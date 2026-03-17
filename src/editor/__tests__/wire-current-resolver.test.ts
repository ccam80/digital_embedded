/**
 * Tests for WireCurrentResolver — KCL wire-current resolver.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { WireCurrentResolver } from "../wire-current-resolver";
import { Wire, Circuit } from "@/core/circuit";
import type { AnalogEngine } from "@/core/analog-engine-interface";
import type { CompiledAnalogCircuit } from "@/core/analog-engine-interface";
import type { AnalogElement } from "@/analog/element";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a Wire with given coordinates. */
function makeWire(x1: number, y1: number, x2: number, y2: number): Wire {
  return new Wire({ x: x1, y: y1 }, { x: x2, y: y2 });
}

/** Minimal AnalogElement stub. */
function makeElement(nodeIndices: number[], branchIndex = -1): AnalogElement {
  return {
    nodeIndices,
    branchIndex,
    stampLinear() {},
    isReactive: false,
  } as unknown as AnalogElement;
}

/** Build a mock AnalogEngine that returns specified currents per element. */
function makeEngine(elementCurrents: number[]): AnalogEngine {
  return {
    getElementCurrent: (id: number) => elementCurrents[id] ?? 0,
    getNodeVoltage: () => 0,
    getBranchCurrent: () => 0,
    getElementPower: () => 0,
    simTime: 0,
    lastDt: 0,
    dcOperatingPoint: () => ({ converged: true, method: "direct", iterations: 0, nodeVoltages: new Float64Array(0), diagnostics: [] }),
    configure: () => {},
    onDiagnostic: () => {},
    addBreakpoint: () => {},
    clearBreakpoints: () => {},
    init: () => {},
    reset: () => {},
    dispose: () => {},
    start: () => {},
    stop: () => {},
    getState: () => { throw new Error("not used"); },
    addChangeListener: () => {},
    removeChangeListener: () => {},
    step: () => {},
  } as unknown as AnalogEngine;
}

/** Build a minimal CompiledAnalogCircuit stub. */
function makeCompiled(
  wireToNodeId: Map<Wire, number>,
  elements: AnalogElement[],
): CompiledAnalogCircuit {
  return {
    wireToNodeId,
    elements,
    nodeCount: 4,
    elementCount: elements.length,
    labelToNodeId: new Map(),
    netCount: 4,
    componentCount: elements.length,
  } as unknown as CompiledAnalogCircuit;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("KCLResolver", () => {
  let resolver: WireCurrentResolver;

  beforeEach(() => {
    resolver = new WireCurrentResolver();
  });

  it("series_circuit_uniform_current", () => {
    // 3 components in series: source (nodes 0→1) → R1 (1→2) → R2 (2→3) → ground (3→0)
    // Wire segments: w1 (node 1), w2 (node 2), w3 (node 3)
    const w1 = makeWire(0, 0, 1, 0); // node 1
    const w2 = makeWire(1, 0, 2, 0); // node 2
    const w3 = makeWire(2, 0, 3, 0); // node 3

    const circuit = new Circuit();
    circuit.addWire(w1);
    circuit.addWire(w2);
    circuit.addWire(w3);

    const wireToNodeId = new Map<Wire, number>([
      [w1, 1],
      [w2, 2],
      [w3, 3],
    ]);

    // source: node 0→1, R1: node 1→2, R2: node 2→3
    const elements = [
      makeElement([0, 1]),  // source
      makeElement([1, 2]),  // R1
      makeElement([2, 3]),  // R2
    ];

    const compiled = makeCompiled(wireToNodeId, elements);
    // All elements carry 5mA
    const engine = makeEngine([0.005, 0.005, 0.005]);

    resolver.resolve(engine, circuit, compiled);

    const c1 = resolver.getWireCurrent(w1);
    const c2 = resolver.getWireCurrent(w2);
    const c3 = resolver.getWireCurrent(w3);

    expect(c1).toBeDefined();
    expect(c2).toBeDefined();
    expect(c3).toBeDefined();

    expect(c1!.current).toBeCloseTo(0.005, 6);
    expect(c2!.current).toBeCloseTo(0.005, 6);
    expect(c3!.current).toBeCloseTo(0.005, 6);
  });

  it("parallel_branch_split", () => {
    // Source → junction (node 1) → R1 (node 2, 3mA) and R2 (node 3, 7mA) → ground
    // Wires:
    //   wSrc: source wire at node 1 (carries 10mA from source to junction)
    //   wR1:  wire at node 2 (carries 3mA through R1)
    //   wR2:  wire at node 3 (carries 7mA through R2)
    const wSrc = makeWire(0, 0, 1, 0);  // node 1
    const wR1  = makeWire(1, 0, 2, 0);  // node 2
    const wR2  = makeWire(1, 0, 3, 0);  // node 3

    const circuit = new Circuit();
    circuit.addWire(wSrc);
    circuit.addWire(wR1);
    circuit.addWire(wR2);

    const wireToNodeId = new Map<Wire, number>([
      [wSrc, 1],
      [wR1,  2],
      [wR2,  3],
    ]);

    // source (0→1, 10mA), R1 (1→2, 3mA), R2 (1→3, 7mA)
    const elements = [
      makeElement([0, 1]),  // source: 10mA
      makeElement([1, 2]),  // R1: 3mA
      makeElement([1, 3]),  // R2: 7mA
    ];

    const compiled = makeCompiled(wireToNodeId, elements);
    const engine = makeEngine([0.010, 0.003, 0.007]);

    resolver.resolve(engine, circuit, compiled);

    const cSrc = resolver.getWireCurrent(wSrc);
    const cR1  = resolver.getWireCurrent(wR1);
    const cR2  = resolver.getWireCurrent(wR2);

    expect(cSrc).toBeDefined();
    expect(cR1).toBeDefined();
    expect(cR2).toBeDefined();

    // Wire from source to junction carries the total 10mA
    expect(cSrc!.current).toBeCloseTo(0.010, 5);
    // Branch wires carry their respective component currents
    expect(cR1!.current).toBeCloseTo(0.003, 5);
    expect(cR2!.current).toBeCloseTo(0.007, 5);
  });

  it("disconnected_wire_zero_current", () => {
    // A wire not in wireToNodeId — disconnected segment
    const wDisconnected = makeWire(5, 5, 6, 5);
    const wConnected    = makeWire(0, 0, 1, 0);

    const circuit = new Circuit();
    circuit.addWire(wDisconnected);
    circuit.addWire(wConnected);

    const wireToNodeId = new Map<Wire, number>([
      [wConnected, 1],
      // wDisconnected intentionally omitted
    ]);

    const elements = [makeElement([0, 1])];
    const compiled = makeCompiled(wireToNodeId, elements);
    const engine   = makeEngine([0.005]);

    resolver.resolve(engine, circuit, compiled);

    const cDisc = resolver.getWireCurrent(wDisconnected);
    expect(cDisc).toBeDefined();
    expect(cDisc!.current).toBe(0);
  });

  it("direction_follows_conventional_current", () => {
    // Source at nodes 0→1, positive terminal at node 1.
    // Conventional current flows from high potential to low: node1 → node0 (ground).
    // Wire at node 1 should have a direction vector.
    const wire = makeWire(0, 0, 4, 0); // horizontal, left to right

    const circuit = new Circuit();
    circuit.addWire(wire);

    const wireToNodeId = new Map<Wire, number>([[wire, 1]]);
    // Source from ground(0) to node1: current exits at node 1
    const elements = [makeElement([0, 1])];
    const compiled = makeCompiled(wireToNodeId, elements);
    const engine   = makeEngine([0.01]); // 10mA

    resolver.resolve(engine, circuit, compiled);

    const result = resolver.getWireCurrent(wire);
    expect(result).toBeDefined();
    expect(result!.current).toBeGreaterThan(0);

    // Direction must be a unit vector (length ≈ 1)
    const [dx, dy] = result!.direction;
    const len = Math.sqrt(dx * dx + dy * dy);
    expect(len).toBeCloseTo(1, 5);
  });

  it("clear_resets_results", () => {
    const wire = makeWire(0, 0, 1, 0);
    const circuit = new Circuit();
    circuit.addWire(wire);

    const wireToNodeId = new Map<Wire, number>([[wire, 1]]);
    const elements = [makeElement([0, 1])];
    const compiled = makeCompiled(wireToNodeId, elements);
    const engine   = makeEngine([0.005]);

    resolver.resolve(engine, circuit, compiled);
    expect(resolver.getWireCurrent(wire)).toBeDefined();

    resolver.clear();
    expect(resolver.getWireCurrent(wire)).toBeUndefined();
  });
});
