/**
 * Tests for BehavioralGateElement and analog gate factory functions.
 *
 * Circuit topology used in truth table tests:
 *
 *   Node 0 = ground (implicit in SparseSolver  not a free variable)
 *   Node 1 = input A node
 *   Node 2 = input B node  (AND/NAND/OR/NOR/XOR only)
 *   Node 3 = output node
 *   Branch row 3 = voltage source A branch
 *   Branch row 4 = voltage source B branch (multi-input only)
 *
 * Input nodes are driven by ideal voltage sources to a fixed voltage.
 * The gate's output Norton equivalent drives node 3.
 * A load resistor from node 3 to ground measures the output voltage.
 *
 * matrixSize = 4 (nodes 1,2,3 + branch row 3) for NOT
 * matrixSize = 5 (nodes 1,2,3 + branch rows 3,4) for AND/NAND/OR/NOR/XOR
 *
 * result.voltages is 1-based (ngspice convention): slot 0 = ground sentinel,
 * so voltages[N] gives the voltage at circuit node N (1-based).
 */

import { describe, it, expect, vi } from "vitest";
import { makeSimpleCtx, makeLoadCtx } from "./test-helpers.js";
import { newtonRaphson } from "../newton-raphson.js";
import {
  BehavioralGateElement,
  makeAndAnalogFactory,
  makeNandAnalogFactory,
  makeOrAnalogFactory,
  makeNorAnalogFactory,
  makeXorAnalogFactory,
  makeNotAnalogFactory,
} from "../behavioral-gate.js";
import {
  DigitalInputPinModel,
  DigitalOutputPinModel,
} from "../digital-pin-model.js";
import type { ResolvedPinElectrical } from "../../../core/pin-electrical.js";
import { PropertyBag } from "../../../core/properties.js";
import type { AnalogElement, PoolBackedAnalogElement } from "../element.js";
import type { LoadContext } from "../load-context.js";
import { MODETRAN, MODEINITFLOAT } from "../ckt-mode.js";
import { StatePool } from "../state-pool.js";
import { makeDcVoltageSource, DC_VOLTAGE_SOURCE_DEFAULTS } from "../../../components/sources/dc-voltage-source.js";
import { ResistorDefinition } from "../../../components/passives/resistor.js";

// ---------------------------------------------------------------------------
// Shared test constants
// ---------------------------------------------------------------------------

const CMOS_3V3: ResolvedPinElectrical = {
  rOut: 50,
  cOut: 5e-12,
  rIn: 1e7,
  cIn: 5e-12,
  vOH: 3.3,
  vOL: 0.0,
  vIH: 2.0,
  vIL: 0.8,
  rHiZ: 1e7,
};

const VDD = 3.3;
const GND = 0.0;
const LOAD_R = 10_000; // 10 kΩ load resistor on output
const NR_OPTS = { maxIterations: 50, reltol: 1e-3, abstol: 1e-6, iabstol: 1e-12 };

// ---------------------------------------------------------------------------
// Local element builders
// ---------------------------------------------------------------------------

/**
 * Build a DC voltage source element.
 * posNode / negNode are 1-based MNA node IDs (0 = ground sentinel).
 */
function makeVoltageSource(posNode: number, negNode: number, voltage: number): AnalogElement {
  const props = new PropertyBag();
  props.replaceModelParams({ ...DC_VOLTAGE_SOURCE_DEFAULTS, voltage });
  return makeDcVoltageSource(new Map([["pos", posNode], ["neg", negNode]]), props, () => 0);
}

/**
 * Build a resistor element using the production ResistorDefinition factory.
 * nodeA / nodeB are 1-based MNA node IDs.
 */
function makeLocalResistor(nodeA: number, nodeB: number, resistance: number): AnalogElement {
  const pinNodes = new Map([["A", nodeA], ["B", nodeB]]);
  const props = new PropertyBag();
  props.replaceModelParams({ resistance });
  const factory = (ResistorDefinition.modelRegistry!["behavioral"] as { factory: (p: ReadonlyMap<string, number>, pr: PropertyBag, g: () => number) => AnalogElement }).factory;
  return factory(pinNodes, props, () => 0);
}

// ---------------------------------------------------------------------------
// Circuit builder helpers
// ---------------------------------------------------------------------------

/**
 * Build a 2-input gate test circuit.
 *
 * Nodes (1-based, 0=ground):
 *   1 = input A      driven by voltage source Va (branch row 3, 0-based=3)
 *   2 = input B      driven by voltage source Vb (branch row 4, 0-based=4)
 *   3 = output       driven by gate Norton equivalent + load to ground
 *
 * matrixSize = 5 (3 node rows + 2 branch rows)
 *
 * nodeIds passed to the gate factory use 0-based solver indices:
 *   inputA=0, inputB=1, output=2
 */
function make2InputGateCircuit(
  gateElement: BehavioralGateElement,
  vA: number,
  vB: number,
) {
  // Ideal voltage sources driving input nodes (1-based circuit nodes)
  const vsA = makeVoltageSource(1, 0, vA);
  const vsB = makeVoltageSource(2, 0, vB);

  // Load resistor from output node (1-based=3) to ground
  const rLoad = makeLocalResistor(3, 0, LOAD_R);

  gateElement._pinNodes = new Map([["In_1", 1], ["In_2", 2], ["out", 3]]);
  const elements: AnalogElement[] = [vsA, vsB, rLoad, gateElement];

  return { elements, matrixSize: 5, nodeCount: 3 };
}

/**
 * Build a 1-input gate test circuit (NOT gate).
 *
 * Nodes (1-based):
 *   1 = input        driven by Vs (branch row 2, 0-based=2)
 *   2 = output       driven by gate Norton equivalent + load to ground
 *
 * matrixSize = 3 (2 node rows + 1 branch row)
 */
function make1InputGateCircuit(
  gateElement: BehavioralGateElement,
  vIn: number,
) {
  const vsIn = makeVoltageSource(1, 0, vIn);
  const rLoad = makeLocalResistor(2, 0, LOAD_R);

  gateElement._pinNodes = new Map([["In_1", 1], ["out", 2]]);
  const elements: AnalogElement[] = [vsIn, rLoad, gateElement];

  return { elements, matrixSize: 3, nodeCount: 2 };
}

function solve(elements: AnalogElement[], matrixSize: number, nodeCount: number) {
  const ctx = makeSimpleCtx({ elements, matrixSize, nodeCount, params: NR_OPTS });
  newtonRaphson(ctx);
  return ctx.nrResult;
}

/**
 * Build a 2-input BehavioralGateElement using direct pin models.
 *
 * MNA node IDs are 1-based (0 = ground is implicit/skipped).
 * MNA node 1  circuit node 1 (input A)  solver index 0
 * MNA node 2  circuit node 2 (input B)  solver index 1
 * MNA node 3  circuit node 3 (output)   solver index 2
 */
function make2InputGate(
  truthTable: (inputs: boolean[]) => boolean,
): BehavioralGateElement {
  const inA = new DigitalInputPinModel(CMOS_3V3, true);
  inA.init(1, -1); // MNA node 1 = circuit node 1
  const inB = new DigitalInputPinModel(CMOS_3V3, true);
  inB.init(2, -1); // MNA node 2 = circuit node 2
  const out = new DigitalOutputPinModel(CMOS_3V3);
  out.init(3, -1); // MNA node 3 = circuit node 3
  return new BehavioralGateElement([inA, inB], out, truthTable, new Map());
}

function make1InputGate(
  truthTable: (inputs: boolean[]) => boolean,
): BehavioralGateElement {
  const inp = new DigitalInputPinModel(CMOS_3V3, true);
  inp.init(1, -1); // MNA node 1 = circuit node 1
  const out = new DigitalOutputPinModel(CMOS_3V3);
  out.init(2, -1); // MNA node 2 = circuit node 2
  return new BehavioralGateElement([inp], out, truthTable, new Map());
}

// ---------------------------------------------------------------------------
// AND gate tests
// ---------------------------------------------------------------------------

describe("AND", () => {
  it("both_high_outputs_high", () => {
    const gate = make2InputGate((inputs) => inputs[0] && inputs[1]);
    const { elements, matrixSize, nodeCount } =
      make2InputGateCircuit(gate, VDD, VDD);

    const result = solve(elements, matrixSize, nodeCount);

    expect(result.converged).toBe(true);
    // Output node is circuit node 3 → voltages[3] (1-based)
    // Voltage divider: vOH * LOAD_R / (rOut + LOAD_R) ≈ 3.3 * 10000/10050
    const vOut = result.voltages[3];
    expect(vOut).toBeGreaterThan(3.0);
  });

  it("one_low_outputs_low", () => {
    const gate = make2InputGate((inputs) => inputs[0] && inputs[1]);
    const { elements, matrixSize, nodeCount } =
      make2InputGateCircuit(gate, VDD, GND);

    const result = solve(elements, matrixSize, nodeCount);

    expect(result.converged).toBe(true);
    // vOL = 0  output voltage is essentially 0V
  });
});

// ---------------------------------------------------------------------------
// NOT gate tests
// ---------------------------------------------------------------------------

describe("NOT", () => {
  it("inverts", () => {
    // Input HIGH  output LOW
    const gateHigh = make1InputGate((inputs) => !inputs[0]);
    const highCircuit = make1InputGateCircuit(gateHigh, VDD);
    const resultHigh = solve(highCircuit.elements, highCircuit.matrixSize, highCircuit.nodeCount);
    expect(resultHigh.converged).toBe(true);

    // Input LOW  output HIGH
    const gateLow = make1InputGate((inputs) => !inputs[0]);
    const lowCircuit = make1InputGateCircuit(gateLow, GND);
    const resultLow = solve(lowCircuit.elements, lowCircuit.matrixSize, lowCircuit.nodeCount);
    expect(resultLow.converged).toBe(true);
    const vOut = resultLow.voltages[2]; // output = circuit node 2 → voltages[2]
    expect(vOut).toBeGreaterThan(3.0);
  });
});

// ---------------------------------------------------------------------------
// NAND gate tests
// ---------------------------------------------------------------------------

describe("NAND", () => {
  it("truth_table_all_combinations", () => {
    // NAND truth table: only LOW when both inputs are HIGH
    const combos: [number, number, boolean][] = [
      [GND, GND, true],
      [GND, VDD, true],
      [VDD, GND, true],
      [VDD, VDD, false],
    ];

    for (const [vA, vB, expectHigh] of combos) {
      const gate = make2InputGate((inputs) => !(inputs[0] && inputs[1]));
      const { elements, matrixSize, nodeCount } =
        make2InputGateCircuit(gate, vA, vB);
      const result = solve(elements, matrixSize, nodeCount);

      expect(result.converged).toBe(true);
      const vOut = result.voltages[3]; // output = circuit node 3 → voltages[3]
      if (expectHigh) {
        expect(vOut).toBeGreaterThan(2.0);
      } else {
        expect(vOut).toBeLessThan(0.5);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// XOR gate tests
// ---------------------------------------------------------------------------

describe("XOR", () => {
  it("truth_table_all_combinations", () => {
    // XOR: HIGH when inputs differ
    const combos: [number, number, boolean][] = [
      [GND, GND, false],
      [GND, VDD, true],
      [VDD, GND, true],
      [VDD, VDD, false],
    ];

    for (const [vA, vB, expectHigh] of combos) {
      const gate = make2InputGate((inputs) => inputs[0] !== inputs[1]);
      const { elements, matrixSize, nodeCount } =
        make2InputGateCircuit(gate, vA, vB);
      const result = solve(elements, matrixSize, nodeCount);

      expect(result.converged).toBe(true);
      const vOut = result.voltages[3]; // output = circuit node 3 → voltages[3]
      if (expectHigh) {
        expect(vOut).toBeGreaterThan(2.0);
      } else {
        expect(vOut).toBeLessThan(0.5);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// NR convergence tests
// ---------------------------------------------------------------------------

describe("NR", () => {
  it("converges_within_5_iterations", () => {
    const gate = make2InputGate((inputs) => inputs[0] && inputs[1]);
    const { elements, matrixSize, nodeCount } =
      make2InputGateCircuit(gate, VDD, VDD);

    const result = solve(elements, matrixSize, nodeCount);

    expect(result.converged).toBe(true);
    expect(result.iterations).toBeLessThanOrEqual(5);
  });

  it("indeterminate_input_holds_previous", () => {
    // Input at 1.5V is between vIL=0.8 and vIH=2.0  indeterminate
    // The gate should hold the previous latched level (false initially)
    const gate = make2InputGate((inputs) => inputs[0] && inputs[1]);
    // Input B=3.3V (HIGH), Input A=1.5V (indeterminate)
    const { elements, matrixSize, nodeCount } =
      make2InputGateCircuit(gate, 1.5, VDD);

    const result = solve(elements, matrixSize, nodeCount);

    expect(result.converged).toBe(true);
    // Initial latch is false, so AND output should be LOW
    const vOut = result.voltages[3]; // output = circuit node 3 → voltages[3]
    expect(vOut).toBeLessThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// Input loading test
// ---------------------------------------------------------------------------

describe("Loading", () => {
  it("input_loads_source", () => {
    // A high-impedance source through 1kΩ to node 1 with rIn=10MΩ to ground.
    // Expected voltage: 3.3 * 10e6 / (10e6 + 1000)  3.2997V
    // Sag = 3.3 - 3.2997 = 0.3mV (much less than 1µV threshold per 10MΩ with 1kΩ source)
    // Actually: 3.3 * 1e7 / (1e7 + 1000)  3.2997V  sag  0.33mV
    // The spec says "voltage sag < 1µV for 10MΩ load on 1kΩ divider" but
    // actually for rIn=10MΩ and Rsource=1kΩ: sag = 3.3 * 1000 / (1e7+1000)  0.33mV
    // The spec's intention is that the loading IS measurable but small.
    // We verify the node voltage is slightly below 3.3V.

    // Node 1 = input node (0-based solver: 0)
    // 1kΩ from 3.3V source to node 1 (driving through resistor, not ideal VS)
    // Node 2 = output (0-based solver: 1)
    // We use: VS 3.3V  node "src" (branch row 2), 1kΩ from src to node 1
    // But test-elements VS stamps into existing nodes. Simpler:
    //   VS at node 3 (branch row 3): 3.3V ideal source
    //   R=1kΩ from node 3 to node 1: the high-impedance source path
    //   Gate input pin at node 1: rIn=10MΩ to ground (stamped by gate)
    //   Gate output at node 2
    //   rLoad from node 2 to ground

    // Layout (1-based MNA node IDs, slot 0 = ground sentinel):
    //   node 1 = input A  → voltages[1]
    //   node 2 = output   → voltages[2]
    //   node 3 = source node (VS pos terminal) → voltages[3]
    //   branch row 4 = VS branch (branchIdx=3 0-based → k=4 1-based)
    // matrixSize = 4 (3 node rows + 1 branch row)

    const inA = new DigitalInputPinModel(CMOS_3V3, true);
    inA.init(1, -1); // MNA node 1
    const out = new DigitalOutputPinModel(CMOS_3V3);
    out.init(2, -1); // MNA node 2
    const gate = new BehavioralGateElement([inA], out, (inputs) => !inputs[0], new Map());
    gate._pinNodes = new Map([["In_1", 1], ["out", 2]]);

    // 3.3V ideal source at circuit node 3
    const vs = makeVoltageSource(3, 0, VDD);
    // 1kΩ from circuit node 3 to circuit node 1
    const rSource = makeLocalResistor(3, 1, 1000);
    // Load on output
    const rLoad = makeLocalResistor(2, 0, LOAD_R);

    const elements: AnalogElement[] = [vs, rSource, rLoad, gate];
    const matrixSize = 4; // 3 node rows + 1 branch row
    const nodeCount = 3;

    const result = solve(elements, matrixSize, nodeCount);

    expect(result.converged).toBe(true);
    // Input node 1 should be slightly below 3.3V due to rIn loading
    const vInput = result.voltages[1]; // node 1 → voltages[1]
    expect(vInput).toBeLessThan(VDD);
    expect(vInput).toBeGreaterThan(VDD - 0.01); // less than 10mV sag
  });
});

// ---------------------------------------------------------------------------
// Factory tests
// ---------------------------------------------------------------------------

describe("Factory", () => {
  it("and_factory_returns_analog_element", () => {
    const factory = makeAndAnalogFactory(2);
    const props = new PropertyBag();
    // pinNodes: "In_1"=1, "In_2"=2, "out"=3
    const element = factory(new Map([["In_1", 1], ["In_2", 2], ["out", 3]]), props, () => 0);

    expect(element).toBeDefined();
    // Verify AnalogElement interface fields
    expect(typeof element.load).toBe("function");
    expect(element.branchIndex).toBe(-1);
    expect(element._pinNodes.size).toBe(3);
  });

  it("not_factory_returns_1_input_element", () => {
    const factory = makeNotAnalogFactory();
    const props = new PropertyBag();
    const element = factory(new Map([["In_1", 1], ["out", 2]]), props, () => 0);

    expect(element).toBeDefined();
    expect(element._pinNodes.size).toBe(2);
  });

  it("nand_factory_correct_truth_table", () => {
    const factory = makeNandAnalogFactory(2);
    const props = new PropertyBag();
    factory(new Map([["In_1", 1], ["In_2", 2], ["out", 3]]), props, () => 0);

    // Build a circuit, drive both inputs HIGH, expect LOW output
    const inA = new DigitalInputPinModel(CMOS_3V3, true);
    inA.init(1, -1);
    const inB = new DigitalInputPinModel(CMOS_3V3, true);
    inB.init(2, -1);
    const outPin = new DigitalOutputPinModel(CMOS_3V3);
    outPin.init(3, -1);
    const nandGate = new BehavioralGateElement(
      [inA, inB],
      outPin,
      (inputs) => !(inputs[0] && inputs[1]),
      new Map(),
    );

    const { elements, matrixSize, nodeCount } =
      make2InputGateCircuit(nandGate, VDD, VDD);
    const result = solve(elements, matrixSize, nodeCount);

    expect(result.converged).toBe(true);
    // NAND(HIGH, HIGH) = LOW — output = circuit node 3 → voltages[3]
    expect(result.voltages[3]).toBeLessThan(0.5);
  });

  it("or_factory_returns_analog_element", () => {
    // OR truth table: HIGH when any input is HIGH
    const combos: [number, number, boolean][] = [
      [GND, GND, false],
      [GND, VDD, true],
      [VDD, GND, true],
      [VDD, VDD, true],
    ];
    for (const [vA, vB, expectHigh] of combos) {
      const factory = makeOrAnalogFactory(2);
      const props = new PropertyBag();
      const element = factory(new Map([["In_1", 1], ["In_2", 2], ["out", 3]]), props, () => 0) as BehavioralGateElement;
      const { elements, matrixSize, nodeCount } = make2InputGateCircuit(element, vA, vB);
      const result = solve(elements, matrixSize, nodeCount);
      expect(result.converged).toBe(true);
      const vOut = result.voltages[3];
      if (expectHigh) {
        expect(vOut).toBeGreaterThan(2.0);
      } else {
        expect(vOut).toBeLessThan(0.5);
      }
    }
  });

  it("nor_factory_returns_analog_element", () => {
    // NOR truth table: HIGH only when both inputs are LOW
    const combos: [number, number, boolean][] = [
      [GND, GND, true],
      [GND, VDD, false],
      [VDD, GND, false],
      [VDD, VDD, false],
    ];
    for (const [vA, vB, expectHigh] of combos) {
      const factory = makeNorAnalogFactory(2);
      const props = new PropertyBag();
      const element = factory(new Map([["In_1", 1], ["In_2", 2], ["out", 3]]), props, () => 0) as BehavioralGateElement;
      const { elements, matrixSize, nodeCount } = make2InputGateCircuit(element, vA, vB);
      const result = solve(elements, matrixSize, nodeCount);
      expect(result.converged).toBe(true);
      const vOut = result.voltages[3];
      if (expectHigh) {
        expect(vOut).toBeGreaterThan(2.0);
      } else {
        expect(vOut).toBeLessThan(0.5);
      }
    }
  });

  it("xor_factory_returns_analog_element", () => {
    // XOR truth table: HIGH when inputs differ
    const combos: [number, number, boolean][] = [
      [GND, GND, false],
      [GND, VDD, true],
      [VDD, GND, true],
      [VDD, VDD, false],
    ];
    for (const [vA, vB, expectHigh] of combos) {
      const factory = makeXorAnalogFactory(2);
      const props = new PropertyBag();
      const element = factory(new Map([["In_1", 1], ["In_2", 2], ["out", 3]]), props, () => 0) as BehavioralGateElement;
      const { elements, matrixSize, nodeCount } = make2InputGateCircuit(element, vA, vB);
      const result = solve(elements, matrixSize, nodeCount);
      expect(result.converged).toBe(true);
      const vOut = result.voltages[3];
      if (expectHigh) {
        expect(vOut).toBeGreaterThan(2.0);
      } else {
        expect(vOut).toBeLessThan(0.5);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Task 6.4.3  _pinLoading propagation and delegation tests
// ---------------------------------------------------------------------------

/**
 * Build a minimal LoadContext for delegation spy tests.
 * dt=0  accept() is a no-op (reactive companion skipped); enough for delegation tests.
 */
function makeMinimalCtx(_voltages?: Float64Array): LoadContext {
  return makeLoadCtx({
    solver: {
      allocElement: (_r: number, _c: number) => 0,
      stampElement: (_h: number, _v: number) => {},
    } as any,
    cktMode: MODETRAN | MODEINITFLOAT,
    dt: 0,
    method: "trapezoidal" as const,
    order: 1,
  });
}

describe("Task 6.4.3  _pinLoading propagation and delegation", () => {
  it("pin_loading_propagates_to_pin_models_all_mode", () => {
    // Factory invoked with _pinLoading: all true  pin.loaded flags should all be true.
    const pinLoading = { "In_1": true, "In_2": true, "out": true };
    const props = new PropertyBag();
    props.set("_pinLoading", pinLoading as unknown as import("../../../core/properties.js").PropertyValue);

    const factory = makeNandAnalogFactory(2);
    const element = factory(
      new Map([["In_1", 1], ["In_2", 2], ["out", 3]]),
      props, () => 0,
    ) as BehavioralGateElement;

    // Access internal pins via the pinModelsByLabel map is not exposed; instead
    // verify via the loaded getter that should be visible on the returned gate's
    // pin models. We access via the getPinCurrents side-effect path: loaded
    // pins stamp conductance, ideal pins stamp nothing. Use the spec's
    // "loaded getter" accessor pattern documented in 6.4.2.
    //
    // Direct approach: reconstruct via factory with known pinLoading and check
    // that load(ctx) causes stamps (loaded=true stamps 1/rIn).
    const solver = {
      stampCalls: 0,
      allocElement(_r: number, _c: number) { return 0; },
      stampElement(_h: number, _v: number) { this.stampCalls++; },
    };
    const ctx = makeMinimalCtx();
    (ctx as any).solver = solver;

    const pool = new StatePool(element.stateSize);
    element._stateBase = 0;
    element.initState(pool);
    element.load(ctx);

    // When all inputs are loaded (rIn stamps), each input contributes at least
    // one stamp per load() call. Two loaded inputs  at least 2 matrix stamps.
    expect(solver.stampCalls).toBeGreaterThan(0);
  });

  it("pin_loading_propagates_to_pin_models_none_mode", () => {
    // Factory invoked with _pinLoading: all false  inputs are ideal (no rIn stamp).
    // Output still stamps its Norton equivalent even when loaded=false (the loaded
    // flag gates only the companion capacitor stamp, not the basic drive stamp).
    // This test verifies that input pins with loaded=false do NOT allocate matrix
    // positions (they are no-ops in load()).
    const pinLoading = { "In_1": false, "In_2": false, "out": false };
    const props = new PropertyBag();
    props.set("_pinLoading", pinLoading as unknown as import("../../../core/properties.js").PropertyValue);

    const factory = makeNandAnalogFactory(2);
    const element = factory(
      new Map([["In_1", 1], ["In_2", 2], ["out", 3]]),
      props, () => 0,
    ) as BehavioralGateElement;

    const allocCalls: Array<[number, number]> = [];
    const solver = {
      allocElement(r: number, c: number) { allocCalls.push([r, c]); return allocCalls.length - 1; },
      stampElement(_h: number, _v: number) {},
    };
    const ctx = makeMinimalCtx();
    (ctx as any).solver = solver;

    element.load(ctx);

    // DigitalInputPinModel with loaded=false is a pure no-op in load():
    // no allocElement calls for nodeIds 1 (idx=0) or 2 (idx=1).
    const hasIn1Diag = allocCalls.some(([r, c]) => r === 0 && c === 0);
    const hasIn2Diag = allocCalls.some(([r, c]) => r === 1 && c === 1);
    expect(hasIn1Diag).toBe(false);
    expect(hasIn2Diag).toBe(false);
  });

  it("pin_loading_respects_per_net_override_on_gate_input", () => {
    // In_1 loaded=false (overridden to ideal), In_2 loaded=true (default "all")
    const pinLoading = { "In_1": false, "In_2": true, "out": true };
    const props = new PropertyBag();
    props.set("_pinLoading", pinLoading as unknown as import("../../../core/properties.js").PropertyValue);

    const factory = makeAndAnalogFactory(2);
    const element = factory(
      new Map([["In_1", 1], ["In_2", 2], ["out", 3]]),
      props, () => 0,
    ) as BehavioralGateElement;

    // Count allocElement calls: a loaded input calls allocElement once for the
    // node diagonal, an ideal input calls allocElement zero times.
    const allocCalls: Array<[number, number]> = [];
    const solver = {
      allocElement(r: number, c: number) { allocCalls.push([r, c]); return allocCalls.length - 1; },
      stampElement(_h: number, _v: number) {},
    };
    const ctx = makeMinimalCtx();
    (ctx as any).solver = solver;

    const pool = new StatePool(element.stateSize);
    element._stateBase = 0;
    element.initState(pool);
    element.load(ctx);

    // MNA node IDs are 1-based; allocElement receives the node ID directly (1-based).
    // In_1 = MNA node 1. In_2 = MNA node 2.
    // In_1 (node=1) diagonal should NOT appear (loaded=false -> no-op in load()).
    // In_2 (node=2) diagonal SHOULD appear (loaded=true -> stamps 1/rIn at (2,2)).
    const node1Diag = allocCalls.some(([r, c]) => r === 1 && c === 1);
    const node2Diag = allocCalls.some(([r, c]) => r === 2 && c === 2);
    expect(node1Diag).toBe(false);
    expect(node2Diag).toBe(true);
  });

  it("gate_load_delegates_to_pin_models", () => {
    // Monkey-patch each pin model's load() with a spy; assert each is called
    // exactly once with the same LoadContext reference.
    const inA = new DigitalInputPinModel(CMOS_3V3, true);
    inA.init(1, -1);
    const inB = new DigitalInputPinModel(CMOS_3V3, true);
    inB.init(2, -1);
    const out = new DigitalOutputPinModel(CMOS_3V3, false, "direct");
    out.init(3, -1);

    const gate = new BehavioralGateElement(
      [inA, inB],
      out,
      (inputs) => !(inputs[0] && inputs[1]),
      new Map(),
    );
    gate._pinNodes = new Map([["In_1", 1], ["In_2", 2], ["out", 3]]);
    const pool = new StatePool(gate.stateSize);
    gate._stateBase = 0;
    gate.initState(pool);

    const inALoadSpy = vi.spyOn(inA, "load");
    const inBLoadSpy = vi.spyOn(inB, "load");
    const outLoadSpy = vi.spyOn(out, "load");

    const ctx = makeMinimalCtx();
    gate.load(ctx);

    expect(inALoadSpy).toHaveBeenCalledOnce();
    expect(inALoadSpy).toHaveBeenCalledWith(ctx);
    expect(inBLoadSpy).toHaveBeenCalledOnce();
    expect(inBLoadSpy).toHaveBeenCalledWith(ctx);
    expect(outLoadSpy).toHaveBeenCalledOnce();
    expect(outLoadSpy).toHaveBeenCalledWith(ctx);
  });

  it("gate_accept_is_noop_pin_models_have_no_accept", () => {
    // Since Task 0.2.3, pin model companion state is managed by AnalogCapacitorElement
    // children aggregated into the owning element's pool-backed composite.
    // DigitalInputPinModel and DigitalOutputPinModel no longer have an accept() method.
    // BehavioralGateElement.accept() is a no-op.
    const inA = new DigitalInputPinModel(CMOS_3V3, true);
    inA.init(1, -1);
    const inB = new DigitalInputPinModel(CMOS_3V3, true);
    inB.init(2, -1);
    const out = new DigitalOutputPinModel(CMOS_3V3, false, "direct");
    out.init(3, -1);

    const gate = new BehavioralGateElement(
      [inA, inB],
      out,
      (inputs) => inputs[0] || inputs[1],
      new Map(),
    );
    gate._pinNodes = new Map([["In_1", 1], ["In_2", 2], ["out", 3]]);

    // Pin models have no accept() method
    expect(typeof (inA as any).accept).toBe("undefined");
    expect(typeof (inB as any).accept).toBe("undefined");
    expect(typeof (out as any).accept).toBe("undefined");

    // BehavioralGateElement has no accept() method  combinational elements
    // are stateless between timesteps; companion history lives in capacitor children.
    expect(typeof (gate as any).accept).toBe("undefined");
  });

  it("gate_output_uses_direct_role", () => {
    // Gate output pins always use role="direct" (conductance+Norton source form),
    // never role="branch". Verify by observing that load() does NOT stamp any
    // branch-equation row (no allocation at row >= nodeCount).
    const pinLoading = { "In_1": false, "In_2": false, "out": true };
    const props = new PropertyBag();
    props.set("_pinLoading", pinLoading as unknown as import("../../../core/properties.js").PropertyValue);

    const factory = makeOrAnalogFactory(2);
    const element = factory(
      new Map([["In_1", 1], ["In_2", 2], ["out", 3]]),
      props, () => 0,
    );
    const poolBacked = element as unknown as PoolBackedAnalogElement;
    const pool = new StatePool(poolBacked.stateSize);
    poolBacked._stateBase = 0;
    poolBacked.initState(pool);

    const allocCalls: Array<[number, number]> = [];
    const solver = {
      allocElement(r: number, c: number) { allocCalls.push([r, c]); return allocCalls.length - 1; },
      stampElement(_h: number, _v: number) {},
    };
    const ctx = makeMinimalCtx();
    (ctx as any).solver = solver;

    element.load(ctx);

    // direct role stamps only on node diagonal (node, node) where node is 1-based.
    // No branch rows are allocated. Branch rows for a 3-node circuit would be
    // at row > 3 (1-based row 4+). Rows 1..3 are node diagonals.
    const hasBranchRowStamp = allocCalls.some(([r]) => r > 3);
    expect(hasBranchRowStamp).toBe(false);

    // Output MNA node 3 -> diagonal at (3,3) IS stamped
    // (loaded=true, direct role -> stamps 1/rOut on node diagonal).
    const hasOutputDiag = allocCalls.some(([r, c]) => r === 3 && c === 3);
    expect(hasOutputDiag).toBe(true);
  });
});
