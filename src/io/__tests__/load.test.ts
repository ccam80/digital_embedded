/**
 * Tests for src/io/load.ts — JSON circuit deserialization.
 */

import { describe, it, expect } from "vitest";
import { serializeCircuit } from "../save.js";
import { deserializeCircuit } from "../load.js";
import { Circuit, Wire } from "../../core/circuit.js";
import { AbstractCircuitElement } from "../../core/element.js";
import { PropertyBag } from "../../core/properties.js";
import { ComponentRegistry, ComponentCategory } from "../../core/registry.js";
import type { ComponentDefinition } from "../../core/registry.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { Pin, Rotation } from "../../core/pin.js";
import { ZodError } from "zod";

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
}

// ---------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------

function noopExecute(): void {
  // no-op
}

function makeDefinition(name: string): ComponentDefinition {
  return {
    name,
    typeId: -1,
    factory: (props: PropertyBag) =>
      new StubElement(name, crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props),
    pinLayout: [],
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.LOGIC,
    helpText: name,
    models: {
      digital: { executeFn: noopExecute },
    },
  };
}

function makeRegistry(...names: string[]): ComponentRegistry {
  const registry = new ComponentRegistry();
  for (const name of names) {
    registry.register(makeDefinition(name));
  }
  return registry;
}

// ---------------------------------------------------------------------------
// Circuit helpers
// ---------------------------------------------------------------------------

function makeElement(
  typeName: string,
  x: number,
  y: number,
  props: Record<string, import("../../core/properties.js").PropertyValue> = {},
  rotation: Rotation = 0,
  mirror = false,
): StubElement {
  const bag = new PropertyBag(Object.entries(props));
  return new StubElement(typeName, crypto.randomUUID(), { x, y }, rotation, mirror, bag);
}

function makeWire(x1: number, y1: number, x2: number, y2: number): Wire {
  return new Wire({ x: x1, y: y1 }, { x: x2, y: y2 });
}

// ---------------------------------------------------------------------------
// Load::roundTrip
// ---------------------------------------------------------------------------

describe("Load", () => {
  it("roundTrip", () => {
    const registry = makeRegistry("In", "And", "Out");

    const circuit = new Circuit({
      name: "RoundTrip",
      description: "Test circuit",
      measurementOrdering: ["A", "Y"],
    });
    const el1 = makeElement("In", 100, 200, { label: "A", bitWidth: 1 });
    const el2 = makeElement("And", 300, 200, { inputCount: 2, wideShape: true });
    const el3 = makeElement("Out", 500, 200, { label: "Y" });
    circuit.addElement(el1);
    circuit.addElement(el2);
    circuit.addElement(el3);
    circuit.addWire(makeWire(120, 200, 280, 200));
    circuit.addWire(makeWire(320, 200, 480, 200));

    const json = serializeCircuit(circuit);
    const loaded = deserializeCircuit(json, registry);

    // Same element count and wire count
    expect(loaded.elements.length).toBe(3);
    expect(loaded.wires.length).toBe(2);

    // Element type names preserved
    expect(loaded.elements[0].typeId).toBe("In");
    expect(loaded.elements[1].typeId).toBe("And");
    expect(loaded.elements[2].typeId).toBe("Out");

    // Positions preserved
    expect(loaded.elements[0].position).toEqual({ x: 100, y: 200 });
    expect(loaded.elements[1].position).toEqual({ x: 300, y: 200 });
    expect(loaded.elements[2].position).toEqual({ x: 500, y: 200 });

    // Properties preserved
    expect(loaded.elements[0].getProperties().get("label")).toBe("A");
    expect(loaded.elements[1].getProperties().get("inputCount")).toBe(2);
    expect(loaded.elements[1].getProperties().get("wideShape")).toBe(true);

    // Wire endpoints preserved
    expect(loaded.wires[0].start).toEqual({ x: 120, y: 200 });
    expect(loaded.wires[0].end).toEqual({ x: 280, y: 200 });

    // Metadata preserved
    expect(loaded.metadata.name).toBe("RoundTrip");
    expect(loaded.metadata.description).toBe("Test circuit");
    expect(loaded.metadata.measurementOrdering).toEqual(["A", "Y"]);
  });

  // -------------------------------------------------------------------------
  // Load::validatesSchema
  // -------------------------------------------------------------------------

  it("validatesSchema", () => {
    const registry = makeRegistry("In");

    // Missing required fields — should throw ZodError
    const invalid = JSON.stringify({ version: 1, metadata: {}, elements: "not-array" });
    expect(() => deserializeCircuit(invalid, registry)).toThrow(ZodError);
  });

  // -------------------------------------------------------------------------
  // Load::restoresBigint
  // -------------------------------------------------------------------------

  it("restoresBigint", () => {
    const registry = makeRegistry("ROM");

    // Build JSON manually with the _bigint: encoding
    const doc = {
      version: 1,
      metadata: {
        name: "BigintTest",
        description: "",
        measurementOrdering: [],
        isGeneric: false,
      },
      elements: [
        {
          typeName: "ROM",
          instanceId: "id-1",
          position: { x: 0, y: 0 },
          rotation: 0,
          mirror: false,
          properties: {
            value: "_bigint:42",
          },
        },
      ],
      wires: [],
    };

    const loaded = deserializeCircuit(JSON.stringify(doc), registry);

    const value = loaded.elements[0].getProperties().get("value");
    expect(typeof value).toBe("bigint");
    expect(value).toBe(42n);
  });

  // -------------------------------------------------------------------------
  // Load::unknownVersionThrows
  // -------------------------------------------------------------------------

  it("unknownVersionThrows", () => {
    const registry = makeRegistry("In");

    const doc = {
      version: 99,
      metadata: {
        name: "FutureCircuit",
        description: "",
        measurementOrdering: [],
        isGeneric: false,
      },
      elements: [],
      wires: [],
    };

    expect(() => deserializeCircuit(JSON.stringify(doc), registry)).toThrow(
      /version 99/,
    );
  });

  // -------------------------------------------------------------------------
  // Load::unknownComponentThrows
  // -------------------------------------------------------------------------

  it("unknownComponentThrows", () => {
    // Registry has no "FutureGate" registered
    const registry = makeRegistry("In");

    const doc = {
      version: 1,
      metadata: {
        name: "UnknownComp",
        description: "",
        measurementOrdering: [],
        isGeneric: false,
      },
      elements: [
        {
          typeName: "FutureGate",
          instanceId: "id-1",
          position: { x: 0, y: 0 },
          rotation: 0,
          mirror: false,
          properties: {},
        },
      ],
      wires: [],
    };

    expect(() => deserializeCircuit(JSON.stringify(doc), registry)).toThrow(
      /FutureGate/,
    );
  });
});
