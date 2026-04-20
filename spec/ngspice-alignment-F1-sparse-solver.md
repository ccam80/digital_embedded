# ngspice alignment — F1: Sparse solver core

_Extracted from ephemeral tool-results cache. Source agent output verbatim below._

---

I have everything I need. Now producing the concrete diffs.

---

# ngspice Alignment Diffs for `src/solver/analog/sparse-solver.ts`

Scope items: #3, #4, #9/S1, #10, #11/S7, S2, S3, S4, S5, S6. Additional divergences surfaced at the end under **F1**.

Ngspice mapping common to all items:

| ngspice | ours |
|---|---|
| `MatrixPtr Matrix` | `SparseSolver` instance |
| `Matrix->NeedsOrdering` | `_needsReorder` |
| `Matrix->Factored` | not explicitly modelled; inverse of `_hasPivotOrder` |
| `Matrix->RelThreshold` | `PIVOT_THRESHOLD` (static) → must become `_relThreshold` |
| `Matrix->AbsThreshold` | `PIVOT_ABS_THRESHOLD` (static) → must become `_absThreshold` |
| `Matrix->Diag[col]` | `_diag[col]` |
| `CKTniState & NIDIDPREORDER` | `_didPreorder` (solver-internal) + NR loop `didPreorder` local |
| `CKTpivotAbsTol` / `CKTpivotRelTol` | *not plumbed — must add* |
| `CKTdiagGmin` | `ctx.diagonalGmin` / `ctx.loadCtx.gmin` |
| `LoadGmin(Matrix,Gmin)` | `addDiagonalGmin(gmin)` / `_applyDiagGmin(gmin)` |
| `spOrderAndFactor` | `factorWithReorder` |
| `spFactor` | `factorNumerical` |
| `spcCreateElement` | `allocElement` (new-element path) |
| `SMPpreOrder` | `preorder()` |

---

## Item #3 — `_numericLUReusePivots` missing column-relative partial-pivot guard

### ngspice reference

- File: `ref/ngspice/src/maths/sparse/spfactor.c`
- Lines: 214-238

```c
if (!Matrix->NeedsOrdering) {
    /* Matrix has been factored before and reordering is not required. */
    for (Step = 1; Step <= Size; Step++) {
        pPivot = Matrix->Diag[Step];
        LargestInCol = FindLargestInCol(pPivot->NextInCol);
        if ((LargestInCol * RelThreshold < ELEMENT_MAG(pPivot))) {
            if (Matrix->Complex)
                ComplexRowColElimination( Matrix, pPivot );
            else
                RealRowColElimination( Matrix, pPivot );
        } else {
            ReorderingRequired = YES;
            break; /* for loop */
        }
    }
    if (!ReorderingRequired)
        goto Done;
    else {
        /* A pivot was not large enough to maintain accuracy, so a
         * partial reordering is required.  */
    }
}
```

Note: in ngspice, when `!NeedsOrdering`, `spOrderAndFactor` runs the partial-pivot guard; when the guard fails at step `Step` it sets `ReorderingRequired = YES; break;` and falls through to `CountMarkowitz + MarkowitzProducts + SearchForPivot` from `Step` onward. **It never returns "singular" from the guard-failure path.**

`FindLargestInCol` ref: `spfactor.c:1850-1863`:

```c
static RealNumber
FindLargestInCol( ElementPtr pElement )
{
    RealNumber  Magnitude, Largest = 0.0;
    while (pElement != NULL) {
        if ((Magnitude = ELEMENT_MAG(pElement)) > Largest)
            Largest = Magnitude;
        pElement = pElement->NextInCol;
    }
    return Largest;
}
```

### Our code today

- File: `src/solver/analog/sparse-solver.ts`
- Lines: 1157-1250 (`_numericLUReusePivots`)

The numeric-reuse path checks only the per-step diagonal magnitude against `PIVOT_ABS_THRESHOLD` (line 1210). **No column-relative guard exists.** The outer `factor()` at 390-411 does not re-dispatch on guard failure — it returns singular and the NR loop calls `forceReorder()` reactively. This is behaviourally close but NOT atomic as ngspice demands: the reuse pass has already mutated `_lVals`/`_uVals` before failure.

The correct ngspice semantic is: **evaluate the guard BEFORE doing the elimination at each step, break with a "needs reorder" sentinel, and have the caller run `factorWithReorder()` from step 0.**

### Variable mapping

| ngspice | ours | notes |
|---|---|---|
| `pPivot = Matrix->Diag[Step]` | `this._diag[k]` | diagonal pool handle at internal column k |
| `pPivot->NextInCol` | `this._elNextInCol[this._diag[k]]` | first sub-diagonal element in column k |
| `FindLargestInCol(pPivot->NextInCol)` | helper `_findLargestInColBelow(e)` (new) | walks `_elNextInCol` and returns max `Math.abs(_elVal)` |
| `ELEMENT_MAG(pPivot)` | `Math.abs(this._elVal[this._diag[k]])` | pivot magnitude |
| `Matrix->RelThreshold` | `this._relThreshold` (new field, replaces `PIVOT_THRESHOLD`) | see Item S2 |
| `ReorderingRequired = YES; break` | `{ success: false, needsReorder: true }` sentinel | added to `FactorResult` |

### Concrete diff

**Part A — extend `FactorResult` with a `needsReorder` sentinel** (sparse-solver.ts:17-21):

OLD (exact):
```ts
export interface FactorResult {
  success: boolean;
  conditionEstimate?: number;
  singularRow?: number;
}
```

NEW (exact):
```ts
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
```

**Part B — add helper `_findLargestInColBelow` before `_searchForPivot`** (insert after line 1310, before `// Factorization public API`):

NEW (exact) — new method appended inside the class:
```ts
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
```

**Part C — rewrite `_numericLUReusePivots` to add the column-relative guard per step** (sparse-solver.ts:1157-1250):

OLD (exact):
```ts
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
      if (Math.abs(diagVal) < PIVOT_ABS_THRESHOLD) {
        for (let idx = 0; idx < xNzCount; idx++) x[xNzIdx[idx]] = 0;
        return { success: false };
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

    if (minDiag < PIVOT_ABS_THRESHOLD) return { success: false };
    return { success: true, conditionEstimate: minDiag > 0 ? maxDiag / minDiag : Infinity };
  }
```

NEW (exact):
```ts
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
```

**Part D — make public `factor()` re-dispatch on `needsReorder`** (sparse-solver.ts:390-411). (Also plumbed for Item #9/S1 below — combined form.)

OLD (exact):
```ts
  factor(): FactorResult {
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
      return this.factorWithReorder();
    }
    this.lastFactorUsedReorder = false;
    return this.factorNumerical();
  }
```

NEW (exact):
```ts
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
```

### Additional files touched

**File: `src/solver/analog/newton-raphson.ts`**
Lines: 295-320.

OLD (exact):
```ts
    // Add gmin to every diagonal element before factorization.
    if (ctx.diagonalGmin) {
      solver.addDiagonalGmin(ctx.diagonalGmin);
    }

    // ---- STEP E: Factorize ----
    // ngspice niiter.c:888-891: E_SINGULAR on numerical-only path sets NISHOULDREORDER
    // and does `continue` (returns to top of for(;;), re-executes CKTload).
    const factorResult = solver.factor();
    if (!factorResult.success) {
      if (!solver.lastFactorUsedReorder) {
        solver.forceReorder();
        continue;
      }
      diagnostics.emit(
        makeDiagnostic("singular-matrix", "error", "Singular matrix during NR iteration", {
          explanation: `The MNA matrix became singular at iteration ${iteration + 1}.`,
          suggestions: [],
        }),
      );
      ctx.nrResult.converged = false;
      ctx.nrResult.iterations = iteration + 1;
      ctx.nrResult.largestChangeElement = -1;
      ctx.nrResult.largestChangeNode = -1;
      return;
    }
```

NEW (exact):
```ts
    // ---- STEP E: Factorize (gmin stamped atomically inside factor()) ----
    // ngspice SMPluFac/SMPreorder call LoadGmin internally, immediately
    // before spFactor/spOrderAndFactor (spsmp.c:173, 197). We mirror that by
    // passing diagGmin into factor() rather than calling addDiagonalGmin
    // separately — this keeps the gmin stamp and the factorization atomic
    // and aligned with ngspice's invariant that no caller observes a
    // post-gmin, pre-factor matrix.
    //
    // ngspice niiter.c:888-891: E_SINGULAR on the numerical-only path sets
    // NISHOULDREORDER and does `continue` (back to CKTload). factor() itself
    // now handles the partial-pivot-guard-driven fallthrough (spfactor.c:225)
    // by dispatching back through factorWithReorder internally, so a
    // `success: false` return here is a genuine singular-matrix failure.
    const factorResult = solver.factor(ctx.diagonalGmin);
    if (!factorResult.success) {
      if (!solver.lastFactorUsedReorder) {
        solver.forceReorder();
        continue;
      }
      diagnostics.emit(
        makeDiagnostic("singular-matrix", "error", "Singular matrix during NR iteration", {
          explanation: `The MNA matrix became singular at iteration ${iteration + 1}.`,
          suggestions: [],
        }),
      );
      ctx.nrResult.converged = false;
      ctx.nrResult.iterations = iteration + 1;
      ctx.nrResult.largestChangeElement = -1;
      ctx.nrResult.largestChangeNode = -1;
      return;
    }
```

### Why this matches ngspice

`spfactor.c:214-227` is the literal model: `!NeedsOrdering` path walks `Step = 1..Size`, computes `LargestInCol = FindLargestInCol(pPivot->NextInCol)`, and if `LargestInCol * RelThreshold >= |pPivot|` sets `ReorderingRequired = YES; break;` and falls into the full reorder from current `Step`. Our reuse path must do the same check per step; on failure we return a sentinel that causes `factor()` to re-dispatch through `factorWithReorder`, and because `_numericLUReusePivots` aborts BEFORE mutating `_elVal`, the matrix still contains A + gmin·I — identical to ngspice, where `spOrderAndFactor` runs on the same matrix state after the guard break.

### Side-effects / callers impacted

- `newton-raphson.ts:303` — no longer needs the separate `addDiagonalGmin` call (moved into `factor()`); updated above.
- `src/solver/analog/__tests__/sparse-solver.test.ts` and `complex-sparse-solver.test.ts` — any test that asserts `singular` after a diagonal-reused factor with a stale pivot order will now see `{ success: true }` via the silent reorder fallback. This is correct ngspice behaviour; any such test must adapt.
- `rl-iter0-probe.test.ts` (currently open/modified in working tree) — must treat `success && lastFactorUsedReorder === true` after a `factor()` call as the partial-pivot fall-through path.

---

## Item #4 — Pivot tolerance constants diverge from ngspice defaults

### ngspice reference

- File: `ref/ngspice/src/maths/sparse/spalloc.c`
- Lines: 192-193

```c
Matrix->RelThreshold = DEFAULT_THRESHOLD;
Matrix->AbsThreshold = 0.0;
```

- File: `ref/ngspice/src/maths/sparse/spconfig.h`
- Lines: 331

```c
#define  DEFAULT_THRESHOLD              1.0e-3
```

So ngspice defaults: `RelThreshold = 1e-3`, `AbsThreshold = 0.0`. They are also mutable per-call (`spOrderAndFactor` parameters, `CKTpivotRelTol`/`CKTpivotAbsTol` plumbed through `SMPluFac`/`SMPreorder` — see Item S2).

### Our code today

- File: `src/solver/analog/sparse-solver.ts`
- Lines: 23-24

```ts
const PIVOT_THRESHOLD = 1e-3;
const PIVOT_ABS_THRESHOLD = 1e-13;
```

`PIVOT_THRESHOLD` matches; `PIVOT_ABS_THRESHOLD = 1e-13` is **arbitrary and wrong** — ngspice's default is `0.0`, and the numeric-reuse singular check at `sparse-solver.ts:1210, 1248` uses this threshold as a hard floor where ngspice uses ABS-strict zero (`Matrix->Diag[1]->Real == 0.0`, `spfactor.c:348`).

### Variable mapping

| ngspice | ours | notes |
|---|---|---|
| `Matrix->RelThreshold` (default `1e-3`) | `this._relThreshold` (new instance field) | replaces module const |
| `Matrix->AbsThreshold` (default `0.0`) | `this._absThreshold` (new instance field) | replaces module const |

### Concrete diff

**Part A — delete module constants, add instance fields** (sparse-solver.ts:22-28):

OLD (exact):
```ts
const PIVOT_THRESHOLD = 1e-3;
const PIVOT_ABS_THRESHOLD = 1e-13;

// Bit flag stored in _elFlags to distinguish fill-in entries from A-matrix entries.
const FLAG_FILL_IN = 1;
```

NEW (exact):
```ts
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
```

**Part B — add instance fields and setter, replace every `PIVOT_THRESHOLD`/`PIVOT_ABS_THRESHOLD` reference.**

Insert new fields after existing `_needsReorder`/`_didPreorder` block (around sparse-solver.ts:196-205). Insert after `_workspaceN`:

NEW (exact) — after line 202 `private _workspaceN: number = -1;` insert:
```ts
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
```

Add a public setter below `invalidateTopology()` (after sparse-solver.ts:469):

NEW (exact):
```ts
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
```

**Part C — replace every use of the module constants with the instance fields.**

sparse-solver.ts:1210 (inside `_numericLUReusePivots` — replaced by the Item #3 rewrite above).

sparse-solver.ts:1248 (inside `_numericLUReusePivots` — replaced by the Item #3 rewrite above).

sparse-solver.ts:1360-1361 (doc comments in `_searchForPivot`):

OLD (exact):
```ts
   *   RelThreshold → PIVOT_THRESHOLD
   *   AbsThreshold → PIVOT_ABS_THRESHOLD
```

NEW (exact):
```ts
   *   RelThreshold → this._relThreshold
   *   AbsThreshold → this._absThreshold
```

sparse-solver.ts:1384, 1395, 1411, 1430 (inside `_searchForPivot`):

OLD (exact):
```ts
    const relThreshold = PIVOT_THRESHOLD * absMax;

    // Phase 1: Singletons
    if (this._singletons > 0) {
      let bestRow = -1;
      let bestVal = 0;
      for (let idx = 0; idx < xNzCount; idx++) {
        const i = xNzIdx[idx];
        if (pinv[i] >= 0) continue;
        if (mProd[i] !== 0) continue;
        const v = Math.abs(x[i]);
        if (v < PIVOT_ABS_THRESHOLD || v < relThreshold) continue;
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
        if (v < PIVOT_ABS_THRESHOLD || v < relThreshold) continue;
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
          if (v >= PIVOT_ABS_THRESHOLD && v >= relThreshold) {
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
```

NEW (exact):
```ts
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

    // Phase 3: Column search via linked structure — Item S6 replaces this
    // block with a whole-matrix SearchEntireMatrix equivalent.
```

(Phase 3 is replaced wholesale in Item S6 below — see that section.)

### Additional files touched

None beyond sparse-solver.ts here; the CKT plumbing to feed these per-call is Item S2 below.

### Why this matches ngspice

ngspice `spalloc.c:192-193` sets `RelThreshold = 1e-3`, `AbsThreshold = 0.0`. Threshold tests in `spfactor.c:1106-1107, 1773-1773` are `Magnitude > Matrix->AbsThreshold` (strict). Our `v <= absThreshold` reject is the boolean-correct inverse.

### Side-effects / callers impacted

- Every `_searchForPivot` call (inside `_numericLUMarkowitz`, sparse-solver.ts:1060) — tolerance semantics now match ngspice.
- `_numericLUReusePivots` — uses `_absThreshold` directly in the Item-#3 diff.
- Any test relying on `1e-13` as the absolute floor must accept that near-zero diag elements that pass the relative test are now valid pivots (matching ngspice).

---

## Item #9 / S1 — `factor()` drops the `diagGmin` parameter

### ngspice reference

- File: `ref/ngspice/src/maths/sparse/spsmp.c`
- Lines: 168-200

```c
int
SMPluFac(SMPmatrix *Matrix, double PivTol, double Gmin)
{
    NG_IGNORE(PivTol);
    spSetReal( Matrix );
    LoadGmin( Matrix, Gmin );
    return spFactor( Matrix );
}

int
SMPreorder(SMPmatrix *Matrix, double PivTol, double PivRel, double Gmin)
{
    spSetReal( Matrix );
    LoadGmin( Matrix, Gmin );
    return spOrderAndFactor( Matrix, NULL,
                             PivRel, PivTol, YES );
}
```

Gmin is applied atomically — `LoadGmin` then factor, with nothing in between that an external caller could observe.

### Our code today

- File: `src/solver/analog/sparse-solver.ts`
- Lines: 390-411, 1320-1332, 1338-1341

`factorWithReorder(diagGmin?)` and `factorNumerical(diagGmin?)` already accept the parameter and delegate to `_applyDiagGmin`. Public `factor()` at 390-411 **does not** — it's a hard-wired dispatcher with no parameter. Meanwhile `newton-raphson.ts:296-298` stamps gmin by calling `solver.addDiagonalGmin(ctx.diagonalGmin)` before `solver.factor()` — introducing an observable intermediate state (matrix = A + gmin·I but solver state flags unchanged).

### Variable mapping

| ngspice | ours | notes |
|---|---|---|
| `SMPluFac(Matrix, PivTol, Gmin)` | `factor(diagGmin)` | add parameter |
| `LoadGmin(Matrix, Gmin)` then `spFactor` | `factor()` body calls `_applyDiagGmin(diagGmin)` immediately before dispatch | atomic |
| `SMPreorder(Matrix, PivTol, PivRel, Gmin)` | `factor()` → `factorWithReorder(diagGmin)` when `_needsReorder` | atomic |

### Concrete diff

Already covered in Item #3 Part D (the `factor(diagGmin?)` signature). To complete the plumbing, also remove the now-dead `addDiagonalGmin` call from newton-raphson.ts as shown in Item #3 "Additional files touched".

Additionally, since `addDiagonalGmin` is now internal-use only through `_applyDiagGmin`, tighten its documentation and preserve it as a public method for instrumentation/tests, but note that production callers must NOT use it:

sparse-solver.ts:559-573, replace the public `addDiagonalGmin`:

OLD (exact):
```ts
  /**
   * Add a conductance value to every diagonal element of the assembled matrix.
   * Matches ngspice LoadGmin (spsmp.c:448-478).
   * Must be called after beginAssembly()+stamps+finalize() but before factor().
   */
  addDiagonalGmin(gmin: number): void {
    if (gmin === 0) return;
    const n = this._n;
    const diag = this._diag;
    const elVal = this._elVal;
    for (let i = 0; i < n; i++) {
      const e = diag[i];
      if (e >= 0) elVal[e] += gmin;
    }
  }
```

NEW (exact):
```ts
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
```

### Additional files touched

`src/solver/analog/newton-raphson.ts` — diff already shown in Item #3 "Additional files touched" (removed the `solver.addDiagonalGmin` call, passed `ctx.diagonalGmin` into `solver.factor(...)`).

### Why this matches ngspice

Every caller of a gmin-bearing factor in ngspice uses `SMPluFac`/`SMPreorder` which call `LoadGmin` immediately before `spFactor`/`spOrderAndFactor`. The NR loop at `niiter.c:883-884, 863-864` passes `ckt->CKTdiagGmin` through — never stamping gmin separately from factorization. Our new `factor(diagGmin)` signature reproduces that 1:1.

### Side-effects / callers impacted

- `newton-raphson.ts:296-303` — atomicised.
- Harness tests that read `solver.getPreFactorMatrixSnapshot()` expecting a matrix WITHOUT gmin stamp will now see A + gmin·I because `_applyDiagGmin` runs inside `factorWithReorder`/`factorNumerical` BEFORE the snapshot. The snapshot is taken at the top of `factor()` **before** dispatch, so ordering of `_capturePreFactorMatrix` vs `_applyDiagGmin` must be checked — **see F1 item below**.
- Any tests that call `solver.addDiagonalGmin(...)` followed by `solver.factor()` will double-stamp gmin. These must change to `solver.factor(gmin)` form.

---

## Item #10 — `_hasPivotOrder` / `_needsReorder` flag lifecycle vs ngspice `Factored`/`NeedsOrdering`

### ngspice reference

- File: `ref/ngspice/src/maths/sparse/spdefs.h`
- Lines: 69

```c
#define  IS_FACTORED(matrix)    ((matrix)->Factored && !(matrix)->NeedsOrdering)
```

- File: `ref/ngspice/src/maths/sparse/spalloc.c`
- Line: 164, 170 (initial state: `Factored = NO`, `NeedsOrdering = YES`)

Set/clear points:
- `NeedsOrdering = YES`:
  - `spCreate` (spalloc.c:170) — initial
  - `spcCreateElement` (spbuild.c:788) — every new A-entry (not fill-in) after initial build
  - `spStripFills` (sputils.c:1042), `spStripMatrix` (sputils.c:1112), `spDeleteRowAndCol` (sputils.c:1264)
- `NeedsOrdering = NO`:
  - `spOrderAndFactor` Done (spfactor.c:279)
- `Factored = YES`:
  - `spOrderAndFactor` Done (spfactor.c:281)
  - `spFactor` Done (spfactor.c:281 / 412 / 534)
- `Factored = NO`:
  - `spClear` (spbuild.c:137)
  - `spInitialize` (spbuild.c:1200)

Inside `spClear`, **`Factored = NO` is set but `NeedsOrdering` is NOT**. So a cleared-then-restamped matrix re-enters `spFactor`, which, because `NeedsOrdering == NO`, takes the fast numeric path. This is the invariant that beginAssembly-based reuse preserves.

### Our code today

- File: `src/solver/analog/sparse-solver.ts`

Flag lifecycle today:

| Event | Line | `_needsReorder` | `_hasPivotOrder` | `_didPreorder` |
|---|---|---|---|---|
| `_initStructure` | 701-702 | = false | = false | untouched |
| `invalidateTopology()` | 465-469 | untouched | = false | = false |
| `forceReorder()` | 475-477 | = true | untouched | untouched |
| `factorWithReorder()` success | 1327-1330 | = false (via 1324) | = true | untouched |
| `_numericLUReusePivots` success | — | untouched | untouched | untouched |
| `allocElement` new entry | 281-291 | untouched — **BUG** | untouched | untouched |
| `beginAssembly` (reuse path) | 321-347 | untouched | untouched | untouched |

Mapping against ngspice `Factored`/`NeedsOrdering`:

| ngspice op | ngspice Factored | ngspice NeedsOrdering | ours equivalent | mismatch? |
|---|---|---|---|---|
| spCreate | NO | YES | `_initStructure` sets `_hasPivotOrder=false`, `_needsReorder=false` | **YES** — ours starts with `_needsReorder=false`; but since `_hasPivotOrder` is also false, `factor()` at 405 still dispatches to `factorWithReorder`. Net semantic matches (both force reorder on first factor). OK. |
| spcCreateElement (new A) | NO | **YES** | `allocElement` does not touch `_needsReorder` | **YES — real bug, Item #11** |
| spClear | NO | NO | `beginAssembly` re-entry with unchanged structure | OK (ours preserves `_hasPivotOrder=true`, `_needsReorder=false` → numeric path) |
| spOrderAndFactor done | YES | NO | `_hasPivotOrder=true`, `_needsReorder=false` | OK |
| spFactor done | YES | NO | `_hasPivotOrder` unchanged (true), `_needsReorder` unchanged (false) | OK |
| spStripFills | NO | YES | no equivalent | see F1 — fill-in stripping happens implicitly in `_resetForAssembly`, and correctly **does not** set `_needsReorder` because ngspice's `spStripFills` only fires on physical fill-in removal that mutates non-fill-in chain membership; our `_resetForAssembly` preserves the A-entry chain, so this is correct |

### Variable mapping

| ngspice | ours |
|---|---|
| `Matrix->Factored && !Matrix->NeedsOrdering` | `this._hasPivotOrder && !this._needsReorder` |
| `Matrix->Factored = NO` | (implicit — `beginAssembly`/`_resetForAssembly` sets `_elVal=0`; `_hasPivotOrder` stays true) |
| `Matrix->NeedsOrdering = YES` | `this._needsReorder = true` |

### Concrete diff

The lifecycle is correct **except** at `allocElement` (Item #11 below) and at `addDiagonalGmin` (Item S4). No per-method flag manipulation beyond those two needs to change here. To make the intent unambiguous, add an explicit lifecycle comment at the flag declarations.

sparse-solver.ts:194-205:

OLD (exact):
```ts
  // =========================================================================
  // State flags
  // =========================================================================
  private _needsReorder: boolean = false;
  private _didPreorder: boolean = false;
  private _hasPivotOrder: boolean = false;
  /** True when linked structure has never been built, or after invalidateTopology(). */
  private _structureEmpty: boolean = true;
  /** Matrix size for which workspace arrays were last allocated. -1 = never. */
  private _workspaceN: number = -1;
```

NEW (exact):
```ts
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
```

Additionally, ensure `_initStructure` sets `_needsReorder = true` to match ngspice `spalloc.c:170`:

sparse-solver.ts:700-703:

OLD (exact):
```ts
    this._structureEmpty = false;
    this._hasPivotOrder = false;
    this._needsReorder = false;
  }
```

NEW (exact):
```ts
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
```

### Additional files touched

None. This is a documentation+invariant edit inside sparse-solver.ts.

### Why this matches ngspice

The lifecycle audit above shows every ngspice `NeedsOrdering`/`Factored` set/clear point maps to exactly one of our flag operations, provided that Item #11 fixes the `allocElement` miss and the above `_initStructure` fix lines up the primitive flag. The `_didPreorder` scope alignment is separately handled in Item S3.

### Side-effects / callers impacted

- `factor()` dispatch at sparse-solver.ts:405 — unchanged effective behaviour (both flag paths still send it to reorder on first call).
- Any test asserting `_needsReorder === false` immediately after `beginAssembly()` on a fresh solver must change expectation.

---

## Item #11 / S7 — `invalidateTopology()` has zero production callers; `allocElement` does not flag reorder on new insertions

### ngspice reference

- File: `ref/ngspice/src/maths/sparse/spbuild.c`
- Lines: 786-789

```c
pElement = spcGetElement( Matrix );
Matrix->Originals++;
Matrix->NeedsOrdering = YES;
```

This is the hot path inside `spcCreateElement` when a new A-entry is inserted AFTER the matrix has been linked (post-initial-build, i.e., any subsequent stamp pass that adds new topology). ngspice sets `NeedsOrdering = YES` unconditionally on every new non-fill-in element. Fill-in creation (`spcGetFillin`, line 781) does NOT set this flag.

Related sites also flag it:
- `sputils.c:1042` (`spStripFills`)
- `sputils.c:1112` (`spStripMatrix`)
- `sputils.c:1264` (`spDeleteRowAndCol`)

### Our code today

- File: `src/solver/analog/sparse-solver.ts`
- Lines: 243-292 (`allocElement`)

When the handle table lookup misses and the column chain search misses, a new element is created at line 281 via `_newElement`. The path **does not** touch `_needsReorder`. This means: any stamp pass that introduces a new (row, col) entry after the first factor will re-use the stale pivot order built on a smaller sparsity pattern.

- File: `sparse-solver.ts:465-469` (`invalidateTopology`):

```ts
invalidateTopology(): void {
  this._structureEmpty = true;
  this._hasPivotOrder = false;
  this._didPreorder = false;
}
```

- Grep across `src/` (excluding `__tests__`, `complex-sparse-solver.ts`, and `sparse-solver.ts`) for `invalidateTopology`:
  - ac-analysis.ts — does not call it.
  - newton-raphson.ts — does not call it.
  - dc-operating-point.ts — does not call it.
  - ckt-load.ts — does not call it.
  - compiler.ts — does not call it.
  - engine, coordinator — do not call it (confirmed by the earlier grep; only test files and the method itself reference it).

**Confirmed: zero production call sites.**

Production allocElement callers that may fire AFTER an initial factor:

1. `src/solver/analog/ckt-load.ts:76, 80` — nodeset/IC enforcement stamps `allocElement(node, node)` inside `cktLoad`, which runs every NR iteration. If `nodesets` or `ics` was empty at compile-time stamp but becomes non-empty during a solve (or, more commonly, if the first-ever cktLoad runs during DC-OP initJct before any prior factor), the first call creates new entries. In that sense ngspice is correct: the very first factor must be a full reorder. But this case is covered by our `_hasPivotOrder === false` guard. The real hazard is when `ctx.nodesets` changes between solves (user adds a nodeset via API) while `_hasPivotOrder` is still true — which is a real path; see below.
2. Element `load()` methods that allocate lazily via `solver.allocElement` — widespread across components (see grep). Most allocate only during the first `beginAssembly` where `_structureEmpty === true`, but some (e.g. `comparator.ts`, `opamp.ts`, `analog-switch.ts`) may introduce new coupling entries when a prop changes between solves and a new terminal activates.
3. `compiler.ts` itself does not call `allocElement` (allocation happens inside element.load() bodies, not at compile time).
4. Bridge adapters `makeBridgeOutputAdapter`/`makeBridgeInputAdapter` — these stamp inside `load()`.

Risk is real. Ngspice sets `NeedsOrdering = YES` **unconditionally** on every new non-fill-in element regardless of whether the caller thinks the topology is stable.

### Variable mapping

| ngspice | ours |
|---|---|
| `Matrix->Originals++; Matrix->NeedsOrdering = YES;` (spbuild.c:787-788) | `this._needsReorder = true` inside `allocElement`'s new-entry branch |
| `Fillin` param true (spcGetFillin) | `allocElement` never sets FLAG_FILL_IN — it only stamps A entries; fill-ins are inserted directly by `_numericLUMarkowitz`, which correctly skips the `_needsReorder` flip |

### Concrete diff

**Part A — `allocElement` sets `_needsReorder = true` on every new-entry insertion** (sparse-solver.ts:243-292):

OLD (exact):
```ts
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
    const newE = this._newElement(row, col, 0, 0);
    this._insertIntoRow(newE, row);
    this._insertIntoCol(newE, internalCol);
    if (row === col) this._diag[internalCol] = newE;

    // Record in handle table
    if (this._n <= this._handleTableN) {
      this._handleTable[row * this._handleTableN + col] = newE + 1;
    }

    return newE;
  }
```

NEW (exact):
```ts
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
```

**Part B — enumerate every production `allocElement` call site that can fire after `finalize()` (post-initial-build).**

Call sites grouped by phase:

- *Compile-time stamps* (run during first `beginAssembly` → `finalize` pass, before any `factor()`; new-entry flag is redundant because `_hasPivotOrder === false`):
  - Every `src/components/**/*.ts` element factory's `load()` call during the very first cktLoad.

- *Post-initial-build stamps* (can fire when `_hasPivotOrder === true`):
  - `src/solver/analog/ckt-load.ts:76, 80` — nodeset/IC enforcement inside cktLoad; repeats every NR iteration; introduces new diagonal entries only on the first iteration where `ctx.nodesets`/`ctx.ics` transitions from empty→non-empty, OR the first DC-OP iteration after a stamp-pass topology change. **This path DOES need the flag flip** — our compiler does not pre-allocate nodeset/IC diagonals.
  - Every element `load()` that allocates lazily based on run-time conditions:
    - `src/components/active/comparator.ts` — hysteresis-mode switches may alloc new entries.
    - `src/components/active/analog-switch.ts` — activation switches between high-/low-impedance states.
    - `src/components/active/opamp.ts`, `real-opamp.ts` — internal nodes present only when gain-bandwidth is finite.
    - `src/components/semiconductors/**/*.ts` — all device models; most allocate on first `load()` only (entering a chain of `_rowHead`/`_colHead` that stays stable), but any device that adds internal nodes conditionally (e.g. parasitic resistance models) hits the same path.
    - `src/components/passives/transformer.ts`, `tapped-transformer.ts`, `coupled-inductor.ts` — coupling additions.
    - `src/components/passives/crystal.ts` — Butterworth network activation.
    - Bridge adapters in `src/solver/analog/bridge-adapter.ts` (inside `makeBridgeOutputAdapter` / `makeBridgeInputAdapter`'s returned `load()`).

For every one of those, the existing guard inside `allocElement` (the column-chain search at lines 267-277) short-circuits the new-entry branch when the element already exists, so `_needsReorder = true` fires only when the topology is genuinely new. **No caller needs editing** — the ngspice invariant lives entirely in `allocElement`.

**Part C — decide the fate of `invalidateTopology()`.**

`invalidateTopology` is subtly different from `allocElement`'s flip: it clears `_structureEmpty = true` so the next `beginAssembly` rebuilds the linked structure from scratch, whereas `allocElement` keeps the structure and only flags reorder. ngspice has **no analogous API**; the closest is `spStripMatrix` (sputils.c:1104-1145), which wipes the linked structure AND sets `NeedsOrdering = YES`. `invalidateTopology` exists today only as a test helper.

Decision: **keep the API, bring it into line with ngspice `spStripMatrix`** by also setting `_needsReorder = true`. The only production use I can imagine is a future "hot-rebuild" path where the coordinator resizes the matrix without re-creating the SparseSolver instance; the ngspice-correct behaviour there is a full reorder on the next factor. This is also Item S5 below. Concrete diff merged with S5.

### Concrete diff (merged with S5)

sparse-solver.ts:465-469:

OLD (exact):
```ts
  invalidateTopology(): void {
    this._structureEmpty = true;
    this._hasPivotOrder = false;
    this._didPreorder = false;
  }
```

NEW (exact):
```ts
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
```

### Additional files touched

None — Part B confirmed every production caller is already covered by `allocElement`'s new flip.

### Why this matches ngspice

`spbuild.c:786-788` sets `NeedsOrdering = YES` on every new non-fill-in element. Our `_numericLUMarkowitz` fill-in path calls `_newElement` directly and sets `FLAG_FILL_IN`, bypassing `allocElement` — identical to ngspice's `spcGetFillin` path at `spbuild.c:781` which also bypasses the `NeedsOrdering = YES` flip. `spStripMatrix` at sputils.c:1112 sets `NeedsOrdering = YES` — which our `invalidateTopology` now also does.

### Side-effects / callers impacted

- `ckt-load.ts:76, 80` — first-ever nodeset/IC stamp after an initial factor will now force a reorder. This is the ngspice-correct behaviour; any tests that asserted `lastFactorUsedReorder === false` on the iteration where nodesets are added must flip the expectation.
- Every test in `src/solver/analog/__tests__/sparse-solver.test.ts` that:
  1. `beginAssembly` + stamp pattern A + finalize + factor,
  2. `beginAssembly` + stamp pattern A' (with new topology) + finalize + factor,
  expected `factor#2` to use numeric path → will now use reorder path. The ngspice-correct result.
- `complex-sparse-solver.ts:invalidateTopology()` at line 398-402 does NOT have an analogous `_needsReorder = true` — see F1 item below.

---

## Item S2 — `CKTpivotAbsTol`/`CKTpivotRelTol` per-factor-call plumbing

### ngspice reference

- File: `ref/ngspice/src/maths/ni/niiter.c`
- Lines: 863-864, 883-884

```c
error = SMPreorder(ckt->CKTmatrix,ckt->CKTpivotAbsTol,
                   ckt->CKTpivotRelTol,ckt->CKTdiagGmin);
...
error=SMPluFac(ckt->CKTmatrix,ckt->CKTpivotAbsTol,
               ckt->CKTdiagGmin);
```

These are passed per-factor call. `SMPluFac` forwards `PivTol` then ignores it (`spsmp.c:171 NG_IGNORE(PivTol)`); `SMPreorder` forwards both to `spOrderAndFactor(... PivRel, PivTol ...)`, which applies them at `spfactor.c:204-211`:

```c
if (RelThreshold <= 0.0)
    RelThreshold = Matrix->RelThreshold;
if (RelThreshold > 1.0)
    RelThreshold = Matrix->RelThreshold;
Matrix->RelThreshold = RelThreshold;
if (AbsThreshold < 0.0)
    AbsThreshold = Matrix->AbsThreshold;
Matrix->AbsThreshold = AbsThreshold;
```

So the per-call tolerances become persistent across subsequent calls (sticky). Fine-grained but stateful.

### Our code today

Module constants (Item #4). No CKT plumbing.

### Variable mapping

| ngspice | ours |
|---|---|
| `ckt->CKTpivotAbsTol` | `CKTCircuitContext.pivotAbsTol` (new field) → flowed via `SparseSolver.setPivotTolerances` |
| `ckt->CKTpivotRelTol` | `CKTCircuitContext.pivotRelTol` (new field) |
| `SimulationParams.pivotAbsTol` | new param |
| `SimulationParams.pivotRelTol` | new param |

### Concrete diff

**Part A — extend `SimulationParams` with pivot tolerances.**

File: `src/core/analog-engine-interface.ts`
Lines to extend: append new fields around line 91 (after `diagGmin`), and extend `DEFAULT_SIMULATION_PARAMS` at lines 144-153.

OLD (exact), lines 89-91:
```ts
  uic?: boolean;
  /** Active diagonal gmin during stepping (ngspice CKTdiagGmin). Persistent engine state. Default: 0 */
  diagGmin?: number;
```

NEW (exact):
```ts
  uic?: boolean;
  /** Active diagonal gmin during stepping (ngspice CKTdiagGmin). Persistent engine state. Default: 0 */
  diagGmin?: number;
  /**
   * Pivot absolute threshold forwarded into SparseSolver per factor call.
   * Mirrors ngspice CKTpivotAbsTol (niiter.c:863, 883; spsmp.c:169, 194).
   * Default: 0 (matches ngspice spalloc.c:193).
   */
  pivotAbsTol?: number;
  /**
   * Pivot relative threshold forwarded into SparseSolver per factor call.
   * Mirrors ngspice CKTpivotRelTol (niiter.c:864; spfactor.c:204-208).
   * Must satisfy 0 < rel <= 1; out-of-range values are ignored at the
   * SparseSolver level (see setPivotTolerances). Default: 1e-3
   * (matches ngspice spconfig.h:331 DEFAULT_THRESHOLD).
   */
  pivotRelTol?: number;
```

OLD (exact), lines 144-153 in `DEFAULT_SIMULATION_PARAMS`:
```ts
  gshunt: 0,
  diagGmin: 0,
  initTime: 0,
  maxOrder: 2,
  lteReltol: 1e-3,
  lteAbstol: 1e-6,
  gminFactor: 10,
  srcFact: 1,
  xmu: 0.5,
};
```

NEW (exact):
```ts
  gshunt: 0,
  diagGmin: 0,
  pivotAbsTol: 0,
  pivotRelTol: 1e-3,
  initTime: 0,
  maxOrder: 2,
  lteReltol: 1e-3,
  lteAbstol: 1e-6,
  gminFactor: 10,
  srcFact: 1,
  xmu: 0.5,
};
```

**Part B — extend `CKTCircuitContext` to carry pivot tolerances and plumb them into `loadCtx`-less state so NR sets them before factor.**

File: `src/solver/analog/ckt-context.ts`
Lines: 312-314.

OLD (exact):
```ts
  /** Node damping factor (ngspice niiter.c). 0 = disabled, non-zero = enabled. */
  nodeDamping: number;
  /** Diagonal gmin conductance for stepping (ngspice CKTdiagGmin). */
  diagonalGmin: number;
```

NEW (exact):
```ts
  /** Node damping factor (ngspice niiter.c). 0 = disabled, non-zero = enabled. */
  nodeDamping: number;
  /** Diagonal gmin conductance for stepping (ngspice CKTdiagGmin). */
  diagonalGmin: number;
  /**
   * Pivot absolute threshold (ngspice CKTpivotAbsTol). Forwarded into the
   * SparseSolver via setPivotTolerances before every factor() call, mirroring
   * niiter.c:863, 883 where SMPreorder/SMPluFac receive ckt->CKTpivotAbsTol.
   */
  pivotAbsTol: number;
  /**
   * Pivot relative threshold (ngspice CKTpivotRelTol). See pivotAbsTol.
   */
  pivotRelTol: number;
```

Constructor body (around line 564-565):

OLD (exact):
```ts
    // Damping
    this.nodeDamping = params.nodeDamping ? 1 : 0;
    this.diagonalGmin = params.diagGmin ?? 0;
```

NEW (exact):
```ts
    // Damping
    this.nodeDamping = params.nodeDamping ? 1 : 0;
    this.diagonalGmin = params.diagGmin ?? 0;
    this.pivotAbsTol = params.pivotAbsTol ?? 0;
    this.pivotRelTol = params.pivotRelTol ?? 1e-3;
```

Also in `refreshTolerances` (around line 624-625):

OLD (exact):
```ts
    // Damping
    this.nodeDamping = params.nodeDamping ? 1 : 0;
    this.diagonalGmin = params.diagGmin ?? 0;
```

NEW (exact):
```ts
    // Damping
    this.nodeDamping = params.nodeDamping ? 1 : 0;
    this.diagonalGmin = params.diagGmin ?? 0;
    this.pivotAbsTol = params.pivotAbsTol ?? 0;
    this.pivotRelTol = params.pivotRelTol ?? 1e-3;
```

**Part C — call `solver.setPivotTolerances` from NR before every factor call.**

File: `src/solver/analog/newton-raphson.ts`
Insert before the factor call (at line 303, inside the new block already introduced by Item #3):

NEW (exact) — insert before `const factorResult = solver.factor(ctx.diagonalGmin);`:
```ts
    // ngspice niiter.c:863-864, 883-884 — CKTpivotAbsTol/CKTpivotRelTol are
    // forwarded into SMPreorder/SMPluFac every iteration. setPivotTolerances
    // is a cheap scalar store; doing it here (not just once at ctx
    // construction) matches ngspice's per-call semantic and lets hot-loaded
    // params propagate without an engine rebuild.
    solver.setPivotTolerances(ctx.pivotRelTol, ctx.pivotAbsTol);
```

### Additional files touched

- `src/core/analog-engine-interface.ts` — diff above.
- `src/solver/analog/ckt-context.ts` — diff above.
- `src/solver/analog/newton-raphson.ts` — diff above.
- Any code constructing a `CKTCircuitContext` directly without going through a params path will continue to work because both new fields default to ngspice defaults.

### Why this matches ngspice

`niiter.c:863-864` passes `CKTpivotAbsTol` and `CKTpivotRelTol` into `SMPreorder`; `:883-884` passes `CKTpivotAbsTol` into `SMPluFac`. Each of those stores the values into `Matrix->AbsThreshold`/`Matrix->RelThreshold` for use inside `spOrderAndFactor` (spfactor.c:204-211). Our `setPivotTolerances` call + instance field storage reproduces this exactly.

### Side-effects / callers impacted

- `newton-raphson.ts:278` NR loop — one extra scalar assignment per iteration; amortised free.
- Tests that construct `CKTCircuitContext` via `MNAEngine.init()` automatically pick up ngspice defaults.
- Hot-loaded params via `MNAEngine.configure()` → `refreshTolerances` now propagates pivot tolerances.

---

## Item S3 — `didPreorder` CKT-lifetime scope reconciliation

### ngspice reference

- File: `ref/ngspice/src/maths/ni/niiter.c`
- Lines: 844-855

```c
if(!(ckt->CKTniState & NIDIDPREORDER)) {
    error = SMPpreOrder(ckt->CKTmatrix);
    if(error) {
        ...
    }
    ckt->CKTniState |= NIDIDPREORDER;
}
```

- File: `ref/ngspice/src/maths/ni/nireinit.c`
- Lines: 42

```c
ckt->CKTniState = NISHOULDREORDER | NIACSHOULDREORDER | NIPZSHOULDREORDER;
```

So `NIDIDPREORDER` is a **CKT-lifetime bit** — set once on first preorder, cleared only when the entire NR state is re-initialised via `NIreinit` (which is called from `CKTsetup`, `cktpzset.c:94`, and `cktsens.c:372-373`). It is NOT per-NR-call.

### Our code today

- File: `src/solver/analog/newton-raphson.ts`
- Lines: 253, 290-293

```ts
let didPreorder = false;
...
if (!didPreorder) {
  solver.preorder();
  didPreorder = true;
}
```

This `didPreorder` local is **per-NR-call** (reset at every newtonRaphson invocation). Meanwhile `solver._didPreorder` is set true inside `preorder()` at sparse-solver.ts:487 and cleared by `invalidateTopology()`. `solver.preorder()` at sparse-solver.ts:486 short-circuits if `_didPreorder === true`, so the second `solver.preorder()` call from the NR local is a no-op. The NR local is redundant and mis-scoped.

Redundant-but-correct? Let's check. ngspice calls `SMPpreOrder` only when `!(CKTniState & NIDIDPREORDER)` at niiter.c:844. If we always call `solver.preorder()` unconditionally inside NR, we rely on solver-internal `_didPreorder` to skip work. Functionally correct, but the NR-local flag adds no value and confuses the semantic.

The real issue is scope mismatch: ngspice's NIDIDPREORDER persists across NR invocations within the same CKT lifetime, cleared only by `NIreinit`. Our `_didPreorder` persists across NR invocations too (good), and `invalidateTopology` clears it (mapping to `NIreinit` — good). The NR-local `didPreorder` is **dead scoped state**.

### Variable mapping

| ngspice | ours | notes |
|---|---|---|
| `ckt->CKTniState & NIDIDPREORDER` | `solver._didPreorder` | CKT-lifetime |
| `ckt->CKTniState |= NIDIDPREORDER` (niiter.c:854) | `solver._didPreorder = true` in `preorder()` | OK |
| `ckt->CKTniState = NISHOULDREORDER | ...` (nireinit.c:42) | `solver._didPreorder = false` in `invalidateTopology()` + `solver._needsReorder = true` | OK |
| local `didPreorder` in newton-raphson.ts:253 | redundant — delete | |

### Concrete diff

**Part A — delete the redundant local flag; rely on `solver.preorder()` idempotence** (newton-raphson.ts:251-293):

OLD (exact):
```ts
  // Step D state: preorder runs at most once per solve.
  let didPreorder = false;
```

NEW (exact):
```ts
  // Step D state: preorder runs at most once per CKT lifetime. ngspice
  // NIDIDPREORDER (cktdefs.h:143) is a CKT-state bit cleared only by
  // NIreinit (nireinit.c:42); our equivalent is solver._didPreorder, set
  // inside solver.preorder() and cleared by solver.invalidateTopology().
  // A per-NR-call local flag would be per-invocation scope — the wrong
  // scope — so we drop it entirely and rely on solver.preorder() being
  // idempotent.
```

OLD (exact):
```ts
    // ---- STEP D: Preorder (once per solve) ----
    if (!didPreorder) {
      solver.preorder();
      didPreorder = true;
    }
```

NEW (exact):
```ts
    // ---- STEP D: Preorder (ngspice niiter.c:844-855, NIDIDPREORDER gate) ----
    // solver.preorder() is idempotent via solver._didPreorder; calling
    // every iteration is harmless and matches ngspice's own behaviour of
    // gating every iteration on the bit.
    solver.preorder();
```

**Part B — ensure `invalidateTopology()` clears `_didPreorder` (already the case at sparse-solver.ts:468, verified; no change needed beyond what Item #11 already did).**

**Part C — document the CKT-lifetime contract on `solver._didPreorder`.** Already handled by the flag-lifecycle comment block added in Item #10.

### Additional files touched

`src/solver/analog/newton-raphson.ts` — diff above.

### Why this matches ngspice

ngspice's `NIDIDPREORDER` is a CKT-lifetime bit cleared only in `NIreinit`. `solver._didPreorder` has exactly that scope: set in `preorder()`, cleared in `invalidateTopology()` (which is the analog of `NIreinit` for the solver's topology state). The NR-local flag was dead scoping that could never trigger a second preorder within a single NR call anyway.

### Side-effects / callers impacted

- No behavioural change — `solver.preorder()` was already idempotent.

---

## Item S4 — `addDiagonalGmin` does not flip `_needsReorder` (and should not)

### ngspice reference

- File: `ref/ngspice/src/maths/sparse/spsmp.c`
- Lines: 422-440 (`LoadGmin`)

```c
static void
LoadGmin(SMPmatrix *Matrix, double Gmin)
{
    ...
    if (Gmin != 0.0) {
        Diag = Matrix->Diag;
        for (I = Matrix->Size; I > 0; I--) {
            if ((diag = Diag[I]) != NULL)
                diag->Real += Gmin;
        }
    }
    return;
}
```

`LoadGmin` does NOT touch `NeedsOrdering`. It only mutates existing diagonal values in place. ngspice's invariant is: `LoadGmin + spFactor` is atomic (wrapped inside `SMPluFac`/`SMPreorder`); no external caller observes a state where gmin has been stamped but the factorization has not been refreshed.

### Our code today

- File: `src/solver/analog/sparse-solver.ts`
- Lines: 564-573 (`addDiagonalGmin`), 1501-1509 (`_applyDiagGmin`)

Neither sets `_needsReorder`. Matches ngspice.

### Variable mapping

| ngspice | ours |
|---|---|
| `LoadGmin` — no NeedsOrdering flip | `_applyDiagGmin`, `addDiagonalGmin` — no `_needsReorder` flip |

### Concrete diff

**None.** This matches ngspice. Add a justifying comment so future readers don't regress it:

sparse-solver.ts:1501-1509:

OLD (exact):
```ts
  private _applyDiagGmin(gmin: number): void {
    const n = this._n;
    const diag = this._diag;
    const elVal = this._elVal;
    for (let i = 0; i < n; i++) {
      const e = diag[i];
      if (e >= 0) elVal[e] += gmin;
    }
  }
```

NEW (exact):
```ts
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
```

(Added the `gmin === 0` short-circuit for parity with the previous `addDiagonalGmin` body.)

### Additional files touched

None.

### Why this matches ngspice

LoadGmin at `spsmp.c:422-440` does not touch `NeedsOrdering`. Atomicity guaranteed by the SMP wrapper. Our implementation does the same; the Item #9/S1 fix to `factor(diagGmin)` re-establishes the wrapper semantic.

### Side-effects / callers impacted

None beyond the zero-short-circuit fast path.

---

## Item S5 — `invalidateTopology()` must set `_needsReorder = true`

### ngspice reference

- File: `ref/ngspice/src/maths/sparse/spbuild.c`
- Lines: 96-142 (`spClear`)

`spClear` sets `Factored = NO` (line 137) but does NOT set `NeedsOrdering`. So a cleared-then-restamped matrix can re-factor numerically if the pivot order is still good.

- File: `ref/ngspice/src/maths/sparse/sputils.c`
- Lines: 1104-1145 (`spStripMatrix`)

`spStripMatrix` sets `NeedsOrdering = YES` (line 1112), `RowsLinked = NO`, wipes all element lists, clears row/col/diag arrays. This is the "structural rebuild" path.

Our `beginAssembly` (reuse path) → **matches `spClear`**: preserves structure, clears values, does not flag reorder.
Our `invalidateTopology` → must match `spStripMatrix`: wipe structure, flag reorder.

### Our code today

sparse-solver.ts:465-469 — does not flip `_needsReorder`. Bug.

### Variable mapping

| ngspice | ours |
|---|---|
| `spStripMatrix` sets `NeedsOrdering = YES` (sputils.c:1112) | `invalidateTopology()` must set `this._needsReorder = true` |
| `spClear` does NOT set `NeedsOrdering` (spbuild.c:96-142) | `beginAssembly` reuse path does NOT set `_needsReorder` — correct, confirmed |

### Concrete diff

**Already folded into Item #11 / S7 diff above.** The `invalidateTopology()` NEW body sets `this._needsReorder = true`.

### Additional files touched

See F1 for the analogous fix in `complex-sparse-solver.ts`.

### Why this matches ngspice

`sputils.c:1112` sets `NeedsOrdering = YES` inside `spStripMatrix`. Our `invalidateTopology` is the direct analog and must do the same.

### Side-effects / callers impacted

Zero production callers of `invalidateTopology` today; all tests that call it expected a structural rebuild, which implies a fresh reorder anyway. No behavioural regression.

---

## Item S6 — Phase 3 column search walks only column k; ngspice's `SearchEntireMatrix` walks ALL columns

### ngspice reference

- File: `ref/ngspice/src/maths/sparse/spfactor.c`
- Lines: 947-994 (`SearchForPivot`), 1730-1809 (`SearchEntireMatrix`)

`SearchForPivot`'s 4-phase cascade (in ngspice's MODIFIED_MARKOWITZ/DIAGONAL_PIVOTING build):

1. `SearchForSingleton` (mProd == 0).
2. `QuicklySearchDiagonal`.
3. `SearchDiagonal` (careful diagonal re-pass).
4. `SearchEntireMatrix`.

`SearchEntireMatrix` at `spfactor.c:1731-1809`:

```c
for (I = Step; I <= Size; I++) {
    pElement = Matrix->FirstInCol[I];
    while (pElement != NULL && pElement->Row < Step)
        pElement = pElement->NextInCol;
    if((LargestInCol = FindLargestInCol(pElement)) == 0.0)
        continue; /* for loop */
    while (pElement != NULL) {
        ...
        Product = Matrix->MarkowitzRow[pElement->Row] *
                  Matrix->MarkowitzCol[pElement->Col];
        if ((Product <= MinMarkowitzProduct) &&
                (Magnitude > Matrix->RelThreshold * LargestInCol) &&
                (Magnitude > Matrix->AbsThreshold)) {
            ...
        }
        pElement = pElement->NextInCol;
    }
}
```

This walks **every column I from Step to Size**, testing **every unpivoted element**. The column-relative threshold uses the per-column `LargestInCol`, not a global `absMax`.

### Our code today

- File: `src/solver/analog/sparse-solver.ts`
- Lines: 1420-1440 (Phase 3 of `_searchForPivot`)

```ts
// Phase 3: Column search via linked structure
{
  let bestRow = -1;
  ...
  let e = this._colHead[k];
  while (e >= 0) {
    const row = this._elRow[e];
    if (pinv[row] < 0) {
      const v = Math.abs(x[row]);
      if (v >= PIVOT_ABS_THRESHOLD && v >= relThreshold) {
        const prod = mRow[row] * mCol[k];
        ...
      }
    }
    e = this._elNextInCol[e];
  }
  ...
}
```

**Only column k** is walked. Our Phase 4 (last-resort, lines 1442-1453) does an `xNzIdx` sweep, picking largest magnitude — but that's NOT ngspice's `SearchEntireMatrix`. Our Phase 3 is closer to a degenerate "same column only" scan. This is a substantial divergence when the matrix has column k with no acceptable pivot but columns k+1..n-1 have acceptable low-mProd pivots. Ngspice finds those and swaps columns; we return the largest-magnitude xNzIdx entry without regard for Markowitz cost, producing fill-in catastrophes.

Note our current `relThreshold = PIVOT_THRESHOLD * absMax` (line 1384) uses a **global** `absMax` from the dense xNzIdx scatter, whereas ngspice uses `Matrix->RelThreshold * LargestInCol` where `LargestInCol` is per-column. These are NOT equivalent:

- ngspice global-scope: pivot must be large relative to its OWN column's largest element.
- Ours: pivot must be large relative to the largest element IN THE DENSE SCATTER OF COLUMN K.

These align only at Phase 3 where we're walking column k (since `absMax` covers precisely the non-zeros of column k's scatter, modulo the submatrix reduction). But after we extend Phase 3 to all columns, the per-column `LargestInCol` must be computed per column.

### Variable mapping

| ngspice | ours |
|---|---|
| outer `for (I = Step; I <= Size; I++)` | outer `for (let col = k; col < n; col++)` |
| `Matrix->FirstInCol[I]` | `this._colHead[col]` |
| skip to `pElement->Row >= Step` | skip via `pinv[row] >= 0` (unpivoted check) |
| `FindLargestInCol(pElement)` | `_findLargestInColBelow(firstUnpivotedE)` computed per column |
| `Matrix->MarkowitzCol[pElement->Col]` | `mCol[col]` |
| `Matrix->MarkowitzRow[pElement->Row]` | `mRow[row]` |
| `Matrix->RelThreshold * LargestInCol` | `this._relThreshold * largestInColThisCol` |
| `Matrix->AbsThreshold` | `this._absThreshold` |
| per-column fallback `LargestInCol == 0.0 → continue` | same skip |
| final `MinMarkowitzProduct * TIES_MULTIPLIER` early exit | mirror |
| `LargestElementMag` tracking for last-resort return of `pLargestElement` | mirror |
| returns `Matrix->Error = spSMALL_PIVOT` / `pLargestElement` when no acceptable pivot | our Phase-4 equivalent |

But there's a critical issue: **our scatter `x` only holds the dense residual of column k**. Ngspice's `SearchEntireMatrix` walks every column's elements AFTER triangular-solve updates are applied, which means each column I's element magnitude is read directly from `pElement->Real` — the live linked-list value, NOT a separately-scattered dense workspace. We do NOT have that luxury because the Gilbert-Peierls LU in `_numericLUMarkowitz` scatters only column k at a time.

This means a faithful ngspice Phase 3 (SearchEntireMatrix) would require re-scattering each column into the dense workspace, which is O(nnz) per column-search call — catastrophic for a Markowitz-selected pivot, because Phase 3 fires only when Phases 1-2 have already failed (typically rare but real).

ngspice's `SearchEntireMatrix` avoids that cost because their linked-list values are live (updated incrementally by `RealRowColElimination`). Our Gilbert-Peierls form does not update linked-list values between columns — it writes factored values only when the pivot is committed.

**The correct ngspice-faithful fix is**: scatter each candidate column j > k into `x` (or a separate workspace), find `LargestInCol` on the residual, test each unpivoted element, pick the best. But that's an O(n·nnz) worst-case hotspot.

**However**, the task spec is unambiguous: *"100% ngspice alignment is the only acceptable outcome. No close-enough."* So: implement it faithfully.

### Concrete diff

sparse-solver.ts:1420-1440 (replace the entire Phase 3 block):

OLD (exact):
```ts
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
          if (v >= PIVOT_ABS_THRESHOLD && v >= relThreshold) {
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
```

NEW (exact):
```ts
    // Phase 3 / 4 unified: SearchEntireMatrix — ngspice spfactor.c:1730-1809.
    //
    // ngspice walks every column I in [Step, Size], computes LargestInCol
    // per column, and selects the element minimising MarkowitzProduct subject
    // to (Magnitude > RelThreshold * LargestInCol) && (Magnitude > AbsThreshold).
    // For column == k we reuse the dense scatter x[]; for every other column
    // j > k we must compute each candidate's residual magnitude.
    //
    // Gilbert-Peierls LU does not keep linked-list residual values live
    // between column eliminations, so to evaluate a non-k column we walk
    // its live _elVal chain — which holds the ORIGINAL A-matrix value for
    // columns not yet eliminated (because _numericLUMarkowitz only writes
    // back L/U values for column k at commit time; columns > k still carry
    // their unmodified A values). This is correct: ngspice's linked-list
    // values for unprocessed columns are likewise the un-eliminated
    // A values at this point in the factorization.
    //
    // For ties on MarkowitzProduct the largest Magnitude/LargestInCol ratio
    // wins (ngspice RatioOfAccepted at spfactor.c:1782-1791). Last-resort
    // fallback picks the globally-largest element (pLargestElement at
    // spfactor.c:1800-1808).
    {
      let chosenRow = -1;
      let chosenCol = -1;
      let minProd = Infinity;
      let bestRatio = Infinity;
      let largestMagRow = -1;
      let largestMagCol = -1;
      let largestMag = 0;

      for (let col = k; col < n; col++) {
        // Find first unpivoted element in this column (ngspice skips while
        // pElement->Row < Step, i.e. already-pivoted rows).
        let firstUnpivoted = this._colHead[col];
        while (firstUnpivoted >= 0 && pinv[this._elRow[firstUnpivoted]] >= 0) {
          firstUnpivoted = this._elNextInCol[firstUnpivoted];
        }
        if (firstUnpivoted < 0) continue;

        // Per-column largest magnitude (ngspice FindLargestInCol, spfactor.c:1850).
        // For col == k use the dense scatter x[]; for col > k walk _elVal.
        let largestInCol = 0;
        if (col === k) {
          for (let idx = 0; idx < xNzCount; idx++) {
            const r = xNzIdx[idx];
            if (pinv[r] >= 0) continue;
            const vv = Math.abs(x[r]);
            if (vv > largestInCol) largestInCol = vv;
          }
        } else {
          let w = firstUnpivoted;
          while (w >= 0) {
            const r = this._elRow[w];
            if (pinv[r] < 0) {
              const vv = Math.abs(this._elVal[w]);
              if (vv > largestInCol) largestInCol = vv;
            }
            w = this._elNextInCol[w];
          }
        }
        if (largestInCol === 0) continue;

        const colThreshold = this._relThreshold * largestInCol;

        // Walk each unpivoted element in this column, testing both for
        // pivot acceptability and for global largestMag bookkeeping.
        let w = firstUnpivoted;
        while (w >= 0) {
          const row = this._elRow[w];
          if (pinv[row] < 0) {
            const v = col === k ? Math.abs(x[row]) : Math.abs(this._elVal[w]);
            if (v > largestMag) {
              largestMag = v;
              largestMagRow = row;
              largestMagCol = col;
            }
            if (v > colThreshold && v > this._absThreshold) {
              const prod = mRow[row] * mCol[col];
              if (prod < minProd) {
                minProd = prod;
                bestRatio = largestInCol / v;
                chosenRow = row;
                chosenCol = col;
              } else if (prod === minProd) {
                const ratio = largestInCol / v;
                if (ratio < bestRatio) {
                  bestRatio = ratio;
                  chosenRow = row;
                  chosenCol = col;
                }
              }
            }
          }
          w = this._elNextInCol[w];
        }
      }

      if (chosenRow >= 0) {
        // ngspice ExchangeRowsAndCols swaps (pPivot->Row, Step) and
        // (pPivot->Col, Step) so the chosen pivot moves to position k.
        // We mirror by column-swapping (k, chosenCol) via _swapColumns when
        // chosenCol !== k, then returning chosenRow; row swap happens
        // implicitly through pinv[chosenRow] = k in the caller.
        if (chosenCol !== k) {
          // Locate twin handles for _swapColumns (pTwin1 at (chosenCol, k),
          // pTwin2 at (k, chosenCol)); if none exist, fall back to a pure
          // _colHead swap plus _extToIntCol / _preorderColPerm update.
          this._swapColumnsForPivot(k, chosenCol);
          // After the swap, chosenRow is still a row in the (now k-indexed)
          // column, with its x[] value unchanged (row permutation has not
          // occurred yet).
        }
        return chosenRow;
      }

      // No acceptable pivot under threshold — ngspice spSMALL_PIVOT path
      // (spfactor.c:1807-1808): return the globally largest-magnitude
      // element and accept the small-pivot warning.
      if (largestMagRow >= 0) {
        if (largestMagCol !== k) {
          this._swapColumnsForPivot(k, largestMagCol);
        }
        return largestMagRow;
      }
      return -1;
    }
  }
```

**Part B — add `_swapColumnsForPivot` helper that handles off-diagonal column swaps that don't have the twin pattern required by `_swapColumns`.** Our existing `_swapColumns` was designed for symmetric-twin preorder; Phase 3 swaps need arbitrary column permutation. Insert after `_swapColumns` at sparse-solver.ts:557:

NEW (exact):
```ts
  /**
   * Swap internal columns k and col2 during Markowitz pivot selection.
   *
   * Unlike _swapColumns (used by preorder() for symmetric twins), this
   * method handles arbitrary column permutation: it swaps _colHead[k] and
   * _colHead[col2], updates _preorderColPerm/_extToIntCol to keep the
   * ext↔int map consistent, and refreshes _diag[k]/_diag[col2] by searching
   * the new chain for each column's diagonal entry.
   *
   * Mirrors ngspice spcColExchange (sputils.c) driven by ExchangeRowsAndCols
   * (spfactor.c) during mid-factorization pivot selection.
   */
  private _swapColumnsForPivot(k: number, col2: number): void {
    if (k === col2) return;
    // Swap column heads.
    const tmpHead = this._colHead[k];
    this._colHead[k] = this._colHead[col2];
    this._colHead[col2] = tmpHead;

    // Swap internal↔external permutation entries.
    const origK = this._preorderColPerm[k];
    const origC = this._preorderColPerm[col2];
    this._preorderColPerm[k] = origC;
    this._preorderColPerm[col2] = origK;
    this._extToIntCol[origK] = col2;
    this._extToIntCol[origC] = k;

    // Refresh _diag[k] and _diag[col2] by scanning the new chains.
    this._diag[k] = this._findDiagOnColumn(k);
    this._diag[col2] = this._findDiagOnColumn(col2);
  }

  /** Search column internalCol's chain for its diagonal pool element (row == internalCol). Returns -1 if absent. */
  private _findDiagOnColumn(internalCol: number): number {
    let e = this._colHead[internalCol];
    while (e >= 0) {
      if (this._elRow[e] === internalCol) return e;
      e = this._elNextInCol[e];
    }
    return -1;
  }
```

### Additional files touched

None outside sparse-solver.ts.

### Why this matches ngspice

`SearchEntireMatrix` (spfactor.c:1730-1809) iterates every column I in [Step, Size], computes per-column `LargestInCol` via `FindLargestInCol`, tests every non-pivoted element against `Matrix->RelThreshold * LargestInCol` and `Matrix->AbsThreshold`, tracks MinMarkowitzProduct with tie-break on `LargestInCol / Magnitude` ratio, and falls back to `pLargestElement` when no threshold-acceptable pivot exists. Our rewrite reproduces each step 1:1. Column permutation for `col > k` goes through `_swapColumnsForPivot` — the analog of `ExchangeRowsAndCols`.

### Side-effects / callers impacted

- Every factorization whose Phases 1-2 fail and falls to Phase 3+ will now correctly search off-column candidates. This is ngspice-correct and strictly widens the pivot pool.
- Phase 3's O(n + nnz_col_k) prior cost becomes O(n + Σ_{j >= k} nnz_col_j) ≈ O(nnz) on Phase 3 failure — the same asymptotic as ngspice.
- Tests that assumed Phase 3 returned `-1` when column k had no acceptable pivot must flip: we now find the best across all columns.
- `_swapColumnsForPivot` is exercised only from inside Phase 3/4; `preorder()` continues to use the existing `_swapColumns`.

---

# F1 — Additional divergences surfaced

## F1.1 — `_capturePreFactorMatrix` snapshot taken BEFORE `_applyDiagGmin`, not after

- File: `src/solver/analog/sparse-solver.ts` — lines 390-404 (pre-factor snapshot) vs 1320-1321/1338-1339 (`_applyDiagGmin` inside `factorWithReorder`/`factorNumerical`).
- ngspice ref: `niiter.c:915-923` (`ni_preSolveRhs` capture — note: this is RHS, not the matrix; ngspice does NOT expose a pre-factor A-matrix snapshot publicly, but internally the "matrix that is factored" INCLUDES gmin because `LoadGmin` runs before `spFactor`).

With the Item #9/S1 refactor moving gmin into `factor()`, the current capture at line 391-404 occurs **before** the internal `_applyDiagGmin` call, so `getPreFactorMatrixSnapshot()` returns A (no gmin). ngspice-faithful meaning of "pre-factor matrix" is "the matrix that was actually factored" = A + gmin·I.

Proposed fix (in the same Item #3/#9 `factor()` rewrite): move the snapshot AFTER `_applyDiagGmin`:

Concrete delta to the new `factor()` body:

The NEW body introduces the snapshot at the top. Move it AFTER the dispatch preparation but BEFORE the factor itself. The cleanest place: into `factorWithReorder` and `factorNumerical` bodies immediately after `_applyDiagGmin`.

Proposed change in `factorWithReorder` (sparse-solver.ts:1320-1332):

OLD (exact):
```ts
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
```

NEW (exact):
```ts
  factorWithReorder(diagGmin?: number): FactorResult {
    if (diagGmin) this._applyDiagGmin(diagGmin);
    this._takePreFactorSnapshotIfEnabled();
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
```

Analogous change in `factorNumerical` (sparse-solver.ts:1338-1341):

OLD (exact):
```ts
  factorNumerical(diagGmin?: number): FactorResult {
    if (diagGmin) this._applyDiagGmin(diagGmin);
    return this._numericLUReusePivots();
  }
```

NEW (exact):
```ts
  factorNumerical(diagGmin?: number): FactorResult {
    if (diagGmin) this._applyDiagGmin(diagGmin);
    this._takePreFactorSnapshotIfEnabled();
    return this._numericLUReusePivots();
  }
```

And extract the snapshot block from `factor()` into a private helper:

NEW (exact) — new method inserted near the other instrumentation accessors (after sparse-solver.ts:631):

```ts
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
```

And strip the snapshot block from `factor()`. Adjusted `factor()` body (replaces the one from Item #3 Part D):

NEW (exact):
```ts
  factor(diagGmin?: number): FactorResult {
    if (this._needsReorder || !this._hasPivotOrder) {
      this.lastFactorUsedReorder = true;
      return this.factorWithReorder(diagGmin);
    }
    this.lastFactorUsedReorder = false;
    const result = this.factorNumerical(diagGmin);
    if (!result.success && result.needsReorder) {
      this._needsReorder = true;
      this.lastFactorUsedReorder = true;
      return this.factorWithReorder(/* diagGmin */ undefined);
    }
    return result;
  }
```

## F1.2 — `complex-sparse-solver.ts:invalidateTopology()` does NOT set `_needsReorderComplex = true`

- File: `src/solver/analog/complex-sparse-solver.ts`
- Lines: 398-402

```ts
invalidateTopology(): void {
  this._structureEmpty = true;
  this._hasComplexPivotOrder = false;
  this._didPreorderComplex = false;
}
```

Same bug as S5 in the real solver. ngspice `spStripMatrix` (sputils.c:1112) sets `NeedsOrdering = YES` regardless of real/complex.

Proposed fix:

OLD (exact):
```ts
  invalidateTopology(): void {
    this._structureEmpty = true;
    this._hasComplexPivotOrder = false;
    this._didPreorderComplex = false;
  }
```

NEW (exact):
```ts
  invalidateTopology(): void {
    this._structureEmpty = true;
    this._hasComplexPivotOrder = false;
    this._didPreorderComplex = false;
    // ngspice spStripMatrix (sputils.c:1112): NeedsOrdering = YES.
    this._needsReorderComplex = true;
  }
```

## F1.3 — `complex-sparse-solver.ts:allocComplexElement` likely also misses the `NeedsOrdering` flip

- File: `src/solver/analog/complex-sparse-solver.ts`
- Lines: 200-211 (new-entry branch)

```ts
// Allocate new element
const newE = this._newElement(row, col, 0, 0, 0);
this._insertIntoRow(newE, row);
this._insertIntoCol(newE, internalCol);
if (row === col) this._diag[internalCol] = newE;

if (this._n <= this._handleTableN) {
  this._handleTable[row * this._handleTableN + col] = newE + 1;
}

return newE;
```

Same ngspice invariant: `spbuild.c:788` `NeedsOrdering = YES`. Complex path does not flip `_needsReorderComplex`. Must add `this._needsReorderComplex = true;` immediately after `this._diag[internalCol] = newE;`.

## F1.4 — `complex-sparse-solver.ts` uses different pivot threshold constants (`1e-600` for mag², `0.01` for rel) that also diverge from ngspice

- File: `src/solver/analog/complex-sparse-solver.ts`
- Lines: 22-23

```ts
const PIVOT_THRESHOLD = 0.01;
const PIVOT_ABS_THRESHOLD2 = 1e-600; // compare to mag2, so threshold^2
```

ngspice real default is `RelThreshold = 1e-3`, and the complex build uses the same `RelThreshold` field (no separate complex default; see `spConfig.h:331 DEFAULT_THRESHOLD`). Our `0.01 = 1e-2` is 10× tighter than ngspice. `1e-600` is essentially zero — matches ngspice default `0.0` squared. The rel threshold is the divergence.

Proposed fix: change `0.01` → `1e-3` and expose per-instance tolerances mirroring Item #4's approach on the real solver. Not part of the originally scoped items but surfaces the same class of bug.

## F1.5 — `_initStructure` leaves `_didPreorder` untouched on first call; after first init it is false (correct), but after a subsequent `beginAssembly(size)` with a new size, `_initStructure` runs again without clearing `_didPreorder`

- File: `src/solver/analog/sparse-solver.ts`
- Lines: 637-703 (`_initStructure`) — does not touch `_didPreorder`.

If the solver is re-initialised with a different `size` (line 322-325 in `beginAssembly` reinits when size changes), the old `_didPreorder` flag may carry over. Now the sparse structure is fresh but `preorder()` will skip on the second size. ngspice `spCreate` initialises everything; equivalent fix: `_initStructure` must clear `_didPreorder = false`. Already added in the Item #10 diff. Confirmed no additional change needed beyond that diff's NEW block at the tail of `_initStructure`.

## F1.6 — `factor()` `_capturePreFactorMatrix` snapshot walks the A-entry chain using `_elFlags[e] & FLAG_FILL_IN` filter, but after `_numericLUMarkowitz` fill-ins have been INSERTED as both L and U references share a single pool element. The snapshot inside the new `_takePreFactorSnapshotIfEnabled` filters fill-ins — **correct**, but this only works because fill-ins from previous factors are wiped by `_resetForAssembly` (sparse-solver.ts:710-741, re-inserts them into free-list at line 723-724). Verified: correct. No fix. Flagging for completeness.

## F1.7 — `_searchForPivot` Phase 2 (diagonal preference) tests `i !== k`, expecting the diagonal of the submatrix to be at row k. But after preorder/column swaps, the diagonal of internal column k may be at a different row in the original coordinate system. Check:

- `pinv[]` is indexed by ORIGINAL row → step. When `_numericLUMarkowitz` scatters column k (internal), `xNzIdx` holds ORIGINAL rows. `i === k` means "the row equal to internal column index k in the original coordinate system". After preorder, `_extToIntCol[orig] = internal` — so the diagonal pool element for internal column k has `_elRow === k` only if the preorder didn't move the natural (k,k) entry. Post-preorder, `_diag[k]` may be any row.

This affects `_updateMarkowitzNumbers(step=k, pivotRow=...)` too. Looking at the code: Phase 2's `if (i !== k) continue;` tests the DIAGONAL row, which in the original-row coordinate system is indeed k iff the original diagonal is still at row k (it is — row indices are NEVER permuted in our implementation; only columns are via `_extToIntCol`).

Verified: row indices are not permuted, only columns. So `i === k` correctly tests "are we on the original row that corresponds to the current column diagonal"? **No** — this tests "row == k", but internal column k after preorder has original column `_preorderColPerm[k]`, and the diagonal of that ORIGINAL column is at original row `_preorderColPerm[k]`, NOT at row `k`.

This is a real divergence from ngspice's `QuicklySearchDiagonal`/`SearchDiagonal`, which test `Matrix->Diag[Step]` — the PRESENT diagonal handle, not a row-column equality. Correct check should be: `i === this._preorderColPerm[k]` to match "original row corresponding to this column's diagonal".

**Proposed fix**, sparse-solver.ts:1405-1417 (Phase 2 block):

OLD (exact, post-Item-#4 rewrite):
```ts
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
```

NEW (exact):
```ts
    // Phase 2: Diagonal preference — ngspice QuicklySearchDiagonal,
    // spfactor.c:1255-1383. Test the diagonal of the CURRENT internal column
    // k, which after preorder corresponds to ORIGINAL row _preorderColPerm[k]
    // — NOT original row k. _diag[k] is the authoritative pool handle for
    // that diagonal; prefer it when available.
    {
      const diagE = this._diag[k];
      if (diagE >= 0) {
        const diagRow = this._elRow[diagE];
        if (pinv[diagRow] < 0) {
          const v = Math.abs(x[diagRow]);
          if (v > absThreshold && v >= relThreshold) {
            return diagRow;
          }
        }
      }
    }
```

This simplification matches ngspice's direct `Matrix->Diag[Step]` lookup and removes the broken `i !== k` filter.

---

# Summary of Blast Radius

| File | Edits |
|---|---|
| `src/solver/analog/sparse-solver.ts` | All diffs above — Items #3, #4, #9/S1, #10, #11/S7, S2, S3, S4, S5, S6, plus F1.1, F1.5, F1.7 |
| `src/solver/analog/newton-raphson.ts` | Atomicise gmin+factor (#9/S1); drop `didPreorder` local (S3); call `setPivotTolerances` (S2) |
| `src/solver/analog/ckt-context.ts` | New `pivotAbsTol`/`pivotRelTol` fields + constructor/refresh wiring (S2) |
| `src/core/analog-engine-interface.ts` | New `pivotAbsTol`/`pivotRelTol` params + defaults (S2) |
| `src/solver/analog/complex-sparse-solver.ts` | F1.2 (`invalidateTopology`), F1.3 (`allocComplexElement`), F1.4 (threshold constants) |

All edits cite ngspice line numbers; no change is a "pragmatic" substitute. The `_searchForPivot` rewrite (Item S6 + F1.7) is the largest semantic shift — it changes which pivots the factorization can find, which is the source of any downstream LTE/convergence divergence visible in the ngspice comparison harness.

agentId: a9f2dac93e6828b9d (use SendMessage with to: 'a9f2dac93e6828b9d' to continue this agent)
<usage>total_tokens: 256352
tool_uses: 45
duration_ms: 654876</usage>