/**
 * Tests for simulation control components: Delay, Break, Stop, Reset, AsyncSeq.
 *
 * Covers per component:
 *   - execute*: correct behavior (pass-through, assertion detection, flag propagation)
 *   - Pin layout: correct structure
 *   - Attribute mapping
 *   - Rendering
 *   - ComponentDefinition completeness
 */

import { describe, it, expect } from "vitest";
import {
  DelayElement,
  executeDelay,
  DelayDefinition,
  DELAY_ATTRIBUTE_MAPPINGS,
  buildDelayPinDeclarations,
} from "../delay.js";
import {
  BreakElement,
  executeBreak,
  BreakDefinition,
  BREAK_ATTRIBUTE_MAPPINGS,
  buildBreakPinDeclarations,
} from "../break.js";
import {
  StopElement,
  executeStop,
  StopDefinition,
  STOP_ATTRIBUTE_MAPPINGS,
  buildStopPinDeclarations,
} from "../stop.js";
import {
  ResetElement,
  executeReset,
  ResetDefinition,
  RESET_ATTRIBUTE_MAPPINGS,
  buildResetPinDeclarations,
} from "../reset.js";
import {
  AsyncSeqElement,
  executeAsyncSeq,
  AsyncSeqDefinition,
  ASYNC_SEQ_ATTRIBUTE_MAPPINGS,
  buildAsyncSeqPinDeclarations,
} from "../async-seq.js";
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
  };
}

function makeState(values: number[]): Uint32Array {
  const arr = new Uint32Array(values.length + 4);
  for (let i = 0; i < values.length; i++) {
    arr[i] = values[i] >>> 0;
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

// ---------------------------------------------------------------------------
// Delay
// ---------------------------------------------------------------------------

describe("Delay", () => {
  describe("passThrough", () => {
    it("input=0xABCD passes through to output", () => {
      // inputs: [in=0xABCD]; output: [out]
      const layout = makeLayout(1, 1);
      const state = makeState([0xABCD]);
      const highZs = new Uint32Array(state.length);
      executeDelay(0, state, highZs, layout);
      expect(state[1]).toBe(0xABCD);
    });

    it("input=0 produces output=0", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([0]);
      const highZs = new Uint32Array(state.length);
      executeDelay(0, state, highZs, layout);
      expect(state[1]).toBe(0);
    });

    it("input=0xFFFFFFFF passes through as unsigned 32-bit", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([0xFFFFFFFF]);
      const highZs = new Uint32Array(state.length);
      executeDelay(0, state, highZs, layout);
      expect(state[1]).toBe(0xFFFFFFFF);
    });

    it("pass-through is idempotent (repeated calls)", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([0x1234]);
      const highZs = new Uint32Array(state.length);
      for (let i = 0; i < 100; i++) {
        state[0] = (i * 31) & 0xFFFF;
        executeDelay(0, state, highZs, layout);
        expect(state[1]).toBe(state[0]);
      }
    });
  });

  describe("pinLayout", () => {
    it("Delay has 1 input pin and 1 output pin", () => {
      const props = new PropertyBag();
      props.set("bitWidth", 1);
      props.set("delayTime", 1);
      const el = new DelayElement("test", { x: 0, y: 0 }, 0, false, props);
      const pins = el.getPins();
      expect(pins.filter((p) => p.direction === PinDirection.INPUT)).toHaveLength(1);
      expect(pins.filter((p) => p.direction === PinDirection.OUTPUT)).toHaveLength(1);
    });

    it("input pin labeled 'in', output pin labeled 'out'", () => {
      const decls = buildDelayPinDeclarations(1);
      expect(decls.find((d) => d.label === "in")).toBeDefined();
      expect(decls.find((d) => d.label === "out")).toBeDefined();
    });
  });

  describe("attributeMapping", () => {
    it("Bits and DelayTime map correctly", () => {
      const entries: Record<string, string> = { Bits: "8", DelayTime: "4" };
      const bag = new PropertyBag();
      for (const m of DELAY_ATTRIBUTE_MAPPINGS) {
        if (entries[m.xmlName] !== undefined) {
          bag.set(m.propertyKey, m.convert(entries[m.xmlName]));
        }
      }
      expect(bag.get<number>("bitWidth")).toBe(8);
      expect(bag.get<number>("delayTime")).toBe(4);
    });
  });

  describe("draw", () => {
    it("draw() calls drawRect", () => {
      const props = new PropertyBag();
      props.set("bitWidth", 1);
      props.set("delayTime", 3);
      const el = new DelayElement("test", { x: 0, y: 0 }, 0, false, props);
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.filter((c) => c.method === "drawRect").length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("definitionComplete", () => {
    it("DelayDefinition has name='Delay'", () => {
      expect(DelayDefinition.name).toBe("Delay");
    });

    it("DelayDefinition has typeId=-1 (sentinel)", () => {
      expect(DelayDefinition.typeId).toBe(-1);
    });

    it("DelayDefinition has executeFn=executeDelay", () => {
      expect(DelayDefinition.executeFn).toBe(executeDelay);
    });

    it("DelayDefinition category is WIRING", () => {
      expect(DelayDefinition.category).toBe(ComponentCategory.WIRING);
    });

    it("DelayDefinition can be registered", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(DelayDefinition)).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// Break
// ---------------------------------------------------------------------------

describe("Break", () => {
  describe("assertionDetection", () => {
    it("input=0 → output=0 (not triggered)", () => {
      // inputs: [brk=0]; output: [triggered]
      const layout = makeLayout(1, 1);
      const state = makeState([0]);
      const highZs = new Uint32Array(state.length);
      executeBreak(0, state, highZs, layout);
      expect(state[1]).toBe(0);
    });

    it("input=1 → output=1 (triggered)", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([1]);
      const highZs = new Uint32Array(state.length);
      executeBreak(0, state, highZs, layout);
      expect(state[1]).toBe(1);
    });

    it("input=0xFF (non-zero) → output=1 (triggered)", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([0xFF]);
      const highZs = new Uint32Array(state.length);
      executeBreak(0, state, highZs, layout);
      expect(state[1]).toBe(1);
    });

    it("input transitions 0→1→0 are tracked correctly", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([0]);
      const highZs = new Uint32Array(state.length);

      executeBreak(0, state, highZs, layout);
      expect(state[1]).toBe(0);

      state[0] = 1;
      executeBreak(0, state, highZs, layout);
      expect(state[1]).toBe(1);

      state[0] = 0;
      executeBreak(0, state, highZs, layout);
      expect(state[1]).toBe(0);
    });
  });

  describe("pinLayout", () => {
    it("Break has 1 input pin and 0 output pins in declarations (+ engine output)", () => {
      const decls = buildBreakPinDeclarations();
      expect(decls.filter((d) => d.direction === PinDirection.INPUT)).toHaveLength(1);
      expect(decls.find((d) => d.label === "brk")).toBeDefined();
    });
  });

  describe("attributeMapping", () => {
    it("Label and enabled map correctly", () => {
      const entries: Record<string, string> = { Label: "bp1", enabled: "false" };
      const bag = new PropertyBag();
      for (const m of BREAK_ATTRIBUTE_MAPPINGS) {
        if (entries[m.xmlName] !== undefined) {
          bag.set(m.propertyKey, m.convert(entries[m.xmlName]));
        }
      }
      expect(bag.get<string>("label")).toBe("bp1");
      expect(bag.get<boolean>("enabled")).toBe(false);
    });
  });

  describe("draw", () => {
    it("draw() calls drawRect", () => {
      const props = new PropertyBag();
      const el = new BreakElement("test", { x: 0, y: 0 }, 0, false, props);
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.filter((c) => c.method === "drawRect").length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("definitionComplete", () => {
    it("BreakDefinition has name='Break'", () => {
      expect(BreakDefinition.name).toBe("Break");
    });

    it("BreakDefinition has typeId=-1", () => {
      expect(BreakDefinition.typeId).toBe(-1);
    });

    it("BreakDefinition has executeFn=executeBreak", () => {
      expect(BreakDefinition.executeFn).toBe(executeBreak);
    });

    it("BreakDefinition category is WIRING", () => {
      expect(BreakDefinition.category).toBe(ComponentCategory.WIRING);
    });

    it("BreakDefinition can be registered", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(BreakDefinition)).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

describe("Stop", () => {
  describe("terminationDetection", () => {
    it("input=0 → output=0 (not triggered)", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([0]);
      const highZs = new Uint32Array(state.length);
      executeStop(0, state, highZs, layout);
      expect(state[1]).toBe(0);
    });

    it("input=1 → output=1 (triggered)", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([1]);
      const highZs = new Uint32Array(state.length);
      executeStop(0, state, highZs, layout);
      expect(state[1]).toBe(1);
    });

    it("input=0xDEAD (non-zero) → output=1", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([0xDEAD]);
      const highZs = new Uint32Array(state.length);
      executeStop(0, state, highZs, layout);
      expect(state[1]).toBe(1);
    });
  });

  describe("pinLayout", () => {
    it("Stop pin declaration has 'stop' input", () => {
      const decls = buildStopPinDeclarations();
      expect(decls.find((d) => d.label === "stop")).toBeDefined();
      expect(decls[0].direction).toBe(PinDirection.INPUT);
    });
  });

  describe("attributeMapping", () => {
    it("Label maps to label", () => {
      const m = STOP_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Label");
      expect(m).toBeDefined();
      expect(m!.convert("myStop")).toBe("myStop");
    });
  });

  describe("draw", () => {
    it("draw() renders 'STP' text", () => {
      const props = new PropertyBag();
      const el = new StopElement("test", { x: 0, y: 0 }, 0, false, props);
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.some((c) => c.args[0] === "STP")).toBe(true);
    });
  });

  describe("definitionComplete", () => {
    it("StopDefinition has name='Stop'", () => {
      expect(StopDefinition.name).toBe("Stop");
    });

    it("StopDefinition has executeFn=executeStop", () => {
      expect(StopDefinition.executeFn).toBe(executeStop);
    });

    it("StopDefinition category is WIRING", () => {
      expect(StopDefinition.category).toBe(ComponentCategory.WIRING);
    });

    it("StopDefinition can be registered", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(StopDefinition)).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

describe("Reset", () => {
  describe("initRelease", () => {
    it("executeReset is a no-op: does not modify output slot", () => {
      // Reset has no inputs — output managed by engine
      const layout = makeLayout(0, 1);
      const state = makeState([]);
      const highZs = new Uint32Array(state.length);
      // Pre-set output to a sentinel value
      state[0] = 42;
      executeReset(0, state, highZs, layout);
      // No-op: output should still be 42
      expect(state[0]).toBe(42);
    });

    it("executeReset can be called repeatedly without side effects", () => {
      const layout = makeLayout(0, 1);
      const state = makeState([]);
      const highZs = new Uint32Array(state.length);
      state[0] = 0xAB;
      for (let i = 0; i < 100; i++) {
        executeReset(0, state, highZs, layout);
      }
      expect(state[0]).toBe(0xAB);
    });
  });

  describe("pinLayout", () => {
    it("Reset has 0 input pins and 1 output pin", () => {
      const decls = buildResetPinDeclarations();
      expect(decls.filter((d) => d.direction === PinDirection.INPUT)).toHaveLength(0);
      expect(decls.filter((d) => d.direction === PinDirection.OUTPUT)).toHaveLength(1);
    });

    it("output pin is labeled 'Reset'", () => {
      const decls = buildResetPinDeclarations();
      expect(decls[0].label).toBe("Reset");
    });
  });

  describe("attributeMapping", () => {
    it("invertOutput maps correctly", () => {
      const m = RESET_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "invertOutput");
      expect(m).toBeDefined();
      expect(m!.convert("true")).toBe(true);
      expect(m!.convert("false")).toBe(false);
    });
  });

  describe("draw", () => {
    it("draw() renders 'RST' text", () => {
      const props = new PropertyBag();
      const el = new ResetElement("test", { x: 0, y: 0 }, 0, false, props);
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.some((c) => c.args[0] === "RST")).toBe(true);
    });

    it("invertOutput=true draws inversion bubble (drawCircle)", () => {
      const props = new PropertyBag();
      props.set("invertOutput", true);
      const el = new ResetElement("test", { x: 0, y: 0 }, 0, false, props);
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const circleCalls = calls.filter((c) => c.method === "drawCircle");
      expect(circleCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("invertOutput=false does not draw inversion bubble", () => {
      const props = new PropertyBag();
      props.set("invertOutput", false);
      const el = new ResetElement("test", { x: 0, y: 0 }, 0, false, props);
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const circleCalls = calls.filter((c) => c.method === "drawCircle");
      expect(circleCalls).toHaveLength(0);
    });
  });

  describe("definitionComplete", () => {
    it("ResetDefinition has name='Reset'", () => {
      expect(ResetDefinition.name).toBe("Reset");
    });

    it("ResetDefinition has executeFn=executeReset", () => {
      expect(ResetDefinition.executeFn).toBe(executeReset);
    });

    it("ResetDefinition category is WIRING", () => {
      expect(ResetDefinition.category).toBe(ComponentCategory.WIRING);
    });

    it("ResetDefinition can be registered", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(ResetDefinition)).not.toThrow();
    });

    it("ResetDefinition propertyDefs include invertOutput", () => {
      const keys = ResetDefinition.propertyDefs.map((d) => d.key);
      expect(keys).toContain("invertOutput");
    });
  });
});

// ---------------------------------------------------------------------------
// AsyncSeq
// ---------------------------------------------------------------------------

describe("AsyncSeq", () => {
  describe("noOpExecute", () => {
    it("executeAsyncSeq is a no-op (does nothing to state)", () => {
      // AsyncSeq has no inputs or outputs
      const layout = makeLayout(0, 0);
      const state = makeState([]);
      const highZs = new Uint32Array(state.length);
      // Pre-populate state with sentinel values
      state[0] = 0xDEAD;
      state[1] = 0xBEEF;
      executeAsyncSeq(0, state, highZs, layout);
      // State should be unchanged
      expect(state[0]).toBe(0xDEAD);
      expect(state[1]).toBe(0xBEEF);
    });

    it("executeAsyncSeq can be called without error", () => {
      const layout = makeLayout(0, 0);
      const state = new Uint32Array(4);
      const highZs = new Uint32Array(state.length);
      expect(() => executeAsyncSeq(0, state, highZs, layout)).not.toThrow();
    });
  });

  describe("flagPropagation", () => {
    it("AsyncSeqElement.runAtRealTime is false by default", () => {
      const props = new PropertyBag();
      const el = new AsyncSeqElement("test", { x: 0, y: 0 }, 0, false, props);
      expect(el.runAtRealTime).toBe(false);
    });

    it("AsyncSeqElement.runAtRealTime reflects property value", () => {
      const props = new PropertyBag();
      props.set("runAtRealTime", true);
      props.set("frequency", 50);
      const el = new AsyncSeqElement("test", { x: 0, y: 0 }, 0, false, props);
      expect(el.runAtRealTime).toBe(true);
      expect(el.frequency).toBe(50);
    });

    it("frequency defaults to 1", () => {
      const props = new PropertyBag();
      const el = new AsyncSeqElement("test", { x: 0, y: 0 }, 0, false, props);
      expect(el.frequency).toBe(1);
    });
  });

  describe("pinLayout", () => {
    it("AsyncSeq has no pins", () => {
      const decls = buildAsyncSeqPinDeclarations();
      expect(decls).toHaveLength(0);
    });

    it("AsyncSeqElement.getPins() returns empty array", () => {
      const props = new PropertyBag();
      const el = new AsyncSeqElement("test", { x: 0, y: 0 }, 0, false, props);
      expect(el.getPins()).toHaveLength(0);
    });
  });

  describe("attributeMapping", () => {
    it("runRealTime and Frequency map correctly", () => {
      const entries: Record<string, string> = { runRealTime: "true", Frequency: "60" };
      const bag = new PropertyBag();
      for (const m of ASYNC_SEQ_ATTRIBUTE_MAPPINGS) {
        if (entries[m.xmlName] !== undefined) {
          bag.set(m.propertyKey, m.convert(entries[m.xmlName]));
        }
      }
      expect(bag.get<boolean>("runAtRealTime")).toBe(true);
      expect(bag.get<number>("frequency")).toBe(60);
    });
  });

  describe("draw", () => {
    it("draw() calls drawRect for the body", () => {
      const props = new PropertyBag();
      const el = new AsyncSeqElement("test", { x: 0, y: 0 }, 0, false, props);
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.filter((c) => c.method === "drawRect").length).toBeGreaterThanOrEqual(1);
    });

    it("draw() renders 'AS' text", () => {
      const props = new PropertyBag();
      const el = new AsyncSeqElement("test", { x: 0, y: 0 }, 0, false, props);
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.some((c) => c.args[0] === "AS")).toBe(true);
    });
  });

  describe("definitionComplete", () => {
    it("AsyncSeqDefinition has name='AsyncSeq'", () => {
      expect(AsyncSeqDefinition.name).toBe("AsyncSeq");
    });

    it("AsyncSeqDefinition has typeId=-1", () => {
      expect(AsyncSeqDefinition.typeId).toBe(-1);
    });

    it("AsyncSeqDefinition has executeFn=executeAsyncSeq", () => {
      expect(AsyncSeqDefinition.executeFn).toBe(executeAsyncSeq);
    });

    it("AsyncSeqDefinition category is WIRING", () => {
      expect(AsyncSeqDefinition.category).toBe(ComponentCategory.WIRING);
    });

    it("AsyncSeqDefinition has empty pinLayout (no pins)", () => {
      expect(AsyncSeqDefinition.pinLayout).toHaveLength(0);
    });

    it("AsyncSeqDefinition propertyDefs include runAtRealTime and frequency", () => {
      const keys = AsyncSeqDefinition.propertyDefs.map((d) => d.key);
      expect(keys).toContain("runAtRealTime");
      expect(keys).toContain("frequency");
    });

    it("AsyncSeqDefinition can be registered", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(AsyncSeqDefinition)).not.toThrow();
    });

    it("AsyncSeqDefinition has a non-empty helpText", () => {
      expect(typeof AsyncSeqDefinition.helpText).toBe("string"); expect(AsyncSeqDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });
  });
});
