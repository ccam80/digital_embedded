/**
 * Tests for the Or gate component.
 *
 * Covers:
 *   - executeOr: logic correctness (2-input, 3-input, multi-bit)
 *   - Rendering: IEC/DIN shape (rect + "≥1" text)
 *   - Rendering: IEEE/US shape (drawPath with curves)
 *   - Attribute mapping
 *   - ComponentDefinition completeness
 */

import { describe, it, expect } from "vitest";
import {
  OrElement,
  executeOr,
  OrDefinition,
  OR_ATTRIBUTE_MAPPINGS,
} from "../or.js";
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
// Helpers — OrElement factory
// ---------------------------------------------------------------------------

function makeOr(overrides?: {
  inputCount?: number;
  bitWidth?: number;
  wideShape?: boolean;
  invertedPins?: string[];
  label?: string;
}): OrElement {
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
  return new OrElement("test-or-001", { x: 0, y: 0 }, 0, false, props);
}

// ---------------------------------------------------------------------------
// executeOr — logic correctness
// ---------------------------------------------------------------------------

describe("OrGate", () => {
  describe("execute2Input", () => {
    it("OR of 0x00 and 0x0F produces 0x0F", () => {
      const layout = makeLayout(2);
      const state = makeState([0x00, 0x0F]);
      const highZs = new Uint32Array(state.length);
      executeOr(0, state, highZs, layout);
      expect(state[2]).toBe(0x0F);
    });

    it("OR of 0xFF and 0x00 produces 0xFF", () => {
      const layout = makeLayout(2);
      const state = makeState([0xFF, 0x00]);
      const highZs = new Uint32Array(state.length);
      executeOr(0, state, highZs, layout);
      expect(state[2]).toBe(0xFF);
    });

    it("OR of 0x00 and 0x00 produces 0x00", () => {
      const layout = makeLayout(2);
      const state = makeState([0x00, 0x00]);
      const highZs = new Uint32Array(state.length);
      executeOr(0, state, highZs, layout);
      expect(state[2]).toBe(0x00);
    });

    it("OR of 0xFFFFFFFF and 0x00000000 produces 0xFFFFFFFF", () => {
      const layout = makeLayout(2);
      const state = makeState([0xFFFFFFFF, 0x00000000]);
      const highZs = new Uint32Array(state.length);
      executeOr(0, state, highZs, layout);
      expect(state[2]).toBe(0xFFFFFFFF);
    });

    it("single-bit: 1 OR 0 = 1", () => {
      const layout = makeLayout(2);
      const state = makeState([1, 0]);
      const highZs = new Uint32Array(state.length);
      executeOr(0, state, highZs, layout);
      expect(state[2]).toBe(1);
    });

    it("single-bit: 0 OR 0 = 0", () => {
      const layout = makeLayout(2);
      const state = makeState([0, 0]);
      const highZs = new Uint32Array(state.length);
      executeOr(0, state, highZs, layout);
      expect(state[2]).toBe(0);
    });
  });

  describe("executeMultiInput", () => {
    it("OR of 0x01, 0x02, 0x04 produces 0x07", () => {
      const layout = makeLayout(3);
      const state = makeState([0x01, 0x02, 0x04]);
      const highZs = new Uint32Array(state.length);
      executeOr(0, state, highZs, layout);
      expect(state[3]).toBe(0x07);
    });

    it("OR of four values produces accumulated OR", () => {
      const layout = makeLayout(4);
      const state = makeState([0x10, 0x20, 0x40, 0x80]);
      const highZs = new Uint32Array(state.length);
      executeOr(0, state, highZs, layout);
      expect(state[4]).toBe(0xF0);
    });
  });

  describe("multiBit", () => {
    it("OR of 0xF0F0F0F0 and 0x0F0F0F0F produces 0xFFFFFFFF", () => {
      const layout = makeLayout(2);
      const state = makeState([0xF0F0F0F0, 0x0F0F0F0F]);
      const highZs = new Uint32Array(state.length);
      executeOr(0, state, highZs, layout);
      expect(state[2]).toBe(0xFFFFFFFF);
    });

    it("OR of 0xAAAAAAAA and 0x55555555 produces 0xFFFFFFFF", () => {
      const layout = makeLayout(2);
      const state = makeState([0xAAAAAAAA, 0x55555555]);
      const highZs = new Uint32Array(state.length);
      executeOr(0, state, highZs, layout);
      expect(state[2]).toBe(0xFFFFFFFF);
    });
  });

  // ---------------------------------------------------------------------------
  // Pin layout
  // ---------------------------------------------------------------------------

  describe("pinLayout", () => {
    it("default (2-input) Or has 2 input pins and 1 output pin", () => {
      const el = makeOr({ inputCount: 2 });
      const pins = el.getPins();
      const inputs = pins.filter((p) => p.direction === PinDirection.INPUT);
      const outputs = pins.filter((p) => p.direction === PinDirection.OUTPUT);
      expect(inputs).toHaveLength(2);
      expect(outputs).toHaveLength(1);
    });

    it("3-input Or has 3 input pins and 1 output pin", () => {
      const el = makeOr({ inputCount: 3 });
      const pins = el.getPins();
      const inputs = pins.filter((p) => p.direction === PinDirection.INPUT);
      const outputs = pins.filter((p) => p.direction === PinDirection.OUTPUT);
      expect(inputs).toHaveLength(3);
      expect(outputs).toHaveLength(1);
    });

    it("output pin is labeled out", () => {
      const el = makeOr();
      const output = el.getPins().find((p) => p.direction === PinDirection.OUTPUT);
      expect(output?.label).toBe("out");
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
      for (const mapping of OR_ATTRIBUTE_MAPPINGS) {
        if (entries[mapping.xmlName] !== undefined) {
          bag.set(mapping.propertyKey, mapping.convert(entries[mapping.xmlName]));
        }
      }

      expect(bag.get<number>("inputCount")).toBe(3);
      expect(bag.get<number>("bitWidth")).toBe(8);
      expect(bag.get<boolean>("wideShape")).toBe(true);
    });

    it("Label attribute maps to label property key", () => {
      const mapping = OR_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Label");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("label");
      expect(mapping!.convert("MyOrGate")).toBe("MyOrGate");
    });

    it("inverterConfig attribute maps to _inverterLabels", () => {
      const mapping = OR_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "inverterConfig");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("_inverterLabels");
      expect(mapping!.convert("in0,in1")).toBe("in0,in1");
    });

    it("wideShape=false converts to boolean false", () => {
      const mapping = OR_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "wideShape");
      expect(mapping!.convert("false")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Rendering — IEC/DIN
  // ---------------------------------------------------------------------------

  describe("drawIEC", () => {
    it("IEC shape calls drawRect and drawText with '≥1'", () => {
      const el = makeOr({ wideShape: false });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const rectCalls = calls.filter((c) => c.method === "drawRect");
      const textCalls = calls.filter((c) => c.method === "drawText");

      expect(rectCalls.length).toBeGreaterThanOrEqual(1);
      expect(textCalls.some((c) => c.args[0] === "≥1")).toBe(true);
    });

    it("IEC shape does not call drawPath for the gate body", () => {
      const el = makeOr({ wideShape: false });
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
      const el = makeOr({ wideShape: true });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const pathCalls = calls.filter((c) => c.method === "drawPath");
      expect(pathCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("IEEE shape path includes curveTo operations", () => {
      const el = makeOr({ wideShape: true });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const pathCalls = calls.filter((c) => c.method === "drawPath");
      const hasCurve = pathCalls.some((c) => {
        const path = c.args[0] as PathData;
        return path.operations.some((op) => op.op === "curveTo");
      });
      expect(hasCurve).toBe(true);
    });

    it("IEEE shape does not call drawRect for the gate body", () => {
      const el = makeOr({ wideShape: true });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const rectCalls = calls.filter((c) => c.method === "drawRect");
      expect(rectCalls).toHaveLength(0);
    });

    it("IEEE shape does not draw '≥1' text", () => {
      const el = makeOr({ wideShape: true });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.some((c) => c.args[0] === "≥1")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // ComponentDefinition completeness
  // ---------------------------------------------------------------------------

  describe("definitionComplete", () => {
    it("OrDefinition has name='Or'", () => {
      expect(OrDefinition.name).toBe("Or");
    });

    it("OrDefinition has typeId=-1 (sentinel for auto-assignment)", () => {
      expect(OrDefinition.typeId).toBe(-1);
    });

    it("OrDefinition has a factory function", () => {
      expect(typeof OrDefinition.factory).toBe("function");
    });

    it("OrDefinition factory produces an OrElement", () => {
      const props = new PropertyBag();
      props.set("inputCount", 2);
      props.set("bitWidth", 1);
      props.set("wideShape", false);
      const el = OrDefinition.factory(props);
      expect(el.typeId).toBe("Or");
    });

    it("OrDefinition has executeFn=executeOr", () => {
      expect(OrDefinition.executeFn).toBe(executeOr);
    });

    it("OrDefinition has a non-empty pinLayout", () => {
      expect(OrDefinition.pinLayout.length).toBeGreaterThan(0);
    });

    it("OrDefinition has non-empty propertyDefs", () => {
      expect(OrDefinition.propertyDefs.length).toBeGreaterThan(0);
    });

    it("OrDefinition propertyDefs include inputCount, bitWidth, wideShape, label", () => {
      const keys = OrDefinition.propertyDefs.map((d) => d.key);
      expect(keys).toContain("inputCount");
      expect(keys).toContain("bitWidth");
      expect(keys).toContain("wideShape");
      expect(keys).toContain("label");
    });

    it("OrDefinition has non-empty attributeMap", () => {
      expect(OrDefinition.attributeMap.length).toBeGreaterThan(0);
    });

    it("OrDefinition attributeMap covers Inputs, Bits, wideShape, inverterConfig, Label", () => {
      const xmlNames = OrDefinition.attributeMap.map((m) => m.xmlName);
      expect(xmlNames).toContain("Inputs");
      expect(xmlNames).toContain("Bits");
      expect(xmlNames).toContain("wideShape");
      expect(xmlNames).toContain("inverterConfig");
      expect(xmlNames).toContain("Label");
    });

    it("OrDefinition category is LOGIC", () => {
      expect(OrDefinition.category).toBe(ComponentCategory.LOGIC);
    });

    it("OrDefinition has a non-empty helpText", () => {
      expect(typeof OrDefinition.helpText).toBe("string");
      expect(typeof OrDefinition.helpText).toBe("string"); expect(OrDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });

    it("OrElement.getHelpText() returns the expected text", () => {
      const el = makeOr();
      expect(el.getHelpText()).toContain("Or gate");
    });

    it("OrDefinition can be registered in ComponentRegistry without throwing", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(OrDefinition)).not.toThrow();
    });

    it("After registration, OrDefinition typeId is overwritten with a non-negative integer", () => {
      const registry = new ComponentRegistry();
      registry.register(OrDefinition);
      const registered = registry.get("Or");
      expect(registered).not.toBeUndefined();
      expect(registered!.typeId).toBeGreaterThanOrEqual(0);
    });
  });
});
