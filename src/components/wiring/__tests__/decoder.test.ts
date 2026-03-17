/**
 * Tests for the Decoder component.
 *
 * Covers:
 *   - executeDecoder: one-hot output for all selector values
 *   - executeDecoder: 1-bit and 2-bit selector configurations
 *   - Pin layout: correct counts and labels
 *   - Attribute mapping
 *   - Rendering
 *   - ComponentDefinition completeness
 */

import { describe, it, expect } from "vitest";
import {
  DecoderElement,
  executeDecoder,
  DecoderDefinition,
  DECODER_ATTRIBUTE_MAPPINGS,
  buildDecoderPinDeclarations,
} from "../decoder.js";
import { PropertyBag } from "../../../core/properties.js";
import { PinDirection } from "../../../core/pin.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import type { ComponentLayout } from "../../../core/registry.js";
import type { RenderContext, Point, TextAnchor, FontSpec, PathData } from "../../../core/renderer-interface.js";
import type { ThemeColor } from "../../../core/renderer-interface.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLayout(inputCount: number, outputCount: number): ComponentLayout {
  return {
    wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: () => inputCount,
    inputOffset: () => 0,
    outputCount: () => outputCount,
    outputOffset: () => inputCount,
    stateOffset: () => inputCount + outputCount,
    getProperty: () => undefined,
  };
}

function makeState(inputs: number[], outputCount: number): Uint32Array {
  const arr = new Uint32Array(inputs.length + outputCount);
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

function makeDecoder(overrides?: { selectorBits?: number }): DecoderElement {
  const props = new PropertyBag();
  props.set("selectorBits", overrides?.selectorBits ?? 2);
  return new DecoderElement("test-dec-001", { x: 0, y: 0 }, 0, false, props);
}

// ---------------------------------------------------------------------------
// executeDecoder — logic correctness
// ---------------------------------------------------------------------------

describe("Decoder", () => {
  describe("execute2Input", () => {
    it("1-bit selector: sel=0 → out_0=1, out_1=0", () => {
      // inputs: [sel=0]; outputs: [out_0, out_1]
      const layout = makeLayout(1, 2);
      const state = makeState([0], 2);
      const highZs = new Uint32Array(state.length);
      executeDecoder(0, state, highZs, layout);
      expect(state[1]).toBe(1); // out_0
      expect(state[2]).toBe(0); // out_1
    });

    it("1-bit selector: sel=1 → out_0=0, out_1=1", () => {
      const layout = makeLayout(1, 2);
      const state = makeState([1], 2);
      const highZs = new Uint32Array(state.length);
      executeDecoder(0, state, highZs, layout);
      expect(state[1]).toBe(0); // out_0
      expect(state[2]).toBe(1); // out_1
    });
  });

  describe("execute2BitSelector", () => {
    it("2-bit selector: sel=0 → one-hot at index 0", () => {
      // inputs: [sel=0]; outputs: [out_0..out_3]
      const layout = makeLayout(1, 4);
      const state = makeState([0], 4);
      const highZs = new Uint32Array(state.length);
      executeDecoder(0, state, highZs, layout);
      expect(state[1]).toBe(1); // out_0
      expect(state[2]).toBe(0); // out_1
      expect(state[3]).toBe(0); // out_2
      expect(state[4]).toBe(0); // out_3
    });

    it("2-bit selector: sel=1 → one-hot at index 1", () => {
      const layout = makeLayout(1, 4);
      const state = makeState([1], 4);
      const highZs = new Uint32Array(state.length);
      executeDecoder(0, state, highZs, layout);
      expect(state[1]).toBe(0);
      expect(state[2]).toBe(1);
      expect(state[3]).toBe(0);
      expect(state[4]).toBe(0);
    });

    it("2-bit selector: sel=2 → one-hot at index 2", () => {
      const layout = makeLayout(1, 4);
      const state = makeState([2], 4);
      const highZs = new Uint32Array(state.length);
      executeDecoder(0, state, highZs, layout);
      expect(state[1]).toBe(0);
      expect(state[2]).toBe(0);
      expect(state[3]).toBe(1);
      expect(state[4]).toBe(0);
    });

    it("2-bit selector: sel=3 → one-hot at index 3", () => {
      const layout = makeLayout(1, 4);
      const state = makeState([3], 4);
      const highZs = new Uint32Array(state.length);
      executeDecoder(0, state, highZs, layout);
      expect(state[1]).toBe(0);
      expect(state[2]).toBe(0);
      expect(state[3]).toBe(0);
      expect(state[4]).toBe(1);
    });
  });

  describe("executeOneHotProperty", () => {
    it("exactly one output is 1 for any selector value", () => {
      const layout = makeLayout(1, 4);
      for (let sel = 0; sel < 4; sel++) {
        const state = makeState([sel], 4);
      const highZs = new Uint32Array(state.length);
        executeDecoder(0, state, highZs, layout);
        let ones = 0;
        for (let i = 1; i <= 4; i++) {
          if (state[i] === 1) ones++;
        }
        expect(ones).toBe(1);
      }
    });

    it("all other outputs are 0 when one is active", () => {
      const layout = makeLayout(1, 4);
      const state = makeState([2], 4);
      const highZs = new Uint32Array(state.length);
      executeDecoder(0, state, highZs, layout);
      // All outputs should be 0 except out_2
      const outputs = [state[1], state[2], state[3], state[4]];
      outputs.forEach((v, i) => {
        if (i === 2) {
          expect(v).toBe(1);
        } else {
          expect(v).toBe(0);
        }
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Pin layout
  // ---------------------------------------------------------------------------

  describe("pinLayout2BitSelector", () => {
    it("2-bit selector produces 1 input pin and 4 output pins", () => {
      const el = makeDecoder({ selectorBits: 2 });
      const pins = el.getPins();
      const inputs = pins.filter((p) => p.direction === PinDirection.INPUT);
      const outputs = pins.filter((p) => p.direction === PinDirection.OUTPUT);
      expect(inputs).toHaveLength(1);
      expect(outputs).toHaveLength(4);
    });

    it("input pin is labeled 'sel'", () => {
      const el = makeDecoder({ selectorBits: 2 });
      const inputs = el.getPins().filter((p) => p.direction === PinDirection.INPUT);
      expect(inputs[0].label).toBe("sel");
    });

    it("output pins labeled out_0..out_3", () => {
      const el = makeDecoder({ selectorBits: 2 });
      const outputs = el.getPins().filter((p) => p.direction === PinDirection.OUTPUT);
      expect(outputs.map((p) => p.label)).toEqual(["out_0", "out_1", "out_2", "out_3"]);
    });
  });

  describe("pinLayout1BitSelector", () => {
    it("1-bit selector produces 1 input and 2 outputs", () => {
      const el = makeDecoder({ selectorBits: 1 });
      const pins = el.getPins();
      const inputs = pins.filter((p) => p.direction === PinDirection.INPUT);
      const outputs = pins.filter((p) => p.direction === PinDirection.OUTPUT);
      expect(inputs).toHaveLength(1);
      expect(outputs).toHaveLength(2);
    });
  });

  describe("pinLayoutFromDeclarations", () => {
    it("buildDecoderPinDeclarations(2) produces 1 input + 4 outputs", () => {
      const decls = buildDecoderPinDeclarations(2);
      expect(decls.filter((d) => d.direction === PinDirection.INPUT)).toHaveLength(1);
      expect(decls.filter((d) => d.direction === PinDirection.OUTPUT)).toHaveLength(4);
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
      for (const mapping of DECODER_ATTRIBUTE_MAPPINGS) {
        if (entries[mapping.xmlName] !== undefined) {
          bag.set(mapping.propertyKey, mapping.convert(entries[mapping.xmlName]));
        }
      }
      expect(bag.get<number>("selectorBits")).toBe(3);
    });

    it("Label maps to label property key", () => {
      const mapping = DECODER_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Label");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.convert("MyDecoder")).toBe("MyDecoder");
    });
  });

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  describe("draw", () => {
    it("draw() calls drawPolygon for trapezoid body", () => {
      const el = makeDecoder();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const polygonCalls = calls.filter((c) => c.method === "drawPolygon");
      expect(polygonCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("draw() renders '0' text label", () => {
      const el = makeDecoder();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.some((c) => c.args[0] === "0")).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // ComponentDefinition completeness
  // ---------------------------------------------------------------------------

  describe("definitionComplete", () => {
    it("DecoderDefinition has name='Decoder'", () => {
      expect(DecoderDefinition.name).toBe("Decoder");
    });

    it("DecoderDefinition has typeId=-1 (sentinel)", () => {
      expect(DecoderDefinition.typeId).toBe(-1);
    });

    it("DecoderDefinition factory produces a DecoderElement with correct typeId", () => {
      const props = new PropertyBag();
      props.set("selectorBits", 2);
      const el = DecoderDefinition.factory(props);
      expect(el.typeId).toBe("Decoder");
    });

    it("DecoderDefinition has executeFn=executeDecoder", () => {
      expect(DecoderDefinition.executeFn).toBe(executeDecoder);
    });

    it("DecoderDefinition has non-empty pinLayout", () => {
      expect(DecoderDefinition.pinLayout.length).toBeGreaterThan(0);
    });

    it("DecoderDefinition propertyDefs include selectorBits", () => {
      const keys = DecoderDefinition.propertyDefs.map((d) => d.key);
      expect(keys).toContain("selectorBits");
    });

    it("DecoderDefinition attributeMap covers Selector Bits", () => {
      const xmlNames = DecoderDefinition.attributeMap.map((m) => m.xmlName);
      expect(xmlNames).toContain("Selector Bits");
    });

    it("DecoderDefinition category is WIRING", () => {
      expect(DecoderDefinition.category).toBe(ComponentCategory.WIRING);
    });

    it("DecoderDefinition has a non-empty helpText", () => {
      expect(typeof DecoderDefinition.helpText).toBe("string");
      expect(typeof DecoderDefinition.helpText).toBe("string"); expect(DecoderDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });

    it("DecoderDefinition can be registered in ComponentRegistry without throwing", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(DecoderDefinition)).not.toThrow();
    });

    it("After registration, typeId is a non-negative integer", () => {
      const registry = new ComponentRegistry();
      registry.register(DecoderDefinition);
      const registered = registry.get("Decoder");
      expect(registered).not.toBeUndefined();
      expect(registered!.typeId).toBeGreaterThanOrEqual(0);
    });
  });
});
