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
  /**
   * When `needsReorder === true`, the step at which `_numericLUReusePivots`
   * rejected the stored pivot order. ngspice spOrderAndFactor shares its
   * `Step` counter between the reuse loop (spfactor.c:217-227) and the
   * reorder loop (spfactor.c:241+) — on rejection the reorder loop resumes
   * at the same step. Steps `[0, rejectedAtStep)` are already factored in
   * ngspice convention; the caller must not redo them.
   */
  rejectedAtStep?: number;
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

  /**
   * Slot → original-row map. _intToExtRow[slot] = original row index.
   * Identity at factor entry; updated by _spcRowExchange when rows physical-swap.
   * Mirrors ngspice IntToExtRowMap.
   */
  private _intToExtRow: Int32Array = new Int32Array(0);

  /**
   * Original-row → slot map. _extToIntRow[origRow] = slot index.
   * Identity at factor entry; updated by _spcRowExchange in lockstep with
   * _intToExtRow. Mirrors ngspice ExtToIntRowMap.
   */
  private _extToIntRow: Int32Array = new Int32Array(0);

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
  // Pivot permutation
  // =========================================================================
  // _pinv[origRow] = step k at which origRow was chosen as pivot.
  // _q[k] = origRow chosen as pivot at step k (inverse of _pinv).
  private _pinv: Int32Array = new Int32Array(0);
  private _q: Int32Array = new Int32Array(0);


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
  // _numericLUMarkowitz lines 1415, 1424, 1439 and _numericLUReusePivots
  // lines 1595, 1605 — ngspice spMatrix semantics). Post-factor snapshots
  // via getCSCNonZeros() therefore report LU data, not the A matrix that
  // was factored. This capture snapshots the A matrix at factor() entry
  // so harness consumers see the system that was actually solved.
  private _preFactorMatrix: Array<{ row: number; col: number; value: number }> | null = null;
  private _capturePreFactorMatrix = false;

  // =========================================================================
  // State flags — ngspice MatrixFrame fields (spdefs.h:733-788) + macro :69.
  //
  // B2 fix (Phase 2.5 W2.1): we no longer conflate Factored + NeedsOrdering
  // into a single boolean. ngspice's `MatrixFrame` has two orthogonal flags:
  //   Matrix->Factored       (spdefs.h:748)  — "matrix has an LU factorization"
  //   Matrix->NeedsOrdering  (spdefs.h:761)  — "matrix topology changed; next
  //                                             factor must reorder, not reuse"
  // and a derived predicate:
  //   IS_FACTORED(m)         (spdefs.h:69)   — `((m)->Factored && !(m)->NeedsOrdering)`
  //
  // Our fields are named after the ngspice fields:
  //   Matrix->Factored       → _factored
  //   Matrix->NeedsOrdering  → _needsReorder
  //   IS_FACTORED(Matrix)    → (_factored && !_needsReorder)
  //   NIDIDPREORDER bit      → _didPreorder (CKT-lifetime — see S3)
  //
  // Set/clear lifecycle (must match ngspice exactly — see Item #10 audit):
  //   _needsReorder = true (ngspice NeedsOrdering = YES):
  //     * _initStructure — initial alloc (spalloc.c:170)
  //     * allocElement (new A-entry, not fill-in) — spbuild.c:788 inside
  //       spcCreateElement (B4 trigger: mid-assembly A-matrix insertion)
  //     * forceReorder() — niiter.c:858 NISHOULDREORDER on (MODEINITJCT ||
  //       (MODEINITTRAN && iterno==1))
  //     * invalidateTopology() — spStripMatrix path (sputils.c:1112)
  //   _needsReorder = false:
  //     * factorWithReorder() success — spfactor.c:279 `NeedsOrdering = NO`
  //
  //   _factored = true (ngspice Factored = YES):
  //     * factorWithReorder() success — spfactor.c:281 `Factored = YES`
  //     * factorNumerical() success   — spfactor.c:412 `Factored = YES`
  //   _factored = false:
  //     * _initStructure — spCreate initial (Factored implicitly NO)
  //     * invalidateTopology() — spStripMatrix path
  //
  //   _didPreorder = true:
  //     * preorder() first call — niiter.c:854 NIDIDPREORDER
  //   _didPreorder = false:
  //     * _initStructure — spCreate initial
  //     * invalidateTopology() — NIreinit (nireinit.c:42 clears CKTniState)
  // =========================================================================
  private _needsReorder: boolean = false;
  private _didPreorder: boolean = false;
  /**
   * ngspice MatrixFrame.Factored (spdefs.h:748). True iff the matrix currently
   * holds an LU factorization that can be reused by factorNumerical (modulo
   * the _needsReorder flag: IS_FACTORED = _factored && !_needsReorder).
   */
  private _factored: boolean = false;
  /**
   * ngspice MatrixFrame.RowsLinked (spdefs.h:771). FALSE during assembly and
   * preorder; flipped to TRUE by spcLinkRows on first factor entry. Single
   * point of truth for whether row chains exist. Drives the two-branch in
   * spcCreateElement (spbuild.c:776) and the gate in spOrderAndFactor
   * (spfactor.c:246-247).
   */
  private _rowsLinked: boolean = false;
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
  // Length n + 2 to host the ngspice sentinel slots used by SearchForSingleton
  // and QuicklySearchDiagonal:
  //   * _markowitzProd[step - 1]   — guard sentinel set to 0/-1 inside the
  //                                   pivot-search routines
  //   * _markowitzProd[Size + 1]   — dual-purpose slot storing
  //                                   _markowitzProd[Step] for the wraparound
  //                                   inspection of Diag[Step]
  //   * _markowitzProd[Size + 2]   — start of the QuicklySearchDiagonal
  //                                   reverse pointer scan
  private _markowitzRow: Int32Array = new Int32Array(0);
  private _markowitzCol: Int32Array = new Int32Array(0);
  // ngspice uses `long` (32-bit) for MarkowitzProduct. Our matrices fit; use
  // Int32Array to mirror the integer semantics including overflow promotion.
  private _markowitzProd: Int32Array = new Int32Array(0);
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

    // Allocate new element. Post-port `_elCol[e]` stores the SLOT the
    // element currently occupies (ngspice `pElement->Col == FirstInCol
    // index` invariant). At allocation time we use `internalCol`
    // (= _extToIntCol[col] = slot at allocation) so the invariant holds
    // immediately. Initially _extToIntCol is identity so internalCol == col.
    //
    // `_elRow[e]` analogously stores the SLOT the element occupies row-wise.
    // ngspice IntToExtRowMap is identity until the first `_spcRowExchange`
    // during factorization, so storing `row` directly here is correct (slot
    // == original row at allocation).
    //
    // B4 (Phase 2.5 W2.1): ngspice spcCreateElement (spbuild.c:786-788):
    //     pElement = spcGetElement( Matrix );
    //     Matrix->Originals++;
    //     Matrix->NeedsOrdering = YES;
    // Every new non-fill-in element sets Matrix->NeedsOrdering = YES. This
    // is the ONLY stamp-time trigger for NeedsOrdering in ngspice. Our
    // invariant mirror: every allocElement that actually allocates (i.e.
    // misses the existing-element fast path above) sets _needsReorder,
    // forcing the next factor() through factorWithReorder. Fill-ins created
    // by _numericLUMarkowitz set FLAG_FILL_IN and route through
    // _newElement directly; ngspice's equivalent is spcGetFillin
    // (spbuild.c:779-782), which does NOT touch NeedsOrdering.
    const newE = this._newElement(row, internalCol, 0, 0);
    // ngspice spcCreateElement (spbuild.c:776) — row insert only when
    // RowsLinked == YES. During assembly and preorder, row chains do not
    // exist; spcLinkRows builds them lazily on first factor entry.
    if (this._rowsLinked) this._insertIntoRow(newE, row);
    this._insertIntoCol(newE, internalCol);
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
   *
   * Additive per ngspice spfactor.c (every stamp is *(ptr) += val). Verified A1 C-W3-1 2026-04-22.
   */
  stampElement(handle: number, value: number): void {
    this._elVal[handle] += value;
  }

  /**
   * Additive per ngspice spfactor.c (every stamp is *(ptr) += val). Verified A1 C-W3-1 2026-04-22.
   */
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

    // Reset Markowitz arrays. Length n + 2 hosts the ngspice sentinel slots.
    if (this._markowitzRow.length !== size + 2) {
      this._markowitzRow = new Int32Array(size + 2);
      this._markowitzCol = new Int32Array(size + 2);
      this._markowitzProd = new Int32Array(size + 2);
    } else {
      this._markowitzRow.fill(0);
      this._markowitzCol.fill(0);
      this._markowitzProd.fill(0);
    }
    this._singletons = 0;

    // ngspice does NOT reset IntToExtRowMap / ExtToIntRowMap between factor
    // calls — `spClear` (spbuild.c:96-142) zeros only element values. The
    // row permutation, the chain heads (`FirstInRow/Col`), and per-element
    // `Row`/`Col` fields all carry forward exactly as the previous factor
    // left them. The next reorder layers more swaps on top. We mirror that.
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
   * ngspice counterparts:
   *   - `diagGmin` → `LoadGmin(Matrix, Gmin)`, called INSIDE `SMPluFac`
   *     (spsmp.c:173) and `SMPreorder` (spsmp.c:197) before the matching
   *     `spFactor` / `spOrderAndFactor` invocation. B3 (Phase 2.5 W2.1):
   *     the gmin stamp belongs inside the factor routine so callers never
   *     observe a post-gmin, pre-factor matrix.
   *   - Dispatch: `spFactor(Matrix)` at spfactor.c:333-335 forwards to
   *     `spOrderAndFactor` when `Matrix->NeedsOrdering` is set. Our B2
   *     predicate `_needsReorder || !_factored` is the same guard expanded
   *     with `Factored = NO` catching the first-ever factor call.
   *   - `needsReorder` sentinel from `_numericLUReusePivots` → spfactor.c:225
   *     `ReorderingRequired = YES; break`, landing the outer `for` exit in
   *     the full-reorder section at spfactor.c:231-237. The numeric-reuse
   *     path's per-step column-relative pivot guard can demand a full
   *     reorder — this is NOT a singular-matrix failure.
   */
  factor(diagGmin?: number): FactorResult {
    // B2: IS_FACTORED predicate from ngspice spdefs.h:69 —
    //   `((m)->Factored && !(m)->NeedsOrdering)`.
    // Reuse the stored pivot order only when both conditions hold. Otherwise
    // dispatch to factorWithReorder, which mirrors spFactor's fallthrough at
    // spfactor.c:333-335 (calls spOrderAndFactor when NeedsOrdering is set).
    if (this._needsReorder || !this._factored) {
      this.lastFactorUsedReorder = true;
      return this.factorWithReorder(diagGmin);
    }
    this.lastFactorUsedReorder = false;
    const result = this.factorNumerical(diagGmin);
    if (!result.success && result.needsReorder) {
      // ngspice spOrderAndFactor: when the reuse loop at spfactor.c:217-227
      // rejects at step k, control falls through to the reorder loop at
      // spfactor.c:241+ which RESUMES at the same step — the `Step` counter
      // is shared between the two loops, and steps [0, k) are already in
      // ngspice-convention factored form. We must NOT re-stamp gmin (already
      // applied by factorNumerical above) and must NOT restart from step 0.
      const rejectedAtStep = result.rejectedAtStep ?? 0;
      this._needsReorder = true;
      this.lastFactorUsedReorder = true;
      this._allocateWorkspace();
      const reorderResult = this._numericLUMarkowitz(rejectedAtStep);
      if (reorderResult.success) {
        // ngspice spfactor.c:279-281
        //   Matrix->NeedsOrdering = NO;
        //   Matrix->Reordered = YES;
        //   Matrix->Factored = YES;
        this._needsReorder = false;
        this._factored = true;
      }
      return reorderResult;
    }
    return result;
  }

  /**
   * Sparse forward/backward substitution by walking the linked structure.
   *
   * ngspice spsolve.c spSolve — port mirroring forward-sub at spsolve.c:154,
   * back-sub at spsolve.c:173. RHS-in permutation at spsolve.c:149-151,
   * RHS-out permutation at spsolve.c:186-188.
   *
   * Post-factor linked-structure convention (ngspice unit-diag-U):
   *   _elVal[_diag[k]]      = 1 / pivot_k
   *   _elVal[(i, k)] i < k  = U_ik = A_ik_post / pivot_i   (U scaled, unit diag)
   *   _elVal[(i, k)] i > k  = L_ik = A_ik_post              (L unscaled)
   *
   * Variable map (ngspice → digiTS):
   *   Matrix->Diag[k]            → _diag[k]
   *   pPivot->Real               → _elVal[_diag[k]]
   *   pElement->NextInCol        → _elNextInCol[e]
   *   pElement->NextInRow        → _elNextInRow[e]
   *   pElement->Real             → _elVal[e]
   *   pElement->Row              → _elRow[e]
   *   pElement->Col              → _elCol[e]
   *   Matrix->IntToExtRowMap[k]  → _intToExtRow[k]
   *   Matrix->IntToExtColMap[k]  → _preorderColPerm[k]   (inverse of _extToIntCol)
   *   RHS                        → this._rhs (stamped by caller, original-row keyed)
   *   Solution                   → x (caller output, original-col keyed)
   *   Intermediate               → b (this._scratch)
   */
  solve(x: Float64Array): void {
    const n = this._n;
    if (n === 0) return;

    const b = this._scratch;
    const rhs = this._rhs;
    const intToExtRow = this._intToExtRow;
    const intToExtCol = this._preorderColPerm;
    const diag = this._diag;
    const elVal = this._elVal;
    const elRow = this._elRow;
    const elCol = this._elCol;
    const elNextInCol = this._elNextInCol;
    const elNextInRow = this._elNextInRow;

    // Initialize Intermediate vector — spsolve.c:149-151.
    //   pExtOrder = &Matrix->IntToExtRowMap[Size];
    //   for (I = Size; I > 0; I--)
    //       Intermediate[I] = RHS[*(pExtOrder--)];
    // RHS comes from the solver's internal _rhs (populated via stampRHS calls
    // from ckt-load.ts; the NR comment "stamps into ctx.rhs" is misleading —
    // cktLoad goes through ctx.solver.stampRHS, which writes to this._rhs).
    // _intToExtRow[k] = original row at slot k.
    // Walk reverse to match ngspice spsolve.c:150 `for (I = Size; I > 0; I--)`.
    for (let k = n - 1; k >= 0; k--) b[k] = rhs[intToExtRow[k]];

    // Forward elimination. Solves Lc = b — spsolve.c:154-170.
    //   for (I = 1; I <= Size; I++) {
    //       if ((Temp = Intermediate[I]) != 0.0) {
    //           pPivot = Matrix->Diag[I];
    //           Intermediate[I] = (Temp *= pPivot->Real);
    //           pElement = pPivot->NextInCol;
    //           while (pElement != NULL) {
    //               Intermediate[pElement->Row] -= Temp * pElement->Real;
    //               pElement = pElement->NextInCol;
    //           }
    //       }
    //   }
    // pPivot->Real holds 1/pivot_k post-factor (ngspice spfactor.c:349/383/408,
    // mirrored on _elVal[_diag[k]]). Elements below the diagonal in column k
    // hold L_ik = A_ik_post (unscaled); the multiply Temp * elVal[e] forms
    // L_ik * y_k as required.
    for (let k = 0; k < n; k++) {
      let temp = b[k];
      if (temp !== 0.0) {
        const pPivot = diag[k];
        temp *= elVal[pPivot];
        b[k] = temp;
        let pElement = elNextInCol[pPivot];
        while (pElement >= 0) {
          b[elRow[pElement]] -= temp * elVal[pElement];
          pElement = elNextInCol[pElement];
        }
      }
    }

    // Backward Substitution. Solves Ux = c — spsolve.c:173-183.
    //   for (I = Size; I > 0; I--) {
    //       Temp = Intermediate[I];
    //       pElement = Matrix->Diag[I]->NextInRow;
    //       while (pElement != NULL) {
    //           Temp -= pElement->Real * Intermediate[pElement->Col];
    //           pElement = pElement->NextInRow;
    //       }
    //       Intermediate[I] = Temp;
    //   }
    // U is unit-diagonal in ngspice convention — no division at the diagonal.
    // Elements right of the diagonal in row k hold U_ki = A_ki_post / pivot_k
    // (already scaled at factor time).
    for (let k = n - 1; k >= 0; k--) {
      let temp = b[k];
      let pElement = elNextInRow[diag[k]];
      while (pElement >= 0) {
        temp -= elVal[pElement] * b[elCol[pElement]];
        pElement = elNextInRow[pElement];
      }
      b[k] = temp;
    }

    // Unscramble Intermediate vector while placing data into Solution vector
    // — spsolve.c:186-188.
    //   pExtOrder = &Matrix->IntToExtColMap[Size];
    //   for (I = Size; I > 0; I--)
    //       Solution[*(pExtOrder--)] = Intermediate[I];
    // _preorderColPerm[k] = original col for slot k (mirrors IntToExtColMap).
    // Walk reverse to match ngspice spsolve.c:187 `for (I = Size; I > 0; I--)`.
    for (let k = n - 1; k >= 0; k--) x[intToExtCol[k]] = b[k];
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
    // B2: clear Factored (spdefs.h:748). spStripMatrix clears the linked
    // structure and the factorization along with it.
    this._factored = false;
    this._didPreorder = false;
    // ngspice spStripMatrix (sputils.c:1112): NeedsOrdering = YES.
    this._needsReorder = true;
    // ngspice spStripMatrix (sputils.c:1111): RowsLinked = NO.
    this._rowsLinked = false;
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
   * One-time static column permutation to eliminate structural zeros on the
   * diagonal. ngspice: spMNA_Preorder (sputils.c:177-230). spMNA_Preorder
   * does not touch row chains — those are built lazily by spcLinkRows on
   * first factor entry (spfactor.c:246-247).
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
   * Rebuild all row chains from the current column structure. Mirrors ngspice
   * spcLinkRows (spbuild.c:907-932). Walks columns in DECREASING slot order;
   * each element is inserted at the HEAD of its row's chain, so that on
   * completion every row chain is sorted ascending by current _elCol[e].
   *
   * Adapted for digiTS' doubly-linked structure: _elPrevInRow is also
   * maintained alongside _elNextInRow.
   */
  private _linkRows(): void {
    const n = this._n;
    for (let r = 0; r < n; r++) this._rowHead[r] = -1;
    for (let col = n - 1; col >= 0; col--) {
      let e = this._colHead[col];
      while (e >= 0) {
        const r = this._elRow[e];
        const oldHead = this._rowHead[r];
        this._elNextInRow[e] = oldHead;
        this._elPrevInRow[e] = -1;
        if (oldHead >= 0) this._elPrevInRow[oldHead] = e;
        this._rowHead[r] = e;
        e = this._elNextInCol[e];
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
   * ngspice reference: SwapCols (sputils.c:283-301). SwapCols swaps the
   * column heads and the IntToExtColMap entries — it does NOT touch any
   * element fields. The `pElement->Col == slot` invariant is established
   * later by spcLinkRows (spbuild.c:923 `pElement->Col = Col`) when row
   * chains are built on first factor entry.
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
   * Search column slot's chain for its diagonal pool element.
   * Post-port the diagonal of slot `slot` is the element with `_elRow[e] === slot`
   * (the slot row equals the slot col on the diagonal). Mirrors ngspice
   * spcFindElementInCol with `(Col, Col)` arguments — see ExchangeRowsAndCols
   * (spfactor.c:2046, 2065-2069).
   */
  private _findDiagOnColumn(slot: number): number {
    let e = this._colHead[slot];
    while (e >= 0) {
      if (this._elRow[e] === slot) return e;
      e = this._elNextInCol[e];
    }
    return -1;
  }

  // =========================================================================
  // Harness instrumentation accessors
  // =========================================================================

  get dimension(): number { return this._n; }
  get markowitzRow(): Int32Array { return this._markowitzRow; }
  get markowitzCol(): Int32Array { return this._markowitzCol; }
  get markowitzProd(): Int32Array { return this._markowitzProd; }
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
   * Snapshot the currently-assembled matrix into _preFactorMatrix, skipped
   * when capture is disabled. Called from factorWithReorder / factorNumerical
   * IMMEDIATELY AFTER _applyDiagGmin so the snapshot reflects the matrix that
   * is actually about to be factored — matching ngspice's invariant that
   * LoadGmin + spFactor are observed atomically.
   */
  private _takePreFactorSnapshotIfEnabled(): void {
    if (!this._capturePreFactorMatrix) return;
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
    this._pinv = new Int32Array(n);
    this._q = new Int32Array(n);
    this._scratch = new Float64Array(n);

    this._markowitzRow = new Int32Array(n + 2);
    this._markowitzCol = new Int32Array(n + 2);
    this._markowitzProd = new Int32Array(n + 2);

    // ngspice IntToExtRowMap / ExtToIntRowMap initialised identity in
    // spcCreateInternalVectors (sputils.c). Updated only by spcRowExchange
    // during pivot selection.
    this._intToExtRow = new Int32Array(n);
    this._extToIntRow = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      this._intToExtRow[i] = i;
      this._extToIntRow[i] = i;
    }

    this._structureEmpty = false;
    // B2: Factored starts at NO (spdefs.h:748 default — spCreate zero-allocates
    // MatrixFrame, so Factored = NO implicitly).
    this._factored = false;
    // ngspice spalloc.c:173 — Matrix->RowsLinked = NO on initial Create.
    this._rowsLinked = false;
    // ngspice spalloc.c:170 — Matrix->NeedsOrdering = YES on initial Create.
    this._needsReorder = true;
    this._didPreorder = false;
  }

  /**
   * Reset for a new assembly pass: mirror ngspice spClear (spbuild.c:96-142).
   * Zero all element values in the pool [0, _elCount). Chains (_elNextInRow,
   * _elPrevInRow, _elNextInCol, _elPrevInCol, _elRow, _elCol), _diag,
   * _rowHead, _colHead, _elFreeHead, and fill-in entries are all preserved
   * exactly as the previous factor left them.
   */
  private _resetForAssembly(): void {
    const elVal = this._elVal;
    const elCount = this._elCount;
    for (let e = 0; e < elCount; e++) {
      elVal[e] = 0;
    }
  }

  // =========================================================================
  // Internal: element pool operations
  // =========================================================================

  /**
   * Allocate a new element from the pool or free-list.
   * Sets row, col, val, flags. Returns element index.
   *
   * ngspice: spcGetElement (spalloc.c:310-364) plus the centralised
   * `Diag[Row] = pElement` set sites at spbuild.c:793 (RowsLinked=YES branch)
   * and spbuild.c:851 (RowsLinked=NO branch). Both branches in ngspice
   * funnel through one diagonal set; we centralise the same way here.
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
    // ngspice spcCreateElement spbuild.c:793 / spbuild.c:851 — single sink
    // for `if (Row == Col) Matrix->Diag[Row] = pElement;` regardless of
    // the RowsLinked branch.
    if (row === col) this._diag[col] = e;
    return e;
  }

  /**
   * Insert `e` into row `row`'s chain at the column-sorted position.
   *
   * ngspice's pivot search routines (SearchForSingleton, SearchEntireMatrix,
   * FindBiggestInColExclude) walk chains and skip leading entries with
   * `Col < Step` / `Row < Step`. They rely on chains being sorted ascending
   * by row/col — without that, an entry past the first `>= Step` element
   * could still have `< Step` and be treated as an unpivoted candidate.
   * digiTS therefore maintains the sorted-chain invariant at every insert.
   */
  private _insertIntoRow(e: number, row: number): void {
    const eCol = this._elCol[e];
    let prev = -1;
    let cur = this._rowHead[row];
    while (cur >= 0 && this._elCol[cur] < eCol) {
      prev = cur;
      cur = this._elNextInRow[cur];
    }
    this._elPrevInRow[e] = prev;
    this._elNextInRow[e] = cur;
    if (prev < 0) this._rowHead[row] = e;
    else this._elNextInRow[prev] = e;
    if (cur >= 0) this._elPrevInRow[cur] = e;
  }

  /**
   * Allocate a fill-in pool element at (row, col) and splice it into the
   * row/col linked structure. Returns the new pool index.
   *
   * Markowitz/Singletons bookkeeping mirrors ngspice CreateFillin
   * spfactor.c:2798-2829 line-for-line. Pre-increment order matters: each
   * count is incremented BEFORE the product is recomputed, and the
   * Singletons check inspects the post-increment value of the count being
   * ++'d alongside the unchanged value of the other count.
   *
   *   ngspice                            digiTS
   *   ----------------------------------+-------------------------
   *   Matrix->MarkowitzRow[Row]         | this._markowitzRow[row]
   *   Matrix->MarkowitzCol[Col]         | this._markowitzCol[col]
   *   Matrix->MarkowitzProd[i]          | this._markowitzProd[i]
   *   Matrix->Singletons                | this._singletons
   */
  private _createFillin(row: number, col: number): number {
    // ngspice CreateFillin (spfactor.c:2799-2829) calls spcCreateElement
    // (spbuild.c:768-871). Fill-ins are created during factor only —
    // _rowsLinked is always true at this point — but gate row insert on
    // RowsLinked per the spcCreateElement contract (spbuild.c:776).
    // _diag[col] = fe is centralised in _newElement (spbuild.c:793/851).
    const fe = this._newElement(row, col, 0, FLAG_FILL_IN);
    if (this._rowsLinked) this._insertIntoRow(fe, row);
    this._insertIntoCol(fe, col);

    // ngspice CreateFillin spfactor.c:2818-2826.
    this._markowitzRow[row] += 1;
    this._markowitzProd[row] = this._markowitzRow[row] * this._markowitzCol[row];
    if (this._markowitzRow[row] === 1 && this._markowitzCol[row] !== 0) {
      this._singletons -= 1;
    }
    this._markowitzCol[col] += 1;
    this._markowitzProd[col] = this._markowitzCol[col] * this._markowitzRow[col];
    if (this._markowitzRow[col] !== 0 && this._markowitzCol[col] === 1) {
      this._singletons -= 1;
    }

    return fe;
  }

  /** Sorted-insert into column `col`'s chain — same rationale as _insertIntoRow. */
  private _insertIntoCol(e: number, col: number): void {
    const eRow = this._elRow[e];
    let prev = -1;
    let cur = this._colHead[col];
    while (cur >= 0 && this._elRow[cur] < eRow) {
      prev = cur;
      cur = this._elNextInCol[cur];
    }
    this._elPrevInCol[e] = prev;
    this._elNextInCol[e] = cur;
    if (prev < 0) this._colHead[col] = e;
    else this._elNextInCol[prev] = e;
    if (cur >= 0) this._elPrevInCol[cur] = e;
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
    else this._colHead[this._elCol[e]] = next;
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

    this._pinv = new Int32Array(n);
    this._q = new Int32Array(n);
    this._scratch = new Float64Array(n);
    this._elMark = new Int32Array(n).fill(-1);
    this._rowToElem = new Int32Array(n).fill(-1);
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
  private _numericLUMarkowitz(startStep: number = 0): FactorResult {
    const n = this._n;
    if (n === 0) return { success: true };

    const pinv = this._pinv;

    // ngspice spOrderAndFactor: CountMarkowitz/MarkowitzProducts run only on
    // first reorder (gated by Matrix->Partitioned at spfactor.c:248). When
    // this entry is the fall-through from a rejected `_numericLUReusePivots`
    // (startStep > 0), every reuse-path elimination has already maintained
    // Markowitz state via _createFillin → bookkeeping; do not re-init.
    // Pass the live RHS so CountMarkowitz can apply its RHS-aware increment
    // (spfactor.c:803-808): rows whose RHS entry is non-zero get +1 weight.
    if (startStep === 0) {
      pinv.fill(-1);
      this._countMarkowitz(0, this._rhs);
      this._markowitzProducts(0);
    }

    // ============================================================
    // ngspice-style per-step elimination on linked structure.
    // Direct port of RealRowColElimination (spfactor.c:2553-2598). The
    // elimination writes ngspice convention onto _elVal[e]:
    //   diag(k):  _elVal = 1 / pivot_k                  (spfactor.c:2567)
    //   U(i,k):   _elVal = A_ik_post / pivot_i          (spfactor.c:2572)
    //   L(i,k):   _elVal = A_ik_post                    (unscaled at step k)
    //
    // When startStep > 0, steps [0, startStep) are already eliminated in
    // ngspice convention from the rejected reuse-pivot pass; we resume the
    // reorder at startStep, mirroring ngspice's shared `Step` counter
    // between the reuse loop (spfactor.c:217-227) and the reorder loop
    // (spfactor.c:241+) inside spOrderAndFactor.
    // ============================================================
    for (let k = startStep; k < n; k++) {
      // ngspice spOrderAndFactor:261 — pivot search BEFORE elimination.
      const pivotE = this._searchForPivot(k);
      if (pivotE < 0) {
        return { success: false, singularRow: k };
      }

      // ngspice spOrderAndFactor:263 — bring pivot to slot (k, k) physically.
      this._exchangeRowsAndCols(pivotE, k);
      // After exchange, pivotE sits at slot (k, k); _diag[k] === pivotE.

      // ngspice RealRowColElimination spfactor.c:2563-2566 — pivot zero test.
      if (Math.abs(this._elVal[pivotE]) === 0) {
        return { success: false, singularRow: k };
      }
      // ngspice spfactor.c:2567 — store reciprocal of pivot at the diagonal.
      this._elVal[pivotE] = 1 / this._elVal[pivotE];

      // ngspice spfactor.c:2569-2596 — eliminate every row reached via the
      // pivot row × pivot column outer product. pUpper walks the pivot row
      // (right of the diagonal), and for each upper element we walk its
      // column (below the diagonal) in lockstep with the pivot column.
      let pUpper = this._elNextInRow[pivotE];
      while (pUpper >= 0) {
        // ngspice spfactor.c:2572 — scale upper triangular element.
        this._elVal[pUpper] *= this._elVal[pivotE];

        let pSub = this._elNextInCol[pUpper];
        let pLower = this._elNextInCol[pivotE];
        const upperCol = this._elCol[pUpper];
        while (pLower >= 0) {
          const row = this._elRow[pLower];
          // ngspice spfactor.c:2580-2581 — advance pSub to row alignment.
          while (pSub >= 0 && this._elRow[pSub] < row) {
            pSub = this._elNextInCol[pSub];
          }
          if (pSub < 0 || this._elRow[pSub] > row) {
            // ngspice spfactor.c:2585 — create fill-in at (row, upperCol).
            // _createFillin owns the Markowitz/Singletons bookkeeping per
            // CreateFillin spfactor.c:2818-2826.
            pSub = this._createFillin(row, upperCol);
          }
          // ngspice spfactor.c:2591 — rank-1 update.
          this._elVal[pSub] -= this._elVal[pUpper] * this._elVal[pLower];
          pSub = this._elNextInCol[pSub];
          pLower = this._elNextInCol[pLower];
        }
        pUpper = this._elNextInRow[pUpper];
      }

      // ngspice spOrderAndFactor:271 — update Markowitz post-elimination.
      if (k < n - 1) {
        this._updateMarkowitzNumbers(pivotE);
      }
    }

    // Condition estimate from final pivot diagonals. ngspice convention:
    // _elVal[_diag[k]] = 1/pivot_k, so the pivot magnitude is 1 / |inv_pivot|.
    let maxDiag = 0, minDiag = Infinity;
    for (let k = 0; k < n; k++) {
      const invPivot = Math.abs(this._elVal[this._diag[k]]);
      const pivotMag = invPivot > 0 ? 1 / invPivot : 0;
      if (pivotMag > maxDiag) maxDiag = pivotMag;
      if (pivotMag > 0 && pivotMag < minDiag) minDiag = pivotMag;
    }
    return { success: true, conditionEstimate: minDiag > 0 ? maxDiag / minDiag : Infinity };
  }

  /**
   * Numeric LU factorization reusing pivot order from a prior factorWithReorder call.
   * Skips pivot search — operates on the existing linked structure with the
   * pivot order already stored in _diag[]. Mirrors ngspice spFactor
   * (spfactor.c:322-414), the no-reorder factor entry point that calls
   * RealRowColElimination (spfactor.c:2553-2598) over the existing structure.
   *
   * ngspice spFactor — reuse-pivot factor with RealRowColElimination at
   * spfactor.c:2553-2598. There is no SearchForPivot, no ExchangeRowsAndCols,
   * no UpdateMarkowitzNumbers, no CreateFillin: every fill-in already exists
   * in the linked structure from the prior spOrderAndFactor.
   *
   * Variable map (ngspice → digiTS):
   *   Matrix->Diag[k]              → _diag[k]
   *   pElement->NextInRow          → _elNextInRow[e]
   *   pElement->NextInCol          → _elNextInCol[e]
   *   pElement->Row                → _elRow[e]
   *   pElement->Col                → _elCol[e]
   *   pElement->Real               → _elVal[e]
   *
   * Output convention written onto _elVal[e]:
   *   _elVal[_diag[k]]      = 1 / pivot_k                  (spfactor.c:2567)
   *   _elVal[(i, k)] i < k  = A_ik_post_elim / pivot_i     (spfactor.c:2572)
   *   _elVal[(i, k)] i > k  = A_ik_post_elim               (unscaled)
   */
  private _numericLUReusePivots(): FactorResult {
    const n = this._n;
    if (n === 0) return { success: true };

    // _resetForAssembly already zeroed all element values (including fill-ins),
    // so no pre-zero loop is needed here.

    const elVal = this._elVal;
    const elNextInRow = this._elNextInRow;
    const elNextInCol = this._elNextInCol;
    const elRow = this._elRow;
    const diag = this._diag;

    // ngspice spFactor — per-step elimination over the existing linked
    // structure. Body identical to RealRowColElimination at spfactor.c:
    // 2553-2598 (mirrored in _numericLUMarkowitz Phase 1).
    const relThreshold = this._relThreshold;
    const absThreshold = this._absThreshold;
    for (let k = 0; k < n; k++) {
      const pivotE = diag[k];   // already at slot k from prior reorder
      if (pivotE < 0 || Math.abs(elVal[pivotE]) === 0) {
        // Structural zero where prior reorder expected a non-zero — pivot
        // order is no longer valid. Caller dispatches to _numericLUMarkowitz
        // resumed at this step (ngspice spfactor.c:225).
        return { success: false, needsReorder: true, rejectedAtStep: k };
      }
      // ngspice spfactor.c:218-225 — column-relative partial-pivot guard.
      // Reuse loop accepts the stored pivot iff
      //     FindLargestInCol(pPivot->NextInCol) * RelThreshold < |pPivot|
      // Rejection here lands the reorder fall-through at step k, matching
      // ngspice's shared `Step` counter between the two loops.
      const pivotMag = Math.abs(elVal[pivotE]);
      const largestInCol = this._findLargestInCol(elNextInCol[pivotE]);
      if (largestInCol * relThreshold >= pivotMag || pivotMag <= absThreshold) {
        return { success: false, needsReorder: true, rejectedAtStep: k };
      }
      // ngspice spfactor.c:2567 — store reciprocal at the diagonal.
      elVal[pivotE] = 1 / elVal[pivotE];

      // ngspice spfactor.c:2569-2596 — eliminate every row reached via the
      // pivot row × pivot column outer product. pUpper walks the pivot row
      // (right of the diagonal), and for each upper element we walk its
      // column (below the diagonal) in lockstep with the pivot column.
      let pUpper = elNextInRow[pivotE];
      while (pUpper >= 0) {
        // ngspice spfactor.c:2572 — scale upper triangular element.
        elVal[pUpper] *= elVal[pivotE];

        let pSub = elNextInCol[pUpper];
        let pLower = elNextInCol[pivotE];
        while (pLower >= 0) {
          const row = elRow[pLower];
          // ngspice spfactor.c:2580-2581 — advance pSub to row alignment.
          while (pSub >= 0 && elRow[pSub] < row) {
            pSub = elNextInCol[pSub];
          }
          if (pSub < 0 || elRow[pSub] > row) {
            // Reuse-pivot must NOT create fill-ins. A missing entry here
            // means the prior reorder's pivot order is no longer
            // structurally valid. Caller dispatches to _numericLUMarkowitz
            // resumed at step k (ngspice spfactor.c:225 "ReorderingRequired
            // = YES; break"; the reorder loop continues with shared Step).
            return { success: false, needsReorder: true, rejectedAtStep: k };
          }
          // ngspice spfactor.c:2591 — rank-1 update.
          elVal[pSub] -= elVal[pUpper] * elVal[pLower];
          pSub = elNextInCol[pSub];
          pLower = elNextInCol[pLower];
        }
        pUpper = elNextInRow[pUpper];
      }
    }

    // Condition estimate from final pivot reciprocals stored at the diagonals.
    let maxDiag = 0, minDiag = Infinity;
    for (let k = 0; k < n; k++) {
      const dk = diag[k];
      if (dk < 0) continue;
      // _elVal[dk] = 1 / pivot_k — magnitude of pivot is the reciprocal.
      const invMag = Math.abs(elVal[dk]);
      if (invMag === 0) continue;
      const v = 1 / invMag;
      if (v > maxDiag) maxDiag = v;
      if (v < minDiag) minDiag = v;
    }

    return { success: true, conditionEstimate: minDiag > 0 && minDiag !== Infinity ? maxDiag / minDiag : Infinity };
  }

  // =========================================================================
  // Factorization public API
  // =========================================================================

  /**
   * Full factorization with Markowitz pivot selection (no AMD).
   * Operates on original column order per ngspice spOrderAndFactor
   * (spfactor.c:192-284). Lazy row-link gate at spfactor.c:246-247.
   */
  factorWithReorder(diagGmin?: number): FactorResult {
    // ngspice spOrderAndFactor (spfactor.c:246-247): row chains are built
    // lazily on first factor entry via spcLinkRows. Until the first factor
    // call, RowsLinked == NO and assembly / preorder run on column chains
    // only.
    if (!this._rowsLinked) {
      this._linkRows();
      this._rowsLinked = true;
    }
    // B3: Gmin stamped INSIDE the factor routine — ngspice spsmp.c:194-200
    // `SMPreorder` body: `LoadGmin(Matrix, Gmin); return spOrderAndFactor(...)`.
    // LoadGmin (spsmp.c:422-440) adds Gmin to every diagonal element, then
    // spOrderAndFactor consumes that already-stamped matrix. The stamp +
    // factor pair is never observed separately.
    if (diagGmin) this._applyDiagGmin(diagGmin);
    this._takePreFactorSnapshotIfEnabled();
    if (this._needsReorder) {
      this._allocateWorkspace();
    }
    const result = this._numericLUMarkowitz();
    if (result.success) {
      // B2: ngspice spfactor.c:279-281
      //   Matrix->NeedsOrdering = NO;
      //   Matrix->Reordered = YES;
      //   Matrix->Factored = YES;
      this._needsReorder = false;
      this._factored = true;
    }
    return result;
  }

  /**
   * Numerical-only factorization reusing pivot order from last factorWithReorder call.
   * ngspice: spFactor (spfactor.c:322-414).
   */
  factorNumerical(diagGmin?: number): FactorResult {
    // B3: Gmin stamped INSIDE the factor routine — ngspice spsmp.c:169-175
    // `SMPluFac` body: `spSetReal(Matrix); LoadGmin(Matrix, Gmin); return spFactor(Matrix);`
    if (diagGmin) this._applyDiagGmin(diagGmin);
    this._takePreFactorSnapshotIfEnabled();
    const result = this._numericLUReusePivots();
    // B2: ngspice spfactor.c:412 `Matrix->Factored = YES` on successful spFactor.
    // The numerical-reuse path preserves _needsReorder = false (it was already
    // false when we entered; a failure here returns needsReorder:true and
    // factor() dispatches to factorWithReorder, which sets both flags).
    if (result.success) {
      this._factored = true;
    }
    return result;
  }

  // =========================================================================
  // 4-phase Markowitz pivot search
  // =========================================================================

  /**
   * Markowitz pivot search matching ngspice SearchForPivot (spfactor.c:947-994).
   *
   * Phase 1: Singleton detection — SearchForSingleton (mProd == 0, magnitude
   *          threshold). Mirrors spfactor.c:951-977.
   * Phase 2: Diagonal preference — QuicklySearchDiagonal / SearchDiagonal.
   *          Uses _diag[k] pool-handle lookup (ngspice Matrix->Diag[Step])
   *          rather than an original-row equality test. Mirrors spfactor.c:
   *          1255-1383.
   * Phase 3 / 4 unified: SearchEntireMatrix — walks every column j in [k, n),
   *          computes per-column LargestInCol, selects minimum MarkowitzProduct
   *          with (Magnitude > RelThreshold * LargestInCol) &&
   *          (Magnitude > AbsThreshold). Tie-break on LargestInCol/Magnitude
   *          ratio (ngspice RatioOfAccepted). Last-resort: globally largest
   *          element (pLargestElement). Mirrors spfactor.c:1730-1809.
   *
   * ngspice variable mapping:
   *   MarkowitzRow[] → _markowitzRow[]
   *   MarkowitzCol[] → _markowitzCol[]
   *   MarkowitzProduct[] → _markowitzProd[]
   *   Singletons → _singletons
   *   RelThreshold → this._relThreshold
   *   AbsThreshold → this._absThreshold
   *   Matrix->Diag[Step] → this._diag[k]
   */
  /**
   * ngspice FindLargestInCol (spfactor.c:1849-1863) — line-for-line port.
   * Walks the column chain starting at `startE`, returning the largest
   * |val|. Caller passes either the column head or the element just below
   * the diagonal (`_elNextInCol[diagE]`) depending on the surrounding
   * predicate. Fill-ins are NOT skipped — by the time pivot search runs,
   * every live element in the column matters regardless of provenance.
   */
  private _findLargestInCol(startE: number): number {
    let largest = 0;
    let e = startE;
    while (e >= 0) {
      const magnitude = Math.abs(this._elVal[e]);
      if (magnitude > largest) largest = magnitude;
      e = this._elNextInCol[e];
    }
    return largest;
  }

  /**
   * ngspice FindBiggestInColExclude (spfactor.c:1913-1944) — line-for-line port.
   * Returns the largest |val| in the active part of the column containing
   * pE, EXCLUDING pE itself. Step is the current pivot step.
   *
   * Invariant: pE must be a live element whose column is `_elCol[pE]` (post-
   * port, that field stores the current slot index). The walk starts at
   * `_colHead[col]` so any element above pE that would otherwise mask it is
   * naturally skipped via the `_elRow[e] < step` filter.
   */
  private _findBiggestInColExclude(pE: number, step: number): number {
    const row = this._elRow[pE];
    const col = this._elCol[pE];
    let e = this._colHead[col];

    /* Travel down column until reduced submatrix is entered. */
    while (e >= 0 && this._elRow[e] < step) {
      e = this._elNextInCol[e];
    }

    /* Initialize the variable Largest. */
    let largest: number;
    if (e >= 0 && this._elRow[e] !== row) {
      largest = Math.abs(this._elVal[e]);
    } else {
      largest = 0.0;
    }

    /* Search rest of column for largest element, avoiding excluded element. */
    while (e >= 0) {
      e = this._elNextInCol[e];
      if (e < 0) break;
      const magnitude = Math.abs(this._elVal[e]);
      if (magnitude > largest && this._elRow[e] !== row) {
        largest = magnitude;
      }
    }

    return largest;
  }

  // ngspice spconfig.h.
  private static readonly MAX_MARKOWITZ_TIES = 100;
  private static readonly TIES_MULTIPLIER = 5;
  private static readonly LARGEST_LONG_INTEGER = 0x7fffffff;
  private static readonly LARGEST_SHORT_INTEGER = 32767;

  /**
   * ngspice CountMarkowitz spfactor.c:783-826. RHS-aware count
   * increment at :803-808: rows whose RHS entry is non-zero
   * contribute one MORE to the active-submatrix Markowitz weight
   * (making them less attractive as early pivots, since elimination
   * would alter the RHS more). Indexed via IntToExtRowMap because
   * RHS itself is not permuted by row exchanges.
   */
  private _countMarkowitz(step: number, rhs: Float64Array | null): void {
    const n = this._n;
    const mRow = this._markowitzRow;
    const mCol = this._markowitzCol;

    /* Generate MarkowitzRow Count for each row. */
    for (let i = step; i < n; i++) {
      let count = -1;
      let e = this._rowHead[i];
      while (e >= 0 && this._elCol[e] < step) e = this._elNextInRow[e];
      while (e >= 0) {
        count++;
        e = this._elNextInRow[e];
      }
      const extRow = this._intToExtRow[i];
      if (rhs && rhs[extRow] !== 0) {
        count += 1;
      }
      mRow[i] = count;
    }

    /* Generate MarkowitzCol count for each column. */
    for (let i = step; i < n; i++) {
      let count = -1;
      let e = this._colHead[i];
      while (e >= 0 && this._elRow[e] < step) e = this._elNextInCol[e];
      while (e >= 0) {
        count++;
        e = this._elNextInCol[e];
      }
      mCol[i] = count;
    }
  }

  /**
   * ngspice MarkowitzProducts (spfactor.c:866-896) — line-for-line port.
   * Compute MarkowitzProd[i] = MarkowitzRow[i] * MarkowitzCol[i] for slot i in
   * [step, n) and tally Singletons (slots with product 0). Promotes to double
   * when factors threaten LARGEST_SHORT_INTEGER overflow, exactly mirroring
   * ngspice's behaviour even though our matrices fit comfortably.
   */
  private _markowitzProducts(step: number): void {
    const n = this._n;
    this._singletons = 0;
    for (let i = step; i < n; i++) {
      const r = this._markowitzRow[i];
      const c = this._markowitzCol[i];
      if ((r > SparseSolver.LARGEST_SHORT_INTEGER && c !== 0) ||
          (c > SparseSolver.LARGEST_SHORT_INTEGER && r !== 0)) {
        const fp = r * c; // double-precision multiply
        this._markowitzProd[i] =
          fp >= SparseSolver.LARGEST_LONG_INTEGER ? SparseSolver.LARGEST_LONG_INTEGER : fp | 0;
      } else {
        const product = r * c;
        this._markowitzProd[i] = product;
        if (product === 0) this._singletons++;
      }
    }
  }

  /**
   * ngspice SearchForPivot (spfactor.c:947-994) — dispatch. Returns the pool
   * element handle of the chosen pivot, or -1 if no acceptable pivot exists
   * (matrix is singular at this step).
   *
   * Uses 0-based step; routine bodies write the canonical 1-based ngspice
   * names but interpret indices in our 0-based slot space.
   */
  private _searchForPivot(step: number): number {
    let chosen: number;
    if (this._singletons > 0) {
      chosen = this._searchForSingleton(step);
      if (chosen >= 0) return chosen;
    }
    // DIAGONAL_PIVOTING is on by default in spconfig.h.
    chosen = this._quicklySearchDiagonal(step);
    if (chosen >= 0) return chosen;
    chosen = this._searchDiagonal(step);
    if (chosen >= 0) return chosen;
    return this._searchEntireMatrix(step);
  }

  /**
   * ngspice SearchForSingleton (spfactor.c:1041-1172) — line-for-line port.
   * The two-level pointer scan over MarkowitzProd is preserved including the
   * dual-purpose `mProd[n] = mProd[step]` slot, the `Singletons--; ...
   * Singletons++` speculation pattern, and the inverted-condition bug at
   * spfactor.c:1116/1132/1150 (preserved for bit-exact pivot parity — see the
   * sub-agent investigation; ngspice silently skips off-diagonal singletons,
   * deferring to diagonal search).
   *
   * Bound-safety: typed-array out-of-bounds reads return undefined → NaN, so
   * each `_elVal[chosen]` read where `chosen === -1` produces NaN; the
   * subsequent magnitude tests fail silently — same effective behaviour as
   * ngspice's UB dereference on circuits that exercise the bug.
   */
  private _searchForSingleton(step: number): number {
    const n = this._n;
    const mProd = this._markowitzProd;

    // Initialize the pointer to scan through MarkowitzProduct.
    // ngspice: pMarkowitzProduct = &MarkowitzProd[Size+1]; in our 0-based
    // world Size+1 maps to index n (since Size = n - 1).
    let p = n;
    mProd[n] = mProd[step];

    // Decrement count of available singletons on the assumption that an
    // acceptable one will be found.
    let singletons = this._singletons;
    this._singletons--;

    // Termination guard: ngspice writes mProd[Step-1] = 0. When step == 0
    // there is no slot at -1; the inner while still terminates because we
    // bound the read at `p < 0 ? 0 : mProd[p]` (acts as implicit sentinel).
    if (step >= 1) mProd[step - 1] = 0;

    while (singletons-- > 0) {
      // Inner while: walk down MarkowitzProd until a zero is found.
      // Mirrors ngspice's `while (*pMarkowitzProduct--) {}` post-decrement.
      let v: number;
      do {
        v = (p >= 0) ? mProd[p] : 0;
        p--;
      } while (v !== 0);

      let i = p + 1;

      // Assure that I is valid.
      if (i < step) break;
      if (i > n - 1) i = step;

      // Singleton has been found in either/both row or/and column I.
      const diagE = this._diag[i];
      if (diagE >= 0) {
        // Singleton lies on the diagonal.
        const pivotMag = Math.abs(this._elVal[diagE]);
        if (pivotMag > this._absThreshold &&
            pivotMag > this._relThreshold * this._findBiggestInColExclude(diagE, step)) {
          return diagE;
        }
      } else {
        // Singleton does not lie on diagonal, find it.
        if (this._markowitzCol[i] === 0) {
          let chosen = this._colHead[i];
          while (chosen >= 0 && this._elRow[chosen] < step) chosen = this._elNextInCol[chosen];
          if (chosen >= 0) {
            // ngspice spfactor.c:1116 inverted-condition bug — break exits
            // the outer singleton scan whenever a candidate IS found.
            // Comment claims "no elements, matrix is singular" but condition
            // is reversed. Preserved for bit-exact ngspice parity.
            break;
          }
          const pivotMag = chosen >= 0 ? Math.abs(this._elVal[chosen]) : 0;
          if (pivotMag > this._absThreshold &&
              pivotMag > this._relThreshold * this._findBiggestInColExclude(chosen, step)) {
            return chosen;
          } else {
            if (this._markowitzRow[i] === 0) {
              let chosen2 = this._rowHead[i];
              while (chosen2 >= 0 && this._elCol[chosen2] < step) chosen2 = this._elNextInRow[chosen2];
              if (chosen2 >= 0) {
                // spfactor.c:1132 — same inverted-condition bug.
                break;
              }
              const pivotMag2 = chosen2 >= 0 ? Math.abs(this._elVal[chosen2]) : 0;
              if (pivotMag2 > this._absThreshold &&
                  pivotMag2 > this._relThreshold * this._findBiggestInColExclude(chosen2, step)) {
                return chosen2;
              }
            }
          }
        } else {
          let chosen = this._rowHead[i];
          while (chosen >= 0 && this._elCol[chosen] < step) chosen = this._elNextInRow[chosen];
          if (chosen >= 0) {
            // spfactor.c:1150 — same inverted-condition bug.
            break;
          }
          const pivotMag = chosen >= 0 ? Math.abs(this._elVal[chosen]) : 0;
          if (pivotMag > this._absThreshold &&
              pivotMag > this._relThreshold * this._findBiggestInColExclude(chosen, step)) {
            return chosen;
          }
        }
      }
      /* Singleton not acceptable (too small), try another. */
    }

    // All singletons unacceptable — restore Singletons count.
    this._singletons++;
    return -1;
  }

  /**
   * ngspice QuicklySearchDiagonal — MODIFIED_MARKOWITZ branch (spfactor.c:
   * 1255-1383) — line-for-line port. Selects the diagonal element with the
   * smallest MarkowitzProduct, with early-exit on the symmetric-off-diagonal
   * case at MarkowitzProduct == 1, MAX_MARKOWITZ_TIES tie cap, and final
   * tie-break on Magnitude/LargestInCol ratio.
   */
  private _quicklySearchDiagonal(step: number): number {
    const n = this._n;
    const mProd = this._markowitzProd;
    let numberOfTies = -1;
    let minMarkowitzProduct = SparseSolver.LARGEST_LONG_INTEGER;
    // pMarkowitzProduct = &MarkowitzProd[Size+2]; our index n+1.
    let p = n + 1;
    mProd[n] = mProd[step];

    // Termination guard: mProd[step-1] = -1.
    if (step >= 1) mProd[step - 1] = -1;

    const tied: number[] = new Array(SparseSolver.MAX_MARKOWITZ_TIES + 1);

    /* Endless for loop. */
    for (;;) {
      // ngspice: while (MinMarkowitzProduct < *(--pMarkowitzProduct)) {}
      // Pre-decrement, then test: keeps walking while the (just-decremented)
      // slot's product is strictly greater than the current minimum.
      let v: number;
      do {
        p--;
        v = (p >= 0) ? mProd[p] : -1;
      } while (minMarkowitzProduct < v);

      let i = p;

      // Assure that I is valid; if I < Step, terminate search.
      if (i < step) break;
      if (i > n - 1) i = step;

      const pDiag = this._diag[i];
      if (pDiag < 0) continue;
      const magnitude = Math.abs(this._elVal[pDiag]);
      if (magnitude <= this._absThreshold) continue;

      if (mProd[p] === 1) {
        /* Only one element exists in row and column other than diagonal. */
        let pOtherInRow = this._elNextInRow[pDiag];
        let pOtherInCol = this._elNextInCol[pDiag];
        if (pOtherInRow < 0 && pOtherInCol < 0) {
          pOtherInRow = this._rowHead[i];
          while (pOtherInRow >= 0) {
            const c = this._elCol[pOtherInRow];
            if (c >= step && c !== i) break;
            pOtherInRow = this._elNextInRow[pOtherInRow];
          }
          pOtherInCol = this._colHead[i];
          while (pOtherInCol >= 0) {
            const r = this._elRow[pOtherInCol];
            if (r >= step && r !== i) break;
            pOtherInCol = this._elNextInCol[pOtherInCol];
          }
        }

        // Accept diagonal if larger than off-diagonals AND off-diagonals
        // placed symmetrically.
        if (pOtherInRow >= 0 && pOtherInCol >= 0) {
          if (this._elCol[pOtherInRow] === this._elRow[pOtherInCol]) {
            const largestOffDiagonal = Math.max(
              Math.abs(this._elVal[pOtherInRow]),
              Math.abs(this._elVal[pOtherInCol]),
            );
            if (magnitude >= largestOffDiagonal) {
              return pDiag;
            }
          }
        }
      }

      if (mProd[p] < minMarkowitzProduct) {
        // Strict inequality — new smallest MarkowitzProduct.
        tied[0] = pDiag;
        minMarkowitzProduct = mProd[p];
        numberOfTies = 0;
      } else {
        // Markowitz tie.
        if (numberOfTies < SparseSolver.MAX_MARKOWITZ_TIES) {
          tied[++numberOfTies] = pDiag;
          if (numberOfTies >= minMarkowitzProduct * SparseSolver.TIES_MULTIPLIER) break;
        }
      }
    }

    if (numberOfTies < 0) return -1;

    // Determine which tied element is best numerically.
    let chosen = -1;
    let maxRatio = 1.0 / this._relThreshold;
    for (let j = 0; j <= numberOfTies; j++) {
      const pDiag = tied[j];
      const magnitude = Math.abs(this._elVal[pDiag]);
      const largestInCol = this._findBiggestInColExclude(pDiag, step);
      const ratio = largestInCol / magnitude;
      if (ratio < maxRatio) {
        chosen = pDiag;
        maxRatio = ratio;
      }
    }
    return chosen;
  }

  /**
   * ngspice SearchDiagonal (spfactor.c:1604-1663) — line-for-line port.
   */
  private _searchDiagonal(step: number): number {
    const n = this._n;
    const size = n - 1;
    const mProd = this._markowitzProd;
    let chosen = -1;
    let minMarkowitzProduct = SparseSolver.LARGEST_LONG_INTEGER;
    let ratioOfAccepted = 0;
    let numberOfTies = 0;
    // pMarkowitzProduct = &MarkowitzProd[Size+2]; index n+1.
    let p = n + 1;
    mProd[n] = mProd[step];

    /* for (J = Size+1; J > Step; J--) — our 0-based: J from n down to step+1. */
    for (let j = n; j > step; j--) {
      p--;
      if (p < 0) break;
      if (mProd[p] > minMarkowitzProduct) continue;
      let i: number;
      if (j > size) i = step; else i = j;
      const pDiag = this._diag[i];
      if (pDiag < 0) continue;
      const magnitude = Math.abs(this._elVal[pDiag]);
      if (magnitude <= this._absThreshold) continue;

      // Test diagonal magnitude acceptable.
      const largestInCol = this._findBiggestInColExclude(pDiag, step);
      if (magnitude <= this._relThreshold * largestInCol) continue;

      if (mProd[p] < minMarkowitzProduct) {
        chosen = pDiag;
        minMarkowitzProduct = mProd[p];
        ratioOfAccepted = largestInCol / magnitude;
        numberOfTies = 0;
      } else {
        // Markowitz tie.
        numberOfTies++;
        const ratio = largestInCol / magnitude;
        if (ratio < ratioOfAccepted) {
          chosen = pDiag;
          ratioOfAccepted = ratio;
        }
        if (numberOfTies >= minMarkowitzProduct * SparseSolver.TIES_MULTIPLIER) return chosen;
      }
    }
    return chosen;
  }

  /**
   * ngspice SearchEntireMatrix (spfactor.c:1730-1809) — line-for-line port.
   * Last-resort search across every column in [step, n). Records the largest-
   * magnitude element pre-emptively so the spSMALL_PIVOT fallback returns it
   * when no acceptable pivot meets RelThreshold * LargestInCol.
   */
  private _searchEntireMatrix(step: number): number {
    const n = this._n;
    let chosen = -1;
    let pLargestElement = -1;
    let largestElementMag = 0;
    let minMarkowitzProduct = SparseSolver.LARGEST_LONG_INTEGER;
    let ratioOfAccepted = 0;
    let numberOfTies = 0;
    const mRow = this._markowitzRow;
    const mCol = this._markowitzCol;

    for (let i = step; i < n; i++) {
      let pElement = this._colHead[i];
      while (pElement >= 0 && this._elRow[pElement] < step) pElement = this._elNextInCol[pElement];

      const largestInCol = this._findLargestInCol(pElement);
      if (largestInCol === 0) continue;

      while (pElement >= 0) {
        const magnitude = Math.abs(this._elVal[pElement]);
        if (magnitude > largestElementMag) {
          largestElementMag = magnitude;
          pLargestElement = pElement;
        }
        const product = mRow[this._elRow[pElement]] * mCol[this._elCol[pElement]];
        if (product <= minMarkowitzProduct &&
            magnitude > this._relThreshold * largestInCol &&
            magnitude > this._absThreshold) {
          if (product < minMarkowitzProduct) {
            chosen = pElement;
            minMarkowitzProduct = product;
            ratioOfAccepted = largestInCol / magnitude;
            numberOfTies = 0;
          } else {
            numberOfTies++;
            const ratio = largestInCol / magnitude;
            if (ratio < ratioOfAccepted) {
              chosen = pElement;
              ratioOfAccepted = ratio;
            }
            if (numberOfTies >= minMarkowitzProduct * SparseSolver.TIES_MULTIPLIER) return chosen;
          }
        }
        pElement = this._elNextInCol[pElement];
      }
    }

    if (chosen >= 0) return chosen;
    // ngspice returns spSINGULAR vs spSMALL_PIVOT distinguishably; we fold
    // both into the chosen-or-largest decision. spSINGULAR maps to -1; the
    // spSMALL_PIVOT fallback returns pLargestElement.
    if (largestElementMag === 0) return -1;
    return pLargestElement;
  }

  // =========================================================================
  // Row/column physical exchange — ngspice spcRowExchange / spcColExchange
  // =========================================================================
  //
  // These maintain the ngspice invariant that, at every step `Step`, the
  // chosen pivot has been physically moved to slot (Step, Step) in the linked
  // structure. After exchange:
  //   * `_elRow[pivotE] === step` and `_elCol[pivotE] === step`
  //   * `_intToExtRow[step]` is the original row of the chosen pivot
  //   * `_diag[step]` points at the pivot
  //
  // `_exchangeColElements` is a line-for-line port of ngspice
  // `ExchangeColElements` (spfactor.c:2302-2385); `_exchangeRowElements`
  // ports `ExchangeRowElements` (spfactor.c:2431-2514). Every C
  // `*ElementAboveRow = X` pointer-to-pointer assignment is expanded into
  // `_setColLink(prev, X, column)` (and the row-side mirror) so that the
  // doubly-linked back-pointers `_elPrevInCol[X]` / `_elPrevInRow[X]`
  // stay consistent with the singly-linked NextIn{Col,Row} updates.
  // Control flow and chain ordering are identical to ngspice.

  /**
   * ngspice spcRowExchange (spfactor.c:2110-2164) — physical row swap.
   */
  private _spcRowExchange(row1Arg: number, row2Arg: number): void {
    let row1 = row1Arg, row2 = row2Arg;
    if (row1 > row2) { const t = row1; row1 = row2; row2 = t; }

    // Walk both rows in lockstep, exchanging per-column elements.
    let p1 = this._rowHead[row1];
    let p2 = this._rowHead[row2];
    while (p1 >= 0 || p2 >= 0) {
      let column: number;
      let element1: number;
      let element2: number;
      if (p1 < 0) {
        column = this._elCol[p2];
        element1 = -1; element2 = p2;
        p2 = this._elNextInRow[p2];
      } else if (p2 < 0) {
        column = this._elCol[p1];
        element1 = p1; element2 = -1;
        p1 = this._elNextInRow[p1];
      } else if (this._elCol[p1] < this._elCol[p2]) {
        column = this._elCol[p1];
        element1 = p1; element2 = -1;
        p1 = this._elNextInRow[p1];
      } else if (this._elCol[p1] > this._elCol[p2]) {
        column = this._elCol[p2];
        element1 = -1; element2 = p2;
        p2 = this._elNextInRow[p2];
      } else {
        column = this._elCol[p1];
        element1 = p1; element2 = p2;
        p1 = this._elNextInRow[p1];
        p2 = this._elNextInRow[p2];
      }
      this._exchangeColElements(row1, element1, row2, element2, column);
    }

    // Swap row-keyed Markowitz count, row chain heads, and IntToExtRowMap.
    const mr = this._markowitzRow[row1];
    this._markowitzRow[row1] = this._markowitzRow[row2];
    this._markowitzRow[row2] = mr;
    const fr = this._rowHead[row1];
    this._rowHead[row1] = this._rowHead[row2];
    this._rowHead[row2] = fr;
    const ir = this._intToExtRow[row1];
    this._intToExtRow[row1] = this._intToExtRow[row2];
    this._intToExtRow[row2] = ir;
    this._extToIntRow[this._intToExtRow[row1]] = row1;
    this._extToIntRow[this._intToExtRow[row2]] = row2;
  }

  /**
   * ngspice spcColExchange (spfactor.c:2204-2258) — physical col swap.
   */
  private _spcColExchange(col1Arg: number, col2Arg: number): void {
    let col1 = col1Arg, col2 = col2Arg;
    if (col1 > col2) { const t = col1; col1 = col2; col2 = t; }

    // Walk both columns in lockstep, exchanging per-row elements.
    let p1 = this._colHead[col1];
    let p2 = this._colHead[col2];
    while (p1 >= 0 || p2 >= 0) {
      let row: number;
      let element1: number;
      let element2: number;
      if (p1 < 0) {
        row = this._elRow[p2];
        element1 = -1; element2 = p2;
        p2 = this._elNextInCol[p2];
      } else if (p2 < 0) {
        row = this._elRow[p1];
        element1 = p1; element2 = -1;
        p1 = this._elNextInCol[p1];
      } else if (this._elRow[p1] < this._elRow[p2]) {
        row = this._elRow[p1];
        element1 = p1; element2 = -1;
        p1 = this._elNextInCol[p1];
      } else if (this._elRow[p1] > this._elRow[p2]) {
        row = this._elRow[p2];
        element1 = -1; element2 = p2;
        p2 = this._elNextInCol[p2];
      } else {
        row = this._elRow[p1];
        element1 = p1; element2 = p2;
        p1 = this._elNextInCol[p1];
        p2 = this._elNextInCol[p2];
      }
      this._exchangeRowElements(col1, element1, col2, element2, row);
    }

    // Swap col-keyed Markowitz count, col chain heads, and IntToExtColMap.
    const mc = this._markowitzCol[col1];
    this._markowitzCol[col1] = this._markowitzCol[col2];
    this._markowitzCol[col2] = mc;
    const fc = this._colHead[col1];
    this._colHead[col1] = this._colHead[col2];
    this._colHead[col2] = fc;
    const ic = this._preorderColPerm[col1];
    this._preorderColPerm[col1] = this._preorderColPerm[col2];
    this._preorderColPerm[col2] = ic;
    this._extToIntCol[this._preorderColPerm[col1]] = col1;
    this._extToIntCol[this._preorderColPerm[col2]] = col2;
  }

  /**
   * Set the column-chain "above" link: prev → e in column `col`. Maintains
   * `_elPrevInCol[e]` consistency. ngspice uses pointer-to-pointer
   * `*ElementAboveRow = X`; we expand into doubly-linked link maintenance.
   */
  private _setColLink(prev: number, e: number, col: number): void {
    if (prev < 0) this._colHead[col] = e;
    else this._elNextInCol[prev] = e;
    if (e >= 0) this._elPrevInCol[e] = prev;
  }

  /**
   * Set the row-chain "left of" link: prev → e in row `row`. Maintains
   * `_elPrevInRow[e]` consistency.
   */
  private _setRowLink(prev: number, e: number, row: number): void {
    if (prev < 0) this._rowHead[row] = e;
    else this._elNextInRow[prev] = e;
    if (e >= 0) this._elPrevInRow[e] = prev;
  }

  /**
   * ngspice ExchangeColElements (spfactor.c:2302-2385) — line-for-line port.
   * Operates on a single column `column`, exchanging row-position row1 ↔ row2
   * for the supplied pool elements (either may be -1 == NULL).
   *
   * Doubly-linked adaptation: every `*ElementAboveRow = X` C pointer-to-pointer
   * assignment is replaced by `_setColLink(prev, X, column)` which maintains
   * both `_elNextInCol[prev]` and `_elPrevInCol[X]`. Every direct
   * `Element->NextInCol = Y` is paired with `_elPrevInCol[Y] = Element` for
   * the symmetric back-link. This is the adaptation explicitly called out in
   * spec/markowitz-pivoting-port.md §4.11 — control flow unchanged from
   * ngspice; only prev-pointer maintenance is added.
   */
  private _exchangeColElements(
    row1: number, e1: number, row2: number, e2: number, column: number,
  ): void {
    let elementAboveRow1: number;
    let elementAboveRow2: number;
    let elementBelowRow1: number;
    let elementBelowRow2: number;
    let pElement: number;

    /* Search to find the ElementAboveRow1. */
    elementAboveRow1 = -1;
    pElement = this._colHead[column];
    while (pElement >= 0 && this._elRow[pElement] < row1) {
      elementAboveRow1 = pElement;
      pElement = this._elNextInCol[pElement];
    }
    if (e1 >= 0) {
      elementBelowRow1 = this._elNextInCol[e1];
      if (e2 < 0) {
        /* Element2 does not exist, move Element1 down to Row2. */
        if (elementBelowRow1 >= 0 && this._elRow[elementBelowRow1] < row2) {
          /* Element1 must be removed from linked list and moved. */
          this._setColLink(elementAboveRow1, elementBelowRow1, column);

          /* Search column for Row2. */
          pElement = elementBelowRow1;
          elementAboveRow2 = -1;
          do {
            elementAboveRow2 = pElement;
            pElement = this._elNextInCol[pElement];
          } while (pElement >= 0 && this._elRow[pElement] < row2);

          /* Place Element1 in Row2. */
          this._setColLink(elementAboveRow2, e1, column);
          this._elNextInCol[e1] = pElement;
          if (pElement >= 0) this._elPrevInCol[pElement] = e1;
          /* Redundant in ngspice; preserved for line-for-line. */
          this._setColLink(elementAboveRow1, elementBelowRow1, column);
        }
        this._elRow[e1] = row2;
      } else {
        /* Element2 does exist, and the two elements must be exchanged. */
        if (this._elRow[elementBelowRow1] === row2) {
          /* Element2 is just below Element1, exchange them. */
          const e2Next = this._elNextInCol[e2];
          this._elNextInCol[e1] = e2Next;
          if (e2Next >= 0) this._elPrevInCol[e2Next] = e1;
          this._elNextInCol[e2] = e1;
          this._elPrevInCol[e1] = e2;
          this._setColLink(elementAboveRow1, e2, column);
        } else {
          /* Element2 is not just below Element1 and must be searched for. */
          pElement = elementBelowRow1;
          elementAboveRow2 = -1;
          do {
            elementAboveRow2 = pElement;
            pElement = this._elNextInCol[pElement];
          } while (pElement >= 0 && this._elRow[pElement] < row2);

          elementBelowRow2 = this._elNextInCol[e2];

          /* Switch Element1 and Element2. */
          this._setColLink(elementAboveRow1, e2, column);
          this._elNextInCol[e2] = elementBelowRow1;
          if (elementBelowRow1 >= 0) this._elPrevInCol[elementBelowRow1] = e2;
          this._setColLink(elementAboveRow2, e1, column);
          this._elNextInCol[e1] = elementBelowRow2;
          if (elementBelowRow2 >= 0) this._elPrevInCol[elementBelowRow2] = e1;
        }
        this._elRow[e1] = row2;
        this._elRow[e2] = row1;
      }
    } else {
      /* Element1 does not exist. */
      elementBelowRow1 = pElement;
      elementAboveRow2 = -1;

      /* Find Element2. */
      if (this._elRow[elementBelowRow1] !== row2) {
        do {
          elementAboveRow2 = pElement;
          pElement = this._elNextInCol[pElement];
        } while (pElement >= 0 && this._elRow[pElement] < row2);

        elementBelowRow2 = this._elNextInCol[e2];

        /* Move Element2 to Row1. */
        this._setColLink(elementAboveRow2, elementBelowRow2, column);
        this._setColLink(elementAboveRow1, e2, column);
        this._elNextInCol[e2] = elementBelowRow1;
        if (elementBelowRow1 >= 0) this._elPrevInCol[elementBelowRow1] = e2;
      }
      this._elRow[e2] = row1;
    }
  }

  /**
   * ngspice ExchangeRowElements (spfactor.c:2431-2514) — line-for-line port.
   * Symmetric mirror of `_exchangeColElements` operating on a single row.
   * Doubly-linked adaptation matches the column-side rationale above.
   */
  private _exchangeRowElements(
    col1: number, e1: number, col2: number, e2: number, row: number,
  ): void {
    let elementLeftOfCol1: number;
    let elementLeftOfCol2: number;
    let elementRightOfCol1: number;
    let elementRightOfCol2: number;
    let pElement: number;

    /* Search to find the ElementLeftOfCol1. */
    elementLeftOfCol1 = -1;
    pElement = this._rowHead[row];
    while (pElement >= 0 && this._elCol[pElement] < col1) {
      elementLeftOfCol1 = pElement;
      pElement = this._elNextInRow[pElement];
    }
    if (e1 >= 0) {
      elementRightOfCol1 = this._elNextInRow[e1];
      if (e2 < 0) {
        /* Element2 does not exist, move Element1 to right to Col2. */
        if (elementRightOfCol1 >= 0 && this._elCol[elementRightOfCol1] < col2) {
          /* Element1 must be removed from linked list and moved. */
          this._setRowLink(elementLeftOfCol1, elementRightOfCol1, row);

          /* Search Row for Col2. */
          pElement = elementRightOfCol1;
          elementLeftOfCol2 = -1;
          do {
            elementLeftOfCol2 = pElement;
            pElement = this._elNextInRow[pElement];
          } while (pElement >= 0 && this._elCol[pElement] < col2);

          /* Place Element1 in Col2. */
          this._setRowLink(elementLeftOfCol2, e1, row);
          this._elNextInRow[e1] = pElement;
          if (pElement >= 0) this._elPrevInRow[pElement] = e1;
          /* Redundant in ngspice; preserved for line-for-line. */
          this._setRowLink(elementLeftOfCol1, elementRightOfCol1, row);
        }
        this._elCol[e1] = col2;
      } else {
        /* Element2 does exist, and the two elements must be exchanged. */
        if (this._elCol[elementRightOfCol1] === col2) {
          /* Element2 is just right of Element1, exchange them. */
          const e2Right = this._elNextInRow[e2];
          this._elNextInRow[e1] = e2Right;
          if (e2Right >= 0) this._elPrevInRow[e2Right] = e1;
          this._elNextInRow[e2] = e1;
          this._elPrevInRow[e1] = e2;
          this._setRowLink(elementLeftOfCol1, e2, row);
        } else {
          /* Element2 is not just right of Element1 and must be searched for. */
          pElement = elementRightOfCol1;
          elementLeftOfCol2 = -1;
          do {
            elementLeftOfCol2 = pElement;
            pElement = this._elNextInRow[pElement];
          } while (pElement >= 0 && this._elCol[pElement] < col2);

          elementRightOfCol2 = this._elNextInRow[e2];

          /* Switch Element1 and Element2. */
          this._setRowLink(elementLeftOfCol1, e2, row);
          this._elNextInRow[e2] = elementRightOfCol1;
          if (elementRightOfCol1 >= 0) this._elPrevInRow[elementRightOfCol1] = e2;
          this._setRowLink(elementLeftOfCol2, e1, row);
          this._elNextInRow[e1] = elementRightOfCol2;
          if (elementRightOfCol2 >= 0) this._elPrevInRow[elementRightOfCol2] = e1;
        }
        this._elCol[e1] = col2;
        this._elCol[e2] = col1;
      }
    } else {
      /* Element1 does not exist. */
      elementRightOfCol1 = pElement;
      elementLeftOfCol2 = -1;

      /* Find Element2. */
      if (this._elCol[elementRightOfCol1] !== col2) {
        do {
          elementLeftOfCol2 = pElement;
          pElement = this._elNextInRow[pElement];
        } while (pElement >= 0 && this._elCol[pElement] < col2);

        elementRightOfCol2 = this._elNextInRow[e2];

        /* Move Element2 to Col1. */
        this._setRowLink(elementLeftOfCol2, elementRightOfCol2, row);
        this._setRowLink(elementLeftOfCol1, e2, row);
        this._elNextInRow[e2] = elementRightOfCol1;
        if (elementRightOfCol1 >= 0) this._elPrevInRow[elementRightOfCol1] = e2;
      }
      this._elCol[e2] = col1;
    }
  }

  /**
   * ngspice ExchangeRowsAndCols (spfactor.c:1986-2070) — line-for-line port.
   * Brings pivotE to slot (step, step) by physical row + col swap. Updates
   * MarkowitzProd, Singletons, Diag, and our row/col permutation maps.
   */
  private _exchangeRowsAndCols(pivotE: number, step: number): void {
    const row = this._elRow[pivotE];
    const col = this._elCol[pivotE];

    if (row === step && col === step) {
      // Already at slot (step, step). Still record the pivot identity for solve().
      this._q[step] = this._intToExtRow[step];
      this._pinv[this._intToExtRow[step]] = step;
      return;
    }

    if (row === col) {
      this._spcRowExchange(step, row);
      this._spcColExchange(step, col);
      // Swap MarkowitzProd[step] ↔ MarkowitzProd[row] and Diag[row] ↔ Diag[step].
      // _singletons does NOT need adjustment: the swap permutes values between
      // two slots, so the global zero-count over the whole array is invariant.
      const mp = this._markowitzProd[step];
      this._markowitzProd[step] = this._markowitzProd[row];
      this._markowitzProd[row] = mp;
      const dr = this._diag[row];
      this._diag[row] = this._diag[step];
      this._diag[step] = dr;
    } else {
      const oldStep = this._markowitzProd[step];
      const oldRow = this._markowitzProd[row];
      const oldCol = this._markowitzProd[col];

      if (row !== step) {
        this._spcRowExchange(step, row);
        this._markowitzProd[row] = this._markowitzRow[row] * this._markowitzCol[row];
        if ((this._markowitzProd[row] === 0) !== (oldRow === 0)) {
          if (oldRow === 0) this._singletons--;
          else this._singletons++;
        }
      }

      if (col !== step) {
        this._spcColExchange(step, col);
        this._markowitzProd[col] = this._markowitzCol[col] * this._markowitzRow[col];
        if ((this._markowitzProd[col] === 0) !== (oldCol === 0)) {
          if (oldCol === 0) this._singletons--;
          else this._singletons++;
        }
        this._diag[col] = this._findDiagOnColumn(col);
      }
      if (row !== step) {
        this._diag[row] = this._findDiagOnColumn(row);
      }
      this._diag[step] = this._findDiagOnColumn(step);

      this._markowitzProd[step] = this._markowitzCol[step] * this._markowitzRow[step];
      if ((this._markowitzProd[step] === 0) !== (oldStep === 0)) {
        if (oldStep === 0) this._singletons--;
        else this._singletons++;
      }
    }

    // Record this step's pivot identity for solve() and downstream consumers.
    // q[k] = original row chosen at step k; pinv[origRow] = step.
    this._q[step] = this._intToExtRow[step];
    this._pinv[this._intToExtRow[step]] = step;
  }

  /**
   * ngspice UpdateMarkowitzNumbers (spfactor.c:2713-2760) — line-for-line port.
   * Walks the just-pivoted column and row chains (post-exchange, pivotE is at
   * slot (step, step)), decrementing Markowitz row/col counts for every off-
   * diagonal element and refreshing MarkowitzProd / Singletons.
   */
  private _updateMarkowitzNumbers(pivotE: number): void {
    const mRow = this._markowitzRow;
    const mCol = this._markowitzCol;
    const mProd = this._markowitzProd;

    // Walk pivot COLUMN below the diagonal — each contributing row loses a
    // column-entry once the pivot row is eliminated.
    for (let p = this._elNextInCol[pivotE]; p >= 0; p = this._elNextInCol[p]) {
      const row = this._elRow[p];
      mRow[row]--;
      if ((mRow[row] > SparseSolver.LARGEST_SHORT_INTEGER && mCol[row] !== 0) ||
          (mCol[row] > SparseSolver.LARGEST_SHORT_INTEGER && mRow[row] !== 0)) {
        const product = mCol[row] * mRow[row];
        mProd[row] = product >= SparseSolver.LARGEST_LONG_INTEGER
          ? SparseSolver.LARGEST_LONG_INTEGER
          : product | 0;
      } else {
        mProd[row] = mRow[row] * mCol[row];
      }
      if (mRow[row] === 0) this._singletons++;
    }

    // Walk pivot ROW right of the diagonal — each contributing column loses a
    // row-entry.
    for (let p = this._elNextInRow[pivotE]; p >= 0; p = this._elNextInRow[p]) {
      const col = this._elCol[p];
      mCol[col]--;
      if ((mRow[col] > SparseSolver.LARGEST_SHORT_INTEGER && mCol[col] !== 0) ||
          (mCol[col] > SparseSolver.LARGEST_SHORT_INTEGER && mRow[col] !== 0)) {
        const product = mCol[col] * mRow[col];
        mProd[col] = product >= SparseSolver.LARGEST_LONG_INTEGER
          ? SparseSolver.LARGEST_LONG_INTEGER
          : product | 0;
      } else {
        mProd[col] = mRow[col] * mCol[col];
      }
      // ngspice spfactor.c:2756 only counts a singleton when MarkoCol == 0
      // AND MarkoRow != 0 (avoid double-counting the row half above).
      if (mCol[col] === 0 && mRow[col] !== 0) this._singletons++;
    }
  }

  // =========================================================================
  // Internal: apply diagonal gmin
  // =========================================================================

  /**
   * Add gmin to every diagonal element — mechanical port of ngspice LoadGmin
   * (spsmp.c:422-440). Private in ngspice (`static` on spsmp.c:109), private
   * here too: external code must not stamp gmin outside the factor routine.
   *
   * Called only from factorWithReorder (ngspice SMPreorder body, spsmp.c:197)
   * and factorNumerical (ngspice SMPluFac body, spsmp.c:173). This preserves
   * the ngspice invariant that `LoadGmin(m,g) ; spFactor(m)` is an atomic
   * unit — no caller observes a post-gmin pre-factor matrix state.
   *
   * Intentionally does NOT set _needsReorder: the stamp is consumed by the
   * same factor call, never persisting beyond it.
   */
  private _applyDiagGmin(gmin: number): void {
    // ngspice spsmp.c:432-437 LoadGmin — gates the work on Gmin != 0 (entry guard)
    // and walks diagonals reverse: `for (I = Matrix->Size; I > 0; I--)`.
    if (gmin !== 0) {
      const diag = this._diag;
      const elVal = this._elVal;
      for (let i = this._n - 1; i >= 0; i--) {
        const e = diag[i];
        if (e >= 0) elVal[e] += gmin;
      }
    }
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
