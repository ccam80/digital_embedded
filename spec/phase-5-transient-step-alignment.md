# Phase 5: Transient Step Alignment (DCtran)

## Overview

Align `analog-engine.ts step()` and `timestep.ts` with ngspice dctran.c. Remove all non-ngspice additions: method switching, BDF-1 startup forcing, BDF-2 history tracking. Fix breakpoint handling to use ULP-based comparison.

**Testing surfaces:** Phase 5 is an engine-internal refactor. Per the master plan Testing Surface Policy, Phase 5 is satisfied by unit tests defined below (headless API surface) plus Phase 7 parity tests as the E2E surface. No per-phase MCP or Playwright tests are required.

**Phase ordering note:** The companion/charge/state loop deletions originally scoped to Task 5.1.3 have been **moved to Phase 6 Wave 6.3** so loop deletion and element `load()`-based replacement land atomically. Phase 5 contains only 5.1.1, 5.1.2, 5.1.4, 5.2.x, and 5.3.1.

## Wave 5.1: analog-engine.ts step() Alignment

### Task 5.1.1: Remove method switching infrastructure

- **Description**: Remove all runtime method switching code. ngspice sets the integration method once (`CKTintegrateMethod`) and never changes it. Our adaptive BDF-1→trapezoidal→BDF-2→trapezoidal switching is a custom addition with no ngspice counterpart.

  Remove from `analog-engine.ts`:
  - `checkMethodSwitch` call (line 638)
  - BDF-2 history push loop (lines 612-621)
  - All references to `_signHistory`, `_stableOnBdf2` (these are on TimestepController)

  Remove from `timestep.ts`:
  - `checkMethodSwitch()` method entirely
  - `_signHistory` field and all ringing detection logic
  - `_stableOnBdf2` field
  - `_updateMethodForStartup()` BDF-1 forcing method

  ngspice reference: dctran.c — `CKTintegrateMethod` set once at initialization, never changed during simulation.

- **Files to modify**:
  - `src/solver/analog/analog-engine.ts` — Delete `checkMethodSwitch` call (line 638). Delete the reactive-element terminal-voltage history push loop (lines 612-621 — this loop feeds `this._history` for `checkMethodSwitch`, which is also being deleted).
  - `src/solver/analog/timestep.ts` — Delete `checkMethodSwitch()` method, `_signHistory` field, `_stableOnBdf2` field, `_updateMethodForStartup()` method and its call from `accept()` (line 391). Update `tryOrderPromotion()` guard: drop the `currentMethod !== "bdf1"` check (it becomes vacuously true now that initial method is trapezoidal per Task 5.1.2), keep only `_acceptedSteps <= 1`. Explicitly **preserve** the post-breakpoint `currentMethod = "bdf1"` reset in `accept()` (this is correct ngspice behaviour after breakpoint consumption — do not delete this line).

- **Tests**:
  - `src/solver/analog/__tests__/timestep.test.ts::no_method_switching` — Run 100 steps with trapezoidal. Assert `currentMethod` remains `"trapezoidal"` throughout. Assert `checkMethodSwitch` does not exist as a method.
  - `src/solver/analog/__tests__/timestep.test.ts::post_breakpoint_bdf1_reset_preserved` — Consume a breakpoint mid-simulation. Assert `currentMethod === "bdf1"` immediately after the breakpoint accept; assert subsequent `tryOrderPromotion` calls skip while `_acceptedSteps <= 1`.
  - `src/solver/analog/__tests__/analog-engine.test.ts::method_stable_across_ringing` — Create an RLC oscillator that would have triggered BDF-2 switching under the old code. Assert method remains trapezoidal.

- **Acceptance criteria**:
  - `checkMethodSwitch` method does not exist.
  - `_signHistory` and `_stableOnBdf2` fields do not exist.
  - `_updateMethodForStartup()` does not exist; `tryOrderPromotion()` guard updated.
  - Post-breakpoint `currentMethod = "bdf1"` reset is preserved (ngspice-correct).
  - Integration method is set once at initialization (trapezoidal) and changes only through the post-breakpoint reset.

### Task 5.1.2: Fix initial integration method to trapezoidal

- **Description**: timestep.ts:150 — initial method is `"bdf1"`. ngspice defaults to `TRAPEZOIDAL`. Change to `"trapezoidal"`.

  The BDF-1 startup phase was a custom addition. ngspice starts with trapezoidal from step 0. GEAR order 1 IS BDF-1, but the default method is TRAPEZOIDAL, not GEAR.

  ngspice reference: dctran.c default — `CKTintegrateMethod = TRAPEZOIDAL`.

- **Files to modify**:
  - `src/solver/analog/timestep.ts` — Change initial `currentMethod` from `"bdf1"` to `"trapezoidal"`.

- **Tests**:
  - `src/solver/analog/__tests__/timestep.test.ts::initial_method_is_trapezoidal` — Assert new TimestepController has `currentMethod === "trapezoidal"`.
  - `src/solver/analog/__tests__/analog-engine.test.ts::first_step_uses_trapezoidal` — Run one transient step. Assert integration coefficients match trapezoidal (ag[0] = 1/dt, ag[1] = -1/dt for order 1).

- **Acceptance criteria**:
  - Default integration method is trapezoidal.
  - The `TimestepController` constructor no longer initialises `currentMethod` to `"bdf1"`. (Post-breakpoint `accept()` branch continues to reset to `"bdf1"` — that usage is correct ngspice behaviour and is not affected.)

### Task 5.1.3: MOVED TO PHASE 6 WAVE 6.3

Deletion of `updateChargeFlux`, `stampCompanion`, `updateCompanion`, and `updateState` loops has been **moved to Phase 6 Wave 6.3** so it lands atomically with the `load()`-based replacements in Phase 6 Wave 6.2. Deleting the loops before Phase 6 would leave every reactive-element transient simulation without companion stamping, breaking the engine for an entire phase window.

Phase 5 no longer contains this task. See Phase 6 Wave 6.3 for the deletion + replacement description.

### Task 5.1.4: preIterationHook closure is eliminated in Phase 6 (no change in Phase 5)

- **Description**: The `preIterationHook` closure currently created per NR call exists only to recompute companion models for nonlinear reactive elements on NR iterations > 0. With the unified `load()` interface delivered by Phase 6, this work is absorbed into `element.load()` — companion recomputation becomes part of the per-element load call, and the hook disappears entirely.

  **Phase 5 leaves the closure in place.** The most ngspice-compliant outcome (ngspice has no preIterationHook — `DEVload` does all per-iteration work) is achieved by Phase 6's `load()` migration, not by introducing a transitional `ctx.preIterationHook` field. This task is an explicit no-op in Phase 5; the elimination is handled as part of Phase 6 Wave 6.2 element rewrites.

  ngspice reference: no separate preIterationHook — DEVload does everything.

- **Files to modify**: None in Phase 5.

- **Tests**: None in Phase 5. Phase 6 Wave 6.2 acceptance criteria include "zero closures created per step" after all elements implement `load()`.

- **Acceptance criteria**:
  - Task 5.1.4 intentionally produces no code change in Phase 5. Zero-closures-per-step is a Phase 6 acceptance criterion.

## Wave 5.2: Timestep Controller Alignment

### Task 5.2.1: Fix breakpoint proximity comparison

- **Description**: The breakpoint-pop loop in `timestep.ts::accept()` (line 402) uses `>=` comparison to consume breakpoints. Must use ULP-based comparison with `delmin` band, matching ngspice dctran.c:553-554,628.

  Current: `simTime >= this._breakpoints[0]!.time`
  Correct: `almostEqualUlps(simTime, bp, 100) || bp - simTime <= delmin`

  **`delmin` definition** (matching ngspice CKTminStep):
  ```
  delmin = tStop * 1e-11   // ngspice sets CKTminStep = CKTfinalTime / 1e11 at transient init
  ```
  Added to `ResolvedSimulationParams` (or computed once in `TimestepController` constructor from `params.tStop`) and stored as `this._delmin`.

  **`almostEqualUlps(a, b, maxUlps)` definition** (IEEE-754 bit-integer distance):
  ```ts
  const buf = new ArrayBuffer(8);
  const f64 = new Float64Array(buf);
  const i64 = new BigInt64Array(buf);
  function almostEqualUlps(a: number, b: number, maxUlps: number): boolean {
    if (Number.isNaN(a) || Number.isNaN(b)) return false;
    if (Math.sign(a) !== Math.sign(b) && a !== 0 && b !== 0) return a === b;
    f64[0] = a; const ai = i64[0];
    f64[0] = b; const bi = i64[0];
    const diff = ai > bi ? ai - bi : bi - ai;
    return diff <= BigInt(maxUlps);
  }
  ```
  This compares 64-bit integer representations as signed-magnitude ULP distance. The buffer/view is a module-level singleton to avoid per-call allocation.

  ngspice reference: dctran.c:553-554 — `AlmostEqualUlps(time, bkpt, 100)`.

- **Files to modify**:
  - `src/solver/analog/timestep.ts` — Fix breakpoint-pop comparison in `accept()` (line 402) — this fix is in `accept()`, not `getClampedDt()`. Add `almostEqualUlps` utility function (module-level, reuses a singleton ArrayBuffer). Add `_delmin: number` field initialized from `params.tStop * 1e-11` in constructor.

- **Tests**:
  - `src/solver/analog/__tests__/timestep.test.ts::breakpoint_ulps_comparison` — Create a breakpoint at `bp = 1e-6`. Compute `simTimeClose = bp + 50_ulps` by loading `bp` into an ArrayBuffer + BigInt64Array, adding 50n, and reading back as Float64 (~ `1e-6 + 5.8e-21`). Step to `simTimeClose`. Assert breakpoint is consumed. Compute `simTimeFar = bp + 200_ulps` similarly. Assert stepping to `simTimeFar` does NOT consume the breakpoint.
  - `src/solver/analog/__tests__/timestep.test.ts::breakpoint_delmin_band` — With `tStop = 1e-3`, `delmin = 1e-14`. Create a breakpoint at `bp = 1e-6`. Step to `bp - delmin/2 = 1e-6 - 5e-15`. Assert breakpoint is consumed (within delmin band).

- **Acceptance criteria**:
  - Breakpoint hit detection in `accept()` uses ULP comparison + delmin band, matching ngspice.
  - `almostEqualUlps` is allocation-free after first call (module-level singleton buffer).

### Task 5.2.2: Fix first-step breakpoint gap formula

- **Description**: timestep.ts:316 — `nextBreakGap` uses `breaks[0] - simTime`. ngspice dctran.c:572-573 uses `breaks[1] - breaks[0]` (gap between first two breakpoints, not gap to current time).

  ngspice reference: dctran.c:572-573.

- **Files to modify**:
  - `src/solver/analog/timestep.ts` — Fix first-step gap formula to use `breaks[1] - breaks[0]`.

- **Tests**:
  - `src/solver/analog/__tests__/timestep.test.ts::first_step_gap_between_breakpoints` — Register breakpoints at t=0 and t=1e-4. Assert initial dt clamp uses gap = 1e-4 (break[1]-break[0]), not the distance from simTime to break[0].

- **Acceptance criteria**:
  - First-step breakpoint gap formula matches ngspice dctran.c:572-573.

### Task 5.2.3: Fix savedDelta capture timing

- **Description**: timestep.ts:306 — `_savedDelta` is captured every step. ngspice dctran.c:595 captures it only at breakpoint hit. Change to match.

  ngspice reference: dctran.c:595 — `saveDelta = delta` only inside the breakpoint-hit branch.

- **Files to modify**:
  - `src/solver/analog/timestep.ts` — Move `_savedDelta` capture into the breakpoint-hit branch of `getClampedDt`.

- **Tests**:
  - `src/solver/analog/__tests__/timestep.test.ts::savedDelta_only_at_breakpoint_hit` — Run several steps without hitting a breakpoint. Assert `_savedDelta` is unchanged. Then hit a breakpoint. Assert `_savedDelta` captures the pre-clamp dt.

- **Acceptance criteria**:
  - `_savedDelta` captured only on breakpoint hit, matching ngspice.

## Wave 5.3: PREDICTOR Audit

### Task 5.3.1: Verify predictor gate is off by default (audit-only)

- **Description**: Verify that the predictor code path is gated OFF by default (`this._params.predictor ?? false` at analog-engine.ts:376). Verify no code path calls `predictVoltages` or `computeAgp` without checking the gate.

  **`xfact` extrapolation is handled in Phase 6**, not here. The `LoadContext` interface is defined in Phase 6 Wave 6.1 (`src/solver/analog/load-context.ts`), and Phase 6 Task 6.1.1 adds `xfact: number` to that interface. The per-step `ctx.loadCtx.xfact` computation in the engine step loop is part of the Phase 6 element-migration work (each element's `load()` reads `ctx.loadCtx.xfact`). Phase 5 does not touch `ckt-context.ts` or `load-context.ts` for xfact.

  ngspice reference: `#ifndef PREDICTOR` blocks in every device load function.

- **Files to modify**: None (audit-only).

- **Tests**:
  - `src/solver/analog/__tests__/analog-engine.test.ts::predictor_gate_off_by_default` — Assert `predictVoltages` is never called during a 10-step transient simulation with default params.

- **Acceptance criteria**:
  - Predictor code gated off by default.
  - No `#ifndef PREDICTOR` equivalent code path is invoked with default params.
  - (`xfact` availability on `LoadContext` is a Phase 6 acceptance criterion, not Phase 5.)
