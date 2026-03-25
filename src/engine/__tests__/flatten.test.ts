/**
 * Tests for subcircuit engine flattening (Task 6.2.3).
 *
 * Tests construct SubcircuitHost implementations directly — no dependency on
 * the SubcircuitElement class from 6.2.1. This makes the tests independent of
 * that task's completion state.
 */

import { describe, it, expect } from "vitest";
import { Circuit, Wire } from "@/core/circuit";
import { AbstractCircuitElement } from "@/core/element";
import type { Pin } from "@/core/pin";
import { PinDirection } from "@/core/pin";
import type { RenderContext, Rect } from "@/core/renderer-interface";
import { PropertyBag } from "@/core/properties";
import { ComponentRegistry, ComponentCategory } from "@/core/registry";
import type { ComponentDefinition, ExecuteFunction } from "@/core/registry";
import { flattenCircuit, isSubcircuitHost } from "@/engine/flatten";
import type { SubcircuitHost } from "@/engine/flatten";

// ---------------------------------------------------------------------------
// Test helpers: minimal leaf component (And-like)
// ---------------------------------------------------------------------------

class TestLeafElement extends AbstractCircuitElement {
  private readonly _pins: readonly Pin[];

  constructor(
    typeId: string,
    instanceId: string,
    position: { x: number; y: number },
    props: PropertyBag,
    pins: Pin[],
  ) {
    super(typeId, instanceId, position, 0, false, props);
    this._pins = pins;
  }

  getPins(): readonly Pin[] {
    return this._pins;
  }

  draw(_ctx: RenderContext): void {}

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y, width: 4, height: 4 };
  }

  getHelpText(): string {
    return "test leaf";
  }
}

function makeLeaf(
  typeId: string,
  instanceId: string,
  position: { x: number; y: number } = { x: 0, y: 0 },
  label?: string,
): TestLeafElement {
  const props = new PropertyBag();
  if (label !== undefined) {
    props.set("label", label);
  }
  const pins: Pin[] = [
    {
      direction: PinDirection.OUTPUT,
      position: { x: position.x + 2, y: position.y + 1 },
      label: "out",
      bitWidth: 1,
      isNegated: false,
      isClock: false,
    },
  ];
  return new TestLeafElement(typeId, instanceId, position, props, pins);
}

function makeInElement(
  instanceId: string,
  label: string,
  position: { x: number; y: number } = { x: 0, y: 0 },
): TestLeafElement {
  const props = new PropertyBag();
  props.set("label", label);
  const pins: Pin[] = [
    {
      direction: PinDirection.OUTPUT,
      position: { x: position.x + 2, y: position.y + 1 },
      label: "out",
      bitWidth: 1,
      isNegated: false,
      isClock: false,
    },
  ];
  return new TestLeafElement("In", instanceId, position, props, pins);
}

function makeOutElement(
  instanceId: string,
  label: string,
  position: { x: number; y: number } = { x: 10, y: 0 },
): TestLeafElement {
  const props = new PropertyBag();
  props.set("label", label);
  const pins: Pin[] = [
    {
      direction: PinDirection.INPUT,
      position: { x: position.x, y: position.y + 1 },
      label: "in",
      bitWidth: 1,
      isNegated: false,
      isClock: false,
    },
  ];
  return new TestLeafElement("Out", instanceId, position, props, pins);
}

// ---------------------------------------------------------------------------
// TestSubcircuitElement — implements SubcircuitHost for test use
// ---------------------------------------------------------------------------

class TestSubcircuitElement extends AbstractCircuitElement implements SubcircuitHost {
  readonly internalCircuit: Circuit;
  readonly subcircuitName: string;
  private readonly _pins: readonly Pin[];

  constructor(
    name: string,
    instanceId: string,
    position: { x: number; y: number },
    internalCircuit: Circuit,
    pins: Pin[],
  ) {
    super(`Subcircuit:${name}`, instanceId, position, 0, false, new PropertyBag());
    this.subcircuitName = name;
    this.internalCircuit = internalCircuit;
    this._pins = pins;
  }

  getPins(): readonly Pin[] {
    return this._pins;
  }

  draw(_ctx: RenderContext): void {}

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y, width: 6, height: 4 };
  }

  getHelpText(): string {
    return "subcircuit";
  }
}

function makeSubcircuitElement(
  name: string,
  instanceId: string,
  position: { x: number; y: number },
  internalCircuit: Circuit,
  interfacePins: Pin[],
): TestSubcircuitElement {
  return new TestSubcircuitElement(name, instanceId, position, internalCircuit, interfacePins);
}

// ---------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------

function makeNoOpExecute(): ExecuteFunction {
  return (_index, _state, _layout) => {};
}

function makeRegistry(...typeIds: string[]): ComponentRegistry {
  const reg = new ComponentRegistry();
  for (const typeId of typeIds) {
    const def: ComponentDefinition = {
      name: typeId,
      typeId: -1,
      factory: (_props) => makeLeaf(typeId, "auto", { x: 0, y: 0 }),
      pinLayout: [],
      propertyDefs: [],
      attributeMap: [],
      category: ComponentCategory.MISC,
      helpText: typeId,
      models: {
        digital: { executeFn: makeNoOpExecute() },
      },
    };
    reg.register(def);
  }
  return reg;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("flattenCircuit", () => {
  it("noSubcircuitsUnchanged — circuit with no subcircuits returns structurally identical circuit", () => {
    const circuit = new Circuit({ name: "Top" });
    const andEl = makeLeaf("And", "and-1", { x: 0, y: 0 });
    const orEl = makeLeaf("Or", "or-1", { x: 10, y: 0 });
    circuit.addElement(andEl);
    circuit.addElement(orEl);
    circuit.addWire(new Wire({ x: 4, y: 1 }, { x: 10, y: 1 }));

    const registry = makeRegistry("And", "Or");
    const { circuit: flat } = flattenCircuit(circuit, registry);

    expect(flat.elements.length).toBe(2);
    expect(flat.elements.map((e) => e.typeId)).toEqual(["And", "Or"]);
    expect(flat.wires.length).toBe(1);
  });

  it("preservesLeafComponents — gates and other leaf elements pass through unchanged", () => {
    const circuit = new Circuit();
    const and1 = makeLeaf("And", "and-a", { x: 0, y: 0 });
    const and2 = makeLeaf("And", "and-b", { x: 5, y: 0 });
    circuit.addElement(and1);
    circuit.addElement(and2);

    const registry = makeRegistry("And");
    const { circuit: flat } = flattenCircuit(circuit, registry);

    expect(flat.elements.length).toBe(2);
    expect(flat.elements[0]!.typeId).toBe("And");
    expect(flat.elements[1]!.typeId).toBe("And");
  });

  it("singleSubcircuit — subcircuit element is replaced by its internal components", () => {
    // Internal circuit: In → And → Out
    const internal = new Circuit({ name: "AndWrapper" });
    const inEl = makeInElement("in-1", "A", { x: 0, y: 0 });
    const andEl = makeLeaf("And", "and-1", { x: 5, y: 0 });
    const outEl = makeOutElement("out-1", "Y", { x: 10, y: 0 });
    internal.addElement(inEl);
    internal.addElement(andEl);
    internal.addElement(outEl);

    // Parent circuit: one subcircuit instance
    const parent = new Circuit({ name: "Top" });
    const subcircuitPins: Pin[] = [
      {
        direction: PinDirection.INPUT,
        position: { x: 20, y: 1 },
        label: "A",
        bitWidth: 1,
        isNegated: false,
        isClock: false,
      },
      {
        direction: PinDirection.OUTPUT,
        position: { x: 26, y: 1 },
        label: "Y",
        bitWidth: 1,
        isNegated: false,
        isClock: false,
      },
    ];
    const subcircuitInstance = makeSubcircuitElement(
      "AndWrapper",
      "sub-1",
      { x: 20, y: 0 },
      internal,
      subcircuitPins,
    );
    parent.addElement(subcircuitInstance);

    const registry = makeRegistry("And", "In", "Out");
    const { circuit: flat } = flattenCircuit(parent, registry);

    // No subcircuit element in result
    const subcircuitEls = flat.elements.filter((e) => e.typeId.startsWith("Subcircuit:"));
    expect(subcircuitEls.length).toBe(0);

    // Internal elements present
    const typeIds = flat.elements.map((e) => e.typeId).sort();
    expect(typeIds).toContain("In");
    expect(typeIds).toContain("And");
    expect(typeIds).toContain("Out");
    expect(flat.elements.length).toBe(3);
  });

  it("twoInstances — two instances of same subcircuit have distinct scoped names", () => {
    const internal = new Circuit({ name: "HalfAdder" });
    const inEl = makeInElement("in-1", "A", { x: 0, y: 0 });
    const andEl = makeLeaf("And", "and-1", { x: 5, y: 0 });
    const outEl = makeOutElement("out-1", "S", { x: 10, y: 0 });
    internal.addElement(inEl);
    internal.addElement(andEl);
    internal.addElement(outEl);

    const parent = new Circuit({ name: "Top" });

    const pinsA: Pin[] = [
      { direction: PinDirection.INPUT, position: { x: 0, y: 1 }, label: "A", bitWidth: 1, isNegated: false, isClock: false },
      { direction: PinDirection.OUTPUT, position: { x: 6, y: 1 }, label: "S", bitWidth: 1, isNegated: false, isClock: false },
    ];
    const pinsB: Pin[] = [
      { direction: PinDirection.INPUT, position: { x: 20, y: 1 }, label: "A", bitWidth: 1, isNegated: false, isClock: false },
      { direction: PinDirection.OUTPUT, position: { x: 26, y: 1 }, label: "S", bitWidth: 1, isNegated: false, isClock: false },
    ];

    const sub0 = makeSubcircuitElement("HalfAdder", "sub-0", { x: 0, y: 0 }, internal, pinsA);
    const sub1 = makeSubcircuitElement("HalfAdder", "sub-1", { x: 20, y: 0 }, internal, pinsB);
    parent.addElement(sub0);
    parent.addElement(sub1);

    const registry = makeRegistry("And", "In", "Out");
    const { circuit: flat } = flattenCircuit(parent, registry);

    // Each instance contributes 3 elements → 6 total
    expect(flat.elements.length).toBe(6);

    // All instanceIds must be distinct
    const instanceIds = flat.elements.map((e) => e.instanceId);
    const uniqueIds = new Set(instanceIds);
    expect(uniqueIds.size).toBe(6);

    // Instance names should contain the instance index to distinguish them
    const scopedIds = flat.elements.map((e) => e.instanceId);
    const instance0Names = scopedIds.filter((id) => id.includes("HalfAdder_0"));
    const instance1Names = scopedIds.filter((id) => id.includes("HalfAdder_1"));
    expect(instance0Names.length).toBe(3);
    expect(instance1Names.length).toBe(3);
  });

  it("nestedSubcircuit — subcircuit containing another subcircuit is fully recursively flattened", () => {
    // Inner: just an And gate
    const inner = new Circuit({ name: "Inner" });
    const innerIn = makeInElement("in-i", "X", { x: 0, y: 0 });
    const innerAnd = makeLeaf("And", "and-i", { x: 5, y: 0 });
    const innerOut = makeOutElement("out-i", "Z", { x: 10, y: 0 });
    inner.addElement(innerIn);
    inner.addElement(innerAnd);
    inner.addElement(innerOut);

    // Middle: contains inner as a subcircuit
    const middle = new Circuit({ name: "Middle" });
    const middleIn = makeInElement("in-m", "A", { x: 0, y: 0 });
    const middleOut = makeOutElement("out-m", "Y", { x: 20, y: 0 });
    const innerPins: Pin[] = [
      { direction: PinDirection.INPUT, position: { x: 5, y: 1 }, label: "X", bitWidth: 1, isNegated: false, isClock: false },
      { direction: PinDirection.OUTPUT, position: { x: 11, y: 1 }, label: "Z", bitWidth: 1, isNegated: false, isClock: false },
    ];
    const innerSub = makeSubcircuitElement("Inner", "inner-sub", { x: 5, y: 0 }, inner, innerPins);
    middle.addElement(middleIn);
    middle.addElement(innerSub);
    middle.addElement(middleOut);

    // Top: contains middle as a subcircuit
    const top = new Circuit({ name: "Top" });
    const middlePins: Pin[] = [
      { direction: PinDirection.INPUT, position: { x: 0, y: 1 }, label: "A", bitWidth: 1, isNegated: false, isClock: false },
      { direction: PinDirection.OUTPUT, position: { x: 6, y: 1 }, label: "Y", bitWidth: 1, isNegated: false, isClock: false },
    ];
    const middleSub = makeSubcircuitElement("Middle", "mid-sub", { x: 0, y: 0 }, middle, middlePins);
    top.addElement(middleSub);

    const registry = makeRegistry("And", "In", "Out");
    const { circuit: flat } = flattenCircuit(top, registry);

    // No subcircuit elements in result
    const subcircuitEls = flat.elements.filter((e) => e.typeId.startsWith("Subcircuit:"));
    expect(subcircuitEls.length).toBe(0);

    // Leaf elements: inner has (In, And, Out) = 3 + middle's own (In, Out) = 5
    expect(flat.elements.length).toBe(5);

    const typeIds = flat.elements.map((e) => e.typeId).sort();
    expect(typeIds.filter((t) => t === "And").length).toBe(1);
    expect(typeIds.filter((t) => t === "In").length).toBe(2);
    expect(typeIds.filter((t) => t === "Out").length).toBe(2);
  });

  it("pinWiring — parent net connected to subcircuit input pin is wired to the internal In component", () => {
    // Internal circuit: In(label=A) → Out(label=Y)
    const internal = new Circuit({ name: "Passthrough" });
    const inEl = makeInElement("in-1", "A", { x: 0, y: 5 });
    const outEl = makeOutElement("out-1", "Y", { x: 10, y: 5 });
    internal.addElement(inEl);
    internal.addElement(outEl);

    // Parent circuit: subcircuit with input pin at (20, 6)
    const parent = new Circuit({ name: "Top" });
    const subcircuitPins: Pin[] = [
      {
        direction: PinDirection.INPUT,
        position: { x: 20, y: 6 },
        label: "A",
        bitWidth: 1,
        isNegated: false,
        isClock: false,
      },
      {
        direction: PinDirection.OUTPUT,
        position: { x: 26, y: 6 },
        label: "Y",
        bitWidth: 1,
        isNegated: false,
        isClock: false,
      },
    ];
    const subEl = makeSubcircuitElement(
      "Passthrough",
      "sub-1",
      { x: 20, y: 5 },
      internal,
      subcircuitPins,
    );
    parent.addElement(subEl);

    const registry = makeRegistry("In", "Out");
    const { circuit: flat } = flattenCircuit(parent, registry);

    // Bridge wires should connect parent pin positions to internal element pin positions.
    // The internal In element's output pin is at (0 + 2, 5 + 1) = (2, 6).
    // The subcircuit's input pin is at (20, 6).
    // So we expect a wire from (20, 6) to (2, 6).
    const bridgeWireForA = flat.wires.find(
      (w) =>
        (w.start.x === 20 && w.start.y === 6 && w.end.x === 2 && w.end.y === 6) ||
        (w.end.x === 20 && w.end.y === 6 && w.start.x === 2 && w.start.y === 6),
    );
    expect(bridgeWireForA).toBeDefined();

    // The internal Out element's input pin is at (10, 5 + 1) = (10, 6).
    // The subcircuit's output pin is at (26, 6).
    // So we expect a wire from (26, 6) to (10, 6).
    const bridgeWireForY = flat.wires.find(
      (w) =>
        (w.start.x === 26 && w.start.y === 6 && w.end.x === 10 && w.end.y === 6) ||
        (w.end.x === 26 && w.end.y === 6 && w.start.x === 10 && w.start.y === 6),
    );
    expect(bridgeWireForY).toBeDefined();
  });

  it("isSubcircuitHost — correctly identifies SubcircuitHost elements", () => {
    const internal = new Circuit({ name: "X" });
    const sub = makeSubcircuitElement("X", "sub-1", { x: 0, y: 0 }, internal, []);
    const leaf = makeLeaf("And", "and-1", { x: 0, y: 0 });

    expect(isSubcircuitHost(sub)).toBe(true);
    expect(isSubcircuitHost(leaf)).toBe(false);
  });

  it("singleSubcircuit — original circuit is not mutated by flattening", () => {
    const internal = new Circuit({ name: "Sub" });
    const inEl = makeInElement("in-1", "A", { x: 0, y: 0 });
    const andEl = makeLeaf("And", "and-1", { x: 5, y: 0 });
    internal.addElement(inEl);
    internal.addElement(andEl);

    const parent = new Circuit({ name: "Top" });
    const subPins: Pin[] = [
      { direction: PinDirection.INPUT, position: { x: 0, y: 1 }, label: "A", bitWidth: 1, isNegated: false, isClock: false },
    ];
    const subEl = makeSubcircuitElement("Sub", "sub-1", { x: 0, y: 0 }, internal, subPins);
    parent.addElement(subEl);

    const originalElementCount = parent.elements.length;
    const originalInternalCount = internal.elements.length;

    const registry = makeRegistry("And", "In");
    flattenCircuit(parent, registry);

    // Parent and internal circuit must be unchanged
    expect(parent.elements.length).toBe(originalElementCount);
    expect(internal.elements.length).toBe(originalInternalCount);
  });
});
