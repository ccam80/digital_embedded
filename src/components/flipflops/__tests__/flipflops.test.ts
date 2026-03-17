/**
 * Tests for all flip-flop components (Task 5.2.3).
 *
 * Covers per flip-flop:
 *   - Truth table on clock edge
 *   - State persistence between edges
 *   - Edge detection (only rising edge triggers)
 *   - Q and ~Q complementary outputs
 *   - Async set/clear (where applicable)
 *   - Pin layout correctness
 *   - Attribute mapping
 *   - ComponentDefinition completeness
 *   - Rendering (rect + labels)
 */

import { describe, it, expect } from "vitest";
import { DElement, sampleD, executeD, DDefinition, D_FF_ATTRIBUTE_MAPPINGS } from "../d.js";
import { DAsyncElement, executeDAsync, DAsyncDefinition } from "../d-async.js";
import { JKElement, sampleJK, executeJK, JKDefinition, JK_FF_ATTRIBUTE_MAPPINGS } from "../jk.js";
import { JKAsyncElement, executeJKAsync, JKAsyncDefinition } from "../jk-async.js";
import { RSElement, sampleRS, executeRS, RSDefinition, RS_FF_ATTRIBUTE_MAPPINGS } from "../rs.js";
import { RSAsyncElement, executeRSAsync, RSAsyncDefinition } from "../rs-async.js";
import { TElement, sampleT, executeT, TDefinition, T_FF_ATTRIBUTE_MAPPINGS } from "../t.js";
import { PropertyBag } from "../../../core/properties.js";
import { PinDirection } from "../../../core/pin.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import type { ComponentLayout } from "../../../core/registry.js";
import type { RenderContext, Point, TextAnchor, FontSpec, PathData } from "../../../core/renderer-interface.js";
import type { ThemeColor } from "../../../core/renderer-interface.js";

// ---------------------------------------------------------------------------
// Helpers — ComponentLayout mock with stateOffset support
// ---------------------------------------------------------------------------

interface LayoutWithState extends ComponentLayout {
  stateOffset(componentIndex: number): number;
}

/**
 * Build a layout for a component with given input/output/state counts.
 * Layout: [inputs..., outputs..., state...]
 */
function makeLayout(inputCount: number, outputCount: number, _stateCount: number): LayoutWithState {
  const inputStart = 0;
  const outputStart = inputCount;
  const stateStart = inputCount + outputCount;
  const totalSlots = inputCount + outputCount + _stateCount;
  const wiringTable = new Int32Array(totalSlots).map((_, i) => i);

  return {
    inputCount: () => inputCount,
    inputOffset: () => inputStart,
    outputCount: () => outputCount,
    outputOffset: () => outputStart,
    stateOffset: () => stateStart,
    wiringTable,
    getProperty: () => undefined,
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

// ---------------------------------------------------------------------------
// RenderContext mock
// ---------------------------------------------------------------------------

interface DrawCall {
  method: string;
  args: unknown[];
}

function makeStubCtx(): { ctx: RenderContext; calls: DrawCall[] } {
  const calls: DrawCall[] = [];
  const record = (method: string) => (...args: unknown[]): void => {
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
// D Flip-Flop tests
// ---------------------------------------------------------------------------

describe("FlipflopD", () => {
  const layout = makeLayout(2, 2, 2);
  // Slots: [D=0, C=1, Q=2, ~Q=3, storedQ=4, prevClock=5]

  describe("truth table on clock edge", () => {
    it("D=1 captured on rising clock edge → Q=1, ~Q=0", () => {
      const state = makeState(6, { 0: 1, 1: 0, 4: 0, 5: 0 });
      const highZs = new Uint32Array(state.length);
      state[1] = 1;
      sampleD(0, state, highZs, layout); executeD(0, state, highZs, layout);
      expect(state[2]).toBe(1);
      expect(state[3]).toBe(0);
    });

    it("D=0 captured on rising clock edge → Q=0, ~Q=1", () => {
      const state = makeState(6, { 0: 0, 1: 0, 4: 1, 5: 0 });
      const highZs = new Uint32Array(state.length);
      state[1] = 1;
      sampleD(0, state, highZs, layout); executeD(0, state, highZs, layout);
      expect(state[2]).toBe(0);
      expect(state[3]).toBe(1);
    });

    it("D=1 but no clock edge (clock stays high) → Q unchanged", () => {
      const state = makeState(6, { 0: 1, 1: 1, 4: 0, 5: 1 });
      const highZs = new Uint32Array(state.length);
      sampleD(0, state, highZs, layout); executeD(0, state, highZs, layout);
      expect(state[2]).toBe(0);
    });

    it("D=1 but falling edge (clock goes 1→0) → Q unchanged", () => {
      const state = makeState(6, { 0: 1, 1: 0, 4: 1, 5: 1 });
      const highZs = new Uint32Array(state.length);
      sampleD(0, state, highZs, layout); executeD(0, state, highZs, layout);
      expect(state[2]).toBe(1);
    });
  });

  describe("state persistence between edges", () => {
    it("stored value persists when clock is low", () => {
      const state = makeState(6, { 0: 0, 1: 0, 4: 1, 5: 0 });
      const highZs = new Uint32Array(state.length);
      state[1] = 1;
      sampleD(0, state, highZs, layout); executeD(0, state, highZs, layout);
      expect(state[2]).toBe(0);
      state[1] = 0;
      sampleD(0, state, highZs, layout); executeD(0, state, highZs, layout);
      expect(state[2]).toBe(0);
    });
  });

  describe("Q and ~Q complementary", () => {
    it("Q and ~Q are always complementary after clock edge", () => {
      const state = makeState(6, { 0: 1, 1: 0, 4: 0, 5: 0 });
      const highZs = new Uint32Array(state.length);
      state[1] = 1;
      sampleD(0, state, highZs, layout); executeD(0, state, highZs, layout);
      expect(state[2]).toBe(1);
      expect(state[3]).toBe(0);

      state[0] = 0;
      state[5] = 0;
      state[1] = 0;
      state[1] = 1;
      sampleD(0, state, highZs, layout); executeD(0, state, highZs, layout);
      expect(state[2]).toBe(0);
      expect(state[3]).toBe(1);
    });
  });

  describe("edge detection", () => {
    it("only rising edge (0→1) triggers capture", () => {
      const state = makeState(6, { 0: 1, 4: 0, 5: 0 });
      const highZs = new Uint32Array(state.length);
      state[1] = 0;
      sampleD(0, state, highZs, layout); executeD(0, state, highZs, layout);
      expect(state[2]).toBe(0);

      state[1] = 1;
      sampleD(0, state, highZs, layout); executeD(0, state, highZs, layout);
      expect(state[2]).toBe(1);

      state[0] = 0;
      sampleD(0, state, highZs, layout); executeD(0, state, highZs, layout);
      expect(state[2]).toBe(1);
    });
  });

  describe("pin layout", () => {
    it("D_FF has 2 input pins (D, C) and 2 output pins (Q, ~Q)", () => {
      const props = new PropertyBag();
      props.set("bitWidth", 1);
      const el = new DElement("id", { x: 0, y: 0 }, 0, false, props);
      const pins = el.getPins();
      const inputs = pins.filter(p => p.direction === PinDirection.INPUT);
      const outputs = pins.filter(p => p.direction === PinDirection.OUTPUT);
      expect(inputs).toHaveLength(2);
      expect(outputs).toHaveLength(2);
      expect(inputs.map(p => p.label)).toEqual(["D", "C"]);
      expect(outputs.map(p => p.label)).toEqual(["Q", "~Q"]);
    });

    it("C pin is marked as isClock=true", () => {
      const props = new PropertyBag();
      props.set("bitWidth", 1);
      const el = new DElement("id", { x: 0, y: 0 }, 0, false, props);
      const c = el.getPins().find(p => p.label === "C");
      expect(c?.isClock).toBe(true);
    });
  });

  describe("attribute mapping", () => {
    it("Bits=8 maps to bitWidth=8", () => {
      const mapping = D_FF_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "Bits");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.convert("8")).toBe(8);
    });

    it("Label maps to label key", () => {
      const mapping = D_FF_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "Label");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("label");
    });
  });

  describe("rendering", () => {
    it("draw() calls drawPolygon for the component body", () => {
      const props = new PropertyBag();
      props.set("bitWidth", 1);
      const el = new DElement("id", { x: 0, y: 0 }, 0, false, props);
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const rects = calls.filter(c => c.method === "drawPolygon");
      expect(rects.length).toBeGreaterThanOrEqual(1);
    });

    it("draw() renders D and C text labels", () => {
      const props = new PropertyBag();
      props.set("bitWidth", 1);
      const el = new DElement("id", { x: 0, y: 0 }, 0, false, props);
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const texts = calls.filter(c => c.method === "drawText").map(c => c.args[0]);
      expect(texts).toContain("D");
      expect(texts).toContain("C");
    });
  });

  describe("definitionComplete", () => {
    it("DDefinition has name='D_FF'", () => {
      expect(DDefinition.name).toBe("D_FF");
    });

    it("DDefinition has typeId=-1 sentinel", () => {
      expect(DDefinition.typeId).toBe(-1);
    });

    it("DDefinition category is FLIP_FLOPS", () => {
      expect(DDefinition.category).toBe(ComponentCategory.FLIP_FLOPS);
    });

    it("DDefinition has executeFn=executeD", () => {
      expect(DDefinition.executeFn).toBe(executeD);
    });

    it("DDefinition can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(DDefinition)).not.toThrow();
    });

    it("DDefinition.helpText is non-empty", () => {
      expect(typeof DDefinition.helpText).toBe("string"); expect(DDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });
  });
});

// ---------------------------------------------------------------------------
// D Flip-Flop Async tests
// ---------------------------------------------------------------------------

describe("FlipflopDAsync", () => {
  const layout = makeLayout(4, 2, 2);
  // Slots: [Set=0, D=1, C=2, Clr=3, Q=4, ~Q=5, storedQ=6, prevClock=7]

  describe("truth table on clock edge", () => {
    it("D=1 captured on rising clock edge when Set=0 Clr=0", () => {
      const state = makeState(8, { 0: 0, 1: 1, 2: 0, 3: 0, 6: 0, 7: 0 });
      const highZs = new Uint32Array(state.length);
      state[2] = 1;
      executeDAsync(0, state, highZs, layout);
      expect(state[4]).toBe(1);
    });

    it("D=0 captured on rising clock edge when Set=0 Clr=0", () => {
      const state = makeState(8, { 0: 0, 1: 0, 2: 0, 3: 0, 6: 1, 7: 0 });
      const highZs = new Uint32Array(state.length);
      state[2] = 1;
      executeDAsync(0, state, highZs, layout);
      expect(state[4]).toBe(0);
    });
  });

  describe("async set", () => {
    it("Set=1 forces Q=all-ones regardless of clock", () => {
      const state = makeState(8, { 0: 1, 1: 0, 2: 0, 3: 0, 6: 0, 7: 0 });
      const highZs = new Uint32Array(state.length);
      executeDAsync(0, state, highZs, layout);
      // bitWidth defaults to 1 (no getProperty), so Set=1 → Q=1, ~Q=0
      expect(state[4]).toBe(1);
      expect(state[5]).toBe(0);
    });

    it("Set=1 overrides D=0 on clock edge", () => {
      const state = makeState(8, { 0: 1, 1: 0, 2: 0, 3: 0, 6: 0, 7: 0 });
      const highZs = new Uint32Array(state.length);
      state[2] = 1;
      executeDAsync(0, state, highZs, layout);
      expect(state[4]).toBe(1);
    });
  });

  describe("async clear", () => {
    it("Clr=1 forces Q=0 regardless of clock", () => {
      const state = makeState(8, { 0: 0, 1: 1, 2: 0, 3: 1, 6: 1, 7: 0 });
      const highZs = new Uint32Array(state.length);
      executeDAsync(0, state, highZs, layout);
      expect(state[4]).toBe(0);
      expect(state[5]).toBe(1);
    });
  });

  describe("pin layout", () => {
    it("D_FF_AS has 4 inputs (Set, D, C, Clr) and 2 outputs (Q, ~Q)", () => {
      const props = new PropertyBag();
      props.set("bitWidth", 1);
      const el = new DAsyncElement("id", { x: 0, y: 0 }, 0, false, props);
      const pins = el.getPins();
      const inputs = pins.filter(p => p.direction === PinDirection.INPUT);
      const outputs = pins.filter(p => p.direction === PinDirection.OUTPUT);
      expect(inputs).toHaveLength(4);
      expect(outputs).toHaveLength(2);
      expect(inputs.map(p => p.label)).toEqual(["Set", "D", "C", "Clr"]);
    });
  });

  describe("definitionComplete", () => {
    it("DAsyncDefinition has name='D_FF_AS'", () => {
      expect(DAsyncDefinition.name).toBe("D_FF_AS");
    });

    it("DAsyncDefinition category is FLIP_FLOPS", () => {
      expect(DAsyncDefinition.category).toBe(ComponentCategory.FLIP_FLOPS);
    });

    it("DAsyncDefinition has executeFn=executeDAsync", () => {
      expect(DAsyncDefinition.executeFn).toBe(executeDAsync);
    });

    it("DAsyncDefinition can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(DAsyncDefinition)).not.toThrow();
    });
  });

  describe("rendering", () => {
    it("draw() calls drawPolygon and contains label texts", () => {
      const props = new PropertyBag();
      props.set("bitWidth", 1);
      const el = new DAsyncElement("id", { x: 0, y: 0 }, 0, false, props);
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const rects = calls.filter(c => c.method === "drawPolygon");
      expect(rects.length).toBeGreaterThanOrEqual(1);
      const texts = calls.filter(c => c.method === "drawText").map(c => c.args[0]);
      expect(texts).toContain("Set");
      expect(texts).toContain("Clr");
    });
  });
});

// ---------------------------------------------------------------------------
// JK Flip-Flop tests
// ---------------------------------------------------------------------------

describe("FlipflopJK", () => {
  const layout = makeLayout(3, 2, 2);
  // Slots: [J=0, C=1, K=2, Q=3, ~Q=4, storedQ=5, prevClock=6]

  describe("truth table on clock edge", () => {
    it("J=1 K=0 → set (Q=1)", () => {
      const state = makeState(7, { 0: 1, 1: 0, 2: 0, 5: 0, 6: 0 });
      const highZs = new Uint32Array(state.length);
      state[1] = 1;
      sampleJK(0, state, highZs, layout); executeJK(0, state, highZs, layout);
      expect(state[3]).toBe(1);
      expect(state[4]).toBe(0);
    });

    it("J=0 K=1 → reset (Q=0)", () => {
      const state = makeState(7, { 0: 0, 1: 0, 2: 1, 5: 1, 6: 0 });
      const highZs = new Uint32Array(state.length);
      state[1] = 1;
      sampleJK(0, state, highZs, layout); executeJK(0, state, highZs, layout);
      expect(state[3]).toBe(0);
      expect(state[4]).toBe(1);
    });

    it("J=1 K=1 → toggle (Q was 0, becomes 1)", () => {
      const state = makeState(7, { 0: 1, 1: 0, 2: 1, 5: 0, 6: 0 });
      const highZs = new Uint32Array(state.length);
      state[1] = 1;
      sampleJK(0, state, highZs, layout); executeJK(0, state, highZs, layout);
      expect(state[3]).toBe(1);
    });

    it("J=1 K=1 → toggle (Q was 1, becomes 0)", () => {
      const state = makeState(7, { 0: 1, 1: 0, 2: 1, 5: 1, 6: 0 });
      const highZs = new Uint32Array(state.length);
      state[1] = 1;
      sampleJK(0, state, highZs, layout); executeJK(0, state, highZs, layout);
      expect(state[3]).toBe(0);
    });

    it("J=0 K=0 → hold (Q unchanged)", () => {
      const state = makeState(7, { 0: 0, 1: 0, 2: 0, 5: 1, 6: 0 });
      const highZs = new Uint32Array(state.length);
      state[1] = 1;
      sampleJK(0, state, highZs, layout); executeJK(0, state, highZs, layout);
      expect(state[3]).toBe(1);
    });
  });

  describe("edge detection", () => {
    it("no update on falling edge (1→0)", () => {
      const state = makeState(7, { 0: 1, 1: 1, 2: 0, 5: 0, 6: 1 });
      const highZs = new Uint32Array(state.length);
      state[1] = 0;
      sampleJK(0, state, highZs, layout); executeJK(0, state, highZs, layout);
      expect(state[3]).toBe(0);
    });

    it("no update when clock stays high", () => {
      const state = makeState(7, { 0: 1, 1: 1, 2: 0, 5: 0, 6: 1 });
      const highZs = new Uint32Array(state.length);
      sampleJK(0, state, highZs, layout); executeJK(0, state, highZs, layout);
      expect(state[3]).toBe(0);
    });
  });

  describe("Q and ~Q complementary", () => {
    it("after set: Q=1 and ~Q=0", () => {
      const state = makeState(7, { 0: 1, 1: 0, 2: 0, 5: 0, 6: 0 });
      const highZs = new Uint32Array(state.length);
      state[1] = 1;
      sampleJK(0, state, highZs, layout); executeJK(0, state, highZs, layout);
      expect(state[3]).toBe(1);
      expect(state[4]).toBe(0);
    });

    it("after reset: Q=0 and ~Q=1", () => {
      const state = makeState(7, { 0: 0, 1: 0, 2: 1, 5: 1, 6: 0 });
      const highZs = new Uint32Array(state.length);
      state[1] = 1;
      sampleJK(0, state, highZs, layout); executeJK(0, state, highZs, layout);
      expect(state[3]).toBe(0);
      expect(state[4]).toBe(1);
    });
  });

  describe("pin layout", () => {
    it("JK_FF has 3 inputs (J, C, K) and 2 outputs (Q, ~Q)", () => {
      const el = new JKElement("id", { x: 0, y: 0 }, 0, false, new PropertyBag());
      const pins = el.getPins();
      const inputs = pins.filter(p => p.direction === PinDirection.INPUT);
      const outputs = pins.filter(p => p.direction === PinDirection.OUTPUT);
      expect(inputs).toHaveLength(3);
      expect(outputs).toHaveLength(2);
      expect(inputs.map(p => p.label)).toEqual(["J", "C", "K"]);
    });
  });

  describe("attribute mapping", () => {
    it("Label maps to label key", () => {
      const mapping = JK_FF_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "Label");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.convert("myFF")).toBe("myFF");
    });
  });

  describe("definitionComplete", () => {
    it("JKDefinition has name='JK_FF'", () => {
      expect(JKDefinition.name).toBe("JK_FF");
    });

    it("JKDefinition category is FLIP_FLOPS", () => {
      expect(JKDefinition.category).toBe(ComponentCategory.FLIP_FLOPS);
    });

    it("JKDefinition has executeFn=executeJK", () => {
      expect(JKDefinition.executeFn).toBe(executeJK);
    });

    it("JKDefinition can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(JKDefinition)).not.toThrow();
    });
  });

  describe("rendering", () => {
    it("draw() renders polygon body and J/K/C labels", () => {
      const el = new JKElement("id", { x: 0, y: 0 }, 0, false, new PropertyBag());
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const rects = calls.filter(c => c.method === "drawPolygon");
      expect(rects.length).toBeGreaterThanOrEqual(1);
      const texts = calls.filter(c => c.method === "drawText").map(c => c.args[0]);
      expect(texts).toContain("J");
      expect(texts).toContain("K");
    });
  });
});

// ---------------------------------------------------------------------------
// JK Flip-Flop Async tests
// ---------------------------------------------------------------------------

describe("FlipflopJKAsync", () => {
  const layout = makeLayout(5, 2, 2);
  // Slots: [Set=0, J=1, C=2, K=3, Clr=4, Q=5, ~Q=6, storedQ=7, prevClock=8]

  describe("truth table on clock edge", () => {
    it("J=1 K=0 → set when Set=0 Clr=0", () => {
      const state = makeState(9, { 0: 0, 1: 1, 2: 0, 3: 0, 4: 0, 7: 0, 8: 0 });
      const highZs = new Uint32Array(state.length);
      state[2] = 1;
      executeJKAsync(0, state, highZs, layout);
      expect(state[5]).toBe(1);
    });

    it("J=0 K=1 → reset when Set=0 Clr=0", () => {
      const state = makeState(9, { 0: 0, 1: 0, 2: 0, 3: 1, 4: 0, 7: 1, 8: 0 });
      const highZs = new Uint32Array(state.length);
      state[2] = 1;
      executeJKAsync(0, state, highZs, layout);
      expect(state[5]).toBe(0);
    });

    it("J=1 K=1 → toggle when Set=0 Clr=0", () => {
      const state = makeState(9, { 0: 0, 1: 1, 2: 0, 3: 1, 4: 0, 7: 0, 8: 0 });
      const highZs = new Uint32Array(state.length);
      state[2] = 1;
      executeJKAsync(0, state, highZs, layout);
      expect(state[5]).toBe(1);
    });
  });

  describe("async set", () => {
    it("Set=1 forces Q=1 regardless of clock", () => {
      const state = makeState(9, { 0: 1, 1: 0, 2: 0, 3: 0, 4: 0, 7: 0, 8: 0 });
      const highZs = new Uint32Array(state.length);
      executeJKAsync(0, state, highZs, layout);
      expect(state[5]).toBe(1);
      expect(state[6]).toBe(0);
    });
  });

  describe("async clear", () => {
    it("Clr=1 forces Q=0 regardless of clock", () => {
      const state = makeState(9, { 0: 0, 1: 0, 2: 0, 3: 0, 4: 1, 7: 1, 8: 0 });
      const highZs = new Uint32Array(state.length);
      executeJKAsync(0, state, highZs, layout);
      expect(state[5]).toBe(0);
      expect(state[6]).toBe(1);
    });
  });

  describe("pin layout", () => {
    it("JK_FF_AS has 5 inputs and 2 outputs", () => {
      const el = new JKAsyncElement("id", { x: 0, y: 0 }, 0, false, new PropertyBag());
      const pins = el.getPins();
      const inputs = pins.filter(p => p.direction === PinDirection.INPUT);
      const outputs = pins.filter(p => p.direction === PinDirection.OUTPUT);
      expect(inputs).toHaveLength(5);
      expect(outputs).toHaveLength(2);
      expect(inputs.map(p => p.label)).toEqual(["Set", "J", "C", "K", "Clr"]);
    });
  });

  describe("definitionComplete", () => {
    it("JKAsyncDefinition has name='JK_FF_AS'", () => {
      expect(JKAsyncDefinition.name).toBe("JK_FF_AS");
    });

    it("JKAsyncDefinition can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(JKAsyncDefinition)).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// RS Flip-Flop tests
// ---------------------------------------------------------------------------

describe("FlipflopRS", () => {
  const layout = makeLayout(3, 2, 2);
  // Slots: [S=0, C=1, R=2, Q=3, ~Q=4, storedQ=5, prevClock=6]

  describe("truth table on clock edge", () => {
    it("S=1 R=0 → set (Q=1)", () => {
      const state = makeState(7, { 0: 1, 1: 0, 2: 0, 5: 0, 6: 0 });
      const highZs = new Uint32Array(state.length);
      state[1] = 1;
      sampleRS(0, state, highZs, layout); executeRS(0, state, highZs, layout);
      expect(state[3]).toBe(1);
      expect(state[4]).toBe(0);
    });

    it("S=0 R=1 → reset (Q=0)", () => {
      const state = makeState(7, { 0: 0, 1: 0, 2: 1, 5: 1, 6: 0 });
      const highZs = new Uint32Array(state.length);
      state[1] = 1;
      sampleRS(0, state, highZs, layout); executeRS(0, state, highZs, layout);
      expect(state[3]).toBe(0);
      expect(state[4]).toBe(1);
    });

    it("S=0 R=0 → hold Q unchanged", () => {
      const state = makeState(7, { 0: 0, 1: 0, 2: 0, 5: 1, 6: 0 });
      const highZs = new Uint32Array(state.length);
      state[1] = 1;
      sampleRS(0, state, highZs, layout); executeRS(0, state, highZs, layout);
      expect(state[3]).toBe(1);
    });

    it("S=1 R=1 → hold (undefined state treated as hold)", () => {
      const state = makeState(7, { 0: 1, 1: 0, 2: 1, 5: 0, 6: 0 });
      const highZs = new Uint32Array(state.length);
      state[1] = 1;
      sampleRS(0, state, highZs, layout); executeRS(0, state, highZs, layout);
      expect(state[3]).toBe(0);
    });
  });

  describe("edge detection", () => {
    it("no update on falling clock edge", () => {
      const state = makeState(7, { 0: 1, 1: 1, 2: 0, 5: 0, 6: 1 });
      const highZs = new Uint32Array(state.length);
      state[1] = 0;
      sampleRS(0, state, highZs, layout); executeRS(0, state, highZs, layout);
      expect(state[3]).toBe(0);
    });
  });

  describe("Q and ~Q complementary", () => {
    it("Q and ~Q are complementary after set", () => {
      const state = makeState(7, { 0: 1, 1: 0, 2: 0, 5: 0, 6: 0 });
      const highZs = new Uint32Array(state.length);
      state[1] = 1;
      sampleRS(0, state, highZs, layout); executeRS(0, state, highZs, layout);
      expect(state[3]).toBe(1);
      expect(state[4]).toBe(0);
    });
  });

  describe("state persistence", () => {
    it("Q persists after clock returns low", () => {
      const state = makeState(7, { 0: 1, 1: 0, 2: 0, 5: 0, 6: 0 });
      const highZs = new Uint32Array(state.length);
      state[1] = 1;
      sampleRS(0, state, highZs, layout); executeRS(0, state, highZs, layout);
      state[0] = 0;
      state[1] = 0;
      sampleRS(0, state, highZs, layout); executeRS(0, state, highZs, layout);
      expect(state[3]).toBe(1);
    });
  });

  describe("pin layout", () => {
    it("RS_FF has 3 inputs (S, C, R) and 2 outputs (Q, ~Q)", () => {
      const el = new RSElement("id", { x: 0, y: 0 }, 0, false, new PropertyBag());
      const pins = el.getPins();
      const inputs = pins.filter(p => p.direction === PinDirection.INPUT);
      const outputs = pins.filter(p => p.direction === PinDirection.OUTPUT);
      expect(inputs).toHaveLength(3);
      expect(outputs).toHaveLength(2);
      expect(inputs.map(p => p.label)).toEqual(["S", "C", "R"]);
    });
  });

  describe("attribute mapping", () => {
    it("RS_FF_ATTRIBUTE_MAPPINGS covers Label", () => {
      const xmlNames = RS_FF_ATTRIBUTE_MAPPINGS.map(m => m.xmlName);
      expect(xmlNames).toContain("Label");
    });
  });

  describe("definitionComplete", () => {
    it("RSDefinition has name='RS_FF'", () => {
      expect(RSDefinition.name).toBe("RS_FF");
    });

    it("RSDefinition category is FLIP_FLOPS", () => {
      expect(RSDefinition.category).toBe(ComponentCategory.FLIP_FLOPS);
    });

    it("RSDefinition has executeFn=executeRS", () => {
      expect(RSDefinition.executeFn).toBe(executeRS);
    });

    it("RSDefinition can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(RSDefinition)).not.toThrow();
    });
  });

  describe("rendering", () => {
    it("draw() renders polygon and S/R/C labels", () => {
      const el = new RSElement("id", { x: 0, y: 0 }, 0, false, new PropertyBag());
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const rects = calls.filter(c => c.method === "drawPolygon");
      expect(rects.length).toBeGreaterThanOrEqual(1);
      const texts = calls.filter(c => c.method === "drawText").map(c => c.args[0]);
      expect(texts).toContain("S");
      expect(texts).toContain("R");
    });
  });
});

// ---------------------------------------------------------------------------
// RS Flip-Flop Async (SR Latch) tests
// ---------------------------------------------------------------------------

describe("FlipflopRSAsync", () => {
  const layout = makeLayout(2, 2, 2);
  // Slots: [S=0, R=1, Q=2, ~Q=3, storedQ=4, storedQn=5]

  describe("truth table (level-sensitive)", () => {
    it("S=1 R=0 → Q=1, ~Q=0", () => {
      const state = makeState(6, { 0: 1, 1: 0, 4: 0, 5: 1 });
      const highZs = new Uint32Array(state.length);
      executeRSAsync(0, state, highZs, layout);
      expect(state[2]).toBe(1);
      expect(state[3]).toBe(0);
    });

    it("S=0 R=1 → Q=0, ~Q=1", () => {
      const state = makeState(6, { 0: 0, 1: 1, 4: 1, 5: 0 });
      const highZs = new Uint32Array(state.length);
      executeRSAsync(0, state, highZs, layout);
      expect(state[2]).toBe(0);
      expect(state[3]).toBe(1);
    });

    it("S=0 R=0 → holds current state (Q=1 stays Q=1)", () => {
      const state = makeState(6, { 0: 0, 1: 0, 4: 1, 5: 0 });
      const highZs = new Uint32Array(state.length);
      executeRSAsync(0, state, highZs, layout);
      expect(state[2]).toBe(1);
      expect(state[3]).toBe(0);
    });

    it("S=0 R=0 → holds current state (Q=0 stays Q=0)", () => {
      const state = makeState(6, { 0: 0, 1: 0, 4: 0, 5: 1 });
      const highZs = new Uint32Array(state.length);
      executeRSAsync(0, state, highZs, layout);
      expect(state[2]).toBe(0);
      expect(state[3]).toBe(1);
    });

    it("S=1 R=1 → forbidden state: Q=0, ~Q=0", () => {
      const state = makeState(6, { 0: 1, 1: 1, 4: 1, 5: 0 });
      const highZs = new Uint32Array(state.length);
      executeRSAsync(0, state, highZs, layout);
      expect(state[2]).toBe(0);
      expect(state[3]).toBe(0);
    });
  });

  describe("no clock needed — level sensitive", () => {
    it("changes propagate immediately without clock", () => {
      const state = makeState(6, { 0: 0, 1: 0, 4: 0, 5: 1 });
      const highZs = new Uint32Array(state.length);
      state[0] = 1;
      executeRSAsync(0, state, highZs, layout);
      expect(state[2]).toBe(1);
    });
  });

  describe("pin layout", () => {
    it("RS_FF_AS has 2 inputs (S, R) and 2 outputs (Q, ~Q)", () => {
      const el = new RSAsyncElement("id", { x: 0, y: 0 }, 0, false, new PropertyBag());
      const pins = el.getPins();
      const inputs = pins.filter(p => p.direction === PinDirection.INPUT);
      const outputs = pins.filter(p => p.direction === PinDirection.OUTPUT);
      expect(inputs).toHaveLength(2);
      expect(outputs).toHaveLength(2);
      expect(inputs.map(p => p.label)).toEqual(["S", "R"]);
    });

    it("RS_FF_AS has no clock pin", () => {
      const el = new RSAsyncElement("id", { x: 0, y: 0 }, 0, false, new PropertyBag());
      const pins = el.getPins();
      expect(pins.some(p => p.isClock)).toBe(false);
    });
  });

  describe("definitionComplete", () => {
    it("RSAsyncDefinition has name='RS_FF_AS'", () => {
      expect(RSAsyncDefinition.name).toBe("RS_FF_AS");
    });

    it("RSAsyncDefinition category is FLIP_FLOPS", () => {
      expect(RSAsyncDefinition.category).toBe(ComponentCategory.FLIP_FLOPS);
    });

    it("RSAsyncDefinition has executeFn=executeRSAsync", () => {
      expect(RSAsyncDefinition.executeFn).toBe(executeRSAsync);
    });

    it("RSAsyncDefinition can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(RSAsyncDefinition)).not.toThrow();
    });
  });

  describe("rendering", () => {
    it("draw() renders polygon and S/R labels", () => {
      const el = new RSAsyncElement("id", { x: 0, y: 0 }, 0, false, new PropertyBag());
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const rects = calls.filter(c => c.method === "drawPolygon");
      expect(rects.length).toBeGreaterThanOrEqual(1);
      const texts = calls.filter(c => c.method === "drawText").map(c => c.args[0]);
      expect(texts).toContain("S");
      expect(texts).toContain("R");
    });
  });
});

// ---------------------------------------------------------------------------
// T Flip-Flop tests
// ---------------------------------------------------------------------------

describe("FlipflopT", () => {
  describe("without enable (always toggle)", () => {
    const layout = makeLayout(1, 2, 2);
    // Slots: [C=0, Q=1, ~Q=2, storedQ=3, prevClock=4]

    it("toggles Q from 0 to 1 on rising clock edge", () => {
      const state = makeState(5, { 0: 0, 3: 0, 4: 0 });
      const highZs = new Uint32Array(state.length);
      state[0] = 1;
      sampleT(0, state, highZs, layout); executeT(0, state, highZs, layout);
      expect(state[1]).toBe(1);
      expect(state[2]).toBe(0);
    });

    it("toggles Q from 1 to 0 on second rising clock edge", () => {
      const state = makeState(5, { 0: 0, 3: 1, 4: 0 });
      const highZs = new Uint32Array(state.length);
      state[0] = 1;
      sampleT(0, state, highZs, layout); executeT(0, state, highZs, layout);
      expect(state[1]).toBe(0);
      expect(state[2]).toBe(1);
    });

    it("no toggle on falling edge", () => {
      const state = makeState(5, { 0: 1, 3: 0, 4: 1 });
      const highZs = new Uint32Array(state.length);
      state[0] = 0;
      sampleT(0, state, highZs, layout); executeT(0, state, highZs, layout);
      expect(state[1]).toBe(0);
    });

    it("no toggle when clock stays high (no second rising edge)", () => {
      const state = makeState(5, { 0: 1, 3: 0, 4: 1 });
      const highZs = new Uint32Array(state.length);
      sampleT(0, state, highZs, layout); executeT(0, state, highZs, layout);
      expect(state[1]).toBe(0);
    });
  });

  describe("with enable (T input)", () => {
    const layout = makeLayout(2, 2, 2);
    // Slots: [T=0, C=1, Q=2, ~Q=3, storedQ=4, prevClock=5]

    it("T=1: toggles Q on rising clock edge", () => {
      const state = makeState(6, { 0: 1, 1: 0, 4: 0, 5: 0 });
      const highZs = new Uint32Array(state.length);
      state[1] = 1;
      sampleT(0, state, highZs, layout); executeT(0, state, highZs, layout);
      expect(state[2]).toBe(1);
    });

    it("T=0: holds Q on rising clock edge", () => {
      const state = makeState(6, { 0: 0, 1: 0, 4: 1, 5: 0 });
      const highZs = new Uint32Array(state.length);
      state[1] = 1;
      sampleT(0, state, highZs, layout); executeT(0, state, highZs, layout);
      expect(state[2]).toBe(1);
    });

    it("T=1 multiple toggles", () => {
      const state = makeState(6, { 0: 1, 1: 0, 4: 0, 5: 0 });
      const highZs = new Uint32Array(state.length);
      state[1] = 1;
      sampleT(0, state, highZs, layout); executeT(0, state, highZs, layout);
      expect(state[2]).toBe(1);

      state[5] = 0;
      state[1] = 0;
      state[1] = 1;
      sampleT(0, state, highZs, layout); executeT(0, state, highZs, layout);
      expect(state[2]).toBe(0);
    });
  });

  describe("Q and ~Q complementary", () => {
    const layout = makeLayout(1, 2, 2);

    it("Q and ~Q are always complementary", () => {
      const state = makeState(5, { 0: 0, 3: 0, 4: 0 });
      const highZs = new Uint32Array(state.length);
      state[0] = 1;
      sampleT(0, state, highZs, layout); executeT(0, state, highZs, layout);
      expect(state[1] + state[2]).toBe(1);

      state[4] = 0;
      state[0] = 0;
      state[0] = 1;
      sampleT(0, state, highZs, layout); executeT(0, state, highZs, layout);
      expect(state[1] + state[2]).toBe(1);
    });
  });

  describe("pin layout (without enable)", () => {
    it("T_FF (no enable) has 1 input (C) and 2 outputs (Q, ~Q)", () => {
      const props = new PropertyBag();
      props.set("withEnable", false);
      const el = new TElement("id", { x: 0, y: 0 }, 0, false, props);
      const pins = el.getPins();
      const inputs = pins.filter(p => p.direction === PinDirection.INPUT);
      const outputs = pins.filter(p => p.direction === PinDirection.OUTPUT);
      expect(inputs).toHaveLength(1);
      expect(outputs).toHaveLength(2);
      expect(inputs[0].label).toBe("C");
    });
  });

  describe("pin layout (with enable)", () => {
    it("T_FF (with enable) has 2 inputs (T, C) and 2 outputs", () => {
      const props = new PropertyBag();
      props.set("withEnable", true);
      const el = new TElement("id", { x: 0, y: 0 }, 0, false, props);
      const pins = el.getPins();
      const inputs = pins.filter(p => p.direction === PinDirection.INPUT);
      const outputs = pins.filter(p => p.direction === PinDirection.OUTPUT);
      expect(inputs).toHaveLength(2);
      expect(outputs).toHaveLength(2);
      expect(inputs.map(p => p.label)).toEqual(["T", "C"]);
    });
  });

  describe("attribute mapping", () => {
    it("withEnable=true maps to boolean true", () => {
      const mapping = T_FF_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "withEnable");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.convert("true")).toBe(true);
      expect(mapping!.convert("false")).toBe(false);
    });

    it("T_FF_ATTRIBUTE_MAPPINGS covers Label", () => {
      const xmlNames = T_FF_ATTRIBUTE_MAPPINGS.map(m => m.xmlName);
      expect(xmlNames).toContain("Label");
    });
  });

  describe("definitionComplete", () => {
    it("TDefinition has name='T_FF'", () => {
      expect(TDefinition.name).toBe("T_FF");
    });

    it("TDefinition category is FLIP_FLOPS", () => {
      expect(TDefinition.category).toBe(ComponentCategory.FLIP_FLOPS);
    });

    it("TDefinition has executeFn=executeT", () => {
      expect(TDefinition.executeFn).toBe(executeT);
    });

    it("TDefinition can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(TDefinition)).not.toThrow();
    });

    it("TDefinition propertyDefs include withEnable", () => {
      const keys = TDefinition.propertyDefs.map(d => d.key);
      expect(keys).toContain("withEnable");
    });
  });

  describe("rendering", () => {
    it("draw() renders polygon body", () => {
      const props = new PropertyBag();
      props.set("withEnable", false);
      const el = new TElement("id", { x: 0, y: 0 }, 0, false, props);
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const rects = calls.filter(c => c.method === "drawPolygon");
      expect(rects.length).toBeGreaterThanOrEqual(1);
    });

    it("draw() renders C label", () => {
      const props = new PropertyBag();
      props.set("withEnable", false);
      const el = new TElement("id", { x: 0, y: 0 }, 0, false, props);
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const texts = calls.filter(c => c.method === "drawText").map(c => c.args[0]);
      expect(texts).toContain("C");
    });
  });
});
