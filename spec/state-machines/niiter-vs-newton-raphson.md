# NIiter vs newton-raphson.ts — Line-by-Line Code Mapping

Source files:
- **ngspice NIiter**: `ref/ngspice/src/maths/ni/niiter.c` — `NIiter()` function (line 608)
- **ngspice CKTload**: `ref/ngspice/src/spicelib/analysis/cktload.c` — `CKTload()` function (line 29)
- **ngspice NIconvTest**: `ref/ngspice/src/maths/ni/niconv.c` — `NIconvTest()` function (line 18)
- **ours NR**: `src/solver/analog/newton-raphson.ts` — `newtonRaphson()` function (line 435)
- **ours assembler**: `src/solver/analog/mna-assembler.ts` — `MNAAssembler.stampAll()` (line 54)
- **ours applyNodesetsAndICs**: `src/solver/analog/newton-raphson.ts` — `applyNodesetsAndICs()` (line 61)

---

## 1. Function Signature

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 1 | `int NIiter(CKTcircuit *ckt, int maxIter)` (niiter.c:609) | `export function newtonRaphson(opts: NROptions): NRResult` (line 435) | DIFF |

---

## 2. Local Variable Declarations

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 2 | `int iterno;` (niiter.c:611) | `for (let iteration = 0; ; iteration++)` — loop variable (line 484) | DIFF |
| 3 | `int ipass;` (niiter.c:612) | `let ipass = 0;` (line 453) | MATCH |
| 4 | `int error;` (niiter.c:613) | MISSING_OURS — error handling uses `factorResult.success` boolean | MISSING_OURS |
| 5 | `int i, j;` (niiter.c:614) | MISSING_OURS — temporaries are loop-scoped | MISSING_OURS |
| 6 | `double *temp;` (niiter.c:615) | `const tmp = voltages;` (line 718, inside loop) | DIFF |
| 7 | `double startTime;` (niiter.c:616) | MISSING_OURS — no timing instrumentation | MISSING_OURS |
| 8 | `static char *msg = "Too many iterations without convergence";` (niiter.c:617) | MISSING_OURS — diagnostic emitted inline via `makeDiagnostic` | MISSING_OURS |
| 9 | `CKTnode *node;` (niiter.c:619) | MISSING_OURS — ours iterates by index, not linked list | MISSING_OURS |
| 10 | `double diff, maxdiff, damp_factor, *OldCKTstate0=NULL;` (niiter.c:620) | `let oldState0: Float64Array \| null = null;` (line 452) + inline locals in damping block (lines 614-631) | DIFF |

---

## 3. maxIter Floor

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 11 | `if ( maxIter < 100 ) maxIter = 100;` (niiter.c:622) | `const maxIterations = opts.exactMaxIterations ? rawMaxIter : Math.max(rawMaxIter, 100);` (line 439) | DIFF |

---

## 4. iterno / ipass Initialization

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 12 | `iterno=0;` (niiter.c:624) | `for (let iteration = 0; ...)` — implicit 0-init (line 484) | MATCH |
| 13 | `ipass=0;` (niiter.c:625) | `let ipass = 0;` (line 453) | MATCH |

---

## 5. Destructure Options / Extract Parameters

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 14 | (parameters accessed via `ckt->CKTreltol`, `ckt->CKTvoltTol`, `ckt->CKTabstol`, etc.) | `const { solver, elements, matrixSize, maxIterations: rawMaxIter, reltol, abstol, iabstol, diagnostics } = opts;` (line 436) | DIFF |
| 15 | MISSING_NGSPICE | `const nodeCount = opts.nodeCount ?? matrixSize;` (line 440) | MISSING_NGSPICE |
| 16 | MISSING_NGSPICE | `const assembler = new MNAAssembler(solver);` (line 442) | MISSING_NGSPICE |
| 17 | `ckt->CKTrhs` / `ckt->CKTrhsOld` — pre-allocated by NIreinit | `let voltages = opts.voltagesBuffer ?? new Float64Array(matrixSize);` (line 447) | DIFF |
| 18 | MISSING_NGSPICE | `if (opts.voltagesBuffer) voltages.fill(0);` (line 448) | MISSING_NGSPICE |
| 19 | (same — `ckt->CKTrhsOld` pre-allocated) | `let prevVoltages = opts.prevVoltagesBuffer ?? new Float64Array(matrixSize);` (line 449) | DIFF |
| 20 | MISSING_NGSPICE | `const statePool = opts.statePool ?? null;` (line 451) | MISSING_NGSPICE |

---

## 6. Initial Guess

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 21 | (CKTrhsOld contains initial guess from prior CKTop/NIiter call or CKTic setup — no code inside NIiter) | `if (opts.initialGuess) { prevVoltages.set(opts.initialGuess); }` (lines 458-460) | DIFF |

---

## 7. Preorder State

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 22 | `ckt->CKTniState` flags — `NIDIDPREORDER` checked at niiter.c:844 | `let didPreorder = false;` (line 464) | DIFF |

---

## 8. Hooks and Instrumentation (MISSING_NGSPICE)

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 23 | MISSING_NGSPICE | `const onIter0Complete = opts.onIteration0Complete;` (line 467) | MISSING_NGSPICE |
| 24 | MISSING_NGSPICE | `opts.preIterationHook` (used at line 494) | MISSING_NGSPICE |
| 25 | MISSING_NGSPICE | `opts.postIterationHook` (used at line 657) | MISSING_NGSPICE |
| 26 | MISSING_NGSPICE | `opts.enableBlameTracking` (used at line 636) | MISSING_NGSPICE |
| 27 | MISSING_NGSPICE | `opts.detailedConvergence` (used at line 595) | MISSING_NGSPICE |
| 28 | MISSING_NGSPICE | `opts.limitingCollector` (used at lines 487-489) | MISSING_NGSPICE |

---

## 9. DCOP Mode Ladder Setup

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 29 | (Mode set by caller: `CKTop` sets `ckt->CKTmode = firstmode` including MODEINITJCT — no code inside NIiter) | `const ladder = opts.dcopModeLadder ?? null;` (line 470) | DIFF |
| 30 | (CKTmode already set before NIiter entry — no code inside NIiter) | `if (ladder) { ladder.pool.initMode = "initJct"; }` (line 472) | DIFF |
| 31 | (CKTic called from dctran.c before CKTop — no code inside NIiter) | `ladder.runPrimeJunctions();` (line 473) | DIFF |

---

## 10. UIC Bypass (MODETRANOP && MODEUIC)

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 32 | `if( (ckt->CKTmode & MODETRANOP) && (ckt->CKTmode & MODEUIC)) {` (niiter.c:628) | `if (opts.isDcOp && opts.statePool?.uic) {` (line 477) | DIFF |
| 33 | `temp = ckt->CKTrhsOld;` (niiter.c:629) | `[voltages, prevVoltages] = [prevVoltages, voltages];` (line 478) | DIFF |
| 34 | `ckt->CKTrhsOld = ckt->CKTrhs;` (niiter.c:630) | (included in destructuring swap above) | DIFF |
| 35 | `ckt->CKTrhs = temp;` (niiter.c:631) | (included in destructuring swap above) | DIFF |
| 36 | `error = CKTload(ckt);` (niiter.c:632) | `assembler.stampAll(elements, matrixSize, prevVoltages, null, 0);` (line 479) | DIFF |
| 37 | `if(error) { return(error); }` (niiter.c:633-635) | MISSING_OURS — stampAll does not return error codes | MISSING_OURS |
| 38 | `return(OK);` (niiter.c:636) | `solver.finalize(); return { converged: true, iterations: 0, voltages: prevVoltages, ... };` (lines 480-481) | DIFF |

---

## 11. SENSE2 / NIreinit Initialization

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 39 | `#ifdef WANT_SENSE2 ... NIsenReinit(ckt) ...` (niiter.c:638-643) | MISSING_OURS | MISSING_OURS |
| 40 | `if(ckt->CKTniState & NIUNINITIALIZED) {` (niiter.c:644) | MISSING_OURS — buffer allocation handled at entry (lines 447-449) | DIFF |
| 41 | `error = NIreinit(ckt);` (niiter.c:645) | MISSING_OURS — no separate reinit step | DIFF |
| 42 | `if(error) { ... return(error); }` (niiter.c:646-651) | MISSING_OURS | MISSING_OURS |
| 43 | `}` (niiter.c:652) | MISSING_OURS | MISSING_OURS |

---

## 12. for(;;) Loop Entry

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 44 | `for(;;) {` (niiter.c:656) | `for (let iteration = 0; ; iteration++) {` (line 484) | DIFF |

---

## 13. Step A: Clear noncon

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 45 | `ckt->CKTnoncon=0;` (niiter.c:657) | `assembler.noncon = 0;` (line 486) | MATCH |
| 46 | `ni_limit_reset();` (niiter.c:660) | `if (opts.limitingCollector != null) { opts.limitingCollector.length = 0; }` (lines 487-489) | DIFF |

---

## 14. Step B: NEWPRED Guard

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 47 | `#ifdef NEWPRED if(!(ckt->CKTmode & MODEINITPRED)) { #else if(1) { #endif` (niiter.c:662-666) | MISSING_OURS — no NEWPRED equivalent, always enters | DIFF |

---

## 15. Step B: CKTload Call

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 48 | `error = CKTload(ckt);` (niiter.c:667) | `assembler.stampAll(elements, matrixSize, prevVoltages, opts.limitingCollector ?? null, iteration, voltages);` (line 495) | DIFF |
| 49 | MISSING_NGSPICE | `opts.preIterationHook?.(iteration, prevVoltages);` (line 494) — called before stampAll | MISSING_NGSPICE |

---

## 16. Step B: CKTload Internals vs stampAll Internals

### 16a. Matrix Clear

| # | ngspice CKTload (C) | MNAAssembler.stampAll (TS) | Status |
|---|-------------------|----------------------|--------|
| 50 | `size = SMPmatSize(ckt->CKTmatrix);` (cktload.c:52) | `matrixSize` parameter passed in | MATCH |
| 51 | `for (i = 0; i <= size; i++) { ckt->CKTrhs[i] = 0; }` (cktload.c:53-55) | `this._solver.beginAssembly(matrixSize);` (mna-assembler.ts:62) — beginAssembly zeros RHS internally | DIFF |
| 52 | `SMPclear(ckt->CKTmatrix);` (cktload.c:56) | (included in `beginAssembly` above — zeros matrix) | DIFF |

### 16b. Device Load Loop

| # | ngspice CKTload (C) | MNAAssembler.stampAll (TS) | Status |
|---|-------------------|----------------------|--------|
| 53 | `for (i = 0; i < DEVmaxnum; i++) {` (cktload.c:61) | `if (iteration > 0) { this.updateOperatingPoints(...); }` + `for (const el of elements) { ... }` (mna-assembler.ts:64-79) | DIFF |
| 54 | `if (DEVices[i] && DEVices[i]->DEVload && ckt->CKThead[i]) {` (cktload.c:62) | (no type-level iteration — flat element list) | DIFF |
| 55 | `error = DEVices[i]->DEVload(ckt->CKThead[i], ckt);` (cktload.c:63) | (split into updateOperatingPoint + stamp + stampNonlinear + stampReactiveCompanion — see rows 56-63) | DIFF |

### 16c. Inside DEVload vs Our Split Passes

| # | ngspice CKTload (C) | MNAAssembler.stampAll (TS) | Status |
|---|-------------------|----------------------|--------|
| 56 | (inside DEVload: read `CKTrhsOld` node voltages) | `voltages` parameter passed to `updateOperatingPoints` (mna-assembler.ts:65) | DIFF |
| 57 | (inside DEVload: apply voltage limiting — ALL iterations including iter 0) | `el.updateOperatingPoint(voltages, limitingCollector)` — iter > 0 only (mna-assembler.ts:64 guard) | DIFF |
| 58 | (inside DEVload: evaluate device equations) | (included in `updateOperatingPoint` above) | DIFF |
| 59 | (inside DEVload: set `CKTnoncon` if limiting occurred) | `if (limited) this.noncon++` (mna-assembler.ts:107) | DIFF |
| 60 | (inside DEVload: stamp conductance matrix + RHS) | `el.stamp(this._solver);` (mna-assembler.ts:72) | DIFF |
| 61 | (inside DEVload: nonlinear stamps part of same DEVload) | `if (el.isNonlinear && el.stampNonlinear) { el.stampNonlinear(this._solver); }` (mna-assembler.ts:73-75) | DIFF |
| 62 | (inside DEVload: call NIintegrate for reactive elements) | `if (el.isReactive && el.stampReactiveCompanion) { el.stampReactiveCompanion(this._solver); }` (mna-assembler.ts:76-78) | DIFF |
| 63 | MISSING_NGSPICE | `if (iteration > 0 && prevVoltages !== undefined && el.shouldBypass?.(...)) { continue; }` (mna-assembler.ts:69-71) | MISSING_NGSPICE |

### 16d. CKTload Post-Device

| # | ngspice CKTload (C) | MNAAssembler.stampAll (TS) | Status |
|---|-------------------|----------------------|--------|
| 64 | `if (ckt->CKTnoncon) ckt->CKTtroubleNode = 0;` (cktload.c:64-65) | MISSING_OURS — no troubleNode tracking | MISSING_OURS |
| 65 | `if (error) return(error);` (cktload.c:73) | MISSING_OURS — stampAll does not return errors | MISSING_OURS |
| 66 | (CKTload does not call finalize — linked-list sparse matrix ready after stamp loop) | `this._solver.finalize();` (mna-assembler.ts:82) | DIFF |

### 16e. Post-CKTload in NIiter

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 67 | `iterno++;` (niiter.c:670) | (iteration incremented by for-loop header `iteration++`) | DIFF |
| 68 | `if(error) { ckt->CKTstat->STATnumIter += iterno; ... return(error); }` (niiter.c:671-678) | MISSING_OURS — stampAll does not return errors | MISSING_OURS |

---

## 17. Step C: Nodeset/IC Enforcement

### 17a. ngspice: inside CKTload (cktload.c:104-158) vs ours: separate step (newton-raphson.ts:497-512)

| # | ngspice CKTload (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 69 | `if (ckt->CKTmode & MODEDC) {` (cktload.c:104) | `if (opts.nodesets?.size || opts.ics?.size) {` (line 501) | DIFF |
| 70 | `if (ckt->CKTmode & (MODEINITJCT | MODEINITFIX)) {` (cktload.c:106) | mode check inside `applyNodesetsAndICs` (line 69: `if (initMode === "initJct" || initMode === "initFix")`) | MATCH |
| 71 | `for (node = ckt->CKTnodes; node; node = node->next) {` (cktload.c:108) | `for (const [nodeId, value] of nodesets) {` (line 70) | DIFF |
| 72 | `if (node->nsGiven) {` (cktload.c:109) | (implicit — only entries in the nodesets Map are processed) | DIFF |
| 73 | `if (ZeroNoncurRow(...)) {` (cktload.c:110-111) | MISSING_OURS — no ZeroNoncurRow; always uses 1e10 stamp | MISSING_OURS |
| 74 | `ckt->CKTrhs[node->number] = 1.0e10 * node->nodeset * ckt->CKTsrcFact;` (cktload.c:112-113) | `solver.stampRHS(nodeId, G_NODESET * value * srcFact);` (line 72) | DIFF |
| 75 | `*(node->ptr) = 1e10;` (cktload.c:114) | `solver.stamp(nodeId, nodeId, G_NODESET);` (line 71) | DIFF |
| 76 | `} else { ...nodeset * srcFact; *(node->ptr) = 1; }` (cktload.c:115-118) | MISSING_OURS — ours always uses 1e10 path | MISSING_OURS |
| 77 | `if ((ckt->CKTmode & MODETRANOP) && (!(ckt->CKTmode & MODEUIC))) {` (cktload.c:130) | (no MODETRANOP/MODEUIC gate — ICs always applied) | DIFF |
| 78 | `for (node = ckt->CKTnodes; node; node = node->next) {` (cktload.c:131) | `for (const [nodeId, value] of ics) {` (line 75) | DIFF |
| 79 | `if (node->icGiven) {` (cktload.c:132) | (implicit — only entries in the ics Map are processed) | DIFF |
| 80 | `if (ZeroNoncurRow(...)) {` (cktload.c:133-134) | MISSING_OURS — no ZeroNoncurRow equivalent | MISSING_OURS |
| 81 | `ckt->CKTrhs[node->number] = 1.0e10 * node->ic * ckt->CKTsrcFact;` (cktload.c:138-139) | `solver.stampRHS(nodeId, G_NODESET * value * srcFact);` (line 77) | DIFF |
| 82 | `*(node->ptr) += 1.0e10;` (cktload.c:140) | `solver.stamp(nodeId, nodeId, G_NODESET);` (line 76) | DIFF |
| 83 | `} else { ...ic * srcFact; *(node->ptr) = 1; }` (cktload.c:144-146) | MISSING_OURS — ours always uses 1e10 path | MISSING_OURS |
| 84 | MISSING_NGSPICE | `solver.finalize();` (line 511) — re-finalize after nodeset/IC stamps | MISSING_NGSPICE |

---

## 18. Pre-LU Matrix Snapshot (Harness Instrumentation)

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 85 | `if (ni_instrument_cb) { /* 140 lines of CSC extraction */ }` (niiter.c:704-842) | MISSING_OURS — no pre-LU matrix snapshot in NR loop | MISSING_OURS |

---

## 19. Step D: Preorder

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 86 | `if(!(ckt->CKTniState & NIDIDPREORDER)) {` (niiter.c:844) | `if (!didPreorder) {` (line 516) | MATCH |
| 87 | `error = SMPpreOrder(ckt->CKTmatrix);` (niiter.c:845) | `solver.preorder();` (line 517) | DIFF |
| 88 | `if(error) { ... return(error); }` (niiter.c:846-852) | MISSING_OURS — preorder does not return errors | MISSING_OURS |
| 89 | `ckt->CKTniState |= NIDIDPREORDER;` (niiter.c:854) | `didPreorder = true;` (line 518) | MATCH |

---

## 20. NISHOULDREORDER Flag Setting

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 90 | `if( (ckt->CKTmode & MODEINITJCT) || ( (ckt->CKTmode & MODEINITTRAN) && (iterno==1))) {` (niiter.c:856-857) | MISSING_OURS — reorder forcing handled in INITF dispatcher (lines 683, 700) | DIFF |
| 91 | `ckt->CKTniState |= NISHOULDREORDER;` (niiter.c:858) | (see row 90) | DIFF |

---

## 21. Diagonal Gmin

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 92 | (diagGmin applied inside SMPreorder/SMPluFac as parameter: `ckt->CKTdiagGmin`) (niiter.c:863-864, 883-884) | `if (opts.diagonalGmin) { solver.addDiagonalGmin(opts.diagonalGmin); }` (lines 522-524) — applied before factorization | DIFF |

---

## 22. Step E: Factorize — Reorder Path

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 93 | `if(ckt->CKTniState & NISHOULDREORDER) {` (niiter.c:861) | `let factorResult = solver.factor();` (line 528) — solver internally decides reorder vs numerical | DIFF |
| 94 | `startTime = SPfrontEnd->IFseconds();` (niiter.c:862) | MISSING_OURS — no timing | MISSING_OURS |
| 95 | `error = SMPreorder(ckt->CKTmatrix, ckt->CKTpivotAbsTol, ckt->CKTpivotRelTol, ckt->CKTdiagGmin);` (niiter.c:863-864) | (solver.factor() internally performs reorder when needed) | DIFF |
| 96 | `ckt->CKTstat->STATreorderTime += SPfrontEnd->IFseconds() - startTime;` (niiter.c:865-866) | MISSING_OURS — no timing | MISSING_OURS |
| 97 | `if(error) { SMPgetError(...); ... return(error); }` (niiter.c:867-878) | `if (!factorResult.success) { diagnostics.emit(makeDiagnostic("singular-matrix", ...)); return { converged: false, ... }; }` (lines 535-543) | DIFF |
| 98 | `ckt->CKTniState &= ~NISHOULDREORDER;` (niiter.c:880) | (solver manages reorder state internally) | DIFF |

---

## 23. Step E: Factorize — Numerical Path

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 99 | `} else {` (niiter.c:881) | (solver.factor() tries numerical first, then reorder on failure) | DIFF |
| 100 | `startTime = SPfrontEnd->IFseconds();` (niiter.c:882) | MISSING_OURS — no timing | MISSING_OURS |
| 101 | `error=SMPluFac(ckt->CKTmatrix, ckt->CKTpivotAbsTol, ckt->CKTdiagGmin);` (niiter.c:883-884) | `let factorResult = solver.factor();` (line 528) | DIFF |
| 102 | `ckt->CKTstat->STATdecompTime += SPfrontEnd->IFseconds() - startTime;` (niiter.c:885-886) | MISSING_OURS — no timing | MISSING_OURS |

---

## 24. Step E: E_SINGULAR Recovery

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 103 | `if(error) {` (niiter.c:887) | `if (!factorResult.success) {` (line 529) | MATCH |
| 104 | `if( error == E_SINGULAR ) {` (niiter.c:888) | `if (!solver.lastFactorUsedReorder) {` (line 530) | DIFF |
| 105 | `ckt->CKTniState |= NISHOULDREORDER;` (niiter.c:889) | `solver.forceReorder();` (line 532) | DIFF |
| 106 | `continue;` (niiter.c:891) — restarts from CKTload (top of for(;;)) | `factorResult = solver.factor();` (line 533) — retries factorization only, no re-load | DIFF |
| 107 | `}` (niiter.c:892) | `}` (line 534) | MATCH |
| 108 | `ckt->CKTstat->STATnumIter += iterno; ... return(error);` (niiter.c:896-901) | `if (!factorResult.success) { diagnostics.emit(...); return { converged: false, ... }; }` (lines 535-543) | DIFF |

---

## 25. Save OldCKTstate0 for Damping

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 109 | `if(!OldCKTstate0) OldCKTstate0=TMALLOC(double, ckt->CKTnumStates + 1);` (niiter.c:906-907) | `if (statePool) { if (!oldState0) { oldState0 = new Float64Array(statePool.state0.length); } }` (lines 547-549) | DIFF |
| 110 | `for(i=0; i<ckt->CKTnumStates; i++) { OldCKTstate0[i] = ckt->CKTstate0[i]; }` (niiter.c:908-909) | `oldState0.set(statePool.state0);` (line 551) | MATCH |

---

## 26. Topology Callback

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 111 | `ni_send_topology(ckt);` (niiter.c:913) | MISSING_OURS — no topology callback in NR loop | MISSING_OURS |

---

## 27. Pre-Solve RHS Capture

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 112 | `if (ni_instrument_cb) { ... memcpy(ni_preSolveRhs, ckt->CKTrhs, sz * sizeof(double)); }` (niiter.c:916-924) | MISSING_OURS — no pre-solve RHS capture | MISSING_OURS |

---

## 28. Step F: Solve

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 113 | `startTime = SPfrontEnd->IFseconds();` (niiter.c:926) | MISSING_OURS — no timing | MISSING_OURS |
| 114 | `SMPsolve(ckt->CKTmatrix, ckt->CKTrhs, ckt->CKTrhsSpare);` (niiter.c:927) | `solver.solve(voltages);` (line 555) | DIFF |
| 115 | `ckt->CKTstat->STATsolveTime += SPfrontEnd->IFseconds() - startTime;` (niiter.c:928-929) | MISSING_OURS — no timing | MISSING_OURS |
| 116 | `*ckt->CKTrhs = 0;` (niiter.c:940) | MISSING_OURS — ground node zeroing handled by solver | MISSING_OURS |
| 117 | `*ckt->CKTrhsSpare = 0;` (niiter.c:941) | MISSING_OURS — no rhsSpare vector | MISSING_OURS |
| 118 | `*ckt->CKTrhsOld = 0;` (niiter.c:942) | MISSING_OURS — ground node zeroing handled by solver | MISSING_OURS |

---

## 29. Step G: Iteration Limit Check

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 119 | `if(iterno > maxIter) {` (niiter.c:944) | `if (iteration + 1 > maxIterations) {` (line 560) | MATCH |
| 120 | `ckt->CKTstat->STATnumIter += iterno;` (niiter.c:947) | MISSING_OURS — no stat tracking | MISSING_OURS |
| 121 | `FREE(errMsg); errMsg = TMALLOC(...); strcpy(errMsg,msg);` (niiter.c:948-950) | MISSING_OURS — no errMsg allocation | MISSING_OURS |
| 122 | `FREE(OldCKTstate0);` (niiter.c:954) | MISSING_OURS — GC handles cleanup | MISSING_OURS |
| 123 | `return(E_ITERLIM);` (niiter.c:955) | `return { converged: false, iterations: iteration + 1, voltages, largestChangeElement: -1, largestChangeNode: -1 };` (line 561) | DIFF |

---

## 30. Step H: Convergence Check

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 124 | `if(ckt->CKTnoncon==0 && iterno!=1) {` (niiter.c:957) | `if (iteration === 0) { assembler.noncon = 1; }` (lines 567-569) + `if (assembler.noncon === 0 && iteration > 0) {` (line 577) | DIFF |
| 125 | `ckt->CKTnoncon = NIconvTest(ckt);` (niiter.c:958) | (inline convergence test — see section 31) | DIFF |
| 126 | `} else { ckt->CKTnoncon = 1; }` (niiter.c:959-961) | `if (iteration === 0) { assembler.noncon = 1; }` (lines 567-569) | DIFF |

---

## 31. Step H: NIconvTest Internals vs Inline Convergence

### 31a. Node Convergence Loop

| # | ngspice NIconvTest (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 127 | `node = ckt->CKTnodes;` (niconv.c:28) | MISSING_OURS — iterates by index | DIFF |
| 128 | `size = SMPmatSize(ckt->CKTmatrix);` (niconv.c:29) | `matrixSize` from opts | MATCH |
| 129 | `for (i=1;i<=size;i++) {` (niconv.c:37) | `for (let i = 0; i < matrixSize; i++) {` (line 581) | DIFF |
| 130 | `node = node->next;` (niconv.c:38) | (no node linked-list traversal) | DIFF |
| 131 | `new = ckt->CKTrhs[i];` (niconv.c:39) | `voltages[i]` (line 583) | MATCH |
| 132 | `old = ckt->CKTrhsOld[i];` (niconv.c:40) | `prevVoltages[i]` (line 583) | MATCH |
| 133 | `if(node->type == SP_VOLTAGE) {` (niconv.c:41) | `const absTol = i < nodeCount ? abstol : iabstol;` (line 587) | DIFF |
| 134 | `tol = ckt->CKTreltol * (MAX(fabs(old),fabs(new))) + ckt->CKTvoltTol;` (niconv.c:42-43) | `const tol = reltol * Math.max(Math.abs(voltages[i]), Math.abs(prevVoltages[i])) + absTol;` (line 588) | MATCH |
| 135 | `if (fabs(new-old) > tol) {` (niconv.c:44) | `if (delta > tol) { globalConverged = false; }` (lines 589-591) | DIFF |
| 136 | `ckt->CKTtroubleNode = i;` (niconv.c:49) | MISSING_OURS — no troubleNode tracking | MISSING_OURS |
| 137 | `ckt->CKTtroubleElt = NULL;` (niconv.c:50) | MISSING_OURS | MISSING_OURS |
| 138 | `return(1);` (niconv.c:51) — short-circuits on first failure | (does not short-circuit — continues to track largest change) | DIFF |
| 139 | `} else {` (niconv.c:53) — current branch node | (handled by `i < nodeCount ? abstol : iabstol` at line 587) | DIFF |
| 140 | `tol = ckt->CKTreltol * (MAX(fabs(old),fabs(new))) + ckt->CKTabstol;` (niconv.c:54-55) | (same formula, with `iabstol` substituted for `CKTabstol`) | MATCH |
| 141 | `if (fabs(new-old) > tol) { ... return(1); }` (niconv.c:56-63) | `if (delta > tol) { globalConverged = false; }` (lines 589-591) | DIFF |

### 31b. Largest Change Tracking (MISSING_NGSPICE)

| # | ngspice NIconvTest (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 142 | MISSING_NGSPICE | `const delta = Math.abs(voltages[i] - prevVoltages[i]);` (line 582) | MISSING_NGSPICE |
| 143 | MISSING_NGSPICE | `if (delta > largestChangeMag) { largestChangeMag = delta; largestChangeNode = i; }` (lines 583-586) | MISSING_NGSPICE |

### 31c. Device Convergence (NEWCONV)

| # | ngspice NIconvTest (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 144 | `#ifdef NEWCONV i = CKTconvTest(ckt); ... return(i); #else return(0); #endif` (niconv.c:68-75) | `elemConverged = assembler.checkAllConverged(elements, voltages, prevVoltages, reltol, iabstol);` (line 600) | DIFF |

### 31d. Detailed Convergence (MISSING_NGSPICE)

| # | ngspice NIconvTest (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 145 | MISSING_NGSPICE | `if (opts.detailedConvergence) { const detailed = assembler.checkAllConvergedDetailed(...); ... }` (lines 595-601) | MISSING_NGSPICE |
| 146 | MISSING_NGSPICE | `} else if (assembler.noncon > 0 && iteration > 0 && opts.detailedConvergence) { ... }` (lines 602-609) | MISSING_NGSPICE |

---

## 32. Instrumentation Callback (ngspice harness code)

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 147 | `if (ni_instrument_cb) { /* 50 lines: populate NiIterationData + fire callback */ }` (niiter.c:966-1017) | MISSING_OURS — ours uses postIterationHook instead (line 657) | DIFF |

---

## 33. Step I: Newton Damping

### 33a. Damping Guard

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 148 | `if( (ckt->CKTnodeDamping!=0) && (ckt->CKTnoncon!=0) &&` (niiter.c:1020) | `if (opts.nodeDamping && assembler.noncon !== 0 && opts.isDcOp && iteration > 0) {` (line 613) | DIFF |
| 149 | `((ckt->CKTmode & MODETRANOP) || (ckt->CKTmode & MODEDCOP)) &&` (niiter.c:1021) | `opts.isDcOp` (line 613) — checks isDcOp only, does not include MODETRANOP separately | DIFF |
| 150 | `(iterno>1) ) {` (niiter.c:1022) | `iteration > 0` (line 613) | DIFF |

### 33b. Compute maxdiff

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 151 | `maxdiff=0;` (niiter.c:1023) | `let maxDelta = 0;` (line 614) | MATCH |
| 152 | `for (node = ckt->CKTnodes->next; node; node = node->next) {` (niiter.c:1024) | `for (let i = 0; i < nodeCount; i++) {` (line 615) | DIFF |
| 153 | `if(node->type == SP_VOLTAGE) {` (niiter.c:1025) | (no type check — uses nodeCount to restrict to voltage nodes) | DIFF |
| 154 | `diff = ckt->CKTrhs[node->number] - ckt->CKTrhsOld[node->number];` (niiter.c:1026-1027) | `const delta = Math.abs(voltages[i] - prevVoltages[i]);` (line 616) | DIFF |
| 155 | `if (diff>maxdiff) maxdiff=diff;` (niiter.c:1028) | `if (delta > maxDelta) maxDelta = delta;` (line 617) | DIFF |

### 33c. Apply Damping to Voltages

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 156 | `if (maxdiff>10) {` (niiter.c:1031) | `if (maxDelta > 10) {` (line 619) | MATCH |
| 157 | `damp_factor=10/maxdiff;` (niiter.c:1032) | `const dampFactor = Math.max(10 / maxDelta, 0.1);` (line 620) | DIFF |
| 158 | `if (damp_factor<0.1) damp_factor=0.1;` (niiter.c:1033) | (included in Math.max above) | MATCH |
| 159 | `for (node = ckt->CKTnodes->next; node; node = node->next) {` (niiter.c:1034) | `for (let i = 0; i < nodeCount; i++) {` (line 621) | DIFF |
| 160 | `diff = ckt->CKTrhs[node->number] - ckt->CKTrhsOld[node->number];` (niiter.c:1035-1036) | (computed inline in assignment) | DIFF |
| 161 | `ckt->CKTrhs[node->number] = ckt->CKTrhsOld[node->number] + (damp_factor * diff);` (niiter.c:1037-1038) | `voltages[i] = prevVoltages[i] + dampFactor * (voltages[i] - prevVoltages[i]);` (line 622) | MATCH |

### 33d. State0 Damping (DO10)

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 162 | `for(i=0; i<ckt->CKTnumStates; i++) {` (niiter.c:1040) | `if (statePool && oldState0) { const s0 = statePool.state0; for (let i = 0; i < s0.length; i++) {` (lines 625-628) | MATCH |
| 163 | `diff = ckt->CKTstate0[i] - OldCKTstate0[i];` (niiter.c:1041) | (computed inline) | DIFF |
| 164 | `ckt->CKTstate0[i] = OldCKTstate0[i] + (damp_factor * diff);` (niiter.c:1042-1043) | `s0[i] = oldState0[i] + dampFactor * (s0[i] - oldState0[i]);` (line 629) | MATCH |

---

## 34. Blame Tracking (MISSING_NGSPICE)

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 165 | MISSING_NGSPICE | `let largestChangeElement = -1;` (line 635) | MISSING_NGSPICE |
| 166 | MISSING_NGSPICE | `if (opts.enableBlameTracking) { ... for (let ei = 0; ei < elements.length; ei++) { ... } }` (lines 636-653) | MISSING_NGSPICE |

---

## 35. Post-Iteration Hook (MISSING_NGSPICE)

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 167 | MISSING_NGSPICE | `const limitingEvents = opts.limitingCollector ?? [];` (line 656) | MISSING_NGSPICE |
| 168 | MISSING_NGSPICE | `opts.postIterationHook?.(iteration, voltages, prevVoltages, assembler.noncon, globalConverged, elemConverged, limitingEvents, convergenceFailedElements);` (line 657) | MISSING_NGSPICE |

---

## 36. Step J: INITF Dispatcher — MODEINITFLOAT

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 169 | `if(ckt->CKTmode & MODEINITFLOAT) {` (niiter.c:1050) | `const initPool = ladder ? ladder.pool : (opts.statePool as { initMode: string } | null);` (line 662) + `const curInitMode = initPool?.initMode ?? "transient";` (line 664) | DIFF |
| 170 | MISSING_NGSPICE | `if (curInitMode === "initFloat" || curInitMode === "transient") {` (line 665) — ours also allows convergence return in "transient" mode | DIFF |
| 171 | `if ((ckt->CKTmode & MODEDC) && ( ckt->CKThadNodeset) ) {` (niiter.c:1051-1052) | MISSING_OURS — no hadNodeset check; ipass logic is unconditional | DIFF |
| 172 | `if(ipass) { ckt->CKTnoncon=ipass; }` (niiter.c:1053-1054) | `if (ipass > 0) { ipass--; assembler.noncon = 1; }` (lines 667-669) | DIFF |
| 173 | `ipass=0;` (niiter.c:1056) | (ipass decremented above, not zeroed) | DIFF |
| 174 | `if(ckt->CKTnoncon == 0) {` (niiter.c:1058) | `if (assembler.noncon === 0 && globalConverged && elemConverged) {` (line 666) | DIFF |
| 175 | `ckt->CKTstat->STATnumIter += iterno;` (niiter.c:1059) | MISSING_OURS — no stat tracking | MISSING_OURS |
| 176 | `FREE(OldCKTstate0);` (niiter.c:1060) | MISSING_OURS — GC handles cleanup | MISSING_OURS |
| 177 | `return(OK);` (niiter.c:1061) | `return { converged: true, iterations: iteration + 1, voltages, largestChangeElement, largestChangeNode };` (line 678) | DIFF |

---

## 37. Step J: INITF Dispatcher — MODEINITJCT

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 178 | `} else if(ckt->CKTmode & MODEINITJCT) {` (niiter.c:1063) | `} else if (curInitMode === "initJct") {` (line 681) | MATCH |
| 179 | `ckt->CKTmode = (ckt->CKTmode&(~INITF))|MODEINITFIX;` (niiter.c:1064) | `if (initPool) initPool.initMode = "initFix";` (line 682) | MATCH |
| 180 | `ckt->CKTniState |= NISHOULDREORDER;` (niiter.c:1065) | `solver.forceReorder();` (line 683) | DIFF |
| 181 | MISSING_NGSPICE | `if (ladder) { ladder.onModeEnd("dcopInitJct", iteration, false); ladder.onModeBegin("dcopInitFix", iteration + 1); }` (lines 684-687) | MISSING_NGSPICE |

---

## 38. Step J: INITF Dispatcher — MODEINITFIX

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 182 | `} else if (ckt->CKTmode & MODEINITFIX) {` (niiter.c:1066) | `} else if (curInitMode === "initFix") {` (line 688) | MATCH |
| 183 | `if(ckt->CKTnoncon==0) ckt->CKTmode = (ckt->CKTmode&(~INITF))|MODEINITFLOAT;` (niiter.c:1067-1068) | `if (assembler.noncon === 0) { if (initPool) initPool.initMode = "initFloat"; }` (lines 689-690) | MATCH |
| 184 | `ipass=1;` (niiter.c:1069) | `ipass = 1;` (line 691) | MATCH |
| 185 | MISSING_NGSPICE | `if (ladder) { ladder.onModeEnd("dcopInitFix", iteration, false); ladder.onModeBegin("dcopInitFloat", iteration + 1); }` (lines 692-695) | MISSING_NGSPICE |

---

## 39. Step J: INITF Dispatcher — MODEINITSMSIG

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 186 | `} else if (ckt->CKTmode & MODEINITSMSIG) {` (niiter.c:1070) | `} else if (curInitMode === "initSmsig") {` (line 704) | MATCH |
| 187 | `ckt->CKTmode = (ckt->CKTmode&(~INITF))|MODEINITFLOAT;` (niiter.c:1071) | `if (initPool) initPool.initMode = "initFloat";` (line 705) | MATCH |

---

## 40. Step J: INITF Dispatcher — MODEINITTRAN

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 188 | `} else if (ckt->CKTmode & MODEINITTRAN) {` (niiter.c:1072) | `} else if (curInitMode === "initTran") {` (line 697) | MATCH |
| 189 | `if(iterno<=1) ckt->CKTniState |= NISHOULDREORDER;` (niiter.c:1073) | `if (iteration <= 0) { solver.forceReorder(); }` (lines 699-701) | DIFF |
| 190 | `ckt->CKTmode = (ckt->CKTmode&(~INITF))|MODEINITFLOAT;` (niiter.c:1074) | `if (initPool) initPool.initMode = "initFloat";` (line 698) | MATCH |

---

## 41. Step J: INITF Dispatcher — MODEINITPRED

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 191 | `} else if (ckt->CKTmode & MODEINITPRED) {` (niiter.c:1075) | `} else if (curInitMode === "initPred") {` (line 702) | MATCH |
| 192 | `ckt->CKTmode = (ckt->CKTmode&(~INITF))|MODEINITFLOAT;` (niiter.c:1076) | `if (initPool) initPool.initMode = "initFloat";` (line 703) | MATCH |

---

## 42. Step J: INITF Dispatcher — Bad INITF State

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 193 | `} else { ckt->CKTstat->STATnumIter += iterno; ... return(E_INTERN); }` (niiter.c:1077-1084) | MISSING_OURS — no bad-INITF-state check; defaults to "transient" handling | MISSING_OURS |

---

## 43. Ladder Mode End Emission (MISSING_NGSPICE)

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 194 | MISSING_NGSPICE | `if (ladder) { const phaseLabel = ...; ladder.onModeEnd(phaseLabel, iteration, true); }` (lines 672-677) — emits terminal ladder end before convergence return | MISSING_NGSPICE |

---

## 44. Iteration 0 Complete Hook (MISSING_NGSPICE)

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 195 | MISSING_NGSPICE | `if (onIter0Complete && iteration === 0) { onIter0Complete(); }` (lines 711-713) | MISSING_NGSPICE |

---

## 45. Step K: Swap RHS Vectors

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 196 | `temp = ckt->CKTrhsOld;` (niiter.c:1088) | `const tmp = voltages;` (line 718) | MATCH |
| 197 | `ckt->CKTrhsOld = ckt->CKTrhs;` (niiter.c:1089) | `voltages = prevVoltages;` (line 719) | MATCH |
| 198 | `ckt->CKTrhs = temp;` (niiter.c:1090) | `prevVoltages = tmp;` (line 720) | MATCH |

---

## 46. Post-Loop Unreachable Return

| # | ngspice NIiter (C) | newton-raphson.ts (TS) | Status |
|---|-------------------|----------------------|--------|
| 199 | `/*NOTREACHED*/` (niiter.c:1094) + `}` (niiter.c:1095) | `return { converged: false, iterations: maxIterations, voltages: prevVoltages, largestChangeElement: -1, largestChangeNode: -1 };` (line 724) | DIFF |

---

## 47. Helper Functions: pnjlim

| # | ngspice DEVpnjlim (devsup.c) | newton-raphson.ts pnjlim (TS) | Status |
|---|-------------------|----------------------|--------|
| 200 | `double DEVpnjlim(double vnew, double vold, double vt, double vcrit, int *icheck)` | `export function pnjlim(vnew: number, vold: number, vt: number, vcrit: number): PnjlimResult` (line 282) | DIFF |
| 201 | `if(vnew > vcrit && fabs(vnew - vold) > (vt + vt)) {` | `if (vnew > vcrit && Math.abs(vnew - vold) > 2 * vt) {` (line 284) | MATCH |
| 202 | `if(vold > 0) {` | `if (vold > 0) {` (line 286) | MATCH |
| 203 | `double arg = 1 + (vnew - vold) / vt;` — ngspice: arg includes +1 offset | `const arg = (vnew - vold) / vt;` (line 287) — ours: arg without +1 offset | DIFF |
| 204 | `if (arg > 0) vnew = vold + vt * (2 + log(arg));` — ngspice `log(1 + delta/vt)` | `vnew = vold + vt * (2 + Math.log(arg - 2));` (line 289) — ours `log(delta/vt - 2)` | DIFF |
| 205 | `else vnew = vold - vt * (2 + log(2 - arg));` — ngspice `2 - arg = 1 - delta/vt` | `vnew = vold - vt * (2 + Math.log(2 - arg));` (line 291) — ours `2 - arg = 2 - delta/vt` | DIFF |
| 206 | `} else { vnew = vt * log(vnew/vt); }` | `vnew = vt * Math.log(vnew / vt);` (line 294) | MATCH |
| 207 | `*icheck = 1;` | `limited = true;` (line 296) | MATCH |
| 208 | `} else {` — reverse-bias branch | `} else {` (line 297) | MATCH |
| 209 | `if(vnew < 0) { if(vold > 0) { arg = -1 - vold; } else { arg = 2*vold - 1; } if(vnew < arg) { vnew = arg; *icheck = 1; } }` (AlansFixes) | `if (vnew < 0) { let arg; if (vold > 0) { arg = -vold - 1; } else { arg = 2 * vold - 1; } if (vnew < arg) { vnew = arg; limited = true; } }` (lines 299-309) | DIFF |
| 210 | `return(vnew);` | `_pnjlimResult.value = vnew; _pnjlimResult.limited = limited; return _pnjlimResult;` (lines 312-314) | DIFF |

---

## 48. Helper Functions: fetlim

| # | ngspice DEVfetlim (devsup.c) | newton-raphson.ts fetlim (TS) | Status |
|---|-------------------|----------------------|--------|
| 211 | `double DEVfetlim(double vnew, double vold, double vto)` | `export function fetlim(vnew: number, vold: number, vto: number): number` (line 339) | MATCH |
| 212 | `double vtsthi = fabs(2*(vold-vto))+2;` | `const vtsthi = Math.abs(2 * (vold - vto)) + 2;` (line 340) | MATCH |
| 213 | `double vtstlo = vtsthi/2 + 2;` — ngspice: `vtstlo = vtsthi/2 + 2` | `const vtstlo = Math.abs(vold - vto) + 1;` (line 341) | DIFF |
| 214 | `double vtox = vto + 3.5;` | `const vtox = vto + 3.5;` (line 342) | MATCH |
| 215 | `double delv = vnew - vold;` | `const delv = vnew - vold;` (line 343) | MATCH |
| 216 | Deep ON zone: `if(vold >= vto) { if(vold >= vtox) { ... } }` | (lines 345-359 same control flow) | MATCH |
| 217 | Near threshold: `else { if(delv <= 0) { ... } else { ... } }` | (lines 361-366 same control flow) | MATCH |
| 218 | OFF zone: `} else { if(delv <= 0) { ... } else { ... } }` | (lines 369-380 same control flow) | MATCH |
| 219 | `return(vnew);` | `return vnew;` (line 381) | MATCH |

---

## 49. Helper Functions: limvds

| # | ngspice DEVlimvds (devsup.c) | newton-raphson.ts limvds (TS) | Status |
|---|-------------------|----------------------|--------|
| 220 | `double DEVlimvds(double vnew, double vold)` | `export function limvds(vnew: number, vold: number): number` (line 396) | MATCH |
| 221 | `if(vold >= 3.5) { if(vnew > vold) { vnew = MIN(vnew, 3*vold+2); } else if(vnew < 3.5) { vnew = MAX(vnew, 2); } }` | `if (vold >= 3.5) { if (vnew > vold) { vnew = Math.min(vnew, 3 * vold + 2); } else if (vnew < 3.5) { vnew = Math.max(vnew, 2); } }` (lines 397-402) | MATCH |
| 222 | `else { if(vnew > vold) { vnew = MIN(vnew, 4); } else { vnew = MAX(vnew, -.5); } }` | `else { if (vnew > vold) { vnew = Math.min(vnew, 4); } else { vnew = Math.max(vnew, -0.5); } }` (lines 403-410) | MATCH |
| 223 | `return(vnew);` | `return vnew;` (line 411) | MATCH |

---

## 50. Helper Functions: applyNodesetsAndICs

| # | ngspice CKTload nodeset/IC code (cktload.c:104-158) | newton-raphson.ts applyNodesetsAndICs (TS) | Status |
|---|-------------------|----------------------|--------|
| 224 | (inline in CKTload, after device loads) | `export function applyNodesetsAndICs(solver, nodesets, ics, srcFact, initMode): void` (line 61) — separate function | DIFF |
| 225 | `1e10` literal matches ngspice | `const G_NODESET = 1e10;` (line 68) | MATCH |
| 226 | See section 17 above for line-by-line mapping | (same) | — |

---

## Summary Statistics

| Status | Count |
|--------|-------|
| MATCH | 56 |
| DIFF | 113 |
| MISSING_OURS | 24 |
| MISSING_NGSPICE | 33 |
| **Total lines mapped** | **226** |
