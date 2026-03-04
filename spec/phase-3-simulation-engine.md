# Phase 3: Simulation Engine

**Depends on**: Phase 1 (complete)
**Parallel with**: Phases 2, 4, 5
**Blocks**: Phase 6 (Core Integration)

## Overview

One simulation engine with three evaluation modes sharing the same flat `Uint32Array` signal storage and compiled circuit representation. SCC-based feedback handling enables correct simulation of all circuits including combinational feedback loops (SR latches from gates).

## Binding Decisions

All decisions from `spec/shared-decisions.md` apply. Additionally:

- **One engine, three modes.** Not two separate engine implementations. The `SimulationEngine` interface from Phase 1 is implemented by a single `DigitalEngine` class. The evaluation mode is a configuration option.
- **SCC decomposition handles feedback.** The compiler detects combinational feedback loops via Tarjan's algorithm. Non-feedback gates are swept in topological order (one pass). Feedback groups (SCCs with >1 node) are iterated until stable. This handles all circuits — pure combinational, sequential with flip-flops, and combinational feedback (SR latches from gates).
- **Timing wheel for timed mode.** The event queue uses a circular-buffer timing wheel (O(1) amortized insert/extract), not a binary heap. Gate delays are small bounded integers, making the wheel the optimal data structure.
- **Flat signal storage throughout.** All modes read/write the same `Uint32Array`. No `ObservableValue` objects. Change detection for scheduling is done by comparing output values before and after evaluation.
- **Noise mode for init only.** During initialization, evaluation order within feedback SCCs is shuffled to break symmetry. After init, the compiled engine runs deterministically. Reset components drive the circuit to a known state after noise-based init.

## Reference Source

The engine design is informed by `ref/Digital/src/main/java/de/neemann/digital/core/Model.java` (evaluation loop, noise mode, oscillation detection), `ref/Digital/src/main/java/de/neemann/digital/draw/model/ModelCreator.java` (circuit compilation), and `ref/Digital/src/main/java/de/neemann/digital/core/wiring/bus/` (bus resolution). The flat-array architecture and SCC-based compilation are optimizations beyond what Digital does — they must produce identical results.

---

## Wave 3.1: Core Engine

### Task 3.1.1 — Compiled Evaluation Engine

- **Description**: The single engine implementation. Implements `SimulationEngine` from Phase 1. Holds the `Uint32Array` signal state. Supports three evaluation modes selectable at construction or runtime:

  **Level-by-level mode** (default): Evaluate components in topological order. Non-feedback groups: one-pass sweep via function table (`executeFns[typeIds[i]](i, state, layout)`). Feedback groups (SCCs): iterate within the group until all outputs stabilize or oscillation limit is reached. On clock edge: evaluate sequential elements first (sample inputs), then sweep combinational logic.

  **Timed mode**: Each component has a configurable propagation delay (default 10ns). When a component's output changes, schedule an event at `currentTime + delay` in the timing wheel. Process events in timestamp order. Multiple events at the same timestamp are batched. Glitches are visible (output changes then changes back within one clock period).

  **Micro-step mode**: Evaluate one component at a time, in the order they would be evaluated in level-by-level mode. After each evaluation, report which component just fired and what changed. For teaching signal propagation.

  All three modes share: the same `Uint32Array` signal state, the same compiled wiring tables, the same component function table.

- **Files to create**:
  - `src/engine/digital-engine.ts` — `DigitalEngine` class implementing `SimulationEngine`:
    - `constructor(mode: EvaluationMode)` where `EvaluationMode = 'level' | 'timed' | 'microstep'`
    - `init(compiled: CompiledCircuit)` — allocate signal arrays sized to `compiled.netCount`, set all signals to UNDEFINED, run noise-based initialization (see task 3.1.3)
    - `reset()` — re-run initialization sequence
    - `step()` — one full propagation cycle (meaning depends on mode):
      - Level: sweep all groups in topological order, iterate feedback SCCs
      - Timed: advance simulation time by one clock period, process all events up to that time
      - Micro-step: evaluate one component, return
    - `microStep()` — in micro-step mode, same as `step()`. In other modes, switch to micro-step mode temporarily for one evaluation, then switch back.
    - `start()` / `stop()` — continuous run via `requestAnimationFrame` (browser) or tight loop (headless). Configurable speed (steps per frame).
    - `runToBreak()` — loop `step()` until a Break component fires
    - `getSignalRaw(netId)` / `getSignalValue(netId)` / `setSignalValue(netId, value)` — signal access per Phase 1 interface
    - `getLastEvaluatedComponent(): { index: number; typeId: string } | undefined` — for micro-step UI (which gate just fired)
    - `setMode(mode: EvaluationMode)` — switch evaluation mode at runtime (resets timing state if switching to/from timed)
  - `src/engine/evaluation-mode.ts` — `EvaluationMode` type and mode-specific configuration:
    - `LevelConfig: {}` (no extra config)
    - `TimedConfig: { defaultDelay: number }` (default 10ns)
    - `MicrostepConfig: {}` (no extra config)

- **Tests**:
  - `src/engine/__tests__/digital-engine.test.ts::DigitalEngine::initSetsAllSignalsUndefined` — after init, every net reads as UNDEFINED via getSignalRaw
  - `src/engine/__tests__/digital-engine.test.ts::DigitalEngine::stepEvaluatesAllComponents` — set up a 2-gate circuit (AND feeding OR), step, verify output net has correct value
  - `src/engine/__tests__/digital-engine.test.ts::DigitalEngine::levelModeOnePassForCombinational` — purely combinational circuit stabilizes in one step() call
  - `src/engine/__tests__/digital-engine.test.ts::DigitalEngine::feedbackSCCIteratesUntilStable` — SR latch from 2 NOR gates, init with noise, verify it settles to a valid state (Q=0,Q̄=1 or Q=1,Q̄=0)
  - `src/engine/__tests__/digital-engine.test.ts::DigitalEngine::microStepAdvancesOneGate` — micro-step, verify getLastEvaluatedComponent returns the expected gate
  - `src/engine/__tests__/digital-engine.test.ts::DigitalEngine::stateTransitions` — verify STOPPED→RUNNING→PAUSED→STOPPED transitions
  - `src/engine/__tests__/digital-engine.test.ts::DigitalEngine::changeListenerFires` — add listener, step, verify callback fired
  - `src/engine/__tests__/digital-engine.test.ts::DigitalEngine::setSignalValuePropagates` — set an input net value, step, verify downstream outputs update

- **Acceptance criteria**:
  - Implements all `SimulationEngine` interface methods
  - Level-by-level mode: one-pass for non-feedback, iterative for feedback SCCs
  - Micro-step mode: one gate per step, reports which gate fired
  - State transitions follow STOPPED/RUNNING/PAUSED/ERROR lifecycle
  - Zero object allocation in the level-by-level inner loop (only Uint32Array index access and function calls)
  - All tests pass

---

### Task 3.1.2 — Timing Wheel Event Queue

- **Description**: O(1) amortized event queue for timed simulation mode. Circular buffer indexed by timestamp modulo wheel size. Events at the same timestamp are batched in a linked list (from a pre-allocated pool). The wheel size is configurable (default: 1024 slots). For delays exceeding the wheel size, overflow events go into a sorted overflow list (processed when the wheel wraps around).

  Pre-allocated event pool: a fixed-size array of event objects, reused via a free list. Zero allocation during simulation. Pool size = `2 * netCount` (each net can have at most one pending event, but during transitions there may be transient doubles).

- **Files to create**:
  - `src/engine/timing-wheel.ts` — `TimingWheel`:
    - `constructor(wheelSize: number, poolSize: number)`
    - `schedule(netId: number, value: number, highZ: number, timestamp: bigint)` — insert event at timestamp. If an event for the same netId already exists at a *different* time, the new one replaces it (a gate's output can only have one pending value).
    - `advance(toTimestamp: bigint): ScheduledEvent[]` — return all events at timestamps ≤ toTimestamp, in timestamp order. Returns from the pre-allocated pool (caller must not hold references after next `advance` call).
    - `peek(): bigint | undefined` — timestamp of next event, or undefined if empty
    - `clear()` — reset all state
    - `ScheduledEvent`: `{ netId: number; value: number; highZ: number; timestamp: bigint }`
  - `src/engine/event-pool.ts` — `EventPool`:
    - Pre-allocated ring buffer of `ScheduledEvent` objects
    - `alloc(): ScheduledEvent` — returns a reusable event from the pool
    - `free(event: ScheduledEvent)` — returns event to pool
    - `reset()` — return all events to pool

- **Tests**:
  - `src/engine/__tests__/timing-wheel.test.ts::TimingWheel::scheduleSingleEvent` — schedule at t=10, advance to t=10, get 1 event with correct netId/value
  - `src/engine/__tests__/timing-wheel.test.ts::TimingWheel::batchesSimultaneousEvents` — schedule 3 events at t=10, advance to t=10, get all 3
  - `src/engine/__tests__/timing-wheel.test.ts::TimingWheel::orderedByTimestamp` — schedule at t=20, t=10, t=15; advance to t=20; receive in order 10, 15, 20
  - `src/engine/__tests__/timing-wheel.test.ts::TimingWheel::replacesExistingEventForSameNet` — schedule net 5 at t=10, then schedule net 5 at t=15; advance to t=15; only one event for net 5 (at t=15)
  - `src/engine/__tests__/timing-wheel.test.ts::TimingWheel::handlesWrapAround` — wheel size 16, schedule at t=20 (wraps), advance to t=20, receive event
  - `src/engine/__tests__/timing-wheel.test.ts::TimingWheel::overflowHandled` — schedule at t > wheelSize, verify it's returned at correct time
  - `src/engine/__tests__/timing-wheel.test.ts::TimingWheel::zeroAllocation` — schedule and advance 1000 events, verify no new objects created (event pool reuse)

- **Acceptance criteria**:
  - O(1) amortized insert and extract for delays within wheel size
  - Events ordered by timestamp
  - Same-net replacement (latest schedule wins)
  - Pre-allocated pool — zero allocation during steady-state simulation
  - All tests pass

---

### Task 3.1.3 — Noise Mode and Initialization

- **Description**: Port Digital's initialization sequence. During init: (1) schedule all components for evaluation, (2) run propagation with noise — within feedback SCCs, shuffle evaluation order and interleave reads/writes (Digital's noise mode). This breaks symmetry for circuits like SR latches. (3) After reaching stability, release Reset components (output 0→1), (4) run one more propagation step without noise to settle. After init, noise is not used — the compiled engine runs deterministically.

  The read/write separation is critical: in non-noise mode, all components read inputs first, then all write outputs (Digital's synchronized mode). In noise mode, reads and writes are interleaved in shuffled order within each SCC. This is exactly Digital's `doMicroStep(noise)` semantics.

- **Files to create**:
  - `src/engine/noise-mode.ts`:
    - `shuffleArray(arr: Uint32Array, start: number, length: number)` — Fisher-Yates shuffle of a subrange (for shuffling component indices within an SCC)
    - `evaluateWithNoise(components: Uint32Array, start: number, count: number, state: Uint32Array, executeFns: Function[], typeIds: Uint8Array, layout: ComponentLayout)` — shuffle the component range, then for each: read inputs + write outputs (interleaved, not separated)
    - `evaluateSynchronized(components: Uint32Array, start: number, count: number, state: Uint32Array, executeFns: Function[], typeIds: Uint8Array, layout: ComponentLayout)` — read phase for all components, then write phase for all (Digital's non-noise mode). Note: this requires the execute function to be split into read and write phases, OR the engine snapshots input values before the write pass. See design note below.
  - `src/engine/init-sequence.ts`:
    - `initializeCircuit(engine: DigitalEngine, compiled: CompiledCircuit): void` — runs the full init sequence: noise propagation → reset release → deterministic settle

  **Design note on read/write separation**: Digital's Java `Node` has separate `readInputs()` and `writeOutputs()` methods. Our flat `executeFn` does both in one call. For synchronized (non-noise) mode within feedback SCCs, we need to either: (a) split executeFn into readFn + writeFn, or (b) snapshot input net values before evaluation, so writes by one component don't affect reads by another in the same micro-step. Option (b) is simpler — snapshot the input values for the SCC's nets into a temporary buffer, evaluate all components in the SCC reading from the snapshot and writing to the real state array, then check for changes. The snapshot buffer is pre-allocated at compile time (sized to the largest SCC's net count).

- **Tests**:
  - `src/engine/__tests__/noise-mode.test.ts::NoiseMode::shuffleProducesPermutation` — shuffle [0,1,2,3,4], verify same elements in different order (run 10 times, at least one differs)
  - `src/engine/__tests__/noise-mode.test.ts::NoiseMode::srLatchSettlesToValidState` — SR latch from 2 NOR gates (S=0, R=0 — hold state). Init with noise. Verify Q and Q̄ are complementary (not both 0 or both 1).
  - `src/engine/__tests__/noise-mode.test.ts::NoiseMode::srLatchWithResetDeterministic` — SR latch with a Reset component. Init → Reset releases → circuit settles to known state (R=1 forces Q=0).
  - `src/engine/__tests__/noise-mode.test.ts::NoiseMode::synchronizedModeSnapshotsInputs` — 2 components in an SCC where evaluation order matters. Synchronized mode produces same result regardless of order (because inputs are snapshotted). Noise mode may produce different results (because reads/writes are interleaved).

- **Acceptance criteria**:
  - SR latch from gates initializes without oscillation
  - Reset component protocol works (held low during init, released after)
  - Synchronized mode within SCCs is order-independent (snapshot-based)
  - Noise mode produces non-deterministic but valid initial states
  - All tests pass

---

## Wave 3.2: Circuit Compilation and Net Resolution

### Task 3.2.1 — Circuit Compiler

- **Description**: Transform a visual `Circuit` into a `CompiledCircuit`. This is the port of Digital's `ModelCreator`, adapted for our flat-array architecture.

  Compilation pipeline:
  1. **Enumerate components**: Walk `circuit.elements`, look up each element's `ComponentDefinition` in the registry. Assign a sequential component index (0..N-1).
  2. **Trace nets**: Run the net resolver (task 3.2.2) to determine which pins are electrically connected. Assign sequential net IDs (0..M-1).
  3. **Build wiring tables**: For each component, record which net IDs correspond to its input and output pins (in pin declaration order). Produce `ComponentLayout` implementation.
  4. **SCC decomposition**: Build the component dependency graph (component A depends on component B if any of A's input nets are driven by B's output nets). Run Tarjan's algorithm to find strongly connected components. Classify: single-node SCCs = non-feedback, multi-node SCCs = feedback.
  5. **Topological sort**: Sort the condensation graph (DAG of SCCs) topologically. This gives the evaluation order.
  6. **Build function table**: Create the `executeFns` array indexed by type ID. Create `typeIds` array indexed by component index.
  7. **Allocate signal arrays**: `Uint32Array(netCount)` for values, `Uint32Array(netCount)` for highZ masks. Pre-allocate the SCC snapshot buffer (sized to largest feedback SCC's net count).
  8. **Classify sequential elements**: Identify flip-flops and other sequential components (components whose executeFn reads a clock input and samples on edge). These are evaluated before the combinational sweep on each clock edge.
  9. **Produce compiled output**: Return `CompiledCircuit` with all the above.

- **Files to create**:
  - `src/engine/compiler.ts` — `compileCircuit(circuit: Circuit, registry: ComponentRegistry): CompiledCircuit`:
    - Orchestrates the full pipeline above
    - Returns a `CompiledCircuit` extending the opaque interface from Phase 1 with concrete fields
  - `src/engine/compiled-circuit.ts` — concrete `CompiledCircuit` implementation:
    - `netCount: number`
    - `componentCount: number`
    - `typeIds: Uint8Array` — type ID per component slot
    - `executeFns: ExecuteFunction[]` — function table indexed by type ID
    - `layout: ComponentLayout` — wiring info (input/output net offsets per component)
    - `evaluationOrder: EvaluationGroup[]` — topologically sorted groups. Each group is `{ componentIndices: Uint32Array; isFeedback: boolean }`
    - `sequentialComponents: Uint32Array` — indices of sequential elements (evaluated on clock edge)
    - `netWidths: Uint8Array` — bit width per net (for BitVector conversion)
    - `componentToElement: Map<number, CircuitElement>` — for micro-step reporting and debugging
    - `labelToNetId: Map<string, number>` — for facade's `setInput(label)` / `readOutput(label)` resolution
    - `wireToNetId: Map<Wire, number>` — for the renderer's wire coloring (Phase 6)
    - `sccSnapshotBuffer: Uint32Array` — pre-allocated buffer for synchronized-mode SCC evaluation
  - `src/engine/tarjan.ts` — `findSCCs(adjacency: number[][]): number[][]` — Tarjan's algorithm returning SCCs in reverse topological order (standard)
  - `src/engine/topological-sort.ts` — `topologicalSort(adjacency: number[][]): number[]` — Kahn's algorithm for DAG sorting. Throws if cycle detected (shouldn't happen on the condensation graph).

- **Tests**:
  - `src/engine/__tests__/compiler.test.ts::Compiler::compilesSimpleCombinational` — AND gate with 2 inputs, 1 output. Verify: 3 nets (2 input + 1 output), 1 component, 1 evaluation group (non-feedback), correct wiring (input nets at layout.inputOffset, output net at layout.outputOffset)
  - `src/engine/__tests__/compiler.test.ts::Compiler::compilesChainedGates` — NOT → AND → OR. Verify: evaluation order respects dependency (NOT before AND before OR), all in one non-feedback group (or separate single-node groups)
  - `src/engine/__tests__/compiler.test.ts::Compiler::detectsFeedbackSCC` — 2 NOR gates cross-connected (SR latch). Verify: one feedback group containing both components
  - `src/engine/__tests__/compiler.test.ts::Compiler::assignsNetIdsConsistently` — two components connected by a wire share the same net ID for the connected pins
  - `src/engine/__tests__/compiler.test.ts::Compiler::buildsFunctionTable` — register 2 component types, compile, verify executeFns has entries at both type IDs
  - `src/engine/__tests__/compiler.test.ts::Compiler::labelToNetIdMapsInputsOutputs` — circuit with In(label="A") and Out(label="S"), verify labelToNetId has entries "A" and "S"
  - `src/engine/__tests__/compiler.test.ts::Compiler::throwsOnUnregisteredComponent` — circuit with element whose typeId is not in the registry, throws with descriptive error
  - `src/engine/__tests__/compiler.test.ts::Tarjan::findsSimpleCycle` — adjacency [[1],[0]] → one SCC [0,1]
  - `src/engine/__tests__/compiler.test.ts::Tarjan::findsNoCycleInDAG` — adjacency [[1],[2],[]] → three singleton SCCs
  - `src/engine/__tests__/compiler.test.ts::Tarjan::reverseTopologicalOrder` — verify SCCs returned in valid reverse topological order

- **Acceptance criteria**:
  - Compiler produces correct wiring for combinational and feedback circuits
  - SCC decomposition correctly identifies feedback loops
  - Topological order is valid (no component evaluated before its non-feedback dependencies)
  - `labelToNetId` maps enable facade's label-based signal access
  - `wireToNetId` maps enable renderer's wire coloring
  - All tests pass

---

### Task 3.2.2 — Net Resolution

- **Description**: Trace wire connections to determine which pins are electrically connected (forming nets). Starting from the visual `Circuit` model (elements + wires), determine connectivity by matching wire endpoints to pin positions. Tunnel components (same name = same net) are resolved here. Validate: bit-width consistency within a net, unconnected input pins (warning), multiple output drivers on a net (route to bus resolution).

  Port of Digital's `Net.interconnect` logic, adapted for our pre-compilation context.

- **Files to create**:
  - `src/engine/net-resolver.ts` — `resolveNets(circuit: Circuit, registry: ComponentRegistry): NetResolution`:
    - Walk all wires, build adjacency by matching endpoints to pin positions and wire-to-wire junctions
    - Union-Find data structure for efficient net merging
    - Resolve Tunnel components: all Tunnels with the same `label` property in the same circuit are merged into one net
    - Validate bit widths: all pins on a net must have the same bit width, else throw `BitsException`
    - Classify nets: single-driver (one output pin) vs multi-driver (multiple output pins → needs bus resolution)
    - Detect unconnected input pins: input pin not on any net → warning (not error, for partial circuits)
    - `NetResolution`: `{ nets: ResolvedNet[]; warnings: string[] }`
    - `ResolvedNet`: `{ netId: number; pins: { element: CircuitElement; pin: Pin }[]; driverCount: number; bitWidth: number; needsBus: boolean }`

- **Tests**:
  - `src/engine/__tests__/net-resolver.test.ts::NetResolver::directWireConnection` — wire from output pin to input pin, both in same net
  - `src/engine/__tests__/net-resolver.test.ts::NetResolver::chainedWires` — 3 wires in series (endpoint matching), all in same net
  - `src/engine/__tests__/net-resolver.test.ts::NetResolver::tunnelsMergeSameNameNets` — 2 Tunnel components with label "Data", verify their nets are merged even without a direct wire
  - `src/engine/__tests__/net-resolver.test.ts::NetResolver::bitWidthMismatchThrows` — 1-bit output connected to 8-bit input, throws `BitsException`
  - `src/engine/__tests__/net-resolver.test.ts::NetResolver::multiDriverDetected` — 2 output pins on same net, verify `needsBus: true`
  - `src/engine/__tests__/net-resolver.test.ts::NetResolver::unconnectedInputWarns` — input pin with no wire, verify warning (not error)

- **Acceptance criteria**:
  - Wire endpoint matching correctly merges pins into nets
  - Tunnel name-based merging works
  - Bit-width validation catches mismatches
  - Multi-driver nets flagged for bus resolution
  - All tests pass

---

### Task 3.2.3 — Bus Resolution Subsystem

- **Description**: Port Digital's `core/wiring/bus/` subsystem. Handles nets where multiple components drive the same wire (tri-state buses, bidirectional lines, switches). When a net has multiple output drivers, the bus resolver determines the net's value by combining all drivers' outputs.

  Resolution logic (per bus net, on every change):
  1. For each driver, get its value and highZ mask
  2. A bit is high-Z only if ALL drivers assert high-Z on that bit (AND of all highZ masks)
  3. The value is the OR of all non-high-Z driver values
  4. **Burn detection**: if two non-high-Z drivers disagree on a bit value, that's a bus conflict
  5. Pull resistors: if the net has a pull-up, floating bits resolve to 1. Pull-down: floating bits resolve to 0.

  Burn detection is **deferred to post-step** (not immediate). During propagation, transient conflicts are normal. Only conflicts that persist at stable state are errors (`BurnException`).

  Switch-driven net merging: when a switch closes, two bus nets merge into one logical net. When it opens, they separate. This is runtime-dynamic and requires reconfiguring the bus handler.

- **Files to create**:
  - `src/engine/bus-resolution.ts`:
    - `BusNet` class: holds references to driver net IDs, pull resistor config, burn state
      - `recalculate(state: Uint32Array, highZState: Uint32Array)` — combine drivers, detect conflicts, update the bus output net in the state array
      - `checkBurn(): BurnException | undefined` — check if burn persists after step
    - `BusResolver` class: manages all bus nets in a compiled circuit
      - `addBusNet(outputNetId: number, driverNetIds: number[], pullResistor: 'up' | 'down' | 'none')` — register a bus net
      - `onNetChanged(netId: number, state: Uint32Array, highZState: Uint32Array)` — called when any driver net changes; recalculates the affected bus
      - `checkAllBurns(): BurnException[]` — post-step burn check
      - `reconfigureForSwitch(switchId: number, closed: boolean)` — merge/split bus nets when switches open/close

- **Tests**:
  - `src/engine/__tests__/bus-resolution.test.ts::BusNet::singleDriverPassthrough` — one driver at value 0xFF, bus output = 0xFF
  - `src/engine/__tests__/bus-resolution.test.ts::BusNet::twoDriversOneHighZ` — driver A = 0xFF, driver B = all-high-Z. Bus output = 0xFF (B doesn't contribute)
  - `src/engine/__tests__/bus-resolution.test.ts::BusNet::twoDriversAgree` — driver A = 0x0F, driver B = 0x0F (both driving same value). Bus output = 0x0F, no burn
  - `src/engine/__tests__/bus-resolution.test.ts::BusNet::twoDriversConflict` — driver A = 0xFF, driver B = 0x00 (both driving, different values). Burn detected.
  - `src/engine/__tests__/bus-resolution.test.ts::BusNet::pullUpResolvesFloating` — all drivers high-Z with pull-up. Bus output = all 1s (not high-Z).
  - `src/engine/__tests__/bus-resolution.test.ts::BusNet::pullDownResolvesFloating` — all drivers high-Z with pull-down. Bus output = all 0s.
  - `src/engine/__tests__/bus-resolution.test.ts::BusResolver::burnDeferredToPostStep` — transient conflict during propagation, resolved before step ends → no BurnException. Persistent conflict at stable state → BurnException.
  - `src/engine/__tests__/bus-resolution.test.ts::BusResolver::switchMergesNets` — close switch between two bus nets, verify they behave as one net
  - `src/engine/__tests__/bus-resolution.test.ts::BusResolver::switchOpenSplitsNets` — close then open switch, verify nets are independent again

- **Acceptance criteria**:
  - Single-driver bus is passthrough
  - Multi-driver resolution: high-Z arbitration, value OR
  - Burn detection is deferred to post-step (transient conflicts tolerated)
  - Pull-up/pull-down resolves floating bits
  - Switch-driven net merging/splitting works
  - All tests pass

---

## Wave 3.3: Advanced Features

### Task 3.3.1 — Propagation Delay Model

- **Description**: Per-component configurable gate delay for timed simulation mode. Each `ComponentDefinition` has a `defaultDelay: number` (in nanoseconds, default 10). Individual component instances can override via a `delay` property in their `PropertyBag`. The compiler reads delays and stores them in a flat `Uint32Array` indexed by component index. The engine's timed mode uses these delays when scheduling events in the timing wheel.

  The `Delay` component (a special passthrough that delays its input by N time units) is implemented as a component in Phase 5, but its semantics are defined here: it reads input, schedules output at `currentTime + delayValue`.

- **Files to create**:
  - `src/engine/delay.ts`:
    - `resolveDelays(compiled: CompiledCircuit, registry: ComponentRegistry): Uint32Array` — build delay array indexed by component index. Read from component instance property `delay` if set, else from `ComponentDefinition.defaultDelay`, else 10ns.
    - `DEFAULT_GATE_DELAY = 10` (nanoseconds)

- **Files to modify**:
  - `src/core/registry.ts` — add `defaultDelay: number` to `ComponentDefinition` interface (default: 10)

- **Tests**:
  - `src/engine/__tests__/delay.test.ts::Delays::defaultDelayIs10ns` — component with no explicit delay, resolveDelays returns 10 for its index
  - `src/engine/__tests__/delay.test.ts::Delays::instanceOverridesDefault` — component with `delay: 20` in properties, resolveDelays returns 20
  - `src/engine/__tests__/delay.test.ts::Delays::definitionOverridesGlobalDefault` — ComponentDefinition with defaultDelay: 5, component instance has no override, resolveDelays returns 5

- **Acceptance criteria**:
  - Delay resolution: instance property > definition default > global default (10ns)
  - Delays stored in flat array for O(1) lookup
  - All tests pass

---

### Task 3.3.2 — Feedback and Oscillation Detection

- **Description**: Detect circuits that fail to stabilize. Port Digital's oscillation detection: after N micro-steps (configurable, default 1000) without reaching stability, collect the still-toggling components for 100 more steps, then throw `NodeException` identifying the oscillating components.

  Compile-time warning: if the compiler's SCC decomposition finds feedback SCCs, emit a warning (not error) noting which components are in feedback loops. This is informational — feedback is legal (SR latches), but the user should be aware.

  Runtime: in the engine's step loop, count micro-step iterations. If the count exceeds `oscillationLimit`:
  1. Collect which components are still being scheduled
  2. Continue for 100 more steps to confirm the pattern
  3. Throw `NodeException` with the oscillating component list and a user-friendly message

- **Files to create**:
  - `src/engine/oscillation.ts`:
    - `OscillationDetector`:
      - `constructor(limit: number)` — default 1000
      - `tick(): void` — increment counter
      - `isOverLimit(): boolean`
      - `collectOscillatingComponents(scheduled: Iterable<number>): void` — track which components keep appearing
      - `getOscillatingComponents(): number[]` — after collection period, return the confirmed oscillators
      - `reset(): void`

- **Tests**:
  - `src/engine/__tests__/oscillation.test.ts::Oscillation::detectsAfterLimit` — feed detector 1001 ticks, verify isOverLimit returns true
  - `src/engine/__tests__/oscillation.test.ts::Oscillation::collectsOscillators` — after limit, collect for 100 ticks with components [3,5] repeating, verify getOscillatingComponents returns [3,5]
  - `src/engine/__tests__/oscillation.test.ts::Oscillation::resetClearsState` — detect, reset, verify isOverLimit is false

- **Acceptance criteria**:
  - Oscillation detected after configurable limit
  - Oscillating components identified for error reporting
  - Compile-time feedback warnings emitted
  - All tests pass

---

### Task 3.3.3 — Clock Management

- **Description**: Identify clock sources in the compiled circuit, manage clock edges, support multiple clock domains with independent frequencies.

  Clock components (`Clock` type) generate periodic signals. The engine must:
  1. Find all Clock components after compilation
  2. On each step: toggle clock values at their configured frequency
  3. On clock edge (rising or falling, configurable): evaluate sequential elements that sample on that edge, then sweep combinational logic
  4. Multi-clock: multiple Clock components at different frequencies. Each has its own edge schedule.
  5. Real-time clock mode: clock ticks at actual wall-clock speed (for demos). Uses `requestAnimationFrame` or `setTimeout` timing.
  6. `AsyncSequentialClock` mode: for asynchronous sequential circuits where there is no explicit clock — propagation is triggered by input changes only.

- **Files to create**:
  - `src/engine/clock.ts`:
    - `ClockManager`:
      - `constructor(compiled: CompiledCircuit)`
      - `findClocks(): ClockInfo[]` — identify Clock components and their frequencies
      - `advanceClocks(state: Uint32Array)` — toggle clock signals, return which edges fired
      - `getSequentialComponentsForEdge(edge: ClockEdge): number[]` — which sequential components sample on this edge
      - `setRealTimeMode(enabled: boolean, targetFrequency?: number)` — real-time clock pacing
    - `ClockInfo`: `{ componentIndex: number; netId: number; frequency: number; currentPhase: boolean }`
    - `ClockEdge`: `'rising' | 'falling'`

- **Tests**:
  - `src/engine/__tests__/clock.test.ts::ClockManager::findsClockComponents` — circuit with 2 Clock elements, findClocks returns 2 entries with correct frequencies
  - `src/engine/__tests__/clock.test.ts::ClockManager::togglesClockOnAdvance` — initial value 0, advanceClocks once → value 1, again → value 0
  - `src/engine/__tests__/clock.test.ts::ClockManager::identifiesEdgeType` — verify rising edge detected on 0→1 transition
  - `src/engine/__tests__/clock.test.ts::ClockManager::multiClockIndependent` — 2 clocks at different frequencies, verify they toggle at their own rate

- **Acceptance criteria**:
  - Clock components correctly identified
  - Clock toggling drives sequential element evaluation
  - Multiple independent clock domains supported
  - Real-time mode paces to wall-clock time
  - All tests pass

---

## Wave 3.4: Simulation Modes

### Task 3.4.1 — Standard Controls

- **Description**: State machine for the engine lifecycle. STOPPED → RUNNING (start) → PAUSED (stop) → STOPPED (reset). Error state on unrecoverable exceptions. Continuous run mode: loop step() calls driven by `requestAnimationFrame` in browser or tight loop in headless. Configurable simulation speed (steps per frame, default 1).

- **Files to create**:
  - `src/engine/controls.ts` — `SimulationController`:
    - `constructor(engine: DigitalEngine)`
    - `start()` — begin continuous simulation, transition to RUNNING
    - `stop()` — pause simulation, transition to PAUSED
    - `reset()` — re-initialize, transition to STOPPED
    - `step()` — single step (works from STOPPED or PAUSED)
    - `setSpeed(stepsPerFrame: number)` — how many steps per animation frame
    - `getState(): EngineState`
    - `onError(callback: (error: SimulationError) => void)` — error handler registration
    - Internal: `requestAnimationFrame`-based loop when RUNNING, calls `engine.step()` N times per frame, then triggers re-render callback

- **Tests**:
  - `src/engine/__tests__/controls.test.ts::Controls::stateTransitions` — STOPPED → start → RUNNING → stop → PAUSED → reset → STOPPED
  - `src/engine/__tests__/controls.test.ts::Controls::stepFromStopped` — step from STOPPED works, stays STOPPED
  - `src/engine/__tests__/controls.test.ts::Controls::errorTransition` — engine.step throws, state becomes ERROR
  - `src/engine/__tests__/controls.test.ts::Controls::speedControlsStepsPerFrame` — set speed 10, verify engine.step called 10 times per tick

- **Acceptance criteria**:
  - State machine transitions are correct
  - Continuous run drives steps at configured speed
  - Error handling catches simulation exceptions
  - All tests pass

---

### Task 3.4.2 — Micro-Step Mode

- **Description**: Advance one single component evaluation. The engine evaluates one component from the current evaluation group, updates its output nets, schedules any affected downstream components, then stops. Reports which component was just evaluated via `getLastEvaluatedComponent()`. The UI can highlight this component on the canvas. For teaching signal propagation order.

- **Files to create**:
  - `src/engine/micro-step.ts` — `MicroStepController`:
    - `constructor(engine: DigitalEngine)`
    - `step(): MicroStepResult` — evaluate one component, return `{ componentIndex: number; typeId: string; changedNets: number[] }`
    - `isStable(): boolean` — true if no more components are scheduled (propagation complete)
    - `reset()` — restart from all-scheduled state

- **Tests**:
  - `src/engine/__tests__/micro-step.test.ts::MicroStep::advancesOneComponent` — step, verify only one component evaluated (check via changedNets)
  - `src/engine/__tests__/micro-step.test.ts::MicroStep::reportsWhichComponentFired` — step, verify componentIndex and typeId are correct
  - `src/engine/__tests__/micro-step.test.ts::MicroStep::eventuallyStabilizes` — step repeatedly, verify isStable() eventually returns true
  - `src/engine/__tests__/micro-step.test.ts::MicroStep::propagationOrderVisible` — chain of 3 gates (A→B→C), micro-step 3 times, verify order is A, B, C

- **Acceptance criteria**:
  - One component per step
  - Component identity and changed nets reported
  - Full circuit stabilizes after enough micro-steps
  - All tests pass

---

### Task 3.4.3 — Run-to-Break

- **Description**: Run simulation until a `Break` component fires, then halt. Break components monitor a condition (their input signal) and fire when the condition is true. Supports both normal-speed and micro-step run-to-break.

- **Files to create**:
  - `src/engine/run-to-break.ts` — `RunToBreak`:
    - `run(engine: DigitalEngine, compiled: CompiledCircuit, maxSteps: number): BreakResult`
    - `BreakResult`: `{ reason: 'break' | 'maxSteps'; breakComponent?: number; stepsExecuted: number }`
    - Identify Break components from compiled circuit
    - After each step, check if any Break component's input is asserted
    - If so, halt and return the Break component's info
    - If maxSteps exceeded, halt and return 'maxSteps' reason

- **Tests**:
  - `src/engine/__tests__/run-to-break.test.ts::RunToBreak::haltsOnBreak` — circuit with Break component, input goes high after 5 steps, verify stops at step 5
  - `src/engine/__tests__/run-to-break.test.ts::RunToBreak::haltsOnMaxSteps` — no Break fires, verify stops at maxSteps
  - `src/engine/__tests__/run-to-break.test.ts::RunToBreak::reportsBreakComponent` — verify breakComponent index matches the Break element

- **Acceptance criteria**:
  - Break detection works
  - Max steps limit prevents infinite loops
  - Break component identity reported
  - All tests pass

---

### Task 3.4.4 — Quick Run and Speed Test

- **Description**: Run simulation at maximum speed with no rendering callbacks. Suppress all change listeners and measurement observers during quick run. For computation-heavy circuits where rendering overhead would slow simulation. Speed test mode: run N steps, measure wall-clock time, report maximum kHz (matching Digital's `SpeedTest` metric).

- **Files to create**:
  - `src/engine/quick-run.ts`:
    - `quickRun(engine: DigitalEngine, steps: number): void` — suppress listeners, run N steps in tight loop, restore listeners
    - `speedTest(engine: DigitalEngine, steps: number): SpeedTestResult` — quickRun + timing. `SpeedTestResult`: `{ steps: number; elapsedMs: number; stepsPerSecond: number; khz: number }`

- **Tests**:
  - `src/engine/__tests__/quick-run.test.ts::QuickRun::runsWithoutListeners` — register listener, quickRun 100 steps, verify listener was NOT called during run
  - `src/engine/__tests__/quick-run.test.ts::QuickRun::restoresListenersAfter` — quickRun, then normal step, verify listener IS called
  - `src/engine/__tests__/quick-run.test.ts::SpeedTest::reportsMetrics` — speedTest 1000 steps, verify result has positive stepsPerSecond

- **Acceptance criteria**:
  - Listeners suppressed during quick run
  - Listeners restored after
  - Speed test reports meaningful metrics
  - All tests pass

---

### Task 3.4.5 — Web Worker Mode

- **Description**: Run the engine in a Web Worker. Signal state in `SharedArrayBuffer` so the main thread can read values for rendering via `Atomics.load()`. Control messages via `postMessage`. Graceful fallback to main-thread simulation if `Cross-Origin-Isolation` headers are unavailable (no `SharedArrayBuffer`).

  The `DigitalEngine` from task 3.1.1 runs identically in both modes — it reads/writes a `Uint32Array`. The difference is whether that array is backed by `SharedArrayBuffer` (Worker mode) or a plain `ArrayBuffer` (main-thread mode).

- **Files to create**:
  - `src/engine/worker-engine.ts` — `WorkerEngine` implementing `SimulationEngine`:
    - Proxy that sends `EngineMessage` commands to the Worker via `postMessage`
    - `getSignalRaw(netId)` → `Atomics.load(sharedView, netId)` (non-blocking read from main thread)
    - `getSignalValue(netId)` → reads raw value via Atomics, constructs BitVector
    - All lifecycle methods (`step`, `start`, `stop`, etc.) → post messages to Worker
    - `onStateChange` receives `EngineResponse` messages back from Worker
  - `src/engine/worker.ts` — Web Worker entry point:
    - Receives `EngineMessage` commands
    - Instantiates `DigitalEngine` with a `SharedArrayBuffer`-backed `Uint32Array`
    - Runs simulation steps
    - Posts `EngineResponse` back to main thread
  - `src/engine/worker-detection.ts`:
    - `canUseSharedArrayBuffer(): boolean` — check for `Cross-Origin-Isolation`
    - `createEngine(compiled: CompiledCircuit, mode: EvaluationMode): SimulationEngine` — factory: returns `WorkerEngine` if SAB available, else `DigitalEngine` on main thread

- **Tests**:
  - `src/engine/__tests__/worker-detection.test.ts::WorkerDetection::fallsBackToMainThread` — mock `SharedArrayBuffer` unavailable, verify factory returns `DigitalEngine`
  - `src/engine/__tests__/worker-detection.test.ts::WorkerDetection::usesWorkerWhenAvailable` — mock SAB available, verify factory returns `WorkerEngine`
  - Worker integration tests deferred to Phase 6 (need browser environment with COOP/COEP headers). Unit tests verify the proxy and message protocol in isolation.

- **Acceptance criteria**:
  - WorkerEngine implements full SimulationEngine interface
  - Signal reads from main thread use Atomics.load (non-blocking)
  - Fallback detection works
  - All message types handled
  - All tests pass

---

## Wave 3.5: Headless Simulation Runner

### Task 3.5.1 — Headless Compile and Run

- **Description**: Implement the simulation portion of the `SimulatorFacade` (interface from Phase 2, task 2.0.1). This is the `runner` module in the facade's composed architecture.

  - `compile(circuit: Circuit): SimulationEngine` — calls the compiler (3.2.1), initializes a `DigitalEngine` (level-by-level mode by default), runs init sequence
  - `step(engine)` — delegates to `engine.step()`
  - `run(engine, cycles)` — call `step()` N times
  - `runToStable(engine, maxIterations=1000)` — loop step until no signal changes between steps, or maxIterations reached (throw `OscillationError`)
  - `setInput(engine, label, value)` — resolve `In` component by label → find its net ID in `compiledCircuit.labelToNetId` → call `engine.setSignalValue()`
  - `readOutput(engine, label)` — resolve `Out`/`Probe` by label → net ID → `engine.getSignalValue()`
  - `readAllSignals(engine)` — iterate all label→netId entries, return `Map<string, BitVector>`

- **Files to create**:
  - `src/headless/runner.ts` — `SimulationRunner`:
    - `constructor(registry: ComponentRegistry)`
    - All methods above
    - Stores `compiledCircuit` reference alongside engine for label resolution

- **Tests**:
  - `src/headless/__tests__/runner.test.ts::Runner::compileAndStep` — build half-adder via builder, compile, setInput A=1 B=1, step, readOutput S=0, C=1
  - `src/headless/__tests__/runner.test.ts::Runner::allFourInputCombinations` — half-adder: test all 4 input combos, verify correct S and C for each
  - `src/headless/__tests__/runner.test.ts::Runner::runToStableOnCombinational` — combinational circuit stabilizes in 1 step
  - `src/headless/__tests__/runner.test.ts::Runner::runToStableThrowsOnOscillation` — circuit that oscillates, verify throws
  - `src/headless/__tests__/runner.test.ts::Runner::readAllSignals` — verify returns Map with all In/Out/Probe labels
  - `src/headless/__tests__/runner.test.ts::Runner::setInputByLabel` — setInput "A" to 1, verify net value changed
  - `src/headless/__tests__/runner.test.ts::Runner::unknownLabelThrows` — setInput with nonexistent label, throws FacadeError

- **Acceptance criteria**:
  - Full compile→step→read cycle works in Node.js (no browser)
  - Half-adder produces correct results for all input combinations
  - Label-based signal access resolves correctly
  - Oscillation detection works
  - All tests pass

---

### Task 3.5.2 — Signal Trace Capture

- **Description**: Capture signal values over multiple simulation steps. `getSignalTrace(engine, labels, steps)` runs N steps, sampling named signals after each step. Returns `Map<string, BitVector[]>`. Useful for verifying sequential circuit behavior (e.g., counter counts correctly over 8 clock cycles).

- **Files to create**:
  - `src/headless/trace.ts`:
    - `captureTrace(runner: SimulationRunner, engine: SimulationEngine, labels: string[], steps: number): Map<string, BitVector[]>` — for each step: call `runner.step(engine)`, then `runner.readOutput(engine, label)` for each label, collect into arrays

- **Tests**:
  - `src/headless/__tests__/trace.test.ts::Trace::capturesMultipleSteps` — 3-step trace of a signal, verify array has 3 entries
  - `src/headless/__tests__/trace.test.ts::Trace::valuesReflectStepProgression` — combinational circuit with changing input: trace shows value changing at expected step

- **Acceptance criteria**:
  - Trace captures correct value at each step
  - Map keys match requested labels
  - All tests pass

---

### Task 3.5.3 — Headless Runner Smoke Tests

- **Description**: Integration tests exercising the full headless pipeline: build circuit → compile → simulate → verify results. These tests depend on both Phase 2 (builder) and Phase 3 (engine) being complete. They use mock component definitions with real execute functions (simple AND/XOR/NOT logic).

- **Files to create**:
  - `src/headless/__tests__/integration.test.ts`:
    - `halfAdderFullCycle` — build half-adder, compile, test all 4 input combinations, verify S and C outputs
    - `srLatchInitializes` — build SR latch from 2 NOR gates, compile (with noise init), verify Q and Q̄ are complementary
    - `chainOfInvertersStabilizes` — 3 NOT gates in series, compile, step, verify output is inverted input
    - `oscillatingCircuitDetected` — ring oscillator (odd number of inverters in a loop), runToStable throws OscillationError
    - `signalTraceCapture` — build simple circuit, capture 5-step trace, verify values

- **Acceptance criteria**:
  - All integration tests pass in Node.js
  - SR latch initializes correctly with noise
  - Oscillation detection works end-to-end
  - All tests pass

---

## Verification Criteria (Phase 3)

All of these must pass before Phase 6 integration:

- `npm run typecheck` passes with zero errors
- `npm test` — all new tests pass, all Phase 1 and Phase 2 tests still pass
- Levelized evaluation matches propagation results for all test circuits
- Noise mode resolves SR flip-flop startup without oscillation
- Bus resolution detects shorted outputs (BurnException)
- Micro-step advances one gate and reports which one
- Run-to-break halts at Break component
- Quick run completes without rendering callbacks
- Web Worker mode produces identical results to main-thread mode (where testable)
- Headless runner: `compile()` + `step()` + `readOutput()` produces correct results for half-adder
- Timing wheel: O(1) amortized insert/extract, zero allocation in steady state
- Timed mode: events processed in timestamp order, glitches visible
- Oscillation detection identifies and reports oscillating components
- All signal access goes through `getSignalRaw()` / `getSignalValue()` — no direct array access outside the engine
