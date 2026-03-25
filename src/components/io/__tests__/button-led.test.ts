/**
 * Tests for the ButtonLED component.
 *
 * Covers:
 *   - executeButtonLED: copies LED input to output slot
 *   - Pin layout: one input (in) + one output (out)
 *   - activeLow and color properties
 *   - Rendering: rect body + inner rect + circle for LED
 *   - Attribute mapping: Label, ActiveLow, Color
 *   - ComponentDefinition completeness
 */

import { describe, it, expect } from "vitest";
import {
  ButtonLEDElement,
  executeButtonLED,
  ButtonLEDDefinition,
  BUTTON_LED_ATTRIBUTE_MAPPINGS,
} from "../button-led.js";
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

function makeButtonLED(overrides?: {
  label?: string;
  activeLow?: boolean;
  color?: string;
}): ButtonLEDElement {
  const props = new PropertyBag();
  props.set("label", overrides?.label ?? "");
  props.set("activeLow", overrides?.activeLow ?? false);
  props.set("color", overrides?.color ?? "red");
  return new ButtonLEDElement("test-bled-001", { x: 0, y: 0 }, 0, false, props);
}

// ---------------------------------------------------------------------------
// executeButtonLED tests
// ---------------------------------------------------------------------------

describe("ButtonLED", () => {
  describe("execute", () => {
    it("executeButtonLED copies LED input (slot 0) to output slot", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([1], 1);
      const highZs = new Uint32Array(state.length);
      executeButtonLED(0, state, highZs, layout);
      expect(state[1]).toBe(1);
    });

    it("executeButtonLED with LED input=0 writes 0 to output", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([0], 1);
      const highZs = new Uint32Array(state.length);
      executeButtonLED(0, state, highZs, layout);
      expect(state[1]).toBe(0);
    });

    it("executeButtonLED with LED input=1 writes 1 to output", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([1], 1);
      const highZs = new Uint32Array(state.length);
      executeButtonLED(0, state, highZs, layout);
      expect(state[1]).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Pin layout
  // ---------------------------------------------------------------------------

  describe("pinLayout", () => {
    it("ButtonLED has exactly 2 pins", () => {
      const el = makeButtonLED();
      expect(el.getPins()).toHaveLength(2);
    });

    it("ButtonLED has 1 input pin labeled 'in'", () => {
      const el = makeButtonLED();
      const inputs = el.getPins().filter((p) => p.direction === PinDirection.INPUT);
      expect(inputs).toHaveLength(1);
      expect(inputs[0].label).toBe("in");
    });

    it("ButtonLED has 1 output pin labeled 'out'", () => {
      const el = makeButtonLED();
      const outputs = el.getPins().filter((p) => p.direction === PinDirection.OUTPUT);
      expect(outputs).toHaveLength(1);
      expect(outputs[0].label).toBe("out");
    });

    it("ButtonLEDDefinition.pinLayout has 2 entries", () => {
      expect(ButtonLEDDefinition.pinLayout).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Properties
  // ---------------------------------------------------------------------------

  describe("activeLow", () => {
    it("activeLow defaults to false", () => {
      const el = makeButtonLED();
      expect(el.activeLow).toBe(false);
    });

    it("activeLow=true is stored correctly", () => {
      const el = makeButtonLED({ activeLow: true });
      expect(el.activeLow).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  describe("draw", () => {
    it("draw calls drawPolygon (component body)", () => {
      const el = makeButtonLED();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      // ButtonLED body is a 6-point polygon, not a rect
      const polygons = calls.filter((c) => c.method === "drawPolygon");
      expect(polygons.length).toBeGreaterThanOrEqual(1);
    });

    it("draw calls drawCircle for the LED indicator", () => {
      const el = makeButtonLED();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const circles = calls.filter((c) => c.method === "drawCircle");
      expect(circles.length).toBeGreaterThanOrEqual(1);
    });

    it("draw calls save and restore", () => {
      const el = makeButtonLED();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.some((c) => c.method === "save")).toBe(true);
      expect(calls.some((c) => c.method === "restore")).toBe(true);
    });

    it("draw renders label text when label is set", () => {
      const el = makeButtonLED({ label: "LED1" });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.some((c) => c.args[0] === "LED1")).toBe(true);
    });

    it("draw always calls drawText (ButtonLED draws label unconditionally)", () => {
      const el = makeButtonLED({ label: "" });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      // ButtonLED.draw() always emits a drawText call (Java parity — always renders label position)
      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Attribute mapping
  // ---------------------------------------------------------------------------

  describe("attributeMapping", () => {
    it("Label maps to 'label' property", () => {
      const m = BUTTON_LED_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Label");
      expect(m).toBeDefined();
      expect(m!.propertyKey).toBe("label");
      expect(m!.convert("BTN")).toBe("BTN");
    });

    it("ActiveLow=true maps to boolean true", () => {
      const m = BUTTON_LED_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "ActiveLow");
      expect(m).toBeDefined();
      expect(m!.convert("true")).toBe(true);
    });

    it("ActiveLow=false maps to boolean false", () => {
      const m = BUTTON_LED_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "ActiveLow");
      expect(m!.convert("false")).toBe(false);
    });

    it("Color maps to 'color' property", () => {
      const m = BUTTON_LED_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Color");
      expect(m).toBeDefined();
      expect(m!.propertyKey).toBe("color");
      expect(m!.convert("green")).toBe("green");
    });
  });

  // ---------------------------------------------------------------------------
  // ComponentDefinition completeness
  // ---------------------------------------------------------------------------

  describe("definitionComplete", () => {
    it("ButtonLEDDefinition name is 'ButtonLED'", () => {
      expect(ButtonLEDDefinition.name).toBe("ButtonLED");
    });

    it("ButtonLEDDefinition typeId is -1 (sentinel)", () => {
      expect(ButtonLEDDefinition.typeId).toBe(-1);
    });

    it("ButtonLEDDefinition factory produces a ButtonLEDElement", () => {
      const props = new PropertyBag();
      props.set("label", "");
      props.set("activeLow", false);
      props.set("color", "red");
      const el = ButtonLEDDefinition.factory(props);
      expect(el.typeId).toBe("ButtonLED");
    });

    it("ButtonLEDDefinition executeFn is executeButtonLED", () => {
      expect(ButtonLEDDefinition.models!.digital!.executeFn).toBe(executeButtonLED);
    });

    it("ButtonLEDDefinition category is IO", () => {
      expect(ButtonLEDDefinition.category).toBe(ComponentCategory.IO);
    });

    it("ButtonLEDDefinition has non-empty helpText", () => {
      expect(typeof ButtonLEDDefinition.helpText).toBe("string"); expect(ButtonLEDDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });

    it("ButtonLEDDefinition can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(ButtonLEDDefinition)).not.toThrow();
    });

    it("ButtonLEDElement.getHelpText() contains 'ButtonLED'", () => {
      const el = makeButtonLED();
      expect(el.getHelpText()).toContain("ButtonLED");
    });
  });
});
