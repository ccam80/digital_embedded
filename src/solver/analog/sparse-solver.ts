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
 *
 * =========================================================================
 * Indexing convention (Stage 7 — option b: documented translation rule)
 * =========================================================================
 *
 * ngspice is 1-based throughout: arrays of length `Size + 1` with slot 0
 * unused, loops `for (Step = 1; Step <= Size; Step++)`. digiTS keeps a
 * uniform 0-based internal convention to match TypeScript-idiomatic typed
 * arrays and to keep the public-surface row/col arguments 0-based for
 * compatibility with caller MNA storage (§7.3.7).
 *
 * The mechanical translation rule applied uniformly across this file is:
 *
 *     digiTS slot/step k    <==>    ngspice Step = k + 1
 *     digiTS array length n <==>    ngspice array length Size + 1
 *     for (k = 0; k < n; k++) <==>  for (Step = 1; Step <= Size; Step++)
 *     for (k = n - 1; k >= 0; k--) <==>
 *                                   for (Step = Size; Step > 0; Step--)
 *     _diag[k] / _colHead[k] / _rowHead[k] / _intToExtRow[k] /
 *     _preorderColPerm[k] / _markowitz*[k]   read at internal slot k;
 *                                            same datum as ngspice's
 *                                            FirstInCol[k+1] etc.
 *
 * Sentinel slots (e.g. `_markowitzProd[Size + 1]` in ngspice's
 * QuicklySearchDiagonal scan — see spfactor.c) become `_markowitzProd[n]`
 * here, allocated as the (n+1)-th slot per the array sizing in
 * `_initStructure`.
 *
 * The public surface (`allocElement(row, col)`, `stampElement(handle, v)`,
 * `stampRHS(row, value)`, `solve(x)`) is 0-based, matching caller-side
 * MNA row/col numbering. The internal slot/step indexing follows the
 * rule above. Do NOT mix the two conventions inside one method.
 *
 * Per spec §7.5: option (a) (full 1-based conversion) was evaluated and
 * judged disruptive enough that the rollback signal already applied
 * (every loop in this 2500+-line file would change, with no test gate
 * available during the port). Option (b) is the strict-port-compatible
 * fallback; it preserves bit-exact factor/solve semantics by keeping the
 * mechanical rule uniform.
 */

// factor() returns the ngspice error code directly (one of spOKAY,
// spSMALL_PIVOT, spZERO_DIAG, spSINGULAR, spNO_MEMORY, spPANIC). Mirrors
// ngspice spOrderAndFactor / spFactor signature: `int (*)(MatrixPtr, ...)`.
// SingularRow/SingularCol read via whereSingular(); reorder-vs-reuse
// dispatch via the `reordered` getter (mirroring Matrix->Reordered).

// =========================================================================
// ngspice public error codes — spmatrix.h.
// =========================================================================
export const spOKAY = 0;
export const spSMALL_PIVOT = 2;
export const spZERO_DIAG = 3;
export const spSINGULAR = 4;
export const spMANGLED = 5;
export const spNO_MEMORY = 6;
export const spPANIC = 7;
export const spFATAL = spPANIC;

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

export class SparseSolver {
  // =========================================================================
  // Persistent linked-list element pool
  // =========================================================================
  // This is the primary matrix storage, persistent across _initStructure / _resetForAssembly / stamp cycles.
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
  /** Next element in same row (-1 = end). */
  private _elNextInRow: Int32Array = new Int32Array(0);
  /** Next element in same column (-1 = end). */
  private _elNextInCol: Int32Array = new Int32Array(0);

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
   * Used by _updateMarkowitzNumbers to translate the element's stored original
   * column into the internal column index that keys _colHead/_markowitzCol.
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

  /** Next free slot in element pool. */
  private _elCount: number = 0;
  /** Current pool capacity. */
  private _elCapacity: number = 0;

  // =========================================================================
  // ngspice MatrixFrame counters — spdefs.h:743, 749, 763.
  //   Matrix->Elements   → _elements   (total live elements; A + fillins)
  //   Matrix->Originals  → _originals  (A-matrix entries from spcCreateElement)
  //   Matrix->Fillins    → _fillins    (entries created by CreateFillin)
  // ngspice maintains the invariant Elements == Originals + Fillins
  // (spalloc.c:879 spOriginalCount returns Matrix->Originals; spalloc.c:885
  // spFillinCount returns Matrix->Fillins; spalloc.c:859 spElementCount
  // returns Matrix->Elements).
  // =========================================================================
  private _elements: number = 0;
  private _originals: number = 0;
  private _fillins: number = 0;

  // =========================================================================
  // RHS vector
  // =========================================================================
  private _rhs: Float64Array = new Float64Array(0);

  // =========================================================================
  // Dimension
  // =========================================================================
  private _n = 0;


  // =========================================================================
  // Scratch for solve
  // =========================================================================
  private _scratch: Float64Array = new Float64Array(0);

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
  //
  // NIDIDPREORDER lives in CKTniState (NI layer), not in MatrixFrame. The
  // gating decision belongs to the caller; the solver runs preorder()
  // unconditionally when invoked.
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
  // =========================================================================
  private _needsReorder: boolean = false;
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
  /**
   * ngspice MatrixFrame.InternalVectorsAllocated (spdefs.h:754). Gates the
   * deferred allocation of the Markowitz / Intermediate vectors inside
   * spcCreateInternalVectors (spfactor.c:706-747); flipped to TRUE after
   * the first allocation. Replaces the prior `_workspaceN` size proxy.
   */
  private _internalVectorsAllocated: boolean = false;

  /** ngspice Matrix->Partitioned (spdefs.h). */
  private _partitioned: boolean = false;
  /** ngspice Matrix->DoRealDirect (spdefs.h). Allocated by spcCreateInternalVectors. */
  private _doRealDirect: Int32Array = new Int32Array(0);

  /**
   * ngspice MatrixFrame.Reordered (spdefs.h:770). Set TRUE at
   * spfactor.c:280 inside spOrderAndFactor when the reorder loop
   * completes. Read by the NR layer (niiter.c:888-891) to dispatch
   * NISHOULDREORDER recovery: a numerical-singular factor with
   * Reordered already TRUE means the next attempt cannot improve by
   * reordering.
   */
  private _reordered: boolean = false;

  /**
   * Per-call signal — true iff the most recent factor() call entered the
   * reorder body of `_spOrderAndFactor` (spfactor.c:240+). Reset to false
   * at every factor() entry, set true the moment the reorder loop body is
   * about to run.
   *
   * ngspice's NR layer distinguishes "this call walked reorder" from "this
   * call took the reuse path" structurally — `if (NISHOULDREORDER)` calls
   * `SMPreorder`, the else arm calls `SMPluFac` (niiter.c:861-902). digiTS
   * does the dispatch inside `factor()`, so the NR layer reads this flag
   * to mirror the `else` arm of niiter.c — only the SMPluFac path is
   * eligible for the spSINGULAR-driven NISHOULDREORDER retry.
   *
   * Distinct from `_reordered` (sticky `Matrix->Reordered`): that field
   * stays TRUE for the lifetime of the matrix once the reorder loop runs;
   * this field is per-call.
   */
  private _lastFactorWalkedReorder: boolean = false;

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

  // =========================================================================
  // ngspice MatrixFrame.Error / SingularRow / SingularCol — spdefs.h:744, 772-773.
  // Stage 6A introduces these as instance state. Writers are spClear,
  // _spFactor, _spOrderAndFactor, _matrixIsSingular, _zeroPivot.
  // Deferred consumer wiring (NR loop, dynamic-gmin ladder) — see Stage 6A.6.
  // =========================================================================
  private _error: number = spOKAY;
  private _singularRow: number = 0;
  private _singularCol: number = 0;

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
   * ngspice: spGetElement (spbuild.c:265-318) — returns a pointer used by
   * *ElementPtr += value. Translates the caller's original (row, col) into
   * the current slot space and dispatches to _spcFindElementInCol +
   * _spcCreateElement, mirroring the C two-call structure.
   *
   * O(column chain length) per call.
   */
  allocElement(row: number, col: number): number {
    // Guard: without _initStructure(), _extToIntCol is zero-length, so
    // _extToIntCol[col] → undefined, which Int32Array writes in
    // _insertIntoCol coerce to 0 — producing a self-referential cycle
    // in the column linked list that makes the next search spin forever.
    // Throw loudly instead.
    if (this._n === 0) {
      throw new Error(
        `SparseSolver.allocElement(${row}, ${col}) called before ` +
        `_initStructure(). Call solver._initStructure(matrixSize) first.`,
      );
    }
    // Translate the caller's original column to the current internal column
    // so the search walks the correct _colHead chain after preorder swaps.
    const internalCol = this._extToIntCol[col];
    return this._spcFindElementInCol(internalCol, row, /*createIfMissing=*/ true);
  }

  /**
   * ngspice spcFindElementInCol (spbuild.c:362-393) — line-for-line port.
   * Walks the column chain at `_colHead[col]` looking for an element at
   * (row, col). Returns the element index if found. If not found and
   * `createIfMissing` is true, dispatches to `_spcCreateElement` and returns
   * the new element. If not found and `createIfMissing` is false, returns -1.
   *
   * The column chain is sorted ascending by row; the search stops at the
   * first element whose row is >= the target row.
   */
  private _spcFindElementInCol(col: number, row: number, createIfMissing: boolean): number {
    let prev = -1;
    let e = this._colHead[col];
    while (e >= 0 && this._elRow[e] < row) {
      prev = e;
      e = this._elNextInCol[e];
    }
    if (e >= 0 && this._elRow[e] === row) return e;
    if (!createIfMissing) return -1;
    return this._spcCreateElement(row, col, prev, /*fillin=*/ false);
  }

  /**
   * ngspice spcCreateElement (spbuild.c:768-871) — line-for-line port.
   * Allocates a new element from the pool and splices it into the column
   * chain immediately after `prevInCol` (or at the head if `prevInCol < 0`),
   * and into the row chain when `_rowsLinked` is true. Sets `_diag[col]`
   * when row == col (centralised in `_newElement`, mirroring spbuild.c:793
   * (RowsLinked) and spbuild.c:851 (unlinked) — single sink). Sets
   * `_needsReorder = true` for non-fill-in elements per spbuild.c:788.
   *
   * Variable map (ngspice → digiTS):
   *   Matrix->FirstInCol[Col]  → _colHead[col]
   *   Matrix->FirstInRow[Row]  → _rowHead[row]
   *   Matrix->Diag[Row]        → _diag[col]    (Row == Col)
   *   pElement->NextInCol      → _elNextInCol[e]
   *   pElement->NextInRow      → _elNextInRow[e]
   *   pElement->Row            → _elRow[e]
   *   pElement->Col            → _elCol[e]
   */
  private _spcCreateElement(
    row: number, col: number, prevInCol: number, fillin: boolean,
  ): number {
    const newE = this._newElement(row, col, 0, 0);
    // Splice into column chain at prevInCol. _newElement initialised
    // _elNextInCol[newE] = -1; we set it to whatever was after prevInCol.
    if (prevInCol < 0) {
      this._elNextInCol[newE] = this._colHead[col];
      this._colHead[col] = newE;
    } else {
      this._elNextInCol[newE] = this._elNextInCol[prevInCol];
      this._elNextInCol[prevInCol] = newE;
    }
    // ngspice spcCreateElement (spbuild.c:776) — row insert only when
    // RowsLinked == YES. During assembly and preorder, row chains do not
    // exist; spcLinkRows builds them lazily on first factor entry.
    if (this._rowsLinked) this._insertIntoRow(newE, row);
    // ngspice counter writes (spbuild.c:782 fillin, 787 originals (linked
    // branch), 847 originals (unlinked branch), 870 elements). Mirror them
    // here so _elements == _originals + _fillins is invariant.
    if (fillin) {
      this._fillins++;
    } else {
      this._originals++;
      // ngspice spbuild.c:788 — every non-fill-in element forces reorder.
      this._needsReorder = true;
    }
    this._elements++;
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
   * ngspice SMPluFac (spsmp.c:168-175) — line-for-line port:
   *
   *     int SMPluFac(SMPmatrix *Matrix, double PivTol, double Gmin) {
   *         LoadGmin(Matrix, Gmin);
   *         return spFactor(Matrix);
   *     }
   *
   * The reorder-vs-reuse dispatch is NOT here — it lives inside `spFactor`
   * at `spfactor.c:333-335` which forwards to `spOrderAndFactor` when
   * `Matrix->NeedsOrdering` is set. Returns the ngspice error code
   * (spOKAY, spSMALL_PIVOT, spZERO_DIAG, spSINGULAR, spNO_MEMORY, spPANIC).
   *
   * Callers read `whereSingular()` for `(SingularRow, SingularCol)` and
   * the `reordered` getter (mirroring `Matrix->Reordered`) for the
   * NISHOULDREORDER recovery dispatch (niiter.c:888-891).
   */
  factor(diagGmin?: number): number {
    if (diagGmin) this._applyDiagGmin(diagGmin);
    // niiter.c:888-891 NR-side gate — reset before each call so the NR
    // layer can distinguish reorder-path failures (no retry) from
    // reuse-path failures (eligible for spSINGULAR retry).
    this._lastFactorWalkedReorder = false;
    return this._spFactor();
  }

  /**
   * ngspice MatrixFrame.Reordered (spdefs.h:770) — true iff the most
   * recent factor pass walked the reorder loop in `_spOrderAndFactor`.
   * Sticky once set; mirrors `Matrix->Reordered` lifetime.
   */
  get reordered(): boolean {
    return this._reordered;
  }

  /**
   * Per-call signal — true iff the most recent factor() call entered the
   * reorder body of `_spOrderAndFactor`. Used by the NR loop to mirror
   * the `else` arm of `if (NISHOULDREORDER)` at niiter.c:881-902:
   *   `errorCode === spSINGULAR && !lastFactorWalkedReorder`
   * is the SMPluFac → spSINGULAR retry gate.
   */
  get lastFactorWalkedReorder(): boolean {
    return this._lastFactorWalkedReorder;
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
    // Stage 6B — ngspice spSolve (spsolve.c:127-191) has no `Size === 0`
    // early-exit. The function is asserted-VALID + asserted-FACTORED at
    // spsolve.c:137, both of which presuppose `Size >= 1`. Per
    // banned-pattern guard rule #1, the digiTS-only guard is removed; any
    // caller that invokes solve() on a zero-size matrix has its own bug.
    const n = this._n;
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
   * Wipe the persistent linked structure so the next _initStructure /
   * _resetForAssembly cycle rebuilds it from scratch. Mirrors ngspice
   * spStripMatrix (sputils.c:1106-1145)
   * field-by-field. Sets NeedsOrdering = YES at line 1112 so the next factor
   * uses the full reorder path; clears RowsLinked, Elements, Originals,
   * Fillins, and resets every chain head, every diag pointer, and the
   * element-list cursor.
   *
   * Not currently invoked from any production path — kept as a test helper
   * for fixture teardown AND as the canonical API for any future consumer
   * that needs to force a structural rebuild without destroying the solver
   * instance.
   *
   * Variable map (ngspice → digiTS):
   *   Matrix->RowsLinked   → _rowsLinked         (sputils.c:1111)
   *   Matrix->NeedsOrdering→ _needsReorder       (sputils.c:1112)
   *   Matrix->Elements     → _elements           (sputils.c:1113)
   *   Matrix->Fillins      → _fillins            (sputils.c:1114)
   *   ElementList cursor   → _elCount = 0        (sputils.c:1117-1133)
   *   FirstInRow/Col[I]    → _rowHead[i]/_colHead[i]  (sputils.c:1138-1142)
   *   Diag[I]              → _diag[i]            (sputils.c:1143)
   */
  /** ngspice spStripMatrix (sputils.c:1106-1145) — line-for-line port. */
  invalidateTopology(): void {
    // ngspice sputils.c:1110 — short-circuit when nothing to strip.
    if (this._elements === 0) return;
    // ngspice sputils.c:1111-1115.
    this._rowsLinked = false;
    this._needsReorder = true;
    this._elements = 0;
    this._originals = 0;
    this._fillins = 0;
    // ngspice sputils.c:1117-1133 — element-list cursor reset. Bucket A.5:
    // pool slot 0 stays as TrashCan; reusable pool starts at slot 1.
    this._elCount = 1;
    // ngspice sputils.c:1135-1144 — per-slot reset of chain heads and Diag.
    const n = this._n;
    for (let i = 0; i < n; i++) {
      this._rowHead[i] = -1;
      this._colHead[i] = -1;
      this._diag[i] = -1;
    }
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
    // ngspice spMNA_Preorder (sputils.c:177-230) runs unconditionally when
    // invoked; the NIDIDPREORDER gating decision lives in CKTniState (NI
    // layer), not in MatrixFrame. Caller-side responsibility per architect
    // B.37.

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
   * Also stamps each element's _elCol[e] = col (spbuild.c:923 `pElement->Col = Col`),
   * fixing up any stale column indices left by _swapColumns (which, per ngspice
   * SwapCols sputils.c:283-301, does not touch element fields).
   *
   * Singly-linked: head-insert, no prev-pointer maintenance — mirrors
   * spbuild.c:921-928.
   */
  /** ngspice spcLinkRows (spbuild.c:907-932) — line-for-line port. */
  private _linkRows(): void {
    for (let col = this._n - 1; col >= 0; col--) {
      let pElement = this._colHead[col];
      while (pElement >= 0) {
        // ngspice spbuild.c:923 — pElement->Col = Col (refresh after SwapCols).
        this._elCol[pElement] = col;
        const r = this._elRow[pElement];
        this._elNextInRow[pElement] = this._rowHead[r];
        this._rowHead[r] = pElement;
        pElement = this._elNextInCol[pElement];
      }
    }
    // ngspice spbuild.c:930.
    this._rowsLinked = true;
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
  // @instrumentation — Stage 8 prefix-marker fallback (spec §8.3 lines 965-967)
  // =========================================================================
  //
  // Every method/getter in the block below is **test-only** harness
  // instrumentation. Production code (anything outside `__tests__/` and the
  // ngspice comparison harness) MUST NOT call these. The long-term home is
  // `sparse-solver-instrumentation.ts`'s `SparseSolverInstrumentation`
  // wrapper; the methods stay here as the prefix-marker fallback because
  // the file split would require migrating 20+ test files in one stage.
  //
  // ngspice has no analogue: `MatrixFrame.Markowitz*` etc. live inside the
  // C struct; ngspice's harness reads them by including `spdefs.h` directly.
  // Our wrapper plays the same role: a controlled side channel separate
  // from the production ABI.
  //
  // Lint-rule note: a future ESLint rule may enforce that production code
  // (i.e. files not under `__tests__/` or `sparse-solver-instrumentation.ts`
  // and not the comparison harness) MUST NOT reference the symbols below
  // by name. Until that lint rule lands, the `@instrumentation` JSDoc
  // tag on each method is the marker.
  // =========================================================================

  /** @instrumentation Test-only. Use SparseSolverInstrumentation in new code. */
  get dimension(): number { return this._n; }
  /** @instrumentation Test-only. Use SparseSolverInstrumentation in new code. */
  get markowitzRow(): Int32Array { return this._markowitzRow; }
  /** @instrumentation Test-only. Use SparseSolverInstrumentation in new code. */
  get markowitzCol(): Int32Array { return this._markowitzCol; }
  /** @instrumentation Test-only. Use SparseSolverInstrumentation in new code. */
  get markowitzProd(): Int32Array { return this._markowitzProd; }
  /** @instrumentation Test-only. Use SparseSolverInstrumentation in new code. */
  get singletons(): number { return this._singletons; }

  /** @instrumentation Test-only. Use SparseSolverInstrumentation in new code. */
  getRhsSnapshot(): Float64Array {
    return this._rhs.slice(0, this._n);
  }

  /**
   * @instrumentation Test-only. Use SparseSolverInstrumentation in new code.
   *
   * Return assembled matrix as array of non-zero entries in original
   * ordering. Used by the ngspice comparison harness. Post-factor reads
   * report LU-overwritten data — there is no pre-factor snapshot path
   * (B.30 deleted the in-class capture; the harness can checkpoint
   * externally if needed).
   */
  getCSCNonZeros(): Array<{ row: number; col: number; value: number }> {
    const n = this._n;
    const result: Array<{ row: number; col: number; value: number }> = [];
    for (let col = 0; col < n; col++) {
      let e = this._colHead[col];
      while (e >= 0) {
        result.push({ row: this._elRow[e], col: this._elCol[e], value: this._elVal[e] });
        e = this._elNextInCol[e];
      }
    }
    return result;
  }

  // =========================================================================
  // Internal: structure initialization
  // =========================================================================

  /** ngspice spCreate (spalloc.c:117-277) — line-for-line port (real-only). */
  _initStructure(n: number): void {
    this._n = n;
    // digiTS-only: caller-owned RHS buffer (B.16 deferred to Phase 6).
    this._rhs = new Float64Array(n);

    // ngspice spalloc.c:164-198 — MatrixFrame field init.
    this._factored = false;
    this._elements = 0;
    this._error = spOKAY;
    this._originals = 0;
    this._fillins = 0;
    this._reordered = false;
    this._needsReorder = true;
    this._partitioned = false;
    this._rowsLinked = false;
    this._internalVectorsAllocated = false;
    this._singularCol = 0;
    this._singularRow = 0;

    // ngspice spalloc.c:215, 220, 225 — SP_CALLOC zero-inits chain head /
    // diag arrays; digiTS uses -1 sentinel (Bucket A.1 Int32Array encoding).
    this._rowHead = new Int32Array(n).fill(-1);
    this._colHead = new Int32Array(n).fill(-1);
    this._diag = new Int32Array(n).fill(-1);

    // ngspice spalloc.c:230, 234 — IntToExt{Col,Row}Map identity.
    // ExtToInt{Col,Row}Map: ngspice initialises to -1 and uses Translate to
    // lazy-assign on first sight (spalloc.c:255-259, spbuild.c:436-504). The
    // -1 init couples to the Translate port, which is a Phase 2 deliverable
    // per amendment A3; for Phase 1 the existing identity init stays.
    this._preorderColPerm = new Int32Array(n);
    this._intToExtRow = new Int32Array(n);
    this._extToIntCol = new Int32Array(n);
    this._extToIntRow = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      this._preorderColPerm[i] = i;
      this._intToExtRow[i] = i;
      this._extToIntCol[i] = i;
      this._extToIntRow[i] = i;
    }

    // ngspice spalloc.c:263 — InitializeElementBlocks. Pool slot 0 is the
    // TrashCan element (spalloc.c:204-211); first real handle is 1.
    const elCap = Math.max(n * 4, 64);
    this._elRow = new Int32Array(elCap);
    this._elCol = new Int32Array(elCap);
    this._elVal = new Float64Array(elCap);
    this._elNextInRow = new Int32Array(elCap).fill(-1);
    this._elNextInCol = new Int32Array(elCap).fill(-1);
    this._elCapacity = elCap;
    this._elCount = 1;

    // Markowitz / Intermediate / DoRealDirect deferred to spcCreateInternalVectors.
    this._markowitzRow = new Int32Array(0);
    this._markowitzCol = new Int32Array(0);
    this._markowitzProd = new Int32Array(0);
    this._scratch = new Float64Array(0);
    this._doRealDirect = new Int32Array(0);
  }

  /**
   * Reset for a new assembly pass — line-for-line port of ngspice `spClear`
   * (spbuild.c:96-142). Walks the column chains from `Size..1` in REVERSE
   * slot order and zeros `pElement->Real` (`_elVal[e]`) for every live
   * element. Chains (_elNextInRow, _elNextInCol, _elRow, _elCol), _diag,
   * _rowHead, _colHead, and fill-in entries all carry forward exactly as
   * the previous factor left them — `spClear` zeros only element values.
   *
   * Variable map (ngspice → digiTS):
   *   Matrix->Size            → this._n
   *   Matrix->FirstInCol[I]   → this._colHead[i]
   *   pElement->NextInCol     → this._elNextInCol[e]
   *   pElement->Real          → this._elVal[e]
   *   Matrix->Factored        → this._factored
   *   Matrix->SingularRow/Col → (deferred to Stage 6A)
   */
  /** ngspice spClear (spbuild.c:96-142) — line-for-line port (real-only). */
  _resetForAssembly(): void {
    // ngspice spbuild.c:121-129 (real branch).
    for (let i = this._n - 1; i >= 0; i--) {
      let e = this._colHead[i];
      while (e >= 0) {
        this._elVal[e] = 0.0;
        e = this._elNextInCol[e];
      }
    }
    // ngspice spbuild.c:133 — TrashCan.Real = 0.0.
    this._elVal[0] = 0.0;
    // ngspice spbuild.c:136-139.
    this._error = spOKAY;
    this._factored = false;
    this._singularCol = 0;
    this._singularRow = 0;
  }

  // =========================================================================
  // Internal: element pool operations
  // =========================================================================

  /**
   * Allocate a new element from the pool. Sets row, col, val. Returns element
   * index. The `flags` parameter is unused (retained for call-site stability;
   * fill-in distinction is now tracked by counter, not per-element flag).
   *
   * ngspice: spcGetElement (spalloc.c:310-364) / spcGetFillin (spalloc.c:475-518)
   * plus the centralised `Diag[Row] = pElement` set sites at spbuild.c:793
   * (RowsLinked=YES branch) and spbuild.c:851 (RowsLinked=NO branch). Both
   * branches in ngspice funnel through one diagonal set; we centralise the
   * same way here.
   */
  private _newElement(row: number, col: number, val: number, _flags: number): number {
    if (this._elCount >= this._elCapacity) this._growElements();
    const e = this._elCount++;
    this._elRow[e] = row;
    this._elCol[e] = col;
    this._elVal[e] = val;
    this._elNextInRow[e] = -1;
    this._elNextInCol[e] = -1;
    // ngspice spcCreateElement spbuild.c:793 / spbuild.c:851 — single sink
    // for `if (Row == Col) Matrix->Diag[Row] = pElement;` regardless of
    // the RowsLinked branch.
    if (row === col) this._diag[col] = e;
    return e;
  }

  /**
   * Insert `e` into row `row`'s chain at the column-sorted position.
   * ngspice spcCreateElement (spbuild.c:809-837) — singly-linked chain walk
   * with a local `prev`; no prev-pointer maintenance.
   *
   * ngspice's pivot search routines (SearchForSingleton, SearchEntireMatrix,
   * FindBiggestInColExclude) walk chains and skip leading entries with
   * `Col < Step` / `Row < Step`. They rely on chains being sorted ascending
   * by row/col.
   */
  private _insertIntoRow(e: number, row: number): void {
    const eCol = this._elCol[e];
    let prev = -1;
    let cur = this._rowHead[row];
    while (cur >= 0 && this._elCol[cur] < eCol) {
      prev = cur;
      cur = this._elNextInRow[cur];
    }
    this._elNextInRow[e] = cur;
    if (prev < 0) this._rowHead[row] = e;
    else this._elNextInRow[prev] = e;
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
    // (spbuild.c:768-871) via spcGetFillin path; fillin=true so _needsReorder
    // is NOT set (matches spcGetFillin spbuild.c:779-782 which does not touch
    // NeedsOrdering). Find the column-chain insert position first, then
    // dispatch to _spcCreateElement which mirrors the ngspice splice.
    let prev = -1;
    let cur = this._colHead[col];
    while (cur >= 0 && this._elRow[cur] < row) {
      prev = cur;
      cur = this._elNextInCol[cur];
    }
    const fe = this._spcCreateElement(row, col, prev, /*fillin=*/ true);

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

  /**
   * Sorted-insert into column `col`'s chain — ngspice spcCreateElement
   * (spbuild.c:805-807); same rationale as _insertIntoRow.
   */
  private _insertIntoCol(e: number, col: number): void {
    const eRow = this._elRow[e];
    let prev = -1;
    let cur = this._colHead[col];
    while (cur >= 0 && this._elRow[cur] < eRow) {
      prev = cur;
      cur = this._elNextInCol[cur];
    }
    this._elNextInCol[e] = cur;
    if (prev < 0) this._colHead[col] = e;
    else this._elNextInCol[prev] = e;
  }

  private _growElements(): void {
    const newCap = Math.max(this._elCapacity * 2, 64);
    const growI = (old: Int32Array): Int32Array => {
      const a = new Int32Array(newCap);
      a.set(old);
      return a;
    };
    const growF = (old: Float64Array): Float64Array => {
      const a = new Float64Array(newCap);
      a.set(old);
      return a;
    };
    this._elRow = growI(this._elRow);
    this._elCol = growI(this._elCol);
    this._elVal = growF(this._elVal);
    this._elNextInRow = growI(this._elNextInRow);
    this._elNextInCol = growI(this._elNextInCol);
    this._elCapacity = newCap;
  }

  // =========================================================================
  // Workspace allocation (called at reorder time)
  // =========================================================================

  /** ngspice spcCreateInternalVectors (spfactor.c:706-747) — line-for-line port (real-only). */
  private _allocateWorkspace(): void {
    if (this._internalVectorsAllocated) return;
    const n = this._n;
    // ngspice spfactor.c:715-726 — Markowitz row/col/prod.
    if (this._markowitzRow.length === 0) this._markowitzRow = new Int32Array(n + 2);
    if (this._markowitzCol.length === 0) this._markowitzCol = new Int32Array(n + 2);
    if (this._markowitzProd.length === 0) this._markowitzProd = new Int32Array(n + 2);
    // ngspice spfactor.c:728-732 — DoRealDirect (real-only; DoCmplxDirect skipped).
    if (this._doRealDirect.length === 0) this._doRealDirect = new Int32Array(n + 1);
    // ngspice spfactor.c:738-742 — Intermediate (real-only: drop the 2*).
    if (this._scratch.length === 0) this._scratch = new Float64Array(n);
    // ngspice spfactor.c:745.
    this._internalVectorsAllocated = true;
  }

  // =========================================================================
  // Numeric LU factorization with Markowitz pivot selection
  // =========================================================================

  /**
   * ngspice spOrderAndFactor (spfactor.c:192-284) — line-for-line port,
   * Stage 6 collapse. Single method body holds the two consecutive loops
   * sharing the local `Step` counter (the reuse-loop at spfactor.c:214-228
   * and the reorder-loop at spfactor.c:240+). Per banned-pattern guard rule
   * #8 the two loops MUST stay in one TS method.
   *
   * Variable map (ngspice → digiTS):
   *   Matrix->Size                → this._n
   *   Matrix->NeedsOrdering       → this._needsReorder
   *   Matrix->Factored            → this._factored
   *   Matrix->RowsLinked          → this._rowsLinked
   *   Matrix->Error               → this._error
   *   Step                        → step
   */
  private _spOrderAndFactor(): number {
    const n = this._n;
    if (n === 0) return spOKAY;

    // ngspice spfactor.c:202 — Matrix->Error = spOKAY at entry.
    this._error = spOKAY;

    // ngspice spfactor.c:246-247 — row chains are built lazily on first
    // factor entry via spcLinkRows. Until the first factor call, RowsLinked
    // == NO and assembly / preorder run on column chains only.
    if (!this._rowsLinked) this._linkRows();

    if (this._needsReorder) {
      this._allocateWorkspace();
    }

    // Function-local Step counter (ngspice convention; banned-pattern guard
    // rule #7 — keep local rather than instance field).
    let step = 0;

    // -----------------------------------------------------------------
    // Reuse loop — ngspice spfactor.c:214-228 `if (!Matrix->NeedsOrdering)`.
    // -----------------------------------------------------------------
    let reorderingRequired = this._needsReorder;
    if (!reorderingRequired) {
      const elVal = this._elVal;
      const elNextInCol = this._elNextInCol;
      const diag = this._diag;
      const relThreshold = this._relThreshold;
      for (; step < n; step++) {
        const pivotE = diag[step];
        if (pivotE < 0 || Math.abs(elVal[pivotE]) === 0) {
          // ngspice spfactor.c:225 ReorderingRequired = YES; break.
          reorderingRequired = true;
          break;
        }
        const pivotMag = Math.abs(elVal[pivotE]);
        const largestInCol = this._findLargestInCol(elNextInCol[pivotE]);
        if (largestInCol * relThreshold >= pivotMag) {
          reorderingRequired = true;
          break;
        }
        // Pivot acceptable — eliminate via the shared kernel.
        elVal[pivotE] = 1 / elVal[pivotE];
        this._realRowColElimination(pivotE);
      }
      if (!reorderingRequired) {
        // Reuse loop completed all steps — ngspice spfactor.c:228 falls
        // through to the Done label. Mark factored and return.
        this._needsReorder = false;
        this._factored = true;
        return spOKAY;
      }
    }

    // -----------------------------------------------------------------
    // Reorder loop — ngspice spfactor.c:240-281 `if (ReorderingRequired)`.
    // Markowitz precompute runs unconditionally on entry to the reorder
    // section (spfactor.c:255-256 CountMarkowitz + MarkowitzProducts),
    // then the per-step pivot-search + exchange + elimination loop.
    // -----------------------------------------------------------------
    // Mark the per-call signal: the NR layer (niiter.c:881-902 else arm)
    // gates spSINGULAR retry on "did this factor take the reuse path."
    this._lastFactorWalkedReorder = true;
    this._countMarkowitz(step, this._rhs);
    this._markowitzProducts(step);

    for (; step < n; step++) {
      // ngspice spfactor.c:261 SearchForPivot.
      const pivotE = this._searchForPivot(step);
      if (pivotE < 0) return this._matrixIsSingular(step);

      // ngspice spfactor.c:263 ExchangeRowsAndCols.
      this._exchangeRowsAndCols(pivotE, step);
      // After exchange: pivotE sits at slot (step, step); _diag[step] === pivotE.

      // ngspice RealRowColElimination spfactor.c:2563-2566 — pivot zero test.
      if (Math.abs(this._elVal[pivotE]) === 0) {
        return this._zeroPivot(step);
      }
      // ngspice spfactor.c:2567 — store reciprocal of pivot at the diagonal.
      this._elVal[pivotE] = 1 / this._elVal[pivotE];

      // ngspice spfactor.c:2568-2596 — outer-product elimination.
      this._realRowColElimination(pivotE);

      // ngspice spfactor.c:271 UpdateMarkowitzNumbers.
      if (step < n - 1) {
        this._updateMarkowitzNumbers(pivotE);
      }
    }

    // ngspice spfactor.c:279-281
    //   Matrix->NeedsOrdering = NO;
    //   Matrix->Reordered = YES;
    //   Matrix->Factored = YES;
    this._needsReorder = false;
    this._reordered = true;
    this._factored = true;
    return spOKAY;
  }

  /**
   * ngspice spFactor (spfactor.c:322-414) — line-for-line port of the
   * prelude. The partition-based factor body (spfactor.c:337, 343-413)
   * is a Phase 5 deliverable per architect §5; until then any caller
   * that reaches the reuse path (NeedsOrdering=NO, Factored=NO, post-
   * reorder) throws a clear Phase-5 marker.
   *
   *     int spFactor(MatrixPtr Matrix) {
   *         assert(IS_VALID(Matrix) && !Matrix->Factored);
   *         if (Matrix->NeedsOrdering)
   *             return spOrderAndFactor(Matrix, NULL, 0.0, 0.0,
   *                                     DIAG_PIVOTING_AS_DEFAULT);
   *         if (!Matrix->Partitioned) spPartition(Matrix, spDEFAULT_PARTITION);
   *         if (Matrix->Complex) return FactorComplexMatrix(Matrix);
   *         ...partition-based body...
   *     }
   */
  private _spFactor(): number {
    // ngspice spfactor.c:331 — assert(IS_VALID(Matrix) && !Matrix->Factored).
    // The matching assertion forbids re-entering spFactor on an
    // already-factored, no-reorder-needed matrix; our caller (NR)
    // currently re-enters unconditionally per iteration, so we drop the
    // assert until Phase 5 restructures the caller-side dispatch.

    // ngspice spfactor.c:333-335 — NeedsOrdering forwards to spOrderAndFactor.
    if (this._needsReorder) {
      return this._spOrderAndFactor();
    }

    // Phase 5: spPartition + dual-body partition factor (spfactor.c:337,
    // 343-413) are not yet ported. Reaching this branch means
    // NeedsOrdering=NO and Factored=NO — i.e. the partition path —
    // which has no ngspice line in this file yet.
    throw new Error(
      "spFactor partition body (spfactor.c:337-413) is a Phase 5 deliverable.",
    );
  }

  /**
   * ngspice RealRowColElimination (spfactor.c:2553-2598) — line-for-line
   * port of the per-pivot outer-product elimination kernel. Caller has
   * ALREADY stored `1/pivot` at `_elVal[pivotE]` (matching ngspice's
   * separation between spOrderAndFactor's pivot prep and the kernel call;
   * the kernel itself does not write the diagonal).
   *
   * pUpper walks the pivot row (right of diagonal); for each upper element
   * pSub walks its column (below diagonal) in lockstep with pLower walking
   * the pivot column. Missing pSub targets are created via `_createFillin`
   * (spfactor.c:2585), which owns the Markowitz/Singletons bookkeeping per
   * `CreateFillin` (spfactor.c:2818-2826).
   */
  private _realRowColElimination(pivotE: number): void {
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
          pSub = this._createFillin(row, upperCol);
        }
        // ngspice spfactor.c:2591 — rank-1 update.
        this._elVal[pSub] -= this._elVal[pUpper] * this._elVal[pLower];
        pSub = this._elNextInCol[pSub];
        pLower = this._elNextInCol[pLower];
      }
      pUpper = this._elNextInRow[pUpper];
    }
  }

  /**
   * ngspice MatrixIsSingular (spfactor.c:2854-2862) — sets Matrix->Error
   * to spSINGULAR and records SingularRow/SingularCol, then returns the
   * error code. Caller propagates the int.
   *
   *     static int MatrixIsSingular(MatrixPtr Matrix, int Step) {
   *         Matrix->SingularRow = Matrix->IntToExtRowMap[Step];
   *         Matrix->SingularCol = Matrix->IntToExtColMap[Step];
   *         return (Matrix->Error = spSINGULAR);
   *     }
   */
  private _matrixIsSingular(step: number): number {
    this._singularRow = this._intToExtRow[step];
    this._singularCol = this._preorderColPerm[step];
    return (this._error = spSINGULAR);
  }

  /**
   * ngspice ZeroPivot (spfactor.c:2865-2873) — same shape as
   * MatrixIsSingular but with spZERO_DIAG.
   *
   *     static int ZeroPivot(MatrixPtr Matrix, int Step) {
   *         Matrix->SingularRow = Matrix->IntToExtRowMap[Step];
   *         Matrix->SingularCol = Matrix->IntToExtColMap[Step];
   *         return (Matrix->Error = spZERO_DIAG);
   *     }
   */
  private _zeroPivot(step: number): number {
    this._singularRow = this._intToExtRow[step];
    this._singularCol = this._preorderColPerm[step];
    return (this._error = spZERO_DIAG);
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
    // ngspice SearchEntireMatrix fallback (spfactor.c:1799-1809): when no
    // candidate met RelThreshold * LargestInCol, fall back to the globally
    // largest element with Matrix->Error = spSMALL_PIVOT (warning, not
    // failure — Factored is still set on the surrounding return). When the
    // largest element is exactly zero the matrix is structurally singular.
    if (largestElementMag === 0) return -1;
    this._error = spSMALL_PIVOT;
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
  // `_setColLink(prev, X, column)` (and the row-side mirror); the caller's
  // local `prev` is rebuilt per chain walk, mirroring ngspice's singly-
  // linked C idiom. No back-pointer maintenance.
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
   * Set the column-chain "above" link: prev -> e in column `col`. Mirrors
   * ngspice `*ElementAboveRow = X` (spfactor.c:2302-2385) — singly-linked
   * write; the caller's local `prev` walks the chain as needed.
   */
  private _setColLink(prev: number, e: number, col: number): void {
    if (prev < 0) this._colHead[col] = e;
    else this._elNextInCol[prev] = e;
  }

  /**
   * Set the row-chain "left of" link: prev -> e in row `row`. Mirrors
   * ngspice `*ElementLeftOfCol = X` (spfactor.c:2431-2514) — singly-linked.
   */
  private _setRowLink(prev: number, e: number, row: number): void {
    if (prev < 0) this._rowHead[row] = e;
    else this._elNextInRow[prev] = e;
  }

  /**
   * ngspice ExchangeColElements (spfactor.c:2302-2385) — line-for-line port.
   * Operates on a single column `column`, exchanging row-position row1 <-> row2
   * for the supplied pool elements (either may be -1 == NULL).
   *
   * Singly-linked: every `*ElementAboveRow = X` is `_setColLink(prev, X, col)`.
   * No prev-pointer maintenance — chain walks rebuild a local prev as needed.
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
          this._elNextInCol[e2] = e1;
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
          this._setColLink(elementAboveRow2, e1, column);
          this._elNextInCol[e1] = elementBelowRow2;
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
      }
      this._elRow[e2] = row1;
    }
  }

  /**
   * ngspice ExchangeRowElements (spfactor.c:2431-2514) — line-for-line port.
   * Symmetric mirror of `_exchangeColElements` operating on a single row.
   * Singly-linked; no prev-pointer maintenance.
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
          this._elNextInRow[e2] = e1;
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
          this._setRowLink(elementLeftOfCol2, e1, row);
          this._elNextInRow[e1] = elementRightOfCol2;
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
      // Already at slot (step, step) — nothing to swap.
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
    // ngspice ExchangeRowsAndCols (spfactor.c:1986-2070) maintains only the
    // IntToExt{Row,Col}Map / ExtToInt{Row,Col}Map permutations and Diag/
    // FirstIn{Row,Col} chains via the inner exchanges; there is no separate
    // pivot-identity table. solve() uses _intToExtRow / _preorderColPerm
    // directly.
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
   * Count of A-matrix entries (originals only, fillins excluded). Mirrors
   * ngspice spOriginalCount (spalloc.c:879) which returns Matrix->Originals.
   */
  get elementCount(): number {
    return this._originals;
  }

  /**
   * Count of fill-in entries. Mirrors ngspice spFillinCount (spalloc.c:885).
   */
  get fillinCount(): number {
    return this._fillins;
  }

  /**
   * Total live element count (originals + fillins). Mirrors ngspice
   * spElementCount (spalloc.c:859).
   */
  get totalElementCount(): number {
    return this._elements;
  }

  /**
   * Stage 6A — public accessor mirror of ngspice spError (spalloc.c:712-724).
   * Returns the most recent Matrix->Error code (spOKAY at construction; set
   * to spSMALL_PIVOT, spZERO_DIAG, or spSINGULAR by the factor routines).
   *
   * Stage 6A.6: downstream consumer wiring (NR loop / dynamic-gmin ladder)
   * is deferred to a follow-up spec. Named call sites that will eventually
   * dispatch off this accessor:
   *   - src/solver/analog/newton-raphson.ts (NR-iteration dispatch off
   *     niiter.c's `Matrix->Error == spSINGULAR` branch).
   *   - src/solver/analog/dc-operating-point.ts (DCOP dynamic-gmin ladder
   *     off cktop.c::dynamicgmin's `Matrix->Error == spSINGULAR` branch).
   */
  getError(): number {
    return this._error;
  }

  /**
   * Stage 6A — public accessor mirror of ngspice spWhereSingular
   * (spalloc.c:749-762). Returns the original-row / original-col of the
   * most recent singularity (or {row: 0, col: 0} when factor() succeeded).
   */
  whereSingular(): { row: number; col: number } {
    return { row: this._singularRow, col: this._singularCol };
  }

}
