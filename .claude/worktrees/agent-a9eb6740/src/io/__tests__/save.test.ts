/**
 * Tests for src/io/save.ts — JSON circuit serialization.
 */

import { describe, it, expect } from "vitest";
import { serializeCircuit, SAVE_FORMAT_VERSION, encodeBigint } from "../save.js";
import { Circuit, Wire } from "../../core/circuit.js";
import { AbstractCircuitElement } from "../../core/element.js";
import { PropertyBag } from "../../core/properties.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { Pin } from "../../core/pin.js";

// ---------------------------------------------------------------------------
// Minimal concrete CircuitElement for tests
// ---------------------------------------------------------------------------

class StubElement extends AbstractCircuitElement {
  getPins(): readonly Pin[] {
    return [];
  }
  draw(_ctx: RenderContext): void {
    // no-op
  }
  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y, width: 4, height: 4 };
  }
  getHelpText(): string {
    return "stub";
  }
}

function makeElement(
  typeName: string,
  instanceId: string,
  x: number,
  y: number,
  props: Record<string, import("../../core/properties.js").PropertyValue> = {},
  rotation: import("../../core/pin.js").Rotation = 0,
  mirror = false,
): StubElement {
  const bag = new PropertyBag(Object.entries(props));
  return new StubElement(typeName, instanceId, { x, y }, rotation, mirror, bag);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWire(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): Wire {
  return new Wire({ x: x1, y: y1 }, { x: x2, y: y2 });
}

// ---------------------------------------------------------------------------
// Save::serializesSimpleCircuit
// ---------------------------------------------------------------------------

describe("Save", () => {
  it("serializesSimpleCircuit", () => {
    const circuit = new Circuit({ name: "Test" });
    const el1 = makeElement("In", "id-1", 100, 200);
    const el2 = makeElement("Out", "id-2", 300, 200);
    circuit.addElement(el1);
    circuit.addElement(el2);
    circuit.addWire(makeWire(120, 200, 280, 200));

    const json = serializeCircuit(circuit);

    // Must be valid JSON
    expect(() => JSON.parse(json)).not.toThrow();

    const parsed = JSON.parse(json) as Record<string, unknown>;

    // Version field present and correct
    expect(parsed["version"]).toBe(SAVE_FORMAT_VERSION);

    // 2 elements, 1 wire
    expect(Array.isArray(parsed["elements"])).toBe(true);
    expect((parsed["elements"] as unknown[]).length).toBe(2);
    expect(Array.isArray(parsed["wires"])).toBe(true);
    expect((parsed["wires"] as unknown[]).length).toBe(1);

    // Element type names preserved
    const elements = parsed["elements"] as Array<Record<string, unknown>>;
    expect(elements[0]["typeName"]).toBe("In");
    expect(elements[1]["typeName"]).toBe("Out");

    // Positions preserved
    expect(elements[0]["position"]).toEqual({ x: 100, y: 200 });
    expect(elements[1]["position"]).toEqual({ x: 300, y: 200 });

    // Wire endpoints
    const wires = parsed["wires"] as Array<Record<string, unknown>>;
    expect(wires[0]["p1"]).toEqual({ x: 120, y: 200 });
    expect(wires[0]["p2"]).toEqual({ x: 280, y: 200 });
  });

  // -------------------------------------------------------------------------
  // Save::stableKeyOrdering
  // -------------------------------------------------------------------------

  it("stableKeyOrdering", () => {
    const circuit = new Circuit({ name: "Stable" });
    const el = makeElement("And", "id-a", 100, 100, {
      inputCount: 2,
      bitWidth: 8,
      label: "gate",
    });
    circuit.addElement(el);
    circuit.addWire(makeWire(0, 0, 10, 10));

    const json1 = serializeCircuit(circuit);
    const json2 = serializeCircuit(circuit);

    // Identical output on two calls
    expect(json1).toBe(json2);

    // Keys in the element properties object must be sorted
    const parsed = JSON.parse(json1) as {
      elements: Array<{ properties: Record<string, unknown> }>;
    };
    const propKeys = Object.keys(parsed.elements[0].properties);
    const sortedKeys = [...propKeys].sort();
    expect(propKeys).toEqual(sortedKeys);
  });

  // -------------------------------------------------------------------------
  // Save::preservesBigint
  // -------------------------------------------------------------------------

  it("preservesBigint", () => {
    const circuit = new Circuit();
    const el = makeElement("ROM", "id-r", 0, 0, { value: 42n });
    circuit.addElement(el);

    const json = serializeCircuit(circuit);
    const parsed = JSON.parse(json) as {
      elements: Array<{ properties: Record<string, unknown> }>;
    };

    const valueField = parsed.elements[0].properties["value"];

    // Must be a string (JSON has no bigint)
    expect(typeof valueField).toBe("string");

    // Must use the "_bigint:" prefix
    expect(valueField).toBe(encodeBigint(42n));
    expect(valueField).toBe("_bigint:42");
  });

  // -------------------------------------------------------------------------
  // Save::includesMetadata
  // -------------------------------------------------------------------------

  it("includesMetadata", () => {
    const circuit = new Circuit({
      name: "My Circuit",
      description: "A test circuit",
      measurementOrdering: ["A", "B", "Y"],
      isGeneric: false,
    });

    const json = serializeCircuit(circuit);
    const parsed = JSON.parse(json) as {
      metadata: {
        name: string;
        description: string;
        measurementOrdering: string[];
        isGeneric: boolean;
      };
    };

    expect(parsed.metadata.name).toBe("My Circuit");
    expect(parsed.metadata.description).toBe("A test circuit");
    expect(parsed.metadata.measurementOrdering).toEqual(["A", "B", "Y"]);
    expect(parsed.metadata.isGeneric).toBe(false);
  });
});
