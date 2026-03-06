/**
 * Tests for insert-subcircuit boundary analysis and circuit extraction.
 */

import { describe, it, expect } from "vitest";
import { Circuit, Wire } from "@/core/circuit";
import { PinDirection } from "@/core/pin";
import type { Pin, PinDeclaration } from "@/core/pin";
import type { CircuitElement } from "@/core/element";
import type { RenderContext, Rect } from "@/core/renderer-interface";
import { PropertyBag } from "@/core/properties";
import type { PropertyValue } from "@/core/properties";
import type { SerializedElement } from "@/core/element";
import { FacadeError } from "@/headless/types";
import {
  analyzeBoundary,
  extractSubcircuit,
  insertAsSubcircuit,
} from "../insert-subcircuit";

// ---------------------------------------------------------------------------
// Minimal test element
// ---------------------------------------------------------------------------

function makeTestElement(
  instanceId: string,
  pins: Pin[],
): CircuitElement {
  const props = new PropertyBag();
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
  it("analyzesBoundaryWires", () => {
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

    expect(result.boundaryWires).toHaveLength(1);
    expect(result.boundaryWires[0].wire).toBe(wire);
    expect(result.boundaryWires[0].direction).toBe(PinDirection.OUTPUT);
    expect(result.boundaryWires[0].bitWidth).toBe(2);
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
    expect(result.boundaryWires).toHaveLength(0);
  });

  it("extractsCircuitWithBoundaryPins", () => {
    const pinA = makePin("Y", PinDirection.OUTPUT, 4, 1);
    const elementA = makeTestElement("el-A", [pinA]);

    const boundaryPins: PinDeclaration[] = [
      {
        direction: PinDirection.OUTPUT,
        label: "Y_out",
        defaultBitWidth: 1,
        position: { x: 4, y: 1 },
        isNegatable: false,
        isClockCapable: false,
      },
      {
        direction: PinDirection.INPUT,
        label: "A_in",
        defaultBitWidth: 1,
        position: { x: 2, y: 1 },
        isNegatable: false,
        isClockCapable: false,
      },
    ];

    const extracted = extractSubcircuit([elementA], [], boundaryPins);

    // The extracted circuit contains the selected element.
    expect(extracted.elements).toContain(elementA);

    // The description encodes the boundary pins for Phase 6 consumption.
    const decoded = JSON.parse(extracted.metadata.description) as PinDeclaration[];
    expect(decoded).toHaveLength(2);
    expect(decoded[0].direction).toBe(PinDirection.OUTPUT);
    expect(decoded[0].label).toBe("Y_out");
    expect(decoded[1].direction).toBe(PinDirection.INPUT);
    expect(decoded[1].label).toBe("A_in");
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

  it("insertThrowsUntilPhase6", () => {
    const pinA = makePin("Y", PinDirection.OUTPUT, 4, 1);
    const elementA = makeTestElement("el-A", [pinA]);

    const circuit = new Circuit();
    circuit.addElement(elementA);

    expect(() => {
      insertAsSubcircuit(circuit, [elementA], []);
    }).toThrow(FacadeError);

    expect(() => {
      insertAsSubcircuit(circuit, [elementA], []);
    }).toThrow("Subcircuit component type not yet available");
  });
});
