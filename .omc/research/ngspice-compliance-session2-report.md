# ngspice Compliance Session 2 Report

**Date:** 2026-04-07
**Scope:** Review of session 1 changes against ngspice source, production of diffs, and execution of approved changes. Root cause analysis of engine freeze.

---

## Changes Executed

### 1. CKTterr Rewrite (`src/solver/analog/ckt-terr.ts`)

**Bugs fixed:**

| Bug | Before | After | ngspice ref |
|-----|--------|-------|-------------|
| Root exponent | `1/(order+1)` — order=1→0.5, order=2→0.333 | order=1→no root, order=2→sqrt, order>2→`pow(del,1/order)` | `cktterr.c:70-74` |
| volttol quantity | Terminal voltage (`vNow`/`vPrev`) | Companion current (`ccap0`/`ccap1` = `dQ/dt`) | `cktterr.c:37-38` |
| Order=2 divided difference | Degraded to order=1 (3 charge points) | Full 3rd divided difference (4 charge points via `q3`) | `cktterr.c:44-59` |

**New signature:** `cktTerr(dt, deltaOld, order, method, q0, q1, q2, q3, ccap0, ccap1, params)`

The root exponent fix alone was 3 orders of magnitude wrong at order=1 (`del` vs `sqrt(del)`).

### 2. Existing Device Caller Updates (6 files)

All reactive devices updated to new cktTerr 11-arg signature with `q3` + `ccap0`/`ccap1`.

| Device | File | State size change | Key fix |
|--------|------|-------------------|---------|
| Capacitor | `capacitor.ts` | 9→10 | +Q_PREV3 slot |
| Inductor | `inductor.ts` | 7→8 | +PHI_PREV3 slot |
| Diode | `diode.ts` | 13→14 | +Q_PREV3, **fixed duplicate SLOT_VD_PREV bug** |
| BJT | `bjt.ts` | +3 slots | +Q_BE/BC/CS_PREV3 |
| MOSFET | `mosfet.ts` | +3 (via fet-base) | All 3 junctions rewritten |
| FET base | `fet-base.ts` | +3 slots | Q_GS/GD/GB_PREV3, renumbered slot constants |

Each device computes `ccap0 = (q0-q1)/dt` and `ccap1 = (q1-q2)/deltaOld[0]` inline, avoiding new state slots for companion current storage.

### 3. Five New Device LTE Migrations (5 files)

| Device | File | Old→New Slots | Junctions | Pattern |
|--------|------|---------------|-----------|---------|
| Polarized Cap | `polarized-cap.ts` | 3→10 | 1 cap | Mirrors capacitor.ts |
| Crystal | `crystal.ts` | 9→21 | 1 inductor + 2 caps | Math.min of 3 cktTerr calls |
| Transformer | `transformer.ts` | 13→21 | 2 coupled inductors | Flux = L*i + M*i_other |
| Tapped Transformer | `tapped-transformer.ts` | 12→24 | 3 coupled inductors | Flux includes all mutual terms |
| Varactor | `varactor.ts` | 8→13 | 1 V-dep cap | Q = Cj(V) * V approximation |

Also added `getLteTimestep?` optional method to `AnalogElementCore` in `core/analog-types.ts` (architecturally correct — this is the factory return contract interface, method is optional via `?`).

### 4. DC-OP Rewrite (`dc-operating-point.ts`, `analog-engine-interface.ts`, `analog-engine.ts`)

Complete replacement of the DC operating point solver.

| Algorithm | Before (WRONG) | After (ngspice-correct) | ngspice ref |
|-----------|----------------|-------------------------|-------------|
| Gmin stepping | `spice3_gmin` — fixed decades, no backtracking | `dynamic_gmin` — adaptive factor, state backtracking | `cktop.c:127-258` |
| Source stepping | Fixed 10% increments, no backtracking | `gillespie_src` — starts at 0.1%, adaptive raise, backtracking | `cktop.c:354-546` |
| Stepping iteration limit | 100 (same as direct solve) | 50 (`dcTrcvMaxIter`, `cktntask.c:98`) | `cktntask.c:98` |
| State backtracking | None | Full `statePool.state0` save/restore via existing infrastructure | `cktop.c:178-185` |

**Key design:** Uses existing `statePool.state0.slice()` / `.set()` for backtracking — zero new element methods needed. `dcTrcvMaxIter: 50` added to `SimulationParams`. `DcOpResult.method` union updated to `"direct" | "dynamic-gmin" | "gillespie-src"`.

**Files changed:**
- `dc-operating-point.ts` — complete rewrite (~420 lines)
- `analog-engine-interface.ts` — `dcTrcvMaxIter` param + method union
- `analog-engine.ts:747` — `statePool: cac.statePool ?? null` pass-through

### 5. Timestep + Damping Fixes (4 items)

| Fix | File:Line | Before | After | ngspice ref |
|-----|-----------|--------|-------|-------------|
| Initial timestep | `timestep.ts:118` | `maxTimeStep / 100` | `maxTimeStep / 1000` | `dctran.c:112` |
| Step-equalisation | `timestep.ts:256-268` | Novel 1.9× split heuristic | Simple breakpoint clamp | `dctran.c:583-585` |
| Order promotion | `timestep.ts:447-480` + `analog-engine.ts:633` | No `.9` gate, no dt update on revert, no `currentOrder=2` | All three sub-issues fixed | `dctran.c:862-876` |
| Damping condition | `newton-raphson.ts:384` | `if (opts.isDcOp)` | `if (opts.isDcOp && iteration > 0)` | `niiter.c:204-206` |

### 6. Engine Freeze Fixes

**Root cause:** `TimestepController.accept()` at `timestep.ts:327-336` has a while loop that pops breakpoints and refills from `source.nextBreakpoint(simTime)`. When floating-point rounding causes `nextBreakpoint` to return a value `<= simTime`, the loop re-inserts at the front and spins forever.

**Fix 1 — Breakpoint refill guard** (`timestep.ts:332`):
```typescript
// Before:
if (next !== null) {
// After:
if (next !== null && next > simTime) {
```

**Fix 2 — Coordinator stagnation guard** (`coordinator.ts:187`):
```typescript
if (this._analog !== null && this._analog.simTime === analogTimeBefore) {
  throw new Error(`Analog engine stagnation: simTime stuck at ${this._analog.simTime}s...`);
}
```

Defense in depth — the breakpoint fix is the root cause resolution; the coordinator guard catches any other zero-progress scenario.

---

## Test Results (post-execution)

**Build:** Zero TypeScript errors.

**Tests:** 8438 passed, 41 failed (33 vitest + 8 playwright). Breakdown:

### State size assertion failures (17 tests) — Expected, need assertion updates
- `bjt.test.ts` — expects 24, got 45 (×2)
- `diode-state-pool.test.ts` — expects 8, got 14 (×3)
- `jfet.test.ts` — expects 43, got 55 (×2) + initState slot offset (×2)
- `capacitor.test.ts` — expects 6, got 10
- `inductor.test.ts` — expects 4, got 8
- `crystal.test.ts` — expects 9, got 21 (×2)
- `polarized-cap.test.ts` — expects 3, got 10 (×3)
- `transformer.test.ts` — expects 13, got 21 (×2)
- `fet-base.test.ts` — expects 40, got 52

### Algorithm change failures (5 tests) — Need test logic updates
- `newton-raphson.test.ts:reports_non_convergence` — maxIter floor 100 changes behavior
- `newton-raphson.test.ts:convergence_trace_populated` — trace array still referenced
- `timestep.test.ts:reduces_dt_for_large_error` — CKTterr root exponent changes values
- `timestep.test.ts:safety_factor_0_9` — same
- `timestep.test.ts:largest_error_element_tracked` — getLteTimestep interface change

### Behavioral/convergence (5 tests) — Need investigation
- `rlc-lte-path.test.ts` — RC/RL step response values far off (×4 + 2 timeouts)
- `buckbjt-convergence.test.ts` — survives 600µs fails
- `timer-555.test.ts` — pulse width off by 0.01% (×2)

### E2E Playwright (8 tests) — Downstream of convergence changes
- `analog-bjt-convergence.spec.ts` — voltage values shifted (×2)
- `hotload-params-e2e.spec.ts` — BJT output voltage shifted
- `master-circuit-assembly.spec.ts` — errors/values off (×3)
- `stepping-perf.spec.ts` — buckbjt doesn't advance (×2)

---

## Open Issues

### CRITICAL: Structural Step Loop Divergence from ngspice

**Location:** `src/solver/analog/analog-engine.ts:257-639`

ngspice uses a single outer `for(;;)` loop (`dctran.c:715`) where both NR failure AND LTE rejection feed back to the top — each gets a fresh NR solve and a fresh LTE check. Our code has two separate nested loops:

1. NR retry loop (lines 371-445) — shrinks dt until NR converges
2. LTE rejection path (lines 466-580) — runs ONE LTE-reduced NR attempt with its own retry loop

After LTE rejection + retry converges, the result is **accepted unconditionally without a second LTE evaluation**. In ngspice, the reduced-dt result would go through LTE again, and could be rejected again, progressively refining dt until both NR and LTE are satisfied.

**Impact:** Circuits with stiff LTE requirements may accept steps that ngspice would reject, leading to accuracy differences. The nested structure also makes the code harder to reason about.

**Recommended fix:** Restructure to a single outer loop matching `dctran.c:715`. High blast radius — all convergence tests need updating.

### CRITICAL: Missing Companion Restamp in LTE Rejection Path

**Location:** `src/solver/analog/analog-engine.ts:469-493`

After LTE rejection, the code restores voltages (line 470) and state (line 472), sets `dt = newDt` (line 476), then calls `newtonRaphson()` (line 480) **without restamping companion models**. The companions are still stamped at the old (rejected) dt. The LTE NR retry loop (lines 508-575) does restamp on NR failure (line 542-546), but the first attempt at the LTE-reduced dt uses stale companions.

**ngspice behavior:** After LTE rejection, ngspice loops back to the top of the outer `for(;;)`, which re-runs companion stamping at the new delta before calling `NIiter`.

**Impact:** The first NR attempt after LTE rejection solves with wrong companion coefficients. If it converges, the solution is based on a dt mismatch. If it fails, the retry loop restamps correctly, wasting an iteration.

**Fix:** Add companion restamping between lines 477 and 480:
```typescript
for (const el of elements) {
  if (el.isReactive && el.stampCompanion) {
    el.stampCompanion(dt, this._timestep.currentMethod, this._voltages);
  }
}
```

### HIGH: tryOrderPromotion `_newDelta` Parameter Unused

**Location:** `src/solver/analog/timestep.ts:451`

The `_newDelta` parameter was added to match ngspice's pattern where the order-1 `newdelta` is passed into the promotion logic. Our implementation ignores it and recomputes via `computeNewDt()`. The underscore prefix silences the compiler but doesn't address the gap.

**ngspice behavior** (`dctran.c:864`): Re-seeds `newdelta = ckt->CKTdelta` (the current timestep, not the order-1 result) before calling `CKTtrunc` at order 2. The order-1 result is only used for the `.9` gate (which our caller already handles).

**Impact:** Functionally equivalent — our `computeNewDt` starts from `currentDt` which is the same as ngspice's re-seed. The parameter may be removable. Needs definitive verification.

### HIGH: Breakpoint `nextBreakpoint` Floating-Point Fragility

**Location:** `src/components/io/clock.ts:282-286`, `src/components/sources/ac-voltage-source.ts:520-524`

The `next > simTime` guard in `accept()` prevents the infinite loop but silently drops breakpoints that land exactly on `simTime`. The root cause is that `nextBreakpoint()` implementations use arithmetic like `(Math.floor(afterTime / halfPeriod) + 1) * halfPeriod` which can round to `<= afterTime`.

**Fix:** Each `nextBreakpoint` implementation should guarantee strict monotonicity:
```typescript
const result = (Math.floor(afterTime / halfPeriod) + 1) * halfPeriod;
return result > afterTime ? result : result + halfPeriod;
```

### HIGH: RLC LTE Path Test Failures

**Location:** `src/headless/__tests__/rlc-lte-path.test.ts`

RC/RL step response values are orders of magnitude off (e.g., expected ≥3.097, got 0.0000281). Two tests timeout. This suggests the CKTterr root exponent fix (which changed order=1 results by 3 orders of magnitude) has shifted timestep control behavior significantly. The LTE system now produces much smaller timesteps at order=1 (correct per ngspice), but the test circuits may need more simulation time or the test assertions need recalibration.

**Needs investigation:** Are the test expectations wrong (calibrated to the old buggy exponent), or is there a new bug in the interaction between the corrected CKTterr and the timestep controller?

### MEDIUM: BJT AREA Parameter + vcrit Scaling

**Diff ready, not executed.** ngspice uses `BJTtSatCur * BJTarea` for vcrit and all current computations (`csat` in `bjtload.c:171`). Our code uses bare `params.IS`. AREA defaults to 1.0 in ngspice (`bjtsetup.c:353-354`), so existing circuits are unaffected.

**Changes needed:**
- Add `AREA` param (default 1.0) to BJT param definitions
- Scale vcrit: `VT * Math.log(VT / (params.IS * params.AREA * Math.SQRT2))`
- Scale `csat = IS * AREA` for all Ebers-Moll current computations
- Audit all `params.IS` uses in bjt.ts

**Diff output:** `tasks/af61313fb8bab7bc1.output` (jcap/vcrit agent)

### MEDIUM: MOSFET Separate Drain/Source vcrit

**Diff ready, not executed.** ngspice computes separate `drainVcrit`/`sourceVcrit` using `JS * area` when available (`mos1temp.c:205-215`). When JS=0 (our default), both collapse to `tSatCur`, matching our current single vcrit.

**Changes needed:**
- Compute `DrainSatCur` / `SourceSatCur` from JS and W*L when JS > 0
- Two separate vcrit values
- Updated pnjlim calls with correct per-junction vcrit

**Diff output:** `tasks/af61313fb8bab7bc1.output`

### MEDIUM: Tunnel Diode Junction Capacitance

**Diff ready, not executed.** Currently has `isReactive: true` but zero capacitance code. ngspice diode model includes depletion + diffusion capacitance in transient/AC.

**Changes needed:**
- Add CJO/VJ/M/TT/FC params (defaults 0 — off by default)
- Expand state schema 4→14 (conditional on `hasCapacitance`)
- Add `stampCompanion` reusing `computeJunctionCapacitance` from diode.ts
- Add `getLteTimestep` with cktTerr call

**Diff output:** `tasks/af61313fb8bab7bc1.output`

### MEDIUM: LED Junction Capacitance

**Diff ready, not executed.** Same gap as tunnel diode — standalone Shockley diode with no capacitance. Inline implementation (not delegation to createDiodeElement due to pin label mismatch).

**Diff output:** `tasks/af61313fb8bab7bc1.output`

### LOW: Trace Array Cleanup

**Diff ready, not executed.** The `ConvergenceTrace[]` array on NRResult is partially dead. Only `trace[trace.length-1].largestChangeElement` and `.largestChangeNode` are ever read. `oscillating` and `fallbackLevel` fields are never read in production.

**Recommended:** Replace with two scalar fields on NRResult. Delete `_makeTrace`, oscillation detection block, `ConvergenceTrace` type.

**Diff output:** `tasks/a2f7d3fe245bd1536.output` (audit-cleanup agent)

### LOW: `timestep.reject()` Dead Code

**Confirmed zero callers.** Engine does inline `dt/8` and direct `currentDt` assignment.

**Diff output:** `tasks/a2f7d3fe245bd1536.output`

### LOW: Incorrect `isReactive: true` Flags (5 devices)

tunnel-diode, SCR, triac, LED, zener (simplified) — all have `isReactive: true` with no `stampCompanion`. Wastes cycles in `computeNewDt` iteration. Needs `PoolBackedAnalogElementCore` interface to decouple pool backing from reactivity.

**Diff output:** `tasks/a2f7d3fe245bd1536.output`

### LOW: Zener Simplified Model Capacitance

The "spice" model (default) already has full capacitance via createDiodeElement. Gap is only in the "simplified" model. Lowest priority.

### MEDIUM: `new_gmin` Algorithm Not Implemented

**Location:** `src/solver/analog/dc-operating-point.ts`

ngspice's default DC-OP fallback chain is `dynamic_gmin → new_gmin → gillespie_src`. Session 2 implemented `dynamic_gmin` and `gillespie_src` but skipped `new_gmin` — the device-level CKTgmin stepping with adaptive backtracking that fires between diagonal-gmin failure and source-stepping. This is the intermediate fallback at `cktop.c:260-340` that sets `CKTgmin` on individual devices rather than adding diagonal shunts.

**Source:** Session 1 report line 178; DC-OP audit agent

### MEDIUM: Temperature Adjustment of IS (BJT + MOSFET)

**Location:** `bjt.ts:549-550`, `mosfet.ts:897`

ngspice computes `BJTtSatCur` via temperature adjustment in `bjttemp.c` (incorporating `TNOM`, energy gap, temperature ratio) and uses it for vcrit and all current computations. Our code uses bare `params.IS` with no temperature model. Same gap exists in MOSFET (`mos1temp.c`). This is a known simplification that becomes incorrect at non-nominal temperatures. Separate from the AREA scaling issue.

**Source:** Phase E review agent vcrit note; jcap/vcrit agent (`af61313fb8bab7bc1.output`)

### MEDIUM: MOSFET Junction Currents Use Bare IS Instead of Area-Scaled Saturation Current

**Location:** `src/components/semiconductors/mosfet.ts:911-931`

The MOSFET drain and source junction current computations (`cbdI`/`cbsI` and `gbd`/`gbs`) use bare `IS` where ngspice uses `DrainSatCur`/`SourceSatCur` (area-scaled or JS-derived). This is the current-computation counterpart of the vcrit issue — even after separate vcrits are added, the junction I-V curves themselves need the scaled saturation currents. The jcap/vcrit agent's diff includes this fix alongside the vcrit change.

**Source:** jcap/vcrit agent (`af61313fb8bab7bc1.output`), MOSFET diff "Fix 4: GMIN current term"

### LOW: NR Blame-Tracking Loop Runs When Tracing Disabled

**Location:** `src/solver/analog/newton-raphson.ts:433-447`

The `largestChangeElement` computation loop runs every NR iteration regardless of `enableTrace`. The result is only consumed inside the `if (enableTrace)` block. Moving it inside the guard saves ~10-20 loop iterations per NR iteration when tracing is off.

**Source:** Phase E review agent, recommendation 2

### LOW: Convergence Log UI Panel

**Location:** postMessage contract ready (`sim-convergence-log` / `sim-convergence-log-data`)

Session 1 implemented convergence logging across headless, MCP, and postMessage surfaces. The UI panel to visualize step records was listed as remaining work in session 1 and was not addressed in session 2.

**Source:** Session 1 report, lines 217-224

### LOW: Transmission Line LTE

**Location:** Composite element with private sub-elements

Transmission line was deferred in session 1 because it's a composite element whose internal segments are not visible to the engine's element iteration. The outer element would need to aggregate LTE across N segments internally — separate architectural work from the per-element getLteTimestep pattern.

**Source:** Session 1 report, lines 213-214

### LOW: `PoolBackedAnalogElementCore` Interface Prerequisite

**Location:** `src/solver/analog/element.ts:318-325`

Fixing the 5 incorrect `isReactive: true` flags requires a new `PoolBackedAnalogElementCore` interface that decouples pool-backing from reactivity. Currently `ReactiveAnalogElementCore` requires `isReactive: true` as a literal type. This is infrastructure needed before the isReactive fix can land.

**Source:** Cleanup audit agent (`a2f7d3fe245bd1536.output`), Item 3 specification

---

## Agent Output References

All investigation and diff agent outputs are in:
`C:\Users\cca79\AppData\Local\Temp\claude\C--local-working-projects-digital-in-browser\9d01aace-c146-404d-a47a-88b2f24b79d8\tasks\`

### Review Agents (Session 2)

| Agent | Topic | Output File |
|-------|-------|-------------|
| Phase A+B review | NR convergence + timestep vs ngspice | `a192f5a9399b3c59a.output` |
| Phase C review | LTE CKTterr vs ngspice | `af5ba9cd937725582.output` |
| Phase E review | stampLinear + pnjlim vs ngspice | `a92a0889a1263ed67.output` |
| DC-OP audit | Full gap analysis + pseudocode | `ad882ff437bad540e.output` |
| LTE device migration audit | 5 devices survey + specs | `aa39d25de1a79fc26.output` |
| Cleanup audit | Trace, reject(), isReactive | `a2f7d3fe245bd1536.output` |
| State infra audit | Existing statePool save/restore | `a15f0b526b5343569.output` |
| Junction cap + vcrit | Tunnel diode, LED, zener, BJT AREA, MOSFET vcrit | `af61313fb8bab7bc1.output` (combined investigation + diffs) |
| Step loop audit | Infinite loop root cause + ngspice structural comparison | `ac05abeb002898c90.output` |

### Diff/Execution Agents (Session 2)

| Agent | Scope | Output File |
|-------|-------|-------------|
| CKTterr rewrite diff | Core function rewrite spec | `a3da503ce05bab6cc.output` |
| DC-OP rewrite diff | Full algorithm spec | `ad5ae2f2aa16a1cd1.output` |
| Timestep fixes diff | 4 fixes spec | `a554ee99246a20291.output` |
| LTE device migration diff | 5 devices spec | `af7052b4d0f4910bc.output` |
| CKTterr executor | ckt-terr.ts rewrite | `a0c20c0dceed4c111.output` |
| Device callers executor | 6 files q3+ccap update | `a02b90f98b8f4557a.output` |
| LTE migration executor | 5 new devices | `a8c75ba6d58913970.output` |
| DC-OP executor | dc-operating-point.ts rewrite | `a07929db1f1e45d64.output` |
| Timestep executor | 4 timestep+damping fixes | `a7cdd901e35385179.output` |
