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
  - `src/core/analog-types.ts` — `AnalogElementCore` is the upstream interface that `AnalogElement` extends. It MUST be kept in lockstep: remove the same methods (`stamp`, `stampNonlinear`, `updateOperatingPoint`, `stampCompanion`, `stampReactiveCompanion`, `updateChargeFlux`, `updateState`, `updateCompanion`, `shouldBypass`, `getBreakpoints`) from `AnalogElementCore` and add `load(ctx: LoadContext): void`. Two sibling interfaces with different method sets is a shim by construction — both must reflect the post-Wave-6.1 shape atomically.

- **Tests**:
  - Compilation must succeed with all ~65 elements implementing the new interface (this is enforced by TypeScript after Task 6.2.*).

- **Acceptance criteria**:
  - `AnalogElement` interface has `load()` as the primary hot-path method.
  - No `stamp()`, `stampNonlinear()`, `updateOperatingPoint()`, `stampCompanion()`, `stampReactiveCompanion()` in **either** `AnalogElement` (element.ts) or `AnalogElementCore` (core/analog-types.ts).

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

## Wave 6.4: Digital Pin Models in cktLoad

Replace the split-interface digital pin models (`DigitalOutputPinModel`, `DigitalInputPinModel`) with unified `load(ctx: LoadContext)` / `accept(ctx, voltage)` methods. Resolve loading-mode at compile time using the compiler's existing `digitalPinLoading` + `perNetLoadingOverrides` mechanism and thread the resolution into behavioural factories via a new `_pinLoading` key on the PropertyBag.

**Why this wave exists.** The digital pin models are sub-components owned by behavioural elements (gates, flip-flops, combinational, sequential, remaining). Without this wave, Wave 6.2.6's behavioural-element `load()` rewrites still delegate to `pinModel.stamp(solver)` / `pinModel.stampOutput(solver)` / `pinModel.stampCompanion(solver, dt, method)` — the old split interface at the sub-component level. That leaves two layers of interface, one migrated and one not, which is exactly the kind of partial migration the master plan bans. Wave 6.4 brings the pin-model layer into cktLoad world.

**Dependencies.** Wave 6.4 depends on Wave 6.1 (`LoadContext` + `AnalogElement` interface) and Wave 6.2 (behavioural element `load()` exists to delegate from). Within Phase 6, Wave 6.4 runs after 6.2; it is independent of 6.3 and may land in parallel with it.

**Mode resolution.** Compile-time, cached on the pin-model instance. No runtime map lookup on the hot path. Mode resolves per-pin using the compiler's existing rule (mirror of the bridge-adapter resolution at `compiler.ts:1281-1295`): consult `perNetLoadingOverrides.get(nodeId)` first — if present, use `override === "loaded"`; otherwise use circuit-level `digitalPinLoading` — `"none"` → false, `"all"` → true, `"cross-domain"` → true iff the pin bridges analog/digital domains. Result is a boolean `loaded` per pin, frozen for the lifetime of the compiled circuit.

**Role tag on output pins.** `DigitalOutputPinModel` takes a `role: "branch" | "direct"` constructor argument. `"branch"` stamps the ideal voltage-source branch-equation form — used by bridge-output adapters. `"direct"` stamps the conductance+current-source form — used by behavioural elements that share the output node with their truth-table NR loop. Role is orthogonal to loaded / ideal and is frozen at construction.

**Introspection policy.** `DigitalOutputPinModel.loaded` and `DigitalInputPinModel.loaded` are exposed as read-only getters for diagnostics and debug overlays. **No call site outside `digital-pin-model.ts` may branch on `pinModel.loaded` to alter its own stamping behaviour.** The getter is for observation only; the stamp shape is entirely the pin model's responsibility.

**readLogicLevel stays outside cktLoad.** `DigitalInputPinModel.readLogicLevel(voltage)` is sense-only — it reads a voltage against `vIH` / `vIL` thresholds and returns a logic level. Behavioural elements call it after `load()` when they need logic-level readout; it is not folded into `load()`.

### Task 6.4.1: Thread resolved per-pin loading mode from compiler to behavioural factories

- **Description**: Extend the compiler's per-pin loading-mode resolution (today applied at `compiler.ts:1281-1295` only to bridge adapters) so every behavioural element's factory receives a per-pin-label loaded map. Write the resolved map into the `PropertyBag` under a new reserved key `_pinLoading`, alongside the existing `_pinElectrical` entry. Behavioural factories read this key during pin-model construction; factories that don't care simply ignore it.

  Key shape:
  ```typescript
  _pinLoading: Record<string, boolean>
  // e.g. { "In_1": true, "In_2": true, "out": true }
  ```
  Keys align with `_pinElectrical` keys so both are looked up the same way. `true` when the compiler resolved that pin to loaded, `false` for ideal.

  Resolution rule is the same as the existing bridge-adapter logic — factor it out of the bridge-adapter code path into a shared helper (e.g. `resolvePinLoading(nodeId, mode, overrides, isCrossDomain): boolean`) that both call sites invoke.

- **Files to modify**:
  - `src/solver/analog/compiler.ts` — In the element-compilation loop, before invoking the analog factory for each element, compute `_pinLoading` for the element's pins by calling the shared helper for each (pinLabel → nodeId) pair, then set it on `props` (PropertyBag). Factor the existing bridge-adapter resolution into the shared helper.

- **Tests**:
  - `src/solver/analog/__tests__/compiler.test.ts::pin_loading_threaded_for_behavioural_gate_all_mode` — compile a circuit containing a NAND gate with `digitalPinLoading: "all"`; assert the factory is invoked with `_pinLoading: { "In_1": true, "In_2": true, "out": true }` on the PropertyBag.
  - `src/solver/analog/__tests__/compiler.test.ts::pin_loading_threaded_for_behavioural_gate_none_mode` — same circuit with `digitalPinLoading: "none"`; assert every `_pinLoading` entry is `false`.
  - `src/solver/analog/__tests__/compiler.test.ts::pin_loading_respects_per_net_override` — circuit with default mode plus `perNetLoadingOverrides` forcing one net to `"ideal"`; assert the corresponding pin entry is `false` while others remain `true`.
  - `src/solver/analog/__tests__/compiler.test.ts::pin_loading_helper_shared_with_bridge_adapter` — instantiate a circuit that drives both a bridge-output adapter and a behavioural gate from the same overridden net; assert both resolve to the same loaded value (same underlying helper call).

- **Acceptance criteria**:
  - Every behavioural element's `PropertyBag` carries a `_pinLoading: Record<string, boolean>` entry whose keys match `_pinElectrical` keys.
  - The bridge-adapter resolution and the behavioural-factory resolution call the same shared helper — no duplicated logic.

### Task 6.4.2: Rewrite pin models with load(ctx), accept(ctx, voltage), role tag, and loaded getter

- **Description**: Replace the pin-model stamp surface with unified load(ctx) / accept(ctx, voltage). Keep `init`, `setLogicLevel`, `setHighZ`, `setParam`, `readLogicLevel`, and all existing getters unchanged.

  **DigitalOutputPinModel:**
  - Constructor gains a `role: "branch" | "direct"` parameter.
  - `load(ctx: LoadContext)` dispatches on `role`:
    - `"branch"` — stamps the current `stamp(solver)` body (ideal voltage-source branch equation). When `_loaded`, also stamps `1/rOut` (drive) or `1/rHiZ` (Hi-Z) on the node diagonal.
    - `"direct"` — stamps the current `stampOutput(solver)` body (conductance + current-source to target rail). When `_loaded`, adds `1/rHiZ` diagonal stamp in Hi-Z.
  - When `_loaded` and `_spec.cOut > 0` and `ctx.isTransient`, `load()` performs inline `NIintegrate`-style companion stamping using `ctx.ag[]` and `ctx.dt` — mirror of the Wave 6.2.2 pattern. No call to the `integrateCapacitor` helper.
  - `accept(ctx: LoadContext, voltage: number)` — post-accepted-timestep companion state update using `ctx.ag[]` and `ctx.dt`. Updates `_prevVoltage` and `_prevCurrent`.

  **DigitalInputPinModel:**
  - `load(ctx)` — no-op when `!_loaded`. When `_loaded`, stamps `1/rIn` on the node diagonal. When `_loaded` and `_spec.cIn > 0` and `ctx.isTransient`, inline companion stamp using `ctx.ag[]` / `ctx.dt`.
  - `accept(ctx, voltage)` — post-accepted-timestep companion state update.

  **Handle caching (both classes):** On the first `load(ctx)` call, allocate matrix handles via `ctx.solver.allocElement(row, col)` once per stamp location and cache in private `Int32Array` fields (one per handle role: `_hNodeDiag`, `_hBranchDiag`, `_hBranchNode`, `_hNodeBranch`, etc.). Subsequent iterations use `stampElement(handle, value)`. Handles are invalidated on `init()` (which reassigns `nodeId` / `branchIdx`).

  **Getter:**
  ```typescript
  /** Read-only introspection accessor. See Wave 6.4 policy. */
  get loaded(): boolean { return this._loaded; }
  ```
  on both classes.

  **Import cleanup:** Delete the `import { integrateCapacitor } from "./integration.js"` line — companion integration is inline via `ctx.ag[]`. This aligns with Wave 6.3.2's deletion of `integrateCapacitor` / `integrateInductor`.

- **Files to modify**:
  - `src/solver/analog/digital-pin-model.ts` — Replace `stamp`, `stampOutput`, `stampCompanion`, `updateCompanion` methods with `load(ctx)` and `accept(ctx, voltage)` on both classes. Add `role` parameter to `DigitalOutputPinModel` constructor. Add `get loaded()` on both classes. Delete the `integrateCapacitor` import. Add private handle-cache fields.

- **Tests**:
  - `src/solver/analog/__tests__/digital-pin-model.test.ts::output_load_branch_role_drive_loaded` — construct `DigitalOutputPinModel(spec, loaded=true, role="branch")` with `setLogicLevel(true)`, `setHighZ(false)`; call `load(ctx)`; assert branch-equation stamps at `(branchIdx, nodeIdx)`, `(branchIdx, branchIdx)`, `(nodeIdx, branchIdx)`, RHS at `branchIdx` equal to `vOH`, plus `1/rOut` diagonal stamp at `(nodeIdx, nodeIdx)`. Reference values captured from the pre-migration `stamp()` body for the same config.
  - `src/solver/analog/__tests__/digital-pin-model.test.ts::output_load_branch_role_hiz_ideal` — `loaded=false`, `role="branch"`, `setHighZ(true)`; assert branch equation `I = 0` form with NO `1/rHiZ` term.
  - `src/solver/analog/__tests__/digital-pin-model.test.ts::output_load_direct_role_drive_loaded` — `role="direct"`, `loaded=true`, `setLogicLevel(false)`; assert `1/rOut` diagonal + `vOL/rOut` RHS. No branch-row stamps.
  - `src/solver/analog/__tests__/digital-pin-model.test.ts::output_load_direct_role_hiz_loaded` — `role="direct"`, `loaded=true`, `setHighZ(true)`; assert `1/rHiZ` diagonal stamp and zero RHS.
  - `src/solver/analog/__tests__/digital-pin-model.test.ts::input_load_loaded_stamps_rIn` — `DigitalInputPinModel(spec, loaded=true)`; `load(ctx)` stamps `1/rIn` on the node diagonal and nothing else.
  - `src/solver/analog/__tests__/digital-pin-model.test.ts::input_load_ideal_is_noop` — `loaded=false`; `load(ctx)` performs zero stamps on matrix and zero writes on RHS.
  - `src/solver/analog/__tests__/digital-pin-model.test.ts::output_load_companion_inline_uses_ag` — transient config with `ctx.ag[0]=g0`, `ctx.ag[1]=g1`, `ctx.dt > 0`, `loaded=true`, `cOut=1e-12`; spy on `integrateCapacitor` (or assert it is no longer imported via file-level grep); call `load(ctx)`; assert companion stamp geq/ceq are consistent with `ag[0] * q0 + ag[1] * q1` inline formula.
  - `src/solver/analog/__tests__/digital-pin-model.test.ts::output_accept_updates_prev_voltage` — call `load(ctx)`, then `accept(ctx, 1.8)`; read internal `_prevVoltage` via existing private-field test hook or diagnostic accessor; assert equals 1.8.
  - `src/solver/analog/__tests__/digital-pin-model.test.ts::loaded_getter_reads_private_field` — construct with `loaded=false`; `pin.loaded === false`. Reconstruct with `loaded=true`; `pin.loaded === true`. No setter exists — `(pin as any).loaded = true` is either a no-op or a TypeError (whichever the getter-without-setter pattern produces in strict mode).
  - `src/solver/analog/__tests__/digital-pin-model.test.ts::handle_cache_stable_across_iterations` — spy on `ctx.solver.allocElement`; call `load(ctx)` three times with identical mode and node assignment; assert `allocElement` invoked exactly `N` times total (where `N` is the number of stamp locations), not `3N`.

- **Acceptance criteria**:
  - `DigitalOutputPinModel` and `DigitalInputPinModel` have no `stamp`, `stampOutput`, `stampCompanion`, or `updateCompanion` methods (grep returns zero matches in `digital-pin-model.ts`).
  - `load(ctx)` is the sole matrix-stamping entry point on each class; `accept(ctx, voltage)` is the sole post-accept companion-update entry point.
  - `role` tag on output pins is frozen at construction; `role === "branch"` only from bridge-output adapters, `role === "direct"` only from behavioural factories.
  - `loaded` getter exists on both classes; no setter.
  - `integrateCapacitor` is not imported in `digital-pin-model.ts`.

### Task 6.4.3: Rewire behavioural factories and delegation from element load() / accept()

- **Description**: Update every behavioural factory to read `_pinLoading: Record<string, boolean>` from the PropertyBag and pass the resolved boolean to each pin-model constructor. Update every behavioural element's `load(ctx)` (landed in Wave 6.2.6) to delegate stamping to `input.load(ctx)` / `output.load(ctx)` for each owned pin model, then evaluate the truth table using `input.readLogicLevel(voltage)` on each input voltage read from `ctx.voltages`. Update each behavioural element's `accept(ctx, simTime, addBreakpoint)` to delegate companion updates to `input.accept(ctx, voltage)` / `output.accept(ctx, voltage)`.

  Specific hardcoded-true fixes (non-exhaustive):
  - `behavioral-gate.ts::buildGateElement` currently constructs `new DigitalInputPinModel(spec, true)` — replace with `new DigitalInputPinModel(spec, pinLoading[label] ?? false)`. Construct `new DigitalOutputPinModel(outSpec, pinLoading["out"] ?? false, "direct")`.
  - All other behavioural factory files: apply the same pattern — read `_pinLoading` from props, pass the per-pin boolean into each constructor, pass `"direct"` for all output pin roles (no behavioural element uses `"branch"`).

- **Files to modify**:
  - `src/solver/analog/behavioral-gate.ts` — read `_pinLoading`; pass to each pin-model constructor; rewire `BehavioralGateElement.load(ctx)` and `.accept(ctx, simTime, addBreakpoint)` to delegate to pin models.
  - `src/solver/analog/behavioral-combinational.ts` — same treatment.
  - `src/solver/analog/behavioral-flipflop.ts`, `behavioral-flipflop-variants.ts`, and every file under `src/solver/analog/behavioral-flipflop/` (`rs.ts`, `rs-async.ts`, `jk.ts`, `jk-async.ts`, `d-async.ts`, `t.ts`) — same treatment.
  - `src/solver/analog/behavioral-sequential.ts` — same treatment.
  - `src/solver/analog/behavioral-remaining.ts` — same treatment.
  - `src/solver/analog/bridge-adapter.ts` — bridge-output adapter constructs `DigitalOutputPinModel(spec, loaded, role="branch")`. Bridge-input adapter constructs `DigitalInputPinModel(spec, loaded)`. Confirm the existing `loaded` plumbing still operates through the same shared helper introduced in Task 6.4.1 (no duplicated logic).

- **Tests**:
  - `src/solver/analog/__tests__/behavioral-gate.test.ts::pin_loading_propagates_to_pin_models_all_mode` — compile a NAND gate circuit with `digitalPinLoading: "all"`; reach the compiled element via the existing test accessor; assert every input pin's `loaded === true` and the output pin's `loaded === true`.
  - `src/solver/analog/__tests__/behavioral-gate.test.ts::pin_loading_propagates_to_pin_models_none_mode` — same circuit with `"none"`; assert every `loaded === false`.
  - `src/solver/analog/__tests__/behavioral-gate.test.ts::pin_loading_respects_per_net_override_on_gate_input` — circuit with default mode plus per-net override on one input net; assert that input's `loaded` reflects the override and the remaining pins use the default resolution.
  - `src/solver/analog/__tests__/behavioral-gate.test.ts::gate_load_delegates_to_pin_models` — monkey-patch each pin-model instance's `load` with a spy; call the gate element's `load(ctx)`; assert every spy was invoked exactly once, with the same LoadContext object reference passed to each.
  - `src/solver/analog/__tests__/behavioral-gate.test.ts::gate_accept_delegates_to_pin_models` — same pattern for `accept(ctx, simTime, addBreakpoint)`. Assert each pin-model `accept(ctx, voltage)` was called with the voltage corresponding to that pin's node in `ctx.voltages`.
  - `src/solver/analog/__tests__/behavioral-gate.test.ts::gate_output_uses_direct_role` — after factory construction, assert the gate's output pin's role is `"direct"` (via an existing test-only accessor or by observing that the stamped shape is conductance+source, not branch-equation).
  - `src/solver/analog/__tests__/behavioral-flipflop.test.ts::flipflop_load_delegates_to_pin_models` — equivalent delegation test for the D flip-flop family (one variant per file is sufficient).
  - `src/solver/analog/__tests__/behavioral-combinational.test.ts::combinational_pin_loading_propagates` — one representative combinational element.
  - `src/solver/analog/__tests__/behavioral-sequential.test.ts::sequential_pin_loading_propagates` — one representative sequential element.
  - `src/solver/analog/__tests__/behavioral-remaining.test.ts::remaining_pin_loading_propagates` — one representative remaining element.
  - All existing behavioural-element tests continue to pass with the new delegation under the default `"cross-domain"` setting (behavioural elements today construct inputs with `loaded=true` hardcoded; after this wave, `"cross-domain"` resolution must produce the same boolean for the test circuits so numerical behaviour is preserved).

- **Acceptance criteria**:
  - Zero hardcoded `new DigitalInputPinModel(spec, true)` or `new DigitalOutputPinModel(spec)` (without explicit loaded + role args) calls in any behavioural factory file. Grep over the listed files returns zero matches for hardcoded boolean literals in pin-model constructor calls.
  - No behavioural element file contains `pinModel.stamp(`, `pinModel.stampOutput(`, `pinModel.stampCompanion(`, or `pinModel.updateCompanion(` calls (grep returns zero matches).
  - Every behavioural element's `load(ctx)` delegates to owned pin models' `load(ctx)`.
  - Every behavioural element's `accept(ctx, simTime, addBreakpoint)` delegates to owned pin models' `accept(ctx, voltage)`.

### Task 6.4.4: Delete legacy pin-model stamp methods — atomic gate

- **Description**: After Tasks 6.4.1–6.4.3 land, the legacy stamp methods on the pin models have no external callers. Delete them atomically and confirm full-codebase `tsc --noEmit` succeeds.

  Deleted methods:
  - `DigitalOutputPinModel.stamp(solver)`
  - `DigitalOutputPinModel.stampOutput(solver)`
  - `DigitalOutputPinModel.stampCompanion(solver, dt, method)`
  - `DigitalOutputPinModel.updateCompanion(dt, method, voltage)`
  - `DigitalInputPinModel.stamp(solver)`
  - `DigitalInputPinModel.stampCompanion(solver, dt, method)`
  - `DigitalInputPinModel.updateCompanion(dt, method, voltage)`

  Retained: `init`, `setLogicLevel`, `setHighZ`, `setParam`, `load`, `accept`, `readLogicLevel`, all getters (including the new `loaded` getter from Task 6.4.2).

- **Files to modify**:
  - `src/solver/analog/digital-pin-model.ts` — delete the listed methods.

- **Tests**:
  - `src/solver/analog/__tests__/digital-pin-model.test.ts::legacy_stamp_methods_deleted_output` — construct a `DigitalOutputPinModel`; assert `(pin as any).stamp === undefined`, `(pin as any).stampOutput === undefined`, `(pin as any).stampCompanion === undefined`, `(pin as any).updateCompanion === undefined`.
  - `src/solver/analog/__tests__/digital-pin-model.test.ts::legacy_stamp_methods_deleted_input` — construct a `DigitalInputPinModel`; assert `(pin as any).stamp === undefined`, `(pin as any).stampCompanion === undefined`, `(pin as any).updateCompanion === undefined`.

- **Acceptance criteria**:
  - Grep for `stampOutput\|stampCompanion\|updateCompanion` in `src/solver/analog/digital-pin-model.ts` returns zero matches.
  - Grep for `\.stamp\(` in the same file returns zero matches.
  - All Wave 6.4 tests pass.
  - Full-codebase `tsc --noEmit` succeeds after Wave 6.4 lands.
