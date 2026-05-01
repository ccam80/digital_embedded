/**
 * ComplexSparseSolver- N×N complex sparse LU solver for AC analysis.
 *
 * Architecture: Persistent linked-list matrix format matching ngspice spMatrix,
 * with values stored as parallel _elRe / _elIm Float64Arrays (complex analogue
 * of Wave 0.1 real-side pool).
 *
 * Assembly: allocComplexElement() at compile time, stampComplexElement() in hot path.
 * LU factorization: Markowitz pivot selection on original column order (no AMD).
 * Solve: sparse forward/backward substitution on CSC L/U built from linked structure.
 *
 * ngspice references:
 *   spGetElement (spbuild.c)- complex variant, cached-pointer pattern
 *   spOrderAndFactor (spfactor.c)- factorWithReorder (complex variant)
 *   spFactor (spfactor.c)- factorNumerical (complex variant)
 *   spSolve (spsolve.c)- solve (complex variant)
 *   SMPpreOrder (sputils.c)- preorder
 */

/**
 * Minimal structural interface for the complex (AC-analysis) sparse solver,
 * exposing only the subset of methods used by element.stampAc() bodies.
 *
 * Parallel to `SparseSolverStamp` (real-side). The `ComplexSparseSolver`
 * class below `implements` this interface and ships a much larger surface
 * for assembly, factorization, and solve.
 */
export interface ComplexSparseSolverStamp {
  stampRHS(row: number, re: number, im: number): void;
  allocComplexElement(row: number, col: number): number;
  stampComplexElement(handle: number, re: number, im: number): void;
}

/**
 * Default pivot thresholds for complex factorization.
 * ngspice spConfig.h:331 DEFAULT_THRESHOLD = 1e-3 (RelThreshold).
 * Complex path uses the same RelThreshold field- no separate complex default.
 * AbsThreshold default is 0.0; abs threshold comparisons use absThreshold² (mag² compare).
 *
 * ngspice variable mapping:
 *   DEFAULT_THRESHOLD (spConfig.h:331) → DEFAULT_PIVOT_REL_THRESHOLD_COMPLEX
 *   AbsThreshold default 0.0           → DEFAULT_PIVOT_ABS_THRESHOLD_COMPLEX
 */
const DEFAULT_PIVOT_REL_THRESHOLD_COMPLEX = 1e-3;
const DEFAULT_PIVOT_ABS_THRESHOLD_COMPLEX = 0.0;

// Bit flag stored in _elFlags to distinguish fill-in entries from A-matrix entries.
const FLAG_FILL_IN = 1;

export class ComplexSparseSolver implements ComplexSparseSolverStamp {
  // =========================================================================
  // Persistent linked-list element pool (complex values in parallel arrays)
  // =========================================================================
  // ngspice variable mapping:
  //   Element->Row        → _elRow[e]
  //   Element->Col        → _elCol[e]
  //   Element->Real       → _elRe[e]
  //   Element->Imag       → _elIm[e]
  //   Element->NextInRow  → _elNextInRow[e]
  //   Element->NextInCol  → _elNextInCol[e]

  private _elRow: Int32Array = new Int32Array(0);
  private _elCol: Int32Array = new Int32Array(0);
  private _elRe: Float64Array = new Float64Array(0);
  private _elIm: Float64Array = new Float64Array(0);
  private _elFlags: Uint8Array = new Uint8Array(0);
  private _elNextInRow: Int32Array = new Int32Array(0);
  private _elPrevInRow: Int32Array = new Int32Array(0);
  private _elNextInCol: Int32Array = new Int32Array(0);
  private _elPrevInCol: Int32Array = new Int32Array(0);

  /** CSC L-array index for element e (-1 if not in L). */
  private _lValueIndex: Int32Array = new Int32Array(0);
  /** CSC U-array index for element e (-1 if not in U). */
  private _uValueIndex: Int32Array = new Int32Array(0);

  /** Reverse maps: CSC position p → pool element index (-1 if none). */
  private _lCscToElem: Int32Array = new Int32Array(0);
  private _uCscToElem: Int32Array = new Int32Array(0);

  /** First element in row r (-1 = empty). Length n. */
  private _rowHead: Int32Array = new Int32Array(0);
  /** First element in column c (-1 = empty). Length n. */
  private _colHead: Int32Array = new Int32Array(0);
  /** Element index of diagonal (r,r) or -1. Length n. */
  private _diag: Int32Array = new Int32Array(0);

  /**
   * Preorder column permutation: _preorderComplexColPerm[internalCol] = originalCol.
   * Identity initially. Updated by _swapComplexColumns during preorder().
   * solve() maps internal column k → original column _preorderComplexColPerm[k].
   */
  private _preorderComplexColPerm: Int32Array = new Int32Array(0);

  /**
   * Inverse: _extToIntComplexCol[originalCol] = internalCol.
   * Updated by _swapComplexColumns in lockstep with _preorderComplexColPerm.
   */
  private _extToIntComplexCol: Int32Array = new Int32Array(0);

  /** Next free slot in pool (when no free-list entry). */
  private _elCount: number = 0;
  private _elCapacity: number = 0;
  private _elFreeHead: number = -1;

  // =========================================================================
  // Handle lookup table for allocComplexElement fast-path
  // =========================================================================
  private _handleTable: Int32Array = new Int32Array(0);
  private _handleTableN: number = 0;

  // =========================================================================
  // RHS (complex)
  // =========================================================================
  private _rhsRe: Float64Array = new Float64Array(0);
  private _rhsIm: Float64Array = new Float64Array(0);

  // =========================================================================
  // Dimension
  // =========================================================================
  private _size = 0;

  // =========================================================================
  // CSC L/U for forward/backward substitution (complex)
  // =========================================================================
  private _lColPtr: Int32Array = new Int32Array(0);
  private _lRowIdx: Int32Array = new Int32Array(0);
  private _lRe: Float64Array = new Float64Array(0);
  private _lIm: Float64Array = new Float64Array(0);

  private _uColPtr: Int32Array = new Int32Array(0);
  private _uRowIdx: Int32Array = new Int32Array(0);
  private _uRe: Float64Array = new Float64Array(0);
  private _uIm: Float64Array = new Float64Array(0);

  // =========================================================================
  // Pivot permutation
  // =========================================================================
  private _pinv: Int32Array = new Int32Array(0);
  private _q: Int32Array = new Int32Array(0);

  // =========================================================================
  // Dense complex workspace for factorization
  // =========================================================================
  private _xRe: Float64Array = new Float64Array(0);
  private _xIm: Float64Array = new Float64Array(0);
  private _xNzIdx: Int32Array = new Int32Array(0);

  // =========================================================================
  // DFS reach workspace
  // =========================================================================
  private _reachStack: Int32Array = new Int32Array(0);
  private _dfsStack: Int32Array = new Int32Array(0);
  private _dfsChildPtr: Int32Array = new Int32Array(0);
  private _reachMark: Int32Array = new Int32Array(0);

  // =========================================================================
  // Scratch for solve (complex)
  // =========================================================================
  private _scratchRe: Float64Array = new Float64Array(0);
  private _scratchIm: Float64Array = new Float64Array(0);

  // =========================================================================
  // Markowitz pivot selection data
  // =========================================================================
  private _markowitzRow: Int32Array = new Int32Array(0);
  private _markowitzCol: Int32Array = new Int32Array(0);
  private _markowitzProd: Float64Array = new Float64Array(0);
  private _singletons: number = 0;

  // Fill-in detection marker: _elMark[row] = column of last mark.
  private _elMark: Int32Array = new Int32Array(0);

  // Dense row→element map for the current column during LU factorization.
  private _rowToElem: Int32Array = new Int32Array(0);

  // =========================================================================
  // State flags
  // =========================================================================
  private _needsReorderComplex: boolean = false;
  private _didPreorderComplex: boolean = false;
  private _hasComplexPivotOrder: boolean = false;
  private _structureEmpty: boolean = true;
  private _workspaceN: number = -1;

  /**
   * Relative pivot threshold for complex factorization.
   * Default from DEFAULT_PIVOT_REL_THRESHOLD_COMPLEX; callers override via
   * setComplexPivotTolerances() to mirror CKTpivotRelTol plumbed through
   * SMPreorder (spfactor.c). ngspice: Matrix->RelThreshold.
   */
  private _relThresholdComplex: number = DEFAULT_PIVOT_REL_THRESHOLD_COMPLEX;

  /**
   * Absolute pivot threshold for complex factorization.
   * Default from DEFAULT_PIVOT_ABS_THRESHOLD_COMPLEX; callers override via
   * setComplexPivotTolerances() to mirror CKTpivotAbsTol plumbed through
   * SMPluFac (spfactor.c). ngspice: Matrix->AbsThreshold.
   */
  private _absThresholdComplex: number = DEFAULT_PIVOT_ABS_THRESHOLD_COMPLEX;

  /** True when the most recent factor() call dispatched to full reorder. */
  lastFactorUsedReorder: boolean = false;

  // =========================================================================
  // Public stamp API
  // =========================================================================

  /**
   * Allocate or find the element at (row, col) in the persistent complex linked structure.
   * Returns a stable handle (pool index) for use with stampComplexElement().
   *
   * Called at compile time. Idempotent per (row, col) per solver instance.
   * ngspice: spGetElement (spbuild.c)- complex variant.
   */
  allocComplexElement(row: number, col: number): number {
    // Fast path: handle table lookup
    if (this._size > 0 && this._size <= this._handleTableN) {
      const idx = row * this._handleTableN + col;
      const stored = this._handleTable[idx];
      if (stored > 0) return stored - 1;
    }

    const internalCol = this._extToIntComplexCol[col];

    // Check whether this (row, col) already exists in the column chain
    let e = this._colHead[internalCol];
    while (e >= 0) {
      if (this._elRow[e] === row) {
        if (this._size <= this._handleTableN) {
          this._handleTable[row * this._handleTableN + col] = e + 1;
        }
        return e;
      }
      e = this._elNextInCol[e];
    }

    // Allocate new element
    const newE = this._newElement(row, col, 0, 0, 0);
    this._insertIntoRow(newE, row);
    this._insertIntoCol(newE, internalCol);
    if (row === col) this._diag[internalCol] = newE;
    // ngspice spbuild.c:788: NeedsOrdering = YES when a new element is inserted.
    this._needsReorderComplex = true;

    if (this._size <= this._handleTableN) {
      this._handleTable[row * this._handleTableN + col] = newE + 1;
    }

    return newE;
  }

  /**
   * Accumulate complex value onto element at handle. O(1) unconditional.
   * Called in the hot path.
   * ngspice: *ElementPtr += value (complex variant)
   */
  stampComplexElement(handle: number, re: number, im: number): void {
    this._elRe[handle] += re;
    this._elIm[handle] += im;
  }

  /** Add a complex value to position (row) of the RHS vector. */
  stampRHS(row: number, re: number, im: number): void {
    this._rhsRe[row] += re;
    this._rhsIm[row] += im;
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * Begin a new assembly pass.
   *
   * On the very first assembly (or after invalidateTopology()), the linked
   * structure is empty and allocComplexElement() calls build it on demand.
   *
   * On subsequent passes (steady state), zeros all A-entry element re/im values
   * and removes fill-in entries via chain walk, preserving the linked structure.
   * Zero allocations in steady state.
   */
  beginAssembly(n: number): void {
    if (n !== this._size) {
      this._size = n;
      this._structureEmpty = true;
    }

    if (this._structureEmpty) {
      this._initStructure();
    } else {
      this._resetForAssembly();
    }

    // Zero RHS
    this._rhsRe.fill(0, 0, this._size);
    this._rhsIm.fill(0, 0, this._size);

    // Reset Markowitz arrays
    if (this._markowitzRow.length !== n) {
      this._markowitzRow = new Int32Array(n);
      this._markowitzCol = new Int32Array(n);
      this._markowitzProd = new Float64Array(n);
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
    const n = this._size;
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
  }

  /**
   * Factor the assembled complex matrix.
   * Dispatches to full reorder or numeric-only based on state flags.
   */
  factor(): boolean {
    if (this._needsReorderComplex || !this._hasComplexPivotOrder) {
      this.lastFactorUsedReorder = true;
      return this._factorWithReorder();
    }
    this.lastFactorUsedReorder = false;
    return this._factorNumerical();
  }

  /**
   * Force full pivot search on next factor() call.
   * ngspice: NISHOULDREORDER trigger.
   */
  forceReorder(): void {
    this._needsReorderComplex = true;
  }

  /**
   * Override per-instance pivot tolerances for complex factorization.
   * Mirrors the real-solver setPivotTolerances() pattern.
   * ngspice: CKTpivotRelTol → SMPreorder RelThreshold (spfactor.c),
   *          CKTpivotAbsTol → SMPluFac AbsThreshold (spfactor.c).
   */
  setComplexPivotTolerances(relThreshold: number, absThreshold: number): void {
    if (relThreshold > 0 && relThreshold <= 1) this._relThresholdComplex = relThreshold;
    if (absThreshold >= 0) this._absThresholdComplex = absThreshold;
  }

  /**
   * Solve the assembled complex system.
   * On return, xRe[i] and xIm[i] contain the solution at index i.
   *
   * Permutation:
   *   1. Apply pivot row permutation: b[k] = rhs[q[k]]
   *   2. Sparse complex forward sub (L, unit lower triangular CSC)
   *   3. Sparse complex backward sub (U, upper triangular CSC)
   *   4. Apply preorder inverse permutation: x[_preorderComplexColPerm[k]] = b[k]
   */
  solve(xRe: Float64Array, xIm: Float64Array): void {
    const n = this._size;
    if (n === 0) return;

    const pinv = this._pinv;
    const q = this._q;
    const bRe = this._scratchRe;
    const bIm = this._scratchIm;

    // Step 1: Apply pivot row permutation to RHS: b[k] = rhs[q[k]]
    for (let k = 0; k < n; k++) {
      const origRow = q[k];
      bRe[k] = this._rhsRe[origRow];
      bIm[k] = this._rhsIm[origRow];
    }

    // Step 2: Sparse complex forward sub (L, unit lower triangular CSC)
    for (let j = 0; j < n; j++) {
      const p0 = this._lColPtr[j];
      const p1 = this._lColPtr[j + 1];
      const bjRe = bRe[j];
      const bjIm = bIm[j];
      for (let p = p0; p < p1; p++) {
        const step = pinv[this._lRowIdx[p]];
        const lRe = this._lRe[p];
        const lIm = this._lIm[p];
        bRe[step] -= lRe * bjRe - lIm * bjIm;
        bIm[step] -= lRe * bjIm + lIm * bjRe;
      }
    }

    // Step 3: Sparse complex backward sub (U, upper triangular CSC)
    for (let j = n - 1; j >= 0; j--) {
      const p0 = this._uColPtr[j];
      const p1 = this._uColPtr[j + 1];
      // Diagonal is last entry: complex division b[j] /= U_diag
      const dRe = this._uRe[p1 - 1];
      const dIm = this._uIm[p1 - 1];
      const dMag2 = dRe * dRe + dIm * dIm;
      const tmpRe = (bRe[j] * dRe + bIm[j] * dIm) / dMag2;
      const tmpIm = (bIm[j] * dRe - bRe[j] * dIm) / dMag2;
      bRe[j] = tmpRe;
      bIm[j] = tmpIm;

      for (let p = p0; p < p1 - 1; p++) {
        const step = pinv[this._uRowIdx[p]];
        const uRe = this._uRe[p];
        const uIm = this._uIm[p];
        bRe[step] -= uRe * tmpRe - uIm * tmpIm;
        bIm[step] -= uRe * tmpIm + uIm * tmpRe;
      }
    }

    // Step 4: Apply preorder inverse permutation
    const pcp = this._preorderComplexColPerm;
    for (let k = 0; k < n; k++) {
      xRe[pcp[k]] = bRe[k];
      xIm[pcp[k]] = bIm[k];
    }
  }

  invalidateTopology(): void {
    this._structureEmpty = true;
    this._hasComplexPivotOrder = false;
    this._didPreorderComplex = false;
    // ngspice spStripMatrix (sputils.c:1112): NeedsOrdering = YES.
    this._needsReorderComplex = true;
  }

  /**
   * One-time static column permutation to eliminate structural zeros on diagonal.
   * Finds symmetric twin pairs (J,R) and (R,J) where re²+im²===1 and diagonal at J
   * is zero, then swaps columns J and R.
   * ngspice: SMPpreOrder (sputils.c:177-301), complex variant.
   * Magnitude check: re*re + im*im === 1.0 to match ngspice |value| === 1.0.
   */
  preorder(): void {
    if (this._didPreorderComplex) return;
    this._didPreorderComplex = true;

    // ngspice monotonically-advancing StartAt cursor to avoid swap oscillation.
    let startAt = 0;
    let didSwap = true;
    while (didSwap) {
      didSwap = false;
      for (let col = startAt; col < this._size; col++) {
        const diagE = this._diag[col];
        if (diagE >= 0) {
          const dRe = this._elRe[diagE];
          const dIm = this._elIm[diagE];
          if (dRe !== 0 || dIm !== 0) continue;
        }

        // Walk column col looking for pTwin1 at (row, col) with re²+im²===1.0
        let el = this._colHead[col];
        while (el >= 0) {
          const eRe = this._elRe[el];
          const eIm = this._elIm[el];
          if (eRe * eRe + eIm * eIm === 1.0) {
            const row = this._elRow[el];
            const pTwin2 = this._findComplexTwin(row, col);
            if (pTwin2 >= 0) {
              this._swapComplexColumns(col, row, el, pTwin2);
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
   * Locate the element in column `col` at row `targetRow` with re²+im²===1.0.
   * Returns the element handle, or -1 if no such entry exists.
   */
  private _findComplexTwin(col: number, targetRow: number): number {
    let el = this._colHead[col];
    while (el >= 0) {
      if (this._elRow[el] === targetRow) {
        const eRe = this._elRe[el];
        const eIm = this._elIm[el];
        if (eRe * eRe + eIm * eIm === 1.0) return el;
      }
      el = this._elNextInCol[el];
    }
    return -1;
  }

  /**
   * Swap columns col1 and col2 in the persistent complex linked structure.
   * pTwin1 is the element at (col2, col1); pTwin2 is the element at (col1, col2).
   * ngspice reference: sputils.c SwapCols (lines 283-301).
   */
  private _swapComplexColumns(col1: number, col2: number, pTwin1: number, pTwin2: number): void {
    const tmpHead = this._colHead[col1];
    this._colHead[col1] = this._colHead[col2];
    this._colHead[col2] = tmpHead;

    const origCol1 = this._preorderComplexColPerm[col1];
    const origCol2 = this._preorderComplexColPerm[col2];
    this._preorderComplexColPerm[col1] = origCol2;
    this._preorderComplexColPerm[col2] = origCol1;
    this._extToIntComplexCol[origCol1] = col2;
    this._extToIntComplexCol[origCol2] = col1;

    this._diag[col1] = pTwin2;
    this._diag[col2] = pTwin1;
  }

  // =========================================================================
  // Internal: structure initialization
  // =========================================================================

  private _initStructure(): void {
    const n = this._size;
    this._rhsRe = new Float64Array(n);
    this._rhsIm = new Float64Array(n);

    const elCap = Math.max(n * 4, 64);
    this._elRow = new Int32Array(elCap);
    this._elCol = new Int32Array(elCap);
    this._elRe = new Float64Array(elCap);
    this._elIm = new Float64Array(elCap);
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
    this._preorderComplexColPerm = new Int32Array(n);
    this._extToIntComplexCol = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      this._preorderComplexColPerm[i] = i;
      this._extToIntComplexCol[i] = i;
    }
    this._elMark = new Int32Array(n).fill(-1);
    this._rowToElem = new Int32Array(n).fill(-1);

    // Handle table for O(1) allocComplexElement lookup
    this._handleTableN = n;
    this._handleTable = new Int32Array(n * n);

    // Factor workspace
    this._xRe = new Float64Array(n);
    this._xIm = new Float64Array(n);
    this._xNzIdx = new Int32Array(n);
    this._reachStack = new Int32Array(n);
    this._dfsStack = new Int32Array(n);
    this._dfsChildPtr = new Int32Array(n);
    this._reachMark = new Int32Array(n).fill(-1);
    this._pinv = new Int32Array(n);
    this._q = new Int32Array(n);
    this._scratchRe = new Float64Array(n);
    this._scratchIm = new Float64Array(n);

    const alloc = Math.max(n * 6, 32);
    this._lColPtr = new Int32Array(n + 1);
    this._lRowIdx = new Int32Array(alloc);
    this._lRe = new Float64Array(alloc);
    this._lIm = new Float64Array(alloc);
    this._lCscToElem = new Int32Array(alloc).fill(-1);
    this._uColPtr = new Int32Array(n + 1);
    this._uRowIdx = new Int32Array(alloc);
    this._uRe = new Float64Array(alloc);
    this._uIm = new Float64Array(alloc);
    this._uCscToElem = new Int32Array(alloc).fill(-1);

    this._markowitzRow = new Int32Array(n);
    this._markowitzCol = new Int32Array(n);
    this._markowitzProd = new Float64Array(n);

    this._structureEmpty = false;
    this._hasComplexPivotOrder = false;
    this._needsReorderComplex = false;
  }

  /**
   * Reset for a new assembly pass: zero A-entry complex values, remove fill-in
   * entries via chain walk, preserve linked structure topology.
   * Zero allocations- fill-in entries are returned to the free-list.
   */
  private _resetForAssembly(): void {
    const n = this._size;

    for (let col = 0; col < n; col++) {
      let e = this._colHead[col];
      while (e >= 0) {
        const next = this._elNextInCol[e];
        if (this._elFlags[e] & FLAG_FILL_IN) {
          this._removeFromRow(e);
          this._removeFromCol(e);
          this._elNextInRow[e] = this._elFreeHead;
          this._elFreeHead = e;
          const r = this._elRow[e];
          if (r === col && this._diag[r] === e) this._diag[r] = -1;
        } else {
          this._elRe[e] = 0;
          this._elIm[e] = 0;
        }
        e = next;
      }
    }
  }

  // =========================================================================
  // Internal: element pool operations
  // =========================================================================

  private _newElement(row: number, col: number, re: number, im: number, flags: number): number {
    let e: number;
    if (this._elFreeHead >= 0) {
      e = this._elFreeHead;
      this._elFreeHead = this._elNextInRow[e];
    } else {
      if (this._elCount >= this._elCapacity) this._growElements();
      e = this._elCount++;
    }
    this._elRow[e] = row;
    this._elCol[e] = col;
    this._elRe[e] = re;
    this._elIm[e] = im;
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
    else this._colHead[this._extToIntComplexCol[this._elCol[e]]] = next;
    if (next >= 0) this._elPrevInCol[next] = prev;
  }

  private _growElements(): void {
    const newCap = Math.max(this._elCapacity * 2, 64);
    const growI = (old: Int32Array, fillVal?: number): Int32Array => {
      const a = new Int32Array(newCap);
      a.set(old);
      if (fillVal !== undefined) {
        for (let i = old.length; i < newCap; i++) a[i] = fillVal;
      }
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
    this._elRe = growF(this._elRe);
    this._elIm = growF(this._elIm);
    this._elFlags = growU(this._elFlags);
    this._elNextInRow = growI(this._elNextInRow);
    this._elPrevInRow = growI(this._elPrevInRow);
    this._elNextInCol = growI(this._elNextInCol);
    this._elPrevInCol = growI(this._elPrevInCol);
    this._lValueIndex = growI(this._lValueIndex, -1);
    this._uValueIndex = growI(this._uValueIndex, -1);
    this._elCapacity = newCap;
  }

  // =========================================================================
  // Workspace allocation (called at reorder time)
  // =========================================================================

  private _allocateComplexWorkspace(): void {
    const n = this._size;
    if (n === 0) return;
    if (n === this._workspaceN) return;
    this._workspaceN = n;

    this._xRe = new Float64Array(n);
    this._xIm = new Float64Array(n);
    this._xNzIdx = new Int32Array(n);
    this._reachStack = new Int32Array(n);
    this._dfsStack = new Int32Array(n);
    this._dfsChildPtr = new Int32Array(n);
    this._reachMark = new Int32Array(n);
    this._reachMark.fill(-1);
    this._pinv = new Int32Array(n);
    this._q = new Int32Array(n);
    this._scratchRe = new Float64Array(n);
    this._scratchIm = new Float64Array(n);
    this._elMark = new Int32Array(n).fill(-1);
    this._rowToElem = new Int32Array(n).fill(-1);

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
    this._lRe = new Float64Array(alloc);
    this._lIm = new Float64Array(alloc);
    this._lCscToElem = new Int32Array(alloc).fill(-1);
    this._uColPtr = new Int32Array(n + 1);
    this._uRowIdx = new Int32Array(alloc);
    this._uRe = new Float64Array(alloc);
    this._uIm = new Float64Array(alloc);
    this._uCscToElem = new Int32Array(alloc).fill(-1);
  }

  // =========================================================================
  // DFS reach through L's column structure
  // =========================================================================

  private _reach(k: number): number {
    const n = this._size;
    const pinv = this._pinv;
    const mark = this._reachMark;
    const stack = this._reachStack;
    const dfs = this._dfsStack;
    const childPtr = this._dfsChildPtr;
    let top = n;

    // Seed DFS from each A-matrix nonzero row of column k (internal order)
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
  // Numeric LU factorization with Markowitz pivot selection (complex)
  // =========================================================================

  private _numericLUMarkowitz(): boolean {
    const n = this._size;
    if (n === 0) return true;

    const xRe = this._xRe;
    const xIm = this._xIm;
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

      // Scatter column k into dense workspace; build row→element map
      let xNzCount = 0;
      let ae = this._colHead[k];
      while (ae >= 0) {
        const row = this._elRow[ae];
        rowToElem[row] = ae;
        this._elMark[row] = k;
        if (!(this._elFlags[ae] & FLAG_FILL_IN)) {
          if (xRe[row] === 0 && xIm[row] === 0) xNzIdx[xNzCount++] = row;
          xRe[row] += this._elRe[ae];
          xIm[row] += this._elIm[ae];
        }
        ae = this._elNextInCol[ae];
      }

      // Sparse triangular solve: x -= L[:,j] * x[q[j]] for each j in reach(k)
      const reachTop = this._reach(k);
      const reachStack = this._reachStack;
      for (let ri = reachTop; ri < n; ri++) {
        const j = reachStack[ri];
        const qj = q[j];
        const xqjRe = xRe[qj];
        const xqjIm = xIm[qj];
        if (xqjRe === 0 && xqjIm === 0) continue;

        const ljp0 = this._lColPtr[j];
        const ljp1 = this._lColPtr[j + 1];
        for (let lp = ljp0; lp < ljp1; lp++) {
          const li = this._lRowIdx[lp];
          if (xRe[li] === 0 && xIm[li] === 0) xNzIdx[xNzCount++] = li;
          const lRe = this._lRe[lp];
          const lIm = this._lIm[lp];
          xRe[li] -= lRe * xqjRe - lIm * xqjIm;
          xIm[li] -= lRe * xqjIm + lIm * xqjRe;
        }
      }

      // Insert fill-in elements for unpivoted rows not yet in column k
      let hadFillin = false;
      const origColK = this._preorderComplexColPerm[k];
      for (let idx = 0; idx < xNzCount; idx++) {
        const i = xNzIdx[idx];
        if ((xRe[i] === 0 && xIm[i] === 0) || pinv[i] >= 0) continue;
        if (this._elMark[i] === k) continue;
        const fe = this._newElement(i, origColK, 0, 0, FLAG_FILL_IN);
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

      // Markowitz pivot selection
      const pivotRow = this._searchForComplexPivot(k, xRe, xIm, xNzIdx, xNzCount, pinv);

      if (pivotRow < 0) {
        for (let idx = 0; idx < xNzCount; idx++) {
          xRe[xNzIdx[idx]] = 0;
          xIm[xNzIdx[idx]] = 0;
        }
        return false;
      }

      pinv[pivotRow] = k;
      q[k] = pivotRow;

      const diagRe = xRe[pivotRow];
      const diagIm = xIm[pivotRow];
      const diagMag2 = diagRe * diagRe + diagIm * diagIm;
      const absT = this._absThresholdComplex;
      if (diagMag2 < absT * absT) {
        for (let idx = 0; idx < xNzCount; idx++) {
          xRe[xNzIdx[idx]] = 0;
          xIm[xNzIdx[idx]] = 0;
        }
        return false;
      }

      // Update Markowitz numbers
      if (k < n - 1) {
        this._updateComplexMarkowitzNumbers(k, pivotRow, pinv);
      }

      // Store U entries (already-pivoted rows + diagonal)
      for (let idx = 0; idx < xNzCount; idx++) {
        const i = xNzIdx[idx];
        const re = xRe[i], im = xIm[i];
        if (re === 0 && im === 0) continue;
        const s = pinv[i];
        if (s >= 0 && s < k) {
          let ue = -1;
          if (this._elMark[i] === k) ue = rowToElem[i];
          this._uCscToElem[unz] = ue;
          if (ue >= 0) {
            this._uValueIndex[ue] = unz;
            this._elRe[ue] = re;
            this._elIm[ue] = im;
          }
          this._uRowIdx[unz] = i;
          this._uRe[unz] = re;
          this._uIm[unz] = im;
          unz++;
        }
      }
      let diagElem = -1;
      if (this._elMark[pivotRow] === k) diagElem = rowToElem[pivotRow];
      this._uCscToElem[unz] = diagElem;
      if (diagElem >= 0) {
        this._uValueIndex[diagElem] = unz;
        this._elRe[diagElem] = diagRe;
        this._elIm[diagElem] = diagIm;
      }
      this._uRowIdx[unz] = pivotRow;
      this._uRe[unz] = diagRe;
      this._uIm[unz] = diagIm;
      unz++;

      // Store L entries (unpivoted rows, scaled by 1/diagonal)
      for (let idx = 0; idx < xNzCount; idx++) {
        const i = xNzIdx[idx];
        const re = xRe[i], im = xIm[i];
        if (re === 0 && im === 0) continue;
        if (pinv[i] >= 0) continue;
        // L[i] = x[i] / diag = x[i] * conj(diag) / |diag|^2
        const lRe = (re * diagRe + im * diagIm) / diagMag2;
        const lIm = (im * diagRe - re * diagIm) / diagMag2;
        let le = -1;
        if (this._elMark[i] === k) le = rowToElem[i];
        this._lCscToElem[lnz] = le;
        if (le >= 0) {
          this._lValueIndex[le] = lnz;
          this._elRe[le] = lRe;
          this._elIm[le] = lIm;
        }
        this._lRowIdx[lnz] = i;
        this._lRe[lnz] = lRe;
        this._lIm[lnz] = lIm;
        lnz++;
      }

      for (let idx = 0; idx < xNzCount; idx++) {
        xRe[xNzIdx[idx]] = 0;
        xIm[xNzIdx[idx]] = 0;
      }
    }

    this._lColPtr[n] = lnz;
    this._uColPtr[n] = unz;

    return true;
  }

  /**
   * Numeric LU factorization reusing pivot order from prior factorWithReorder call.
   * Scatters values directly into existing CSC positions via _lValueIndex/_uValueIndex.
   * Zero linked-list operations in this hot path.
   * ngspice: spFactor (spfactor.c), complex variant.
   */
  private _numericLUReusePivots(): boolean {
    const n = this._size;
    if (n === 0) return true;

    const xRe = this._xRe;
    const xIm = this._xIm;
    const xNzIdx = this._xNzIdx;
    const q = this._q;
    const elRe = this._elRe;
    const elIm = this._elIm;
    const elRow = this._elRow;
    const lCscToElem = this._lCscToElem;
    const uCscToElem = this._uCscToElem;

    const lnzTotal = this._lColPtr[n];
    const unzTotal = this._uColPtr[n];
    for (let i = 0; i < lnzTotal; i++) { this._lRe[i] = 0; this._lIm[i] = 0; }
    for (let i = 0; i < unzTotal; i++) { this._uRe[i] = 0; this._uIm[i] = 0; }

    this._reachMark.fill(-1);

    for (let k = 0; k < n; k++) {
      // Scatter A-matrix values for column k via colHead chain
      let xNzCount = 0;
      let ae = this._colHead[k];
      while (ae >= 0) {
        if (!(this._elFlags[ae] & FLAG_FILL_IN)) {
          const row = elRow[ae];
          if (xRe[row] === 0 && xIm[row] === 0) xNzIdx[xNzCount++] = row;
          xRe[row] += elRe[ae];
          xIm[row] += elIm[ae];
        }
        ae = this._elNextInCol[ae];
      }

      const reachTop = this._reach(k);
      const reachStack = this._reachStack;
      for (let ri = reachTop; ri < n; ri++) {
        const j = reachStack[ri];
        const qj = q[j];
        const xqjRe = xRe[qj];
        const xqjIm = xIm[qj];
        if (xqjRe === 0 && xqjIm === 0) continue;

        const ljp0 = this._lColPtr[j];
        const ljp1 = this._lColPtr[j + 1];
        for (let lp = ljp0; lp < ljp1; lp++) {
          const li = this._lRowIdx[lp];
          if (xRe[li] === 0 && xIm[li] === 0) xNzIdx[xNzCount++] = li;
          const lRe = this._lRe[lp];
          const lIm = this._lIm[lp];
          xRe[li] -= lRe * xqjRe - lIm * xqjIm;
          xIm[li] -= lRe * xqjIm + lIm * xqjRe;
        }
      }

      const pivotRow = q[k];
      const diagRe = xRe[pivotRow];
      const diagIm = xIm[pivotRow];
      const diagMag2 = diagRe * diagRe + diagIm * diagIm;
      const absT2 = this._absThresholdComplex;
      if (diagMag2 < absT2 * absT2) {
        for (let idx = 0; idx < xNzCount; idx++) {
          xRe[xNzIdx[idx]] = 0;
          xIm[xNzIdx[idx]] = 0;
        }
        return false;
      }

      // U scatter
      for (let p = this._uColPtr[k]; p < this._uColPtr[k + 1]; p++) {
        const i = this._uRowIdx[p];
        const re = xRe[i], im = xIm[i];
        this._uRe[p] = re;
        this._uIm[p] = im;
        const ue = uCscToElem[p];
        if (ue >= 0) { elRe[ue] = re; elIm[ue] = im; }
      }

      // L scatter
      for (let p = this._lColPtr[k]; p < this._lColPtr[k + 1]; p++) {
        const i = this._lRowIdx[p];
        const re = xRe[i], im = xIm[i];
        const lRe = (re * diagRe + im * diagIm) / diagMag2;
        const lIm = (im * diagRe - re * diagIm) / diagMag2;
        this._lRe[p] = lRe;
        this._lIm[p] = lIm;
        const le = lCscToElem[p];
        if (le >= 0) { elRe[le] = lRe; elIm[le] = lIm; }
      }

      for (let idx = 0; idx < xNzCount; idx++) {
        xRe[xNzIdx[idx]] = 0;
        xIm[xNzIdx[idx]] = 0;
      }
    }

    return true;
  }

  /**
   * Snapshot pool → CSC: walk the element pool once and copy _elRe[e]/_elIm[e]
   * into the CSC L/U arrays via _lValueIndex[e]/_uValueIndex[e].
   */
  private _buildCSCFromLinked(): void {
    const elCount = this._elCount;
    const lValueIndex = this._lValueIndex;
    const uValueIndex = this._uValueIndex;
    const elRe = this._elRe;
    const elIm = this._elIm;
    const lRe = this._lRe;
    const lIm = this._lIm;
    const uRe = this._uRe;
    const uIm = this._uIm;
    for (let e = 0; e < elCount; e++) {
      const li = lValueIndex[e];
      if (li >= 0) { lRe[li] = elRe[e]; lIm[li] = elIm[e]; }
      const ui = uValueIndex[e];
      if (ui >= 0) { uRe[ui] = elRe[e]; uIm[ui] = elIm[e]; }
    }
  }

  // =========================================================================
  // Factorization
  // =========================================================================

  private _factorWithReorder(): boolean {
    if (this._needsReorderComplex) {
      this._allocateComplexWorkspace();
      this._needsReorderComplex = false;
    }
    const ok = this._numericLUMarkowitz();
    if (ok) {
      this._hasComplexPivotOrder = true;
      this._buildCSCFromLinked();
    }
    return ok;
  }

  private _factorNumerical(): boolean {
    return this._numericLUReusePivots();
  }

  // =========================================================================
  // Markowitz pivot search (complex)
  // =========================================================================

  private _searchForComplexPivot(
    k: number,
    xRe: Float64Array,
    xIm: Float64Array,
    xNzIdx: Int32Array,
    xNzCount: number,
    pinv: Int32Array
  ): number {
    const mProd = this._markowitzProd;
    const mRow = this._markowitzRow;
    const mCol = this._markowitzCol;
    const relThreshold = this._relThresholdComplex;
    const absThreshold = this._absThresholdComplex;

    let absMax2 = 0;
    for (let idx = 0; idx < xNzCount; idx++) {
      const i = xNzIdx[idx];
      if (pinv[i] >= 0) continue;
      const re = xRe[i], im = xIm[i];
      const mag2 = re * re + im * im;
      if (mag2 > absMax2) absMax2 = mag2;
    }

    if (absMax2 === 0) return -1;

    const threshold2 = relThreshold * relThreshold * absMax2;
    const absThreshold2 = absThreshold * absThreshold;

    // Phase 1: Singletons
    if (this._singletons > 0) {
      let bestRow = -1;
      let bestMag2 = 0;
      for (let idx = 0; idx < xNzCount; idx++) {
        const i = xNzIdx[idx];
        if (pinv[i] >= 0) continue;
        if (mProd[i] !== 0) continue;
        const re = xRe[i], im = xIm[i];
        const mag2 = re * re + im * im;
        if (mag2 < absThreshold2 || mag2 < threshold2) continue;
        if (mag2 > bestMag2) { bestMag2 = mag2; bestRow = i; }
      }
      if (bestRow >= 0) return bestRow;
    }

    // Phase 2: Diagonal preference
    {
      let bestRow = -1;
      let bestProd = Infinity;
      let bestMag2 = 0;
      for (let idx = 0; idx < xNzCount; idx++) {
        const i = xNzIdx[idx];
        if (pinv[i] >= 0) continue;
        if (i !== k) continue;
        const re = xRe[i], im = xIm[i];
        const mag2 = re * re + im * im;
        if (mag2 < absThreshold2 || mag2 < threshold2) continue;
        const prod = mProd[i];
        if (prod < bestProd || (prod === bestProd && mag2 > bestMag2)) {
          bestProd = prod; bestMag2 = mag2; bestRow = i;
        }
      }
      if (bestRow >= 0) return bestRow;
    }

    // Phase 3: Column search via linked structure
    {
      let bestRow = -1;
      let bestProd = Infinity;
      let bestMag2 = 0;
      let e = this._colHead[k];
      while (e >= 0) {
        const row = this._elRow[e];
        if (pinv[row] < 0) {
          const re = xRe[row], im = xIm[row];
          const mag2 = re * re + im * im;
          if (mag2 >= absThreshold2 && mag2 >= threshold2) {
            const prod = mRow[row] * mCol[k];
            if (prod < bestProd || (prod === bestProd && mag2 > bestMag2)) {
              bestProd = prod; bestMag2 = mag2; bestRow = row;
            }
          }
        }
        e = this._elNextInCol[e];
      }
      if (bestRow >= 0) return bestRow;
    }

    // Phase 4: Last-resort- largest magnitude
    {
      let bestRow = -1;
      let bestMag2 = 0;
      for (let idx = 0; idx < xNzCount; idx++) {
        const i = xNzIdx[idx];
        if (pinv[i] >= 0) continue;
        const re = xRe[i], im = xIm[i];
        const mag2 = re * re + im * im;
        if (mag2 > bestMag2) { bestMag2 = mag2; bestRow = i; }
      }
      return bestRow;
    }
  }

  private _updateComplexMarkowitzNumbers(step: number, pivotRow: number, pinv: Int32Array): void {
    const mRow = this._markowitzRow;
    const mCol = this._markowitzCol;
    const mProd = this._markowitzProd;

    let e = this._rowHead[pivotRow];
    while (e >= 0) {
      const c = this._extToIntComplexCol[this._elCol[e]];
      if (c !== step && mCol[c] > 0) mCol[c]--;
      e = this._elNextInRow[e];
    }

    e = this._colHead[step];
    while (e >= 0) {
      const r = this._elRow[e];
      if (r !== pivotRow && mRow[r] > 0) mRow[r]--;
      e = this._elNextInCol[e];
    }

    let singletons = 0;
    for (let i = 0; i < this._size; i++) {
      if (pinv[i] >= 0) continue;
      mProd[i] = mRow[i] * mCol[i];
      if (mProd[i] === 0) singletons++;
    }
    this._singletons = singletons;
  }

  // =========================================================================
  // Storage growth for L/U CSC arrays
  // =========================================================================

  private _growL(min: number): void {
    const sz = Math.max(min, this._lRowIdx.length * 2);
    const r = new Int32Array(sz);
    const re = new Float64Array(sz);
    const im = new Float64Array(sz);
    r.set(this._lRowIdx);
    re.set(this._lRe);
    im.set(this._lIm);
    this._lRowIdx = r;
    this._lRe = re;
    this._lIm = im;
    const m = new Int32Array(sz).fill(-1);
    m.set(this._lCscToElem);
    this._lCscToElem = m;
  }

  private _growU(min: number): void {
    const sz = Math.max(min, this._uRowIdx.length * 2);
    const r = new Int32Array(sz);
    const re = new Float64Array(sz);
    const im = new Float64Array(sz);
    r.set(this._uRowIdx);
    re.set(this._uRe);
    im.set(this._uIm);
    this._uRowIdx = r;
    this._uRe = re;
    this._uIm = im;
    const m = new Int32Array(sz).fill(-1);
    m.set(this._uCscToElem);
    this._uCscToElem = m;
  }

  // =========================================================================
  // Accessors for tests that probe internal structure
  // =========================================================================

  /** Count of non-fill-in elements in the linked structure. */
  get elementCount(): number {
    let count = 0;
    const n = this._size;
    for (let col = 0; col < n; col++) {
      let e = this._colHead[col];
      while (e >= 0) {
        if (!(this._elFlags[e] & FLAG_FILL_IN)) count++;
        e = this._elNextInCol[e];
      }
    }
    return count;
  }

  /** Expose internal linked-list fields for test assertions. */
  get rowHead(): Int32Array { return this._rowHead; }
  get colHead(): Int32Array { return this._colHead; }
  get elRow(): Int32Array { return this._elRow; }
  get elCol(): Int32Array { return this._elCol; }
  get elRe(): Float64Array { return this._elRe; }
  get elIm(): Float64Array { return this._elIm; }
  get elNextInRow(): Int32Array { return this._elNextInRow; }
  get elNextInCol(): Int32Array { return this._elNextInCol; }
  get diag(): Int32Array { return this._diag; }
  get dimension(): number { return this._size; }
}
