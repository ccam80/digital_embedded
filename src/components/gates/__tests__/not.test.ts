/**
 * Tests for the Not gate component.
 *
 * Covers:
 *   - executeNot: logic correctness (single-bit, multi-bit)
 *   - Rendering: IEC/DIN shape (rect + "1" text + output bubble)
 *   - Rendering: IEEE/US shape (triangle + bubble)
 *   - Attribute mapping
 *   - ComponentDefinition completeness
 */

import { describe, it, expect } from "vitest";
import {
  NotElement,
  executeNot,
  NotDefinition,
  NOT_ATTRIBUTE_MAPPINGS,
} from "../not.js";
import { PropertyBag } from "../../../core/properties.js";
import { PinDirection } from "../../../core/pin.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import type { ComponentLayout } from "../../../core/registry.js";
import type { RenderContext, Point, TextAnchor, FontSpec, PathData } from "../../../core/renderer-interface.js";
import type { ThemeColor } from "../../../core/renderer-interface.js";

// ---------------------------------------------------------------------------
// Helpers — ComponentLayout mock (Not always has 1 input)
// ---------------------------------------------------------------------------

function makeLayout(bitWidth = 32): ComponentLayout {
  return {
    wiringTable: Int32Array.from({ length: 2 }, (_, i) => i),
    inputCount: () => 1,
    inputOffset: () => 0,
    outputCount: () => 1,
    outputOffset: () => 1,
    stateOffset: () => 0,
    getProperty: (_index: number, key: string) => key === "bitWidth" ? bitWidth : undefined,
  };
}

function makeState(input: number): Uint32Array {
  const arr = new Uint32Array(2);
  arr[0] = input >>> 0;
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
// Helpers — NotElement factory
// ---------------------------------------------------------------------------

function makeNot(overrides?: {
  bitWidth?: number;
  wideShape?: boolean;
  label?: string;
}): NotElement {
  const props = new PropertyBag();
  props.set("bitWidth", overrides?.bitWidth ?? 1);
  props.set("wideShape", overrides?.wideShape ?? false);
  if (overrides?.label !== undefined) {
    props.set("label", overrides.label);
  }
  return new NotElement("test-not-001", { x: 0, y: 0 }, 0, false, props);
}

// ---------------------------------------------------------------------------
// executeNot — logic correctness
// ---------------------------------------------------------------------------

describe("NotGate", () => {
  describe("execute2Input", () => {
    it("NOT 0 produces 0xFFFFFFFF", () => {
      const layout = makeLayout();
      const state = makeState(0);
      const highZs = new Uint32Array(state.length);
      executeNot(0, state, highZs, layout);
      expect(state[1]).toBe(0xFFFFFFFF);
    });

    it("NOT 0xFFFFFFFF produces 0", () => {
      const layout = makeLayout();
      const state = makeState(0xFFFFFFFF);
      const highZs = new Uint32Array(state.length);
      executeNot(0, state, highZs, layout);
      expect(state[1]).toBe(0);
    });

    it("NOT 1 produces 0xFFFFFFFE", () => {
      const layout = makeLayout();
      const state = makeState(1);
      const highZs = new Uint32Array(state.length);
      executeNot(0, state, highZs, layout);
      expect(state[1]).toBe(0xFFFFFFFE);
    });
  });

  describe("multiBit", () => {
    it("NOT 0x0F0F0F0F produces 0xF0F0F0F0", () => {
      const layout = makeLayout();
      const state = makeState(0x0F0F0F0F);
      const highZs = new Uint32Array(state.length);
      executeNot(0, state, highZs, layout);
      expect(state[1]).toBe(0xF0F0F0F0);
    });

    it("NOT 0xAAAAAAAA produces 0x55555555", () => {
      const layout = makeLayout();
      const state = makeState(0xAAAAAAAA);
      const highZs = new Uint32Array(state.length);
      executeNot(0, state, highZs, layout);
      expect(state[1]).toBe(0x55555555);
    });

    it("double NOT returns original value", () => {
      const layout = makeLayout();
      const original = 0x12345678;
      const state = makeState(original);
      const highZs = new Uint32Array(state.length);
      executeNot(0, state, highZs, layout);
      // state[1] is now NOT(original), put it back as input
      state[0] = state[1];
      executeNot(0, state, highZs, layout);
      expect(state[1]).toBe(original);
    });
  });

  // ---------------------------------------------------------------------------
  // Pin layout
  // ---------------------------------------------------------------------------

  describe("pinLayout", () => {
    it("Not has exactly 1 input pin and 1 output pin", () => {
      const el = makeNot();
      const pins = el.getPins();
      const inputs = pins.filter((p) => p.direction === PinDirection.INPUT);
      const outputs = pins.filter((p) => p.direction === PinDirection.OUTPUT);
      expect(inputs).toHaveLength(1);
      expect(outputs).toHaveLength(1);
    });

    it("input pin is labeled 'in'", () => {
      const el = makeNot();
      const input = el.getPins().find((p) => p.direction === PinDirection.INPUT);
      expect(input?.label).toBe("in");
    });

    it("output pin is labeled 'out'", () => {
      const el = makeNot();
      const output = el.getPins().find((p) => p.direction === PinDirection.OUTPUT);
      expect(output?.label).toBe("out");
    });

    it("NotDefinition.pinLayout has 2 entries (1 in, 1 out)", () => {
      expect(NotDefinition.pinLayout).toHaveLength(2);
      const inputs = NotDefinition.pinLayout.filter((p) => p.direction === PinDirection.INPUT);
      const outputs = NotDefinition.pinLayout.filter((p) => p.direction === PinDirection.OUTPUT);
      expect(inputs).toHaveLength(1);
      expect(outputs).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Attribute mapping
  // ---------------------------------------------------------------------------

  describe("attributeMapping", () => {
    it("Bits=8, wideShape=true map to correct PropertyBag entries", () => {
      const entries: Record<string, string> = {
        Bits: "8",
        wideShape: "true",
      };

      const bag = new PropertyBag();
      for (const mapping of NOT_ATTRIBUTE_MAPPINGS) {
        if (entries[mapping.xmlName] !== undefined) {
          bag.set(mapping.propertyKey, mapping.convert(entries[mapping.xmlName]));
        }
      }

      expect(bag.get<number>("bitWidth")).toBe(8);
      expect(bag.get<boolean>("wideShape")).toBe(true);
    });

    it("Label attribute maps to label property key", () => {
      const mapping = NOT_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Label");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("label");
    });

    it("wideShape=false converts to boolean false", () => {
      const mapping = NOT_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "wideShape");
      expect(mapping!.convert("false")).toBe(false);
    });

    it("Not attributeMap does not include Inputs (single input only)", () => {
      const xmlNames = NOT_ATTRIBUTE_MAPPINGS.map((m) => m.xmlName);
      expect(xmlNames).not.toContain("Inputs");
    });
  });

  // ---------------------------------------------------------------------------
  // Rendering — IEC/DIN
  // ---------------------------------------------------------------------------

  describe("drawNarrowIEEE", () => {
    it("narrow IEEE shape calls drawPath for the triangle body", () => {
      const el = makeNot({ wideShape: false });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const pathCalls = calls.filter((c) => c.method === "drawPath");
      expect(pathCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("narrow IEEE shape calls drawCircle for output bubble", () => {
      const el = makeNot({ wideShape: false });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const circleCalls = calls.filter((c) => c.method === "drawCircle");
      expect(circleCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("narrow IEEE shape does not call drawRect", () => {
      const el = makeNot({ wideShape: false });
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
    it("IEEE shape calls drawPath for the triangle body", () => {
      const el = makeNot({ wideShape: true });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const pathCalls = calls.filter((c) => c.method === "drawPath");
      expect(pathCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("IEEE shape calls drawCircle for the inversion bubble", () => {
      const el = makeNot({ wideShape: true });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const circleCalls = calls.filter((c) => c.method === "drawCircle");
      expect(circleCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("IEEE shape does not call drawRect", () => {
      const el = makeNot({ wideShape: true });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const rectCalls = calls.filter((c) => c.method === "drawRect");
      expect(rectCalls).toHaveLength(0);
    });

    it("IEEE shape does not draw '1' text", () => {
      const el = makeNot({ wideShape: true });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.some((c) => c.args[0] === "1")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // ComponentDefinition completeness
  // ---------------------------------------------------------------------------

  describe("definitionComplete", () => {
    it("NotDefinition has name='Not'", () => {
      expect(NotDefinition.name).toBe("Not");
    });

    it("NotDefinition has typeId=-1 (sentinel for auto-assignment)", () => {
      expect(NotDefinition.typeId).toBe(-1);
    });

    it("NotDefinition has a factory function", () => {
      expect(typeof NotDefinition.factory).toBe("function");
    });

    it("NotDefinition factory produces a NotElement", () => {
      const props = new PropertyBag();
      props.set("bitWidth", 1);
      props.set("wideShape", false);
      const el = NotDefinition.factory(props);
      expect(el.typeId).toBe("Not");
    });

    it("NotDefinition has executeFn=executeNot", () => {
      expect(NotDefinition.executeFn).toBe(executeNot);
    });

    it("NotDefinition has a non-empty pinLayout", () => {
      expect(NotDefinition.pinLayout.length).toBeGreaterThan(0);
    });

    it("NotDefinition has non-empty propertyDefs", () => {
      expect(NotDefinition.propertyDefs.length).toBeGreaterThan(0);
    });

    it("NotDefinition propertyDefs include bitWidth, wideShape, label", () => {
      const keys = NotDefinition.propertyDefs.map((d) => d.key);
      expect(keys).toContain("bitWidth");
      expect(keys).toContain("wideShape");
      expect(keys).toContain("label");
    });

    it("NotDefinition has non-empty attributeMap", () => {
      expect(NotDefinition.attributeMap.length).toBeGreaterThan(0);
    });

    it("NotDefinition attributeMap covers Bits, wideShape, Label", () => {
      const xmlNames = NotDefinition.attributeMap.map((m) => m.xmlName);
      expect(xmlNames).toContain("Bits");
      expect(xmlNames).toContain("wideShape");
      expect(xmlNames).toContain("Label");
    });

    it("NotDefinition category is LOGIC", () => {
      expect(NotDefinition.category).toBe(ComponentCategory.LOGIC);
    });

    it("NotDefinition has a non-empty helpText", () => {
      expect(typeof NotDefinition.helpText).toBe("string");
      expect(typeof NotDefinition.helpText).toBe("string"); expect(NotDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });

    it("NotElement.getHelpText() returns the expected text", () => {
      const el = makeNot();
      expect(el.getHelpText()).toContain("Not gate");
    });

    it("NotDefinition can be registered in ComponentRegistry without throwing", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(NotDefinition)).not.toThrow();
    });

    it("After registration, NotDefinition typeId is overwritten with a non-negative integer", () => {
      const registry = new ComponentRegistry();
      registry.register(NotDefinition);
      const registered = registry.get("Not");
      expect(registered).not.toBeUndefined();
      expect(registered!.typeId).toBeGreaterThanOrEqual(0);
    });
  });
});
