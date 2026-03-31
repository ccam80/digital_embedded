/**
 * Tests for subcircuit engine flattening (Task 6.2.3).
 *
 * Tests construct SubcircuitHost implementations directly — no dependency on
 * the SubcircuitElement class from 6.2.1. This makes the tests independent of
 * that task's completion state.
 */

import { describe, it, expect } from "vitest";
import { Circuit, Wire } from "@/core/circuit";
import { PinDirection } from "@/core/pin";
import type { Pin } from "@/core/pin";
import { PropertyBag } from "@/core/properties";
import { ComponentRegistry, ComponentCategory } from "@/core/registry";
import type { ComponentDefinition } from "@/core/registry";
import { flattenCircuit, isSubcircuitHost } from "@/solver/digital/flatten";
import {
  TestLeafElement,
  TestSubcircuitElement,
  makeLeafElement,
  makeInElement,
  makeOutElement,
} from "@/test-fixtures/subcircuit-elements";

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function makePortElement(
  instanceId: string,
  label: string,
  position: { x: number; y: number } = { x: 5, y: 0 },
  bitWidth: number = 1,
): TestLeafElement {
  const props = new PropertyBag();
  props.set("label", label);
  props.set("bitWidth", bitWidth);
  props.set("face", "left");
  props.set("sortOrder", 0);
  const pins: Pin[] = [
    {
      direction: PinDirection.BIDIRECTIONAL,
      position: { x: 0, y: 1 },
      label: "port",
      bitWidth,
      isNegated: false,
      isClock: false,
      kind: "signal",
    },
  ];
  return new TestLeafElement("Port", instanceId, position, props, pins);
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

function makeRegistry(...typeIds: string[]): ComponentRegistry {
  const reg = new ComponentRegistry();
  for (const typeId of typeIds) {
    const def: ComponentDefinition = {
      name: typeId,
      typeId: -1,
      factory: (_props) => makeLeafElement(typeId, "auto", { x: 0, y: 0 }),
      pinLayout: [],
      propertyDefs: [],
      attributeMap: [],
      category: ComponentCategory.MISC,
      helpText: typeId,
      models: {
        digital: { executeFn: (_index: number, _state: Uint32Array, _highZs: Uint32Array) => {} },
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
    const andEl = makeLeafElement("And", "and-1", { x: 0, y: 0 });
    const orEl = makeLeafElement("Or", "or-1", { x: 10, y: 0 });
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
    const and1 = makeLeafElement("And", "and-a", { x: 0, y: 0 });
    const and2 = makeLeafElement("And", "and-b", { x: 5, y: 0 });
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
    const andEl = makeLeafElement("And", "and-1", { x: 5, y: 0 });
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
        kind: "signal",
      },
      {
        direction: PinDirection.OUTPUT,
        position: { x: 26, y: 1 },
        label: "Y",
        bitWidth: 1,
        isNegated: false,
        isClock: false,
        kind: "signal",
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
    const andEl = makeLeafElement("And", "and-1", { x: 5, y: 0 });
    const outEl = makeOutElement("out-1", "S", { x: 10, y: 0 });
    internal.addElement(inEl);
    internal.addElement(andEl);
    internal.addElement(outEl);

    const parent = new Circuit({ name: "Top" });

    const pinsA: Pin[] = [
      { direction: PinDirection.INPUT, position: { x: 0, y: 1 }, label: "A", bitWidth: 1, isNegated: false, isClock: false, kind: "signal" },
      { direction: PinDirection.OUTPUT, position: { x: 6, y: 1 }, label: "S", bitWidth: 1, isNegated: false, isClock: false, kind: "signal" },
    ];
    const pinsB: Pin[] = [
      { direction: PinDirection.INPUT, position: { x: 20, y: 1 }, label: "A", bitWidth: 1, isNegated: false, isClock: false, kind: "signal" },
      { direction: PinDirection.OUTPUT, position: { x: 26, y: 1 }, label: "S", bitWidth: 1, isNegated: false, isClock: false, kind: "signal" },
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
    const innerAnd = makeLeafElement("And", "and-i", { x: 5, y: 0 });
    const innerOut = makeOutElement("out-i", "Z", { x: 10, y: 0 });
    inner.addElement(innerIn);
    inner.addElement(innerAnd);
    inner.addElement(innerOut);

    // Middle: contains inner as a subcircuit
    const middle = new Circuit({ name: "Middle" });
    const middleIn = makeInElement("in-m", "A", { x: 0, y: 0 });
    const middleOut = makeOutElement("out-m", "Y", { x: 20, y: 0 });
    const innerPins: Pin[] = [
      { direction: PinDirection.INPUT, position: { x: 5, y: 1 }, label: "X", bitWidth: 1, isNegated: false, isClock: false, kind: "signal" },
      { direction: PinDirection.OUTPUT, position: { x: 11, y: 1 }, label: "Z", bitWidth: 1, isNegated: false, isClock: false, kind: "signal" },
    ];
    const innerSub = makeSubcircuitElement("Inner", "inner-sub", { x: 5, y: 0 }, inner, innerPins);
    middle.addElement(middleIn);
    middle.addElement(innerSub);
    middle.addElement(middleOut);

    // Top: contains middle as a subcircuit
    const top = new Circuit({ name: "Top" });
    const middlePins: Pin[] = [
      { direction: PinDirection.INPUT, position: { x: 0, y: 1 }, label: "A", bitWidth: 1, isNegated: false, isClock: false, kind: "signal" },
      { direction: PinDirection.OUTPUT, position: { x: 6, y: 1 }, label: "Y", bitWidth: 1, isNegated: false, isClock: false, kind: "signal" },
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

    // Parent circuit: subcircuit with chip-relative input pin {0,1} at element position {20,5} → world (20,6)
    const parent = new Circuit({ name: "Top" });
    const subcircuitPins: Pin[] = [
      {
        direction: PinDirection.INPUT,
        position: { x: 0, y: 1 },
        label: "A",
        bitWidth: 1,
        isNegated: false,
        isClock: false,
        kind: "signal",
      },
      {
        direction: PinDirection.OUTPUT,
        position: { x: 6, y: 1 },
        label: "Y",
        bitWidth: 1,
        isNegated: false,
        isClock: false,
        kind: "signal",
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
    const leaf = makeLeafElement("And", "and-1", { x: 0, y: 0 });

    expect(isSubcircuitHost(sub)).toBe(true);
    expect(isSubcircuitHost(leaf)).toBe(false);
  });

  it("singleSubcircuit — original circuit is not mutated by flattening", () => {
    const internal = new Circuit({ name: "Sub" });
    const inEl = makeInElement("in-1", "A", { x: 0, y: 0 });
    const andEl = makeLeafElement("And", "and-1", { x: 5, y: 0 });
    internal.addElement(inEl);
    internal.addElement(andEl);

    const parent = new Circuit({ name: "Top" });
    const subPins: Pin[] = [
      { direction: PinDirection.INPUT, position: { x: 0, y: 1 }, label: "A", bitWidth: 1, isNegated: false, isClock: false, kind: "signal" },
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

// ---------------------------------------------------------------------------
// Port-based subcircuit flattening tests
// ---------------------------------------------------------------------------

describe("flattenCircuit — Port-based subcircuits", () => {
  it("singleLevelFlattenWithPortInterfaces — internal circuit with Port elements is inlined correctly", () => {
    // Internal circuit: Port("A") → And gate → Port("Y")
    const internal = new Circuit({ name: "PortWrapper" });
    const portA = makePortElement("port-A", "A", { x: 0, y: 0 });
    const andEl = makeLeafElement("And", "and-1", { x: 5, y: 0 });
    const portY = makePortElement("port-Y", "Y", { x: 10, y: 0 });
    internal.addElement(portA);
    internal.addElement(andEl);
    internal.addElement(portY);
    internal.addWire(new Wire(
      { x: portA.position.x + portA.getPins()[0]!.position.x, y: portA.position.y + portA.getPins()[0]!.position.y },
      { x: andEl.position.x + andEl.getPins()[0]!.position.x, y: andEl.position.y + andEl.getPins()[0]!.position.y },
    ));
    internal.addWire(new Wire(
      { x: andEl.position.x + andEl.getPins()[0]!.position.x, y: andEl.position.y + andEl.getPins()[0]!.position.y },
      { x: portY.position.x + portY.getPins()[0]!.position.x, y: portY.position.y + portY.getPins()[0]!.position.y },
    ));

    // Parent circuit: subcircuit instance with BIDIRECTIONAL pins
    const parent = new Circuit({ name: "Top" });
    const subcircuitPins: Pin[] = [
      {
        direction: PinDirection.BIDIRECTIONAL,
        position: { x: 20, y: 1 },
        label: "A",
        bitWidth: 1,
        isNegated: false,
        isClock: false,
        kind: "signal",
      },
      {
        direction: PinDirection.BIDIRECTIONAL,
        position: { x: 26, y: 1 },
        label: "Y",
        bitWidth: 1,
        isNegated: false,
        isClock: false,
        kind: "signal",
      },
    ];
    const subEl = makeSubcircuitElement("PortWrapper", "sub-1", { x: 20, y: 0 }, internal, subcircuitPins);
    parent.addElement(subEl);

    const registry = makeRegistry("And");
    const { circuit: flat } = flattenCircuit(parent, registry);

    // No subcircuit elements remain
    const subcircuitEls = flat.elements.filter((e) => e.typeId.startsWith("Subcircuit:"));
    expect(subcircuitEls.length).toBe(0);

    // Gate is present in flattened circuit
    const gateEls = flat.elements.filter((e) => e.typeId === "And");
    expect(gateEls.length).toBe(1);

    // Port elements are retained (they are leaf elements)
    const portEls = flat.elements.filter((e) => e.typeId === "Port");
    expect(portEls.length).toBe(2);

    // Bridge wires are created: 2 internal wires + 2 bridge wires (one per subcircuit pin) = 4
    expect(flat.wires.length).toBe(4);
  });

  it("nestedPortSubcircuits — recursive flattening works with Port at every level", () => {
    // Inner circuit: Port("X") → And gate → Port("Z")
    const inner = new Circuit({ name: "Inner" });
    const innerPortX = makePortElement("port-X", "X", { x: 0, y: 0 });
    const innerAnd = makeLeafElement("And", "and-i", { x: 5, y: 0 });
    const innerPortZ = makePortElement("port-Z", "Z", { x: 10, y: 0 });
    inner.addElement(innerPortX);
    inner.addElement(innerAnd);
    inner.addElement(innerPortZ);

    // Middle circuit: Port("A") + inner subcircuit + Port("Y")
    const middle = new Circuit({ name: "Middle" });
    const middlePortA = makePortElement("port-A", "A", { x: 0, y: 0 });
    const middlePortY = makePortElement("port-Y", "Y", { x: 20, y: 0 });
    const innerPins: Pin[] = [
      { direction: PinDirection.BIDIRECTIONAL, position: { x: 5, y: 1 }, label: "X", bitWidth: 1, isNegated: false, isClock: false, kind: "signal" },
      { direction: PinDirection.BIDIRECTIONAL, position: { x: 11, y: 1 }, label: "Z", bitWidth: 1, isNegated: false, isClock: false, kind: "signal" },
    ];
    const innerSub = makeSubcircuitElement("Inner", "inner-sub", { x: 5, y: 0 }, inner, innerPins);
    middle.addElement(middlePortA);
    middle.addElement(innerSub);
    middle.addElement(middlePortY);

    // Top: contains middle as a subcircuit with BIDIRECTIONAL pins
    const top = new Circuit({ name: "Top" });
    const middlePins: Pin[] = [
      { direction: PinDirection.BIDIRECTIONAL, position: { x: 0, y: 1 }, label: "A", bitWidth: 1, isNegated: false, isClock: false, kind: "signal" },
      { direction: PinDirection.BIDIRECTIONAL, position: { x: 6, y: 1 }, label: "Y", bitWidth: 1, isNegated: false, isClock: false, kind: "signal" },
    ];
    const middleSub = makeSubcircuitElement("Middle", "mid-sub", { x: 0, y: 0 }, middle, middlePins);
    top.addElement(middleSub);

    const registry = makeRegistry("And");
    const { circuit: flat } = flattenCircuit(top, registry);

    // No subcircuit elements in result
    const subcircuitEls = flat.elements.filter((e) => e.typeId.startsWith("Subcircuit:"));
    expect(subcircuitEls.length).toBe(0);

    // The And gate from inner is present
    const gateEls = flat.elements.filter((e) => e.typeId === "And");
    expect(gateEls.length).toBe(1);

    // All Port elements are present: middle has 2 (A, Y) + inner has 2 (X, Z) = 4
    const portEls = flat.elements.filter((e) => e.typeId === "Port");
    expect(portEls.length).toBe(4);
  });

  it("multiInstancePortSubcircuit — two instances of the same Port-based subcircuit have distinct scoped names", () => {
    const internal = new Circuit({ name: "PortGate" });
    const portA = makePortElement("port-A", "A", { x: 0, y: 0 });
    const andEl = makeLeafElement("And", "and-1", { x: 5, y: 0 });
    const portY = makePortElement("port-Y", "Y", { x: 10, y: 0 });
    internal.addElement(portA);
    internal.addElement(andEl);
    internal.addElement(portY);

    const parent = new Circuit({ name: "Top" });

    const pinsA: Pin[] = [
      { direction: PinDirection.BIDIRECTIONAL, position: { x: 0, y: 1 }, label: "A", bitWidth: 1, isNegated: false, isClock: false, kind: "signal" },
      { direction: PinDirection.BIDIRECTIONAL, position: { x: 6, y: 1 }, label: "Y", bitWidth: 1, isNegated: false, isClock: false, kind: "signal" },
    ];
    const pinsB: Pin[] = [
      { direction: PinDirection.BIDIRECTIONAL, position: { x: 20, y: 1 }, label: "A", bitWidth: 1, isNegated: false, isClock: false, kind: "signal" },
      { direction: PinDirection.BIDIRECTIONAL, position: { x: 26, y: 1 }, label: "Y", bitWidth: 1, isNegated: false, isClock: false, kind: "signal" },
    ];

    const sub0 = makeSubcircuitElement("PortGate", "sub-0", { x: 0, y: 0 }, internal, pinsA);
    const sub1 = makeSubcircuitElement("PortGate", "sub-1", { x: 20, y: 0 }, internal, pinsB);
    parent.addElement(sub0);
    parent.addElement(sub1);

    const registry = makeRegistry("And");
    const { circuit: flat } = flattenCircuit(parent, registry);

    // Each instance contributes 3 elements (Port A, And, Port Y) → 6 total
    expect(flat.elements.length).toBe(6);

    // All instanceIds must be distinct
    const instanceIds = flat.elements.map((e) => e.instanceId);
    const uniqueIds = new Set(instanceIds);
    expect(uniqueIds.size).toBe(6);

    // Scoped names contain the instance index to distinguish the two instances
    const instance0Names = instanceIds.filter((id) => id.includes("PortGate_0"));
    const instance1Names = instanceIds.filter((id) => id.includes("PortGate_1"));
    expect(instance0Names.length).toBe(3);
    expect(instance1Names.length).toBe(3);
  });

  it("portWithMultiBitWidth — Port('BUS', bitWidth=8) preserves bus width through the bridge", () => {
    // Internal circuit: Port("BUS") with bitWidth 8 → And gate
    const internal = new Circuit({ name: "BusSub" });
    const portBus = makePortElement("port-BUS", "BUS", { x: 0, y: 0 }, 8);
    const andEl = makeLeafElement("And", "and-1", { x: 5, y: 0 });
    internal.addElement(portBus);
    internal.addElement(andEl);
    internal.addWire(new Wire(
      { x: portBus.position.x + portBus.getPins()[0]!.position.x, y: portBus.position.y + portBus.getPins()[0]!.position.y },
      { x: andEl.position.x + andEl.getPins()[0]!.position.x, y: andEl.position.y + andEl.getPins()[0]!.position.y },
    ));

    // Parent with an 8-bit BIDIRECTIONAL pin
    const parent = new Circuit({ name: "Top" });
    const subcircuitPins: Pin[] = [
      {
        direction: PinDirection.BIDIRECTIONAL,
        position: { x: 0, y: 1 },
        label: "BUS",
        bitWidth: 8,
        isNegated: false,
        isClock: false,
        kind: "signal",
      },
    ];
    const subEl = makeSubcircuitElement("BusSub", "sub-1", { x: 10, y: 0 }, internal, subcircuitPins);
    parent.addElement(subEl);

    const registry = makeRegistry("And");
    const { circuit: flat } = flattenCircuit(parent, registry);

    // Gate and Port are both present
    expect(flat.elements.filter((e) => e.typeId === "And").length).toBe(1);
    const portEls = flat.elements.filter((e) => e.typeId === "Port");
    expect(portEls.length).toBe(1);

    // Port pin bitWidth is preserved
    expect(portEls[0]!.getPins()[0]!.bitWidth).toBe(8);

    // 1 internal wire + 1 bridge wire = 2
    expect(flat.wires.length).toBe(2);
  });

  it("mixedPortAndLeafElements — multiple internal gates wired together are all preserved with correct bridge wires", () => {
    // Internal circuit: Port("IN") → And → Or → Port("OUT")
    const internal = new Circuit({ name: "TwoGates" });
    const portIn = makePortElement("port-IN", "IN", { x: 0, y: 0 });
    const andEl = makeLeafElement("And", "and-1", { x: 5, y: 0 });
    const orEl = makeLeafElement("Or", "or-1", { x: 10, y: 0 });
    const portOut = makePortElement("port-OUT", "OUT", { x: 15, y: 0 });
    internal.addElement(portIn);
    internal.addElement(andEl);
    internal.addElement(orEl);
    internal.addElement(portOut);
    // Wire the internal chain (using world positions: el.position + chip-relative pin)
    internal.addWire(new Wire(
      { x: portIn.position.x + portIn.getPins()[0]!.position.x, y: portIn.position.y + portIn.getPins()[0]!.position.y },
      { x: andEl.position.x + andEl.getPins()[0]!.position.x, y: andEl.position.y + andEl.getPins()[0]!.position.y },
    ));
    internal.addWire(new Wire(
      { x: andEl.position.x + andEl.getPins()[0]!.position.x, y: andEl.position.y + andEl.getPins()[0]!.position.y },
      { x: orEl.position.x + orEl.getPins()[0]!.position.x, y: orEl.position.y + orEl.getPins()[0]!.position.y },
    ));
    internal.addWire(new Wire(
      { x: orEl.position.x + orEl.getPins()[0]!.position.x, y: orEl.position.y + orEl.getPins()[0]!.position.y },
      { x: portOut.position.x + portOut.getPins()[0]!.position.x, y: portOut.position.y + portOut.getPins()[0]!.position.y },
    ));

    // Parent circuit with BIDIRECTIONAL pins for IN and OUT
    const parent = new Circuit({ name: "Top" });
    const subcircuitPins: Pin[] = [
      {
        direction: PinDirection.BIDIRECTIONAL,
        position: { x: 0, y: 1 },
        label: "IN",
        bitWidth: 1,
        isNegated: false,
        isClock: false,
        kind: "signal",
      },
      {
        direction: PinDirection.BIDIRECTIONAL,
        position: { x: 6, y: 1 },
        label: "OUT",
        bitWidth: 1,
        isNegated: false,
        isClock: false,
        kind: "signal",
      },
    ];
    const subEl = makeSubcircuitElement("TwoGates", "sub-1", { x: 30, y: 0 }, internal, subcircuitPins);
    parent.addElement(subEl);

    const registry = makeRegistry("And", "Or");
    const { circuit: flat } = flattenCircuit(parent, registry);

    // No subcircuit elements remain
    expect(flat.elements.filter((e) => e.typeId.startsWith("Subcircuit:")).length).toBe(0);

    // All internal elements present: 2 Port + And + Or = 4
    expect(flat.elements.length).toBe(4);
    expect(flat.elements.filter((e) => e.typeId === "And").length).toBe(1);
    expect(flat.elements.filter((e) => e.typeId === "Or").length).toBe(1);
    expect(flat.elements.filter((e) => e.typeId === "Port").length).toBe(2);

    // 3 internal wires + 2 bridge wires (one per subcircuit pin) = 5
    expect(flat.wires.length).toBe(5);

    // Bridge wire for "IN" pin: connects subcircuit world pin at (30, 1) to Port("IN") world pin at (0, 1)
    // portIn at {0,0} + chip-relative pin {0,1} = world {0,1}; subEl at {30,0} + chip pin {0,1} = world {30,1}
    const bridgeWireIN = flat.wires.find(
      (w) =>
        (w.start.x === 30 && w.start.y === 1 && w.end.x === 0 && w.end.y === 1) ||
        (w.end.x === 30 && w.end.y === 1 && w.start.x === 0 && w.start.y === 1),
    );
    expect(bridgeWireIN).toBeDefined();

    // Bridge wire for "OUT" pin: connects subcircuit world pin at (36, 1) to Port("OUT") world pin at (15, 1)
    // portOut at {15,0} + chip-relative pin {0,1} = world {15,1}; subEl at {30,0} + chip pin {6,1} = world {36,1}
    const bridgeWireOUT = flat.wires.find(
      (w) =>
        (w.start.x === 36 && w.start.y === 1 && w.end.x === 15 && w.end.y === 1) ||
        (w.end.x === 36 && w.end.y === 1 && w.start.x === 15 && w.start.y === 1),
    );
    expect(bridgeWireOUT).toBeDefined();
  });
});
