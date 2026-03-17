/**
 * Tests for Counter and CounterPreset components (Task 5.2.7).
 *
 * Covers:
 *   - Count up sequence
 *   - Count down (CounterPreset)
 *   - Overflow/wrap behavior
 *   - Clear (synchronous)
 *   - Preset load (CounterPreset)
 *   - Enable/disable
 *   - ovf flag correctness
 *   - Edge detection (only rising clock edge)
 *   - Pin layout
 *   - Attribute mapping
 *   - ComponentDefinition completeness
 *   - Rendering
 */

import { describe, it, expect } from "vitest";
import {
  CounterElement,
  executeCounter,
  CounterDefinition,
  COUNTER_ATTRIBUTE_MAPPINGS,
} from "../counter.js";
import {
  CounterPresetElement,
  executeCounterPreset,
  CounterPresetDefinition,
  COUNTER_PRESET_ATTRIBUTE_MAPPINGS,
} from "../counter-preset.js";
import { PropertyBag } from "../../../core/properties.js";
import { PinDirection } from "../../../core/pin.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import type { ComponentLayout } from "../../../core/registry.js";
import type { RenderContext, Point, TextAnchor, FontSpec, PathData } from "../../../core/renderer-interface.js";
import type { ThemeColor } from "../../../core/renderer-interface.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface LayoutWithState extends ComponentLayout {
  stateOffset(componentIndex: number): number;
  getProperty(componentIndex: number, key: string): number;
}

function makeLayout(
  inputCount: number,
  outputCount: number,
  props: Record<string, number> = {},
): LayoutWithState {
  const outputStart = inputCount;
  const stateStart = inputCount + outputCount;
  return {
    wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: () => inputCount,
    inputOffset: () => 0,
    outputCount: () => outputCount,
    outputOffset: () => outputStart,
    stateOffset: () => stateStart,
    getProperty: (_i: number, key: string) => props[key] ?? 0,
  };
}

function makeState(totalSlots: number, initial?: Partial<Record<number, number>>): Uint32Array {
  const arr = new Uint32Array(totalSlots);
  if (initial) {
    for (const [idx, val] of Object.entries(initial)) {
      arr[parseInt(idx, 10)] = val as number;
    }
  }
  return arr;
}

interface DrawCall { method: string; args: unknown[] }

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

// Counter slot map (4-bit, en+C+clr inputs, out+ovf outputs, counter+prevClock state):
// [en=0, C=1, clr=2, out=3, ovf=4, counter=5, prevClock=6] = 7 slots

// ---------------------------------------------------------------------------
// Counter tests
// ---------------------------------------------------------------------------

describe("Counter", () => {
  describe("count up sequence", () => {
    it("counts from 0 to 1 on first rising clock edge with en=1", () => {
      const layout = makeLayout(3, 2, { bitWidth: 4 });
      const state = makeState(7, { 0: 1, 1: 0, 2: 0, 5: 0, 6: 0 });
      const highZs = new Uint32Array(state.length);
      state[1] = 1;
      executeCounter(0, state, highZs, layout);
      expect(state[3]).toBe(1);
    });

    it("counts 0→1→2→3 over three rising edges", () => {
      const layout = makeLayout(3, 2, { bitWidth: 4 });
      const state = makeState(7, { 0: 1, 1: 0, 2: 0, 5: 0, 6: 0 });
      const highZs = new Uint32Array(state.length);

      for (let expected = 1; expected <= 3; expected++) {
        state[6] = 0;
        state[1] = 1;
        executeCounter(0, state, highZs, layout);
        expect(state[3]).toBe(expected);
        state[1] = 0;
        state[6] = 1;
        executeCounter(0, state, highZs, layout);
      }
    });
  });

  describe("overflow/wrap", () => {
    it("wraps from maxValue (15 for 4-bit) back to 0", () => {
      const layout = makeLayout(3, 2, { bitWidth: 4 });
      const state = makeState(7, { 0: 1, 1: 0, 2: 0, 5: 15, 6: 0 });
      const highZs = new Uint32Array(state.length);
      state[1] = 1;
      executeCounter(0, state, highZs, layout);
      expect(state[3]).toBe(0);
    });

    it("wraps from maxValue (255 for 8-bit) back to 0", () => {
      const layout = makeLayout(3, 2, { bitWidth: 8 });
      const state = makeState(7, { 0: 1, 1: 0, 2: 0, 5: 255, 6: 0 });
      const highZs = new Uint32Array(state.length);
      state[1] = 1;
      executeCounter(0, state, highZs, layout);
      expect(state[3]).toBe(0);
    });
  });

  describe("clear", () => {
    it("clr=1 resets counter to 0 on clock edge (takes priority over increment)", () => {
      const layout = makeLayout(3, 2, { bitWidth: 4 });
      const state = makeState(7, { 0: 1, 1: 0, 2: 1, 5: 7, 6: 0 });
      const highZs = new Uint32Array(state.length);
      state[1] = 1;
      executeCounter(0, state, highZs, layout);
      expect(state[3]).toBe(0);
    });

    it("clr=1 resets even when counter is at 0", () => {
      const layout = makeLayout(3, 2, { bitWidth: 4 });
      const state = makeState(7, { 0: 1, 1: 0, 2: 1, 5: 0, 6: 0 });
      const highZs = new Uint32Array(state.length);
      state[1] = 1;
      executeCounter(0, state, highZs, layout);
      expect(state[3]).toBe(0);
    });
  });

  describe("enable", () => {
    it("en=0 holds counter unchanged on clock edge", () => {
      const layout = makeLayout(3, 2, { bitWidth: 4 });
      const state = makeState(7, { 0: 0, 1: 0, 2: 0, 5: 5, 6: 0 });
      const highZs = new Uint32Array(state.length);
      state[1] = 1;
      executeCounter(0, state, highZs, layout);
      expect(state[3]).toBe(5);
    });
  });

  describe("ovf flag", () => {
    it("ovf=1 when counter==maxValue and en=1", () => {
      const layout = makeLayout(3, 2, { bitWidth: 4 });
      const state = makeState(7, { 0: 1, 1: 0, 2: 0, 5: 15, 6: 1 });
      const highZs = new Uint32Array(state.length);
      executeCounter(0, state, highZs, layout);
      expect(state[4]).toBe(1);
    });

    it("ovf=0 when counter==maxValue but en=0", () => {
      const layout = makeLayout(3, 2, { bitWidth: 4 });
      const state = makeState(7, { 0: 0, 1: 0, 2: 0, 5: 15, 6: 1 });
      const highZs = new Uint32Array(state.length);
      executeCounter(0, state, highZs, layout);
      expect(state[4]).toBe(0);
    });

    it("ovf=0 when counter < maxValue", () => {
      const layout = makeLayout(3, 2, { bitWidth: 4 });
      const state = makeState(7, { 0: 1, 1: 0, 2: 0, 5: 7, 6: 1 });
      const highZs = new Uint32Array(state.length);
      executeCounter(0, state, highZs, layout);
      expect(state[4]).toBe(0);
    });
  });

  describe("edge detection", () => {
    it("no count when clock stays high", () => {
      const layout = makeLayout(3, 2, { bitWidth: 4 });
      const state = makeState(7, { 0: 1, 1: 1, 2: 0, 5: 3, 6: 1 });
      const highZs = new Uint32Array(state.length);
      executeCounter(0, state, highZs, layout);
      expect(state[3]).toBe(3);
    });

    it("no count on falling edge", () => {
      const layout = makeLayout(3, 2, { bitWidth: 4 });
      const state = makeState(7, { 0: 1, 1: 1, 2: 0, 5: 3, 6: 1 });
      const highZs = new Uint32Array(state.length);
      state[1] = 0;
      executeCounter(0, state, highZs, layout);
      expect(state[3]).toBe(3);
    });
  });

  describe("pin layout", () => {
    it("Counter has 3 inputs (en, C, clr) and 2 outputs (out, ovf)", () => {
      const props = new PropertyBag();
      props.set("bitWidth", 4);
      const el = new CounterElement("id", { x: 0, y: 0 }, 0, false, props);
      const pins = el.getPins();
      const inputs = pins.filter(p => p.direction === PinDirection.INPUT);
      const outputs = pins.filter(p => p.direction === PinDirection.OUTPUT);
      expect(inputs).toHaveLength(3);
      expect(outputs).toHaveLength(2);
      expect(inputs.map(p => p.label)).toEqual(["en", "C", "clr"]);
      expect(outputs.map(p => p.label)).toEqual(["out", "ovf"]);
    });

    it("C pin is marked as isClock=true", () => {
      const props = new PropertyBag();
      props.set("bitWidth", 4);
      const el = new CounterElement("id", { x: 0, y: 0 }, 0, false, props);
      const c = el.getPins().find(p => p.label === "C");
      expect(c?.isClock).toBe(true);
    });
  });

  describe("attribute mapping", () => {
    it("Bits=8 maps to bitWidth=8", () => {
      const mapping = COUNTER_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "Bits");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.convert("8")).toBe(8);
    });

    it("Label maps to label key", () => {
      const mapping = COUNTER_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "Label");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.convert("cnt1")).toBe("cnt1");
    });
  });

  describe("definitionComplete", () => {
    it("CounterDefinition has name='Counter'", () => {
      expect(CounterDefinition.name).toBe("Counter");
    });

    it("CounterDefinition has typeId=-1 sentinel", () => {
      expect(CounterDefinition.typeId).toBe(-1);
    });

    it("CounterDefinition category is MEMORY", () => {
      expect(CounterDefinition.category).toBe(ComponentCategory.MEMORY);
    });

    it("CounterDefinition has executeFn=executeCounter", () => {
      expect(CounterDefinition.executeFn).toBe(executeCounter);
    });

    it("CounterDefinition propertyDefs include bitWidth", () => {
      const keys = CounterDefinition.propertyDefs.map(d => d.key);
      expect(keys).toContain("bitWidth");
    });

    it("CounterDefinition has non-empty helpText", () => {
      expect(typeof CounterDefinition.helpText).toBe("string"); expect(CounterDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });

    it("CounterDefinition can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(CounterDefinition)).not.toThrow();
    });

    it("CounterDefinition factory produces a CounterElement", () => {
      const props = new PropertyBag();
      props.set("bitWidth", 4);
      const el = CounterDefinition.factory(props);
      expect(el.typeId).toBe("Counter");
    });
  });

  describe("rendering", () => {
    it("draw() calls drawPolygon for body", () => {
      const props = new PropertyBag();
      props.set("bitWidth", 4);
      const el = new CounterElement("id", { x: 0, y: 0 }, 0, false, props);
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const rects = calls.filter(c => c.method === "drawPolygon");
      expect(rects.length).toBeGreaterThanOrEqual(1);
    });

    it("draw() renders en and clr labels", () => {
      const props = new PropertyBag();
      props.set("bitWidth", 4);
      const el = new CounterElement("id", { x: 0, y: 0 }, 0, false, props);
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const texts = calls.filter(c => c.method === "drawText").map(c => c.args[0]);
      expect(texts).toContain("en");
      expect(texts).toContain("clr");
    });
  });
});

// ---------------------------------------------------------------------------
// CounterPreset tests
// ---------------------------------------------------------------------------

describe("CounterPreset", () => {
  // Slot map: [en=0,C=1,dir=2,in=3,ld=4,clr=5, out=6,ovf=7, counter=8,prevClock=9] = 10 slots

  describe("count up sequence (dir=0)", () => {
    it("counts from 0 to 1 with en=1 dir=0", () => {
      const layout = makeLayout(6, 2, { bitWidth: 4, maxValue: 0 });
      const state = makeState(10, { 0: 1, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 8: 0, 9: 0 });
      const highZs = new Uint32Array(state.length);
      state[1] = 1;
      executeCounterPreset(0, state, highZs, layout);
      expect(state[6]).toBe(1);
    });

    it("wraps from maxValue (15 for 4-bit) to 0 when counting up", () => {
      const layout = makeLayout(6, 2, { bitWidth: 4, maxValue: 0 });
      const state = makeState(10, { 0: 1, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 8: 15, 9: 0 });
      const highZs = new Uint32Array(state.length);
      state[1] = 1;
      executeCounterPreset(0, state, highZs, layout);
      expect(state[6]).toBe(0);
    });
  });

  describe("count down sequence (dir=1)", () => {
    it("decrements from 5 to 4 with en=1 dir=1", () => {
      const layout = makeLayout(6, 2, { bitWidth: 4, maxValue: 0 });
      const state = makeState(10, { 0: 1, 1: 0, 2: 1, 3: 0, 4: 0, 5: 0, 8: 5, 9: 0 });
      const highZs = new Uint32Array(state.length);
      state[1] = 1;
      executeCounterPreset(0, state, highZs, layout);
      expect(state[6]).toBe(4);
    });

    it("wraps from 0 back to maxValue (15) when counting down", () => {
      const layout = makeLayout(6, 2, { bitWidth: 4, maxValue: 0 });
      const state = makeState(10, { 0: 1, 1: 0, 2: 1, 3: 0, 4: 0, 5: 0, 8: 0, 9: 0 });
      const highZs = new Uint32Array(state.length);
      state[1] = 1;
      executeCounterPreset(0, state, highZs, layout);
      expect(state[6]).toBe(15);
    });
  });

  describe("clear (synchronous)", () => {
    it("clr=1 resets counter to 0 on clock edge", () => {
      const layout = makeLayout(6, 2, { bitWidth: 4, maxValue: 0 });
      const state = makeState(10, { 0: 1, 1: 0, 2: 0, 3: 0, 4: 0, 5: 1, 8: 7, 9: 0 });
      const highZs = new Uint32Array(state.length);
      state[1] = 1;
      executeCounterPreset(0, state, highZs, layout);
      expect(state[6]).toBe(0);
    });

    it("clr=1 takes priority over ld=1", () => {
      const layout = makeLayout(6, 2, { bitWidth: 4, maxValue: 0 });
      const state = makeState(10, { 0: 1, 1: 0, 2: 0, 3: 9, 4: 1, 5: 1, 8: 7, 9: 0 });
      const highZs = new Uint32Array(state.length);
      state[1] = 1;
      executeCounterPreset(0, state, highZs, layout);
      expect(state[6]).toBe(0);
    });
  });

  describe("preset load", () => {
    it("ld=1 loads 'in' value on clock edge when clr=0", () => {
      const layout = makeLayout(6, 2, { bitWidth: 4, maxValue: 0 });
      const state = makeState(10, { 0: 1, 1: 0, 2: 0, 3: 9, 4: 1, 5: 0, 8: 0, 9: 0 });
      const highZs = new Uint32Array(state.length);
      state[1] = 1;
      executeCounterPreset(0, state, highZs, layout);
      expect(state[6]).toBe(9);
    });

    it("ld loads value after count operation on same edge", () => {
      const layout = makeLayout(6, 2, { bitWidth: 4, maxValue: 0 });
      const state = makeState(10, { 0: 1, 1: 0, 2: 0, 3: 5, 4: 1, 5: 0, 8: 3, 9: 0 });
      const highZs = new Uint32Array(state.length);
      state[1] = 1;
      executeCounterPreset(0, state, highZs, layout);
      expect(state[6]).toBe(5);
    });
  });

  describe("enable", () => {
    it("en=0 holds counter unchanged on clock edge", () => {
      const layout = makeLayout(6, 2, { bitWidth: 4, maxValue: 0 });
      const state = makeState(10, { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 8: 7, 9: 0 });
      const highZs = new Uint32Array(state.length);
      state[1] = 1;
      executeCounterPreset(0, state, highZs, layout);
      expect(state[6]).toBe(7);
    });
  });

  describe("ovf flag", () => {
    it("ovf=1 when counter==maxValue (15) counting up with en=1", () => {
      const layout = makeLayout(6, 2, { bitWidth: 4, maxValue: 0 });
      const state = makeState(10, { 0: 1, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 8: 15, 9: 1 });
      const highZs = new Uint32Array(state.length);
      executeCounterPreset(0, state, highZs, layout);
      expect(state[7]).toBe(1);
    });

    it("ovf=1 when counter==0 counting down (dir=1) with en=1", () => {
      const layout = makeLayout(6, 2, { bitWidth: 4, maxValue: 0 });
      const state = makeState(10, { 0: 1, 1: 0, 2: 1, 3: 0, 4: 0, 5: 0, 8: 0, 9: 1 });
      const highZs = new Uint32Array(state.length);
      executeCounterPreset(0, state, highZs, layout);
      expect(state[7]).toBe(1);
    });

    it("ovf=0 when counter is not at overflow position", () => {
      const layout = makeLayout(6, 2, { bitWidth: 4, maxValue: 0 });
      const state = makeState(10, { 0: 1, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 8: 7, 9: 1 });
      const highZs = new Uint32Array(state.length);
      executeCounterPreset(0, state, highZs, layout);
      expect(state[7]).toBe(0);
    });
  });

  describe("custom maxValue", () => {
    it("wraps at custom maxValue=9 when counting up", () => {
      const layout = makeLayout(6, 2, { bitWidth: 4, maxValue: 9 });
      const state = makeState(10, { 0: 1, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 8: 9, 9: 0 });
      const highZs = new Uint32Array(state.length);
      state[1] = 1;
      executeCounterPreset(0, state, highZs, layout);
      expect(state[6]).toBe(0);
    });

    it("wraps at 9 when counting down from 0", () => {
      const layout = makeLayout(6, 2, { bitWidth: 4, maxValue: 9 });
      const state = makeState(10, { 0: 1, 1: 0, 2: 1, 3: 0, 4: 0, 5: 0, 8: 0, 9: 0 });
      const highZs = new Uint32Array(state.length);
      state[1] = 1;
      executeCounterPreset(0, state, highZs, layout);
      expect(state[6]).toBe(9);
    });
  });

  describe("pin layout", () => {
    it("CounterPreset has 6 inputs and 2 outputs", () => {
      const props = new PropertyBag();
      props.set("bitWidth", 4);
      props.set("maxValue", 0);
      const el = new CounterPresetElement("id", { x: 0, y: 0 }, 0, false, props);
      const pins = el.getPins();
      const inputs = pins.filter(p => p.direction === PinDirection.INPUT);
      const outputs = pins.filter(p => p.direction === PinDirection.OUTPUT);
      expect(inputs).toHaveLength(6);
      expect(outputs).toHaveLength(2);
      expect(inputs.map(p => p.label)).toEqual(["en", "C", "dir", "in", "ld", "clr"]);
    });
  });

  describe("attribute mapping", () => {
    it("maxValue maps to maxValue key as integer", () => {
      const mapping = COUNTER_PRESET_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "maxValue");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.convert("15")).toBe(15);
    });

    it("Bits maps to bitWidth", () => {
      const mapping = COUNTER_PRESET_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "Bits");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.convert("8")).toBe(8);
    });
  });

  describe("definitionComplete", () => {
    it("CounterPresetDefinition has name='CounterPreset'", () => {
      expect(CounterPresetDefinition.name).toBe("CounterPreset");
    });

    it("CounterPresetDefinition category is MEMORY", () => {
      expect(CounterPresetDefinition.category).toBe(ComponentCategory.MEMORY);
    });

    it("CounterPresetDefinition has executeFn=executeCounterPreset", () => {
      expect(CounterPresetDefinition.executeFn).toBe(executeCounterPreset);
    });

    it("CounterPresetDefinition propertyDefs include maxValue", () => {
      const keys = CounterPresetDefinition.propertyDefs.map(d => d.key);
      expect(keys).toContain("maxValue");
    });

    it("CounterPresetDefinition can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(CounterPresetDefinition)).not.toThrow();
    });
  });

  describe("rendering", () => {
    it("draw() calls drawPolygon for body", () => {
      const props = new PropertyBag();
      props.set("bitWidth", 4);
      props.set("maxValue", 0);
      const el = new CounterPresetElement("id", { x: 0, y: 0 }, 0, false, props);
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const rects = calls.filter(c => c.method === "drawPolygon");
      expect(rects.length).toBeGreaterThanOrEqual(1);
    });

    it("draw() renders dir and ld labels", () => {
      const props = new PropertyBag();
      props.set("bitWidth", 4);
      props.set("maxValue", 0);
      const el = new CounterPresetElement("id", { x: 0, y: 0 }, 0, false, props);
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const texts = calls.filter(c => c.method === "drawText").map(c => c.args[0]);
      expect(texts).toContain("dir");
      expect(texts).toContain("ld");
    });
  });
});
