/**
 * Unit tests for CircuitElement interface and AbstractCircuitElement base class.
 *
 * Tests verify:
 * - A concrete element can be created and satisfies the interface
 * - draw(), getPins(), serialize(), getAttribute() behave correctly
 * - getBoundingBox() returns the correct rect
 * - Serialization produces the expected shape
 * - Mutation of position/rotation/mirror is reflected immediately
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  AbstractCircuitElement,
  type CircuitElement,
  type SerializedElement,
} from "../element.js";
import { PropertyBag } from "../properties.js";
import { PinDirection, type Pin, type Rotation } from "../pin.js";
import type { RenderContext, Point, Rect, ThemeColor, FontSpec, TextAnchor, PathData } from "../renderer-interface.js";

// ---------------------------------------------------------------------------
// Minimal RenderContext stub — records all draw calls
// ---------------------------------------------------------------------------

interface DrawCall {
  method: string;
  args: unknown[];
}

function makeStubCtx(): { ctx: RenderContext; calls: DrawCall[] } {
  const calls: DrawCall[] = [];

  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
    };

  const ctx: RenderContext = {
    drawLine: record("drawLine") as (x1: number, y1: number, x2: number, y2: number) => void,
    drawRect: record("drawRect") as (x: number, y: number, w: number, h: number, filled: boolean) => void,
    drawCircle: record("drawCircle") as (cx: number, cy: number, r: number, filled: boolean) => void,
    drawArc: record("drawArc") as (cx: number, cy: number, r: number, s: number, e: number) => void,
    drawPolygon: record("drawPolygon") as (points: readonly Point[], filled: boolean) => void,
    drawPath: record("drawPath") as (path: PathData) => void,
    drawText: record("drawText") as (text: string, x: number, y: number, anchor: TextAnchor) => void,
    save: record("save") as () => void,
    restore: record("restore") as () => void,
    translate: record("translate") as (dx: number, dy: number) => void,
    rotate: record("rotate") as (angle: number) => void,
    scale: record("scale") as (sx: number, sy: number) => void,
    setColor: record("setColor") as (color: ThemeColor) => void,
    setLineWidth: record("setLineWidth") as (w: number) => void,
    setFont: record("setFont") as (font: FontSpec) => void,
    setLineDash: record("setLineDash") as (pattern: number[]) => void,
  };

  return { ctx, calls };
}

// ---------------------------------------------------------------------------
// Concrete test element
// ---------------------------------------------------------------------------

const FIXED_PINS: Pin[] = [
  {
    direction: PinDirection.INPUT,
    position: { x: 0, y: 1 },
    label: "A",
    bitWidth: 1,
    isNegated: false,
    isClock: false,
    kind: "signal",
  },
  {
    direction: PinDirection.OUTPUT,
    position: { x: 4, y: 1 },
    label: "Q",
    bitWidth: 1,
    isNegated: false,
    isClock: false,
    kind: "signal",
  },
];

class ConcreteElement extends AbstractCircuitElement {
  getPins(): readonly Pin[] {
    return FIXED_PINS;
  }

  draw(ctx: RenderContext): void {
    ctx.drawRect(this.position.x, this.position.y, 4, 2, false);
  }

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y, width: 4, height: 2 };
  }

}

function makeElement(overrides?: {
  position?: Point;
  rotation?: Rotation;
  mirror?: boolean;
  properties?: PropertyBag;
}): ConcreteElement {
  const props = overrides?.properties ?? new PropertyBag([["bitWidth", 1]]);
  return new ConcreteElement(
    "TestGate",
    "inst-001",
    overrides?.position ?? { x: 2, y: 3 },
    overrides?.rotation ?? 0,
    overrides?.mirror ?? false,
    props,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CircuitElement interface via AbstractCircuitElement", () => {
  let el: ConcreteElement;

  beforeEach(() => {
    el = makeElement();
  });

  // --- Identity ---

  it("exposes typeId", () => {
    expect(el.typeId).toBe("TestGate");
  });

  it("exposes instanceId", () => {
    expect(el.instanceId).toBe("inst-001");
  });

  it("typeId and instanceId are readonly at the type level", () => {
    // TypeScript enforces readonly; verify the values survive construction.
    const el2 = makeElement();
    expect(el2.typeId).toBe("TestGate");
    expect(el2.instanceId).toBe("inst-001");
  });

  // --- Visual placement ---

  it("exposes mutable position", () => {
    expect(el.position).toEqual({ x: 2, y: 3 });
    el.position = { x: 10, y: 20 };
    expect(el.position).toEqual({ x: 10, y: 20 });
  });

  it("exposes mutable rotation", () => {
    expect(el.rotation).toBe(0);
    el.rotation = 2;
    expect(el.rotation).toBe(2);
  });

  it("exposes mutable mirror flag", () => {
    expect(el.mirror).toBe(false);
    el.mirror = true;
    expect(el.mirror).toBe(true);
  });

  // --- Pins ---

  it("getPins returns the declared pins", () => {
    const pins = el.getPins();
    expect(pins).toHaveLength(2);
    expect(pins[0].label).toBe("A");
    expect(pins[0].direction).toBe(PinDirection.INPUT);
    expect(pins[1].label).toBe("Q");
    expect(pins[1].direction).toBe(PinDirection.OUTPUT);
  });

  it("getPins returns a readonly array (does not expose mutable internals)", () => {
    const pins = el.getPins();
    // The array itself should be the same reference each call (no unnecessary allocation).
    expect(el.getPins()).toBe(pins);
  });

  it("pin has no simulation state (no netId, no signalValue)", () => {
    const pin = el.getPins()[0];
    expect(Object.keys(pin)).not.toContain("netId");
    expect(Object.keys(pin)).not.toContain("signalValue");
  });

  // --- Properties ---

  it("getProperties returns the PropertyBag", () => {
    const bag = el.getProperties();
    expect(bag.get<number>("bitWidth")).toBe(1);
  });

  it("getProperties returns the same bag instance (no defensive copy)", () => {
    expect(el.getProperties()).toBe(el.getProperties());
  });

  // --- Rendering ---

  it("draw() calls RenderContext methods (never Canvas2D directly)", () => {
    const { ctx, calls } = makeStubCtx();
    el.draw(ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("drawRect");
    expect(calls[0].args).toEqual([2, 3, 4, 2, false]);
  });

  it("draw() uses component position", () => {
    el.position = { x: 5, y: 7 };
    const { ctx, calls } = makeStubCtx();
    el.draw(ctx);
    expect(calls[0].args[0]).toBe(5);
    expect(calls[0].args[1]).toBe(7);
  });

  it("getBoundingBox returns correct rect for default position", () => {
    const bb = el.getBoundingBox();
    expect(bb).toEqual({ x: 2, y: 3, width: 4, height: 2 });
  });

  it("getBoundingBox reflects position mutations", () => {
    el.position = { x: 0, y: 0 };
    expect(el.getBoundingBox()).toEqual({ x: 0, y: 0, width: 4, height: 2 });
  });

  // --- Help text ---


  // --- Serialization ---

  it("serialize returns correct typeId and instanceId", () => {
    const s: SerializedElement = el.serialize();
    expect(s.typeId).toBe("TestGate");
    expect(s.instanceId).toBe("inst-001");
  });

  it("serialize returns correct position", () => {
    const s = el.serialize();
    expect(s.position).toEqual({ x: 2, y: 3 });
  });

  it("serialize position is a copy (not the same object reference)", () => {
    const s = el.serialize();
    expect(s.position).not.toBe(el.position);
  });

  it("serialize returns correct rotation and mirror", () => {
    el.rotation = 1;
    el.mirror = true;
    const s = el.serialize();
    expect(s.rotation).toBe(1);
    expect(s.mirror).toBe(true);
  });

  it("serialize includes property values as plain JSON-safe types", () => {
    const s = el.serialize();
    expect(s.properties).toHaveProperty("bitWidth", 1);
  });

  it("serialize encodes bigint properties as '0n<digits>' strings", () => {
    const props = new PropertyBag([
      ["bitWidth", 1],
      ["largeVal", BigInt(999)],
    ]);
    const elWithBigInt = makeElement({ properties: props });
    const s = elWithBigInt.serialize();
    expect(s.properties["largeVal"]).toBe("0n999");
    expect(s.properties["bitWidth"]).toBe(1);
  });

  it("serialize output satisfies SerializedElement shape", () => {
    const s: SerializedElement = el.serialize();
    expect(typeof s.typeId).toBe("string");
    expect(typeof s.instanceId).toBe("string");
    expect(typeof s.position.x).toBe("number");
    expect(typeof s.position.y).toBe("number");
    expect(typeof s.rotation).toBe("number");
    expect(typeof s.mirror).toBe("boolean");
    expect(typeof s.properties).toBe("object");
  });

  // --- HGS attribute access ---

  it("getAttribute returns value for known property", () => {
    expect(el.getAttribute("bitWidth")).toBe(1);
  });

  it("getAttribute returns undefined for unknown property", () => {
    expect(el.getAttribute("nonexistent")).toBeUndefined();
  });

  it("getAttribute and getProperties().get() return the same value", () => {
    const fromAttr = el.getAttribute("bitWidth");
    const fromBag = el.getProperties().get<number>("bitWidth");
    expect(fromAttr).toBe(fromBag);
  });

  // --- No simulation state ---

  it("CircuitElement has no execute method", () => {
    expect(typeof (el as unknown as Record<string, unknown>)["execute"]).not.toBe("function");
  });

  it("CircuitElement has no readInputs method", () => {
    expect(typeof (el as unknown as Record<string, unknown>)["readInputs"]).not.toBe("function");
  });

  it("CircuitElement has no writeOutputs method", () => {
    expect(typeof (el as unknown as Record<string, unknown>)["writeOutputs"]).not.toBe("function");
  });

  // --- Multiple instances are independent ---

  it("two instances with same typeId have independent state", () => {
    const el1 = makeElement({ position: { x: 0, y: 0 } });
    const el2 = makeElement({ position: { x: 10, y: 10 }, properties: new PropertyBag([["bitWidth", 4]]) });

    el1.position = { x: 5, y: 5 };
    expect(el2.position).toEqual({ x: 10, y: 10 });

    expect(el1.getProperties().get<number>("bitWidth")).toBe(1);
    expect(el2.getProperties().get<number>("bitWidth")).toBe(4);
  });

  it("serialize on two instances produces different instanceIds if constructed with different IDs", () => {
    const elA = new ConcreteElement("TestGate", "id-A", { x: 0, y: 0 }, 0, false, new PropertyBag());
    const elB = new ConcreteElement("TestGate", "id-B", { x: 0, y: 0 }, 0, false, new PropertyBag());
    expect(elA.serialize().instanceId).toBe("id-A");
    expect(elB.serialize().instanceId).toBe("id-B");
  });

  // --- Satisfies interface structurally ---

  it("ConcreteElement is assignable to CircuitElement interface", () => {
    const asInterface: CircuitElement = el;
    expect(asInterface.typeId).toBe("TestGate");
    expect(typeof asInterface.draw).toBe("function");
    expect(typeof asInterface.getPins).toBe("function");
    expect(typeof asInterface.getProperties).toBe("function");
    expect(typeof asInterface.getBoundingBox).toBe("function");
    expect(typeof asInterface.serialize).toBe("function");
    expect(typeof asInterface.getAttribute).toBe("function");
  });
});
