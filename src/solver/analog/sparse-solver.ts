/**
 * Sparse linear solver for MNA circuit simulation.
 *
 * Architecture: Persistent linked-list matrix format matching ngspice spMatrix.
 * The linked structure is the primary storage — no COO triplet arrays.
 * Assembly: allocElement() at compile time, stampElement() in NR hot path.
 * LU factorization: Markowitz pivot selection on original column order (no AMD).
 * Solve: sparse forward/backward substitution on CSC L/U built from linked structure.
 *
 * ngspice references:
 *   spGetElement (spbuild.c) — allocElement
 *   spOrderAndFactor (spfactor.c) — factorWithReorder
 *   spFactor (spfactor.c) — factorNumerical
 *   spSolve (spsolve.c) — solve
 */

export interface FactorResult {
  success: boolean;
  conditionEstimate?: number;
  singularRow?: number;
  /**
   * True when factorNumerical detected that the stored pivot order is no
   * longer numerically adequate and a full reorder is required. Mirrors
   * ngspice ReorderingRequired = YES at spfactor.c:225. The caller (factor())
   * must dispatch to factorWithReorder; NR-loop callers must not treat this
   * as a singular-matrix failure.
   */
  needsReorder?: boolean;
}

/**
 * Default pivot thresholds — ngspice spalloc.c:192-193 and spconfig.h:331.
 *
 *   DEFAULT_PIVOT_REL_THRESHOLD === Matrix->RelThreshold default === 1e-3
 *   DEFAULT_PIVOT_ABS_THRESHOLD === Matrix->AbsThreshold default === 0.0
 *
 * These are module-level defaults only; the live values used during
 * factorization live on SparseSolver instance fields `_relThreshold` and
 * `_absThreshold`, which the CKT context overrides per factor call via the
 * setPivotTolerances() setter. Matches ngspice's CKTpivotRelTol and
 * CKTpivotAbsTol plumbed through SMPluFac/SMPreorder (niiter.c:863-864,
 * 883-884, spsmp.c:169-200).
 */
const DEFAULT_PIVOT_REL_THRESHOLD = 1e-3;
const DEFAULT_PIVOT_ABS_THRESHOLD = 0.0;

// Bit flag stored in _elFlags to distinguish fill-in entries from A-matrix entries.
const FLAG_FILL_IN = 1;

export class SparseSolver {
  // =========================================================================
  // Persistent linked-list element pool
  // =========================================================================
  // This is the primary matrix storage, persistent across beginAssembly/stamp/finalize cycles.
  // ngspice variable mapping:
  //   Element->Row        → _elRow[e]
  //   Element->Col        → _elCol[e]
  //   Element->NextInRow  → _elNextInRow[e]
  //   Element->NextInCol  → _elNextInCol[e]
  //   spGetElement        → allocElement (public)
  //   *ElementPtr += val  → stampElement (public)

  /** Row of element e. */
  private _elRow: Int32Array = new Int32Array(0);
  /** Column of element e. */
  private _elCol: Int32Array = new Int32Array(0);
  /** Accumulated matrix value at element e. */
  private _elVal: Float64Array = new Float64Array(0);
  /** Flags: FLAG_FILL_IN when this entry was inserted during LU factorization. */
  private _elFlags: Uint8Array = new Uint8Array(0);
  /** Next element in same row (-1 = end). */
  private _elNextInRow: Int32Array = new Int32Array(0);
  /** Prev element in same row (-1 = head). */
  private _elPrevInRow: Int32Array = new Int32Array(0);
  /** Next element in same column (-1 = end). */
  private _elNextInCol: Int32Array = new Int32Array(0);
  /** Prev element in same column (-1 = head). */
  private _elPrevInCol: Int32Array = new Int32Array(0);
  /**
   * CSC L-array index for element e (-1 if not in L).
   * Set during _numericLUMarkowitz; used by _buildCSCFromLinked snapshot.
   */
  private _lValueIndex: Int32Array = new Int32Array(0);
  /**
   * CSC U-array index for element e (-1 if not in U).
   * Set during _numericLUMarkowitz; used by _buildCSCFromLinked snapshot.
   */
  private _uValueIndex: Int32Array = new Int32Array(0);

  /**
   * Reverse maps: CSC position p → pool element index (or -1 if no backing
   * pool element). Used by _numericLUReusePivots to keep _elVal[e] in sync
   * with the factored L/U values written to the CSC arrays.
   */
  private _lCscToElem: Int32Array = new Int32Array(0);
  private _uCscToElem: Int32Array = new Int32Array(0);

  /**
   * A-matrix handle CSR (ngspice-style flat pool-handle array): for each
   * internal column k, _aMatrixHandlesByCol[_aMatrixColStart[k]..
   * _aMatrixColStart[k+1]-1] lists the pool handles of all non-fill-in
   * (A-matrix) entries in that column. Built inside _buildCSCFromLinked,
   * consumed by _numericLUReusePivots — so the NR hot path scatters A
   * values into the dense workspace without ever touching _colHead /
   * _elNextInCol linked-list fields.
   */
  private _aMatrixColStart: Int32Array = new Int32Array(0);
  private _aMatrixHandlesByCol: Int32Array = new Int32Array(0);

  /** First element in row r (-1 = empty). Length n. */
  private _rowHead: Int32Array = new Int32Array(0);
  /** First element in column c (-1 = empty). Length n. */
  private _colHead: Int32Array = new Int32Array(0);
  /** Element index of diagonal (r,r) or -1. Length n. */
  private _diag: Int32Array = new Int32Array(0);

  /**
   * Preorder column permutation: _preorderColPerm[internalCol] = originalCol.
   * Identity initially. Updated by _swapColumns during preorder().
   * solve() maps internal column k → original column _preorderColPerm[k].
   * Matches ngspice IntToExtColMap (sputils.c:291).
   */
  private _preorderColPerm: Int32Array = new Int32Array(0);

  /**
   * Inverse of _preorderColPerm: _extToIntCol[originalCol] = internalCol.
   * Identity initially. Updated by _swapColumns in lockstep with _preorderColPerm.
   * Used by _removeFromCol and _updateMarkowitzNumbers to translate the element's
   * stored original column into the internal column index that keys _colHead/_markowitzCol.
   */
  private _extToIntCol: Int32Array = new Int32Array(0);

  /** Next free slot in element pool (used when no free-list entry). */
  private _elCount: number = 0;
  /** Current pool capacity. */
  private _elCapacity: number = 0;
  /** Head of free-list for recycled fill-in slots (-1 = none). */
  private _elFreeHead: number = -1;

  // =========================================================================
  // Handle lookup table for allocElement fast-path
  // =========================================================================
  // Sparse handle table: _handleTable[row * _handleTableN + col] = element index + 1
  // (0 means not allocated). Valid only for n <= _handleTableN.
  private _handleTable: Int32Array = new Int32Array(0);
  private _handleTableN: number = 0;

  // =========================================================================
  // RHS vector
  // =========================================================================
  private _rhs: Float64Array = new Float64Array(0);

  // =========================================================================
  // Dimension
  // =========================================================================
  private _n = 0;

  // =========================================================================
  // CSC L/U for forward/backward substitution
  // =========================================================================
  private _lColPtr: Int32Array = new Int32Array(0);
  private _lRowIdx: Int32Array = new Int32Array(0);
  private _lVals: Float64Array = new Float64Array(0);

  private _uColPtr: Int32Array = new Int32Array(0);
  private _uRowIdx: Int32Array = new Int32Array(0);
  private _uVals: Float64Array = new Float64Array(0);

  // =========================================================================
  // Pivot permutation
  // =========================================================================
  // _pinv[origRow] = step k at which origRow was chosen as pivot.
  // _q[k] = origRow chosen as pivot at step k (inverse of _pinv).
  private _pinv: Int32Array = new Int32Array(0);
  private _q: Int32Array = new Int32Array(0);

  // =========================================================================
  // Dense workspace for factorization
  // =========================================================================
  private _x: Float64Array = new Float64Array(0);
  private _xNzIdx: Int32Array = new Int32Array(0);

  // =========================================================================
  // DFS reach workspace
  // =========================================================================
  private _reachStack: Int32Array = new Int32Array(0);
  private _dfsStack: Int32Array = new Int32Array(0);
  private _dfsChildPtr: Int32Array = new Int32Array(0);
  private _reachMark: Int32Array = new Int32Array(0);

  // =========================================================================
  // Scratch for solve
  // =========================================================================
  private _scratch: Float64Array = new Float64Array(0);

  // =========================================================================
  // Pre-solve RHS capture
  // =========================================================================
  private _preSolveRhs: Float64Array | null = null;
  private _capturePreSolveRhs = false;

  // =========================================================================
  // Pre-factor matrix capture
  // =========================================================================
  // Factorization overwrites _elVal[e] with combined L/U values (see
  // _numericLUMarkowitz lines 1055, 1067, 1084 and _numericLUReusePivots
  // lines 1183, 1192 — ngspice spMatrix semantics). Post-factor snapshots
  // via getCSCNonZeros() therefore report LU data, not the A matrix that
  // was factored. This capture snapshots the A matrix at factor() entry
  // so harness consumers see the system that was actually solved.
  private _preFactorMatrix: Array<{ row: number; col: number; value: number }> | null = null;
  private _capturePreFactorMatrix = false;

  // =========================================================================
  // State flags — ngspice mapping (spdefs.h:761 + :642-644, :69)
  //
  //   Matrix->NeedsOrdering  → _needsReorder
  //   Matrix->Factored       → _hasPivotOrder (inverse: !_hasPivotOrder ⇒ !Factored)
  //   IS_FACTORED(Matrix)    → _hasPivotOrder && !_needsReorder
  //   NIDIDPREORDER bit      → _didPreorder (CKT-lifetime — see S3)
  //
  // Set/clear lifecycle (must match ngspice exactly — see Item #10 audit):
  //   _needsReorder = true:
  //     * _initStructure — initial (ngspice spalloc.c:170 NeedsOrdering=YES)
  //     * allocElement (new A-entry, not fill-in) — ngspice spbuild.c:788
  //     * forceReorder() — ngspice niiter.c:858, 861 NISHOULDREORDER
  //     * invalidateTopology() — ngspice spStripMatrix path (sputils.c:1112)
  //   _needsReorder = false:
  //     * factorWithReorder() success — ngspice spfactor.c:279
  //
  //   _hasPivotOrder = true:
  //     * factorWithReorder() success — ngspice spfactor.c:281 Factored=YES
  //   _hasPivotOrder = false:
  //     * _initStructure — ngspice spCreate initial
  //     * invalidateTopology() — ngspice spStripMatrix path
  //
  //   _didPreorder = true:
  //     * preorder() first call — ngspice niiter.c:854 NIDIDPREORDER
  //   _didPreorder = false:
  //     * _initStructure — ngspice spCreate initial
  //     * invalidateTopology() — ngspice NIreinit (nireinit.c:42 clears CKTniState)
  // =========================================================================
  private _needsReorder: boolean = false;
  private _didPreorder: boolean = false;
  private _hasPivotOrder: boolean = false;
  /** True when linked structure has never been built, or after invalidateTopology(). */
  private _structureEmpty: boolean = true;
  /** Matrix size for which workspace arrays were last allocated. -1 = never. */
  private _workspaceN: number = -1;

  /**
   * Pivot relative threshold (ngspice Matrix->RelThreshold, spalloc.c:192).
   * Default from DEFAULT_PIVOT_REL_THRESHOLD; callers override via
   * setPivotTolerances() to mirror CKTpivotRelTol plumbed through SMPreorder
   * (niiter.c:863-864, spsmp.c:194).
   */
  private _relThreshold: number = DEFAULT_PIVOT_REL_THRESHOLD;

  /**
   * Pivot absolute threshold (ngspice Matrix->AbsThreshold, spalloc.c:193).
   * Default 0.0 matches ngspice's default. Callers override via
   * setPivotTolerances() to mirror CKTpivotAbsTol plumbed through SMPluFac
   * (niiter.c:883-884, spsmp.c:169).
   */
  private _absThreshold: number = DEFAULT_PIVOT_ABS_THRESHOLD;

  /** True when the most recent factor() call dispatched to factorWithReorder. */
  lastFactorUsedReorder: boolean = false;

  // =========================================================================
  // Markowitz pivot selection data
  // =========================================================================
  private _markowitzRow: Int32Array = new Int32Array(0);
  private _markowitzCol: Int32Array = new Int32Array(0);
  private _markowitzProd: Float64Array = new Float64Array(0);
  private _singletons: number = 0;

  // Fill-in detection marker: _elMark[row] = column of last mark. Length n.
  private _elMark: Int32Array = new Int32Array(0);

  // Dense row→element map for the current column during LU factorization.
  // _rowToElem[i] = element index for row i in the current column scatter.
  // Used by _numericLUMarkowitz to record CSC index positions on pool elements.
  private _rowToElem: Int32Array = new Int32Array(0);

  // =========================================================================
  // Constructor
  // =========================================================================

  constructor() {}

  // =========================================================================
  // Public stamp API — ngspice spGetElement / *ElementPtr pattern
  // =========================================================================

  /**
   * Allocate or find the element at (row, col) in the persistent linked structure.
   * Returns a stable handle (pool index) for use with stampElement().
   *
   * Called at compile time by every caller (element factories, cktLoad).
   * ngspice: spGetElement (spbuild.c) — returns a pointer used by *ElementPtr += value.
   *
   * O(1) via handle table when n <= handle table size.
   * O(column chain length) when the matrix exceeds the handle table size.
   */
  allocElement(row: number, col: number): number {
    // Guard: without beginAssembly(), _extToIntCol is zero-length, so
    // _extToIntCol[col] → undefined, which Int32Array writes in
    // _insertIntoCol coerce to 0 — producing a self-referential cycle
    // in the column linked list that makes the next search spin forever.
    // Throw loudly instead.
    if (this._n === 0) {
      throw new Error(
        `SparseSolver.allocElement(${row}, ${col}) called before ` +
        `beginAssembly(). Call solver.beginAssembly(matrixSize) first.`,
      );
    }
    // Fast path: handle table lookup keyed by the caller's (original) row/col.
    if (this._n > 0 && this._n <= this._handleTableN) {
      const idx = row * this._handleTableN + col;
      const stored = this._handleTable[idx];
      if (stored > 0) return stored - 1; // already allocated
    }

    // Translate the caller's original column to the current internal column
    // so the search walks the correct _colHead chain after preorder swaps.
    const internalCol = this._extToIntCol[col];

    // Check whether this (row, col) already exists in the column chain
    let e = this._colHead[internalCol];
    while (e >= 0) {
      if (this._elRow[e] === row) {
        // Record in handle table
        if (this._n <= this._handleTableN) {
          this._handleTable[row * this._handleTableN + col] = e + 1;
        }
        return e;
      }
      e = this._elNextInCol[e];
    }

    // Allocate new element. _elCol stores the original column (ngspice
    // Element->Col convention); chain membership uses the internal column.
    //
    // ngspice spcCreateElement (spbuild.c:786-788): every new non-fill-in
    // element sets Matrix->NeedsOrdering = YES. This is the only place in
    // ngspice where stamp-time topology changes flag a reorder; the same
    // invariant belongs here so stamp passes that introduce a new A-entry
    // between solves (e.g. a newly-activated comparator output, a newly-
    // added nodeset, a hot-loaded model change that enables a new coupling)
    // force the next factor() through factorWithReorder. Fill-ins created
    // by _numericLUMarkowitz set FLAG_FILL_IN and take a different code
    // path (ngspice spcGetFillin, spbuild.c:781) that does NOT flag
    // NeedsOrdering — mirrored by _numericLUMarkowitz calling _newElement
    // directly without going through allocElement.
    const newE = this._newElement(row, col, 0, 0);
    this._insertIntoRow(newE, row);
    this._insertIntoCol(newE, internalCol);
    if (row === col) this._diag[internalCol] = newE;
    this._needsReorder = true;

    // Record in handle table
    if (this._n <= this._handleTableN) {
      this._handleTable[row * this._handleTableN + col] = newE + 1;
    }

    return newE;
  }

  /**
   * Accumulate value onto the element at handle. O(1) unconditional.
   * Called in the NR hot path.
   * ngspice: *ElementPtr += value
   */
  stampElement(handle: number, value: number): void {
    this._elVal[handle] += value;
  }

  stampRHS(row: number, value: number): void {
    this._rhs[row] += value;
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * Begin a new assembly pass.
   *
   * On the very first assembly (or after invalidateTopology()), the linked
   * structure is empty and allocElement() calls build it on demand.
   *
   * On subsequent passes (steady state), zeros all A-entry element values
   * and removes fill-in entries via chain walk, preserving the linked structure.
   * Zero allocations in steady state.
   */
  beginAssembly(size: number): void {
    if (size !== this._n) {
      this._n = size;
      this._structureEmpty = true;
    }

    if (this._structureEmpty) {
      this._initStructure(size);
    } else {
      this._resetForAssembly();
    }

    // Zero RHS
    this._rhs.fill(0, 0, this._n);

    // Reset Markowitz arrays
    if (this._markowitzRow.length !== size) {
      this._markowitzRow = new Int32Array(size);
      this._markowitzCol = new Int32Array(size);
      this._markowitzProd = new Float64Array(size);
    } else {
      this._markowitzRow.fill(0);
      this._markowitzCol.fill(0);
      this._markowitzProd.fill(0);
    }
    this._singletons = 0;
  }

  /**
   * Finalize after stamping. Computes Markowitz counts from the persistent
   * linked structure for the upcoming factor call.
   */
  finalize(): void {
    const n = this._n;
    const mRow = this._markowitzRow;
    const mCol = this._markowitzCol;
    const mProd = this._markowitzProd;
    let singletons = 0;

    for (let i = 0; i < n; i++) {
      let rc = 0;
      let e = this._rowHead[i];
      while (e >= 0) {
        if (!(this._elFlags[e] & FLAG_FILL_IN)) rc++;
        e = this._elNextInRow[e];
      }
      mRow[i] = rc > 0 ? rc - 1 : 0;

      let cc = 0;
      e = this._colHead[i];
      while (e >= 0) {
        if (!(this._elFlags[e] & FLAG_FILL_IN)) cc++;
        e = this._elNextInCol[e];
      }
      mCol[i] = cc > 0 ? cc - 1 : 0;

      mProd[i] = mRow[i] * mCol[i];
      if (mProd[i] === 0) singletons++;
    }
    this._singletons = singletons;

    if (this._capturePreSolveRhs && this._preSolveRhs) {
      if (this._preSolveRhs.length !== n) {
        this._preSolveRhs = new Float64Array(n);
      }
      this._preSolveRhs.set(this._rhs.subarray(0, n));
    }
  }

  /**
   * Factor the currently-assembled matrix.
   *
   * ngspice mapping:
   *   - `diagGmin` → `LoadGmin(Matrix, Gmin)` called INSIDE SMPluFac / SMPreorder
   *     before the corresponding `spFactor`/`spOrderAndFactor` (spsmp.c:173,
   *     197). Making `factor()` accept `diagGmin` and stamp it here keeps the
   *     gmin + factorization pair atomic, mirroring ngspice's invariant that
   *     callers never see a post-gmin, pre-factor matrix state.
   *   - `needsReorder` sentinel from `_numericLUReusePivots` → ReorderingRequired
   *     at spfactor.c:225. The numeric-reuse path's per-step partial-pivot
   *     guard can demand a full reorder; dispatching back through
   *     `factorWithReorder` here is the ngspice fall-through equivalent.
   *     This must NOT be conflated with a singular-matrix failure.
   */
  factor(diagGmin?: number): FactorResult {
    if (this._capturePreFactorMatrix) {
      const n = this._n;
      const snap: Array<{ row: number; col: number; value: number }> = [];
      for (let col = 0; col < n; col++) {
        let e = this._colHead[col];
        while (e >= 0) {
          if (!(this._elFlags[e] & FLAG_FILL_IN)) {
            snap.push({ row: this._elRow[e], col: this._elCol[e], value: this._elVal[e] });
          }
          e = this._elNextInCol[e];
        }
      }
      this._preFactorMatrix = snap;
    }
    if (this._needsReorder || !this._hasPivotOrder) {
      this.lastFactorUsedReorder = true;
      return this.factorWithReorder(diagGmin);
    }
    this.lastFactorUsedReorder = false;
    const result = this.factorNumerical(diagGmin);
    if (!result.success && result.needsReorder) {
      // ngspice spfactor.c:225 fall-through: partial-pivot guard failed at
      // some step k; re-run the full reorder from step 0. This is NOT a
      // singular-matrix failure. diagGmin has already been stamped once by
      // factorNumerical's _applyDiagGmin call, so forward it again; the
      // gmin must reach the factored matrix exactly once, and the first
      // application was discarded with the abandoned numeric factorization.
      // Because _numericLUReusePivots aborts before mutating _elVal, the
      // underlying matrix is still the original A + gmin·I; the full
      // reorder must NOT add gmin a second time.
      this._needsReorder = true;
      this.lastFactorUsedReorder = true;
      return this.factorWithReorder(/* diagGmin */ undefined);
    }
    return result;
  }

  /**
   * Sparse forward/backward substitution on CSC L/U.
   *
   * L and U row indices are in original-column-order space.
   * Pivot mapping: _pinv[origRow] = step, _q[step] = origRow.
   *
   * 1. Apply pivot permutation: b[k] = rhs[q[k]]
   * 2. Sparse forward sub (L, unit lower triangular CSC)
   * 3. Sparse backward sub (U, upper triangular CSC)
   * 4. Copy solution: x[k] = b[k]. Row pivoting does not permute columns.
   */
  solve(x: Float64Array): void {
    const n = this._n;
    if (n === 0) return;

    const pinv = this._pinv;
    const q = this._q;
    const b = this._scratch;

    // Step 1: Apply pivot row permutation to RHS: b[k] = rhs[q[k]]
    // q[k] is the original row chosen as pivot at step k.
    for (let k = 0; k < n; k++) b[k] = this._rhs[q[k]];

    // Step 2: Sparse forward sub (L, unit lower triangular CSC)
    for (let j = 0; j < n; j++) {
      const p0 = this._lColPtr[j];
      const p1 = this._lColPtr[j + 1];
      const bj = b[j];
      for (let p = p0; p < p1; p++) {
        b[pinv[this._lRowIdx[p]]] -= this._lVals[p] * bj;
      }
    }

    // Step 3: Sparse backward sub (U, upper triangular CSC)
    for (let j = n - 1; j >= 0; j--) {
      const p0 = this._uColPtr[j];
      const p1 = this._uColPtr[j + 1];
      b[j] /= this._uVals[p1 - 1];
      const bj = b[j];
      for (let p = p0; p < p1 - 1; p++) {
        b[pinv[this._uRowIdx[p]]] -= this._uVals[p] * bj;
      }
    }

    // Step 4: Apply preorder inverse permutation and write solution.
    // _preorderColPerm[k] = original column index for internal column k.
    // Without preorder this is identity; after column swaps the mapping
    // routes the internal solution back to original variable indices.
    const pcp = this._preorderColPerm;
    for (let k = 0; k < n; k++) x[pcp[k]] = b[k];
  }

  /**
   * Wipe the persistent linked structure so the next beginAssembly() rebuilds
   * it from scratch. Mirrors ngspice spStripMatrix (sputils.c:1104-1145),
   * which sets NeedsOrdering = YES at line 1112 so the next factor uses the
   * full reorder path. We match that invariant here.
   *
   * Not currently invoked from any production path — kept as a test helper
   * for fixture teardown AND as the canonical API for any future consumer
   * that needs to force a structural rebuild without destroying the solver
   * instance. See the Item #11 / S7 audit notes at the top of this file.
   */
  invalidateTopology(): void {
    this._structureEmpty = true;
    this._hasPivotOrder = false;
    this._didPreorder = false;
    // ngspice spStripMatrix (sputils.c:1112): NeedsOrdering = YES.
    this._needsReorder = true;
  }

  /**
   * Set the pivot tolerances used by the next factor() call.
   *
   * Mirrors ngspice CKTpivotAbsTol / CKTpivotRelTol being forwarded to
   * SMPluFac (PivTol, ignored), SMPreorder (PivTol, PivRel), which store
   * into Matrix->RelThreshold / Matrix->AbsThreshold inside spOrderAndFactor
   * (spfactor.c:204-211). Called by the NR loop before every factor() call.
   *
   * Relative threshold must satisfy 0 < rel <= 1 to match ngspice semantics;
   * ngspice silently falls back to the stored default when the value is
   * out of range (spfactor.c:204-208). We mirror that fallback here so
   * per-call tolerance mistakes never disable pivoting.
   */
  setPivotTolerances(relThreshold: number, absThreshold: number): void {
    if (relThreshold > 0 && relThreshold <= 1) this._relThreshold = relThreshold;
    if (absThreshold >= 0) this._absThreshold = absThreshold;
  }

  /**
   * Force full symbolic reorder on next factor() call.
   * ngspice: NISHOULDREORDER trigger (niiter.c:858, 861-880).
   */
  forceReorder(): void {
    this._needsReorder = true;
  }

  /**
   * One-time static column permutation to eliminate structural zeros on the diagonal.
   * Finds symmetric twin pairs (J,R) and (R,J) with |value|=1.0 where diagonal at col J
   * is zero, then swaps columns J and R. Iterates until no more swaps are possible.
   * ngspice: SMPpreOrder (sputils.c:177-301).
   */
  preorder(): void {
    if (this._didPreorder) return;
    this._didPreorder = true;

    // ngspice uses a monotonically-advancing StartAt cursor (sputils.c:181, 210,
    // 218) so a just-swapped pair is never re-examined in the same outer pass.
    // Without this, restarting at col=0 each pass lets the swap oscillate forever
    // on any twin pair: swap(J,R) on pass 1, then on pass 2 the new _diag[R] is
    // the old zero, the original twins are still |value|=1 in the swapped
    // chains, and the algorithm swaps back.
    let startAt = 0;
    let didSwap = true;
    while (didSwap) {
      didSwap = false;
      for (let col = startAt; col < this._n; col++) {
        // Only fix columns with a structural zero on the diagonal
        if (this._diag[col] >= 0 && this._elVal[this._diag[col]] !== 0) continue;

        // Walk column col looking for pTwin1 at (row, col) with |value| === 1.0
        let el = this._colHead[col];
        while (el >= 0) {
          if (Math.abs(this._elVal[el]) === 1.0) {
            const row = this._elRow[el];
            // Locate pTwin2: the element at (col, row) with |value| === 1.0
            const pTwin2 = this._findTwin(row, col);
            if (pTwin2 >= 0) {
              this._swapColumns(col, row, el, pTwin2);
              didSwap = true;
              startAt = col + 1;
              break;
            }
          }
          el = this._elNextInCol[el];
        }
        if (didSwap) break;
      }
    }
  }

  /**
   * Locate the element in column `col` at row `targetRow` with |value| === 1.0.
   * Returns the element handle, or -1 if no such entry exists.
   * Used by preorder() to find the symmetric partner (pTwin2) of a twin pair.
   */
  private _findTwin(col: number, targetRow: number): number {
    let el = this._colHead[col];
    while (el >= 0) {
      if (this._elRow[el] === targetRow && Math.abs(this._elVal[el]) === 1.0) return el;
      el = this._elNextInCol[el];
    }
    return -1;
  }

  /**
   * Swap columns col1 and col2 in the persistent linked structure.
   * pTwin1 is the element at (col2, col1); pTwin2 is the element at (col1, col2).
   * ngspice reference: sputils.c SwapCols (lines 283-301).
   */
  private _swapColumns(col1: number, col2: number, pTwin1: number, pTwin2: number): void {
    const tmpHead = this._colHead[col1];
    this._colHead[col1] = this._colHead[col2];
    this._colHead[col2] = tmpHead;

    const origCol1 = this._preorderColPerm[col1];
    const origCol2 = this._preorderColPerm[col2];
    this._preorderColPerm[col1] = origCol2;
    this._preorderColPerm[col2] = origCol1;
    this._extToIntCol[origCol1] = col2;
    this._extToIntCol[origCol2] = col1;

    this._diag[col1] = pTwin2;
    this._diag[col2] = pTwin1;
  }

  /**
   * Test-only: add gmin to every diagonal element of the assembled matrix.
   *
   * Production callers MUST NOT invoke this directly — use `factor(diagGmin)`
   * so the gmin stamp and the factorization are atomic, mirroring ngspice's
   * SMPluFac(Matrix, PivTol, Gmin) wrapper which calls LoadGmin + spFactor
   * back-to-back with no intermediate observable state (spsmp.c:169-175).
   *
   * Kept public for harness instrumentation tests that need to inspect the
   * post-gmin, pre-factor matrix snapshot via getPreFactorMatrixSnapshot().
   */
  addDiagonalGmin(gmin: number): void {
    this._applyDiagGmin(gmin);
  }

  // =========================================================================
  // Harness instrumentation accessors
  // =========================================================================

  get dimension(): number { return this._n; }
  get markowitzRow(): Int32Array { return this._markowitzRow; }
  get markowitzCol(): Int32Array { return this._markowitzCol; }
  get markowitzProd(): Float64Array { return this._markowitzProd; }
  get singletons(): number { return this._singletons; }

  getRhsSnapshot(): Float64Array {
    return this._rhs.slice(0, this._n);
  }

  enablePreSolveRhsCapture(enabled: boolean): void {
    this._capturePreSolveRhs = enabled;
    if (enabled && (this._preSolveRhs === null || this._preSolveRhs.length !== this._n)) {
      this._preSolveRhs = new Float64Array(this._n);
    }
  }

  getPreSolveRhsSnapshot(): Float64Array {
    return this._preSolveRhs ?? new Float64Array(0);
  }

  enablePreFactorMatrixCapture(enabled: boolean): void {
    this._capturePreFactorMatrix = enabled;
    if (!enabled) this._preFactorMatrix = null;
  }

  /**
   * Returns the A matrix non-zero entries snapshotted at the most recent
   * factor() entry, before factorization mutated _elVal. Empty if capture
   * was never enabled or factor() has not been called since enabling.
   */
  getPreFactorMatrixSnapshot(): ReadonlyArray<{ row: number; col: number; value: number }> {
    return this._preFactorMatrix ?? [];
  }

  /**
   * Return assembled matrix as array of non-zero entries in original ordering.
   * Used by comparison harness. Not for hot-path use.
   */
  getCSCNonZeros(): Array<{ row: number; col: number; value: number }> {
    const n = this._n;
    const result: Array<{ row: number; col: number; value: number }> = [];
    for (let col = 0; col < n; col++) {
      let e = this._colHead[col];
      while (e >= 0) {
        if (!(this._elFlags[e] & FLAG_FILL_IN)) {
          result.push({ row: this._elRow[e], col: this._elCol[e], value: this._elVal[e] });
        }
        e = this._elNextInCol[e];
      }
    }
    return result;
  }

  // =========================================================================
  // Internal: structure initialization
  // =========================================================================

  private _initStructure(n: number): void {
    // Allocate workspace arrays sized for n
    this._rhs = new Float64Array(n);

    const elCap = Math.max(n * 4, 64);
    this._elRow = new Int32Array(elCap);
    this._elCol = new Int32Array(elCap);
    this._elVal = new Float64Array(elCap);
    this._elFlags = new Uint8Array(elCap);
    this._elNextInRow = new Int32Array(elCap).fill(-1);
    this._elPrevInRow = new Int32Array(elCap).fill(-1);
    this._elNextInCol = new Int32Array(elCap).fill(-1);
    this._elPrevInCol = new Int32Array(elCap).fill(-1);
    this._lValueIndex = new Int32Array(elCap).fill(-1);
    this._uValueIndex = new Int32Array(elCap).fill(-1);
    this._elCapacity = elCap;
    this._elCount = 0;
    this._elFreeHead = -1;

    this._rowHead = new Int32Array(n).fill(-1);
    this._colHead = new Int32Array(n).fill(-1);
    this._diag = new Int32Array(n).fill(-1);
    this._preorderColPerm = new Int32Array(n);
    this._extToIntCol = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      this._preorderColPerm[i] = i;
      this._extToIntCol[i] = i;
    }
    this._elMark = new Int32Array(n).fill(-1);
    this._rowToElem = new Int32Array(n).fill(-1);

    // Handle table for O(1) allocElement lookup
    this._handleTableN = n;
    this._handleTable = new Int32Array(n * n); // zero = unallocated

    // Factor workspace
    this._x = new Float64Array(n);
    this._xNzIdx = new Int32Array(n);
    this._reachStack = new Int32Array(n);
    this._dfsStack = new Int32Array(n);
    this._dfsChildPtr = new Int32Array(n);
    this._reachMark = new Int32Array(n).fill(-1);
    this._pinv = new Int32Array(n);
    this._q = new Int32Array(n);
    this._scratch = new Float64Array(n);

    const alloc = Math.max(n * 6, 32);
    this._lColPtr = new Int32Array(n + 1);
    this._lRowIdx = new Int32Array(alloc);
    this._lVals = new Float64Array(alloc);
    this._lCscToElem = new Int32Array(alloc).fill(-1);
    this._uColPtr = new Int32Array(n + 1);
    this._uRowIdx = new Int32Array(alloc);
    this._uVals = new Float64Array(alloc);
    this._uCscToElem = new Int32Array(alloc).fill(-1);

    this._aMatrixColStart = new Int32Array(n + 1);
    this._aMatrixHandlesByCol = new Int32Array(0);

    this._markowitzRow = new Int32Array(n);
    this._markowitzCol = new Int32Array(n);
    this._markowitzProd = new Float64Array(n);

    this._structureEmpty = false;
    this._hasPivotOrder = false;
    // ngspice spalloc.c:170 — Matrix->NeedsOrdering = YES on initial Create.
    // Previously set to false; the net dispatch result was still "reorder"
    // (because _hasPivotOrder was also false), but aligning the primitive
    // flag with ngspice removes a divergence that could bite if downstream
    // logic queries _needsReorder directly.
    this._needsReorder = true;
    this._didPreorder = false;
  }

  /**
   * Reset for a new assembly pass: zero A-entry values, remove fill-in entries
   * via chain walk, preserve linked structure topology.
   * Zero allocations — fill-in entries are returned to the free-list.
   */
  private _resetForAssembly(): void {
    const n = this._n;

    for (let col = 0; col < n; col++) {
      let e = this._colHead[col];
      while (e >= 0) {
        const next = this._elNextInCol[e];
        if (this._elFlags[e] & FLAG_FILL_IN) {
          // Remove fill-in from row chain
          this._removeFromRow(e);
          // Remove from col chain
          this._removeFromCol(e);
          // Return to free-list
          this._elNextInRow[e] = this._elFreeHead;
          this._elFreeHead = e;
          // Clear diagonal pointer if this was diagonal
          const r = this._elRow[e];
          if (r === col && this._diag[r] === e) this._diag[r] = -1;
        } else {
          // A-matrix entry: zero value only
          this._elVal[e] = 0;
        }
        e = next;
      }
    }

    // Zero handle table (fill-in entries have been freed, but their handles
    // were never stored in the handle table, so only zero A-entry handles
    // that were cleared via free-list). Since fill-in was never in handle
    // table and A-entries stay in place, handle table remains valid.
    // Nothing to do — handle table entries for A-elements remain correct.
  }

  // =========================================================================
  // Internal: element pool operations
  // =========================================================================

  /**
   * Allocate a new element from the pool or free-list.
   * Sets row, col, val, flags. Returns element index.
   */
  private _newElement(row: number, col: number, val: number, flags: number): number {
    let e: number;
    if (this._elFreeHead >= 0) {
      e = this._elFreeHead;
      this._elFreeHead = this._elNextInRow[e]; // free-list uses NextInRow
    } else {
      if (this._elCount >= this._elCapacity) this._growElements();
      e = this._elCount++;
    }
    this._elRow[e] = row;
    this._elCol[e] = col;
    this._elVal[e] = val;
    this._elFlags[e] = flags;
    this._elNextInRow[e] = -1;
    this._elPrevInRow[e] = -1;
    this._elNextInCol[e] = -1;
    this._elPrevInCol[e] = -1;
    this._lValueIndex[e] = -1;
    this._uValueIndex[e] = -1;
    return e;
  }

  private _insertIntoRow(e: number, row: number): void {
    const head = this._rowHead[row];
    this._elNextInRow[e] = head;
    this._elPrevInRow[e] = -1;
    if (head >= 0) this._elPrevInRow[head] = e;
    this._rowHead[row] = e;
  }

  private _insertIntoCol(e: number, col: number): void {
    const head = this._colHead[col];
    this._elNextInCol[e] = head;
    this._elPrevInCol[e] = -1;
    if (head >= 0) this._elPrevInCol[head] = e;
    this._colHead[col] = e;
  }

  private _removeFromRow(e: number): void {
    const prev = this._elPrevInRow[e];
    const next = this._elNextInRow[e];
    if (prev >= 0) this._elNextInRow[prev] = next;
    else this._rowHead[this._elRow[e]] = next;
    if (next >= 0) this._elPrevInRow[next] = prev;
  }

  private _removeFromCol(e: number): void {
    const prev = this._elPrevInCol[e];
    const next = this._elNextInCol[e];
    if (prev >= 0) this._elNextInCol[prev] = next;
    else this._colHead[this._extToIntCol[this._elCol[e]]] = next;
    if (next >= 0) this._elPrevInCol[next] = prev;
  }

  private _growElements(): void {
    const newCap = Math.max(this._elCapacity * 2, 64);
    const growI = (old: Int32Array): Int32Array => {
      const a = new Int32Array(newCap);
      a.set(old);
      // Fill new slots with -1 for link fields (not needed for row/col/flags)
      return a;
    };
    const growF = (old: Float64Array): Float64Array => {
      const a = new Float64Array(newCap);
      a.set(old);
      return a;
    };
    const growU = (old: Uint8Array): Uint8Array => {
      const a = new Uint8Array(newCap);
      a.set(old);
      return a;
    };
    this._elRow = growI(this._elRow);
    this._elCol = growI(this._elCol);
    this._elVal = growF(this._elVal);
    this._elFlags = growU(this._elFlags);
    this._elNextInRow = growI(this._elNextInRow);
    this._elPrevInRow = growI(this._elPrevInRow);
    this._elNextInCol = growI(this._elNextInCol);
    this._elPrevInCol = growI(this._elPrevInCol);
    // Grow index arrays; new slots default to 0 (not -1), but will be set
    // by _numericLUMarkowitz before any read in _numericLUReusePivots.
    const oldLVI = this._lValueIndex;
    const newLVI = new Int32Array(newCap).fill(-1);
    newLVI.set(oldLVI);
    this._lValueIndex = newLVI;
    const oldUVI = this._uValueIndex;
    const newUVI = new Int32Array(newCap).fill(-1);
    newUVI.set(oldUVI);
    this._uValueIndex = newUVI;
    this._elCapacity = newCap;
  }

  // =========================================================================
  // Workspace allocation (called at reorder time)
  // =========================================================================

  /**
   * Allocate/resize all factorization workspace arrays.
   * Called by factorWithReorder on first reorder or after invalidateTopology().
   * ngspice: no direct equivalent — workspace sizing is embedded in spOrderAndFactor.
   */
  private _allocateWorkspace(): void {
    const n = this._n;
    if (n === 0) return;
    if (n === this._workspaceN) return;
    this._workspaceN = n;

    this._x = new Float64Array(n);
    this._xNzIdx = new Int32Array(n);
    this._reachStack = new Int32Array(n);
    this._dfsStack = new Int32Array(n);
    this._dfsChildPtr = new Int32Array(n);
    this._reachMark = new Int32Array(n);
    this._reachMark.fill(-1);
    this._pinv = new Int32Array(n);
    this._q = new Int32Array(n);
    this._scratch = new Float64Array(n);
    this._elMark = new Int32Array(n).fill(-1);
    this._rowToElem = new Int32Array(n).fill(-1);

    // Count A-matrix nonzeros for sizing L/U
    let nnzA = 0;
    for (let col = 0; col < n; col++) {
      let e = this._colHead[col];
      while (e >= 0) {
        if (!(this._elFlags[e] & FLAG_FILL_IN)) nnzA++;
        e = this._elNextInCol[e];
      }
    }
    const alloc = Math.max(nnzA * 6, n * 4, 32);

    this._lColPtr = new Int32Array(n + 1);
    this._lRowIdx = new Int32Array(alloc);
    this._lVals = new Float64Array(alloc);
    this._lCscToElem = new Int32Array(alloc).fill(-1);
    this._uColPtr = new Int32Array(n + 1);
    this._uRowIdx = new Int32Array(alloc);
    this._uVals = new Float64Array(alloc);
    this._uCscToElem = new Int32Array(alloc).fill(-1);

    this._aMatrixColStart = new Int32Array(n + 1);
    this._aMatrixHandlesByCol = new Int32Array(0);
  }

  // =========================================================================
  // DFS reach through L's column structure
  // =========================================================================

  /**
   * Compute the reach of column k through L's current structure.
   * Returns top such that _reachStack[top..n-1] contains the reach in
   * topological order.
   */
  private _reach(k: number): number {
    const n = this._n;
    const pinv = this._pinv;
    const mark = this._reachMark;
    const stack = this._reachStack;
    const dfs = this._dfsStack;
    const childPtr = this._dfsChildPtr;
    let top = n;

    // Seed DFS from each nonzero row of A[:,k] (column k in original order)
    let seed = this._colHead[k];
    while (seed >= 0) {
      const row = this._elRow[seed];
      if (this._elFlags[seed] & FLAG_FILL_IN) { seed = this._elNextInCol[seed]; continue; }
      const j = pinv[row];
      if (j < 0 || j >= k) { seed = this._elNextInCol[seed]; continue; }
      if (mark[j] === k) { seed = this._elNextInCol[seed]; continue; }

      mark[j] = k;
      let head = 0;
      dfs[0] = j;
      childPtr[0] = this._lColPtr[j];

      while (head >= 0) {
        const cur = dfs[head];
        const p1 = this._lColPtr[cur + 1];
        let found = false;

        for (let lp = childPtr[head]; lp < p1; lp++) {
          const s = pinv[this._lRowIdx[lp]];
          if (s < 0 || s >= k || mark[s] === k) continue;
          mark[s] = k;
          childPtr[head] = lp + 1;
          head++;
          dfs[head] = s;
          childPtr[head] = this._lColPtr[s];
          found = true;
          break;
        }

        if (!found) {
          head--;
          stack[--top] = cur;
        }
      }

      seed = this._elNextInCol[seed];
    }

    return top;
  }

  // =========================================================================
  // Numeric LU factorization with Markowitz pivot selection
  // =========================================================================

  /**
   * Numeric LU factorization with Markowitz pivot selection.
   * Operates directly on the persistent linked structure (original column order, no AMD).
   * Inserts fill-in entries into the linked structure with FLAG_FILL_IN set.
   * ngspice: spOrderAndFactor (spfactor.c).
   */
  private _numericLUMarkowitz(): FactorResult {
    const n = this._n;
    if (n === 0) return { success: true };

    const x = this._x;
    const xNzIdx = this._xNzIdx;
    const pinv = this._pinv;
    const q = this._q;

    let lnz = 0;
    let unz = 0;

    pinv.fill(-1);
    this._reachMark.fill(-1);
    this._elMark.fill(-1);

    // Reset all CSC index mappings before full re-factorization
    for (let e = 0; e < this._elCount; e++) {
      this._lValueIndex[e] = -1;
      this._uValueIndex[e] = -1;
    }

    const rowToElem = this._rowToElem;

    for (let k = 0; k < n; k++) {
      this._lColPtr[k] = lnz;
      this._uColPtr[k] = unz;

      if (lnz + n > this._lRowIdx.length) this._growL(lnz + n);
      if (unz + n > this._uRowIdx.length) this._growU(unz + n);

      // Scatter column k into dense workspace x; build row→element map;
      // stamp _elMark[row] = k so later U/L stores know rowToElem[row] is
      // valid for this column (prevents stale reads from previous k).
      let xNzCount = 0;
      let ae = this._colHead[k];
      while (ae >= 0) {
        const row = this._elRow[ae];
        rowToElem[row] = ae;
        this._elMark[row] = k;
        if (!(this._elFlags[ae] & FLAG_FILL_IN)) {
          if (x[row] === 0) xNzIdx[xNzCount++] = row;
          x[row] += this._elVal[ae];
        }
        ae = this._elNextInCol[ae];
      }

      // Sparse triangular solve: x -= L[:,j] * x[q[j]] for each j in reach(k)
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

      // Check all nonzero rows — if no pool element exists at (i, k) and
      // row i is still unpivoted, insert an L fill-in element.
      let hadFillin = false;
      const origColK = this._preorderColPerm[k];
      for (let idx = 0; idx < xNzCount; idx++) {
        const i = xNzIdx[idx];
        if (x[i] === 0 || pinv[i] >= 0) continue;
        if (this._elMark[i] === k) continue;
        const fe = this._newElement(i, origColK, 0, FLAG_FILL_IN);
        this._insertIntoRow(fe, i);
        this._insertIntoCol(fe, k);
        rowToElem[i] = fe;
        this._elMark[i] = k;
        this._markowitzRow[i]++;
        this._markowitzCol[k]++;
        hadFillin = true;
      }

      if (hadFillin) {
        let singletons = 0;
        for (let i = 0; i < n; i++) {
          if (pinv[i] >= 0) continue;
          this._markowitzProd[i] = this._markowitzRow[i] * this._markowitzCol[i];
          if (this._markowitzProd[i] === 0) singletons++;
        }
        this._singletons = singletons;
      }

      // 4-phase Markowitz pivot selection
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

      // Store U entries (already-pivoted rows + diagonal). Record the pool
      // handle backing each CSC slot (-1 if none) and mirror the factored
      // value onto _elVal[e] so _buildCSCFromLinked can snapshot pool→CSC.
      for (let idx = 0; idx < xNzCount; idx++) {
        const i = xNzIdx[idx];
        if (x[i] === 0) continue;
        const s = pinv[i];
        if (s >= 0 && s < k) {
          const xi = x[i];
          let ue = -1;
          if (this._elMark[i] === k) ue = rowToElem[i];
          this._uCscToElem[unz] = ue;
          if (ue >= 0) {
            this._uValueIndex[ue] = unz;
            this._elVal[ue] = xi;
          }
          this._uRowIdx[unz] = i;
          this._uVals[unz] = xi;
          unz++;
        }
      }
      let diagElem = -1;
      if (this._elMark[pivotRow] === k) diagElem = rowToElem[pivotRow];
      this._uCscToElem[unz] = diagElem;
      if (diagElem >= 0) {
        this._uValueIndex[diagElem] = unz;
        this._elVal[diagElem] = diagVal;
      }
      this._uRowIdx[unz] = pivotRow;
      this._uVals[unz] = diagVal;
      unz++;

      // Store L entries (unpivoted rows, scaled by 1/diagonal).
      for (let idx = 0; idx < xNzCount; idx++) {
        const i = xNzIdx[idx];
        if (x[i] === 0) continue;
        if (pinv[i] >= 0) continue;
        const lVal = x[i] / diagVal;
        let le = -1;
        if (this._elMark[i] === k) le = rowToElem[i];
        this._lCscToElem[lnz] = le;
        if (le >= 0) {
          this._lValueIndex[le] = lnz;
          this._elVal[le] = lVal;
        }
        this._lRowIdx[lnz] = i;
        this._lVals[lnz] = lVal;
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
   * Numeric LU factorization reusing pivot order from a prior factorWithReorder call.
   * Skips pivot search — uses stored pinv[]/q[].
   * Scatters values directly into existing CSC positions via _lValueIndex/_uValueIndex:
   * zero linked-list operations in this hot path.
   * ngspice: spFactor (spfactor.c).
   */
  private _numericLUReusePivots(): FactorResult {
    const n = this._n;
    if (n === 0) return { success: true };

    const x = this._x;
    const xNzIdx = this._xNzIdx;
    const q = this._q;
    const aColStart = this._aMatrixColStart;
    const aHandles = this._aMatrixHandlesByCol;
    const elVal = this._elVal;
    const elRow = this._elRow;
    const elNextInCol = this._elNextInCol;
    const diag = this._diag;
    const relThreshold = this._relThreshold;
    const absThreshold = this._absThreshold;
    const lCscToElem = this._lCscToElem;
    const uCscToElem = this._uCscToElem;

    const lnzTotal = this._lColPtr[n];
    const unzTotal = this._uColPtr[n];
    for (let i = 0; i < lnzTotal; i++) this._lVals[i] = 0;
    for (let i = 0; i < unzTotal; i++) this._uVals[i] = 0;

    this._reachMark.fill(-1);

    for (let k = 0; k < n; k++) {
      // Scatter A-matrix values via the flat per-column handle array built
      // by _buildAMatrixHandleCSR. No _colHead / _elNextInCol access in the
      // hot path per Task 0.1.3 acceptance ("zero linked-list operations").
      let xNzCount = 0;
      const cs = aColStart[k];
      const ce = aColStart[k + 1];
      for (let p = cs; p < ce; p++) {
        const ae = aHandles[p];
        const row = elRow[ae];
        if (x[row] === 0) xNzIdx[xNzCount++] = row;
        x[row] += elVal[ae];
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
      const diagMag = Math.abs(diagVal);

      // --- ngspice column-relative partial-pivot guard (spfactor.c:218-226).
      // pPivot->NextInCol is the first sub-diagonal element in the column.
      // If LargestInCol * RelThreshold >= |pPivot|, the stored pivot order is
      // no longer numerically adequate and a full reorder is required. Signal
      // this by returning { success: false, needsReorder: true } so factor()
      // falls through to factorWithReorder. This must fire BEFORE writing
      // this column's L/U values so the scatter from a rejected column does
      // not pollute the factored CSC.
      const diagE = diag[k];
      if (diagE >= 0) {
        const largestInCol = this._findLargestInColBelow(elNextInCol[diagE]);
        if (largestInCol * relThreshold >= diagMag || diagMag <= absThreshold) {
          for (let idx = 0; idx < xNzCount; idx++) x[xNzIdx[idx]] = 0;
          return { success: false, needsReorder: true };
        }
      } else if (diagMag <= absThreshold) {
        // No diagonal pool element (unusual after reorder); still enforce the
        // absolute tolerance guard. Do NOT demand reorder here — this path
        // indicates structural singularity of the factored pivot.
        for (let idx = 0; idx < xNzCount; idx++) x[xNzIdx[idx]] = 0;
        return { success: false, needsReorder: true };
      }

      // U scatter: write CSC and mirror onto _elVal[e] via reverse map so
      // post-factor pool state matches ngspice spMatrix (Element->Real holds
      // the factored value after spFactor/spOrderAndFactor).
      for (let p = this._uColPtr[k]; p < this._uColPtr[k + 1]; p++) {
        const i = this._uRowIdx[p];
        const val = x[i];
        this._uVals[p] = val;
        const ue = uCscToElem[p];
        if (ue >= 0) elVal[ue] = val;
      }

      // L scatter: same pool mirror for L entries.
      for (let p = this._lColPtr[k]; p < this._lColPtr[k + 1]; p++) {
        const i = this._lRowIdx[p];
        const val = x[i] / diagVal;
        this._lVals[p] = val;
        const le = lCscToElem[p];
        if (le >= 0) elVal[le] = val;
      }

      for (let idx = 0; idx < xNzCount; idx++) x[xNzIdx[idx]] = 0;
    }

    let maxDiag = 0, minDiag = Infinity;
    for (let k = 0; k < n; k++) {
      const e = this._uColPtr[k + 1];
      if (e > this._uColPtr[k]) {
        const v = Math.abs(this._uVals[e - 1]);
        if (v > maxDiag) maxDiag = v;
        if (v < minDiag) minDiag = v;
      }
    }

    if (minDiag <= this._absThreshold) return { success: false, needsReorder: true };
    return { success: true, conditionEstimate: minDiag > 0 ? maxDiag / minDiag : Infinity };
  }

  /**
   * Snapshot pool → CSC: walk the element pool once and copy _elVal[e] into
   * the CSC L/U arrays via the _lValueIndex[e] / _uValueIndex[e] positions
   * recorded during _numericLUMarkowitz. Also builds the A-matrix handle CSR
   * that _numericLUReusePivots uses to scatter A values without touching
   * linked-list chain fields.
   */
  private _buildCSCFromLinked(): void {
    const elCount = this._elCount;
    const lValueIndex = this._lValueIndex;
    const uValueIndex = this._uValueIndex;
    const elVal = this._elVal;
    const lVals = this._lVals;
    const uVals = this._uVals;
    for (let e = 0; e < elCount; e++) {
      const li = lValueIndex[e];
      if (li >= 0) lVals[li] = elVal[e];
      const ui = uValueIndex[e];
      if (ui >= 0) uVals[ui] = elVal[e];
    }

    this._buildAMatrixHandleCSR();
  }

  /**
   * Build the per-column flat array of A-matrix (non-fill-in) pool handles
   * consumed by _numericLUReusePivots. Called at the tail of every
   * factorWithReorder so the CSR tracks the current post-preorder column
   * chain state. Fill-ins are excluded by the FLAG_FILL_IN filter.
   */
  private _buildAMatrixHandleCSR(): void {
    const n = this._n;
    if (this._aMatrixColStart.length !== n + 1) {
      this._aMatrixColStart = new Int32Array(n + 1);
    }
    const colStart = this._aMatrixColStart;
    let total = 0;
    for (let col = 0; col < n; col++) {
      colStart[col] = total;
      let e = this._colHead[col];
      while (e >= 0) {
        if (!(this._elFlags[e] & FLAG_FILL_IN)) total++;
        e = this._elNextInCol[e];
      }
    }
    colStart[n] = total;
    if (this._aMatrixHandlesByCol.length < total) {
      this._aMatrixHandlesByCol = new Int32Array(total);
    }
    const handles = this._aMatrixHandlesByCol;
    let idx = 0;
    for (let col = 0; col < n; col++) {
      let e = this._colHead[col];
      while (e >= 0) {
        if (!(this._elFlags[e] & FLAG_FILL_IN)) handles[idx++] = e;
        e = this._elNextInCol[e];
      }
    }
  }

  // =========================================================================
  // Factorization public API
  // =========================================================================

  /**
   * Full factorization with Markowitz pivot selection (no AMD).
   * Operates on original column order per ngspice spOrderAndFactor.
   */
  factorWithReorder(diagGmin?: number): FactorResult {
    if (diagGmin) this._applyDiagGmin(diagGmin);
    if (this._needsReorder) {
      this._allocateWorkspace();
      this._needsReorder = false;
    }
    const result = this._numericLUMarkowitz();
    if (result.success) {
      this._hasPivotOrder = true;
      this._buildCSCFromLinked();
    }
    return result;
  }

  /**
   * Numerical-only factorization reusing pivot order from last factorWithReorder call.
   * ngspice: spFactor (spfactor.c).
   */
  factorNumerical(diagGmin?: number): FactorResult {
    if (diagGmin) this._applyDiagGmin(diagGmin);
    return this._numericLUReusePivots();
  }

  // =========================================================================
  // 4-phase Markowitz pivot search
  // =========================================================================

  /**
   * 4-phase Markowitz pivot search matching ngspice SearchForPivot (spfactor.c).
   *
   * Phase 1: Singleton detection (mProd == 0, magnitude threshold).
   * Phase 2: Diagonal preference (minimum mProd, diagonal entry at column k).
   * Phase 3: Column search via linked structure (minimum mRow*mCol product).
   * Phase 4: Last-resort — largest magnitude among all unpivoted rows.
   *
   * ngspice variable mapping:
   *   MarkowitzRow[] → _markowitzRow[]
   *   MarkowitzCol[] → _markowitzCol[]
   *   MarkowitzProduct[] → _markowitzProd[]
   *   Singletons → _singletons
   *   RelThreshold → this._relThreshold
   *   AbsThreshold → this._absThreshold
   */
  /**
   * Return the largest |_elVal[e]| in the current column chain starting at
   * element `startE` (which must be the first entry BELOW the diagonal, i.e.
   * `_elNextInCol[diagE]`). Skips fill-ins is NOT done here — ngspice walks
   * every live element in the column regardless of fill-in flag, because
   * by the time _numericLUReusePivots runs those fill-ins are real entries
   * in the factored chain.
   * Mirrors ngspice FindLargestInCol (spfactor.c:1850-1863).
   */
  private _findLargestInColBelow(startE: number): number {
    let largest = 0;
    let e = startE;
    while (e >= 0) {
      const mag = Math.abs(this._elVal[e]);
      if (mag > largest) largest = mag;
      e = this._elNextInCol[e];
    }
    return largest;
  }

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

    let absMax = 0;
    for (let idx = 0; idx < xNzCount; idx++) {
      const i = xNzIdx[idx];
      if (pinv[i] >= 0) continue;
      const v = Math.abs(x[i]);
      if (v > absMax) absMax = v;
    }

    if (absMax === 0) return -1;

    const relThreshold = this._relThreshold * absMax;
    const absThreshold = this._absThreshold;

    // Phase 1: Singletons
    if (this._singletons > 0) {
      let bestRow = -1;
      let bestVal = 0;
      for (let idx = 0; idx < xNzCount; idx++) {
        const i = xNzIdx[idx];
        if (pinv[i] >= 0) continue;
        if (mProd[i] !== 0) continue;
        const v = Math.abs(x[i]);
        if (v <= absThreshold || v < relThreshold) continue;
        if (v > bestVal) { bestVal = v; bestRow = i; }
      }
      if (bestRow >= 0) return bestRow;
    }

    // Phase 2: Diagonal preference
    {
      let bestRow = -1;
      let bestProd = Infinity;
      let bestVal = 0;
      for (let idx = 0; idx < xNzCount; idx++) {
        const i = xNzIdx[idx];
        if (pinv[i] >= 0) continue;
        if (i !== k) continue;
        const v = Math.abs(x[i]);
        if (v <= absThreshold || v < relThreshold) continue;
        const prod = mProd[i];
        if (prod < bestProd || (prod === bestProd && v > bestVal)) {
          bestProd = prod; bestVal = v; bestRow = i;
        }
      }
      if (bestRow >= 0) return bestRow;
    }

    // Phase 3: Column search via linked structure
    {
      let bestRow = -1;
      let bestProd = Infinity;
      let bestVal = 0;
      let e = this._colHead[k];
      while (e >= 0) {
        const row = this._elRow[e];
        if (pinv[row] < 0) {
          const v = Math.abs(x[row]);
          if (v > absThreshold && v >= relThreshold) {
            const prod = mRow[row] * mCol[k];
            if (prod < bestProd || (prod === bestProd && v > bestVal)) {
              bestProd = prod; bestVal = v; bestRow = row;
            }
          }
        }
        e = this._elNextInCol[e];
      }
      if (bestRow >= 0) return bestRow;
    }

    // Phase 4: Last-resort — largest magnitude
    {
      let bestRow = -1;
      let bestVal = 0;
      for (let idx = 0; idx < xNzCount; idx++) {
        const i = xNzIdx[idx];
        if (pinv[i] >= 0) continue;
        const v = Math.abs(x[i]);
        if (v > bestVal) { bestVal = v; bestRow = i; }
      }
      return bestRow;
    }
  }

  /**
   * Update Markowitz numbers after eliminating pivot at step `step`.
   * Decrements row/col counts for entries in the pivot row and column.
   * Does NOT modify the linked structure — chains remain intact for
   * subsequent beginAssembly() calls. Only the count arrays are updated.
   * ngspice: UpdateMarkowitzNumbers (spfactor.c).
   */
  private _updateMarkowitzNumbers(step: number, pivotRow: number, pinv: Int32Array): void {
    const mRow = this._markowitzRow;
    const mCol = this._markowitzCol;
    const mProd = this._markowitzProd;

    // Walk pivot ROW — decrement column counts for non-pivot columns.
    // _elCol[e] is the element's ORIGINAL column; translate to the internal
    // column via _extToIntCol so it can be compared with `step` and used to
    // index _markowitzCol (both of which are keyed by internal column).
    let e = this._rowHead[pivotRow];
    while (e >= 0) {
      const c = this._extToIntCol[this._elCol[e]];
      if (c !== step && mCol[c] > 0) mCol[c]--;
      e = this._elNextInRow[e];
    }

    // Walk pivot COLUMN — decrement row counts for non-pivot rows
    e = this._colHead[step];
    while (e >= 0) {
      const r = this._elRow[e];
      if (r !== pivotRow && mRow[r] > 0) mRow[r]--;
      e = this._elNextInCol[e];
    }

    // Recompute products and singletons for remaining unpivoted rows
    let singletons = 0;
    for (let i = 0; i < this._n; i++) {
      if (pinv[i] >= 0) continue;
      mProd[i] = mRow[i] * mCol[i];
      if (mProd[i] === 0) singletons++;
    }
    this._singletons = singletons;
  }

  // =========================================================================
  // Internal: apply diagonal gmin
  // =========================================================================

  /**
   * Add gmin to every diagonal element. ngspice LoadGmin (spsmp.c:422-440).
   *
   * Intentionally does NOT set this._needsReorder = true: ngspice's
   * invariant is that LoadGmin is always wrapped atomically with spFactor
   * (SMPluFac, spsmp.c:169-175) or spOrderAndFactor (SMPreorder, :194-200),
   * so the gmin-stamped matrix is never observed without an immediate
   * re-factor. Our factor(diagGmin?) wrapper preserves that atomicity.
   */
  private _applyDiagGmin(gmin: number): void {
    if (gmin === 0) return;
    const n = this._n;
    const diag = this._diag;
    const elVal = this._elVal;
    for (let i = 0; i < n; i++) {
      const e = diag[i];
      if (e >= 0) elVal[e] += gmin;
    }
  }

  // =========================================================================
  // Storage growth for L/U CSC arrays
  // =========================================================================

  private _growL(min: number): void {
    const sz = Math.max(min, this._lRowIdx.length * 2);
    const r = new Int32Array(sz), v = new Float64Array(sz);
    r.set(this._lRowIdx); v.set(this._lVals);
    this._lRowIdx = r; this._lVals = v;
    const m = new Int32Array(sz).fill(-1);
    m.set(this._lCscToElem);
    this._lCscToElem = m;
  }

  private _growU(min: number): void {
    const sz = Math.max(min, this._uRowIdx.length * 2);
    const r = new Int32Array(sz), v = new Float64Array(sz);
    r.set(this._uRowIdx); v.set(this._uVals);
    this._uRowIdx = r; this._uVals = v;
    const m = new Int32Array(sz).fill(-1);
    m.set(this._uCscToElem);
    this._uCscToElem = m;
  }

  // =========================================================================
  // Accessors for tests that probe internal structure
  // =========================================================================

  /**
   * Count of non-fill-in elements in the linked structure.
   */
  get elementCount(): number {
    let count = 0;
    const n = this._n;
    for (let col = 0; col < n; col++) {
      let e = this._colHead[col];
      while (e >= 0) {
        if (!(this._elFlags[e] & FLAG_FILL_IN)) count++;
        e = this._elNextInCol[e];
      }
    }
    return count;
  }

}
