/**
 * Tests for Text and Rectangle annotation components (task 5.2.24).
 *
 * Both components are non-functional visual elements — no simulation behavior.
 * Tests cover:
 *   - Rendering: correct draw calls for text content / rectangle border
 *   - No simulation behavior: executeFn is a no-op, getPins returns empty
 *   - Attribute mapping: .dig XML attributes convert to correct PropertyBag entries
 *   - ComponentDefinition: all required fields present
 */

import { describe, it, expect } from "vitest";
import {
  TextElement,
  executeText,
  TextDefinition,
  TEXT_ATTRIBUTE_MAPPINGS,
} from "../text.js";
import {
  RectangleElement,
  executeRectangle,
  RectangleDefinition,
  RECTANGLE_ATTRIBUTE_MAPPINGS,
} from "../rectangle.js";
import { PropertyBag } from "../../../core/properties.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import type { ComponentLayout } from "../../../core/registry.js";
import type { RenderContext, Point, TextAnchor, FontSpec, PathData } from "../../../core/renderer-interface.js";
import type { ThemeColor } from "../../../core/renderer-interface.js";

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
// Helpers — ComponentLayout mock (no-op for annotation components)
// ---------------------------------------------------------------------------

function makeNoOpLayout(): ComponentLayout {
  return {
    inputCount: () => 0,
    inputOffset: () => 0,
    outputCount: () => 0,
    outputOffset: () => 0,
  };
}

// ---------------------------------------------------------------------------
// Helpers — element factories
// ---------------------------------------------------------------------------

function makeText(overrides?: {
  text?: string;
  fontSize?: number;
}): TextElement {
  const props = new PropertyBag();
  props.set("text", overrides?.text ?? "Hello");
  props.set("fontSize", overrides?.fontSize ?? 1.0);
  return new TextElement("test-text-001", { x: 0, y: 0 }, 0, false, props);
}

function makeRectangle(overrides?: {
  label?: string;
  rectWidth?: number;
  rectHeight?: number;
  lineWidth?: number;
}): RectangleElement {
  const props = new PropertyBag();
  if (overrides?.label !== undefined) {
    props.set("label", overrides.label);
  }
  props.set("rectWidth", overrides?.rectWidth ?? 6);
  props.set("rectHeight", overrides?.rectHeight ?? 4);
  props.set("lineWidth", overrides?.lineWidth ?? 1);
  return new RectangleElement("test-rect-001", { x: 0, y: 0 }, 0, false, props);
}

// ---------------------------------------------------------------------------
// Text — rendering
// ---------------------------------------------------------------------------

describe("Text", () => {
  describe("rendering", () => {
    it("draw() calls drawText with the configured text content", () => {
      const el = makeText({ text: "My Label" });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.some((c) => c.args[0] === "My Label")).toBe(true);
    });

    it("draw() calls save and restore", () => {
      const el = makeText();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      expect(calls.some((c) => c.method === "save")).toBe(true);
      expect(calls.some((c) => c.method === "restore")).toBe(true);
    });

    it("draw() calls translate with component position", () => {
      const props = new PropertyBag();
      props.set("text", "Test");
      props.set("fontSize", 1.0);
      const el = new TextElement("inst", { x: 3, y: 7 }, 0, false, props);
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const translateCalls = calls.filter((c) => c.method === "translate");
      expect(translateCalls.some((c) => c.args[0] === 3 && c.args[1] === 7)).toBe(true);
    });

    it("draw() calls setFont with the configured fontSize", () => {
      const el = makeText({ fontSize: 2.5 });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const fontCalls = calls.filter((c) => c.method === "setFont");
      expect(fontCalls.some((c) => (c.args[0] as FontSpec).size === 2.5)).toBe(true);
    });

    it("draw() with empty text still calls drawText", () => {
      const el = makeText({ text: "" });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("draw() does not call drawRect (Text is not a box)", () => {
      const el = makeText({ text: "No box" });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const rectCalls = calls.filter((c) => c.method === "drawRect");
      expect(rectCalls).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Text — no simulation behavior
  // ---------------------------------------------------------------------------

  describe("noSimulationBehavior", () => {
    it("getPins() returns an empty array", () => {
      const el = makeText();
      expect(el.getPins()).toHaveLength(0);
    });

    it("executeText is a no-op — does not modify state", () => {
      const layout = makeNoOpLayout();
      const state = new Uint32Array(4);
      state[0] = 0xDEADBEEF;
      state[1] = 0xCAFEBABE;

      executeText(0, state, layout);

      expect(state[0]).toBe(0xDEADBEEF);
      expect(state[1]).toBe(0xCAFEBABE);
    });

    it("executeText can be called repeatedly without error", () => {
      const layout = makeNoOpLayout();
      const state = new Uint32Array(2);
      for (let i = 0; i < 100; i++) {
        executeText(0, state, layout);
      }
      expect(state[0]).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Text — getBoundingBox
  // ---------------------------------------------------------------------------

  describe("getBoundingBox", () => {
    it("bounding box x/y matches position", () => {
      const props = new PropertyBag();
      props.set("text", "Test");
      props.set("fontSize", 1.0);
      const el = new TextElement("inst", { x: 5, y: 10 }, 0, false, props);
      const box = el.getBoundingBox();
      expect(box.x).toBe(5);
      expect(box.y).toBe(10);
    });

    it("bounding box has positive width and height", () => {
      const el = makeText();
      const box = el.getBoundingBox();
      expect(box.width).toBeGreaterThanOrEqual(2);
      expect(box.height).toBeGreaterThanOrEqual(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Text — attribute mapping
  // ---------------------------------------------------------------------------

  describe("attributeMapping", () => {
    it("text xmlName maps to text propertyKey", () => {
      const mapping = TEXT_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "text");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("text");
      expect(mapping!.convert("Hello World")).toBe("Hello World");
    });

    it("fontSize xmlName maps to fontSize propertyKey as float", () => {
      const mapping = TEXT_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "fontSize");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("fontSize");
      expect(mapping!.convert("1.5")).toBe(1.5);
    });

    it("appling all mappings produces correct PropertyBag", () => {
      const entries: Record<string, string> = { text: "Circuit Label", fontSize: "2.0" };
      const bag = new PropertyBag();
      for (const mapping of TEXT_ATTRIBUTE_MAPPINGS) {
        if (entries[mapping.xmlName] !== undefined) {
          bag.set(mapping.propertyKey, mapping.convert(entries[mapping.xmlName]));
        }
      }
      expect(bag.get<string>("text")).toBe("Circuit Label");
      expect(bag.get<number>("fontSize")).toBe(2.0);
    });
  });

  // ---------------------------------------------------------------------------
  // Text — ComponentDefinition completeness
  // ---------------------------------------------------------------------------

  describe("definitionComplete", () => {
    it("TextDefinition has name='Text'", () => {
      expect(TextDefinition.name).toBe("Text");
    });

    it("TextDefinition has typeId=-1 (sentinel for auto-assignment)", () => {
      expect(TextDefinition.typeId).toBe(-1);
    });

    it("TextDefinition has a factory function", () => {
      expect(typeof TextDefinition.factory).toBe("function");
    });

    it("TextDefinition factory produces a TextElement", () => {
      const props = new PropertyBag();
      props.set("text", "Test");
      props.set("fontSize", 1.0);
      const el = TextDefinition.factory(props);
      expect(el.typeId).toBe("Text");
    });

    it("TextDefinition executeFn is executeText", () => {
      expect(TextDefinition.executeFn).toBe(executeText);
    });

    it("TextDefinition pinLayout is empty (no pins)", () => {
      expect(TextDefinition.pinLayout).toHaveLength(0);
    });

    it("TextDefinition propertyDefs include text and fontSize", () => {
      const keys = TextDefinition.propertyDefs.map((d) => d.key);
      expect(keys).toContain("text");
      expect(keys).toContain("fontSize");
    });

    it("TextDefinition attributeMap covers text and fontSize", () => {
      const xmlNames = TextDefinition.attributeMap.map((m) => m.xmlName);
      expect(xmlNames).toContain("text");
      expect(xmlNames).toContain("fontSize");
    });

    it("TextDefinition category is MISC", () => {
      expect(TextDefinition.category).toBe(ComponentCategory.MISC);
    });

    it("TextDefinition has a non-empty helpText", () => {
      expect(typeof TextDefinition.helpText).toBe("string");
      expect(typeof TextDefinition.helpText).toBe("string"); expect(TextDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });

    it("TextElement.getHelpText() returns relevant text", () => {
      const el = makeText();
      expect(el.getHelpText()).toContain("Text");
    });

    it("TextDefinition can be registered in ComponentRegistry without throwing", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(TextDefinition)).not.toThrow();
    });

    it("After registration, TextDefinition typeId is non-negative integer", () => {
      const registry = new ComponentRegistry();
      registry.register(TextDefinition);
      const registered = registry.get("Text");
      expect(registered).not.toBeUndefined();
      expect(registered!.typeId).toBeGreaterThanOrEqual(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Rectangle — rendering
// ---------------------------------------------------------------------------

describe("Rectangle", () => {
  describe("rendering", () => {
    it("draw() calls drawRect for the border", () => {
      const el = makeRectangle();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const rectCalls = calls.filter((c) => c.method === "drawRect");
      expect(rectCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("draw() calls drawRect with configured dimensions", () => {
      const el = makeRectangle({ rectWidth: 8, rectHeight: 5 });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const rectCalls = calls.filter((c) => c.method === "drawRect");
      expect(rectCalls.some((c) => c.args[2] === 8 && c.args[3] === 5)).toBe(true);
    });

    it("draw() calls drawRect as unfilled (border only)", () => {
      const el = makeRectangle();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const rectCalls = calls.filter((c) => c.method === "drawRect");
      expect(rectCalls.some((c) => c.args[4] === false)).toBe(true);
    });

    it("draw() calls save and restore", () => {
      const el = makeRectangle();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      expect(calls.some((c) => c.method === "save")).toBe(true);
      expect(calls.some((c) => c.method === "restore")).toBe(true);
    });

    it("draw() calls translate with component position", () => {
      const props = new PropertyBag();
      props.set("rectWidth", 6);
      props.set("rectHeight", 4);
      props.set("lineWidth", 1);
      const el = new RectangleElement("inst", { x: 2, y: 4 }, 0, false, props);
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const translateCalls = calls.filter((c) => c.method === "translate");
      expect(translateCalls.some((c) => c.args[0] === 2 && c.args[1] === 4)).toBe(true);
    });

    it("draw() with label calls drawText with the label", () => {
      const el = makeRectangle({ label: "Section A" });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.some((c) => c.args[0] === "Section A")).toBe(true);
    });

    it("draw() without label does not call drawText", () => {
      const props = new PropertyBag();
      props.set("rectWidth", 6);
      props.set("rectHeight", 4);
      props.set("lineWidth", 1);
      const el = new RectangleElement("inst", { x: 0, y: 0 }, 0, false, props);
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls).toHaveLength(0);
    });

    it("draw() calls setLineWidth with the configured lineWidth", () => {
      const el = makeRectangle({ lineWidth: 3 });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const lwCalls = calls.filter((c) => c.method === "setLineWidth");
      expect(lwCalls.some((c) => c.args[0] === 3)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Rectangle — no simulation behavior
  // ---------------------------------------------------------------------------

  describe("noSimulationBehavior", () => {
    it("getPins() returns an empty array", () => {
      const el = makeRectangle();
      expect(el.getPins()).toHaveLength(0);
    });

    it("executeRectangle is a no-op — does not modify state", () => {
      const layout = makeNoOpLayout();
      const state = new Uint32Array(4);
      state[0] = 0xDEADBEEF;
      state[1] = 0xCAFEBABE;

      executeRectangle(0, state, layout);

      expect(state[0]).toBe(0xDEADBEEF);
      expect(state[1]).toBe(0xCAFEBABE);
    });

    it("executeRectangle can be called repeatedly without error", () => {
      const layout = makeNoOpLayout();
      const state = new Uint32Array(2);
      for (let i = 0; i < 100; i++) {
        executeRectangle(0, state, layout);
      }
      expect(state[0]).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Rectangle — getBoundingBox
  // ---------------------------------------------------------------------------

  describe("getBoundingBox", () => {
    it("bounding box matches configured rectWidth and rectHeight", () => {
      const el = makeRectangle({ rectWidth: 10, rectHeight: 7 });
      const box = el.getBoundingBox();
      expect(box.width).toBe(10);
      expect(box.height).toBe(7);
    });

    it("bounding box x/y matches position", () => {
      const props = new PropertyBag();
      props.set("rectWidth", 6);
      props.set("rectHeight", 4);
      props.set("lineWidth", 1);
      const el = new RectangleElement("inst", { x: 3, y: 8 }, 0, false, props);
      const box = el.getBoundingBox();
      expect(box.x).toBe(3);
      expect(box.y).toBe(8);
    });
  });

  // ---------------------------------------------------------------------------
  // Rectangle — attribute mapping
  // ---------------------------------------------------------------------------

  describe("attributeMapping", () => {
    it("Label xmlName maps to label propertyKey", () => {
      const mapping = RECTANGLE_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Label");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("label");
      expect(mapping!.convert("My Group")).toBe("My Group");
    });

    it("rectWidth xmlName maps to rectWidth propertyKey as integer", () => {
      const mapping = RECTANGLE_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "rectWidth");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("rectWidth");
      expect(mapping!.convert("8")).toBe(8);
    });

    it("rectHeight xmlName maps to rectHeight propertyKey as integer", () => {
      const mapping = RECTANGLE_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "rectHeight");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("rectHeight");
      expect(mapping!.convert("5")).toBe(5);
    });

    it("lineWidth xmlName maps to lineWidth propertyKey as integer", () => {
      const mapping = RECTANGLE_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "lineWidth");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("lineWidth");
      expect(mapping!.convert("2")).toBe(2);
    });

    it("applying all mappings produces correct PropertyBag", () => {
      const entries: Record<string, string> = {
        Label: "CPU Block",
        rectWidth: "12",
        rectHeight: "8",
        lineWidth: "2",
      };
      const bag = new PropertyBag();
      for (const mapping of RECTANGLE_ATTRIBUTE_MAPPINGS) {
        if (entries[mapping.xmlName] !== undefined) {
          bag.set(mapping.propertyKey, mapping.convert(entries[mapping.xmlName]));
        }
      }
      expect(bag.get<string>("label")).toBe("CPU Block");
      expect(bag.get<number>("rectWidth")).toBe(12);
      expect(bag.get<number>("rectHeight")).toBe(8);
      expect(bag.get<number>("lineWidth")).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Rectangle — ComponentDefinition completeness
  // ---------------------------------------------------------------------------

  describe("definitionComplete", () => {
    it("RectangleDefinition has name='Rectangle'", () => {
      expect(RectangleDefinition.name).toBe("Rectangle");
    });

    it("RectangleDefinition has typeId=-1 (sentinel for auto-assignment)", () => {
      expect(RectangleDefinition.typeId).toBe(-1);
    });

    it("RectangleDefinition has a factory function", () => {
      expect(typeof RectangleDefinition.factory).toBe("function");
    });

    it("RectangleDefinition factory produces a RectangleElement", () => {
      const props = new PropertyBag();
      props.set("rectWidth", 6);
      props.set("rectHeight", 4);
      props.set("lineWidth", 1);
      const el = RectangleDefinition.factory(props);
      expect(el.typeId).toBe("Rectangle");
    });

    it("RectangleDefinition executeFn is executeRectangle", () => {
      expect(RectangleDefinition.executeFn).toBe(executeRectangle);
    });

    it("RectangleDefinition pinLayout is empty (no pins)", () => {
      expect(RectangleDefinition.pinLayout).toHaveLength(0);
    });

    it("RectangleDefinition propertyDefs include label, rectWidth, rectHeight, lineWidth", () => {
      const keys = RectangleDefinition.propertyDefs.map((d) => d.key);
      expect(keys).toContain("label");
      expect(keys).toContain("rectWidth");
      expect(keys).toContain("rectHeight");
      expect(keys).toContain("lineWidth");
    });

    it("RectangleDefinition attributeMap covers Label, rectWidth, rectHeight, lineWidth", () => {
      const xmlNames = RectangleDefinition.attributeMap.map((m) => m.xmlName);
      expect(xmlNames).toContain("Label");
      expect(xmlNames).toContain("rectWidth");
      expect(xmlNames).toContain("rectHeight");
      expect(xmlNames).toContain("lineWidth");
    });

    it("RectangleDefinition category is MISC", () => {
      expect(RectangleDefinition.category).toBe(ComponentCategory.MISC);
    });

    it("RectangleDefinition has a non-empty helpText", () => {
      expect(typeof RectangleDefinition.helpText).toBe("string");
      expect(typeof RectangleDefinition.helpText).toBe("string"); expect(RectangleDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });

    it("RectangleElement.getHelpText() returns relevant text", () => {
      const el = makeRectangle();
      expect(el.getHelpText()).toContain("Rectangle");
    });

    it("RectangleDefinition can be registered in ComponentRegistry without throwing", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(RectangleDefinition)).not.toThrow();
    });

    it("After registration, RectangleDefinition typeId is non-negative integer", () => {
      const registry = new ComponentRegistry();
      registry.register(RectangleDefinition);
      const registered = registry.get("Rectangle");
      expect(registered).not.toBeUndefined();
      expect(registered!.typeId).toBeGreaterThanOrEqual(0);
    });
  });
});
