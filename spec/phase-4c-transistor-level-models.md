# Phase 4c: Transistor-Level Models

## Overview

Add first-class support for transistor-level component models. When a user enables "transistor model" on a digital component, the analog compiler expands it into its transistor-level subcircuit (e.g., a CMOS inverter becomes a PMOS + NMOS pair) before MNA assembly. The expanded subcircuit uses Phase 2's MOSFET and BJT models directly — no pin electrical wrapper is needed because the transistors provide the electrical interface natively. Ship transistor-level models for 8 fundamental gates and a D flip-flop.

## Dependencies

- **Phase 2** (Tier 1 Components) must be complete: N-MOSFET, P-MOSFET component definitions with Level 2 models, ground, DC voltage source
- **Phase 4a** must be complete: `simulationModes` field on `ComponentDefinition`, `transistorModel` field, `simulationMode` property on component instances, analog compiler handling of simulation modes
- Can run **in parallel** with Phase 4b (two-engine bridge) — no shared dependencies beyond Phase 4a

## Wave structure and dependencies

```
Wave 4c.1: Compiler Transistor Expansion         [depends on Phase 2 + Phase 4a]
Wave 4c.2: CMOS Gate Transistor Models            [depends on 4c.1]
Wave 4c.3: CMOS D Flip-Flop Transistor Model      [depends on 4c.2]
```

Waves are sequential. 4c.2 and 4c.3 could be parallelized (both depend on 4c.1) but the flip-flop model builds on gate models, so sequential is cleaner.

---

## Wave 4c.1: Compiler Transistor Expansion

### Task 4c.1.1: Transistor Model Expansion in Analog Compiler

- **Description**: Extend the analog compiler to handle `simulationMode: 'transistor'`. When a component has `transistorModel` set (a registered subcircuit name) and its instance `simulationMode` is `'transistor'`, the compiler expands it: look up the transistor model subcircuit by name, flatten it into analog leaf components (resistors, MOSFETs, voltage sources, etc.), wire the subcircuit's interface pins (In/Out elements) to the component's pin nodes in the outer circuit, and include all expanded elements in the MNA assembly. This is conceptually similar to `flattenCircuit()` but operates at analog compile time and only expands components marked for transistor-level simulation.

  Note: `expandTransistorModel` is independent of `flattenCircuit()` (Phase 4b). It operates at analog compile time and does not reuse Phase 4b code. Phases 4b and 4c can run in parallel.

- **Files to modify**:
  - `src/analog/compiler.ts`:
    - New compilation step (before element stamping, after node mapping): for each component where `simulationMode === 'transistor'` and `def.transistorModel` is defined:
      1. Look up `modelRegistry.get(def.transistorModel)` — retrieves the `Circuit` from the `TransistorModelRegistry`
      2. Flatten the internal circuit (it should contain no further subcircuits — transistor models are leaf-level)
      3. Map the subcircuit's In/Out interface pins to the component's pin nodes in the outer circuit:
         - For each In element in the subcircuit: its label matches a pin label on the original component. Wire the In element's output node to the outer node that connects to that pin.
         - For each Out element: similarly wire the Out element's input node.
      4. Create `AnalogElement` instances for each internal component (resistor, MOSFET, etc.) using their `analogFactory`
      5. Assign internal nodes (nodes within the transistor model that don't connect to interface pins) unique MNA node IDs
      6. Add all elements to the compiled circuit's element list
    - VDD injection: if any component has `simulationMode: 'transistor'`, the compiler reads `logicFamily.vdd` from `CircuitMetadata`, creates one VDD node, and inserts one DC voltage source element (`V = logicFamily.vdd`) between the VDD node and ground (node 0). The VDD node ID is passed to `expandTransistorModel()`. All transistor model subcircuits share this single VDD node.
    - When `simulationMode === 'transistor'` but `transistorModel` is undefined: emit `missing-transistor-model` diagnostic (error)
    - When the transistor model subcircuit contains non-analog components: emit `invalid-transistor-model` diagnostic (error)
- **Files to create**:
  - `src/analog/transistor-model-registry.ts`:
    - `TransistorModelRegistry` — stores transistor model subcircuits:
      ```
      class TransistorModelRegistry {
        private models = new Map<string, Circuit>();
        register(name: string, circuit: Circuit): void;
        get(name: string): Circuit | undefined;
        has(name: string): boolean;
      }
      ```
    - This is separate from `ComponentRegistry` which stores `ComponentDefinition` objects. Populated by `registerAllCmosGateModels(modelRegistry)`.
  - `src/analog/transistor-expansion.ts`:
    - `expandTransistorModel(componentDef: ComponentDefinition, outerPinNodeIds: number[], modelRegistry: TransistorModelRegistry, vddNodeId: number, gndNodeId: number, nextNodeId: () => number): TransistorExpansionResult`
      - `outerPinNodeIds`: array of MNA node IDs for each of the component's pins, indexed by pin order
      - `vddNodeId`: the shared VDD node ID injected by the compiler
      - `gndNodeId`: ground node ID (node 0)
      - `nextNodeId`: closure created by the compiler with initial value = (number of external circuit nodes + 1). Each call increments and returns the next available node index. All expansions within a single compilation share the same closure, ensuring globally unique node IDs.
      - `TransistorExpansionResult`:
        - `elements: AnalogElement[]` — all analog elements from the expansion
        - `internalNodeCount: number` — number of new internal nodes allocated
        - `diagnostics: SolverDiagnostic[]` — any issues during expansion
      - Subcircuit VDD/GND binding: within each transistor model `Circuit`, the VDD rail is identified by a component with label `'VDD'` (an `In` element). The GND rail is identified by label `'GND'`. During expansion, the compiler maps the subcircuit's VDD `In` node to `vddNodeId` and the GND `In` node to `gndNodeId` (node 0).
    - This function encapsulates the expansion logic so it can be tested independently from the full compiler pipeline
- **Tests**:
  - `src/analog/__tests__/transistor-expansion.test.ts::Expansion::expands_inverter_to_two_mosfets` — register a CMOS inverter transistor model subcircuit (PMOS + NMOS) in a `TransistorModelRegistry`; call `expandTransistorModel` with `vddNodeId` and `gndNodeId` supplied by the test; assert 2 MOSFET analog elements created. The compiler (not this function) injects the shared VDD voltage source.
  - `src/analog/__tests__/transistor-expansion.test.ts::Expansion::interface_pins_mapped_correctly` — inverter model has In labeled "in" and Out labeled "out"; assert the MOSFET gate nodes connect to the outer circuit's input node, and the MOSFET drain node connects to the outer output node; VDD `In` node maps to `vddNodeId`, GND `In` node maps to `gndNodeId`
  - `src/analog/__tests__/transistor-expansion.test.ts::Expansion::internal_nodes_get_unique_ids` — create a `nextNodeId` closure starting at (outerNodeCount + 1); assert all internal nodes get unique IDs that don't collide with outer circuit nodes or with each other
  - `src/analog/__tests__/transistor-expansion.test.ts::Expansion::missing_transistor_model_emits_diagnostic` — component with `simulationMode: 'transistor'` but no `transistorModel`; assert `missing-transistor-model` diagnostic
  - `src/analog/__tests__/transistor-expansion.test.ts::Expansion::invalid_model_with_digital_components_emits_diagnostic` — transistor model subcircuit containing a digital-only component (e.g., FlipflopD without analogFactory); assert `invalid-transistor-model` diagnostic
  - `src/analog/__tests__/transistor-expansion.test.ts::Expansion::multiple_expansions_independent` — expand two NOT gates from the same transistor model sharing the same `nextNodeId` closure; assert each expansion gets independent internal node IDs (no sharing between the two expansions)
- **Acceptance criteria**:
  - Transistor model subcircuits are expanded into leaf analog elements at compile time
  - Interface pins are correctly wired to the outer circuit's nodes
  - Internal nodes get unique IDs that don't collide with outer circuit or other expansions
  - Missing or invalid transistor models produce clear diagnostics
  - Non-transistor components in the same circuit are unaffected

---

## Wave 4c.2: CMOS Gate Transistor Models

### Task 4c.2.1: Define Transistor-Level Subcircuits for Basic Gates

- **Description**: Create transistor-level subcircuit definitions for the 7 basic logic gates + buffer. Each subcircuit is a `Circuit` object containing MOSFET components wired as standard CMOS logic. These subcircuits are registered in the `TransistorModelRegistry` and referenced by the `transistorModel` field on the corresponding gate `ComponentDefinition`. The subcircuits use Phase 2's N-MOSFET and P-MOSFET components with default model parameters.
- **Files to create**:
  - `src/analog/transistor-models/cmos-gates.ts`:
    - `createCmosInverter(modelRegistry: TransistorModelRegistry): Circuit` — PMOS (source→VDD, gate→input, drain→output) + NMOS (source→GND, gate→input, drain→output). Interface: In "in", Out "out", VDD rail, GND rail.
    - `createCmosNand2(modelRegistry: TransistorModelRegistry): Circuit` — 2 PMOS in parallel (sources→VDD, gates→A/B, drains→output) + 2 NMOS in series (top drain→output, bottom source→GND, gates→A/B). Interface: In "In_1", In "In_2", Out "out".
    - `createCmosNor2(modelRegistry: TransistorModelRegistry): Circuit` — 2 NMOS in parallel + 2 PMOS in series. Dual of NAND.
    - `createCmosAnd2(modelRegistry: TransistorModelRegistry): Circuit` — NAND2 + inverter.
    - `createCmosOr2(modelRegistry: TransistorModelRegistry): Circuit` — NOR2 + inverter.
    - `createCmosXor2(modelRegistry: TransistorModelRegistry): Circuit` — transmission-gate XOR: 4 NMOS + 4 PMOS (8 MOSFETs). Two transmission gates select between input B and its complement based on input A.
    - `createCmosXnor2(modelRegistry: TransistorModelRegistry): Circuit` — transmission-gate XOR (from `createCmosXor2`) followed by a CMOS inverter (from `createCmosInverter`). Total: 10 MOSFETs.
    - `createCmosBuffer(modelRegistry: TransistorModelRegistry): Circuit` — two inverters in series (4 MOSFETs).
    - `registerAllCmosGateModels(modelRegistry: TransistorModelRegistry): void` — creates and registers the `Circuit` objects in the `TransistorModelRegistry`. Registration is done statically in each gate definition file. The gate `.ts` files set `transistorModel: 'CmosNand2'` (the registry key) and append `'transistor'` to `simulationModes`. There is no overlap — the definition files reference the model by name, the registry function creates the model circuits.

  Note: all factory functions take `modelRegistry: TransistorModelRegistry` (not `registry: ComponentRegistry`). The function signatures above replace the previous `registry: ComponentRegistry` parameter throughout this file.
- **Files to modify**:
  - `src/components/gates/not.ts` — set `transistorModel: 'CmosInverter'`, add `'transistor'` to `simulationModes`
  - `src/components/gates/and.ts` — set `transistorModel: 'CmosAnd2'`, add `'transistor'` to `simulationModes`
  - `src/components/gates/nand.ts` — set `transistorModel: 'CmosNand2'`, add `'transistor'` to `simulationModes`
  - `src/components/gates/or.ts` — set `transistorModel: 'CmosOr2'`, add `'transistor'` to `simulationModes`
  - `src/components/gates/nor.ts` — set `transistorModel: 'CmosNor2'`, add `'transistor'` to `simulationModes`
  - `src/components/gates/xor.ts` — set `transistorModel: 'CmosXor2'`, add `'transistor'` to `simulationModes`
  - `src/components/gates/xnor.ts` — set `transistorModel: 'CmosXnor2'` (XOR + inverter), add `'transistor'` to `simulationModes`
- **Tests**:
  Voltage thresholds for all DC truth table tests (VDD=3.3V): HIGH output > 3.2V, LOW output < 0.1V.

  - `src/analog/__tests__/cmos-gates.test.ts::CmosInverter::dc_transfer_curve` — use VDD=3.3V from default CMOS logic family. Sweep input voltage from 0V to VDD in 0.1V steps; solve DC OP at each; assert output voltage > 3.2V when input < VDD/2 and output < 0.1V when input > VDD/2 (standard CMOS transfer characteristic). Assert the switching threshold is between 1.32V and 1.98V (VDD/2 ± 20%).
  - `src/analog/__tests__/cmos-gates.test.ts::CmosInverter::noise_margins` — use logic family preset values: V_IH=2.0V, V_IL=0.8V. Assert simulated output: V_OH > V_IH (output HIGH exceeds input HIGH threshold) and V_OL < V_IL (output LOW is below input LOW threshold).
  - `src/analog/__tests__/cmos-gates.test.ts::CmosNand2::truth_table_dc` — for all 4 input combinations (0V/VDD): solve DC OP; assert output > 3.2V unless both inputs = VDD, in which case output < 0.1V (NAND truth table within voltage thresholds)
  - `src/analog/__tests__/cmos-gates.test.ts::CmosNor2::truth_table_dc` — for all 4 input combinations: assert output > 3.2V only when both inputs = 0V, otherwise output < 0.1V (NOR truth table within voltage thresholds)
  - `src/analog/__tests__/cmos-gates.test.ts::CmosAnd2::truth_table_dc` — assert AND truth table: output > 3.2V only when both inputs = VDD, otherwise < 0.1V
  - `src/analog/__tests__/cmos-gates.test.ts::CmosOr2::truth_table_dc` — assert OR truth table: output > 3.2V unless both inputs = 0V, otherwise < 0.1V
  - `src/analog/__tests__/cmos-gates.test.ts::CmosXor2::truth_table_dc` — assert XOR truth table within voltage thresholds (HIGH > 3.2V, LOW < 0.1V)
  - `src/analog/__tests__/cmos-gates.test.ts::CmosXnor2::truth_table_dc` — all 4 input combinations, assert output matches XNOR truth table within voltage thresholds (HIGH > 3.2V, LOW < 0.1V)
  - `src/analog/__tests__/cmos-gates.test.ts::CmosBuffer::truth_table_dc` — input LOW (0V) → output < 0.1V, input HIGH (VDD) → output > 3.2V. Buffer is two inverters in series (4 MOSFETs).
  - `src/analog/__tests__/cmos-gates.test.ts::CmosInverter::transient_propagation_delay` — step input from 0V to VDD; run transient for 5ns with max timestep 0.01ns; measure time for output to cross VDD/2 = 1.65V; assert propagation delay > 0.1ns and < 50ns for default MOSFET parameters (Level 2, KP=120µA/V², VTO=0.7V).
  - `src/analog/__tests__/cmos-gates.test.ts::CmosInverter::short_circuit_current` — drive input to VDD/2 (1.65V, mid-transition); solve DC OP; assert VDD supply current > 10µA (both PMOS and NMOS partially conducting); measure via `engine.getElementCurrent(vddSourceId)`.
  - `src/analog/__tests__/cmos-gates.test.ts::Registration::not_has_transistor_model` — assert `registry.get('Not')!.transistorModel === 'CmosInverter'`
  - `src/analog/__tests__/cmos-gates.test.ts::Registration::all_gates_have_transistor_mode` — iterate all 8 gate types (including XNOR and buffer); assert `'transistor'` is in `simulationModes`
  - `src/analog/__tests__/cmos-gates.test.ts::Registration::all_models_registered` — call `registerAllCmosGateModels(modelRegistry)`. Assert `modelRegistry.has('CmosInverter')`, `modelRegistry.has('CmosNand2')`, `modelRegistry.has('CmosNor2')`, `modelRegistry.has('CmosAnd2')`, `modelRegistry.has('CmosOr2')`, `modelRegistry.has('CmosXor2')`, `modelRegistry.has('CmosXnor2')`, `modelRegistry.has('CmosBuffer')` — all 8 names present.
- **Acceptance criteria**:
  - All 7 basic logic gate types + buffer (8 total) have transistor models registered
  - DC transfer curves show correct CMOS switching behavior (sharp transition near VDD/2)
  - Noise margins are positive (output levels clear of input thresholds)
  - Truth tables match for all input combinations at DC
  - Propagation delay emerges naturally from MOSFET capacitances (not hardcoded)
  - Short-circuit current during transitions is observable (physically correct)

---

## Wave 4c.3: CMOS D Flip-Flop Transistor Model

### Task 4c.3.1: Transistor-Level D Flip-Flop

- **Description**: Create a transmission-gate-based CMOS D flip-flop transistor model. This is the canonical master-slave D flip-flop built from transmission gates and inverters — the standard textbook design. Unlike the behavioral flip-flop (Phase 4a) which uses edge detection in `updateCompanion()`, the transistor-level flip-flop exhibits real metastability, setup/hold time violations, and clock-to-Q delay that emerge from the analog simulation.
- **Files to create**:
  - `src/analog/transistor-models/cmos-flipflop.ts`:
    - `createCmosDFlipflop(modelRegistry: TransistorModelRegistry): Circuit`:
      - Master latch: transmission gate (CLK̄ pass, CLK hold) → inverter pair (cross-coupled for storage)
      - Slave latch: transmission gate (CLK pass, CLK̄ hold) → inverter pair
      - Clock inverter: generates CLK̄ from CLK
      - Interface: In "D", In "C" (clock), Out "Q", Out "nQ"
      - Total: 20 MOSFETs (4 transmission gates × 2 MOSFETs each = 8 MOSFETs + 5 inverters × 2 MOSFETs each = 10 MOSFETs + 1 clock inverter × 2 = 2 MOSFETs. A transmission gate = 1 NMOS + 1 PMOS = 2 MOSFETs.)
    - `registerCmosDFlipflop(modelRegistry: TransistorModelRegistry): void` — registers the subcircuit in the `TransistorModelRegistry` and sets `transistorModel` on `FlipflopD`
- **Files to modify**:
  - `src/components/flipflops/d.ts` — set `transistorModel: 'CmosDFlipflop'`, add `'transistor'` to `simulationModes`
- **Tests**:
  - `src/analog/__tests__/cmos-flipflop.test.ts::CmosDFF::latches_on_rising_edge` — D=VDD (high), clock transitions 0→VDD; run transient through the edge; assert Q settles to ≈ VDD after clock-to-Q delay
  - `src/analog/__tests__/cmos-flipflop.test.ts::CmosDFF::holds_on_falling_edge` — Q=high, D=0V, clock transitions VDD→0; assert Q remains ≈ VDD
  - `src/analog/__tests__/cmos-flipflop.test.ts::CmosDFF::q_bar_complement` — when Q ≈ VDD, assert nQ ≈ 0V; when Q ≈ 0V, assert nQ ≈ VDD
  - `src/analog/__tests__/cmos-flipflop.test.ts::CmosDFF::clock_to_q_delay` — run transient for 5ns with max timestep 0.01ns; measure time from clock rising edge (50% VDD = 1.65V) to Q reaching 50% VDD (1.65V); assert delay > 0.1ns and < 50ns for default MOSFET parameters (Level 2, KP=120µA/V², VTO=0.7V)
  - `src/analog/__tests__/cmos-flipflop.test.ts::CmosDFF::setup_time_violation` — change D very close to the clock edge (within 1 gate delay); assert that at time T_end (10ns after the setup-time violation), the Q node voltage is between 0.3V and 3.0V (neither a valid HIGH nor a valid LOW for VDD=3.3V). This demonstrates the metastable state that behavioral models cannot reproduce.
  - `src/analog/__tests__/cmos-flipflop.test.ts::CmosDFF::toggle_mode` — connect nQ to D; apply clock; assert Q toggles once per clock cycle with correct timing
  - `src/analog/__tests__/cmos-flipflop.test.ts::Registration::d_flipflop_has_transistor_model` — assert `registry.get('FlipflopD')!.transistorModel === 'CmosDFlipflop'`
  - `src/analog/__tests__/cmos-flipflop.test.ts::Registration::d_flipflop_has_transistor_mode` — assert `'transistor'` in `registry.get('FlipflopD')!.simulationModes`
- **Acceptance criteria**:
  - D flip-flop latches correctly on rising clock edge
  - Clock-to-Q delay emerges from the MOSFET simulation (not hardcoded)
  - Setup time violation produces metastable behavior (a property unique to transistor-level modeling)
  - Q̄ is always the complement of Q in steady state
  - Toggle mode (nQ→D) works correctly
  - Registration as `transistorModel` on `FlipflopD` with `simulationModes` including `'transistor'`

---

## Diagnostic Codes Added

| Code | Severity | Meaning |
|------|----------|---------|
| `missing-transistor-model` | error | Component set to `simulationMode: 'transistor'` but has no `transistorModel` defined |
| `invalid-transistor-model` | error | Transistor model subcircuit contains non-analog components that cannot be stamped into MNA |

## Key Files Summary

| File | Purpose |
|------|---------|
| `src/analog/transistor-model-registry.ts` | `TransistorModelRegistry` — stores transistor model `Circuit` objects by name; separate from `ComponentRegistry` |
| `src/analog/transistor-expansion.ts` | `expandTransistorModel(componentDef, outerPinNodeIds, modelRegistry, vddNodeId, gndNodeId, nextNodeId)` — compiler expansion logic |
| `src/analog/transistor-models/cmos-gates.ts` | CMOS gate subcircuit definitions (inverter, NAND, NOR, AND, OR, XOR, XNOR, buffer) — 7 basic gates + buffer |
| `src/analog/transistor-models/cmos-flipflop.ts` | CMOS D flip-flop subcircuit (transmission-gate master-slave, 20 MOSFETs) |
| `src/analog/compiler.ts` | Modified: transistor expansion step + VDD node injection during analog compilation |
| `src/components/gates/*.ts` | Modified: `transistorModel` and `simulationModes` fields added |
| `src/components/flipflops/d.ts` | Modified: `transistorModel` and `simulationModes` fields added |
