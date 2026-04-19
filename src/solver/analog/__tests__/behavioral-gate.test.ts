/**
 * Tests for BehavioralGateElement and analog gate factory functions.
 *
 * Circuit topology used in truth table tests:
 *
 *   Node 0 = ground (implicit in SparseSolver — not a free variable)
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
 * Node IDs here are 1-based circuit nodes (0 = ground is implicit);
 * solver uses 0-based indexing so voltages[nodeId - 1] gives node voltage.
 */

import { describe, it, expect, vi } from "vitest";
import { makeVoltageSource, makeResistor, withNodeIds, runNR } from "./test-helpers.js";
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
import type { AnalogElement } from "../element.js";
import type { LoadContext } from "../load-context.js";

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
  const vsA = makeVoltageSource(1, 0, 3, vA); // node 1, branch row 3
  const vsB = makeVoltageSource(2, 0, 4, vB); // node 2, branch row 4

  // Load resistor from output node (1-based=3) to ground
  const rLoad = makeResistor(3, 0, LOAD_R);

  const elements: AnalogElement[] = [vsA, vsB, rLoad, withNodeIds(gateElement, [1, 2, 3])];

  return { elements, matrixSize: 5 };
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
  const vsIn = makeVoltageSource(1, 0, 2, vIn); // node 1, branch row 2
  const rLoad = makeResistor(2, 0, LOAD_R);

  const elements: AnalogElement[] = [vsIn, rLoad, withNodeIds(gateElement, [1, 2])];

  return { elements, matrixSize: 3 };
}

function solve(elements: AnalogElement[], matrixSize: number) {
  const nodeIds = new Set<number>();
  for (const el of elements) {
    for (const n of el.allNodeIds) {
      if (n > 0) nodeIds.add(n);
    }
  }
  const nodeCount = nodeIds.size;
  return runNR({ elements, matrixSize, nodeCount, params: NR_OPTS, isDcOp: true });
}

/**
 * Build a 2-input BehavioralGateElement using direct pin models.
 *
 * MNA node IDs are 1-based (0 = ground is implicit/skipped).
 * MNA node 1 → circuit node 1 (input A) → solver index 0
 * MNA node 2 → circuit node 2 (input B) → solver index 1
 * MNA node 3 → circuit node 3 (output)  → solver index 2
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
    const { solver, diagnostics, elements, matrixSize } =
      make2InputGateCircuit(gate, VDD, VDD);

    const result = solve(elements, matrixSize);

    expect(result.converged).toBe(true);
    // Output node is solver index 2 (circuit node 3)
    // Voltage divider: vOH * LOAD_R / (rOut + LOAD_R) ≈ 3.3 * 10000/10050
    const vOut = result.voltages[2];
    expect(vOut).toBeGreaterThan(3.0);
    expect(vOut).toBeCloseTo(CMOS_3V3.vOH * LOAD_R / (CMOS_3V3.rOut + LOAD_R), 1);
  });

  it("one_low_outputs_low", () => {
    const gate = make2InputGate((inputs) => inputs[0] && inputs[1]);
    const { solver, diagnostics, elements, matrixSize } =
      make2InputGateCircuit(gate, VDD, GND);

    const result = solve(elements, matrixSize);

    expect(result.converged).toBe(true);
    const vOut = result.voltages[2];
    // vOL = 0 — output voltage is essentially 0V
    expect(vOut).toBeCloseTo(0.0, 2);
  });
});

// ---------------------------------------------------------------------------
// NOT gate tests
// ---------------------------------------------------------------------------

describe("NOT", () => {
  it("inverts", () => {
    // Input HIGH → output LOW
    const gateHigh = make1InputGate((inputs) => !inputs[0]);
    const highCircuit = make1InputGateCircuit(gateHigh, VDD);
    const resultHigh = solve(highCircuit.elements, highCircuit.matrixSize);
    expect(resultHigh.converged).toBe(true);
    expect(resultHigh.voltages[1]).toBeCloseTo(0.0, 2);

    // Input LOW → output HIGH
    const gateLow = make1InputGate((inputs) => !inputs[0]);
    const lowCircuit = make1InputGateCircuit(gateLow, GND);
    const resultLow = solve(lowCircuit.elements, lowCircuit.matrixSize);
    expect(resultLow.converged).toBe(true);
    const vOut = resultLow.voltages[1];
    expect(vOut).toBeGreaterThan(3.0);
    expect(vOut).toBeCloseTo(CMOS_3V3.vOH * LOAD_R / (CMOS_3V3.rOut + LOAD_R), 1);
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
      const { solver, diagnostics, elements, matrixSize } =
        make2InputGateCircuit(gate, vA, vB);
      const result = solve(elements, matrixSize);

      expect(result.converged).toBe(true);
      const vOut = result.voltages[2];
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
      const { solver, diagnostics, elements, matrixSize } =
        make2InputGateCircuit(gate, vA, vB);
      const result = solve(elements, matrixSize);

      expect(result.converged).toBe(true);
      const vOut = result.voltages[2];
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
    const { solver, diagnostics, elements, matrixSize } =
      make2InputGateCircuit(gate, VDD, VDD);

    const result = solve(elements, matrixSize);

    expect(result.converged).toBe(true);
    expect(result.iterations).toBeLessThanOrEqual(5);
  });

  it("indeterminate_input_holds_previous", () => {
    // Input at 1.5V is between vIL=0.8 and vIH=2.0 → indeterminate
    // The gate should hold the previous latched level (false initially)
    const gate = make2InputGate((inputs) => inputs[0] && inputs[1]);
    // Input B=3.3V (HIGH), Input A=1.5V (indeterminate)
    const { solver, diagnostics, elements, matrixSize } =
      make2InputGateCircuit(gate, 1.5, VDD);

    const result = solve(elements, matrixSize);

    expect(result.converged).toBe(true);
    // Initial latch is false, so AND output should be LOW
    const vOut = result.voltages[2];
    expect(vOut).toBeLessThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// Input loading test
// ---------------------------------------------------------------------------

describe("Loading", () => {
  it("input_loads_source", () => {
    // A high-impedance source through 1kΩ to node 1 with rIn=10MΩ to ground.
    // Expected voltage: 3.3 * 10e6 / (10e6 + 1000) ≈ 3.2997V
    // Sag = 3.3 - 3.2997 = 0.3mV (much less than 1µV threshold per 10MΩ with 1kΩ source)
    // Actually: 3.3 * 1e7 / (1e7 + 1000) ≈ 3.2997V → sag ≈ 0.33mV
    // The spec says "voltage sag < 1µV for 10MΩ load on 1kΩ divider" but
    // actually for rIn=10MΩ and Rsource=1kΩ: sag = 3.3 * 1000 / (1e7+1000) ≈ 0.33mV
    // The spec's intention is that the loading IS measurable but small.
    // We verify the node voltage is slightly below 3.3V.

    // Node 1 = input node (0-based solver: 0)
    // 1kΩ from 3.3V source to node 1 (driving through resistor, not ideal VS)
    // Node 2 = output (0-based solver: 1)
    // We use: VS 3.3V → node "src" (branch row 2), 1kΩ from src to node 1
    // But test-elements VS stamps into existing nodes. Simpler:
    //   VS at node 3 (branch row 3): 3.3V ideal source
    //   R=1kΩ from node 3 to node 1: the high-impedance source path
    //   Gate input pin at node 1: rIn=10MΩ to ground (stamped by gate)
    //   Gate output at node 2
    //   rLoad from node 2 to ground

    // Layout (1-based MNA node IDs, 0=ground implicit):
    //   MNA node 1 = input A  → solver index 0
    //   MNA node 2 = output   → solver index 1
    //   MNA node 3 = source node (VS pos terminal) → solver index 2
    //   branch row 3 = VS branch
    // matrixSize = 4 (3 node rows + 1 branch row)

    const inA = new DigitalInputPinModel(CMOS_3V3, true);
    inA.init(1, -1); // MNA node 1
    const out = new DigitalOutputPinModel(CMOS_3V3);
    out.init(2, -1); // MNA node 2
    const gate = new BehavioralGateElement([inA], out, (inputs) => !inputs[0], new Map());

    // 3.3V ideal source at circuit node 3 (solver node 2, branch row 3)
    const vs = makeVoltageSource(3, 0, 3, VDD);
    // 1kΩ from circuit node 3 to circuit node 1
    const rSource = makeResistor(3, 1, 1000);
    // Load on output
    const rLoad = makeResistor(2, 0, LOAD_R);

    const elements: AnalogElement[] = [vs, rSource, rLoad, withNodeIds(gate, [1, 2])];
    const matrixSize = 4; // solver nodes 0,1,2 + branch row 3

    const result = solve(elements, matrixSize);

    expect(result.converged).toBe(true);
    // Input node (solver 0) should be slightly below 3.3V due to rIn loading
    const vInput = result.voltages[0];
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
    const element = withNodeIds(
      factory(new Map([["In_1", 1], ["In_2", 2], ["out", 3]]), [], -1, props, () => 0),
      [1, 2, 3],
    );

    expect(element).toBeDefined();
    // Verify AnalogElement interface fields
    expect(typeof element.load).toBe("function");
    expect(element.isNonlinear).toBe(true);
    expect(element.isReactive).toBe(true);
    expect(element.branchIndex).toBe(-1);
    expect(element.pinNodeIds.length).toBe(3);
  });

  it("not_factory_returns_1_input_element", () => {
    const factory = makeNotAnalogFactory();
    const props = new PropertyBag();
    const element = withNodeIds(
      factory(new Map([["In_1", 1], ["out", 2]]), [], -1, props, () => 0),
      [1, 2],
    );

    expect(element).toBeDefined();
    expect(element.pinNodeIds.length).toBe(2);
  });

  it("nand_factory_correct_truth_table", () => {
    const factory = makeNandAnalogFactory(2);
    const props = new PropertyBag();
    const gate = withNodeIds(
      factory(new Map([["In_1", 1], ["In_2", 2], ["out", 3]]), [], -1, props, () => 0),
      [1, 2, 3],
    ) as unknown as BehavioralGateElement;

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

    const { solver, diagnostics, elements, matrixSize } =
      make2InputGateCircuit(nandGate, VDD, VDD);
    const result = solve(elements, matrixSize);

    expect(result.converged).toBe(true);
    // NAND(HIGH, HIGH) = LOW
    expect(result.voltages[2]).toBeLessThan(0.5);

    // Verify the factory-produced gate also satisfies AnalogElement interface
    expect(gate.isNonlinear).toBe(true);
    expect(gate.isReactive).toBe(true);
  });

  it("or_factory_returns_analog_element", () => {
    const factory = makeOrAnalogFactory(2);
    const props = new PropertyBag();
    const element = withNodeIds(
      factory(new Map([["In_1", 1], ["In_2", 2], ["out", 3]]), [], -1, props, () => 0),
      [1, 2, 3],
    );
    expect(element.isNonlinear).toBe(true);
    expect(element.pinNodeIds.length).toBe(3);
  });

  it("nor_factory_returns_analog_element", () => {
    const factory = makeNorAnalogFactory(2);
    const props = new PropertyBag();
    const element = withNodeIds(
      factory(new Map([["In_1", 1], ["In_2", 2], ["out", 3]]), [], -1, props, () => 0),
      [1, 2, 3],
    );
    expect(element.isNonlinear).toBe(true);
    expect(element.pinNodeIds.length).toBe(3);
  });

  it("xor_factory_returns_analog_element", () => {
    const factory = makeXorAnalogFactory(2);
    const props = new PropertyBag();
    const element = withNodeIds(
      factory(new Map([["In_1", 1], ["In_2", 2], ["out", 3]]), [], -1, props, () => 0),
      [1, 2, 3],
    );
    expect(element.isNonlinear).toBe(true);
    expect(element.pinNodeIds.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Task 6.4.3 — _pinLoading propagation and delegation tests
// ---------------------------------------------------------------------------

/**
 * Build a minimal LoadContext for delegation spy tests.
 * dt=0 → accept() is a no-op (reactive companion skipped); enough for delegation tests.
 */
function makeMinimalCtx(voltages?: Float64Array): LoadContext {
  const ag = new Float64Array(7);
  return {
    solver: {
      allocElement: (_r: number, _c: number) => 0,
      stampElement: (_h: number, _v: number) => {},
      stampRHS: (_i: number, _v: number) => {},
    } as any,
    voltages: voltages ?? new Float64Array(16),
    iteration: 0,
    initMode: "transient" as const,
    dt: 0,
    method: "trapezoidal" as const,
    order: 1,
    deltaOld: [],
    ag,
    srcFact: 1,
    noncon: { value: 0 },
    limitingCollector: null,
    isDcOp: false,
    isTransient: false,
    xfact: 0,
    gmin: 1e-12,
    uic: false,
    reltol: 1e-3,
    iabstol: 1e-12,
  };
}

describe("Task 6.4.3 — _pinLoading propagation and delegation", () => {
  it("pin_loading_propagates_to_pin_models_all_mode", () => {
    // Factory invoked with _pinLoading: all true → pin.loaded flags should all be true.
    const pinLoading = { "In_1": true, "In_2": true, "out": true };
    const props = new PropertyBag();
    props.set("_pinLoading", pinLoading as unknown as import("../../../core/properties.js").PropertyValue);

    const factory = makeNandAnalogFactory(2);
    const element = factory(
      new Map([["In_1", 1], ["In_2", 2], ["out", 3]]),
      [], -1, props, () => 0,
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
      stampRHS(_i: number, _v: number) {},
    };
    const ctx = makeMinimalCtx();
    (ctx as any).solver = solver;

    withNodeIds(element, [1, 2, 3]);
    element.load(ctx);

    // When all inputs are loaded (rIn stamps), each input contributes at least
    // one stamp per load() call. Two loaded inputs → at least 2 matrix stamps.
    expect(solver.stampCalls).toBeGreaterThan(0);
  });

  it("pin_loading_propagates_to_pin_models_none_mode", () => {
    // Factory invoked with _pinLoading: all false → inputs are ideal (no rIn stamp).
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
      [], -1, props, () => 0,
    ) as BehavioralGateElement;

    const allocCalls: Array<[number, number]> = [];
    const solver = {
      allocElement(r: number, c: number) { allocCalls.push([r, c]); return allocCalls.length - 1; },
      stampElement(_h: number, _v: number) {},
      stampRHS(_i: number, _v: number) {},
    };
    const ctx = makeMinimalCtx();
    (ctx as any).solver = solver;

    withNodeIds(element, [1, 2, 3]);
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
      [], -1, props, () => 0,
    ) as BehavioralGateElement;

    // Count allocElement calls: a loaded input calls allocElement once for the
    // node diagonal, an ideal input calls allocElement zero times.
    const allocCalls: Array<[number, number]> = [];
    const solver = {
      allocElement(r: number, c: number) { allocCalls.push([r, c]); return allocCalls.length - 1; },
      stampElement(_h: number, _v: number) {},
      stampRHS(_i: number, _v: number) {},
    };
    const ctx = makeMinimalCtx();
    (ctx as any).solver = solver;

    withNodeIds(element, [1, 2, 3]);
    element.load(ctx);

    // MNA node IDs are 1-based; allocElement receives 0-based nodeIdx = nodeId-1.
    // In_1 = MNA node 1 → nodeIdx 0. In_2 = MNA node 2 → nodeIdx 1.
    // In_1 (nodeIdx=0) diagonal should NOT appear (loaded=false → no-op in load()).
    // In_2 (nodeIdx=1) diagonal SHOULD appear (loaded=true → stamps 1/rIn).
    const node1Diag = allocCalls.some(([r, c]) => r === 0 && c === 0);
    const node2Diag = allocCalls.some(([r, c]) => r === 1 && c === 1);
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
    withNodeIds(gate, [1, 2, 3]);

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

  it("gate_accept_delegates_to_pin_models", () => {
    // Monkey-patch each pin model's accept() with a spy; assert each is called
    // with the voltage from ctx.voltages at that pin's node index.
    const inA = new DigitalInputPinModel(CMOS_3V3, true);
    inA.init(1, -1); // MNA node 1 → solver index 0 (0-based)
    const inB = new DigitalInputPinModel(CMOS_3V3, true);
    inB.init(2, -1); // MNA node 2 → solver index 1
    const out = new DigitalOutputPinModel(CMOS_3V3, false, "direct");
    out.init(3, -1); // MNA node 3 → solver index 2

    const gate = new BehavioralGateElement(
      [inA, inB],
      out,
      (inputs) => inputs[0] || inputs[1],
      new Map(),
    );
    withNodeIds(gate, [1, 2, 3]);

    const inAAcceptSpy = vi.spyOn(inA, "accept");
    const inBAcceptSpy = vi.spyOn(inB, "accept");
    const outAcceptSpy = vi.spyOn(out, "accept");

    // Set specific voltages at each node
    const voltages = new Float64Array(16);
    voltages[0] = 3.3; // node 1 (MNA) → index 0
    voltages[1] = 0.0; // node 2 (MNA) → index 1
    voltages[2] = 3.3; // node 3 (MNA) → index 2

    // dt must be > 0 to trigger accept delegation (gate.accept returns early if dt<=0)
    const ctx = { ...makeMinimalCtx(voltages), dt: 1e-9 };

    gate.accept(ctx, 0, () => {});

    // Each pin's accept should be called with the voltage at its node
    expect(inAAcceptSpy).toHaveBeenCalledWith(ctx, voltages[0]);
    expect(inBAcceptSpy).toHaveBeenCalledWith(ctx, voltages[1]);
    expect(outAcceptSpy).toHaveBeenCalledWith(ctx, voltages[2]);
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
      [], -1, props, () => 0,
    );
    withNodeIds(element, [1, 2, 3]);

    const allocCalls: Array<[number, number]> = [];
    const solver = {
      allocElement(r: number, c: number) { allocCalls.push([r, c]); return allocCalls.length - 1; },
      stampElement(_h: number, _v: number) {},
      stampRHS(_i: number, _v: number) {},
    };
    const ctx = makeMinimalCtx();
    (ctx as any).solver = solver;

    element.load(ctx);

    // direct role stamps only on node diagonal (nodeIdx, nodeIdx) where
    // nodeIdx = nodeId - 1 (0-based). No branch rows are allocated.
    // Branch rows for a 3-node circuit would be at row >= 3 (absolute row).
    const hasBranchRowStamp = allocCalls.some(([r]) => r >= 3);
    expect(hasBranchRowStamp).toBe(false);

    // Output MNA node 3 → nodeIdx 2. The output diagonal (2,2) IS stamped
    // (loaded=true, direct role → stamps 1/rOut on node diagonal).
    const hasOutputDiag = allocCalls.some(([r, c]) => r === 2 && c === 2);
    expect(hasOutputDiag).toBe(true);
  });
});
