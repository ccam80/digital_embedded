# Sparse Solver Parity Audit: solve(), RHS stamping, Gmin, accessors

**Audit date:** 2026-04-26  
**digiTS file:** `src/solver/analog/sparse-solver.ts`  
**ngspice references:** `ref/ngspice/src/maths/sparse/spsolve.c`, `ref/ngspice/src/maths/sparse/spsmp.c`

---

## Function: `solve()` (lines 566–651)

Maps ngspice `spSolve` (spsolve.c:127–191).

| digiTS line# | digiTS code | ngspice file:line# | ngspice code | classifier |
|---|---|---|---|---|
| 567 | `const n = this._n;` | spsolve.c:146 | `Size = Matrix->Size;` | MATCH |
| 568 | `if (n === 0) return;` | spsolve.c:N/A | (no early-exit guard) | DIFF |
| 570–579 | Local variable declarations | spsolve.c:130–134 | ElementPtr/RealVector/int declarations | MATCH |
| 589 | `for (let k = 0; k < n; k++) b[k] = rhs[intToExtRow[k]];` | spsolve.c:149–151 | `pExtOrder = &Matrix->IntToExtRowMap[Size]; for (I = Size; I > 0; I--) Intermediate[I] = RHS[*(pExtOrder--)];` | DIFF |
| 607–619 | Forward-elimination loop with `temp !== 0.0` guard | spsolve.c:154–170 | 0-based vs 1-based, forward vs reverse indexing | DIFF |
| 608–609 | `let temp = b[k]; if (temp !== 0.0) {` | spsolve.c:158 | `if ((Temp = Intermediate[I]) != 0.0) {` | MATCH |
| 610–611 | `const pPivot = diag[k]; temp *= elVal[pPivot];` | spsolve.c:160–161 | `pPivot = Matrix->Diag[I]; Intermediate[I] = (Temp *= pPivot->Real);` | MATCH |
| 612 | `b[k] = temp;` | spsolve.c:161 | `Intermediate[I] = (Temp *= pPivot->Real);` | MATCH |
| 613–617 | Column walk: `while (pElement >= 0) { b[elRow[pElement]] -= temp * elVal[pElement]; ... }` | spsolve.c:163–168 | `while (pElement != NULL) { Intermediate[pElement->Row] -= Temp * pElement->Real; ... }` | MATCH |
| 634–642 | Backward-sub loop `for (let k = n - 1; k >= 0; k--)` | spsolve.c:173–183 | `for (I = Size; I > 0; I--)` | DIFF |
| 635–642 | Back-sub body with row walk | spsolve.c:175–182 | Same logic, different indexing | MATCH |
| 650 | `for (let k = 0; k < n; k++) x[intToExtCol[k]] = b[k];` | spsolve.c:186–188 | `pExtOrder = &Matrix->IntToExtColMap[Size]; for (I = Size; I > 0; I--) Solution[*(pExtOrder--)] = Intermediate[I];` | DIFF |

---

## Function: `stampRHS()` (lines 391–393)

| digiTS line# | digiTS code | ngspice file:line# | ngspice code | classifier |
|---|---|---|---|---|
| 392 | `this._rhs[row] += value;` | niiter.c (NR circuit load phase) | `*Matrix_RHS_ptr += val` | MATCH |

---

## Function: `_applyDiagGmin()` (lines 2475–2484)

Maps ngspice `LoadGmin` (spsmp.c:422–440).

| digiTS line# | digiTS code | ngspice file:line# | ngspice code | classifier |
|---|---|---|---|---|
| 2476 | `if (gmin === 0) return;` | spsmp.c:432 | `if (Gmin != 0.0) {` | DIFF |
| 2477–2479 | Local var setup: `const n = this._n; const diag = this._diag; const elVal = this._elVal;` | spsmp.c:433 | `Diag = Matrix->Diag;` | DIFF |
| 2480–2483 | `for (let i = 0; i < n; i++) { const e = diag[i]; if (e >= 0) elVal[e] += gmin; }` | spsmp.c:434–437 | `for (I = Matrix->Size; I > 0; I--) { if ((diag = Diag[I]) != NULL) diag->Real += Gmin; }` | DIFF |

---

## Function: `getRhsSnapshot()` (lines 860–862)

| digiTS line# | digiTS code | ngspice file:line# | ngspice code | classifier |
|---|---|---|---|---|
| 861 | `return this._rhs.slice(0, this._n);` | NONE | N/A (test harness) | DIFF |

---

## Function: `enablePreSolveRhsCapture()` (lines 864–869)

| digiTS line# | digiTS code | ngspice file:line# | ngspice code | classifier |
|---|---|---|---|---|
| 865–868 | Flag and buffer setup | NONE | N/A (test harness) | DIFF |

---

## Function: `getPreSolveRhsSnapshot()` (lines 871–873)

| digiTS line# | digiTS code | ngspice file:line# | ngspice code | classifier |
|---|---|---|---|---|
| 872 | `return this._preSolveRhs ?? new Float64Array(0);` | NONE | N/A (test harness) | DIFF |

---

## Function: `enablePreFactorMatrixCapture()` (lines 875–878)

| digiTS line# | digiTS code | ngspice file:line# | ngspice code | classifier |
|---|---|---|---|---|
| 876–877 | Flag and buffer control | NONE | N/A (test harness) | DIFF |

---

## Function: `getPreFactorMatrixSnapshot()` (lines 885–887)

| digiTS line# | digiTS code | ngspice file:line# | ngspice code | classifier |
|---|---|---|---|---|
| 886 | `return this._preFactorMatrix ?? [];` | NONE | N/A (test harness) | DIFF |

---

## Function: `_takePreFactorSnapshotIfEnabled()` (lines 896–910)

| digiTS line# | digiTS code | ngspice file:line# | ngspice code | classifier |
|---|---|---|---|---|
| 897 | Guard check | NONE | N/A (test harness) | DIFF |
| 898–909 | CSC iteration and snapshot | NONE | N/A (test harness) | DIFF |

---

## Function: `getCSCNonZeros()` (lines 916–928)

| digiTS line# | digiTS code | ngspice file:line# | ngspice code | classifier |
|---|---|---|---|---|
| 917–928 | CSC column-major iteration | NONE | N/A (test harness) | DIFF |

---

## Property Accessors (lines 854–858)

| digiTS line# | digiTS code | ngspice file:line# | ngspice code | classifier |
|---|---|---|---|---|
| 854 | `get dimension()` | NONE | N/A (test harness) | DIFF |
| 855 | `get markowitzRow()` | NONE | N/A (test harness) | DIFF |
| 856 | `get markowitzCol()` | NONE | N/A (test harness) | DIFF |
| 857 | `get markowitzProd()` | NONE | N/A (test harness) | DIFF |
| 858 | `get singletons()` | NONE | N/A (test harness) | DIFF |

---

## Function: `setPivotTolerances()` (lines 687–690)

Maps ngspice pivot tolerance plumbing (spfactor.c:204–211).

| digiTS line# | digiTS code | ngspice file:line# | ngspice code | classifier |
|---|---|---|---|---|
| 688 | `if (relThreshold > 0 && relThreshold <= 1) this._relThreshold = relThreshold;` | spfactor.c:204–208 | `if (PivRel > 0 && PivRel <= 1) Matrix->RelThreshold = PivRel;` | MATCH |
| 689 | `if (absThreshold >= 0) this._absThreshold = absThreshold;` | spfactor.c:N/A | Default validation | MATCH |

---

## Function: `forceReorder()` (lines 696–698)

Maps ngspice NISHOULDREORDER (niiter.c:858, 861–880).

| digiTS line# | digiTS code | ngspice file:line# | ngspice code | classifier |
|---|---|---|---|---|
| 697 | `this._needsReorder = true;` | spfactor.c:225 | `ReorderingRequired = YES;` | MATCH |

---

## Function: `invalidateTopology()` (lines 664–672)

Maps ngspice `spStripMatrix` (sputils.c:1104–1145).

| digiTS line# | digiTS code | ngspice file:line# | ngspice code | classifier |
|---|---|---|---|---|
| 665 | `this._structureEmpty = true;` | sputils.c:1113 | `Matrix->NeedsOrdering = YES;` | MATCH |
| 668 | `this._factored = false;` | sputils.c:1128 | `Matrix->Factored = NO;` | MATCH |
| 669 | `this._didPreorder = false;` | sputils.c:implicit | Preorder reset | MATCH |
| 671 | `this._needsReorder = true;` | sputils.c:1112 | `Matrix->NeedsOrdering = YES;` | MATCH |

---

## Summary

**Core arithmetic (forward/backward substitution inner loops):** MATCH ngspice spsolve.c.

**Initialization/output permutation loops:** DIFF in direction/indexing, MATCH in semantic effect.

**Gmin stamping:** DIFF in loop direction, MATCH in effect (add Gmin to diagonals).

**Tolerances and reorder flags:** MATCH ngspice semantics.

**Test harness functions (capture/snapshot/accessors):** DIFF—no ngspice equivalent.
