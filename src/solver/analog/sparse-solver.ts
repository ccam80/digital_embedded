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
  // After the first NR iteration establishes the sparsity pattern, we
  // snapshot the CSC values produced by linear stamps alone. Subsequent
  // iterations restore this snapshot and scatter-add only nonlinear COO
  // entries, avoiding redundant linear stamp() calls and their COO→CSC
  // scatter work.
  /** Snapshot of CSC values after linear-only scatter. */
  private _linearBaseVals: Float64Array = new Float64Array(0);
  /** Snapshot of RHS after linear stamping (captured before nonlinear stamps). */
  private _linearBaseRhs: Float64Array = new Float64Array(0);
  /** Number of live CSC entries at snapshot time. */
  private _linearBaseCscNnz = 0;
  /** Matrix dimension at snapshot time. */
  private _linearBaseN = 0;
  /** Whether a valid linear-base snapshot exists. */
  private _hasLinearBase = false;

  // -- Mode-driven reorder flag --
  private _needsReorder: boolean = false;

  // -- Preorder flag --
  private _didPreorder: boolean = false;

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
    this._hasLinearBase = false;
    if (this._rhs.length !== size) {
      this._rhs = new Float64Array(size);
    } else {
      this._rhs.fill(0);
    }
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
  finalize(cooStart = 0): void {
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
      this._hasLinearBase = false; // topology change invalidates snapshot
    } else {
      this._refillCSC(cooStart);
    }

    if (this._capturePreSolveRhs && this._preSolveRhs) {
      if (this._preSolveRhs.length !== this._n) {
        this._preSolveRhs = new Float64Array(this._n);
      }
      this._preSolveRhs.set(this._rhs.subarray(0, this._n));
    }
  }

  factor(): FactorResult {
    return { success: false };
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

  // =========================================================================
  // Linear-base snapshot for NR loop optimization
  // =========================================================================

  /**
   * Capture the current RHS as the "linear-only" RHS snapshot.
   *
   * Called after stampLinear() but BEFORE stampNonlinear(), so the snapshot
   * contains only linear RHS contributions. The CSC-values snapshot is
   * taken separately by saveLinearBase() after finalize().
   */
  captureLinearRhs(): void {
    const n = this._n;
    if (this._linearBaseRhs.length < n) {
      this._linearBaseRhs = new Float64Array(n);
    }
    const baseRhs = this._linearBaseRhs;
    const rhs = this._rhs;
    // Index-based copy -- no subarray() view allocation
    for (let i = 0; i < n; i++) baseRhs[i] = rhs[i];
    this._linearBaseN = n;
  }

  /**
   * Snapshot the CSC values produced by linear stamps alone.
   *
   * Called once after the first NR iteration's full assembly (beginAssembly +
   * stampLinear + stampNonlinear + finalize). captureLinearRhs() must have
   * been called earlier (after stampLinear, before stampNonlinear) to capture
   * the RHS half of the snapshot.
   *
   * The CSC snapshot is computed by scatter-adding only the linear portion
   * of the COO array [0, linearCooCount) into a zeroed buffer using the
   * existing _cooToCsc index map.
   *
   * @param linearCooCount - Number of COO triplets from stampLinear
   */
  saveLinearBase(linearCooCount: number): void {
    const cscNnz = this._cscColPtr[this._n];

    // Grow-only allocation for the CSC snapshot buffer
    if (this._linearBaseVals.length < cscNnz) {
      this._linearBaseVals = new Float64Array(cscNnz);
    }
    // Zero and scatter-add only linear COO entries [0, linearCooCount).
    const baseVals = this._linearBaseVals;
    baseVals.fill(0, 0, cscNnz);
    const map = this._cooToCsc;
    const cooVals = this._cooVals;
    for (let k = 0; k < linearCooCount; k++) {
      baseVals[map[k]] += cooVals[k];
    }

    this._linearBaseCscNnz = cscNnz;
    this._hasLinearBase = true;
  }

  /**
   * Restore CSC values and RHS to the linear-base snapshot.
   *
   * After this call, _cscVals contains only linear contributions and _rhs
   * is reset to the linear-only state. The caller then re-stamps nonlinear
   * contributions into COO (starting at linearCooCount) and calls
   * finalize(linearCooCount) to scatter-add only the nonlinear portion.
   *
   * Uses index-based for loops instead of Float64Array.set(subarray()) to
   * avoid allocating TypedArray view objects on every NR iteration.
   *
   * Precondition: saveLinearBase() was called earlier in this NR solve.
   */
  restoreLinearBase(): void {
    const cscNnz = this._linearBaseCscNnz;
    const n = this._linearBaseN;
    const baseVals = this._linearBaseVals;
    const baseRhs = this._linearBaseRhs;
    const vals = this._cscVals;
    const rhs = this._rhs;
    for (let i = 0; i < cscNnz; i++) vals[i] = baseVals[i];
    for (let i = 0; i < n; i++) rhs[i] = baseRhs[i];
  }

  /** Whether a valid linear-base snapshot exists. */
  get hasLinearBase(): boolean {
    return this._hasLinearBase;
  }

  /** Reset the COO write cursor to a given position (for nonlinear re-stamping). */
  setCooCount(count: number): void {
    this._cooCount = count;
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
  /**
   * Refill CSC values from COO triplets.
   *
   * @param cooStart - First COO index to scatter. Pass 0 for a full refill
   *   (zeros _cscVals then scatters all COO entries). Pass a nonzero value
   *   when the linear base has already been restored into _cscVals -- only
   *   nonlinear COO entries [cooStart, _cooCount) are scatter-added on top.
   */
  private _refillCSC(cooStart = 0): void {
    const nnz = this._cooCount;
    const vals = this._cscVals;
    const cooVals = this._cooVals;
    const map = this._cooToCsc;

    if (cooStart === 0) {
      // Full refill: zero all CSC values, scatter all COO triplets.
      const cscNnz = this._cscColPtr[this._n];
      vals.fill(0, 0, cscNnz);
      for (let k = 0; k < nnz; k++) {
        vals[map[k]] += cooVals[k];
      }
    } else {
      // Partial refill: CSC already contains the linear base via
      // restoreLinearBase(); scatter-add only the nonlinear COO triplets.
      for (let k = cooStart; k < nnz; k++) {
        vals[map[k]] += cooVals[k];
      }
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
   * Left-looking sparse LU factorization with partial pivoting.
   *
   * For each column k (in AMD order):
   *   1. Scatter AMD-permuted A[:,k] into dense workspace x[]
   *   2. Sparse triangular solve via DFS reach through L
   *   3. Partial pivot: find best |x[i]| among unpivoted rows
   *   4. Record pivot: pinv[bestRow] = k, q[k] = bestRow
   *   5. Store U[:,k] entries (from already-pivoted rows + diagonal)
   *   6. Store L[:,k] entries (from unpivoted rows, scaled by 1/diag)
   *   7. Clear workspace (only touched entries)
   */
  private _numericLU(): FactorResult {
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

      let absMax = 0;
      for (let idx = 0; idx < xNzCount; idx++) {
        const i = xNzIdx[idx];
        if (pinv[i] >= 0) continue;
        const v = Math.abs(x[i]);
        if (v > absMax) absMax = v;
      }

      if (absMax === 0) {
        for (let idx = 0; idx < xNzCount; idx++) x[xNzIdx[idx]] = 0;
        return { success: false, singularRow: k };
      }

      const relThreshold = PIVOT_THRESHOLD * absMax;

      let maxVal = 0;
      let pivotRow = -1;
      for (let idx = 0; idx < xNzCount; idx++) {
        const i = xNzIdx[idx];
        if (pinv[i] >= 0) continue;
        if (x[i] === 0) continue;
        const v = Math.abs(x[i]);
        if (v < relThreshold || v < PIVOT_ABS_THRESHOLD) continue;
        if (v > maxVal) { maxVal = v; pivotRow = i; }
      }

      if (pivotRow < 0) {
        maxVal = 0;
        for (let idx = 0; idx < xNzCount; idx++) {
          const i = xNzIdx[idx];
          if (pinv[i] >= 0) continue;
          const v = Math.abs(x[i]);
          if (v > maxVal) { maxVal = v; pivotRow = i; }
        }
      }

      pinv[pivotRow] = k;
      q[k] = pivotRow;

      const diagVal = x[pivotRow];
      if (Math.abs(diagVal) < 1e-300) {
        for (let idx = 0; idx < xNzCount; idx++) x[xNzIdx[idx]] = 0;
        return { success: false, singularRow: k };
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
      this._hasLinearBase = false;
    }
    return this._numericLU();
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
