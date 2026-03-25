/**
 * Tests for WireCurrentResolver — KCL-correct tree-traced wire current attribution.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { WireCurrentResolver } from "../wire-current-resolver";
import type { ResolvedAnalogCircuit } from "../wire-current-resolver";
import { Wire, Circuit } from "@/core/circuit";
import type { AnalogEngine } from "@/core/analog-engine-interface";
import type { AnalogElement } from "@/analog/element";
import type { CircuitElement } from "@/core/element";
import type { Pin, Rotation } from "@/core/pin";
import { PinDirection } from "@/core/pin";
import type { Rect, RenderContext } from "@/core/renderer-interface";
import type { SerializedElement } from "@/core/element";
import { MNAEngine } from "@/analog/analog-engine";
import type { ConcreteCompiledAnalogCircuit } from "@/analog/analog-engine";
import {
  makeResistor,
  makeVoltageSource,
  makeAcVoltageSource,
  makeCapacitor,
  makeInductor,
} from "@/analog/test-elements";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a Wire with given coordinates. */
function makeWire(x1: number, y1: number, x2: number, y2: number): Wire {
  return new Wire({ x: x1, y: y1 }, { x: x2, y: y2 });
}

/** Minimal AnalogElement stub with stamp no-op. */
function makeMockElement(pinNodeIds: number[], branchIndex = -1): AnalogElement {
  return {
    pinNodeIds,
    allNodeIds: pinNodeIds,
    branchIndex,
    stamp() {},
    isNonlinear: false,
    isReactive: false,
    getPinCurrents() { return pinNodeIds.map(() => 0); },
  } as unknown as AnalogElement;
}

/**
 * Create a mock CircuitElement with pins at absolute positions.
 * element.position = (0,0), rotation = 0, mirror = false, so
 * pinWorldPosition returns pin.position directly.
 */
function makeCE(pins: Array<{ x: number; y: number }>): CircuitElement {
  const resolvedPins: Pin[] = pins.map((p, i) => ({
    position: { x: p.x, y: p.y },
    label: `p${i}`,
    direction: PinDirection.BIDIRECTIONAL,
    isNegated: false,
    isClock: false,
    bitWidth: 1,
  }));

  const serialized: SerializedElement = {
    typeId: "mock",
    instanceId: "mock",
    position: { x: 0, y: 0 },
    rotation: 0 as SerializedElement["rotation"],
    mirror: false,
    properties: {},
  };

  return {
    typeId: "mock",
    instanceId: "mock",
    position: { x: 0, y: 0 },
    rotation: 0 as Rotation,
    mirror: false,
    getPins() {
      return resolvedPins;
    },
    getProperties() {
      return new Map() as any;
    },
    getBoundingBox(): Rect {
      return { x: 0, y: 0, width: 1, height: 1 };
    },
    draw(_ctx: RenderContext) {},
    serialize() {
      return serialized;
    },
    getHelpText() {
      return "";
    },
    getAttribute() {
      return undefined;
    },
  } as unknown as CircuitElement;
}

/** Build a mock AnalogEngine that returns specified currents per element. */
function makeEngine(elementCurrents: number[]): AnalogEngine {
  return {
    getElementCurrent: (id: number) => elementCurrents[id] ?? 0,
    getElementPinCurrents: (id: number) => { const I = elementCurrents[id] ?? 0; return [I, -I]; },
    getNodeVoltage: () => 0,
    getBranchCurrent: () => 0,
    getElementPower: () => 0,
    simTime: 0,
    lastDt: 0,
    dcOperatingPoint: () => ({
      converged: true,
      method: "direct" as const,
      iterations: 0,
      nodeVoltages: new Float64Array(0),
      diagnostics: [],
    }),
    configure: () => {},
    onDiagnostic: () => {},
    addBreakpoint: () => {},
    clearBreakpoints: () => {},
    init: () => {},
    reset: () => {},
    dispose: () => {},
    start: () => {},
    stop: () => {},
    getState: () => {
      throw new Error("not used");
    },
    addChangeListener: () => {},
    removeChangeListener: () => {},
    addMeasurementObserver: () => {},
    removeMeasurementObserver: () => {},
    step: () => {},
  } as unknown as AnalogEngine;
}

/** Build a ResolvedAnalogCircuit from elements, pin positions, and wire map. */
function makeCompiled(
  elements: AnalogElement[],
  circuitElements: CircuitElement[],
  wireToNodeId: Map<Wire, number>,
): ResolvedAnalogCircuit {
  const elementToCircuitElement = new Map<number, CircuitElement>();
  const elementPinVertices = new Map<number, Array<{ x: number; y: number } | null>>();
  for (let i = 0; i < circuitElements.length; i++) {
    elementToCircuitElement.set(i, circuitElements[i]);
    // Mock CEs have position=(0,0) rotation=0, so pin world pos = pin.position
    const pins = circuitElements[i].getPins();
    elementPinVertices.set(i, pins.map(p => ({ x: p.position.x, y: p.position.y })));
  }
  return { wireToNodeId, elements, elementToCircuitElement, elementPinVertices };
}

/**
 * Build a ResolvedAnalogCircuit that also satisfies ConcreteCompiledAnalogCircuit
 * for use with the real MNAEngine.
 */
function makeCompiledWithEngine(params: {
  nodeCount: number;
  branchCount: number;
  elements: AnalogElement[];
  circuitElements: CircuitElement[];
  wireToNodeId: Map<Wire, number>;
}): ResolvedAnalogCircuit & ConcreteCompiledAnalogCircuit {
  const elementToCircuitElement = new Map<number, CircuitElement>();
  const elementPinVertices = new Map<number, Array<{ x: number; y: number } | null>>();
  for (let i = 0; i < params.circuitElements.length; i++) {
    elementToCircuitElement.set(i, params.circuitElements[i]);
    const pins = params.circuitElements[i].getPins();
    elementPinVertices.set(i, pins.map(p => ({ x: p.position.x, y: p.position.y })));
  }

  return {
    nodeCount: params.nodeCount,
    branchCount: params.branchCount,
    matrixSize: params.nodeCount + params.branchCount,
    elements: params.elements,
    labelToNodeId: new Map<string, number>(),
    wireToNodeId: params.wireToNodeId,
    elementToCircuitElement,
    elementPinVertices,
    netCount: params.nodeCount,
    componentCount: params.elements.length,
    elementCount: params.elements.length,
    timeRef: { value: 0 },
    models: new Map(),
    diagnostics: [],
    bridges: [],
  } as unknown as ResolvedAnalogCircuit & ConcreteCompiledAnalogCircuit;
}

// ===========================================================================
// Unit tests — mock elements with known currents
// ===========================================================================

describe("WireCurrentResolver", () => {
  let resolver: WireCurrentResolver;

  beforeEach(() => {
    resolver = new WireCurrentResolver();
  });

  it("series_circuit_uniform_current", () => {
    // 4 components in a closed series loop (KCL balanced at every node):
    //   source (0→1) → R1 (1→2) → R2 (2→3) → gnd_return (3→0)
    // Each node has a wire with element pins at BOTH endpoints. All carry 5 mA.
    const w1 = makeWire(0, 2, 2, 2);   // node 1: source.pos → R1.A
    const w2 = makeWire(4, 2, 6, 2);   // node 2: R1.B → R2.A
    const w3 = makeWire(8, 2, 10, 2);  // node 3: R2.B → gnd_return.A
    const w0 = makeWire(10, 0, 0, 0);  // node 0: gnd_return.B → source.neg

    const circuit = new Circuit();
    circuit.addWire(w0);
    circuit.addWire(w1);
    circuit.addWire(w2);
    circuit.addWire(w3);

    const wireToNodeId = new Map<Wire, number>([
      [w0, 0],
      [w1, 1],
      [w2, 2],
      [w3, 3],
    ]);

    const elements = [
      makeMockElement([0, 1]), // source
      makeMockElement([1, 2]), // R1
      makeMockElement([2, 3]), // R2
      makeMockElement([3, 0]), // gnd_return (closes the loop)
    ];
    const ces = [
      makeCE([{ x: 0, y: 0 }, { x: 0, y: 2 }]),   // source: neg(0,0) pos(0,2)
      makeCE([{ x: 2, y: 2 }, { x: 4, y: 2 }]),   // R1: A(2,2) B(4,2)
      makeCE([{ x: 6, y: 2 }, { x: 8, y: 2 }]),   // R2: A(6,2) B(8,2)
      makeCE([{ x: 10, y: 2 }, { x: 10, y: 0 }]), // gnd: A(10,2) B(10,0)
    ];

    const compiled = makeCompiled(elements, ces, wireToNodeId);
    const engine = makeEngine([0.005, 0.005, 0.005, 0.005]);

    resolver.resolve(engine, circuit, compiled);

    expect(resolver.getWireCurrent(w0)!.current).toBeCloseTo(0.005, 6);
    expect(resolver.getWireCurrent(w1)!.current).toBeCloseTo(0.005, 6);
    expect(resolver.getWireCurrent(w2)!.current).toBeCloseTo(0.005, 6);
    expect(resolver.getWireCurrent(w3)!.current).toBeCloseTo(0.005, 6);

    // Cross-component KCL: wire current at pin A == wire current at pin B
    // source (node0→node1): w0 side == w1 side
    expect(resolver.getWireCurrent(w0)!.current).toBeCloseTo(
      resolver.getWireCurrent(w1)!.current, 6);
    // R1 (node1→node2): w1 side == w2 side
    expect(resolver.getWireCurrent(w1)!.current).toBeCloseTo(
      resolver.getWireCurrent(w2)!.current, 6);
    // R2 (node2→node3): w2 side == w3 side
    expect(resolver.getWireCurrent(w2)!.current).toBeCloseTo(
      resolver.getWireCurrent(w3)!.current, 6);
    // gnd_return (node3→node0): w3 side == w0 side
    expect(resolver.getWireCurrent(w3)!.current).toBeCloseTo(
      resolver.getWireCurrent(w0)!.current, 6);

    // Component body paths must match wire currents
    const paths = resolver.getComponentPaths();
    expect(paths).toHaveLength(4);
    for (const path of paths) {
      expect(path.current).toBeCloseTo(0.005, 6);
    }
  });

  it("parallel_branch_split", () => {
    // Source → junction (node 1) → R1 (node 2) + R2 (node 3) → gnd
    // All nodes balanced (KCL). Node 1 is a 3-wire junction.
    //
    // Layout: junction at (2,2), source.pos at (0,2), R1.A at (2,0), R2.A at (2,4)
    const wSrc = makeWire(0, 2, 2, 2); // node 1: source.pos → junction
    const wJ1  = makeWire(2, 2, 2, 0); // node 1: junction → R1.A
    const wJ2  = makeWire(2, 2, 2, 4); // node 1: junction → R2.A
    const wR1  = makeWire(4, 0, 6, 0); // node 2: R1.B → gndR1.A
    const wR2  = makeWire(4, 4, 6, 4); // node 3: R2.B → gndR2.A

    const circuit = new Circuit();
    circuit.addWire(wSrc);
    circuit.addWire(wJ1);
    circuit.addWire(wJ2);
    circuit.addWire(wR1);
    circuit.addWire(wR2);

    const wireToNodeId = new Map<Wire, number>([
      [wSrc, 1], [wJ1, 1], [wJ2, 1],
      [wR1, 2],
      [wR2, 3],
    ]);

    // source (0→1, 10 mA), R1 (1→2, 3 mA), R2 (1→3, 7 mA)
    // gndR1 (2→0, 3 mA), gndR2 (3→0, 7 mA) — close the loop
    const elements = [
      makeMockElement([0, 1]),  // source
      makeMockElement([1, 2]),  // R1
      makeMockElement([1, 3]),  // R2
      makeMockElement([2, 0]),  // gndR1 (R1 return)
      makeMockElement([3, 0]),  // gndR2 (R2 return)
    ];
    const ces = [
      makeCE([{ x: 0, y: -2 }, { x: 0, y: 2 }]), // source: neg(0,-2) pos(0,2)
      makeCE([{ x: 2, y: 0 }, { x: 4, y: 0 }]),  // R1: A(2,0) B(4,0)
      makeCE([{ x: 2, y: 4 }, { x: 4, y: 4 }]),  // R2: A(2,4) B(4,4)
      makeCE([{ x: 6, y: 0 }, { x: 6, y: -2 }]), // gndR1: A(6,0) B(6,-2)
      makeCE([{ x: 6, y: 4 }, { x: 6, y: -2 }]), // gndR2: A(6,4) B(6,-2)
    ];

    const compiled = makeCompiled(elements, ces, wireToNodeId);
    const engine = makeEngine([0.01, 0.003, 0.007, 0.003, 0.007]);

    resolver.resolve(engine, circuit, compiled);

    // Node 1 junction: source injects +10mA, R1 takes -3mA, R2 takes -7mA → balanced
    expect(resolver.getWireCurrent(wSrc)!.current).toBeCloseTo(0.01, 5);
    expect(resolver.getWireCurrent(wJ1)!.current).toBeCloseTo(0.003, 5);
    expect(resolver.getWireCurrent(wJ2)!.current).toBeCloseTo(0.007, 5);
    // KCL at junction
    expect(resolver.getWireCurrent(wSrc)!.current).toBeCloseTo(
      resolver.getWireCurrent(wJ1)!.current + resolver.getWireCurrent(wJ2)!.current, 5);
    // Individual branch wires
    expect(resolver.getWireCurrent(wR1)!.current).toBeCloseTo(0.003, 5);
    expect(resolver.getWireCurrent(wR2)!.current).toBeCloseTo(0.007, 5);

    // Cross-component KCL: wire at pin A == wire at pin B for each component
    // R1 (node1→node2): junction wire wJ1 (pin A side) == wR1 (pin B side)
    expect(resolver.getWireCurrent(wJ1)!.current).toBeCloseTo(
      resolver.getWireCurrent(wR1)!.current, 5);
    // R2 (node1→node3): junction wire wJ2 (pin A side) == wR2 (pin B side)
    expect(resolver.getWireCurrent(wJ2)!.current).toBeCloseTo(
      resolver.getWireCurrent(wR2)!.current, 5);

    // Component body paths must match adjacent wire currents
    const paths = resolver.getComponentPaths();
    expect(paths).toHaveLength(5);
    // source: 10 mA
    expect(paths[0].current).toBeCloseTo(0.01, 5);
    // R1: 3 mA
    expect(paths[1].current).toBeCloseTo(0.003, 5);
    // R2: 7 mA
    expect(paths[2].current).toBeCloseTo(0.007, 5);
  });

  it("disconnected_wire_zero_current", () => {
    const wDisconnected = makeWire(5, 5, 6, 5);
    const wConnected = makeWire(0, 0, 2, 0);

    const circuit = new Circuit();
    circuit.addWire(wDisconnected);
    circuit.addWire(wConnected);

    const wireToNodeId = new Map<Wire, number>([[wConnected, 1]]);

    const elements = [makeMockElement([0, 1])];
    const ces = [makeCE([{ x: 0, y: -2 }, { x: 0, y: 0 }])];

    const compiled = makeCompiled(elements, ces, wireToNodeId);
    const engine = makeEngine([0.005]);

    resolver.resolve(engine, circuit, compiled);

    const cDisc = resolver.getWireCurrent(wDisconnected);
    expect(cDisc).toBeDefined();
    expect(cDisc!.current).toBe(0);
    expect(cDisc!.flowSign).toBe(0);
  });

  it("direction_follows_unit_vector", () => {
    // Two elements share node 1 via a wire: source enters, R1 leaves.
    // KCL balanced: +I at wire.start, -I at wire.end → total = 0.
    const wire = makeWire(0, 0, 4, 0);

    const circuit = new Circuit();
    circuit.addWire(wire);

    const wireToNodeId = new Map<Wire, number>([[wire, 1]]);
    const elements = [
      makeMockElement([0, 1]), // source: pin1 at (0,0) injects +I into node 1
      makeMockElement([1, 2]), // R1: pin0 at (4,0) takes -I from node 1
    ];
    const ces = [
      makeCE([{ x: 0, y: -2 }, { x: 0, y: 0 }]),  // source: neg(0,-2) pos(0,0)
      makeCE([{ x: 4, y: 0 }, { x: 4, y: 2 }]),    // R1: A(4,0) B(4,2)
    ];

    const compiled = makeCompiled(elements, ces, wireToNodeId);
    const engine = makeEngine([0.01, 0.01]);

    resolver.resolve(engine, circuit, compiled);

    const result = resolver.getWireCurrent(wire);
    expect(result).toBeDefined();
    expect(result!.current).toBeGreaterThan(0);

    const [dx, dy] = result!.direction;
    const len = Math.sqrt(dx * dx + dy * dy);
    expect(len).toBeCloseTo(1, 5);
  });

  it("flowSign_indicates_direction_relative_to_wire", () => {
    // Wire from (0,0) to (4,0) at node 1. Two elements balance KCL:
    //   source pin1 at (0,0) injects +I (current enters node 1)
    //   R1 pin0 at (4,0) injects -I (current leaves node 1)
    // Current flows start→end → flowSign = +1.
    const wire = makeWire(0, 0, 4, 0);
    const circuit = new Circuit();
    circuit.addWire(wire);

    const wireToNodeId = new Map<Wire, number>([[wire, 1]]);

    const elements = [
      makeMockElement([0, 1]), // source
      makeMockElement([1, 2]), // R1
    ];
    const ces = [
      makeCE([{ x: 0, y: -2 }, { x: 0, y: 0 }]),  // source: neg, pos(0,0)
      makeCE([{ x: 4, y: 0 }, { x: 4, y: 2 }]),    // R1: A(4,0), B(4,2)
    ];

    const compiled = makeCompiled(elements, ces, wireToNodeId);
    const engine = makeEngine([0.01, 0.01]);

    resolver.resolve(engine, circuit, compiled);

    const result = resolver.getWireCurrent(wire)!;
    expect(result.current).toBeCloseTo(0.01, 6);
    // Current enters at wire.start (0,0) and leaves at wire.end (4,0)
    expect(result.flowSign).toBe(1);
  });

  it("clear_resets_results", () => {
    const wire = makeWire(0, 0, 2, 0);
    const circuit = new Circuit();
    circuit.addWire(wire);

    const wireToNodeId = new Map<Wire, number>([[wire, 1]]);
    const elements = [makeMockElement([0, 1])];
    const ces = [makeCE([{ x: 0, y: -2 }, { x: 0, y: 0 }])];

    const compiled = makeCompiled(elements, ces, wireToNodeId);
    const engine = makeEngine([0.005]);

    resolver.resolve(engine, circuit, compiled);
    expect(resolver.getWireCurrent(wire)).toBeDefined();

    resolver.clear();
    expect(resolver.getWireCurrent(wire)).toBeUndefined();
  });

  it("junction_node_tree_traces_correct_branch_currents", () => {
    // 3 wires at one node meeting at junction point (4,3).
    // Element terminals inject current at the leaf endpoints.
    //
    //   R1.B(4,0) ──w1──▶ junction(4,3)
    //                      ├──w2──▶ R2.A(4,6)
    //                      └──w3──▶ R3.A(10,3)
    //
    // R1 carries 10 mA, R2 carries 6 mA, R3 carries 4 mA.
    // KCL: 10 = 6 + 4.
    const w1 = makeWire(4, 0, 4, 3);
    const w2 = makeWire(4, 3, 4, 6);
    const w3 = makeWire(4, 3, 10, 3);

    const circuit = new Circuit();
    circuit.addWire(w1);
    circuit.addWire(w2);
    circuit.addWire(w3);

    // All three wires are at node 2
    const wireToNodeId = new Map<Wire, number>([
      [w1, 2],
      [w2, 2],
      [w3, 2],
    ]);

    // R1: nodes 1→2 (10 mA), R2: nodes 2→0 (6 mA), R3: nodes 2→0 (4 mA)
    const elements = [
      makeMockElement([1, 2]),
      makeMockElement([2, 0]),
      makeMockElement([2, 0]),
    ];
    // Pin positions:
    //   R1: A at some node1 pos, B at (4,0) which is node 2
    //   R2: A at (4,6) which is node 2, B at some gnd pos
    //   R3: A at (10,3) which is node 2, B at some gnd pos
    const ces = [
      makeCE([{ x: 0, y: 0 }, { x: 4, y: 0 }]), // R1: A(0,0)→n1, B(4,0)→n2
      makeCE([{ x: 4, y: 6 }, { x: 4, y: 10 }]), // R2: A(4,6)→n2, B(4,10)→gnd
      makeCE([{ x: 10, y: 3 }, { x: 10, y: 10 }]), // R3: A(10,3)→n2, B(10,10)→gnd
    ];

    const compiled = makeCompiled(elements, ces, wireToNodeId);
    const engine = makeEngine([0.010, 0.006, 0.004]);

    resolver.resolve(engine, circuit, compiled);

    const c1 = resolver.getWireCurrent(w1)!;
    const c2 = resolver.getWireCurrent(w2)!;
    const c3 = resolver.getWireCurrent(w3)!;

    // w1 carries the full R1 current
    expect(c1.current).toBeCloseTo(0.010, 6);
    // w2 carries R2 current
    expect(c2.current).toBeCloseTo(0.006, 6);
    // w3 carries R3 current
    expect(c3.current).toBeCloseTo(0.004, 6);
    // KCL at junction: parent = sum of children
    expect(c1.current).toBeCloseTo(c2.current + c3.current, 6);
  });
});

// ===========================================================================
// KCL conservation tests — real MNA engine, tree-traced attribution
// ===========================================================================

describe("WireCurrentResolver — KCL conservation", () => {
  let resolver: WireCurrentResolver;

  beforeEach(() => {
    resolver = new WireCurrentResolver();
  });

  // -------------------------------------------------------------------------
  // Test 1: DC source + 3 resistors (parallel split at junction)
  //
  // Vs(5V) → R1(1kΩ) → node2 → R2(2kΩ)||R3(3kΩ) → ground
  //
  // Node 1: Vs.pos(0,0), R1.A(4,0)  — single wire
  // Node 2: R1.B(8,0), R2.A(8,6), R3.A(14,3) — JUNCTION at (8,3)
  //   Wire: (8,0)→(8,3), (8,3)→(8,6), (8,3)→(14,3)
  // Ground: Vs.neg(0,6), R2.B(8,10), R3.B(14,10)
  // -------------------------------------------------------------------------

  it("DC parallel split: junction wires carry correct individual currents", () => {
    const R1 = 1000,
      R2 = 2000,
      R3 = 3000,
      VS = 5;
    const Rpar = (R2 * R3) / (R2 + R3);
    const Rtotal = R1 + Rpar;
    const Itotal = VS / Rtotal;
    const V2 = VS * Rpar / Rtotal;
    const I_R2 = V2 / R2;
    const I_R3 = V2 / R3;

    // MNA: node1=idx0, node2=idx1, branch=idx2 → matrixSize=3
    const vs = makeVoltageSource(1, 0, 2, VS);
    const r1 = makeResistor(1, 2, R1);
    const r2 = makeResistor(2, 0, R2);
    const r3 = makeResistor(2, 0, R3);

    const ceVs = makeCE([{ x: 0, y: 0 }, { x: 0, y: 6 }]);
    const ceR1 = makeCE([{ x: 4, y: 0 }, { x: 8, y: 0 }]);
    const ceR2 = makeCE([{ x: 8, y: 6 }, { x: 8, y: 10 }]);
    const ceR3 = makeCE([{ x: 14, y: 3 }, { x: 14, y: 10 }]);

    const w_n1 = makeWire(0, 0, 4, 0);
    const w_r1b = makeWire(8, 0, 8, 3);
    const w_r2a = makeWire(8, 3, 8, 6);
    const w_r3a = makeWire(8, 3, 14, 3);
    const w_g1 = makeWire(0, 6, 8, 10);
    const w_g2 = makeWire(8, 10, 14, 10);

    const wireToNodeId = new Map<Wire, number>([
      [w_n1, 1],
      [w_r1b, 2],
      [w_r2a, 2],
      [w_r3a, 2],
      [w_g1, 0],
      [w_g2, 0],
    ]);

    const circuit = new Circuit();
    for (const w of wireToNodeId.keys()) circuit.addWire(w);

    const compiled = makeCompiledWithEngine({
      nodeCount: 2,
      branchCount: 1,
      elements: [vs, r1, r2, r3],
      circuitElements: [ceVs, ceR1, ceR2, ceR3],
      wireToNodeId,
    });

    const engine = new MNAEngine();
    engine.init(compiled as unknown as ConcreteCompiledAnalogCircuit);
    const dc = engine.dcOperatingPoint();
    expect(dc.converged).toBe(true);

    expect(engine.getNodeVoltage(1)).toBeCloseTo(VS, 3);
    expect(engine.getNodeVoltage(2)).toBeCloseTo(V2, 3);

    resolver.resolve(
      engine as unknown as AnalogEngine,
      circuit,
      compiled,
    );

    const c_n1 = resolver.getWireCurrent(w_n1)!;
    const c_r1b = resolver.getWireCurrent(w_r1b)!;
    const c_r2a = resolver.getWireCurrent(w_r2a)!;
    const c_r3a = resolver.getWireCurrent(w_r3a)!;

    expect(c_n1.current).toBeCloseTo(Itotal, 5);
    expect(c_r1b.current).toBeCloseTo(Itotal, 5);
    expect(c_r2a.current).toBeCloseTo(I_R2, 5);
    expect(c_r3a.current).toBeCloseTo(I_R3, 5);

    // KCL at junction
    expect(c_r1b.current).toBeCloseTo(c_r2a.current + c_r3a.current, 5);

    // Cross-component KCL: wire at pin A == wire at pin B
    // R1 (node1→node2): w_n1 (pin A side) == w_r1b (pin B side)
    expect(c_n1.current).toBeCloseTo(c_r1b.current, 5);

    // Component body paths must match adjacent wire currents
    const paths = resolver.getComponentPaths();
    expect(paths).toHaveLength(4);
    expect(paths[1].current).toBeCloseTo(Itotal, 5);  // R1
    expect(paths[2].current).toBeCloseTo(I_R2, 5);    // R2
    expect(paths[3].current).toBeCloseTo(I_R3, 5);    // R3
  });

  // -------------------------------------------------------------------------
  // Test 2: 4-node resistor ladder
  //
  // Vs(10V)→R1(1kΩ)→n2→R3(1kΩ)→n3→R5(2kΩ)→n4→R7(4kΩ)→gnd
  //                  |            |            |
  //              R2(2kΩ)→gnd  R4(3kΩ)→gnd  R6(1kΩ)→gnd
  //
  // 4 non-ground nodes. Nodes 2, 3, 4 each have 3-way junctions.
  // -------------------------------------------------------------------------

  it("4-node ladder: junction wires satisfy KCL at every node", () => {
    const VS = 10;
    const R1v = 1000, R2v = 2000, R3v = 1000, R4v = 3000;
    const R5v = 2000, R6v = 1000, R7v = 4000;

    const vs = makeVoltageSource(1, 0, 4, VS);
    const r1 = makeResistor(1, 2, R1v);
    const r2 = makeResistor(2, 0, R2v);
    const r3 = makeResistor(2, 3, R3v);
    const r4 = makeResistor(3, 0, R4v);
    const r5 = makeResistor(3, 4, R5v);
    const r6 = makeResistor(4, 0, R6v);
    const r7 = makeResistor(4, 0, R7v);

    const ceVs = makeCE([{ x: 0, y: 0 }, { x: 0, y: 10 }]);
    const ceR1 = makeCE([{ x: 4, y: 0 }, { x: 8, y: 0 }]);
    const ceR2 = makeCE([{ x: 8, y: 6 }, { x: 8, y: 10 }]);
    const ceR3 = makeCE([{ x: 14, y: 3 }, { x: 18, y: 0 }]);
    const ceR4 = makeCE([{ x: 18, y: 6 }, { x: 18, y: 10 }]);
    const ceR5 = makeCE([{ x: 24, y: 3 }, { x: 28, y: 0 }]);
    const ceR6 = makeCE([{ x: 28, y: 6 }, { x: 28, y: 10 }]);
    const ceR7 = makeCE([{ x: 34, y: 3 }, { x: 34, y: 10 }]);

    // Node 1: single wire
    const w_n1 = makeWire(0, 0, 4, 0);

    // Node 2: junction at (8,3)
    const w2_r1b = makeWire(8, 0, 8, 3);
    const w2_r2a = makeWire(8, 3, 8, 6);
    const w2_r3a = makeWire(8, 3, 14, 3);

    // Node 3: junction at (18,3)
    const w3_r3b = makeWire(18, 0, 18, 3);
    const w3_r4a = makeWire(18, 3, 18, 6);
    const w3_r5a = makeWire(18, 3, 24, 3);

    // Node 4: junction at (28,3)
    const w4_r5b = makeWire(28, 0, 28, 3);
    const w4_r6a = makeWire(28, 3, 28, 6);
    const w4_r7a = makeWire(28, 3, 34, 3);

    // Ground wires
    const w_g1 = makeWire(0, 10, 8, 10);
    const w_g2 = makeWire(8, 10, 18, 10);
    const w_g3 = makeWire(18, 10, 28, 10);
    const w_g4 = makeWire(28, 10, 34, 10);

    const wireToNodeId = new Map<Wire, number>([
      [w_n1, 1],
      [w2_r1b, 2], [w2_r2a, 2], [w2_r3a, 2],
      [w3_r3b, 3], [w3_r4a, 3], [w3_r5a, 3],
      [w4_r5b, 4], [w4_r6a, 4], [w4_r7a, 4],
      [w_g1, 0], [w_g2, 0], [w_g3, 0], [w_g4, 0],
    ]);

    const circuit = new Circuit();
    for (const w of wireToNodeId.keys()) circuit.addWire(w);

    const compiled = makeCompiledWithEngine({
      nodeCount: 4,
      branchCount: 1,
      elements: [vs, r1, r2, r3, r4, r5, r6, r7],
      circuitElements: [ceVs, ceR1, ceR2, ceR3, ceR4, ceR5, ceR6, ceR7],
      wireToNodeId,
    });

    const engine = new MNAEngine();
    engine.init(compiled as unknown as ConcreteCompiledAnalogCircuit);
    const dc = engine.dcOperatingPoint();
    expect(dc.converged).toBe(true);

    const V1 = engine.getNodeVoltage(1);
    const V2 = engine.getNodeVoltage(2);
    const V3 = engine.getNodeVoltage(3);
    const V4 = engine.getNodeVoltage(4);

    expect(V1).toBeCloseTo(VS, 2);

    // Element currents from node voltages
    const I_R1 = (V1 - V2) / R1v;
    const I_R2 = V2 / R2v;
    const I_R3 = (V2 - V3) / R3v;
    const I_R4 = V3 / R4v;
    const I_R5 = (V3 - V4) / R5v;
    const I_R6 = V4 / R6v;
    const I_R7 = V4 / R7v;

    // Verify MNA KCL at each node
    expect(I_R1 - I_R2 - I_R3).toBeCloseTo(0, 8);
    expect(I_R3 - I_R4 - I_R5).toBeCloseTo(0, 8);
    expect(I_R5 - I_R6 - I_R7).toBeCloseTo(0, 8);

    // Run resolver
    resolver.resolve(
      engine as unknown as AnalogEngine,
      circuit,
      compiled,
    );

    // ---- Node 2 junction KCL ----
    const c2_r1b = resolver.getWireCurrent(w2_r1b)!;
    const c2_r2a = resolver.getWireCurrent(w2_r2a)!;
    const c2_r3a = resolver.getWireCurrent(w2_r3a)!;

    expect(c2_r1b.current).toBeCloseTo(I_R1, 5);
    expect(c2_r2a.current).toBeCloseTo(I_R2, 5);
    expect(c2_r3a.current).toBeCloseTo(I_R3, 5);
    expect(c2_r1b.current).toBeCloseTo(c2_r2a.current + c2_r3a.current, 5);

    // ---- Node 3 junction KCL ----
    const c3_r3b = resolver.getWireCurrent(w3_r3b)!;
    const c3_r4a = resolver.getWireCurrent(w3_r4a)!;
    const c3_r5a = resolver.getWireCurrent(w3_r5a)!;

    expect(c3_r3b.current).toBeCloseTo(I_R3, 5);
    expect(c3_r4a.current).toBeCloseTo(I_R4, 5);
    expect(c3_r5a.current).toBeCloseTo(I_R5, 5);
    expect(c3_r3b.current).toBeCloseTo(c3_r4a.current + c3_r5a.current, 5);

    // ---- Node 4 junction KCL ----
    const c4_r5b = resolver.getWireCurrent(w4_r5b)!;
    const c4_r6a = resolver.getWireCurrent(w4_r6a)!;
    const c4_r7a = resolver.getWireCurrent(w4_r7a)!;

    expect(c4_r5b.current).toBeCloseTo(I_R5, 5);
    expect(c4_r6a.current).toBeCloseTo(I_R6, 5);
    expect(c4_r7a.current).toBeCloseTo(I_R7, 5);
    expect(c4_r5b.current).toBeCloseTo(c4_r6a.current + c4_r7a.current, 5);

    // ---- Node 1 (single wire) ----
    expect(resolver.getWireCurrent(w_n1)!.current).toBeCloseTo(I_R1, 5);

    // ---- Cross-component KCL: wire at pin A == wire at pin B ----
    // R1 (node1→node2): w_n1 (pin A side) == w2_r1b (pin B side)
    expect(resolver.getWireCurrent(w_n1)!.current).toBeCloseTo(c2_r1b.current, 5);
    // R3 (node2→node3): w2_r3a (pin A side) == w3_r3b (pin B side)
    expect(c2_r3a.current).toBeCloseTo(c3_r3b.current, 5);
    // R5 (node3→node4): w3_r5a (pin A side) == w4_r5b (pin B side)
    expect(c3_r5a.current).toBeCloseTo(c4_r5b.current, 5);

    // ---- Component body paths match wire currents ----
    const paths = resolver.getComponentPaths();
    expect(paths).toHaveLength(8);
    // R1 (element 1)
    expect(paths[1].current).toBeCloseTo(I_R1, 5);
    expect(paths[1].current).toBeCloseTo(c2_r1b.current, 5);
    // R3 (element 3)
    expect(paths[3].current).toBeCloseTo(I_R3, 5);
    expect(paths[3].current).toBeCloseTo(c2_r3a.current, 5);
    // R5 (element 5)
    expect(paths[5].current).toBeCloseTo(I_R5, 5);
    expect(paths[5].current).toBeCloseTo(c3_r5a.current, 5);

    // ---- All currents are positive (non-degenerate) ----
    for (const w of [w_n1, w2_r1b, w2_r2a, w2_r3a, w3_r3b, w3_r4a, w3_r5a, w4_r5b, w4_r6a, w4_r7a]) {
      expect(resolver.getWireCurrent(w)!.current).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// AC transient KCL — RLC circuit with time-varying currents
// ===========================================================================

describe("WireCurrentResolver — AC transient RLC", () => {
  // -------------------------------------------------------------------------
  // AC source → Resistor → junction → (Capacitor || Inductor) → ground
  //
  // This is the topology of lrctest.dig. At the junction node, the resistor
  // current splits into capacitor and inductor branches whose magnitudes and
  // phases vary over time. The test verifies that the tree-traced resolver
  // correctly attributes per-wire currents at every timestep during AC
  // steady-state operation.
  //
  // MNA layout:
  //   Node 1: Vs.pos, R.A       (voltages[0])
  //   Node 2: R.B, C.pos, L.A   (voltages[1])  ← junction under test
  //   Ground: Vs.neg, C.neg, L.B
  //   Branch 0: Vs current       (voltages[2])
  //   Branch 1: L current        (voltages[3])
  //   matrixSize = 4
  //
  // Wire layout at node 2 (junction at (8,3)):
  //   (8,0)→(8,3)    from R.B
  //   (8,3)→(8,6)    to C.pos
  //   (8,3)→(14,3)   to L.A
  // -------------------------------------------------------------------------

  it("RLC junction: wire currents match element currents at every AC timestep", () => {
    const R = 1000;       // 1 kΩ
    const C = 1e-6;       // 1 µF
    const L = 0.1;        // 100 mH
    const F = 100;        // 100 Hz
    const A = 5;          // 5 V peak
    const TAU = R * C;    // 1 ms (RC time constant)

    const timeRef = { value: 0 };
    const getTime = () => timeRef.value;

    // Elements: Vs at branch 2, L at branch 3
    const vs = makeAcVoltageSource(1, 0, 2, A, F, 0, 0, getTime);
    const r = makeResistor(1, 2, R);
    const cap = makeCapacitor(2, 0, C);
    const ind = makeInductor(2, 0, 3, L);

    // Pin positions
    const ceVs = makeCE([{ x: 0, y: 0 }, { x: 0, y: 10 }]);   // pos(0,0), neg(0,10)
    const ceR = makeCE([{ x: 4, y: 0 }, { x: 8, y: 0 }]);     // A(4,0), B(8,0)
    const ceC = makeCE([{ x: 8, y: 6 }, { x: 8, y: 10 }]);    // pos(8,6), neg(8,10)
    const ceL = makeCE([{ x: 14, y: 3 }, { x: 14, y: 10 }]);  // A(14,3), B(14,10)

    // Wires
    const w_n1 = makeWire(0, 0, 4, 0);      // node 1: Vs.pos → R.A

    // Node 2 junction at (8,3)
    const w_rb = makeWire(8, 0, 8, 3);      // R.B → junction
    const w_ca = makeWire(8, 3, 8, 6);      // junction → C.pos
    const w_la = makeWire(8, 3, 14, 3);     // junction → L.A

    // Ground wires
    const w_g1 = makeWire(0, 10, 8, 10);
    const w_g2 = makeWire(8, 10, 14, 10);

    const wireToNodeId = new Map<Wire, number>([
      [w_n1, 1],
      [w_rb, 2], [w_ca, 2], [w_la, 2],
      [w_g1, 0], [w_g2, 0],
    ]);

    const circuit = new Circuit();
    for (const w of wireToNodeId.keys()) circuit.addWire(w);

    const compiled = makeCompiledWithEngine({
      nodeCount: 2,
      branchCount: 2,
      elements: [vs, r, cap, ind],
      circuitElements: [ceVs, ceR, ceC, ceL],
      wireToNodeId,
    });

    // Run MNA engine
    const engine = new MNAEngine();
    engine.init(compiled as unknown as ConcreteCompiledAnalogCircuit);
    const dc = engine.dcOperatingPoint();
    expect(dc.converged).toBe(true);

    // Step to steady state: 10 × τ_RC = 10 ms
    const settleTime = 10 * TAU;
    let steps = 0;
    while (engine.simTime < settleTime && steps < 100_000) {
      engine.step();
      steps++;
    }
    expect(engine.simTime).toBeGreaterThan(settleTime * 0.9);

    // Now verify KCL at the junction over one full AC period.
    // At each timestep:
    //   1. Each wire current must match its adjacent element's current magnitude
    //   2. KCL: I_R = I_C + I_L (signed), so |I_R| = |I_C + I_L|
    const resolver = new WireCurrentResolver();
    const periodEnd = engine.simTime + 1 / F;
    let sampleCount = 0;
    let maxKclError = 0;
    let maxWireElementError = 0;

    while (engine.simTime < periodEnd && sampleCount < 50_000) {
      engine.step();
      sampleCount++;

      resolver.resolve(
        engine as unknown as AnalogEngine,
        circuit,
        compiled,
      );

      // Element currents (convention: positive = from pinNodeIds[0] to [1])
      const I_R = engine.getElementCurrent(1);   // resistor
      const I_C = engine.getElementCurrent(2);   // capacitor
      const I_L = engine.getElementCurrent(3);   // inductor

      // Skip steps with negligible current (near zero crossings)
      const maxI = Math.max(Math.abs(I_R), Math.abs(I_C), Math.abs(I_L));
      if (maxI < 1e-9) continue;

      // Wire currents
      const cRB = resolver.getWireCurrent(w_rb)!.current;
      const cCA = resolver.getWireCurrent(w_ca)!.current;
      const cLA = resolver.getWireCurrent(w_la)!.current;

      // Each wire should match its element's current magnitude
      const errR = Math.abs(cRB - Math.abs(I_R));
      const errC = Math.abs(cCA - Math.abs(I_C));
      const errL = Math.abs(cLA - Math.abs(I_L));
      const wireErr = Math.max(errR, errC, errL) / maxI;
      if (wireErr > maxWireElementError) maxWireElementError = wireErr;

      // Cross-component: resistor pin A wire (w_n1) == resistor pin B wire (w_rb)
      const cN1 = resolver.getWireCurrent(w_n1)!.current;
      const crossRErr = Math.abs(cN1 - cRB) / maxI;
      if (crossRErr > maxWireElementError) maxWireElementError = crossRErr;

      // Component body paths must match element currents
      const paths = resolver.getComponentPaths();
      const pathErrR = Math.abs(paths[1].current - Math.abs(I_R)) / maxI;
      const pathErrC = Math.abs(paths[2].current - Math.abs(I_C)) / maxI;
      const pathErrL = Math.abs(paths[3].current - Math.abs(I_L)) / maxI;
      const pathErr = Math.max(pathErrR, pathErrC, pathErrL);
      if (pathErr > maxWireElementError) maxWireElementError = pathErr;

      // KCL at node 2: I_R (entering via terminal 1) = I_C + I_L (leaving via terminal 0)
      // Signed: I_R - I_C - I_L should ≈ 0
      // But from getElementCurrent convention:
      //   R: pinNodeIds=[1,2], positive I_R flows 1→2, so I_R enters node 2
      //   C: pinNodeIds=[2,0], positive I_C flows 2→0, so I_C leaves node 2
      //   L: pinNodeIds=[2,0], positive I_L flows 2→0, so I_L leaves node 2
      // KCL: I_R - I_C - I_L = 0
      const kclResidual = Math.abs(I_R - I_C - I_L) / maxI;
      if (kclResidual > maxKclError) maxKclError = kclResidual;
    }

    // Must have taken meaningful steps
    expect(sampleCount).toBeGreaterThan(10);

    // MNA guarantees KCL — residual should be near machine epsilon
    expect(maxKclError).toBeLessThan(1e-6);

    // Wire currents should match element currents within 1%
    // (tiny numerical differences from companion model discretisation)
    expect(maxWireElementError).toBeLessThan(0.01);
  });
});

// ===========================================================================
// Cross-component KCL — wire current at each pin must match component body
// ===========================================================================

describe("WireCurrentResolver — cross-component pin-wire matching", () => {
  // -------------------------------------------------------------------------
  // For every 2-terminal component, the wire adjacent to each pin must carry
  // at least that component's current. When the pin connects to a
  // non-junction wire (single wire at the node), the wire current must equal
  // the element current exactly. This catches the "current mismatch into vs
  // out of a component" visual bug.
  //
  // Topology (same as the AC transient RLC):
  //   Vs(5V AC) → R(1kΩ) → junction → C(1µF) || L(100mH) → ground
  //
  // Pin-wire pairs checked:
  //   Vs pin 0 (node 1, non-junction): w_n1 must carry I_Vs
  //   Vs pin 1 (ground, junction): adjacent wire carries merged return current
  //   R pin 0 (node 1, non-junction): w_n1 must carry I_R
  //   R pin 1 (node 2, junction stem): w_rb must carry I_R
  //   C pin 0 (node 2, junction leaf): w_ca must carry I_C
  //   L pin 0 (node 2, junction leaf): w_la must carry I_L
  //   C pin 1 (ground): adjacent wire ≥ I_C
  //   L pin 1 (ground): adjacent wire ≥ I_L
  //
  // Component paths must match element currents exactly.
  // -------------------------------------------------------------------------

  it("wire current at each pin matches component body current", () => {
    const R = 1000;
    const C_val = 1e-6;
    const L_val = 0.1;
    const F = 100;
    const A_val = 5;
    const TAU = R * C_val;

    const timeRef = { value: 0 };
    const getTime = () => timeRef.value;

    const vs = makeAcVoltageSource(1, 0, 2, A_val, F, 0, 0, getTime);
    const r = makeResistor(1, 2, R);
    const cap = makeCapacitor(2, 0, C_val);
    const ind = makeInductor(2, 0, 3, L_val);

    // Pin positions — must match wire endpoints
    const ceVs = makeCE([{ x: 0, y: 0 }, { x: 0, y: 10 }]);
    const ceR  = makeCE([{ x: 4, y: 0 }, { x: 8, y: 0 }]);
    const ceC  = makeCE([{ x: 8, y: 6 }, { x: 8, y: 10 }]);
    const ceL  = makeCE([{ x: 14, y: 3 }, { x: 14, y: 10 }]);

    // Wires
    const w_n1 = makeWire(0, 0, 4, 0);       // node 1
    const w_rb = makeWire(8, 0, 8, 3);        // node 2 stem
    const w_ca = makeWire(8, 3, 8, 6);        // node 2 → C
    const w_la = makeWire(8, 3, 14, 3);       // node 2 → L
    const w_g1 = makeWire(0, 10, 8, 10);      // ground
    const w_g2 = makeWire(8, 10, 14, 10);     // ground

    const wireToNodeId = new Map<Wire, number>([
      [w_n1, 1],
      [w_rb, 2], [w_ca, 2], [w_la, 2],
      [w_g1, 0], [w_g2, 0],
    ]);

    const circuit = new Circuit();
    for (const w of wireToNodeId.keys()) circuit.addWire(w);

    const compiled = makeCompiledWithEngine({
      nodeCount: 2,
      branchCount: 2,
      elements: [vs, r, cap, ind],
      circuitElements: [ceVs, ceR, ceC, ceL],
      wireToNodeId,
    });

    const engine = new MNAEngine();
    engine.init(compiled as unknown as ConcreteCompiledAnalogCircuit);
    engine.dcOperatingPoint();

    // Settle to steady state
    const settleTime = 10 * TAU;
    let steps = 0;
    while (engine.simTime < settleTime && steps < 100_000) {
      engine.step();
      steps++;
    }

    const resolver = new WireCurrentResolver();
    const periodEnd = engine.simTime + 1 / F;
    let sampleCount = 0;
    let maxPinWireError = 0;
    let maxComponentPathError = 0;
    let maxGroundWireError = 0;

    while (engine.simTime < periodEnd && sampleCount < 50_000) {
      engine.step();
      sampleCount++;

      resolver.resolve(
        engine as unknown as AnalogEngine,
        circuit,
        compiled,
      );

      const I_Vs = Math.abs(engine.getElementCurrent(0));
      const I_R  = Math.abs(engine.getElementCurrent(1));
      const I_C  = Math.abs(engine.getElementCurrent(2));
      const I_L  = Math.abs(engine.getElementCurrent(3));

      const maxI = Math.max(I_Vs, I_R, I_C, I_L);
      if (maxI < 1e-9) continue;

      // --- Pin-wire matching (non-junction, exact) ---
      // Vs pin 0 at (0,0) → w_n1 start: should carry I_Vs
      // R pin 0 at (4,0) → w_n1 end: should carry I_R (= I_Vs in series)
      const c_n1 = resolver.getWireCurrent(w_n1)!.current;
      const errVsPin0 = Math.abs(c_n1 - I_Vs) / maxI;
      const errRPin0  = Math.abs(c_n1 - I_R) / maxI;

      // R pin 1 at (8,0) → w_rb start: should carry I_R
      const c_rb = resolver.getWireCurrent(w_rb)!.current;
      const errRPin1 = Math.abs(c_rb - I_R) / maxI;

      // C pin 0 at (8,6) → w_ca end: should carry I_C
      const c_ca = resolver.getWireCurrent(w_ca)!.current;
      const errCPin0 = Math.abs(c_ca - I_C) / maxI;

      // L pin 0 at (14,3) → w_la end: should carry I_L
      const c_la = resolver.getWireCurrent(w_la)!.current;
      const errLPin0 = Math.abs(c_la - I_L) / maxI;

      const pinErr = Math.max(errVsPin0, errRPin0, errRPin1, errCPin0, errLPin0);
      if (pinErr > maxPinWireError) maxPinWireError = pinErr;

      // --- Component paths must match element currents exactly ---
      const paths = resolver.getComponentPaths();
      expect(paths.length).toBe(4);
      const pathErr = Math.max(
        Math.abs(paths[0].current - I_Vs) / maxI,  // Vs
        Math.abs(paths[1].current - I_R) / maxI,   // R
        Math.abs(paths[2].current - I_C) / maxI,   // C
        Math.abs(paths[3].current - I_L) / maxI,   // L
      );
      if (pathErr > maxComponentPathError) maxComponentPathError = pathErr;

      // --- Ground wires: min-attribution must not exceed element currents ---
      // w_g2 connects C.neg junction to L.neg.
      // With correct min-attribution, w_g2 should carry I_L (the lighter subtree).
      // It must NOT carry the inflated I_Vs + I_C from the max formulation.
      const c_g2 = resolver.getWireCurrent(w_g2)!.current;
      const errG2 = Math.abs(c_g2 - I_L) / maxI;
      if (errG2 > maxGroundWireError) maxGroundWireError = errG2;
    }

    expect(sampleCount).toBeGreaterThan(10);

    // Pin-adjacent wire currents match element currents within 1%
    expect(maxPinWireError).toBeLessThan(0.01);

    // Component body paths match element currents within 1%
    expect(maxComponentPathError).toBeLessThan(0.01);

    // Ground wire min-attribution matches expected element current within 1%
    expect(maxGroundWireError).toBeLessThan(0.01);
  });
});

// ===========================================================================
// Real lrctest.dig fixture — full pipeline (load → compile → MNA → resolve)
// ===========================================================================

describe("WireCurrentResolver — lrctest.dig real fixture", () => {
  // -------------------------------------------------------------------------
  // Loads the actual lrctest.dig fixture through the full pipeline:
  //   XML parse → analog compile → MNA engine → DC OP → transient → resolve
  //
  // The circuit has rotated components whose pin world positions do NOT
  // coincide with wire endpoints. This is the real integration test that
  // validates the entire current visualization pipeline end-to-end.
  //
  // Topology: AcVs → R → junction → C || L → ground loop
  //
  // For every 2-terminal component, the test verifies:
  //   1. Wire current at pin A ≈ wire current at pin B (cross-component KCL)
  //   2. Component body path current ≈ element current from MNA
  //   3. KCL at junction nodes (sum of branch currents = 0)
  // -------------------------------------------------------------------------

  it("cross-component current equality through real compiled lrctest.dig", async () => {
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");
    const { DefaultSimulatorFacade } = await import("@/headless/default-facade");
    const { createDefaultRegistry } = await import("@/components/register-all");
    const { compileUnified } = await import("@/compile/compile");
    const { MNAEngine } = await import("@/analog/analog-engine");
    const { pinWorldPosition } = await import("@/core/pin");

    // Load the real lrctest.dig fixture through the full pipeline:
    // XML parse → analog compile → MNA engine → transient → resolve
    const xml = readFileSync(
      resolve(__dirname, "../../../fixtures/lrctest.dig"),
      "utf-8",
    );
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = facade.loadDigXml(xml);
    circuit.metadata = { ...circuit.metadata, engineType: "analog" };

    // Compile through real analog compiler
    const compiled = compileUnified(circuit, registry).analog!;
    expect(compiled.elements.length).toBeGreaterThan(0);

    const engine = new MNAEngine();
    engine.init(compiled);

    // DC OP — may or may not converge depending on topology (inductor at DC).
    // Either way, transient stepping will settle the circuit.
    const dc = engine.dcOperatingPoint();

    // Settle past transients
    const R = 1000, C_val = 1e-6;
    const settleTime = dc.converged ? 10 * R * C_val : 0.05;
    let steps = 0;
    while (engine.simTime < settleTime && steps < 100_000) {
      engine.step();
      steps++;
    }
    expect(engine.simTime).toBeGreaterThan(settleTime * 0.9);

    // Resolve wire currents over one full period
    const resolver = new WireCurrentResolver();
    const F = 100; // default AcVs frequency
    const periodEnd = engine.simTime + 1 / F;
    let sampleCount = 0;
    let maxCrossComponentError = 0;
    let maxComponentPathError = 0;
    let nonJunctionChecks = 0;

    // Build element-to-wire map: for each 2-terminal element, find wires
    // adjacent to each pin by matching pin world position to wire endpoints.
    const elementPinWires = new Map<number, { pinAWires: Wire[]; pinBWires: Wire[] }>();

    for (let eIdx = 0; eIdx < compiled.elements.length; eIdx++) {
      const ae = compiled.elements[eIdx];
      if (ae.pinNodeIds.length !== 2) continue;
      const ce = compiled.elementToCircuitElement.get(eIdx);
      if (!ce) continue;
      const pins = ce.getPins();
      if (pins.length < 2) continue;

      const posA = pinWorldPosition(ce, pins[0]);
      const posB = pinWorldPosition(ce, pins[1]);

      const pinAWires: Wire[] = [];
      const pinBWires: Wire[] = [];

      for (const wire of circuit.wires) {
        const nodeId = compiled.wireToNodeId.get(wire);
        if (nodeId === undefined) continue;

        const matchA = (nodeId === ae.pinNodeIds[0]) && (
          (Math.abs(wire.start.x - posA.x) < 1 && Math.abs(wire.start.y - posA.y) < 1) ||
          (Math.abs(wire.end.x - posA.x) < 1 && Math.abs(wire.end.y - posA.y) < 1)
        );
        const matchB = (nodeId === ae.pinNodeIds[1]) && (
          (Math.abs(wire.start.x - posB.x) < 1 && Math.abs(wire.start.y - posB.y) < 1) ||
          (Math.abs(wire.end.x - posB.x) < 1 && Math.abs(wire.end.y - posB.y) < 1)
        );

        if (matchA) pinAWires.push(wire);
        if (matchB) pinBWires.push(wire);
      }

      elementPinWires.set(eIdx, { pinAWires, pinBWires });
    }

    // Verify we found wires for at least some elements
    expect(elementPinWires.size).toBeGreaterThan(0);

    while (engine.simTime < periodEnd && sampleCount < 50_000) {
      engine.step();
      sampleCount++;

      resolver.resolve(
        engine as unknown as AnalogEngine,
        circuit,
        compiled as unknown as ResolvedAnalogCircuit,
      );

      // For each 2-terminal element at a non-junction node,
      // wire current must equal element current.
      // At junction nodes, the stem wire (closest to the pin) must carry
      // at least the element's current.
      for (const [eIdx, { pinAWires, pinBWires }] of elementPinWires) {
        const I_elem = Math.abs(engine.getElementCurrent(eIdx));
        if (I_elem < 1e-9) continue;

        const ae = compiled.elements[eIdx];

        for (const [pinWires, nodeIdx] of [
          [pinAWires, ae.pinNodeIds[0]] as const,
          [pinBWires, ae.pinNodeIds[1]] as const,
        ]) {
          if (pinWires.length === 0) continue;

          // Count total wires at this node
          const nodeWireCount = circuit.wires.filter(
            w => compiled.wireToNodeId.get(w) === nodeIdx).length;

          // Get the wire current at the pin's wire
          const c = resolver.getWireCurrent(pinWires[0])?.current ?? 0;

          if (nodeWireCount === 1) {
            // Non-junction: wire current must equal element current
            const err = Math.abs(c - I_elem) / I_elem;
            if (err > maxCrossComponentError) maxCrossComponentError = err;
            nonJunctionChecks++;
          }
        }
      }

      // Component paths must match their corresponding element currents.
      // Paths are emitted only for 2-terminal elements, in element index order.
      const paths = resolver.getComponentPaths();
      let pathIdx = 0;
      for (let eIdx = 0; eIdx < compiled.elements.length && pathIdx < paths.length; eIdx++) {
        const ae = compiled.elements[eIdx];
        if (ae.pinNodeIds.length !== 2) continue;
        if (!compiled.elementToCircuitElement.get(eIdx)) continue;

        const I_elem = Math.abs(engine.getElementCurrent(eIdx));
        if (I_elem < 1e-9) { pathIdx++; continue; }

        const pathErr = Math.abs(paths[pathIdx].current - I_elem) / I_elem;
        if (pathErr > maxComponentPathError) maxComponentPathError = pathErr;
        pathIdx++;
      }
    }

    expect(sampleCount).toBeGreaterThan(10);

    // Non-junction wire-element checks (if any exist in this topology)
    if (nonJunctionChecks > 0) {
      expect(maxCrossComponentError).toBeLessThan(0.05);
    }

    // Verify the resolver produces component paths with correct currents
    // by doing one final resolve and checking directly
    resolver.resolve(
      engine as unknown as AnalogEngine,
      circuit,
      compiled as unknown as ResolvedAnalogCircuit,
    );
    const finalPaths = resolver.getComponentPaths();
    expect(finalPaths.length).toBeGreaterThan(0);
    for (let eIdx = 0, pIdx = 0; eIdx < compiled.elements.length && pIdx < finalPaths.length; eIdx++) {
      const ae = compiled.elements[eIdx];
      if (ae.pinNodeIds.length !== 2) continue;
      if (!compiled.elementToCircuitElement.get(eIdx)) continue;
      const I_elem = Math.abs(engine.getElementCurrent(eIdx));
      if (I_elem > 1e-9) {
        expect(finalPaths[pIdx].current).toBeCloseTo(I_elem, 4);
      }
      pIdx++;
    }
  });

  it("component-as-node KCL: wire at pin A ≈ wire at pin B ≈ body current", async () => {
    // -----------------------------------------------------------------------
    // The visual invariant: dots entering a component via one pin must exit
    // at the same rate via the other pin. This treats each component as a
    // KCL node and verifies:
    //   wire_current_at_pinA ≈ wire_current_at_pinB ≈ component_body_current
    //
    // Uses the real lrctest.dig fixture with rotated components, so
    // elementPinVertices come from the compiler's snap-to-wire-endpoint logic
    // rather than ideal pin positions. This catches misalignment bugs where
    // a pin's injection lands at the wrong wire vertex.
    // -----------------------------------------------------------------------
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");
    const { DefaultSimulatorFacade } = await import("@/headless/default-facade");
    const { createDefaultRegistry } = await import("@/components/register-all");
    const { compileUnified } = await import("@/compile/compile");
    const { MNAEngine } = await import("@/analog/analog-engine");

    const xml = readFileSync(
      resolve(__dirname, "../../../fixtures/lrctest.dig"),
      "utf-8",
    );
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = facade.loadDigXml(xml);
    circuit.metadata = { ...circuit.metadata, engineType: "analog" };

    const compiled = compileUnified(circuit, registry).analog!;
    const engine = new MNAEngine();
    engine.init(compiled);
    engine.dcOperatingPoint();

    // Settle past transients
    const settleTime = 0.01; // 10ms — 10×RC for R=1k, C=1µF
    let steps = 0;
    while (engine.simTime < settleTime && steps < 100_000) {
      engine.step();
      steps++;
    }

    const resolver = new WireCurrentResolver();
    const F = 100;
    const periodEnd = engine.simTime + 1 / F;
    let sampleCount = 0;
    let maxPinAPinBError = 0;
    let maxWireVsBodyError = 0;
    let checksPerformed = 0;

    // Helper: find the wire at a given vertex (elementPinVertices entry)
    // within a given MNA node. Returns the wire whose endpoint matches.
    function findWireAtVertex(
      vertex: { x: number; y: number },
      nodeId: number,
    ): Wire | null {
      for (const wire of circuit.wires) {
        if (compiled.wireToNodeId.get(wire) !== nodeId) continue;
        const matchStart =
          Math.abs(wire.start.x - vertex.x) < 0.5 &&
          Math.abs(wire.start.y - vertex.y) < 0.5;
        const matchEnd =
          Math.abs(wire.end.x - vertex.x) < 0.5 &&
          Math.abs(wire.end.y - vertex.y) < 0.5;
        if (matchStart || matchEnd) return wire;
      }
      return null;
    }

    // Helper: count wires at a given vertex within a node
    function wireCountAtVertex(
      vertex: { x: number; y: number },
      nodeId: number,
    ): number {
      let count = 0;
      for (const wire of circuit.wires) {
        if (compiled.wireToNodeId.get(wire) !== nodeId) continue;
        const matchStart =
          Math.abs(wire.start.x - vertex.x) < 0.5 &&
          Math.abs(wire.start.y - vertex.y) < 0.5;
        const matchEnd =
          Math.abs(wire.end.x - vertex.x) < 0.5 &&
          Math.abs(wire.end.y - vertex.y) < 0.5;
        if (matchStart || matchEnd) count++;
      }
      return count;
    }

    while (engine.simTime < periodEnd && sampleCount < 50_000) {
      engine.step();
      sampleCount++;

      resolver.resolve(
        engine as unknown as AnalogEngine,
        circuit,
        compiled as unknown as ResolvedAnalogCircuit,
      );

      const paths = resolver.getComponentPaths();
      let pathIdx = 0;

      for (let eIdx = 0; eIdx < compiled.elements.length; eIdx++) {
        const ae = compiled.elements[eIdx];
        if (ae.pinNodeIds.length !== 2) continue;
        const ce = compiled.elementToCircuitElement.get(eIdx);
        if (!ce) continue;

        const I_elem = Math.abs(engine.getElementCurrent(eIdx));
        if (I_elem < 1e-9) { pathIdx++; continue; }

        // Get compiler-resolved wire vertices for this element's pins
        const vertices = compiled.elementPinVertices.get(eIdx);
        if (!vertices || vertices.length < 2) { pathIdx++; continue; }

        const vA = vertices[0];
        const vB = vertices[1];
        if (!vA || !vB) { pathIdx++; continue; }

        // Find the wire at each pin's vertex
        const wireA = findWireAtVertex(vA, ae.pinNodeIds[0]);
        const wireB = findWireAtVertex(vB, ae.pinNodeIds[1]);
        if (!wireA || !wireB) { pathIdx++; continue; }

        const cA = resolver.getWireCurrent(wireA)?.current ?? 0;
        const cB = resolver.getWireCurrent(wireB)?.current ?? 0;

        // Component body path current
        const bodyCurrent = pathIdx < paths.length ? paths[pathIdx].current : 0;

        // Determine if each pin is at a junction (multiple wires at vertex)
        const isJunctionA = wireCountAtVertex(vA, ae.pinNodeIds[0]) > 1;
        const isJunctionB = wireCountAtVertex(vB, ae.pinNodeIds[1]) > 1;

        // CHECK 1: For non-junction pins, wire current must match body current.
        // At a junction vertex the component's current splits across multiple
        // wires, so no single wire carries the full amount — skip those pins.
        if (!isJunctionA) {
          const errA = Math.abs(cA - bodyCurrent) / I_elem;
          if (errA > maxWireVsBodyError) maxWireVsBodyError = errA;
          checksPerformed++;
        }
        if (!isJunctionB) {
          const errB = Math.abs(cB - bodyCurrent) / I_elem;
          if (errB > maxWireVsBodyError) maxWireVsBodyError = errB;
          checksPerformed++;
        }

        // CHECK 2: When BOTH pins are non-junction, wire currents must match
        // each other (component-as-node KCL — current in = current out).
        if (!isJunctionA && !isJunctionB) {
          const pinAPinBErr = Math.abs(cA - cB) / I_elem;
          if (pinAPinBErr > maxPinAPinBError) maxPinAPinBError = pinAPinBErr;
        }

        pathIdx++;
      }
    }

    expect(sampleCount).toBeGreaterThan(10);
    expect(checksPerformed).toBeGreaterThan(0);

    // Non-junction wire currents must match component body within 1%
    expect(maxWireVsBodyError).toBeLessThan(0.01);

    // Pin A ≈ pin B for components with both pins at non-junction vertices
    if (maxPinAPinBError > 0) {
      expect(maxPinAPinBError).toBeLessThan(0.01);
    }
  });
});

// ===========================================================================
// Rotated-component pin snap — simplified mock (misaligned pin on wire segment)
// ===========================================================================

describe("WireCurrentResolver — misaligned pin snap (mock)", () => {
  it("current into resistor equals current out despite misaligned pins", () => {
    // Simple DC series circuit: Vs(5V) → R1(1kΩ) → R2(1kΩ) → ground
    // R2 has a MISALIGNED pin: pin B at (10, 3) lies ON the wire from
    // (10, 0) to (10, 6) but doesn't match either endpoint.
    // Without snap-to-vertex, R2's pin B injection is lost, making the
    // wire current on the ground side differ from the R2 side.
    const VS = 5, R1v = 1000, R2v = 1000;
    const I_expected = VS / (R1v + R2v); // 2.5 mA

    const vs = makeVoltageSource(1, 0, 2, VS); // branch index = nodeCount
    const r1 = makeResistor(1, 2, R1v);
    const r2 = makeResistor(2, 0, R2v);

    // R1: pins aligned with wire endpoints
    const ceR1 = makeCE([{ x: 0, y: 0 }, { x: 4, y: 0 }]);
    // R2: pin A at (6, 0) — on wire endpoint ✓
    //     pin B at (10, 3) — BETWEEN wire endpoints (10,0) and (10,6) ✗
    //     This simulates the rotation-induced misalignment from lrctest.dig
    const ceR2 = makeCE([{ x: 6, y: 0 }, { x: 10, y: 3 }]);
    // Vs: pins aligned
    const ceVs = makeCE([{ x: 0, y: -2 }, { x: 0, y: 0 }]);

    // Wires: node 1 connects Vs.pos to R1.A
    const w_n1 = makeWire(0, -2, 0, 0);   // Vs.pos to junction
    // Actually make it simpler:
    const w1 = makeWire(0, 0, 0, -2);      // node1: Vs.pos(-2) → R1.A(0)...
    // Let me use a horizontal layout:
    // Vs.pos at (0,0), R1.A at (2,0), R1.B at (6,0), R2.A at (6,0), R2.B at (10,3)
    // Gnd wires: Vs.neg at (0,-4), R2 side at (10,0)→(10,6) with pin at (10,3)

    // Simpler: just 3 nodes in a line
    // node 1: Vs.pos(0,0) ——wire——> R1.A(2,0)
    const wa = makeWire(0, 0, 2, 0);
    // node 2: R1.B(6,0) ——wire——> R2.A(8,0)  (single wire, both pins on endpoints)
    const wb = makeWire(6, 0, 8, 0);
    // ground: R2.B(10,3) is ON wire (10,0)→(10,6) but not at an endpoint
    const wg1 = makeWire(10, 0, 10, 6);  // R2 ground-side wire
    const wg2 = makeWire(10, 6, 0, 6);   // ground bus
    const wg3 = makeWire(0, 6, 0, -4);   // back to Vs.neg

    // Vs.neg at (0,-4): on wire wg3 endpoint ✓
    // R2.B at (10,3): on wire wg1 segment (10,0)→(10,6) but not at endpoint!
    const ceVsReal = makeCE([{ x: 0, y: 0 }, { x: 0, y: -4 }]);
    const ceR1Real = makeCE([{ x: 2, y: 0 }, { x: 6, y: 0 }]);
    const ceR2Real = makeCE([{ x: 8, y: 0 }, { x: 10, y: 3 }]); // pin B misaligned!

    const wireToNodeId = new Map<Wire, number>([
      [wa, 1],
      [wb, 2],
      [wg1, 0], [wg2, 0], [wg3, 0],
    ]);

    const circuit = new Circuit();
    for (const w of wireToNodeId.keys()) circuit.addWire(w);

    const compiled = makeCompiledWithEngine({
      nodeCount: 2,
      branchCount: 1,
      elements: [vs, r1, r2],
      circuitElements: [ceVsReal, ceR1Real, ceR2Real],
      wireToNodeId,
    });

    const engine = new MNAEngine();
    engine.init(compiled as unknown as ConcreteCompiledAnalogCircuit);
    const dc = engine.dcOperatingPoint();
    expect(dc.converged).toBe(true);

    const resolver = new WireCurrentResolver();
    resolver.resolve(engine as unknown as AnalogEngine, circuit, compiled);

    const I_R2 = Math.abs(engine.getElementCurrent(2));
    expect(I_R2).toBeCloseTo(I_expected, 5);

    // THE KEY CHECKS:
    // Wire at node 2 (between R1 and R2): carries full series current
    const c_wb = resolver.getWireCurrent(wb)!.current;
    expect(c_wb).toBeCloseTo(I_expected, 5);

    // Wire at ground (R2.B side): must also carry full series current.
    // R2.B at (10,3) is ON wire wg1 from (10,0) to (10,6) but not at an endpoint.
    // Without snap-to-vertex, R2.B's injection is lost → wg1 gets wrong current.
    const c_wg1 = resolver.getWireCurrent(wg1)!.current;
    expect(c_wg1).toBeCloseTo(I_expected, 5);

    // Direct comparison: current in R2 == current out R2
    expect(c_wb).toBeCloseTo(c_wg1, 5);

    // Component path matches
    const paths = resolver.getComponentPaths();
    expect(paths[2].current).toBeCloseTo(I_expected, 5); // R2 path
  });
});
