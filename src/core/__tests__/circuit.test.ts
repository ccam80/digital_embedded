import { describe, it, expect } from "vitest";
import {
  Circuit,
  Wire,
  Net,
} from "../circuit.js";
import type { CircuitElement, SerializedElement } from "../element.js";
import type { Point, Rect } from "../renderer-interface.js";
import type { Pin } from "../pin.js";
import type { PropertyBag, PropertyValue } from "../properties.js";
import type { RenderContext } from "../renderer-interface.js";
import type { Rotation } from "../pin.js";

// ---------------------------------------------------------------------------
// Minimal mock CircuitElement for testing Circuit methods
// ---------------------------------------------------------------------------

function makeMockElement(
  instanceId: string,
  position: Point = { x: 0, y: 0 },
  boundingBox: Rect = { x: 0, y: 0, width: 4, height: 4 },
): CircuitElement {
  return {
    typeId: "MockComponent",
    instanceId,
    position,
    rotation: 0 as Rotation,
    mirror: false,
    getPins(): readonly Pin[] {
      return [];
    },
    getProperties(): PropertyBag {
      throw new Error("not needed in circuit tests");
    },
    draw(_ctx: RenderContext): void {
      // no-op
    },
    getBoundingBox(): Rect {
      return boundingBox;
    },
    serialize(): SerializedElement {
      return {
        typeId: "MockComponent",
        instanceId,
        position,
        rotation: 0 as Rotation,
        mirror: false,
        properties: {},
      };
    },
    getAttribute(_name: string): PropertyValue | undefined {
      return undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Wire tests
// ---------------------------------------------------------------------------

describe("Wire", () => {
  it("stores start and end points", () => {
    const w = new Wire({ x: 0, y: 0 }, { x: 10, y: 0 });
    expect(w.start).toEqual({ x: 0, y: 0 });
    expect(w.end).toEqual({ x: 10, y: 0 });
  });

  it("allows mutating start and end", () => {
    const w = new Wire({ x: 0, y: 0 }, { x: 10, y: 0 });
    w.start = { x: 1, y: 2 };
    w.end = { x: 5, y: 6 };
    expect(w.start).toEqual({ x: 1, y: 2 });
    expect(w.end).toEqual({ x: 5, y: 6 });
  });

  it("has no netId property", () => {
    const w = new Wire({ x: 0, y: 0 }, { x: 1, y: 0 });
    expect("netId" in w).toBe(false);
  });

  it("has no signalValue property", () => {
    const w = new Wire({ x: 0, y: 0 }, { x: 1, y: 0 });
    expect("signalValue" in w).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Net tests
// ---------------------------------------------------------------------------

describe("Net", () => {
  it("starts empty", () => {
    const net = new Net();
    expect(net.size).toBe(0);
  });

  it("adds and retrieves pins", () => {
    const net = new Net();
    const pin: Pin = {
      direction: "INPUT" as Pin["direction"],
      position: { x: 0, y: 0 },
      label: "A",
      bitWidth: 1,
      isNegated: false,
      isClock: false,
    };
    net.addPin(pin);
    expect(net.size).toBe(1);
    expect(net.getPins().has(pin)).toBe(true);
  });

  it("removes pins", () => {
    const net = new Net();
    const pin: Pin = {
      direction: "INPUT" as Pin["direction"],
      position: { x: 0, y: 0 },
      label: "A",
      bitWidth: 1,
      isNegated: false,
      isClock: false,
    };
    net.addPin(pin);
    net.removePin(pin);
    expect(net.size).toBe(0);
  });

  it("returns a read-only set from getPins()", () => {
    const net = new Net();
    const pin: Pin = {
      direction: "INPUT" as Pin["direction"],
      position: { x: 0, y: 0 },
      label: "A",
      bitWidth: 1,
      isNegated: false,
      isClock: false,
    };
    net.addPin(pin);
    const pins = net.getPins();
    expect(pins).toBeInstanceOf(Set);
    expect(pins.size).toBe(1);
    expect(pins.has(pin)).toBe(true);
  });

  it("has no signal value property", () => {
    const net = new Net();
    expect("signalValue" in net).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Circuit tests
// ---------------------------------------------------------------------------

describe("Circuit", () => {
  it("starts with empty elements and wires", () => {
    const circuit = new Circuit();
    expect(circuit.elements).toHaveLength(0);
    expect(circuit.wires).toHaveLength(0);
  });

  it("uses default metadata when none provided", () => {
    const circuit = new Circuit();
    expect(circuit.metadata.name).toBe("Untitled");
    expect(circuit.metadata.isGeneric).toBe(false);
  });

  it("accepts partial metadata override", () => {
    const circuit = new Circuit({ name: "MyCircuit", isGeneric: true });
    expect(circuit.metadata.name).toBe("MyCircuit");
    expect(circuit.metadata.isGeneric).toBe(true);
    expect(circuit.metadata.description).toBe("");
  });

  it("addElement appends to elements array", () => {
    const circuit = new Circuit();
    const el = makeMockElement("el1");
    circuit.addElement(el);
    expect(circuit.elements).toHaveLength(1);
    expect(circuit.elements[0]).toBe(el);
  });

  it("removeElement removes existing element", () => {
    const circuit = new Circuit();
    const el = makeMockElement("el1");
    circuit.addElement(el);
    circuit.removeElement(el);
    expect(circuit.elements).toHaveLength(0);
  });

  it("removeElement is a no-op for element not in circuit", () => {
    const circuit = new Circuit();
    const el1 = makeMockElement("el1");
    const el2 = makeMockElement("el2");
    circuit.addElement(el1);
    circuit.removeElement(el2); // el2 was never added
    expect(circuit.elements).toHaveLength(1);
  });

  it("removeElement removes only the matching element", () => {
    const circuit = new Circuit();
    const el1 = makeMockElement("el1");
    const el2 = makeMockElement("el2");
    circuit.addElement(el1);
    circuit.addElement(el2);
    circuit.removeElement(el1);
    expect(circuit.elements).toHaveLength(1);
    expect(circuit.elements[0]).toBe(el2);
  });

  it("addWire appends to wires array", () => {
    const circuit = new Circuit();
    const wire = new Wire({ x: 0, y: 0 }, { x: 5, y: 0 });
    circuit.addWire(wire);
    expect(circuit.wires).toHaveLength(1);
    expect(circuit.wires[0]).toBe(wire);
  });

  it("removeWire removes existing wire", () => {
    const circuit = new Circuit();
    const wire = new Wire({ x: 0, y: 0 }, { x: 5, y: 0 });
    circuit.addWire(wire);
    circuit.removeWire(wire);
    expect(circuit.wires).toHaveLength(0);
  });

  it("removeWire is a no-op for wire not in circuit", () => {
    const circuit = new Circuit();
    const w1 = new Wire({ x: 0, y: 0 }, { x: 1, y: 0 });
    const w2 = new Wire({ x: 2, y: 0 }, { x: 3, y: 0 });
    circuit.addWire(w1);
    circuit.removeWire(w2);
    expect(circuit.wires).toHaveLength(1);
  });

  describe("getElementsAt", () => {
    it("returns element whose bounding box contains the point", () => {
      const circuit = new Circuit();
      // bounding box: x=2, y=2, width=4, height=4 → covers (2,2)..(6,6)
      const el = makeMockElement("el1", { x: 2, y: 2 }, { x: 2, y: 2, width: 4, height: 4 });
      circuit.addElement(el);
      expect(circuit.getElementsAt({ x: 4, y: 4 })).toContain(el);
    });

    it("returns empty array when no element contains the point", () => {
      const circuit = new Circuit();
      const el = makeMockElement("el1", { x: 0, y: 0 }, { x: 0, y: 0, width: 2, height: 2 });
      circuit.addElement(el);
      expect(circuit.getElementsAt({ x: 10, y: 10 })).toHaveLength(0);
    });

    it("returns multiple elements when they overlap at the point", () => {
      const circuit = new Circuit();
      const el1 = makeMockElement("el1", { x: 0, y: 0 }, { x: 0, y: 0, width: 4, height: 4 });
      const el2 = makeMockElement("el2", { x: 1, y: 1 }, { x: 1, y: 1, width: 4, height: 4 });
      circuit.addElement(el1);
      circuit.addElement(el2);
      const result = circuit.getElementsAt({ x: 2, y: 2 });
      expect(result).toContain(el1);
      expect(result).toContain(el2);
    });

    it("includes elements whose bounding box edge contains the point (inclusive bounds)", () => {
      const circuit = new Circuit();
      const el = makeMockElement("el1", { x: 0, y: 0 }, { x: 0, y: 0, width: 4, height: 4 });
      circuit.addElement(el);
      // Point exactly on the right edge
      expect(circuit.getElementsAt({ x: 4, y: 2 })).toContain(el);
      // Point exactly on the bottom edge
      expect(circuit.getElementsAt({ x: 2, y: 4 })).toContain(el);
      // Point at origin corner
      expect(circuit.getElementsAt({ x: 0, y: 0 })).toContain(el);
    });

    it("returns empty array when circuit has no elements", () => {
      const circuit = new Circuit();
      expect(circuit.getElementsAt({ x: 0, y: 0 })).toHaveLength(0);
    });
  });
});
