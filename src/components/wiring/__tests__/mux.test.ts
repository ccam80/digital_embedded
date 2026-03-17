/**
 * Tests for the Multiplexer component.
 *
 * Covers:
 *   - executeMux: truth table verification for representative cases
 *   - executeMux: multi-bit operation
 *   - Pin layout: correct count and labels for 1-bit and 2-bit selector configs
 *   - Attribute mapping: .dig XML attributes convert to correct PropertyBag entries
 *   - Rendering: draw() calls polygon and text
 *   - ComponentDefinition: all required fields present
 */

import { describe, it, expect } from "vitest";
import {
  MuxElement,
  executeMux,
  MuxDefinition,
  MUX_ATTRIBUTE_MAPPINGS,
  buildMuxPinDeclarations,
} from "../mux.js";
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
  const arr = new Uint32Array(inputs.length + 8);
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

function makeMux(overrides?: { selectorBits?: number; bitWidth?: number }): MuxElement {
  const props = new PropertyBag();
  props.set("selectorBits", overrides?.selectorBits ?? 1);
  props.set("bitWidth", overrides?.bitWidth ?? 1);
  return new MuxElement("test-mux-001", { x: 0, y: 0 }, 0, false, props);
}

// ---------------------------------------------------------------------------
// executeMux — logic correctness
// ---------------------------------------------------------------------------

describe("Multiplexer", () => {
  describe("execute2Input", () => {
    it("sel=0 selects in_0", () => {
      // 1-bit selector: 2 data inputs
      // state: [sel=0, in_0=0xAA, in_1=0xBB, out]
      const layout = makeLayout(3, 1);
      const state = makeState([0, 0xAA, 0xBB]);
      const highZs = new Uint32Array(state.length);
      executeMux(0, state, highZs, layout);
      expect(state[3]).toBe(0xAA);
    });

    it("sel=1 selects in_1", () => {
      const layout = makeLayout(3, 1);
      const state = makeState([1, 0xAA, 0xBB]);
      const highZs = new Uint32Array(state.length);
      executeMux(0, state, highZs, layout);
      expect(state[3]).toBe(0xBB);
    });

    it("sel=0 with 1-bit inputs: selects 0", () => {
      const layout = makeLayout(3, 1);
      const state = makeState([0, 0, 1]);
      const highZs = new Uint32Array(state.length);
      executeMux(0, state, highZs, layout);
      expect(state[3]).toBe(0);
    });

    it("sel=1 with 1-bit inputs: selects 1", () => {
      const layout = makeLayout(3, 1);
      const state = makeState([1, 0, 1]);
      const highZs = new Uint32Array(state.length);
      executeMux(0, state, highZs, layout);
      expect(state[3]).toBe(1);
    });
  });

  describe("executeMultiInput", () => {
    it("4-input mux: sel=2 selects in_2", () => {
      // 2-bit selector: 4 data inputs
      // state: [sel=2, in_0=0x11, in_1=0x22, in_2=0x33, in_3=0x44, out]
      const layout = makeLayout(5, 1);
      const state = makeState([2, 0x11, 0x22, 0x33, 0x44]);
      const highZs = new Uint32Array(state.length);
      executeMux(0, state, highZs, layout);
      expect(state[5]).toBe(0x33);
    });

    it("4-input mux: sel=3 selects in_3", () => {
      const layout = makeLayout(5, 1);
      const state = makeState([3, 0x11, 0x22, 0x33, 0x44]);
      const highZs = new Uint32Array(state.length);
      executeMux(0, state, highZs, layout);
      expect(state[5]).toBe(0x44);
    });

    it("4-input mux: sel=0 selects in_0", () => {
      const layout = makeLayout(5, 1);
      const state = makeState([0, 0x11, 0x22, 0x33, 0x44]);
      const highZs = new Uint32Array(state.length);
      executeMux(0, state, highZs, layout);
      expect(state[5]).toBe(0x11);
    });
  });

  describe("multiBit", () => {
    it("multi-bit: sel=1, 32-bit values", () => {
      const layout = makeLayout(3, 1);
      const state = makeState([1, 0xDEADBEEF, 0xCAFEBABE]);
      const highZs = new Uint32Array(state.length);
      executeMux(0, state, highZs, layout);
      expect(state[3]).toBe(0xCAFEBABE >>> 0);
    });

    it("multi-bit: sel=0, 32-bit all-ones passes through", () => {
      const layout = makeLayout(3, 1);
      const state = makeState([0, 0xFFFFFFFF, 0x00000000]);
      const highZs = new Uint32Array(state.length);
      executeMux(0, state, highZs, layout);
      expect(state[3]).toBe(0xFFFFFFFF);
    });
  });

  // ---------------------------------------------------------------------------
  // Pin layout
  // ---------------------------------------------------------------------------

  describe("pinLayout1BitSelector", () => {
    it("1-bit selector produces 3 input pins (sel + 2 data) and 1 output", () => {
      const el = makeMux({ selectorBits: 1 });
      const pins = el.getPins();
      const inputs = pins.filter((p) => p.direction === PinDirection.INPUT);
      const outputs = pins.filter((p) => p.direction === PinDirection.OUTPUT);
      expect(inputs).toHaveLength(3); // sel + in_0 + in_1
      expect(outputs).toHaveLength(1);
    });

    it("sel pin is labeled 'sel'", () => {
      const el = makeMux({ selectorBits: 1 });
      const sel = el.getPins().find((p) => p.label === "sel");
      expect(sel).toBeDefined();
      expect(sel!.direction).toBe(PinDirection.INPUT);
    });

    it("data input pins are labeled in_0 and in_1", () => {
      const el = makeMux({ selectorBits: 1 });
      const inputs = el.getPins().filter((p) => p.direction === PinDirection.INPUT && p.label !== "sel");
      expect(inputs.map((p) => p.label)).toEqual(["in_0", "in_1"]);
    });

    it("output pin is labeled 'out'", () => {
      const el = makeMux({ selectorBits: 1 });
      const out = el.getPins().find((p) => p.direction === PinDirection.OUTPUT);
      expect(out?.label).toBe("out");
    });
  });

  describe("pinLayout2BitSelector", () => {
    it("2-bit selector produces 5 input pins (sel + 4 data) and 1 output", () => {
      const el = makeMux({ selectorBits: 2 });
      const pins = el.getPins();
      const inputs = pins.filter((p) => p.direction === PinDirection.INPUT);
      const outputs = pins.filter((p) => p.direction === PinDirection.OUTPUT);
      expect(inputs).toHaveLength(5); // sel + in_0..in_3
      expect(outputs).toHaveLength(1);
    });

    it("4 data input pins labeled in_0..in_3", () => {
      const el = makeMux({ selectorBits: 2 });
      const dataInputs = el
        .getPins()
        .filter((p) => p.direction === PinDirection.INPUT && p.label !== "sel");
      expect(dataInputs.map((p) => p.label)).toEqual(["in_0", "in_1", "in_2", "in_3"]);
    });
  });

  describe("pinLayoutFromDeclarations", () => {
    it("buildMuxPinDeclarations(1,1) produces 3 inputs + 1 output", () => {
      const decls = buildMuxPinDeclarations(1, 1);
      expect(decls.filter((d) => d.direction === PinDirection.INPUT)).toHaveLength(3);
      expect(decls.filter((d) => d.direction === PinDirection.OUTPUT)).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Attribute mapping
  // ---------------------------------------------------------------------------

  describe("attributeMapping", () => {
    it("Bits and Selector Bits map to correct PropertyBag entries", () => {
      const entries: Record<string, string> = {
        Bits: "8",
        "Selector Bits": "2",
      };
      const bag = new PropertyBag();
      for (const mapping of MUX_ATTRIBUTE_MAPPINGS) {
        if (entries[mapping.xmlName] !== undefined) {
          bag.set(mapping.propertyKey, mapping.convert(entries[mapping.xmlName]));
        }
      }
      expect(bag.get<number>("bitWidth")).toBe(8);
      expect(bag.get<number>("selectorBits")).toBe(2);
    });

    it("Label maps to label property key", () => {
      const mapping = MUX_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Label");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("label");
      expect(mapping!.convert("MuxLabel")).toBe("MuxLabel");
    });
  });

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  describe("draw", () => {
    it("draw() calls drawPolygon for trapezoid body", () => {
      const el = makeMux();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const polygonCalls = calls.filter((c) => c.method === "drawPolygon");
      expect(polygonCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("draw() renders '0' text label", () => {
      const el = makeMux();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.some((c) => c.args[0] === "0")).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // ComponentDefinition completeness
  // ---------------------------------------------------------------------------

  describe("definitionComplete", () => {
    it("MuxDefinition has name='Multiplexer'", () => {
      expect(MuxDefinition.name).toBe("Multiplexer");
    });

    it("MuxDefinition has typeId=-1 (sentinel)", () => {
      expect(MuxDefinition.typeId).toBe(-1);
    });

    it("MuxDefinition has a factory function", () => {
      expect(typeof MuxDefinition.factory).toBe("function");
    });

    it("MuxDefinition factory produces a MuxElement with correct typeId", () => {
      const props = new PropertyBag();
      props.set("selectorBits", 1);
      props.set("bitWidth", 1);
      const el = MuxDefinition.factory(props);
      expect(el.typeId).toBe("Multiplexer");
    });

    it("MuxDefinition has executeFn=executeMux", () => {
      expect(MuxDefinition.executeFn).toBe(executeMux);
    });

    it("MuxDefinition has a non-empty pinLayout", () => {
      expect(MuxDefinition.pinLayout.length).toBeGreaterThan(0);
    });

    it("MuxDefinition has non-empty propertyDefs", () => {
      expect(MuxDefinition.propertyDefs.length).toBeGreaterThan(0);
    });

    it("MuxDefinition propertyDefs include selectorBits and bitWidth", () => {
      const keys = MuxDefinition.propertyDefs.map((d) => d.key);
      expect(keys).toContain("selectorBits");
      expect(keys).toContain("bitWidth");
    });

    it("MuxDefinition has non-empty attributeMap", () => {
      expect(MuxDefinition.attributeMap.length).toBeGreaterThan(0);
    });

    it("MuxDefinition attributeMap covers Bits and Selector Bits", () => {
      const xmlNames = MuxDefinition.attributeMap.map((m) => m.xmlName);
      expect(xmlNames).toContain("Bits");
      expect(xmlNames).toContain("Selector Bits");
    });

    it("MuxDefinition category is WIRING", () => {
      expect(MuxDefinition.category).toBe(ComponentCategory.WIRING);
    });

    it("MuxDefinition has a non-empty helpText", () => {
      expect(typeof MuxDefinition.helpText).toBe("string");
      expect(typeof MuxDefinition.helpText).toBe("string"); expect(MuxDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });

    it("MuxDefinition can be registered in ComponentRegistry without throwing", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(MuxDefinition)).not.toThrow();
    });

    it("After registration, typeId is a non-negative integer", () => {
      const registry = new ComponentRegistry();
      registry.register(MuxDefinition);
      const registered = registry.get("Multiplexer");
      expect(registered).not.toBeUndefined();
      expect(registered!.typeId).toBeGreaterThanOrEqual(0);
    });
  });
});
