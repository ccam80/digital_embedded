# Phase 2: Tier 1 Components

## Overview

Implement the 20 core analog components, .MODEL parser, built-in device model defaults, and an arithmetic expression parser. At the end of this phase, users can build and simulate analog circuits containing resistors, capacitors, inductors, diodes, BJTs, MOSFETs, op-amps, voltage/current sources, switches, and probes — with correct DC operating point and transient results verified against analytical solutions and SPICE reference values.

## Dependencies

- **Phase 0** (Interface Abstraction) must be complete: `Engine` base interface, `AnalogEngine` interface, `CompiledAnalogCircuit`, `analogFactory` on `ComponentDefinition` with signature `analogFactory?: (nodeIds: number[], branchIdx: number, props: PropertyBag, getTime: () => number) => AnalogElement`, `engineType: "both"` support, runner analog dispatch, mode toggle.
- **Phase 1** (MNA Engine Core) must be complete: `SparseSolver`, `AnalogElement` interface, `MNAAssembler`, `newtonRaphson()`, `pnjlim()`, `fetlim()`, `TimestepController`, `HistoryStore`, `solveDcOperatingPoint()`, `MNAEngine`, `DiagnosticCollector`, `compileAnalogCircuit()`.

## Wave structure and dependencies

```
Wave 2.1: Infrastructure + Linear Elements   (depends on Phase 0 + 1)
Wave 2.2: Reactive Elements                  (depends on 2.1)
Wave 2.3: .MODEL Infrastructure              (depends on 2.1)
Wave 2.4: Semiconductor Devices              (depends on 2.2 + 2.3)
Wave 2.5: Active Blocks + Switches           (depends on 2.1 + 2.3)
Wave 2.6: Expression Parser                  (depends on 2.5)
```

Waves 2.2 and 2.3 can run in parallel. Wave 2.4 merges them. Wave 2.5 depends only on 2.1 + 2.3 (no reactive or semiconductor dependency), so it can run in parallel with 2.4.

---

## Wave 2.1: Infrastructure + Linear Elements

### Task 2.1.1: Analog Component Infrastructure

- **Description**: Add the shared infrastructure that all analog component registrations need: new `ComponentCategory` values for analog groupings, a shared no-op `ExecuteFunction` sentinel for pure-analog components, and the `engineType: "both"` value for shared components.
- **Files to modify**:
  - `src/core/registry.ts`:
    - Add `PASSIVES = "PASSIVES"`, `SEMICONDUCTORS = "SEMICONDUCTORS"`, `SOURCES = "SOURCES"`, `ACTIVE = "ACTIVE"` to the `ComponentCategory` const enum
    - Change `engineType` on `ComponentDefinition` from `"digital" | "analog"` to `"digital" | "analog" | "both"`
    - Update `getByEngineType()` to include components with `engineType: "both"` in both digital and analog results: `return et === engineType || et === "both"`
    - Export `const noOpAnalogExecuteFn: ExecuteFunction = () => {}`
- **Tests**:
  - `src/core/__tests__/registry.test.ts::AnalogInfrastructure::new_categories_accepted` — register a definition with `category: ComponentCategory.PASSIVES`, assert `getByCategory(PASSIVES)` returns it
  - `src/core/__tests__/registry.test.ts::AnalogInfrastructure::engine_type_both_appears_in_digital_and_analog` — register a definition with `engineType: "both"`, assert it appears in both `getByEngineType("digital")` and `getByEngineType("analog")`
  - `src/core/__tests__/registry.test.ts::AnalogInfrastructure::pure_analog_excluded_from_digital` — register with `engineType: "analog"`, assert absent from `getByEngineType("digital")` and present in `getByEngineType("analog")`
  - `src/core/__tests__/registry.test.ts::AnalogInfrastructure::no_op_execute_fn_is_callable` — call `noOpAnalogExecuteFn(0, new Uint32Array(4), new Uint32Array(4), stubLayout)`; assert no throw and no state mutation
- **Acceptance criteria**:
  - Four new `ComponentCategory` values compile and are usable
  - `engineType: "both"` is a valid type on `ComponentDefinition`
  - `getByEngineType()` returns shared components in both palettes
  - `noOpAnalogExecuteFn` is exported and callable
  - All existing registry tests pass unchanged

---

### Task 2.1.2: Resistor + Ground

- **Description**: Implement the resistor and ground analog components. The resistor stamps a conductance matrix (G = 1/R at four positions). The ground component is handled by the analog compiler (Phase 1) — it marks its connected node as node 0 (ground reference). Ground's `AnalogElement` is a no-op stamp; its purpose is topological, not computational. Both components get IEEE/IEC symbols via programmatic `draw()`.
- **Files to create**:
  - `src/components/passives/resistor.ts`:
    - `ResistorDefinition: ComponentDefinition` with `engineType: "analog"`, `category: PASSIVES`, `executeFn: noOpAnalogExecuteFn`
    - `analogFactory(nodeIds, branchIdx, props)` returns `AnalogElement` with:
      - `nodeIndices: [nodeIds[0], nodeIds[1]]`, `branchIndex: -1`, `isNonlinear: false`, `isReactive: false`
      - `stamp(solver)`: stamps `G = 1/R` at `(n0,n0)`, `(n1,n1)`, `-(n0,n1)`, `-(n1,n0)`
    - Pin layout: 2 pins — `A` (input, left) and `B` (output, right), both 1-bit analog
    - Property defs: `resistance` (number, default 1000, min 1e-9, unit "Ω"), `label` (string)
    - `draw()`: IEEE zigzag symbol (6 segments at 60° angles), with value label
  - `src/components/sources/ground.ts`:
    - `GroundDefinition: ComponentDefinition` with `engineType: "analog"`, `category: SOURCES`
    - `analogFactory` returns `AnalogElement` with no-op `stamp()` (ground constraint is handled by the compiler's node mapping — the compiler assigns node 0 to any node connected to a Ground component)
    - Pin layout: 1 pin — `gnd` (input, bottom)
    - Property defs: `label` (string, optional)
    - `draw()`: standard 3-line decreasing-width ground symbol
- **Files to modify**:
  - `src/core/registry.ts`: register `ResistorDefinition` and `GroundDefinition` with the component registry's analog category.

**Registration pattern (applies to all component tasks in this phase):** Every new `ComponentDefinition` must be registered in `src/core/registry.ts` with `category: 'ANALOG'` and `engineType: 'analog'`. The definition's `analogFactory` creates the corresponding `AnalogElement`.
- **Tests**:
  - `src/components/passives/__tests__/resistor.test.ts::Resistor::stamp_places_four_conductance_entries` — create resistor with R=1kΩ between nodes 1 and 2; call `stamp()` on a mock solver; assert 4 calls to `solver.stamp()` with values `±1e-3` at positions `(1,1)`, `(2,2)`, `(1,2)`, `(2,1)`
  - `src/components/passives/__tests__/resistor.test.ts::Resistor::resistance_from_props` — create with `resistance: 470`; assert stamp uses `G = 1/470`
  - `src/components/passives/__tests__/resistor.test.ts::Resistor::minimum_resistance_clamped` — create with `resistance: 0`; assert stamp uses `G = 1/1e-9` (clamped to min)
  - `src/components/sources/__tests__/ground.test.ts::Ground::stamp_is_noop` — create ground; call `stamp(solver)`; assert zero calls to `solver.stamp()` and `solver.stampRHS()`
  - `src/components/sources/__tests__/ground.test.ts::Ground::pin_layout_single_input` — assert `GroundDefinition.pinLayout` has exactly 1 pin with direction `input`
- **Acceptance criteria**:
  - Resistor stamps the correct 4-entry conductance matrix for any positive R value
  - Ground registers as analog, has a single pin, and its stamp is a no-op
  - Both components appear in the analog palette under their respective categories
  - Both have correct IEEE/IEC symbols rendered via `draw()`

**Note on `draw()` methods:** All `draw()` methods in this phase operate on `RenderContext` from Phase 0. Coordinate system: grid units (1 grid unit = 20px at default zoom). Component origin is the center of the component body. Pin positions are declared in the `PinLayout` of the `ComponentDefinition`. No tests are required for `draw()` in this phase — visual correctness is verified during integration testing.

---

### Task 2.1.3: DC Voltage Source + Current Source

- **Description**: Implement the DC voltage source (branch-based MNA stamp) and ideal current source (RHS-only stamp). The voltage source requires a branch variable — its `branchIndex` is assigned by the compiler. Both must implement `setScale(factor: number)` for the DC operating point source-stepping fallback (Phase 1's `solveDcOperatingPoint` scales sources from 0→100%).
- **Files to create**:
  - `src/components/sources/dc-voltage-source.ts`:
    - `DcVoltageSourceDefinition: ComponentDefinition` with `engineType: "analog"`, `category: SOURCES`
    - `analogFactory(nodeIds, branchIdx, props)` returns `AnalogElement` with:
      - `nodeIndices: [nodeIds[0], nodeIds[1]]`, `branchIndex: branchIdx` (must be ≥ 0), `isNonlinear: false`, `isReactive: false`
      - `stamp(solver)`: stamps incidence matrix entries at `(n+, n+b)`, `(n-, n+b)`, `(n+b, n+)`, `(n+b, n-)` with values `±1`, and `RHS[n+b] = V * scale`
      - `setScale(factor)`: stores factor, used by `stamp()` to scale the voltage
    - Pin layout: 2 pins — `pos` (+, left) and `neg` (-, right)
    - Property defs: `voltage` (number, default 5, unit "V"), `label` (string)
    - `draw()`: circle with + and - symbols inside
  - `src/components/sources/current-source.ts`:
    - `CurrentSourceDefinition: ComponentDefinition` with `engineType: "analog"`, `category: SOURCES`
    - `analogFactory` returns `AnalogElement` with:
      - `nodeIndices: [nodeIds[0], nodeIds[1]]`, `branchIndex: -1`, `isNonlinear: false`, `isReactive: false`
      - `stamp(solver)`: stamps `RHS[n+] -= I * scale`, `RHS[n-] += I * scale`
      - `setScale(factor)`: stores factor
    - Pin layout: 2 pins — `pos` (+, top) and `neg` (-, bottom)
    - Property defs: `current` (number, default 0.01, unit "A"), `label` (string)
    - `draw()`: circle with arrow inside showing current direction
- **Tests**:
  - `src/components/sources/__tests__/dc-voltage-source.test.ts::DcVoltageSource::stamp_incidence_and_rhs` — create 10V source between nodes 1,2 with branch 0 in a 3-node system (matrixSize=4); call `stamp()`; assert 4 matrix stamps at correct positions and `RHS[3] = 10`
  - `src/components/sources/__tests__/dc-voltage-source.test.ts::DcVoltageSource::set_scale_modifies_rhs` — create 10V source, `setScale(0.5)`, `stamp()`; assert `RHS[n+b] = 5`
  - `src/components/sources/__tests__/current-source.test.ts::CurrentSource::stamp_rhs_only` — create 10mA source between nodes 1,2; call `stamp()`; assert zero matrix stamps, `RHS[1] -= 0.01`, `RHS[2] += 0.01`
  - `src/components/sources/__tests__/current-source.test.ts::CurrentSource::set_scale_modifies_current` — create 10mA source, `setScale(0.3)`, `stamp()`; assert `RHS` values use `0.003`
  - **Integration test** — `src/components/passives/__tests__/resistor.test.ts::Integration::voltage_divider_dc_op` — build circuit: 10V source → 1kΩ → 2kΩ → ground; compile; run `dcOperatingPoint()`; assert node voltage at R1-R2 junction = 6.667V ± 1e-4; assert source current = 3.333mA ± 1e-6
- **Acceptance criteria**:
  - Voltage source stamps 4 incidence entries + 1 RHS entry
  - Current source stamps 2 RHS entries only (no matrix entries)
  - Both support `setScale()` for source-stepping convergence fallback
  - Voltage divider integration test passes with analytically correct values
  - Both appear in analog palette under SOURCES

---

### Task 2.1.4: Probe / Voltmeter (Shared Component)

- **Description**: Add `analogFactory` to the existing Probe component, making it a shared component visible in both digital and analog palettes. In analog mode, the probe reads node voltage — it has infinite input impedance (no stamp). The `analogFactory` returns an `AnalogElement` that records the node ID for voltage readout.
- **Files to modify**:
  - `src/components/io/probe.ts`:
    - Change `engineType` to `"both"`
    - Add `analogFactory(nodeIds, branchIdx, props)` returning `AnalogElement` with:
      - `nodeIndices: [nodeIds[0]]`, `branchIndex: -1`, `isNonlinear: false`, `isReactive: false`
      - `stamp(solver)`: no-op (infinite impedance)
      - `getVoltage(voltages: Float64Array): number`: returns `voltages[nodeIndices[0]]`
    - Existing digital `executeFn` unchanged
- **Tests**:
  - `src/components/io/__tests__/probe.test.ts::AnalogProbe::stamp_is_noop` — create analog probe; call `stamp(solver)`; assert zero solver calls
  - `src/components/io/__tests__/probe.test.ts::AnalogProbe::reads_node_voltage` — create analog probe at node 3; set `voltages[3] = 4.72`; assert `getVoltage(voltages) === 4.72`
  - `src/components/io/__tests__/probe.test.ts::AnalogProbe::definition_has_engine_type_both` — assert `ProbeDefinition.engineType === "both"`
  - `src/components/io/__tests__/probe.test.ts::AnalogProbe::appears_in_both_palettes` — register probe, assert it appears in `getByEngineType("digital")` and `getByEngineType("analog")`
- **Acceptance criteria**:
  - Probe appears in both digital and analog palettes
  - Digital behavior completely unchanged
  - Analog probe stamps nothing and reads node voltage correctly
  - All existing probe tests pass unchanged

---

## Wave 2.2: Reactive Elements

### Task 2.2.1: Capacitor + Inductor

- **Description**: Implement the capacitor and inductor. Both are reactive elements — they implement `updateCompanion()` to recompute their companion model (equivalent conductance + history current source) at each timestep. The capacitor is a 2-terminal element with no branch variable. The inductor uses a branch variable (like voltage sources) to track its current in the MNA solution vector.
- **Files to create**:
  - `src/components/passives/capacitor.ts`:
    - `CapacitorDefinition: ComponentDefinition` with `engineType: "analog"`, `category: PASSIVES`
    - `analogFactory` returns `AnalogElement` with:
      - `nodeIndices: [nodeIds[0], nodeIds[1]]`, `branchIndex: -1`, `isNonlinear: false`, `isReactive: true`
      - Internal state: `geq` (companion conductance), `ieq` (history current), `vPrev` (previous voltage), `vPrevPrev` (for BDF-2)
      - `stamp(solver)`: stamps `geq` at the 4 conductance positions + `ieq` into RHS
      - `updateCompanion(dt, method, voltages)`: computes `geq` and `ieq` using `capacitorConductance()` and `capacitorHistoryCurrent()` from `src/analog/integration.ts`; updates history (`vPrev`, `vPrevPrev`)
    - Pin layout: 2 pins — `pos` (+) and `neg` (-)
    - Property defs: `capacitance` (number, default 1e-6, min 1e-15, unit "F"), `label` (string)
    - `draw()`: two parallel plates with gap
  - `src/components/passives/inductor.ts`:
    - `InductorDefinition: ComponentDefinition` with `engineType: "analog"`, `category: PASSIVES`
    - `analogFactory` returns `AnalogElement` with:
      - `nodeIndices: [nodeIds[0], nodeIds[1]]`, `branchIndex: branchIdx` (must be ≥ 0), `isNonlinear: false`, `isReactive: true`
      - Internal state: `geq`, `ieq`, `iPrev`, `iPrevPrev`, `vPrev`
      - `stamp(solver)`: stamps companion conductance at 4 positions + incidence entries for branch row + `ieq` into RHS
      - `updateCompanion(dt, method, voltages)`: computes `geq` and `ieq` using `inductorConductance()` and `inductorHistoryCurrent()` from `src/analog/integration.ts`; updates history
    - Pin layout: 2 pins — `A` and `B`
    - Property defs: `inductance` (number, default 1e-3, min 1e-12, unit "H"), `label` (string)
    - `draw()`: 4 semi-circular arcs (coil symbol)
- **Tests**:
  - `src/components/passives/__tests__/capacitor.test.ts::Capacitor::update_companion_trapezoidal` — create 1µF capacitor, call `updateCompanion(1e-6, 'trapezoidal', voltages)` with `v(n+)=5, v(n-)=0`; assert `geq = 2C/h = 2.0` and `ieq` computed correctly
  - `src/components/passives/__tests__/capacitor.test.ts::Capacitor::update_companion_bdf1` — same but method `'bdf1'`; assert `geq = C/h = 1.0`
  - `src/components/passives/__tests__/capacitor.test.ts::Capacitor::update_companion_bdf2` — same but method `'bdf2'`; assert `geq = 3C/(2h) = 1.5`; verify it uses `vPrevPrev` history
  - `src/components/passives/__tests__/capacitor.test.ts::Capacitor::is_reactive_true` — assert `element.isReactive === true`
  - `src/components/passives/__tests__/inductor.test.ts::Inductor::stamps_branch_equation` — create 10mH inductor with branch 0; call `stamp()`; assert incidence matrix entries at branch row positions
  - `src/components/passives/__tests__/inductor.test.ts::Inductor::update_companion_trapezoidal` — create 10mH inductor, call `updateCompanion(1e-4, 'trapezoidal', voltages)` with known state; assert `geq = 2L/h = 2 × 0.01 / 1e-4 = 200`. For L=10mH and h=0.1ms (1e-4s): geq = 2L/h = 200 S. Inductor trapezoidal companion: geq = 2L/h, ieq = geq × I_prev + V_prev × geq. This stamps as a conductance geq in parallel with a current source ieq.
  - **Integration test** — `src/components/passives/__tests__/capacitor.test.ts::Integration::rc_step_response` — build circuit: 5V DC source → 1kΩ resistor → 1µF capacitor → ground; compile; run transient for 100 steps; assert `V_cap` at t=1ms ≈ 3.161V ± 0.05 (analytical: `5(1-e^(-1))`) and at t=5ms ≈ 4.966V ± 0.01
  - **Integration test** — `src/components/passives/__tests__/inductor.test.ts::Integration::rl_step_response` — build: 5V → 100Ω → 10mH inductor → ground; compile; run transient; assert inductor current at t=0.1ms ≈ 31.6mA ± 0.5mA (analytical: `(5/100)(1-e^(-1))`)
- **Acceptance criteria**:
  - Capacitor companion model produces correct `geq`/`ieq` for all three integration methods
  - Inductor companion model uses branch variable and produces correct values
  - RC step response matches analytical solution within 1% after τ
  - RL step response matches analytical solution within 2% after τ
  - Both elements declare `isReactive: true`

---

### Task 2.2.2: Potentiometer

- **Description**: Implement the potentiometer as two series resistors sharing a common wiper node. The wiper position (0.0–1.0) determines the resistance split: `R_top = R × position`, `R_bottom = R × (1 - position)`. This is a 3-terminal linear element — stamps two independent conductance matrices.
- **Files to create**:
  - `src/components/passives/potentiometer.ts`:
    - `PotentiometerDefinition: ComponentDefinition` with `engineType: "analog"`, `category: PASSIVES`
    - `analogFactory` returns `AnalogElement` with:
      - `nodeIndices: [nodeIds[0], nodeIds[1], nodeIds[2]]` (A, wiper, B), `branchIndex: -1`, `isNonlinear: false`, `isReactive: false`
      - `stamp(solver)`: stamps two conductance matrices — `G_top = 1/R_top` between nodes A and wiper, `G_bottom = 1/R_bottom` between wiper and B. Clamps both R values to minimum 1e-9Ω.
    - Pin layout: 3 pins — `A` (top), `W` (wiper, side), `B` (bottom)
    - Property defs: `resistance` (number, default 10000, unit "Ω"), `position` (number, default 0.5, min 0, max 1), `label` (string)
    - `draw()`: resistor zigzag with arrow touching the midpoint
- **Tests**:
  - `src/components/passives/__tests__/potentiometer.test.ts::Potentiometer::stamps_two_conductance_pairs` — create 10kΩ pot at position 0.5 between nodes 1,2,3; call `stamp()`; assert 8 solver.stamp calls: 4 for `G=1/5000` between nodes 1-2 and 4 for `G=1/5000` between nodes 2-3
  - `src/components/passives/__tests__/potentiometer.test.ts::Potentiometer::position_0_gives_full_resistance_on_bottom` — position=0: `R_top=0` (clamped to 1e-9), `R_bottom=R`; assert stamp conductances match
  - `src/components/passives/__tests__/potentiometer.test.ts::Potentiometer::position_1_gives_full_resistance_on_top` — position=1: `R_top=R`, `R_bottom=0` (clamped)
  - **Integration test** — `src/components/passives/__tests__/potentiometer.test.ts::Integration::pot_as_voltage_divider` — 10V source → pot (10kΩ, pos=0.3) → ground; assert wiper voltage = 10 × 0.7 = 7.0V ± 1e-4
- **Acceptance criteria**:
  - Potentiometer stamps 8 conductance entries (two 4-entry groups)
  - Position 0 and 1 clamp to minimum resistance, no division by zero
  - Wiper voltage matches analytical voltage divider within tolerance
  - 3-pin component renders with correct symbol

---

## Wave 2.3: .MODEL Infrastructure

### Task 2.3.1: .MODEL Text Parser

- **Description**: Implement a parser for SPICE `.MODEL` statements. The parser extracts the model name, device type, level, and parameter key-value pairs from standard SPICE syntax. It handles multi-line continuations (+ prefix), inline comments (* or ;), and parenthesized or bare parameter lists.
- **Files to create**:
  - `src/analog/model-parser.ts`:
    - `parseModelCard(text: string): ParsedModel | ParseError` — parses a single `.MODEL` line/block
    - `parseModelFile(text: string): { models: ParsedModel[], errors: ParseError[] }` — parses a file containing multiple `.MODEL` statements
    - `ParsedModel`: `{ name: string, deviceType: DeviceType, level: number, params: Record<string, number> }`
    - `DeviceType`: `'NPN' | 'PNP' | 'NMOS' | 'PMOS' | 'NJFET' | 'PJFET' | 'D'`
    - `ParseError`: `{ line: number, message: string }`
    - Handles: `.MODEL 2N2222 NPN (IS=14.34E-15 BF=255.9 NF=1.005 VAF=74.03 ...)`
    - Handles multi-line: `.MODEL 2N2222 NPN (\n+ IS=14.34E-15\n+ BF=255.9\n)`
    - Handles scientific notation: `1e-15`, `14.34E-15`, `1.5MEG`, `4.7K`, `100M` (SPICE multiplier suffixes)
- **Tests**:
  - `src/analog/__tests__/model-parser.test.ts::ModelParser::parses_simple_diode_model` — parse `.MODEL D1N4148 D (IS=2.52e-9 N=1.752 RS=0.568)`; assert name=`D1N4148`, type=`D`, params has `IS`, `N`, `RS` with correct numeric values
  - `src/analog/__tests__/model-parser.test.ts::ModelParser::parses_bjt_model` — parse `.MODEL 2N2222 NPN (IS=14.34E-15 BF=255.9 NF=1.005 VAF=74.03 IKF=0.2847)`; assert all 5 params extracted
  - `src/analog/__tests__/model-parser.test.ts::ModelParser::handles_multiline_continuation` — parse model with `+` continuation lines; assert all params from all lines collected
  - `src/analog/__tests__/model-parser.test.ts::ModelParser::handles_spice_suffixes` — parse `R=4.7K C=100P L=10M`; assert `4700`, `100e-12`, `10e-3`
  - `src/analog/__tests__/model-parser.test.ts::ModelParser::ignores_comments` — parse model with `* comment` and `; comment` lines; assert params from non-comment lines only
  - `src/analog/__tests__/model-parser.test.ts::ModelParser::returns_error_for_invalid_syntax` — parse `.MODEL`; assert `ParseError` with descriptive message
  - `src/analog/__tests__/model-parser.test.ts::ModelParser::multiple_models_in_file` — parse text with 3 `.MODEL` statements; assert `models.length === 3`
  - `src/analog/__tests__/model-parser.test.ts::ModelParser::level_extracted` — parse `.MODEL M1 NMOS (LEVEL=2 VTO=0.7)`; assert `level === 2`; default is 1 when omitted
- **Acceptance criteria**:
  - Parses all standard SPICE `.MODEL` syntax including continuations and suffixes
  - Extracts all 7 device types correctly
  - Returns structured errors with line numbers for invalid syntax
  - SPICE multiplier suffixes (`K`, `MEG`, `M`, `U`, `N`, `P`, `F`, `T`, `G`) all handled

---

### Task 2.3.2: Model Library + Built-in Defaults

- **Description**: Implement the model library that stores device models and provides lookup by name. Include built-in Level 2 default parameter sets for each device type so components work without explicit `.MODEL` cards.
- **Files to create**:
  - `src/analog/model-library.ts`:
    - `class ModelLibrary`:
      - `add(model: DeviceModel): void` — stores model, overwrites if name exists
      - `get(name: string): DeviceModel | undefined` — lookup by name
      - `getDefault(deviceType: DeviceType): DeviceModel` — returns built-in default for the device type
      - `getAll(): DeviceModel[]` — list all models
      - `remove(name: string): boolean` — remove by name
      - `clear(): void` — remove all user models (built-ins retained)
    - `DeviceModel`: `{ name: string, type: DeviceType, level: number, params: Record<string, number> }`
  - `src/analog/model-defaults.ts`:
    - `DIODE_DEFAULTS: Record<string, number>` — exact SPICE standard defaults: `IS=1e-14, N=1, RS=0, BV=∞, IBV=1e-3, CJO=0, VJ=0.7, M=0.5, TT=0, EG=1.11, XTI=3, KF=0, AF=1, FC=0.5`
    - `BJT_NPN_DEFAULTS: Record<string, number>` — `IS=1e-16, BF=100, NF=1.0, BR=1, NR=1, ISE=0, ISC=0, VAF=∞, VAR=∞, IKF=∞, IKR=∞, RB=0, RC=0, RE=0, CJE=0, VJE=0.75, MJE=0.33, CJC=0, VJC=0.75, MJC=0.33, TF=0, TR=0, EG=1.11, XTI=3, XTB=0, KF=0`
    - `BJT_PNP_DEFAULTS: Record<string, number>` — same values (polarity handled by the element implementation, not the defaults)
    - `MOSFET_NMOS_DEFAULTS: Record<string, number>` — `VTO=0.7, KP=120e-6, LAMBDA=0.02, PHI=0.6, GAMMA=0.37, CBD=0, CBS=0, CGDO=0, CGSO=0, W=1e-6, L=1e-6, TOX=1e-7`
    - `MOSFET_PMOS_DEFAULTS: Record<string, number>` — same keys, `VTO=-0.7, KP=60e-6` (all others identical)
    - `JFET_N_DEFAULTS: Record<string, number>` — 12 parameters
    - `JFET_P_DEFAULTS: Record<string, number>` — 12 parameters
    - Each default set includes a comment documenting the parameter name, physical meaning, and unit
- **Tests**:
  - `src/analog/__tests__/model-library.test.ts::ModelLibrary::add_and_get` — add a model, retrieve by name, assert all fields match
  - `src/analog/__tests__/model-library.test.ts::ModelLibrary::get_default_diode` — assert `getDefault('D')` returns model with exact SPICE standard defaults (IS=1e-14, N=1, RS=0, BV=∞, IBV=1e-3, CJO=0, VJ=0.7, M=0.5, TT=0, EG=1.11, XTI=3, KF=0, AF=1)
  - `src/analog/__tests__/model-library.test.ts::ModelLibrary::get_default_bjt` — assert `getDefault('NPN')` has 26 params, `BF > 0`, `IS > 0`
  - `src/analog/__tests__/model-library.test.ts::ModelLibrary::get_default_mosfet` — assert `getDefault('NMOS')` has 25 params, `VTO > 0`, `KP > 0`
  - `src/analog/__tests__/model-library.test.ts::ModelLibrary::user_model_overrides_default` — add model named `"custom_d"` with `IS=1e-10`; retrieve; assert `IS === 1e-10`
  - `src/analog/__tests__/model-library.test.ts::ModelLibrary::clear_removes_user_models_not_defaults` — add user model, call `clear()`, assert user model gone but `getDefault('D')` still works
  - `src/analog/__tests__/model-library.test.ts::ModelLibrary::all_device_types_have_defaults` — iterate all 7 device types; assert each returns a non-empty default model from `getDefault()`
- **Acceptance criteria**:
  - Every device type (D, NPN, PNP, NMOS, PMOS, NJFET, PJFET) has a built-in default parameter set
  - Default parameter values match standard SPICE defaults per circuits-engine-spec section 8
  - User models are stored and retrievable by name
  - `clear()` preserves built-in defaults

---

### Task 2.3.3: Component ↔ Model Binding + Diagnostics

- **Description**: Wire the model library into the analog compilation pipeline. When the compiler creates an `AnalogElement` for a semiconductor component, it looks up the referenced model (or the default) and passes the resolved parameters to the `analogFactory`. Emit diagnostics for unknown parameters and unsupported model levels.
- **Files to modify**:
  - `src/analog/compiler.ts`:
    - After building node map, load circuit's model library (from `CompiledAnalogCircuit.models`)
    - When creating an `AnalogElement` for a semiconductor: resolve model name from component props → `modelLibrary.get(name) ?? modelLibrary.getDefault(deviceType)` → pass `model.params` in the `props` bag under key `_modelParams`
    - If model has unknown parameters (not in the device type's known set): emit `model-param-ignored` diagnostic with parameter name and explanation
    - If model `level > 2`: emit `model-level-unsupported` diagnostic, use Level 2 equations with available params
  - `src/analog/model-library.ts`:
    - Add `KNOWN_PARAMS: Record<DeviceType, Set<string>>` listing all recognized parameter names per device type
    - Add `validateModel(model: DeviceModel): SolverDiagnostic[]` — returns diagnostics for unknown params and unsupported levels
- **Tests**:
  - `src/analog/__tests__/model-binding.test.ts::ModelBinding::compiler_passes_model_params` — register a diode component with model="D1N4148"; add D1N4148 to model library with IS=2.52e-9; compile; assert the diode AnalogElement received `IS=2.52e-9` (not the default)
  - `src/analog/__tests__/model-binding.test.ts::ModelBinding::falls_back_to_default_when_no_model` — register a diode with no model specified; compile; assert it uses `DIODE_DEFAULTS.IS`
  - `src/analog/__tests__/model-binding.test.ts::ModelBinding::unknown_param_emits_diagnostic` — add model with `FOOBAR=42`; validate; assert `model-param-ignored` diagnostic emitted mentioning "FOOBAR"
  - `src/analog/__tests__/model-binding.test.ts::ModelBinding::level_3_emits_diagnostic` — add model with `LEVEL=3`; validate; assert `model-level-unsupported` diagnostic
- **Acceptance criteria**:
  - Components receive resolved model parameters at compile time
  - Missing model name falls back to device-type default
  - Unknown parameters produce `model-param-ignored` diagnostics
  - Level 3+ models produce `model-level-unsupported` diagnostics
  - All diagnostics include plain-language explanations per circuits-engine-spec section 7

---

## Wave 2.4: Semiconductor Devices

### Task 2.4.1: Diode + Zener Diode

- **Description**: Implement the standard diode (Shockley equation with Level 2 junction capacitance and transit time) and the Zener diode (adds reverse breakdown). Both are nonlinear elements — they implement `stampNonlinear()` with linearized conductance at the current operating point, and `updateOperatingPoint()` to recompute after each NR iteration. Both use `pnjlim()` voltage limiting.
- **Files to create**:
  - `src/components/semiconductors/diode.ts`:
    - `DiodeDefinition: ComponentDefinition` with `engineType: "analog"`, `category: SEMICONDUCTORS`
    - `analogFactory(nodeIds, branchIdx, props)` returns `AnalogElement` with:
      - `nodeIndices: [nodeIds[0], nodeIds[1]]` (anode, cathode), `branchIndex: -1`
      - `isNonlinear: true`, `isReactive: false` (junction capacitance makes it reactive at Level 2 — set `isReactive: true` when CJO > 0)
      - Internal state: `vd` (diode voltage), `geq` (linearized conductance), `ieq` (Norton current), model params from `props._modelParams`
      - `stamp(solver)`: no-op (all contributions are nonlinear)
      - `stampNonlinear(solver)`: computes `Id = IS * (exp(Vd/(N*Vt)) - 1)`, linearizes to `geq = Id/(N*Vt)`, `ieq = Id - geq*Vd`; stamps 4 conductance entries + 2 RHS entries
      - `updateOperatingPoint(voltages)`: reads `Vd = V[anode] - V[cathode]`, applies `pnjlim()`, stores new `vd`
      - `checkConvergence(voltages, prev)`: checks `|Vd_new - Vd_old| < abstol + reltol * |Vd_new|`
      - When `CJO > 0`: also implements `updateCompanion()` for junction capacitance `Cj = CJO / (1 - Vd/VJ)^M` (reverse bias) or `CJO * (1 + M*Vd/VJ)` (forward), plus transit time capacitance `Ct = TT * geq`
    - Pin layout: 2 pins — `anode` (A, left) and `cathode` (K, right)
    - Property defs: `model` (string, default ""), `label` (string)
    - `draw()`: triangle pointing right with vertical bar at cathode
  - `src/components/semiconductors/zener.ts`:
    - `ZenerDiodeDefinition: ComponentDefinition` with `engineType: "analog"`, `category: SEMICONDUCTORS`
    - Extends diode behavior with reverse breakdown: when `Vd < -BV`, `Id = -IS * exp(-(Vd+BV)/(N*Vt))`; linearization includes the reverse region
    - Pin layout: same as diode
    - Property defs: `model` (string, default ""), `label` (string)
    - `draw()`: diode triangle with bent bar ends at cathode (Z-shape)
- **Tests**:
  - `src/components/semiconductors/__tests__/diode.test.ts::Diode::forward_bias_stamp` — create diode with default model, set `vd = 0.7V`; call `stampNonlinear()`; assert `geq ≈ IS/Vt × exp(Vd/Vt)` where Vd=0.7V, Vt=0.026V, using the test's specific IS value, and `ieq` matches Norton equivalent
  - `src/components/semiconductors/__tests__/diode.test.ts::Diode::reverse_bias_stamp` — set `vd = -5V`; assert `geq ≈ 0` (very small conductance) and `ieq ≈ -IS`
  - `src/components/semiconductors/__tests__/diode.test.ts::Diode::voltage_limiting_applied` — set `vd = 0.3V`, then raw NR step to `vd = 5.0V`; assert `pnjlim` compresses step to < 0.3V change
  - `src/components/semiconductors/__tests__/diode.test.ts::Diode::junction_capacitance_when_cjo_nonzero` — create diode with `CJO=10e-12, VJ=0.7, M=0.5`; assert `isReactive === true`; call `updateCompanion()` at `Vd=-2V`; assert `Cj = CJO / (1 - Vd/VJ)^M = 10pF / (1 + 2/0.7)^0.5 = 10pF / 1.964 ≈ 5.09pF` companion conductance
  - `src/components/semiconductors/__tests__/zener.test.ts::Zener::reverse_breakdown` — create zener with `BV=5.1`; set `vd = -5.5V`; call `stampNonlinear()`; assert |Id| > 1mA (breakdown current exceeds leakage by orders of magnitude at 0.4V overdrive beyond BV)
  - **Integration test (SPICE reference)** — `src/components/semiconductors/__tests__/diode.test.ts::Integration::diode_resistor_dc_op` — 5V source → 1kΩ → default diode → ground; DC OP; assert `Vd ≈ 0.665V ± 0.01V` and `I ≈ 4.335mA ± 0.05mA` (values from ngspice with same IS/N defaults)
  - **Integration test (SPICE reference)** — `src/components/semiconductors/__tests__/zener.test.ts::Integration::zener_regulator` — 12V → 1kΩ → zener (BV=5.1) → ground; DC OP; assert zener voltage ≈ 5.1V ± 0.05V
- **Acceptance criteria**:
  - Diode Shockley equation produces correct I-V characteristic across forward and reverse bias
  - Voltage limiting prevents NR divergence for step sizes > 2Vt
  - Junction capacitance activates when CJO > 0 in model params
  - Zener reverse breakdown region produces correct I-V curve
  - Integration tests match SPICE reference values within stated tolerances

---

### Task 2.4.2: LED (Shared Component)

- **Description**: Add `analogFactory` to the existing LED component for analog mode. In analog mode, the LED behaves as a diode with a specific forward voltage drop (determined by color: red ≈ 1.8V, green ≈ 2.1V, blue ≈ 3.2V) and emits light (changes visual appearance) when forward current exceeds a threshold. Same Shockley equation as the diode, but with color-dependent IS/N defaults.
- **Files to modify**:
  - `src/components/io/led.ts`:
    - Change `engineType` to `"both"`
    - Add `analogFactory` returning a diode-like `AnalogElement` with color-specific model defaults:
      - Red: `IS=1e-20, N=1.8` (Vf ≈ 1.8V at 20mA)
      - Green: `IS=1e-22, N=2.0` (Vf ≈ 2.1V at 20mA)
      - Blue: `IS=1e-26, N=2.5` (Vf ≈ 3.2V at 20mA)
    - Brightness proportional to forward current for rendering
- **Tests**:
  - `src/components/io/__tests__/led.test.ts::AnalogLED::red_led_forward_drop` — 5V → 220Ω → red LED → ground; DC OP; assert Vf ≈ 1.8V ± 0.15V
  - `src/components/io/__tests__/led.test.ts::AnalogLED::blue_led_forward_drop` — 5V → 100Ω → blue LED → ground; DC OP; assert Vf ≈ 3.2V ± 0.15V
  - `src/components/io/__tests__/led.test.ts::AnalogLED::definition_has_engine_type_both` — assert `engineType === "both"`
  - `src/components/io/__tests__/led.test.ts::AnalogLED::digital_behavior_unchanged` — assert existing digital `executeFn` still works correctly
- **Acceptance criteria**:
  - LED appears in both palettes
  - Analog forward voltage matches expected value per color
  - Digital behavior completely unchanged
  - All existing LED tests pass

---

### Task 2.4.3: NPN BJT + PNP BJT

- **Description**: Implement NPN and PNP bipolar junction transistors using the Gummel-Poon model at Level 2. The BJT is a 3-terminal nonlinear element. It stamps linearized conductances and currents between collector, base, and emitter at each NR iteration. Uses `pnjlim()` on both B-E and B-C junctions. PNP is the NPN implementation with reversed current/voltage polarities.
- **Files to create**:
  - `src/components/semiconductors/bjt.ts`:
    - `NpnBjtDefinition: ComponentDefinition` and `PnpBjtDefinition: ComponentDefinition` with `engineType: "analog"`, `category: SEMICONDUCTORS`
    - `analogFactory` returns `AnalogElement` with:
      - `nodeIndices: [nodeIds[0], nodeIds[1], nodeIds[2]]` (collector, base, emitter), `branchIndex: -1`
      - `isNonlinear: true`, `isReactive: false` (set `isReactive: true` when junction capacitances CJE/CJC > 0)
      - `polarity`: +1 for NPN, -1 for PNP (multiplied into voltage reads)
      - `stampNonlinear(solver)`: at current operating point, compute:
        - Forward current: `If = IS * (exp(Vbe/(NF*Vt)) - 1)`
        - Reverse current: `Ir = IS * (exp(Vbc/(NR*Vt)) - 1)`
        - Collector current: `Ic = If/qb - Ir/qb` where `qb` is base charge factor (Early effect via VAF/VAR, high-injection via IKF/IKB)
        - Base current: `Ib = If/BF + ISE*(exp(Vbe/(NE*Vt))-1) + Ir/BR + ISC*(exp(Vbc/(NC*Vt))-1)`
        - Linearize: compute `gm` (∂Ic/∂Vbe), `go` (∂Ic/∂Vce), `gpi` (∂Ib/∂Vbe), `gmu` (∂Ib/∂Vbc)
        - Stamp 3×3 conductance submatrix + Norton currents at C, B, E
      - `updateOperatingPoint(voltages)`: apply `pnjlim()` to Vbe and Vbc separately
      - Junction capacitances (when CJE, CJC > 0): `updateCompanion()` adds depletion and diffusion capacitance terms
    - Pin layout: 3 pins — `C` (collector), `B` (base), `E` (emitter)
    - Property defs: `model` (string, default ""), `label` (string)
    - `draw()`: NPN: circle with collector/emitter lines, arrow on emitter pointing out. PNP: arrow on emitter pointing in.
- **Tests**:
  - `src/components/semiconductors/__tests__/bjt.test.ts::NPN::active_region_stamp` — set Vbe=0.7V, Vce=5V with default model (IS=1e-16, BF=100); call `stampNonlinear()`; assert Ic ≈ 2.2mA and Ib ≈ 22µA (verifying Ic/Ib ≈ BF=100 within 5%) for the common-emitter circuit above, gm > 0, go > 0
  - `src/components/semiconductors/__tests__/bjt.test.ts::NPN::cutoff_region` — set Vbe=0V, Vce=5V; assert collector current ≈ 0 (leakage only)
  - `src/components/semiconductors/__tests__/bjt.test.ts::NPN::saturation_region` — set Vbe=0.8V, Vce=0.2V; assert both junctions forward biased, Ic limited
  - `src/components/semiconductors/__tests__/bjt.test.ts::NPN::voltage_limiting_both_junctions` — large NR step on Vbe; assert pnjlim compresses it
  - `src/components/semiconductors/__tests__/bjt.test.ts::PNP::polarity_reversed` — set Veb=0.7V; assert collector current flows in opposite direction to NPN
  - **Integration test (SPICE reference)** — `src/components/semiconductors/__tests__/bjt.test.ts::Integration::common_emitter_amplifier` — Vcc=5V, Rb=100kΩ, Rc=1kΩ, NPN with default model (IS=1e-16, BF=100), Vbb=5V; DC OP; assert Vce ≈ 2.8V ± 5%, Ic ≈ 2.2mA ± 5%, Ib ≈ 22µA ± 5% (ngspice reference: default NPN model IS=1e-16, BF=100, Vcc=5V, Rc=1kΩ, Rb=100kΩ, Vbb=5V)
- **Acceptance criteria**:
  - BJT operates correctly in all three regions (cutoff, active, saturation)
  - Gummel-Poon model includes Early effect (VAF) and high-injection (IKF) when non-zero
  - PNP is the polarity-reversed NPN (single implementation, polarity parameter)
  - `pnjlim()` applied to both junctions prevents NR divergence
  - Integration test matches SPICE reference within stated tolerance

---

### Task 2.4.4: N-MOSFET + P-MOSFET

- **Description**: Implement N-channel and P-channel MOSFETs using the Level 2 model. The MOSFET is a 3-terminal nonlinear element with three operating regions (cutoff, linear/triode, saturation). Uses `fetlim()` for Vgs voltage limiting. P-MOSFET is the N-MOSFET with reversed polarities. **Architectural note**: Structure the MOSFET implementation so that its I-V computation, voltage limiting, and capacitance calculation are in overridable methods. Phase 5 (Task 5.4.1) will extract an `AbstractFetElement` base class shared by MOSFETs and JFETs. By isolating these concerns now into dedicated methods (`computeIds`, `computeGm`, `computeGds`, `limitVoltages`, `computeCapacitances`) rather than inlining everything in `stampNonlinear`, the Phase 5 refactor becomes a mechanical extraction rather than a rewrite.
- **Files to create**:
  - `src/components/semiconductors/mosfet.ts`:
    - `NmosfetDefinition: ComponentDefinition` and `PmosfetDefinition: ComponentDefinition` with `engineType: "analog"`, `category: SEMICONDUCTORS`
    - `analogFactory` returns `AnalogElement` with:
      - `nodeIndices: [nodeIds[0], nodeIds[1], nodeIds[2]]` (drain, gate, source), `branchIndex: -1`
      - `isNonlinear: true`, `isReactive: false` (set `isReactive: true` when CBD/CBS/CGS/CGD > 0)
      - `polarity`: +1 for NMOS, -1 for PMOS
      - **I-V computation methods** (designed for future extraction into `AbstractFetElement`):
        - `computeIds(vgs: number, vds: number): number` — computes drain-source current for the three regions:
          - Threshold: `Vth = VTO + GAMMA * (sqrt(PHI + Vsb) - sqrt(PHI))` (body effect)
          - Cutoff (Vgs < Vth): `Id = 0` (plus subthreshold leakage)
          - Linear (Vds < Vgs - Vth): `Id = KP * W/L * ((Vgs-Vth)*Vds - Vds²/2) * (1 + LAMBDA*Vds)`
          - Saturation (Vds ≥ Vgs - Vth): `Id = KP/2 * W/L * (Vgs-Vth)² * (1 + LAMBDA*Vds)`
        - `computeGm(vgs: number, vds: number): number` — `∂Id/∂Vgs` for each region
        - `computeGds(vgs: number, vds: number): number` — `∂Id/∂Vds` for each region
        - `computeGmbs(vgs: number, vds: number, vsb: number): number` — `∂Id/∂Vbs` (body transconductance)
        - `limitVoltages(vgsOld: number, vgsNew: number, vdsOld: number, vdsNew: number): { vgs, vds }` — applies `fetlim()` to Vgs; detect source/drain swap for symmetric MOSFET
        - `computeCapacitances(vgs: number, vds: number): { cgs, cgd, cds, cgb }` — junction and overlap capacitances from CBD, CBS, CGS, CGD model params. Returns zeros when capacitance params are zero.
      - `stampNonlinear(solver)`: calls `computeIds`, `computeGm`, `computeGds`, `computeGmbs` at current operating point; stamps conductance matrix at D, G, S nodes + Norton current at D, S
      - `updateOperatingPoint(voltages)`: calls `limitVoltages()`
      - `updateCompanion()` (when `isReactive`): calls `computeCapacitances()`, stamps companion models
    - Pin layout: 3 pins — `D` (drain), `G` (gate), `S` (source)
    - Property defs: `model` (string, default ""), `label` (string), `W` (number, default 1e-6, unit "m"), `L` (number, default 1e-6, unit "m")
    - `draw()`: NMOS: vertical line (channel), horizontal line (gate) with gap, arrow on source pointing in. PMOS: arrow pointing out, circle on gate.
- **Tests**:
  - `src/components/semiconductors/__tests__/mosfet.test.ts::NMOS::cutoff_region` — set Vgs=0V, Vds=5V with default model (VTO=0.7); assert Id ≈ 0
  - `src/components/semiconductors/__tests__/mosfet.test.ts::NMOS::saturation_region` — set Vgs=3V, Vds=5V; assert `Id = KP/2*(Vgs-Vth)^2*(1+LAMBDA*Vds)` within 1%
  - `src/components/semiconductors/__tests__/mosfet.test.ts::NMOS::linear_region` — set Vgs=3V, Vds=0.5V; assert `Id = KP*((Vgs-Vth)*Vds - Vds^2/2)*(1+LAMBDA*Vds)` within 1%
  - `src/components/semiconductors/__tests__/mosfet.test.ts::NMOS::body_effect` — set Vsb=2V; assert Vth increases by `GAMMA*(sqrt(PHI+Vsb) - sqrt(PHI))`
  - `src/components/semiconductors/__tests__/mosfet.test.ts::NMOS::voltage_limiting` — large NR step on Vgs above threshold; assert fetlim clamps to 0.5V change
  - `src/components/semiconductors/__tests__/mosfet.test.ts::PMOS::polarity_reversed` — set Vsg=3V; assert drain current flows opposite to NMOS
  - **Integration test (SPICE reference)** — `src/components/semiconductors/__tests__/mosfet.test.ts::Integration::common_source_nmos` — Vdd=5V, Rd=1kΩ, NMOS with Vgs=3V, default model (KP=120µA/V², Vth=0.7V, W=10µ, L=1µ); DC OP; assert Vds ≈ 2.5V ± 5%, Id ≈ 2.5mA ± 5% (ngspice reference: default NMOS model KP=120µA/V², Vth=0.7V, W=10µ, L=1µ, Vdd=5V, Rd=1kΩ, Vgs=3V)
- **Acceptance criteria**:
  - MOSFET operates correctly in all three regions with correct transitions
  - Body effect modifies threshold voltage when Vsb ≠ 0
  - `fetlim()` prevents large Vgs jumps above threshold during NR iteration
  - Source/drain swap detection handles symmetric device correctly
  - PMOS is polarity-reversed NMOS
  - Integration test matches SPICE reference within stated tolerance

---

## Wave 2.5: Active Blocks + Switches

### Task 2.5.1: Ideal Op-Amp

- **Description**: Implement an ideal operational amplifier with finite gain, output saturation at power rail voltages, and a small output impedance. This is a 5-terminal nonlinear element (V+, V-, out, Vcc+, Vcc-). It operates as a voltage-controlled voltage source with gain A (default 1e6) clamped to the supply rail voltages. Nonlinear because of the saturation clamp.
- **Files to create**:
  - `src/components/active/opamp.ts`:
    - `OpAmpDefinition: ComponentDefinition` with `engineType: "analog"`, `category: ACTIVE`
    - `analogFactory` returns `AnalogElement` with:
      - `nodeIndices: [nodeIds[0], nodeIds[1], nodeIds[2], nodeIds[3], nodeIds[4]]` (in+, in-, out, vcc+, vcc-)
      - `branchIndex: -1` (Norton equivalent, no branch variable needed), `isNonlinear: true`, `isReactive: false`
      - `stampNonlinear(solver)`: The ideal op-amp uses a Norton approximation with a single branch variable for the output:
        - Stamp `G_out = 1/R_out` between the output node and ground: `G[out,out] += G_out`
        - Stamp the VCVS as a current source: `RHS[out] += A_open × (V_inp - V_inn) × G_out`
        - During NR, the Jacobian entries for the differential input are: `J[out,inp] += A_open × G_out` and `J[out,inn] -= A_open × G_out`
        - Saturation clamp: if `A_open × V_diff` exceeds `[Vcc-, Vcc+]`, clamp the output voltage and set `J[out,inp] = J[out,inn] = 0` (zero gain in saturation).
        - With `A_open = 1e6` and `R_out = 75Ω` (defaults), this is indistinguishable from an ideal op-amp for educational circuits.
      - `updateOperatingPoint(voltages)`: reads V+, V-, Vcc+, Vcc- from solution vector
    - Pin layout: 5 pins — `in+` (non-inverting), `in-` (inverting), `out`, `Vcc+`, `Vcc-`
    - Property defs: `gain` (number, default 1e6), `rOut` (number, default 75, unit "Ω"), `label` (string)
    - `draw()`: large triangle pointing right, + and - labels at inputs, power pins at top/bottom
- **Tests**:
  - `src/components/active/__tests__/opamp.test.ts::OpAmp::linear_region` — set Vdiff=1µV, Vcc+=15V, Vcc-=-15V; assert Vout = 1e6 * 1e-6 = 1.0V (within linear range)
  - `src/components/active/__tests__/opamp.test.ts::OpAmp::positive_saturation` — set Vdiff=1mV (→ Vout_ideal=1000V), Vcc+=15V; assert Vout clamped to ≈15V
  - `src/components/active/__tests__/opamp.test.ts::OpAmp::negative_saturation` — set Vdiff=-1mV; assert Vout clamped to ≈-15V
  - `src/components/active/__tests__/opamp.test.ts::OpAmp::output_impedance` — load output with 75Ω to ground; assert Vout = Vout_unloaded × R_load / (R_out + R_load) ± 0.1V. With R_load=75Ω and R_out=75Ω: Vout ≈ 0.5 × Vout_unloaded ± 0.1V
  - **Integration test** — `src/components/active/__tests__/opamp.test.ts::Integration::inverting_amplifier` — Vcc=±15V, Rin=1kΩ, Rf=10kΩ, Vin=1V DC; DC OP; assert Vout ≈ -10V ± 0.01V (gain = -Rf/Rin = -10)
  - **Integration test** — `src/components/active/__tests__/opamp.test.ts::Integration::voltage_follower` — Vcc=±15V, output tied to in-, Vin=3.7V DC; DC OP; assert Vout ≈ 3.7V ± 0.001V
- **Acceptance criteria**:
  - Op-amp linear region produces correct gain within linear range
  - Output saturates at rail voltages, not beyond
  - Output impedance behaves as a series resistance
  - Inverting amplifier gain matches -Rf/Rin within 0.1%
  - Voltage follower tracks input within 0.1%

---

### Task 2.5.2: AC Voltage Source

- **Description**: Implement a time-dependent voltage source that produces standard waveforms (sine, square, triangle, sawtooth). The source stamps the same branch equation as a DC voltage source but the voltage value changes with simulation time. The `analogFactory` receives a closure `getTime: () => number` that returns the current simulation time. The factory captures this closure and the constructed element calls `getTime()` inside `stamp()` to obtain `simTime`. This closure is provided by the compiler alongside `nodeIds`, `branchIdx`, and `props`. Square wave edges insert breakpoints via `addBreakpoint()` to ensure the timestep controller lands exactly on transitions.
- **Files to create**:
  - `src/components/sources/ac-voltage-source.ts`:
    - `AcVoltageSourceDefinition: ComponentDefinition` with `engineType: "analog"`, `category: SOURCES`
    - `analogFactory(nodeIds, branchIdx, props, getTime)` returns `AnalogElement` with:
      - Same branch-based stamp as DC voltage source
      - `stamp(solver)`: calls `getTime()` to obtain `simTime`, then stamps incidence matrix + `RHS[branch] = V(t) * scale` where:
        - Sine: `V(t) = dcOffset + amplitude * sin(2π * frequency * t + phase)`
        - Square: `V(t) = dcOffset + amplitude * sign(sin(2π * frequency * t + phase))`
        - Triangle: `V(t) = dcOffset + amplitude * (2/π) * asin(sin(2π * frequency * t + phase))`
        - Sawtooth: `V(t) = dcOffset + amplitude * (2 * (frequency * t + phase/(2π) - floor(frequency * t + phase/(2π) + 0.5)))`
      - `setScale(factor)`: for source-stepping support
      - `getBreakpoints(tStart, tEnd): number[]`: for square wave, returns edge times within [tStart, tEnd] so the engine's timestep controller can land exactly on transitions
    - Pin layout: 2 pins — `pos` (+) and `neg` (-)
    - Property defs: `amplitude` (number, default 5, unit "V"), `frequency` (number, default 1000, unit "Hz"), `phase` (number, default 0, unit "rad"), `dcOffset` (number, default 0, unit "V"), `waveform` (enum: `sine | square | triangle | sawtooth`, default `sine`), `label` (string)
    - `draw()`: circle with ~ (tilde/sine wave) symbol inside
- **Tests**:
  - `src/components/sources/__tests__/ac-voltage-source.test.ts::AcSource::sine_at_t_zero` — 5V amplitude, 1kHz, phase=0, offset=0; stamp at t=0; assert RHS voltage = 0
  - `src/components/sources/__tests__/ac-voltage-source.test.ts::AcSource::sine_at_quarter_period` — stamp at t=0.25ms (quarter period of 1kHz); assert RHS voltage = 5.0V
  - `src/components/sources/__tests__/ac-voltage-source.test.ts::AcSource::square_at_half_period` — square wave 1kHz; stamp at t=0.5ms; assert RHS voltage = -5.0V
  - `src/components/sources/__tests__/ac-voltage-source.test.ts::AcSource::triangle_linearity` — triangle wave; stamp at t=0.125ms (1/8 period); assert voltage = 2.5V (half amplitude, rising)
  - `src/components/sources/__tests__/ac-voltage-source.test.ts::AcSource::dc_offset_applied` — sine with offset=2V; stamp at t=0; assert RHS = 2.0V
  - `src/components/sources/__tests__/ac-voltage-source.test.ts::AcSource::square_wave_breakpoints` — 1kHz square; call `getBreakpoints(0, 0.002)`; assert breakpoints at 0.0005, 0.001, and 0.0015 (half-period edges for 1kHz square wave in [0, 0.002])
  - `src/components/sources/__tests__/ac-voltage-source.test.ts::AcSource::set_scale_applied` — setScale(0.5), stamp at peak; assert voltage = 2.5V
  - **Integration test** — `src/components/sources/__tests__/ac-voltage-source.test.ts::Integration::rc_lowpass` — 1kHz sine (5V) → 1kΩ → 1µF → ground; run transient for 10 periods; assert capacitor voltage amplitude ≈ 5 / sqrt(1 + (2π*1000*1e-3*1e-6)²) = 5 / sqrt(1 + 39.48) ≈ 0.786V ± 10% (accounting for transient settling)
- **Acceptance criteria**:
  - All four waveforms produce correct values at known time points
  - DC offset is additive to the waveform
  - Source scaling works for DC OP convergence fallback
  - Square wave breakpoints ensure clean transitions without ringing
  - RC lowpass integration test shows correct attenuation

---

### Task 2.5.3: Switches SPST + SPDT (Shared Components)

- **Description**: Add `analogFactory` to the existing switch components for analog mode. In analog mode, a switch is modeled as a variable resistance: `Ron` (default 1Ω) when closed, `Roff` (default 1e9Ω) when open. The user clicks to toggle state. The SPDT switch has a common terminal and two output terminals — one is Ron and the other is Roff.
- **Files to modify**:
  - `src/components/switching/plain-switch.ts`:
    - Change `engineType` to `"both"`
    - Add `analogFactory` returning `AnalogElement` with:
      - 2 nodes (A, B), stamps conductance `G = 1/Ron` or `G = 1/Roff` depending on closed state
      - `stamp(solver)`: stamps 4 conductance entries with current resistance
      - `setClosed(closed: boolean)`: updates internal state, changes which resistance to stamp
    - Add property defs: `Ron` (number, default 1, unit "Ω"), `Roff` (number, default 1e9, unit "Ω")
  - `src/components/switching/plain-switch-dt.ts`:
    - Change `engineType` to `"both"`
    - Add `analogFactory` returning `AnalogElement` with:
      - 3 nodes (common, A, B), stamps `Ron` between common and selected output, `Roff` between common and unselected output
    - Same `Ron`/`Roff` properties
- **Tests**:
  - `src/components/switching/__tests__/switches.test.ts::AnalogSwitch::closed_stamps_ron` — SPST closed, Ron=1Ω; assert conductance stamps use G=1.0
  - `src/components/switching/__tests__/switches.test.ts::AnalogSwitch::open_stamps_roff` — SPST open, Roff=1e9Ω; assert conductance stamps use G=1e-9
  - `src/components/switching/__tests__/switches.test.ts::AnalogSwitch::toggle_changes_conductance` — create closed switch, `setClosed(false)`, re-stamp; assert conductance changed from 1/Ron to 1/Roff
  - `src/components/switching/__tests__/switches.test.ts::AnalogSPDT::common_to_a_when_position_0` — SPDT position 0; assert common-A has Ron, common-B has Roff
  - `src/components/switching/__tests__/switches.test.ts::AnalogSPDT::common_to_b_when_position_1` — SPDT position 1; assert common-A has Roff, common-B has Ron
  - `src/components/switching/__tests__/switches.test.ts::AnalogSwitch::definition_has_engine_type_both` — assert both definitions have `engineType === "both"`
  - `src/components/switching/__tests__/switches.test.ts::AnalogSwitch::digital_behavior_unchanged` — assert existing digital `executeFn` still works correctly
  - **Integration test** — `src/components/switching/__tests__/switches.test.ts::Integration::switched_resistor_divider` — 10V → SPST switch (closed, Ron=1Ω) → 1kΩ → ground; DC OP; assert V across R = 10 * 1000/1001 ≈ 9.99V. Open switch; re-solve; assert V across R ≈ 0V
- **Acceptance criteria**:
  - Both switch types appear in both palettes
  - Analog mode stamps correct variable resistance
  - Toggle changes resistance between Ron and Roff
  - SPDT correctly routes between two outputs
  - All existing digital switch tests pass unchanged

---

## Wave 2.6: Expression Parser

### Task 2.6.1: Arithmetic Expression Parser

- **Description**: Implement a recursive-descent arithmetic expression parser for use in AC source waveform definitions and (future) controlled source transfer functions. This is distinct from the existing boolean expression parser in `src/analysis/expression-parser.ts` — it handles floating-point arithmetic, trigonometric functions, and named variables. Port the concept from CircuitJS's expression evaluation. **Extensibility note**: Phase 5 (Task 5.2.1) will extend this parser with `V(label)` and `I(label)` circuit-variable lookups, a `time` built-in variable, and symbolic differentiation of the AST for Jacobian computation in controlled sources. To support this cleanly: (1) design the `ExprNode` AST as an open discriminated union so new node kinds can be added without modifying existing code, (2) keep the evaluator dispatch table-driven (a `Record<kind, handler>` or switch with default) so new node kinds can be handled by extending the table, (3) export the `ExprNode` type and all AST constructors so downstream code (differentiation, compilation) can create and manipulate AST nodes programmatically.
- **Files to create**:
  - `src/analog/expression.ts`:
    - `parseExpression(text: string): ExprNode` — parses a mathematical expression string into an AST
    - `evaluateExpression(expr: ExprNode, env: Record<string, number>): number` — evaluates the AST with variable bindings. Uses a switch on `expr.kind` with a default case that throws `UnknownNodeKindError` — this ensures Phase 5's new node kinds (`circuit-voltage`, `circuit-current`, `builtin-var`) are caught if accidentally evaluated without the extended evaluator.
    - `ExprNode` — discriminated union AST:
      - `{ kind: 'number', value: number }`
      - `{ kind: 'variable', name: string }`
      - `{ kind: 'unary', op: '-', operand: ExprNode }`
      - `{ kind: 'binary', op: '+' | '-' | '*' | '/' | '^', left: ExprNode, right: ExprNode }`
      - `{ kind: 'call', fn: string, args: ExprNode[] }`
    - AST constructor helpers (exported for programmatic AST construction by Phase 5's differentiator):
      - `numNode(value: number): ExprNode`
      - `varNode(name: string): ExprNode`
      - `binOp(op, left, right): ExprNode`
      - `unaryOp(op, operand): ExprNode`
      - `callNode(fn, args): ExprNode`
    - Built-in functions: `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `exp`, `log` (natural), `log10`, `sqrt`, `abs`, `min`, `max`, `floor`, `ceil`, `round`, `pow`
    - Built-in constants: `pi` (π), `e` (Euler's number)
    - Operator precedence: `+/-` < `*//` < `^` (right-associative) < unary `-` < function call
    - Error reporting: `ExprParseError` with position and descriptive message
  - `src/analog/__tests__/expression.test.ts`:
    - Parsing + evaluation tests (see below)
- **Tests**:
  - `src/analog/__tests__/expression.test.ts::ExprParser::basic_arithmetic` — parse `"2 + 3 * 4"`; evaluate; assert result = 14
  - `src/analog/__tests__/expression.test.ts::ExprParser::operator_precedence` — parse `"2 + 3 * 4 ^ 2"`; assert result = 2 + 3*16 = 50
  - `src/analog/__tests__/expression.test.ts::ExprParser::parentheses` — parse `"(2 + 3) * 4"`; assert result = 20
  - `src/analog/__tests__/expression.test.ts::ExprParser::unary_minus` — parse `"-3 + 5"`; assert result = 2
  - `src/analog/__tests__/expression.test.ts::ExprParser::variables` — parse `"2 * t + 1"`; evaluate with `{t: 3}`; assert result = 7
  - `src/analog/__tests__/expression.test.ts::ExprParser::trig_functions` — parse `"sin(pi / 2)"`; assert result ≈ 1.0 ± 1e-10
  - `src/analog/__tests__/expression.test.ts::ExprParser::nested_functions` — parse `"sqrt(abs(-16))"`; assert result = 4.0
  - `src/analog/__tests__/expression.test.ts::ExprParser::multi_arg_functions` — parse `"max(3, 7)"`; assert result = 7
  - `src/analog/__tests__/expression.test.ts::ExprParser::exp_and_log` — parse `"log(exp(3))"`; assert result ≈ 3.0 ± 1e-10
  - `src/analog/__tests__/expression.test.ts::ExprParser::power_right_associative` — parse `"2 ^ 3 ^ 2"`; assert result = 2^(3^2) = 512 (not (2^3)^2 = 64)
  - `src/analog/__tests__/expression.test.ts::ExprParser::constants` — parse `"2 * pi"`; assert result ≈ 6.2832 ± 1e-4
  - `src/analog/__tests__/expression.test.ts::ExprParser::division_by_zero` — parse `"1 / 0"`; evaluate; assert result = Infinity (IEEE 754, no throw)
  - `src/analog/__tests__/expression.test.ts::ExprParser::missing_variable_throws` — parse `"x + 1"`; evaluate with `{}`; assert throws ExprParseError mentioning "x"
  - `src/analog/__tests__/expression.test.ts::ExprParser::invalid_syntax_throws` — parse `"2 + + 3"`; assert throws ExprParseError with position
  - `src/analog/__tests__/expression.test.ts::ExprParser::complex_expression` — parse `"5 * sin(2 * pi * 1000 * t)"`; evaluate with `{t: 0.00025}`; assert result ≈ 5.0 (quarter period of 1kHz)
- **Acceptance criteria**:
  - All arithmetic operators with correct precedence and associativity
  - All listed functions work with correct arity
  - Variables resolve from environment; missing variables throw with name
  - Parse errors include position in source string
  - IEEE 754 behavior for edge cases (div by zero, NaN propagation)
  - Parsing + evaluation of `5 * sin(2 * pi * 1000 * t)` produces correct results (this is the primary use case)

---

### Task 2.6.2: Expression Integration with AC Source

- **Description**: Add expression-based waveform support to the AC voltage source. When `waveform` is set to `"expression"`, the source evaluates a user-provided expression string with `t` (time in seconds) as the bound variable.
- **Files to modify**:
  - `src/components/sources/ac-voltage-source.ts`:
    - Add `"expression"` to the `waveform` enum
    - Add `expression` property def (string, default `"sin(2 * pi * 1000 * t)"`)
    - When `waveform === "expression"`: parse the expression string once at element creation (via `analogFactory`); evaluate at each `stamp()` call with `{ t: getTime() }` where `getTime` is the closure captured from `analogFactory`'s fourth argument
    - Parse errors emit a diagnostic (not a throw) and fall back to 0V
- **Tests**:
  - `src/components/sources/__tests__/ac-voltage-source.test.ts::ExprWaveform::custom_sine` — expression `"3 * sin(2 * pi * 500 * t)"`; stamp at t=0.0005 (half period); assert RHS ≈ 0V
  - `src/components/sources/__tests__/ac-voltage-source.test.ts::ExprWaveform::ramp` — expression `"5 * t"`; stamp at t=0.001; assert RHS = 0.005V
  - `src/components/sources/__tests__/ac-voltage-source.test.ts::ExprWaveform::invalid_expression_emits_diagnostic` — expression `"sin("`; assert diagnostic emitted and voltage defaults to 0
  - `src/components/sources/__tests__/ac-voltage-source.test.ts::ExprWaveform::expression_parsed_once` — create element; call `stamp()` twice consecutively; verify `element._parsedExpr` is the same object reference after both calls (not re-parsed)
- **Acceptance criteria**:
  - Expression waveform mode evaluates user expressions with time variable
  - Expression is parsed once at creation, not on every stamp call
  - Invalid expressions produce diagnostics, not exceptions
  - Existing waveform modes (sine, square, triangle, sawtooth) unchanged
