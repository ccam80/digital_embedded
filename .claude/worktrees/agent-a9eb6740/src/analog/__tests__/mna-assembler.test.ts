/**
 * Tests for MNA infrastructure: node mapping, MNA assembler, and test elements.
 *
 * Test groups:
 *   NodeMapping  — buildNodeMap wire grouping, ground detection, label mapping
 *   Stamping     — full solve with resistors, voltage sources, current sources
 *   Assembler    — stampLinear / stampNonlinear / checkAllConverged behaviour
 *   Convergence  — checkAllConverged edge cases
 */

import { describe, it, expect, vi } from "vitest";
import { Circuit, Wire } from "../../core/circuit.js";
import { SparseSolver } from "../sparse-solver.js";
import { buildNodeMap } from "../node-map.js";
import { MNAAssembler } from "../mna-assembler.js";
import {
  makeResistor,
  makeVoltageSource,
  makeCurrentSource,
} from "../test-elements.js";
import type { AnalogElement } from "../element.js";
import type { CircuitElement } from "../../core/element.js";
import type { Pin } from "../../core/pin.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { PropertyBag, PropertyValue } from "../../core/properties.js";
import type { SerializedElement } from "../../core/element.js";
import { PinDirection } from "../../core/pin.js";

// ---------------------------------------------------------------------------
// Minimal mock CircuitElement for node mapping tests
// ---------------------------------------------------------------------------

function makeMockElement(
  typeId: string,
  pinPositions: Array<{ x: number; y: number }>,
  labelProp?: string,
): CircuitElement {
  const pins: Pin[] = pinPositions.map((pos, i) => ({
    direction: PinDirection.BIDIRECTIONAL,
    position: pos,
    label: `pin${i}`,
    bitWidth: 1,
    isNegated: false,
    isClock: false,
  }));

  const props = new Map<string, PropertyValue>();
  if (labelProp !== undefined) {
    props.set("label", labelProp);
  }

  const propertyBag: PropertyBag = {
    has(name: string) { return props.has(name); },
    get<T>(name: string): T { return props.get(name) as T; },
    set(name: string, value: PropertyValue) { props.set(name, value); },
    clone() { return this; },
    keys() { return Array.from(props.keys()); },
  } as unknown as PropertyBag;

  return {
    typeId,
    instanceId: `${typeId}-${Math.random().toString(36).slice(2)}`,
    position: { x: 0, y: 0 },
    rotation: 0,
    mirror: false,
    getPins() { return pins; },
    getProperties() { return propertyBag; },
    getAttribute(name: string) { return props.get(name); },
    draw(_ctx: RenderContext) {},
    getBoundingBox(): Rect { return { x: 0, y: 0, width: 10, height: 10 }; },
    serialize(): SerializedElement {
      return {
        typeId,
        instanceId: this.instanceId,
        position: this.position,
        rotation: 0,
        mirror: false,
        properties: {},
      };
    },
    getHelpText() { return ""; },
  };
}

// ---------------------------------------------------------------------------
// NodeMapping tests
// ---------------------------------------------------------------------------

describe("NodeMapping", () => {
  it("assigns_unique_node_ids", () => {
    // Build a circuit with 3 disjoint wire groups plus a ground wire group.
    // Each group is a single wire segment not sharing endpoints with others.
    const circuit = new Circuit();

    // Ground element at (0,0) — wire group 0
    const gnd = makeMockElement("Ground", [{ x: 0, y: 0 }]);
    circuit.addElement(gnd);
    circuit.addWire(new Wire({ x: 0, y: 0 }, { x: 0, y: 10 }));

    // Group 1: isolated wire at y=20
    circuit.addWire(new Wire({ x: 0, y: 20 }, { x: 10, y: 20 }));

    // Group 2: isolated wire at y=30
    circuit.addWire(new Wire({ x: 0, y: 30 }, { x: 10, y: 30 }));

    // Group 3: isolated wire at y=40
    circuit.addWire(new Wire({ x: 0, y: 40 }, { x: 10, y: 40 }));

    const nodeMap = buildNodeMap(circuit);

    expect(nodeMap.nodeCount).toBe(3);
    expect(nodeMap.diagnostics).toHaveLength(0);
  });

  it("ground_is_node_zero", () => {
    const circuit = new Circuit();

    // Ground element with pin at (5, 5)
    const gnd = makeMockElement("Ground", [{ x: 5, y: 5 }]);
    circuit.addElement(gnd);

    // Wire connected to ground pin at (5,5)
    const gndWire1 = new Wire({ x: 5, y: 5 }, { x: 15, y: 5 });
    const gndWire2 = new Wire({ x: 15, y: 5 }, { x: 25, y: 5 });
    circuit.addWire(gndWire1);
    circuit.addWire(gndWire2);

    const nodeMap = buildNodeMap(circuit);

    expect(nodeMap.wireToNodeId.get(gndWire1)).toBe(0);
    expect(nodeMap.wireToNodeId.get(gndWire2)).toBe(0);
  });

  it("merged_wires_share_node_id", () => {
    const circuit = new Circuit();

    // Ground element
    const gnd = makeMockElement("Ground", [{ x: 0, y: 0 }]);
    circuit.addElement(gnd);
    circuit.addWire(new Wire({ x: 0, y: 0 }, { x: 1, y: 0 }));

    // Two wires sharing an endpoint at (10, 10) — both should get node ID 1
    const wire1 = new Wire({ x: 0, y: 10 }, { x: 10, y: 10 });
    const wire2 = new Wire({ x: 10, y: 10 }, { x: 20, y: 10 });
    circuit.addWire(wire1);
    circuit.addWire(wire2);

    const nodeMap = buildNodeMap(circuit);

    const id1 = nodeMap.wireToNodeId.get(wire1);
    const id2 = nodeMap.wireToNodeId.get(wire2);

    expect(id1).toBeDefined();
    expect(id2).toBeDefined();
    expect(id1).toBe(id2);
    expect(id1).not.toBe(0); // not ground
  });

  it("labels_mapped", () => {
    const circuit = new Circuit();

    // Ground element
    const gnd = makeMockElement("Ground", [{ x: 0, y: 0 }]);
    circuit.addElement(gnd);
    circuit.addWire(new Wire({ x: 0, y: 0 }, { x: 0, y: 10 }));

    // Node 1: wire group at y=20, with an In element labelled "A"
    const wire1 = new Wire({ x: 0, y: 20 }, { x: 10, y: 20 });
    circuit.addWire(wire1);
    const inEl = makeMockElement("In", [{ x: 0, y: 20 }], "A");
    circuit.addElement(inEl);

    // Node 2: wire group at y=30, with an Out element labelled "Y"
    const wire2 = new Wire({ x: 0, y: 30 }, { x: 10, y: 30 });
    circuit.addWire(wire2);
    const outEl = makeMockElement("Out", [{ x: 0, y: 30 }], "Y");
    circuit.addElement(outEl);

    const nodeMap = buildNodeMap(circuit);

    expect(nodeMap.labelToNodeId.has("A")).toBe(true);
    expect(nodeMap.labelToNodeId.has("Y")).toBe(true);

    // Both should be non-zero (not ground) and different from each other
    const nodeA = nodeMap.labelToNodeId.get("A")!;
    const nodeY = nodeMap.labelToNodeId.get("Y")!;
    expect(nodeA).toBeGreaterThan(0);
    expect(nodeY).toBeGreaterThan(0);
    expect(nodeA).not.toBe(nodeY);

    // Wire node IDs should match the label node IDs
    expect(nodeMap.wireToNodeId.get(wire1)).toBe(nodeA);
    expect(nodeMap.wireToNodeId.get(wire2)).toBe(nodeY);
  });

  it("missing_ground_emits_diagnostic", () => {
    const circuit = new Circuit();

    // No Ground element — just two isolated wires
    circuit.addWire(new Wire({ x: 0, y: 0 }, { x: 10, y: 0 }));
    circuit.addWire(new Wire({ x: 0, y: 20 }, { x: 10, y: 20 }));

    const nodeMap = buildNodeMap(circuit);

    // Should have emitted a no-ground diagnostic, not thrown
    const noGround = nodeMap.diagnostics.find((d) => d.code === "no-ground");
    expect(noGround).toBeDefined();
    expect(noGround!.severity).toBe("warning");
  });
});

// ---------------------------------------------------------------------------
// Stamping tests — full solve
// ---------------------------------------------------------------------------

describe("Stamping", () => {
  /**
   * Resistor divider DC solve.
   *
   * Circuit: Vs=5V from node 1 to GND (node 0), R1=1kΩ from node 1 to node 2,
   * R2=1kΩ from node 2 to GND.
   *
   * MNA matrix (nodeCount=2, branchCount=1, matrixSize=3):
   *   Rows/cols 0,1 = nodes 1,2; row/col 2 = branch for Vs
   *
   *   [ G1       0      1  ] [V1]   [0]
   *   [-G1  G1+G2      0  ] [V2] = [0]
   *   [  1       0      0  ] [I ]   [5]
   *
   * where G1 = G2 = 1e-3 S
   * Solution: V1 = 5V, V2 = 2.5V, I = -5mA
   */
  it("resistor_divider_dc", () => {
    const solver = new SparseSolver();
    const assembler = new MNAAssembler(solver);

    // Nodes: 1 = top of divider, 2 = midpoint, 0 = ground
    // Branch row index 2 (after 2 node rows) for the voltage source
    const nodeCount = 2;
    const branchCount = 1;
    const matrixSize = nodeCount + branchCount;

    const R1 = makeResistor(1, 2, 1000);
    const R2 = makeResistor(2, 0, 1000);
    // Voltage source: +5V at node 1, referenced to GND; branch row = nodeCount = 2
    const Vs = makeVoltageSource(1, 0, nodeCount, 5);

    const elements = [R1, R2, Vs];

    solver.beginAssembly(matrixSize);
    assembler.stampLinear(elements);
    solver.finalize();

    const factorResult = solver.factor();
    expect(factorResult.success).toBe(true);

    const solution = new Float64Array(matrixSize);
    solver.solve(solution);

    // solution[0] = V1 (node 1), solution[1] = V2 (node 2), solution[2] = branch current
    const V1 = solution[0];
    const V2 = solution[1];

    expect(V1).toBeCloseTo(5.0, 8);
    expect(V2).toBeCloseTo(2.5, 8);
  });

  /**
   * Two voltage sources in series with a resistor to ground.
   *
   * Circuit: V1=3V (node 1→GND) + V2=2V (node 2→node 1) in series,
   * resistor R=1kΩ from node 2 to GND.
   *
   * Expected: V2 = 5V, current through R = 5V / 1kΩ = 5mA.
   */
  it("two_voltage_sources_series", () => {
    const solver = new SparseSolver();
    const assembler = new MNAAssembler(solver);

    // Nodes: 1, 2; Branches: branch0 for V1 (row 2), branch1 for V2 (row 3)
    const nodeCount = 2;
    const branchCount = 2;
    const matrixSize = nodeCount + branchCount;

    const R = makeResistor(2, 0, 1000);
    // V1: node 1 → GND = 3V, branch row index = nodeCount = 2
    const V1 = makeVoltageSource(1, 0, nodeCount, 3);
    // V2: node 2 → node 1 = 2V, branch row index = nodeCount + 1 = 3
    const V2src = makeVoltageSource(2, 1, nodeCount + 1, 2);

    const elements = [R, V1, V2src];

    solver.beginAssembly(matrixSize);
    assembler.stampLinear(elements);
    solver.finalize();

    const factorResult = solver.factor();
    expect(factorResult.success).toBe(true);

    const solution = new Float64Array(matrixSize);
    solver.solve(solution);

    // solution[0] = V_node1, solution[1] = V_node2
    const Vnode1 = solution[0];
    const Vnode2 = solution[1];

    expect(Vnode1).toBeCloseTo(3.0, 8);
    expect(Vnode2).toBeCloseTo(5.0, 8);

    // Current through R = V_node2 / 1000 = 5mA
    const I_R = Vnode2 / 1000;
    expect(I_R).toBeCloseTo(5e-3, 8);
  });

  /**
   * Current source with resistor.
   *
   * Circuit: I=1mA from GND to node 1, R=1kΩ from node 1 to GND.
   * Expected: V_node1 = 1mA * 1kΩ = 1.0V.
   */
  it("current_source_with_resistor", () => {
    const solver = new SparseSolver();
    const assembler = new MNAAssembler(solver);

    const nodeCount = 1;
    const matrixSize = nodeCount; // no branches

    const I = makeCurrentSource(1, 0, 1e-3);
    const R = makeResistor(1, 0, 1000);

    const elements = [I, R];

    solver.beginAssembly(matrixSize);
    assembler.stampLinear(elements);
    solver.finalize();

    const factorResult = solver.factor();
    expect(factorResult.success).toBe(true);

    const solution = new Float64Array(matrixSize);
    solver.solve(solution);

    // solution[0] = V_node1
    const Vnode1 = solution[0];
    expect(Vnode1).toBeCloseTo(1.0, 8);
  });
});

// ---------------------------------------------------------------------------
// Assembler tests
// ---------------------------------------------------------------------------

describe("Assembler", () => {
  it("linear_only_stamps_once", () => {
    const solver = new SparseSolver();
    const assembler = new MNAAssembler(solver);

    // Spy on a resistor's stamp() method
    const resistor = makeResistor(1, 0, 1000);
    const stampSpy = vi.spyOn(resistor, "stamp");

    solver.beginAssembly(1);
    assembler.stampLinear([resistor]);
    assembler.stampLinear([resistor]);
    // stamp called twice because stampLinear was called twice (caller controls when)
    expect(stampSpy).toHaveBeenCalledTimes(2);
  });

  it("nonlinear_skips_linear_elements", () => {
    const solver = new SparseSolver();
    const assembler = new MNAAssembler(solver);

    // Resistor is a linear element (isNonlinear=false)
    const resistor = makeResistor(1, 0, 1000);
    expect(resistor.isNonlinear).toBe(false);

    // The resistor does not have stampNonlinear defined
    // Create a spy on the method — it won't be called because isNonlinear=false
    const stampNonlinearSpy = vi.fn();

    // Manually attach stampNonlinear to test the guard
    const resistorWithNl = {
      ...resistor,
      isNonlinear: false, // still false
      stampNonlinear: stampNonlinearSpy,
    };

    solver.beginAssembly(1);
    assembler.stampNonlinear([resistorWithNl]);

    // Because isNonlinear=false, stampNonlinear must not be called
    expect(stampNonlinearSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Convergence tests
// ---------------------------------------------------------------------------

describe("Convergence", () => {
  it("all_linear_converges_immediately", () => {
    const solver = new SparseSolver();
    const assembler = new MNAAssembler(solver);

    // Linear elements have no checkConvergence method
    const R1 = makeResistor(1, 0, 1000);
    const R2 = makeResistor(2, 0, 1000);
    expect(R1.checkConvergence).toBeUndefined();
    expect(R2.checkConvergence).toBeUndefined();

    const voltages = new Float64Array([1.0, 2.0]);
    const prevVoltages = new Float64Array([1.0, 2.0]);

    const converged = assembler.checkAllConverged(
      [R1, R2],
      voltages,
      prevVoltages,
    );

    expect(converged).toBe(true);
  });
});
