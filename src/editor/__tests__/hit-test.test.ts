/**
 * Tests for hit-test pure functions.
 *
 * Uses lightweight stubs for CircuitElement and Wire- no DOM required.
 */

import { describe, it, expect } from "vitest";
import {
  hitTestElements,
  hitTestWires,
  hitTestPins,
  hitTestAll,
  elementsInRect,
  wiresInRect,
} from "@/editor/hit-test";
import type { CircuitElement } from "@/core/element";
import type { Pin } from "@/core/pin";
import type { Rect } from "@/core/renderer-interface";
import { Wire, Circuit } from "@/core/circuit";
import type { RenderContext } from "@/core/renderer-interface";
import { PropertyBag } from "@/core/properties";
import type { SerializedElement } from "@/core/element";
import type { PropertyValue } from "@/core/properties";
import { PinDirection } from "@/core/pin";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

function makeElement(bb: Rect, pins: Pin[] = []): CircuitElement {
  return {
    typeId: "stub",
    instanceId: "stub-" + Math.random(),
    position: { x: bb.x, y: bb.y },
    rotation: 0,
    mirror: false,
    getPins: () => pins,
    getProperties: () => new PropertyBag(),
    draw: (_ctx: RenderContext) => {},
    getBoundingBox: () => bb,
    serialize: () => ({} as SerializedElement),
    getAttribute: (_name: string): PropertyValue | undefined => undefined,
    setAttribute: (_name: string, _value: PropertyValue): void => {},
  };
}

function makePin(x: number, y: number): Pin {
  return {
    direction: PinDirection.INPUT,
    position: { x, y },
    label: "A",
    bitWidth: 1,
    isNegated: false,
    isClock: false,
    kind: "signal",
  };
}

function makeWire(x1: number, y1: number, x2: number, y2: number): Wire {
  return new Wire({ x: x1, y: y1 }, { x: x2, y: y2 });
}

// ---------------------------------------------------------------------------
// hitTestElements
// ---------------------------------------------------------------------------

describe("HitTest", () => {
  it("hitsElementInBoundingBox", () => {
    const el = makeElement({ x: 0, y: 0, width: 10, height: 10 });
    const result = hitTestElements({ x: 5, y: 5 }, [el]);
    expect(result).toBe(el);
  });

  it("missesOutsideBoundingBox", () => {
    const el = makeElement({ x: 0, y: 0, width: 10, height: 10 });
    const result = hitTestElements({ x: 15, y: 15 }, [el]);
    expect(result).toBeUndefined();
  });

  it("hitsLastElementWhenOverlapping", () => {
    const el1 = makeElement({ x: 0, y: 0, width: 10, height: 10 });
    const el2 = makeElement({ x: 0, y: 0, width: 10, height: 10 });
    // el2 is last (on top)
    const result = hitTestElements({ x: 5, y: 5 }, [el1, el2]);
    expect(result).toBe(el2);
  });

  // ---------------------------------------------------------------------------
  // hitTestWires
  // ---------------------------------------------------------------------------

  it("hitsWireWithinThreshold", () => {
    // Horizontal wire at y=10 from x=0 to x=20
    const wire = makeWire(0, 10, 20, 10);
    // Point at (10, 13): 3px below midpoint, threshold 5
    const result = hitTestWires({ x: 10, y: 13 }, [wire], 5);
    expect(result).toBe(wire);
  });

  it("missesWireBeyondThreshold", () => {
    const wire = makeWire(0, 10, 20, 10);
    // Point at (10, 20): 10px away, threshold 5
    const result = hitTestWires({ x: 10, y: 20 }, [wire], 5);
    expect(result).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // hitTestPins
  // ---------------------------------------------------------------------------

  it("hitsPinWithinThreshold", () => {
    const pin = makePin(5, 5);
    const el = makeElement({ x: 0, y: 0, width: 10, height: 10 }, [pin]);
    const result = hitTestPins({ x: 5, y: 5 }, [el], 3);
    expect(result?.pin).toBe(pin);
    expect(result?.element).toBe(el);
  });

  it("missesPinBeyondThreshold", () => {
    const pin = makePin(5, 5);
    const el = makeElement({ x: 0, y: 0, width: 10, height: 10 }, [pin]);
    const result = hitTestPins({ x: 20, y: 20 }, [el], 3);
    expect(result).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // hitTestAll- priority ordering
  // ---------------------------------------------------------------------------

  it("pinTakesPriorityOverElement", () => {
    const pin = makePin(5, 5);
    const el = makeElement({ x: 0, y: 0, width: 10, height: 10 }, [pin]);
    const circuit = new Circuit();
    circuit.addElement(el);

    // Point exactly on pin, also inside element bounding box
    const result = hitTestAll({ x: 5, y: 5 }, circuit, 3);
    expect(result.type).toBe("pin");
  });

  it("elementHitWhenNoPinNearby", () => {
    const el = makeElement({ x: 0, y: 0, width: 10, height: 10 });
    const circuit = new Circuit();
    circuit.addElement(el);

    const result = hitTestAll({ x: 5, y: 5 }, circuit, 1);
    expect(result.type).toBe("element");
    if (result.type === "element") {
      expect(result.element).toBe(el);
    }
  });

  it("wireHitWhenNoElementOrPin", () => {
    const wire = makeWire(0, 20, 20, 20);
    const circuit = new Circuit();
    circuit.addWire(wire);

    const result = hitTestAll({ x: 10, y: 20 }, circuit, 3);
    expect(result.type).toBe("wire");
  });

  it("noneWhenNothingHit", () => {
    const circuit = new Circuit();
    const result = hitTestAll({ x: 100, y: 100 }, circuit, 3);
    expect(result.type).toBe("none");
  });

  // ---------------------------------------------------------------------------
  // elementsInRect
  // ---------------------------------------------------------------------------

  it("elementsInRectFindsOverlapping", () => {
    const el1 = makeElement({ x: 0, y: 0, width: 5, height: 5 });
    const el2 = makeElement({ x: 10, y: 10, width: 5, height: 5 });
    const el3 = makeElement({ x: 20, y: 20, width: 5, height: 5 });

    // Rect that overlaps el1 and el2 but not el3
    const selRect: Rect = { x: 0, y: 0, width: 14, height: 14 };
    const result = elementsInRect(selRect, [el1, el2, el3]);
    expect(result).toContain(el1);
    expect(result).toContain(el2);
    expect(result).not.toContain(el3);
  });

  it("wiresInRectWithEndpointInside", () => {
    const w1 = makeWire(2, 2, 8, 2);  // both endpoints inside rect
    const w2 = makeWire(50, 50, 60, 60);  // neither endpoint inside

    const selRect: Rect = { x: 0, y: 0, width: 10, height: 10 };
    const result = wiresInRect(selRect, [w1, w2]);
    expect(result).toContain(w1);
    expect(result).not.toContain(w2);
  });

});
