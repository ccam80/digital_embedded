# Phase 4b: Two-Engine Bridge

## Overview

Implement the mixed-signal subcircuit bridge: when a digital-engine subcircuit is embedded in an analog circuit (or vice versa), the inner subcircuit runs in its own engine instance while the outer engine sees bridge adapter elements stamped at the boundary. A `MixedSignalCoordinator` manages timing synchronization between engines using the breakpoint API. At the end of this phase, users can embed a digital subcircuit (e.g., a counter, state machine, or processor) inside an analog circuit and have signals cross the boundary correctly with realistic electrical behavior from Phase 4a's pin model.

## Dependencies

- **Phase 4a** (Digital-Analog Interface Layer) must be complete: `DigitalPinModel`, `LogicFamilyConfig`, `PinElectricalSpec`, `resolvePinElectrical()`, `simulationMode` property, analog compiler handling of `engineType: "both"`
- **Phase 0** (Interface Abstraction) must be complete: `Engine` base interface, `AnalogEngine`, `SimulationEngine`
- **Phase 1** (MNA Engine Core) must be complete: `MNAEngine`, `compileAnalogCircuit()`, `addBreakpoint()`/`clearBreakpoints()`
- The existing digital engine infrastructure: `DigitalEngine`, `compileCircuit()`, `flattenCircuit()`

## Wave structure and dependencies

```
Wave 4b.1: Bridge Adapter Elements               [depends on Phase 4a]
Wave 4b.2: Compiler Cross-Engine Detection        [depends on 4b.1]
Wave 4b.3: MixedSignalCoordinator                 [depends on 4b.1 + 4b.2]
Wave 4b.4: Integration Tests + Bridge Diagnostics [depends on 4b.3]
```

All waves are sequential — each depends on the previous.

---

## Wave 4b.1: Bridge Adapter Elements

### Task 4b.1.1: BridgeOutputAdapter — Digital Engine Output → MNA

- **Description**: Implement the `BridgeOutputAdapter`, an `AnalogElement` that represents a digital engine's output pin in the MNA matrix. It uses `DigitalOutputPinModel` from Phase 4a to stamp the Norton equivalent (voltage source + R_out + C_out). Unlike the behavioral gate (which evaluates a truth table to determine its output), the bridge adapter receives its logic level externally from the `MixedSignalCoordinator` after each digital engine step. The adapter's `stampNonlinear()` re-stamps the output voltage whenever the logic level changes.
- **Files to create**:
  - `src/analog/bridge-adapter.ts`:
    - `class BridgeOutputAdapter implements AnalogElement`:
      - `constructor(pinModel: DigitalOutputPinModel)`
      - `readonly nodeIndices: readonly number[]` — the single output node + ground
      - `readonly branchIndex: number` — -1 (Norton equivalent)
      - `readonly isNonlinear: true` — output level can change between timesteps
      - `readonly isReactive: true` — C_out companion model
      - `setLogicLevel(high: boolean): void` — called by the coordinator when the digital engine's output changes; delegates to `pinModel.setLogicLevel()`
      - `setHighZ(hiZ: boolean): void` — called when the digital output goes high-impedance
      - `stamp(solver): void` — delegates to `pinModel.stamp()`
      - `stampNonlinear(solver): void` — re-stamps the Norton current based on current logic level (handles the case where the level changed mid-NR)
      - `updateCompanion(dt, method, voltages): void` — updates C_out companion model
      - `updateOperatingPoint(voltages): void` — no-op
      - `readonly outputNodeId: number` — for coordinator to read the analog voltage at this pin
      - `label?: string`
    - `class BridgeInputAdapter implements AnalogElement`:
      - `constructor(pinModel: DigitalInputPinModel)`
      - `readonly nodeIndices: readonly number[]` — the single input node + ground
      - `readonly branchIndex: number` — -1
      - `readonly isNonlinear: false` — input loading is linear (R_in)
      - `readonly isReactive: true` — C_in companion model
      - `stamp(solver): void` — stamps R_in via `pinModel.stamp()`
      - `updateCompanion(dt, method, voltages): void` — updates C_in companion
      - `readLogicLevel(voltage: number): boolean | undefined` — delegates to `pinModel.readLogicLevel()`; coordinator calls this to convert analog voltage to digital bit
      - `readonly inputNodeId: number` — for coordinator to read the analog voltage at this node
      - `label?: string`
- **Tests**:
  - `src/analog/__tests__/bridge-adapter.test.ts::OutputAdapter::stamps_norton_for_logic_high` — create adapter with CMOS 3.3V spec; call `setLogicLevel(true)`; call `stamp()` + `stampNonlinear()`; verify conductance 1/50 and RHS current 3.3/50
  - `src/analog/__tests__/bridge-adapter.test.ts::OutputAdapter::stamps_norton_for_logic_low` — call `setLogicLevel(false)`; verify RHS current 0.0/50
  - `src/analog/__tests__/bridge-adapter.test.ts::OutputAdapter::hiz_stamps_rhiz` — call `setHighZ(true)`; verify conductance 1/1e7 and no voltage source contribution
  - `src/analog/__tests__/bridge-adapter.test.ts::OutputAdapter::level_change_updates_stamp` — set high, stamp, set low, stampNonlinear again; verify RHS current changed
  - `src/analog/__tests__/bridge-adapter.test.ts::InputAdapter::stamps_input_loading` — create adapter; call `stamp()`; verify conductance 1/rIn at input node
  - `src/analog/__tests__/bridge-adapter.test.ts::InputAdapter::reads_threshold` — voltage 3.0V with vIH=2.0; assert `readLogicLevel()` returns true. Voltage 0.5V with vIL=0.8; assert false. Voltage 1.5V; assert undefined.
- **Acceptance criteria**:
  - `BridgeOutputAdapter` stamps identical MNA contributions to `DigitalOutputPinModel` — reuses the same helper
  - Logic level is set externally (by coordinator), not computed internally (unlike behavioral gates)
  - `BridgeInputAdapter` provides threshold-based reading for the coordinator to convert analog → digital
  - Companion models for pin capacitance work identically to Phase 4a's behavioral elements

---

## Wave 4b.2: Compiler Cross-Engine Detection

### Task 4b.2.1: Selective Flattening — Preserve Cross-Engine Subcircuit Boundaries

- **Description**: Modify `flattenCircuit()` to detect when a subcircuit's internal `engineType` differs from the outer circuit's `engineType` (or when the subcircuit instance's `simulationMode` is set to `'digital'` in an analog circuit). In those cases, the subcircuit is NOT flattened — it's left as an opaque boundary marker. A new `CrossEngineBoundary` structure records the subcircuit element, its internal circuit, and the pin mappings needed for bridge adapter creation.
- **Files to modify**:
  - `src/engine/flatten.ts`:
    - In `flattenCircuitScoped()`: before inlining a `SubcircuitHost`, check if the subcircuit's internal `engineType` differs from the outer circuit's `engineType`, OR if the subcircuit instance's `simulationMode` property is `'digital'` (in an analog-engine outer circuit)
    - When a cross-engine boundary is detected: do NOT recurse into `inlineSubcircuit()`. Instead, record the boundary in a `CrossEngineBoundary` structure and leave the subcircuit element in the flat result as a placeholder.
    - `flattenCircuit()` return type changes from `Circuit` to `FlattenResult`:
      - `circuit: Circuit` — the flattened circuit (leaf elements only, except cross-engine placeholders)
      - `crossEngineBoundaries: CrossEngineBoundary[]` — boundaries that the compiler must handle

**Call-site migration (exhaustive):**

Migration pattern: `const circuit = flattenCircuit(c)` → `const { circuit, boundaryPins } = flattenCircuit(c)`. Digital-only callers ignore `boundaryPins`.

| File | Current usage | Migration |
|------|--------------|-----------|
| `src/engine/__tests__/flatten.test.ts:205` | `const flat = flattenCircuit(circuit, registry)` | `const { circuit: flat } = flattenCircuit(circuit, registry)` — `boundaryPins` unused in digital path |
| `src/engine/__tests__/flatten.test.ts:220` | `const flat = flattenCircuit(circuit, registry)` | `const { circuit: flat } = flattenCircuit(circuit, registry)` — `boundaryPins` unused in digital path |
| `src/engine/__tests__/flatten.test.ts:267` | `const flat = flattenCircuit(parent, registry)` | `const { circuit: flat } = flattenCircuit(parent, registry)` — `boundaryPins` unused in digital path |
| `src/engine/__tests__/flatten.test.ts:307` | `const flat = flattenCircuit(parent, registry)` | `const { circuit: flat } = flattenCircuit(parent, registry)` — `boundaryPins` unused in digital path |
| `src/engine/__tests__/flatten.test.ts:358` | `const flat = flattenCircuit(top, registry)` | `const { circuit: flat } = flattenCircuit(top, registry)` — `boundaryPins` unused in digital path |
| `src/engine/__tests__/flatten.test.ts:411` | `const flat = flattenCircuit(parent, registry)` | `const { circuit: flat } = flattenCircuit(parent, registry)` — `boundaryPins` unused in digital path |
| `src/engine/__tests__/flatten.test.ts:462` | `flattenCircuit(parent, registry)` (result discarded) | `flattenCircuit(parent, registry)` — no change needed, result still discarded |

All callers must be updated in this task. No overload or backward-compatible wrapper.
- **Files to create**:
  - `src/engine/cross-engine-boundary.ts`:
    - `CrossEngineBoundary` interface:
      - `subcircuitElement: SubcircuitHost` — the original subcircuit element (not flattened)
      - `internalCircuit: Circuit` — the subcircuit's internal circuit definition
      - `internalEngineType: EngineType` — the engine type of the internal circuit
      - `outerEngineType: EngineType` — the engine type of the outer circuit
      - `pinMappings: BoundaryPinMapping[]` — one per subcircuit interface pin
      - `instanceName: string` — scoped name for diagnostics
    - `BoundaryPinMapping` interface:
      - `pinLabel: string` — the interface pin's label (matches In/Out element label inside)
      - `direction: 'in' | 'out'` — from the subcircuit's perspective (In = data flows into subcircuit, Out = data flows out)
      - `outerNodeId?: number` — filled in later by the compiler (net ID in the outer circuit)
      - `innerLabel: string` — label of the corresponding In/Out element inside the subcircuit
      - `bitWidth: number` — bus width; for multi-bit signals, each bit gets its own bridge adapter pair. A bus of width N creates N independent `DigitalToAnalogBridge` + `AnalogToDigitalBridge` pairs, one per bit. The compiler iterates bits 0..bitWidth-1.
- **Tests**:
  - `src/engine/__tests__/flatten-bridge.test.ts::CrossEngine::analog_subcircuit_in_digital_not_flattened` — create digital circuit containing an analog-engine subcircuit; flatten; assert the analog subcircuit appears in `crossEngineBoundaries`, not in the flattened circuit's elements
  - `src/engine/__tests__/flatten-bridge.test.ts::CrossEngine::digital_subcircuit_in_analog_not_flattened` — create analog circuit containing a digital-engine subcircuit; flatten; assert boundary recorded
  - `src/engine/__tests__/flatten-bridge.test.ts::CrossEngine::same_engine_subcircuit_still_flattened` — digital subcircuit in digital circuit; assert no boundaries, normal flattening
  - `src/engine/__tests__/flatten-bridge.test.ts::CrossEngine::simulation_mode_digital_overrides` — analog circuit, subcircuit with `simulationMode: 'digital'`; assert boundary recorded even if subcircuit is analog-engine
  - `src/engine/__tests__/flatten-bridge.test.ts::CrossEngine::pin_mappings_correct` — subcircuit with 2 inputs + 1 output; assert 3 `BoundaryPinMapping` entries with correct labels and directions
  - `src/engine/__tests__/flatten-bridge.test.ts::CrossEngine::existing_flatten_tests_unchanged` — run all existing flatten tests; assert no regression
- **Acceptance criteria**:
  - Same-engine subcircuits are flattened exactly as before (no regression)
  - Cross-engine subcircuits are preserved as boundaries with complete pin mapping information
  - `FlattenResult` carries both the flat circuit and the boundary list
  - All existing compiler and engine tests pass (they all use same-engine subcircuits)

---

### Task 4b.2.2: Analog Compiler — Bridge Adapter Insertion

- **Description**: Extend the analog compiler to process `CrossEngineBoundary` entries from the flattener. For each boundary, the compiler: (1) creates `BridgeOutputAdapter` elements for digital outputs that feed into the analog circuit, (2) creates `BridgeInputAdapter` elements for analog signals that feed into the digital subcircuit, (3) assigns MNA node IDs for the bridge adapter pins, (4) compiles the inner digital circuit separately using the digital compiler.
- **Files to modify**:
  - `src/analog/compiler.ts`:
    - Accept `FlattenResult` instead of (or in addition to) `Circuit`
    - New compilation step (after node mapping, before element stamping): for each `CrossEngineBoundary`:
      1. Compile the inner circuit: call `compileCircuit(boundary.internalCircuit, registry)` to get a `ConcreteCompiledCircuit` for the digital engine
      2. For each `BoundaryPinMapping`:
         - If direction is `'out'` (subcircuit outputs data): create a `BridgeOutputAdapter` — this adapter's node is wired to the outer circuit's net at the subcircuit pin position. Resolve pin electrical spec from circuit logic family + component/pin overrides.
         - If direction is `'in'` (subcircuit receives data): create a `BridgeInputAdapter` — this adapter reads the outer analog node voltage and feeds it as a digital input to the inner engine.
      3. Store the compiled inner circuit + bridge adapters in a `BridgeInstance` structure on the `CompiledAnalogCircuit`
    - `CompiledAnalogCircuit` gains: `bridges?: BridgeInstance[]`
  - `src/analog/bridge-instance.ts` (new file):
    - `BridgeInstance` interface:
      - `compiledInner: ConcreteCompiledCircuit` — the digital circuit compiled for the digital engine
      - `outputAdapters: BridgeOutputAdapter[]` — adapters for digital→analog signals
      - `inputAdapters: BridgeInputAdapter[]` — adapters for analog→digital signals
      - `outputPinNetIds: number[]` — net IDs in the inner digital circuit for each output adapter (the digital engine's output nets)
      - `inputPinNetIds: number[]` — net IDs in the inner digital circuit for each input adapter (the digital engine's input nets)
      - `instanceName: string` — for diagnostics
- **Tests**:
  - `src/analog/__tests__/bridge-compiler.test.ts::BridgeCompilation::compiles_digital_subcircuit_separately` — analog circuit with embedded digital subcircuit (AND gate inside); compile; assert `bridges` has 1 entry with a valid `compiledInner`
  - `src/analog/__tests__/bridge-compiler.test.ts::BridgeCompilation::creates_output_adapters` — digital subcircuit has 1 output pin; assert 1 `BridgeOutputAdapter` created, wired to the correct outer MNA node
  - `src/analog/__tests__/bridge-compiler.test.ts::BridgeCompilation::creates_input_adapters` — digital subcircuit has 2 input pins; assert 2 `BridgeInputAdapter` elements, each with correct outer MNA node
  - `src/analog/__tests__/bridge-compiler.test.ts::BridgeCompilation::inner_net_ids_mapped` — assert `outputPinNetIds` and `inputPinNetIds` map to valid net IDs in the inner compiled circuit
  - `src/analog/__tests__/bridge-compiler.test.ts::BridgeCompilation::pin_electrical_resolved` — circuit has TTL logic family; assert bridge adapters use TTL thresholds (vIH=2.0, not CMOS 3.3V's 2.0 — same values but vOH differs: 3.4 not 3.3)
- **Acceptance criteria**:
  - Digital subcircuit compiled by the digital compiler independently
  - Bridge adapters created for every pin crossing the engine boundary
  - Adapters wired to correct MNA nodes in the outer analog circuit
  - Inner circuit's net IDs mapped for coordinator to read/write signals
  - Logic family resolution applied to bridge adapter pin specs

---

## Wave 4b.3: MixedSignalCoordinator

### Task 4b.3.1: MixedSignalCoordinator — Timing Synchronization

- **Description**: Implement the `MixedSignalCoordinator` that orchestrates stepping between the outer analog engine and inner digital engines. The coordinator sits between `MNAEngine` and its bridge instances. On each analog timestep, the coordinator: (1) reads analog voltages at bridge input adapter nodes, (2) converts to digital bits via threshold detection, (3) feeds bits to the inner digital engine, (4) steps the inner digital engine, (5) reads digital outputs, (6) updates bridge output adapters with new logic levels, (7) registers breakpoints for the next expected transitions.
- **Files to create**:
  - `src/analog/mixed-signal-coordinator.ts`:
    - `class MixedSignalCoordinator`:
      - `constructor(analogEngine: MNAEngine, bridges: BridgeInstance[])`
      - `init(): void` — creates a `DigitalEngine` instance for each bridge, calls `init(bridge.compiledInner)` on each
      - `syncBeforeAnalogStep(voltages: Float64Array): void` — called by `MNAEngine` before each analog timestep:
        1. For each bridge:
           a. For each input adapter: read analog voltage at `inputNodeId` from `voltages`, call `readLogicLevel()`, convert to BitVector, call `innerEngine.setSignalValue(inputPinNetId, bit)`
           b. Step the inner digital engine: `innerEngine.step()`
           c. For each output adapter: read `innerEngine.getSignalRaw(outputPinNetId)`, call `outputAdapter.setLogicLevel(bit === 1)`, handle high-Z via `innerEngine.getSignalValue()` high-Z mask
        2. Detect output changes: if any bridge output adapter changed level since the last sync, register a breakpoint at the current analog time via `analogEngine.addBreakpoint(simTime)` so the timestep controller lands exactly on the transition
      - `syncAfterAnalogStep(voltages: Float64Array): void` — called by `MNAEngine` after each accepted timestep:
        1. Check for threshold crossings: for each bridge input adapter, compare analog voltage to previous voltage; if a threshold was crossed (entered or exited the indeterminate band), the digital subcircuit may need re-evaluation
        2. If crossings detected: re-sync (step digital engine again with updated inputs)
      - `reset(): void` — resets all inner digital engines
      - `dispose(): void` — disposes all inner digital engines
      - `readonly bridges: BridgeInstance[]`
    - Internal state per bridge:
      - `innerEngine: DigitalEngine` — the digital engine for this subcircuit
      - `prevInputBits: boolean[]` — previous digital input values (for change detection)
      - `prevOutputBits: boolean[]` — previous digital output values (for breakpoint registration)
      - `prevInputVoltages: number[]` — previous analog voltages at input adapters (for crossing detection)
- **Files to modify**:
  - `src/analog/mna-engine.ts` (the `MNAEngine` class from Phase 1):
    - In `init()`: if `compiled.bridges` is non-empty, create a `MixedSignalCoordinator`
    - In `step()`: call `coordinator.syncBeforeAnalogStep(voltages)` before the NR solve, `coordinator.syncAfterAnalogStep(voltages)` after the timestep is accepted
    - In `reset()`: call `coordinator.reset()`
    - In `dispose()`: call `coordinator.dispose()`
- **Tests**:
  - `src/analog/__tests__/mixed-signal-coordinator.test.ts::Sync::digital_output_drives_analog_node` — bridge with 1 digital output (AND gate, both inputs high); init coordinator; sync; assert output adapter's logic level is true and analog node voltage ≈ vOH
  - `src/analog/__tests__/mixed-signal-coordinator.test.ts::Sync::analog_input_drives_digital` — bridge with 1 input adapter; set analog node voltage to 3.3V (above vIH); sync; assert inner digital engine's input net is 1
  - `src/analog/__tests__/mixed-signal-coordinator.test.ts::Sync::analog_input_below_threshold_drives_low` — analog voltage at 0.5V (below vIL); sync; assert inner engine's input net is 0
  - `src/analog/__tests__/mixed-signal-coordinator.test.ts::Sync::output_change_registers_breakpoint` — first sync: output high. Change digital input to make output low. Second sync: assert `addBreakpoint()` was called on the analog engine
  - `src/analog/__tests__/mixed-signal-coordinator.test.ts::Sync::no_change_no_breakpoint` — sync twice with same inputs; assert no breakpoint registered on second sync
  - `src/analog/__tests__/mixed-signal-coordinator.test.ts::Sync::threshold_crossing_triggers_resync` — analog voltage transitions from 1.0V to 3.0V (crosses vIH=2.0) between two timesteps; assert `syncAfterAnalogStep` detects the crossing and re-evaluates the digital engine
  - `src/analog/__tests__/mixed-signal-coordinator.test.ts::Lifecycle::reset_resets_inner_engines` — call `reset()`; assert inner engine state is reset (outputs back to initial values)
  - `src/analog/__tests__/mixed-signal-coordinator.test.ts::Lifecycle::dispose_disposes_inner_engines` — call `dispose()`; assert inner engines are disposed
- **Acceptance criteria**:
  - Digital outputs appear as correct voltages in the analog MNA through bridge adapters
  - Analog inputs are threshold-converted and fed to the digital engine correctly
  - Output transitions register breakpoints so the analog timestep controller handles the discontinuity
  - Threshold crossings on analog inputs trigger digital re-evaluation
  - Multiple bridges (multiple digital subcircuits in one analog circuit) work independently
  - Reset and dispose propagate to all inner engines

---

## Wave 4b.4: Integration Tests + Bridge Diagnostics

### Task 4b.4.1: Bridge Diagnostics

- **Description**: Add diagnostic emissions for common mixed-signal issues: signals lingering in the indeterminate voltage band, impedance mismatches between the analog source and bridge input, and digital output contention through the bridge.
- **Files to modify**:
  - `src/analog/mixed-signal-coordinator.ts`:
    - In `syncBeforeAnalogStep()`: when `readLogicLevel()` returns `undefined` (indeterminate) for more than N consecutive timesteps (N=10), emit diagnostic `bridge-indeterminate-input` (warning) with the pin label, current voltage, and threshold values
    - In `syncAfterAnalogStep()`: when a threshold crossing is detected on every timestep for M consecutive steps (M=20), emit `bridge-oscillating-input` (warning) — the analog signal may be oscillating around a threshold
  - `src/analog/compiler.ts`:
    - During bridge compilation: if the outer circuit drives a bridge input through a very high impedance (R_source > 100 × R_in, detectable from the net's driver component), emit `bridge-impedance-mismatch` (info) suggesting the source may not reliably drive the digital input
- **Files to create**:
  - `src/analog/__tests__/bridge-diagnostics.test.ts`:
    - Tests listed below
- **Tests**:
  - `src/analog/__tests__/bridge-diagnostics.test.ts::Diagnostics::indeterminate_input_warns` — hold bridge input voltage at 1.5V (between vIL and vIH) for 15 timesteps; assert `bridge-indeterminate-input` diagnostic emitted with pin label and voltage
  - `src/analog/__tests__/bridge-diagnostics.test.ts::Diagnostics::stable_input_no_warning` — hold voltage at 3.3V (well above vIH) for 100 timesteps; assert no `bridge-indeterminate-input` diagnostic
  - `src/analog/__tests__/bridge-diagnostics.test.ts::Diagnostics::oscillating_input_warns` — voltage alternates between 1.9V and 2.1V (crossing vIH=2.0) every timestep for 25 steps; assert `bridge-oscillating-input` diagnostic
- **Acceptance criteria**:
  - Indeterminate inputs produce a warning after sustained ambiguity (not on transient glitches)
  - Oscillating inputs are detected and warned about
  - Diagnostics include pin labels and voltage values for actionable debugging
  - No false positives during normal transient simulation (brief threshold crossings during edges are expected)

---

### Task 4b.4.2: End-to-End Bridge Integration Tests

- **Description**: Full pipeline integration tests that compile and simulate mixed-signal circuits through the bridge.
- **Files to create**:
  - `src/analog/__tests__/bridge-integration.test.ts`:
    - **Test circuit A**: Analog voltage source (3.3V) → resistor divider → bridge input → digital NOT gate subcircuit → bridge output → analog resistor load to ground.
    - **Test circuit B**: Analog sine wave source → bridge input → digital 4-bit counter subcircuit (clocked by the sine wave threshold crossings) → 4 bridge outputs → 4 analog LED indicator circuits.
    - **Tests**:
      - `Integration::not_gate_subcircuit_inverts` — drive bridge input with 3.3V (logic high); solve DC OP; assert bridge output node ≈ vOL (NOT inverts)
      - `Integration::not_gate_subcircuit_low_input` — drive bridge input with 0V; assert bridge output ≈ vOH
      - `Integration::output_voltage_through_load` — bridge output through 10kΩ load to ground; assert voltage divider: vOH × 10kΩ / (rOut + 10kΩ)
      - `Integration::transient_edge_propagation` — step input from 0V to 3.3V; run transient; assert output transitions from vOH to vOL with RC time constant from bridge pin capacitance
      - `Integration::counter_counts_on_threshold_crossings` — sine wave crosses vIH threshold; after 4 rising edges, assert counter output is 4 (binary 0100)
      - `Integration::bidirectional_nesting` — analog circuit containing a digital subcircuit that itself contains an analog sub-subcircuit (resistor divider); assert correct voltage propagation through one bridge layer. The coordinator supports one level of nesting: analog→digital→analog. Recursive nesting (analog→digital→analog→digital→...) is not supported in this phase. The test verifies the single-level case only.
- **Acceptance criteria**:
  - Simple digital subcircuits (NOT, counter) produce correct results when bridged into analog circuits
  - Output voltages are consistent with the pin electrical model (R_out loading, C_out edge rates)
  - Threshold crossings on a sine wave clock correctly trigger digital engine stepping
  - Nested mixed-signal (analog → digital → analog) works
  - All existing analog and digital tests pass unchanged

---

## Diagnostic Codes Added

| Code | Severity | Meaning |
|------|----------|---------|
| `bridge-indeterminate-input` | warning | Bridge input voltage has been in the indeterminate band (between V_IL and V_IH) for >10 consecutive timesteps |
| `bridge-oscillating-input` | warning | Bridge input voltage oscillates across a threshold every timestep for >20 consecutive steps |
| `bridge-impedance-mismatch` | info | Analog source impedance is very high relative to bridge input impedance — may not reliably drive the digital input |

## Key Files Summary

| File | Purpose |
|------|---------|
| `src/analog/bridge-adapter.ts` | `BridgeOutputAdapter`, `BridgeInputAdapter` — MNA elements for bridge pins |
| `src/analog/bridge-instance.ts` | `BridgeInstance` — compiled inner circuit + adapter mappings |
| `src/analog/mixed-signal-coordinator.ts` | `MixedSignalCoordinator` — timing sync between engines |
| `src/engine/cross-engine-boundary.ts` | `CrossEngineBoundary`, `BoundaryPinMapping` — flattener output for cross-engine subcircuits |
| `src/engine/flatten.ts` | Modified: selective flattening, `FlattenResult` return type |
| `src/analog/compiler.ts` | Modified: bridge adapter insertion during analog compilation |
| `src/analog/mna-engine.ts` | Modified: coordinator integration into engine lifecycle |
