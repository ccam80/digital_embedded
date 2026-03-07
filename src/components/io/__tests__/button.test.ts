/**
 * Tests for the Button component.
 *
 * Covers:
 *   - executeButton: no-op (value set externally)
 *   - ButtonElement: rendering (rect body + button symbol)
 *   - ButtonElement: activeLow property
 *   - Attribute mapping: Label, ActiveLow
 *   - ComponentDefinition completeness
 */

import { describe, it, expect } from "vitest";
import {
  ButtonElement,
  executeButton,
  ButtonDefinition,
  BUTTON_ATTRIBUTE_MAPPINGS,
} from "../button.js";
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
  return {
    inputCount: () => inputCount,
    inputOffset: () => 0,
    outputCount: () => outputCount,
    outputOffset: () => inputCount,
    stateOffset: () => 0,
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

function makeButton(overrides?: {
  label?: string;
  activeLow?: boolean;
}): ButtonElement {
  const props = new PropertyBag();
  props.set("label", overrides?.label ?? "");
  props.set("activeLow", overrides?.activeLow ?? false);
  return new ButtonElement("test-btn-001", { x: 0, y: 0 }, 0, false, props);
}

// ---------------------------------------------------------------------------
// executeButton tests
// ---------------------------------------------------------------------------

describe("Button", () => {
  describe("execute", () => {
    it("executeButton is a no-op: does not modify state array", () => {
      const layout = makeLayout(0, 1);
      const state = makeState([], 1);
      const highZs = new Uint32Array(state.length);
      state[0] = 42;
      executeButton(0, state, highZs, layout);
      expect(state[0]).toBe(42);
    });

    it("executeButton can be called 1000 times without error", () => {
      const layout = makeLayout(0, 1);
      const state = makeState([], 1);
      const highZs = new Uint32Array(state.length);
      for (let i = 0; i < 1000; i++) {
        executeButton(0, state, highZs, layout);
      }
      expect(state[0]).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Pin layout
  // ---------------------------------------------------------------------------

  describe("pinLayout", () => {
    it("Button has 1 output pin labeled 'out'", () => {
      const el = makeButton();
      const pins = el.getPins();
      expect(pins).toHaveLength(1);
      const out = pins.find((p) => p.direction === PinDirection.OUTPUT);
      expect(out).toBeDefined();
      expect(out!.label).toBe("out");
    });

    it("Button has no input pins", () => {
      const el = makeButton();
      const inputs = el.getPins().filter((p) => p.direction === PinDirection.INPUT);
      expect(inputs).toHaveLength(0);
    });

    it("Button output pin has bitWidth 1", () => {
      const el = makeButton();
      const out = el.getPins().find((p) => p.direction === PinDirection.OUTPUT);
      expect(out!.bitWidth).toBe(1);
    });

    it("ButtonDefinition.pinLayout has 1 output pin", () => {
      const outputs = ButtonDefinition.pinLayout.filter((p) => p.direction === PinDirection.OUTPUT);
      expect(outputs).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // activeLow property
  // ---------------------------------------------------------------------------

  describe("activeLow", () => {
    it("activeLow defaults to false", () => {
      const el = makeButton();
      expect(el.activeLow).toBe(false);
    });

    it("activeLow=true is stored and accessible", () => {
      const el = makeButton({ activeLow: true });
      expect(el.activeLow).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  describe("draw", () => {
    it("draw calls drawRect at least once (component body)", () => {
      const el = makeButton();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const rects = calls.filter((c) => c.method === "drawRect");
      expect(rects.length).toBeGreaterThanOrEqual(1);
    });

    it("draw calls save and restore", () => {
      const el = makeButton();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.some((c) => c.method === "save")).toBe(true);
      expect(calls.some((c) => c.method === "restore")).toBe(true);
    });

    it("draw renders label when set", () => {
      const el = makeButton({ label: "BTN1" });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.some((c) => c.args[0] === "BTN1")).toBe(true);
    });

    it("draw does not render text when label is empty", () => {
      const el = makeButton({ label: "" });
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
    it("Label attribute maps to label property", () => {
      const mapping = BUTTON_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Label");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("label");
      expect(mapping!.convert("START")).toBe("START");
    });

    it("ActiveLow=true maps to boolean true", () => {
      const mapping = BUTTON_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "ActiveLow");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.convert("true")).toBe(true);
    });

    it("ActiveLow=false maps to boolean false", () => {
      const mapping = BUTTON_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "ActiveLow");
      expect(mapping!.convert("false")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // ComponentDefinition completeness
  // ---------------------------------------------------------------------------

  describe("definitionComplete", () => {
    it("ButtonDefinition has name='Button'", () => {
      expect(ButtonDefinition.name).toBe("Button");
    });

    it("ButtonDefinition has typeId=-1 (sentinel)", () => {
      expect(ButtonDefinition.typeId).toBe(-1);
    });

    it("ButtonDefinition factory produces a ButtonElement", () => {
      const props = new PropertyBag();
      props.set("label", "");
      props.set("activeLow", false);
      const el = ButtonDefinition.factory(props);
      expect(el.typeId).toBe("Button");
    });

    it("ButtonDefinition executeFn is executeButton", () => {
      expect(ButtonDefinition.executeFn).toBe(executeButton);
    });

    it("ButtonDefinition category is IO", () => {
      expect(ButtonDefinition.category).toBe(ComponentCategory.IO);
    });

    it("ButtonDefinition has non-empty helpText", () => {
      expect(typeof ButtonDefinition.helpText).toBe("string"); expect(ButtonDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });

    it("ButtonDefinition can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(ButtonDefinition)).not.toThrow();
    });

    it("ButtonElement.getHelpText() contains 'Button'", () => {
      const el = makeButton();
      expect(el.getHelpText()).toContain("Button");
    });
  });
});
