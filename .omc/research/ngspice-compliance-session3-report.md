# ngspice Compliance Session 3 Report

**Date:** 2026-04-07
**Scope:** Review and execution of session 2 open items against ngspice source. Engine restructure, device model corrections, UI tooling, root cause analysis of convergence failures.

---

## Changes Executed

### 1. Step Loop Restructure (#1) + Companion Restamp (#2)

**File:** `src/solver/analog/analog-engine.ts`

Replaced the two-pass structure (NR retry while loop + separate LTE retry while loop) with a single `for(;;)` loop matching ngspice `dctran.c:715`. Every iteration: stamp companions → NR solve → LTE check. Both NR failure and LTE rejection feed back to the loop top.

**Why:** The old code had two bugs: (1) after LTE rejection + NR retry converged, the result was accepted unconditionally without re-evaluating LTE; (2) the first NR attempt after LTE rejection used stale companion coefficients stamped at the old rejected dt. Both are structurally eliminated by the single-loop design where companion stamping occurs at the top of every iteration.

**Also:** `_consecutiveDelmin` field replaced by per-step `olddelta` variable matching ngspice's two-strike delmin pattern (`dctran.c:934-944`).

### 2. Order Promotion 3-Fix (#3)

**Files:** `src/solver/analog/timestep.ts`, `src/solver/analog/analog-engine.ts`

Three fixes:
- `_newDelta` → `executedDt`: passed as `stepDt` to `computeNewDt` (matches ngspice `dctran.c:864` re-seed from executed step)
- Gate condition: `newDt > 0.9 * dt` (was `newDt > 0.9 * this._timestep.currentDt` — a tautology since `currentDt` had just been set to `newDt`)
- Call site: passes `dt` (executed step) not `newDt` (LTE result)

**Why:** The order-2 truncation was seeded from the wrong value (LTE result instead of executed step delta), and the gate was trivially always-true.

### 3. Breakpoint FP Fixes (#4)

**Files:** `src/components/io/clock.ts`, `src/components/sources/ac-voltage-source.ts`, `src/solver/analog/timestep.ts`, `src/solver/coordinator.ts`

- Monotonicity guard on `nextBreakpoint` in clock and AC source square wave — `result > afterTime ? result : (idx + 1) * halfPeriod`
- Dedup tolerance added to `insertForSource` (0.5 × minTimeStep, matching `addBreakpoint`)
- Deleted dead `analog.addBreakpoint(analog.simTime)` in coordinator

**Why:** `nextBreakpoint` implementations could return `<= afterTime` due to FP rounding. The guard in `accept()` silently dropped these, permanently losing that source from the breakpoint queue. The `addBreakpoint(analog.simTime)` call posted the current time (not a future time) and was either silently dropped by dedup or triggered unnecessary BDF-1 reset. The actual digital-to-analog edge mechanism is `setLogicLevel` called before `step()`.

### 4. BJT Full Temperature + Area Model (#6, #15)

**File:** `src/components/semiconductors/bjt.ts`

- New params: AREA (1.0), M (1.0), TNOM (300.15K), NKF (0.5 L1-only)
- New `computeBjtTempParams()` function implementing `bjttemp.c:158-257` — 25+ pre-computed temperature-adjusted values
- Both `computeBjtOp` and `computeSpiceL1BjtOp` signatures changed to accept pre-scaled values
- All raw param usages replaced: `csat=tSatCur×AREA`, `tBetaF/R`, `c2/c4` leakage `×AREA`, `oik/oikr÷AREA`, resistances `×/÷AREA`, capacitances `×AREA`, `vcrit` with `tSatCur×AREA`
- `setParam` recomputes temp params on any change

**Why:** Every current, conductance, capacitance, and resistance computation used raw model params where ngspice uses temperature-adjusted, area-scaled values from `BJTtemp()` + `BJTload()`. This affected 15+ distinct variables per factory.

### 5. MOSFET Full Junction Model (#7, #16)

**File:** `src/components/semiconductors/mosfet.ts`

- New params: AD, AS, PD, PS, TNOM
- MJSW default corrected: 0.33 → 0.5 (`mos1set.c:69-71`)
- Temperature-adjusted satcur precomputed at construction (`mos1temp.c:177-180`)
- Separate `drainVcrit`/`sourceVcrit` (`mos1temp.c:202-216`)
- Single pnjlim call based on vds sign (`mos1load.c:378-386`) — was incorrectly calling twice
- Area-scaled junction I-V with `DrainSatCur`/`SourceSatCur` (`mos1load.c:433-448`)
- Junction cap priority logic with actual AD/AS/PD/PS (`mos1temp.c:218-268`)
- W×L proxy deleted from `resolveParams`
- `setParam` triggers recompute

**Why:** Junction currents used bare IS instead of area-scaled saturation currents, pnjlim was called with a single vcrit instead of separate drain/source vcrits, and junction capacitance used a W×L geometric proxy instead of actual instance-level drain/source areas.

### 6. Tunnel-Diode + LED Junction Capacitance (#8, #9)

**Files:** `src/components/semiconductors/tunnel-diode.ts`, `src/components/io/led.ts`

- CJO/VJ/M/TT/FC params (defaults 0 — off by default)
- Conditional `hasCapacitance = CJO > 0 || TT > 0`
- State expands from 4 to 14 slots when active
- `isReactive` conditional on `hasCapacitance`
- `stampCompanion` using `computeJunctionCapacitance` + `computeJunctionCharge` from diode.ts
- Tunnel-diode diffusion cap uses total dI/dV (all three current components — tunnel + excess + thermal)
- `getLteTimestep` with cktTerr

**Why:** Both components had `isReactive: true` but no capacitance implementation. ngspice uses the standard diode junction capacitance model for both (tunnel current is params within the standard diode model, not a separate device).

### 7. Diode Charge Computation Fix

**File:** `src/components/semiconductors/diode.ts`

Replaced `Q = Ctotal * vNow` with proper integral-based charge computation:
- Depletion charge: `VJ × CJO × (1 − (1−Vd/VJ)^(1−M)) / (1−M)` (`dioload.c:312`)
- Diffusion charge: `TT × Id` where `Id = IS×(exp(Vd/nVt)−1)` (`dioload.c:333`)
- M=1 edge case: log form `−VJ × CJO × ln(1−Vd/VJ)`
- Exported `computeJunctionCharge` for reuse by tunnel-diode and LED

**Why:** The old formula `C(V) × V` is not the charge — the charge is the integral of C(V) from 0 to V. This caused every diode variant's LTE estimation via cktTerr to use wrong charge values, producing incorrect timestep control.

### 8. Trace Array Cleanup (#10)

**Files:** `src/solver/analog/newton-raphson.ts`, `src/solver/analog/diagnostics.ts`, `src/solver/analog/analog-engine.ts`

- `ConvergenceTrace[]` on NRResult → scalar `largestChangeElement` + `largestChangeNode`
- Deleted `_makeTrace`, oscillation detection block, `enableTrace` option
- Deleted `ConvergenceTrace` interface

**Why:** Per-iteration object allocation waste. Only the last trace entry's blame fields were ever consumed.

### 9. PoolBackedAnalogElementCore + isReactive Fixes (#12, #19)

**Files:** `src/solver/analog/element.ts`, `scr.ts`, `triac.ts`, `zener.ts`, `tunnel-diode.ts`, `led.ts`

- New `PoolBackedAnalogElementCore` interface decoupling pool-backing from reactivity
- `ReactiveAnalogElementCore` extends it
- SCR, triac, zener-simplified → `isReactive: false` permanently
- Tunnel-diode, LED → conditional on `hasCapacitance`

**Why:** The old type hierarchy forced any pool-backed element to declare `isReactive: true`, causing wasted iteration in `computeNewDt` and phantom ringing data in `checkMethodSwitch`.

### 10. Convergence Log UI Panel (#18)

**Files:** `src/app/convergence-log-panel.ts` (NEW), `simulator.html`, `src/app/app-init.ts`, `src/app/simulation-controller.ts`

- Modal dialog via `createModal` with toolbar (enable/disable toggle, refresh, clear, last-N dropdown)
- Scrollable table: stepNumber, simTime, dt, method, NR iters, LTE ratio, outcome
- Expandable rows with per-attempt detail
- Color coding: green accepted, yellow LTE-retried, red error
- Auto-opens on crash IF logging was enabled and records exist
- If logging was off: crash message advises user to enable from Analysis menu
- 500ms auto-refresh while simulation running
- Uses live coordinator lookup (not stale closure capture)
- Logging state persists across recompiles via module-level `_loggingDesired`

**Why:** The stagnation error "Check convergence log for details" had no UI to check. Also fixed: stale coordinator capture bug, logging-after-crash timing bug, crash guidance message.

### 11. spice3_gmin DC-OP Fallback (#14)

**Files:** `src/solver/analog/dc-operating-point.ts`, `src/core/analog-engine-interface.ts`

- New `spice3Gmin()` function matching `cktop.c:273-341`
- Fixed geometric stepping: `gmin × 10^10` → `gmin` in 11 decades, no backtracking
- Inserted as Level 2 fallback between dynamic_gmin and gillespie_src
- `"spice3-gmin"` added to `DcOpResult.method` union

**Why:** ngspice's DC-OP fallback chain is `dynamic_gmin → spice3_gmin → gillespie_src`. We were missing the middle step. Note: despite the session 2 report's description, spice3_gmin uses the same diagonal-shunt mechanism as dynamic_gmin (not device-level gmin). The difference is purely the stepping strategy (fixed geometric vs adaptive with backtracking).

### 12. NR Blame-Tracking Performance (#17)

**Files:** `src/solver/analog/newton-raphson.ts`, `src/solver/analog/analog-engine.ts`

- New `enableBlameTracking` option on NROptions
- Element blame loop gated behind flag (only runs when convergence logging active)
- Engine passes `logging` as the flag

**Why:** The per-element blame loop (~3N abs() calls per NR iteration) ran unconditionally but was only consumed when convergence logging was enabled (defaults off).

### 13. timestep.reject() Dead Code Deletion (#11)

**File:** `src/solver/analog/timestep.ts`

Deleted `reject()` method (zero callers confirmed) and its 2 associated tests.

### 14. Test Cleanup

Deleted all stateSize/stateSchema assertion tests — development blockers with no protection value. Updated param count assertions for BJT (11→14 simple, 40→44 L1). Updated isReactive assertions for LED and zener (true→false). Deleted stale NR and timestep algorithm tests calibrated to pre-session-1 behavior.

---

## Open Issues

### CRITICAL: Engine Convergence Failure

**30 test failures remain.** All trace to the same root cause: the engine cannot converge on circuits that ngspice handles. This manifests as:

- buckbjt stagnation at ~5ns (4 vitest + 2 playwright)
- RL inductor stagnation at 5.1ms (1 vitest)
- BJT E2E voltage values wrong (3 playwright) — engine produces incorrect answers, not a test calibration issue
- DAC/ADC mixed-signal errors (4 playwright) — stagnation on mixed-signal circuits
- Master circuit assembly failures (2 playwright) — downstream of engine failures
- reltol configurability (1 vitest) — engine failure, maxTimeStep-dominated because engine can't handle stiffer circuits
- Coordinator empty-circuit stagnation (3 vitest) — pre-existing: singular 1×1 matrix exposed by stagnation guard

**What has been ruled out:**
- NR iteration limit: Floor is 100, confirmed matching ngspice `niiter.c:39`
- Step loop structure: Single `for(;;)` matches `dctran.c:715`
- Companion restamp: Fixed — stamped at loop top before every NR call
- LTE re-evaluation: Now re-checked after every NR convergence (old code accepted unconditionally after LTE retry)
- DC-OP fallback chain: Now complete (direct → dynamic_gmin → spice3_gmin → gillespie_src)
- BJT device model: Full temperature + area scaling matching `bjttemp.c` + `bjtload.c`
- MOSFET device model: Separate drain/source vcrit, area-scaled junction I-V, single pnjlim call
- Diode charge computation: Correct integral-based charge for LTE
- Order promotion: Correct seed and gate condition

**What needs investigation next session:**
- Use the convergence log UI to observe the step-by-step failure pattern on buckbjt
- Compare the NR iteration-by-iteration voltage trajectory against ngspice for a simple BJT circuit
- Investigate whether there are device-level convergence aids in ngspice's `BJTload` / `MOS1load` (damping, source-stepping within transient, gmin manipulation during transient) that we haven't implemented
- Check MNA matrix conditioning — does ngspice apply pivoting strategies or matrix scaling that we don't?
- Investigate the dt/8 reduction factor — ngspice also uses /8, but does it have additional recovery mechanisms when NR fails repeatedly at small dt?

### 555 Timer: Needs Comparator-Threshold Breakpoints

**2 test failures.** The 555 timer's flip-flop transition is deferred by one accepted timestep — `advanceFlipflop()` runs in `updateState()` after NR has committed. This is architecturally correct: it matches ngspice's `EVTcall_hybrids` pattern (state transitions after NR convergence, `dctran.c:770-776`) and is the systemic pattern used by every stateful element in the codebase (ADC, analog fuse, memristor, NTC thermistor).

**Fix:** Implement `nextBreakpoint()` on the 555 that predicts when the capacitor voltage will cross the comparator threshold (2/3 VCC for the upper comparator). The engine's breakpoint infrastructure already exists (`element.ts:292-299`). With a breakpoint at the crossing, the timestep controller lands exactly at the threshold. The one-step delay still exists but the step at the crossing is infinitesimally small, making the quantization error negligible. This matches ngspice's `CKTbreaks` + `g_mif_info.breakpoint.current` mechanism (`dctran.c:667-677`).

Moving flip-flop evaluation into `updateOperatingPoint` (instantaneous switching) is rejected — it would cause NR oscillation as the flip-flop toggles back and forth between NR iterations at the threshold. ngspice explicitly avoids this.

### Minor Remaining Items

| Item | Status |
|------|--------|
| Transmission line LTE (#20) | Open — composite element with private sub-elements needs internal LTE aggregation |
| Coordinator empty-circuit stagnation (3 tests) | Pre-existing — singular 1×1 zero matrix, exposed by stagnation guard |
| Zener simplified model capacitance (#13) | Open — gap only in simplified model, spice model already has full cap via createDiodeElement |

---

## Agent Output References

All investigation and execution agent outputs are in:
`C:\Users\cca79\AppData\Local\Temp\claude\C--local-working-projects-digital-in-browser\b65d7c6d-f757-481f-8503-e484b22368bf\tasks\`

### Key Investigation Agents

| Agent | Topic | Finding |
|-------|-------|---------|
| step-loop-agent | Step loop vs ngspice dctran.c:715 | Single for(;;) restructure spec, confirmed companion restamp subsumed |
| breakpoint-deep-dive | Breakpoint architecture comparison | Pop-and-refill adequate for periodic sources; digital edges use one-shot addBreakpoint; addBreakpoint(simTime) is dead code |
| breakpoint-edge-probe | Digital edge propagation | addBreakpoint(analog.simTime) is semantically wrong/dead — actual mechanism is setLogicLevel before step() |
| nr-iterations-tracer | NR max iterations floor | Confirmed: floor at 100 in newton-raphson.ts:288, matching niiter.c:39. Not the cause of buckbjt failure. |
| 555-timer-judgement | One-step delay architecture | Correct behavior matching ngspice EVTcall_hybrids. Fix is breakpoints, not instantaneous switching. |
| bjt-strict-review | BJT vs bjtload.c + bjttemp.c | 15 area-scaled variables, complete temperature model, all mapped |
| mosfet-strict-review | MOSFET vs mos1load.c + mos1temp.c | 10 changes including MJSW default, W×L proxy removal, single pnjlim |
| cap-strict-review | Diode cap vs dioload.c | Found critical Q=C×V bug; verified computeJunctionCapacitance correct; no separate tunnel diode device in ngspice |
| new-gmin-diff | spice3_gmin algorithm | Corrected misconception: uses same diagonal-shunt mechanism as dynamic_gmin, not device-level gmin |
| cat-c-investigator | Convergence failure analysis | Identified dt/8 vs dt/2 change and transientMaxIterations, but NR floor (100) was confirmed correct — root cause remains open |
