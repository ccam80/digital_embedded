/**
 * Tests for the Monoflop component (Task 5.2.4).
 *
 * Covers:
 *   - Trigger produces pulse of correct duration
 *   - Retriggering behavior (new edge resets counter)
 *   - R (reset) input cancels active pulse
 *   - Edge detection (only rising edge triggers)
 *   - Q and ~Q are complementary
 *   - Pin layout
 *   - Attribute mapping
 *   - ComponentDefinition completeness
 *   - Rendering
 */

import { describe, it, expect } from "vitest";
import {
  MonoflopElement,
  executeMonoflop,
  MonoflopDefinition,
  MONOFLOP_ATTRIBUTE_MAPPINGS,
} from "../monoflop.js";
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
  getProperty?(componentIndex: number, key: string): number;
}

/**
 * Build a layout that includes stateOffset and optional getProperty.
 * Layout: inputs at 0..inputCount-1, outputs at inputCount..., state at inputCount+outputCount...
 */
function makeLayout(inputCount: number, outputCount: number, timerDelay: number): LayoutWithState {
  const outputStart = inputCount;
  const stateStart = inputCount + outputCount;

  return {
    inputCount: () => inputCount,
    inputOffset: () => 0,
    outputCount: () => outputCount,
    outputOffset: () => outputStart,
    stateOffset: () => stateStart,
    getProperty: (_i: number, key: string) => {
      if (key === "timerDelay") return timerDelay;
      return 0;
    },
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

// Slot map for timerDelay=N: [C=0, R=1, Q=2, ~Q=3, storedQ=4, prevClock=5, counter=6]
// total = 7 slots

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

// ---------------------------------------------------------------------------
// Monoflop tests
// ---------------------------------------------------------------------------

describe("Monoflop", () => {
  describe("trigger produces pulse", () => {
    it("rising edge on C sets Q=1 immediately", () => {
      const layout = makeLayout(2, 2, 3);
      // slots: [C=0, R=1, Q=2, ~Q=3, storedQ=4, prevClock=5, counter=6]
      const state = makeState(7, { 0: 0, 1: 0, 4: 0, 5: 0, 6: 0 });
      state[0] = 1;
      executeMonoflop(0, state, layout);
      expect(state[2]).toBe(1);
      expect(state[3]).toBe(0);
    });

    it("after trigger, counter is set to timerDelay", () => {
      const layout = makeLayout(2, 2, 3);
      const state = makeState(7, { 0: 0, 1: 0, 4: 0, 5: 0, 6: 0 });
      state[0] = 1;
      executeMonoflop(0, state, layout);
      expect(state[6]).toBe(3);
    });

    it("Q stays high for timerDelay ticks then returns to 0", () => {
      const timerDelay = 3;
      const layout = makeLayout(2, 2, timerDelay);
      const state = makeState(7, { 0: 0, 1: 0, 4: 0, 5: 0, 6: 0 });

      state[0] = 1;
      executeMonoflop(0, state, layout);
      expect(state[2]).toBe(1);
      expect(state[6]).toBe(3);

      state[0] = 0;
      state[5] = 0;

      executeMonoflop(0, state, layout);
      expect(state[2]).toBe(1);
      expect(state[6]).toBe(2);

      executeMonoflop(0, state, layout);
      expect(state[2]).toBe(1);
      expect(state[6]).toBe(1);

      executeMonoflop(0, state, layout);
      expect(state[2]).toBe(0);
      expect(state[6]).toBe(0);
    });

    it("timerDelay=1 produces single-tick pulse", () => {
      const layout = makeLayout(2, 2, 1);
      const state = makeState(7, { 0: 0, 1: 0, 4: 0, 5: 0, 6: 0 });
      state[0] = 1;
      executeMonoflop(0, state, layout);
      expect(state[2]).toBe(1);
      expect(state[6]).toBe(1);

      state[0] = 0;
      state[5] = 0;
      executeMonoflop(0, state, layout);
      expect(state[2]).toBe(0);
    });
  });

  describe("retriggering", () => {
    it("new rising edge while active resets counter to timerDelay", () => {
      const timerDelay = 4;
      const layout = makeLayout(2, 2, timerDelay);
      const state = makeState(7, { 0: 0, 1: 0, 4: 0, 5: 0, 6: 0 });

      state[0] = 1;
      executeMonoflop(0, state, layout);
      expect(state[6]).toBe(4);

      state[0] = 0;
      state[5] = 0;
      executeMonoflop(0, state, layout);
      expect(state[6]).toBe(3);

      state[0] = 1;
      state[5] = 0;
      executeMonoflop(0, state, layout);
      expect(state[6]).toBe(4);
      expect(state[2]).toBe(1);
    });
  });

  describe("reset input", () => {
    it("R=1 immediately forces Q=0 and cancels pulse", () => {
      const layout = makeLayout(2, 2, 3);
      const state = makeState(7, { 0: 0, 1: 0, 4: 1, 5: 0, 6: 2 });
      state[1] = 1;
      executeMonoflop(0, state, layout);
      expect(state[2]).toBe(0);
      expect(state[6]).toBe(0);
    });

    it("R=1 prevents trigger on rising edge", () => {
      const layout = makeLayout(2, 2, 3);
      const state = makeState(7, { 0: 0, 1: 1, 4: 0, 5: 0, 6: 0 });
      state[0] = 1;
      executeMonoflop(0, state, layout);
      expect(state[2]).toBe(0);
    });
  });

  describe("edge detection", () => {
    it("no trigger when clock stays high (no new rising edge)", () => {
      const layout = makeLayout(2, 2, 3);
      const state = makeState(7, { 0: 1, 1: 0, 4: 0, 5: 1, 6: 0 });
      executeMonoflop(0, state, layout);
      expect(state[2]).toBe(0);
    });

    it("no trigger on falling edge", () => {
      const layout = makeLayout(2, 2, 3);
      const state = makeState(7, { 0: 1, 1: 0, 4: 0, 5: 1, 6: 0 });
      state[0] = 0;
      executeMonoflop(0, state, layout);
      expect(state[2]).toBe(0);
    });
  });

  describe("Q and ~Q complementary", () => {
    it("Q=1 → ~Q=0", () => {
      const layout = makeLayout(2, 2, 3);
      const state = makeState(7, { 0: 0, 1: 0, 4: 0, 5: 0, 6: 0 });
      state[0] = 1;
      executeMonoflop(0, state, layout);
      expect(state[2]).toBe(1);
      expect(state[3]).toBe(0);
    });

    it("Q=0 → ~Q=1", () => {
      const layout = makeLayout(2, 2, 3);
      const state = makeState(7, { 0: 0, 1: 0, 4: 0, 5: 0, 6: 0 });
      executeMonoflop(0, state, layout);
      expect(state[2]).toBe(0);
      expect(state[3]).toBe(1);
    });
  });

  describe("pin layout", () => {
    it("Monoflop has 2 inputs (C, R) and 2 outputs (Q, ~Q)", () => {
      const props = new PropertyBag();
      props.set("timerDelay", 1);
      const el = new MonoflopElement("id", { x: 0, y: 0 }, 0, false, props);
      const pins = el.getPins();
      const inputs = pins.filter(p => p.direction === PinDirection.INPUT);
      const outputs = pins.filter(p => p.direction === PinDirection.OUTPUT);
      expect(inputs).toHaveLength(2);
      expect(outputs).toHaveLength(2);
      expect(inputs.map(p => p.label)).toEqual(["C", "R"]);
      expect(outputs.map(p => p.label)).toEqual(["Q", "~Q"]);
    });

    it("C pin is marked as isClock=true", () => {
      const props = new PropertyBag();
      props.set("timerDelay", 1);
      const el = new MonoflopElement("id", { x: 0, y: 0 }, 0, false, props);
      const c = el.getPins().find(p => p.label === "C");
      expect(c?.isClock).toBe(true);
    });
  });

  describe("attribute mapping", () => {
    it("Delay maps to timerDelay as integer", () => {
      const mapping = MONOFLOP_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "Delay");
      expect(mapping).toBeDefined();
      expect(mapping!.propertyKey).toBe("timerDelay");
      expect(mapping!.convert("5")).toBe(5);
    });

    it("Label maps to label key", () => {
      const mapping = MONOFLOP_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "Label");
      expect(mapping).toBeDefined();
      expect(mapping!.convert("mono1")).toBe("mono1");
    });
  });

  describe("definitionComplete", () => {
    it("MonoflopDefinition has name='Monoflop'", () => {
      expect(MonoflopDefinition.name).toBe("Monoflop");
    });

    it("MonoflopDefinition has typeId=-1 sentinel", () => {
      expect(MonoflopDefinition.typeId).toBe(-1);
    });

    it("MonoflopDefinition category is FLIP_FLOPS", () => {
      expect(MonoflopDefinition.category).toBe(ComponentCategory.FLIP_FLOPS);
    });

    it("MonoflopDefinition has executeFn=executeMonoflop", () => {
      expect(MonoflopDefinition.executeFn).toBe(executeMonoflop);
    });

    it("MonoflopDefinition propertyDefs include timerDelay", () => {
      const keys = MonoflopDefinition.propertyDefs.map(d => d.key);
      expect(keys).toContain("timerDelay");
    });

    it("MonoflopDefinition has non-empty helpText", () => {
      expect(MonoflopDefinition.helpText.length).toBeGreaterThan(0);
    });

    it("MonoflopDefinition can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(MonoflopDefinition)).not.toThrow();
    });

    it("MonoflopDefinition factory produces a MonoflopElement", () => {
      const props = new PropertyBag();
      props.set("timerDelay", 2);
      const el = MonoflopDefinition.factory(props);
      expect(el.typeId).toBe("Monoflop");
    });
  });

  describe("rendering", () => {
    it("draw() calls drawRect for body", () => {
      const props = new PropertyBag();
      props.set("timerDelay", 1);
      const el = new MonoflopElement("id", { x: 0, y: 0 }, 0, false, props);
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const rects = calls.filter(c => c.method === "drawRect");
      expect(rects.length).toBeGreaterThanOrEqual(1);
    });

    it("draw() renders C and R labels", () => {
      const props = new PropertyBag();
      props.set("timerDelay", 1);
      const el = new MonoflopElement("id", { x: 0, y: 0 }, 0, false, props);
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const texts = calls.filter(c => c.method === "drawText").map(c => c.args[0]);
      expect(texts).toContain("C");
      expect(texts).toContain("R");
    });

    it("draw() renders component label when set", () => {
      const props = new PropertyBag();
      props.set("timerDelay", 1);
      props.set("label", "T1");
      const el = new MonoflopElement("id", { x: 0, y: 0 }, 0, false, props);
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const texts = calls.filter(c => c.method === "drawText").map(c => c.args[0]);
      expect(texts).toContain("T1");
    });
  });
});
