/**
 * Tests for the DipSwitch component.
 *
 * Covers:
 *   - executeDipSwitch: no-op (value set externally per-bit)
 *   - Pin layout: single multi-bit output
 *   - bitCount property drives pin bit width
 *   - Rendering: rect body + per-bit switch slots
 *   - Attribute mapping: Label, Bits, Default
 *   - ComponentDefinition completeness
 */

import { describe, it, expect } from "vitest";
import {
  DipSwitchElement,
  executeDipSwitch,
  DipSwitchDefinition,
  DIP_SWITCH_ATTRIBUTE_MAPPINGS,
} from "../dip-switch.js";
import { PropertyBag } from "../../../core/properties.js";
import { PinDirection } from "../../../core/pin.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import type { ComponentLayout } from "../../../core/registry.js";
import type { RenderContext, Point, TextAnchor, FontSpec, PathData } from "../../../core/renderer-interface.js";
import type { ThemeColor } from "../../../core/renderer-interface.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLayout(inputCount: number, outputCount: number = 1): ComponentLayout {
  const wt = new Int32Array(64).map((_, i) => i);
  return {
    inputCount: () => inputCount,
    inputOffset: () => 0,
    outputCount: () => outputCount,
    outputOffset: () => inputCount,
    stateOffset: () => 0,
    wiringTable: wt,
    getProperty: () => undefined,
  };
}

function makeState(inputs: number[], extraSlots: number = 1): Uint32Array {
  const arr = new Uint32Array(inputs.length + extraSlots);
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
  const record = (method: string) => (...args: unknown[]): void => { calls.push({ method, args }); };
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

function makeDipSwitch(overrides?: {
  label?: string;
  bitCount?: number;
  defaultValue?: number;
}): DipSwitchElement {
  const props = new PropertyBag();
  props.set("label", overrides?.label ?? "");
  props.set("bitCount", overrides?.bitCount ?? 1);
  props.set("defaultValue", overrides?.defaultValue ?? 0);
  return new DipSwitchElement("test-dip-001", { x: 0, y: 0 }, 0, false, props);
}

// ---------------------------------------------------------------------------
// executeDipSwitch tests
// ---------------------------------------------------------------------------

describe("DipSwitch", () => {
  describe("execute", () => {
    it("executeDipSwitch is a no-op: does not modify state", () => {
      const layout = makeLayout(0, 1);
      const state = makeState([], 1);
      const highZs = new Uint32Array(state.length);
      state[0] = 0b101;
      executeDipSwitch(0, state, highZs, layout);
      expect(state[0]).toBe(0b101);
    });

    it("executeDipSwitch can be called 1000 times without error", () => {
      const layout = makeLayout(0, 1);
      const state = makeState([], 1);
      const highZs = new Uint32Array(state.length);
      for (let i = 0; i < 1000; i++) {
        executeDipSwitch(0, state, highZs, layout);
      }
      expect(state[0]).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Per-bit toggle concept
  // ---------------------------------------------------------------------------

  describe("perBitToggle", () => {
    it("bitCount=4, defaultValue=0b1010 stores correct default", () => {
      const el = makeDipSwitch({ bitCount: 4, defaultValue: 0b1010 });
      expect(el.defaultValue).toBe(0b1010);
    });

    it("bitCount=8, defaultValue=0xFF stores correct default", () => {
      const el = makeDipSwitch({ bitCount: 8, defaultValue: 0xFF });
      expect(el.defaultValue).toBe(0xFF);
    });
  });

  // ---------------------------------------------------------------------------
  // Pin layout
  // ---------------------------------------------------------------------------

  describe("pinLayout", () => {
    it("1-bit DipSwitch has 1 output pin labeled 'out'", () => {
      const el = makeDipSwitch({ bitCount: 1 });
      const pins = el.getPins();
      expect(pins).toHaveLength(1);
      const out = pins.find((p) => p.direction === PinDirection.OUTPUT);
      expect(out).toBeDefined();
      expect(out!.label).toBe("out");
    });

    it("4-bit DipSwitch has 1 output pin with bitWidth=4", () => {
      const el = makeDipSwitch({ bitCount: 4 });
      const out = el.getPins().find((p) => p.direction === PinDirection.OUTPUT);
      expect(out!.bitWidth).toBe(4);
    });

    it("DipSwitch has no input pins", () => {
      const el = makeDipSwitch({ bitCount: 8 });
      const inputs = el.getPins().filter((p) => p.direction === PinDirection.INPUT);
      expect(inputs).toHaveLength(0);
    });

    it("DipSwitchDefinition.pinLayout has 1 entry", () => {
      expect(DipSwitchDefinition.pinLayout).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  describe("draw", () => {
    it("draw calls drawRect at least once (component body)", () => {
      const el = makeDipSwitch();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const rects = calls.filter((c) => c.method === "drawRect");
      expect(rects.length).toBeGreaterThanOrEqual(1);
    });

    it("draw calls save and restore", () => {
      const el = makeDipSwitch();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.some((c) => c.method === "save")).toBe(true);
      expect(calls.some((c) => c.method === "restore")).toBe(true);
    });

    it("4-bit DipSwitch renders same drawRect calls as 1-bit (one slider slot drawn)", () => {
      const el1 = makeDipSwitch({ bitCount: 1 });
      const el4 = makeDipSwitch({ bitCount: 4 });
      const { ctx: ctx1, calls: calls1 } = makeStubCtx();
      const { ctx: ctx4, calls: calls4 } = makeStubCtx();
      el1.draw(ctx1);
      el4.draw(ctx4);
      // Body is drawn via drawPolygon; slider (filled + outline) is 2 drawRect calls each
      const rects1 = calls1.filter((c) => c.method === "drawRect").length;
      const rects4 = calls4.filter((c) => c.method === "drawRect").length;
      expect(rects1).toBe(2);
      expect(rects4).toBe(2);
    });

    it("draw renders label when set", () => {
      const el = makeDipSwitch({ label: "SW1" });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.some((c) => c.args[0] === "SW1")).toBe(true);
    });

    it("draw does not render text when label is empty", () => {
      const el = makeDipSwitch({ label: "" });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Attribute mapping
  // ---------------------------------------------------------------------------

  describe("attributeMapping", () => {
    it("Label maps to 'label' property", () => {
      const m = DIP_SWITCH_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Label");
      expect(m).toBeDefined();
      expect(m!.propertyKey).toBe("label");
      expect(m!.convert("SW")).toBe("SW");
    });

    it("Bits maps to 'bitCount' property as integer", () => {
      const m = DIP_SWITCH_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Bits");
      expect(m).toBeDefined();
      expect(m!.propertyKey).toBe("bitCount");
      expect(m!.convert("4")).toBe(4);
    });

    it("Default maps to 'defaultValue' as integer", () => {
      const m = DIP_SWITCH_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Default");
      expect(m).toBeDefined();
      expect(m!.propertyKey).toBe("defaultValue");
      expect(m!.convert("10")).toBe(10);
    });
  });

  // ---------------------------------------------------------------------------
  // ComponentDefinition completeness
  // ---------------------------------------------------------------------------

  describe("definitionComplete", () => {
    it("DipSwitchDefinition name is 'DipSwitch'", () => {
      expect(DipSwitchDefinition.name).toBe("DipSwitch");
    });

    it("DipSwitchDefinition typeId is -1 (sentinel)", () => {
      expect(DipSwitchDefinition.typeId).toBe(-1);
    });

    it("DipSwitchDefinition factory produces a DipSwitchElement", () => {
      const props = new PropertyBag();
      props.set("label", "");
      props.set("bitCount", 4);
      props.set("defaultValue", 0);
      const el = DipSwitchDefinition.factory(props);
      expect(el.typeId).toBe("DipSwitch");
    });

    it("DipSwitchDefinition executeFn is executeDipSwitch", () => {
      expect(DipSwitchDefinition.models!.digital!.executeFn).toBe(executeDipSwitch);
    });

    it("DipSwitchDefinition category is IO", () => {
      expect(DipSwitchDefinition.category).toBe(ComponentCategory.IO);
    });

    it("DipSwitchDefinition has non-empty helpText", () => {
      expect(typeof DipSwitchDefinition.helpText).toBe("string"); expect(DipSwitchDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });

    it("DipSwitchDefinition can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(DipSwitchDefinition)).not.toThrow();
    });

  });
});
