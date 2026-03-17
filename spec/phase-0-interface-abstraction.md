# Phase 0: Interface Abstraction

## Overview

Extract the `Engine` base interface from `SimulationEngine`, define the `AnalogEngine` contract and its associated types, extend the component registry for analog factories, extend the runner for analog dispatch, and wire up the Edit menu mode toggle. Most editor plumbing already exists: `EngineType`, palette engine filter, `WireSignalAccess` with `AnalogWireValue`, `WIRE_ANALOG` theme color, and engineType in load/save.

---

## Wave 0.1: Interface Definitions

### Task 0.1.1: Engine Base Interface

- **Description**: Extract shared lifecycle methods from `SimulationEngine` into an `Engine` base interface. `SimulationEngine` then extends `Engine` with digital-specific methods. No behavioral changes — purely a type-level refactoring.
- **Files to modify**:
  - `src/core/engine-interface.ts`:
    - Add `Engine` interface with: `init(circuit: CompiledCircuit)`, `reset()`, `dispose()`, `step()`, `start()`, `stop()`, `getState(): EngineState`, `addChangeListener(listener)`, `removeChangeListener(listener)`
    - Change `SimulationEngine` to `extends Engine`, removing the methods now on `Engine`
    - Export `Engine`
- **Tests**:
  - `src/core/__tests__/engine-interface.test.ts::EngineBaseInterface::digital_engine_satisfies_engine` — instantiate `DigitalEngine`, assign to `const e: Engine = engine`, call `e.step()`; assert no type errors and no runtime errors
  - `src/core/__tests__/engine-interface.test.ts::EngineBaseInterface::simulation_engine_extends_engine` — create a mock implementing `SimulationEngine`; assert it is assignable to a variable typed `Engine`
- **Acceptance criteria**:
  - `Engine` interface exists and is exported from `engine-interface.ts`
  - `SimulationEngine extends Engine`
  - All 25 existing `SimulationEngine` import sites compile without changes
  - All existing tests pass unchanged

---

### Task 0.1.2: AnalogEngine Interface + Associated Types + Registry Extension

- **Description**: Define the `AnalogEngine` interface extending `Engine` with analog-specific methods, all associated types (`SimulationParams`, `DcOpResult`, `SolverDiagnostic`, `CompiledAnalogCircuit`), and extend `ComponentDefinition` with an analog factory field.
- **Files to create**:
  - `src/core/analog-engine-interface.ts`:
    - `AnalogEngine extends Engine`:
      - `dcOperatingPoint(): DcOpResult`
      - `readonly simTime: number` — current simulation time in seconds
      - `readonly lastDt: number` — last accepted timestep in seconds
      - `getNodeVoltage(nodeId: number): number`
      - `getBranchCurrent(branchId: number): number`
      - `getElementCurrent(elementId: number): number`
      - `getElementPower(elementId: number): number`
      - `configure(params: Partial<SimulationParams>): void`
      - `onDiagnostic(callback: (diag: SolverDiagnostic) => void): void`
      - `addBreakpoint(time: number): void` — register a time at which the timestep controller must land a step exactly; used by the mixed-signal coordinator (Phase 4) and by source components with discontinuities (square wave edges, etc.)
      - `clearBreakpoints(): void` — remove all registered breakpoints
    - `SimulationParams`: `{ maxTimeStep, minTimeStep, reltol, abstol, chargeTol, maxIterations, integrationMethod: 'auto' | 'trapezoidal' | 'bdf1' | 'bdf2', gmin }` with defaults as specified in circuits-engine-spec.md section 2
    - `DcOpResult`: `{ converged, method: 'direct' | 'gmin-stepping' | 'source-stepping', iterations, nodeVoltages: Float64Array, diagnostics: SolverDiagnostic[] }`
    - `SolverDiagnostic`: `{ code: SolverDiagnosticCode, severity: 'info' | 'warning' | 'error', summary, explanation, suggestions: DiagnosticSuggestion[], involvedNodes?, involvedElements?, simTime?, detail? }`
    - `SolverDiagnosticCode` — type union of all diagnostic codes: `'singular-matrix' | 'voltage-source-loop' | 'floating-node' | 'inductor-loop' | 'no-ground' | 'convergence-failed' | 'timestep-too-small' | 'width-mismatch' | 'unconnected-input' | 'unconnected-output' | 'multi-driver-no-tristate' | 'missing-subcircuit' | 'label-collision' | 'combinational-loop' | 'missing-property' | 'unknown-component'`
    - `DiagnosticSuggestion`: `{ text, automatable, patch? }`
    - `CompiledAnalogCircuit extends CompiledCircuit`:
      - `readonly nodeCount: number` — number of non-ground MNA nodes
      - `readonly elementCount: number` — number of analog elements
      - `readonly labelToNodeId: Map<string, number>` — for runner label resolution
      - `readonly wireToNodeId: Map<Wire, number>` — for wire renderer signal access
- **Files to modify**:
  - `src/core/registry.ts`:
    - Add `analogFactory?: (nodeIds: number[], branchIdx: number, props: PropertyBag, getTime: () => number) => AnalogElement` to `ComponentDefinition` — factory for creating analog element instances. `getTime` is a closure returning current simulation time (used by time-dependent sources).
    - Add `requiresBranchRow?: boolean` to `ComponentDefinition` — defaults to `false`. When `true`, the analog compiler assigns an MNA branch index to this component before calling `analogFactory`. Used by voltage sources and inductors.
    - Add `getInternalNodeCount?: (props: PropertyBag) => number` to `ComponentDefinition` — returns the number of internal MNA nodes this component requires. Called by the analog compiler before matrix allocation. Defaults to 0 if not implemented. Used by components with variable internal topology (e.g., transmission line with configurable segment count).
    - Import `AnalogElement` type from `src/analog/element.ts` using a `type`-only import: `import type { AnalogElement } from '../analog/element.js'`. The file is created in Phase 1, Task 1.2.2. The import resolves at compile time only — no runtime dependency on Phase 1.
- **Tests**:
  - `src/core/__tests__/analog-engine-interface.test.ts::AnalogEngineTypes::simulation_params_has_all_fields` — construct a `SimulationParams` literal with all fields; assert it compiles and default values match spec
  - `src/core/__tests__/analog-engine-interface.test.ts::AnalogEngineTypes::dc_op_result_structure` — construct `DcOpResult` with `converged: true, method: 'direct', diagnostics: []`; assert valid
  - `src/core/__tests__/analog-engine-interface.test.ts::AnalogEngineTypes::compiled_analog_extends_compiled` — construct a `CompiledAnalogCircuit` with `netCount: 5, componentCount: 3`; assert it satisfies `CompiledCircuit`
  - `src/core/__tests__/analog-engine-interface.test.ts::AnalogEngineTypes::solver_diagnostic_codes_exhaustive` — assert every code from the spec's diagnostic table is a valid `SolverDiagnosticCode` value
  - `src/core/__tests__/analog-engine-interface.test.ts::AnalogEngineTypes::analog_engine_extends_engine` — assert a mock `AnalogEngine` is assignable to `Engine`
- **Acceptance criteria**:
  - All types from circuits-engine-spec.md sections 2 and 7 are defined and exported
  - `AnalogEngine extends Engine` — any code holding an `Engine` reference can accept an `AnalogEngine`
  - `CompiledAnalogCircuit extends CompiledCircuit` — runner label resolution works via `labelToNodeId`
  - `ComponentDefinition.analogFactory` is optional and does not affect existing digital component registrations
  - `addBreakpoint` and `clearBreakpoints` are part of the `AnalogEngine` contract from day 1

---

## Wave 0.2: Runner + Mode Integration

### Task 0.2.1: SimulationRunner Analog Dispatch

- **Description**: Extend `SimulationRunner` to detect `circuit.metadata.engineType` and dispatch to the appropriate compiler and engine factory. Add analog signal access methods.
- **Files to modify**:
  - `src/headless/runner.ts`:
    - Change `WeakMap<SimulationEngine, EngineRecord>` to `WeakMap<Engine, EngineRecord>` (import `Engine` from `engine-interface.ts`)
    - Add `engineType: EngineType` to `EngineRecord`
    - `compile()`: read `circuit.metadata.engineType`; when `"analog"`, call `compileAnalogCircuit()` (stub) and create an analog engine via factory
    - `setInput()`: for analog engines, resolve label via `compiled.labelToNodeId`, set voltage
    - `readOutput()`: for analog engines, resolve label via `compiled.labelToNodeId`, return `getNodeVoltage()`
    - `readAllSignals()`: dispatch based on engine type
    - Add `dcOperatingPoint(engine: Engine): DcOpResult` — narrows to `AnalogEngine`, throws if digital
- **Files to create**:
  - `src/analog/compiler.ts` — stub: `export function compileAnalogCircuit(circuit: Circuit, registry: ComponentRegistry): CompiledAnalogCircuit` that throws `new Error("Analog compiler not yet implemented — Phase 1 delivers this")`
- **Tests**:
  - `src/headless/__tests__/runner.test.ts::AnalogDispatch::compile_digital_circuit_returns_digital_engine` — assert existing behavior unchanged: digital engineType produces a working digital engine
  - `src/headless/__tests__/runner.test.ts::AnalogDispatch::compile_analog_circuit_throws_not_implemented` — assert analog engineType throws "not yet implemented" (until Phase 1)
  - `src/headless/__tests__/runner.test.ts::AnalogDispatch::dc_operating_point_throws_for_digital_engine` — assert `dcOperatingPoint()` on a digital engine throws TypeError
- **Acceptance criteria**:
  - Digital circuits compile and run exactly as before (no regression)
  - Analog path is stubbed with a clear error message
  - Runner's WeakMap accepts both engine types via `Engine` base
  - All existing runner tests pass unchanged

---

### Task 0.2.2: Edit Menu Mode Toggle

- **Description**: Add an Edit menu item to switch between digital and analog circuit modes. The toggle writes `circuit.metadata.engineType`, swaps the palette engine filter, and triggers recompilation.
- **Files to modify**:
  - `src/app/app-init.ts`:
    - Add Edit menu item "Circuit Mode: Digital / Analog" (toggle with checkmark showing current mode)
    - On toggle: set `circuit.metadata.engineType`, call `palette.setEngineTypeFilter(newMode)`, call `paletteUI.render()`, mark circuit dirty for recompilation
    - Read `circuit.metadata.engineType` at load time and set the palette filter accordingly
    - In `compileAndBind()`: when `engineType === "analog"`, skip digital compilation (stub: show status message "Analog simulation not yet available")
- **Tests**:
  - `src/app/__tests__/mode-toggle.test.ts::ModeToggle::toggle_sets_metadata_engine_type` — assert toggling from digital to analog writes `circuit.metadata.engineType = "analog"` and vice versa
  - `src/app/__tests__/mode-toggle.test.ts::ModeToggle::toggle_updates_palette_filter` — assert `palette.getEngineTypeFilter()` matches the new mode after toggle
  - `src/app/__tests__/mode-toggle.test.ts::ModeToggle::load_analog_circuit_sets_palette_filter` — assert loading a circuit with `engineType: "analog"` in metadata sets the palette filter to analog
- **Acceptance criteria**:
  - Edit menu shows current circuit mode with a checkmark or label
  - Toggling changes palette to show only components matching the engine type
  - Circuit metadata is updated and persisted on save
  - Loading a .digb with `engineType: "analog"` automatically sets analog mode
  - Digital compilation is unaffected by the toggle machinery
