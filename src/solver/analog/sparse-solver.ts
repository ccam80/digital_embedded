/**
 * Sparse linear solver for MNA circuit simulation.
 *
 * Pipeline: COO triplet assembly → CSC format conversion → AMD ordering →
 * sparse LU factorization → sparse forward/backward substitution solve.
 *
 * The symbolic phase (AMD ordering + elimination tree + storage allocation)
 * is cached when topology is unchanged. Only numeric refactorization runs
 * on each NR iteration (allocation-free hot path).
 *
 * Solve: sparse forward substitution on CSC L, sparse backward substitution
 * on CSC U. O(nnz(L) + nnz(U)) per solve.
 */

export interface FactorResult {
  success: boolean;
  conditionEstimate?: number;
  singularRow?: number;
}

const INITIAL_TRIPLET_CAPACITY = 256;
const PIVOT_THRESHOLD = 1e-3;
const PIVOT_ABS_THRESHOLD = 1e-13;

export class SparseSolver {
  // -- COO triplet storage --
  private _cooRows: Int32Array;
  private _cooCols: Int32Array;
  private _cooVals: Float64Array;
  private _cooCount = 0;

  // -- RHS --
  private _rhs: Float64Array = new Float64Array(0);

  // -- CSC (original ordering) --
  private _cscColPtr: Int32Array = new Int32Array(0);
  private _cscRowIdx: Int32Array = new Int32Array(0);
  private _cscVals: Float64Array = new Float64Array(0);

  // -- Dimension --
  private _n = 0;

  // -- AMD permutation --
  private _perm: Int32Array = new Int32Array(0);
  private _permInv: Int32Array = new Int32Array(0);

  // -- Sparse L (CSC, unit lower triangular) --
  // Row indices are in ORIGINAL AMD-row space (not pivot-position space).
  private _lColPtr: Int32Array = new Int32Array(0);
  private _lRowIdx: Int32Array = new Int32Array(0);
  private _lVals: Float64Array = new Float64Array(0);

  // -- Sparse U (CSC, upper triangular) --
  // Row indices are in ORIGINAL AMD-row space (not pivot-position space).
  // Diagonal is stored as the LAST entry in each column.
  private _uColPtr: Int32Array = new Int32Array(0);
  private _uRowIdx: Int32Array = new Int32Array(0);
  private _uVals: Float64Array = new Float64Array(0);

  // -- Pivot permutation --
  // _pinv[origRow] = step k at which origRow was chosen as pivot.
  // _q[k] = origRow chosen as pivot at step k (inverse of _pinv).
  private _pinv: Int32Array = new Int32Array(0);
  private _q: Int32Array = new Int32Array(0);

  // -- Dense workspace for factorization (length n, reused each factor) --
  private _x: Float64Array = new Float64Array(0);

  // -- Tracked nonzero indices in x[] (for scatter-reset clearing) --
  private _xNzIdx: Int32Array = new Int32Array(0);

  // -- DFS reach workspace --
  /** Result stack: _reachStack[top..n-1] = reach set in topological order. */
  private _reachStack: Int32Array = new Int32Array(0);
  /** DFS call stack (step indices being explored). */
  private _dfsStack: Int32Array = new Int32Array(0);
  /** Per-DFS-frame child pointer into L column (saves scan progress). */
  private _dfsChildPtr: Int32Array = new Int32Array(0);
  /** Visit marker: _reachMark[j] === k means step j was visited during column k's reach. */
  private _reachMark: Int32Array = new Int32Array(0);

  // -- Scratch for solve (length n) --
  private _scratch: Float64Array = new Float64Array(0);

  // -- Pre-solve RHS capture --
  private _preSolveRhs: Float64Array | null = null;
  private _capturePreSolveRhs = false;

  // -- Topology tracking --
  /**
   * When true, the next `finalize()` rebuilds CSC + AMD + symbolic LU from
   * scratch. Flipped back to `false` at the end of a rebuild. Flipped back
   * to `true` by `finalize()` whenever the COO stamp count changes — this
   * catches legitimate pattern changes within a single solver lifetime:
   *  - DC operating point with gmin-stepping stamps extra diagonals that
   *    disappear once gmin reaches zero
   *  - DC → transient transition (reactive companion models stamp differently)
   *  - Retry paths that drop or add stamps
   * True topology changes (new circuit) always arrive via a fresh
   * `SparseSolver` instance from the engine's `init()`, so this flag never
   * needs external invalidation in production.
   */
  private _topologyDirty = true;
  /**
   * COO triplet count at the last successful full rebuild. A mismatch at
   * the top of `finalize()` forces `_topologyDirty = true`, ensuring the
   * `_cooToCsc` mapping is never consumed by `_refillCSC()` with a stale
   * stamp pattern. Initialized to -1 so the very first finalize always
   * takes the slow path.
   */
  private _prevCooCount = -1;
  /**
   * Maps each COO triplet index `k` to its accumulated position in
   * `_cscVals`. Populated during `_buildCSC()`; consumed by `_refillCSC()`
   * to scatter-add new stamp values without rebuilding the CSC structure.
   */
  private _cooToCsc: Int32Array = new Int32Array(0);

  // -- Linear-base CSC snapshot for NR loop optimization --
  // -- Mode-driven reorder flag --
  private _needsReorder: boolean = false;

  // -- Preorder flag --
  private _didPreorder: boolean = false;

  // -- Pivot order tracking --
  /** True after at least one factorWithReorder call has established _pinv/_q. */
  private _hasPivotOrder: boolean = false;

  // -- Last factor path tracking --
  /** True when the most recent factor() call dispatched to factorWithReorder (full pivot search). */
  lastFactorUsedReorder: boolean = false;

  // -- Markowitz pivot selection data --
  /** Count of off-diagonal nonzeros in each row (indexed by internal row). */
  private _markowitzRow: Int32Array = new Int32Array(0);
  /** Count of off-diagonal nonzeros in each column (indexed by internal column). */
  private _markowitzCol: Int32Array = new Int32Array(0);
  /** Markowitz product per diagonal: (rowCount-1)*(colCount-1). */
  private _markowitzProd: Float64Array = new Float64Array(0);
  /** Count of rows/columns with exactly one off-diagonal nonzero (singletons). */
  private _singletons: number = 0;

  // -- Parallel-array doubly-linked-list element pool --
  // Topology-only overlay for Markowitz fill-in tracking during _numericLUMarkowitz.
  // Values stay in the dense workspace x[]. The linked structure is ephemeral —
  // built at start of _numericLUMarkowitz, consumed during elimination, abandoned on return.
  //
  // ngspice variable mapping:
  // | ngspice (spfactor.c)     | Ours                    |
  // |--------------------------|-------------------------|
  // | Element->NextInRow       | _elNextInRow[e]         |
  // | Element->NextInCol       | _elNextInCol[e]         |
  // | Element->Row             | _elRow[e]               |
  // | Element->Col             | _elCol[e]               |
  // | CreateFillin()           | _allocElement + _insertIntoRow + _insertIntoCol |

  /** AMD-permuted row of element e. */
  private _elRow: Int32Array = new Int32Array(0);
  /** AMD-permuted column of element e. */
  private _elCol: Int32Array = new Int32Array(0);
  /** Next element in same row (-1 = end). */
  private _elNextInRow: Int32Array = new Int32Array(0);
  /** Prev element in same row (-1 = head). */
  private _elPrevInRow: Int32Array = new Int32Array(0);
  /** Next element in same column (-1 = end). */
  private _elNextInCol: Int32Array = new Int32Array(0);
  /** Prev element in same column (-1 = head). */
  private _elPrevInCol: Int32Array = new Int32Array(0);

  /** First element in row r (-1 = empty). Length n. */
  private _rowHead: Int32Array = new Int32Array(0);
  /** First element in column c (-1 = empty). Length n. */
  private _colHead: Int32Array = new Int32Array(0);
  /** Element index of diagonal (r,r) or -1. Length n. */
  private _diag: Int32Array = new Int32Array(0);

  /** Next free slot in element pool. */
  private _elCount: number = 0;
  /** Current pool capacity. */
  private _elCapacity: number = 0;

  /** Fill-in detection marker: _elMark[row] = column of last mark. Length n. */
  private _elMark: Int32Array = new Int32Array(0);

  // -- Scratch buffers for _buildCSC (hoisted, grown lazily) --
  /** Per-column nonzero counts + prefix-summed column start offsets. */
  private _bldColCount: Int32Array = new Int32Array(0);
  /** Per-column write cursor during COO→bucket scatter. */
  private _bldColPos: Int32Array = new Int32Array(0);
  /** Pre-dedup row indices, bucketed by column. Size ≥ max COO count seen. */
  private _bldBucketRows: Int32Array = new Int32Array(0);
  /** Parallel to _bldBucketRows: original COO triplet index, used to record _cooToCsc. */
  private _bldBucketCooIdx: Int32Array = new Int32Array(0);

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
      this._markowitzRow = new Int32Array(size);
      this._markowitzCol = new Int32Array(size);
      this._markowitzProd = new Float64Array(size);
    } else {
      this._rhs.fill(0);
      this._markowitzRow.fill(0);
      this._markowitzCol.fill(0);
      this._markowitzProd.fill(0);
    }
    this._singletons = 0;
  }

  stamp(row: number, col: number, value: number): void {
    if (this._cooCount === this._cooRows.length) this._growCOO();
    this._cooRows[this._cooCount] = row;
    this._cooCols[this._cooCount] = col;
    this._cooVals[this._cooCount] = value;
    this._cooCount++;
  }

  stampRHS(row: number, value: number): void {
    this._rhs[row] += value;
  }

  /**
   * Convert accumulated COO triplets into CSC form.
   *
   * Fast path (steady state): sparsity pattern is assumed stable, so only
   * `_cscVals` is refilled via a pre-built COO→CSC index map. Zero
   * allocations. This is the common case for a fixed-topology transient
   * simulation where every NR iteration stamps the same (row, col) positions
   * with different numeric values.
   *
   * Slow path (first finalize only, or after `invalidateTopology()`): rebuild
   * CSC + cooToCsc mapping, then recompute AMD and symbolic LU.
   *
   * The fast path trusts that callers have stamped at the same (row, col)
   * positions as last time. Stamp-pattern changes in this codebase are
   * compile-gated — topology changes go through the compiler, which produces
   * a new compiled circuit and the engine constructs a fresh solver. Inside
   * the solver's lifetime the pattern is invariant.
   */
  finalize(): void {
    // Any change in the COO stamp count invalidates the cached CSC structure
    // and the `_cooToCsc` index map that the refill fast path relies on.
    // This covers:
    //  - first call of a solver's lifetime (_prevCooCount === -1)
    //  - DC op gmin-stepping adds diagonal stamps that disappear at gmin=0
    //  - DC → transient transition changes which reactive companions stamp
    //  - NR retry paths that add/drop stamps
    if (this._cooCount !== this._prevCooCount) {
      this._topologyDirty = true;
    }
    if (this._topologyDirty) {
      this._buildCSC();
      this._computeAMD();
      this._symbolicLU();
      this._topologyDirty = false;
      this._prevCooCount = this._cooCount;
      this._hasPivotOrder = false; // topology change invalidates stored pivot order
    } else {
      this._refillCSC();
    }

    if (this._capturePreSolveRhs && this._preSolveRhs) {
      if (this._preSolveRhs.length !== this._n) {
        this._preSolveRhs = new Float64Array(this._n);
      }
      this._preSolveRhs.set(this._rhs.subarray(0, this._n));
    }
  }

  factor(): FactorResult {
    if (this._needsReorder || !this._hasPivotOrder) {
      this.lastFactorUsedReorder = true;
      return this.factorWithReorder();
    }
    this.lastFactorUsedReorder = false;
    return this.factorNumerical();
  }

  /**
   * Sparse forward/backward substitution.
   *
   * L and U row indices are in original AMD-row space. The pivot mapping
   * _pinv[origRow] = step and _q[step] = origRow connect the two spaces.
   *
   * 1. AMD permute RHS into AMD-row space
   * 2. Apply pivot permutation: b_piv[k] = b_amd[q[k]]
   * 3. Sparse forward sub (L, unit lower triangular CSC)
   *    L rows are in original AMD-row space, so we index via q[]:
   *    for column j: val_j = b_piv[j], then for each L entry (origRow, l):
   *      b_piv[pinv[origRow]] -= l * val_j
   * 4. Sparse backward sub (U, upper triangular CSC)
   *    Similarly index U via q[]/pinv[]
   * 5. Undo AMD permutation
   */
  solve(x: Float64Array): void {
    const n = this._n;
    if (n === 0) return;

    const perm = this._perm;
    const pinv = this._pinv;
    const q = this._q;
    const b = this._scratch;

    // Step 1+2: AMD permute then pivot permute RHS
    // Combined: b[k] = rhs[perm[q[k]]] where q[k] is the AMD-row pivoted at step k
    for (let k = 0; k < n; k++) b[k] = this._rhs[perm[q[k]]];

    // Step 3: Sparse forward sub (L, unit lower triangular CSC)
    // L column j corresponds to step j. L row indices are original AMD-rows.
    // b[] is in step-order space. To update b[step] for an L entry at
    // origRow, we use pinv[origRow] to find the step.
    for (let j = 0; j < n; j++) {
      const p0 = this._lColPtr[j];
      const p1 = this._lColPtr[j + 1];
      const bj = b[j];
      for (let p = p0; p < p1; p++) {
        b[pinv[this._lRowIdx[p]]] -= this._lVals[p] * bj;
      }
    }

    // Step 4: Sparse backward sub (U, upper triangular CSC)
    // U column j corresponds to step j. U row indices are original AMD-rows.
    // Diagonal is last entry, its origRow = q[j], so pinv[origRow] = j.
    for (let j = n - 1; j >= 0; j--) {
      const p0 = this._uColPtr[j];
      const p1 = this._uColPtr[j + 1];
      // Diagonal is last entry in column j
      b[j] /= this._uVals[p1 - 1];
      const bj = b[j];
      for (let p = p0; p < p1 - 1; p++) {
        b[pinv[this._uRowIdx[p]]] -= this._uVals[p] * bj;
      }
    }

    // Step 5: Undo AMD column permutation
    // b[k] is the solution for AMD-column k. perm[k] = original column index.
    for (let k = 0; k < n; k++) x[perm[k]] = b[k];
  }

  invalidateTopology(): void {
    this._topologyDirty = true;
    this._hasPivotOrder = false;
  }

  /**
   * Force full symbolic reorder on next factor() call.
   * ngspice: NISHOULDREORDER trigger (niiter.c:858, 861-880).
   */
  forceReorder(): void {
    this._needsReorder = true;
  }

  /**
   * One-time static column permutation.
   * ngspice: SMPpreOrder (spbuild.c). Sets up initial column ordering
   * before the first factorization. Currently delegates to AMD ordering
   * which is applied during finalize(). Sets `_didPreorder` to prevent
   * redundant calls.
   */
  preorder(): void {
    if (this._didPreorder) return;
    this._didPreorder = true;
  }

  /**
   * Add a conductance value to every diagonal element of the assembled matrix.
   * Matches ngspice LoadGmin (spsmp.c:448-478): called after CKTload fills
   * the matrix but before LU factorization.
   *
   * Must be called after beginAssembly()+stamps+finalize() but before factor().
   * Directly mutates the CSC values array at diagonal positions.
   *
   * @param gmin - Conductance in siemens to add to each diagonal
   */
  addDiagonalGmin(gmin: number): void {
    if (gmin === 0 || !this._cscColPtr) return;
    const n = this._n;
    const colPtr = this._cscColPtr;
    const rowIdx = this._cscRowIdx;
    const vals = this._cscVals;
    for (let col = 0; col < n; col++) {
      const start = colPtr[col];
      const end = colPtr[col + 1];
      for (let k = start; k < end; k++) {
        if (rowIdx[k] === col) {
          vals[k] += gmin;
          break;
        }
      }
    }
  }

  /** Current COO triplet count (read-only access for the NR loop). */
  get cooCount(): number {
    return this._cooCount;
  }

  // =========================================================================
  // Harness instrumentation accessors (zero-cost when unused)
  // =========================================================================

  /** Current MNA matrix dimension. */
  get dimension(): number {
    return this._n;
  }

  /** Markowitz row counts (off-diagonal nonzeros per row). */
  get markowitzRow(): Int32Array {
    return this._markowitzRow;
  }

  /** Markowitz column counts (off-diagonal nonzeros per column). */
  get markowitzCol(): Int32Array {
    return this._markowitzCol;
  }

  /** Markowitz products: (rowCount-1)*(colCount-1) per diagonal entry. */
  get markowitzProd(): Float64Array {
    return this._markowitzProd;
  }

  /** Count of singleton rows/columns. */
  get singletons(): number {
    return this._singletons;
  }

  /**
   * Return a snapshot (copy) of the current RHS vector.
   * The returned array is owned by the caller — mutations do not
   * affect the solver's internal state.
   */
  getRhsSnapshot(): Float64Array {
    return this._rhs.slice(0, this._n);
  }

  /**
   * Enable or disable pre-solve RHS capture.
   * When enabled, finalize() snapshots the RHS after stamp assembly and
   * before factorization. Zero cost when disabled.
   */
  enablePreSolveRhsCapture(enabled: boolean): void {
    this._capturePreSolveRhs = enabled;
    if (enabled && (this._preSolveRhs === null || this._preSolveRhs.length !== this._n)) {
      this._preSolveRhs = new Float64Array(this._n);
    }
  }

  /**
   * Returns the pre-solve RHS snapshot captured during the last finalize() call.
   * Returns a zero-length array if capture is not enabled.
   */
  getPreSolveRhsSnapshot(): Float64Array {
    return this._preSolveRhs ?? new Float64Array(0);
  }

  /**
   * Return the assembled matrix as an array of CSC non-zero entries.
   * Each entry contains { row, col, value } in original (un-permuted)
   * node ordering. Used by the comparison harness to diff against
   * ngspice's matrix dump.
   *
   * Performance: O(nnz) — allocates one object per non-zero. Not for
   * hot-path use; intended for offline comparison only.
   */
  getCSCNonZeros(): Array<{ row: number; col: number; value: number }> {
    const n = this._n;
    const result: Array<{ row: number; col: number; value: number }> = [];
    for (let col = 0; col < n; col++) {
      const p0 = this._cscColPtr[col];
      const p1 = this._cscColPtr[col + 1];
      for (let p = p0; p < p1; p++) {
        result.push({ row: this._cscRowIdx[p], col, value: this._cscVals[p] });
      }
    }
    return result;
  }

  // =========================================================================
  // COO growth
  // =========================================================================

  private _growCOO(): void {
    const c = this._cooRows.length * 2;
    const r = new Int32Array(c), co = new Int32Array(c), v = new Float64Array(c);
    r.set(this._cooRows); co.set(this._cooCols); v.set(this._cooVals);
    this._cooRows = r; this._cooCols = co; this._cooVals = v;
  }

  // =========================================================================
  // CSC conversion
  // =========================================================================

  /**
   * Full CSC build: bucket COO triplets by column, insertion-sort each
   * bucket by row in place, dedup-sum duplicates, and record the
   * COO-index → CSC-position mapping for the fast path.
   *
   * Uses hoisted scratch buffers; the only allocations are lazy growths of
   * those buffers when nnz or matrix dimension exceeds their current capacity
   * (one-time cost for a fresh solver). Called on first finalize, after
   * `invalidateTopology()`, or on pivot-threshold failure during factor.
   */
  private _buildCSC(): void {
    const n = this._n;
    const nnz = this._cooCount;
    const cooRows = this._cooRows;
    const cooCols = this._cooCols;
    const cooVals = this._cooVals;

    // Grow scratch buffers if needed (one-time; reused on subsequent builds).
    if (this._bldColCount.length < n + 1) {
      this._bldColCount = new Int32Array(n + 1);
      this._bldColPos = new Int32Array(n);
    } else {
      this._bldColCount.fill(0, 0, n + 1);
    }
    if (this._bldBucketRows.length < nnz) {
      const cap = Math.max(nnz, this._bldBucketRows.length * 2);
      this._bldBucketRows = new Int32Array(cap);
      this._bldBucketCooIdx = new Int32Array(cap);
    }
    if (this._cooToCsc.length < nnz) {
      this._cooToCsc = new Int32Array(Math.max(nnz, this._cooToCsc.length * 2));
    }
    if (this._cscColPtr.length < n + 1) {
      this._cscColPtr = new Int32Array(n + 1);
    }
    // CSC output arrays — upper bound is nnz (before dedup); grow-only.
    if (this._cscRowIdx.length < nnz) {
      const cap = Math.max(nnz, this._cscRowIdx.length * 2);
      this._cscRowIdx = new Int32Array(cap);
      this._cscVals = new Float64Array(cap);
    }

    const colCount = this._bldColCount;
    const colPos = this._bldColPos;
    const bucketRows = this._bldBucketRows;
    const bucketCooIdx = this._bldBucketCooIdx;
    const cooToCsc = this._cooToCsc;
    const cscColPtr = this._cscColPtr;
    const cscRowIdx = this._cscRowIdx;
    const cscVals = this._cscVals;

    // Step 1: count nonzeros per column, then prefix-sum to column starts.
    for (let k = 0; k < nnz; k++) colCount[cooCols[k] + 1]++;
    for (let j = 0; j < n; j++) colCount[j + 1] += colCount[j];

    // Step 2: scatter COO triplets into their column buckets (unsorted),
    // carrying the original COO index so we can record cooToCsc later.
    for (let j = 0; j < n; j++) colPos[j] = colCount[j];
    for (let k = 0; k < nnz; k++) {
      const c = cooCols[k];
      const p = colPos[c]++;
      bucketRows[p] = cooRows[k];
      bucketCooIdx[p] = k;
    }

    // Step 3: per-column insertion sort by row (carrying cooIdx) + dedup sum.
    // Insertion sort is fine here — MNA matrix columns have very few nonzeros
    // (typically 2–6) so O(k²) per column is cheaper than comparator sort
    // and allocates nothing.
    let outPos = 0;
    for (let j = 0; j < n; j++) {
      const start = colCount[j];
      const end = colCount[j + 1];
      // Insertion sort [start, end) by bucketRows, moving bucketCooIdx in lockstep.
      for (let i = start + 1; i < end; i++) {
        const r = bucketRows[i];
        const idx = bucketCooIdx[i];
        let h = i - 1;
        while (h >= start && bucketRows[h] > r) {
          bucketRows[h + 1] = bucketRows[h];
          bucketCooIdx[h + 1] = bucketCooIdx[h];
          h--;
        }
        bucketRows[h + 1] = r;
        bucketCooIdx[h + 1] = idx;
      }
      // Dedup-sum: merge consecutive entries with equal row; record cooToCsc.
      cscColPtr[j] = outPos;
      let prevRow = -1;
      for (let i = start; i < end; i++) {
        const r = bucketRows[i];
        const origK = bucketCooIdx[i];
        if (r === prevRow) {
          cscVals[outPos - 1] += cooVals[origK];
          cooToCsc[origK] = outPos - 1;
        } else {
          cscRowIdx[outPos] = r;
          cscVals[outPos] = cooVals[origK];
          cooToCsc[origK] = outPos;
          outPos++;
          prevRow = r;
        }
      }
    }
    cscColPtr[n] = outPos;
  }

  /**
   * Fast path: refill `_cscVals` in place using the COO→CSC index map
   * recorded by the last `_buildCSC()`. Structure (`_cscColPtr`,
   * `_cscRowIdx`) is reused unchanged. Zero allocations.
   */
  private _refillCSC(): void {
    const nnz = this._cooCount;
    const vals = this._cscVals;
    const cooVals = this._cooVals;
    const map = this._cooToCsc;
    const cscNnz = this._cscColPtr[this._n];
    vals.fill(0, 0, cscNnz);
    for (let k = 0; k < nnz; k++) {
      vals[map[k]] += cooVals[k];
    }
  }

  // =========================================================================
  // AMD ordering
  // =========================================================================

  private _computeAMD(): void {
    const n = this._n;
    if (n <= 1) {
      this._perm = new Int32Array(n);
      this._permInv = new Int32Array(n);
      if (n === 1) { this._perm[0] = 0; this._permInv[0] = 0; }
      return;
    }

    const adj: Set<number>[] = [];
    for (let j = 0; j < n; j++) adj.push(new Set<number>());
    for (let j = 0; j < n; j++) {
      for (let p = this._cscColPtr[j]; p < this._cscColPtr[j + 1]; p++) {
        const i = this._cscRowIdx[p];
        if (i < 0 || i >= n) continue; // skip out-of-range indices (defensive)
        if (i !== j) { adj[j].add(i); adj[i].add(j); }
      }
    }

    const degree = new Int32Array(n);
    for (let j = 0; j < n; j++) degree[j] = adj[j].size;
    const eliminated = new Uint8Array(n);
    const perm = new Int32Array(n);
    const permInv = new Int32Array(n);

    for (let step = 0; step < n; step++) {
      let minDeg = n + 1, pivot = -1;
      for (let j = 0; j < n; j++) {
        if (!eliminated[j] && degree[j] < minDeg) { minDeg = degree[j]; pivot = j; }
      }
      perm[step] = pivot;
      permInv[pivot] = step;
      eliminated[pivot] = 1;

      const neighbors = Array.from(adj[pivot]);
      for (const u of neighbors) {
        if (eliminated[u]) continue;
        adj[u].delete(pivot);
        for (const v of neighbors) {
          if (v !== u && !eliminated[v]) adj[u].add(v);
        }
        degree[u] = adj[u].size;
      }
    }

    this._perm = perm;
    this._permInv = permInv;
  }

  // =========================================================================
  // Symbolic LU (once per topology change)
  // =========================================================================

  /**
   * Build elimination tree from the AMD-permuted CSC matrix.
   * Algorithm: cs_etree (Davis, Algorithm 4.4).
   */
  private _buildEtree(): void {
    const n = this._n;
    const perm = this._perm;
    const permInv = this._permInv;
    const etree = new Int32Array(n);
    const ancestor = new Int32Array(n);

    for (let j = 0; j < n; j++) {
      etree[j] = -1;
      ancestor[j] = -1;
    }

    for (let j = 0; j < n; j++) {
      const origJ = perm[j];
      for (let p = this._cscColPtr[origJ]; p < this._cscColPtr[origJ + 1]; p++) {
        let i = permInv[this._cscRowIdx[p]];
        if (i >= j) continue;

        while (ancestor[i] !== -1 && ancestor[i] !== j) {
          const next = ancestor[i];
          ancestor[i] = j;
          i = next;
        }

        if (ancestor[i] === -1) {
          ancestor[i] = j;
          etree[i] = j;
        }
      }
    }

    void etree; // _etree removed (unused)
  }

  /**
   * Symbolic LU phase. Replaces the old _allocateArrays.
   *
   * 1. Build elimination tree from AMD-permuted matrix
   * 2. Pre-allocate L, U storage with generous capacity
   * 3. Allocate workspace arrays
   */
  private _symbolicLU(): void {
    const n = this._n;

    this._buildEtree();

    // Dense workspace
    this._x = new Float64Array(n);

    // Nonzero index tracking for workspace clearing
    this._xNzIdx = new Int32Array(n);

    // DFS reach workspace
    this._reachStack = new Int32Array(n);
    this._dfsStack = new Int32Array(n);
    this._dfsChildPtr = new Int32Array(n);
    this._reachMark = new Int32Array(n);
    this._reachMark.fill(-1);

    // Pivot mappings
    this._pinv = new Int32Array(n);
    this._q = new Int32Array(n);

    // Solve scratch
    this._scratch = new Float64Array(n);

    // Pre-allocate L and U with generous capacity
    const nnzA = this._cscColPtr[n];
    const alloc = Math.max(nnzA * 6, n * 4);

    this._lColPtr = new Int32Array(n + 1);
    this._lRowIdx = new Int32Array(alloc);
    this._lVals = new Float64Array(alloc);

    this._uColPtr = new Int32Array(n + 1);
    this._uRowIdx = new Int32Array(alloc);
    this._uVals = new Float64Array(alloc);

    // Linked-list element pool for Markowitz fill-in tracking
    const elCap = Math.max(nnzA * 3, n * 4);
    this._elRow = new Int32Array(elCap);
    this._elCol = new Int32Array(elCap);
    this._elNextInRow = new Int32Array(elCap);
    this._elPrevInRow = new Int32Array(elCap);
    this._elNextInCol = new Int32Array(elCap);
    this._elPrevInCol = new Int32Array(elCap);
    this._elCapacity = elCap;
    this._rowHead = new Int32Array(n).fill(-1);
    this._colHead = new Int32Array(n).fill(-1);
    this._diag = new Int32Array(n).fill(-1);
    this._elMark = new Int32Array(n).fill(-1);
  }

  // =========================================================================
  // DFS reach through L's column structure
  // =========================================================================

  /**
   * Compute the reach of AMD-permuted column k through L's current structure.
   *
   * For each nonzero row in A[:,k] that has already been pivoted (pinv >= 0,
   * pinv < k), run an iterative DFS through L's columns to find all steps
   * j < k whose L columns participate in the sparse triangular solve for
   * column k.
   *
   * Returns `top` such that `_reachStack[top..n-1]` contains the reach set
   * in topological order (ascending step index — children before parents in
   * the L-column dependency graph). This is the correct order for the
   * left-looking L-solve: when processing step j, all steps it depends on
   * have already been processed.
   *
   * Complexity: O(|reach| + nnz in reached L columns) per call.
   * Total across all n columns: O(nnz(L)).
   */
  private _reach(k: number): number {
    const n = this._n;
    const pinv = this._pinv;
    const permInv = this._permInv;
    const mark = this._reachMark;
    const stack = this._reachStack;
    const dfs = this._dfsStack;
    const childPtr = this._dfsChildPtr;
    let top = n;

    // Seed DFS from each nonzero row of AMD-permuted A[:,k]
    const origJ = this._perm[k];
    for (let p = this._cscColPtr[origJ]; p < this._cscColPtr[origJ + 1]; p++) {
      const newI = permInv[this._cscRowIdx[p]];
      const j = pinv[newI]; // step at which this row was pivoted
      if (j < 0 || j >= k) continue; // not yet pivoted or step >= k
      if (mark[j] === k) continue; // already visited

      // Iterative DFS from step j through L's columns
      mark[j] = k;
      let head = 0;
      dfs[0] = j;
      childPtr[0] = this._lColPtr[j];

      while (head >= 0) {
        const cur = dfs[head];
        const p1 = this._lColPtr[cur + 1];
        let found = false;

        // Scan L[:,cur] for next unvisited child step
        for (let lp = childPtr[head]; lp < p1; lp++) {
          const s = pinv[this._lRowIdx[lp]];
          if (s < 0 || s >= k || mark[s] === k) continue;
          // Found unvisited child — push it
          mark[s] = k;
          childPtr[head] = lp + 1; // save scan progress
          head++;
          dfs[head] = s;
          childPtr[head] = this._lColPtr[s];
          found = true;
          break;
        }

        if (!found) {
          // All children visited — post-order: push to result
          head--;
          stack[--top] = cur;
        }
      }
    }

    return top;
  }

  // =========================================================================
  // Numeric LU factorization
  // =========================================================================

  /**
   * Numeric LU factorization with Markowitz pivot selection.
   * Uses 4-phase Markowitz pivot ordering: singleton detection, diagonal
   * preference, column search, and full matrix fallback. After each pivot
   * choice, Markowitz numbers are updated for the remaining submatrix.
   * ngspice: spOrderAndFactor (spfactor.c).
   */
  private _numericLUMarkowitz(): FactorResult {
    const n = this._n;
    if (n === 0) return { success: true };

    const x = this._x;
    const xNzIdx = this._xNzIdx;
    const pinv = this._pinv;
    const q = this._q;
    const permInv = this._permInv;

    let lnz = 0;
    let unz = 0;

    pinv.fill(-1);
    this._reachMark.fill(-1);

    this._buildLinkedMatrix();

    for (let k = 0; k < n; k++) {
      this._lColPtr[k] = lnz;
      this._uColPtr[k] = unz;

      if (lnz + n > this._lRowIdx.length) this._growL(lnz + n);
      if (unz + n > this._uRowIdx.length) this._growU(unz + n);

      let xNzCount = 0;
      const origJ = this._perm[k];
      for (let p = this._cscColPtr[origJ]; p < this._cscColPtr[origJ + 1]; p++) {
        const newI = permInv[this._cscRowIdx[p]];
        if (x[newI] === 0) xNzIdx[xNzCount++] = newI;
        x[newI] += this._cscVals[p];
      }

      const reachTop = this._reach(k);
      const reachStack = this._reachStack;
      for (let ri = reachTop; ri < n; ri++) {
        const j = reachStack[ri];
        const qj = q[j];
        if (x[qj] === 0) continue;

        const ljp0 = this._lColPtr[j];
        const ljp1 = this._lColPtr[j + 1];
        for (let lp = ljp0; lp < ljp1; lp++) {
          const li = this._lRowIdx[lp];
          if (x[li] === 0) xNzIdx[xNzCount++] = li;
          x[li] -= this._lVals[lp] * x[qj];
        }
      }

      // Detect and record fill-in entries in column k.
      // Mark existing entries in column k via the linked structure.
      let me = this._colHead[k];
      while (me >= 0) {
        this._elMark[this._elRow[me]] = k;
        me = this._elNextInCol[me];
      }

      // Check all nonzero rows — if unmarked and unpivoted, it's fill-in
      let hadFillin = false;
      for (let idx = 0; idx < xNzCount; idx++) {
        const i = xNzIdx[idx];
        if (x[i] === 0 || pinv[i] >= 0) continue;
        if (this._elMark[i] === k) continue; // existing entry
        // Fill-in at (i, k)
        const e = this._allocElement(i, k);
        this._insertIntoRow(e, i);
        this._insertIntoCol(e, k);
        this._markowitzRow[i]++;
        this._markowitzCol[k]++;
        hadFillin = true;
      }

      // Recompute Markowitz products and singletons after fill-in
      if (hadFillin) {
        let singletons = 0;
        for (let i = 0; i < n; i++) {
          if (pinv[i] >= 0) continue;
          this._markowitzProd[i] = this._markowitzRow[i] * this._markowitzCol[i];
          if (this._markowitzProd[i] === 0) singletons++;
        }
        this._singletons = singletons;
      }

      // 4-phase Markowitz pivot selection (ngspice spOrderAndFactor).
      const pivotRow = this._searchForPivot(k, x, xNzIdx, xNzCount, pinv);

      if (pivotRow < 0) {
        for (let idx = 0; idx < xNzCount; idx++) x[xNzIdx[idx]] = 0;
        return { success: false, singularRow: k };
      }

      pinv[pivotRow] = k;
      q[k] = pivotRow;

      const diagVal = x[pivotRow];
      if (Math.abs(diagVal) < 1e-300) {
        for (let idx = 0; idx < xNzCount; idx++) x[xNzIdx[idx]] = 0;
        return { success: false, singularRow: k };
      }

      // Update Markowitz numbers via linked-list traversal
      if (k < n - 1) {
        this._updateMarkowitzNumbers(k, pivotRow, pinv);
      }

      // Store U entries (already-pivoted rows + diagonal)
      void unz;
      for (let idx = 0; idx < xNzCount; idx++) {
        const i = xNzIdx[idx];
        if (x[i] === 0) continue;
        const s = pinv[i];
        if (s >= 0 && s < k) {
          this._uRowIdx[unz] = i;
          this._uVals[unz] = x[i];
          unz++;
        }
      }
      this._uRowIdx[unz] = pivotRow;
      this._uVals[unz] = diagVal;
      unz++;

      // Store L entries (unpivoted rows, scaled by 1/diagonal)
      for (let idx = 0; idx < xNzCount; idx++) {
        const i = xNzIdx[idx];
        if (x[i] === 0) continue;
        if (pinv[i] >= 0) continue;
        this._lRowIdx[lnz] = i;
        this._lVals[lnz] = x[i] / diagVal;
        lnz++;
      }

      for (let idx = 0; idx < xNzCount; idx++) x[xNzIdx[idx]] = 0;
    }

    this._lColPtr[n] = lnz;
    this._uColPtr[n] = unz;

    let maxDiag = 0, minDiag = Infinity;
    for (let k = 0; k < n; k++) {
      const e = this._uColPtr[k + 1];
      if (e > this._uColPtr[k]) {
        const v = Math.abs(this._uVals[e - 1]);
        if (v > maxDiag) maxDiag = v;
        if (v < minDiag) minDiag = v;
      }
    }

    return { success: true, conditionEstimate: minDiag > 0 ? maxDiag / minDiag : Infinity };
  }

  /**
   * Numeric LU factorization that reuses pivot order from a prior
   * factorWithReorder call. Skips pivot search — uses stored pinv[]/q[].
   *
   * ngspice: spFactor (spfactor.c) — the "fast" factorization path
   * used on NR iterations 2+ within the same operating point.
   */
  private _numericLUReusePivots(): FactorResult {
    const n = this._n;
    if (n === 0) return { success: true };

    const x = this._x;
    const xNzIdx = this._xNzIdx;
    const pinv = this._pinv;
    const q = this._q;
    const permInv = this._permInv;

    let lnz = 0;
    let unz = 0;

    this._reachMark.fill(-1);

    for (let k = 0; k < n; k++) {
      this._lColPtr[k] = lnz;
      this._uColPtr[k] = unz;

      if (lnz + n > this._lRowIdx.length) this._growL(lnz + n);
      if (unz + n > this._uRowIdx.length) this._growU(unz + n);

      let xNzCount = 0;
      const origJ = this._perm[k];
      for (let p = this._cscColPtr[origJ]; p < this._cscColPtr[origJ + 1]; p++) {
        const newI = permInv[this._cscRowIdx[p]];
        if (x[newI] === 0) xNzIdx[xNzCount++] = newI;
        x[newI] += this._cscVals[p];
      }

      const reachTop = this._reach(k);
      const reachStack = this._reachStack;
      for (let ri = reachTop; ri < n; ri++) {
        const j = reachStack[ri];
        const qj = q[j];
        if (x[qj] === 0) continue;

        const ljp0 = this._lColPtr[j];
        const ljp1 = this._lColPtr[j + 1];
        for (let lp = ljp0; lp < ljp1; lp++) {
          const li = this._lRowIdx[lp];
          if (x[li] === 0) xNzIdx[xNzCount++] = li;
          x[li] -= this._lVals[lp] * x[qj];
        }
      }

      const pivotRow = q[k];
      const diagVal = x[pivotRow];
      if (Math.abs(diagVal) < PIVOT_ABS_THRESHOLD) {
        for (let idx = 0; idx < xNzCount; idx++) x[xNzIdx[idx]] = 0;
        return { success: false };
      }

      void unz;
      for (let idx = 0; idx < xNzCount; idx++) {
        const i = xNzIdx[idx];
        if (x[i] === 0) continue;
        const s = pinv[i];
        if (s >= 0 && s < k) {
          this._uRowIdx[unz] = i;
          this._uVals[unz] = x[i];
          unz++;
        }
      }
      this._uRowIdx[unz] = pivotRow;
      this._uVals[unz] = diagVal;
      unz++;

      for (let idx = 0; idx < xNzCount; idx++) {
        const i = xNzIdx[idx];
        if (x[i] === 0) continue;
        if (pinv[i] <= k) continue;
        this._lRowIdx[lnz] = i;
        this._lVals[lnz] = x[i] / diagVal;
        lnz++;
      }

      for (let idx = 0; idx < xNzCount; idx++) x[xNzIdx[idx]] = 0;
    }

    this._lColPtr[n] = lnz;
    this._uColPtr[n] = unz;

    let maxDiag = 0, minDiag = Infinity;
    for (let k = 0; k < n; k++) {
      const e = this._uColPtr[k + 1];
      if (e > this._uColPtr[k]) {
        const v = Math.abs(this._uVals[e - 1]);
        if (v > maxDiag) maxDiag = v;
        if (v < minDiag) minDiag = v;
      }
    }

    return { success: true, conditionEstimate: minDiag > 0 ? maxDiag / minDiag : Infinity };
  }

  // =========================================================================
  // Factorization public API
  // =========================================================================

  // =========================================================================
  // Linked-list element pool for Markowitz fill-in tracking
  // =========================================================================

  /**
   * Allocate an element slot from the pool.
   * ngspice: spcreate.c CreateFillin (allocation portion).
   *
   * @returns element index
   */
  private _allocElement(row: number, col: number): number {
    if (this._elCount >= this._elCapacity) this._growElements();
    const e = this._elCount++;
    this._elRow[e] = row;
    this._elCol[e] = col;
    this._elNextInRow[e] = -1;
    this._elPrevInRow[e] = -1;
    this._elNextInCol[e] = -1;
    this._elPrevInCol[e] = -1;
    return e;
  }

  /**
   * Insert element `e` at the head of row `row`'s chain. O(1).
   */
  private _insertIntoRow(e: number, row: number): void {
    const head = this._rowHead[row];
    this._elNextInRow[e] = head;
    this._elPrevInRow[e] = -1;
    if (head >= 0) this._elPrevInRow[head] = e;
    this._rowHead[row] = e;
  }

  /**
   * Insert element `e` at the head of column `col`'s chain. O(1).
   */
  private _insertIntoCol(e: number, col: number): void {
    const head = this._colHead[col];
    this._elNextInCol[e] = head;
    this._elPrevInCol[e] = -1;
    if (head >= 0) this._elPrevInCol[head] = e;
    this._colHead[col] = e;
  }

  /**
   * Remove element `e` from its row chain. O(1).
   */
  private _removeFromRow(e: number): void {
    const prev = this._elPrevInRow[e];
    const next = this._elNextInRow[e];
    if (prev >= 0) this._elNextInRow[prev] = next;
    else this._rowHead[this._elRow[e]] = next;
    if (next >= 0) this._elPrevInRow[next] = prev;
  }

  /**
   * Remove element `e` from its column chain. O(1).
   */
  private _removeFromCol(e: number): void {
    const prev = this._elPrevInCol[e];
    const next = this._elNextInCol[e];
    if (prev >= 0) this._elNextInCol[prev] = next;
    else this._colHead[this._elCol[e]] = next;
    if (next >= 0) this._elPrevInCol[next] = prev;
  }

  /**
   * Double all 6 element arrays when pool is full.
   * Same growth pattern as _growL/_growU.
   */
  private _growElements(): void {
    const newCap = this._elCapacity * 2;
    const grow = (old: Int32Array): Int32Array => {
      const a = new Int32Array(newCap);
      a.set(old);
      return a;
    };
    this._elRow = grow(this._elRow);
    this._elCol = grow(this._elCol);
    this._elNextInRow = grow(this._elNextInRow);
    this._elPrevInRow = grow(this._elPrevInRow);
    this._elNextInCol = grow(this._elNextInCol);
    this._elPrevInCol = grow(this._elPrevInCol);
    this._elCapacity = newCap;
  }

  /**
   * Build linked structure from CSC in AMD-permuted order.
   * Called at the top of _numericLUMarkowitz, replacing
   * _countMarkowitz() + _markowitzProducts().
   *
   * ngspice variable mapping:
   * | ngspice (spfactor.c)       | ours                    |
   * |----------------------------|-------------------------|
   * | MarkowitzRow[i]            | _markowitzRow[i]        |
   * | MarkowitzCol[i]            | _markowitzCol[i]        |
   * | MarkowitzProduct[i]        | _markowitzProd[i]       |
   * | Singletons                 | _singletons             |
   * | Element->NextInRow         | _elNextInRow[e]         |
   * | Element->NextInCol         | _elNextInCol[e]         |
   * | Element->Row               | _elRow[e]               |
   * | Element->Col               | _elCol[e]               |
   */
  private _buildLinkedMatrix(): void {
    const n = this._n;
    this._elCount = 0;
    this._rowHead.fill(-1);
    this._colHead.fill(-1);
    this._diag.fill(-1);
    this._elMark.fill(-1);

    // Walk CSC in AMD-permuted order
    for (let amdCol = 0; amdCol < n; amdCol++) {
      const origCol = this._perm[amdCol];
      for (let p = this._cscColPtr[origCol]; p < this._cscColPtr[origCol + 1]; p++) {
        const amdRow = this._permInv[this._cscRowIdx[p]];
        const e = this._allocElement(amdRow, amdCol);
        this._insertIntoRow(e, amdRow);
        this._insertIntoCol(e, amdCol);
        if (amdRow === amdCol) this._diag[amdRow] = e;
      }
    }

    // Compute initial Markowitz counts from linked structure
    const mRow = this._markowitzRow;
    const mCol = this._markowitzCol;
    const mProd = this._markowitzProd;
    let singletons = 0;

    for (let i = 0; i < n; i++) {
      let rc = 0;
      let e = this._rowHead[i];
      while (e >= 0) { rc++; e = this._elNextInRow[e]; }
      mRow[i] = rc > 0 ? rc - 1 : 0; // exclude diagonal

      let cc = 0;
      e = this._colHead[i];
      while (e >= 0) { cc++; e = this._elNextInCol[e]; }
      mCol[i] = cc > 0 ? cc - 1 : 0;

      mProd[i] = mRow[i] * mCol[i];
      if (mProd[i] === 0 && (mRow[i] <= 1 || mCol[i] <= 1)) singletons++;
    }
    this._singletons = singletons;
  }

  /**
   * Count off-diagonal nonzeros per row and per column in the CSC matrix.
   * Populates _markowitzRow and _markowitzCol in AMD-permuted space.
   * ngspice: CountMarkowitz in spfactor.c.
   */
  private _countMarkowitz(): void {
    const n = this._n;
    const colPtr = this._cscColPtr;
    const rowIdx = this._cscRowIdx;
    const perm = this._perm;
    const permInv = this._permInv;
    const mRow = this._markowitzRow;
    const mCol = this._markowitzCol;

    mRow.fill(0);
    mCol.fill(0);

    for (let k = 0; k < n; k++) {
      const origCol = perm[k];
      const start = colPtr[origCol];
      const end = colPtr[origCol + 1];
      let colCount = 0;
      for (let p = start; p < end; p++) {
        const origRow = rowIdx[p];
        const permRow = permInv[origRow];
        if (permRow === k) continue;
        colCount++;
        mRow[permRow]++;
      }
      mCol[k] = colCount;
    }
  }

  /**
   * Compute Markowitz products and count singletons.
   * Product for diagonal i = (markowitzRow[i] - 1) * (markowitzCol[i] - 1).
   * A singleton is a row or column with exactly 1 off-diagonal nonzero.
   * ngspice: MarkowitzProducts in spfactor.c.
   */
  private _markowitzProducts(): void {
    const n = this._n;
    const mRow = this._markowitzRow;
    const mCol = this._markowitzCol;
    const mProd = this._markowitzProd;
    let singletons = 0;

    for (let i = 0; i < n; i++) {
      const rr = mRow[i];
      const cc = mCol[i];
      if (rr <= 1 || cc <= 1) {
        singletons++;
        mProd[i] = 0;
      } else {
        mProd[i] = (rr - 1) * (cc - 1);
      }
    }

    this._singletons = singletons;
  }

  /**
   * 4-phase Markowitz-primary pivot search matching ngspice's SearchForPivot.
   *
   * Phase 1: Singleton detection — rows with Markowitz product == 0 and
   *          magnitude >= relThreshold. Pick largest magnitude among those.
   * Phase 2: Diagonal preference — among unpivoted diagonals passing magnitude
   *          threshold, find minimum Markowitz product.
   * Phase 3: Column search — walk _colHead[k] chain. Among unpivoted rows
   *          with |x[row]| >= relThreshold, find minimum mRow[row]*mCol[k]
   *          product. Tiebreak by largest magnitude.
   * Phase 4: Fallback — largest magnitude among all unpivoted rows.
   *
   * The relative threshold is `PIVOT_THRESHOLD * absMax` — Markowitz product
   * is primary, magnitude ensures numerical stability.
   *
   * ngspice variable mapping:
   * | ngspice (spfactor.c)       | ours                    |
   * |----------------------------|-------------------------|
   * | MarkowitzRow[]             | _markowitzRow[]         |
   * | MarkowitzCol[]             | _markowitzCol[]         |
   * | MarkowitzProduct[]         | _markowitzProd[]        |
   * | Singletons                 | _singletons             |
   * | RelThreshold               | PIVOT_THRESHOLD         |
   * | AbsThreshold               | PIVOT_ABS_THRESHOLD     |
   * | pPivot                     | return value            |
   * | Step                       | k parameter             |
   * | SearchForSingleton()       | phase 1                 |
   * | QuicklySearchDiagonal()    | phase 2                 |
   * | SearchEntireMatrix()       | phases 3+4              |
   *
   * @returns AMD-permuted row index of chosen pivot, or -1 if singular
   */
  private _searchForPivot(
    k: number,
    x: Float64Array,
    xNzIdx: Int32Array,
    xNzCount: number,
    pinv: Int32Array
  ): number {
    const mProd = this._markowitzProd;
    const mRow = this._markowitzRow;
    const mCol = this._markowitzCol;

    // Compute max magnitude among unpivoted rows for relative threshold
    let absMax = 0;
    for (let idx = 0; idx < xNzCount; idx++) {
      const i = xNzIdx[idx];
      if (pinv[i] >= 0) continue;
      const v = Math.abs(x[i]);
      if (v > absMax) absMax = v;
    }

    if (absMax === 0) return -1;

    const relThreshold = PIVOT_THRESHOLD * absMax;

    // Phase 1: Singletons — rows with mProd == 0, magnitude >= relThreshold
    if (this._singletons > 0) {
      let bestRow = -1;
      let bestVal = 0;
      for (let idx = 0; idx < xNzCount; idx++) {
        const i = xNzIdx[idx];
        if (pinv[i] >= 0) continue;
        if (mProd[i] !== 0) continue;
        const v = Math.abs(x[i]);
        if (v < PIVOT_ABS_THRESHOLD || v < relThreshold) continue;
        if (v > bestVal) {
          bestVal = v;
          bestRow = i;
        }
      }
      if (bestRow >= 0) return bestRow;
    }

    // Phase 2: Diagonal preference — minimum mProd among unpivoted diagonals
    // passing magnitude threshold
    {
      let bestRow = -1;
      let bestProd = Infinity;
      let bestVal = 0;
      for (let idx = 0; idx < xNzCount; idx++) {
        const i = xNzIdx[idx];
        if (pinv[i] >= 0) continue;
        // Diagonal entry: row == column in AMD space. For column k, check i == k.
        if (i !== k) continue;
        const v = Math.abs(x[i]);
        if (v < PIVOT_ABS_THRESHOLD || v < relThreshold) continue;
        const prod = mProd[i];
        if (prod < bestProd || (prod === bestProd && v > bestVal)) {
          bestProd = prod;
          bestVal = v;
          bestRow = i;
        }
      }
      if (bestRow >= 0) return bestRow;
    }

    // Phase 3: Column search — walk _colHead[k] chain via linked structure.
    // Among unpivoted rows with |x[row]| >= relThreshold, find minimum
    // mRow[row] * mCol[k] product. Tiebreak by largest magnitude.
    {
      let bestRow = -1;
      let bestProd = Infinity;
      let bestVal = 0;
      let e = this._colHead[k];
      while (e >= 0) {
        const row = this._elRow[e];
        if (pinv[row] < 0) {
          const v = Math.abs(x[row]);
          if (v >= PIVOT_ABS_THRESHOLD && v >= relThreshold) {
            const prod = mRow[row] * mCol[k];
            if (prod < bestProd || (prod === bestProd && v > bestVal)) {
              bestProd = prod;
              bestVal = v;
              bestRow = row;
            }
          }
        }
        e = this._elNextInCol[e];
      }
      if (bestRow >= 0) return bestRow;
    }

    // Phase 4: Fallback — largest magnitude among all unpivoted rows
    {
      let bestRow = -1;
      let bestVal = 0;
      for (let idx = 0; idx < xNzCount; idx++) {
        const i = xNzIdx[idx];
        if (pinv[i] >= 0) continue;
        const v = Math.abs(x[i]);
        if (v > bestVal) {
          bestVal = v;
          bestRow = i;
        }
      }
      return bestRow; // -1 if truly singular
    }
  }

  /**
   * Update Markowitz numbers after eliminating pivot at step `step`.
   * Walks linked lists to decrement row/col counts for entries affected
   * by the pivot row/col, then recalculates products and singleton count.
   *
   * ngspice: UpdateMarkowitzNumbers in spfactor.c.
   *
   * ngspice variable mapping:
   * | ngspice (spfactor.c)          | ours                         |
   * |-------------------------------|------------------------------|
   * | UpdateMarkowitzNumbers()      | _updateMarkowitzNumbers()    |
   * | MarkowitzRow[i]               | _markowitzRow[i]             |
   * | MarkowitzCol[i]               | _markowitzCol[i]             |
   * | MarkowitzProduct[i]           | _markowitzProd[i]            |
   * | Singletons                    | _singletons                  |
   * | Element->NextInRow            | _elNextInRow[e]              |
   * | Element->NextInCol            | _elNextInCol[e]              |
   *
   * @param step The elimination step just completed
   * @param pivotRow The row chosen as pivot
   * @param pinv Pivot inverse mapping
   */
  private _updateMarkowitzNumbers(
    step: number,
    pivotRow: number,
    pinv: Int32Array
  ): void {
    const mRow = this._markowitzRow;
    const mCol = this._markowitzCol;
    const mProd = this._markowitzProd;

    // Walk pivot ROW — decrement column counts and remove from column chains
    let e = this._rowHead[pivotRow];
    while (e >= 0) {
      const c = this._elCol[e];
      const next = this._elNextInRow[e];
      if (c !== step && mCol[c] > 0) mCol[c]--;
      this._removeFromCol(e);
      e = next;
    }
    this._rowHead[pivotRow] = -1;

    // Walk pivot COLUMN — decrement row counts and remove from row chains
    e = this._colHead[step];
    while (e >= 0) {
      const r = this._elRow[e];
      const next = this._elNextInCol[e];
      if (r !== pivotRow && mRow[r] > 0) mRow[r]--;
      this._removeFromRow(e);
      e = next;
    }
    this._colHead[step] = -1;

    // Recompute products and singletons
    let singletons = 0;
    for (let i = 0; i < this._n; i++) {
      if (pinv[i] >= 0) continue;
      mProd[i] = mRow[i] * mCol[i];
      if (mProd[i] === 0) singletons++;
    }
    this._singletons = singletons;
  }

  /**
   * Apply gmin conductance to CSC diagonal entries.
   * Extracted from addDiagonalGmin for use within factor paths.
   */
  private _applyDiagGmin(diagGmin: number): void {
    const n = this._n;
    const colPtr = this._cscColPtr;
    const rowIdx = this._cscRowIdx;
    const vals = this._cscVals;
    for (let col = 0; col < n; col++) {
      const start = colPtr[col];
      const end = colPtr[col + 1];
      for (let k = start; k < end; k++) {
        if (rowIdx[k] === col) {
          vals[k] += diagGmin;
          break;
        }
      }
    }
  }

  /**
   * Full factorization with AMD reordering and pivot selection.
   * ngspice: spOrderAndFactor (spfactor.c).
   *
   * Rebuilds CSC + AMD + symbolic LU if topology is dirty, then runs
   * numeric LU with full pivot search. Establishes the pivot order
   * (pinv[]/q[]) that factorNumerical will reuse.
   */
  factorWithReorder(diagGmin?: number): FactorResult {
    if (diagGmin) this._applyDiagGmin(diagGmin);
    if (this._needsReorder) {
      this._buildCSC();
      this._computeAMD();
      this._symbolicLU();
      this._needsReorder = false;
      this._topologyDirty = false;
      this._prevCooCount = this._cooCount;
    }
    const result = this._numericLUMarkowitz();
    if (result.success) this._hasPivotOrder = true;
    return result;
  }

  /**
   * Numerical-only factorization reusing pivot order from last
   * factorWithReorder call. Skips pivot search for performance.
   * ngspice: spFactor (spfactor.c).
   *
   * Returns { success: false } if the stored pivot gives a near-zero
   * diagonal value, signaling the NR loop should set shouldReorder=true.
   */
  factorNumerical(diagGmin?: number): FactorResult {
    if (diagGmin) this._applyDiagGmin(diagGmin);
    return this._numericLUReusePivots();
  }

  // =========================================================================
  // Storage growth
  // =========================================================================

  private _growL(min: number): void {
    const sz = Math.max(min, this._lRowIdx.length * 2);
    const r = new Int32Array(sz), v = new Float64Array(sz);
    r.set(this._lRowIdx); v.set(this._lVals);
    this._lRowIdx = r; this._lVals = v;
  }

  private _growU(min: number): void {
    const sz = Math.max(min, this._uRowIdx.length * 2);
    const r = new Int32Array(sz), v = new Float64Array(sz);
    r.set(this._uRowIdx); v.set(this._uVals);
    this._uRowIdx = r; this._uVals = v;
  }
}
