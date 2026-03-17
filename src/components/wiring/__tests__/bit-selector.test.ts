/**
 * Tests for the BitSelector component.
 *
 * Covers:
 *   - executeBitSelector: correct bit extraction for various selector values
 *   - executeBitSelector: multi-bit input, boundary conditions
 *   - Pin layout: correct input/output structure
 *   - Attribute mapping
 *   - Rendering
 *   - ComponentDefinition completeness
 */

import { describe, it, expect } from "vitest";
import {
  BitSelectorElement,
  executeBitSelector,
  BitSelectorDefinition,
  BIT_SELECTOR_ATTRIBUTE_MAPPINGS,
  buildBitSelectorPinDeclarations,
} from "../bit-selector.js";
import { PropertyBag } from "../../../core/properties.js";
import { PinDirection } from "../../../core/pin.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import type { ComponentLayout } from "../../../core/registry.js";
import type { RenderContext, Point, TextAnchor, FontSpec, PathData } from "../../../core/renderer-interface.js";
import type { ThemeColor } from "../../../core/renderer-interface.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLayout(inputCount: number, outputCount: number): ComponentLayout {
  return {
    wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: () => inputCount,
    inputOffset: () => 0,
    outputCount: () => outputCount,
    outputOffset: () => inputCount,
    stateOffset: () => inputCount + outputCount,
    getProperty: () => undefined,
  };
}

function makeState(inputs: number[]): Uint32Array {
  const arr = new Uint32Array(inputs.length + 1);
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

function makeBitSelector(overrides?: { selectorBits?: number }): BitSelectorElement {
  const props = new PropertyBag();
  props.set("selectorBits", overrides?.selectorBits ?? 3);
  return new BitSelectorElement("test-bsel-001", { x: 0, y: 0 }, 0, false, props);
}

// ---------------------------------------------------------------------------
// executeBitSelector — logic correctness
// ---------------------------------------------------------------------------

describe("BitSelector", () => {
  describe("execute2Input", () => {
    it("input=0b1010, sel=0 → output=0 (bit 0 is 0)", () => {
      // inputs: [in=0b1010, sel=0]; output
      const layout = makeLayout(2, 1);
      const state = makeState([0b1010, 0]);
      const highZs = new Uint32Array(state.length);
      executeBitSelector(0, state, highZs, layout);
      expect(state[2]).toBe(0);
    });

    it("input=0b1010, sel=1 → output=1 (bit 1 is 1)", () => {
      const layout = makeLayout(2, 1);
      const state = makeState([0b1010, 1]);
      const highZs = new Uint32Array(state.length);
      executeBitSelector(0, state, highZs, layout);
      expect(state[2]).toBe(1);
    });

    it("input=0b1010, sel=2 → output=0 (bit 2 is 0)", () => {
      const layout = makeLayout(2, 1);
      const state = makeState([0b1010, 2]);
      const highZs = new Uint32Array(state.length);
      executeBitSelector(0, state, highZs, layout);
      expect(state[2]).toBe(0);
    });

    it("input=0b1010, sel=3 → output=1 (bit 3 is 1)", () => {
      const layout = makeLayout(2, 1);
      const state = makeState([0b1010, 3]);
      const highZs = new Uint32Array(state.length);
      executeBitSelector(0, state, highZs, layout);
      expect(state[2]).toBe(1);
    });
  });

  describe("executeMultiInput", () => {
    it("all-ones input: any selector returns 1", () => {
      const layout = makeLayout(2, 1);
      for (let sel = 0; sel < 8; sel++) {
        const state = makeState([0xFF, sel]);
      const highZs = new Uint32Array(state.length);
        executeBitSelector(0, state, highZs, layout);
        expect(state[2]).toBe(1);
      }
    });

    it("all-zeros input: any selector returns 0", () => {
      const layout = makeLayout(2, 1);
      for (let sel = 0; sel < 8; sel++) {
        const state = makeState([0x00, sel]);
      const highZs = new Uint32Array(state.length);
        executeBitSelector(0, state, highZs, layout);
        expect(state[2]).toBe(0);
      }
    });

    it("32-bit input 0xDEADBEEF: selects correct bits", () => {
      const layout = makeLayout(2, 1);
      const value = 0xDEADBEEF >>> 0;

      for (let sel = 0; sel < 32; sel++) {
        const state = makeState([value, sel]);
      const highZs = new Uint32Array(state.length);
        executeBitSelector(0, state, highZs, layout);
        const expected = (value >>> sel) & 1;
        expect(state[2]).toBe(expected);
      }
    });
  });

  describe("multiBit", () => {
    it("output is always 0 or 1 (single bit)", () => {
      const layout = makeLayout(2, 1);
      const state = makeState([0xFFFFFFFF, 15]);
      const highZs = new Uint32Array(state.length);
      executeBitSelector(0, state, highZs, layout);
      expect(state[2]).toBe(1);
    });

    it("selecting bit 0 of odd number returns 1", () => {
      const layout = makeLayout(2, 1);
      const state = makeState([0x12345679, 0]);
      const highZs = new Uint32Array(state.length);
      executeBitSelector(0, state, highZs, layout);
      expect(state[2]).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Pin layout
  // ---------------------------------------------------------------------------

  describe("pinLayout", () => {
    it("BitSelector produces 2 input pins and 1 output pin", () => {
      const el = makeBitSelector({ selectorBits: 3 });
      const pins = el.getPins();
      const inputs = pins.filter((p) => p.direction === PinDirection.INPUT);
      const outputs = pins.filter((p) => p.direction === PinDirection.OUTPUT);
      expect(inputs).toHaveLength(2);
      expect(outputs).toHaveLength(1);
    });

    it("input pins labeled 'in' and 'sel'", () => {
      const el = makeBitSelector({ selectorBits: 3 });
      const inputs = el.getPins().filter((p) => p.direction === PinDirection.INPUT);
      const labels = inputs.map((p) => p.label);
      expect(labels).toContain("in");
      expect(labels).toContain("sel");
    });

    it("output pin labeled 'out'", () => {
      const el = makeBitSelector({ selectorBits: 3 });
      const out = el.getPins().find((p) => p.direction === PinDirection.OUTPUT);
      expect(out?.label).toBe("out");
    });

    it("output pin has bitWidth=1", () => {
      const el = makeBitSelector({ selectorBits: 3 });
      const out = el.getPins().find((p) => p.direction === PinDirection.OUTPUT);
      expect(out?.bitWidth).toBe(1);
    });
  });

  describe("pinLayoutFromDeclarations", () => {
    it("buildBitSelectorPinDeclarations(3) produces 2 inputs + 1 output", () => {
      const decls = buildBitSelectorPinDeclarations(3);
      expect(decls.filter((d) => d.direction === PinDirection.INPUT)).toHaveLength(2);
      expect(decls.filter((d) => d.direction === PinDirection.OUTPUT)).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Attribute mapping
  // ---------------------------------------------------------------------------

  describe("attributeMapping", () => {
    it("Selector Bits maps to selectorBits", () => {
      const entries: Record<string, string> = {
        "Selector Bits": "4",
      };
      const bag = new PropertyBag();
      for (const mapping of BIT_SELECTOR_ATTRIBUTE_MAPPINGS) {
        if (entries[mapping.xmlName] !== undefined) {
          bag.set(mapping.propertyKey, mapping.convert(entries[mapping.xmlName]));
        }
      }
      expect(bag.get<number>("selectorBits")).toBe(4);
    });
  });

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  describe("draw", () => {
    it("draw() calls drawPolygon for trapezoid body", () => {
      const el = makeBitSelector();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const polygonCalls = calls.filter((c) => c.method === "drawPolygon");
      expect(polygonCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("draw() does not draw any text (BitSelector has no label)", () => {
      const el = makeBitSelector();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // ComponentDefinition completeness
  // ---------------------------------------------------------------------------

  describe("definitionComplete", () => {
    it("BitSelectorDefinition has name='BitSelector'", () => {
      expect(BitSelectorDefinition.name).toBe("BitSelector");
    });

    it("BitSelectorDefinition has typeId=-1 (sentinel)", () => {
      expect(BitSelectorDefinition.typeId).toBe(-1);
    });

    it("BitSelectorDefinition factory produces element with correct typeId", () => {
      const props = new PropertyBag();
      props.set("selectorBits", 3);
      const el = BitSelectorDefinition.factory(props);
      expect(el.typeId).toBe("BitSelector");
    });

    it("BitSelectorDefinition has executeFn=executeBitSelector", () => {
      expect(BitSelectorDefinition.executeFn).toBe(executeBitSelector);
    });

    it("BitSelectorDefinition has non-empty pinLayout", () => {
      expect(BitSelectorDefinition.pinLayout.length).toBeGreaterThan(0);
    });

    it("BitSelectorDefinition propertyDefs include selectorBits", () => {
      const keys = BitSelectorDefinition.propertyDefs.map((d) => d.key);
      expect(keys).toContain("selectorBits");
    });

    it("BitSelectorDefinition attributeMap covers Selector Bits", () => {
      const xmlNames = BitSelectorDefinition.attributeMap.map((m) => m.xmlName);
      expect(xmlNames).toContain("Selector Bits");
    });

    it("BitSelectorDefinition category is WIRING", () => {
      expect(BitSelectorDefinition.category).toBe(ComponentCategory.WIRING);
    });

    it("BitSelectorDefinition has a non-empty helpText", () => {
      expect(typeof BitSelectorDefinition.helpText).toBe("string");
      expect(typeof BitSelectorDefinition.helpText).toBe("string"); expect(BitSelectorDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });

    it("BitSelectorDefinition can be registered in ComponentRegistry without throwing", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(BitSelectorDefinition)).not.toThrow();
    });

    it("After registration, typeId is a non-negative integer", () => {
      const registry = new ComponentRegistry();
      registry.register(BitSelectorDefinition);
      const registered = registry.get("BitSelector");
      expect(registered).not.toBeUndefined();
      expect(registered!.typeId).toBeGreaterThanOrEqual(0);
    });
  });
});
