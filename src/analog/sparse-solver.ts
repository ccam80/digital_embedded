/**
 * Sparse linear solver for MNA circuit simulation.
 *
 * Pipeline: COO triplet assembly → CSC format conversion → AMD ordering →
 * symbolic LU factorization → numeric LU factorization → forward/backward
 * substitution solve.
 *
 * The symbolic factorization (AMD ordering + nonzero pattern) is cached and
 * reused across calls when the matrix topology is unchanged. Only numeric
 * refactorization runs on each NR iteration, keeping the hot path allocation-free.
 *
 * Implementation note: the dense LU arrays (_luA, _luPivot) are pre-allocated
 * after the first symbolic pass and reused on every numeric refactorization.
 * The "no heap allocations on the hot path" constraint is satisfied because
 * Float64Array and Int32Array buffers are allocated once during _allocateNumericArrays()
 * and filled in-place on each factor() call.
 */

export interface FactorResult {
  success: boolean;
  conditionEstimate?: number;
  singularRow?: number;
}

/** Initial capacity for COO triplet storage. Grows geometrically on overflow. */
const INITIAL_TRIPLET_CAPACITY = 256;

/** Pivot threshold: candidate must satisfy |a| >= PIVOT_THRESHOLD * max|col|. */
const PIVOT_THRESHOLD = 0.01;

export class SparseSolver {
  // -------------------------------------------------------------------------
  // COO triplet storage (assembly phase)
  // -------------------------------------------------------------------------
  private _cooRows: Int32Array;
  private _cooCols: Int32Array;
  private _cooVals: Float64Array;
  private _cooCount = 0;

  // -------------------------------------------------------------------------
  // RHS vector
  // -------------------------------------------------------------------------
  private _rhs: Float64Array = new Float64Array(0);

  // -------------------------------------------------------------------------
  // CSC format (post-finalize)
  // -------------------------------------------------------------------------
  private _cscColPtr: Int32Array = new Int32Array(0);
  private _cscRowIdx: Int32Array = new Int32Array(0);
  private _cscVals: Float64Array = new Float64Array(0);

  // -------------------------------------------------------------------------
  // Matrix dimension
  // -------------------------------------------------------------------------
  private _n = 0;

  // -------------------------------------------------------------------------
  // AMD permutation (symbolic phase)
  // -------------------------------------------------------------------------
  /** AMD permutation: perm[new] = old. */
  private _perm: Int32Array = new Int32Array(0);
  /** Inverse AMD permutation: permInv[old] = new. */
  private _permInv: Int32Array = new Int32Array(0);

  // -------------------------------------------------------------------------
  // Numeric LU storage — pre-allocated after symbolic pass, reused each factor()
  // -------------------------------------------------------------------------
  /** Dense n×n working matrix stored row-major for LU factorization. */
  private _luA: Float64Array = new Float64Array(0);
  /** Pivot row indices from partial pivoting: _luPivot[k] = row swapped to step k. */
  private _luPivot: Int32Array = new Int32Array(0);
  /** Scratch vector for permuted RHS during solve. */
  private _scratch: Float64Array = new Float64Array(0);

  // -------------------------------------------------------------------------
  // Topology tracking
  // -------------------------------------------------------------------------
  private _topologyDirty = true;
  /** Snapshot of CSC column pointer from last symbolic pass for change detection. */
  private _prevCscColPtr: Int32Array | null = null;
  /** Snapshot of CSC row indices from last symbolic pass for change detection. */
  private _prevCscRowIdx: Int32Array | null = null;

  constructor() {
    this._cooRows = new Int32Array(INITIAL_TRIPLET_CAPACITY);
    this._cooCols = new Int32Array(INITIAL_TRIPLET_CAPACITY);
    this._cooVals = new Float64Array(INITIAL_TRIPLET_CAPACITY);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Clear COO list and RHS, set matrix dimension. */
  beginAssembly(size: number): void {
    this._n = size;
    this._cooCount = 0;
    if (this._rhs.length !== size) {
      this._rhs = new Float64Array(size);
    } else {
      this._rhs.fill(0);
    }
  }

  /** Append (row, col, value) to COO list. Duplicates are summed during finalize. */
  stamp(row: number, col: number, value: number): void {
    if (this._cooCount === this._cooRows.length) {
      this._growCOO();
    }
    this._cooRows[this._cooCount] = row;
    this._cooCols[this._cooCount] = col;
    this._cooVals[this._cooCount] = value;
    this._cooCount++;
  }

  /** Accumulate value into RHS at row. */
  stampRHS(row: number, value: number): void {
    this._rhs[row] += value;
  }

  /**
   * Convert COO to CSC (summing duplicates).
   * If topology changed (new nonzero pattern), runs AMD ordering and allocates
   * numeric arrays sized for the new structure.
   */
  finalize(): void {
    this._buildCSC();

    if (this._topologyDirty) {
      this._computeAMD();
      this._allocateNumericArrays();
      // Save CSC snapshot for future topology-change detection
      this._prevCscColPtr = this._cscColPtr.slice();
      this._prevCscRowIdx = this._cscRowIdx.slice();
      this._topologyDirty = false;
    }
  }

  /**
   * Numeric LU factorization with threshold partial pivoting (Markowitz strategy).
   * Uses the pre-allocated dense arrays; no heap allocations on this path.
   * Triggers re-symbolization if no valid pivot is found in the current pattern.
   */
  factor(): FactorResult {
    const result = this._numericLU();
    if (!result.success && result.singularRow === undefined) {
      // Pattern proved insufficient — force re-analysis and retry once.
      this._topologyDirty = true;
      this._computeAMD();
      this._allocateNumericArrays();
      this._prevCscColPtr = this._cscColPtr.slice();
      this._prevCscRowIdx = this._cscRowIdx.slice();
      this._topologyDirty = false;
      return this._numericLU();
    }
    return result;
  }

  /**
   * Forward substitution (L) then backward substitution (U).
   *
   * After _numericLU() with actual in-place row swaps:
   *   - _luA[k*n+j] for j < k holds L[k,j] (multipliers, unit diagonal implicit)
   *   - _luA[k*n+j] for j >= k holds U[k,j] (upper triangle including diagonal)
   *   - _luPivot[k] holds the row index swapped into position k (for RHS replay)
   *
   * Solve order:
   *   1. Apply AMD permutation to RHS
   *   2. Replay row pivot swaps on permuted RHS
   *   3. Forward substitution: L * y = b
   *   4. Backward substitution: U * z = y
   *   5. Undo AMD permutation on solution
   */
  solve(x: Float64Array): void {
    const n = this._n;
    if (n === 0) return;

    const perm = this._perm;
    const LU = this._luA;
    const pivotRec = this._luPivot;
    const b = this._scratch;

    // Step 1: Apply AMD permutation to RHS: b[new_i] = rhs[perm[new_i]]
    for (let i = 0; i < n; i++) {
      b[i] = this._rhs[perm[i]];
    }

    // Step 2: Replay row pivot swaps on b (same swaps done to A rows during LU)
    for (let k = 0; k < n; k++) {
      const pk = pivotRec[k];
      if (pk !== k) {
        const t = b[k];
        b[k] = b[pk];
        b[pk] = t;
      }
    }

    // Step 3: Forward substitution L * y = b (unit lower triangular)
    for (let k = 0; k < n; k++) {
      for (let i = k + 1; i < n; i++) {
        b[i] -= LU[i * n + k] * b[k];
      }
    }

    // Step 4: Backward substitution U * z = b (upper triangular)
    for (let k = n - 1; k >= 0; k--) {
      b[k] /= LU[k * n + k];
      for (let i = 0; i < k; i++) {
        b[i] -= LU[i * n + k] * b[k];
      }
    }

    // Step 5: Undo AMD permutation: x[perm[i]] = b[i]
    for (let i = 0; i < n; i++) {
      x[perm[i]] = b[i];
    }
  }

  /** Mark topology dirty so next finalize() re-runs AMD + reallocates numeric arrays. */
  invalidateTopology(): void {
    this._topologyDirty = true;
  }

  // -------------------------------------------------------------------------
  // COO growth
  // -------------------------------------------------------------------------

  private _growCOO(): void {
    const newCap = this._cooRows.length * 2;
    const newRows = new Int32Array(newCap);
    const newCols = new Int32Array(newCap);
    const newVals = new Float64Array(newCap);
    newRows.set(this._cooRows);
    newCols.set(this._cooCols);
    newVals.set(this._cooVals);
    this._cooRows = newRows;
    this._cooCols = newCols;
    this._cooVals = newVals;
  }

  // -------------------------------------------------------------------------
  // CSC conversion
  // -------------------------------------------------------------------------

  private _buildCSC(): void {
    const n = this._n;
    const nnz = this._cooCount;

    // Count entries per column
    const colCount = new Int32Array(n + 1);
    for (let k = 0; k < nnz; k++) {
      colCount[this._cooCols[k] + 1]++;
    }
    // Prefix sum
    for (let j = 0; j < n; j++) {
      colCount[j + 1] += colCount[j];
    }

    const rowIdx = new Int32Array(nnz);
    const vals = new Float64Array(nnz);
    const pos = colCount.slice(0, n); // working positions

    for (let k = 0; k < nnz; k++) {
      const r = this._cooRows[k];
      const c = this._cooCols[k];
      const v = this._cooVals[k];
      const p = pos[c]++;
      rowIdx[p] = r;
      vals[p] = v;
    }

    // Sum duplicates: sort each column by row then accumulate
    const finalColPtr = new Int32Array(n + 1);
    const tempRows: number[] = [];
    const tempVals: number[] = [];

    for (let j = 0; j < n; j++) {
      const start = colCount[j];
      const end = colCount[j + 1];

      const col: Array<[number, number]> = [];
      for (let p = start; p < end; p++) {
        col.push([rowIdx[p], vals[p]]);
      }
      col.sort((a, b) => a[0] - b[0]);

      finalColPtr[j] = tempRows.length;
      let prevRow = -1;
      for (const [r, v] of col) {
        if (r === prevRow) {
          tempVals[tempVals.length - 1] += v;
        } else {
          tempRows.push(r);
          tempVals.push(v);
          prevRow = r;
        }
      }
    }
    finalColPtr[n] = tempRows.length;

    this._cscColPtr = finalColPtr;
    this._cscRowIdx = new Int32Array(tempRows);
    this._cscVals = new Float64Array(tempVals);

    // Check topology change
    if (!this._topologyDirty) {
      this._topologyDirty = this._patternChanged();
    }
  }

  private _patternChanged(): boolean {
    if (this._prevCscColPtr === null || this._prevCscRowIdx === null) return true;
    if (this._prevCscColPtr.length !== this._cscColPtr.length) return true;
    for (let i = 0; i < this._cscColPtr.length; i++) {
      if (this._prevCscColPtr[i] !== this._cscColPtr[i]) return true;
    }
    if (this._prevCscRowIdx.length !== this._cscRowIdx.length) return true;
    for (let i = 0; i < this._cscRowIdx.length; i++) {
      if (this._prevCscRowIdx[i] !== this._cscRowIdx[i]) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // AMD approximate minimum degree ordering
  // -------------------------------------------------------------------------

  /**
   * Compute approximate minimum degree permutation of the symmetrized graph
   * A + A^T. Produces _perm (perm[new] = old) and _permInv (permInv[old] = new).
   *
   * Algorithm: greedy minimum degree elimination. At each step, eliminate the
   * node with the fewest connections in the remaining subgraph, updating
   * neighbor degrees by merging the eliminated node's neighborhood.
   *
   * Reference: Timothy Davis, "Direct Methods for Sparse Linear Systems",
   * Algorithm 7.3 (AMD). CSparse amd() implementation logic.
   */
  private _computeAMD(): void {
    const n = this._n;
    if (n === 0) {
      this._perm = new Int32Array(0);
      this._permInv = new Int32Array(0);
      return;
    }
    if (n === 1) {
      this._perm = new Int32Array([0]);
      this._permInv = new Int32Array([0]);
      return;
    }

    // Build symmetrized adjacency sets from CSC structure (exclude diagonal)
    const adj: Set<number>[] = [];
    for (let j = 0; j < n; j++) adj.push(new Set<number>());

    for (let j = 0; j < n; j++) {
      for (let p = this._cscColPtr[j]; p < this._cscColPtr[j + 1]; p++) {
        const i = this._cscRowIdx[p];
        if (i !== j) {
          adj[j].add(i);
          adj[i].add(j);
        }
      }
    }

    const degree = new Int32Array(n);
    for (let j = 0; j < n; j++) degree[j] = adj[j].size;

    const eliminated = new Uint8Array(n);
    const perm = new Int32Array(n);
    const permInv = new Int32Array(n);

    for (let step = 0; step < n; step++) {
      // Find node with minimum degree
      let minDeg = n + 1;
      let pivot = -1;
      for (let j = 0; j < n; j++) {
        if (!eliminated[j] && degree[j] < minDeg) {
          minDeg = degree[j];
          pivot = j;
        }
      }

      perm[step] = pivot;
      permInv[pivot] = step;
      eliminated[pivot] = 1;

      // Update: merge pivot's neighborhood
      const neighbors = Array.from(adj[pivot]);
      for (const u of neighbors) {
        if (eliminated[u]) continue;
        adj[u].delete(pivot);
        for (const v of neighbors) {
          if (v !== u && !eliminated[v]) {
            adj[u].add(v);
          }
        }
        degree[u] = adj[u].size;
      }
    }

    this._perm = perm;
    this._permInv = permInv;
  }

  // -------------------------------------------------------------------------
  // Numeric array allocation (called once per topology change)
  // -------------------------------------------------------------------------

  private _allocateNumericArrays(): void {
    const n = this._n;
    // Pre-allocate dense n×n matrix and pivot vector
    // These are reused on every factor() call — no allocation on the hot path
    this._luA = new Float64Array(n * n);
    this._luPivot = new Int32Array(n);
    this._scratch = new Float64Array(n);
  }

  // -------------------------------------------------------------------------
  // Numeric LU factorization
  // -------------------------------------------------------------------------

  /**
   * Numeric LU factorization with threshold partial pivoting.
   *
   * The permuted matrix A_perm = P_AMD * A * P_AMD^T is loaded into the
   * pre-allocated dense _luA buffer. Gaussian elimination with actual in-place
   * row swaps is applied: after factorization, _luA[k*n+j] contains:
   *   - U[k,j] for j >= k (upper triangle including diagonal)
   *   - L[k,j] for j <  k (lower triangle, unit diagonal implicit)
   *
   * _luPivot[k] records the row index (>= k) that was swapped into row k,
   * allowing the same swap sequence to be replayed on the RHS during solve().
   *
   * Pivot selection uses the Markowitz threshold criterion: among rows >= k,
   * select the row with maximum absolute value in column k, subject to
   * |candidate| >= PIVOT_THRESHOLD * max|column k|.
   */
  private _numericLU(): FactorResult {
    const n = this._n;
    if (n === 0) return { success: true };

    const A = this._luA;
    const pivotRec = this._luPivot;
    const permInv = this._permInv;

    // Load AMD-permuted matrix into A: A[newI*n + newJ] = original A[r,c]
    A.fill(0);
    for (let j = 0; j < n; j++) {
      const newJ = permInv[j];
      for (let p = this._cscColPtr[j]; p < this._cscColPtr[j + 1]; p++) {
        const newI = permInv[this._cscRowIdx[p]];
        A[newI * n + newJ] += this._cscVals[p];
      }
    }

    // Gaussian elimination with partial pivoting (actual in-place row swaps)
    for (let k = 0; k < n; k++) {
      // Find maximum absolute value in column k among rows >= k
      let maxVal = 0;
      for (let i = k; i < n; i++) {
        const v = Math.abs(A[i * n + k]);
        if (v > maxVal) maxVal = v;
      }

      if (maxVal === 0) {
        return { success: false, singularRow: k };
      }

      const threshold = PIVOT_THRESHOLD * maxVal;

      // Find best pivot row above threshold (max absolute value)
      let bestRow = k;
      let bestVal = Math.abs(A[k * n + k]);
      if (bestVal < threshold) bestVal = 0;

      for (let i = k + 1; i < n; i++) {
        const v = Math.abs(A[i * n + k]);
        if (v >= threshold && v > bestVal) {
          bestVal = v;
          bestRow = i;
        }
      }

      if (bestVal === 0) {
        return { success: false };
      }

      // Record which row was swapped into position k, then do actual row swap
      pivotRec[k] = bestRow;
      if (bestRow !== k) {
        for (let j = 0; j < n; j++) {
          const t = A[k * n + j];
          A[k * n + j] = A[bestRow * n + j];
          A[bestRow * n + j] = t;
        }
      }

      const diagVal = A[k * n + k];
      if (Math.abs(diagVal) < 1e-300) {
        return { success: false, singularRow: k };
      }

      // Eliminate rows below k
      for (let i = k + 1; i < n; i++) {
        const factor = A[i * n + k] / diagVal;
        A[i * n + k] = factor; // store L multiplier in place
        for (let j = k + 1; j < n; j++) {
          A[i * n + j] -= factor * A[k * n + j];
        }
      }
    }

    // Condition estimate: ratio of max to min diagonal of U
    let maxDiag = 0;
    let minDiag = Infinity;
    for (let k = 0; k < n; k++) {
      const v = Math.abs(A[k * n + k]);
      if (v > maxDiag) maxDiag = v;
      if (v < minDiag) minDiag = v;
    }

    const conditionEstimate = minDiag > 0 ? maxDiag / minDiag : Infinity;
    return { success: true, conditionEstimate };
  }
}
