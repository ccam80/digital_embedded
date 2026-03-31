/**
 * ComplexSparseSolver — native N×N complex sparse LU solver for AC analysis.
 *
 * Implements the same COO→CSC→AMD→symbolic→numeric LU pipeline as SparseSolver,
 * but with native complex arithmetic throughout. Each matrix entry and workspace
 * slot stores a (re, im) pair in parallel Float64Arrays.
 *
 * This is ~4x more memory-efficient and faster than the previous 2N×2N real
 * block expansion approach, since we work directly with an N×N complex system.
 *
 * Factorization: left-looking column-by-column complex LU with partial pivoting
 * (pivot selection by complex magnitude). Follows the same CSparse-style approach
 * as SparseSolver, adapted for complex values.
 */

import type { ComplexSparseSolver as IComplexSparseSolver } from "./element.js";

const INITIAL_TRIPLET_CAPACITY = 256;
const PIVOT_THRESHOLD = 0.01;

export class ComplexSparseSolver implements IComplexSparseSolver {
  // -- COO triplet storage (complex values in parallel arrays) --
  private _cooRows: Int32Array;
  private _cooCols: Int32Array;
  private _cooRe: Float64Array;
  private _cooIm: Float64Array;
  private _cooCount = 0;

  // -- RHS (complex) --
  private _rhsRe: Float64Array = new Float64Array(0);
  private _rhsIm: Float64Array = new Float64Array(0);

  // -- CSC (original ordering, complex values) --
  private _cscColPtr: Int32Array = new Int32Array(0);
  private _cscRowIdx: Int32Array = new Int32Array(0);
  private _cscRe: Float64Array = new Float64Array(0);
  private _cscIm: Float64Array = new Float64Array(0);

  // -- Dimension --
  private _n = 0;

  // -- AMD permutation --
  private _perm: Int32Array = new Int32Array(0);
  private _permInv: Int32Array = new Int32Array(0);

  // -- Sparse L (CSC, unit lower triangular, complex) --
  private _lColPtr: Int32Array = new Int32Array(0);
  private _lRowIdx: Int32Array = new Int32Array(0);
  private _lRe: Float64Array = new Float64Array(0);
  private _lIm: Float64Array = new Float64Array(0);

  // -- Sparse U (CSC, upper triangular, complex) --
  // Diagonal stored as last entry in each column.
  private _uColPtr: Int32Array = new Int32Array(0);
  private _uRowIdx: Int32Array = new Int32Array(0);
  private _uRe: Float64Array = new Float64Array(0);
  private _uIm: Float64Array = new Float64Array(0);

  // -- Pivot permutation --
  private _pinv: Int32Array = new Int32Array(0);
  private _q: Int32Array = new Int32Array(0);

  // -- Dense complex workspace (length n each, reused each factor) --
  private _xRe: Float64Array = new Float64Array(0);
  private _xIm: Float64Array = new Float64Array(0);

  // -- Tracked nonzero indices in x[] --
  private _xNzIdx: Int32Array = new Int32Array(0);

  // -- DFS reach workspace --
  private _reachStack: Int32Array = new Int32Array(0);
  private _dfsStack: Int32Array = new Int32Array(0);
  private _dfsChildPtr: Int32Array = new Int32Array(0);
  private _reachMark: Int32Array = new Int32Array(0);

  // -- Scratch for solve (complex, length n each) --
  private _scratchRe: Float64Array = new Float64Array(0);
  private _scratchIm: Float64Array = new Float64Array(0);

  // -- Topology tracking --
  private _topologyDirty = true;
  private _prevCscColPtr: Int32Array | null = null;
  private _prevCscRowIdx: Int32Array | null = null;

  constructor() {
    this._cooRows = new Int32Array(INITIAL_TRIPLET_CAPACITY);
    this._cooCols = new Int32Array(INITIAL_TRIPLET_CAPACITY);
    this._cooRe = new Float64Array(INITIAL_TRIPLET_CAPACITY);
    this._cooIm = new Float64Array(INITIAL_TRIPLET_CAPACITY);
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /** Begin assembly for an N×N complex system. */
  beginAssembly(n: number): void {
    this._n = n;
    this._cooCount = 0;
    if (this._rhsRe.length !== n) {
      this._rhsRe = new Float64Array(n);
      this._rhsIm = new Float64Array(n);
    } else {
      this._rhsRe.fill(0);
      this._rhsIm.fill(0);
    }
  }

  /** Add a complex value (re + j*im) to position (row, col). */
  stamp(row: number, col: number, re: number, im: number): void {
    if (this._cooCount === this._cooRows.length) this._growCOO();
    const k = this._cooCount;
    this._cooRows[k] = row;
    this._cooCols[k] = col;
    this._cooRe[k] = re;
    this._cooIm[k] = im;
    this._cooCount++;
  }

  /** Add a complex value to position (row) of the RHS vector. */
  stampRHS(row: number, re: number, im: number): void {
    this._rhsRe[row] += re;
    this._rhsIm[row] += im;
  }

  /** Finalize assembly: build CSC, compute AMD ordering, symbolic LU. */
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

  /** Factor the assembled complex matrix. Returns true on success. */
  factor(): boolean {
    const result = this._numericLU();
    if (!result.success && result.singularRow === undefined) {
      this._topologyDirty = true;
      this._computeAMD();
      this._symbolicLU();
      this._prevCscColPtr = this._cscColPtr.slice();
      this._prevCscRowIdx = this._cscRowIdx.slice();
      this._topologyDirty = false;
      return this._numericLU().success;
    }
    return result.success;
  }

  /**
   * Solve the assembled complex system.
   * On return, xRe[i] and xIm[i] contain the solution at index i.
   */
  solve(xRe: Float64Array, xIm: Float64Array): void {
    const n = this._n;
    if (n === 0) return;

    const perm = this._perm;
    const pinv = this._pinv;
    const q = this._q;
    const bRe = this._scratchRe;
    const bIm = this._scratchIm;

    // Step 1+2: AMD permute then pivot permute RHS
    for (let k = 0; k < n; k++) {
      const origIdx = perm[q[k]];
      bRe[k] = this._rhsRe[origIdx];
      bIm[k] = this._rhsIm[origIdx];
    }

    // Step 3: Complex sparse forward sub (L, unit lower triangular CSC)
    for (let j = 0; j < n; j++) {
      const p0 = this._lColPtr[j];
      const p1 = this._lColPtr[j + 1];
      const bjRe = bRe[j];
      const bjIm = bIm[j];
      for (let p = p0; p < p1; p++) {
        const step = pinv[this._lRowIdx[p]];
        const lRe = this._lRe[p];
        const lIm = this._lIm[p];
        // b[step] -= L[p] * b[j]  (complex multiply)
        bRe[step] -= lRe * bjRe - lIm * bjIm;
        bIm[step] -= lRe * bjIm + lIm * bjRe;
      }
    }

    // Step 4: Complex sparse backward sub (U, upper triangular CSC)
    for (let j = n - 1; j >= 0; j--) {
      const p0 = this._uColPtr[j];
      const p1 = this._uColPtr[j + 1];
      // Diagonal is last entry: complex division b[j] /= U_diag
      const dRe = this._uRe[p1 - 1];
      const dIm = this._uIm[p1 - 1];
      const dMag2 = dRe * dRe + dIm * dIm;
      // b[j] = b[j] / diag = b[j] * conj(diag) / |diag|^2
      const tmpRe = (bRe[j] * dRe + bIm[j] * dIm) / dMag2;
      const tmpIm = (bIm[j] * dRe - bRe[j] * dIm) / dMag2;
      bRe[j] = tmpRe;
      bIm[j] = tmpIm;

      for (let p = p0; p < p1 - 1; p++) {
        const step = pinv[this._uRowIdx[p]];
        const uRe = this._uRe[p];
        const uIm = this._uIm[p];
        // b[step] -= U[p] * b[j]
        bRe[step] -= uRe * tmpRe - uIm * tmpIm;
        bIm[step] -= uRe * tmpIm + uIm * tmpRe;
      }
    }

    // Step 5: Undo AMD column permutation
    for (let k = 0; k < n; k++) {
      xRe[perm[k]] = bRe[k];
      xIm[perm[k]] = bIm[k];
    }
  }

  // =========================================================================
  // COO growth
  // =========================================================================

  private _growCOO(): void {
    const c = this._cooRows.length * 2;
    const r = new Int32Array(c);
    const co = new Int32Array(c);
    const re = new Float64Array(c);
    const im = new Float64Array(c);
    r.set(this._cooRows);
    co.set(this._cooCols);
    re.set(this._cooRe);
    im.set(this._cooIm);
    this._cooRows = r;
    this._cooCols = co;
    this._cooRe = re;
    this._cooIm = im;
  }

  // =========================================================================
  // CSC conversion (complex)
  // =========================================================================

  private _buildCSC(): void {
    const n = this._n;
    const nnz = this._cooCount;

    const colCount = new Int32Array(n + 1);
    for (let k = 0; k < nnz; k++) colCount[this._cooCols[k] + 1]++;
    for (let j = 0; j < n; j++) colCount[j + 1] += colCount[j];

    const rowIdx = new Int32Array(nnz);
    const valsRe = new Float64Array(nnz);
    const valsIm = new Float64Array(nnz);
    const pos = colCount.slice(0, n);
    for (let k = 0; k < nnz; k++) {
      const p = pos[this._cooCols[k]]++;
      rowIdx[p] = this._cooRows[k];
      valsRe[p] = this._cooRe[k];
      valsIm[p] = this._cooIm[k];
    }

    const finalColPtr = new Int32Array(n + 1);
    const tempRows: number[] = [];
    const tempRe: number[] = [];
    const tempIm: number[] = [];

    for (let j = 0; j < n; j++) {
      const start = colCount[j], end = colCount[j + 1];
      const col: Array<[number, number, number]> = [];
      for (let p = start; p < end; p++) col.push([rowIdx[p], valsRe[p], valsIm[p]]);
      col.sort((a, b) => a[0] - b[0]);

      finalColPtr[j] = tempRows.length;
      let prevRow = -1;
      for (const [r, re, im] of col) {
        if (r === prevRow) {
          tempRe[tempRe.length - 1] += re;
          tempIm[tempIm.length - 1] += im;
        } else {
          tempRows.push(r);
          tempRe.push(re);
          tempIm.push(im);
          prevRow = r;
        }
      }
    }
    finalColPtr[n] = tempRows.length;

    this._cscColPtr = finalColPtr;
    this._cscRowIdx = new Int32Array(tempRows);
    this._cscRe = new Float64Array(tempRe);
    this._cscIm = new Float64Array(tempIm);

    if (!this._topologyDirty) this._topologyDirty = this._patternChanged();
  }

  private _patternChanged(): boolean {
    if (!this._prevCscColPtr || !this._prevCscRowIdx) return true;
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
  // Symbolic LU
  // =========================================================================

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

  private _symbolicLU(): void {
    const n = this._n;

    this._buildEtree();

    // Dense complex workspace
    this._xRe = new Float64Array(n);
    this._xIm = new Float64Array(n);

    // Nonzero index tracking
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
    this._scratchRe = new Float64Array(n);
    this._scratchIm = new Float64Array(n);

    // Pre-allocate L and U with generous capacity
    const nnzA = this._cscColPtr[n];
    const alloc = Math.max(nnzA * 6, n * 4);

    this._lColPtr = new Int32Array(n + 1);
    this._lRowIdx = new Int32Array(alloc);
    this._lRe = new Float64Array(alloc);
    this._lIm = new Float64Array(alloc);

    this._uColPtr = new Int32Array(n + 1);
    this._uRowIdx = new Int32Array(alloc);
    this._uRe = new Float64Array(alloc);
    this._uIm = new Float64Array(alloc);
  }

  // =========================================================================
  // DFS reach through L's column structure
  // =========================================================================

  private _reach(k: number): number {
    const n = this._n;
    const pinv = this._pinv;
    const permInv = this._permInv;
    const mark = this._reachMark;
    const stack = this._reachStack;
    const dfs = this._dfsStack;
    const childPtr = this._dfsChildPtr;
    let top = n;

    const origJ = this._perm[k];
    for (let p = this._cscColPtr[origJ]; p < this._cscColPtr[origJ + 1]; p++) {
      const newI = permInv[this._cscRowIdx[p]];
      const j = pinv[newI];
      if (j < 0 || j >= k) continue;
      if (mark[j] === k) continue;

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
    }

    return top;
  }

  // =========================================================================
  // Numeric LU factorization (left-looking, complex)
  // =========================================================================

  private _numericLU(): { success: boolean; singularRow?: number } {
    const n = this._n;
    if (n === 0) return { success: true };

    const xRe = this._xRe;
    const xIm = this._xIm;
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

      // Step 1: Scatter AMD-permuted column k into complex workspace
      let xNzCount = 0;
      const origJ = this._perm[k];
      for (let p = this._cscColPtr[origJ]; p < this._cscColPtr[origJ + 1]; p++) {
        const newI = permInv[this._cscRowIdx[p]];
        if (xRe[newI] === 0 && xIm[newI] === 0) xNzIdx[xNzCount++] = newI;
        xRe[newI] += this._cscRe[p];
        xIm[newI] += this._cscIm[p];
      }

      // Step 2: Left-looking solve via DFS reach
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
          // x[li] -= L[lp] * x[qj]  (complex multiply)
          const lRe = this._lRe[lp];
          const lIm = this._lIm[lp];
          xRe[li] -= lRe * xqjRe - lIm * xqjIm;
          xIm[li] -= lRe * xqjIm + lIm * xqjRe;
        }
      }

      // Step 3: Partial pivot — find best |x[i]| among unpivoted rows
      let maxMag2 = 0;
      let pivotRow = -1;
      for (let idx = 0; idx < xNzCount; idx++) {
        const i = xNzIdx[idx];
        if (pinv[i] >= 0) continue;
        const re = xRe[i], im = xIm[i];
        if (re === 0 && im === 0) continue;
        const mag2 = re * re + im * im;
        if (mag2 > maxMag2) { maxMag2 = mag2; pivotRow = i; }
      }

      if (maxMag2 === 0 || pivotRow < 0) {
        for (let idx = 0; idx < xNzCount; idx++) {
          xRe[xNzIdx[idx]] = 0;
          xIm[xNzIdx[idx]] = 0;
        }
        return { success: false, singularRow: k };
      }

      // Threshold pivoting (compare magnitudes squared to avoid sqrt)
      const threshold2 = PIVOT_THRESHOLD * PIVOT_THRESHOLD * maxMag2;
      const pivRe = xRe[pivotRow], pivIm = xIm[pivotRow];
      const pivMag2 = pivRe * pivRe + pivIm * pivIm;
      if (pivMag2 < threshold2) {
        for (let idx = 0; idx < xNzCount; idx++) {
          xRe[xNzIdx[idx]] = 0;
          xIm[xNzIdx[idx]] = 0;
        }
        return { success: false };
      }

      // Step 4: Record pivot
      pinv[pivotRow] = k;
      q[k] = pivotRow;

      const diagRe = xRe[pivotRow];
      const diagIm = xIm[pivotRow];
      const diagMag2 = diagRe * diagRe + diagIm * diagIm;
      if (diagMag2 < 1e-600) {
        for (let idx = 0; idx < xNzCount; idx++) {
          xRe[xNzIdx[idx]] = 0;
          xIm[xNzIdx[idx]] = 0;
        }
        return { success: false, singularRow: k };
      }

      // Step 5: Store U[:,k]
      for (let idx = 0; idx < xNzCount; idx++) {
        const i = xNzIdx[idx];
        const re = xRe[i], im = xIm[i];
        if (re === 0 && im === 0) continue;
        const s = pinv[i];
        if (s >= 0 && s < k) {
          this._uRowIdx[unz] = i;
          this._uRe[unz] = re;
          this._uIm[unz] = im;
          unz++;
        }
      }
      // Diagonal last
      this._uRowIdx[unz] = pivotRow;
      this._uRe[unz] = diagRe;
      this._uIm[unz] = diagIm;
      unz++;

      // Step 6: Store L[:,k] — unpivoted rows, scaled by 1/diag (complex division)
      // L[i] = x[i] / diag = x[i] * conj(diag) / |diag|^2
      for (let idx = 0; idx < xNzCount; idx++) {
        const i = xNzIdx[idx];
        const re = xRe[i], im = xIm[i];
        if (re === 0 && im === 0) continue;
        if (pinv[i] >= 0) continue;
        this._lRowIdx[lnz] = i;
        this._lRe[lnz] = (re * diagRe + im * diagIm) / diagMag2;
        this._lIm[lnz] = (im * diagRe - re * diagIm) / diagMag2;
        lnz++;
      }

      // Step 7: Clear workspace
      for (let idx = 0; idx < xNzCount; idx++) {
        xRe[xNzIdx[idx]] = 0;
        xIm[xNzIdx[idx]] = 0;
      }
    }

    this._lColPtr[n] = lnz;
    this._uColPtr[n] = unz;

    return { success: true };
  }

  // =========================================================================
  // Storage growth
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
  }
}
