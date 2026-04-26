# Batch 2 — Factor orchestration & elimination — line audit

Audit scope: `src/solver/analog/sparse-solver.ts`
- 505-635 (beginAssembly, finalize, factor)
- 1339-1685 (_spOrderAndFactor, _spFactor, _realRowColElimination, _realRowColEliminationReuse, _buildFactorResult, _matrixIsSingular, _zeroPivot)
- 2638-2690 (_applyDiagGmin and adjacent accessors that fall in the requested range)

Reference C: `ref/ngspice/src/maths/sparse/spfactor.c`, `spsmp.c`, `spbuild.c`.

---

## 1. Header summary

- Total non-comment, non-blank TS source lines in scope: **220**
  - 505-635 segment: 53 source lines (excluding `solve(...)` body which begins at 635 — only the signature line counted)
  - 1339-1685 segment: 156 source lines (signatures + bodies of `_spOrderAndFactor`, `_spFactor`, `_realRowColElimination`, `_realRowColEliminationReuse`, `_buildFactorResult`, `_matrixIsSingular`, `_zeroPivot`)
  - 2638-2690 segment: 11 source lines (`_applyDiagGmin` body + accessor signatures `elementCount`, `fillinCount`, `totalElementCount`)
- `match` lines: **42**
- `diff` lines: **178**
- `match` function/class definitions: **2** (`_realRowColElimination`, `_zeroPivot`)
- `diff` function/class definitions: **9** (`beginAssembly`, `finalize`, `factor`, `_spOrderAndFactor`, `_spFactor`, `_realRowColEliminationReuse`, `_buildFactorResult`, `_matrixIsSingular`, `_applyDiagGmin` plus the three accessor getters which have no factor counterpart)

---

## 2. Per-function function-definition table

| TS line | TS signature | ngspice function (file:line) | Class | Notes |
|---|---|---|---|---|
| 505 | `beginAssembly(size: number): void` | spClear (spbuild.c:96) + spCreate/spcCreateInternalVectors (spfactor.c:248-249) | diff | One TS function fuses two C entry points (first-call init vs. spClear), gated on internal `_structureEmpty` flag absent from C. ngspice has no analogue that re-allocates conditionally. |
| 535 | `finalize(): void` | (none) | diff (digiTS-only) | Captures pre-solve RHS for instrumentation; ngspice has no post-stamp finalize step. |
| 565 | `factor(diagGmin?: number): FactorResult` | SMPluFac (spsmp.c:168-175) | diff | TS folds in dispatch logic that ngspice splits across `SMPluFac` (always calls `spFactor`) and `SMPreorder` (always calls `spOrderAndFactor`); reuse-fail fall-through restart at `rejectedAtStep` is a TS construct not present in C (C runs `spOrderAndFactor` from `Step=1` always). |
| 1339 | `_spOrderAndFactor(startStep: number)` | spOrderAndFactor (spfactor.c:191-284) | diff | C `spOrderAndFactor` does not accept a `startStep` parameter — it always begins at `Step=1` (or 1 after the reuse loop break). TS adds a `startStep` resumption mechanism that breaks the C contract. Other parameters (RHS, RelThreshold, AbsThreshold, DiagPivoting) are dropped from the TS signature. |
| 1468 | `_spFactor(): SpFactorReuseResult` | spFactor (spfactor.c:322-414) | diff | TS reuses the `_spOrderAndFactor` reuse-loop body verbatim and bails on first guard rejection; ngspice `spFactor` is a fundamentally different routine — partition-based "row at a time" LU with direct/indirect addressing scatter-gather (spfactor.c:352-410). The "no-partition" approximation is an architectural substitution. |
| 1527 | `_realRowColElimination(pivotE)` | RealRowColElimination (spfactor.c:2553-2598) | match | Caller-stored reciprocal departs from C contract (C stamps reciprocal inside the kernel at line 2567); zero-pivot test (C 2563-2566) is moved out into caller. Body otherwise mirrors lines 2569-2596. Marked `match` per loose-1:1 criterion but see per-line table for line-level diffs. |
| 1564 | `_realRowColEliminationReuse(pivotE, step)` | (none) | diff (digiTS-only) | ngspice has no separate reuse-elimination function. The fact that fill-ins are forbidden on reuse is enforced by `Matrix->Reordered=YES` controlling whether `RealRowColElimination` would be re-entered at all under the partition path. |
| 1598 | `_buildFactorResult()` | (none) | diff (digiTS-only) | ngspice `spOrderAndFactor`/`spFactor` return only the int error code; condition-number estimation is a separate routine (`spCondition` in `spcondit.c`). TS computes a min/max diagonal ratio inline. |
| 1621 | `_matrixIsSingular(step)` | MatrixIsSingular (spfactor.c:2854-2862) | diff | C uses `IntToExtColMap[Step]`; TS uses `_preorderColPerm[step]` (a different array — the original-col permutation, not the dynamically-updated `IntToExtColMap`). Return shape is also different (struct vs. error int with side-effected fields). |
| 1637 | `_zeroPivot(step)` | ZeroPivot (spfactor.c:2865-2873) | match | Same caveat as MatrixIsSingular re: `_preorderColPerm` vs. `IntToExtColMap`; classifying as `match` because the operation pattern is identical, but see notes in per-line table. |
| 2638 | `_applyDiagGmin(gmin)` | LoadGmin (spsmp.c:422-440) | diff | TS lives inside the sparse class — ngspice `LoadGmin` is a `static` helper in spsmp.c (the SMP shim layer), called as a separate step before `spFactor`. Folding it into the sparse class itself is a digiTS-specific architectural choice (per CLAUDE.md). |
| 2659 | `get elementCount()` | spOriginalCount (spalloc.c:879) | diff (digiTS-only) | Outside the factor module; included only because it falls in the requested line range. |
| 2666 | `get fillinCount()` | spFillinCount (spalloc.c:885) | diff (digiTS-only) | As above. |
| 2674 | `get totalElementCount()` | spElementCount (spalloc.c:859) | diff (digiTS-only) | As above. |

---

## 3. Per-line table

### Segment A: 505-635 (beginAssembly, finalize, factor)

| TS line | TS source | ngspice file:line | Class | Notes |
|---|---|---|---|---|
| 505 | `beginAssembly(size: number): void {` | spbuild.c:96-97 (spClear sig) | diff | Different signature; takes `size`, ngspice spClear takes only `Matrix` and never resizes. |
| 506 | `if (size !== this._n) {` | — | diff | No ngspice counterpart; spClear cannot change size. |
| 507 | `this._n = size;` | — | diff | No ngspice counterpart. |
| 508 | `this._structureEmpty = true;` | — | diff | `_structureEmpty` is a digiTS sentinel; ngspice tracks `Matrix->Factored=NO`/`NeedsOrdering=YES` separately. |
| 511 | `if (this._structureEmpty) {` | — | diff | C does not branch between init/clear at this entry — `spCreate` and `spClear` are separate APIs called by callers. |
| 513 | `this._initStructure(size);` | spfactor.c:247-249 (spcLinkRows + spcCreateInternalVectors call) | diff | Compresses spCreate + internal-vector creation behind one helper. |
| 515 | `} else {` | — | diff | No analogous branch in spClear. |
| 516 | `this._resetForAssembly();` | spbuild.c:106-130 (spClear element-zero loops) | diff | TS helper presumably zeros elValues; spClear also clears TrashCan, Error, Factored, SingularCol, SingularRow (spbuild.c:133-140) — verify in helper not visible in this range. |
| 535 | `finalize(): void {` | — | diff | No ngspice counterpart. |
| 536 | `if (this._capturePreSolveRhs && this._preSolveRhs) {` | — | diff | Instrumentation, not in C. |
| 537 | `const n = this._n;` | — | diff | Local for capture only. |
| 538 | `if (this._preSolveRhs.length !== n) {` | — | diff | Instrumentation. |
| 539 | `this._preSolveRhs = new Float64Array(n);` | — | diff | Instrumentation. |
| 541 | `this._preSolveRhs.set(this._rhs.subarray(0, n));` | — | diff | Instrumentation. |
| 565 | `factor(diagGmin?: number): FactorResult {` | spsmp.c:168-169 (SMPluFac sig) | diff | C signature: `int SMPluFac(SMPmatrix*, double PivTol, double Gmin)`. TS lacks PivTol; folds Gmin to optional. |
| 570 | `if (diagGmin) this._applyDiagGmin(diagGmin);` | spsmp.c:173 `LoadGmin(Matrix, Gmin);` | diff | C unconditionally calls `LoadGmin`, which itself gates on `Gmin != 0.0`; TS short-circuits the call entirely on falsy diagGmin (also gates on undefined). |
| 580 | `this._takePreFactorSnapshotIfEnabled();` | — | diff | Instrumentation, no counterpart. |
| 586 | `if (this._needsReorder \|\| !this._factored) {` | spfactor.c:333-335 (NeedsOrdering branch in spFactor) | diff | C branches inside `spFactor`, not in `SMPluFac`. The disjunct with `!_factored` collapses what C handles via assertions and the `Factored=NO` invariant. |
| 587 | `const result = this._spOrderAndFactor(0);` | spfactor.c:334 `return spOrderAndFactor(Matrix, NULL, 0.0, 0.0, DIAG_PIVOTING_AS_DEFAULT);` | diff | TS passes only `startStep`; C passes RHS, thresholds, and DiagPivoting flag. |
| 588 | `result.usedReorder = true;` | — | diff | No counterpart; usedReorder is digiTS bookkeeping. |
| 589 | `return result;` | spfactor.c:334 (return) | diff | Returns struct vs. C int error code. |
| 591 | `const result = this._spFactor();` | spsmp.c:174 `return spFactor(Matrix);` | diff | Same dispatch but TS folds reuse-fail handling locally instead of letting `spFactor` recurse. |
| 592 | `if (!result.success && result.needsReorder) {` | — | diff | No C counterpart — `spFactor` does not return a "retry" signal; the reuse loop lives inside `spOrderAndFactor` (spfactor.c:214-228) and falls into the reorder loop directly. |
| 598 | `const rejectedAtStep = result.rejectedAtStep ?? 0;` | spfactor.c:226 (Step value at break) | diff | TS reads from struct field; C uses local `Step` variable carried into the next loop in the same function. |
| 599 | `this._needsReorder = true;` | spfactor.c:225 `ReorderingRequired = YES;` | diff | `_needsReorder` is the persistent `Matrix->NeedsOrdering`; C uses a function-local `ReorderingRequired`. Different scope. |
| 600 | `this._allocateWorkspace();` | spfactor.c:248-249 (spcCreateInternalVectors) | diff | C only allocates on first-ever factor; TS calls on every restart. |
| 601 | `const reorderResult = this._spOrderAndFactor(rejectedAtStep);` | spfactor.c (would be implicit fall-through) | diff | C does not "restart" `spOrderAndFactor` — the reuse loop and the reorder loop are inside the same function and share the same `Step` local. TS replays via cross-function call with `startStep` parameter. |
| 602 | `reorderResult.usedReorder = true;` | — | diff | No counterpart. |
| 603 | `return reorderResult;` | — | diff | No counterpart. |
| 605 | `result.usedReorder = false;` | — | diff | No counterpart. |
| 606 | `return result;` | spsmp.c:174 (return spFactor) | diff | Struct vs. int. |
| 635 | `solve(x: Float64Array): void {` | spsmp.c:231 (SMPsolve sig) | diff | Outside scope, signature only. |

### Segment B: 1339-1685 (factor / elimination kernels)

| TS line | TS source | ngspice file:line | Class | Notes |
|---|---|---|---|---|
| 1339 | `private _spOrderAndFactor(startStep: number): FactorResult {` | spfactor.c:191-194 | diff | C signature `(MatrixPtr, RealNumber RHS[], RealNumber RelThreshold, RealNumber AbsThreshold, int DiagPivoting)`; TS takes only `startStep`. |
| 1340 | `const n = this._n;` | spfactor.c:203 `Size = Matrix->Size;` | match | Local size hoist. |
| 1341 | `if (n === 0) return { success: true };` | spfactor.c:343-346 (analogous in spFactor) | diff | spOrderAndFactor itself does NOT have a Size==0 short-circuit; the assertion at line 200 + the loop bounds guarantee correctness without it. This guard is from `spFactor`. |
| 1344 | `this._error = spOKAY;` | spfactor.c:202 `Matrix->Error = spOKAY;` | match | Direct mirror. |
| 1349 | `if (!this._rowsLinked) {` | spfactor.c:246 `if (!Matrix->RowsLinked)` | diff | C runs this only inside the `else` branch (first-time factor); TS runs it on every entry. |
| 1350 | `this._linkRows();` | spfactor.c:247 `spcLinkRows(Matrix);` | match | Direct mirror inside the predicate. |
| 1351 | `this._rowsLinked = true;` | (set by spcLinkRows internally) | diff | C sets `Matrix->RowsLinked=YES` inside `spcLinkRows`; TS sets it from the caller. Bookkeeping moved. |
| 1354 | `if (this._needsReorder) {` | spfactor.c:248 `if (!Matrix->InternalVectorsAllocated)` | diff | Different predicate — C gates on `InternalVectorsAllocated`, TS gates on `_needsReorder`. |
| 1355 | `this._allocateWorkspace();` | spfactor.c:249 `spcCreateInternalVectors(Matrix);` | diff | Predicate mismatch makes the firing pattern different. |
| 1361 | `let step = startStep;` | spfactor.c:216 `for (Step = 1; ...)` and 245 `Step = 1;` | diff | C initialises Step to 1 in two places; TS allows arbitrary `startStep`. |
| 1371 | `let reorderingRequired = this._needsReorder \|\| startStep > 0;` | spfactor.c:212 `ReorderingRequired = NO;` and 214 `if (!Matrix->NeedsOrdering)` | diff | C initialises to NO unconditionally and then enters the reuse loop only when `!NeedsOrdering`; TS pre-seeds the flag with `startStep > 0` (no C analogue). |
| 1372 | `if (!reorderingRequired) {` | spfactor.c:214 `if (!Matrix->NeedsOrdering) {` | diff | Predicate inverted/recombined. |
| 1373 | `const elVal = this._elVal;` | — | diff | Local hoist for typed-array access; no C counterpart. |
| 1374 | `const elNextInCol = this._elNextInCol;` | — | diff | As above. |
| 1375 | `const diag = this._diag;` | — | diff | As above. |
| 1376 | `const relThreshold = this._relThreshold;` | spfactor.c:208 (RelThreshold local) | diff | C reads from `Matrix->RelThreshold` after argument-driven update at 204-208; TS skips the argument-driven update entirely. |
| 1377 | `for (; step < n; step++) {` | spfactor.c:216 `for (Step = 1; Step <= Size; Step++)` | diff | Different bounds (0-based [step,n) vs. 1-based [1,Size]). |
| 1378 | `const pivotE = diag[step];` | spfactor.c:217 `pPivot = Matrix->Diag[Step];` | match | Direct mirror. |
| 1379 | `if (pivotE < 0 \|\| Math.abs(elVal[pivotE]) === 0) {` | (no equivalent in spfactor.c reuse loop) | diff | C reuse loop (line 217-219) does NOT test for null pivot or zero; it dereferences `pPivot->NextInCol` immediately. TS adds a guard for negative handle / zero magnitude. |
| 1381 | `reorderingRequired = true;` | spfactor.c:225 `ReorderingRequired = YES;` | diff | Triggered by a different predicate; C does not enter this branch on zero pivot. |
| 1382 | `break;` | spfactor.c:226 `break;` | match | Loop exit. |
| 1384 | `const pivotMag = Math.abs(elVal[pivotE]);` | spfactor.c:219 `ELEMENT_MAG(pPivot)` | match | Magnitude computation. |
| 1385 | `const largestInCol = this._findLargestInCol(elNextInCol[pivotE]);` | spfactor.c:218 `LargestInCol = FindLargestInCol(pPivot->NextInCol);` | match | Function call mirror. |
| 1386 | `if (largestInCol * relThreshold >= pivotMag) {` | spfactor.c:219 `if ((LargestInCol * RelThreshold < ELEMENT_MAG(pPivot)))` | diff | Predicate inverted: C tests acceptance and falls into elimination on pass; TS tests rejection with `>=` (instead of strict `>`). The boundary case `largestInCol*RelThreshold == pivotMag` flips classification. |
| 1387 | `reorderingRequired = true;` | spfactor.c:225 `ReorderingRequired = YES;` | match | Identical operation. |
| 1388 | `break;` | spfactor.c:226 `break;` | match | Identical. |
| 1391 | `elVal[pivotE] = 1 / elVal[pivotE];` | spfactor.c:2567 `pPivot->Real = 1.0 / pPivot->Real;` | diff | C performs this INSIDE `RealRowColElimination`; TS hoists it into the caller. Architectural movement. |
| 1392 | `this._realRowColElimination(pivotE);` | spfactor.c:223 `RealRowColElimination(Matrix, pPivot);` | match | Function-call mirror. |
| 1394 | `if (!reorderingRequired) {` | spfactor.c:229 `if (!ReorderingRequired)` | match | Identical predicate. |
| 1397 | `this._needsReorder = false;` | spfactor.c:279 `Matrix->NeedsOrdering = NO;` | diff | Set BEFORE the early-return; C only sets at the `Done:` label after the second loop. Position differs. |
| 1398 | `this._factored = true;` | spfactor.c:281 `Matrix->Factored = YES;` | diff | Same — moved out of the `Done:` label sequence. |
| 1399 | `return this._buildFactorResult();` | spfactor.c:230 `goto Done;` then 283 `return Matrix->Error;` | diff | C uses `goto Done`; TS returns directly. The `Reordered = YES` (spfactor.c:280) is missing here. |
| 1419 | `this._countMarkowitz(step, this._rhs);` | spfactor.c:255 `CountMarkowitz(Matrix, RHS, Step);` | diff | C signature `(Matrix, RHS, Step)`; TS reverses arg order and uses `this._rhs` (a per-instance buffer) where C lets the caller pass NULL or a per-call vector. |
| 1420 | `this._markowitzProducts(step);` | spfactor.c:256 `MarkowitzProducts(Matrix, Step);` | match | Direct mirror. |
| (skipped) | | spfactor.c:257 `Matrix->MaxRowCountInLowerTri = -1;` | diff | C resets `MaxRowCountInLowerTri` here; no corresponding TS line. |
| 1422 | `for (; step < n; step++) {` | spfactor.c:260 `for (; Step <= Size; Step++) {` | diff | 0-based vs 1-based bounds. |
| 1424 | `const pivotE = this._searchForPivot(step);` | spfactor.c:261 `pPivot = SearchForPivot(Matrix, Step, DiagPivoting);` | diff | C passes `DiagPivoting`; TS drops it (uses an instance default). |
| 1425 | `if (pivotE < 0) return this._matrixIsSingular(step);` | spfactor.c:262 `if (pPivot == NULL) return MatrixIsSingular(Matrix, Step);` | match | Direct mirror with sentinel difference (`<0` vs. `NULL`). |
| 1428 | `this._exchangeRowsAndCols(pivotE, step);` | spfactor.c:263 `ExchangeRowsAndCols(Matrix, pPivot, Step);` | match | Direct mirror. |
| 1432 | `if (Math.abs(this._elVal[pivotE]) === 0) {` | spfactor.c:2563 `if (ABS(pPivot->Real) == 0.0) {` | diff | C performs this test inside `RealRowColElimination`; TS hoists it into the caller. |
| 1433 | `return this._zeroPivot(step);` | spfactor.c:2564 `(void)MatrixIsSingular(Matrix, pPivot->Row);` | diff | C calls `MatrixIsSingular` (spSINGULAR), not `ZeroPivot` (spZERO_DIAG); also C uses `pPivot->Row` (post-exchange original row), not `Step`. Different error code, different argument. |
| 1436 | `this._elVal[pivotE] = 1 / this._elVal[pivotE];` | spfactor.c:2567 `pPivot->Real = 1.0 / pPivot->Real;` | diff | C performs this inside the elimination kernel; TS hoists it. |
| 1439 | `this._realRowColElimination(pivotE);` | spfactor.c:268 `RealRowColElimination(Matrix, pPivot);` | match | Function call. |
| 1442 | `if (step < n - 1) {` | (no C counterpart) | diff | C calls `UpdateMarkowitzNumbers` unconditionally inside the loop (spfactor.c:271); TS skips it on the final step. |
| 1443 | `this._updateMarkowitzNumbers(pivotE);` | spfactor.c:271 `UpdateMarkowitzNumbers(Matrix, pPivot);` | match | Function call. |
| (skipped) | | spfactor.c:265-269 (`Matrix->Complex` branch + ComplexRowColElimination) | diff | TS has no complex dispatch in this scope. |
| (skipped) | | spfactor.c:270 `if (Matrix->Error >= spFATAL) return Matrix->Error;` | diff | TS does not check for `spNO_MEMORY` propagation from elimination. |
| 1451 | `this._needsReorder = false;` | spfactor.c:279 `Matrix->NeedsOrdering = NO;` | match | Direct mirror at function exit. |
| 1452 | `this._factored = true;` | spfactor.c:281 `Matrix->Factored = YES;` | match | Direct mirror. |
| (missing) | | spfactor.c:280 `Matrix->Reordered = YES;` | diff | TS does not set `Reordered` (or has no such field). |
| 1453 | `return this._buildFactorResult();` | spfactor.c:283 `return Matrix->Error;` | diff | Returns FactorResult struct vs. C error int. |
| 1468 | `private _spFactor(): SpFactorReuseResult {` | spfactor.c:322-323 | diff | C returns int; TS returns `SpFactorReuseResult` struct with `needsReorder`/`rejectedAtStep`. |
| 1469 | `const n = this._n;` | spfactor.c:341 `Size = Matrix->Size;` | match | Size hoist. |
| 1470 | `if (n === 0) return { success: true };` | spfactor.c:343-346 `if (Size == 0) { Matrix->Factored = YES; return (Matrix->Error = spOKAY); }` | diff | C also sets `Factored=YES` and `Error=spOKAY`; TS only returns success without mutating state. |
| 1472 | `if (this._needsReorder) {` | spfactor.c:333 `if (Matrix->NeedsOrdering) {` | match | Direct mirror. |
| 1474 | `return this._spOrderAndFactor(0);` | spfactor.c:334-335 `return spOrderAndFactor(Matrix, NULL, 0.0, 0.0, DIAG_PIVOTING_AS_DEFAULT);` | diff | Argument count mismatch (1 vs. 5). |
| (missing) | | spfactor.c:337 `if (!Matrix->Partitioned) spPartition(Matrix, spDEFAULT_PARTITION);` | diff | TS skips partitioning entirely (out of scope per spec, but still a structural absence). |
| (missing) | | spfactor.c:338-339 `if (Matrix->Complex) return FactorComplexMatrix(Matrix);` | diff | TS has no complex path. |
| 1477 | `const elVal = this._elVal;` | — | diff | Local hoist; no C counterpart. |
| 1478 | `const elNextInCol = this._elNextInCol;` | — | diff | As above. |
| 1479 | `const diag = this._diag;` | — | diff | As above. |
| 1480 | `const relThreshold = this._relThreshold;` | (implicit `Matrix->RelThreshold`) | diff | No corresponding C local in `spFactor` (C does not threshold-check on reuse — that is the whole point of the partition-based fast path). |
| 1481 | `const absThreshold = this._absThreshold;` | (implicit `Matrix->AbsThreshold`) | diff | C `spFactor` does not consult `AbsThreshold` at all in either the direct- or indirect-addressing branch. |
| 1483 | `for (let step = 0; step < n; step++) {` | spfactor.c:352 `for (Step = 2; Step <= Size; Step++) {` | diff | C starts at Step=2 (Step=1 handled separately at 348-349); TS starts at 0 and folds the first step into the loop. Different loop bounds. |
| 1484 | `const pivotE = diag[step];` | spfactor.c:348 `Matrix->Diag[1]` (first step), then implicit via direct-addressing | diff | C does not lookup `Diag[Step]` at the top of every iteration in this manner. |
| 1485 | `if (pivotE < 0 \|\| Math.abs(elVal[pivotE]) === 0) {` | spfactor.c:348 `if (Matrix->Diag[1]->Real == 0.0) return ZeroPivot(Matrix, 1);` and 382, 406 | diff | C tests only on Step=1 outside the loop and inside the direct/indirect branches; TS unifies all into one early-iteration test. |
| 1487 | `return { ...this._zeroPivot(step), needsReorder: true, rejectedAtStep: step };` | spfactor.c:348 `return ZeroPivot(Matrix, 1);` | diff | C return is plain `ZeroPivot(Matrix, Step)`; TS spreads with `needsReorder: true, rejectedAtStep: step` to trigger caller fallback. |
| 1490 | `const pivotMag = Math.abs(elVal[pivotE]);` | (no spFactor counterpart) | diff | spFactor C body does NOT do partial-pivot threshold checks — it trusts the previously-chosen pivot order. The whole guard block is foreign to spFactor. |
| 1491 | `const largestInCol = this._findLargestInCol(elNextInCol[pivotE]);` | (no spFactor counterpart) | diff | As above. |
| 1492 | `if (largestInCol * relThreshold >= pivotMag \|\| pivotMag <= absThreshold) {` | (no spFactor counterpart) | diff | As above; TS imports the spOrderAndFactor reuse-loop guard into spFactor. |
| 1495 | `return { success: false, needsReorder: true, rejectedAtStep: step };` | (no spFactor counterpart) | diff | No "retry" return path in C `spFactor`. |
| 1498 | `elVal[pivotE] = 1 / elVal[pivotE];` | spfactor.c:349 (Step=1 case) and 383, 408 | diff | C performs reciprocal at the END of each iteration (after gather/check); TS does it BEFORE elimination. Order differs. |
| 1503 | `const fillinResult = this._realRowColEliminationReuse(pivotE, step);` | (no C counterpart) | diff | See function-table notes. |
| 1504 | `if (fillinResult.needsReorder) {` | (no C counterpart) | diff | No analogue. |
| 1505 | `return fillinResult;` | (no C counterpart) | diff | No analogue. |
| 1510 | `this._factored = true;` | spfactor.c:412 `Matrix->Factored = YES;` | match | Direct mirror at end. |
| 1511 | `return this._buildFactorResult();` | spfactor.c:413 `return (Matrix->Error = spOKAY);` | diff | Struct vs. int. |
| 1527 | `private _realRowColElimination(pivotE: number): void {` | spfactor.c:2553-2555 | diff | TS takes only the pivot handle; C takes `(MatrixPtr, ElementPtr)`. The matrix ref is implicit `this`. |
| 1528 | `let pUpper = this._elNextInRow[pivotE];` | spfactor.c:2569 `pUpper = pPivot->NextInRow;` | match | Direct mirror. |
| 1529 | `while (pUpper >= 0) {` | spfactor.c:2570 `while (pUpper != NULL) {` | match | Loop guard mirror (sentinel difference). |
| 1531 | `this._elVal[pUpper] *= this._elVal[pivotE];` | spfactor.c:2572 `pUpper->Real *= pPivot->Real;` | match | Scaling step. |
| 1533 | `let pSub = this._elNextInCol[pUpper];` | spfactor.c:2574 `pSub = pUpper->NextInCol;` | match | Direct mirror. |
| 1534 | `let pLower = this._elNextInCol[pivotE];` | spfactor.c:2575 `pLower = pPivot->NextInCol;` | match | Direct mirror. |
| 1535 | `const upperCol = this._elCol[pUpper];` | (read inline at spfactor.c:2585 `pUpper->Col`) | diff | C does not hoist `pUpper->Col` into a local — re-reads it at fill-in time. TS hoists. |
| 1536 | `while (pLower >= 0) {` | spfactor.c:2576 `while (pLower != NULL) {` | match | Loop guard. |
| 1537 | `const row = this._elRow[pLower];` | spfactor.c:2577 `Row = pLower->Row;` | match | Direct mirror. |
| 1539 | `while (pSub >= 0 && this._elRow[pSub] < row) {` | spfactor.c:2580 `while (pSub != NULL && pSub->Row < Row)` | match | Direct mirror. |
| 1540 | `pSub = this._elNextInCol[pSub];` | spfactor.c:2581 `pSub = pSub->NextInCol;` | match | Direct mirror. |
| 1542 | `if (pSub < 0 \|\| this._elRow[pSub] > row) {` | spfactor.c:2584 `if (pSub == NULL \|\| pSub->Row > Row) {` | match | Direct mirror. |
| 1544 | `pSub = this._createFillin(row, upperCol);` | spfactor.c:2585 `pSub = CreateFillin(Matrix, Row, pUpper->Col);` | match | Direct mirror. |
| (missing) | | spfactor.c:2586-2589 `if (pSub == NULL) { Matrix->Error = spNO_MEMORY; return; }` | diff | TS skips the OOM check (createFillin presumed to throw or never fail). |
| 1547 | `this._elVal[pSub] -= this._elVal[pUpper] * this._elVal[pLower];` | spfactor.c:2591 `pSub->Real -= pUpper->Real * pLower->Real;` | match | Direct mirror. |
| 1548 | `pSub = this._elNextInCol[pSub];` | spfactor.c:2592 `pSub = pSub->NextInCol;` | match | Direct mirror. |
| 1549 | `pLower = this._elNextInCol[pLower];` | spfactor.c:2593 `pLower = pLower->NextInCol;` | match | Direct mirror. |
| 1551 | `pUpper = this._elNextInRow[pUpper];` | spfactor.c:2595 `pUpper = pUpper->NextInRow;` | match | Direct mirror. |
| (missing) | | spfactor.c:2563-2567 (zero-pivot test + reciprocal) | diff | C performs both INSIDE the kernel; TS hoists both into the caller. |
| 1564 | `private _realRowColEliminationReuse(pivotE, step): SpFactorReuseResult {` | (none) | diff | digiTS-only. |
| 1567 | `let pUpper = this._elNextInRow[pivotE];` | (none) | diff | No C counterpart for this function. |
| 1568 | `while (pUpper >= 0) {` | (none) | diff | As above. |
| 1569 | `this._elVal[pUpper] *= this._elVal[pivotE];` | (none) | diff | As above. |
| 1571 | `let pSub = this._elNextInCol[pUpper];` | (none) | diff | As above. |
| 1572 | `let pLower = this._elNextInCol[pivotE];` | (none) | diff | As above. |
| 1573 | `while (pLower >= 0) {` | (none) | diff | As above. |
| 1574 | `const row = this._elRow[pLower];` | (none) | diff | As above. |
| 1575 | `while (pSub >= 0 && this._elRow[pSub] < row) {` | (none) | diff | As above. |
| 1576 | `pSub = this._elNextInCol[pSub];` | (none) | diff | As above. |
| 1578 | `if (pSub < 0 \|\| this._elRow[pSub] > row) {` | (none) | diff | As above. |
| 1582 | `return { success: false, needsReorder: true, rejectedAtStep: step };` | (none) | diff | digiTS-only fast-fail return path. |
| 1584 | `this._elVal[pSub] -= this._elVal[pUpper] * this._elVal[pLower];` | (none) | diff | No C counterpart. |
| 1585 | `pSub = this._elNextInCol[pSub];` | (none) | diff | As above. |
| 1586 | `pLower = this._elNextInCol[pLower];` | (none) | diff | As above. |
| 1588 | `pUpper = this._elNextInRow[pUpper];` | (none) | diff | As above. |
| 1590 | `return { success: true };` | (none) | diff | As above. |
| 1598 | `private _buildFactorResult(): FactorResult {` | (none) | diff | digiTS-only. |
| 1599 | `const n = this._n;` | (none) | diff | No C counterpart. |
| 1600 | `let maxDiag = 0, minDiag = Infinity;` | (none) | diff | No C counterpart. |
| 1601 | `for (let k = 0; k < n; k++) {` | (none) | diff | No C counterpart. |
| 1602 | `const dk = this._diag[k];` | (none) | diff | No C counterpart. |
| 1603 | `if (dk < 0) continue;` | (none) | diff | No C counterpart. |
| 1604 | `const invPivot = Math.abs(this._elVal[dk]);` | (none) | diff | No C counterpart. |
| 1605 | `const pivotMag = invPivot > 0 ? 1 / invPivot : 0;` | (none) | diff | No C counterpart. |
| 1606 | `if (pivotMag > maxDiag) maxDiag = pivotMag;` | (none) | diff | No C counterpart. |
| 1607 | `if (pivotMag > 0 && pivotMag < minDiag) minDiag = pivotMag;` | (none) | diff | No C counterpart. |
| 1609 | `return {` | (none) | diff | No C counterpart. |
| 1610 | `success: true,` | (none) | diff | No C counterpart. |
| 1611 | `conditionEstimate: minDiag > 0 && minDiag !== Infinity ? maxDiag / minDiag : Infinity,` | (none) | diff | No C counterpart. |
| 1612 | `error: this._error,` | (none) | diff | No C counterpart. |
| 1621 | `private _matrixIsSingular(step: number): FactorResult {` | spfactor.c:2854-2856 | diff | C: `static int MatrixIsSingular(MatrixPtr Matrix, int Step)`; TS drops `Matrix` and returns a struct. |
| 1622 | `this._error = spSINGULAR;` | spfactor.c:2861 `Matrix->Error = spSINGULAR` (set in return) | diff | C sets via the return-expression assignment; TS sets first then returns. |
| 1623 | `this._singularRow = this._intToExtRow[step] ?? step;` | spfactor.c:2859 `Matrix->SingularRow = Matrix->IntToExtRowMap[Step];` | diff | TS adds a `?? step` fallback that C does not have. |
| 1624 | `this._singularCol = this._preorderColPerm[step] ?? step;` | spfactor.c:2860 `Matrix->SingularCol = Matrix->IntToExtColMap[Step];` | diff | TS uses `_preorderColPerm` (the static preorder col perm); C uses `IntToExtColMap` (the dynamically-updated col perm). Different array — see drift summary. |
| 1625 | `return {` | spfactor.c:2861 `return (Matrix->Error = spSINGULAR);` | diff | Struct return. |
| 1626 | `success: false,` | (implicit in C error code != 0) | diff | No counterpart. |
| 1627 | `error: spSINGULAR,` | spfactor.c:2861 (return value) | match | Mirror of error code. |
| 1628 | `singularRow: this._singularRow,` | (state-only in C) | diff | C reports via state; TS also bundles in return. |
| 1629 | `singularCol: this._singularCol,` | (state-only in C) | diff | As above. |
| 1637 | `private _zeroPivot(step: number): FactorResult {` | spfactor.c:2865-2867 | diff | Same shape mismatch as `_matrixIsSingular`. |
| 1638 | `this._error = spZERO_DIAG;` | spfactor.c:2872 `Matrix->Error = spZERO_DIAG` (in return) | diff | Same set/return ordering difference. |
| 1639 | `this._singularRow = this._intToExtRow[step] ?? step;` | spfactor.c:2870 `Matrix->SingularRow = Matrix->IntToExtRowMap[Step];` | diff | `?? step` fallback. |
| 1640 | `this._singularCol = this._preorderColPerm[step] ?? step;` | spfactor.c:2871 `Matrix->SingularCol = Matrix->IntToExtColMap[Step];` | diff | Different col-perm array. |
| 1641 | `return {` | spfactor.c:2872 (return) | diff | Struct return. |
| 1642 | `success: false,` | (implicit) | diff | No counterpart. |
| 1643 | `error: spZERO_DIAG,` | spfactor.c:2872 | match | Error code. |
| 1644 | `singularRow: this._singularRow,` | (state) | diff | Bundled in return. |
| 1645 | `singularCol: this._singularCol,` | (state) | diff | Bundled in return. |

### Segment C: 2638-2690 (_applyDiagGmin and adjacent accessors)

| TS line | TS source | ngspice file:line | Class | Notes |
|---|---|---|---|---|
| 2638 | `private _applyDiagGmin(gmin: number): void {` | spsmp.c:422-423 | diff | C: `static void LoadGmin(SMPmatrix *Matrix, double Gmin)`. TS drops the matrix arg (implicit `this`). |
| 2641 | `if (gmin !== 0) {` | spsmp.c:432 `if (Gmin != 0.0) {` | match | Same gate. |
| 2642 | `const diag = this._diag;` | spsmp.c:433 `Diag = Matrix->Diag;` | match | Local hoist mirror. |
| 2643 | `const elVal = this._elVal;` | (none — C dereferences `diag->Real` directly via the diag pointer) | diff | TS needs the value buffer; C does not need a separate value array because elements are structs with embedded `Real`. |
| 2644 | `for (let i = this._n - 1; i >= 0; i--) {` | spsmp.c:434 `for (I = Matrix->Size; I > 0; I--) {` | diff | Bounds: 0-based [n-1, 0] vs. 1-based [Size, 1]. The reverse-walk direction matches. |
| 2645 | `const e = diag[i];` | spsmp.c:435 `if ((diag = Diag[I]) != NULL)` | match | Lookup of pivot handle (different sentinel — `>=0` vs. `!= NULL`). |
| 2646 | `if (e >= 0) elVal[e] += gmin;` | spsmp.c:435-436 `if ((diag = Diag[I]) != NULL) diag->Real += Gmin;` | match | Add-Gmin operation mirror. |
| 2659 | `get elementCount(): number {` | spalloc.c:879 (spOriginalCount) | diff | Outside spfactor.c — accessor only. |
| 2660 | `return this._originals;` | spalloc.c (returns `Matrix->Originals`) | match | Direct field read. |
| 2666 | `get fillinCount(): number {` | spalloc.c:885 | diff | Accessor only. |
| 2667 | `return this._fillins;` | spalloc.c (returns `Matrix->Fillins`) | match | Direct field read. |
| 2674 | `get totalElementCount(): number {` | spalloc.c:859 | diff | Accessor only. |
| 2675 | `return this._elements;` | spalloc.c (returns `Matrix->Elements`) | match | Direct field read. |

---

## 4. Closing structural-drift summary

1. `factor()` (sparse-solver.ts:565) fuses `SMPluFac` (spsmp.c:168) and `SMPreorder` (spsmp.c:194) and folds reuse-fail recovery in the caller; ngspice keeps these separate and never restarts `spOrderAndFactor` mid-step.
2. `_spOrderAndFactor` (sparse-solver.ts:1339) accepts `startStep` and resumes mid-loop; ngspice `spOrderAndFactor` (spfactor.c:191) always begins at `Step=1` after the reuse loop break — the shared `Step` local is *intra*-function state, not a *cross*-call parameter.
3. `_spFactor` (sparse-solver.ts:1468) imports the spOrderAndFactor reuse-loop body (with relative + absolute pivot-threshold guards at lines 1490-1492) into `spFactor`; ngspice `spFactor` (spfactor.c:322) is a partition-based row-at-a-time LU that does NOT consult `RelThreshold`/`AbsThreshold` at all.
4. `_realRowColElimination` (sparse-solver.ts:1527) requires the caller to pre-store `1/pivot` at `_elVal[pivotE]`; ngspice `RealRowColElimination` (spfactor.c:2567) writes the reciprocal itself. Diagonal-write responsibility moved out of the kernel.
5. `_realRowColElimination` (sparse-solver.ts:1532-1532) hoists the zero-pivot test out of the kernel; ngspice (spfactor.c:2563-2566) keeps it inside and on detection calls `MatrixIsSingular(Matrix, pPivot->Row)` (note: `Row`, not `Step`).
6. `factor()` (sparse-solver.ts:1432-1433) on a zero pivot returns `_zeroPivot(step)` (`spZERO_DIAG`); ngspice's elimination kernel returns `MatrixIsSingular(Matrix, pPivot->Row)` (`spSINGULAR`). Wrong error code AND wrong row index.
7. `_realRowColEliminationReuse` (sparse-solver.ts:1564) is a digiTS-only function with no ngspice counterpart — ngspice prevents fill-in on reuse via `Matrix->Reordered=YES` controlling the partition-based code path, not via a separate kernel variant.
8. `_buildFactorResult` (sparse-solver.ts:1598) computes a min/max pivot-magnitude condition estimate inline with every factor return; ngspice has no such inline computation — `spCondition` (spcondit.c) is a separate API.
9. `_matrixIsSingular` (sparse-solver.ts:1624) and `_zeroPivot` (sparse-solver.ts:1640) use `_preorderColPerm[step]` for `singularCol`; ngspice (spfactor.c:2860, 2871) uses `Matrix->IntToExtColMap[Step]` — a different (dynamically updated) permutation array.
10. `beginAssembly` (sparse-solver.ts:505) has dual personality (init or clear) gated on `_structureEmpty`; ngspice keeps `spCreate`/`spcCreateInternalVectors`/`spClear` as distinct entry points called by distinct callers.
11. `_spOrderAndFactor` line 1349-1352 calls `_linkRows` on every entry; ngspice (spfactor.c:246) only calls `spcLinkRows` inside the first-time-factor `else` branch.
12. `_spOrderAndFactor` line 1397-1399 sets `_factored=true` and `_needsReorder=false` BEFORE the early reuse-loop return; ngspice (spfactor.c:229-230) uses `goto Done` and only sets these at the `Done:` label after the second loop.
13. `_spOrderAndFactor` line 1399 (and 1453) does NOT set `Matrix->Reordered = YES`; ngspice (spfactor.c:280) sets it at every `Done:` exit.
14. `_spOrderAndFactor` line 1386 uses `>=` in the threshold rejection test; ngspice (spfactor.c:219) uses strict `<` for acceptance — the boundary case `largestInCol*RelThreshold == pivotMag` is classified differently.
15. `_spOrderAndFactor` line 1442-1443 skips `_updateMarkowitzNumbers` on the final step; ngspice (spfactor.c:271) calls `UpdateMarkowitzNumbers` unconditionally inside the loop.
16. `_spOrderAndFactor` is missing the `Matrix->MaxRowCountInLowerTri = -1;` reset (spfactor.c:257) between Markowitz precompute and the reorder loop.
17. `_spOrderAndFactor` is missing the `if (Matrix->Error >= spFATAL) return Matrix->Error;` propagation check (spfactor.c:270) inside the reorder loop.
18. `_spFactor` line 1474 fall-through to `_spOrderAndFactor` passes only `startStep=0`; ngspice (spfactor.c:334-335) passes RHS=NULL, RelThreshold=0.0, AbsThreshold=0.0, DiagPivoting=DIAG_PIVOTING_AS_DEFAULT — the four dropped arguments mean default-threshold behaviour is encoded at the wrong layer in TS.
19. `_spFactor` line 1483 starts the loop at `step=0`; ngspice (spfactor.c:348-352) handles `Step=1` (with explicit zero-pivot test and reciprocal) outside the main loop, then loops `Step=2..Size`.
20. `_spFactor` line 1498 takes the reciprocal BEFORE elimination; ngspice (spfactor.c:349, 383, 408) takes it AFTER the column update / scatter-gather. Order differs.
21. `_spFactor` does not call `spPartition` (spfactor.c:337); the partition table that drives ngspice's `DoRealDirect[]` decisions is absent — TS always uses linked-list elimination regardless of column density.
22. `factor()` line 570 short-circuits `_applyDiagGmin` on falsy `diagGmin`; ngspice (spsmp.c:173) unconditionally calls `LoadGmin` and lets the inner `Gmin != 0` test gate. The behavioural difference appears on `diagGmin == undefined` vs. `diagGmin == 0`.
23. `_applyDiagGmin` lives in the sparse-solver class; ngspice `LoadGmin` is in the SMP shim layer (spsmp.c:422), not in the sparse module — a layering inversion.
24. `factor()` line 580 takes a pre-factor matrix snapshot via `_takePreFactorSnapshotIfEnabled()`; this is digiTS instrumentation with no ngspice counterpart.
25. `_realRowColElimination` line 1535 hoists `pUpper->Col` into local `upperCol`; ngspice (spfactor.c:2585) reads `pUpper->Col` directly at fill-in creation. Minor but it changes the read pattern.
26. `_realRowColElimination` is missing the `spNO_MEMORY` propagation on failed `CreateFillin` (spfactor.c:2586-2589).
27. `_matrixIsSingular` line 1623 and `_zeroPivot` line 1639 use `?? step` fallbacks for `singularRow`; ngspice has no fallback — `IntToExtRowMap[Step]` is presumed valid by construction.
28. `finalize()` (sparse-solver.ts:535) is digiTS-only; ngspice has no post-stamp / pre-factor instrumentation hook.
29. The factor() return type is `FactorResult` (struct with `success`, `conditionEstimate`, `error`, `usedReorder`, optional `singularRow`/`singularCol`); ngspice returns a single `int` error code and surfaces the rest via `Matrix->...` field reads.
30. The reuse loop at sparse-solver.ts:1377-1393 lives inside `_spOrderAndFactor` AND is duplicated inside `_spFactor` (lines 1483-1496); ngspice has the loop in exactly one place (spfactor.c:214-228 inside `spOrderAndFactor`). The duplication breaks the banned-pattern guard rule (#7 / #8) about a single shared `Step` counter and not splitting into methods.
