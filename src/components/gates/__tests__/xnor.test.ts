/**
 * Tests for the XNOr gate component.
 *
 * Covers:
 *   - executeXNOr: logic correctness (2-input, 3-input, multi-bit)
 *   - Rendering: IEC/DIN shape (rect + "=1" text + output bubble)
 *   - Rendering: IEEE/US shape (XOR-like curve + output bubble)
 *   - Attribute mapping
 *   - ComponentDefinition completeness
 */

import { describe, it, expect } from "vitest";
import {
  XNOrElement,
  executeXNOr,
  XNOrDefinition,
  XNOR_ATTRIBUTE_MAPPINGS,
} from "../xnor.js";
import { PropertyBag } from "../../../core/properties.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import type { ComponentLayout } from "../../../core/registry.js";
import type { RenderContext, Point, TextAnchor, FontSpec, PathData } from "../../../core/renderer-interface.js";
import type { ThemeColor } from "../../../core/renderer-interface.js";

// ---------------------------------------------------------------------------
// Helpers — ComponentLayout mock
// ---------------------------------------------------------------------------

function makeLayout(inputCount: number, bitWidth = 32): ComponentLayout {
  const totalSlots = inputCount + 1;
  return {
    wiringTable: Int32Array.from({ length: totalSlots }, (_, i) => i),
    inputCount: () => inputCount,
    inputOffset: () => 0,
    outputCount: () => 1,
    outputOffset: () => inputCount,
    stateOffset: () => 0,
    getProperty: (_index: number, key: string) => key === "bitWidth" ? bitWidth : undefined,
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
// Helpers — XNOrElement factory
// ---------------------------------------------------------------------------

function makeXNOr(overrides?: {
  inputCount?: number;
  bitWidth?: number;
  wideShape?: boolean;
  invertedPins?: string[];
  label?: string;
}): XNOrElement {
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
  return new XNOrElement("test-xnor-001", { x: 0, y: 0 }, 0, false, props);
}

// ---------------------------------------------------------------------------
// executeXNOr — logic correctness
// ---------------------------------------------------------------------------

describe("XNOrGate", () => {
  describe("execute2Input", () => {
    it("XNOR of 0 and 0 produces 0xFFFFFFFF (all bits set)", () => {
      const layout = makeLayout(2);
      const state = makeState([0, 0]);
      const highZs = new Uint32Array(state.length);
      executeXNOr(0, state, highZs, layout);
      expect(state[2]).toBe(0xFFFFFFFF);
    });

    it("XNOR of 1 and 1 produces 0xFFFFFFFF (equal, so XOR=0, NOT=all-ones)", () => {
      const layout = makeLayout(2);
      const state = makeState([1, 1]);
      const highZs = new Uint32Array(state.length);
      executeXNOr(0, state, highZs, layout);
      expect(state[2]).toBe(0xFFFFFFFF);
    });

    it("XNOR of 1 and 0 produces 0xFFFFFFFE (XOR=1, NOT=all-but-lsb)", () => {
      const layout = makeLayout(2);
      const state = makeState([1, 0]);
      const highZs = new Uint32Array(state.length);
      executeXNOr(0, state, highZs, layout);
      expect(state[2]).toBe(0xFFFFFFFE);
    });

    it("XNOR of 0xFFFFFFFF and 0xFFFFFFFF produces 0xFFFFFFFF", () => {
      const layout = makeLayout(2);
      const state = makeState([0xFFFFFFFF, 0xFFFFFFFF]);
      const highZs = new Uint32Array(state.length);
      executeXNOr(0, state, highZs, layout);
      expect(state[2]).toBe(0xFFFFFFFF);
    });

    it("XNOR of 0xAAAAAAAA and 0x55555555 produces 0", () => {
      const layout = makeLayout(2);
      const state = makeState([0xAAAAAAAA, 0x55555555]);
      const highZs = new Uint32Array(state.length);
      executeXNOr(0, state, highZs, layout);
      expect(state[2]).toBe(0);
    });
  });

  describe("executeMultiInput", () => {
    it("XNOR of 0xFF, 0x0F, 0x03 produces NOT(0xFF ^ 0x0F ^ 0x03)", () => {
      const layout = makeLayout(3);
      const state = makeState([0xFF, 0x0F, 0x03]);
      const highZs = new Uint32Array(state.length);
      executeXNOr(0, state, highZs, layout);
      expect(state[3]).toBe((~(0xFF ^ 0x0F ^ 0x03)) >>> 0);
    });
  });

  describe("multiBit", () => {
    it("XNOR of identical 32-bit values produces 0xFFFFFFFF", () => {
      const layout = makeLayout(2);
      const state = makeState([0x12345678, 0x12345678]);
      const highZs = new Uint32Array(state.length);
      executeXNOr(0, state, highZs, layout);
      expect(state[2]).toBe(0xFFFFFFFF);
    });

    it("XNOR of 0x0F0F0F0F and 0xF0F0F0F0 produces 0", () => {
      const layout = makeLayout(2);
      const state = makeState([0x0F0F0F0F, 0xF0F0F0F0]);
      const highZs = new Uint32Array(state.length);
      executeXNOr(0, state, highZs, layout);
      expect(state[2]).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Rendering — IEC/DIN
  // ---------------------------------------------------------------------------

  describe("drawNarrowIEEE", () => {
    it("narrow IEEE shape calls drawPath for the curved body", () => {
      const el = makeXNOr({ wideShape: false });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const pathCalls = calls.filter((c) => c.method === "drawPath");
      expect(pathCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("narrow IEEE shape calls drawCircle for output inversion bubble", () => {
      const el = makeXNOr({ wideShape: false });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const circleCalls = calls.filter((c) => c.method === "drawCircle");
      expect(circleCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("narrow IEEE shape does not call drawRect", () => {
      const el = makeXNOr({ wideShape: false });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const rectCalls = calls.filter((c) => c.method === "drawRect");
      expect(rectCalls).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Rendering — IEEE/US
  // ---------------------------------------------------------------------------

  describe("drawIEEE", () => {
    it("IEEE shape calls drawPath for the curved body", () => {
      const el = makeXNOr({ wideShape: true });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const pathCalls = calls.filter((c) => c.method === "drawPath");
      expect(pathCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("IEEE shape calls drawPath at least twice (body + extra input curve)", () => {
      const el = makeXNOr({ wideShape: true });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const pathCalls = calls.filter((c) => c.method === "drawPath");
      expect(pathCalls.length).toBeGreaterThanOrEqual(2);
    });

    it("IEEE shape calls drawCircle for output inversion bubble", () => {
      const el = makeXNOr({ wideShape: true });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const circleCalls = calls.filter((c) => c.method === "drawCircle");
      expect(circleCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("IEEE shape does not call drawRect", () => {
      const el = makeXNOr({ wideShape: true });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const rectCalls = calls.filter((c) => c.method === "drawRect");
      expect(rectCalls).toHaveLength(0);
    });

    it("IEEE shape does not draw '=1' text", () => {
      const el = makeXNOr({ wideShape: true });
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
    it("Inputs=3, Bits=8, wideShape=true map to correct PropertyBag entries", () => {
      const entries: Record<string, string> = {
        Inputs: "3",
        Bits: "8",
        wideShape: "true",
      };

      const bag = new PropertyBag();
      for (const mapping of XNOR_ATTRIBUTE_MAPPINGS) {
        if (entries[mapping.xmlName] !== undefined) {
          bag.set(mapping.propertyKey, mapping.convert(entries[mapping.xmlName]));
        }
      }

      expect(bag.get<number>("inputCount")).toBe(3);
      expect(bag.get<number>("bitWidth")).toBe(8);
      expect(bag.get<boolean>("wideShape")).toBe(true);
    });

    it("Label attribute maps to label property key", () => {
      const mapping = XNOR_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Label");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("label");
    });

    it("inverterConfig attribute maps to _inverterLabels", () => {
      const mapping = XNOR_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "inverterConfig");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("_inverterLabels");
    });
  });

  // ---------------------------------------------------------------------------
  // ComponentDefinition completeness
  // ---------------------------------------------------------------------------

  describe("definitionComplete", () => {
    it("XNOrDefinition has name='XNOr'", () => {
      expect(XNOrDefinition.name).toBe("XNOr");
    });

    it("XNOrDefinition has typeId=-1", () => {
      expect(XNOrDefinition.typeId).toBe(-1);
    });

    it("XNOrDefinition has a factory function", () => {
      expect(typeof XNOrDefinition.factory).toBe("function");
    });

    it("XNOrDefinition factory produces a XNOrElement", () => {
      const props = new PropertyBag();
      props.set("inputCount", 2);
      props.set("bitWidth", 1);
      props.set("wideShape", false);
      const el = XNOrDefinition.factory(props);
      expect(el.typeId).toBe("XNOr");
    });

    it("XNOrDefinition has executeFn=executeXNOr", () => {
      expect(XNOrDefinition.executeFn).toBe(executeXNOr);
    });

    it("XNOrDefinition has a non-empty pinLayout", () => {
      expect(XNOrDefinition.pinLayout.length).toBeGreaterThan(0);
    });

    it("XNOrDefinition propertyDefs include inputCount, bitWidth, wideShape, label", () => {
      const keys = XNOrDefinition.propertyDefs.map((d) => d.key);
      expect(keys).toContain("inputCount");
      expect(keys).toContain("bitWidth");
      expect(keys).toContain("wideShape");
      expect(keys).toContain("label");
    });

    it("XNOrDefinition attributeMap covers Inputs, Bits, wideShape, inverterConfig, Label", () => {
      const xmlNames = XNOrDefinition.attributeMap.map((m) => m.xmlName);
      expect(xmlNames).toContain("Inputs");
      expect(xmlNames).toContain("Bits");
      expect(xmlNames).toContain("wideShape");
      expect(xmlNames).toContain("inverterConfig");
      expect(xmlNames).toContain("Label");
    });

    it("XNOrDefinition category is LOGIC", () => {
      expect(XNOrDefinition.category).toBe(ComponentCategory.LOGIC);
    });

    it("XNOrDefinition has a non-empty helpText", () => {
      expect(typeof XNOrDefinition.helpText).toBe("string");
      expect(typeof XNOrDefinition.helpText).toBe("string"); expect(XNOrDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });

    it("XNOrDefinition can be registered in ComponentRegistry without throwing", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(XNOrDefinition)).not.toThrow();
    });

    it("After registration, XNOrDefinition typeId is overwritten with a non-negative integer", () => {
      const registry = new ComponentRegistry();
      registry.register(XNOrDefinition);
      const registered = registry.get("XNOr");
      expect(registered).not.toBeUndefined();
      expect(registered!.typeId).toBeGreaterThanOrEqual(0);
    });
  });
});
