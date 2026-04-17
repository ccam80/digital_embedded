# Phase 6: Model Rewrites — Unified load() Interface

## Overview

Replace the split element interface (`stamp` + `stampNonlinear` + `updateOperatingPoint` + `stampReactiveCompanion`) with a single `load(ctx: LoadContext): void` method matching ngspice's `DEVload`. All ~65 analog element implementations rewritten atomically. No compatibility shims, no coexistence period.

**Testing surfaces:** Phase 6 is an engine-internal refactor. Per the master plan Testing Surface Policy, Phase 6 is satisfied by unit tests defined below (headless API surface) plus Phase 7 parity tests as the E2E surface. No per-phase MCP or Playwright tests are required.

**Wave 6.2 dependency:** Wave 6.2 tasks (6.2.1 through 6.2.7) operate on non-overlapping element files and are independent once Wave 6.1 (interface + `LoadContext`) is merged. Wave 6.3 cannot begin until every Wave 6.2 task has landed AND a full-codebase `tsc --noEmit` passes — this is the atomic-migration gate. No shims, no coexistence period.

**Scope additions folded from Phase 5:**
- The companion/charge/state loop deletions (originally Phase 5 Task 5.1.3) are now part of Phase 6 Wave 6.3 — see Task 6.3.3 below. Deletion lands atomically with the Wave 6.2 element rewrites that replace the loops.
- The `preIterationHook` closure elimination (originally Phase 5 Task 5.1.4) is absorbed by Wave 6.2 element `load()` migration — `load()` does per-iteration companion recomputation inline, making the hook dead code after Wave 6.2 completes. Its removal is part of Wave 6.3.
- The `xfact` field addition to `LoadContext` and per-step computation wiring (originally Phase 5 Task 5.3.1) is handled by Task 6.1.1 (interface field) and Wave 6.2 element implementations (which read `ctx.loadCtx.xfact`).

## Wave 6.1: Define LoadContext and New AnalogElement Interface

### Task 6.1.1: Define LoadContext interface

- **Description**: `LoadContext` is a pre-allocated mutable struct on `CKTCircuitContext`, passed to every `element.load()` call. Contains all state an element needs to read voltages, evaluate device equations, stamp the matrix, integrate reactive elements, and report limiting.

  ```typescript
  interface LoadContext {
    solver: SparseSolver;
    voltages: Float64Array;        // CKTrhsOld — previous NR solution
    iteration: number;             // iterno (0-based)
    initMode: InitMode;            // CKTmode & INITF
    dt: number;                    // CKTdelta (0 for DC)
    method: IntegrationMethod;     // CKTintegrateMethod
    order: number;                 // CKTorder
    deltaOld: readonly number[];   // CKTdeltaOld[7]
    ag: Float64Array;              // CKTag[] integration coefficients
    srcFact: number;               // CKTsrcFact for source stepping
    noncon: { value: number };     // CKTnoncon — mutable counter
    limitingCollector: LimitingEvent[] | null;
    isDcOp: boolean;
    isTransient: boolean;
    xfact: number;                 // #ifndef PREDICTOR extrapolation factor; engine sets ctx.loadCtx.xfact = deltaOld[0] / deltaOld[1] before each NR call
    gmin: number;                  // CKTgmin
    uic: boolean;                  // use initial conditions flag
    reltol: number;                // CKTreltol — passed through from CKTCircuitContext for element checkConvergence()
    iabstol: number;               // CKTabstol (current abstol) — passed through for element checkConvergence()
  }
  ```

  **Why `reltol`/`iabstol` are on `LoadContext`**: Task 6.1.2 changes the element interface method `checkConvergence(voltages, prevVoltages, reltol, iabstol): boolean` to `checkConvergence(ctx: LoadContext): boolean`. Moving these tolerances onto `LoadContext` is what enables that signature reduction; the NR-loop caller in Phase 2 already writes to `ctx.loadCtx` once per iteration, so no per-element allocation is introduced.

  `noncon` is a mutable ref object so that `element.load()` can increment it directly when limiting occurs, matching ngspice's `ckt->CKTnoncon++`.

- **Files to create**:
  - `src/solver/analog/load-context.ts` — `LoadContext` interface definition. `InitMode` type alias.

- **Files to modify**:
  - `src/solver/analog/ckt-context.ts` — Add `loadCtx: LoadContext` field, allocated in constructor.

- **Tests**:
  - `src/solver/analog/__tests__/ckt-context.test.ts::loadCtx_fields_populated` — Construct context for a circuit. Assert all LoadContext fields are defined and have correct types/defaults.

- **Acceptance criteria**:
  - `LoadContext` interface defined with all fields from the plan.
  - `CKTCircuitContext.loadCtx` pre-allocated, mutated per-iteration, never re-created.

### Task 6.1.2: Redefine AnalogElement interface with load()

- **Description**: Replace the split stamp methods with a single `load(ctx: LoadContext): void`. Remove the old methods from the interface. Add `accept()` for post-acceptance work, `checkConvergence()` with LoadContext parameter, and `getLteTimestep()` unchanged.

  New interface (replacing current element.ts):
  ```typescript
  interface AnalogElement {
    // Hot-path methods (called every NR iteration or every accepted step)
    load(ctx: LoadContext): void;
    accept?(ctx: LoadContext, simTime: number, addBreakpoint: (t: number) => void): void;
    checkConvergence?(ctx: LoadContext): boolean;
    getLteTimestep?(dt: number, deltaOld: readonly number[], order: number,
                    method: IntegrationMethod, lteParams: LteParams): number;

    // Cold-path methods (unchanged)
    setParam(key: string, value: number): void;
    setSourceScale?(factor: number): void;
    stampAc?(solver: ComplexSparseSolver, omega: number): void;
    primeJunctions?(): void;
    getPinCurrents(voltages: Float64Array): number[];

    // Metadata (unchanged)
    readonly pinNodeIds: readonly number[];
    readonly allNodeIds: readonly number[];
    readonly internalNodeLabels?: readonly string[];
    readonly branchIndex: number;
    readonly isNonlinear: boolean;
    readonly isReactive: boolean;
    label?: string;
    elementIndex?: number;

    // Breakpoints (unchanged)
    nextBreakpoint?(afterTime: number): number | null;
    registerRefreshCallback?(cb: () => void): void;
    acceptStep?(simTime: number, addBreakpoint: (t: number) => void): void;
  }
  ```

  Removed from interface:
  - `stamp(solver)` — absorbed into `load()`
  - `stampNonlinear?(solver)` — absorbed into `load()`
  - `updateOperatingPoint?(voltages, limitingCollector)` — absorbed into `load()`
  - `stampCompanion?(dt, method, voltages, order, deltaOld)` — absorbed into `load()`
  - `stampReactiveCompanion?(solver)` — absorbed into `load()`
  - `updateChargeFlux?(voltages, dt, method, order, deltaOld)` — absorbed into `load()`
  - `updateState?(dt, voltages)` — folded into `accept()`
  - `updateCompanion?(dt, method, voltages)` — folded into `accept()`
  - `shouldBypass?(voltages, prevVoltages)` — removed (ngspice bypass is device-internal, not interface-level)
  - `getBreakpoints?(tStart, tEnd)` — removed (replaced by `nextBreakpoint` + `acceptStep`)

  **Changed signatures (breaking):**
  - `checkConvergence?(voltages: Float64Array, prevVoltages: Float64Array, reltol: number, iabstol: number): boolean` → `checkConvergence?(ctx: LoadContext): boolean`.
    Rationale: `reltol` and `iabstol` are now fields on `LoadContext` (see Task 6.1.1). The NR-loop caller in `newton-raphson.ts` must be updated to pass `ctx.loadCtx` instead of the four-argument tuple. Phase 2 Task 2.2.2 already migrates convergence checking to an inline loop over `ctx.elementsWithConvergence`; that loop must pass `ctx.loadCtx` to each element's `checkConvergence`. This caller update is handled as part of Phase 2 Task 2.2.2's "Files to modify" for `newton-raphson.ts` — implementers applying Phase 2 must use the new single-argument form.
  - `accept?(simTime: number, addBreakpoint: (t: number) => void): void` — **expanded** to absorb `updateCompanion` and `updateState` post-acceptance responsibilities. New signature: `accept?(ctx: LoadContext, simTime: number, addBreakpoint: (t: number) => void): void`. The `ctx: LoadContext` parameter gives post-accept callers access to `dt`, `method`, and `voltages` needed for companion/state updates.

- **Files to modify**:
  - `src/solver/analog/element.ts` — Replace interface definition. Remove `stamp`, `stampNonlinear`, `updateOperatingPoint`, `stampCompanion`, `stampReactiveCompanion`, `updateChargeFlux`, `updateState`, `updateCompanion`, `shouldBypass`, `getBreakpoints`. Add `load(ctx: LoadContext): void`.

- **Tests**:
  - Compilation must succeed with all ~65 elements implementing the new interface (this is enforced by TypeScript after Task 6.2.*).

- **Acceptance criteria**:
  - `AnalogElement` interface has `load()` as the primary hot-path method.
  - No `stamp()`, `stampNonlinear()`, `updateOperatingPoint()`, `stampCompanion()`, `stampReactiveCompanion()` in the interface.

## Wave 6.2: Rewrite All Element Implementations

### Task 6.2.1: Rewrite passive linear elements (6 elements)

- **Description**: Convert Resistor, Potentiometer, NTC, LDR, Fuse, SparkGap to unified `load()`. These are the simplest — linear elements just read voltages and stamp conductance. Nonlinear ones (NTC, LDR, Fuse, SparkGap) add operating point evaluation.

  Each element's `load()` follows the order from plan Appendix D1 (Resistor example):
  1. Read terminal voltages from `ctx.voltages`
  2. Evaluate device equations
  3. Stamp conductance matrix and RHS

- **Files to modify**:
  - `src/components/passives/resistor.ts`
  - `src/components/passives/potentiometer.ts`
  - `src/components/sensors/ntc-thermistor.ts`
  - `src/components/sensors/ldr.ts`
  - `src/components/passives/analog-fuse.ts`
  - `src/components/sensors/spark-gap.ts`

- **Tests**:
  - `src/solver/analog/__tests__/mna-end-to-end.test.ts::resistor_load_interface` — Compile a resistive divider, run DC-OP via `load()` path. Assert correct node voltages.
  - Per-element DC-OP parity tests, added as new `it()` blocks in each element's existing test file (or created at the path given if none exists):
    - `src/components/passives/__tests__/resistor.test.ts::resistor_load_dcop_parity`
    - `src/components/passives/__tests__/potentiometer.test.ts::potentiometer_load_dcop_parity`
    - `src/components/sensors/__tests__/ntc-thermistor.test.ts::ntc_load_dcop_parity`
    - `src/components/sensors/__tests__/ldr.test.ts::ldr_load_dcop_parity`
    - `src/components/passives/__tests__/analog-fuse.test.ts::fuse_load_dcop_parity`
    - `src/components/sensors/__tests__/spark-gap.test.ts::spark_gap_load_dcop_parity`
  Each parity test builds a minimal circuit with the target element, runs DC-OP, and asserts node voltages match pre-rewrite references to bit-exact IEEE-754 precision. Spec author captures reference values by running the current implementation once and inlining the Float64 results as test literals.

- **Acceptance criteria**:
  - All 6 elements implement `load()`. No `stamp()` or `stampNonlinear()` methods remain.
  - DC-OP results bit-exact identical to pre-rewrite references.

### Task 6.2.2: Rewrite passive reactive elements (8 elements)

- **Description**: Convert Capacitor, PolarizedCap, Inductor, Transformer, TappedTransformer, Crystal, Memristor, TransmissionLine to unified `load()`. These add NIintegrate inline using `ctx.ag[]`, matching plan Appendix D2 (Capacitor example).

  `load()` order for reactive elements:
  1. Read terminal voltages
  2. Gate on transient/DC mode
  3. Handle initial conditions (initJct, initTran UIC)
  4. Compute charge/flux: Q = C*V or phi = L*I
  5. NIintegrate inline: `ccap = ag[0]*q0 + ag[1]*q1 + ...`
  6. Compute geq and ceq from ag[0] and ccap
  7. Stamp companion model (geq conductance + ceq current source)
  8. Store state for next iteration

- **Files to modify**:
  - `src/components/passives/capacitor.ts`
  - `src/components/passives/polarized-cap.ts`
  - `src/components/passives/inductor.ts`
  - `src/components/passives/transformer.ts`
  - `src/components/passives/tapped-transformer.ts`
  - `src/components/passives/crystal.ts`
  - `src/components/passives/memristor.ts`
  - `src/components/passives/transmission-line.ts`
  - `src/solver/analog/coupled-inductor.ts` — helper module called by Transformer and TappedTransformer. `stampCompanionModel()` (and any sibling helpers) accept `ctx.solver` extracted from `LoadContext` by the transformer's `load()`; no signature change is required on the helper beyond documenting that callers now pass `ctx.solver` (which is the same `SparseSolver` instance they previously passed directly). Add an acceptance criterion confirming the helper's behaviour is unchanged and transformers extract `ctx.solver` before invoking it.

- **Tests**:
  - `src/solver/analog/__tests__/rc-ac-transient.test.ts` — Existing RC transient test must pass with new `load()` path. Capacitor voltage must match expected exponential charging curve.
  - Per-element transient parity tests, added as new `it()` blocks in each element's existing test file:
    - `src/components/passives/__tests__/capacitor.test.ts::capacitor_load_transient_parity`
    - `src/components/passives/__tests__/polarized-cap.test.ts::polarized_cap_load_transient_parity`
    - `src/components/passives/__tests__/inductor.test.ts::inductor_load_transient_parity`
    - `src/components/passives/__tests__/transformer.test.ts::transformer_load_transient_parity`
    - `src/components/passives/__tests__/tapped-transformer.test.ts::tapped_transformer_load_transient_parity`
    - `src/components/passives/__tests__/crystal.test.ts::crystal_load_transient_parity`
    - `src/components/passives/__tests__/memristor.test.ts::memristor_load_transient_parity`
    - `src/components/passives/__tests__/transmission-line.test.ts::transmission_line_load_transient_parity`
  Each test builds a circuit exercising the target element with a pulse source, runs transient for a fixed number of accepted steps, and asserts node-voltage waveforms match pre-rewrite references bit-exact at a fixed set of sample times (spec author inlines Float64 references).

- **Acceptance criteria**:
  - All 8 elements implement `load()` with inline NIintegrate.
  - No calls to `integrateCapacitor()` or `integrateInductor()` from element code — integration is inline using `ctx.ag[]`.
  - Transient results bit-exact identical to pre-rewrite references.

### Task 6.2.3: Rewrite semiconductor elements (16 elements)

- **Description**: Convert all diode-family (5-6), BJT (2), FET (4), thyristor (3), and triode (1) elements to unified `load()`. These are the most complex — they include voltage limiting (pnjlim/fetlim), operating point evaluation, junction capacitance integration, and convergence checks.

  `load()` order matches plan Appendix D3 (Diode example):
  1. Read terminal voltages from `ctx.voltages`
  2. If `iteration > 0` or not initJct: apply voltage limiting (pnjlim/fetlim)
  3. If limiting occurred: `ctx.noncon.value++`
  4. If initJct or initFix: use junction initial conditions
  5. If `iteration === 0 && !isDcOp`: apply xfact extrapolation
  6. Evaluate device equations (currents, conductances)
  7. Stamp conductance matrix and RHS
  8. If reactive: inline NIintegrate, stamp companion model
  9. Store operating point

  Each element must have a `checkConvergence(ctx)` method matching its ngspice `DEVconvTest`.

- **Files to modify**:
  - `src/components/semiconductors/diode.ts`
  - `src/components/semiconductors/schottky.ts` — delegates to `createDiodeElement`; verify compile and runtime correctness after diode.ts migrates to the new factory signature. If `createDiodeElement` now takes `LoadContext`-related setup, update schottky's wrapper call accordingly.
  - `src/components/semiconductors/zener.ts`
  - `src/components/semiconductors/tunnel-diode.ts`
  - `src/components/semiconductors/varactor.ts`
  - `src/components/io/led.ts`
  - `src/components/semiconductors/bjt.ts`
  - `src/components/semiconductors/mosfet.ts` (via `src/solver/analog/fet-base.ts`)
  - `src/components/semiconductors/njfet.ts`
  - `src/components/semiconductors/pjfet.ts`
  - `src/components/semiconductors/scr.ts`
  - `src/components/semiconductors/triac.ts`
  - `src/components/semiconductors/diac.ts`
  - `src/components/semiconductors/triode.ts`
  - `src/solver/analog/fet-base.ts`

- **Tests**:
  - `src/solver/analog/__tests__/dcop-init-jct.test.ts` — Existing DC-OP junction init test must pass.
  - `src/solver/analog/__tests__/buckbjt-convergence.test.ts` — BJT convergence test must pass.
  - `src/solver/analog/__tests__/fet-base.test.ts` — FET base tests must pass.
  - One parity test per semiconductor family verifying DC-OP and transient behavior matches pre-rewrite results.

- **Acceptance criteria**:
  - All 16 semiconductor elements implement `load()` with inline limiting, integration, and convergence checks.
  - xfact extrapolation implemented in every element's initPred path.
  - DC-OP and transient results identical to pre-rewrite.

### Task 6.2.4: Rewrite source and controlled-source elements (9 elements + 1 base)

- **Description**: Convert DC/AC voltage sources, current source, variable rail, clock, and all 4 controlled sources (VCVS/VCCS/CCVS/CCCS) to unified `load()`. The shared `controlled-source-base.ts` must also be migrated. Sources are simpler — they stamp fixed values scaled by `ctx.srcFact` during source stepping.

- **Files to modify**:
  - `src/components/sources/dc-voltage-source.ts`
  - `src/components/sources/ac-voltage-source.ts`
  - `src/components/sources/current-source.ts`
  - `src/components/sources/variable-rail.ts`
  - `src/components/io/clock.ts`
  - `src/components/active/vcvs.ts`
  - `src/components/active/vccs.ts`
  - `src/components/active/ccvs.ts`
  - `src/components/active/cccs.ts`
  - `src/solver/analog/controlled-source-base.ts`

- **Tests**:
  - Existing source and controlled-source tests must pass.
  - One parity test per source type verifying DC-OP output matches pre-rewrite.

- **Acceptance criteria**:
  - All 12 source elements implement `load()`.
  - Source scaling via `ctx.srcFact` works correctly during DC-OP source stepping.

### Task 6.2.5: Rewrite active elements (7 elements)

- **Description**: Convert opamp, real-opamp, comparator, OTA, analog switch, 555 timer, optocoupler to unified `load()`.

- **Files to modify**:
  - `src/components/active/opamp.ts`
  - `src/components/active/real-opamp.ts`
  - `src/components/active/comparator.ts`
  - `src/components/active/ota.ts`
  - `src/components/active/analog-switch.ts`
  - `src/components/active/timer-555.ts`
  - `src/components/active/optocoupler.ts`
  - `src/components/active/schmitt-trigger.ts` (folded in from Task 6.2.7 per the "active/ directory alignment" rule)
  - `src/components/active/dac.ts` (folded in from Task 6.2.7)
  - `src/components/active/adc.ts` (folded in from Task 6.2.7)

- **Tests**:
  - All existing test files in `src/components/active/__tests__/` (and any `src/solver/analog/__tests__/*opamp*`, `*comparator*`, `*ota*`, `*switch*`, `*555*`, `*optocoupler*`, `*schmitt*`, `*dac*`, `*adc*` test files) must pass without tolerance changes under the new `load()` path.
  - **Parity test per element**: For each of the 10 elements, add a DC-OP correctness test in the element's existing test file (or, if none exists, create `src/components/active/__tests__/{name}-load.test.ts`). Each test builds a minimal circuit featuring that element, runs DC-OP, and asserts node voltages match pre-rewrite reference values to bit-exact IEEE-754 precision (spec author captures reference values by running the current implementation once and inlining the Float64 results in the test).

- **Acceptance criteria**:
  - All 10 active elements (including DAC/ADC/Schmitt-trigger folded from 6.2.7) implement `load()`.
  - Per-element DC-OP parity tests pass bit-exact against pre-rewrite references.

### Task 6.2.6: Rewrite behavioral digital elements

- **Description**: Convert all behavioral gates, flip-flops, MUX/DEMUX, counters, registers, and remaining behavioral elements (driver, relay, seven-seg, etc.) to unified `load()`. These are all nonlinear+reactive — they model digital logic with realistic analog voltage transitions.

- **Files to modify**:
  - `src/solver/analog/behavioral-gate.ts`
  - `src/solver/analog/behavioral-combinational.ts`
  - `src/solver/analog/behavioral-flipflop.ts`
  - `src/solver/analog/behavioral-flipflop/rs.ts`
  - `src/solver/analog/behavioral-flipflop/rs-async.ts`
  - `src/solver/analog/behavioral-flipflop/jk.ts`
  - `src/solver/analog/behavioral-flipflop/jk-async.ts`
  - `src/solver/analog/behavioral-flipflop/d-async.ts`
  - `src/solver/analog/behavioral-flipflop/t.ts` — **T flip-flop variant** (was missing from the original list). Implements `BehavioralTFlipflopElement` with old-interface methods `stamp`/`stampNonlinear`/`stampCompanion` that must all be migrated to `load()`.
  - `src/solver/analog/behavioral-sequential.ts`
  - `src/solver/analog/behavioral-remaining.ts`

- **Tests**:
  - All existing behavioral element tests must pass.
  - `src/solver/analog/__tests__/behavioral-gate.test.ts`
  - `src/solver/analog/__tests__/behavioral-flipflop.test.ts`
  - `src/solver/analog/__tests__/behavioral-sequential.test.ts`
  - `src/solver/analog/__tests__/behavioral-combinational.test.ts`
  - `src/solver/analog/__tests__/behavioral-remaining.test.ts`

- **Acceptance criteria**:
  - No class or factory in the listed files retains `stamp()`, `stampNonlinear()`, `stampCompanion()`, `updateOperatingPoint()`, or `stampReactiveCompanion()` methods. (Verified programmatically — a grep over the listed files must return zero matches; TypeScript compilation must succeed with the new interface in place.)
  - Edge detection and latching behavior preserved.

### Task 6.2.7: Rewrite bridge adapters, probes, and switches (5 elements)

- **Description**: Convert bridge adapters (BridgeInput, BridgeOutput), probe, ground, and switches (SPST `switch.ts`, SPDT `switch-dt.ts`) to unified `load()`. (DAC, ADC, and Schmitt trigger were moved to Task 6.2.5 to align with the `src/components/active/` directory. No `break-before-make` file exists — the earlier description's reference to that was incorrect and is removed.)

- **Files to modify**:
  - `src/solver/analog/bridge-adapter.ts`
  - `src/components/io/probe.ts`
  - `src/components/io/ground.ts`
  - `src/components/switching/switch.ts`
  - `src/components/switching/switch-dt.ts`

- **Tests**:
  - All existing bridge, switch, and misc element tests must pass.

- **Acceptance criteria**:
  - All remaining elements implement `load()`.
  - No element in the codebase has `stamp()`, `stampNonlinear()`, `updateOperatingPoint()`, `stampCompanion()`, or `stampReactiveCompanion()` methods.

## Wave 6.3: Update Test Infrastructure

### Task 6.3.1: Rewrite test mock elements

- **Description**: Test helpers that create mock `AnalogElement` objects must implement `load(ctx)` instead of the old split methods. The test helper at `src/solver/analog/__tests__/test-helpers.ts` (if it exists) or inline mocks in test files must be updated.

- **Files to modify**:
  - All test files in `src/solver/analog/__tests__/` that create mock elements — update to implement `load()`.

- **Tests**:
  - All existing tests must pass with updated mocks.

- **Acceptance criteria**:
  - No test file references `stamp()`, `stampNonlinear()`, `updateOperatingPoint()`, `stampCompanion()`, or `stampReactiveCompanion()` as element methods.

### Task 6.3.2: Delete integrateCapacitor and integrateInductor

- **Description**: With all elements performing NIintegrate inline in their `load()` using `ctx.ag[]`, the `integrateCapacitor` and `integrateInductor` functions in integration.ts are dead code. Delete them.

  Keep: `computeNIcomCof` (called by the engine to populate `ctx.ag[]`), `HistoryStore`, `NodeVoltageHistory`, `solveGearVandermonde` (used by `computeNIcomCof`).

- **Files to modify**:
  - `src/solver/analog/integration.ts` — Delete `integrateCapacitor` and `integrateInductor` functions.

- **Tests**:
  - `src/solver/analog/__tests__/integration.test.ts` — Remove tests for deleted functions. Keep tests for `computeNIcomCof`, `HistoryStore`, `solveGearVandermonde`.

- **Acceptance criteria**:
  - `integrateCapacitor` and `integrateInductor` do not exist.
  - No element imports them.

### Task 6.3.3: Delete engine-side companion/charge/state loops (moved from Phase 5 Task 5.1.3)

- **Description**: After Wave 6.2 lands and every element's `load()` handles its own stamping, charge/flux integration, and companion-model recomputation internally, the four engine-side post-NR loops become dead code. Delete them atomically:

  - `updateChargeFlux` loop in `analog-engine.ts` (charge/flux updates absorbed into `load()`).
  - `stampCompanion` pre-NR loop in `analog-engine.ts` (companion stamping absorbed into `load()`).
  - `updateCompanion` post-accept loop in `analog-engine.ts` (folded into each element's `accept(ctx, simTime, addBreakpoint)`).
  - `updateState` post-accept loop in `analog-engine.ts` (folded into each element's `accept(ctx, simTime, addBreakpoint)`).

  Keep the `computeNIcomCof` call (writing into `ctx.ag[]`) immediately before each NR call — elements read `ctx.ag[]` via `ctx.loadCtx.ag`.

  Also delete the `preIterationHook` closure (analog-engine.ts) at this point — it was kept alive through Phase 5 intentionally; Wave 6.2 `load()` absorbs its responsibility, making it dead code.

  Also set `ctx.loadCtx.xfact = ctx.deltaOld[0] / ctx.deltaOld[1]` in the engine step loop before each NR call so every element's `load()` can read it (fulfils the xfact portion deferred from Phase 5 Task 5.3.1).

  ngspice reference: dctran.c — all device work happens inside DEVload (NR loop) and DEVaccept (post-acceptance). No separate companion/charge/state loops.

- **Files to modify**:
  - `src/solver/analog/analog-engine.ts` — Delete the four post-NR loops. Delete the `preIterationHook` closure creation. Add the per-step `ctx.loadCtx.xfact` assignment before each NR call.

- **Tests**:
  - `src/solver/analog/__tests__/analog-engine.test.ts::rc_transient_without_separate_loops` — Run an RC transient simulation. Assert correct voltage waveform (capacitor charges exponentially). Validates that `load()` handles all stamp/charge/companion work internally.
  - `src/solver/analog/__tests__/analog-engine.test.ts::xfact_computed_from_deltaOld` — After 2 accepted steps with `dt=1e-7` then `dt=2e-7`, assert `ctx.loadCtx.xfact === 1e-7 / 2e-7 === 0.5` when the engine enters the third step.
  - `src/solver/analog/__tests__/analog-engine.test.ts::no_closures_in_step` — Using the monkey-patch pattern from Phase 1, wrap `Function.prototype.bind` and arrow-function creation proxies. Run 10 transient steps and assert zero closures created after the first step.

- **Acceptance criteria**:
  - No separate `updateChargeFlux`, `stampCompanion`, `updateCompanion`, `updateState` loops in `step()`.
  - No per-step arrow functions or closures created.
  - `ctx.loadCtx.xfact` is written once per step and read by every element's `load()`.
  - All device work happens inside `element.load()` (NR loop) and `element.accept(ctx, simTime, addBreakpoint)` (post-acceptance).

### Task 6.3.4: Delete `SparseSolver.stamp(row, col, value)` method

- **Description**: After every element, MNAAssembler descendant, bridge-adapter, behavioural helper, and test fixture has been migrated to the handle-based API (`allocElement` at compile time + `stampElement` in the hot path), the value-addressed convenience method `stamp(row, col, value)` on `SparseSolver` is dead code. Delete it.

  Phase 0 left the method in place as a working value-addressed wrapper (it calls `allocElement` then `stampElement`) so that Phase 0 could land before the 65+ element rewrites in Wave 6.2. Wave 6.2 migrates those callers. Wave 6.3 is the atomic deletion point.

- **Files to modify**:
  - `src/solver/analog/sparse-solver.ts` — Delete the `stamp(row, col, value): number` method.
  - Any remaining test fixtures or helpers still using `solver.stamp(...)` — migrate to `allocElement` + `stampElement`.

- **Tests**:
  - No new tests; the existing targeted sparse-solver and MNA tests must pass. Full-codebase `tsc --noEmit` must succeed (no callers remain).

- **Acceptance criteria**:
  - `SparseSolver.stamp(row, col, value)` does not exist.
  - Zero grep hits for `.stamp(` on a `SparseSolver` instance anywhere in `src/` or test fixtures.
  - All targeted sparse-solver / newton-raphson / element tests remain green after the deletion.
