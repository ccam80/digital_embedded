/**
 * Tests for insert-subcircuit boundary analysis and circuit extraction.
 */

import { describe, it, expect } from "vitest";
import { Circuit, Wire } from "@/core/circuit";
import { PinDirection } from "@/core/pin";
import type { Pin } from "@/core/pin";
import type { CircuitElement } from "@/core/element";
import type { RenderContext, Rect } from "@/core/renderer-interface";
import { PropertyBag } from "@/core/properties";
import type { PropertyValue } from "@/core/properties";
import type { SerializedElement } from "@/core/element";
import type { BoundaryPort } from "../insert-subcircuit";
import {
  analyzeBoundary,
  extractSubcircuit,
  insertAsSubcircuit,
} from "../insert-subcircuit";
import { SubcircuitElement } from "@/components/subcircuit/subcircuit";

// ---------------------------------------------------------------------------
// Minimal test element
// ---------------------------------------------------------------------------

function makeTestElement(
  instanceId: string,
  pins: Pin[],
  label = "",
): CircuitElement {
  const props = new PropertyBag();
  if (label) props.set("label", label);
  return {
    typeId: "TestGate",
    instanceId,
    position: { x: 0, y: 0 },
    rotation: 0 as const,
    mirror: false,
    getPins(): readonly Pin[] {
      return pins;
    },
    getProperties(): PropertyBag {
      return props;
    },
    draw(_ctx: RenderContext): void {},
    getBoundingBox(): Rect {
      return { x: 0, y: 0, width: 2, height: 2 };
    },
    serialize(): SerializedElement {
      return {
        typeId: "TestGate",
        instanceId,
        position: { x: 0, y: 0 },
        rotation: 0 as const,
        mirror: false,
        properties: {},
      };
    },
    getHelpText(): string {
      return "";
    },
    getAttribute(_name: string): PropertyValue | undefined {
      return undefined;
    },
  };
}

function makePin(
  label: string,
  direction: PinDirection,
  x: number,
  y: number,
  bitWidth = 1,
): Pin {
  return {
    label,
    direction,
    position: { x, y },
    bitWidth,
    isNegated: false,
    isClock: false,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("InsertSubcircuit", () => {
  it("analyzesBoundaryPorts_returnsBoundaryPortArray", () => {
    // Element A has an output pin at (4, 1).
    // Element B has an input pin at (6, 1).
    // Wire runs from (4, 1) to (6, 1).
    // Only element A is selected — the wire crosses the boundary.

    const pinA = makePin("Y", PinDirection.OUTPUT, 4, 1, 2);
    const pinB = makePin("A", PinDirection.INPUT, 6, 1, 2);
    const elementA = makeTestElement("el-A", [pinA]);
    const elementB = makeTestElement("el-B", [pinB]);

    const circuit = new Circuit();
    circuit.addElement(elementA);
    circuit.addElement(elementB);

    const wire = new Wire({ x: 4, y: 1 }, { x: 6, y: 1 });
    circuit.addWire(wire);

    const result = analyzeBoundary(circuit, [elementA], []);

    // Returns BoundaryPort[] — no direction field
    expect(result.boundaryPorts).toHaveLength(1);
    const port = result.boundaryPorts[0] as BoundaryPort;
    expect(port.wire).toBe(wire);
    expect(port.bitWidth).toBe(2);
    expect(port.label).toBe("Y");
    expect(port.position).toEqual({ x: 4, y: 1 });
    // Must not have a direction field
    expect("direction" in port).toBe(false);
    expect(result.internalWires).toHaveLength(0);
  });

  it("classifiesInternalWires", () => {
    // Both endpoints of the wire land on pins of selected elements.
    // When both elements are selected, the wire is internal.
    const pinA = makePin("Y", PinDirection.OUTPUT, 4, 1);
    const pinB = makePin("A", PinDirection.INPUT, 6, 1);
    const elementA = makeTestElement("el-A", [pinA]);
    const elementB = makeTestElement("el-B", [pinB]);

    const circuit = new Circuit();
    circuit.addElement(elementA);
    circuit.addElement(elementB);

    const wire = new Wire({ x: 4, y: 1 }, { x: 6, y: 1 });
    circuit.addWire(wire);

    // Both elements are selected — wire is internal.
    const result = analyzeBoundary(circuit, [elementA, elementB], [wire]);

    expect(result.internalWires).toHaveLength(1);
    expect(result.internalWires[0]).toBe(wire);
    expect(result.boundaryPorts).toHaveLength(0);
  });

  it("labelDeduplication_twoBoundaryWiresBothLabeledOut", () => {
    // Two elements each with a pin labeled "out", both selected.
    // A third external element connects to both via boundary wires.
    // Labels must be deduplicated to "out" and "out_2".
    const pinA = makePin("out", PinDirection.OUTPUT, 4, 1);
    const pinB = makePin("out", PinDirection.OUTPUT, 4, 3);
    const elementA = makeTestElement("el-A", [pinA]);
    const elementB = makeTestElement("el-B", [pinB]);

    const externalPin = makePin("in", PinDirection.INPUT, 6, 1);
    const externalPin2 = makePin("in", PinDirection.INPUT, 6, 3);
    const elementExt = makeTestElement("el-ext", [externalPin, externalPin2]);

    const circuit = new Circuit();
    circuit.addElement(elementA);
    circuit.addElement(elementB);
    circuit.addElement(elementExt);

    const wire1 = new Wire({ x: 4, y: 1 }, { x: 6, y: 1 });
    const wire2 = new Wire({ x: 4, y: 3 }, { x: 6, y: 3 });
    circuit.addWire(wire1);
    circuit.addWire(wire2);

    const result = analyzeBoundary(circuit, [elementA, elementB], []);

    expect(result.boundaryPorts).toHaveLength(2);
    const labels = result.boundaryPorts.map(p => p.label).sort();
    expect(labels).toEqual(["out", "out_2"]);
  });

  it("zeroBoundaryCrossings_returnsEmptyBoundaryPorts", () => {
    // Two elements connected internally, no wires to external elements.
    const pinA = makePin("Y", PinDirection.OUTPUT, 4, 1);
    const pinB = makePin("A", PinDirection.INPUT, 6, 1);
    const elementA = makeTestElement("el-A", [pinA]);
    const elementB = makeTestElement("el-B", [pinB]);

    const circuit = new Circuit();
    circuit.addElement(elementA);
    circuit.addElement(elementB);

    const wire = new Wire({ x: 4, y: 1 }, { x: 6, y: 1 });
    circuit.addWire(wire);

    // Both elements selected — wire is internal, no boundary crossings.
    const result = analyzeBoundary(circuit, [elementA, elementB], []);

    expect(result.boundaryPorts).toHaveLength(0);
    expect(result.internalWires).toHaveLength(1);
  });

  it("extractedSubcircuit_containsPortElements_notInOut", () => {
    // Element A output pin at (4, 1) — one boundary crossing.
    const pinA = makePin("Y", PinDirection.OUTPUT, 4, 1);
    const elementA = makeTestElement("el-A", [pinA]);

    const boundaryPorts: BoundaryPort[] = [
      {
        wire: new Wire({ x: 4, y: 1 }, { x: 6, y: 1 }),
        label: "Y",
        bitWidth: 1,
        position: { x: 4, y: 1 },
      },
    ];

    const extracted = extractSubcircuit([elementA], [], boundaryPorts);

    // The extracted circuit contains the selected element.
    expect(extracted.elements).toContain(elementA);

    // There must be Port elements (not In or Out) for boundary crossings.
    const portEls = extracted.elements.filter(el => el.typeId === "Port");
    const inEls = extracted.elements.filter(el => el.typeId === "In");
    const outEls = extracted.elements.filter(el => el.typeId === "Out");

    expect(portEls).toHaveLength(1);
    expect(inEls).toHaveLength(0);
    expect(outEls).toHaveLength(0);

    // Port element has correct label and bitWidth.
    const portEl = portEls[0];
    expect(portEl.getProperties().getOrDefault("label", "")).toBe("Y");
    expect(portEl.getProperties().getOrDefault("bitWidth", 0)).toBe(1);
    expect(portEl.position).toEqual({ x: 4, y: 1 });
  });

  it("preservesInternalWiring", () => {
    const pinA = makePin("Y", PinDirection.OUTPUT, 4, 1);
    const pinB = makePin("A", PinDirection.INPUT, 6, 1);
    const elementA = makeTestElement("el-A", [pinA]);
    const elementB = makeTestElement("el-B", [pinB]);
    const internalWire = new Wire({ x: 4, y: 1 }, { x: 6, y: 1 });

    const extracted = extractSubcircuit(
      [elementA, elementB],
      [internalWire],
      [],
    );

    expect(extracted.wires).toContain(internalWire);
    expect(extracted.elements).toContain(elementA);
    expect(extracted.elements).toContain(elementB);
  });

  it("insertReturnsSubcircuitAndCommand", () => {
    const pinA = makePin("Y", PinDirection.OUTPUT, 4, 1);
    const elementA = makeTestElement("el-A", [pinA]);

    const circuit = new Circuit();
    circuit.addElement(elementA);

    const result = insertAsSubcircuit(circuit, [elementA], []);
    expect(result.subcircuit).toBeDefined();
    expect(result.command).toBeDefined();
    expect(result.command.description).toBe("Insert selection as subcircuit");
  });

  it("undo_restoresAllOriginalElementsAndWires", () => {
    // Setup: elementA (output) → wire → elementB (input), elementB is external.
    const pinA = makePin("Y", PinDirection.OUTPUT, 4, 1);
    const pinB = makePin("A", PinDirection.INPUT, 6, 1);
    const elementA = makeTestElement("el-A", [pinA]);
    const elementB = makeTestElement("el-B", [pinB]);

    const circuit = new Circuit();
    circuit.addElement(elementA);
    circuit.addElement(elementB);

    const boundaryWire = new Wire({ x: 4, y: 1 }, { x: 6, y: 1 });
    circuit.addWire(boundaryWire);

    // Only elementA is selected — boundaryWire crosses the boundary.
    const { command } = insertAsSubcircuit(circuit, [elementA], []);

    // Execute removes elementA and the boundary wire.
    command.execute();
    expect(circuit.elements).not.toContain(elementA);
    expect(circuit.wires).not.toContain(boundaryWire);

    // Undo restores them.
    command.undo();
    expect(circuit.elements).toContain(elementA);
    expect(circuit.wires).toContain(boundaryWire);
  });

  // ---------------------------------------------------------------------------
  // SE-5: Instance placement tests
  // ---------------------------------------------------------------------------

  it("instancePlacement_returnsSubcircuitElementWithCorrectTypeId", () => {
    // elementA at (0,0) has an output pin at (4,1); elementB is external.
    const pinA = makePin("Y", PinDirection.OUTPUT, 4, 1);
    const pinB = makePin("A", PinDirection.INPUT, 6, 1);
    const elementA = makeTestElement("el-A", [pinA]);
    const elementB = makeTestElement("el-B", [pinB]);

    const circuit = new Circuit();
    circuit.addElement(elementA);
    circuit.addElement(elementB);
    circuit.addWire(new Wire({ x: 4, y: 1 }, { x: 6, y: 1 }));

    const result = insertAsSubcircuit(circuit, [elementA], [], undefined, "MyAdder");

    // The returned instance must be a SubcircuitElement.
    expect(result.instance).toBeInstanceOf(SubcircuitElement);

    // typeId must follow "Subcircuit:{name}" format.
    expect(result.instance.typeId).toBe("Subcircuit:MyAdder");
  });

  it("instancePlacement_execute_addsSubcircuitElementToCircuit", () => {
    const pinA = makePin("Y", PinDirection.OUTPUT, 4, 1);
    const pinB = makePin("A", PinDirection.INPUT, 6, 1);
    const elementA = makeTestElement("el-A", [pinA]);
    const elementB = makeTestElement("el-B", [pinB]);

    const circuit = new Circuit();
    circuit.addElement(elementA);
    circuit.addElement(elementB);
    circuit.addWire(new Wire({ x: 4, y: 1 }, { x: 6, y: 1 }));

    const { command, instance } = insertAsSubcircuit(circuit, [elementA], [], undefined, "TestSC");

    command.execute();

    // Original element removed, subcircuit instance added.
    expect(circuit.elements).not.toContain(elementA);
    expect(circuit.elements).toContain(instance);
  });

  it("instancePlacement_undo_removesInstanceAndRestoresOriginals", () => {
    const pinA = makePin("Y", PinDirection.OUTPUT, 4, 1);
    const pinB = makePin("A", PinDirection.INPUT, 6, 1);
    const elementA = makeTestElement("el-A", [pinA]);
    const elementB = makeTestElement("el-B", [pinB]);

    const circuit = new Circuit();
    circuit.addElement(elementA);
    circuit.addElement(elementB);

    const boundaryWire = new Wire({ x: 4, y: 1 }, { x: 6, y: 1 });
    circuit.addWire(boundaryWire);

    const { command, instance } = insertAsSubcircuit(circuit, [elementA], [], undefined, "TestSC");

    command.execute();
    command.undo();

    // Original element and wire restored.
    expect(circuit.elements).toContain(elementA);
    expect(circuit.wires).toContain(boundaryWire);

    // Subcircuit instance no longer present.
    expect(circuit.elements).not.toContain(instance);
  });

  it("instancePlacement_boundaryWiresReconnectedToSubcircuitPins", () => {
    // elementA at (0,0) with output pin at (4,1).
    // elementB at (8,0) with input pin at (6,1) — external.
    // Boundary wire: (4,1) → (6,1).
    // After execute(), the reconnected wire must connect the external endpoint
    // (6,1) to the subcircuit instance's pin for label "Y".
    const pinA = makePin("Y", PinDirection.OUTPUT, 4, 1);
    const pinB = makePin("A", PinDirection.INPUT, 6, 1);
    const elementA = makeTestElement("el-A", [pinA]);
    const elementB = makeTestElement("el-B", [pinB]);

    const circuit = new Circuit();
    circuit.addElement(elementA);
    circuit.addElement(elementB);
    circuit.addWire(new Wire({ x: 4, y: 1 }, { x: 6, y: 1 }));

    const { command } = insertAsSubcircuit(circuit, [elementA], [], undefined, "SC");

    command.execute();

    // The original boundary wire is gone.
    const origWire = circuit.wires.find(
      w => w.start.x === 4 && w.start.y === 1 && w.end.x === 6 && w.end.y === 1
    );
    expect(origWire).toBeUndefined();

    // A new reconnected wire must exist connecting to the external endpoint (6,1).
    const reconnectedWire = circuit.wires.find(
      w =>
        (w.start.x === 6 && w.start.y === 1) ||
        (w.end.x === 6 && w.end.y === 1)
    );
    expect(reconnectedWire).toBeDefined();
  });

  it("instancePlacement_positionedAtCentroidOfSelection", () => {
    // Two elements at (0,0) and (4,0) — centroid is (2,0).
    const pinA = makePin("out", PinDirection.OUTPUT, 2, 0);
    const pinC = makePin("in", PinDirection.INPUT, 8, 0);
    const elementA = makeTestElement("el-A", [pinA]);
    const elementA2 = makeTestElement("el-A2", [makePin("X", PinDirection.INPUT, 0, 0)]);

    // Position elementA at (0,0), elementA2 at (4,0)
    (elementA as { position: { x: number; y: number } }).position = { x: 0, y: 0 };
    (elementA2 as { position: { x: number; y: number } }).position = { x: 4, y: 0 };

    const elementC = makeTestElement("el-C", [pinC]);

    const circuit = new Circuit();
    circuit.addElement(elementA);
    circuit.addElement(elementA2);
    circuit.addElement(elementC);
    circuit.addWire(new Wire({ x: 2, y: 0 }, { x: 8, y: 0 }));

    const { instance } = insertAsSubcircuit(circuit, [elementA, elementA2], [], undefined, "SC2");

    // Centroid of (0,0) and (4,0) is (2,0) — grid-snapped stays (2,0).
    expect(instance.position).toEqual({ x: 2, y: 0 });
  });
});
