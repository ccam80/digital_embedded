# Session Report — 2026-04-08

## Engine Alignment: ngspice Parity Fixes + Comparison Harness Design

### Changes Made

#### 1. Inductor `integrateInductor` Migration
**File:** `src/components/passives/inductor.ts`
**Root cause:** The inductor was importing `inductorConductance`/`inductorHistoryCurrent` from `integration.ts`, but those functions were removed during the MNA engine refactor. The capacitor had been updated to use `integrateCapacitor`; the inductor was left behind. This caused RL circuits to produce completely wrong results (inductor acted as open circuit then short).
**Fix:** Replaced dead imports with `integrateInductor`. Added CCAP slot to state schema. Updated `stampCompanion`, `updateChargeFlux`, `getLteTimestep` signatures to match engine's 5-arg call convention. Split static topology stamps from reactive companion into `stampReactiveCompanion`. Removed dead `getLteEstimate` method.
**Tests:** 17/17 inductor tests pass. RC/RL diagnostic confirms sub-ppm accuracy for both circuits.

#### 2. MOSFET Analytical Depletion Charge Integral
**File:** `src/components/semiconductors/mosfet.ts`
**Root cause:** DB/SB junction charge was computed as `Q = C * V` (linearized) instead of the analytical depletion charge integral from ngspice `mos1load.c:643-669`.
**Fix:** Replaced `qbd = capbd * vdb` / `qbs = capbs * vsbCap` with:
- Reverse bias: `Q = PB * (CJ*(1 - arg*sarg)/(1-MJ) + CJSW*(1 - arg*sargsw)/(1-MJSW))`
- Forward bias: `Q = f4 + V*(f2 + V*f3/2)`
Applied at 4 locations: `stampCompanion` (drain-bulk, source-bulk) and `updateChargeFlux` (drain-bulk, source-bulk). All `_f2d/_f3d/_f4d/_f2s/_f3s/_f4s` coefficients were already precomputed but unused for charge.
**Tests:** 26/26 MOSFET tests pass.

#### 3. Transmission Line branchCount + Internal Node Count
**Files:** `src/components/passives/transmission-line.ts`, `src/core/registry.ts`, `src/compile/types.ts`, `src/solver/analog/compiler.ts`
**Root cause:** `branchCount: 1` was hardcoded but N-segment transmission line uses N branch rows (one per inductor/CombinedRL). With default segments=10, 9 branch rows stomped subsequent elements' matrix entries. Additionally, `getInternalNodeCount` was missing (needs `2*(N-1)` internal nodes), and three attribute mappings (`lossPerMeter`, `length`, `segments`) lacked `modelParam: true`, causing XML-loaded values to be invisible to the compiler.
**Fix:**
- `ModelEntry` and `MnaModel` interfaces: `branchCount` widened to `number | ((props: PropertyBag) => number)`
- Compiler Pass A reordered: props/merge hoisted above branchCount resolution with `typeof` check
- Transmission line: dynamic `branchCount` and `getInternalNodeCount` functions, `modelParam: true` on all three attrs
**Tests:** 33/33 transmission line tests pass.

#### 4. 555 Timer Test Helper Fix
**File:** `src/components/active/__tests__/timer-555.test.ts`
**Root cause:** Tests used `makeCapacitor` mock from `test-helpers.ts` which had a stale charge history bug (`q1` derived from `vPrev` one step too old instead of from accepted charge). This made RC charging ~3-5x slower than correct, causing frequency/pulse-width tests to fail.
**Fix:** Replaced `makeCapacitor` mock with real `AnalogCapacitorElement` (via `createTestCapacitor` + `allocateStatePool`) in both `buildAstableCircuit` and `buildMonostableCircuit`.
**Tests:** 8/8 timer-555 tests pass (was 5/8).

#### 5. Transmission Line Test Assertion Update
**File:** `src/components/passives/__tests__/transmission-line.test.ts`
**Root cause:** Test expected static `branchCount: 1` but it's now a function.
**Fix:** Updated assertion to verify function-typed branchCount returns correct values for different segment counts.
**Tests:** 33/33 pass.

---

### Open Issues — Investigated but Not Implemented

#### A. BJT Temperature Polynomial System (~40 coefficients)
**Status:** Fully catalogued, not implemented.
**Problem:** ngspice temperature-adjusts ~15 BJT parameters via `(1 + tx1*dt + tx2*dt^2)` polynomials in `bjttemp.c:112-156`. Our code implements zero of them. All defaults are 0, so at T=TNOM the polynomials evaluate to 1.0 — no effect on current circuits.
**Required:** Add ~40 parameter definitions to BJT schemas (`tnf1/tnf2`, `tnr1/tnr2`, `tne1/tne2`, `tnc1/tnc2`, `tns1/tns2`, `tvaf1/tvaf2`, `tikf1/tikf2`, `trc1/trc2`, `tre1/tre2`, `trb1/trb2`, `trbm1/trbm2`, `tirb1/tirb2`, `titf1/titf2`, `ttf1/ttf2`, `ttr1/ttr2`, `tmje1/tmje2`, `tmjc1/tmjc2`, `tmjs1/tmjs2`), implement polynomial multiplication in `computeBjtTempParams`, pass temperature-adjusted values to stamp functions. Mechanical but wide-reaching.
**Impact:** Only affects circuits with non-nominal temperature or model cards specifying temperature coefficients.
**Reference:** Complete checklist with ngspice line references in explore-bjt-temp agent output.

#### B. `getLteEstimate` Dead Interface Cleanup
**Status:** Identified, removal spec written (Phase 1e of harness spec).
**Problem:** `getLteEstimate` is declared as an optional method in `element.ts:202` and `analog-types.ts:151` but never implemented by any element and never called by the engine. It was superseded by `getLteTimestep`. Three comments still reference it (`element.ts:274`, `timestep.ts:182`, `bjt.ts:1056`).
**Required:** Remove declarations from both interfaces, update 3 stale comments. Part of harness Phase 1e spec.

#### C. Coordinator Stagnation (4 test failures)
**Status:** Unresolved. These are the buckbjt-class engine stagnation bugs.
**Problem:** 4 tests in `src/solver/coordinator.ts` fail with "Analog engine stagnation: simTime stuck at 5.000004768371584e-9s". The engine exhausts all retries without advancing. This is the primary remaining engine bug.
**Required:** The comparison harness (spec at `docs/harness-implementation-spec.md`) is designed to diagnose this by providing per-NR-iteration internal state comparison against ngspice. Phase 1 (engine accessors) enables standalone debugging; Phase 3 (ngspice bridge) enables side-by-side comparison.

#### D. MOSFET DB/SB Junction Charge Conservation (follow-up)
**Status:** Charge formula fixed (Change #2 above), but the broader charge conservation architecture question remains.
**Problem:** Gate caps use proper Meyer incremental charge accumulation. Junction caps now use the correct analytical integral. However, ngspice's `NIintegrate` integrates Q(V) directly while our code passes the charge to `integrateCapacitor` which uses the companion model. The two approaches should be numerically equivalent but this has not been verified via the harness.
**Required:** Harness comparison of MOSFET transient behavior against ngspice to confirm junction charge tracking matches.

#### E. Voltage Range Tracker Display Issue
**Status:** Investigated, not the root cause of reported problems, but a real UX issue.
**Problem:** `VoltageRangeTracker` starts at ±5V default. Small-signal circuits map all voltages to ~0.5 (gray) making wire colors indistinguishable. The `LOG_GAMMA = 0.4` curve further compresses differentiation. Additionally, before `startSimulation()` is called, `voltageTracker` is null and all analog wires render as flat theme color.
**Required:** Auto-scale the voltage range based on actual circuit voltages, or use a logarithmic/adaptive range that distinguishes millivolt-level differences.

---

### Harness Implementation Spec
**Location:** `docs/harness-implementation-spec.md`
**Status:** Spec complete, zero-cost review passed, approved for implementation.
**Phases:**
1. Engine accessors (4 file changes — sparse-solver, newton-raphson, analog-engine, convergence-log)
2. Harness TypeScript modules (5 new files — types, capture, device-mappings, compare, query)
3. ngspice integration (niiter.c modification, DLL build, FFI bridge)

---

### Test Suite Status at Session End
- **Passed:** 7966
- **Failed:** 4 (all coordinator stagnation — issue C above)
- **Total files:** 341
