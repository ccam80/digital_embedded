# DCtran vs step() — Line-by-Line Mapping

Scope: ngspice `DCtran()` transient step body (the single-step iteration from the top of the outer time-loop at `dctran.c:715` through the `for(;;)` retry block ending at `dctran.c:973`, plus the post-acceptance tail at `dctran.c:~386-489`) vs. `MNAEngine.step()` in `src/solver/analog/analog-engine.ts` (lines 256-670).

Each executable C source line that participates in a single transient step gets its own row. Multi-line TS equivalents produce multiple rows. C lines inside `#ifdef` blocks not compiled in the default ngspice-43 build (CLUSTER / SHARED_MODULE / XSPICE / WANT_SENSE2 / PREDICTOR variants where noted) are included as individual rows with `MISSING_OURS` or `MATCH_CONDITIONAL` status so the mapping remains exhaustive.

Status legend:
- **MATCH**     — identical operation, operands, order, conditions.
- **DIFF**      — semantically related but differs in operands, order, or guards.
- **MISSING_OURS**   — present in ngspice, absent in our step().
- **MISSING_NGSPICE**— present in our step(), absent in ngspice DCtran.
- **REORDERED** — same operation exists but relocated in control flow.

## 1. Method Signature / Entry

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 1 | `int DCtran(CKTcircuit *ckt, int restart)` (dctran.c:117) | `step(): void` (line 256) | DIFF |
| 2 | `int converged;` declared at function scope (dctran.c:~122) | (no counterpart — convergence reported via `nrResult.converged`) | MISSING_OURS |
| 3 | `double olddelta;` declared at function scope | `let olddelta = dt;` (line 337) | REORDERED |
| 4 | `double newdelta;` declared at function scope | `let newDt = dt;` (line 335) | DIFF |
| 5 | `int firsttime;` declared at function scope | `this._firsttime` (field on MNAEngine) | DIFF |
| 6 | `int save_mode; int save_order;` declared | (no counterpart — no WANT_SENSE2 path) | MISSING_OURS |
| 7 | `int error;` declared | (no counterpart — exceptions used instead of error codes) | MISSING_OURS |
| 8 | `int i;` loop index declared | `let i` declared locally at line 612 loop | REORDERED |
| 9 | `double *temp;` pointer for state rotation | (no counterpart — handled internally by `statePool.rotateStateVectors`) | DIFF |
| 10 | (implicit: `ckt` always valid in C, no guard) | `if (!this._compiled) return;` (line 257) | MISSING_NGSPICE |
| 11 | (implicit) | `if (this._engineState === EngineState.ERROR) return;` (line 258) | MISSING_NGSPICE |

## 2. Pre-loop Setup / Compiled Extraction

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 12 | `ckt->CKTmatrix`, `ckt->CKTrhs` accessed directly as struct fields | `const { elements, matrixSize, nodeCount } = this._compiled;` (line 260) | DIFF |
| 13 | `ckt->CKTcurParams` accessed as `ckt->CKTreltol`, etc. | `const params = this._params;` (line 261) | DIFF |
| 14 | (no counterpart — no convergence logging field) | `const logging = this._convergenceLog.enabled;` (line 262) | MISSING_NGSPICE |
| 15 | (no counterpart — STEPDEBUG `#ifdef` prints only) | `let stepRec: StepRecord | null = null;` (line 263) | MISSING_NGSPICE |
| 16 | (no counterpart — no DEV-build probe) | `if (import.meta.env?.DEV && !this._devProbeRan) {` (line 265) | MISSING_NGSPICE |
| 17 | (no counterpart) | `this._devProbeRan = true;` (line 266) | MISSING_NGSPICE |
| 18 | (no counterpart) | `const statePool = (this._compiled as CompiledWithBridges).statePool ?? null;` (line 267) | MISSING_NGSPICE |
| 19 | (no counterpart) | `if (statePool) {` (line 268) | MISSING_NGSPICE |
| 20 | (no counterpart) | `const solver = this._solver;` (line 269) | MISSING_NGSPICE |
| 21 | (no counterpart) | `const voltages = this._voltages;` (line 270) | MISSING_NGSPICE |
| 22 | (no counterpart) | `const dt = this._timestep.getClampedDt(this._simTime);` (line 271) | MISSING_NGSPICE |
| 23 | (no counterpart) | `const method = this._timestep.currentMethod;` (line 272) | MISSING_NGSPICE |
| 24 | (no counterpart) | `const poolSnapshot = statePool.state0.slice();` (line 273) | MISSING_NGSPICE |
| 25 | (no counterpart — dev probe loop) | `for (const element of this._elements) {` (line 274) | MISSING_NGSPICE |
| 26 | (no counterpart) | `if (isPoolBacked(element)) {` (line 275) | MISSING_NGSPICE |
| 27 | (no counterpart) | `const violations = assertPoolIsSoleMutableState(` (line 276) | MISSING_NGSPICE |
| 28 | (no counterpart) | `element.stateSchema.owner ?? "unknown",` (line 277) | MISSING_NGSPICE |
| 29 | (no counterpart) | `element,` (line 278) | MISSING_NGSPICE |
| 30 | (no counterpart) | `() => { element.stamp(solver); ... },` (lines 279-287) | MISSING_NGSPICE |
| 31 | (no counterpart) | `for (const v of violations) {` (line 289) | MISSING_NGSPICE |
| 32 | (no counterpart) | `const msg = ...` (lines 290-295) | MISSING_NGSPICE |
| 33 | (no counterpart) | `this._diagnostics.emit(makeDiagnostic(...));` (lines 296-302) | MISSING_NGSPICE |
| 34 | (no counterpart) | `statePool.state0.set(poolSnapshot);` (line 306) | MISSING_NGSPICE |
| 35 | (implicit — CKTrhsOld holds previous solution; no explicit `prevVoltages` buffer) | `this._prevVoltages.set(this._voltages);` (line 310) | DIFF |
| 36 | (no counterpart — `ckt->CKTstates` accessed directly) | `const statePool = (this._compiled as CompiledWithBridges).statePool ?? null;` (line 311) | DIFF |
| 37 | `ckt->CKTdelta` set at timepoint computation (dctran.c:~540-602 before loop entry) | `let dt = this._timestep.getClampedDt(this._simTime);` (line 313) | DIFF |
| 38 | `ckt->CKTintegrateMethod` field read throughout | `const method = this._timestep.currentMethod;` (line 314) | DIFF |

## 3. Logging Scaffold (Not in ngspice core)

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 39 | (no counterpart) | `if (logging) {` (line 316) | MISSING_NGSPICE |
| 40 | (no counterpart) | `stepRec = {` (line 317) | MISSING_NGSPICE |
| 41 | (no counterpart) | `stepNumber: this._stepCount,` (line 318) | MISSING_NGSPICE |
| 42 | (no counterpart) | `simTime: this._simTime,` (line 319) | MISSING_NGSPICE |
| 43 | (no counterpart) | `entryDt: dt,` (line 320) | MISSING_NGSPICE |
| 44 | (no counterpart) | `acceptedDt: dt,` (line 321) | MISSING_NGSPICE |
| 45 | (no counterpart) | `entryMethod: method,` (line 322) | MISSING_NGSPICE |
| 46 | (no counterpart) | `exitMethod: method,` (line 323) | MISSING_NGSPICE |
| 47 | (no counterpart) | `attempts: [],` (line 324) | MISSING_NGSPICE |
| 48 | (no counterpart) | `lteWorstRatio: 0,` (line 325) | MISSING_NGSPICE |
| 49 | (no counterpart) | `lteProposedDt: 0,` (line 326) | MISSING_NGSPICE |
| 50 | (no counterpart) | `lteRejected: false,` (line 327) | MISSING_NGSPICE |
| 51 | (no counterpart) | `outcome: "accepted",` (line 328) | MISSING_NGSPICE |
| 52 | (no counterpart) | `};` (line 329) | MISSING_NGSPICE |
| 53 | (no counterpart) | `}` (line 330) | MISSING_NGSPICE |

## 4. Retry-Loop Local State

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 54 | `newdelta` scalar declared at fn scope | `let newDt = dt;` (line 335) | DIFF |
| 55 | (no counterpart — worst-ratio not tracked) | `let worstRatio = 0;` (line 336) | MISSING_NGSPICE |
| 56 | `olddelta = ckt->CKTdelta;` (dctran.c:740 — inside loop) | `let olddelta = dt;` (line 337 — BEFORE loop) | REORDERED |

## 5. DeltaOld Rotation (dctran.c:715-717 — OUTSIDE retry loop)

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 57 | `for(i=5; i>=0; i--)` (dctran.c:715) | `this._timestep.rotateDeltaOld();` (line 340 — delegates) | DIFF |
| 58 | `ckt->CKTdeltaOld[i+1] = ckt->CKTdeltaOld[i];` (dctran.c:716) | (delegated inside `rotateDeltaOld()`) | MATCH |
| 59 | `ckt->CKTdeltaOld[0] = ckt->CKTdelta;` (dctran.c:717) | (NOT done here — performed at line 358 `setDeltaOldCurrent(dt)`) | REORDERED |

## 6. State Vector Rotation (dctran.c:719-723 — OUTSIDE retry loop)

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 60 | `temp = ckt->CKTstates[ckt->CKTmaxOrder+1];` (dctran.c:719) | `if (statePool) {` (line 345) | DIFF |
| 61 | `for(i=ckt->CKTmaxOrder;i>=0;i--) {` (dctran.c:720) | `statePool.rotateStateVectors();` (line 346) | DIFF |
| 62 | `ckt->CKTstates[i+1] = ckt->CKTstates[i];` (dctran.c:721) | (delegated inside `rotateStateVectors()`) | MATCH |
| 63 | `}` (dctran.c:722) | (delegated inside) | MATCH |
| 64 | `ckt->CKTstates[0] = temp;` (dctran.c:723) | (delegated inside — pointer swap recycles oldest) | MATCH |
| 65 | (no counterpart — ngspice binds state pointers at init, re-points on rotate) | `statePool.refreshElementRefs(elements.filter(isPoolBacked) as unknown as PoolBackedAnalogElement[]);` (line 347) | MISSING_NGSPICE |
| 66 | (no counterpart) | `}` (line 348) | MISSING_NGSPICE |

## 7. Phase Tracking Scaffold (Not in ngspice core)

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 67 | (no counterpart) | `let _stepAttemptCount = 0;` (line 352) | MISSING_NGSPICE |
| 68 | `firsttime` read at multiple points; no captured copy | `const wasFirsttime = this._firsttime;` (line 354) | MISSING_NGSPICE |

## 8. `for(;;)` Retry Loop Entry (dctran.c:725-726)

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 69 | `/* 600 */` label comment (dctran.c:725) | (no counterpart — no goto) | MISSING_OURS |
| 70 | `for (;;) {` (dctran.c:726) | `for (;;) {` (line 356) | MATCH |
| 71 | `#if defined CLUSTER || defined SHARED_MODULE` (dctran.c:727) | (not compiled — not applicable) | MISSING_OURS |
| 72 | `redostep = 1;` (dctran.c:728) | (not applicable) | MISSING_OURS |
| 73 | `#endif` (dctran.c:729) | (not applicable) | MISSING_OURS |
| 74 | `#ifdef XSPICE ... ckt->CKTcurrentAnalysis = DOING_TRAN;` (dctran.c:730-739) | (no XSPICE) | MISSING_OURS |

## 9. Top of Retry Iteration (dctran.c:740-748)

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 75 | `olddelta = ckt->CKTdelta;` (dctran.c:740) | (HOISTED to line 337 outside loop; UPDATED at line 583 at end-of-iteration) | REORDERED |
| 76 | `ckt->CKTsimTimeStart = ckt->CKTtime;` (dctran.c:743) | (no counterpart — simTime mutated directly) | MISSING_OURS |
| 77 | `ckt->CKTtime += ckt->CKTdelta;` (dctran.c:744) | `this._simTime += dt;` (line 361) | MATCH |
| 78 | `#ifdef CLUSTER CLUinput(ckt);` (dctran.c:745-747) | (not applicable) | MISSING_OURS |
| 79 | `ckt->CKTdeltaOld[0]=ckt->CKTdelta;` (dctran.c:748) | `this._timestep.setDeltaOldCurrent(dt);` (line 358) | REORDERED |

## 10. Advance Time Publishing (ours only)

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 80 | (time-varying sources read `ckt->CKTtime` directly — no publish) | `const cac = this._compiled as CompiledWithBridges | undefined;` (line 366) | MISSING_NGSPICE |
| 81 | (no counterpart) | `if (cac?.timeRef) cac.timeRef.value = this._simTime;` (line 367) | MISSING_NGSPICE |

## 11. Predictor Gating (dctran.c:750-752 — PREDICTOR macro)

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 82 | `#ifdef PREDICTOR` (dctran.c:750) | `if (this._stepCount > 0 && (this._params.predictor ?? false)) {` (line 376) | DIFF |
| 83 | `error = NIpred(ckt);` (dctran.c:751) | `computeAgp(this._timestep.currentMethod, this._timestep.currentOrder, dt, this._timestep.deltaOld, this._agp);` (lines 377-378) | DIFF |
| 84 | (inside NIpred — extrapolation) | `predictVoltages(this._nodeVoltageHistory, this._timestep.deltaOld, this._timestep.currentOrder, this._timestep.currentMethod, this._agp, this._voltages);` (lines 379-381) | MATCH |
| 85 | `#endif /* PREDICTOR */` (dctran.c:752) | `}` (line 382) | MATCH |

## 12. save_mode/save_order (dctran.c:753-754)

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 86 | `save_mode = ckt->CKTmode;` (dctran.c:753) | (no counterpart — only used in WANT_SENSE2) | MISSING_OURS |
| 87 | `save_order = ckt->CKTorder;` (dctran.c:754) | (no counterpart — only used in WANT_SENSE2) | MISSING_OURS |

## 13. Phase Hook onAttemptBegin (ours only)

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 88 | (no counterpart) | `if (this.stepPhaseHook) {` (line 385) | MISSING_NGSPICE |
| 89 | (no counterpart) | `let attemptPhase: "tranInit" | "tranNR" | "tranNrRetry" | "tranLteRetry";` (line 386) | MISSING_NGSPICE |
| 90 | (no counterpart) | `if (this._stepCount === 0 && _stepAttemptCount === 0) {` (line 387) | MISSING_NGSPICE |
| 91 | (no counterpart) | `attemptPhase = "tranInit";` (line 388) | MISSING_NGSPICE |
| 92 | (no counterpart) | `} else if (_stepAttemptCount === 0) {` (line 389) | MISSING_NGSPICE |
| 93 | (no counterpart) | `attemptPhase = "tranNR";` (line 390) | MISSING_NGSPICE |
| 94 | (no counterpart) | `} else {` (line 391) | MISSING_NGSPICE |
| 95 | (no counterpart) | `attemptPhase = "tranNrRetry";` (line 394) | MISSING_NGSPICE |
| 96 | (no counterpart) | `}` (line 395) | MISSING_NGSPICE |
| 97 | (no counterpart) | `this.stepPhaseHook.onAttemptBegin(attemptPhase, dt);` (line 396) | MISSING_NGSPICE |
| 98 | (no counterpart) | `}` (line 397) | MISSING_NGSPICE |
| 99 | (no counterpart) | `_stepAttemptCount++;` (line 398) | MISSING_NGSPICE |

## 14. XSPICE Breakpoint Scaffold (dctran.c:755-781)

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 100 | `#ifdef XSPICE` (dctran.c:755) | (not applicable) | MISSING_OURS |
| 101 | `g_mif_info.breakpoint.current = 1.0e30;` (dctran.c:759) | (no counterpart) | MISSING_OURS |
| 102 | `if(ckt->CKTdelta <= ckt->CKTdelmin)` (dctran.c:766) | (no counterpart) | MISSING_OURS |
| 103 | `ckt->enh->conv_debug.last_NIiter_call = MIF_TRUE;` (dctran.c:767) | (no counterpart) | MISSING_OURS |
| 104 | `else ckt->enh->conv_debug.last_NIiter_call = MIF_FALSE;` (dctran.c:768-769) | (no counterpart) | MISSING_OURS |
| 105 | `if(ckt->evt->counts.num_insts > 0) { g_mif_info.circuit.evt_step = ckt->CKTtime; }` (dctran.c:777-779) | (no counterpart) | MISSING_OURS |
| 106 | `#endif` (dctran.c:781) | (not applicable) | MISSING_OURS |

## 15. NIcomCof (dctran.c:749)

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 107 | (no counterpart — ngspice binds dt via CKTag[]/CKTdelta only) | `if (statePool) {` (line 410) | MISSING_NGSPICE |
| 108 | (no counterpart — pool infra) | `statePool.dt = dt;` (line 411) | MISSING_NGSPICE |
| 109 | `NIcomCof(ckt);` (dctran.c:749) | `computeNIcomCof(dt, this._timestep.deltaOld, this._timestep.currentOrder, this._timestep.currentMethod, statePool.ag);` (lines 412-413) | MATCH |
| 110 | (implicit — ngspice checks `ckt->CKTmode & MODEINITTRAN` inside devices) | `if (this._firsttime) {` (line 414) | DIFF |
| 111 | `ckt->CKTmode = MODETRAN | MODEINITTRAN` set during tran_set_initial_mode | `statePool.initMode = "initTran";` (line 415) | DIFF |
| 112 | (implicit) | `}` (line 416) | DIFF |
| 113 | (implicit) | `}` (line 417) | DIFF |

## 16. Companion Stamp Loop (ours; ngspice folds into CKTload)

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 114 | (handled inside CKTload per-device NIintegrate calls) | `for (const el of elements) {` (line 418) | DIFF |
| 115 | (handled inside CAPload/INDload/etc. via NIintegrate) | `if (el.isReactive && el.stampCompanion) {` (line 419) | DIFF |
| 116 | (stamp done inside device load) | `el.stampCompanion(dt, this._timestep.currentMethod, this._voltages, this._timestep.currentOrder, this._timestep.deltaOld);` (line 420) | DIFF |
| 117 | (end of device iteration) | `}` (line 421) | DIFF |
| 118 | (end) | `}` (line 422) | DIFF |

## 17. NIiter Call (dctran.c:783)

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 119 | `converged = NIiter(ckt,ckt->CKTtranMaxIter);` (dctran.c:783) | `const nrResult = newtonRaphson({` (line 425) | DIFF |
| 120 | `ckt->CKTmatrix` member passed implicitly via ckt | `solver: this._solver,` (line 426) | DIFF |
| 121 | device list traversed via DEVices[] inside NIiter | `elements,` (line 427) | DIFF |
| 122 | `ckt->CKTmatSize` implicit via ckt | `matrixSize,` (line 428) | DIFF |
| 123 | `ckt->CKTnumNodes` implicit | `nodeCount,` (line 429) | DIFF |
| 124 | `ckt->CKTtranMaxIter` 2nd arg of NIiter | `maxIterations: params.transientMaxIterations,` (line 430) | MATCH |
| 125 | `ckt->CKTreltol` read inside NIconvTest | `reltol: params.reltol,` (line 431) | MATCH |
| 126 | `ckt->CKTvoltTol` read inside NIconvTest | `abstol: params.voltTol,` (line 432) | MATCH |
| 127 | `ckt->CKTabstol` read inside NIconvTest | `iabstol: params.abstol,` (line 433) | MATCH |
| 128 | `CKTrhsOld` used as initial guess | `initialGuess: this._voltages,` (line 434) | MATCH |
| 129 | (no counterpart — errMsg fprintf to stderr) | `diagnostics: this._diagnostics,` (line 435) | MISSING_NGSPICE |
| 130 | `CKTrhs` buffer | `voltagesBuffer: this._nrVoltages,` (line 436) | MATCH |
| 131 | `CKTrhsOld` buffer | `prevVoltagesBuffer: this._nrPrevVoltages,` (line 437) | MATCH |
| 132 | (no counterpart — blame via `CKTtroubleNode`) | `enableBlameTracking: logging,` (line 438) | MISSING_NGSPICE |
| 133 | (no counterpart) | `postIterationHook: this.postIterationHook ?? undefined,` (line 439) | MISSING_NGSPICE |
| 134 | (no counterpart) | `detailedConvergence: this.detailedConvergence,` (line 440) | MISSING_NGSPICE |
| 135 | (no counterpart) | `limitingCollector: this.limitingCollector,` (line 441) | MISSING_NGSPICE |
| 136 | (no counterpart) | `statePool: statePool ?? null,` (line 442) | MISSING_NGSPICE |
| 137 | (ngspice re-stamps companion implicitly via CKTload each iter) | `preIterationHook: (_iteration, iterVoltages) => {` (line 443) | DIFF |
| 138 | (ngspice iterates CKTintegrateMethod via CKTag) | `const currentMethod = this._timestep.currentMethod;` (line 444) | DIFF |
| 139 | (per-device NIintegrate inside CKTload) | `for (const el of elements) {` (line 445) | DIFF |
| 140 | (per-device) | `if (el.isReactive && el.isNonlinear && el.stampCompanion) {` (line 446) | DIFF |
| 141 | (per-device) | `el.stampCompanion(dt, currentMethod, iterVoltages, this._timestep.currentOrder, this._timestep.deltaOld);` (line 447) | DIFF |
| 142 | (per-device end) | `}` (line 448) | DIFF |
| 143 | (per-device end) | `}` (line 449) | DIFF |
| 144 | (end of hook) | `},` (line 450) | DIFF |
| 145 | (end of call) | `});` (line 451) | DIFF |

## 18. XSPICE Hybrid Call (dctran.c:785-792)

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 146 | `#ifdef XSPICE` (dctran.c:785) | (not applicable) | MISSING_OURS |
| 147 | `if(ckt->evt->counts.num_insts > 0) {` (dctran.c:786) | (no counterpart) | MISSING_OURS |
| 148 | `g_mif_info.circuit.evt_step = ckt->CKTtime;` (dctran.c:787) | (no counterpart) | MISSING_OURS |
| 149 | `EVTcall_hybrids(ckt);` (dctran.c:788) | (no counterpart) | MISSING_OURS |
| 150 | `}` (dctran.c:789) | (not applicable) | MISSING_OURS |
| 151 | `#endif` (dctran.c:792) | (not applicable) | MISSING_OURS |

## 19. Post-NIiter Bookkeeping (dctran.c:793-804)

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 152 | `ckt->CKTstat->STATtimePts ++;` (dctran.c:793) | (no counterpart — no stat counters) | MISSING_OURS |
| 153 | `ckt->CKTmode = (ckt->CKTmode&MODEUIC)|MODETRAN | MODEINITPRED;` (dctran.c:794) | `if (statePool) {` (line 453) | DIFF |
| 154 | (same assignment sets MODEINITPRED unconditionally) | `statePool.initMode = "initPred";` (line 454) | DIFF |
| 155 | (same) | `}` (line 455) | DIFF |
| 156 | `if(firsttime) {` (dctran.c:795) | `if (this._firsttime && statePool) {` (line 462) | DIFF |
| 157 | `for(i=0;i<ckt->CKTnumStates;i++) {` (dctran.c:796) | `statePool.states[1].set(statePool.states[0]);` (line 463) | DIFF |
| 158 | `ckt->CKTstate2[i] = ckt->CKTstate1[i];` (dctran.c:797) | (delegated) | DIFF |
| 159 | `ckt->CKTstate3[i] = ckt->CKTstate1[i];` (dctran.c:798) | `statePool.seedFromState1();` (line 464) | DIFF |
| 160 | `}` (dctran.c:799) | (delegated) | MATCH |
| 161 | `}` (dctran.c:800) | `}` (line 465) | MATCH |
| 162 | `/* txl, cpl addition */` (dctran.c:801) | (no counterpart — no lossy-transmission-line extension) | MISSING_OURS |
| 163 | `if (converged == 1111) {` (dctran.c:802) | (no counterpart) | MISSING_OURS |
| 164 | `return(converged);` (dctran.c:803) | (no counterpart) | MISSING_OURS |
| 165 | `}` (dctran.c:804) | (no counterpart) | MISSING_OURS |

## 20. Logging Per-Attempt (ours only)

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 166 | (no counterpart) | `if (logging) {` (line 468) | MISSING_NGSPICE |
| 167 | (no counterpart) | `stepRec!.attempts.push({` (line 469) | MISSING_NGSPICE |
| 168 | (no counterpart) | `dt,` (line 470) | MISSING_NGSPICE |
| 169 | (no counterpart) | `method: this._timestep.currentMethod,` (line 471) | MISSING_NGSPICE |
| 170 | (no counterpart) | `iterations: nrResult.iterations,` (line 472) | MISSING_NGSPICE |
| 171 | (no counterpart) | `converged: nrResult.converged,` (line 473) | MISSING_NGSPICE |
| 172 | (no counterpart) | `blameElement: nrResult.largestChangeElement,` (line 474) | MISSING_NGSPICE |
| 173 | (no counterpart) | `blameNode: nrResult.largestChangeNode,` (line 475) | MISSING_NGSPICE |
| 174 | (no counterpart) | `trigger: stepRec!.attempts.length === 0 ? "initial" : "nr-retry",` (line 476) | MISSING_NGSPICE |
| 175 | (no counterpart) | `});` (line 477) | MISSING_NGSPICE |
| 176 | (no counterpart) | `if (this._convergenceLog.enabled) {` (line 478) | MISSING_NGSPICE |
| 177 | (no counterpart) | `const drainable = this.postIterationHook as unknown as { drainForLog?: () => NRAttemptRecord["iterationDetails"] };` (line 479) | MISSING_NGSPICE |
| 178 | (no counterpart) | `if (typeof drainable?.drainForLog === "function") {` (line 480) | MISSING_NGSPICE |
| 179 | (no counterpart) | `stepRec!.attempts[stepRec!.attempts.length - 1].iterationDetails = drainable.drainForLog();` (line 481) | MISSING_NGSPICE |
| 180 | (no counterpart) | `}` (line 482) | MISSING_NGSPICE |
| 181 | (no counterpart) | `}` (line 483) | MISSING_NGSPICE |
| 182 | (no counterpart) | `}` (line 484) | MISSING_NGSPICE |

## 21. NR Failed Branch (dctran.c:806-828)

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 183 | `if(converged != 0) {` (dctran.c:806) | `if (!nrResult.converged) {` (line 486) | MATCH |
| 184 | `#ifndef CLUSTER #ifndef SHARED_MODULE` (dctran.c:807-808) | (not applicable) | MISSING_OURS |
| 185 | (no counterpart — phase hook is ours) | `this.stepPhaseHook?.onAttemptEnd("nrFailedRetry", false);` (line 488) | MISSING_NGSPICE |
| 186 | `ckt->CKTtime = ckt->CKTtime -ckt->CKTdelta;` (dctran.c:809) | `this._simTime -= dt;` (line 489) | MATCH |
| 187 | `ckt->CKTstat->STATrejected ++;` (dctran.c:810) | (no counterpart — no stat counter) | MISSING_OURS |
| 188 | `#else redostep = 1; #endif #endif` (dctran.c:811-814) | (not applicable) | MISSING_OURS |
| 189 | (implicit — CKTrhsOld still holds previous solution) | `this._voltages.set(this._prevVoltages);` (line 490) | MISSING_NGSPICE |
| 190 | `ckt->CKTdelta = ckt->CKTdelta/8;` (dctran.c:815) | `dt = dt / 8;` (line 491) | MATCH |
| 191 | `#ifdef STEPDEBUG (void)printf(...);` (dctran.c:816-819) | (no counterpart) | MISSING_OURS |
| 192 | (implicit in ckt->CKTdelta update) | `this._timestep.currentDt = dt;` (line 492) | MISSING_NGSPICE |
| 193 | `if(firsttime) {` (dctran.c:820) | (folded into line 494) | REORDERED |
| 194 | `ckt->CKTmode = (ckt->CKTmode&MODEUIC) | MODETRAN | MODEINITTRAN;` (dctran.c:821) | `if (this._firsttime && statePool) { statePool.initMode = "initTran"; }` (lines 494-496) | DIFF |
| 195 | `}` (dctran.c:822) | (end of conditional) | MATCH |
| 196 | `ckt->CKTorder = 1;` (dctran.c:823) | `this._timestep.currentOrder = 1;` (line 493) | MATCH |
| 197 | `/* Outer-loop instrumentation: NR failed */` (dctran.c:824) | (comment) | MATCH |
| 198 | `ni_fire_outer_cb(ckt->CKTsimTimeStart, olddelta, ...);` (dctran.c:825-828) | (no separate outer-cb — collapsed into `stepPhaseHook.onAttemptEnd`) | DIFF |

## 22. XSPICE Breakpoint Backup (dctran.c:830-846 — `else if`)

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 199 | `#ifdef XSPICE` (dctran.c:830) | (not applicable) | MISSING_OURS |
| 200 | `} else if(g_mif_info.breakpoint.current < ckt->CKTtime) {` (dctran.c:834) | (no counterpart) | MISSING_OURS |
| 201 | `ckt->CKTsaveDelta = ckt->CKTdelta;` (dctran.c:835) | (no counterpart) | MISSING_OURS |
| 202 | `ckt->CKTtime -= ckt->CKTdelta;` (dctran.c:836) | (no counterpart) | MISSING_OURS |
| 203 | `ckt->CKTdelta = g_mif_info.breakpoint.current - ckt->CKTtime;` (dctran.c:837) | (no counterpart) | MISSING_OURS |
| 204 | `g_mif_info.breakpoint.last = ckt->CKTtime + ckt->CKTdelta;` (dctran.c:838) | (no counterpart) | MISSING_OURS |
| 205 | `if(firsttime) { ckt->CKTmode = ... | MODEINITTRAN; }` (dctran.c:840-842) | (no counterpart) | MISSING_OURS |
| 206 | `ckt->CKTorder = 1;` (dctran.c:843) | (no counterpart) | MISSING_OURS |
| 207 | `#endif` (dctran.c:846) | (not applicable) | MISSING_OURS |

## 23. NR Converged `else` Branch (dctran.c:848)

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 208 | `} else {` (dctran.c:848) | `} else {` (line 498) | MATCH |
| 209 | (implicit — ckt->CKTdelta already equals delta just used) | `this._timestep.currentDt = dt;` (line 500) | MISSING_NGSPICE |
| 210 | (ngspice leaves CKTrhsOld unchanged; NIiter already swapped) | `this._voltages.set(nrResult.voltages);` (line 501) | DIFF |

## 24. updateChargeFlux Loop (ours; ngspice folds into device load)

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 211 | (handled inside each DEVload after NIintegrate) | `for (const el of elements) {` (line 506) | DIFF |
| 212 | (per-device) | `if (el.isReactive && el.updateChargeFlux) {` (line 507) | DIFF |
| 213 | (per-device) | `el.updateChargeFlux(this._voltages, dt, this._timestep.currentMethod, this._timestep.currentOrder, this._timestep.deltaOld);` (line 508) | DIFF |
| 214 | (per-device end) | `}` (line 509) | DIFF |
| 215 | (per-device end) | `}` (line 510) | DIFF |

## 25. firsttime Block — WANT_SENSE2 + Skip LTE (dctran.c:849-873)

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 216 | `if (firsttime) {` (dctran.c:849) | `if (this._firsttime) {` (line 513) | MATCH |
| 217 | `#ifdef WANT_SENSE2` (dctran.c:850) | (not applicable) | MISSING_OURS |
| 218 | `if(ckt->CKTsenInfo && ...) {` (dctran.c:851) | (no counterpart) | MISSING_OURS |
| 219 | `save1 = ckt->CKTmode;` (dctran.c:852) | (no counterpart) | MISSING_OURS |
| 220 | `save2 = ckt->CKTorder;` (dctran.c:853) | (no counterpart) | MISSING_OURS |
| 221 | `ckt->CKTmode = save_mode;` (dctran.c:854) | (no counterpart) | MISSING_OURS |
| 222 | `ckt->CKTorder = save_order;` (dctran.c:855) | (no counterpart) | MISSING_OURS |
| 223 | `error = CKTsenDCtran (ckt);` (dctran.c:856) | (no counterpart) | MISSING_OURS |
| 224 | `if (error) return(error);` (dctran.c:857-858) | (no counterpart) | MISSING_OURS |
| 225 | `ckt->CKTmode = save1;` (dctran.c:860) | (no counterpart) | MISSING_OURS |
| 226 | `ckt->CKTorder = save2;` (dctran.c:861) | (no counterpart) | MISSING_OURS |
| 227 | `}` (dctran.c:862) | (not applicable) | MISSING_OURS |
| 228 | `#endif` (dctran.c:863) | (not applicable) | MISSING_OURS |
| 229 | `firsttime = 0;` (dctran.c:864) | `this._firsttime = false;` (line 514) | MATCH |
| 230 | (no counterpart — phase hook is ours) | `this.stepPhaseHook?.onAttemptEnd("accepted", true);` (line 515) | MISSING_NGSPICE |
| 231 | (implicit — delta unchanged) | `newDt = dt;` (line 516) | MISSING_NGSPICE |
| 232 | (no counterpart — no ratio) | `worstRatio = 0;` (line 517) | MISSING_NGSPICE |
| 233 | `#if !defined CLUSTER && !defined SHARED_MODULE` (dctran.c:865) | (not applicable) | MISSING_OURS |
| 234 | `goto nextTime;` (dctran.c:866) | `break;` (line 518 — loop exit to acceptance block) | DIFF |
| 235 | `#else redostep = 0; goto chkStep;` (dctran.c:869-871) | (not applicable) | MISSING_OURS |
| 236 | `#endif` (dctran.c:872) | (not applicable) | MISSING_OURS |
| 237 | `}` (dctran.c:873 — end firsttime block) | `}` (line 519) | MATCH |

## 26. LTE Check (dctran.c:874-879)

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 238 | `newdelta = ckt->CKTdelta;` (dctran.c:874) | (folded into computeNewDt — dt passed as arg) | REORDERED |
| 239 | `error = CKTtrunc(ckt,&newdelta);` (dctran.c:875) | `const lte = this._timestep.computeNewDt(` (line 521) | DIFF |
| 240 | (elements iterated inside CKTtrunc) | `elements, this._history, this._simTime, dt,` (line 522) | DIFF |
| 241 | (end of CKTtrunc call) | `);` (line 523) | DIFF |
| 242 | `if(error) {` (dctran.c:876) | (no counterpart — LteResult has no error) | MISSING_OURS |
| 243 | `UPDATE_STATS(DOING_TRAN);` (dctran.c:877) | (no counterpart) | MISSING_OURS |
| 244 | `return(error);` (dctran.c:878) | (no counterpart) | MISSING_OURS |
| 245 | `}` (dctran.c:879) | (no counterpart) | MISSING_OURS |
| 246 | (implicit via newdelta scalar) | `newDt = lte.newDt;` (line 524) | MATCH |
| 247 | (no counterpart — ngspice does not expose ratio) | `worstRatio = lte.worstRatio;` (line 525) | MISSING_NGSPICE |

## 27. LTE Logging (ours)

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 248 | (no counterpart) | `if (logging) {` (line 527) | MISSING_NGSPICE |
| 249 | (no counterpart) | `stepRec!.lteWorstRatio = worstRatio;` (line 528) | MISSING_NGSPICE |
| 250 | (no counterpart) | `stepRec!.lteProposedDt = newDt;` (line 529) | MISSING_NGSPICE |
| 251 | (no counterpart) | `}` (line 530) | MISSING_NGSPICE |

## 28. LTE Accept Path — Order Promotion Test (dctran.c:880-894)

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 252 | `if(newdelta > .9 * ckt->CKTdelta) {` (dctran.c:880) | (INVERTED — ngspice wraps order-promotion AND accept inside this branch; we test promotion then separately test `shouldReject`) | DIFF |
| 253 | `if((ckt->CKTorder == 1) && (ckt->CKTmaxOrder > 1)) {` (dctran.c:881) | `if (this._timestep.currentOrder === 1 && newDt > 0.9 * dt) {` (line 535) | DIFF |
| 254 | `newdelta = ckt->CKTdelta;` (dctran.c:882) | (inside tryOrderPromotion) | DIFF |
| 255 | `ckt->CKTorder = 2;` (dctran.c:883) | (inside tryOrderPromotion) | DIFF |
| 256 | `error = CKTtrunc(ckt,&newdelta);` (dctran.c:884) | `this._timestep.tryOrderPromotion(elements, this._history, this._simTime, dt);` (line 536) | DIFF |
| 257 | `if(error) { ... return(error); }` (dctran.c:885-888) | (no error path) | MISSING_OURS |
| 258 | `if(newdelta <= 1.05 * ckt->CKTdelta) {` (dctran.c:889) | (inside tryOrderPromotion) | DIFF |
| 259 | `ckt->CKTorder = 1;` (dctran.c:890) | (inside tryOrderPromotion) | DIFF |
| 260 | `}` (dctran.c:891) | (inside tryOrderPromotion) | DIFF |
| 261 | `}` (dctran.c:892 — end order==1 block) | `}` (line 537) | MATCH |

## 29. LTE Accept — Accept Step (dctran.c:893-934)

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 262 | `/* time point OK  - 630 */` (dctran.c:893) | (comment) | MATCH |
| 263 | `ckt->CKTdelta = newdelta;` (dctran.c:894) | (done later at line 624 `this._timestep.currentDt = newDt;` after loop exit) | REORDERED |
| 264 | `#ifdef NDEV ... progress indicator printf` (dctran.c:895-904) | (no counterpart) | MISSING_OURS |
| 265 | `#ifdef STEPDEBUG (void)printf(...);` (dctran.c:906-911) | (no counterpart) | MISSING_OURS |
| 266 | `#ifdef WANT_SENSE2 ... CKTsenDCtran` (dctran.c:913-926) | (not applicable) | MISSING_OURS |
| 267 | (accept branch condition is inverted in ngspice — uses `newdelta > 0.9*dt`) | `if (!this._timestep.shouldReject(worstRatio)) {` (line 539) | DIFF |
| 268 | (no counterpart — phase hook is ours) | `this.stepPhaseHook?.onAttemptEnd("accepted", true);` (line 541) | MISSING_NGSPICE |
| 269 | `#if !defined CLUSTER && !defined SHARED_MODULE` (dctran.c:928) | (not applicable) | MISSING_OURS |
| 270 | `/* go to 650 - trapezoidal */` (dctran.c:929) | (comment) | MATCH |
| 271 | `goto nextTime;` (dctran.c:930) | `break;` (line 542) | DIFF |
| 272 | `#else redostep = 0; goto chkStep; #endif` (dctran.c:931-934) | (not applicable) | MISSING_OURS |

## 30. LTE Reject Path (dctran.c:935-955)

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 273 | `} else {` (dctran.c:935 — LTE rejected) | (in our code the reject path is after `break;` at line 542 but before the delmin check, unguarded by else) | DIFF |
| 274 | (no counterpart — phase hook is ours) | `this.stepPhaseHook?.onAttemptEnd("lteRejectedRetry", true);` (line 546) | MISSING_NGSPICE |
| 275 | `#ifndef CLUSTER #ifndef SHARED_MODULE` (dctran.c:936-937) | (not applicable) | MISSING_OURS |
| 276 | `ckt->CKTtime = ckt->CKTtime -ckt->CKTdelta;` (dctran.c:938) | `this._simTime -= dt;` (line 547) | MATCH |
| 277 | `ckt->CKTstat->STATrejected ++;` (dctran.c:939) | (no counterpart — no stat counter) | MISSING_OURS |
| 278 | `#else redostep = 1; #endif #endif` (dctran.c:940-943) | (not applicable) | MISSING_OURS |
| 279 | (no counterpart — logging is ours) | `if (logging) stepRec!.lteRejected = true;` (line 548) | MISSING_NGSPICE |
| 280 | (implicit — ngspice does not restore voltages; CKTrhsOld holds prev) | `this._voltages.set(this._prevVoltages);` (line 550) | MISSING_NGSPICE |
| 281 | `ckt->CKTdelta = newdelta;` (dctran.c:944) | `dt = newDt;` (line 551) | MATCH |
| 282 | `#ifdef STEPDEBUG (void)printf(...);` (dctran.c:945-948) | (no counterpart) | MISSING_OURS |
| 283 | (no counterpart — only ours has explicit currentDt mirror) | `this._timestep.currentDt = dt;` (line 552) | MISSING_NGSPICE |
| 284 | `/* Outer-loop instrumentation: LTE rejected */` (dctran.c:949) | (comment) | MATCH |
| 285 | `ni_fire_outer_cb(ckt->CKTsimTimeStart, olddelta, /*lteRejected=*/1, ...);` (dctran.c:950-953) | (collapsed into onAttemptEnd above at line 546) | REORDERED |
| 286 | `}` (dctran.c:954 — end LTE reject) | (end of else branch) | MATCH |
| 287 | `}` (dctran.c:955 — end `else` of converged check) | `}` (line 554) | MATCH |

## 31. delmin Check (dctran.c:957-973)

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 288 | `if (ckt->CKTdelta <= ckt->CKTdelmin) {` (dctran.c:957) | `if (dt <= params.minTimeStep) {` (line 557) | MATCH |
| 289 | `if (olddelta > ckt->CKTdelmin) {` (dctran.c:958) | `if (olddelta > params.minTimeStep) {` (line 558) | MATCH |
| 290 | `ckt->CKTdelta = ckt->CKTdelmin;` (dctran.c:959) | `dt = params.minTimeStep;` (line 560) | MATCH |
| 291 | `#ifdef STEPDEBUG (void)printf("delta at delmin\n");` (dctran.c:960-962) | (no counterpart) | MISSING_OURS |
| 292 | (implicit) | `this._timestep.currentDt = dt;` (line 561) | MISSING_NGSPICE |
| 293 | `} else {` (dctran.c:963 — second strike) | `} else {` (line 562) | MATCH |
| 294 | `/* Outer-loop instrumentation: final failure */` (dctran.c:964) | (comment) | MATCH |
| 295 | (no counterpart — phase hook is ours) | `this.stepPhaseHook?.onAttemptEnd("finalFailure", false);` (line 564) | MISSING_NGSPICE |
| 296 | `ni_fire_outer_cb(ckt->CKTsimTimeStart, olddelta, /*finalFailure=*/1, ...);` (dctran.c:965-968) | (collapsed into onAttemptEnd above) | REORDERED |
| 297 | `UPDATE_STATS(DOING_TRAN);` (dctran.c:969) | (no counterpart) | MISSING_OURS |
| 298 | `errMsg = CKTtrouble(ckt, "Timestep too small");` (dctran.c:970) | `this._diagnostics.emit(makeDiagnostic("convergence-failed", "error", "Timestep too small", {` (lines 565-567) | DIFF |
| 299 | (inside CKTtrouble — sprintf to static buffer) | ``explanation: `Newton-Raphson failed after timestep reduced to minimum (${params.minTimeStep}s).`,`` (line 568) | DIFF |
| 300 | (inside CKTtrouble) | `involvedElements: [],` (line 569) | DIFF |
| 301 | (inside CKTtrouble) | `simTime: this._simTime,` (line 570) | DIFF |
| 302 | (inside CKTtrouble) | `}),` (line 571) | DIFF |
| 303 | (end CKTtrouble) | `);` (line 572) | DIFF |
| 304 | (no counterpart — ngspice exits directly) | `if (logging) {` (line 573) | MISSING_NGSPICE |
| 305 | (no counterpart) | `stepRec!.outcome = "error";` (line 574) | MISSING_NGSPICE |
| 306 | (no counterpart) | `stepRec!.acceptedDt = dt;` (line 575) | MISSING_NGSPICE |
| 307 | (no counterpart) | `stepRec!.exitMethod = this._timestep.currentMethod;` (line 576) | MISSING_NGSPICE |
| 308 | (no counterpart) | `this._convergenceLog.record(stepRec!);` (line 577) | MISSING_NGSPICE |
| 309 | (no counterpart) | `}` (line 578) | MISSING_NGSPICE |
| 310 | (no counterpart — ngspice returns from function) | `this._transitionState(EngineState.ERROR);` (line 579) | MISSING_NGSPICE |
| 311 | `return(E_TIMESTEP);` (dctran.c:971) | `return;` (line 580) | DIFF |
| 312 | `}` (dctran.c:972 — end else of olddelta) | `}` (line 581) | MATCH |
| 313 | `}` (dctran.c:973 — end delmin block) | `}` (line 582) | MATCH |

## 32. olddelta Update (ours only — two-strike tracker)

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 314 | `olddelta = ckt->CKTdelta;` is updated at dctran.c:740 (TOP of next iteration, AFTER delmin clamp) | `olddelta = dt;` (line 583 — END of iteration, AFTER delmin clamp) | REORDERED |

## 33. XSPICE/CLUSTER Post-delmin Scaffold (dctran.c:974-999)

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 315 | `#ifdef XSPICE` (dctran.c:974) | (not applicable) | MISSING_OURS |
| 316 | `if(ckt->evt->counts.num_insts > 0) EVTbackup(...);` (dctran.c:977-978) | (no counterpart) | MISSING_OURS |
| 317 | `#endif` (dctran.c:981) | (not applicable) | MISSING_OURS |
| 318 | `#ifdef CLUSTER chkStep: if(CLUsync(...)) goto nextTime; else { ckt->CKTtime -= olddelta; STATrejected++; } #endif` (dctran.c:982-990) | (not applicable) | MISSING_OURS |
| 319 | `#ifdef SHARED_MODULE sharedsync(...); #endif` (dctran.c:992+) | (not applicable) | MISSING_OURS |

## 34. End of for(;;) Loop

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 320 | `}` end of `for(;;)` (dctran.c end of retry block) | `}` (line 584 — end retry loop) | MATCH |

## 35. nextTime Label / Acceptance Block (dctran.c:~386-489)

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 321 | `nextTime:` label (dctran.c:~386) | (comment `---- End single retry loop ----` at line 585; `break;` targets this point) | DIFF |
| 322 | (no direct counterpart — ngspice bumps states via rotation, not a tranStep counter) | `if (statePool) {` (line 588) | MISSING_NGSPICE |
| 323 | (no counterpart) | `statePool.tranStep++;` (line 589) | MISSING_NGSPICE |
| 324 | (no counterpart) | `}` (line 590) | MISSING_NGSPICE |

## 36. CKTsols Rotation (dctran.c inside CKTaccept, PREDICTOR path)

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 325 | `for(i=7;i>0;i--) CKTsols[i]=CKTsols[i-1];` (cktaccept.c PREDICTOR ring) | `this._nodeVoltageHistory.rotateNodeVoltages(this._voltages);` (line 595 — delegated) | DIFF |
| 326 | `CKTsols[0] = CKTrhs;` (cktaccept.c) | (delegated — pushes `_voltages` as newest) | MATCH |

## 37. Accepted-Attempt Logging (ours)

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 327 | (no counterpart) | `if (logging) {` (line 597) | MISSING_NGSPICE |
| 328 | (no counterpart) | `stepRec!.acceptedDt = dt;` (line 598) | MISSING_NGSPICE |
| 329 | (no counterpart) | `stepRec!.exitMethod = this._timestep.currentMethod;` (line 599) | MISSING_NGSPICE |
| 330 | (no counterpart) | `this._convergenceLog.record(stepRec!);` (line 600) | MISSING_NGSPICE |
| 331 | (no counterpart) | `}` (line 601) | MISSING_NGSPICE |

## 38. timeRef Republish (ours only)

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 332 | (implicit via CKTtime) | `const cac = this._compiled as CompiledWithBridges | undefined;` (line 603) | MISSING_NGSPICE |
| 333 | (implicit) | `if (cac?.timeRef) cac.timeRef.value = this._simTime;` (line 604) | MISSING_NGSPICE |
| 334 | (no counterpart — no separate lastDt field) | `this._lastDt = dt;` (line 605) | MISSING_NGSPICE |

## 39. BDF-2 Method-Switching History Push (ours only)

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 335 | (no counterpart — ngspice tracks only charge history per reactive element) | `for (let i = 0; i < elements.length; i++) {` (line 612) | MISSING_NGSPICE |
| 336 | (no counterpart) | `const el = elements[i];` (line 613) | MISSING_NGSPICE |
| 337 | (no counterpart) | `if (el.isReactive && el.pinNodeIds.length >= 2) {` (line 614) | MISSING_NGSPICE |
| 338 | (no counterpart) | `const nA = el.pinNodeIds[0];` (line 615) | MISSING_NGSPICE |
| 339 | (no counterpart) | `const nB = el.pinNodeIds[1];` (line 616) | MISSING_NGSPICE |
| 340 | (no counterpart) | `const vA = nA > 0 && nA - 1 < nodeCount ? this._voltages[nA - 1] : 0;` (line 617) | MISSING_NGSPICE |
| 341 | (no counterpart) | `const vB = nB > 0 && nB - 1 < nodeCount ? this._voltages[nB - 1] : 0;` (line 618) | MISSING_NGSPICE |
| 342 | (no counterpart) | `this._history.push(i, vA - vB);` (line 619) | MISSING_NGSPICE |
| 343 | (no counterpart) | `}` (line 620) | MISSING_NGSPICE |
| 344 | (no counterpart) | `}` (line 621) | MISSING_NGSPICE |

## 40. TimestepController Accept (ours) vs ngspice `CKTdelta = newdelta`

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 345 | `ckt->CKTdelta = newdelta;` (dctran.c:894 — done INSIDE accept branch of retry loop) | `this._timestep.currentDt = newDt;` (line 624 — done AFTER loop) | REORDERED |
| 346 | (no counterpart — ngspice has no invariant check on CKTtime) | `try {` (line 625) | MISSING_NGSPICE |
| 347 | (implicit — CKTtime already advanced inside loop) | `this._timestep.accept(this._simTime);` (line 626) | MISSING_NGSPICE |
| 348 | (no counterpart) | `} catch (err) {` (line 627) | MISSING_NGSPICE |
| 349 | (no counterpart) | `this._diagnostics.emit(` (line 628) | MISSING_NGSPICE |
| 350 | (no counterpart) | `makeDiagnostic("convergence-failed", "error", String(err instanceof Error ? err.message : err), {` (line 629) | MISSING_NGSPICE |
| 351 | (no counterpart) | `explanation: "TimestepController.accept() invariant violated — simTime did not advance monotonically.",` (line 630) | MISSING_NGSPICE |
| 352 | (no counterpart) | `involvedElements: [],` (line 631) | MISSING_NGSPICE |
| 353 | (no counterpart) | `simTime: this._simTime,` (line 632) | MISSING_NGSPICE |
| 354 | (no counterpart) | `}),` (line 633) | MISSING_NGSPICE |
| 355 | (no counterpart) | `);` (line 634) | MISSING_NGSPICE |
| 356 | (no counterpart) | `this._transitionState(EngineState.ERROR);` (line 635) | MISSING_NGSPICE |
| 357 | (no counterpart) | `return;` (line 636) | MISSING_NGSPICE |
| 358 | (no counterpart) | `}` (line 637) | MISSING_NGSPICE |

## 41. Method Switching (ours only — BDF-2 heuristic)

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 359 | (no counterpart — ngspice's method is set once via `.options method=gear/trap`, never auto-switched) | `this._timestep.checkMethodSwitch(elements, this._history);` (line 638) | MISSING_NGSPICE |

## 42. updateCompanion Loop (ours; ngspice folds into DEVaccept)

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 360 | `CKTaccept(ckt)` iterates DEVices[]->DEVaccept for LTRA etc. (cktaccept.c) | `for (const el of elements) {` (line 645) | DIFF |
| 361 | (per-device inside DEVaccept) | `if (el.updateCompanion) {` (line 646) | DIFF |
| 362 | (per-device inside DEVaccept) | `el.updateCompanion(dt, method, this._voltages);` (line 647) | DIFF |
| 363 | (per-device end) | `}` (line 648) | DIFF |
| 364 | (per-device end) | `}` (line 649) | DIFF |

## 43. updateState Loop (ours; ngspice has no direct counterpart — device state in CKTstate0)

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 365 | (no direct counterpart — ngspice devices update state inside DEVload/DEVaccept) | `for (const el of elements) {` (line 652) | MISSING_NGSPICE |
| 366 | (inside DEVaccept) | `if (el.updateState) {` (line 653) | MISSING_NGSPICE |
| 367 | (inside DEVaccept) | `el.updateState(dt, this._voltages);` (line 654) | MISSING_NGSPICE |
| 368 | (end) | `}` (line 655) | MISSING_NGSPICE |
| 369 | (end) | `}` (line 656) | MISSING_NGSPICE |

## 44. acceptStep / Breakpoint Scheduling (ngspice CKTsetBreak inside devices)

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 370 | Devices call `CKTsetBreak(ckt, t)` inside DEVload/DEVaccept for waveform edges (e.g., VSRCload) | `for (const el of elements) {` (line 659) | DIFF |
| 371 | (per-device) | `if (el.acceptStep) {` (line 660) | DIFF |
| 372 | (per-device — arg is `CKTsetBreak` bound to ckt) | `el.acceptStep(this._simTime, (t) => this._timestep.addBreakpoint(t));` (line 661) | DIFF |
| 373 | (per-device end) | `}` (line 662) | DIFF |
| 374 | (per-device end) | `}` (line 663) | DIFF |

## 45. Measurement Observers + stepCount (ours only)

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 375 | (no counterpart — `.measure` processed separately in outer driver) | `this._stepCount++;` (line 666) | MISSING_NGSPICE |
| 376 | (no counterpart) | `for (const obs of this._measurementObservers) {` (line 667) | MISSING_NGSPICE |
| 377 | (no counterpart) | `obs.onStep(this._stepCount);` (line 668) | MISSING_NGSPICE |
| 378 | (no counterpart) | `}` (line 669) | MISSING_NGSPICE |

## 46. Method Exit

| # | ngspice DCtran (C) | analog-engine.ts step() (TS) | Status |
|---|-------------------|------------------------------|--------|
| 379 | (no explicit return — DCtran continues outer `while(time < finalTime)` loop; single-step caller returns inside acceptance block at CKTdump+IFpauseTest) | `}` end of step (line 670) | DIFF |

## 47. Summary Statistics

| Category | Count |
|----------|------:|
| Total rows | 379 |
| MATCH | 46 |
| DIFF | 89 |
| REORDERED | 13 |
| MISSING_OURS (ngspice has, we lack) | 79 |
| MISSING_NGSPICE (we have, ngspice lacks) | 152 |

### Breakdown by section (rows per region)

| Section | Rows |
|---------|-----:|
| 1. Method signature | 11 |
| 2. Pre-loop setup | 27 |
| 3. Logging scaffold | 15 |
| 4. Retry-loop local state | 3 |
| 5. DeltaOld rotation | 3 |
| 6. State-vector rotation | 7 |
| 7. Phase tracking scaffold | 2 |
| 8. for(;;) loop entry | 6 |
| 9. Top of retry iter (dctran.c:740-748) | 5 |
| 10. Advance-time publish | 2 |
| 11. Predictor (PREDICTOR macro) | 4 |
| 12. save_mode/save_order | 2 |
| 13. Phase hook onAttemptBegin | 12 |
| 14. XSPICE breakpoint scaffold | 7 |
| 15. NIcomCof block | 7 |
| 16. Companion stamp loop | 5 |
| 17. NIiter call | 27 |
| 18. XSPICE hybrid call | 6 |
| 19. Post-NIiter bookkeeping | 14 |
| 20. Per-attempt logging | 17 |
| 21. NR-failed branch | 16 |
| 22. XSPICE breakpoint backup | 9 |
| 23. NR-converged else | 3 |
| 24. updateChargeFlux loop | 5 |
| 25. firsttime block + WANT_SENSE2 | 22 |
| 26. LTE check | 10 |
| 27. LTE logging | 4 |
| 28. LTE accept + order promotion | 10 |
| 29. LTE accept step | 11 |
| 30. LTE reject | 15 |
| 31. delmin check | 26 |
| 32. olddelta update | 1 |
| 33. XSPICE/CLUSTER post-delmin | 5 |
| 34. End of for(;;) | 1 |
| 35. nextTime/acceptance | 4 |
| 36. CKTsols rotation | 2 |
| 37. Accepted-attempt logging | 5 |
| 38. timeRef republish | 3 |
| 39. BDF-2 history push | 10 |
| 40. TimestepController accept | 14 |
| 41. Method switching | 1 |
| 42. updateCompanion loop | 5 |
| 43. updateState loop | 5 |
| 44. acceptStep / breakpoint | 5 |
| 45. Measurement observers | 4 |
| 46. Method exit | 1 |

### Notable Structural Observations

- **olddelta placement (rows 56, 75, 314)**: ngspice initializes `olddelta = CKTdelta` at the TOP of each retry iteration (dctran.c:740) before advancing time. We initialize once before the loop (line 337) and update only at the END of each iteration (line 583). Net effect is equivalent for the two-strike delmin logic, but the semantic is inverted (olddelta becomes "previous iteration's delta" rather than "this iteration's entry delta").
- **Voltage restore on retry (rows 189, 280)**: We explicitly `this._voltages.set(this._prevVoltages)` on both NR-fail and LTE-reject; ngspice relies on `CKTrhsOld` already holding the previous solution (NIiter did not swap on failure paths).
- **CKTdelta update on accept (rows 263, 345)**: ngspice does `CKTdelta = newdelta` INSIDE the accept branch before `goto nextTime`. We do `this._timestep.currentDt = newDt` AFTER the loop exit. Functionally equivalent but reordered.
- **Phase hooks and stepPhaseHook (rows 88-99, 185, 230, 268, 274, 295)**: Entirely ours — ngspice uses the single `ni_fire_outer_cb` instrumentation call with a flag bundle per termination path.
- **BDF-2 history + method switching (rows 335-344, 359)**: Entirely ours — ngspice has no runtime method switching; `CKTintegrateMethod` is set once at setup.
- **State-vector rotation location (rows 57-66)**: ngspice rotates `CKTdeltaOld` AND `CKTstates` immediately before the retry loop (dctran.c:715-723). Ours matches the location (lines 340-348), but additionally calls `refreshElementRefs` because pool-backed elements hold slot pointers.
- **updateChargeFlux (rows 211-215)**: Called explicitly on the converged `_voltages` before LTE evaluation. In ngspice, charge updates happen inside each DEVload during the final NIiter iteration and are stored in `CKTstate0` for CKTterr to read.
- **tranStep counter (rows 322-324)**: Bumped at acceptance for pool state book-keeping. No direct ngspice equivalent — ngspice's equivalent is the `CKTstates[]` pointer rotation which happened BEFORE the retry loop.
- **statePool.initMode transitions (rows 110-112, 153-155, 194)**: Our explicit `"initTran"`/`"initPred"` strings mirror ngspice's `CKTmode &= ~INITF; CKTmode |= MODEINITPRED;` bitmask operations, but the transitions happen at slightly different points (ours sets `initPred` right after the NR solve unconditionally at line 454, ngspice sets it at dctran.c:794 also unconditionally — row 153 matches).
