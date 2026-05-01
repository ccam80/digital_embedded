/**
 * Tests for Port-based subcircuit flattening (SE-2).
 *
 * Verifies that findInterfaceElement() recognizes Port elements and that
 * flattening works correctly for Port-based (domain-agnostic) subcircuits.
 */

import { describe, it, expect } from "vitest";
import { Circuit, Wire } from "@/core/circuit";
import type { Pin } from "@/core/pin";
import { PinDirection } from "@/core/pin";
import { PropertyBag } from "@/core/properties";
import { ComponentRegistry, ComponentCategory } from "@/core/registry";
import type { ComponentDefinition } from "@/core/registry";
import { flattenCircuit } from "@/solver/digital/flatten";
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
        digital: { executeFn: (_i: number, _s: Uint32Array, _h: Uint32Array) => {} },
      },
    };
    reg.register(def);
  }
  return reg;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("flattenCircuit- Port interface elements", () => {
  it("Port matched by label creates bridge wire for BIDIRECTIONAL subcircuit pin", () => {
    // Internal circuit: Port("A") → And gate
    const internal = new Circuit({ name: "PortSub" });
    const portEl = makePortElement("port-A", "A", { x: 0, y: 0 });
    const gate = makeLeafElement("And", "and1", { x: 5, y: 0 });
    internal.addElement(portEl);
    internal.addElement(gate);
    internal.addWire(new Wire(
      { x: portEl.position.x + portEl.getPins()[0].position.x, y: portEl.position.y + portEl.getPins()[0].position.y },
      { x: gate.position.x + gate.getPins()[0].position.x, y: gate.position.y + gate.getPins()[0].position.y },
    ));

    // Parent circuit: subcircuit instance with a BIDIRECTIONAL pin named "A"
    const top = new Circuit({ name: "Top" });
    const subcircuitPins: Pin[] = [
      {
        direction: PinDirection.BIDIRECTIONAL,
        position: { x: 0, y: 1 },
        label: "A",
        bitWidth: 1,
        isNegated: false,
        isClock: false,
        kind: "signal",
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
    const gate = makeLeafElement("And", "and1", { x: 5, y: 0 });
    internal.addElement(inEl);
    internal.addElement(outEl);
    internal.addElement(gate);
    internal.addWire(new Wire(
      { x: inEl.position.x + inEl.getPins()[0].position.x, y: inEl.position.y + inEl.getPins()[0].position.y },
      { x: gate.position.x + gate.getPins()[0].position.x, y: gate.position.y + gate.getPins()[0].position.y },
    ));

    // Parent circuit with INPUT and OUTPUT pins
    const top = new Circuit({ name: "Top" });
    const subcircuitPins: Pin[] = [
      {
        direction: PinDirection.INPUT,
        position: { x: 0, y: 1 },
        label: "X",
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

  it("returns undefined for BIDIRECTIONAL when no Port matches- does not match Out", () => {
    // Internal circuit has an Out("Z") but NO Port("Z")
    const internal = new Circuit({ name: "MismatchSub" });
    const outEl = makeOutElement("out1", "Z", { x: 10, y: 0 });
    const gate = makeLeafElement("And", "and1", { x: 5, y: 0 });
    internal.addElement(outEl);
    internal.addElement(gate);

    // Parent with a BIDIRECTIONAL pin "Z"- should NOT match the Out element
    const top = new Circuit({ name: "Top" });
    const subcircuitPins: Pin[] = [
      {
        direction: PinDirection.BIDIRECTIONAL,
        position: { x: 0, y: 1 },
        label: "Z",
        bitWidth: 1,
        isNegated: false,
        isClock: false,
        kind: "signal",
      },
    ];
    const subEl = new TestSubcircuitElement("MismatchSub", "sub1", { x: 30, y: 0 }, internal, subcircuitPins);
    top.addElement(subEl);

    const reg = makeRegistry("And");
    const flat = flattenCircuit(top, reg);

    // Gate should still be flattened
    const flatGates = flat.circuit.elements.filter((e) => e.typeId === "And");
    expect(flatGates.length).toBe(1);

    // No bridge wire for the unmatched BIDIRECTIONAL pin- findInterfaceElement returned undefined
    // The only wires should be from internal wiring, not bridge wires from the subcircuit pin
    const bridgeWires = flat.circuit.wires.filter((w) =>
      (w.start.x === 30 && w.start.y === 1) ||
      (w.end.x === 30 && w.end.y === 1),
    );
    expect(bridgeWires.length).toBe(0);
  });

  it("Port with bitWidth 8 flattens correctly- bus-width preserved across bridge", () => {
    // Internal circuit: Port("BUS") with bitWidth 8
    const internal = new Circuit({ name: "BusSub" });
    const portEl = makePortElement("port-BUS", "BUS", { x: 0, y: 0 }, 8);
    const gate = makeLeafElement("And", "and1", { x: 5, y: 0 });
    internal.addElement(portEl);
    internal.addElement(gate);
    internal.addWire(new Wire(
      { x: portEl.position.x + portEl.getPins()[0].position.x, y: portEl.position.y + portEl.getPins()[0].position.y },
      { x: gate.position.x + gate.getPins()[0].position.x, y: gate.position.y + gate.getPins()[0].position.y },
    ));

    // Parent with an 8-bit BIDIRECTIONAL pin
    const top = new Circuit({ name: "Top" });
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
    const subEl = new TestSubcircuitElement("BusSub", "sub1", { x: 10, y: 0 }, internal, subcircuitPins);
    top.addElement(subEl);

    const reg = makeRegistry("And");
    const flat = flattenCircuit(top, reg);

    // Gate flattened
    const flatGates = flat.circuit.elements.filter((e) => e.typeId === "And");
    expect(flatGates.length).toBe(1);

    // 1 internal wire (Port pin → And pin) + 1 bridge wire (subcircuit pin → Port pin) = 2
    expect(flat.circuit.wires.length).toBe(2);

    // Port IS retained in the flattened circuit- assert count unconditionally
    const flatPorts = flat.circuit.elements.filter((e) => e.typeId === "Port");
    expect(flatPorts.length).toBe(1);
    const portPins = flatPorts[0].getPins();
    expect(portPins[0].bitWidth).toBe(8);
  });

  it("bridge wire connects subcircuit pin position to internal Port pin position", () => {
    const portPos = { x: 2, y: 3 };
    // subcircuitPinChip is chip-relative; subEl is at {12,3} → world pin = {12+3, 3+2} = {15,5}
    const subcircuitPinChip = { x: 3, y: 2 };
    const subElPos = { x: 12, y: 3 };
    const expectedSubPinWorld = { x: subElPos.x + subcircuitPinChip.x, y: subElPos.y + subcircuitPinChip.y }; // {15,5}
    // portEl at {2,3} with chip-relative pin {0,1} → world pin = {2+0, 3+1} = {2,4}
    const expectedPortPinWorld = { x: portPos.x + 0, y: portPos.y + 1 }; // {2,4}

    // Internal circuit with Port at known position
    const internal = new Circuit({ name: "PosSub" });
    const portEl = makePortElement("port-P", "P", portPos);
    internal.addElement(portEl);

    // Parent with subcircuit pin at chip-relative position
    const top = new Circuit({ name: "Top" });
    const subcircuitPins: Pin[] = [
      {
        direction: PinDirection.BIDIRECTIONAL,
        position: subcircuitPinChip,
        label: "P",
        bitWidth: 1,
        isNegated: false,
        isClock: false,
        kind: "signal",
      },
    ];
    const subEl = new TestSubcircuitElement("PosSub", "sub1", subElPos, internal, subcircuitPins);
    top.addElement(subEl);

    const reg = makeRegistry();
    const flat = flattenCircuit(top, reg);

    // Find the bridge wire- endpoints at world positions: subcircuit pin world and Port pin world
    const bridgeWire = flat.circuit.wires.find((w) =>
      (w.start.x === expectedSubPinWorld.x && w.start.y === expectedSubPinWorld.y &&
       w.end.x === expectedPortPinWorld.x && w.end.y === expectedPortPinWorld.y) ||
      (w.end.x === expectedSubPinWorld.x && w.end.y === expectedSubPinWorld.y &&
       w.start.x === expectedPortPinWorld.x && w.start.y === expectedPortPinWorld.y),
    );
    expect(bridgeWire).toBeDefined();

    // Verify the bridge wire connects the expected positions
    const startMatchesSubPin =
      bridgeWire!.start.x === expectedSubPinWorld.x && bridgeWire!.start.y === expectedSubPinWorld.y;
    const endMatchesSubPin =
      bridgeWire!.end.x === expectedSubPinWorld.x && bridgeWire!.end.y === expectedSubPinWorld.y;
    const startMatchesPortPin =
      bridgeWire!.start.x === expectedPortPinWorld.x && bridgeWire!.start.y === expectedPortPinWorld.y;
    const endMatchesPortPin =
      bridgeWire!.end.x === expectedPortPinWorld.x && bridgeWire!.end.y === expectedPortPinWorld.y;

    expect(
      (startMatchesSubPin && endMatchesPortPin) ||
      (startMatchesPortPin && endMatchesSubPin),
    ).toBe(true);
  });
});
