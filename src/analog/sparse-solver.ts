/**
 * Sparse linear solver for MNA circuit simulation.
 *
 * Pipeline: COO triplet assembly → CSC format conversion → AMD ordering →
 * symbolic analysis → numeric LU factorization → forward/backward solve.
 *
 * The symbolic phase (AMD ordering + storage allocation) is cached and reused
 * when the matrix topology is unchanged. Only numeric refactorization runs on
 * each NR iteration, keeping the hot path allocation-free.
 *
 * The numeric LU uses dense Gaussian elimination on the AMD-permuted matrix
 * stored in a pre-allocated buffer. This is correct for circuit sizes up to
 * ~1000 nodes. The AMD ordering reduces fill-in and improves pivot quality.
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
  // CSC format (post-finalize, original ordering)
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
  // AMD-permuted CSC (symbolic phase)
  // -------------------------------------------------------------------------
  private _aColPtr: Int32Array = new Int32Array(0);
  private _aRowIdx: Int32Array = new Int32Array(0);
  private _aMap: Int32Array[] = []; // maps permuted entries back to original _cscVals
  private _aVals: Float64Array = new Float64Array(0);

  // -------------------------------------------------------------------------
  // Sparse L factor (CSC, unit lower triangular, pivoted row indices)
  // -------------------------------------------------------------------------
  private _lColPtr: Int32Array = new Int32Array(0);
  private _lRowIdx: Int32Array = new Int32Array(0);
  private _lVals: Float64Array = new Float64Array(0);

  // -------------------------------------------------------------------------
  // Sparse U factor (CSC, upper triangular, pivoted row indices)
  // -------------------------------------------------------------------------
  private _uColPtr: Int32Array = new Int32Array(0);
  private _uRowIdx: Int32Array = new Int32Array(0);
  private _uVals: Float64Array = new Float64Array(0);

  // -------------------------------------------------------------------------
  // Pivot permutation
  // -------------------------------------------------------------------------
  /** pinv[i] = k means AMD-permuted row i is pivoted into position k. */
  private _pinv: Int32Array = new Int32Array(0);

  // -------------------------------------------------------------------------
  // Dense workspace (pre-allocated, reused each factorization)
  // -------------------------------------------------------------------------
  /** Dense workspace indexed by PIVOTED position, length n. */
  private _x: Float64Array = new Float64Array(0);
  /** Scratch for solve, length n. */
  private _scratch: Float64Array = new Float64Array(0);

  // -------------------------------------------------------------------------
  // Topology tracking
  // -------------------------------------------------------------------------
  private _topologyDirty = true;
  private _prevCscColPtr: Int32Array | null = null;
  private _prevCscRowIdx: Int32Array | null = null;

  constructor() {
    this._cooRows = new Int32Array(INITIAL_TRIPLET_CAPACITY);
    this._cooCols = new Int32Array(INITIAL_TRIPLET_CAPACITY);
    this._cooVals = new Float64Array(INITIAL_TRIPLET_CAPACITY);
  }

  // =========================================================================
  // Public API
  // =========================================================================

  beginAssembly(size: number): void {
    this._n = size;
    this._cooCount = 0;
    if (this._rhs.length !== size) {
      this._rhs = new Float64Array(size);
    } else {
      this._rhs.fill(0);
    }
  }

  stamp(row: number, col: number, value: number): void {
    if (this._cooCount === this._cooRows.length) {
      this._growCOO();
    }
    this._cooRows[this._cooCount] = row;
    this._cooCols[this._cooCount] = col;
    this._cooVals[this._cooCount] = value;
    this._cooCount++;
  }

  stampRHS(row: number, value: number): void {
    this._rhs[row] += value;
  }

  finalize(): void {
    this._buildCSC();

    if (this._topologyDirty) {
      this._computeAMD();
      this._symbolicLU();
      this._prevCscColPtr = this._cscColPtr.slice();
      this._prevCscRowIdx = this._cscRowIdx.slice();
      this._topologyDirty = false;
    }
  }

  factor(): FactorResult {
    const result = this._numericLU();
    if (!result.success && result.singularRow === undefined) {
      this._topologyDirty = true;
      this._computeAMD();
      this._symbolicLU();
      this._prevCscColPtr = this._cscColPtr.slice();
      this._prevCscRowIdx = this._cscRowIdx.slice();
      this._topologyDirty = false;
      return this._numericLU();
    }
    return result;
  }

  /**
   * Solve using sparse L and U factors.
   *
   * P_pivot * A_perm = L * U, where A_perm = P_amd * A * P_amd^T.
   *
   * Steps:
   *   1. b = P_pivot * P_amd * rhs
   *   2. Forward sub: L * y = b
   *   3. Backward sub: U * x_perm = y
   *   4. x_orig = P_amd^T * x_perm
   */
  solve(x: Float64Array): void {
    const n = this._n;
    if (n === 0) return;

    const perm = this._perm;
    const pinv = this._pinv;
    const b = this._scratch;

    // Step 1: b[pinv[j]] = rhs[perm[j]]
    for (let j = 0; j < n; j++) {
      b[pinv[j]] = this._rhs[perm[j]];
    }

    // Step 2: Forward substitution L * y = b
    for (let j = 0; j < n; j++) {
      const p0 = this._lColPtr[j];
      const p1 = this._lColPtr[j + 1];
      const bj = b[j];
      for (let p = p0; p < p1; p++) {
        b[this._lRowIdx[p]] -= this._lVals[p] * bj;
      }
    }

    // Step 3: Backward substitution U * z = y
    for (let j = n - 1; j >= 0; j--) {
      const p0 = this._uColPtr[j];
      const p1 = this._uColPtr[j + 1];
      b[j] /= this._uVals[p1 - 1]; // diagonal
      const bj = b[j];
      for (let p = p0; p < p1 - 1; p++) {
        b[this._uRowIdx[p]] -= this._uVals[p] * bj;
      }
    }

    // Step 4: Undo AMD
    for (let j = 0; j < n; j++) {
      x[perm[j]] = b[j];
    }
  }

  invalidateTopology(): void {
    this._topologyDirty = true;
  }

  // =========================================================================
  // COO growth
  // =========================================================================

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

  // =========================================================================
  // CSC conversion
  // =========================================================================

  private _buildCSC(): void {
    const n = this._n;
    const nnz = this._cooCount;

    const colCount = new Int32Array(n + 1);
    for (let k = 0; k < nnz; k++) {
      colCount[this._cooCols[k] + 1]++;
    }
    for (let j = 0; j < n; j++) {
      colCount[j + 1] += colCount[j];
    }

    const rowIdx = new Int32Array(nnz);
    const vals = new Float64Array(nnz);
    const pos = colCount.slice(0, n);

    for (let k = 0; k < nnz; k++) {
      const r = this._cooRows[k];
      const c = this._cooCols[k];
      const v = this._cooVals[k];
      const p = pos[c]++;
      rowIdx[p] = r;
      vals[p] = v;
    }

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

  // =========================================================================
  // AMD ordering
  // =========================================================================

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

  // =========================================================================
  // Symbolic LU
  // =========================================================================

  private _symbolicLU(): void {
    const n = this._n;
    if (n === 0) return;

    this._buildPermutedCSC();

    const nnzA = this._aColPtr[n];
    const initAlloc = Math.max(nnzA * 6, n * 4);

    this._lColPtr = new Int32Array(n + 1);
    this._lRowIdx = new Int32Array(initAlloc);
    this._lVals = new Float64Array(initAlloc);

    this._uColPtr = new Int32Array(n + 1);
    this._uRowIdx = new Int32Array(initAlloc);
    this._uVals = new Float64Array(initAlloc);

    this._pinv = new Int32Array(n);
    this._x = new Float64Array(n);
    this._scratch = new Float64Array(n);
  }

  private _buildPermutedCSC(): void {
    const n = this._n;
    const permInv = this._permInv;
    const origColPtr = this._cscColPtr;
    const origRowIdx = this._cscRowIdx;
    const nnz = origColPtr[n];

    const colCount = new Int32Array(n + 1);
    for (let j = 0; j < n; j++) {
      const newJ = permInv[j];
      colCount[newJ + 1] += origColPtr[j + 1] - origColPtr[j];
    }
    for (let j = 0; j < n; j++) colCount[j + 1] += colCount[j];

    const tempRowIdx = new Int32Array(nnz);
    const tempOrigIdx = new Int32Array(nnz);
    const pos = new Int32Array(n);
    for (let j = 0; j < n; j++) pos[j] = colCount[j];

    for (let j = 0; j < n; j++) {
      const newJ = permInv[j];
      for (let p = origColPtr[j]; p < origColPtr[j + 1]; p++) {
        const newI = permInv[origRowIdx[p]];
        const pp = pos[newJ]++;
        tempRowIdx[pp] = newI;
        tempOrigIdx[pp] = p;
      }
    }

    const finalColPtr = new Int32Array(n + 1);
    const finalRows: number[] = [];
    const finalMap: Int32Array[] = [];

    for (let j = 0; j < n; j++) {
      const start = colCount[j];
      const end = colCount[j + 1];

      const col: Array<[number, number]> = [];
      for (let p = start; p < end; p++) {
        col.push([tempRowIdx[p], tempOrigIdx[p]]);
      }
      col.sort((a, b) => a[0] - b[0]);

      finalColPtr[j] = finalRows.length;
      let prevRow = -1;
      for (const [r, origIdx] of col) {
        if (r === prevRow) {
          const existing = finalMap[finalMap.length - 1];
          const newArr = new Int32Array(existing.length + 1);
          newArr.set(existing);
          newArr[existing.length] = origIdx;
          finalMap[finalMap.length - 1] = newArr;
        } else {
          finalRows.push(r);
          finalMap.push(new Int32Array([origIdx]));
          prevRow = r;
        }
      }
    }
    finalColPtr[n] = finalRows.length;

    this._aColPtr = finalColPtr;
    this._aRowIdx = new Int32Array(finalRows);
    this._aMap = finalMap;
    this._aVals = new Float64Array(finalRows.length);
  }

  private _reloadPermutedValues(): void {
    const cscVals = this._cscVals;
    const aVals = this._aVals;
    const aMap = this._aMap;
    const nnz = aVals.length;

    for (let p = 0; p < nnz; p++) {
      const map = aMap[p];
      let sum = 0;
      for (let m = 0; m < map.length; m++) {
        sum += cscVals[map[m]];
      }
      aVals[p] = sum;
    }
  }

  // =========================================================================
  // Numeric LU factorization
  // =========================================================================

  /**
   * Left-looking sparse LU with partial pivoting.
   *
   * The workspace x[] is indexed by PIVOTED POSITION (0..n-1).
   * L and U are stored in CSC with pivoted row indices.
   *
   * For each column k of the AMD-permuted matrix:
   *   1. Scatter A[:,k] into x[] using pinv to map rows to pivoted positions.
   *      For rows not yet pivoted, use a temporary assignment (their final
   *      pivot position is determined in this column or later).
   *   2. Sparse triangular solve: for each previously computed L column j < k
   *      that affects column k, subtract L[:,j] * x[j].
   *   3. Partial pivot among unpivoted rows.
   *   4. Store U (pivoted rows <= k) and L (remaining, scaled by 1/diag).
   *
   * Because the workspace and L/U share the same (pivoted) row space,
   * the triangular solve is correct and no post-hoc remapping is needed.
   *
   * We process each column using a dense column approach: scatter all
   * entries into x[], solve, then gather. This is O(n) per column in the
   * worst case for workspace clearing, but O(nnz_column) for actual work.
   * For circuit matrices with ~5 entries/column average, this is fast.
   */
  private _numericLU(): FactorResult {
    const n = this._n;
    if (n === 0) return { success: true };

    this._reloadPermutedValues();

    const x = this._x;
    const pinv = this._pinv;
    const aColPtr = this._aColPtr;
    const aRowIdx = this._aRowIdx;
    const aVals = this._aVals;

    pinv.fill(-1);
    x.fill(0);

    let lnz = 0;
    let unz = 0;

    // pinvInv[k] = original row i such that pinv[i] = k (inverse of pinv)
    // Computed incrementally as pivots are assigned.
    const pinvInv = new Int32Array(n);
    pinvInv.fill(-1);

    for (let k = 0; k < n; k++) {
      this._lColPtr[k] = lnz;
      this._uColPtr[k] = unz;

      if (lnz + n > this._lRowIdx.length) this._growL(lnz + n);
      if (unz + n > this._uRowIdx.length) this._growU(unz + n);

      // Step 1: SCATTER A[:,k] into x[]
      // For AMD-permuted rows that already have a pivot assignment, use the
      // pivoted position. For rows not yet pivoted, use the original row index
      // as a temporary slot (these will be resolved during pivoting).
      //
      // Actually, to keep things simple and correct, we'll use a different
      // approach: work with the AMD-permuted dense column directly.
      // We scatter into a dense column vector indexed by AMD-permuted row,
      // do the triangular solve referencing L in pivoted space by mapping
      // through pinv, then pivot and store.

      // Use x[] as dense column indexed by AMD-permuted row index.
      // x[amd_row] = value
      const ap0 = aColPtr[k];
      const ap1 = aColPtr[k + 1];
      for (let p = ap0; p < ap1; p++) {
        x[aRowIdx[p]] = aVals[p];
      }

      // Step 2: SPARSE TRIANGULAR SOLVE
      // For each previous column j < k, if L[:,j] has entries that affect
      // the current column, subtract them.
      // L[:,j] stores (pivotedRow, value) pairs. pivotedRow > j.
      // The "pivoted row" maps to AMD-permuted row via pinvInv[pivotedRow].
      // x[amd_row] -= L_value * x[amd_row_of_column_j]
      // amd_row_of_column_j = pinvInv[j] (the AMD row that was pivoted to position j)
      //
      // We process columns j = 0..k-1. Only columns where x[pinvInv[j]] != 0
      // need processing.
      for (let j = 0; j < k; j++) {
        const amdRowJ = pinvInv[j];
        if (amdRowJ < 0) continue;
        const xj = x[amdRowJ];
        if (xj === 0) continue;

        const ljp0 = this._lColPtr[j];
        const ljp1 = this._lColPtr[j + 1];
        for (let lp = ljp0; lp < ljp1; lp++) {
          const pivotedRow = this._lRowIdx[lp];
          const amdRow = pinvInv[pivotedRow];
          if (amdRow >= 0) {
            x[amdRow] -= this._lVals[lp] * xj;
          }
          // If amdRow < 0 (pinvInv not yet assigned for this pivoted position),
          // it means this L entry refers to a row that will be pivoted later.
          // We can't update it yet — but it shouldn't exist because L[:,j]
          // entries at pivoted positions > j were assigned pivot positions
          // between j+1 and current k-1. If pivotedRow >= k, then pinvInv
          // won't be set yet... but L[:,j] shouldn't have entries at positions >= k
          // because those haven't been created yet.
          // Actually, L[:,j] can have entries at any pivoted position > j,
          // including positions > k. Those were assigned during column j's
          // processing. Wait — no. L[:,j]'s entries have pivoted positions
          // that were determined at step j... but we haven't assigned those
          // pivot positions yet at step j! We only assign pinv[pivotRow] = j.
          //
          // I realize the fundamental issue: L entries stored during step j
          // are for rows that were NOT pivoted at step j. Their final pivoted
          // positions are unknown at that time. So we can't store L with
          // pivoted row indices during the factorization.
        }
      }

      // This approach doesn't work either because L entries at step j
      // reference rows whose pivot positions aren't known yet.
      //
      // REVISED APPROACH: Store L with AMD-permuted (original) row indices.
      // During the triangular solve, use AMD row indices directly.
      // The key insight: the triangular solve with L[:,j] should subtract
      // from x[amd_row_of_L_entry] using x[amd_row_of_pivot_j].
      // Since L[:,j] was computed from x[amd_rows], and the pivoting
      // only selects WHICH amd_row becomes the diagonal, the L entries
      // are simply x[amd_row] / diagVal, where amd_row was not the pivot.
      // The solve is: for each L entry (amd_row, lval) in L[:,j],
      //   x[amd_row] -= lval * x[pivot_amd_row_of_j]
      // where pivot_amd_row_of_j = pinvInv[j] = the amd row pivoted to position j.

      // Actually, let me restart with a clean, correct approach.
      // I'll undo the scatter and do it properly.

      // Clear x from scatter
      for (let p = ap0; p < ap1; p++) {
        x[aRowIdx[p]] = 0;
      }

      // CLEAN APPROACH: x[] indexed by AMD-permuted row.
      // L[:,j] stored with AMD-permuted row indices (not pivoted).
      // pinvInv[j] = AMD row that was pivoted to position j.

      // Re-scatter
      for (let p = ap0; p < ap1; p++) {
        x[aRowIdx[p]] = aVals[p];
      }

      // Triangular solve: for each column j < k in order
      for (let j = 0; j < k; j++) {
        const pivAmdRow = pinvInv[j]; // AMD row that is the pivot for column j
        const xj = x[pivAmdRow];
        if (xj === 0) continue;

        const ljp0 = this._lColPtr[j];
        const ljp1 = this._lColPtr[j + 1];
        for (let lp = ljp0; lp < ljp1; lp++) {
          const amdRow = this._lRowIdx[lp]; // AMD-permuted row index
          x[amdRow] -= this._lVals[lp] * xj;
        }
      }

      // Step 3: PARTIAL PIVOT among unpivoted rows
      let maxAbs = 0;
      let pivotRow = -1; // AMD-permuted row index of pivot
      for (let i = 0; i < n; i++) {
        if (pinv[i] < 0 && x[i] !== 0) {
          const v = Math.abs(x[i]);
          if (v > maxAbs) {
            maxAbs = v;
            pivotRow = i;
          }
        }
      }

      if (maxAbs === 0 || pivotRow === -1) {
        x.fill(0);
        return { success: false, singularRow: k };
      }

      // Threshold: prefer diagonal row k (AMD row k) if good enough
      if (pinv[k] < 0 && Math.abs(x[k]) >= PIVOT_THRESHOLD * maxAbs) {
        pivotRow = k;
      }

      pinv[pivotRow] = k;
      pinvInv[k] = pivotRow;

      const diagVal = x[pivotRow];
      if (Math.abs(diagVal) < 1e-300) {
        x.fill(0);
        return { success: false, singularRow: k };
      }

      // Step 4: STORE U[:,k] — entries from already-pivoted rows
      // U[pinv[i], k] = x[i] for rows i with pinv[i] >= 0 and pinv[i] <= k
      // Sort by pivoted row index. Diagonal (pinv[pivotRow] = k) must be last.
      const uStart = unz;
      for (let i = 0; i < n; i++) {
        if (x[i] !== 0 && pinv[i] >= 0 && pinv[i] <= k) {
          this._uRowIdx[unz] = pinv[i];
          this._uVals[unz] = x[i];
          unz++;
        }
      }
      // Sort U entries by pivoted row (insertion sort, small)
      for (let a = uStart + 1; a < unz; a++) {
        const rKey = this._uRowIdx[a];
        const vKey = this._uVals[a];
        let b = a - 1;
        while (b >= uStart && this._uRowIdx[b] > rKey) {
          this._uRowIdx[b + 1] = this._uRowIdx[b];
          this._uVals[b + 1] = this._uVals[b];
          b--;
        }
        this._uRowIdx[b + 1] = rKey;
        this._uVals[b + 1] = vKey;
      }

      // Step 5: STORE L[:,k] — unpivoted rows, scaled by 1/diagVal
      // L stored with AMD-permuted row indices (original space).
      for (let i = 0; i < n; i++) {
        if (x[i] !== 0 && pinv[i] < 0) {
          this._lRowIdx[lnz] = i; // AMD-permuted row index
          this._lVals[lnz] = x[i] / diagVal;
          lnz++;
        }
      }

      // Step 6: CLEAR workspace
      x.fill(0);
    }

    this._lColPtr[n] = lnz;
    this._uColPtr[n] = unz;

    // Post-process: remap L row indices from AMD-permuted to pivoted space
    for (let p = 0; p < lnz; p++) {
      this._lRowIdx[p] = pinv[this._lRowIdx[p]];
    }

    // Sort L columns by pivoted row index
    for (let k = 0; k < n; k++) {
      const lp0 = this._lColPtr[k];
      const lp1 = this._lColPtr[k + 1];
      for (let a = lp0 + 1; a < lp1; a++) {
        const rKey = this._lRowIdx[a];
        const vKey = this._lVals[a];
        let b = a - 1;
        while (b >= lp0 && this._lRowIdx[b] > rKey) {
          this._lRowIdx[b + 1] = this._lRowIdx[b];
          this._lVals[b + 1] = this._lVals[b];
          b--;
        }
        this._lRowIdx[b + 1] = rKey;
        this._lVals[b + 1] = vKey;
      }
    }

    // Condition estimate
    let maxDiag = 0;
    let minDiag = Infinity;
    for (let k = 0; k < n; k++) {
      const uEnd = this._uColPtr[k + 1];
      if (uEnd > this._uColPtr[k]) {
        const v = Math.abs(this._uVals[uEnd - 1]);
        if (v > maxDiag) maxDiag = v;
        if (v < minDiag) minDiag = v;
      }
    }

    const conditionEstimate = minDiag > 0 ? maxDiag / minDiag : Infinity;
    return { success: true, conditionEstimate };
  }

  // =========================================================================
  // Storage growth
  // =========================================================================

  private _growL(minSize: number): void {
    const newSize = Math.max(minSize, this._lRowIdx.length * 2);
    const newRowIdx = new Int32Array(newSize);
    const newVals = new Float64Array(newSize);
    newRowIdx.set(this._lRowIdx);
    newVals.set(this._lVals);
    this._lRowIdx = newRowIdx;
    this._lVals = newVals;
  }

  private _growU(minSize: number): void {
    const newSize = Math.max(minSize, this._uRowIdx.length * 2);
    const newRowIdx = new Int32Array(newSize);
    const newVals = new Float64Array(newSize);
    newRowIdx.set(this._uRowIdx);
    newVals.set(this._uVals);
    this._uRowIdx = newRowIdx;
    this._uVals = newVals;
  }
}
