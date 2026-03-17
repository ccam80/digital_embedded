# Phase 4a: Digital-Analog Interface Layer + Behavioral Stamps

## Overview

Build the unified digital-analog interface layer: logic family configuration with named presets, per-pin electrical specifications (impedance, capacitance, thresholds), the `DigitalPinModel` MNA stamping helper, and behavioral analog implementations of core digital gates and a D flip-flop. At the end of this phase, individual digital components can be placed in analog circuits and simulated in the MNA engine with correct input loading, output drive strength, realistic edge rates from pin capacitance, and threshold-based level detection. This phase also renames the native file format from `.digb` to `.dts`.

The pin model built here is a **shared primitive** reused by:
- **Phase 4b** (Two-Engine Bridge): bridge adapters stamp the same pin model, driven by a separate digital engine
- **Phase 4c** (Transistor-Level Models): optional replacement when the user enables transistor expansion
- **Phase 6** (Tier 3 digital-in-analog): all digital-in-analog components are built on this interface

## Dependencies

- **Phase 0** (Interface Abstraction) must be complete: `Engine` base interface, `AnalogEngine` interface, `CompiledAnalogCircuit`, `analogFactory` on `ComponentDefinition`, registry `engineType` support
- **Phase 1** (MNA Engine Core) must be complete: `SparseSolver`, `AnalogElement` interface, `MNAAssembler`, `newtonRaphson()`, companion model infrastructure (`updateCompanion()`), `TimestepController`, `MNAEngine`, `compileAnalogCircuit()`
- Can run **in parallel** with Phase 2 (Tier 1 Components) and Phase 3 (Analog UI Features)

## Wave structure and dependencies

```
Wave 4a.0: File Format Rename (.digb → .dts)            [no phase dependencies]
Wave 4a.1: Logic Family + Pin Electrical Infrastructure  [depends on Phase 0]
Wave 4a.2: Digital Pin Model (MNA elements)              [depends on Phase 1 + 4a.1]
Wave 4a.3: Behavioral Combinational Gates                [depends on 4a.2]
Wave 4a.4: Behavioral Sequential Components              [depends on 4a.3]
Wave 4a.5: Compiler Integration + Simulation Mode Toggle [depends on 4a.3]
```

Waves 4a.0 and 4a.1 can run in parallel. Wave 4a.4 and 4a.5 are sequential: Task 4a.5.3 (integration test) depends on `BehavioralDFlipflopElement` from Task 4a.4.1. Execute Wave 4a.4 first, then Wave 4a.5.

---

## Wave 4a.0: File Format Rename

### Task 4a.0.1: Rename .digb to .dts

- **Description**: Rename the native JSON format from `.digb` to `.dts`. Change the format tag from `'digb'` to `'dts'`. Rename all internal types (`Digb*` → `Dts*`), file names, and references. Add a backward-compatibility shim in the validator that accepts `format: 'digb'` and treats it as `'dts'`.
- **Files to rename**:
  - `src/io/digb-schema.ts` → `src/io/dts-schema.ts`
  - `src/io/digb-serializer.ts` → `src/io/dts-serializer.ts`
  - `src/io/digb-deserializer.ts` → `src/io/dts-deserializer.ts`
  - `src/io/__tests__/digb-schema.test.ts` → `src/io/__tests__/dts-schema.test.ts`
- **Files to modify**:
  - `src/io/dts-schema.ts` (after rename):
    - Rename `DigbPoint` → `DtsPoint`, `DigbElement` → `DtsElement`, `DigbWire` → `DtsWire`, `DigbCircuit` → `DtsCircuit`, `DigbDocument` → `DtsDocument`
    - Change `format: 'digb'` → `format: 'dts'` in the `DtsDocument` interface
    - In `validateDtsDocument()` (renamed from `validateDigbDocument`): accept both `format === 'dts'` and `format === 'digb'` (compat shim); all other validation unchanged
    - Update all error messages from `.digb` to `.dts`
  - `src/io/dts-serializer.ts` (after rename):
    - Update imports to reference `dts-schema.js`
    - Rename `encodeDigbBigint` → `encodeDtsBigint`
    - Serializer outputs `format: 'dts'` in new documents
    - Rename all `Digb*` type references to `Dts*`
  - `src/io/dts-deserializer.ts` (after rename):
    - Update imports to reference `dts-schema.js`
    - Rename `Digb*` type references to `Dts*`
    - The compat shim in the validator handles old `'digb'` format tags transparently
  - `src/io/file-resolver.ts` — update `.digb` extension check to `.dts`
  - `src/io/postmessage-adapter.ts` — update any `.digb` references to `.dts`
  - `src/app/app-init.ts` — update file extension in save dialog, load detection, and any format references
  - `simulator.html` — update any `.digb` references
  - `src/fsm/fsm-serializer.ts` — Update doc-comment references from `.digb` to `.dts` in `src/fsm/fsm-serializer.ts` (comments only — no code logic changes).
  - `src/io/load.ts` — update imports from `digb-deserializer` to `dts-deserializer` and any `.digb` format checks
  - `src/io/save.ts` — update imports from `digb-serializer` to `dts-serializer` and any `.digb` format references
  - All test files importing the old module names (grep for `digb` across `src/` to find all import sites)
  - `src/io/__tests__/dts-schema.test.ts` (after rename) — update all `'digb'` string literals to `'dts'`; add test for backward compat
  - `src/io/__tests__/postmessage-adapter.test.ts` — update `.digb` references
- **Tests**:
  - `src/io/__tests__/dts-schema.test.ts::Validation::accepts_format_dts` — validate a document with `format: 'dts'`; assert passes
  - `src/io/__tests__/dts-schema.test.ts::Validation::accepts_legacy_format_digb` — validate a document with `format: 'digb'`; assert passes (backward compatibility)
  - `src/io/__tests__/dts-schema.test.ts::Validation::rejects_unknown_format` — validate a document with `format: 'foo'`; assert throws
  - `src/io/__tests__/dts-schema.test.ts::Serialization::round_trip_dts` — serialize a circuit, deserialize; assert identical structure and `format === 'dts'` in output
- **Acceptance criteria**:
  - New files are saved with `.dts` extension and `format: 'dts'`
  - Files with `format: 'digb'` load correctly (compat shim)
  - All internal type names use `Dts*` prefix
  - All existing tests pass after renaming (no functional changes)
  - No `.digb` string literals remain in source (except the compat check and test for it)

---

## Wave 4a.1: Logic Family + Pin Electrical Infrastructure

### Task 4a.1.1: Logic Family Configuration + Presets

- **Description**: Define the `LogicFamilyConfig` type, built-in presets for CMOS 3.3V, CMOS 5V, and TTL, and extend `CircuitMetadata` with a `logicFamily` field that controls the default electrical characteristics of all digital pins in the circuit.
- **Files to create**:
  - `src/core/__tests__/logic-family.test.ts`
  - `src/core/logic-family.ts`:
    - `LogicFamilyConfig` interface:
      - `name: string` — preset name for display (`'CMOS 3.3V'`, `'CMOS 5V'`, `'TTL'`, `'Custom'`)
      - `vdd: number` — supply voltage (V)
      - `vOH: number` — output high voltage (V)
      - `vOL: number` — output low voltage (V)
      - `vIH: number` — input high threshold (V)
      - `vIL: number` — input low threshold (V)
      - `rOut: number` — default output impedance (Ω)
      - `rIn: number` — default input impedance (Ω)
      - `cIn: number` — default input capacitance (F)
      - `cOut: number` — default output capacitance (F)
      - `rHiZ: number` — Hi-Z state impedance (Ω)
    - `LOGIC_FAMILY_PRESETS: Record<string, LogicFamilyConfig>`:
      - `'cmos-3v3'`: `{ name: 'CMOS 3.3V', vdd: 3.3, vOH: 3.3, vOL: 0.0, vIH: 2.0, vIL: 0.8, rOut: 50, rIn: 1e7, cIn: 5e-12, cOut: 5e-12, rHiZ: 1e7 }`
      - `'cmos-5v'`: `{ name: 'CMOS 5V', vdd: 5.0, vOH: 5.0, vOL: 0.0, vIH: 3.5, vIL: 1.5, rOut: 50, rIn: 1e7, cIn: 5e-12, cOut: 5e-12, rHiZ: 1e7 }`
      - `'ttl'`: `{ name: 'TTL', vdd: 5.0, vOH: 3.4, vOL: 0.35, vIH: 2.0, vIL: 0.8, rOut: 80, rIn: 4e3, cIn: 5e-12, cOut: 5e-12, rHiZ: 1e7 }`
    - `defaultLogicFamily(): LogicFamilyConfig` — returns `LOGIC_FAMILY_PRESETS['cmos-3v3']`
    - `getLogicFamilyPreset(key: string): LogicFamilyConfig | undefined`
- **Files to modify**:
  - `src/core/circuit.ts`:
    - Add `logicFamily?: LogicFamilyConfig` to `CircuitMetadata` (optional — omitted means `defaultLogicFamily()`)
    - Import `LogicFamilyConfig` and `defaultLogicFamily` from `logic-family.js`
- **Tests**:
  - `src/core/__tests__/logic-family.test.ts::Presets::cmos_3v3_values_correct` — assert `LOGIC_FAMILY_PRESETS['cmos-3v3']` has `vdd === 3.3`, `vOH === 3.3`, `vOL === 0.0`, `vIH === 2.0`, `vIL === 0.8`, `rOut === 50`, `rIn === 1e7`
  - `src/core/__tests__/logic-family.test.ts::Presets::ttl_values_correct` — assert TTL preset has `vOH === 3.4`, `vOL === 0.35`, `rIn === 4e3`
  - `src/core/__tests__/logic-family.test.ts::Presets::all_presets_have_positive_impedances` — iterate all presets; assert `rOut > 0`, `rIn > 0`, `rHiZ > 0`, `cIn > 0`, `cOut > 0` for each
  - `src/core/__tests__/logic-family.test.ts::Presets::all_presets_thresholds_ordered` — assert `vOL < vIL < vIH < vOH` for each preset
  - `src/core/__tests__/logic-family.test.ts::Default::default_returns_cmos_3v3` — assert `defaultLogicFamily().vdd === 3.3`
- **Acceptance criteria**:
  - Three built-in presets with physically realistic values
  - `vOL < vIL < vIH < vOH` invariant holds for all presets
  - `CircuitMetadata.logicFamily` is optional; when absent, `defaultLogicFamily()` is used
  - Presets are imported from `src/core/logic-family.ts` — no analog-engine dependency

---

### Task 4a.1.2: Pin Electrical Specification on ComponentDefinition

- **Description**: Add an optional `PinElectricalSpec` to `ComponentDefinition` that allows per-component-type (and per-pin) override of the circuit-level logic family defaults. Most digital components omit this entirely and inherit defaults. Components with unusual drive characteristics (open-drain outputs, Schmitt trigger inputs, high-current drivers) override specific fields.
- **Files to create**:
  - `src/core/__tests__/pin-electrical.test.ts`
  - `src/core/pin-electrical.ts`:
    - `PinElectricalSpec` interface:
      - `rOut?: number` — output impedance override (Ω)
      - `cOut?: number` — output capacitance override (F)
      - `rIn?: number` — input impedance override (Ω)
      - `cIn?: number` — input capacitance override (F)
      - `vOH?: number` — output high voltage override (V)
      - `vOL?: number` — output low voltage override (V)
      - `vIH?: number` — input high threshold override (V)
      - `vIL?: number` — input low threshold override (V)
      - `rHiZ?: number` — Hi-Z impedance override (Ω)
    - `resolvePinElectrical(family: LogicFamilyConfig, pinOverride?: PinElectricalSpec, componentOverride?: PinElectricalSpec): ResolvedPinElectrical` — merges overrides onto family defaults. Pin override takes priority over component override, which takes priority over family defaults.
    - `ResolvedPinElectrical` interface — same fields as `LogicFamilyConfig` but all required (no optionals — fully resolved)
- **Files to modify**:
  - `src/core/registry.ts`:
    - Add `pinElectrical?: PinElectricalSpec` to `ComponentDefinition` — component-level override applying to all pins
    - Add `pinElectricalOverrides?: Record<string, PinElectricalSpec>` to `ComponentDefinition` — per-pin overrides keyed by pin label (e.g., `{ "Q": { rOut: 25 } }` for a high-drive output)
- **Tests**:
  - `src/core/__tests__/pin-electrical.test.ts::Resolve::family_defaults_used_when_no_overrides` — resolve with CMOS 3.3V, no overrides; assert all fields match the preset
  - `src/core/__tests__/pin-electrical.test.ts::Resolve::component_override_takes_priority` — resolve with family vOH=3.3 and component override vOH=2.8; assert resolved vOH=2.8
  - `src/core/__tests__/pin-electrical.test.ts::Resolve::pin_override_beats_component` — resolve with component rOut=50 and pin override rOut=25; assert resolved rOut=25
  - `src/core/__tests__/pin-electrical.test.ts::Resolve::partial_override_preserves_other_fields` — override only rOut; assert all other fields still match family defaults
  - `src/core/__tests__/pin-electrical.test.ts::Resolve::all_fields_required_in_result` — assert every field of `ResolvedPinElectrical` is a finite positive number
- **Acceptance criteria**:
  - `PinElectricalSpec` is entirely optional on `ComponentDefinition` — existing digital registrations are unaffected
  - Resolution cascade: pin override > component override > circuit logic family > `defaultLogicFamily()`
  - `ResolvedPinElectrical` has no optional fields — downstream code never needs null checks

---

## Wave 4a.2: Digital Pin Model (MNA Elements)

### Task 4a.2.1: DigitalPinModel — Reusable MNA Stamp Helper

- **Description**: Implement the `DigitalPinModel` class — a reusable helper that stamps the analog equivalent of one digital pin into the MNA matrix. This is NOT a standalone `AnalogElement`; it's a utility used inside behavioral elements and bridge adapters. It handles both input pins (R_in to ground + C_in companion + threshold detection) and output pins (Norton equivalent: conductance + current source + C_out companion). Hi-Z state switches from the Norton equivalent to R_HiZ to ground.
- **Files to create**:
  - `src/analog/digital-pin-model.ts`:
    - `class DigitalOutputPinModel`:
      - `constructor(spec: ResolvedPinElectrical)` — stores resolved electrical parameters
      - `init(nodeId: number, branchIdx: number): void` — assigns the node this pin drives. `branchIdx` is accepted for compatibility with elements that need branch variables (e.g., Phase 4b bridge adapters); for Norton-equivalent outputs, `branchIdx` is accepted but unused (`this.branchIndex = -1`).
      - `setLogicLevel(high: boolean): void` — sets output voltage to `spec.vOH` (high) or `spec.vOL` (low); marks dirty for re-stamping
      - `setHighZ(hiZ: boolean): void` — when true, disconnects the Norton equivalent and stamps R_HiZ to ground instead; when false, reconnects the Norton equivalent
      - `stamp(solver: SparseSolver): void` — stamps the linear portion:
        - Normal mode: Norton equivalent — conductance `1/rOut` from node to ground plus current source `V_out/rOut` into the node in the RHS. This avoids needing a branch variable for the voltage source, simplifying the matrix.
        - Hi-Z mode: conductance `1/rHiZ` from node to ground
      - `stampCompanion(solver: SparseSolver, dt: number, method: IntegrationMethod): void` — stamps the companion model for C_out (conductance + history current, same as capacitor companion from Phase 1)
      - `updateCompanion(dt: number, method: IntegrationMethod, voltage: number): void` — updates C_out companion state for new timestep
      - `readonly nodeId: number`
      - `readonly currentVoltage: number` — the target output voltage (V_OH or V_OL)
      - `readonly isHiZ: boolean`
    - `class DigitalInputPinModel`:
      - `constructor(spec: ResolvedPinElectrical)` — stores resolved electrical parameters
      - `init(nodeId: number, groundNode: number): void` — assigns the node this pin reads
      - `stamp(solver: SparseSolver): void` — stamps `1/rIn` conductance from node to ground (input loading)
      - `stampCompanion(solver: SparseSolver, dt: number, method: IntegrationMethod): void` — stamps the companion model for C_in
      - `updateCompanion(dt: number, method: IntegrationMethod, voltage: number): void` — updates C_in companion state
      - `readLogicLevel(voltage: number): boolean | undefined` — applies threshold: `voltage > vIH` → true, `voltage < vIL` → false, between → undefined (indeterminate)
      - `readonly nodeId: number`
    - Both classes maintain internal state for the companion model: previous voltage and previous companion current (same state as Phase 1's capacitor companion model).
- **Tests**:
  - `src/analog/__tests__/digital-pin-model.test.ts::OutputPin::stamps_norton_equivalent` — create output pin with rOut=50, vOH=3.3; call `setLogicLevel(true)` then `stamp()`; verify solver received conductance `1/50` at (node, node) and RHS current `3.3/50`
  - `src/analog/__tests__/digital-pin-model.test.ts::OutputPin::stamps_hiz_resistance` — call `setHighZ(true)` then `stamp()`; verify solver received conductance `1/rHiZ` and no voltage source contribution
  - `src/analog/__tests__/digital-pin-model.test.ts::OutputPin::switches_between_drive_and_hiz` — alternate between `setHighZ(false)` and `setHighZ(true)`; verify stamp changes accordingly
  - `src/analog/__tests__/digital-pin-model.test.ts::OutputPin::companion_stamps_capacitance` — call `stampCompanion()` with dt=1e-6, trapezoidal method, cOut=5e-12; verify conductance `2*C/dt` added
  - `src/analog/__tests__/digital-pin-model.test.ts::InputPin::stamps_input_resistance` — create input pin with rIn=1e7; call `stamp()`; verify conductance `1e-7` at (node, node)
  - `src/analog/__tests__/digital-pin-model.test.ts::InputPin::threshold_detection_high` — `readLogicLevel(3.0)` with vIH=2.0; assert returns `true`
  - `src/analog/__tests__/digital-pin-model.test.ts::InputPin::threshold_detection_low` — `readLogicLevel(0.5)` with vIL=0.8; assert returns `false`
  - `src/analog/__tests__/digital-pin-model.test.ts::InputPin::threshold_detection_indeterminate` — `readLogicLevel(1.5)` with vIL=0.8, vIH=2.0; assert returns `undefined`
  - `src/analog/__tests__/digital-pin-model.test.ts::InputPin::companion_stamps_capacitance` — same as output pin test but for cIn
- **Acceptance criteria**:
  - Output pin in normal mode stamps Norton equivalent (conductance + current source) — no branch variable needed
  - Output pin in Hi-Z mode stamps only R_HiZ conductance
  - Input pin stamps load resistance and capacitance
  - Threshold detection returns `undefined` for indeterminate voltages (no guessing)
  - Companion models match Phase 1's capacitor companion coefficients exactly (trapezoidal: `2C/h`, BDF-1: `C/h`, BDF-2: `3C/2h`)
  - No allocation on the stamp hot path

---

## Wave 4a.3: Behavioral Combinational Gates

### Task 4a.3.1: BehavioralGateElement — Parameterized Factory

- **Description**: Implement the `BehavioralGateElement` class — an `AnalogElement` that wraps N `DigitalInputPinModel`s and 1 `DigitalOutputPinModel` around a truth table function. This single implementation handles all combinational gates (NOT, AND, NAND, OR, NOR, XOR) via parameterization. The element evaluates its truth table in `stampNonlinear()` and updates companion models in `updateCompanion()`.
- **Files to create**:
  - `src/analog/behavioral-gate.ts`:
    - `type GateTruthTable = (inputs: boolean[]) => boolean` — pure function mapping logic levels to output
    - `class BehavioralGateElement implements AnalogElement`:
      - `constructor(inputs: DigitalInputPinModel[], output: DigitalOutputPinModel, truthTable: GateTruthTable)`
      - `readonly nodeIndices: readonly number[]` — all input nodes + output node
      - `readonly branchIndex: number` — -1 (Norton equivalent, no branch variable)
      - `readonly isNonlinear: true` — threshold detection is a nonlinearity
      - `readonly isReactive: true` — pin capacitances require companion models
      - `stamp(solver: SparseSolver): void` — stamps all input R_in and output R_out/V_out (linear portion)
      - `stampNonlinear(solver: SparseSolver): void`:
        1. For each input pin: read node voltage from solver's current solution, call `readLogicLevel()`
        2. Handle indeterminate inputs: hold previous logic level (latching behavior in the indeterminate band). Initial logic level before first evaluation: `false` (logic LOW). Latching is per-input and persists across timesteps. When an input leaves the indeterminate band (goes clearly HIGH or LOW), the latch updates to the new level.
        3. Call `truthTable(logicLevels)` → output bit
        4. Call `output.setLogicLevel(outputBit)`
        5. Re-stamp output (the Norton current changes when V_out switches between V_OH and V_OL)
      - `updateCompanion(dt, method, voltages): void` — calls `updateCompanion()` on all input and output pin models
      - `updateOperatingPoint(voltages): void` — no-op (threshold detection handles state in stampNonlinear)
      - `label?: string`
    - Factory functions that return `analogFactory` closures for `ComponentDefinition`:
      - `makeNotAnalogFactory(): AnalogElementFactory`
      - `makeAndAnalogFactory(inputCount: number): AnalogElementFactory`
      - `makeNandAnalogFactory(inputCount: number): AnalogElementFactory`
      - `makeOrAnalogFactory(inputCount: number): AnalogElementFactory`
      - `makeNorAnalogFactory(inputCount: number): AnalogElementFactory`
      - `makeXorAnalogFactory(inputCount: number): AnalogElementFactory`
    - Type alias: `type AnalogElementFactory = (nodeIds: number[], branchIdx: number, props: PropertyBag, getTime: () => number) => AnalogElement`. Defined in `src/analog/element.ts` (Phase 1) or `src/core/registry.ts`.
    - Each factory: `(nodeIds: number[], branchIdx: number, props: PropertyBag, getTime: () => number) => AnalogElement`
      - The compiler resolves pin electrical specs before calling `analogFactory`:
        1. Read `CircuitMetadata.logicFamily` (the circuit's logic family preset name).
        2. Resolve the `LogicFamilyConfig` from the preset.
        3. For each component, merge per-pin overrides from `ComponentDefinition.pinElectricalOverrides` with the circuit-level defaults.
        4. Pass the result via `props.set('_pinElectrical', resolvedSpecs)` where `resolvedSpecs: Record<string, ResolvedPinElectrical>` is keyed by pin label.
        5. The factory reads it back via `props.get('_pinElectrical') as Record<string, ResolvedPinElectrical>`.

        The key name `_pinElectrical` is binding (not illustrative). The underscore prefix signals compiler-injected data, not a user-facing property.
      - Creates input/output pin models from the resolved specs
      - Returns a `BehavioralGateElement` with the appropriate truth table
- **Tests**:
  - `src/analog/__tests__/behavioral-gate.test.ts::AND::both_high_outputs_high` — 2-input AND, set both input node voltages to 3.3V (above vIH=2.0); run NR to convergence; assert output node voltage ≈ vOH (3.3V) through rOut
  - `src/analog/__tests__/behavioral-gate.test.ts::AND::one_low_outputs_low` — set input A to 3.3V, input B to 0V; NR converge; assert output ≈ vOL (0.0V)
  - `src/analog/__tests__/behavioral-gate.test.ts::NOT::inverts` — input at 3.3V; assert output ≈ 0V. Input at 0V; assert output ≈ 3.3V.
  - `src/analog/__tests__/behavioral-gate.test.ts::NAND::truth_table_all_combinations` — test all 4 input combinations for 2-input NAND; assert correct output voltage for each
  - `src/analog/__tests__/behavioral-gate.test.ts::XOR::truth_table_all_combinations` — test all 4 input combinations; assert correct output for each
  - `src/analog/__tests__/behavioral-gate.test.ts::NR::converges_within_5_iterations` — AND gate with inputs at known voltages; assert NR convergence in ≤ 5 iterations
  - `src/analog/__tests__/behavioral-gate.test.ts::NR::indeterminate_input_holds_previous` — input voltage at 1.5V (between vIL=0.8 and vIH=2.0); assert output holds previous value (not undefined behavior)
  - `src/analog/__tests__/behavioral-gate.test.ts::Loading::input_loads_source` — connect input pin (rIn=1e7) to a resistive voltage divider; assert node voltage slightly affected by input loading (voltage sag < 1µV for 10MΩ load on 1kΩ divider)
  - `src/analog/__tests__/behavioral-gate.test.ts::Factory::and_factory_returns_analog_element` — call `makeAndAnalogFactory(2)`; invoke the factory with node IDs; assert returned object satisfies `AnalogElement` interface
- **Acceptance criteria**:
  - One `BehavioralGateElement` class handles all combinational gate types
  - NR converges in ≤ 5 iterations for gates with stable inputs
  - Indeterminate inputs latch to previous value (no oscillation in the indeterminate band)
  - Input loading through R_in is measurable but realistic (10MΩ for CMOS)
  - Output drive through R_out produces correct voltage under load
  - All 6 gate truth tables (NOT, AND, NAND, OR, NOR, XOR) produce correct results

---

### Task 4a.3.2: Register Behavioral analogFactory on Gate ComponentDefinitions

- **Description**: Wire the behavioral analog factories from Task 4a.3.1 into the existing gate `ComponentDefinition` registrations. Add `analogFactory` and update `engineType` to `"both"` so these gates appear in both digital and analog palettes. Add the `simulationMode` property to `ComponentDefinition` and to component instance properties.
- **Files to modify**:
  - `src/core/registry.ts`:
    - Add to `ComponentDefinition`:
      - `analogFactory?: (nodeIds: number[], branchIdx: number, props: PropertyBag, getTime: () => number) => AnalogElement` — factory for creating the behavioral analog element. Added unconditionally in this task. The field does not exist prior to Phase 4a.
      - `transistorModel?: string` — name of a registered subcircuit for transistor-level expansion (populated in Phase 4c; field added now)
      - `simulationModes?: ('digital' | 'behavioral' | 'transistor')[]` — available simulation modes for this component
    - Update `engineType` field: change type from `"digital" | "analog"` to `"digital" | "analog" | "both"` to support components that work in either engine
    - Update `getByEngineType()`: when `engineType === "both"`, include in both `"digital"` and `"analog"` results
  - `src/components/gates/and.ts` — add `analogFactory: makeAndAnalogFactory(inputCount)`, `engineType: "both"`, `simulationModes: ['digital', 'behavioral']`
  - `src/components/gates/nand.ts` — same pattern with `makeNandAnalogFactory`
  - `src/components/gates/or.ts` — same with `makeOrAnalogFactory`
  - `src/components/gates/nor.ts` — same with `makeNorAnalogFactory`
  - `src/components/gates/xor.ts` — same with `makeXorAnalogFactory`
  - `src/components/gates/xnor.ts` — same with `makeXorAnalogFactory` and inverted output: use `(inputs: boolean[]) => !xorTruthTable(inputs)` — the XOR truth table with output inverted. No separate factory function needed; the `BehavioralGateElement` constructor accepts any `GateTruthTable` function.
  - `src/components/gates/not.ts` — same with `makeNotAnalogFactory`
- **Tests**:
  - `src/components/gates/__tests__/analog-gates.test.ts::Registration::and_has_analog_factory` — assert `registry.get('And')!.analogFactory` is defined
  - `src/components/gates/__tests__/analog-gates.test.ts::Registration::and_engine_type_is_both` — assert `registry.get('And')!.engineType === 'both'`
  - `src/components/gates/__tests__/analog-gates.test.ts::Registration::all_gates_have_analog_factory` — iterate ['And', 'NAnd', 'Or', 'NOr', 'XOr', 'XNOr', 'Not']; assert each has `analogFactory` defined
  - `src/components/gates/__tests__/analog-gates.test.ts::Palette::analog_palette_includes_gates` — call `registry.getByEngineType('analog')`; assert result includes 'And', 'Or', 'Not' etc.
  - `src/components/gates/__tests__/analog-gates.test.ts::Palette::digital_palette_still_includes_gates` — call `registry.getByEngineType('digital')`; assert gates still present
  - `src/components/gates/__tests__/analog-gates.test.ts::SimulationModes::and_supports_digital_and_behavioral` — assert `registry.get('And')!.simulationModes` includes `'digital'` and `'behavioral'`
- **Acceptance criteria**:
  - All 7 gate types have `analogFactory` set and `engineType: "both"`
  - `getByEngineType("analog")` returns gates; `getByEngineType("digital")` still returns them
  - All existing digital gate tests pass unchanged (no regression)
  - `simulationModes` field exists on `ComponentDefinition`; gates declare `['digital', 'behavioral']`

---

## Wave 4a.4: Behavioral Sequential Components

### Task 4a.4.1: BehavioralFlipflopElement — Edge Detection in MNA

- **Description**: Implement a behavioral D flip-flop as an `AnalogElement`. Unlike combinational gates that evaluate on every NR iteration, the flip-flop latches its D input on a rising clock edge. Clock edge detection happens in `updateCompanion()` (called once per accepted timestep, not per NR iteration): compare clock voltage at current time vs stored previous-timestep clock voltage. When a rising edge is detected (previous < V_IH and current ≥ V_IH), sample D input and update Q/Q̄ output voltages.
- **Files to create**:
  - `src/analog/behavioral-flipflop.ts`:
    - `class BehavioralDFlipflopElement implements AnalogElement`:
      - Constructor takes: clock input pin model, D input pin model, Q output pin model, Q̄ output pin model, optional set/reset input pin models
      - `readonly isNonlinear: true` — output voltage depends on latched state
      - `readonly isReactive: true` — pin capacitances + edge detection timing
      - Internal state: `_latchedQ: boolean` (current Q state), `_prevClockVoltage: number` (clock voltage at previous accepted timestep)
      - `stamp(solver): void` — stamps all pin R/C contributions (linear)
      - `stampNonlinear(solver): void` — stamps output pins based on `_latchedQ` (Q gets vOH or vOL, Q̄ gets opposite). Does NOT evaluate logic — that happens in `updateCompanion`.
      - `updateCompanion(dt, method, voltages): void`:
        1. Read current clock voltage from `voltages[clockNode]`
        2. Detect rising edge: `_prevClockVoltage < vIH && currentClockV >= vIH`
        3. If rising edge: read D input voltage, apply threshold → new Q value; update `_latchedQ`
        4. Handle asynchronous set/reset: if set pin active (voltage > vIH), force Q=true; if reset active, force Q=false. Property `resetActiveLevel: 'high' | 'low'` (default `'low'` — active-low reset, matching standard CMOS conventions). When `resetActiveLevel: 'low'`: reset is active when voltage < V_IL. Set uses the opposite convention.
        5. Update `_prevClockVoltage = currentClockV`
        6. Update all pin companion models
      - `updateOperatingPoint(voltages): void` — no-op
    - `makeDFlipflopAnalogFactory(): AnalogElementFactory`
- **Files to modify**:
  - `src/components/flipflops/d.ts` — add `analogFactory: makeDFlipflopAnalogFactory()`, `engineType: "both"`, `simulationModes: ['digital', 'behavioral']`
- **Tests**:
  - `src/analog/__tests__/behavioral-flipflop.test.ts::DFF::latches_d_on_rising_edge` — D=high, clock transitions from 0V to 3.3V; step engine; assert Q output ≈ vOH
  - `src/analog/__tests__/behavioral-flipflop.test.ts::DFF::holds_on_falling_edge` — Q=high, D=low, clock transitions from 3.3V to 0V; step; assert Q remains ≈ vOH (no change on falling edge)
  - `src/analog/__tests__/behavioral-flipflop.test.ts::DFF::q_bar_is_complement` — when Q=high, assert Q̄ ≈ vOL; when Q=low, assert Q̄ ≈ vOH
  - `src/analog/__tests__/behavioral-flipflop.test.ts::DFF::does_not_latch_during_nr_iteration` — within a single timestep, NR runs multiple iterations; assert Q does not change mid-NR even if D changes (edge detection is only in updateCompanion)
  - `src/analog/__tests__/behavioral-flipflop.test.ts::DFF::async_reset_forces_q_low` — reset pin driven high; assert Q ≈ vOL regardless of clock/D state
  - `src/analog/__tests__/behavioral-flipflop.test.ts::DFF::edge_rate_from_capacitance` — after clock edge triggers Q transition, measure output voltage vs time; assert rise time consistent with R_out × C_out time constant (voltage reaches 63% of target within 1τ ± 20%)
  - `src/analog/__tests__/behavioral-flipflop.test.ts::Registration::d_flipflop_has_analog_factory` — assert `registry.get('FlipflopD')!.analogFactory` is defined
- **Acceptance criteria**:
  - Q latches D value only on rising clock edge
  - No latching during NR iterations (edge detection in `updateCompanion` only)
  - Q̄ is always the complement of Q
  - Asynchronous set/reset override clock-triggered behavior
  - Output transitions show realistic rise/fall times from R_out × C_out
  - Registration as `engineType: "both"` with `simulationModes: ['digital', 'behavioral']`

---

## Wave 4a.5: Compiler Integration + Simulation Mode Toggle

### Task 4a.5.1: Analog Compiler Support for Behavioral Digital Components

- **Description**: Extend the analog circuit compiler (`compileAnalogCircuit()`) to handle components with `engineType: "both"` that have `analogFactory`. When compiling an analog circuit, components with `analogFactory` are compiled as analog elements using their factory function (unless the component's instance property `simulationMode` is set to `'digital'`, which is handled by Phase 4b's bridge). The compiler resolves pin electrical specs by merging the circuit's logic family, the component's `pinElectrical`, and any per-pin overrides, then passes the resolved specs to the factory.
- **Files to modify**:
  - `src/analog/compiler.ts` (the analog compiler from Phase 1 (`src/analog/compiler.ts`)). This file is created in Phase 1. If the `src/analog/` directory does not exist, Phase 1 is incomplete and must be finished first.
    - In the component enumeration step: for each component, check `engineType`:
      - `"analog"` → use `analogFactory` (existing behavior)
      - `"both"` with `analogFactory` → use `analogFactory`, passing resolved `ResolvedPinElectrical` per pin via props
      - `"digital"` without `analogFactory` → emit diagnostic `unsupported-component-in-analog` (error)
    - Add logic family resolution: read `circuit.metadata.logicFamily` (or `defaultLogicFamily()`), resolve per-pin specs using `resolvePinElectrical()`
    - The compiler resolves pin electrical specs before calling `analogFactory`:
      1. Read `CircuitMetadata.logicFamily` (the circuit's logic family preset name).
      2. Resolve the `LogicFamilyConfig` from the preset.
      3. For each component, merge per-pin overrides from `ComponentDefinition.pinElectricalOverrides` with the circuit-level defaults.
      4. Pass the result via `props.set('_pinElectrical', resolvedSpecs)` where `resolvedSpecs: Record<string, ResolvedPinElectrical>` is keyed by pin label.
      5. The factory reads it back via `props.get('_pinElectrical') as Record<string, ResolvedPinElectrical>`.

      The key name `_pinElectrical` is binding (not illustrative). The underscore prefix signals compiler-injected data, not a user-facing property.
- **Tests**:
  - `src/analog/__tests__/analog-compiler.test.ts::BehavioralCompilation::compiles_and_gate_in_analog_circuit` — create analog circuit with 2 In components + AND gate + Out component; compile; assert no errors, element count includes the AND gate's analog element
  - `src/analog/__tests__/analog-compiler.test.ts::BehavioralCompilation::resolves_logic_family_defaults` — compile with default logic family; assert the AND gate's pin models use vIH=2.0, vOH=3.3 (CMOS 3.3V defaults)
  - `src/analog/__tests__/analog-compiler.test.ts::BehavioralCompilation::respects_circuit_logic_family` — set circuit metadata logicFamily to TTL preset; compile; assert pin models use vIH=2.0, vOH=3.4 (TTL values)
  - `src/analog/__tests__/analog-compiler.test.ts::BehavioralCompilation::digital_only_component_emits_diagnostic` — place a purely digital component (no analogFactory) in an analog circuit; compile; assert `unsupported-component-in-analog` diagnostic emitted
  - `src/analog/__tests__/analog-compiler.test.ts::BehavioralCompilation::pin_override_applied` — register a gate with `pinElectricalOverrides: { "out": { rOut: 25 } }`; compile; assert output pin model has rOut=25 (not the family default 50)
- **Acceptance criteria**:
  - Analog compiler accepts `engineType: "both"` components with `analogFactory`
  - Logic family resolution cascade works: pin > component > circuit > default
  - Pure-digital components in analog circuits produce a clear diagnostic
  - Compiled circuit can be initialized on `MNAEngine` and stepped

---

### Task 4a.5.2: Simulation Mode Property on Component Instances

- **Description**: Add a `simulationMode` property to component instances that allows the user to select between available simulation modes. The property appears in the property panel only when the circuit is in analog mode and the component supports multiple modes. Default is `'behavioral'` for individual components in analog circuits.
- **Files to modify**:
  - `src/core/registry.ts`:
    - Add `'simulationMode'` to the set of well-known property keys
  - `src/editor/property-panel.ts`:
    - When circuit `engineType === "analog"` and the selected component has `simulationModes` with more than one entry: show a dropdown for `simulationMode`
    - Values: filtered to modes available for this component (e.g., `['behavioral', 'digital']` for gates in Phase 4a; `['behavioral', 'digital', 'transistor']` once Phase 4c adds transistor models)
    - Default is computed at read time, never persisted: if the circuit's `engineType === 'analog'` and the component has `simulationModes.length > 1`, default to `'behavioral'`. In digital circuits, the property is hidden and the component always runs in digital mode.
  - `src/analog/compiler.ts` — This file is created in Phase 1. If the `src/analog/` directory does not exist, Phase 1 is incomplete and must be finished first.
    - Check component instance's `simulationMode` property during compilation
    - `'behavioral'` → use `analogFactory` (this task)
    - `'digital'` → skip, mark for bridge handling (Phase 4b implements the bridge; for now emit `digital-bridge-not-yet-implemented` diagnostic)
    - `'transistor'` → skip, mark for transistor expansion (Phase 4c; for now emit `transistor-model-not-yet-implemented` diagnostic)
- **Tests**:
  - `src/analog/__tests__/analog-compiler.test.ts::SimulationMode::default_is_behavioral` — component with no explicit simulationMode in analog circuit; assert compiled as behavioral analog element
  - `src/analog/__tests__/analog-compiler.test.ts::SimulationMode::explicit_behavioral_compiles` — set `simulationMode: 'behavioral'` on AND gate; assert compiles normally
  - `src/analog/__tests__/analog-compiler.test.ts::SimulationMode::digital_mode_emits_stub_diagnostic` — set `simulationMode: 'digital'` on AND gate in analog circuit; assert `digital-bridge-not-yet-implemented` diagnostic (info severity)
  - `src/analog/__tests__/analog-compiler.test.ts::SimulationMode::transistor_mode_emits_stub_diagnostic` — set `simulationMode: 'transistor'`; assert `transistor-model-not-yet-implemented` diagnostic
- **Acceptance criteria**:
  - `simulationMode` property is read during analog compilation
  - Default mode is `'behavioral'` for components with `analogFactory`
  - `'digital'` and `'transistor'` modes produce informative stub diagnostics (not errors — they're valid modes that will be implemented in Phase 4b/4c)
  - Property panel shows the dropdown only when relevant (analog circuit + multiple modes available)

---

### Task 4a.5.3: End-to-End Integration Test

- **Description**: Build and simulate a complete analog circuit containing behavioral digital gates, verifying that the full pipeline works: circuit construction → analog compilation with logic family resolution → MNA engine initialization → DC operating point → transient simulation → correct output voltages with realistic edge rates.
- **Files to create**:
  - `src/analog/__tests__/behavioral-integration.test.ts`:
    - Test circuit: voltage source (3.3V) → resistor (1kΩ) → node A → AND gate input 1; voltage source (3.3V) → resistor (1kΩ) → node B → AND gate input 2; AND gate output → resistor (10kΩ) → ground. The AND gate operates in behavioral mode with CMOS 3.3V logic family.
    - **Tests**:
      - `Integration::dc_op_with_behavioral_and_gate` — both inputs driven to 3.3V (above vIH); solve DC operating point; assert AND output node voltage ≈ 3.3V (vOH) through voltage divider of rOut and 10kΩ load
      - `Integration::dc_op_one_input_low` — input B driven to 0V; solve DC OP; assert output ≈ 0V (vOL)
      - `Integration::transient_edge_rate` — Test setup: build a circuit with an AND gate (behavioral mode) driven by two DC voltage sources (3.3V and 0V). Compile with `compileAnalogCircuit()`. Create `MNAEngine`, call `init(compiled)`. Call `dcOperatingPoint()`. Read output node voltage. Then change input A source to step from 0V→3.3V by modifying the source element (via `engine.updateParameter()`), run 100 transient steps of 0.1ns each, verify output transitions.
      - `Integration::input_loading_measurable` — connect AND gate input to a high-impedance source (100kΩ from 3.3V); assert node voltage slightly below 3.3V due to input resistance loading (3.3V × rIn / (rIn + 100kΩ))
      - `Integration::ttl_logic_family_different_thresholds` — same circuit but with TTL logic family; input at 1.5V (above TTL vIL=0.8 but below TTL vIH=2.0); assert output reflects indeterminate input handling
      - `Integration::behavioral_dff_toggle` — D flip-flop with D tied to Q̄ and clock driven by AC square wave; run transient for 4 clock periods; assert Q toggles once per rising clock edge with realistic edge rates
- **Acceptance criteria**:
  - Full pipeline works end-to-end: circuit → compile → engine → DC OP → transient
  - Output voltages match expected values within 1% (accounting for resistive divider effects)
  - Edge rates are consistent with RC time constants from pin capacitances
  - Logic family selection (CMOS vs TTL) changes thresholds and output levels
  - Behavioral D flip-flop toggles correctly in transient simulation

---

## Diagnostic Codes Added

| Code | Severity | Meaning |
|------|----------|---------|
| `unsupported-component-in-analog` | error | Digital-only component placed in analog circuit without analogFactory |
| `digital-bridge-not-yet-implemented` | info | Component set to `simulationMode: 'digital'` in analog circuit; bridge not yet available |
| `transistor-model-not-yet-implemented` | info | Component set to `simulationMode: 'transistor'`; transistor expansion not yet available |

## Key Files Summary

| File | Purpose |
|------|---------|
| `src/io/dts-schema.ts` | `.dts` format schema (renamed from `digb-schema.ts`) |
| `src/io/dts-serializer.ts` | `.dts` serializer (renamed from `digb-serializer.ts`) |
| `src/io/dts-deserializer.ts` | `.dts` deserializer (renamed from `digb-deserializer.ts`) |
| `src/core/logic-family.ts` | `LogicFamilyConfig`, presets, defaults |
| `src/core/pin-electrical.ts` | `PinElectricalSpec`, `ResolvedPinElectrical`, resolution cascade |
| `src/analog/digital-pin-model.ts` | `DigitalOutputPinModel`, `DigitalInputPinModel` — reusable MNA stamp helpers |
| `src/analog/behavioral-gate.ts` | `BehavioralGateElement`, truth table factory functions |
| `src/analog/behavioral-flipflop.ts` | `BehavioralDFlipflopElement`, edge detection in `updateCompanion()` |
