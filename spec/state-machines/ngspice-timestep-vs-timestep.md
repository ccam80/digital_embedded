# ngspice timestep vs timestep.ts — Line-by-Line Mapping

## 1. File / Module Layout

| # | ngspice dctran.c (C) | timestep.ts (TS) | Status |
|---|---|---|---|
| 1 | `(flat C function DCtran, no class)` | `export class TimestepController {` (line 45) | DIFF |
| 2 | `(module-scope doc: inline comments, see dctran.c:1-30)` | file header jsdoc lines 1-10 describing "Adaptive timestep controller..." | DIFF |
| 3 | `(ngspice has no BreakpointEntry struct — uses parallel arrays ckt->CKTbreaks[])` | `interface BreakpointEntry { time; source; }` (lines 21-31) | DIFF |
| 4 | `(ngspice breakpoints are plain double *CKTbreaks)` | BreakpointEntry.time field doc (lines 22-23) | DIFF |
| 5 | `(ngspice breakpoint sources are tracked implicitly via per-device nextBreakpoint calls in CKTaccept)` | BreakpointEntry.source field doc (lines 24-30) | DIFF |
| 6 | `#include <spice.h>` etc (dctran.c:1-30) | `import type { AnalogElement, IntegrationMethod } from "./element.js";` (line 12) | DIFF |
| 7 | `(no analog import)` | `import type { ResolvedSimulationParams } from "../../core/analog-engine-interface.js";` (line 13) | DIFF |
| 8 | `(no analog import)` | `import type { HistoryStore } from "./integration.js";` (line 14) | DIFF |
| 9 | `(no analog import)` | `import type { LteParams } from "./ckt-terr.js";` (line 15) | DIFF |

## 2. Fields / State Declaration

| # | ngspice dctran.c (C) | timestep.ts (TS) | Status |
|---|---|---|---|
| 10 | `double ckt->CKTdelta;` (struct field, see cktdefs.h) | `currentDt: number;` (line 47) | MATCH |
| 11 | `int ckt->CKTintegrateMethod; // TRAPEZOIDAL or GEAR` | `currentMethod: IntegrationMethod;` (line 50) | DIFF (ours: "bdf1"/"trapezoidal"/"bdf2" string union) |
| 12 | `(no equivalent — params are global CKT fields)` | `private _params: ResolvedSimulationParams;` (line 52) | DIFF |
| 13 | `double ckt->CKTbreaks[];` (flat double array) | `private _breakpoints: BreakpointEntry[];` (line 55) | DIFF |
| 14 | `(no equivalent — ngspice does not track accepted simTime for invariant)` | `private _lastAcceptedSimTime: number;` (line 58) | MISSING_NGSPICE |
| 15 | `(no equivalent — ngspice uses firsttime local + CKTstat->STATaccepted counter)` | `private _acceptedSteps: number;` (line 61) | DIFF |
| 16 | `(no equivalent — ngspice has no ringing detector)` | `private _signHistory: Array<number[]>;` (line 70) | MISSING_NGSPICE |
| 17 | `(no equivalent — ngspice has no BDF-2 stability counter)` | `private _stableOnBdf2: number;` (line 73) | MISSING_NGSPICE |
| 18 | `(ngspice does not track largest LTE element across calls)` | `private _largestErrorElement: number \| undefined;` (line 76) | MISSING_NGSPICE |
| 19 | `double CKTsaveDelta;` (struct field, set at dctran.c:323, 506, 595, 612, 642, 687) | `private _savedDelta: number = 0;` (line 83) | MATCH (field) |
| 20 | `int CKTbreak;` (flag, set at dctran.c:188, 434, 601, 641) | `private _breakFlag: boolean = false;` (line 89) | MATCH (field) |
| 21 | `int firsttime;` (local in DCtran, dctran.c:189) | `private _isFirstGetClampedDt: boolean = true;` (line 96) | DIFF (local vs member) |
| 22 | `double CKTdeltaOld[7];` (struct field, dctran.c:316) | `private _deltaOld: number[] = [0,0,0,0,0,0,0];` (line 103) | MATCH (size 7) |
| 23 | `int CKTorder;` (struct field, dctran.c:315 set to 1) | `currentOrder: number = 1;` (line 109) | MATCH (initial value 1) |

## 3. Constructor

| # | ngspice dctran.c (C) | timestep.ts (TS) | Status |
|---|---|---|---|
| 24 | `(no constructor — ckt struct initialized by CKTinit / TRANinit)` | `constructor(params: ResolvedSimulationParams) {` (line 143) | DIFF |
| 25 | `(no equivalent — params are read directly from ckt->)` | `this._params = params;` (line 144) | DIFF |
| 26 | `delta = MIN(ckt->CKTfinalTime/100, ckt->CKTstep)/10;` (dctran.c:118) | `this.currentDt = Math.max(params.minTimeStep, Math.min(params.maxTimeStep, params.firstStep));` (lines 146-149) | DIFF (formula) |
| 27 | `(no clamp to [minTimeStep, maxTimeStep] at init)` | `Math.max(params.minTimeStep, ...)` inside currentDt init (line 147) | DIFF |
| 28 | `(no explicit integration method setter — uses CKTintegrateMethod default TRAPEZOIDAL)` | `this.currentMethod = "bdf1";` (line 150) | DIFF (we start bdf1, ngspice default trap) |
| 29 | `(no explicit breakpoint array init — done at TRANinit via CKTsetBreak calls)` | `this._breakpoints = [];` (line 151) | DIFF |
| 30 | `(no equivalent)` | `this._lastAcceptedSimTime = -Infinity;` (line 152) | MISSING_NGSPICE |
| 31 | `ckt->CKTstat->STATaccepted = 0;` (implied via stat init) | `this._acceptedSteps = 0;` (line 153) | DIFF |
| 32 | `(no equivalent)` | `this._signHistory = [];` (line 154) | MISSING_NGSPICE |
| 33 | `(no equivalent)` | `this._stableOnBdf2 = 0;` (line 155) | MISSING_NGSPICE |
| 34 | `(no equivalent)` | `this._largestErrorElement = undefined;` (line 156) | MISSING_NGSPICE |
| 35 | `(ngspice CKTreltol, CKTabstol, CKTchgtol, CKTtrtol are scalar ckt fields set by options)` | `this._lteParams = { trtol, reltol, abstol, chgtol };` (lines 157-165) | DIFF (we bundle into object) |
| 36 | `ckt->CKTtrtol` (global field) | `trtol: params.trtol,` (line 158) | MATCH |
| 37 | `ckt->CKTreltol` (global field) | `reltol: params.reltol,` (line 159) | MATCH |
| 38 | `ckt->CKTabstol` (global field, current tol) | `abstol: params.abstol,` (line 163) | MATCH |
| 39 | `ckt->CKTchgtol` (global field) | `chgtol: params.chargeTol,` (line 164) | MATCH |
| 40 | `for(i=0;i<7;i++) { ckt->CKTdeltaOld[i]=ckt->CKTmaxStep; }` (dctran.c:316-318) | `for (let i = 0; i < 7; i++) { this._deltaOld[i] = params.maxTimeStep; }` (lines 168-170) | MATCH |
| 41 | `ckt->CKTsaveDelta = ckt->CKTfinalTime/50;` (dctran.c:323) | `this._savedDelta = params.tStop != null ? params.tStop / 50 : params.maxTimeStep;` (lines 175-177) | DIFF (fallback branch) |
| 42 | `ckt->CKTsaveDelta = ckt->CKTfinalTime/50;` (dctran.c:323) — fallback path N/A | `? params.tStop / 50` (line 176) | MATCH (when tStop present) |
| 43 | `(ngspice always has CKTfinalTime — no fallback path)` | `: params.maxTimeStep;` (line 177) | MISSING_NGSPICE |
| 44 | `ckt->CKTorder = 1;` (dctran.c:315) | `(field initializer sets currentOrder = 1 at line 109)` | MATCH |
| 45 | `ckt->CKTdelta = delta;` (dctran.c:319) | `(covered in currentDt init at line 146)` | MATCH |

## 4. Property Getters

| # | ngspice dctran.c (C) | timestep.ts (TS) | Status |
|---|---|---|---|
| 46 | `(no getter — direct field access)` | `get largestErrorElement(): number \| undefined {` (line 184) | DIFF |
| 47 | `(no getter)` | `return this._largestErrorElement;` (line 185) | MISSING_NGSPICE |
| 48 | `(no getter)` | `}` (line 186) | DIFF |
| 49 | `(no getter — double CKTdeltaOld[] direct access)` | `get deltaOld(): readonly number[] {` (line 189) | DIFF |
| 50 | `(no getter)` | `return this._deltaOld;` (line 190) | MATCH |
| 51 | `(no getter)` | `}` (line 191) | DIFF |
| 52 | `(no getter — int CKTbreak flag direct)` | `get breakFlag(): boolean {` (line 194) | DIFF |
| 53 | `(no getter)` | `return this._breakFlag;` (line 195) | MATCH |
| 54 | `(no getter)` | `}` (line 196) | DIFF |
| 55 | `(no getter — tolerance fields direct)` | `get lteParams(): LteParams {` (line 199) | DIFF |
| 56 | `(no getter)` | `return this._lteParams;` (line 200) | MATCH |
| 57 | `(no getter)` | `}` (line 201) | DIFF |

## 5. rotateDeltaOld() — shift history ring (dctran.c:715-717)

| # | ngspice dctran.c (C) | timestep.ts (TS) | Status |
|---|---|---|---|
| 58 | `(no method — inlined at dctran.c:715-717 before NR loop)` | `rotateDeltaOld(): void {` (line 115) | DIFF |
| 59 | `for(i=5; i>=0; i--)` (dctran.c:715) | `for (let i = 5; i >= 0; i--) {` (line 117) | MATCH |
| 60 | `ckt->CKTdeltaOld[i+1] = ckt->CKTdeltaOld[i];` (dctran.c:716) | `this._deltaOld[i + 1] = this._deltaOld[i];` (line 118) | MATCH |
| 61 | `}` (end for loop, dctran.c:717) | `}` (line 119) | MATCH |
| 62 | `ckt->CKTdeltaOld[0] = ckt->CKTdelta;` (dctran.c:717) | `this._deltaOld[0] = this.currentDt;` (line 120) | MATCH |
| 63 | `(end of inlined block)` | `}` (line 121) | DIFF |

## 6. setDeltaOldCurrent() — dctran.c:748

| # | ngspice dctran.c (C) | timestep.ts (TS) | Status |
|---|---|---|---|
| 64 | `(no method — inlined at dctran.c:748)` | `setDeltaOldCurrent(dt: number): void {` (line 127) | DIFF |
| 65 | `ckt->CKTdeltaOld[0]=ckt->CKTdelta;` (dctran.c:748) | `this._deltaOld[0] = dt;` (line 128) | MATCH |
| 66 | `(end of inlined assignment)` | `}` (line 129) | DIFF |

## 7. computeNewDt() — LTE-based dt proposal (dctran.c:874-876 + CKTtrunc)

| # | ngspice dctran.c (C) | timestep.ts (TS) | Status |
|---|---|---|---|
| 67 | `(no method — CKTtrunc dispatch)` | `computeNewDt(` (line 227) | DIFF |
| 68 | `(elements via ckt->CKThead iteration)` | `  elements: readonly AnalogElement[],` (line 228) | DIFF |
| 69 | `(state history via ckt->CKTstates)` | `  _history: HistoryStore,` (line 229) | DIFF |
| 70 | `(ckt->CKTtime available globally)` | `  simTime: number = 0,` (line 230) | DIFF |
| 71 | `newdelta = ckt->CKTdelta;` (dctran.c:874) | `  stepDt?: number,` (line 231) | DIFF |
| 72 | `(return type implicit in C)` | `): { newDt: number; worstRatio: number } {` (line 232) | DIFF |
| 73 | `newdelta = ckt->CKTdelta;` (dctran.c:874) | `const dt = stepDt ?? this.currentDt;` (line 233) | MATCH (seed value) |
| 74 | `(order read from ckt->CKTorder)` | `const order = this.currentOrder;` (line 234) | MATCH |
| 75 | `(method read from ckt->CKTintegrateMethod)` | `const method = this.currentMethod;` (line 235) | MATCH |
| 76 | `(tol fields read from ckt struct)` | `const lteParams = this._lteParams;` (line 236) | MATCH |
| 77 | `(CKTdeltaOld[] direct access)` | `const deltaOld = this._deltaOld;` (line 237) | MATCH |
| 78 | `(ngspice aggregates via CKTterr calling loadfn per device)` | `let minProposedDt = Infinity;` (line 242) | DIFF |
| 79 | `(ngspice does not track which device had min)` | `let minProposedIdx = -1;` (line 243) | MISSING_NGSPICE |
| 80 | `for (i=0; i<nelements; i++)` (implicit device list walk) | `for (let i = 0; i < elements.length; i++) {` (line 245) | MATCH |
| 81 | `model = ckt->CKThead[i];` (device pointer) | `const el = elements[i];` (line 246) | MATCH |
| 82 | `if(!device->DEVtrunc) continue;` (equivalent C guard) | `if (!el.isReactive) continue;` (line 247) | MATCH |
| 83 | `(ngspice dispatches DEVtrunc function pointer)` | `if (typeof el.getLteTimestep === "function") {` (line 249) | DIFF (explicit check) |
| 84 | `CKTterr(model, ckt, &timeStep);` (CKTterr.c:50) | `const proposed = el.getLteTimestep(dt, deltaOld, order, method, lteParams);` (line 250) | MATCH |
| 85 | `if (timeStep < minTime) { minTime = timeStep; }` (standard reduction) | `if (proposed < minProposedDt) {` (line 251) | MATCH |
| 86 | `minTime = timeStep;` | `minProposedDt = proposed;` (line 252) | MATCH |
| 87 | `(no index tracking in ngspice)` | `minProposedIdx = i;` (line 253) | MISSING_NGSPICE |
| 88 | `}` | `}` (line 254) | MATCH |
| 89 | `}` (end if DEVtrunc present) | `}` (line 255) | MATCH |
| 90 | `(no comment line in ngspice)` | `// Elements without getLteTimestep contribute no LTE constraint.` (line 256) | DIFF |
| 91 | `}` (end for loop over devices) | `}` (line 257) | MATCH |
| 92 | `(no idx tracking)` | `this._largestErrorElement = minProposedIdx >= 0 ? minProposedIdx : undefined;` (line 259) | MISSING_NGSPICE |
| 93 | `(newdelta declared inline)` | `let newDt: number;` (line 261) | DIFF |
| 94 | `(not in ngspice — no reject ratio concept)` | `let worstRatio: number;` (line 262) | MISSING_NGSPICE |
| 95 | `(ngspice unconditionally sets newdelta from CKTtrunc)` | `if (minProposedDt < Infinity) {` (line 264) | DIFF |
| 96 | `newdelta = minTime;` (CKTtrunc writes back) | `newDt = minProposedDt;` (line 267) | MATCH |
| 97 | `(ckttrunc.c:53: timeStep = MIN(timeStep, 2.0 * ckt->CKTdelta))` | `newDt = Math.min(2 * dt, newDt);` (line 270) | MATCH |
| 98 | `(no worstRatio in ngspice — uses direct newdelta > .9 CKTdelta compare)` | `worstRatio = minProposedDt < dt ? dt / minProposedDt : 0;` (line 272) | MISSING_NGSPICE |
| 99 | `} else {` (implicit: no DEVtrunc → newdelta unchanged) | `} else {` (line 273) | DIFF |
| 100 | `(ngspice: newdelta stays = CKTdelta — no growth)` | `newDt = Math.min(dt * 2, this._params.maxTimeStep);` (line 275) | DIFF |
| 101 | `(no worstRatio)` | `worstRatio = 0;` (line 276) | MISSING_NGSPICE |
| 102 | `}` | `}` (line 277) | MATCH |
| 103 | `(no global clamp in CKTtrunc — ngspice clamps at dctran.c:540-541 via MIN(CKTdelta, CKTmaxStep))` | `newDt = Math.max(this._params.minTimeStep, Math.min(this._params.maxTimeStep, newDt));` (line 280) | DIFF |
| 104 | `(breakpoint clamping done later at dctran.c:594-596)` | `if (this._breakpoints.length > 0) {` (line 283) | DIFF |
| 105 | `ckt->CKTbreaks[0]` (first breakpoint) | `const nextBp = this._breakpoints[0]!.time;` (line 284) | MATCH |
| 106 | `ckt->CKTbreaks[0] - ckt->CKTtime` | `const remaining = nextBp - simTime;` (line 285) | MATCH |
| 107 | `if(ckt->CKTtime + ckt->CKTdelta >= ckt->CKTbreaks[0])` (dctran.c:594) | `if (remaining > 0 && newDt > remaining) {` (line 286) | MATCH |
| 108 | `ckt->CKTdelta = ckt->CKTbreaks[0] - ckt->CKTtime;` (dctran.c:596) | `newDt = remaining;` (line 287) | MATCH |
| 109 | `}` | `}` (line 288) | MATCH |
| 110 | `}` | `}` (line 289) | MATCH |
| 111 | `(no pre-allocated result — ngspice uses *newdelta pointer)` | `this._lteResult.newDt = newDt;` (line 292) | DIFF |
| 112 | `(no pre-allocated result)` | `this._lteResult.worstRatio = worstRatio;` (line 293) | DIFF |
| 113 | `return(OK);` / `*newdelta = newdelta;` | `return this._lteResult;` (line 294) | DIFF |
| 114 | `}` (end CKTtrunc) | `}` (line 295) | DIFF |

## 8. getClampedDt() — pre-step dt computation (dctran.c:551-603)

| # | ngspice dctran.c (C) | timestep.ts (TS) | Status |
|---|---|---|---|
| 115 | `(no equivalent method — inline in resume: block at dctran.c:521-603)` | `getClampedDt(simTime: number): number {` (line 302) | DIFF |
| 116 | `(ngspice reads ckt->CKTdelta directly, already clamped to maxStep at dctran.c:540-541)` | `let dt = this.currentDt;` (line 303) | DIFF |
| 117 | `ckt->CKTsaveDelta = ckt->CKTdelta;` (dctran.c:595, captured at breakpoint only) | `this._savedDelta = dt;` (line 306) | DIFF (we capture always) |
| 118 | `(ngspice has no firsttime branch inside this block — firsttime handled at dctran.c:575-584)` | `if (this._isFirstGetClampedDt) {` (line 310) | DIFF |
| 119 | `(firsttime cleared after first pass: firsttime = 0 at dctran.c:370,864)` | `this._isFirstGetClampedDt = false;` (line 311) | MATCH |
| 120 | `(dctran.c:553: breakpoint proximity uses AlmostEqualUlps + delmin gap)` | `if (this._breakpoints.length > 0) {` (line 312) | DIFF |
| 121 | `(ngspice reads ckt->CKTbreaks[0] directly)` | `const nextBreakGap = this._breakpoints[0]!.time - simTime;` (line 313) | DIFF |
| 122 | `(ngspice has no nextBreakGap > 0 guard — uses delmin proximity)` | `if (nextBreakGap > 0) {` (line 314) | DIFF |
| 123 | `ckt->CKTdelta = MIN(ckt->CKTdelta, .1 * MIN(ckt->CKTsaveDelta, ckt->CKTbreaks[1] - ckt->CKTbreaks[0]));` (dctran.c:572-573) | `dt = Math.min(dt, 0.1 * Math.min(this._savedDelta, nextBreakGap));` (line 316) | DIFF (ngspice uses breaks[1]-breaks[0], ours uses breaks[0]-simTime) |
| 124 | `}` | `}` (line 317) | MATCH |
| 125 | `}` | `}` (line 318) | MATCH |
| 126 | `ckt->CKTdelta /= 10;` (dctran.c:580) | `dt /= 10;` (line 320) | MATCH |
| 127 | `ckt->CKTdelta = MAX(ckt->CKTdelta, ckt->CKTdelmin*2.0);` (dctran.c:588) | `dt = Math.max(dt, this._params.minTimeStep * 2);` (line 322) | MATCH |
| 128 | `(ngspice does NOT persist — ckt->CKTdelta is overwritten here)` | `this._savedDelta = dt;` (line 326) | DIFF |
| 129 | `}` (close firsttime block) | `}` (line 327) | MATCH |
| 130 | `ckt->CKTbreak = 0;` (cleared at dctran.c:434 after accept) | `this._breakFlag = false;` (line 329) | MATCH |
| 131 | `if(ckt->CKTtime + ckt->CKTdelta >= ckt->CKTbreaks[0])` (dctran.c:594) | `if (this._breakpoints.length > 0) {` (line 330) | DIFF (outer guard) |
| 132 | `(ngspice reads ckt->CKTbreaks[0] directly)` | `const nextBp = this._breakpoints[0]!.time;` (line 331) | DIFF |
| 133 | `(ngspice uses CKTtime + CKTdelta comparison)` | `const remaining = nextBp - simTime;` (line 332) | DIFF |
| 134 | `if(ckt->CKTtime + ckt->CKTdelta >= ckt->CKTbreaks[0])` (dctran.c:594) | `if (remaining > 0 && dt >= remaining) {` (line 333) | MATCH |
| 135 | `ckt->CKTsaveDelta = ckt->CKTdelta;` (dctran.c:595) | `(not repeated here — already captured at line 306)` | DIFF |
| 136 | `ckt->CKTdelta = ckt->CKTbreaks[0] - ckt->CKTtime;` (dctran.c:596) | `dt = remaining;` (line 337) | MATCH |
| 137 | `ckt->CKTbreak = 1;` (dctran.c:601) | `this._breakFlag = true;` (line 338) | MATCH |
| 138 | `}` | `}` (line 339) | MATCH |
| 139 | `(end of outer if)` | `}` (line 340) | MATCH |
| 140 | `(no return — ckt->CKTdelta updated in place)` | `return dt;` (line 341) | DIFF |
| 141 | `(end of inline block)` | `}` (line 342) | DIFF |

## 9. shouldReject() — dctran.c:880

| # | ngspice dctran.c (C) | timestep.ts (TS) | Status |
|---|---|---|---|
| 142 | `(no method — inline at dctran.c:880)` | `shouldReject(worstRatio: number): boolean {` (line 365) | DIFF |
| 143 | `if(newdelta > .9 * ckt->CKTdelta) { // accept }` (dctran.c:880) | `return worstRatio >= 1 / 0.9;` (line 367) | MATCH (inverted) |
| 144 | `(end of inline test)` | `}` (line 368) | DIFF |

## 10. accept() — post-step bookkeeping (dctran.c:410-433, 572-580)

| # | ngspice dctran.c (C) | timestep.ts (TS) | Status |
|---|---|---|---|
| 145 | `(no method — nextTime: label block at dctran.c:386-433)` | `accept(simTime: number): void {` (line 382) | DIFF |
| 146 | `(ngspice does not check monotonicity — trusts caller)` | `if (simTime <= this._lastAcceptedSimTime) {` (line 383) | MISSING_NGSPICE |
| 147 | `(no invariant check)` | `throw new Error(...);` (lines 384-386) | MISSING_NGSPICE |
| 148 | `(no invariant check)` | `}` (line 387) | MISSING_NGSPICE |
| 149 | `(no tracking — ckt->CKTtime is global)` | `this._lastAcceptedSimTime = simTime;` (line 388) | MISSING_NGSPICE |
| 150 | `ckt->CKTstat->STATaccepted ++;` (dctran.c:433) | `this._acceptedSteps++;` (line 390) | MATCH |
| 151 | `(ngspice uses firsttime local, cleared at dctran.c:864)` | `this._updateMethodForStartup();` (line 391) | DIFF |
| 152 | `for(i=5; i>=0; i--) CKTdeltaOld[i+1]=CKTdeltaOld[i];` (dctran.c:715-717, NOT in accept) | `// deltaOld rotation removed — now performed by the engine` (line 393) | DIFF |
| 153 | `(ngspice does not track breakpointConsumed flag)` | `let breakpointConsumed = false;` (line 401) | MISSING_NGSPICE |
| 154 | `for (;;) { if(AlmostEqualUlps(ckt->CKTbreaks[0], ckt->CKTtime, 100) || ckt->CKTbreaks[0] <= ckt->CKTtime + ckt->CKTminBreak) { CKTclrBreak(ckt); } else { break; } }` (dctran.c:624-638) | `while (this._breakpoints.length > 0 && simTime >= this._breakpoints[0]!.time) {` (line 402) | MATCH (concept) |
| 155 | `(ngspice does not set flag)` | `breakpointConsumed = true;` (line 403) | MISSING_NGSPICE |
| 156 | `CKTclrBreak(ckt);` (dctran.c:634) | `const popped = this._breakpoints.shift()!;` (line 404) | MATCH |
| 157 | `(ngspice re-seeds breakpoints per-device in CKTaccept via DEVaccept)` | `if (typeof popped.source?.nextBreakpoint === "function") {` (line 405) | DIFF |
| 158 | `(per-device DEVaccept may call CKTsetBreak for next edge)` | `const next = popped.source.nextBreakpoint(simTime);` (line 406) | DIFF |
| 159 | `(ngspice: CKTsetBreak ignores duplicates)` | `if (next !== null && next > simTime) {` (line 407) | DIFF |
| 160 | `CKTsetBreak(ckt, next);` | `this.insertForSource(next, popped.source);` (line 408) | MATCH |
| 161 | `}` | `}` (line 409) | MATCH |
| 162 | `}` (end per-source refill) | `}` (line 410) | MATCH |
| 163 | `}` (end while breakpoint loop) | `}` (line 411) | MATCH |
| 164 | `if ( AlmostEqualUlps(ckt->CKTtime, ckt->CKTbreaks[0], 100) || ckt->CKTbreaks[0] - ckt->CKTtime <= ckt->CKTdelmin) {` (dctran.c:553-554) | `if (breakpointConsumed) {` (line 415) | DIFF (proximity vs flag) |
| 165 | `ckt->CKTorder = 1;` (dctran.c:559) | `this.currentMethod = "bdf1";` (line 416) | MATCH (order 1 sets BDF-1) |
| 166 | `(dctran.c:559 sets CKTorder=1 which = BDF-1 via gear/trap selection)` | `this.currentOrder = 1;` (line 417) | MATCH |
| 167 | `(no intermediate variable)` | `const nextBreakGap = this._breakpoints.length > 0` (line 421) | DIFF |
| 168 | `ckt->CKTbreaks[1] - ckt->CKTbreaks[0]` (dctran.c:572-573) | `? this._breakpoints[0]!.time - simTime` (line 422) | DIFF (ours: next break - simTime; ngspice: breaks[1]-breaks[0]) |
| 169 | `(ngspice returns empty breakpoint sentinel — finalTime?)` | `: Infinity;` (line 423) | DIFF |
| 170 | `ckt->CKTdelta = MIN(ckt->CKTdelta, .1 * MIN(ckt->CKTsaveDelta, ckt->CKTbreaks[1] - ckt->CKTbreaks[0]));` (dctran.c:572-573) | `this.currentDt = Math.max(` (line 424) | DIFF (ours: MAX with delmin floor) |
| 171 | `.1 * MIN(ckt->CKTsaveDelta, nextBreakGap)` (dctran.c:572) | `0.1 * Math.min(this._savedDelta, nextBreakGap),` (line 425) | MATCH |
| 172 | `MAX(ckt->CKTdelmin*2.0, ...)` (dctran.c:588, non-XSPICE) | `2 * this._params.minTimeStep,` (line 426) | MATCH |
| 173 | `);` | `);` (line 427) | MATCH |
| 174 | `}` (end post-breakpoint block) | `}` (line 428) | MATCH |
| 175 | `(end nextTime: block — fall through or goto)` | `}` (line 429) | DIFF |

## 11. checkMethodSwitch() — ringing detection (MISSING IN NGSPICE)

| # | ngspice dctran.c (C) | timestep.ts (TS) | Status |
|---|---|---|---|
| 176 | `(no equivalent — ngspice has no ringing detection)` | `checkMethodSwitch(elements: readonly AnalogElement[], history: HistoryStore): void {` (line 449) | MISSING_NGSPICE |
| 177 | `(no equivalent)` | `if (this._acceptedSteps <= 1) return;` (line 452) | MISSING_NGSPICE |
| 178 | `(no equivalent — ngspice has no per-reactive-element bookkeeping)` | `const reactiveIndices: number[] = [];` (line 455) | MISSING_NGSPICE |
| 179 | `(no equivalent)` | `for (let i = 0; i < elements.length; i++) {` (line 456) | MISSING_NGSPICE |
| 180 | `(no equivalent)` | `if (elements[i].isReactive) reactiveIndices.push(i);` (line 457) | MISSING_NGSPICE |
| 181 | `(no equivalent)` | `}` (line 458) | MISSING_NGSPICE |
| 182 | `(no equivalent)` | `if (this._signHistory.length !== reactiveIndices.length) {` (line 461) | MISSING_NGSPICE |
| 183 | `(no equivalent)` | `this._signHistory = reactiveIndices.map(() => []);` (line 462) | MISSING_NGSPICE |
| 184 | `(no equivalent)` | `}` (line 463) | MISSING_NGSPICE |
| 185 | `(no equivalent)` | `let ringing = false;` (line 465) | MISSING_NGSPICE |
| 186 | `(no equivalent)` | `for (let ri = 0; ri < reactiveIndices.length; ri++) {` (line 467) | MISSING_NGSPICE |
| 187 | `(no equivalent)` | `const elIdx = reactiveIndices[ri];` (line 468) | MISSING_NGSPICE |
| 188 | `(no equivalent)` | `const vNow = history.get(elIdx, 0);` (line 469) | MISSING_NGSPICE |
| 189 | `(no equivalent)` | `const sign = vNow > 0 ? 1 : vNow < 0 ? -1 : 0;` (line 470) | MISSING_NGSPICE |
| 190 | `(no equivalent)` | `const buf = this._signHistory[ri];` (line 472) | MISSING_NGSPICE |
| 191 | `(no equivalent)` | `buf.push(sign);` (line 473) | MISSING_NGSPICE |
| 192 | `(no equivalent)` | `if (buf.length > 3) buf.shift();` (line 474) | MISSING_NGSPICE |
| 193 | `(no equivalent)` | `if (buf.length === 3) {` (line 476) | MISSING_NGSPICE |
| 194 | `(no equivalent)` | `if (` (line 478) | MISSING_NGSPICE |
| 195 | `(no equivalent)` | `buf[0] !== 0 &&` (line 479) | MISSING_NGSPICE |
| 196 | `(no equivalent)` | `buf[1] !== 0 &&` (line 480) | MISSING_NGSPICE |
| 197 | `(no equivalent)` | `buf[2] !== 0 &&` (line 481) | MISSING_NGSPICE |
| 198 | `(no equivalent)` | `buf[0] !== buf[1] &&` (line 482) | MISSING_NGSPICE |
| 199 | `(no equivalent)` | `buf[1] !== buf[2] &&` (line 483) | MISSING_NGSPICE |
| 200 | `(no equivalent)` | `buf[0] === buf[2]` (line 484) | MISSING_NGSPICE |
| 201 | `(no equivalent)` | `) {` (line 485) | MISSING_NGSPICE |
| 202 | `(no equivalent)` | `ringing = true;` (line 486) | MISSING_NGSPICE |
| 203 | `(no equivalent)` | `}` (line 487) | MISSING_NGSPICE |
| 204 | `(no equivalent)` | `}` (line 488) | MISSING_NGSPICE |
| 205 | `(no equivalent)` | `}` (line 489) | MISSING_NGSPICE |
| 206 | `(no equivalent)` | `if (ringing) {` (line 491) | MISSING_NGSPICE |
| 207 | `(no equivalent)` | `if (this.currentMethod !== "bdf2") {` (line 492) | MISSING_NGSPICE |
| 208 | `(no equivalent)` | `this.currentMethod = "bdf2";` (line 493) | MISSING_NGSPICE |
| 209 | `(no equivalent)` | `this.currentOrder = 2;` (line 494) | MISSING_NGSPICE |
| 210 | `(no equivalent)` | `this._stableOnBdf2 = 0;` (line 495) | MISSING_NGSPICE |
| 211 | `(no equivalent)` | `}` (line 496) | MISSING_NGSPICE |
| 212 | `(no equivalent)` | `} else if (this.currentMethod === "bdf2") {` (line 497) | MISSING_NGSPICE |
| 213 | `(no equivalent)` | `this._stableOnBdf2++;` (line 498) | MISSING_NGSPICE |
| 214 | `(no equivalent)` | `if (this._stableOnBdf2 >= 5) {` (line 499) | MISSING_NGSPICE |
| 215 | `(no equivalent)` | `this.currentMethod = "trapezoidal";` (line 500) | MISSING_NGSPICE |
| 216 | `(no equivalent)` | `this.currentOrder = 2;` (line 501) | MISSING_NGSPICE |
| 217 | `(no equivalent)` | `this._stableOnBdf2 = 0;` (line 502) | MISSING_NGSPICE |
| 218 | `(no equivalent)` | `}` (line 503) | MISSING_NGSPICE |
| 219 | `(no equivalent)` | `}` (line 504) | MISSING_NGSPICE |
| 220 | `(no equivalent)` | `}` (line 505) | MISSING_NGSPICE |

## 12. tryOrderPromotion() — dctran.c:881-892

| # | ngspice dctran.c (C) | timestep.ts (TS) | Status |
|---|---|---|---|
| 221 | `(ngspice inline at dctran.c:881-892 after newdelta > .9 CKTdelta)` | `tryOrderPromotion(` (line 525) | DIFF |
| 222 | `(elements via CKThead walk)` | `  elements: readonly AnalogElement[],` (line 526) | DIFF |
| 223 | `(state global)` | `  _history: HistoryStore,` (line 527) | DIFF |
| 224 | `(CKTtime global)` | `  _simTime: number,` (line 528) | DIFF |
| 225 | `(CKTdelta global)` | `  executedDt: number,` (line 529) | DIFF |
| 226 | `(void return)` | `): void {` (line 530) | DIFF |
| 227 | `if((ckt->CKTorder == 1) && (ckt->CKTmaxOrder > 1))` (dctran.c:881) | `if (this.currentMethod !== "bdf1" \|\| this._acceptedSteps <= 1) return;` (line 535) | MATCH (inverted condition) |
| 228 | `newdelta = ckt->CKTdelta;` (dctran.c:882) | `let rawTrialDt = Infinity;` (line 544) | DIFF (seed value) |
| 229 | `ckt->CKTorder = 2;` (dctran.c:883) | `(not performed yet — only mutate after success gate)` | DIFF (order of operations) |
| 230 | `error = CKTtrunc(ckt,&newdelta);` (dctran.c:884) → iterates devices | `for (let i = 0; i < elements.length; i++) {` (line 545) | DIFF (inlined here) |
| 231 | `(device iteration in CKTtrunc)` | `const el = elements[i];` (line 546) | MATCH |
| 232 | `if(!device->DEVtrunc) continue;` | `if (!el.isReactive) continue;` (line 547) | MATCH |
| 233 | `(DEVtrunc function pointer check)` | `if (typeof el.getLteTimestep === "function") {` (line 548) | DIFF |
| 234 | `CKTterr(device, ckt, &timeStep);` — called with order=2 inside CKTtrunc | `const proposed = el.getLteTimestep(` (line 549) | MATCH |
| 235 | `(ckt->CKTorder = 2 at dctran.c:883)` | `  executedDt, this._deltaOld, 2, "trapezoidal", this._lteParams,` (line 550) | MATCH (order 2, trapezoidal) |
| 236 | `);` | `);` (line 551) | MATCH |
| 237 | `if (timeStep < minTime) minTime = timeStep;` | `if (proposed < rawTrialDt) rawTrialDt = proposed;` (line 552) | MATCH |
| 238 | `}` (close DEVtrunc branch) | `}` (line 553) | MATCH |
| 239 | `}` (end loop over devices) | `}` (line 554) | MATCH |
| 240 | `(ckttrunc.c:53: timeStep = MIN(timeStep, 2.0 * ckt->CKTdelta))` | `if (rawTrialDt > 2 * executedDt) rawTrialDt = 2 * executedDt;` (line 556) | MATCH |
| 241 | `if(newdelta <= 1.05 * ckt->CKTdelta)` (dctran.c:889) | `if (rawTrialDt <= 1.05 * executedDt) {` (line 558) | MATCH |
| 242 | `ckt->CKTorder = 1;` (dctran.c:890) | `(no order revert needed — we haven't mutated order yet)` | DIFF |
| 243 | `(ngspice also writes ckt->CKTdelta = newdelta at dctran.c:894 unconditionally)` | `this.currentDt = Math.max(` (line 562) | DIFF |
| 244 | `(no explicit lower clamp in ngspice — delmin gate applied separately)` | `this._params.minTimeStep,` (line 563) | DIFF |
| 245 | `(no explicit maxStep clamp here — done at dctran.c:540-541 on next iter)` | `Math.min(this._params.maxTimeStep, rawTrialDt),` (line 564) | DIFF |
| 246 | `);` | `);` (line 565) | MATCH |
| 247 | `(falls through to dctran.c:894)` | `return;` (line 566) | DIFF |
| 248 | `}` (end demote block) | `}` (line 567) | MATCH |
| 249 | `(ckt->CKTorder = 2 already set at dctran.c:883 above)` | `this.currentMethod = "trapezoidal";` (line 570) | MATCH |
| 250 | `ckt->CKTorder = 2;` (dctran.c:883, sticks if promote succeeds) | `this.currentOrder = 2;` (line 571) | MATCH |
| 251 | `ckt->CKTdelta = newdelta;` (dctran.c:894) | `this.currentDt = Math.max(` (line 573) | MATCH (clamp wrap) |
| 252 | `(ngspice has no explicit maxStep clamp here — done at dctran.c:540-541)` | `this._params.minTimeStep,` (line 574) | DIFF |
| 253 | `(no explicit maxStep clamp)` | `Math.min(this._params.maxTimeStep, rawTrialDt),` (line 575) | DIFF |
| 254 | `(inline falls through)` | `);` (line 576) | DIFF |
| 255 | `(end of inline promotion block)` | `}` (line 577) | DIFF |

## 13. addBreakpoint() — CKTsetBreak equivalent

| # | ngspice dctran.c (C) | timestep.ts (TS) | Status |
|---|---|---|---|
| 256 | `int CKTsetBreak(CKTcircuit *ckt, double time) {` (ckt/setbreak.c) | `addBreakpoint(time: number): void {` (line 592) | DIFF |
| 257 | `int i; for (i=0; ckt->CKTbreaks[i] < time; i++);` (linear search) | `let lo = 0;` (line 594) | DIFF (binary vs linear) |
| 258 | `(linear search continuation)` | `let hi = this._breakpoints.length;` (line 595) | DIFF |
| 259 | `(linear walk loop)` | `while (lo < hi) {` (line 596) | DIFF |
| 260 | `(linear walk loop)` | `const mid = (lo + hi) >>> 1;` (line 597) | DIFF |
| 261 | `for (i=0; ckt->CKTbreaks[i] < time; i++);` | `if (this._breakpoints[mid]!.time < time) lo = mid + 1;` (line 598) | DIFF |
| 262 | `(implicit branch)` | `else hi = mid;` (line 599) | DIFF |
| 263 | `(end for)` | `}` (line 600) | DIFF |
| 264 | `(no dedup eps var — uses CKTminBreak)` | `const eps = this._params.maxTimeStep * 5e-5;` (line 603) | MATCH (CKTminBreak = CKTmaxStep*5e-5, dctran.c:369) |
| 265 | `if(ckt->CKTbreaks[i] - time <= ckt->CKTminBreak) return(OK);` (setbreak.c dedup forward) | `if (lo < this._breakpoints.length && this._breakpoints[lo]!.time - time < eps) {` (line 604) | MATCH |
| 266 | `return(OK);` | `return;` (line 605) | MATCH |
| 267 | `}` | `}` (line 606) | MATCH |
| 268 | `if(time - ckt->CKTbreaks[i-1] <= ckt->CKTminBreak) return(OK);` (dedup backward) | `if (lo > 0 && time - this._breakpoints[lo - 1]!.time < eps) {` (line 607) | MATCH |
| 269 | `return(OK);` | `return;` (line 608) | MATCH |
| 270 | `}` | `}` (line 609) | MATCH |
| 271 | `memmove(&ckt->CKTbreaks[i+1], &ckt->CKTbreaks[i], ...); ckt->CKTbreaks[i] = time;` (setbreak.c) | `this._breakpoints.splice(lo, 0, { time, source: null });` (line 610) | MATCH |
| 272 | `}` | `}` (line 611) | MATCH |

## 14. insertForSource() — (no direct ngspice analogue; per-device CKTsetBreak)

| # | ngspice dctran.c (C) | timestep.ts (TS) | Status |
|---|---|---|---|
| 273 | `(no direct analogue — per-device DEVaccept calls CKTsetBreak(ckt, nextEdge))` | `insertForSource(time: number, source: AnalogElement): void {` (line 623) | DIFF |
| 274 | `(CKTsetBreak linear search)` | `let lo = 0;` (line 624) | DIFF |
| 275 | `(linear search)` | `let hi = this._breakpoints.length;` (line 625) | DIFF |
| 276 | `(linear search)` | `while (lo < hi) {` (line 626) | DIFF |
| 277 | `(linear search)` | `const mid = (lo + hi) >>> 1;` (line 627) | DIFF |
| 278 | `for (i=0; ckt->CKTbreaks[i] < time; i++);` | `if (this._breakpoints[mid]!.time < time) lo = mid + 1;` (line 628) | DIFF |
| 279 | `(implicit)` | `else hi = mid;` (line 629) | DIFF |
| 280 | `(end for)` | `}` (line 630) | DIFF |
| 281 | `ckt->CKTminBreak = CKTmaxStep * 5e-5;` (dctran.c:369) | `const eps = this._params.maxTimeStep * 5e-5;` (line 631) | MATCH |
| 282 | `dedup forward (setbreak.c)` | `if (lo < this._breakpoints.length && this._breakpoints[lo]!.time - time < eps) {` (line 632) | MATCH |
| 283 | `return(OK);` | `return;` (line 633) | MATCH |
| 284 | `}` | `}` (line 634) | MATCH |
| 285 | `dedup backward` | `if (lo > 0 && time - this._breakpoints[lo - 1]!.time < eps) {` (line 635) | MATCH |
| 286 | `return(OK);` | `return;` (line 636) | MATCH |
| 287 | `}` | `}` (line 637) | MATCH |
| 288 | `ckt->CKTbreaks[i] = time;` (no source tracking) | `this._breakpoints.splice(lo, 0, { time, source });` (line 638) | DIFF |
| 289 | `}` | `}` (line 639) | MATCH |

## 15. refreshForSource() — MISSING IN NGSPICE

| # | ngspice dctran.c (C) | timestep.ts (TS) | Status |
|---|---|---|---|
| 290 | `(no equivalent — ngspice has no per-source refresh API)` | `refreshForSource(source: AnalogElement, newNextTime: number \| null): void {` (line 646) | MISSING_NGSPICE |
| 291 | `(no equivalent)` | `const idx = this._breakpoints.findIndex((e) => e.source === source);` (line 647) | MISSING_NGSPICE |
| 292 | `(no equivalent)` | `if (idx >= 0) {` (line 648) | MISSING_NGSPICE |
| 293 | `(no equivalent)` | `this._breakpoints.splice(idx, 1);` (line 649) | MISSING_NGSPICE |
| 294 | `(no equivalent)` | `}` (line 650) | MISSING_NGSPICE |
| 295 | `(no equivalent)` | `if (newNextTime !== null) {` (line 651) | MISSING_NGSPICE |
| 296 | `(no equivalent)` | `this.insertForSource(newNextTime, source);` (line 652) | MISSING_NGSPICE |
| 297 | `(no equivalent)` | `}` (line 653) | MISSING_NGSPICE |
| 298 | `(no equivalent)` | `}` (line 654) | MISSING_NGSPICE |

## 16. clearBreakpoints() — CKTclrBreak bulk analogue

| # | ngspice dctran.c (C) | timestep.ts (TS) | Status |
|---|---|---|---|
| 299 | `(ngspice CKTclrBreak removes ONE breakpoint; no bulk clear API)` | `clearBreakpoints(): void {` (line 659) | DIFF |
| 300 | `(no bulk clear — caller loops)` | `this._breakpoints = [];` (line 660) | DIFF |
| 301 | `(no bulk clear)` | `}` (line 661) | DIFF |

## 17. _updateMethodForStartup() — firsttime replacement

| # | ngspice dctran.c (C) | timestep.ts (TS) | Status |
|---|---|---|---|
| 302 | `(ngspice: firsttime = 1 at dctran.c:189, cleared at dctran.c:370,864)` | `private _updateMethodForStartup(): void {` (line 679) | DIFF |
| 303 | `if(firsttime) { ... goto nextTime; }` (dctran.c:849-873 — skips LTE on first) | `if (this._acceptedSteps <= 1) {` (line 683) | DIFF |
| 304 | `(ngspice uses trapezoidal default — not BDF-1)` | `this.currentMethod = "bdf1";` (line 684) | DIFF |
| 305 | `ckt->CKTorder = 1;` (dctran.c:315) | `this.currentOrder = 1;` (line 685) | MATCH |
| 306 | `(end firsttime block)` | `}` (line 686) | DIFF |
| 307 | `(end function)` | `}` (line 690) | DIFF |
| 308 | `(end flat C function DCtran)` | `}` (line 691, end class) | DIFF |

## 18. ngspice features NOT in our TS (MISSING_OURS)

| # | ngspice dctran.c (C) | timestep.ts (TS) | Status |
|---|---|---|---|
| 309 | `if(converged != 0) { ckt->CKTtime -= ckt->CKTdelta; ckt->CKTdelta = ckt->CKTdelta/8; ckt->CKTorder = 1; }` (dctran.c:806-823) | `(no NR-failure dt/8 shrink — handled in engine, not controller)` | MISSING_OURS |
| 310 | `ckt->CKTstat->STATrejected ++;` (dctran.c:810, 939) | `(no rejection stat counter)` | MISSING_OURS |
| 311 | `if (ckt->CKTdelta <= ckt->CKTdelmin) { if (olddelta > ckt->CKTdelmin) { ckt->CKTdelta = ckt->CKTdelmin; } else { return(E_TIMESTEP); } }` (dctran.c:957-972) | `(no two-strike delmin abort — handled in engine)` | MISSING_OURS |
| 312 | `if(check_autostop("tran") \|\| fabs(ckt->CKTtime - ckt->CKTfinalTime) < ckt->CKTminBreak)` (dctran.c:499-501) | `(no final-time early exit in controller)` | MISSING_OURS |
| 313 | `AlmostEqualUlps(ckt->CKTtime, ckt->CKTbreaks[0], 100)` (dctran.c:553, 628) ULPS-based breakpoint proximity | `simTime >= this._breakpoints[0]!.time` (line 402) — strict >= compare | DIFF |
| 314 | `ckt->CKTbreaks[0] - ckt->CKTtime <= ckt->CKTdelmin` (dctran.c:554) — delmin-band proximity | `(no delmin-band test — exact >= only)` | MISSING_OURS |
| 315 | `XSPICE temp breakpoint via g_mif_info.breakpoint.current` (dctran.c:609-618) | `(no temp breakpoint system)` | MISSING_OURS |
| 316 | `ckt->CKTstat->STATtimePts++;` (dctran.c:314, 793) | `(no time-points stat)` | MISSING_OURS |
| 317 | `temp = ckt->CKTstates[ckt->CKTmaxOrder+1]; for(i=CKTmaxOrder;i>=0;i--) ckt->CKTstates[i+1]=ckt->CKTstates[i]; ckt->CKTstates[0]=temp;` (dctran.c:719-723) | `(state pool rotation handled elsewhere in engine)` | MISSING_OURS |
| 318 | `NIcomCof(ckt);` (dctran.c:749) — compute BDF/Trap integration coefficients from CKTdeltaOld | `(integration coefficients built per element, not central)` | DIFF |
| 319 | `if(ckt->CKTorder == 1 && ckt->CKTmaxOrder > 1)` promotion condition (dctran.c:881) | `if (this.currentMethod !== "bdf1" \|\| this._acceptedSteps <= 1) return;` (line 535) | MATCH (same predicate) |
| 320 | `ckt->CKTmaxOrder` — user-configurable max order | `(no per-run max order — hardcoded to 2 in tryOrderPromotion)` | MISSING_OURS |
| 321 | `if (firsttime) { if (ckt->CKTmode & MODEUIC) CKTsetBreak(ckt, ckt->CKTstep); }` (dctran.c:575-578) | `(no MODEUIC CKTstep breakpoint seed)` | MISSING_OURS |
| 322 | `ckt->CKTdelta = MIN(ckt->CKTdelta, ckt->CKTmaxStep);` (dctran.c:540-541) — explicit clamp at resume | `(implicit in computeNewDt via Math.min(...maxTimeStep...) at line 280; not separate step)` | DIFF |
| 323 | `ckt->CKTmode = (ckt->CKTmode&MODEUIC)\|MODETRAN\|MODEINITPRED;` (dctran.c:794) | `(no mode field — we don't track NR init mode here)` | MISSING_OURS |
| 324 | `if(firsttime) { for(i=0;i<ckt->CKTnumStates;i++) { CKTstate2[i]=CKTstate1[i]; CKTstate3[i]=CKTstate1[i]; } }` (dctran.c:795-800) | `(state pool seeding handled in engine)` | MISSING_OURS |
| 325 | `olddelta=ckt->CKTdelta;` (dctran.c:740) — saved before retry | `(no olddelta — engine manages retry state)` | MISSING_OURS |
| 326 | `ckt->CKTsimTimeStart = ckt->CKTtime; ckt->CKTtime += ckt->CKTdelta;` (dctran.c:743-744) | `(engine advances time, not controller)` | MISSING_OURS |
| 327 | `NIpred(ckt);` predictor (dctran.c:751) | `(predictor handled per-element in integration.ts)` | DIFF |
| 328 | `ckt->CKTmode = save_mode; ckt->CKTorder = save_order;` around sensitivity (dctran.c:335-336, 341-342) | `(no sensitivity analysis save/restore)` | MISSING_OURS |
| 329 | `CKTsoaCheck(ckt)` (dctran.c:414-415) | `(no SOA check)` | MISSING_OURS |

## 19. Mid-method per-line decomposition recap

| # | ngspice dctran.c (C) | timestep.ts (TS) | Status |
|---|---|---|---|
| 330 | `newdelta = ckt->CKTdelta;` (dctran.c:874, LTE seed) | (computeNewDt seed: `const dt = stepDt ?? this.currentDt;` line 233) | MATCH |
| 331 | `error = CKTtrunc(ckt,&newdelta);` (dctran.c:875) | `const proposed = el.getLteTimestep(...)` (line 250) per-element | DIFF (dispatched per-device vs aggregate) |
| 332 | `if(error) { return(error); }` (dctran.c:876-878) | `(no error path — getLteTimestep returns number)` | MISSING_OURS |
| 333 | `if(newdelta > .9 * ckt->CKTdelta) {` (dctran.c:880) accept gate | `return worstRatio >= 1 / 0.9;` (line 367) | MATCH (inverted) |
| 334 | `newdelta = ckt->CKTdelta;` (dctran.c:882) re-seed for order 2 | `let rawTrialDt = Infinity;` (line 544) | DIFF |
| 335 | `ckt->CKTorder = 2;` (dctran.c:883) | `(deferred until success at line 571)` | DIFF |
| 336 | `error = CKTtrunc(ckt,&newdelta);` (dctran.c:884) at order 2 | `for (let i = 0; ...) { const proposed = el.getLteTimestep(executedDt, this._deltaOld, 2, "trapezoidal", ...);` (lines 545-551) | MATCH (inlined) |
| 337 | `if(error) { return(error); }` (dctran.c:885-887) | `(no error path)` | MISSING_OURS |
| 338 | `if(newdelta <= 1.05 * ckt->CKTdelta) { ckt->CKTorder = 1; }` (dctran.c:889-890) | `if (rawTrialDt <= 1.05 * executedDt) { ... return; }` (lines 558-567) | MATCH |
| 339 | `}` (close order==1 block, dctran.c:891) | `}` (line 567) | MATCH |
| 340 | `ckt->CKTdelta = newdelta;` (dctran.c:894) | `this.currentDt = Math.max(minTimeStep, Math.min(maxTimeStep, rawTrialDt));` (lines 573-576) | DIFF (we add explicit clamps) |
| 341 | `goto nextTime;` (dctran.c:930) | `(no goto — return from method)` | DIFF |
| 342 | `} else {` (LTE reject branch, dctran.c:935) | `return worstRatio >= 1 / 0.9;` consumed by engine (line 367) | DIFF |
| 343 | `ckt->CKTtime = ckt->CKTtime - ckt->CKTdelta; ckt->CKTstat->STATrejected++;` (dctran.c:938-939) | `(engine handles time rollback)` | MISSING_OURS |
| 344 | `ckt->CKTdelta = newdelta;` (dctran.c:944) | `(engine sets currentDt after reject; controller exposes next value)` | DIFF |
| 345 | `ckt->CKTdelta = ckt->CKTdelta/8;` NR-failure shrink (dctran.c:815) | `(no NR-failure shrink in controller)` | MISSING_OURS |

## 20. Summary Statistics

| Category | Count |
|---|---|
| Total rows | 345 |
| MATCH | 93 |
| DIFF | 163 |
| MISSING_NGSPICE (in ours, not ngspice) | 66 |
| MISSING_OURS (in ngspice, not ours) | 23 |
