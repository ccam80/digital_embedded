/**
 * Tests for the PriorityEncoder component.
 *
 * Covers:
 *   - executePriorityEncoder: truth table for representative cases
 *   - executePriorityEncoder: highest-index (last active) priority wins
 *   - executePriorityEncoder: any flag correct
 *   - executePriorityEncoder: all inputs inactive → any=0, num=0
 *   - Pin layout: correct counts and labels
 *   - Attribute mapping
 *   - Rendering
 *   - ComponentDefinition completeness
 */

import { describe, it, expect } from "vitest";
import {
  PriorityEncoderElement,
  executePriorityEncoder,
  PriorityEncoderDefinition,
  PRIORITY_ENCODER_ATTRIBUTE_MAPPINGS,
  buildPriorityEncoderPinDeclarations,
} from "../priority-encoder.js";
import { PropertyBag } from "../../../core/properties.js";
import { PinDirection } from "../../../core/pin.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import type { ComponentLayout } from "../../../core/registry.js";
import type { RenderContext, Point, TextAnchor, FontSpec, PathData } from "../../../core/renderer-interface.js";
import type { ThemeColor } from "../../../core/renderer-interface.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a layout for a priority encoder with N inputs and 2 outputs (num, any).
 */
function makeLayout(inputCount: number): ComponentLayout {
  return {
    wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: () => inputCount,
    inputOffset: () => 0,
    outputCount: () => 2,
    outputOffset: () => inputCount,
    stateOffset: () => inputCount + 2,
    getProperty: () => undefined,
  };
}

function makeState(inputs: number[]): Uint32Array {
  const arr = new Uint32Array(inputs.length + 2);
  for (let i = 0; i < inputs.length; i++) {
    arr[i] = inputs[i] >>> 0;
  }
  return arr;
}

interface DrawCall {
  method: string;
  args: unknown[];
}

function makeStubCtx(): { ctx: RenderContext; calls: DrawCall[] } {
  const calls: DrawCall[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]): void => {
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

function makePrioEnc(overrides?: { selectorBits?: number }): PriorityEncoderElement {
  const props = new PropertyBag();
  props.set("selectorBits", overrides?.selectorBits ?? 2);
  return new PriorityEncoderElement("test-prio-001", { x: 0, y: 0 }, 0, false, props);
}

// ---------------------------------------------------------------------------
// executePriorityEncoder- logic correctness
// ---------------------------------------------------------------------------

describe("PriorityEncoder", () => {
  describe("execute2Input", () => {
    it("only in0=1: num=0, any=1", () => {
      // 1-bit selector → 2 inputs
      const layout = makeLayout(2);
      const state = makeState([1, 0]);
      const highZs = new Uint32Array(state.length);
      executePriorityEncoder(0, state, highZs, layout);
      expect(state[2]).toBe(0); // num
      expect(state[3]).toBe(1); // any
    });

    it("only in1=1: num=1, any=1", () => {
      const layout = makeLayout(2);
      const state = makeState([0, 1]);
      const highZs = new Uint32Array(state.length);
      executePriorityEncoder(0, state, highZs, layout);
      expect(state[2]).toBe(1); // num
      expect(state[3]).toBe(1); // any
    });

    it("both in0=1 and in1=1: num=1 (highest index wins), any=1", () => {
      const layout = makeLayout(2);
      const state = makeState([1, 1]);
      const highZs = new Uint32Array(state.length);
      executePriorityEncoder(0, state, highZs, layout);
      expect(state[2]).toBe(1); // num = highest active index
      expect(state[3]).toBe(1); // any
    });

    it("all inputs 0: num=0, any=0", () => {
      const layout = makeLayout(2);
      const state = makeState([0, 0]);
      const highZs = new Uint32Array(state.length);
      executePriorityEncoder(0, state, highZs, layout);
      expect(state[2]).toBe(0); // num
      expect(state[3]).toBe(0); // any
    });
  });

  describe("executeMultiInput", () => {
    it("4-input encoder: only in2=1 → num=2, any=1", () => {
      // 2-bit selector → 4 inputs
      const layout = makeLayout(4);
      const state = makeState([0, 0, 1, 0]);
      const highZs = new Uint32Array(state.length);
      executePriorityEncoder(0, state, highZs, layout);
      expect(state[4]).toBe(2); // num
      expect(state[5]).toBe(1); // any
    });

    it("4-input encoder: in0=1 and in3=1 → num=3 (in3 has higher priority)", () => {
      const layout = makeLayout(4);
      const state = makeState([1, 0, 0, 1]);
      const highZs = new Uint32Array(state.length);
      executePriorityEncoder(0, state, highZs, layout);
      expect(state[4]).toBe(3); // highest active index
      expect(state[5]).toBe(1);
    });

    it("4-input encoder: all active → num=3 (highest index)", () => {
      const layout = makeLayout(4);
      const state = makeState([1, 1, 1, 1]);
      const highZs = new Uint32Array(state.length);
      executePriorityEncoder(0, state, highZs, layout);
      expect(state[4]).toBe(3);
      expect(state[5]).toBe(1);
    });

    it("4-input encoder: all inactive → num=0, any=0", () => {
      const layout = makeLayout(4);
      const state = makeState([0, 0, 0, 0]);
      const highZs = new Uint32Array(state.length);
      executePriorityEncoder(0, state, highZs, layout);
      expect(state[4]).toBe(0);
      expect(state[5]).toBe(0);
    });
  });

  describe("multiBit", () => {
    it("non-zero input value (not just 1) still counts as active", () => {
      const layout = makeLayout(4);
      const state = makeState([0xFF, 0, 0, 0]);
      const highZs = new Uint32Array(state.length);
      executePriorityEncoder(0, state, highZs, layout);
      expect(state[4]).toBe(0); // only in0 active
      expect(state[5]).toBe(1); // any
    });

    it("8-input encoder: only in7=1 → num=7", () => {
      const layout = makeLayout(8);
      const state = makeState([0, 0, 0, 0, 0, 0, 0, 1]);
      const highZs = new Uint32Array(state.length);
      executePriorityEncoder(0, state, highZs, layout);
      expect(state[8]).toBe(7);
      expect(state[9]).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Pin layout
  // ---------------------------------------------------------------------------

  describe("pinLayout2BitSelector", () => {
    it("2-bit selector produces 4 input pins and 2 output pins", () => {
      const el = makePrioEnc({ selectorBits: 2 });
      const pins = el.getPins();
      const inputs = pins.filter((p) => p.direction === PinDirection.INPUT);
      const outputs = pins.filter((p) => p.direction === PinDirection.OUTPUT);
      expect(inputs).toHaveLength(4);
      expect(outputs).toHaveLength(2);
    });

    it("input pins labeled in0..in3", () => {
      const el = makePrioEnc({ selectorBits: 2 });
      const inputs = el.getPins().filter((p) => p.direction === PinDirection.INPUT);
      expect(inputs.map((p) => p.label)).toEqual(["in0", "in1", "in2", "in3"]);
    });

    it("output pins labeled 'num' and 'any'", () => {
      const el = makePrioEnc({ selectorBits: 2 });
      const outputs = el.getPins().filter((p) => p.direction === PinDirection.OUTPUT);
      const labels = outputs.map((p) => p.label);
      expect(labels).toContain("num");
      expect(labels).toContain("any");
    });
  });

  describe("pinLayout1BitSelector", () => {
    it("1-bit selector produces 2 input pins and 2 output pins", () => {
      const el = makePrioEnc({ selectorBits: 1 });
      const pins = el.getPins();
      const inputs = pins.filter((p) => p.direction === PinDirection.INPUT);
      const outputs = pins.filter((p) => p.direction === PinDirection.OUTPUT);
      expect(inputs).toHaveLength(2);
      expect(outputs).toHaveLength(2);
    });
  });

  describe("pinLayoutFromDeclarations", () => {
    it("buildPriorityEncoderPinDeclarations(2) produces 4 inputs + 2 outputs", () => {
      const decls = buildPriorityEncoderPinDeclarations(2);
      expect(decls.filter((d) => d.direction === PinDirection.INPUT)).toHaveLength(4);
      expect(decls.filter((d) => d.direction === PinDirection.OUTPUT)).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Attribute mapping
  // ---------------------------------------------------------------------------

  describe("attributeMapping", () => {
    it("Selector Bits maps to selectorBits", () => {
      const entries: Record<string, string> = {
        "Selector Bits": "3",
      };
      const bag = new PropertyBag();
      for (const mapping of PRIORITY_ENCODER_ATTRIBUTE_MAPPINGS) {
        if (entries[mapping.xmlName] !== undefined) {
          bag.set(mapping.propertyKey, mapping.convert(entries[mapping.xmlName]));
        }
      }
      expect(bag.get<number>("selectorBits")).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  describe("draw", () => {
    it("draw() calls drawPolygon for the body", () => {
      const el = makePrioEnc();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const polygonCalls = calls.filter((c) => c.method === "drawPolygon");
      expect(polygonCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("draw() renders 'Priority' component name text", () => {
      const el = makePrioEnc();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.some((c) => c.args[0] === "Priority")).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // ComponentDefinition completeness
  // ---------------------------------------------------------------------------

  describe("definitionComplete", () => {
    it("PriorityEncoderDefinition has name='PriorityEncoder'", () => {
      expect(PriorityEncoderDefinition.name).toBe("PriorityEncoder");
    });

    it("PriorityEncoderDefinition has typeId=-1 (sentinel)", () => {
      expect(PriorityEncoderDefinition.typeId).toBe(-1);
    });

    it("PriorityEncoderDefinition factory produces element with correct typeId", () => {
      const props = new PropertyBag();
      props.set("selectorBits", 2);
      const el = PriorityEncoderDefinition.factory(props);
      expect(el.typeId).toBe("PriorityEncoder");
    });

    it("PriorityEncoderDefinition has executeFn=executePriorityEncoder", () => {
      expect(PriorityEncoderDefinition.models.digital!.executeFn).toBe(executePriorityEncoder);
    });

    it("PriorityEncoderDefinition has non-empty pinLayout", () => {
      expect(PriorityEncoderDefinition.pinLayout.length).toBeGreaterThan(0);
    });

    it("PriorityEncoderDefinition propertyDefs include selectorBits", () => {
      const keys = PriorityEncoderDefinition.propertyDefs.map((d) => d.key);
      expect(keys).toContain("selectorBits");
    });

    it("PriorityEncoderDefinition attributeMap covers Selector Bits", () => {
      const xmlNames = PriorityEncoderDefinition.attributeMap.map((m) => m.xmlName);
      expect(xmlNames).toContain("Selector Bits");
    });

    it("PriorityEncoderDefinition category is WIRING", () => {
      expect(PriorityEncoderDefinition.category).toBe(ComponentCategory.WIRING);
    });

    it("PriorityEncoderDefinition has a non-empty helpText", () => {
      expect(typeof PriorityEncoderDefinition.helpText).toBe("string");
      expect(typeof PriorityEncoderDefinition.helpText).toBe("string"); expect(PriorityEncoderDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });

    it("PriorityEncoderDefinition can be registered in ComponentRegistry without throwing", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(PriorityEncoderDefinition)).not.toThrow();
    });

    it("After registration, typeId is a non-negative integer", () => {
      const registry = new ComponentRegistry();
      registry.register(PriorityEncoderDefinition);
      const registered = registry.get("PriorityEncoder");
      expect(registered).not.toBeUndefined();
      expect(registered!.typeId).toBeGreaterThanOrEqual(0);
    });
  });
});
