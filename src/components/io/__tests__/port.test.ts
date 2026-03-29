/**
 * Unit tests for the Port component.
 *
 * Covers:
 *   - PortDefinition.pinLayout: exactly 1 BIDIRECTIONAL pin labeled "port"
 *   - PortElement.getPins: bitWidth from props is reflected in pin
 *   - Serialization round-trip: serialize to .dig XML, deserialize, verify all properties
 *   - deriveInterfacePins: Port element produces a BIDIRECTIONAL PinDeclaration
 *   - resolveModelAssignments: Port resolves to modelKey "neutral"
 */

import { describe, it, expect } from "vitest";
import { PortDefinition, PortElement, PORT_ATTRIBUTE_MAPPINGS } from "../port.js";
import { PropertyBag } from "../../../core/properties.js";
import { PinDirection } from "../../../core/pin.js";
import { ComponentRegistry } from "../../../core/registry.js";
import { Circuit } from "../../../core/circuit.js";
import { deriveInterfacePins } from "../../subcircuit/pin-derivation.js";
import { resolveModelAssignments } from "../../../compile/extract-connectivity.js";
import { serializeCircuitToDig } from "../../../io/dig-serializer.js";
import { parseDigXml } from "../../../io/dig-parser.js";
import { loadDigCircuit } from "../../../io/dig-loader.js";
import { createDefaultRegistry } from "../../register-all.js";

// ---------------------------------------------------------------------------
// Helper — create a PortElement with given props
// ---------------------------------------------------------------------------

function makePort(props: Record<string, import("../../../core/properties.js").PropertyValue> = {}): PortElement {
  const bag = new PropertyBag(Object.entries(props));
  return new PortElement("port-test-id", { x: 5, y: 3 }, 0, false, bag);
}

// ---------------------------------------------------------------------------
// PortDefinition.pinLayout
// ---------------------------------------------------------------------------

describe("PortDefinition", () => {
  it("pinLayout has exactly 1 pin with direction BIDIRECTIONAL and label 'port'", () => {
    const pins = PortDefinition.pinLayout;
    expect(pins).toHaveLength(1);
    expect(pins[0]!.direction).toBe(PinDirection.BIDIRECTIONAL);
    expect(pins[0]!.label).toBe("port");
  });

  it("pinLayout default bit width is 1", () => {
    const pins = PortDefinition.pinLayout;
    expect(pins[0]!.defaultBitWidth).toBe(1);
  });

  it("models is empty object (neutral infrastructure)", () => {
    expect(Object.keys(PortDefinition.models as object)).toHaveLength(0);
  });

  it("category is IO", () => {
    expect(PortDefinition.category).toBe("IO");
  });

  it("name is 'Port'", () => {
    expect(PortDefinition.name).toBe("Port");
  });
});

// ---------------------------------------------------------------------------
// PortElement.getPins — bitWidth from props
// ---------------------------------------------------------------------------

describe("PortElement.getPins", () => {
  it("pin reflects bitWidth from props when bitWidth is 4", () => {
    const el = makePort({ bitWidth: 4 });
    const pins = el.getPins();
    expect(pins).toHaveLength(1);
    expect(pins[0]!.bitWidth).toBe(4);
    expect(pins[0]!.direction).toBe(PinDirection.BIDIRECTIONAL);
    expect(pins[0]!.label).toBe("port");
  });

  it("pin defaults to bitWidth 1 when no props given", () => {
    const el = makePort();
    const pins = el.getPins();
    expect(pins[0]!.bitWidth).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Serialization round-trip
// ---------------------------------------------------------------------------

describe("Port serialization round-trip", () => {
  it("serializes to .dig XML and deserializes back preserving all properties", () => {
    const registry = createDefaultRegistry();

    const circuit = new Circuit({ name: "PortRoundTrip" });
    const el = makePort({
      label: "myPort",
      bitWidth: 8,
      face: "right",
      sortOrder: 3,
    });
    circuit.addElement(el);

    const xml = serializeCircuitToDig(circuit, registry);

    expect(xml).toContain("Port");
    expect(xml).toContain("myPort");

    const parsed = parseDigXml(xml);
    const loaded = loadDigCircuit(parsed, registry);

    expect(loaded.elements).toHaveLength(1);
    const loadedEl = loaded.elements[0]!;
    expect(loadedEl.typeId).toBe("Port");

    const props = loadedEl.getProperties();
    expect(props.getOrDefault<string>("label", "")).toBe("myPort");
    expect(props.getOrDefault<number>("bitWidth", 1)).toBe(8);
    expect(props.getOrDefault<string>("face", "left")).toBe("right");
    expect(props.getOrDefault<number>("sortOrder", 0)).toBe(3);
  });

  it("PORT_ATTRIBUTE_MAPPINGS covers label, bitWidth, face, sortOrder", () => {
    const keys = PORT_ATTRIBUTE_MAPPINGS.map((m) => m.propertyKey);
    expect(keys).toContain("label");
    expect(keys).toContain("bitWidth");
    expect(keys).toContain("face");
    expect(keys).toContain("sortOrder");
  });
});

// ---------------------------------------------------------------------------
// deriveInterfacePins — Port element produces BIDIRECTIONAL PinDeclaration
// ---------------------------------------------------------------------------

describe("deriveInterfacePins with Port element", () => {
  it("returns a PinDeclaration with direction BIDIRECTIONAL and the Port's label", () => {
    const circuit = new Circuit({ name: "SubTest" });
    const el = makePort({ label: "A", bitWidth: 1, face: "left", sortOrder: 0 });
    circuit.addElement(el);

    const pins = deriveInterfacePins(circuit);

    expect(pins).toHaveLength(1);
    expect(pins[0]!.direction).toBe(PinDirection.BIDIRECTIONAL);
    expect(pins[0]!.label).toBe("A");
    expect(pins[0]!.defaultBitWidth).toBe(1);
  });

  it("face property drives face assignment (not rotation)", () => {
    const circuit = new Circuit({ name: "SubTest" });
    const el = makePort({ label: "B", bitWidth: 4, face: "right", sortOrder: 0 });
    circuit.addElement(el);

    const pins = deriveInterfacePins(circuit);

    expect(pins).toHaveLength(1);
    expect((pins[0] as import("../../../core/pin.js").PinDeclaration & { face?: string }).face).toBe("right");
    expect(pins[0]!.defaultBitWidth).toBe(4);
  });

  it("uses fallback label 'port0' when Port element has no label", () => {
    const circuit = new Circuit({ name: "SubTest" });
    const el = makePort({ label: "", face: "bottom", sortOrder: 1 });
    circuit.addElement(el);

    const pins = deriveInterfacePins(circuit);

    expect(pins).toHaveLength(1);
    expect(pins[0]!.label).toBe("port0");
  });
});

// ---------------------------------------------------------------------------
// resolveModelAssignments — Port resolves to modelKey "neutral"
// ---------------------------------------------------------------------------

describe("resolveModelAssignments — Port is neutral infrastructure", () => {
  it("Port with models: {} resolves to modelKey 'neutral'", () => {
    const registry = createDefaultRegistry();
    const el = makePort({ label: "p" });

    const [assignments] = resolveModelAssignments([el], registry);

    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.modelKey).toBe("neutral");
    expect(assignments[0]!.model).toBeNull();
  });
});
