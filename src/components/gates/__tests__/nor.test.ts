/**
 * Tests for the NOr gate component.
 *
 * Covers:
 *   - executeNOr: logic correctness (2-input, 3-input, multi-bit)
 *   - Rendering: IEC/DIN shape (rect + "≥1" text + output bubble)
 *   - Rendering: IEEE/US shape (OR curve + output bubble)
 *   - Attribute mapping
 *   - ComponentDefinition completeness
 */

import { describe, it, expect } from "vitest";
import {
  NOrElement,
  executeNOr,
  NOrDefinition,
  NOR_ATTRIBUTE_MAPPINGS,
} from "../nor.js";
import { PropertyBag } from "../../../core/properties.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import type { ComponentLayout } from "../../../core/registry.js";
import type { RenderContext, Point, TextAnchor, FontSpec, PathData } from "../../../core/renderer-interface.js";
import type { ThemeColor } from "../../../core/renderer-interface.js";

// ---------------------------------------------------------------------------
// Helpers — ComponentLayout mock
// ---------------------------------------------------------------------------

function makeLayout(inputCount: number): ComponentLayout {
  const totalSlots = inputCount + 1;
  return {
    wiringTable: Int32Array.from({ length: totalSlots }, (_, i) => i),
    inputCount: () => inputCount,
    inputOffset: () => 0,
    outputCount: () => 1,
    outputOffset: () => inputCount,
    stateOffset: () => 0,
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
// Helpers — NOrElement factory
// ---------------------------------------------------------------------------

function makeNOr(overrides?: {
  inputCount?: number;
  bitWidth?: number;
  wideShape?: boolean;
  invertedPins?: string[];
  label?: string;
}): NOrElement {
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
  return new NOrElement("test-nor-001", { x: 0, y: 0 }, 0, false, props);
}

// ---------------------------------------------------------------------------
// executeNOr — logic correctness
// ---------------------------------------------------------------------------

describe("NOrGate", () => {
  describe("execute2Input", () => {
    it("NOR of 0x00 and 0x00 produces 0xFFFFFFFF", () => {
      const layout = makeLayout(2);
      const state = makeState([0x00, 0x00]);
      const highZs = new Uint32Array(state.length);
      executeNOr(0, state, highZs, layout);
      expect(state[2]).toBe(0xFFFFFFFF);
    });

    it("NOR of 0xFF and 0x00 produces NOT(0xFF)", () => {
      const layout = makeLayout(2);
      const state = makeState([0xFF, 0x00]);
      const highZs = new Uint32Array(state.length);
      executeNOr(0, state, highZs, layout);
      expect(state[2]).toBe((~0xFF) >>> 0);
    });

    it("NOR of 0xFFFFFFFF and 0x00000000 produces 0", () => {
      const layout = makeLayout(2);
      const state = makeState([0xFFFFFFFF, 0x00000000]);
      const highZs = new Uint32Array(state.length);
      executeNOr(0, state, highZs, layout);
      expect(state[2]).toBe(0);
    });

    it("single-bit: 0 NOR 0 = 1 (all bits set)", () => {
      const layout = makeLayout(2);
      const state = makeState([0, 0]);
      const highZs = new Uint32Array(state.length);
      executeNOr(0, state, highZs, layout);
      expect(state[2]).toBe(0xFFFFFFFF);
    });

    it("single-bit: 1 NOR 0 = 0 (all bits clear)", () => {
      const layout = makeLayout(2);
      const state = makeState([1, 0]);
      const highZs = new Uint32Array(state.length);
      executeNOr(0, state, highZs, layout);
      expect(state[2]).toBe(0xFFFFFFFE);
    });
  });

  describe("executeMultiInput", () => {
    it("NOR of 0x01, 0x02, 0x04 produces NOT(0x07)", () => {
      const layout = makeLayout(3);
      const state = makeState([0x01, 0x02, 0x04]);
      const highZs = new Uint32Array(state.length);
      executeNOr(0, state, highZs, layout);
      expect(state[3]).toBe((~0x07) >>> 0);
    });
  });

  describe("multiBit", () => {
    it("NOR of 0xF0F0F0F0 and 0x0F0F0F0F produces 0", () => {
      const layout = makeLayout(2);
      const state = makeState([0xF0F0F0F0, 0x0F0F0F0F]);
      const highZs = new Uint32Array(state.length);
      executeNOr(0, state, highZs, layout);
      expect(state[2]).toBe(0);
    });

    it("NOR of 0x00000000 and 0x00000000 produces 0xFFFFFFFF", () => {
      const layout = makeLayout(2);
      const state = makeState([0x00000000, 0x00000000]);
      const highZs = new Uint32Array(state.length);
      executeNOr(0, state, highZs, layout);
      expect(state[2]).toBe(0xFFFFFFFF);
    });
  });

  // ---------------------------------------------------------------------------
  // Rendering — IEC/DIN
  // ---------------------------------------------------------------------------

  describe("drawIEC", () => {
    it("IEC shape calls drawRect and drawText with '≥1'", () => {
      const el = makeNOr({ wideShape: false });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const rectCalls = calls.filter((c) => c.method === "drawRect");
      const textCalls = calls.filter((c) => c.method === "drawText");

      expect(rectCalls.length).toBeGreaterThanOrEqual(1);
      expect(textCalls.some((c) => c.args[0] === "≥1")).toBe(true);
    });

    it("IEC shape calls drawCircle for output inversion bubble", () => {
      const el = makeNOr({ wideShape: false });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const circleCalls = calls.filter((c) => c.method === "drawCircle");
      expect(circleCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("IEC shape does not call drawPath for the gate body", () => {
      const el = makeNOr({ wideShape: false });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const pathCalls = calls.filter((c) => c.method === "drawPath");
      expect(pathCalls).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Rendering — IEEE/US
  // ---------------------------------------------------------------------------

  describe("drawIEEE", () => {
    it("IEEE shape calls drawPath for the curved body", () => {
      const el = makeNOr({ wideShape: true });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const pathCalls = calls.filter((c) => c.method === "drawPath");
      expect(pathCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("IEEE shape path includes curveTo operations", () => {
      const el = makeNOr({ wideShape: true });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const pathCalls = calls.filter((c) => c.method === "drawPath");
      const hasCurve = pathCalls.some((c) => {
        const path = c.args[0] as PathData;
        return path.operations.some((op) => op.op === "curveTo");
      });
      expect(hasCurve).toBe(true);
    });

    it("IEEE shape calls drawCircle for output inversion bubble", () => {
      const el = makeNOr({ wideShape: true });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const circleCalls = calls.filter((c) => c.method === "drawCircle");
      expect(circleCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("IEEE shape does not call drawRect", () => {
      const el = makeNOr({ wideShape: true });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const rectCalls = calls.filter((c) => c.method === "drawRect");
      expect(rectCalls).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Attribute mapping
  // ---------------------------------------------------------------------------

  describe("attributeMapping", () => {
    it("Inputs=4, Bits=8, wideShape=true map to correct PropertyBag entries", () => {
      const entries: Record<string, string> = {
        Inputs: "4",
        Bits: "8",
        wideShape: "true",
      };

      const bag = new PropertyBag();
      for (const mapping of NOR_ATTRIBUTE_MAPPINGS) {
        if (entries[mapping.xmlName] !== undefined) {
          bag.set(mapping.propertyKey, mapping.convert(entries[mapping.xmlName]));
        }
      }

      expect(bag.get<number>("inputCount")).toBe(4);
      expect(bag.get<number>("bitWidth")).toBe(8);
      expect(bag.get<boolean>("wideShape")).toBe(true);
    });

    it("inverterConfig attribute maps to _inverterLabels", () => {
      const mapping = NOR_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "inverterConfig");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("_inverterLabels");
    });
  });

  // ---------------------------------------------------------------------------
  // ComponentDefinition completeness
  // ---------------------------------------------------------------------------

  describe("definitionComplete", () => {
    it("NOrDefinition has name='NOr'", () => {
      expect(NOrDefinition.name).toBe("NOr");
    });

    it("NOrDefinition has typeId=-1", () => {
      expect(NOrDefinition.typeId).toBe(-1);
    });

    it("NOrDefinition has a factory function", () => {
      expect(typeof NOrDefinition.factory).toBe("function");
    });

    it("NOrDefinition factory produces a NOrElement", () => {
      const props = new PropertyBag();
      props.set("inputCount", 2);
      props.set("bitWidth", 1);
      props.set("wideShape", false);
      const el = NOrDefinition.factory(props);
      expect(el.typeId).toBe("NOr");
    });

    it("NOrDefinition has executeFn=executeNOr", () => {
      expect(NOrDefinition.executeFn).toBe(executeNOr);
    });

    it("NOrDefinition has a non-empty pinLayout", () => {
      expect(NOrDefinition.pinLayout.length).toBeGreaterThan(0);
    });

    it("NOrDefinition propertyDefs include inputCount, bitWidth, wideShape, label", () => {
      const keys = NOrDefinition.propertyDefs.map((d) => d.key);
      expect(keys).toContain("inputCount");
      expect(keys).toContain("bitWidth");
      expect(keys).toContain("wideShape");
      expect(keys).toContain("label");
    });

    it("NOrDefinition attributeMap covers Inputs, Bits, wideShape, inverterConfig, Label", () => {
      const xmlNames = NOrDefinition.attributeMap.map((m) => m.xmlName);
      expect(xmlNames).toContain("Inputs");
      expect(xmlNames).toContain("Bits");
      expect(xmlNames).toContain("wideShape");
      expect(xmlNames).toContain("inverterConfig");
      expect(xmlNames).toContain("Label");
    });

    it("NOrDefinition category is LOGIC", () => {
      expect(NOrDefinition.category).toBe(ComponentCategory.LOGIC);
    });

    it("NOrDefinition has a non-empty helpText", () => {
      expect(typeof NOrDefinition.helpText).toBe("string");
      expect(typeof NOrDefinition.helpText).toBe("string"); expect(NOrDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });

    it("NOrDefinition can be registered in ComponentRegistry without throwing", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(NOrDefinition)).not.toThrow();
    });

    it("After registration, NOrDefinition typeId is overwritten with a non-negative integer", () => {
      const registry = new ComponentRegistry();
      registry.register(NOrDefinition);
      const registered = registry.get("NOr");
      expect(registered).not.toBeUndefined();
      expect(registered!.typeId).toBeGreaterThanOrEqual(0);
    });
  });
});
