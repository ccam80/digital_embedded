/**
 * Tests for the XOr gate component.
 *
 * Covers:
 *   - executeXOr: logic correctness (2-input, 3-input, multi-bit)
 *   - Rendering: IEC/DIN shape (rect + "=1" text)
 *   - Rendering: IEEE/US shape (OR-like curve + extra input curve)
 *   - Attribute mapping
 *   - ComponentDefinition completeness
 */

import { describe, it, expect } from "vitest";
import {
  XOrElement,
  executeXOr,
  XOrDefinition,
  XOR_ATTRIBUTE_MAPPINGS,
} from "../xor.js";
import { PropertyBag } from "../../../core/properties.js";
import { PinDirection } from "../../../core/pin.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import type { ComponentLayout } from "../../../core/registry.js";
import type { RenderContext, Point, TextAnchor, FontSpec, PathData } from "../../../core/renderer-interface.js";
import type { ThemeColor } from "../../../core/renderer-interface.js";

// ---------------------------------------------------------------------------
// Helpers — ComponentLayout mock
// ---------------------------------------------------------------------------

function makeLayout(inputCount: number): ComponentLayout {
  return {
    inputCount: () => inputCount,
    inputOffset: () => 0,
    outputCount: () => 1,
    outputOffset: () => inputCount,
  };
}

function makeState(inputs: number[]): Uint32Array {
  const arr = new Uint32Array(inputs.length + 1);
  for (let i = 0; i < inputs.length; i++) {
    arr[i] = inputs[i] >>> 0;
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Helpers — RenderContext mock
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers — XOrElement factory
// ---------------------------------------------------------------------------

function makeXOr(overrides?: {
  inputCount?: number;
  bitWidth?: number;
  wideShape?: boolean;
  invertedPins?: string[];
  label?: string;
}): XOrElement {
  const props = new PropertyBag();
  props.set("inputCount", overrides?.inputCount ?? 2);
  props.set("bitWidth", overrides?.bitWidth ?? 1);
  props.set("wideShape", overrides?.wideShape ?? false);
  if (overrides?.invertedPins && overrides.invertedPins.length > 0) {
    props.set("_inverterLabels", overrides.invertedPins.join(","));
  }
  if (overrides?.label !== undefined) {
    props.set("label", overrides.label);
  }
  return new XOrElement("test-xor-001", { x: 0, y: 0 }, 0, false, props);
}

// ---------------------------------------------------------------------------
// executeXOr — logic correctness
// ---------------------------------------------------------------------------

describe("XOrGate", () => {
  describe("execute2Input", () => {
    it("XOR of 0 and 0 produces 0", () => {
      const layout = makeLayout(2);
      const state = makeState([0, 0]);
      executeXOr(0, state, layout);
      expect(state[2]).toBe(0);
    });

    it("XOR of 1 and 0 produces 1", () => {
      const layout = makeLayout(2);
      const state = makeState([1, 0]);
      executeXOr(0, state, layout);
      expect(state[2]).toBe(1);
    });

    it("XOR of 1 and 1 produces 0", () => {
      const layout = makeLayout(2);
      const state = makeState([1, 1]);
      executeXOr(0, state, layout);
      expect(state[2]).toBe(0);
    });

    it("XOR of 0xFFFFFFFF and 0xFFFFFFFF produces 0", () => {
      const layout = makeLayout(2);
      const state = makeState([0xFFFFFFFF, 0xFFFFFFFF]);
      executeXOr(0, state, layout);
      expect(state[2]).toBe(0);
    });

    it("XOR of 0xAAAAAAAA and 0x55555555 produces 0xFFFFFFFF", () => {
      const layout = makeLayout(2);
      const state = makeState([0xAAAAAAAA, 0x55555555]);
      executeXOr(0, state, layout);
      expect(state[2]).toBe(0xFFFFFFFF);
    });
  });

  describe("executeMultiInput", () => {
    it("XOR of 0xFF, 0x0F, 0x03 produces 0xFF ^ 0x0F ^ 0x03", () => {
      const layout = makeLayout(3);
      const state = makeState([0xFF, 0x0F, 0x03]);
      executeXOr(0, state, layout);
      expect(state[3]).toBe((0xFF ^ 0x0F ^ 0x03) >>> 0);
    });

    it("XOR of 4 equal values produces 0 (even number of highs)", () => {
      const layout = makeLayout(4);
      const state = makeState([0xFF, 0xFF, 0xFF, 0xFF]);
      executeXOr(0, state, layout);
      expect(state[4]).toBe(0);
    });

    it("XOR of 3 equal values produces original (odd number of highs)", () => {
      const layout = makeLayout(3);
      const state = makeState([0xAB, 0xAB, 0xAB]);
      executeXOr(0, state, layout);
      expect(state[3]).toBe(0xAB);
    });
  });

  describe("multiBit", () => {
    it("XOR of 0x0F0F0F0F and 0xF0F0F0F0 produces 0xFFFFFFFF", () => {
      const layout = makeLayout(2);
      const state = makeState([0x0F0F0F0F, 0xF0F0F0F0]);
      executeXOr(0, state, layout);
      expect(state[2]).toBe(0xFFFFFFFF);
    });

    it("XOR of identical multi-bit values produces 0", () => {
      const layout = makeLayout(2);
      const state = makeState([0x12345678, 0x12345678]);
      executeXOr(0, state, layout);
      expect(state[2]).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Rendering — IEC/DIN
  // ---------------------------------------------------------------------------

  describe("drawIEC", () => {
    it("IEC shape calls drawRect and drawText with '=1'", () => {
      const el = makeXOr({ wideShape: false });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const rectCalls = calls.filter((c) => c.method === "drawRect");
      const textCalls = calls.filter((c) => c.method === "drawText");

      expect(rectCalls.length).toBeGreaterThanOrEqual(1);
      expect(textCalls.some((c) => c.args[0] === "=1")).toBe(true);
    });

    it("IEC shape does not call drawPath for the gate body", () => {
      const el = makeXOr({ wideShape: false });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const pathCalls = calls.filter((c) => c.method === "drawPath");
      expect(pathCalls).toHaveLength(0);
    });

    it("IEC shape does not draw inversion bubble", () => {
      const el = makeXOr({ wideShape: false });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const circleCalls = calls.filter((c) => c.method === "drawCircle");
      expect(circleCalls).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Rendering — IEEE/US
  // ---------------------------------------------------------------------------

  describe("drawIEEE", () => {
    it("IEEE shape calls drawPath for the curved body", () => {
      const el = makeXOr({ wideShape: true });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const pathCalls = calls.filter((c) => c.method === "drawPath");
      expect(pathCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("IEEE shape calls drawPath at least twice (body + extra curve)", () => {
      const el = makeXOr({ wideShape: true });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const pathCalls = calls.filter((c) => c.method === "drawPath");
      expect(pathCalls.length).toBeGreaterThanOrEqual(2);
    });

    it("IEEE shape path includes curveTo operations", () => {
      const el = makeXOr({ wideShape: true });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const pathCalls = calls.filter((c) => c.method === "drawPath");
      const hasCurve = pathCalls.some((c) => {
        const path = c.args[0] as PathData;
        return path.operations.some((op) => op.op === "curveTo");
      });
      expect(hasCurve).toBe(true);
    });

    it("IEEE shape does not call drawRect", () => {
      const el = makeXOr({ wideShape: true });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const rectCalls = calls.filter((c) => c.method === "drawRect");
      expect(rectCalls).toHaveLength(0);
    });

    it("IEEE shape does not draw '=1' text", () => {
      const el = makeXOr({ wideShape: true });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.some((c) => c.args[0] === "=1")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Attribute mapping
  // ---------------------------------------------------------------------------

  describe("attributeMapping", () => {
    it("Inputs=3, Bits=4, wideShape=true map to correct PropertyBag entries", () => {
      const entries: Record<string, string> = {
        Inputs: "3",
        Bits: "4",
        wideShape: "true",
      };

      const bag = new PropertyBag();
      for (const mapping of XOR_ATTRIBUTE_MAPPINGS) {
        if (entries[mapping.xmlName] !== undefined) {
          bag.set(mapping.propertyKey, mapping.convert(entries[mapping.xmlName]));
        }
      }

      expect(bag.get<number>("inputCount")).toBe(3);
      expect(bag.get<number>("bitWidth")).toBe(4);
      expect(bag.get<boolean>("wideShape")).toBe(true);
    });

    it("Label attribute maps to label property key", () => {
      const mapping = XOR_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Label");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("label");
    });
  });

  // ---------------------------------------------------------------------------
  // ComponentDefinition completeness
  // ---------------------------------------------------------------------------

  describe("definitionComplete", () => {
    it("XOrDefinition has name='XOr'", () => {
      expect(XOrDefinition.name).toBe("XOr");
    });

    it("XOrDefinition has typeId=-1", () => {
      expect(XOrDefinition.typeId).toBe(-1);
    });

    it("XOrDefinition has a factory function", () => {
      expect(typeof XOrDefinition.factory).toBe("function");
    });

    it("XOrDefinition factory produces a XOrElement", () => {
      const props = new PropertyBag();
      props.set("inputCount", 2);
      props.set("bitWidth", 1);
      props.set("wideShape", false);
      const el = XOrDefinition.factory(props);
      expect(el.typeId).toBe("XOr");
    });

    it("XOrDefinition has executeFn=executeXOr", () => {
      expect(XOrDefinition.executeFn).toBe(executeXOr);
    });

    it("XOrDefinition has a non-empty pinLayout", () => {
      expect(XOrDefinition.pinLayout.length).toBeGreaterThan(0);
    });

    it("XOrDefinition propertyDefs include inputCount, bitWidth, wideShape, label", () => {
      const keys = XOrDefinition.propertyDefs.map((d) => d.key);
      expect(keys).toContain("inputCount");
      expect(keys).toContain("bitWidth");
      expect(keys).toContain("wideShape");
      expect(keys).toContain("label");
    });

    it("XOrDefinition attributeMap covers Inputs, Bits, wideShape, inverterConfig, Label", () => {
      const xmlNames = XOrDefinition.attributeMap.map((m) => m.xmlName);
      expect(xmlNames).toContain("Inputs");
      expect(xmlNames).toContain("Bits");
      expect(xmlNames).toContain("wideShape");
      expect(xmlNames).toContain("inverterConfig");
      expect(xmlNames).toContain("Label");
    });

    it("XOrDefinition category is LOGIC", () => {
      expect(XOrDefinition.category).toBe(ComponentCategory.LOGIC);
    });

    it("XOrDefinition has a non-empty helpText", () => {
      expect(typeof XOrDefinition.helpText).toBe("string");
      expect(typeof XOrDefinition.helpText).toBe("string"); expect(XOrDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });

    it("XOrDefinition can be registered in ComponentRegistry without throwing", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(XOrDefinition)).not.toThrow();
    });

    it("After registration, XOrDefinition typeId is overwritten with a non-negative integer", () => {
      const registry = new ComponentRegistry();
      registry.register(XOrDefinition);
      const registered = registry.get("XOr");
      expect(registered).not.toBeUndefined();
      expect(registered!.typeId).toBeGreaterThanOrEqual(0);
    });
  });
});
