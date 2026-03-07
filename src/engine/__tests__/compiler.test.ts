/**
 * Tests for circuit compiler (task 3.2.1) and Tarjan/topological-sort
 * utilities (task 3.2.1 sub-components).
 *
 * Tests build minimal Circuit + ComponentRegistry instances in-process so
 * they do not depend on Phase 4 (.dig parser) or Phase 5 (full components).
 */

import { describe, it, expect } from "vitest";
import { compileCircuit } from "../compiler.js";
import { findSCCs } from "../tarjan.js";
import { topologicalSort } from "../topological-sort.js";
import { Circuit, Wire } from "@/core/circuit";
import { ComponentRegistry } from "@/core/registry";
import type { ComponentDefinition, ExecuteFunction } from "@/core/registry";
import { ComponentCategory } from "@/core/registry";
import { AbstractCircuitElement } from "@/core/element";
import type { Pin, PinDeclaration } from "@/core/pin";
import { PinDirection, resolvePins, createInverterConfig, createClockConfig } from "@/core/pin";
import type { RenderContext, Rect } from "@/core/renderer-interface";
import { PropertyBag } from "@/core/properties";
import type { PropertyBag as PropertyBagType } from "@/core/properties";
import { BitsException } from "@/core/errors";

// ---------------------------------------------------------------------------
// Minimal test CircuitElement implementation
// ---------------------------------------------------------------------------

class TestElement extends AbstractCircuitElement {
  private readonly _pins: readonly Pin[];

  constructor(
    typeId: string,
    instanceId: string,
    position: { x: number; y: number },
    pinDecls: PinDeclaration[],
    props?: PropertyBag,
  ) {
    super(typeId, instanceId, position, 0, false, props ?? new PropertyBag());
    this._pins = resolvePins(
      pinDecls,
      position,
      0,
      createInverterConfig([]),
      createClockConfig([]),
    );
  }

  getPins(): readonly Pin[] {
    return this._pins;
  }

  draw(_ctx: RenderContext): void {}

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y, width: 2, height: 2 };
  }

  getHelpText(): string {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Helpers: pin declarations for common gate shapes
// ---------------------------------------------------------------------------

/** Single-input, single-output component (e.g. NOT gate). */
function notPins(): PinDeclaration[] {
  return [
    { direction: PinDirection.INPUT, label: "in", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false },
    { direction: PinDirection.OUTPUT, label: "out", defaultBitWidth: 1, position: { x: 2, y: 0 }, isNegatable: false, isClockCapable: false },
  ];
}

/** Two-input, single-output component (e.g. AND, NOR gate). */
function twoInputPins(): PinDeclaration[] {
  return [
    { direction: PinDirection.INPUT, label: "a", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false },
    { direction: PinDirection.INPUT, label: "b", defaultBitWidth: 1, position: { x: 0, y: 1 }, isNegatable: false, isClockCapable: false },
    { direction: PinDirection.OUTPUT, label: "out", defaultBitWidth: 1, position: { x: 2, y: 0 }, isNegatable: false, isClockCapable: false },
  ];
}

/** Input pin only (e.g. In component). */
function inputOnlyPin(label: string, position: { x: number; y: number }): PinDeclaration[] {
  return [
    { direction: PinDirection.OUTPUT, label, defaultBitWidth: 1, position, isNegatable: false, isClockCapable: false },
  ];
}

/** Output pin only (e.g. Out component). */
function outputOnlyPin(label: string, position: { x: number; y: number }): PinDeclaration[] {
  return [
    { direction: PinDirection.INPUT, label, defaultBitWidth: 1, position, isNegatable: false, isClockCapable: false },
  ];
}

// ---------------------------------------------------------------------------
// Helpers: build minimal ComponentDefinition
// ---------------------------------------------------------------------------

const noopExecute: ExecuteFunction = (_index, _state, _layout) => {};

function makeDefinition(
  name: string,
  pins: PinDeclaration[],
  executeFn: ExecuteFunction = noopExecute,
  defaultDelay?: number,
): Omit<ComponentDefinition, "typeId"> & { typeId: number } {
  return {
    name,
    typeId: -1,
    factory: (props: PropertyBagType) =>
      new TestElement(name, crypto.randomUUID(), { x: 0, y: 0 }, pins, props),
    executeFn,
    pinLayout: pins,
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.LOGIC,
    helpText: "",
    ...(defaultDelay !== undefined ? { defaultDelay } : {}),
  };
}

// ---------------------------------------------------------------------------
// Registry builder
// ---------------------------------------------------------------------------

function makeRegistry(...defs: (Omit<ComponentDefinition, "typeId"> & { typeId: number })[]): ComponentRegistry {
  const registry = new ComponentRegistry();
  for (const def of defs) {
    registry.register(def as ComponentDefinition);
  }
  return registry;
}

// ---------------------------------------------------------------------------
// Compiler tests
// ---------------------------------------------------------------------------

describe("Compiler", () => {
  // -------------------------------------------------------------------------
  // compilesSimpleCombinational
  // -------------------------------------------------------------------------
  it("compilesSimpleCombinational", () => {
    // AND gate: 2 input pins at (0,0) and (0,1); 1 output pin at (2,0).
    // Wire from output pin (2,0) connects to nothing — standalone gate.
    // Expected: 3 nets (one per pin), 1 component, 1 non-feedback group.

    const andDef = makeDefinition("And", twoInputPins());
    const registry = makeRegistry(andDef);

    const circuit = new Circuit();
    const andEl = new TestElement("And", "and-1", { x: 0, y: 0 }, twoInputPins());
    circuit.addElement(andEl);

    const compiled = compileCircuit(circuit, registry);

    // Each unconnected pin forms its own net
    expect(compiled.netCount).toBe(3);
    expect(compiled.componentCount).toBe(1);
    expect(compiled.evaluationOrder.length).toBe(1);
    expect(compiled.evaluationOrder[0]!.isFeedback).toBe(false);
    expect(compiled.evaluationOrder[0]!.componentIndices.length).toBe(1);

    // Verify layout provides valid offsets for component 0
    const layout = compiled.layout;
    expect(layout.inputCount(0)).toBe(2);
    expect(layout.outputCount(0)).toBe(1);
  });

  // -------------------------------------------------------------------------
  // compilesChainedGates
  // -------------------------------------------------------------------------
  it("compilesChainedGates", () => {
    // Chain: NOT(A) → AND(_, B) → nothing
    // NOT output at (2,0) connects to AND input at (10,0) via a wire.
    // Each gate is positioned so their pins don't accidentally overlap.

    const notDef = makeDefinition("Not", notPins());
    const andDef = makeDefinition("And", twoInputPins());
    const registry = makeRegistry(notDef, andDef);

    const circuit = new Circuit();

    // NOT gate at (0,0): input at (0,0), output at (2,0)
    const notEl = new TestElement("Not", "not-1", { x: 0, y: 0 }, notPins());

    // AND gate at (8,0): inputs at (8,0) and (8,1), output at (10,0)
    const andEl = new TestElement("And", "and-1", { x: 8, y: 0 }, twoInputPins());

    circuit.addElement(notEl);
    circuit.addElement(andEl);

    // Wire from NOT output (2,0) to AND input-a (8,0)
    circuit.addWire(new Wire({ x: 2, y: 0 }, { x: 8, y: 0 }));

    const compiled = compileCircuit(circuit, registry);

    expect(compiled.componentCount).toBe(2);
    // NOT output and AND first input share a net via wire
    // Unconnected: NOT input (0,0), AND second input (8,1), AND output (10,0)
    // So: 4 nets total
    expect(compiled.netCount).toBe(4);

    // Evaluation order must respect dependency: NOT before AND
    // Find which group/position each component appears in
    const orderByComponent = new Map<number, number>();
    for (let g = 0; g < compiled.evaluationOrder.length; g++) {
      for (const idx of compiled.evaluationOrder[g]!.componentIndices) {
        orderByComponent.set(idx, g);
      }
    }

    // NOT (index 0) must appear in a group that comes before AND (index 1)
    const notOrder = orderByComponent.get(0)!;
    const andOrder = orderByComponent.get(1)!;
    expect(notOrder).toBeLessThanOrEqual(andOrder);

    // No feedback in a chain
    for (const group of compiled.evaluationOrder) {
      expect(group.isFeedback).toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // detectsFeedbackSCC
  // -------------------------------------------------------------------------
  it("detectsFeedbackSCC", () => {
    // SR latch: two NOR gates cross-connected.
    // NOR1 at (0,0): inputs at (0,0), (0,1); output at (2,0)
    // NOR2 at (8,0): inputs at (8,0), (8,1); output at (10,0)
    // Wire: NOR1 output (2,0) → NOR2 input (8,0)
    // Wire: NOR2 output (10,0) → NOR1 input (0,1)

    const norDef = makeDefinition("Nor", twoInputPins());
    const registry = makeRegistry(norDef);

    const circuit = new Circuit();

    const nor1 = new TestElement("Nor", "nor-1", { x: 0, y: 0 }, twoInputPins());
    const nor2 = new TestElement("Nor", "nor-2", { x: 8, y: 0 }, twoInputPins());
    circuit.addElement(nor1);
    circuit.addElement(nor2);

    // NOR1 output (2,0) → NOR2 input-a (8,0)
    circuit.addWire(new Wire({ x: 2, y: 0 }, { x: 8, y: 0 }));
    // NOR2 output (10,0) → NOR1 input-b (0,1)
    circuit.addWire(new Wire({ x: 10, y: 0 }, { x: 0, y: 1 }));

    const compiled = compileCircuit(circuit, registry);

    expect(compiled.componentCount).toBe(2);

    // Should have exactly one feedback group containing both components
    const feedbackGroups = compiled.evaluationOrder.filter((g) => g.isFeedback);
    expect(feedbackGroups.length).toBe(1);
    expect(feedbackGroups[0]!.componentIndices.length).toBe(2);

    // Both component 0 and 1 should be in the feedback group
    const indices = Array.from(feedbackGroups[0]!.componentIndices);
    expect(indices).toContain(0);
    expect(indices).toContain(1);
  });

  // -------------------------------------------------------------------------
  // assignsNetIdsConsistently
  // -------------------------------------------------------------------------
  it("assignsNetIdsConsistently", () => {
    // Two components connected by a wire. The connected pins must share the
    // same net ID.
    // NOT gate at (0,0): input at (0,0), output at (2,0)
    // AND gate at (8,0): input-a at (8,0), input-b at (8,1), output at (10,0)
    // Wire: (2,0) → (8,0)

    const notDef = makeDefinition("Not", notPins());
    const andDef = makeDefinition("And", twoInputPins());
    const registry = makeRegistry(notDef, andDef);

    const circuit = new Circuit();
    const notEl = new TestElement("Not", "not-1", { x: 0, y: 0 }, notPins());
    const andEl = new TestElement("And", "and-1", { x: 8, y: 0 }, twoInputPins());
    circuit.addElement(notEl);
    circuit.addElement(andEl);
    circuit.addWire(new Wire({ x: 2, y: 0 }, { x: 8, y: 0 }));

    const compiled = compileCircuit(circuit, registry);

    // The NOT output (pin index 1, position 2,0) and AND input-a (pin index 0,
    // position 8,0) should be on the same net.
    // We verify this by checking outputOffset(NOT) === inputOffset(AND)
    // since both should map to the same net ID.
    const notOutputNetId = compiled.layout.outputOffset(0);
    const andFirstInputNetId = compiled.layout.inputOffset(1);
    expect(notOutputNetId).toBe(andFirstInputNetId);
  });

  // -------------------------------------------------------------------------
  // buildsFunctionTable
  // -------------------------------------------------------------------------
  it("buildsFunctionTable", () => {
    // Register 2 component types. Compile a circuit with both. Verify executeFns
    // has entries at both assigned type IDs.

    let notCalled = false;
    let andCalled = false;

    const notExecute: ExecuteFunction = (_i, _s, _l) => { notCalled = true; };
    const andExecute: ExecuteFunction = (_i, _s, _l) => { andCalled = true; };

    const notDef = makeDefinition("Not", notPins(), notExecute);
    const andDef = makeDefinition("And", twoInputPins(), andExecute);
    const registry = makeRegistry(notDef, andDef);

    // Get type IDs (auto-assigned: Not=0, And=1)
    const notTypeId = registry.get("Not")!.typeId;
    const andTypeId = registry.get("And")!.typeId;

    const circuit = new Circuit();
    circuit.addElement(new TestElement("Not", "not-1", { x: 0, y: 0 }, notPins()));
    circuit.addElement(new TestElement("And", "and-1", { x: 8, y: 0 }, twoInputPins()));

    const compiled = compileCircuit(circuit, registry);

    // executeFns must be populated at both type IDs
    expect(compiled.executeFns[notTypeId]).toBeDefined();
    expect(compiled.executeFns[andTypeId]).toBeDefined();

    // Call them to verify they're the right functions
    const state = new Uint32Array(10);
    const highZs = new Uint32Array(state.length);
    const layout = compiled.layout;
    compiled.executeFns[notTypeId]!(0, state, highZs, layout);
    compiled.executeFns[andTypeId]!(1, state, highZs, layout);
    expect(notCalled).toBe(true);
    expect(andCalled).toBe(true);
  });

  // -------------------------------------------------------------------------
  // labelToNetIdMapsInputsOutputs
  // -------------------------------------------------------------------------
  it("labelToNetIdMapsInputsOutputs", () => {
    // Circuit with In(label="A") and Out(label="S").
    // In at (0,0): output pin at (0,0) — drives value into the circuit
    // Out at (10,0): input pin at (10,0) — reads value from circuit
    // Wire: (0,0) → (10,0) connects them

    const inPins = inputOnlyPin("A", { x: 0, y: 0 });
    const outPins = outputOnlyPin("S", { x: 0, y: 0 });

    const inDef = makeDefinition("In", inPins);
    const outDef = makeDefinition("Out", outPins);
    const registry = makeRegistry(inDef, outDef);

    const circuit = new Circuit();

    // In element with label "A"
    const inProps = new PropertyBag([["label", "A"]]);
    const inEl = new TestElement("In", "in-1", { x: 0, y: 0 }, inPins, inProps);

    // Out element with label "S" at (10,0): its input pin is at (10,0)
    const outProps = new PropertyBag([["label", "S"]]);
    const outEl = new TestElement("Out", "out-1", { x: 10, y: 0 }, outPins, outProps);

    circuit.addElement(inEl);
    circuit.addElement(outEl);

    // Wire from In output (0,0) to Out input (10,0)
    circuit.addWire(new Wire({ x: 0, y: 0 }, { x: 10, y: 0 }));

    const compiled = compileCircuit(circuit, registry);

    expect(compiled.labelToNetId.has("A")).toBe(true);
    expect(compiled.labelToNetId.has("S")).toBe(true);

    // Both A and S should map to the same net (they're connected by wire)
    expect(compiled.labelToNetId.get("A")).toBe(compiled.labelToNetId.get("S"));
  });

  // -------------------------------------------------------------------------
  // throwsOnUnregisteredComponent
  // -------------------------------------------------------------------------
  it("throwsOnUnregisteredComponent", () => {
    const registry = new ComponentRegistry();
    // Don't register anything

    const circuit = new Circuit();
    circuit.addElement(new TestElement("Xyzzy", "xyzzy-1", { x: 0, y: 0 }, notPins()));

    expect(() => compileCircuit(circuit, registry)).toThrow(/unknown component type "Xyzzy"/);
  });

  // -------------------------------------------------------------------------
  // bitWidthMismatchThrows (BitsException)
  // -------------------------------------------------------------------------
  it("bitWidthMismatchThrows", () => {
    // 1-bit output connected to 8-bit input — should throw BitsException
    const singleBitOutPins: PinDeclaration[] = [
      { direction: PinDirection.OUTPUT, label: "out", defaultBitWidth: 1, position: { x: 2, y: 0 }, isNegatable: false, isClockCapable: false },
    ];
    const eightBitInPins: PinDeclaration[] = [
      { direction: PinDirection.INPUT, label: "in", defaultBitWidth: 8, position: { x: 2, y: 0 }, isNegatable: false, isClockCapable: false },
    ];

    const srcDef = makeDefinition("Src", singleBitOutPins);
    const dstDef = makeDefinition("Dst", eightBitInPins);
    const registry = makeRegistry(srcDef, dstDef);

    const circuit = new Circuit();
    // Both elements have pins at (2,0) — they'll share a net
    circuit.addElement(new TestElement("Src", "src-1", { x: 0, y: 0 }, singleBitOutPins));
    circuit.addElement(new TestElement("Dst", "dst-1", { x: 0, y: 0 }, eightBitInPins));

    expect(() => compileCircuit(circuit, registry)).toThrow(BitsException);
  });

  // -------------------------------------------------------------------------
  // wireToNetIdPopulated
  // -------------------------------------------------------------------------
  it("wireToNetIdPopulated", () => {
    // A wire connecting NOT output to AND input should appear in wireToNetId.
    const notDef = makeDefinition("Not", notPins());
    const andDef = makeDefinition("And", twoInputPins());
    const registry = makeRegistry(notDef, andDef);

    const circuit = new Circuit();
    const notEl = new TestElement("Not", "not-1", { x: 0, y: 0 }, notPins());
    const andEl = new TestElement("And", "and-1", { x: 8, y: 0 }, twoInputPins());
    circuit.addElement(notEl);
    circuit.addElement(andEl);

    const wire = new Wire({ x: 2, y: 0 }, { x: 8, y: 0 });
    circuit.addWire(wire);

    const compiled = compileCircuit(circuit, registry);

    expect(compiled.wireToNetId.has(wire)).toBe(true);
    // The wire's net ID should be valid (0 <= netId < netCount)
    const netId = compiled.wireToNetId.get(wire)!;
    expect(netId).toBeGreaterThanOrEqual(0);
    expect(netId).toBeLessThan(compiled.netCount);
  });

  // -------------------------------------------------------------------------
  // emptyCircuitCompiles
  // -------------------------------------------------------------------------
  it("emptyCircuitCompiles", () => {
    const registry = new ComponentRegistry();
    const circuit = new Circuit();
    const compiled = compileCircuit(circuit, registry);
    expect(compiled.netCount).toBe(0);
    expect(compiled.componentCount).toBe(0);
    expect(compiled.evaluationOrder.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tarjan tests
// ---------------------------------------------------------------------------

describe("Tarjan", () => {
  // -------------------------------------------------------------------------
  // findsSimpleCycle
  // -------------------------------------------------------------------------
  it("findsSimpleCycle", () => {
    // adjacency [[1],[0]] — 0→1 and 1→0, one SCC [0,1]
    const sccs = findSCCs([[1], [0]]);
    expect(sccs.length).toBe(1);
    const scc = sccs[0]!;
    expect(scc.length).toBe(2);
    expect(scc).toContain(0);
    expect(scc).toContain(1);
  });

  // -------------------------------------------------------------------------
  // findsNoCycleInDAG
  // -------------------------------------------------------------------------
  it("findsNoCycleInDAG", () => {
    // 0→1→2 — three singleton SCCs (no cycles)
    const sccs = findSCCs([[1], [2], []]);
    expect(sccs.length).toBe(3);
    // Each SCC should be a singleton
    for (const scc of sccs) {
      expect(scc.length).toBe(1);
    }
  });

  // -------------------------------------------------------------------------
  // reverseTopologicalOrder
  // -------------------------------------------------------------------------
  it("reverseTopologicalOrder", () => {
    // 0→1→2 (DAG). Tarjan returns in reverse topological order.
    // In a chain A→B→C, reverse topological means C appears before B before A.
    const sccs = findSCCs([[1], [2], []]);

    // Build a map from node to SCC index in the returned array
    const nodeToSccIdx = new Map<number, number>();
    for (let i = 0; i < sccs.length; i++) {
      for (const node of sccs[i]!) {
        nodeToSccIdx.set(node, i);
      }
    }

    // In reverse topological order: node 2 should appear at a lower index
    // than node 1, and node 1 at a lower index than node 0.
    // (lower index = earlier in the returned array)
    expect(nodeToSccIdx.get(2)).toBeLessThan(nodeToSccIdx.get(1)!);
    expect(nodeToSccIdx.get(1)).toBeLessThan(nodeToSccIdx.get(0)!);
  });

  // -------------------------------------------------------------------------
  // handlesDisconnectedGraph
  // -------------------------------------------------------------------------
  it("handlesDisconnectedGraph", () => {
    // 0→1 and 2→3 — two separate components
    const sccs = findSCCs([[1], [], [3], []]);
    expect(sccs.length).toBe(4);
    for (const scc of sccs) {
      expect(scc.length).toBe(1);
    }
  });

  // -------------------------------------------------------------------------
  // handlesSelfLoop
  // -------------------------------------------------------------------------
  it("handlesSelfLoop", () => {
    // Node 0 has a self-loop (0→0). It forms its own SCC.
    const sccs = findSCCs([[0]]);
    expect(sccs.length).toBe(1);
    expect(sccs[0]!.length).toBe(1);
    expect(sccs[0]![0]).toBe(0);
  });

  // -------------------------------------------------------------------------
  // handlesLargerCycle
  // -------------------------------------------------------------------------
  it("handlesLargerCycle", () => {
    // 0→1→2→0 — one SCC of size 3
    const sccs = findSCCs([[1], [2], [0]]);
    expect(sccs.length).toBe(1);
    expect(sccs[0]!.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// TopologicalSort tests
// ---------------------------------------------------------------------------

describe("TopologicalSort", () => {
  // -------------------------------------------------------------------------
  // sortsLinearChain
  // -------------------------------------------------------------------------
  it("sortsLinearChain", () => {
    // 0→1→2: 0 must come before 1, 1 before 2
    const order = topologicalSort([[1], [2], []]);
    expect(order).toEqual([0, 1, 2]);
  });

  // -------------------------------------------------------------------------
  // sortsDiamondDAG
  // -------------------------------------------------------------------------
  it("sortsDiamondDAG", () => {
    // Diamond: 0→{1,2}→3
    // adjacency: 0→[1,2], 1→[3], 2→[3], 3→[]
    const order = topologicalSort([[1, 2], [3], [3], []]);
    // 0 must come first, 3 must come last
    expect(order[0]).toBe(0);
    expect(order[3]).toBe(3);
    // 1 and 2 can be in any order
    expect(order.slice(1, 3)).toContain(1);
    expect(order.slice(1, 3)).toContain(2);
  });

  // -------------------------------------------------------------------------
  // throwsOnCycle
  // -------------------------------------------------------------------------
  it("throwsOnCycle", () => {
    // 0→1→0 — cycle, should throw
    expect(() => topologicalSort([[1], [0]])).toThrow(/cycle detected/);
  });

  // -------------------------------------------------------------------------
  // handlesEmptyGraph
  // -------------------------------------------------------------------------
  it("handlesEmptyGraph", () => {
    const order = topologicalSort([]);
    expect(order).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // handlesSingleNode
  // -------------------------------------------------------------------------
  it("handlesSingleNode", () => {
    const order = topologicalSort([[]]);
    expect(order).toEqual([0]);
  });
});
