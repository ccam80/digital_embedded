/**
 * Tests for Port-based subcircuit flattening (SE-2).
 *
 * Verifies that findInterfaceElement() recognizes Port elements and that
 * flattening works correctly for Port-based (domain-agnostic) subcircuits.
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
import { flattenCircuit } from "@/solver/digital/flatten";
import type { SubcircuitHost } from "@/solver/digital/flatten";

// ---------------------------------------------------------------------------
// Test helpers (same pattern as flatten.test.ts)
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
      position: { x: position.x, y: position.y + 1 },
      label: "port",
      bitWidth,
      isNegated: false,
      isClock: false,
    },
  ];
  return new TestLeafElement("Port", instanceId, position, props, pins);
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

describe("flattenCircuit — Port interface elements", () => {
  it("Port matched by label creates bridge wire for BIDIRECTIONAL subcircuit pin", () => {
    // Internal circuit: Port("A") → And gate
    const internal = new Circuit({ name: "PortSub" });
    const portEl = makePortElement("port-A", "A", { x: 0, y: 0 });
    const gate = makeLeaf("And", "and1", { x: 5, y: 0 });
    internal.addElement(portEl);
    internal.addElement(gate);
    internal.addWire(new Wire(
      { x: portEl.getPins()[0].position.x, y: portEl.getPins()[0].position.y },
      { x: gate.getPins()[0].position.x, y: gate.getPins()[0].position.y },
    ));

    // Parent circuit: subcircuit instance with a BIDIRECTIONAL pin named "A"
    const top = new Circuit({ name: "Top" });
    const subcircuitPins: Pin[] = [
      {
        direction: PinDirection.BIDIRECTIONAL,
        position: { x: 10, y: 1 },
        label: "A",
        bitWidth: 1,
        isNegated: false,
        isClock: false,
      },
    ];
    const subEl = new TestSubcircuitElement("PortSub", "sub1", { x: 10, y: 0 }, internal, subcircuitPins);
    top.addElement(subEl);

    const reg = makeRegistry("And");
    const flat = flattenCircuit(top, reg);

    // The flattened circuit should contain the gate from the internal circuit
    const flatGates = flat.circuit.elements.filter((e) => e.typeId === "And");
    expect(flatGates.length).toBe(1);

    // 1 internal wire (Port pin → And pin) + 1 bridge wire (subcircuit pin → Port pin) = 2
    expect(flat.circuit.wires.length).toBe(2);
  });

  it("matches In/Out elements for INPUT/OUTPUT direction", () => {
    // Internal circuit: In("X") → And gate → Out("Y")
    const internal = new Circuit({ name: "InOutSub" });
    const inEl = makeInElement("in1", "X", { x: 0, y: 0 });
    const outEl = makeOutElement("out1", "Y", { x: 10, y: 0 });
    const gate = makeLeaf("And", "and1", { x: 5, y: 0 });
    internal.addElement(inEl);
    internal.addElement(outEl);
    internal.addElement(gate);
    internal.addWire(new Wire(
      { x: inEl.getPins()[0].position.x, y: inEl.getPins()[0].position.y },
      { x: gate.getPins()[0].position.x, y: gate.getPins()[0].position.y },
    ));

    // Parent circuit with INPUT and OUTPUT pins
    const top = new Circuit({ name: "Top" });
    const subcircuitPins: Pin[] = [
      {
        direction: PinDirection.INPUT,
        position: { x: 20, y: 1 },
        label: "X",
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
    const subEl = new TestSubcircuitElement("InOutSub", "sub1", { x: 20, y: 0 }, internal, subcircuitPins);
    top.addElement(subEl);

    const reg = makeRegistry("And");
    const flat = flattenCircuit(top, reg);

    // Gate should be flattened in
    const flatGates = flat.circuit.elements.filter((e) => e.typeId === "And");
    expect(flatGates.length).toBe(1);

    // 1 internal wire (In pin → And pin) + 2 bridge wires (one per subcircuit pin: X and Y) = 3
    expect(flat.circuit.wires.length).toBe(3);
  });

  it("returns undefined for BIDIRECTIONAL when no Port matches — does not match Out", () => {
    // Internal circuit has an Out("Z") but NO Port("Z")
    const internal = new Circuit({ name: "MismatchSub" });
    const outEl = makeOutElement("out1", "Z", { x: 10, y: 0 });
    const gate = makeLeaf("And", "and1", { x: 5, y: 0 });
    internal.addElement(outEl);
    internal.addElement(gate);

    // Parent with a BIDIRECTIONAL pin "Z" — should NOT match the Out element
    const top = new Circuit({ name: "Top" });
    const subcircuitPins: Pin[] = [
      {
        direction: PinDirection.BIDIRECTIONAL,
        position: { x: 30, y: 1 },
        label: "Z",
        bitWidth: 1,
        isNegated: false,
        isClock: false,
      },
    ];
    const subEl = new TestSubcircuitElement("MismatchSub", "sub1", { x: 30, y: 0 }, internal, subcircuitPins);
    top.addElement(subEl);

    const reg = makeRegistry("And");
    const flat = flattenCircuit(top, reg);

    // Gate should still be flattened
    const flatGates = flat.circuit.elements.filter((e) => e.typeId === "And");
    expect(flatGates.length).toBe(1);

    // No bridge wire for the unmatched BIDIRECTIONAL pin — findInterfaceElement returned undefined
    // The only wires should be from internal wiring, not bridge wires from the subcircuit pin
    const bridgeWires = flat.circuit.wires.filter((w) =>
      (w.start.x === 30 && w.start.y === 1) ||
      (w.end.x === 30 && w.end.y === 1),
    );
    expect(bridgeWires.length).toBe(0);
  });

  it("Port with bitWidth 8 flattens correctly — bus-width preserved across bridge", () => {
    // Internal circuit: Port("BUS") with bitWidth 8
    const internal = new Circuit({ name: "BusSub" });
    const portEl = makePortElement("port-BUS", "BUS", { x: 0, y: 0 }, 8);
    const gate = makeLeaf("And", "and1", { x: 5, y: 0 });
    internal.addElement(portEl);
    internal.addElement(gate);
    internal.addWire(new Wire(
      { x: portEl.getPins()[0].position.x, y: portEl.getPins()[0].position.y },
      { x: gate.getPins()[0].position.x, y: gate.getPins()[0].position.y },
    ));

    // Parent with an 8-bit BIDIRECTIONAL pin
    const top = new Circuit({ name: "Top" });
    const subcircuitPins: Pin[] = [
      {
        direction: PinDirection.BIDIRECTIONAL,
        position: { x: 10, y: 1 },
        label: "BUS",
        bitWidth: 8,
        isNegated: false,
        isClock: false,
      },
    ];
    const subEl = new TestSubcircuitElement("BusSub", "sub1", { x: 10, y: 0 }, internal, subcircuitPins);
    top.addElement(subEl);

    const reg = makeRegistry("And");
    const flat = flattenCircuit(top, reg);

    // Gate flattened
    const flatGates = flat.circuit.elements.filter((e) => e.typeId === "And");
    expect(flatGates.length).toBe(1);

    // 1 internal wire (Port pin → And pin) + 1 bridge wire (subcircuit pin → Port pin) = 2
    expect(flat.circuit.wires.length).toBe(2);

    // Port IS retained in the flattened circuit — assert count unconditionally
    const flatPorts = flat.circuit.elements.filter((e) => e.typeId === "Port");
    expect(flatPorts.length).toBe(1);
    const portPins = flatPorts[0].getPins();
    expect(portPins[0].bitWidth).toBe(8);
  });

  it("bridge wire connects subcircuit pin position to internal Port pin position", () => {
    const portPos = { x: 2, y: 3 };
    const subcircuitPinPos = { x: 15, y: 5 };

    // Internal circuit with Port at known position
    const internal = new Circuit({ name: "PosSub" });
    const portEl = makePortElement("port-P", "P", portPos);
    internal.addElement(portEl);

    // Parent with subcircuit pin at known position
    const top = new Circuit({ name: "Top" });
    const subcircuitPins: Pin[] = [
      {
        direction: PinDirection.BIDIRECTIONAL,
        position: subcircuitPinPos,
        label: "P",
        bitWidth: 1,
        isNegated: false,
        isClock: false,
      },
    ];
    const subEl = new TestSubcircuitElement("PosSub", "sub1", { x: 12, y: 3 }, internal, subcircuitPins);
    top.addElement(subEl);

    const reg = makeRegistry();
    const flat = flattenCircuit(top, reg);

    // Find the bridge wire — one endpoint at subcircuit pin position, other at Port pin position
    const portPinPos = portEl.getPins()[0].position;
    const bridgeWire = flat.circuit.wires.find((w) =>
      (w.start.x === subcircuitPinPos.x && w.start.y === subcircuitPinPos.y &&
       w.end.x === portPinPos.x && w.end.y === portPinPos.y) ||
      (w.end.x === subcircuitPinPos.x && w.end.y === subcircuitPinPos.y &&
       w.start.x === portPinPos.x && w.start.y === portPinPos.y),
    );
    expect(bridgeWire).toBeDefined();

    // Verify the bridge wire connects the expected positions
    const startMatchesSubPin =
      bridgeWire!.start.x === subcircuitPinPos.x && bridgeWire!.start.y === subcircuitPinPos.y;
    const endMatchesSubPin =
      bridgeWire!.end.x === subcircuitPinPos.x && bridgeWire!.end.y === subcircuitPinPos.y;
    const startMatchesPortPin =
      bridgeWire!.start.x === portPinPos.x && bridgeWire!.start.y === portPinPos.y;
    const endMatchesPortPin =
      bridgeWire!.end.x === portPinPos.x && bridgeWire!.end.y === portPinPos.y;

    expect(
      (startMatchesSubPin && endMatchesPortPin) ||
      (startMatchesPortPin && endMatchesSubPin),
    ).toBe(true);
  });
});
