# Phase 7: Verification

## Overview

Per-NR-iteration numerical comparison against ngspice using the instrumented test harness. Every node voltage, device state, convergence flag, and mode transition must match ngspice's default build to **exact IEEE-754 bit equality (absDelta === 0)**. Zero tolerance for numerical divergence — this is the authoritative tolerance contract for all parity assertions in this phase.

**Testing surfaces:** Phase 7 IS the E2E surface for the entire ngspice-alignment initiative. Its harness-based tests validate the complete engine stack against ngspice. No additional MCP or Playwright tests are required beyond the parity tests defined below; Phase 7 satisfies the Three-Surface Testing Rule E2E surface for Phases 0–6.

**Wave separation:**

- **Wave 7.1 (infrastructure)** delivers `parity-helpers.ts` and extends harness capture with `lteDt`. Unit-testable. Must land before any Wave 7.2–7.4 test can execute.
- **Waves 7.2–7.4 (parity tests)** execute the 8 parity circuits against ngspice. These tests may only run after Phases 0–6 and Wave 7.1 are all complete; they are diagnostic — failures indicate a spec bug or an implementation bug in one of the earlier phases, not something to be "fixed" inside Phase 7 itself. The parity tests never edit implementation code; their output is either a bit-exact pass or a divergence report identifying the earliest diverging step/iteration and the specific `IterationSnapshot` field that mismatches.

## Wave 7.1: Parity Test Infrastructure

### Task 7.1.1: Create ngspice parity test suite

- **Description**: Create a dedicated test directory for ngspice comparison tests. Each test loads a `.dts` circuit fixture via `ComparisonSession`, runs both engines, and compares per-iteration data using the harness pattern already used by `buckbjt-smoke.test.ts`.

  The harness captures from both engines per NR iteration:
  - `rhsOld[]` (all node voltages)
  - `state0[]` (all device states — slot names resolved via `DEVICE_MAPPINGS`)
  - `noncon` (convergence flag counter)
  - `diagGmin` (diagonal conductance)
  - `srcFact` (source stepping factor)
  - `initMode` (INITF mode)
  - `order` (integration order)
  - `delta` (timestep)
  - `lteDt` (LTE-proposed next timestep — new field added per Task 7.1.2 below)

  **Comparison tolerance is `absDelta === 0`** (exact IEEE-754 bit equality). Any divergence fails the test with the exact step/iteration number, field name, our value, ngspice value, and absolute difference.

- **Files to create**:
  - `src/solver/analog/__tests__/ngspice-parity/parity-helpers.ts`

- **parity-helpers.ts contents (authoritative signatures):**
  ```typescript
  import { accessSync } from "node:fs";
  import type { CaptureSession, IterationSnapshot } from "../../../harness/types";
  import { describe } from "vitest";

  export const DLL_PATH = "C:/local_working_projects/digital_in_browser/third_party/ngspice/bin/ngspice.dll";

  let _dllAvailable: boolean | null = null;
  export function dllAvailable(): boolean {
    if (_dllAvailable !== null) return _dllAvailable;
    try { accessSync(DLL_PATH); _dllAvailable = true; }
    catch { _dllAvailable = false; }
    return _dllAvailable;
  }

  export const describeIfDll: typeof describe = dllAvailable() ? describe : describe.skip;

  /**
   * Assert that two IterationSnapshots match bit-exact across rhsOld[], state0[],
   * noncon, diagGmin, srcFact, initMode, order, delta, lteDt.
   * Throws via vitest `expect()` on any mismatch. Error message includes
   * step/iter context, field name, ours, ngspice, absDelta.
   */
  export function assertIterationMatch(
    ours: IterationSnapshot,
    ngspice: IterationSnapshot,
    ctx: { stepIndex: number; iterIndex: number }
  ): void;

  /** Compare the ordered sequence of initMode values across all steps/iterations. */
  export function assertModeTransitionMatch(
    ours: CaptureSession,
    ngspice: CaptureSession
  ): void;

  /**
   * Compare convergence scalars (noncon, diagGmin, srcFact) at every NR iteration
   * across both sessions. Fields inactive in a circuit are still asserted equal
   * (both engines produce the same zero/unused value).
   */
  export function assertConvergenceFlowMatch(
    ours: CaptureSession,
    ngspice: CaptureSession
  ): void;
  ```

  `assertIterationMatch` MUST compare **state0[] device-state slots** (resolved via `DEVICE_MAPPINGS`) in addition to `rhsOld[]`. All per-circuit tasks inherit this requirement automatically; they do not need to re-specify state0[] slots.

  `assertConvergenceFlowMatch` MUST compare noncon at every NR iteration, diagGmin at every gmin-stepping sub-solve, and srcFact at every source-stepping step. All per-circuit tasks inherit this requirement.

- **Tests**:
  - `parity-helpers.ts` contains no independently-runnable tests; helper correctness is transitively validated through Tasks 7.2.1–7.4.1.

- **Acceptance criteria**:
  - All three helpers implemented with the exact TypeScript signatures above.
  - `DLL_PATH` + `describeIfDll` centralised; every parity test uses `describeIfDll(...)` instead of raw `describe(...)`.
  - Comparison uses `absDelta === 0` throughout (exact IEEE-754 match, not relative/absolute tolerance).
  - Supports both DC-OP (per-NR-iteration) and transient (per-step, per-NR-iteration) comparison modes.

### Task 7.1.2: Extend harness capture to include lteDt

- **Description**: The LTE-proposed next timestep is an observable parity field in ngspice (`RawNgspiceOuterEvent.nextDelta` at the outer event level) but is not currently captured from our engine. Extend `NRAttempt` (or the outer step event struct) with `lteDt: number` and populate it from our `TimestepController`'s proposed dt after the LTE check.

- **Files to modify**:
  - `src/harness/types.ts` — Add `lteDt?: number` to `NRAttempt` or `StepSnapshot`.
  - `src/harness/capture.ts` — Read the LTE-proposed dt from the engine and write into the snapshot.
  - `src/harness/ngspice-bridge.ts` — Read `RawNgspiceOuterEvent.nextDelta` and map it into the same field on the ngspice session's `IterationSnapshot`.

- **Tests**:
  - `src/harness/__tests__/capture.test.ts::lteDt_captured_from_ours` — Run a short transient; assert `lteDt` is a finite positive number on every accepted step.
  - `src/harness/__tests__/ngspice-bridge.test.ts::lteDt_captured_from_ngspice` — Run ngspice under `describeIfDll`; assert `lteDt` present on every outer step.

- **Acceptance criteria**:
  - `IterationSnapshot.lteDt` populated for both engines, enabling `assertIterationMatch` to compare it bit-exact.

## Wave 7.2: DC-OP Parity Tests

All tasks in this wave use `ComparisonSession({ dtsPath, dllPath: DLL_PATH })` following the existing `buckbjt-smoke.test.ts` pattern, wrap tests in `describeIfDll(...)`, and call `assertIterationMatch`, `assertModeTransitionMatch`, and `assertConvergenceFlowMatch` from `parity-helpers.ts` (so state0[]/noncon/diagGmin/srcFact/mode-sequence comparisons are inherited automatically — per-task assertions need only call these helpers).

### Task 7.2.1: Resistive divider DC-OP parity

- **Description**: Two resistors in series. Tests linear stamp correctness. Must converge in exactly 1 NR iteration after `initJct`→`initFix`→`initFloat`.

- **Circuit**: `R1=1kΩ` from node `in` to `mid`, `R2=1kΩ` from `mid` to `gnd`. Voltage source `V1=5V` at `in`.

- **Files to create**:
  - `src/solver/analog/__tests__/ngspice-parity/fixtures/resistive-divider.dts` — Fixture loadable via `DefaultSimulatorFacade`.
  - `src/solver/analog/__tests__/ngspice-parity/resistive-divider.test.ts`

- **Tests**:
  - `resistive-divider.test.ts::dc_op_iteration_match` — Run DC-OP on both engines via `ComparisonSession`. For every step/iteration pair, call `assertIterationMatch(ours, ngspice, { stepIndex, iterIndex })`. Call `assertModeTransitionMatch` and `assertConvergenceFlowMatch` once at end. Additionally assert NR iteration count equal between engines.

- **Acceptance criteria**:
  - `absDelta === 0` on all per-iteration rhsOld[], state0[], mode transitions, noncon, diagGmin, srcFact, iteration count.

### Task 7.2.2: Diode + resistor DC-OP parity

- **Description**: Single diode in series with resistor. Tests pnjlim, mode transitions, noncon tracking.

- **Circuit**: `V1=1V` source at `in`, `R1=1kΩ` from `in` to `anode`, `D1` diode (`Is=1e-14`, `N=1`) from `anode` to `gnd`.

- **Files to create**:
  - `src/solver/analog/__tests__/ngspice-parity/fixtures/diode-resistor.dts`
  - `src/solver/analog/__tests__/ngspice-parity/diode-resistor.test.ts`

- **Tests**:
  - `diode-resistor.test.ts::dc_op_pnjlim_match` — Same pattern as Task 7.2.1. `assertIterationMatch` at every step/iter; `assertModeTransitionMatch`; `assertConvergenceFlowMatch`; NR iteration count equal.

- **Acceptance criteria**:
  - pnjlim produces bit-exact voltage limiting at every iteration.
  - Convergence path (noncon sequence, iteration count) matches exactly.

### Task 7.2.3: BJT common-emitter DC-OP parity

- **Description**: NPN BJT with biasing resistors. Tests multi-junction limiting and (if required for convergence) gmin stepping.

- **Circuit**: `V_CC=5V` at `vcc`, `R_C=1kΩ` from `vcc` to `collector`, `R_B=100kΩ` from `vcc` to `base`, `Q1` NPN BJT (`Is=1e-14`, `Bf=100`, `Br=1`) with `collector` → `base` → `emitter=gnd`.

- **Files to create**:
  - `src/solver/analog/__tests__/ngspice-parity/fixtures/bjt-common-emitter.dts`
  - `src/solver/analog/__tests__/ngspice-parity/bjt-common-emitter.test.ts`

- **Tests**:
  - `bjt-common-emitter.test.ts::dc_op_match` — `assertIterationMatch` at every step/iter (covers rhsOld, state0, noncon, diagGmin, srcFact, mode). `assertModeTransitionMatch`. `assertConvergenceFlowMatch`. Iteration count equal.

- **Acceptance criteria**:
  - DC-OP convergence method (direct, gmin-stepping, or source-stepping) matches ngspice's choice.
  - All per-iteration node voltages, device-state slots, and convergence scalars match bit-exact.

### Task 7.2.4: Op-amp inverting amplifier DC-OP parity

- **Description**: Op-amp with feedback resistors. Tests source stepping.

- **Circuit**: `V_IN=1V` at `in`, `R_IN=10kΩ` from `in` to `inverting` node, `R_F=100kΩ` feedback from `out` to `inverting`. Op-amp with `+in=gnd`, `-in=inverting`, `out=out` (use `real-opamp` with `gain=1e5`, `V_SUPPLY=±15V` rails).

- **Files to create**:
  - `src/solver/analog/__tests__/ngspice-parity/fixtures/opamp-inverting.dts`
  - `src/solver/analog/__tests__/ngspice-parity/opamp-inverting.test.ts`

- **Tests**:
  - `opamp-inverting.test.ts::dc_op_source_stepping_match` — `assertIterationMatch` at every step/iter. `assertModeTransitionMatch`. `assertConvergenceFlowMatch` (verifies srcFact sequence bit-exact).

- **Acceptance criteria**:
  - Source-stepping sequence and per-iteration voltages match ngspice exactly.

## Wave 7.3: Transient Parity Tests

All tasks in this wave use `ComparisonSession({ dtsPath, dllPath: DLL_PATH })`, wrap in `describeIfDll(...)`, and call `assertIterationMatch` + `assertModeTransitionMatch` + `assertConvergenceFlowMatch` from `parity-helpers.ts`. Tests run to a fixed `stopTime` (not a fixed step count). lteDt comparison is inherited from `assertIterationMatch` since Task 7.1.2 adds it to `IterationSnapshot`.

### Task 7.3.1: RC circuit transient parity

- **Description**: RC series circuit with pulse source. Tests NIintegrate for capacitor, LTE timestep estimation, order promotion.

- **Circuit**: `V1` pulse source (`V_low=0V`, `V_high=1V`, `t_delay=0`, `t_rise=1ns`, `t_fall=1ns`, `t_width=1ms`, `t_period=2ms`). `R1=1kΩ` from `V1` to `cap_top`. `C1=1µF` from `cap_top` to `gnd`.
- **Simulation params**: `stopTime=2ms`, `maxStep=10µs`, method `trapezoidal`, default `reltol=1e-3`, `abstol=1e-12`, `chgtol=1e-14`.

- **Files to create**:
  - `src/solver/analog/__tests__/ngspice-parity/fixtures/rc-transient.dts`
  - `src/solver/analog/__tests__/ngspice-parity/rc-transient.test.ts`

- **Tests**:
  - `rc-transient.test.ts::transient_per_step_match` — For each accepted step, call `assertIterationMatch(ours, ngspice, ...)` on every NR iteration (this covers dt, order, method, rhsOld, state0, lteDt bit-exact). `assertModeTransitionMatch` and `assertConvergenceFlowMatch` at end.

- **Acceptance criteria**:
  - Every accepted timestep's dt, order, method, rhsOld[], state0[], and lteDt match ngspice bit-exact.

### Task 7.3.2: RLC oscillator transient parity

- **Description**: RLC series circuit with AC source. Tests inductor integration and ringing.

- **Circuit**: AC sinusoidal source `V1=1V` peak at `1592Hz` (≈ resonant freq of `1/(2π√(LC))` with `L=10mH`, `C=1µF`, giving fundamental ring). `R1=10Ω` series (low damping). `L1=10mH`. `C1=1µF`.
- **Simulation params**: `stopTime=4ms`, `maxStep=1µs`.

- **Files to create**:
  - `src/solver/analog/__tests__/ngspice-parity/fixtures/rlc-oscillator.dts`
  - `src/solver/analog/__tests__/ngspice-parity/rlc-oscillator.test.ts`

- **Tests**:
  - `rlc-oscillator.test.ts::transient_oscillation_match` — `assertIterationMatch` at every step/iter. `assertModeTransitionMatch`. `assertConvergenceFlowMatch`. Additionally assert the capacitor voltage peak over step indices 0..200 exceeds `0.5V` (sanity check that oscillation actually occurs, not that both engines converged to zero).

- **Acceptance criteria**:
  - Per-step node voltages match ngspice bit-exact.
  - Oscillation actually occurs (peak > 0.5V confirmed).
  - `currentMethod === "trapezoidal"` at every accepted step (no method switching).

### Task 7.3.3: Diode bridge rectifier transient parity

- **Description**: Four diodes in bridge configuration with AC source and capacitor filter. Tests multi-junction limiting and breakpoint handling.

- **Circuit**: AC source `V1=1V` peak sinusoid at `60Hz`, differential across `ac_p`/`ac_n`. Four diodes (`Is=1e-14`, `N=1`) in standard full-wave bridge between `ac_p`/`ac_n` and `vout_p`/`gnd`. `R_load=1kΩ` from `vout_p` to `gnd`. `C_filter=100µF` from `vout_p` to `gnd`.
- **Simulation params**: `stopTime=33.3ms` (≈ 2 full 60Hz cycles), `maxStep=100µs`.

- **Files to create**:
  - `src/solver/analog/__tests__/ngspice-parity/fixtures/diode-bridge.dts`
  - `src/solver/analog/__tests__/ngspice-parity/diode-bridge.test.ts`

- **Tests**:
  - `diode-bridge.test.ts::transient_rectification_match` — `assertIterationMatch` at every step/iter (captures per-iteration parity, including breakpoint landing). `assertModeTransitionMatch`. `assertConvergenceFlowMatch`. Additionally compare the sequence of breakpoint consumption times between sessions: every consumed breakpoint's time must match bit-exact (`absDelta === 0`).

- **Acceptance criteria**:
  - Breakpoint times match ngspice to exact IEEE-754 (absDelta === 0).
  - Diode switching transients match bit-exact.

### Task 7.3.4: MOSFET inverter transient parity

- **Description**: NMOS inverter with resistive load. Tests fetlim and FET device equations in DC-OP + transient.

- **Circuit**: `V_DD=5V` at `vdd`. `R_D=10kΩ` from `vdd` to `vout`. NMOS (`Vto=1V`, `Kp=50e-6`, `W=10µm`, `L=1µm`, `Lambda=0.02`) with drain=`vout`, source=`gnd`, body=`gnd`, gate=`vin`. `V_IN` pulse at gate: `V_low=0V`, `V_high=5V`, `t_rise=1ns`, `t_fall=1ns`, `t_width=50µs`, `t_period=100µs`, `t_delay=0`.
- **Simulation params**: DC-OP first (with `V_IN=0V`), then transient `stopTime=200µs`, `maxStep=1µs`.

- **Files to create**:
  - `src/solver/analog/__tests__/ngspice-parity/fixtures/mosfet-inverter.dts`
  - `src/solver/analog/__tests__/ngspice-parity/mosfet-inverter.test.ts`

- **Tests**:
  - `mosfet-inverter.test.ts::dc_op_match` — DC-OP phase: `assertIterationMatch` per iter; `assertModeTransitionMatch`; `assertConvergenceFlowMatch`.
  - `mosfet-inverter.test.ts::transient_match` — Transient phase after DC-OP: same helper pattern, all per-step/iter assertions bit-exact.

- **Acceptance criteria**:
  - fetlim produces bit-exact results at every NR iteration.
  - DC-OP and transient node voltages and state0[] match ngspice bit-exact.

## Wave 7.4: Convergence Flow Verification (audit-only)

### Task 7.4.1: Confirm mode-transition coverage across Waves 7.2–7.3

- **Description**: Mode-transition assertions are now an **integrated requirement** of every Wave 7.2 and 7.3 task — each task's test body explicitly calls `assertModeTransitionMatch(ours, ngspice)` using the helper from `parity-helpers.ts`. Task 7.4.1 is an audit-only coverage check: inspect each of the 8 parity test files to confirm the `assertModeTransitionMatch` call is present and reaches the end-of-test site (not inside a skip-gated branch).

  Expected DC-OP sequence: `initJct` → `initFix` → `initFloat` → converge (or → gmin stepping → ...).
  Expected transient step 0: `initTran` → `initFloat` → converge.
  Expected transient step N: `initPred` → `initFloat` → converge.

- **Files to modify**: None.

- **Tests**: None new — coverage is inherited from Wave 7.2/7.3 tests.

- **Acceptance criteria**:
  - All 8 parity test files contain an `assertModeTransitionMatch(ours, ngspice)` call that executes on every run.
  - Mode transition sequences match ngspice for all 8 test circuits (enforced by the helper — bit-exact `initMode` equality throughout).
  - No extra or missing mode transitions compared to ngspice.
