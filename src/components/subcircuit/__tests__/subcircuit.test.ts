/**
 * Framework destination for `deriveInterfacePins` BIDIRECTIONAL / face / label
 * rules (per Wave-3 disposition table). Subcircuit is a SUBCIRCUIT-category
 * infrastructure component flattened before simulation: it has no analog model,
 * no setup()/load() state, no transient behaviour, no digital outputSchema,
 * and `executeSubcircuit` is a no-op. None of Canon Categories 1-15 apply.
 *
 * The pin-derivation rules audited here are the only canonical contract this
 * file owns: how In/Out/Port elements inside a Circuit translate into the
 * subcircuit's external PinDeclaration[] interface (direction, face, bitWidth,
 * document order).
 */

import { describe, it, expect } from "vitest";
import { Circuit } from "../../../core/circuit.js";
import { PropertyBag } from "../../../core/properties.js";
import type { PropertyValue } from "../../../core/properties.js";
import type { CircuitElement } from "../../../core/element.js";
import type { Rotation, PinDeclaration } from "../../../core/pin.js";
import { PinDirection } from "../../../core/pin.js";
import { InElement } from "../../io/in.js";
import { OutElement } from "../../io/out.js";
import { PortElement } from "../../io/port.js";
import { ClockElement } from "../../io/clock.js";
import { deriveInterfacePins } from "../pin-derivation.js";

// ---------------------------------------------------------------------------
// Fixture helpers — build real In/Out/Port/Clock elements via their concrete
// element classes (no type-bypass casts; no engine impersonators). Pin
// derivation walks circuit.elements and reads typeId / position / rotation /
// properties only — no simulator state is involved.
// ---------------------------------------------------------------------------

type InterfaceTypeId = "In" | "Out" | "Port" | "Clock";

interface MakeElementOptions {
  bitWidth?: number;
  rotation?: Rotation;
  position?: { x: number; y: number };
  face?: "left" | "right" | "top" | "bottom";
  sortOrder?: number;
}

function makeElement(
  typeId: InterfaceTypeId,
  label: string,
  options: MakeElementOptions = {},
): CircuitElement {
  const entries: [string, PropertyValue][] = [
    ["label", label],
    ["bitWidth", options.bitWidth ?? 1],
  ];
  if (typeId === "Port") {
    entries.push(["face", options.face ?? "left"]);
    entries.push(["sortOrder", options.sortOrder ?? 0]);
  }
  const props = new PropertyBag(entries);
  const position = options.position ?? { x: 0, y: 0 };
  const rotation: Rotation = options.rotation ?? 0;
  const instanceId = "inst-" + typeId + "-" + label;

  switch (typeId) {
    case "In":
      return new InElement(instanceId, position, rotation, false, props);
    case "Out":
      return new OutElement(instanceId, position, rotation, false, props);
    case "Port":
      return new PortElement(instanceId, position, rotation, false, props);
    case "Clock":
      return new ClockElement(instanceId, position, rotation, false, props);
  }
}

function buildCircuit(name: string, elements: CircuitElement[]): Circuit {
  const circuit = new Circuit({ name });
  for (const el of elements) circuit.addElement(el);
  return circuit;
}

// ---------------------------------------------------------------------------
// deriveInterfacePins — direction rule
// ---------------------------------------------------------------------------

describe("deriveInterfacePins direction rule", () => {
  it("In elements produce INPUT pins and Out elements produce OUTPUT pins", () => {
    const circuit = buildCircuit("HalfAdder", [
      makeElement("In", "A"),
      makeElement("In", "B"),
      makeElement("Out", "S"),
    ]);

    const pins = deriveInterfacePins(circuit);

    expect(pins).toHaveLength(3);
    const inputs = pins.filter((p) => p.direction === PinDirection.INPUT);
    const outputs = pins.filter((p) => p.direction === PinDirection.OUTPUT);
    expect(inputs).toHaveLength(2);
    expect(outputs).toHaveLength(1);
    expect(inputs[0].label).toBe("A");
    expect(inputs[1].label).toBe("B");
    expect(outputs[0].label).toBe("S");
  });

  it("Port elements produce BIDIRECTIONAL pins", () => {
    const circuit = buildCircuit("PortGate", [
      makeElement("Port", "A"),
      makeElement("Port", "B"),
      makeElement("Port", "Y"),
    ]);

    const pins = deriveInterfacePins(circuit);

    expect(pins).toHaveLength(3);
    const bidir = pins.filter((p) => p.direction === PinDirection.BIDIRECTIONAL);
    expect(bidir).toHaveLength(3);
    expect(bidir[0].label).toBe("A");
    expect(bidir[1].label).toBe("B");
    expect(bidir[2].label).toBe("Y");
  });

  it("Clock elements produce INPUT pins like In elements", () => {
    const circuit = buildCircuit("ClockedChip", [
      makeElement("Clock", "CLK"),
      makeElement("Out", "Q"),
    ]);

    const pins = deriveInterfacePins(circuit);

    expect(pins).toHaveLength(2);
    expect(pins[0].direction).toBe(PinDirection.INPUT);
    expect(pins[0].label).toBe("CLK");
    expect(pins[1].direction).toBe(PinDirection.OUTPUT);
    expect(pins[1].label).toBe("Q");
  });

  it("mixed Port + In + Out yields a mix of BIDIRECTIONAL / INPUT / OUTPUT", () => {
    const circuit = buildCircuit("MixedChip", [
      makeElement("Port", "P"),
      makeElement("In", "A"),
      makeElement("Out", "Y"),
    ]);

    const pins = deriveInterfacePins(circuit);

    expect(pins).toHaveLength(3);
    const bidir = pins.filter((p) => p.direction === PinDirection.BIDIRECTIONAL);
    const inputs = pins.filter((p) => p.direction === PinDirection.INPUT);
    const outputs = pins.filter((p) => p.direction === PinDirection.OUTPUT);
    expect(bidir).toHaveLength(1);
    expect(bidir[0].label).toBe("P");
    expect(inputs).toHaveLength(1);
    expect(inputs[0].label).toBe("A");
    expect(outputs).toHaveLength(1);
    expect(outputs[0].label).toBe("Y");
  });
});

// ---------------------------------------------------------------------------
// deriveInterfacePins — bitWidth rule
// ---------------------------------------------------------------------------

describe("deriveInterfacePins bitWidth rule", () => {
  it("preserves bitWidth from In/Out element properties on the derived pin", () => {
    const circuit = buildCircuit("Wide", [
      makeElement("In", "data", { bitWidth: 8 }),
      makeElement("Out", "result", { bitWidth: 4 }),
    ]);

    const pins = deriveInterfacePins(circuit);

    const inPin = pins.find((p) => p.label === "data")!;
    const outPin = pins.find((p) => p.label === "result")!;
    expect(inPin.defaultBitWidth).toBe(8);
    expect(outPin.defaultBitWidth).toBe(4);
  });

  it("preserves bitWidth from Port element properties", () => {
    const circuit = buildCircuit("WidePort", [
      makeElement("Port", "bus", { bitWidth: 16 }),
    ]);

    const pins = deriveInterfacePins(circuit);

    expect(pins).toHaveLength(1);
    expect(pins[0].label).toBe("bus");
    expect(pins[0].defaultBitWidth).toBe(16);
  });

  it("defaults bitWidth to 1 when the element omits the property", () => {
    const circuit = buildCircuit("Default1", [
      makeElement("In", "single"),
      makeElement("Out", "alone"),
    ]);

    const pins = deriveInterfacePins(circuit);

    expect(pins[0].defaultBitWidth).toBe(1);
    expect(pins[1].defaultBitWidth).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// deriveInterfacePins — face rule (rotation-driven for In/Out, property-driven for Port)
// ---------------------------------------------------------------------------

describe("deriveInterfacePins face rule", () => {
  it("In rotation 0/1/2/3 maps to face left/bottom/right/top", () => {
    const circuit = buildCircuit("InRot", [
      makeElement("In", "L", { rotation: 0 }),
      makeElement("In", "B", { rotation: 1 }),
      makeElement("In", "R", { rotation: 2 }),
      makeElement("In", "T", { rotation: 3 }),
    ]);

    const pins = deriveInterfacePins(circuit);
    const byLabel = new Map(pins.map((p) => [p.label, p as PinDeclaration & { face?: string }]));
    expect(byLabel.get("L")!.face).toBe("left");
    expect(byLabel.get("B")!.face).toBe("bottom");
    expect(byLabel.get("R")!.face).toBe("right");
    expect(byLabel.get("T")!.face).toBe("top");
  });

  it("Out rotation 0/1/2/3 maps to face right/top/left/bottom", () => {
    const circuit = buildCircuit("OutRot", [
      makeElement("Out", "R", { rotation: 0 }),
      makeElement("Out", "T", { rotation: 1 }),
      makeElement("Out", "L", { rotation: 2 }),
      makeElement("Out", "B", { rotation: 3 }),
    ]);

    const pins = deriveInterfacePins(circuit);
    const byLabel = new Map(pins.map((p) => [p.label, p as PinDeclaration & { face?: string }]));
    expect(byLabel.get("R")!.face).toBe("right");
    expect(byLabel.get("T")!.face).toBe("top");
    expect(byLabel.get("L")!.face).toBe("left");
    expect(byLabel.get("B")!.face).toBe("bottom");
  });

  it("Port face property controls pin face directly (not rotation)", () => {
    const circuit = buildCircuit("FaceChip", [
      makeElement("Port", "L", { face: "left" }),
      makeElement("Port", "R", { face: "right" }),
      makeElement("Port", "T", { face: "top" }),
      makeElement("Port", "B", { face: "bottom" }),
    ]);

    const pins = deriveInterfacePins(circuit);

    expect(pins).toHaveLength(4);
    expect((pins[0] as PinDeclaration & { face?: string }).face).toBe("left");
    expect((pins[1] as PinDeclaration & { face?: string }).face).toBe("right");
    expect((pins[2] as PinDeclaration & { face?: string }).face).toBe("top");
    expect((pins[3] as PinDeclaration & { face?: string }).face).toBe("bottom");
  });
});

// ---------------------------------------------------------------------------
// deriveInterfacePins — document-order rule
// ---------------------------------------------------------------------------

describe("deriveInterfacePins document-order rule", () => {
  it("INPUT pins appear in the order their In elements appear in circuit.elements", () => {
    const circuit = buildCircuit("Ordered", [
      makeElement("In", "first"),
      makeElement("In", "second"),
      makeElement("In", "third"),
      makeElement("Out", "result"),
    ]);

    const pins = deriveInterfacePins(circuit);
    const inputs = pins.filter((p) => p.direction === PinDirection.INPUT);

    expect(inputs[0].label).toBe("first");
    expect(inputs[1].label).toBe("second");
    expect(inputs[2].label).toBe("third");
  });

  it("OUTPUT pins appear in the order their Out elements appear in circuit.elements", () => {
    const circuit = buildCircuit("MultiOut", [
      makeElement("In", "x"),
      makeElement("Out", "sum"),
      makeElement("Out", "carry"),
    ]);

    const pins = deriveInterfacePins(circuit);
    const outputs = pins.filter((p) => p.direction === PinDirection.OUTPUT);

    expect(outputs[0].label).toBe("sum");
    expect(outputs[1].label).toBe("carry");
  });

  it("BIDIRECTIONAL pins appear in the order their Port elements appear in circuit.elements", () => {
    const circuit = buildCircuit("PortOrder", [
      makeElement("Port", "alpha"),
      makeElement("Port", "beta"),
      makeElement("Port", "gamma"),
    ]);

    const pins = deriveInterfacePins(circuit);
    const bidir = pins.filter((p) => p.direction === PinDirection.BIDIRECTIONAL);

    expect(bidir[0].label).toBe("alpha");
    expect(bidir[1].label).toBe("beta");
    expect(bidir[2].label).toBe("gamma");
  });

  it("In + Port + Out interleaved preserves global document order across direction kinds", () => {
    const circuit = buildCircuit("Interleaved", [
      makeElement("In", "a"),
      makeElement("Port", "p"),
      makeElement("Out", "y"),
      makeElement("In", "b"),
      makeElement("Out", "z"),
    ]);

    const pins = deriveInterfacePins(circuit);

    expect(pins.map((p) => p.label)).toEqual(["a", "p", "y", "b", "z"]);
  });
});

// ---------------------------------------------------------------------------
// deriveInterfacePins — label-fallback rule
// ---------------------------------------------------------------------------

describe("deriveInterfacePins label fallback", () => {
  it("In element without a label falls back to in<N> derived from emission index", () => {
    const circuit = buildCircuit("EmptyLabel", [
      makeElement("In", ""),
      makeElement("In", ""),
      makeElement("Out", ""),
    ]);

    const pins = deriveInterfacePins(circuit);

    expect(pins[0].label).toBe("in0");
    expect(pins[1].label).toBe("in1");
    expect(pins[2].label).toBe("out2");
  });

  it("Port element without a label falls back to port<N>", () => {
    const circuit = buildCircuit("EmptyPortLabel", [
      makeElement("Port", ""),
      makeElement("Port", ""),
    ]);

    const pins = deriveInterfacePins(circuit);

    expect(pins[0].label).toBe("port0");
    expect(pins[1].label).toBe("port1");
  });
});
