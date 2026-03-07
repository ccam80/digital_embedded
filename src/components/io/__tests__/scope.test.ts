/**
 * Tests for Oscilloscope components: Scope, ScopeTrigger.
 *
 * Covers:
 *   - Waveform recording over multiple steps
 *   - Trigger detection (rising/falling edge)
 *   - Multi-channel capture
 *   - Pin layout
 *   - Attribute mapping
 *   - ComponentDefinition completeness
 */

import { describe, it, expect } from "vitest";
import {
  ScopeElement,
  executeScope,
  ScopeDefinition,
  SCOPE_ATTRIBUTE_MAPPINGS,
} from "../scope.js";
import {
  ScopeTriggerElement,
  executeScopeTrigger,
  ScopeTriggerDefinition,
  SCOPE_TRIGGER_ATTRIBUTE_MAPPINGS,
} from "../scope-trigger.js";
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

function makeState(inputs: number[], extraSlots: number = 2): Uint32Array {
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

function makeScope(overrides?: { channelCount?: number; bitWidth?: number; timeScale?: number }): ScopeElement {
  const props = new PropertyBag();
  props.set("channelCount", overrides?.channelCount ?? 1);
  props.set("bitWidth", overrides?.bitWidth ?? 1);
  props.set("timeScale", overrides?.timeScale ?? 1);
  return new ScopeElement("test-scope-001", { x: 0, y: 0 }, 0, false, props);
}

function makeScopeTrigger(overrides?: { triggerMode?: string }): ScopeTriggerElement {
  const props = new PropertyBag();
  props.set("triggerMode", overrides?.triggerMode ?? "rising");
  return new ScopeTriggerElement("test-trigger-001", { x: 0, y: 0 }, 0, false, props);
}

// ---------------------------------------------------------------------------
// Scope tests
// ---------------------------------------------------------------------------

describe("Scope", () => {
  describe("waveformRecording", () => {
    it("recordSamples appends values to channel buffer", () => {
      const scope = makeScope({ channelCount: 1 });
      scope.recordSamples([42]);
      expect(scope.getChannels()[0].samples).toHaveLength(1);
      expect(scope.getChannels()[0].samples[0]).toBe(42);
    });

    it("recordSamples over multiple steps accumulates samples", () => {
      const scope = makeScope({ channelCount: 1 });
      scope.recordSamples([0]);
      scope.recordSamples([1]);
      scope.recordSamples([0]);
      expect(scope.getChannels()[0].samples).toEqual([0, 1, 0]);
    });

    it("clearSamples empties all channel buffers", () => {
      const scope = makeScope({ channelCount: 2 });
      scope.recordSamples([1, 1]);
      scope.recordSamples([0, 0]);
      scope.clearSamples();
      for (const ch of scope.getChannels()) {
        expect(ch.samples).toHaveLength(0);
      }
    });

    it("sample buffer is capped at 1024 entries", () => {
      const scope = makeScope({ channelCount: 1 });
      for (let i = 0; i < 1100; i++) {
        scope.recordSamples([i & 1]);
      }
      expect(scope.getChannels()[0].samples.length).toBeLessThanOrEqual(1024);
    });
  });

  describe("multiChannelCapture", () => {
    it("2-channel scope records each channel independently", () => {
      const scope = makeScope({ channelCount: 2 });
      scope.recordSamples([1, 0]);
      scope.recordSamples([0, 1]);
      expect(scope.getChannels()[0].samples).toEqual([1, 0]);
      expect(scope.getChannels()[1].samples).toEqual([0, 1]);
    });

    it("4-channel scope has 4 channel buffers", () => {
      const scope = makeScope({ channelCount: 4 });
      expect(scope.getChannels()).toHaveLength(4);
    });

    it("channel labels are in0..inN-1", () => {
      const scope = makeScope({ channelCount: 3 });
      const labels = scope.getChannels().map((ch) => ch.label);
      expect(labels).toEqual(["in0", "in1", "in2"]);
    });
  });

  describe("executeScope", () => {
    it("executeScope writes first channel input to output slot", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([42], 1);
      const highZs = new Uint32Array(state.length);
      executeScope(0, state, highZs, layout);
      expect(state[1]).toBe(42);
    });

    it("executeScope with zero input → output=0", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([0], 1);
      const highZs = new Uint32Array(state.length);
      executeScope(0, state, highZs, layout);
      expect(state[1]).toBe(0);
    });

    it("executeScope with multi-channel: first channel written to output", () => {
      const layout = makeLayout(3, 1);
      const state = makeState([7, 2, 5], 1);
      const highZs = new Uint32Array(state.length);
      executeScope(0, state, highZs, layout);
      expect(state[3]).toBe(7);
    });
  });

  describe("pinLayout", () => {
    it("1-channel Scope has 1 input pin labeled 'in0'", () => {
      const el = makeScope({ channelCount: 1 });
      const inputs = el.getPins().filter((p) => p.direction === PinDirection.INPUT);
      expect(inputs).toHaveLength(1);
      expect(inputs[0].label).toBe("in0");
    });

    it("3-channel Scope has 3 input pins", () => {
      const el = makeScope({ channelCount: 3 });
      const inputs = el.getPins().filter((p) => p.direction === PinDirection.INPUT);
      expect(inputs).toHaveLength(3);
    });

    it("channelCount property is accessible", () => {
      const el = makeScope({ channelCount: 2 });
      expect(el.channelCount).toBe(2);
    });

    it("timeScale property is accessible", () => {
      const el = makeScope({ timeScale: 10 });
      expect(el.timeScale).toBe(10);
    });
  });

  describe("rendering", () => {
    it("draw calls save and restore", () => {
      const el = makeScope();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.some((c) => c.method === "save")).toBe(true);
      expect(calls.some((c) => c.method === "restore")).toBe(true);
    });

    it("draw renders component rect", () => {
      const el = makeScope();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const rects = calls.filter((c) => c.method === "drawRect");
      expect(rects.length).toBeGreaterThanOrEqual(1);
    });

    it("draw renders waveform symbol lines", () => {
      const el = makeScope();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const lines = calls.filter((c) => c.method === "drawLine");
      expect(lines.length).toBeGreaterThanOrEqual(3);
    });

    it("draw renders 'Scope' label", () => {
      const el = makeScope();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.some((c) => c.args[0] === "Scope")).toBe(true);
    });
  });

  describe("attributeMapping", () => {
    it("Channels attribute maps to channelCount", () => {
      const mapping = SCOPE_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Channels");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("channelCount");
      expect(mapping!.convert("3")).toBe(3);
    });

    it("Bits attribute maps to bitWidth", () => {
      const mapping = SCOPE_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Bits");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.convert("8")).toBe(8);
    });

    it("TimeScale attribute maps to timeScale", () => {
      const mapping = SCOPE_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "TimeScale");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.convert("10")).toBe(10);
    });
  });

  describe("definitionComplete", () => {
    it("ScopeDefinition has name='Scope'", () => {
      expect(ScopeDefinition.name).toBe("Scope");
    });

    it("ScopeDefinition has typeId=-1", () => {
      expect(ScopeDefinition.typeId).toBe(-1);
    });

    it("ScopeDefinition factory produces ScopeElement", () => {
      const props = new PropertyBag();
      props.set("channelCount", 1);
      props.set("bitWidth", 1);
      props.set("timeScale", 1);
      const el = ScopeDefinition.factory(props);
      expect(el.typeId).toBe("Scope");
    });

    it("ScopeDefinition executeFn is executeScope", () => {
      expect(ScopeDefinition.executeFn).toBe(executeScope);
    });

    it("ScopeDefinition category is IO", () => {
      expect(ScopeDefinition.category).toBe(ComponentCategory.IO);
    });

    it("ScopeDefinition has non-empty helpText", () => {
      expect(typeof ScopeDefinition.helpText).toBe("string"); expect(ScopeDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });

    it("ScopeDefinition can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(ScopeDefinition)).not.toThrow();
    });

    it("ScopeElement.getHelpText() contains 'Scope'", () => {
      const el = makeScope();
      expect(el.getHelpText()).toContain("Scope");
    });
  });
});

// ---------------------------------------------------------------------------
// ScopeTrigger tests
// ---------------------------------------------------------------------------

describe("ScopeTrigger", () => {
  describe("triggerDetection", () => {
    it("rising edge: 0→1 produces output=1", () => {
      const layout = makeLayout(1, 2);
      const state = makeState([1], 2);
      const highZs = new Uint32Array(state.length);
      state[2] = 0; // previous value = 0 (no edge yet)
      executeScopeTrigger(0, state, highZs, layout);
      expect(state[1]).toBe(1);
    });

    it("no edge: 1→1 produces output=0", () => {
      const layout = makeLayout(1, 2);
      const state = makeState([1], 2);
      const highZs = new Uint32Array(state.length);
      state[2] = 1; // previous value = 1 (no edge)
      executeScopeTrigger(0, state, highZs, layout);
      expect(state[1]).toBe(0);
    });

    it("falling edge: 1→0 produces output=1", () => {
      const layout = makeLayout(1, 2);
      const state = makeState([0], 2);
      const highZs = new Uint32Array(state.length);
      state[2] = 1; // previous value = 1
      executeScopeTrigger(0, state, highZs, layout);
      expect(state[1]).toBe(1);
    });

    it("no edge: 0→0 produces output=0", () => {
      const layout = makeLayout(1, 2);
      const state = makeState([0], 2);
      const highZs = new Uint32Array(state.length);
      state[2] = 0; // previous value = 0
      executeScopeTrigger(0, state, highZs, layout);
      expect(state[1]).toBe(0);
    });

    it("previous value is updated after each step", () => {
      const layout = makeLayout(1, 2);
      const state = makeState([1], 2);
      const highZs = new Uint32Array(state.length);
      state[2] = 0;
      executeScopeTrigger(0, state, highZs, layout);
      // After step, previous value should be 1
      expect(state[2]).toBe(1);
    });
  });

  describe("pinLayout", () => {
    it("ScopeTrigger has 1 input pin 'in'", () => {
      const el = makeScopeTrigger();
      const inputs = el.getPins().filter((p) => p.direction === PinDirection.INPUT);
      expect(inputs).toHaveLength(1);
      expect(inputs[0].label).toBe("in");
    });

    it("ScopeTrigger has 1 output pin 'out'", () => {
      const el = makeScopeTrigger();
      const outputs = el.getPins().filter((p) => p.direction === PinDirection.OUTPUT);
      expect(outputs).toHaveLength(1);
      expect(outputs[0].label).toBe("out");
    });

    it("triggerMode property is accessible", () => {
      const el = makeScopeTrigger({ triggerMode: "falling" });
      expect(el.triggerMode).toBe("falling");
    });
  });

  describe("rendering", () => {
    it("draw calls save and restore", () => {
      const el = makeScopeTrigger();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.some((c) => c.method === "save")).toBe(true);
      expect(calls.some((c) => c.method === "restore")).toBe(true);
    });

    it("draw renders component rect", () => {
      const el = makeScopeTrigger();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const rects = calls.filter((c) => c.method === "drawRect");
      expect(rects.length).toBeGreaterThanOrEqual(1);
    });

    it("draw renders edge symbol lines", () => {
      const el = makeScopeTrigger();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const lines = calls.filter((c) => c.method === "drawLine");
      expect(lines.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("attributeMapping", () => {
    it("TriggerMode attribute maps to triggerMode property", () => {
      const mapping = SCOPE_TRIGGER_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "TriggerMode");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("triggerMode");
      expect(mapping!.convert("falling")).toBe("falling");
    });
  });

  describe("definitionComplete", () => {
    it("ScopeTriggerDefinition has name='ScopeTrigger'", () => {
      expect(ScopeTriggerDefinition.name).toBe("ScopeTrigger");
    });

    it("ScopeTriggerDefinition has typeId=-1", () => {
      expect(ScopeTriggerDefinition.typeId).toBe(-1);
    });

    it("ScopeTriggerDefinition factory produces ScopeTriggerElement", () => {
      const props = new PropertyBag();
      props.set("triggerMode", "rising");
      const el = ScopeTriggerDefinition.factory(props);
      expect(el.typeId).toBe("ScopeTrigger");
    });

    it("ScopeTriggerDefinition executeFn is executeScopeTrigger", () => {
      expect(ScopeTriggerDefinition.executeFn).toBe(executeScopeTrigger);
    });

    it("ScopeTriggerDefinition category is IO", () => {
      expect(ScopeTriggerDefinition.category).toBe(ComponentCategory.IO);
    });

    it("ScopeTriggerDefinition has non-empty helpText", () => {
      expect(typeof ScopeTriggerDefinition.helpText).toBe("string"); expect(ScopeTriggerDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });

    it("ScopeTriggerDefinition can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(ScopeTriggerDefinition)).not.toThrow();
    });

    it("ScopeTriggerElement.getHelpText() contains 'ScopeTrigger'", () => {
      const el = makeScopeTrigger();
      expect(el.getHelpText()).toContain("ScopeTrigger");
    });
  });
});
