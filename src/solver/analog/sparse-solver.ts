/**
 * Sparse linear solver for MNA circuit simulation — direct port of ngspice
 * `spMatrix` (real-only).
 *
 * ngspice references:
 *   spCreate (spalloc.c:117-277)         — _initStructure
 *   spClear (spbuild.c:96-142)           — _resetForAssembly
 *   spStripMatrix (sputils.c:1106-1145)  — invalidateTopology
 *   spcCreateInternalVectors (spfactor.c:706-747) — _allocateWorkspace
 *   spcLinkRows (spbuild.c:907-932)      — _linkRows
 *   spGetElement (spbuild.c:264-318)     — allocElement
 *   spcFindElementInCol (spbuild.c:362-393) — _spcFindElementInCol
 *   spcCreateElement (spbuild.c:768-871) — _spcCreateElement
 *   spcGetElement (spalloc.c:310-364)    — _newElement
 *   Translate (spbuild.c:436-504)        — _translate
 *   CreateFillin (spfactor.c:2799-2829)  — _createFillin
 *   spOrderAndFactor (spfactor.c:191-284)— _spOrderAndFactor
 *   spFactor (spfactor.c:322-414)        — _spFactor
 *   spSolve (spsolve.c:126-191)          — solve
 *
 * =========================================================================
 * Indexing convention — ngspice 1-based (port-spec stage 7 option a)
 * =========================================================================
 *
 * Every per-row / per-col / per-slot vector has length `Size + 1`. Slot 0
 * is the ngspice ground-node sentinel; loops run `for (I = 1; I <= Size; I++)`.
 *
 * Element pool: slot 0 is the TrashCan (spdefs.h:776, spalloc.c:204-211);
 * `allocElement` returns handle 0 when Row == 0 or Col == 0, so any stamp
 * to a ground row/col writes into `_elVal[0]`, which `_resetForAssembly`
 * zeros every NR iteration (spbuild.c:133-134). The first usable element
 * handle is 1.
 *
 * Caller-facing convention:
 *   * Public allocElement(row, col) takes ngspice external indices: 0 is
 *     ground, 1..Size are the active MNA rows / cols.
 *   * solve(rhs, solution) reads `rhs[i]` and writes `solution[i]` for
 *     i in 1..Size; slot 0 is the ngspice ground sentinel (always 0).
 *     Mirrors spSolve(Matrix, RHS, Solution, iRHS, iSolution) from
 *     ngspice spsolve.c:127. RHS is caller-owned (the NI layer's
 *     `ckt->CKTrhs`); the solver does not allocate or zero it.
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

/** ngspice spconfig.h:332 — DIAG_PIVOTING_AS_DEFAULT YES. */
const DIAG_PIVOTING_AS_DEFAULT = true;

/** ngspice spconfig.h:336 — MINIMUM_ALLOCATED_SIZE 6. */
const MINIMUM_ALLOCATED_SIZE = 6;
/** ngspice spconfig.h:337 — EXPANSION_FACTOR 1.5. */
const EXPANSION_FACTOR = 1.5;

// ngspice spmatrix.h:143-146 — spPartition mode codes.
const spDEFAULT_PARTITION = 0;
const spDIRECT_PARTITION = 1;
const spINDIRECT_PARTITION = 2;
const spAUTO_PARTITION = 3;
/** ngspice spconfig.h:340 — DEFAULT_PARTITION spAUTO_PARTITION. */
const DEFAULT_PARTITION = spAUTO_PARTITION;

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
   * ngspice Matrix->IntToExtColMap (spdefs.h, sputils.c:291). Length Size + 1;
   * slot 0 unused. Identity at construction; updated by SwapCols and
   * spcColExchange.
   */
  private _intToExtCol: Int32Array = new Int32Array(0);

  /**
   * External-col → internal-slot map. ngspice Matrix->ExtToIntColMap
   * (spalloc.c:246). Length Size + 1; slot 0 = 0 (ground sentinel),
   * slots 1..Size start at -1 and Translate (spbuild.c:436-504) lazily
   * assigns CurrentSize on first sight (spalloc.c:255-259).
   */
  private _extToIntCol: Int32Array = new Int32Array(0);

  /**
   * Internal-slot → external-row map. ngspice Matrix->IntToExtRowMap
   * (spdefs.h, sputils.c). Length Size + 1; slot 0 unused. Identity at
   * construction; updated by _spcRowExchange.
   */
  private _intToExtRow: Int32Array = new Int32Array(0);

  /**
   * External-row → internal-slot map. ngspice Matrix->ExtToIntRowMap
   * (spalloc.c:250). Length Size + 1; slot 0 = 0 (ground sentinel),
   * slots 1..Size start at -1.
   */
  private _extToIntRow: Int32Array = new Int32Array(0);

  /**
   * ngspice Matrix->CurrentSize (spalloc.c:181) — running count of
   * internal slots assigned by Translate. Bumped from 0 to Size as
   * external indices are first observed via _translate.
   */
  private _currentSize: number = 0;

  /**
   * Next free slot in element pool. Slot 0 is the TrashCan sentinel
   * (spdefs.h:776; A2 amendment); first real handle is 1.
   */
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
  // Dimension — ngspice MatrixFrame Size / AllocatedSize / ExtSize / AllocatedExtSize
  // =========================================================================
  /** ngspice Matrix->Size — live loop bound; bumped by _enlargeMatrix. */
  private _size: number = 0;
  /** Public accessor for the current matrix dimension (mirrors ngspice
   *  Matrix->Size). After CKTsetup-equivalent calls have run, this is the
   *  number of MNA equations including ground row 0. */
  get matrixSize(): number { return this._size; }
  /** ngspice Matrix->AllocatedSize — heap capacity for _diag/_rowHead/_colHead/_intToExtRow/_intToExtCol. */
  private _allocatedSize: number = 0;
  /** ngspice Matrix->ExtSize — largest external index seen. */
  private _extSize: number = 0;
  /** ngspice Matrix->AllocatedExtSize — heap capacity for _extToIntRow/_extToIntCol. */
  private _allocatedExtSize: number = 0;
  /** Insertion order for _getInsertionOrder() — test-only debug field. */
  private _insertionOrder: Array<{ extRow: number; extCol: number }> = [];


  // =========================================================================
  // ngspice Matrix->Intermediate (spdefs.h, spfactor.c:738-742). Length
  // Size + 1; allocated by spcCreateInternalVectors. Used as the scatter-
  // gather buffer in spFactor's partition body and the working vector in
  // spSolve.
  // =========================================================================
  private _intermediate: Float64Array = new Float64Array(0);

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
   * ngspice MatrixFrame.NumberOfInterchangesIsOdd (spdefs.h). Toggled at every
   * SwapCols (sputils.c:299) and at the Row != Step / Col != Step branches of
   * ExchangeRowsAndCols (spfactor.c:2016-2017, 2033-2034). Sign source for
   * spDeterminant.
   */
  private _numberOfInterchangesIsOdd: boolean = false;

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

  // ngspice QuicklySearchDiagonal stack array `TiedElements[MAX_MARKOWITZ_TIES + 1]`
  // (spfactor.c:1260). Allocated once as class field per architect B.42.
  private _tiedElements: Int32Array = new Int32Array(101);

  // =========================================================================
  // Constructor
  // =========================================================================

  constructor() {}

  // =========================================================================
  // Public stamp API — ngspice spGetElement / *ElementPtr pattern
  // =========================================================================

  /**
   * ngspice spGetElement (spbuild.c:264-318) — line-for-line port.
   *
   *   if (Row == 0 || Col == 0) return &Matrix->TrashCan.Real;
   *   Translate(Matrix, &Row, &Col);
   *   if (Row != Col || Diag[Row] == NULL)
   *       pElement = spcFindElementInCol(...);
   *   else pElement = Matrix->Diag[Row];
   *   return &pElement->Real;
   *
   * Returns the pool handle for use with stampElement(). Handle 0 is the
   * TrashCan (amendment A2): stamps to ground rows/cols write into
   * `_elVal[0]` which is reset by _resetForAssembly per spbuild.c:133.
   */
   allocElement(row: number, col: number): number {
    // ngspice spbuild.c:272-273 — Row == 0 || Col == 0 → TrashCan handle.
    if (row === 0 || col === 0) return 0;
    // ngspice spbuild.c:280 (TRANSLATE) — translate BOTH Row and Col.
    const translated = this._translate(row, col);
    const intRow = translated.intRow;
    const intCol = translated.intCol;
    // ngspice spbuild.c:306-316 — Diag[Row] fast-path. When the element is
    // on the diagonal AND already exists, skip the column-chain walk.
    if (intRow === intCol) {
      const pDiag = this._diag[intRow];
      if (pDiag >= 0) return pDiag;
    }
    // ngspice spbuild.c:313-315 — spcFindElementInCol(&FirstInCol[Col], Row, Col, YES).
    return this._spcFindElementInCol(intCol, intRow, /*createIfMissing=*/ true);
  }

  /**
   * ngspice Translate (spbuild.c:436-504) — line-for-line port. TRANSLATE
   * is always on per amendment A3.
   *
   *   ExtRow / ExtCol → IntRow / IntCol via lazy assignment of CurrentSize
   *   on first sight (`ExtToInt[I] == -1`). The first sight of an external
   *   index N also sets IntToExt[CurrentSize] = N, building both
   *   permutation directions in lockstep.
   *
   * One _insertionOrder entry is pushed per call (one allocElement call =
   * one entry). Index-assignment side-effects (row-new / col-new branches)
   * do NOT push additional entries.
   */
  private _translate(extRow: number, extCol: number): { intRow: number; intCol: number } {
    // Record this allocElement call in insertion order (one entry per call).
    this._insertionOrder.push({ extRow, extCol });
    const maxExt = extRow > extCol ? extRow : extCol;
    if (maxExt > this._extSize) {
      this._expandTranslationArrays(maxExt);
    }
    // Grow internal arrays if ext index exceeds internal allocation (spbuild.c:968-970).
    if (maxExt > this._allocatedSize) {
      this._enlargeMatrix(maxExt);
    }

    // ngspice spbuild.c:458-477 — translate ExtRow.
    let intRow = this._extToIntRow[extRow];
    if (intRow === -1) {
      this._currentSize++;
      // Grow internal arrays if needed (spbuild.c:957-1019).
      if (this._currentSize > this._allocatedSize) {
        this._enlargeMatrix(this._currentSize);
      }
      this._extToIntRow[extRow] = this._currentSize;
      this._extToIntCol[extRow] = this._currentSize;
      intRow = this._currentSize;
      this._intToExtRow[intRow] = extRow;
      this._intToExtCol[intRow] = extRow;
    }

    // ngspice spbuild.c:480-499 — translate ExtCol.
    let intCol = this._extToIntCol[extCol];
    if (intCol === -1) {
      this._currentSize++;
      // Grow internal arrays if needed.
      if (this._currentSize > this._allocatedSize) {
        this._enlargeMatrix(this._currentSize);
      }
      this._extToIntRow[extCol] = this._currentSize;
      this._extToIntCol[extCol] = this._currentSize;
      intCol = this._currentSize;
      this._intToExtRow[intCol] = extCol;
      this._intToExtCol[intCol] = extCol;
    }

    // Update live Size (spbuild.c:963 via EnlargeMatrix called above).
    // Size is the max internal slot assigned so far.
    if (this._currentSize > this._size) {
      this._enlargeMatrix(this._currentSize);
    }

    return { intRow, intCol };
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
   * ngspice spcCreateElement (spbuild.c:767-872) — line-for-line port. Two
   * complete branches under `if (RowsLinked)` per architect B.22 / port-
   * spec edit 1.3.5. Each branch:
   *   - alloc via spcGetElement (we reuse _newElement for both element and
   *     fill-in pools — ngspice's spcGetFillin falls back to spcGetElement
   *     on FillinsRemaining == 0 per spalloc.c:481-483, and amendment A5
   *     reclassifies the block-list as TS-mandated absent);
   *   - if (Row == Col) Matrix->Diag[Row] = pElement (spbuild.c:793/851);
   *   - initialise pElement->Row / Col / Real (spbuild.c:797-803/855-863);
   *   - splice into column chain via *LastAddr (spbuild.c:806-807/866-867);
   *   - RowsLinked branch additionally walks FirstInRow[Row] for the row
   *     splice (spbuild.c:810-837);
   *   - bump counters per branch (spbuild.c:782/787/847) and Matrix->
   *     Elements++ (spbuild.c:870).
   */
  private _spcCreateElement(
    row: number, col: number, prevInCol: number, fillin: boolean,
  ): number {
    let pElement: number;
    if (this._rowsLinked) {
      // ngspice spbuild.c:776-789 — Row pointers cannot be ignored.
      // ngspice splits between spcGetFillin and spcGetElement here; both
      // funnel into the same pool walk in our model (amendment A5).
      pElement = this._newElement();
      if (fillin) {
        this._fillins++;
      } else {
        this._originals++;
        // ngspice spbuild.c:788 — Matrix->NeedsOrdering = YES.
        this._needsReorder = true;
      }

      // ngspice spbuild.c:793 — `if (Row == Col) Matrix->Diag[Row] = pElement`.
      if (row === col) this._diag[row] = pElement;

      // ngspice spbuild.c:797-800 — initialise Element fields.
      this._elRow[pElement] = row;
      this._elCol[pElement] = col;
      this._elVal[pElement] = 0.0;
      // (Imag = 0.0 / pInitInfo = NULL — complex / INITIALIZE both off.)

      // ngspice spbuild.c:806-807 — splice into column at *LastAddr.
      if (prevInCol < 0) {
        this._elNextInCol[pElement] = this._colHead[col];
        this._colHead[col] = pElement;
      } else {
        this._elNextInCol[pElement] = this._elNextInCol[prevInCol];
        this._elNextInCol[prevInCol] = pElement;
      }

      // ngspice spbuild.c:810-822 — search FirstInRow[Row] for splice point.
      let pLastInRow = -1;
      let pInRow = this._rowHead[row];
      while (pInRow >= 0) {
        if (this._elCol[pInRow] < col) {
          pLastInRow = pInRow;
          pInRow = this._elNextInRow[pInRow];
        } else {
          // ngspice spbuild.c:821 — `else pElement = NULL;` to break loop.
          break;
        }
      }

      // ngspice spbuild.c:825-837 — splice into row.
      if (pLastInRow < 0) {
        this._elNextInRow[pElement] = this._rowHead[row];
        this._rowHead[row] = pElement;
      } else {
        this._elNextInRow[pElement] = this._elNextInRow[pLastInRow];
        this._elNextInRow[pLastInRow] = pElement;
      }
    } else {
      // ngspice spbuild.c:840-867 — row chains do not exist yet; just
      // splice into the column chain.
      pElement = this._newElement();
      this._originals++;

      // ngspice spbuild.c:851 — `if (Row == Col) Matrix->Diag[Row] = pElement`.
      if (row === col) this._diag[row] = pElement;

      // ngspice spbuild.c:855-860 — initialise. (DEBUG branch always sets
      // Col; we do too because pivot search reads _elCol unconditionally.)
      this._elRow[pElement] = row;
      this._elCol[pElement] = col;
      this._elVal[pElement] = 0.0;

      // ngspice spbuild.c:866-867 — splice into column at *LastAddr.
      if (prevInCol < 0) {
        this._elNextInCol[pElement] = this._colHead[col];
        this._colHead[col] = pElement;
      } else {
        this._elNextInCol[pElement] = this._elNextInCol[prevInCol];
        this._elNextInCol[prevInCol] = pElement;
      }
    }

    // ngspice spbuild.c:870 — Matrix->Elements++.
    this._elements++;
    return pElement;
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

  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * ngspice SMPluFac (spsmp.c:168-175) — line-for-line port. PivTol is
   * NG_IGNORE-d; spSetReal is a no-op in this real-only port (amendment A8).
   * The reorder-vs-reuse dispatch lives one level deeper at spfactor.c:333-335.
   */
  factor(pivTol: number = 0, gmin: number = 0): number {
    // ngspice spsmp.c:171 — NG_IGNORE(PivTol).
    void pivTol;
    // ngspice spsmp.c:172 — spSetReal (real-only port: no-op).
    // ngspice spsmp.c:173.
    this._loadGmin(gmin);
    // niiter.c:888-891 NR retry gate (digiTS-only signal).
    this._lastFactorWalkedReorder = false;
    // ngspice spsmp.c:174.
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
   * ngspice spSolve (spsolve.c:126-191) — line-for-line port, real-only.
   *
   * Five-argument signature mirrors spSolve(Matrix, RHS, Solution, iRHS,
   * iSolution). Real-only port: iRHS / iSolution are accepted for
   * signature parity but unused. The Complex branch (spsolve.c:139-143)
   * is out of scope per amendment A8; complex solves live in
   * complex-sparse-solver.ts.
   *
   * Per spsolve.c:90-91, RHS and Solution may alias (in-place solve).
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
   *   Matrix->IntToExtColMap[k]  → _intToExtCol[k]
   *   RHS                        → rhs (caller-owned, original-row keyed)
   *   Solution                   → solution (caller output, original-col keyed)
   *   Intermediate               → b (this._intermediate)
   */
  solve(
    rhs: Float64Array,
    solution: Float64Array,
    iRHS?: Float64Array | null,
    iSolution?: Float64Array | null,
  ): void {
    // ngspice spsolve.c:137 — assert( IS_VALID(Matrix) && IS_FACTORED(Matrix) ).
    // IS_FACTORED == (Matrix->Factored && !Matrix->NeedsOrdering).
    if (!this._factored || this._needsReorder) {
      throw new Error("spSolve: matrix is not factored (IS_FACTORED assertion)");
    }
    // ngspice spsolve.c:139-143 — Complex branch dispatched to
    // SolveComplexMatrix. Out of scope per amendment A8.
    void iRHS;
    void iSolution;

    // ngspice spsolve.c:145-146.
    const b = this._intermediate;
    const n = this._size;
    const intToExtRow = this._intToExtRow;
    const intToExtCol = this._intToExtCol;
    const diag = this._diag;
    const elVal = this._elVal;
    const elRow = this._elRow;
    const elCol = this._elCol;
    const elNextInCol = this._elNextInCol;
    const elNextInRow = this._elNextInRow;

    // ngspice spsolve.c:149-151 — Initialize Intermediate vector.
    //   pExtOrder = &Matrix->IntToExtRowMap[Size];
    //   for (I = Size; I > 0; I--)
    //       Intermediate[I] = RHS[*(pExtOrder--)];
    for (let i = n; i >= 1; i--) b[i] = rhs[intToExtRow[i]];

    // ngspice spsolve.c:154-170 — Forward elimination. Solves Lc = b.
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
    for (let i = 1; i <= n; i++) {
      let temp = b[i];
      if (temp !== 0.0) {
        const pPivot = diag[i];
        temp *= elVal[pPivot];
        b[i] = temp;
        let pElement = elNextInCol[pPivot];
        while (pElement >= 0) {
          b[elRow[pElement]] -= temp * elVal[pElement];
          pElement = elNextInCol[pElement];
        }
      }
    }

    // ngspice spsolve.c:173-183 — Backward Substitution. Solves Ux = c.
    //   for (I = Size; I > 0; I--) {
    //       Temp = Intermediate[I];
    //       pElement = Matrix->Diag[I]->NextInRow;
    //       while (pElement != NULL) {
    //           Temp -= pElement->Real * Intermediate[pElement->Col];
    //           pElement = pElement->NextInRow;
    //       }
    //       Intermediate[I] = Temp;
    //   }
    for (let i = n; i >= 1; i--) {
      let temp = b[i];
      let pElement = elNextInRow[diag[i]];
      while (pElement >= 0) {
        temp -= elVal[pElement] * b[elCol[pElement]];
        pElement = elNextInRow[pElement];
      }
      b[i] = temp;
    }

    // ngspice spsolve.c:186-188 — Unscramble Intermediate vector while
    // placing data into Solution vector.
    //   pExtOrder = &Matrix->IntToExtColMap[Size];
    //   for (I = Size; I > 0; I--)
    //       Solution[*(pExtOrder--)] = Intermediate[I];
    for (let i = n; i >= 1; i--) solution[intToExtCol[i]] = b[i];
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
    // ngspice sputils.c:1117-1133 — element-list cursor reset (block-walk
    // collapses to "pool counter resets to first usable slot" per Bucket
    // A.5 / amendment A5; the doubling pool reuses the buffer).
    this._elCount = 1;
    // ngspice sputils.c:1135-1144 — `for (I = 1; I <= Size; I++)` resets
    // FirstInRow / FirstInCol / Diag.
    const n = this._size;
    for (let i = 1; i <= n; i++) {
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
   * ngspice spMNA_Preorder (sputils.c:177-230) — line-for-line port. Two-
   * phase loop: the inner pass first swaps only zero-diagonal columns whose
   * Twins count is exactly 1 (lone twins); when no lone twins remain, the
   * second pass relaxes to the first multi-twin column and swaps it. Loop
   * repeats until no AnotherPassNeeded was raised.
   *
   * Skipped when RowsLinked (sputils.c:187) — preorder runs only before the
   * first factor builds row chains.
   */
  preorder(): void {
    // sputils.c:185 — assert( IS_VALID(Matrix) && !Matrix->Factored ).
    // sputils.c:187.
    if (this._rowsLinked) return;
    const size = this._size;
    // sputils.c:189 — Matrix->Reordered = YES.
    this._reordered = true;

    let startAt = 1;
    let anotherPassNeeded: boolean;
    do {
      // sputils.c:193.
      anotherPassNeeded = false;
      let swapped = false;

      // sputils.c:196-213 — search for zero diagonals with lone twins.
      for (let j = startAt; j <= size; j++) {
        if (this._diag[j] < 0) {
          const t = this._countTwins(j);
          if (t.count === 1) {
            this._swapColumns(t.pTwin1, t.pTwin2);
            swapped = true;
          } else if (t.count > 1 && !anotherPassNeeded) {
            anotherPassNeeded = true;
            startAt = j;
          }
        }
      }

      // sputils.c:216-227 — all lone twins are gone, look for zero diagonals
      // with multiple twins.
      if (anotherPassNeeded) {
        for (let j = startAt; !swapped && j <= size; j++) {
          if (this._diag[j] < 0) {
            const t = this._countTwins(j);
            this._swapColumns(t.pTwin1, t.pTwin2);
            swapped = true;
          }
        }
      }
    } while (anotherPassNeeded);
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
    // ngspice spbuild.c:917 — `for (Col = Matrix->Size; Col >= 1; Col--)`.
    for (let col = this._size; col >= 1; col--) {
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
   * ngspice CountTwins (sputils.c:243-271) — line-for-line port. Counts the
   * symmetric twins associated with the zero-diagonal column `col` and
   * returns one set of twins if any exist; the count is terminated early
   * at two.
   *
   * Side effect at the first twin pair (sputils.c:264-265):
   *   (*ppTwin1 = pTwin1)->Col = Col;
   *   (*ppTwin2 = pTwin2)->Col = Row;
   * which is the only place ngspice stamps `Element->Col` for a freshly-
   * allocated element pre-spcLinkRows (architect B.4 carve-out).
   */
  private _countTwins(col: number): { count: number; pTwin1: number; pTwin2: number } {
    let twins = 0;
    let resTwin1 = -1;
    let resTwin2 = -1;

    let pTwin1 = this._colHead[col];
    while (pTwin1 >= 0) {
      if (Math.abs(this._elVal[pTwin1]) === 1.0) {
        const row = this._elRow[pTwin1];
        let pTwin2 = this._colHead[row];
        while (pTwin2 >= 0 && this._elRow[pTwin2] !== col)
          pTwin2 = this._elNextInCol[pTwin2];
        if (pTwin2 >= 0 && Math.abs(this._elVal[pTwin2]) === 1.0) {
          if (++twins >= 2) return { count: twins, pTwin1: resTwin1, pTwin2: resTwin2 };
          // sputils.c:264 — (*ppTwin1 = pTwin1)->Col = Col.
          resTwin1 = pTwin1;
          this._elCol[pTwin1] = col;
          // sputils.c:265 — (*ppTwin2 = pTwin2)->Col = Row.
          resTwin2 = pTwin2;
          this._elCol[pTwin2] = row;
        }
      }
      pTwin1 = this._elNextInCol[pTwin1];
    }
    return { count: twins, pTwin1: resTwin1, pTwin2: resTwin2 };
  }

  /**
   * ngspice SwapCols (sputils.c:283-301) — line-for-line port. Applicable
   * before the rows are linked. Caller (spMNA_Preorder) supplies pTwin1
   * and pTwin2; Col1 and Col2 are derived from `pTwin->Col` per
   * sputils.c:286.
   */
  private _swapColumns(pTwin1: number, pTwin2: number): void {
    const col1 = this._elCol[pTwin1];
    const col2 = this._elCol[pTwin2];

    // sputils.c:290 — SWAP(ElementPtr, FirstInCol[Col1], FirstInCol[Col2]).
    const fic1 = this._colHead[col1];
    this._colHead[col1] = this._colHead[col2];
    this._colHead[col2] = fic1;

    // sputils.c:291 — SWAP(int, IntToExtColMap[Col1], IntToExtColMap[Col2]).
    const itec1 = this._intToExtCol[col1];
    this._intToExtCol[col1] = this._intToExtCol[col2];
    this._intToExtCol[col2] = itec1;

    // sputils.c:293-294 (TRANSLATE always on per amendment A3).
    this._extToIntCol[this._intToExtCol[col2]] = col2;
    this._extToIntCol[this._intToExtCol[col1]] = col1;

    // sputils.c:297-298 — Diag[Col1] = pTwin2; Diag[Col2] = pTwin1.
    this._diag[col1] = pTwin2;
    this._diag[col2] = pTwin1;

    // sputils.c:299 — NumberOfInterchangesIsOdd flip.
    this._numberOfInterchangesIsOdd = !this._numberOfInterchangesIsOdd;
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
  get dimension(): number { return this._size; }

  /** Test-only: return (extRow, extCol) pairs in the order Translate
   *  first encountered them. Used by setup-stamp-order invariant tests
   *  to verify TSTALLOC ordering against ngspice's *setup.c line
   *  ordering. Not part of the runtime API. */
  _getInsertionOrder(): ReadonlyArray<{ extRow: number; extCol: number }> {
    return this._insertionOrder;
  }
  /** @instrumentation Test-only. Use SparseSolverInstrumentation in new code. */
  get markowitzRow(): Int32Array { return this._markowitzRow; }
  /** @instrumentation Test-only. Use SparseSolverInstrumentation in new code. */
  get markowitzCol(): Int32Array { return this._markowitzCol; }
  /** @instrumentation Test-only. Use SparseSolverInstrumentation in new code. */
  get markowitzProd(): Int32Array { return this._markowitzProd; }
  /** @instrumentation Test-only. Use SparseSolverInstrumentation in new code. */
  get singletons(): number { return this._singletons; }

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
    const n = this._size;
    const result: Array<{ row: number; col: number; value: number }> = [];
    // Walk slots 1..n; slot 0 is the ground sentinel and never linked.
    // Report ngspice-external (MNA) indices, not internal sparse-matrix indices,
    // so the harness comparison aligns with ngspice's niiter.c:813,830 which
    // exports ExtCol/ExtRow. Without this, two engines that walk elements in
    // different orders during setup get different internal index assignments
    // via _translate, even though their external (MNA) layout is identical.
    const intToExtRow = this._intToExtRow;
    const intToExtCol = this._intToExtCol;
    for (let col = 1; col <= n; col++) {
      let e = this._colHead[col];
      while (e >= 0) {
        const intRow = this._elRow[e]!;
        const intCol = this._elCol[e]!;
        const extRow = intToExtRow[intRow] ?? intRow;
        const extCol = intToExtCol[intCol] ?? intCol;
        result.push({ row: extRow, col: extCol, value: this._elVal[e]! });
        e = this._elNextInCol[e]!;
      }
    }
    return result;
  }

  // =========================================================================
  // Internal: structure initialization
  // =========================================================================

  /** ngspice spCreate (spalloc.c:117-277) — line-for-line port (real-only). */
  _initStructure(): void {
    const initialAlloc = MINIMUM_ALLOCATED_SIZE; // 6 per spconfig.h:336

    // ngspice spalloc.c:164-198 — MatrixFrame field init.
    this._size = 0;
    this._currentSize = 0;                        // mirrors ngspice CurrentSize
    this._extSize = 0;
    this._allocatedSize = initialAlloc;
    this._allocatedExtSize = initialAlloc;
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

    this._intToExtCol = new Int32Array(initialAlloc + 1);
    this._intToExtRow = new Int32Array(initialAlloc + 1);
    this._extToIntCol = new Int32Array(initialAlloc + 1).fill(-1);
    this._extToIntRow = new Int32Array(initialAlloc + 1).fill(-1);
    this._extToIntCol[0] = 0;
    this._extToIntRow[0] = 0;
    this._diag = new Int32Array(initialAlloc + 1).fill(-1);
    this._rowHead = new Int32Array(initialAlloc + 1).fill(-1);
    this._colHead = new Int32Array(initialAlloc + 1).fill(-1);
    for (let i = 1; i <= initialAlloc; i++) {
      this._intToExtRow[i] = i;
      this._intToExtCol[i] = i;
    }

    // Element pool sized 6 * AllocatedSize per spalloc.c:263-264.
    const elCap = Math.max(6 * initialAlloc, 64);
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
    this._intermediate = new Float64Array(0);
    this._doRealDirect = new Int32Array(0);
    this._insertionOrder = [];                    // for _getInsertionOrder
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
   *   Matrix->Size            → this._size
   *   Matrix->FirstInCol[I]   → this._colHead[i]
   *   pElement->NextInCol     → this._elNextInCol[e]
   *   pElement->Real          → this._elVal[e]
   *   Matrix->Factored        → this._factored
   *   Matrix->SingularRow/Col → (deferred to Stage 6A)
   */
  /** ngspice EnlargeMatrix (spbuild.c:957-1019) — line-for-line port. */
  private _enlargeMatrix(newSize: number): void {
    const oldAllocatedSize = this._allocatedSize;       // spbuild.c:960
    this._size = newSize;                               // spbuild.c:963
    if (newSize <= oldAllocatedSize) return;            // spbuild.c:965-966

    newSize = Math.max(newSize, Math.ceil(EXPANSION_FACTOR * oldAllocatedSize));
    this._allocatedSize = newSize;

    this._intToExtCol = this._growInt32(this._intToExtCol, newSize + 1);
    this._intToExtRow = this._growInt32(this._intToExtRow, newSize + 1);
    this._diag        = this._growInt32(this._diag,        newSize + 1, -1);
    this._rowHead     = this._growInt32(this._rowHead,     newSize + 1, -1);
    this._colHead     = this._growInt32(this._colHead,     newSize + 1, -1);

    // spbuild.c:1000-1006 — drop Markowitz/Intermediate workspace.
    this._markowitzRow  = new Int32Array(0);
    this._markowitzCol  = new Int32Array(0);
    this._markowitzProd = new Int32Array(0);
    this._doRealDirect  = new Int32Array(0);
    this._intermediate  = new Float64Array(0);
    this._internalVectorsAllocated = false;

    // spbuild.c:1009-1016 — initialise the new portion (identity map).
    for (let I = oldAllocatedSize + 1; I <= newSize; I++) {
      this._intToExtRow[I] = I;
      this._intToExtCol[I] = I;
    }
  }

  /** ngspice ExpandTranslationArrays (spbuild.c:1047-1081) — line-for-line port. */
  private _expandTranslationArrays(newSize: number): void {
    const oldAllocatedSize = this._allocatedExtSize;
    this._extSize = newSize;
    if (newSize <= oldAllocatedSize) return;              // spbuild.c:1055-1056

    newSize = Math.max(newSize, Math.ceil(EXPANSION_FACTOR * oldAllocatedSize));
    this._allocatedExtSize = newSize;

    this._extToIntRow = this._growInt32(this._extToIntRow, newSize + 1, -1);
    this._extToIntCol = this._growInt32(this._extToIntCol, newSize + 1, -1);
    this._extToIntRow[0] = 0;     // ground-pin re-pin (defensive)
    this._extToIntCol[0] = 0;
  }

  /** Grow an Int32Array to newLen, preserving existing data. Fill new slots with `fill`. */
  private _growInt32(arr: Int32Array, newLen: number, fill = 0): Int32Array {
    const next = new Int32Array(newLen);
    if (fill !== 0) next.fill(fill);
    next.set(arr.subarray(0, Math.min(arr.length, newLen)));
    return next;
  }

  /** ngspice spClear (spbuild.c:96-142) — line-for-line port (real-only). */
  _resetForAssembly(): void {
    // ngspice spbuild.c:121-129 (real branch) — `for (I = Size; I > 0; I--)`.
    for (let i = this._size; i >= 1; i--) {
      let e = this._colHead[i];
      while (e >= 0) {
        this._elVal[e] = 0.0;
        e = this._elNextInCol[e];
      }
    }
    // ngspice spbuild.c:133-134 — TrashCan.Real / .Imag = 0.0.
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
   * ngspice spcGetElement (spalloc.c:310-364) — pool advance only. Per
   * architect B.20 / B.21 / port-spec edit 1.3.5, this routine no longer
   * carries val / flags arguments and does not touch the diagonal: the
   * caller (_spcCreateElement) initialises every Element field including
   * the Diag set, mirroring spbuild.c:793/851.
   *
   * Field init (Row / Col / Real / NextInCol / NextInRow) lives at the
   * caller. We only return a fresh slot whose pointers happen to be -1
   * thanks to the Int32Array zero-fill at construction; this is identical
   * in behaviour to ngspice's `Matrix->NextAvailElement++` returning a
   * SP_MALLOC'd block whose fields are uninitialised (the caller writes
   * them all anyway).
   */
  private _newElement(): number {
    if (this._elCount >= this._elCapacity) this._growElements();
    return this._elCount++;
  }

  /**
   * ngspice CreateFillin (spfactor.c:2799-2829) — line-for-line port.
   *
   *     ppElementAbove = &Matrix->FirstInCol[Col];
   *     pElement = *ppElementAbove;
   *     while (pElement != NULL) {
   *         if (pElement->Row < Row) {
   *             ppElementAbove = &pElement->NextInCol;
   *             pElement = *ppElementAbove;
   *         } else break;
   *     }
   *     pElement = spcCreateElement( Matrix, Row, Col, ppElementAbove, YES );
   *     Matrix->MarkowitzProd[Row] = ++Matrix->MarkowitzRow[Row] *
   *                                  Matrix->MarkowitzCol[Row];
   *     if ((Matrix->MarkowitzRow[Row] == 1) && (Matrix->MarkowitzCol[Row] != 0))
   *         Matrix->Singletons--;
   *     Matrix->MarkowitzProd[Col] = ++Matrix->MarkowitzCol[Col] *
   *                                  Matrix->MarkowitzRow[Col];
   *     if ((Matrix->MarkowitzRow[Col] != 0) && (Matrix->MarkowitzCol[Col] == 1))
   *         Matrix->Singletons--;
   *
   * The C `*ppElementAbove` pointer-to-pointer is replaced by a `prev`
   * local plus the canonical Bucket A.5 mitigation passed to
   * _spcCreateElement.
   */
  private _createFillin(row: number, col: number): number {
    // Find Element above fill-in.
    let prev = -1;
    let pElement = this._colHead[col];
    while (pElement >= 0) {
      if (this._elRow[pElement] < row) {
        prev = pElement;
        pElement = this._elNextInCol[pElement];
      } else break;
    }

    // End of search, create the element.
    pElement = this._spcCreateElement(row, col, prev, /*Fillin=*/ true);

    // Update Markowitz counts and products.
    this._markowitzProd[row] = ++this._markowitzRow[row] * this._markowitzCol[row];
    if (this._markowitzRow[row] === 1 && this._markowitzCol[row] !== 0)
      this._singletons--;
    this._markowitzProd[col] = ++this._markowitzCol[col] * this._markowitzRow[col];
    if (this._markowitzRow[col] !== 0 && this._markowitzCol[col] === 1)
      this._singletons--;

    return pElement;
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
    const n = this._size;
    // ngspice spfactor.c:715-726 — MarkowitzRow / MarkowitzCol /
    // MarkowitzProd. Allocated length Size + 2 to host the dual-purpose
    // [Size+1] slot used by SearchForSingleton / QuicklySearchDiagonal.
    if (this._markowitzRow.length === 0) this._markowitzRow = new Int32Array(n + 2);
    if (this._markowitzCol.length === 0) this._markowitzCol = new Int32Array(n + 2);
    if (this._markowitzProd.length === 0) this._markowitzProd = new Int32Array(n + 2);
    // ngspice spfactor.c:728-732 — DoRealDirect length Size + 1 (real-only;
    // DoCmplxDirect skipped per amendment A4 + complex-out-of-scope A8).
    if (this._doRealDirect.length === 0) this._doRealDirect = new Int32Array(n + 1);
    // ngspice spfactor.c:738-742 — Intermediate length Size + 1 (real-only:
    // drop the `2 *` complex factor at spfactor.c:738).
    if (this._intermediate.length === 0) this._intermediate = new Float64Array(n + 1);
    // ngspice spfactor.c:745.
    this._internalVectorsAllocated = true;
  }

  // =========================================================================
  // Numeric LU factorization with Markowitz pivot selection
  // =========================================================================

  /**
   * ngspice spOrderAndFactor (spfactor.c:191-284) — line-for-line port.
   * Single body holds the reuse loop (spfactor.c:214-228) and the reorder
   * loop (spfactor.c:240-276) sharing function-local `step`. Single labelled
   * exit at `done:` mirrors the C `Done:` label.
   */
  private _spOrderAndFactor(
    rhs: Float64Array | null,
    relThreshold: number,
    absThreshold: number,
    diagPivoting: boolean,
  ): number {
    // ngspice spfactor.c:202.
    this._error = spOKAY;
    const size = this._size;

    // ngspice spfactor.c:204-208.
    if (relThreshold <= 0.0) relThreshold = this._relThreshold;
    if (relThreshold > 1.0) relThreshold = this._relThreshold;
    this._relThreshold = relThreshold;

    // ngspice spfactor.c:209-211.
    if (absThreshold < 0.0) absThreshold = this._absThreshold;
    this._absThreshold = absThreshold;

    // ngspice spfactor.c:212.
    let reorderingRequired = false;
    let step = 1;

    done: {
      if (!this._needsReorder) {
        // ngspice spfactor.c:216-228 — reuse loop.
        for (step = 1; step <= size; step++) {
          const pPivot = this._diag[step];
          // ngspice spfactor.c:218.
          const largestInCol = this._findLargestInCol(this._elNextInCol[pPivot]);
          // ngspice spfactor.c:219.
          if (largestInCol * relThreshold < Math.abs(this._elVal[pPivot])) {
            // ngspice spfactor.c:223 — real branch (Complex out of scope).
            this._realRowColElimination(pPivot);
          } else {
            // ngspice spfactor.c:225-226.
            reorderingRequired = true;
            break;
          }
        }
        // ngspice spfactor.c:229-230 — `if (!ReorderingRequired) goto Done`.
        if (!reorderingRequired) break done;
      } else {
        // ngspice spfactor.c:241-251 — first-time setup.
        step = 1;
        if (!this._rowsLinked) this._linkRows();
        if (!this._internalVectorsAllocated) this._allocateWorkspace();
        if (this._error >= spFATAL) return this._error;
      }

      // niiter.c:881-902 NR retry gate (digiTS-only signal). Set true the
      // moment the function commits to walking the reorder body.
      this._lastFactorWalkedReorder = true;

      // ngspice spfactor.c:254-257.
      this._countMarkowitz(step, rhs);
      this._markowitzProducts(step);

      // ngspice spfactor.c:260-276 — reorder loop.
      for (; step <= size; step++) {
        // ngspice spfactor.c:261.
        const pPivot = this._searchForPivot(step, diagPivoting);
        // ngspice spfactor.c:262.
        if (pPivot < 0) return this._matrixIsSingular(step);
        // ngspice spfactor.c:263.
        this._exchangeRowsAndCols(pPivot, step);
        // ngspice spfactor.c:265-268 — real branch.
        this._realRowColElimination(pPivot);
        // ngspice spfactor.c:270.
        if (this._error >= spFATAL) return this._error;
        // ngspice spfactor.c:271.
        this._updateMarkowitzNumbers(pPivot);
      }
    }

    // ngspice spfactor.c:278-283 — Done.
    this._needsReorder = false;
    this._reordered = true;
    this._factored = true;
    return this._error;
  }

  /**
   * ngspice spFactor (spfactor.c:322-414) — line-for-line port (real-only:
   * the FactorComplexMatrix branch and Complex check are out of scope per
   * amendment A8). Dual-body row-at-a-time LU using direct (scatter-gather)
   * or indirect (index-redirect) addressing per the partition decision.
   */
  private _spFactor(): number {
    // ngspice spfactor.c:331 — assert(IS_VALID(Matrix) && !Matrix->Factored).

    // ngspice spfactor.c:333-335.
    if (this._needsReorder) {
      return this._spOrderAndFactor(null, 0.0, 0.0, DIAG_PIVOTING_AS_DEFAULT);
    }
    // ngspice spfactor.c:337.
    if (!this._partitioned) this._spPartition(spDEFAULT_PARTITION);
    // ngspice spfactor.c:338-339 — complex branch out of scope.

    const size = this._size;

    // ngspice spfactor.c:343-346.
    if (size === 0) {
      this._factored = true;
      return (this._error = spOKAY);
    }

    // ngspice spfactor.c:348-349.
    if (this._elVal[this._diag[1]] === 0.0) return this._zeroPivot(1);
    this._elVal[this._diag[1]] = 1.0 / this._elVal[this._diag[1]];

    // ngspice spfactor.c:352-410 — dual-body row-at-a-time LU.
    //
    // Both branches use Matrix->Intermediate; in TS we use _intermediate
    // (Float64Array) for both — the indirect branch stores element handles
    // (always representable as a double, well under 2^53) per amendment A4.
    const dest = this._intermediate;
    for (let step = 2; step <= size; step++) {
      if (this._doRealDirect[step]) {
        // ngspice spfactor.c:353-383 — direct addressing.
        let pElement: number;
        let pColumn: number;

        // ngspice spfactor.c:357-362 — scatter.
        pElement = this._colHead[step];
        while (pElement >= 0) {
          dest[this._elRow[pElement]] = this._elVal[pElement];
          pElement = this._elNextInCol[pElement];
        }

        // ngspice spfactor.c:365-372 — update column.
        pColumn = this._colHead[step];
        while (this._elRow[pColumn] < step) {
          pElement = this._diag[this._elRow[pColumn]];
          this._elVal[pColumn] = dest[this._elRow[pColumn]] * this._elVal[pElement];
          while ((pElement = this._elNextInCol[pElement]) >= 0)
            dest[this._elRow[pElement]] -= this._elVal[pColumn] * this._elVal[pElement];
          pColumn = this._elNextInCol[pColumn];
        }

        // ngspice spfactor.c:375-379 — gather.
        pElement = this._elNextInCol[this._diag[step]];
        while (pElement >= 0) {
          this._elVal[pElement] = dest[this._elRow[pElement]];
          pElement = this._elNextInCol[pElement];
        }

        // ngspice spfactor.c:382-383.
        if (dest[step] === 0.0) return this._zeroPivot(step);
        this._elVal[this._diag[step]] = 1.0 / dest[step];
      } else {
        // ngspice spfactor.c:385-409 — indirect addressing. pDest stores
        // element handles per amendment A4 (Bucket A.5 TS adaptation):
        //   pDest[row] = elementIdx; _elVal[pDest[row]] *= pivot;
        let pElement: number;
        let pColumn: number;
        let mult: number;

        // ngspice spfactor.c:389-393 — scatter (store handles).
        pElement = this._colHead[step];
        while (pElement >= 0) {
          dest[this._elRow[pElement]] = pElement;
          pElement = this._elNextInCol[pElement];
        }

        // ngspice spfactor.c:396-403 — update column.
        pColumn = this._colHead[step];
        while (this._elRow[pColumn] < step) {
          pElement = this._diag[this._elRow[pColumn]];
          // ngspice spfactor.c:399 — `Mult = (*pDest[pColumn->Row] *= pElement->Real)`.
          const destIdx = dest[this._elRow[pColumn]];
          this._elVal[destIdx] *= this._elVal[pElement];
          mult = this._elVal[destIdx];
          while ((pElement = this._elNextInCol[pElement]) >= 0)
            this._elVal[dest[this._elRow[pElement]]] -= mult * this._elVal[pElement];
          pColumn = this._elNextInCol[pColumn];
        }

        // ngspice spfactor.c:406-408.
        if (this._elVal[this._diag[step]] === 0.0)
          return this._zeroPivot(step);
        this._elVal[this._diag[step]] = 1.0 / this._elVal[this._diag[step]];
      }
    }

    // ngspice spfactor.c:412-413.
    this._factored = true;
    return (this._error = spOKAY);
  }

  /**
   * ngspice spPartition (spfactor.c:580-681) — line-for-line port (real-
   * only, generic-machine heuristic per amendment A4). Counts Nc/Nm/No
   * via mock-factor walk and sets DoRealDirect[Step] per the
   * `Nm + No > 3*Nc - 2*Nm` decision.
   */
  private _spPartition(mode: number): void {
    // ngspice spfactor.c:589.
    if (this._partitioned) return;
    const size = this._size;
    const doRealDirect = this._doRealDirect;
    // ngspice spfactor.c:594.
    this._partitioned = true;

    // ngspice spfactor.c:597.
    if (mode === spDEFAULT_PARTITION) mode = DEFAULT_PARTITION;
    // ngspice spfactor.c:598-603.
    if (mode === spDIRECT_PARTITION) {
      for (let step = 1; step <= size; step++) doRealDirect[step] = 1;
      return;
    }
    // ngspice spfactor.c:604-609.
    if (mode === spINDIRECT_PARTITION) {
      for (let step = 1; step <= size; step++) doRealDirect[step] = 0;
      return;
    }
    // ngspice spfactor.c:610-611 — assert(Mode == spAUTO_PARTITION).

    // ngspice spfactor.c:614-616 — Nc=MarkowitzRow, No=MarkowitzCol,
    // Nm=MarkowitzProd. Reused as op-count scratch buffers.
    const nc = this._markowitzRow;
    const no = this._markowitzCol;
    const nm = this._markowitzProd;

    // ngspice spfactor.c:619-636 — mock-factorization op count.
    for (let step = 1; step <= size; step++) {
      nc[step] = 0;
      no[step] = 0;
      nm[step] = 0;

      let pElement = this._colHead[step];
      while (pElement >= 0) {
        nc[step]++;
        pElement = this._elNextInCol[pElement];
      }

      let pColumn = this._colHead[step];
      while (this._elRow[pColumn] < step) {
        pElement = this._diag[this._elRow[pColumn]];
        nm[step]++;
        while ((pElement = this._elNextInCol[pElement]) >= 0)
          no[step]++;
        pColumn = this._elNextInCol[pColumn];
      }
    }

    // ngspice spfactor.c:638-670 — generic-machine heuristic at line 666.
    for (let step = 1; step <= size; step++) {
      doRealDirect[step] = (nm[step] + no[step] > 3 * nc[step] - 2 * nm[step]) ? 1 : 0;
    }
  }

  /**
   * ngspice RealRowColElimination (spfactor.c:2553-2598) — line-for-line
   * port. Self-contained: tests pPivot->Real for zero (calling
   * MatrixIsSingular and returning on hit), stamps the reciprocal in-place,
   * then walks pUpper / pLower for the rank-1 update with fill-in via
   * CreateFillin.
   */
  private _realRowColElimination(pivotE: number): void {
    // ngspice spfactor.c:2562-2566 — Test for zero pivot.
    if (Math.abs(this._elVal[pivotE]) === 0.0) {
      this._matrixIsSingular(this._elRow[pivotE]);
      return;
    }
    // ngspice spfactor.c:2567 — pPivot->Real = 1.0 / pPivot->Real.
    this._elVal[pivotE] = 1.0 / this._elVal[pivotE];

    let pUpper = this._elNextInRow[pivotE];
    while (pUpper >= 0) {
      // ngspice spfactor.c:2572 — pUpper->Real *= pPivot->Real.
      this._elVal[pUpper] *= this._elVal[pivotE];

      let pSub = this._elNextInCol[pUpper];
      let pLower = this._elNextInCol[pivotE];
      while (pLower >= 0) {
        const row = this._elRow[pLower];

        // ngspice spfactor.c:2580-2581 — advance pSub to row alignment.
        while (pSub >= 0 && this._elRow[pSub] < row) {
          pSub = this._elNextInCol[pSub];
        }

        // ngspice spfactor.c:2584-2590 — create fill-in if missing.
        if (pSub < 0 || this._elRow[pSub] > row) {
          pSub = this._createFillin(row, this._elCol[pUpper]);
          if (pSub < 0) {
            this._error = spNO_MEMORY;
            return;
          }
        }
        // ngspice spfactor.c:2591 — pSub->Real -= pUpper->Real * pLower->Real.
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
    this._singularCol = this._intToExtCol[step];
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
    this._singularCol = this._intToExtCol[step];
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
    if (this._elRow[e] !== row)
      largest = Math.abs(this._elVal[e]);
    else
      largest = 0.0;

    /* Search rest of column for largest element, avoiding excluded element. */
    while ((e = this._elNextInCol[e]) >= 0) {
      const magnitude = Math.abs(this._elVal[e]);
      if (magnitude > largest) {
        if (this._elRow[e] !== row)
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
    const n = this._size;
    const mRow = this._markowitzRow;
    const mCol = this._markowitzCol;

    /* Generate MarkowitzRow Count for each row. */
    // ngspice spfactor.c:794 — `for (I = Step; I <= Matrix->Size; I++)`.
    for (let i = step; i <= n; i++) {
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
    // ngspice spfactor.c:813 — same loop bounds.
    for (let i = step; i <= n; i++) {
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
    const n = this._size;
    this._singletons = 0;
    // ngspice spfactor.c:880 — `for (I = Step; I <= Size; I++)`.
    for (let i = step; i <= n; i++) {
      const r = this._markowitzRow[i];
      const c = this._markowitzCol[i];
      if ((r > SparseSolver.LARGEST_SHORT_INTEGER && c !== 0) ||
          (c > SparseSolver.LARGEST_SHORT_INTEGER && r !== 0)) {
        const fProduct = r * c;
        if (fProduct >= SparseSolver.LARGEST_LONG_INTEGER)
          this._markowitzProd[i] = SparseSolver.LARGEST_LONG_INTEGER;
        else
          this._markowitzProd[i] = Math.trunc(fProduct);
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
   */
  private _searchForPivot(step: number, diagPivoting: boolean): number {
    let chosenPivot: number;

    /* If singletons exist, look for an acceptable one to use as pivot. */
    if (this._singletons > 0) {
      chosenPivot = this._searchForSingleton(step);
      if (chosenPivot >= 0) {
        return chosenPivot;
      }
    }

    /* DIAGONAL_PIVOTING compile-flag is YES in stock ngspice. */
    if (diagPivoting) {
      chosenPivot = this._quicklySearchDiagonal(step);
      if (chosenPivot >= 0) {
        return chosenPivot;
      }
      chosenPivot = this._searchDiagonal(step);
      if (chosenPivot >= 0) {
        return chosenPivot;
      }
    }

    /* No acceptable pivot found yet, search entire matrix. */
    chosenPivot = this._searchEntireMatrix(step);

    return chosenPivot;
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
    const n = this._size;
    const mProd = this._markowitzProd;

    /* Initialize pointer that is to scan through MarkowitzProduct vector. */
    // ngspice spfactor.c:1051 — `pMarkowitzProduct = &MarkowitzProd[Size+1]`.
    let p = n + 1;
    mProd[n + 1] = mProd[step];

    /* Decrement the count of available singletons, on the assumption that an
     * acceptable one will be found. */
    let singletons = this._singletons--;

    /* Assure that following while loop will always terminate. */
    mProd[step - 1] = 0;

    while (singletons-- > 0) {
      /* Singletons exist, find them. */

      // ngspice spfactor.c:1087 — `while ( *pMarkowitzProduct-- ) {}`.
      while (mProd[p--]) {}
      // ngspice spfactor.c:1095 — `I = (pMarkowitzProduct - MarkowitzProd) + 1`.
      // Post-decrement leaves p one below the zero position; +1 recovers it.
      let i = p + 1;

      /* Assure that I is valid. */
      if (i < step) break;
      if (i > n) i = step;

      /* Singleton has been found in either/both row or/and column I. */
      let chosenPivot = this._diag[i];
      if (chosenPivot >= 0) {
        /* Singleton lies on the diagonal. */
        const pivotMag = Math.abs(this._elVal[chosenPivot]);
        if (pivotMag > this._absThreshold &&
            pivotMag > this._relThreshold *
            this._findBiggestInColExclude(chosenPivot, step))
          return chosenPivot;
      } else {
        /* Singleton does not lie on diagonal, find it. */
        if (this._markowitzCol[i] === 0) {
          chosenPivot = this._colHead[i];
          while ((chosenPivot >= 0) && (this._elRow[chosenPivot] < step))
            chosenPivot = this._elNextInCol[chosenPivot];
          if (chosenPivot >= 0) {
            /* Reduced column has no elements, matrix is singular. */
            break;
          }
          const pivotMag = Math.abs(this._elVal[chosenPivot]);
          if (pivotMag > this._absThreshold &&
              pivotMag > this._relThreshold *
              this._findBiggestInColExclude(chosenPivot, step))
            return chosenPivot;
          else {
            if (this._markowitzRow[i] === 0) {
              chosenPivot = this._rowHead[i];
              while ((chosenPivot >= 0) && (this._elCol[chosenPivot] < step))
                chosenPivot = this._elNextInRow[chosenPivot];
              if (chosenPivot >= 0) {
                /* Reduced row has no elements, matrix is singular. */
                break;
              }
              const pivotMag2 = Math.abs(this._elVal[chosenPivot]);
              if (pivotMag2 > this._absThreshold &&
                  pivotMag2 > this._relThreshold *
                  this._findBiggestInColExclude(chosenPivot, step))
                return chosenPivot;
            }
          }
        } else {
          chosenPivot = this._rowHead[i];
          while ((chosenPivot >= 0) && (this._elCol[chosenPivot] < step))
            chosenPivot = this._elNextInRow[chosenPivot];
          if (chosenPivot >= 0) {
            /* Reduced row has no elements, matrix is singular. */
            break;
          }
          const pivotMag = Math.abs(this._elVal[chosenPivot]);
          if (pivotMag > this._absThreshold &&
              pivotMag > this._relThreshold *
              this._findBiggestInColExclude(chosenPivot, step))
            return chosenPivot;
        }
      }
      /* Singleton not acceptable (too small), try another. */
    } /* end of while(lSingletons>0) */

    /* All singletons were unacceptable.  Restore Matrix->Singletons count. */
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
    const n = this._size;
    const mProd = this._markowitzProd;
    const tiedElements = this._tiedElements;

    /* Begin `QuicklySearchDiagonal'. */
    let numberOfTies = -1;
    let minMarkowitzProduct = SparseSolver.LARGEST_LONG_INTEGER;
    // ngspice spfactor.c:1268 — `pMarkowitzProduct = &MarkowitzProd[Size+2]`.
    let p = n + 2;
    mProd[n + 1] = mProd[step];

    /* Assure that following while loop will always terminate. */
    mProd[step - 1] = -1;

    for (;;) { /* Endless for loop. */
      // ngspice spfactor.c:1294 — `while (MinMarkowitzProduct < *(--pMarkowitzProduct)) {}`.
      while (minMarkowitzProduct < mProd[--p]) {}

      let i = p;

      /* Assure that I is valid; if I < Step, terminate search. */
      if (i < step) break; /* Endless for loop */
      if (i > n) i = step;

      let pDiag: number;
      if ((pDiag = this._diag[i]) < 0)
        continue; /* Endless for loop */
      let magnitude: number;
      if ((magnitude = Math.abs(this._elVal[pDiag])) <= this._absThreshold)
        continue; /* Endless for loop */

      if (mProd[p] === 1) {
        /* Case where only one element exists in row and column other than diagonal. */

        /* Find off diagonal elements. */
        let pOtherInRow = this._elNextInRow[pDiag];
        let pOtherInCol = this._elNextInCol[pDiag];
        if (pOtherInRow < 0 && pOtherInCol < 0) {
          pOtherInRow = this._rowHead[i];
          while (pOtherInRow >= 0) {
            if (this._elCol[pOtherInRow] >= step && this._elCol[pOtherInRow] !== i)
              break;
            pOtherInRow = this._elNextInRow[pOtherInRow];
          }
          pOtherInCol = this._colHead[i];
          while (pOtherInCol >= 0) {
            if (this._elRow[pOtherInCol] >= step && this._elRow[pOtherInCol] !== i)
              break;
            pOtherInCol = this._elNextInCol[pOtherInCol];
          }
        }

        /* Accept diagonal as pivot if diagonal is larger than off diagonals
         * and the off diagonals are placed symmetricly. */
        if (pOtherInRow >= 0 && pOtherInCol >= 0) {
          if (this._elCol[pOtherInRow] === this._elRow[pOtherInCol]) {
            const largestOffDiagonal = Math.max(
              Math.abs(this._elVal[pOtherInRow]),
              Math.abs(this._elVal[pOtherInCol]),
            );
            if (magnitude >= largestOffDiagonal) {
              /* Accept pivot, it is unlikely to contribute excess error. */
              return pDiag;
            }
          }
        }
      }

      if (mProd[p] < minMarkowitzProduct) {
        /* Notice strict inequality in test. This is a new smallest MarkowitzProduct. */
        tiedElements[0] = pDiag;
        minMarkowitzProduct = mProd[p];
        numberOfTies = 0;
      } else {
        /* This case handles Markowitz ties. */
        if (numberOfTies < SparseSolver.MAX_MARKOWITZ_TIES) {
          tiedElements[++numberOfTies] = pDiag;
          if (numberOfTies >= minMarkowitzProduct * SparseSolver.TIES_MULTIPLIER)
            break; /* Endless for loop */
        }
      }
    } /* End of endless for loop. */

    /* Test to see if any element was chosen as a pivot candidate. */
    if (numberOfTies < 0)
      return -1;

    /* Determine which of tied elements is best numerically. */
    let chosenPivot = -1;
    let maxRatio = 1.0 / this._relThreshold;

    for (let i = 0; i <= numberOfTies; i++) {
      const pDiag = tiedElements[i];
      const magnitude = Math.abs(this._elVal[pDiag]);
      const largestInCol = this._findBiggestInColExclude(pDiag, step);
      const ratio = largestInCol / magnitude;
      if (ratio < maxRatio) {
        chosenPivot = pDiag;
        maxRatio = ratio;
      }
    }
    return chosenPivot;
  }

  /**
   * ngspice SearchDiagonal (spfactor.c:1604-1663) — line-for-line port.
   */
  private _searchDiagonal(step: number): number {
    const n = this._size;
    const mProd = this._markowitzProd;
    let numberOfTies = 0;

    /* Begin `SearchDiagonal'. */
    let chosenPivot = -1;
    let minMarkowitzProduct = SparseSolver.LARGEST_LONG_INTEGER;
    // ngspice spfactor.c:1622 — `pMarkowitzProduct = &MarkowitzProd[Size+2]`.
    let p = n + 2;
    mProd[n + 1] = mProd[step];

    let ratioOfAccepted = 0;

    /* Start search of diagonal. */
    // ngspice spfactor.c:1626 — `for (J = Size+1; J > Step; J--)`.
    for (let j = n + 1; j > step; j--) {
      // ngspice spfactor.c:1627 — `if (*(--pMarkowitzProduct) > MinMarkowitzProduct) continue;`.
      if (mProd[--p] > minMarkowitzProduct)
        continue; /* for loop */
      let i: number;
      if (j > n)
        i = step;
      else
        i = j;
      let pDiag: number;
      if ((pDiag = this._diag[i]) < 0)
        continue; /* for loop */
      let magnitude: number;
      if ((magnitude = Math.abs(this._elVal[pDiag])) <= this._absThreshold)
        continue; /* for loop */

      /* Test to see if diagonal's magnitude is acceptable. */
      const largestInCol = this._findBiggestInColExclude(pDiag, step);
      if (magnitude <= this._relThreshold * largestInCol)
        continue; /* for loop */

      if (mProd[p] < minMarkowitzProduct) {
        /* Notice strict inequality in test. This is a new
           smallest MarkowitzProduct. */
        chosenPivot = pDiag;
        minMarkowitzProduct = mProd[p];
        ratioOfAccepted = largestInCol / magnitude;
        numberOfTies = 0;
      } else {
        /* This case handles Markowitz ties. */
        numberOfTies++;
        const ratio = largestInCol / magnitude;
        if (ratio < ratioOfAccepted) {
          chosenPivot = pDiag;
          ratioOfAccepted = ratio;
        }
        if (numberOfTies >= minMarkowitzProduct * SparseSolver.TIES_MULTIPLIER)
          return chosenPivot;
      }
    } /* End of for(Step) */
    return chosenPivot;
  }

  /**
   * ngspice SearchEntireMatrix (spfactor.c:1730-1809) — line-for-line port.
   * Last-resort search across every column in [step, n). Records the largest-
   * magnitude element pre-emptively so the spSMALL_PIVOT fallback returns it
   * when no acceptable pivot meets RelThreshold * LargestInCol.
   */
  private _searchEntireMatrix(step: number): number {
    const n = this._size;
    let numberOfTies = 0;
    let minMarkowitzProduct: number;
    let chosenPivot: number;
    let pLargestElement = -1;
    let largestElementMag: number;
    let ratioOfAccepted = 0;
    const mRow = this._markowitzRow;
    const mCol = this._markowitzCol;

    /* Begin `SearchEntireMatrix'. */
    chosenPivot = -1;
    largestElementMag = 0.0;
    minMarkowitzProduct = SparseSolver.LARGEST_LONG_INTEGER;

    /* Start search of matrix on column by column basis. */
    // ngspice spfactor.c:1749 — `for (I = Step; I <= Size; I++)`.
    for (let i = step; i <= n; i++) {
      let pElement = this._colHead[i];

      while (pElement >= 0 && this._elRow[pElement] < step)
        pElement = this._elNextInCol[pElement];

      let largestInCol: number;
      if ((largestInCol = this._findLargestInCol(pElement)) === 0.0)
        continue; /* for loop */

      while (pElement >= 0) {
        /* Check to see if element is the largest encountered so
           far.  If so, record its magnitude and address. */
        let magnitude: number;
        if ((magnitude = Math.abs(this._elVal[pElement])) > largestElementMag) {
          largestElementMag = magnitude;
          pLargestElement = pElement;
        }
        /* Calculate element's MarkowitzProduct. */
        const product = mRow[this._elRow[pElement]] *
                        mCol[this._elCol[pElement]];

        /* Test to see if element is acceptable as a pivot candidate. */
        if ((product <= minMarkowitzProduct) &&
            (magnitude > this._relThreshold * largestInCol) &&
            (magnitude > this._absThreshold)) {
          /* Test to see if element has lowest MarkowitzProduct
             yet found, or whether it is tied with an element
             found earlier. */
          if (product < minMarkowitzProduct) {
            /* Notice strict inequality in test. This is a new
               smallest MarkowitzProduct. */
            chosenPivot = pElement;
            minMarkowitzProduct = product;
            ratioOfAccepted = largestInCol / magnitude;
            numberOfTies = 0;
          } else {
            /* This case handles Markowitz ties. */
            numberOfTies++;
            const ratio = largestInCol / magnitude;
            if (ratio < ratioOfAccepted) {
              chosenPivot = pElement;
              ratioOfAccepted = ratio;
            }
            if (numberOfTies >= minMarkowitzProduct * SparseSolver.TIES_MULTIPLIER)
              return chosenPivot;
          }
        }
        pElement = this._elNextInCol[pElement];
      }  /* End of while(pElement != NULL) */
    } /* End of for(Step) */

    if (chosenPivot >= 0) return chosenPivot;

    if (largestElementMag === 0.0) {
      this._error = spSINGULAR;
      return -1;
    }

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

    // spfactor.c:2154 — gate Markowitz swap on InternalVectorsAllocated.
    if (this._internalVectorsAllocated) {
      const mr = this._markowitzRow[row1];
      this._markowitzRow[row1] = this._markowitzRow[row2];
      this._markowitzRow[row2] = mr;
    }
    // spfactor.c:2156 — SWAP(ElementPtr, FirstInRow[Row1], FirstInRow[Row2]).
    const fr = this._rowHead[row1];
    this._rowHead[row1] = this._rowHead[row2];
    this._rowHead[row2] = fr;
    // spfactor.c:2157 — SWAP(int, IntToExtRowMap[Row1], IntToExtRowMap[Row2]).
    const ir = this._intToExtRow[row1];
    this._intToExtRow[row1] = this._intToExtRow[row2];
    this._intToExtRow[row2] = ir;
    // spfactor.c:2159-2160 (TRANSLATE always on per amendment A3).
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

    // spfactor.c:2248 — gate Markowitz swap on InternalVectorsAllocated.
    if (this._internalVectorsAllocated) {
      const mc = this._markowitzCol[col1];
      this._markowitzCol[col1] = this._markowitzCol[col2];
      this._markowitzCol[col2] = mc;
    }
    // spfactor.c:2250 — SWAP(ElementPtr, FirstInCol[Col1], FirstInCol[Col2]).
    const fc = this._colHead[col1];
    this._colHead[col1] = this._colHead[col2];
    this._colHead[col2] = fc;
    // spfactor.c:2251 — SWAP(int, IntToExtColMap[Col1], IntToExtColMap[Col2]).
    const ic = this._intToExtCol[col1];
    this._intToExtCol[col1] = this._intToExtCol[col2];
    this._intToExtCol[col2] = ic;
    // spfactor.c:2253-2254 (TRANSLATE always on per amendment A3).
    this._extToIntCol[this._intToExtCol[col1]] = col1;
    this._extToIntCol[this._intToExtCol[col2]] = col2;
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
    // spfactor.c:2313 — while (pElement->Row < Row1).
    while (this._elRow[pElement] < row1) {
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
          // spfactor.c:2330 — while (pElement != NULL && pElement->Row < Row2).
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
          // spfactor.c:2351 — while (pElement->Row < Row2).
          do {
            elementAboveRow2 = pElement;
            pElement = this._elNextInCol[pElement];
          } while (this._elRow[pElement] < row2);

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

      /* Find Element2. */
      if (this._elRow[elementBelowRow1] !== row2) {
        // spfactor.c:2373 — while (pElement->Row < Row2).
        do {
          elementAboveRow2 = pElement;
          pElement = this._elNextInCol[pElement];
        } while (this._elRow[pElement] < row2);

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
    // spfactor.c:2442 — while (pElement->Col < Col1).
    while (this._elCol[pElement] < col1) {
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
          // spfactor.c:2459 — while (pElement != NULL && pElement->Col < Col2).
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
          // spfactor.c:2480 — while (pElement->Col < Col2).
          do {
            elementLeftOfCol2 = pElement;
            pElement = this._elNextInRow[pElement];
          } while (this._elCol[pElement] < col2);

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

      /* Find Element2. */
      if (this._elCol[elementRightOfCol1] !== col2) {
        // spfactor.c:2502 — while (pElement->Col < Col2).
        do {
          elementLeftOfCol2 = pElement;
          pElement = this._elNextInRow[pElement];
        } while (this._elCol[pElement] < col2);

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
    // spfactor.c:1993-1994.
    const row = this._elRow[pivotE];
    const col = this._elCol[pivotE];

    // spfactor.c:1998.
    if (row === step && col === step) return;

    if (row === col) {
      // spfactor.c:2002-2005.
      this._spcRowExchange(step, row);
      this._spcColExchange(step, col);
      const mp = this._markowitzProd[step];
      this._markowitzProd[step] = this._markowitzProd[row];
      this._markowitzProd[row] = mp;
      const dr = this._diag[row];
      this._diag[row] = this._diag[step];
      this._diag[step] = dr;
    } else {
      // spfactor.c:2009-2011.
      const oldStep = this._markowitzProd[step];
      const oldRow = this._markowitzProd[row];
      const oldCol = this._markowitzProd[col];

      // spfactor.c:2014-2028.
      if (row !== step) {
        this._spcRowExchange(step, row);
        // spfactor.c:2016-2017.
        this._numberOfInterchangesIsOdd = !this._numberOfInterchangesIsOdd;
        this._markowitzProd[row] = this._markowitzRow[row] * this._markowitzCol[row];
        if ((this._markowitzProd[row] === 0) !== (oldRow === 0)) {
          if (oldRow === 0) this._singletons--;
          else this._singletons++;
        }
      }

      // spfactor.c:2031-2049.
      if (col !== step) {
        this._spcColExchange(step, col);
        // spfactor.c:2033-2034.
        this._numberOfInterchangesIsOdd = !this._numberOfInterchangesIsOdd;
        this._markowitzProd[col] = this._markowitzCol[col] * this._markowitzRow[col];
        if ((this._markowitzProd[col] === 0) !== (oldCol === 0)) {
          if (oldCol === 0) this._singletons--;
          else this._singletons++;
        }
        // spfactor.c:2046 — Diag[Col] = spcFindElementInCol(..., Col, Col, NO).
        this._diag[col] = this._spcFindElementInCol(col, col, /*createIfMissing=*/ false);
      }
      // spfactor.c:2050-2054.
      if (row !== step) {
        this._diag[row] = this._spcFindElementInCol(row, row, /*createIfMissing=*/ false);
      }
      // spfactor.c:2055-2057.
      this._diag[step] = this._spcFindElementInCol(step, step, /*createIfMissing=*/ false);

      // spfactor.c:2060-2067.
      this._markowitzProd[step] = this._markowitzCol[step] * this._markowitzRow[step];
      if ((this._markowitzProd[step] === 0) !== (oldStep === 0)) {
        if (oldStep === 0) this._singletons--;
        else this._singletons++;
      }
    }
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

    /* Update Markowitz numbers. */
    // ngspice spfactor.c:2724 — `for (ColPtr = pPivot->NextInCol; ...)`.
    for (let colPtr = this._elNextInCol[pivotE]; colPtr >= 0; colPtr = this._elNextInCol[colPtr]) {
      const row = this._elRow[colPtr];
      --mRow[row];

      /* Form Markowitz product while being cautious of overflows. */
      if ((mRow[row] > SparseSolver.LARGEST_SHORT_INTEGER && mCol[row] !== 0) ||
          (mCol[row] > SparseSolver.LARGEST_SHORT_INTEGER && mRow[row] !== 0)) {
        const product = mCol[row] * mRow[row];
        if (product >= SparseSolver.LARGEST_LONG_INTEGER)
          mProd[row] = SparseSolver.LARGEST_LONG_INTEGER;
        else
          mProd[row] = Math.trunc(product);
      } else mProd[row] = mRow[row] * mCol[row];
      if (mRow[row] === 0)
        this._singletons++;
    }

    // ngspice spfactor.c:2741 — `for (RowPtr = pPivot->NextInRow; ...)`.
    for (let rowPtr = this._elNextInRow[pivotE]; rowPtr >= 0; rowPtr = this._elNextInRow[rowPtr]) {
      const col = this._elCol[rowPtr];
      --mCol[col];

      /* Form Markowitz product while being cautious of overflows. */
      if ((mRow[col] > SparseSolver.LARGEST_SHORT_INTEGER && mCol[col] !== 0) ||
          (mCol[col] > SparseSolver.LARGEST_SHORT_INTEGER && mRow[col] !== 0)) {
        const product = mCol[col] * mRow[col];
        if (product >= SparseSolver.LARGEST_LONG_INTEGER)
          mProd[col] = SparseSolver.LARGEST_LONG_INTEGER;
        else
          mProd[col] = Math.trunc(product);
      } else mProd[col] = mRow[col] * mCol[col];
      if ((mCol[col] === 0) && (mRow[col] !== 0))
        this._singletons++;
    }
  }

  /**
   * ngspice LoadGmin (spsmp.c:422-440) — line-for-line port. Gates on
   * `Gmin != 0`; walks `for (I = Size; I > 0; I--)` adding Gmin to each
   * present diagonal element.
   */
  private _loadGmin(gmin: number): void {
    // ngspice spsmp.c:432.
    if (gmin !== 0.0) {
      // ngspice spsmp.c:434-436.
      for (let i = this._size; i > 0; i--) {
        const diag = this._diag[i];
        if (diag >= 0) this._elVal[diag] += gmin;
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
   * ngspice spWhereSingular (spalloc.c:749-762) — line-for-line port. The
   * Error == spSINGULAR || spZERO_DIAG gate (spalloc.c:755-760) forces
   * (0, 0) when the matrix is in any other state, so callers cannot
   * read stale singular-row / singular-col fields outside an active
   * singular state.
   */
  whereSingular(): { row: number; col: number } {
    // ngspice spalloc.c:755-760.
    if (this._error === spSINGULAR || this._error === spZERO_DIAG) {
      return { row: this._singularRow, col: this._singularCol };
    }
    return { row: 0, col: 0 };
  }

}
