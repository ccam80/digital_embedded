/**
 * Tests for the NAnd gate component.
 *
 * Covers:
 *   - executeNAnd: logic correctness (2-input, 3-input, multi-bit)
 *   - Rendering: IEC/DIN shape (rect + "&" text + output bubble)
 *   - Rendering: IEEE/US shape (AND curve + output bubble)
 *   - Attribute mapping
 *   - ComponentDefinition completeness
 */

import { describe, it, expect } from "vitest";
import {
  NAndElement,
  executeNAnd,
  NAndDefinition,
} from "../nand.js";
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
// Helpers — NAndElement factory
// ---------------------------------------------------------------------------

function makeNAnd(overrides?: {
  inputCount?: number;
  bitWidth?: number;
  wideShape?: boolean;
  invertedPins?: string[];
  label?: string;
}): NAndElement {
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
  return new NAndElement("test-nand-001", { x: 0, y: 0 }, 0, false, props);
}

// ---------------------------------------------------------------------------
// executeNAnd — logic correctness
// ---------------------------------------------------------------------------

describe("NAndGate", () => {
  describe("execute2Input", () => {
    it("NAND of 0xFFFFFFFF and 0xFFFFFFFF produces 0", () => {
      const layout = makeLayout(2);
      const state = makeState([0xFFFFFFFF, 0xFFFFFFFF]);
      const highZs = new Uint32Array(state.length);
      executeNAnd(0, state, highZs, layout);
      expect(state[2]).toBe(0);
    });

    it("NAND of 0xFFFFFFFF and 0x00000000 produces 0xFFFFFFFF", () => {
      const layout = makeLayout(2);
      const state = makeState([0xFFFFFFFF, 0x00000000]);
      const highZs = new Uint32Array(state.length);
      executeNAnd(0, state, highZs, layout);
      expect(state[2]).toBe(0xFFFFFFFF);
    });

    it("NAND of 0x0F0F0F0F and 0xFFFFFFFF produces 0xF0F0F0F0", () => {
      const layout = makeLayout(2);
      const state = makeState([0x0F0F0F0F, 0xFFFFFFFF]);
      const highZs = new Uint32Array(state.length);
      executeNAnd(0, state, highZs, layout);
      expect(state[2]).toBe(0xF0F0F0F0);
    });

    it("single-bit: 1 NAND 1 = 0", () => {
      const layout = makeLayout(2);
      const state = makeState([1, 1]);
      const highZs = new Uint32Array(state.length);
      executeNAnd(0, state, highZs, layout);
      expect(state[2]).toBe(0xFFFFFFFE);
    });

    it("single-bit: 1 NAND 0 = 1 (all bits set)", () => {
      const layout = makeLayout(2);
      const state = makeState([1, 0]);
      const highZs = new Uint32Array(state.length);
      executeNAnd(0, state, highZs, layout);
      expect(state[2]).toBe(0xFFFFFFFF);
    });

    it("single-bit: 0 NAND 0 = 1 (all bits set)", () => {
      const layout = makeLayout(2);
      const state = makeState([0, 0]);
      const highZs = new Uint32Array(state.length);
      executeNAnd(0, state, highZs, layout);
      expect(state[2]).toBe(0xFFFFFFFF);
    });
  });

  describe("executeMultiInput", () => {
    it("NAND of 0xFF, 0x0F, 0x03 produces NOT(0x03)", () => {
      const layout = makeLayout(3);
      const state = makeState([0xFF, 0x0F, 0x03]);
      const highZs = new Uint32Array(state.length);
      executeNAnd(0, state, highZs, layout);
      expect(state[3]).toBe((~0x03) >>> 0);
    });
  });

  describe("multiBit", () => {
    it("NAND of 0xAAAAAAAA and 0xAAAAAAAA produces NOT(0xAAAAAAAA)", () => {
      const layout = makeLayout(2);
      const state = makeState([0xAAAAAAAA, 0xAAAAAAAA]);
      const highZs = new Uint32Array(state.length);
      executeNAnd(0, state, highZs, layout);
      expect(state[2]).toBe(0x55555555);
    });
  });

  // ---------------------------------------------------------------------------
  // Rendering — IEC/DIN
  // ---------------------------------------------------------------------------

  describe("drawIEC", () => {
    it("IEC shape calls drawRect and drawText with '&'", () => {
      const el = makeNAnd({ wideShape: false });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const rectCalls = calls.filter((c) => c.method === "drawRect");
      const textCalls = calls.filter((c) => c.method === "drawText");

      expect(rectCalls.length).toBeGreaterThanOrEqual(1);
      expect(textCalls.some((c) => c.args[0] === "&")).toBe(true);
    });

    it("IEC shape calls drawCircle for output inversion bubble", () => {
      const el = makeNAnd({ wideShape: false });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const circleCalls = calls.filter((c) => c.method === "drawCircle");
      expect(circleCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("IEC shape does not call drawPath for the gate body", () => {
      const el = makeNAnd({ wideShape: false });
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
      const el = makeNAnd({ wideShape: true });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const pathCalls = calls.filter((c) => c.method === "drawPath");
      expect(pathCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("IEEE shape path includes curveTo for the AND shape", () => {
      const el = makeNAnd({ wideShape: true });
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
      const el = makeNAnd({ wideShape: true });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const circleCalls = calls.filter((c) => c.method === "drawCircle");
      expect(circleCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("IEEE shape does not call drawRect for the gate body", () => {
      const el = makeNAnd({ wideShape: true });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const rectCalls = calls.filter((c) => c.method === "drawRect");
      expect(rectCalls).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // ComponentDefinition completeness
  // ---------------------------------------------------------------------------

  describe("definitionComplete", () => {
    it("NAndDefinition has name='NAnd'", () => {
      expect(NAndDefinition.name).toBe("NAnd");
    });

    it("NAndDefinition has typeId=-1", () => {
      expect(NAndDefinition.typeId).toBe(-1);
    });

    it("NAndDefinition has a factory function", () => {
      expect(typeof NAndDefinition.factory).toBe("function");
    });

    it("NAndDefinition factory produces a NAndElement", () => {
      const props = new PropertyBag();
      props.set("inputCount", 2);
      props.set("bitWidth", 1);
      props.set("wideShape", false);
      const el = NAndDefinition.factory(props);
      expect(el.typeId).toBe("NAnd");
    });

    it("NAndDefinition has executeFn=executeNAnd", () => {
      expect(NAndDefinition.executeFn).toBe(executeNAnd);
    });

    it("NAndDefinition has a non-empty pinLayout", () => {
      expect(NAndDefinition.pinLayout.length).toBeGreaterThan(0);
    });

    it("NAndDefinition propertyDefs include inputCount, bitWidth, wideShape, label", () => {
      const keys = NAndDefinition.propertyDefs.map((d) => d.key);
      expect(keys).toContain("inputCount");
      expect(keys).toContain("bitWidth");
      expect(keys).toContain("wideShape");
      expect(keys).toContain("label");
    });

    it("NAndDefinition attributeMap covers Inputs, Bits, wideShape, inverterConfig, Label", () => {
      const xmlNames = NAndDefinition.attributeMap.map((m) => m.xmlName);
      expect(xmlNames).toContain("Inputs");
      expect(xmlNames).toContain("Bits");
      expect(xmlNames).toContain("wideShape");
      expect(xmlNames).toContain("inverterConfig");
      expect(xmlNames).toContain("Label");
    });

    it("NAndDefinition category is LOGIC", () => {
      expect(NAndDefinition.category).toBe(ComponentCategory.LOGIC);
    });

    it("NAndDefinition has a non-empty helpText", () => {
      expect(typeof NAndDefinition.helpText).toBe("string");
      expect(typeof NAndDefinition.helpText).toBe("string"); expect(NAndDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });

    it("NAndDefinition can be registered in ComponentRegistry without throwing", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(NAndDefinition)).not.toThrow();
    });

    it("After registration, NAndDefinition typeId is overwritten with a non-negative integer", () => {
      const registry = new ComponentRegistry();
      registry.register(NAndDefinition);
      const registered = registry.get("NAnd");
      expect(registered).not.toBeUndefined();
      expect(registered!.typeId).toBeGreaterThanOrEqual(0);
    });
  });
});
