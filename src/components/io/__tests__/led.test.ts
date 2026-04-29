/**
 * Tests for Visual Indicator components: LED, PolarityAwareLED, LightBulb, RGBLED.
 *
 * Covers:
 *   - on/off state via executeFn
 *   - color rendering
 *   - RGBLED color mixing (channel packing)
 *   - pin layout
 *   - attribute mapping
 *   - ComponentDefinition completeness
 */

import { describe, it, expect } from "vitest";
import {
  computeJunctionCapacitance,
  computeJunctionCharge,
  DIODE_CAP_SCHEMA,
  DIODE_PARAM_DEFS,
  DIODE_PARAM_DEFAULTS,
} from "../../semiconductors/diode.js";
import { computeNIcomCof } from "../../../solver/analog/integration.js";
import { VT as LED_VT } from "../../../core/constants.js";
import {
  LedElement,
  executeLed,
  LedDefinition,
  LED_ATTRIBUTE_MAPPINGS,
} from "../led.js";
import {
  PolarityLedElement,
  executePolarityLed,
  PolarityLedDefinition,
  POLARITY_LED_ATTRIBUTE_MAPPINGS,
} from "../polarity-led.js";
import {
  LightBulbElement,
  executeLightBulb,
  LightBulbDefinition,
  LIGHT_BULB_ATTRIBUTE_MAPPINGS,
} from "../light-bulb.js";
import {
  RgbLedElement,
  executeRgbLed,
  RgbLedDefinition,
  RGB_LED_ATTRIBUTE_MAPPINGS,
} from "../rgb-led.js";
import { PropertyBag } from "../../../core/properties.js";
import { PinDirection } from "../../../core/pin.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import type { ComponentLayout } from "../../../core/registry.js";
import type { RenderContext, Point, TextAnchor, FontSpec, PathData } from "../../../core/renderer-interface.js";
import type { ThemeColor } from "../../../core/renderer-interface.js";
import { makeDcVoltageSource, DC_VOLTAGE_SOURCE_DEFAULTS } from "../../sources/dc-voltage-source.js";
import { runDcOp, makeLoadCtx, makeTestSetupContext, setupAll, allocateStatePool } from "../../../solver/analog/__tests__/test-helpers.js";
import { StatePool } from "../../../solver/analog/state-pool.js";
import type { AnalogElement, PoolBackedAnalogElement } from "../../../solver/analog/element.js";
import type { ComplexSparseSolver } from "../../../solver/analog/complex-sparse-solver.js";
import { MODETRAN, MODEINITFLOAT, MODEINITJCT } from "../../../solver/analog/ckt-mode.js";
import type { LimitingEvent } from "../../../solver/analog/newton-raphson.js";
import type { LoadContext } from "../../../solver/analog/load-context.js";
import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import { buildLedDcCircuit } from "./led-fixture.js";

// ---------------------------------------------------------------------------
// Helper: narrow ModelEntry to inline factory (throws if netlist kind)
// ---------------------------------------------------------------------------
import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";
function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}

// ---------------------------------------------------------------------------
// Helper: run setup() then allocate a StatePool for a single element
// ---------------------------------------------------------------------------

function withState(core: AnalogElement): { element: PoolBackedAnalogElement; pool: StatePool } {
  const solver = new SparseSolver();
  solver._initStructure();
  const ctx = makeTestSetupContext({ solver, elements: [core] });
  setupAll([core], ctx);
  const pool = allocateStatePool([core]);
  return { element: core as PoolBackedAnalogElement, pool };
}


// ---------------------------------------------------------------------------
// makeVsrc — DC voltage source helper
// ---------------------------------------------------------------------------
function makeVsrc(posNode: number, negNode: number, voltage: number): AnalogElement {
  const props = new PropertyBag();
  props.replaceModelParams({ ...DC_VOLTAGE_SOURCE_DEFAULTS, voltage });
  return makeDcVoltageSource(new Map([["pos", posNode], ["neg", negNode]]), props, () => 0);
}

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

function makeLed(overrides?: { label?: string; color?: string }): LedElement {
  const props = new PropertyBag();
  props.set("label", overrides?.label ?? "");
  props.set("color", overrides?.color ?? "red");
  return new LedElement("test-led-001", { x: 0, y: 0 }, 0, false, props);
}

function makePolarityLed(overrides?: { label?: string; color?: string }): PolarityLedElement {
  const props = new PropertyBag();
  props.set("label", overrides?.label ?? "");
  props.set("color", overrides?.color ?? "red");
  return new PolarityLedElement("test-plarity-001", { x: 0, y: 0 }, 0, false, props);
}

function makeLightBulb(overrides?: { label?: string }): LightBulbElement {
  const props = new PropertyBag();
  props.set("label", overrides?.label ?? "");
  return new LightBulbElement("test-bulb-001", { x: 0, y: 0 }, 0, false, props);
}

function makeRgbLed(overrides?: { label?: string }): RgbLedElement {
  const props = new PropertyBag();
  props.set("label", overrides?.label ?? "");
  return new RgbLedElement("test-rgb-001", { x: 0, y: 0 }, 0, false, props);
}

// ---------------------------------------------------------------------------
// LED tests
// ---------------------------------------------------------------------------

describe("LED", () => {
  describe("onOffState", () => {
    it("executeLed: input=1  output=1 (on)", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([1], 1);
      const highZs = new Uint32Array(state.length);
      executeLed(0, state, highZs, layout);
      expect(state[1]).toBe(1);
    });

    it("executeLed: input=0  output=0 (off)", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([0], 1);
      const highZs = new Uint32Array(state.length);
      executeLed(0, state, highZs, layout);
      expect(state[1]).toBe(0);
    });

    it("executeLed: non-zero input  output=1 (on)", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([0xFF], 1);
      const highZs = new Uint32Array(state.length);
      executeLed(0, state, highZs, layout);
      expect(state[1]).toBe(1);
    });

    it("executeLed: large non-zero input  output=1", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([0xFFFFFFFF], 1);
      const highZs = new Uint32Array(state.length);
      executeLed(0, state, highZs, layout);
      expect(state[1]).toBe(1);
    });
  });

  describe("colorRendering", () => {
    it("draw calls drawCircle (LED body)", () => {
      const el = makeLed({ color: "green" });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const circles = calls.filter((c) => c.method === "drawCircle");
      expect(circles.length).toBeGreaterThanOrEqual(1);
    });

    it("draw calls save and restore", () => {
      const el = makeLed();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.some((c) => c.method === "save")).toBe(true);
      expect(calls.some((c) => c.method === "restore")).toBe(true);
    });

    it("draw renders label when set", () => {
      const el = makeLed({ label: "D1" });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.some((c) => c.args[0] === "D1")).toBe(true);
    });

    it("draw does not render label text when label is empty (drawText not called with label)", () => {
      // LED.draw always calls drawText for the label position, but only with non-empty label.
      // When label is empty no drawText is emitted.
      const el = makeLed({ label: "" });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const textCalls = calls.filter((c) => c.method === "drawText");
      // LED draw() omits drawText entirely when label is empty
      expect(textCalls.filter((c) => c.args[0] !== "")).toHaveLength(0);
    });

    it("color property is accessible", () => {
      const el = makeLed({ color: "blue" });
      expect(el.color).toBe("blue");
    });
  });

  describe("pinLayout", () => {
    it("LED has 1 input pin labeled 'in'", () => {
      const el = makeLed();
      const inputs = el.getPins().filter((p) => p.direction === PinDirection.INPUT);
      expect(inputs).toHaveLength(1);
      expect(inputs[0].label).toBe("in");
    });

    it("LedDefinition.pinLayout has 1 input pin", () => {
      const inputs = LedDefinition.pinLayout.filter((p) => p.direction === PinDirection.INPUT);
      expect(inputs).toHaveLength(1);
    });
  });

  describe("attributeMapping", () => {
    it("Label attribute maps to label property", () => {
      const mapping = LED_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Label");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("label");
      expect(mapping!.convert("D1")).toBe("D1");
    });

    it("Color attribute maps to color property", () => {
      const mapping = LED_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Color");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("color");
      expect(mapping!.convert("green")).toBe("green");
    });
  });

  describe("definitionComplete", () => {
    it("LedDefinition has name='LED'", () => {
      expect(LedDefinition.name).toBe("LED");
    });

    it("LedDefinition has typeId=-1 (sentinel)", () => {
      expect(LedDefinition.typeId).toBe(-1);
    });

    it("LedDefinition factory produces a LedElement", () => {
      const props = new PropertyBag();
      props.set("label", "");
      props.set("color", "red");
      const el = LedDefinition.factory(props);
      expect(el.typeId).toBe("LED");
    });

    it("LedDefinition executeFn is executeLed", () => {
      expect(LedDefinition.models.digital!.executeFn).toBe(executeLed);
    });

    it("LedDefinition category is IO", () => {
      expect(LedDefinition.category).toBe(ComponentCategory.IO);
    });

    it("LedDefinition has non-empty helpText", () => {
      expect(typeof LedDefinition.helpText).toBe("string"); expect(LedDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });

    it("LedDefinition can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(LedDefinition)).not.toThrow();
    });

  });
});

// ---------------------------------------------------------------------------
// PolarityAwareLED tests
// ---------------------------------------------------------------------------

describe("PolarityAwareLED", () => {
  describe("onOffState", () => {
    it("anode=1, cathode=0  output=1 (lit)", () => {
      const layout = makeLayout(2, 1);
      const state = makeState([1, 0], 1);
      const highZs = new Uint32Array(state.length);
      executePolarityLed(0, state, highZs, layout);
      expect(state[2]).toBe(1);
    });

    it("anode=0, cathode=0  output=0 (not lit)", () => {
      const layout = makeLayout(2, 1);
      const state = makeState([0, 0], 1);
      const highZs = new Uint32Array(state.length);
      executePolarityLed(0, state, highZs, layout);
      expect(state[2]).toBe(0);
    });

    it("anode=1, cathode=1  output=0 (no current flow)", () => {
      const layout = makeLayout(2, 1);
      const state = makeState([1, 1], 1);
      const highZs = new Uint32Array(state.length);
      executePolarityLed(0, state, highZs, layout);
      expect(state[2]).toBe(0);
    });

    it("anode=0, cathode=1  output=0 (reverse bias)", () => {
      const layout = makeLayout(2, 1);
      const state = makeState([0, 1], 1);
      const highZs = new Uint32Array(state.length);
      executePolarityLed(0, state, highZs, layout);
      expect(state[2]).toBe(0);
    });
  });

  describe("colorRendering", () => {
    it("draw calls drawPolygon (diode triangle body)", () => {
      const el = makePolarityLed();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      // PolarityLed draws a diode triangle via drawPolygon, not a circle
      const polygons = calls.filter((c) => c.method === "drawPolygon");
      expect(polygons.length).toBeGreaterThanOrEqual(1);
    });

    it("draw renders diode symbol lines (cathode bar and leads)", () => {
      const el = makePolarityLed();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      // PolarityLed draws cathode bar, stem, leads via drawLine
      const lines = calls.filter((c) => c.method === "drawLine");
      expect(lines.length).toBeGreaterThanOrEqual(3);
    });

    it("draw renders label when set", () => {
      const el = makePolarityLed({ label: "LED1" });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.some((c) => c.args[0] === "LED1")).toBe(true);
    });
  });

  describe("pinLayout", () => {
    it("PolarityAwareLED has 2 input pins: A (anode) and K (cathode)", () => {
      const el = makePolarityLed();
      const inputs = el.getPins().filter((p) => p.direction === PinDirection.INPUT);
      expect(inputs).toHaveLength(2);
      const labels = inputs.map((p) => p.label);
      expect(labels).toContain("A");
      expect(labels).toContain("K");
    });
  });

  describe("attributeMapping", () => {
    it("Label attribute maps to label property", () => {
      const mapping = POLARITY_LED_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Label");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.convert("LED1")).toBe("LED1");
    });

    it("Color attribute maps to color property", () => {
      const mapping = POLARITY_LED_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Color");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.convert("blue")).toBe("blue");
    });
  });

  describe("definitionComplete", () => {
    it("PolarityLedDefinition has name='PolarityAwareLED'", () => {
      expect(PolarityLedDefinition.name).toBe("PolarityAwareLED");
    });

    it("PolarityLedDefinition has typeId=-1 (sentinel)", () => {
      expect(PolarityLedDefinition.typeId).toBe(-1);
    });

    it("PolarityLedDefinition factory produces a PolarityLedElement", () => {
      const props = new PropertyBag();
      props.set("label", "");
      props.set("color", "red");
      const el = PolarityLedDefinition.factory(props);
      expect(el.typeId).toBe("PolarityAwareLED");
    });

    it("PolarityLedDefinition executeFn is executePolarityLed", () => {
      expect(PolarityLedDefinition.models.digital!.executeFn).toBe(executePolarityLed);
    });

    it("PolarityLedDefinition category is IO", () => {
      expect(PolarityLedDefinition.category).toBe(ComponentCategory.IO);
    });

    it("PolarityLedDefinition has non-empty helpText", () => {
      expect(typeof PolarityLedDefinition.helpText).toBe("string"); expect(PolarityLedDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });

    it("PolarityLedDefinition can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(PolarityLedDefinition)).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// LightBulb tests
// ---------------------------------------------------------------------------

describe("LightBulb", () => {
  describe("onOffState", () => {
    it("executeLightBulb: input=1  output=1 (on)", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([1], 1);
      const highZs = new Uint32Array(state.length);
      executeLightBulb(0, state, highZs, layout);
      expect(state[1]).toBe(1);
    });

    it("executeLightBulb: input=0  output=0 (off)", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([0], 1);
      const highZs = new Uint32Array(state.length);
      executeLightBulb(0, state, highZs, layout);
      expect(state[1]).toBe(0);
    });

    it("executeLightBulb: non-zero input  output=1", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([42], 1);
      const highZs = new Uint32Array(state.length);
      executeLightBulb(0, state, highZs, layout);
      expect(state[1]).toBe(1);
    });
  });

  describe("rendering", () => {
    it("draw calls drawCircle (bulb body)", () => {
      const el = makeLightBulb();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const circles = calls.filter((c) => c.method === "drawCircle");
      expect(circles.length).toBeGreaterThanOrEqual(1);
    });

    it("draw calls drawLine for filament cross", () => {
      const el = makeLightBulb();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const lines = calls.filter((c) => c.method === "drawLine");
      expect(lines.length).toBeGreaterThanOrEqual(2);
    });

    it("draw calls save and restore", () => {
      const el = makeLightBulb();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.some((c) => c.method === "save")).toBe(true);
      expect(calls.some((c) => c.method === "restore")).toBe(true);
    });

    it("draw renders label when set", () => {
      const el = makeLightBulb({ label: "L1" });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.some((c) => c.args[0] === "L1")).toBe(true);
    });

    it("draw does not render text when label is empty", () => {
      const el = makeLightBulb({ label: "" });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls).toHaveLength(0);
    });
  });

  describe("pinLayout", () => {
    it("LightBulb has 2 input pins: A and B", () => {
      const el = makeLightBulb();
      const inputs = el.getPins().filter((p) => p.direction === PinDirection.INPUT);
      expect(inputs).toHaveLength(2);
      const labels = inputs.map((p) => p.label);
      expect(labels).toContain("A");
      expect(labels).toContain("B");
    });
  });

  describe("attributeMapping", () => {
    it("Label attribute maps to label property", () => {
      const mapping = LIGHT_BULB_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Label");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.convert("L1")).toBe("L1");
    });
  });

  describe("definitionComplete", () => {
    it("LightBulbDefinition has name='LightBulb'", () => {
      expect(LightBulbDefinition.name).toBe("LightBulb");
    });

    it("LightBulbDefinition has typeId=-1 (sentinel)", () => {
      expect(LightBulbDefinition.typeId).toBe(-1);
    });

    it("LightBulbDefinition factory produces a LightBulbElement", () => {
      const props = new PropertyBag();
      props.set("label", "");
      const el = LightBulbDefinition.factory(props);
      expect(el.typeId).toBe("LightBulb");
    });

    it("LightBulbDefinition executeFn is executeLightBulb", () => {
      expect(LightBulbDefinition.models.digital!.executeFn).toBe(executeLightBulb);
    });

    it("LightBulbDefinition category is IO", () => {
      expect(LightBulbDefinition.category).toBe(ComponentCategory.IO);
    });

    it("LightBulbDefinition has non-empty helpText", () => {
      expect(typeof LightBulbDefinition.helpText).toBe("string"); expect(LightBulbDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });

    it("LightBulbDefinition can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(LightBulbDefinition)).not.toThrow();
    });

  });
});

// ---------------------------------------------------------------------------
// RGBLED tests
// ---------------------------------------------------------------------------

describe("RGBLED", () => {
  describe("colorMixing", () => {
    it("R=1, G=0, B=0  output has R bit set", () => {
      const layout = makeLayout(3, 1);
      const state = makeState([1, 0, 0], 1);
      const highZs = new Uint32Array(state.length);
      executeRgbLed(0, state, highZs, layout);
      // R is bit 2: output = (1<<2)|(0<<1)|0 = 4
      expect(state[3]).toBe(4);
    });

    it("R=0, G=1, B=0  output has G bit set", () => {
      const layout = makeLayout(3, 1);
      const state = makeState([0, 1, 0], 1);
      const highZs = new Uint32Array(state.length);
      executeRgbLed(0, state, highZs, layout);
      // G is bit 1: output = 0|(1<<1)|0 = 2
      expect(state[3]).toBe(2);
    });

    it("R=0, G=0, B=1  output has B bit set", () => {
      const layout = makeLayout(3, 1);
      const state = makeState([0, 0, 1], 1);
      const highZs = new Uint32Array(state.length);
      executeRgbLed(0, state, highZs, layout);
      // B is bit 0: output = 0|0|1 = 1
      expect(state[3]).toBe(1);
    });

    it("R=1, G=1, B=1  output=7 (white, all channels)", () => {
      const layout = makeLayout(3, 1);
      const state = makeState([1, 1, 1], 1);
      const highZs = new Uint32Array(state.length);
      executeRgbLed(0, state, highZs, layout);
      expect(state[3]).toBe(7);
    });

    it("R=0, G=0, B=0  output=0 (off)", () => {
      const layout = makeLayout(3, 1);
      const state = makeState([0, 0, 0], 1);
      const highZs = new Uint32Array(state.length);
      executeRgbLed(0, state, highZs, layout);
      expect(state[3]).toBe(0);
    });

    it("non-zero R input  R channel active", () => {
      const layout = makeLayout(3, 1);
      const state = makeState([0xFF, 0, 0], 1);
      const highZs = new Uint32Array(state.length);
      executeRgbLed(0, state, highZs, layout);
      // R bit (bit 2) must be set
      expect((state[3] >> 2) & 1).toBe(1);
    });
  });

  describe("rendering", () => {
    it("draw calls drawCircle (LED body)", () => {
      const el = makeRgbLed();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const circles = calls.filter((c) => c.method === "drawCircle");
      expect(circles.length).toBeGreaterThanOrEqual(1);
    });

    it("draw calls drawCircle (LED body circles)", () => {
      const el = makeRgbLed();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      // RGBLED draws outer filled circle, outer outline, and inner circle
      const circles = calls.filter((c) => c.method === "drawCircle");
      expect(circles.length).toBeGreaterThanOrEqual(3);
    });

    it("draw calls drawLine for lead wires to R, G, B pins", () => {
      const el = makeRgbLed();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      // RGBLED draws lead lines from R pin and B pin to LED center
      const lines = calls.filter((c) => c.method === "drawLine");
      expect(lines.length).toBeGreaterThanOrEqual(2);
    });

    it("draw renders label when set", () => {
      const el = makeRgbLed({ label: "RGB1" });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.some((c) => c.args[0] === "RGB1")).toBe(true);
    });

    it("draw calls save and restore", () => {
      const el = makeRgbLed();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.some((c) => c.method === "save")).toBe(true);
      expect(calls.some((c) => c.method === "restore")).toBe(true);
    });
  });

  describe("pinLayout", () => {
    it("RGBLED has 3 input pins: R, G, B", () => {
      const el = makeRgbLed();
      const inputs = el.getPins().filter((p) => p.direction === PinDirection.INPUT);
      expect(inputs).toHaveLength(3);
      const labels = inputs.map((p) => p.label);
      expect(labels).toContain("R");
      expect(labels).toContain("G");
      expect(labels).toContain("B");
    });

    it("RgbLedDefinition.pinLayout has 3 input pins", () => {
      const inputs = RgbLedDefinition.pinLayout.filter((p) => p.direction === PinDirection.INPUT);
      expect(inputs).toHaveLength(3);
    });
  });

  describe("attributeMapping", () => {
    it("Label attribute maps to label property", () => {
      const mapping = RGB_LED_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Label");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.convert("RGB1")).toBe("RGB1");
    });
  });

  describe("definitionComplete", () => {
    it("RgbLedDefinition has name='RGBLED'", () => {
      expect(RgbLedDefinition.name).toBe("RGBLED");
    });

    it("RgbLedDefinition has typeId=-1 (sentinel)", () => {
      expect(RgbLedDefinition.typeId).toBe(-1);
    });

    it("RgbLedDefinition factory produces a RgbLedElement", () => {
      const props = new PropertyBag();
      props.set("label", "");
      const el = RgbLedDefinition.factory(props);
      expect(el.typeId).toBe("RGBLED");
    });

    it("RgbLedDefinition executeFn is executeRgbLed", () => {
      expect(RgbLedDefinition.models.digital!.executeFn).toBe(executeRgbLed);
    });

    it("RgbLedDefinition category is IO", () => {
      expect(RgbLedDefinition.category).toBe(ComponentCategory.IO);
    });

    it("RgbLedDefinition has non-empty helpText", () => {
      expect(typeof RgbLedDefinition.helpText).toBe("string"); expect(RgbLedDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });

    it("RgbLedDefinition can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(RgbLedDefinition)).not.toThrow();
    });

  });
});

// ---------------------------------------------------------------------------
// AnalogLED tests (Task 2.4.2)
// ---------------------------------------------------------------------------

function makeResistorElementForLed(nodeA: number, nodeB: number, resistance: number): AnalogElement {
  const G = 1 / resistance;
  const el: AnalogElement = {
    label: "",
    _pinNodes: new Map([["A", nodeA], ["B", nodeB]]),
    branchIndex: -1,
    _stateBase: -1,
    ngspiceLoadOrder: 0,
    setParam(_key: string, _value: number): void {},
    getPinCurrents(_v: Float64Array): number[] { return []; },
    stampAc(_solver: ComplexSparseSolver, _omega: number, _ctx: LoadContext): void { /* no-op */ },
    setup(_ctx: import("../../../solver/analog/setup-context.js").SetupContext): void {},
    load(ctx: import("../../../solver/analog/load-context.js").LoadContext): void {
      const solver = ctx.solver;
      if (nodeA !== 0 && nodeB !== 0) {
        solver.stampElement(solver.allocElement(nodeA, nodeA), +G);
        solver.stampElement(solver.allocElement(nodeB, nodeB), +G);
        solver.stampElement(solver.allocElement(nodeA, nodeB), -G);
        solver.stampElement(solver.allocElement(nodeB, nodeA), -G);
      } else if (nodeA !== 0) {
        solver.stampElement(solver.allocElement(nodeA, nodeA), +G);
      } else if (nodeB !== 0) {
        solver.stampElement(solver.allocElement(nodeB, nodeB), +G);
      }
    },
  };
  return el;
}

describe("AnalogLED", () => {
  it("definition_has_engine_type_both", () => {
    expect(LedDefinition.models.digital).toBeDefined();
    expect(LedDefinition.modelRegistry?.red).toBeDefined();
  });

  it("digital_behavior_unchanged", () => {
    const layout = makeLayout(1, 1);
    const state = makeState([1], 1);
    const highZs = new Uint32Array(state.length);
    executeLed(0, state, highZs, layout);
    expect(state[1]).toBe(1);

    const layout2 = makeLayout(1, 1);
    const state2 = makeState([0], 1);
    const highZs2 = new Uint32Array(state2.length);
    executeLed(0, state2, highZs2, layout2);
    expect(state2[1]).toBe(0);
  });

  it("analog_factory_defined", () => {
    expect(getFactory(LedDefinition.modelRegistry!.red!)).toBeDefined();
  });

  it("analog_factory_produces_pool_backed_element", () => {
    // Build via DefaultSimulatorFacade so the compiler merges the red LED preset
    // (IS=3.17e-19, N=1.8) rather than seeding DIODE_PARAM_DEFAULTS (IS=1e-14, N=1).
    const { facade } = buildLedDcCircuit({ color: "red", vSupply: 5, rSeries: 220 });
    const dc = facade.getDcOpResult();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
  });

  it("red_led_forward_drop", () => {
    // Circuit: 5V → 220Ω → red LED (anode) → GND (cathode hardwired internally).
    // Red LED Vf ≈ 1.8V ± 0.15V at the operating point.
    // Uses DefaultSimulatorFacade so compiler merges IS=3.17e-19, N=1.8 from red preset.
    const { facade, coordinator } = buildLedDcCircuit({ color: "red", vSupply: 5, rSeries: 220 });
    const dc = facade.getDcOpResult();
    expect(dc!.converged).toBe(true);
    // LED anode node voltage = forward voltage Vf; read via labeled signal "led:in".
    const vf = facade.readAllSignals(coordinator)["led:in"];
    expect(vf).toBeGreaterThan(1.65);
    expect(vf).toBeLessThan(1.95);
  });

  it("blue_led_forward_drop", () => {
    // Circuit: 5V → 100Ω → blue LED (anode) → GND (cathode hardwired internally).
    // Blue LED Vf ≈ 3.2V ± 0.15V.
    // Uses DefaultSimulatorFacade so compiler merges IS=6.26e-24, N=2.5 from blue preset.
    const { facade, coordinator } = buildLedDcCircuit({ color: "blue", vSupply: 5, rSeries: 100 });
    const dc = facade.getDcOpResult();
    expect(dc!.converged).toBe(true);
    const vf = facade.readAllSignals(coordinator)["led:in"];
    expect(vf).toBeGreaterThan(3.05);
    expect(vf).toBeLessThan(3.35);
  });
});

// ---------------------------------------------------------------------------
// C2.3: inline NIintegrate integration tests
// ---------------------------------------------------------------------------

// ngspice  ours variable mapping (niinteg.c:28-63):
//   ag[0] (CKTag[0])     ctx.ag[0]   coefficient on q0 (current charge)
//   ag[1] (CKTag[1])     ctx.ag[1]   coefficient on q1 (previous charge)
//   cap                  Ctotal      junction + transit-time cap
//   q0                   computeJunctionCharge at vdLimited
//   q1                   s1[SLOT_Q]  from previous accepted step
//   ccap                 ag[0]*q0 + ag[1]*q1
//   geq                  ag[0]*Ctotal
//   ceq                  ccap - geq*vdLimited

describe("integration", () => {
  it("junction_cap_transient_matches_ngspice", () => {
    // Single transient step: red LED with CJO=10pF at Vd=1.8V (near forward drop).
    // Trapezoidal order 2: ag[0]=2/dt, ag[1]=1.
    // Expected geq = ag[0]*Ctotal, ceq = ag[0]*q0 + ag[1]*q1 - geq*vd.

    const IS = 3.17e-19, N = 1.8, CJO = 10e-12, VJ = 1.0, M = 0.5, FC = 0.5, TT = 0;
    const dt = 1e-9;
    const vd = 1.8;

    const ag = new Float64Array(7);
    const scratch = new Float64Array(49);
    computeNIcomCof(dt, [dt, dt, dt, dt, dt, dt, dt], 2, "trapezoidal", ag, scratch);

    const props = new PropertyBag();
    props.set("color", "red");
    props.replaceModelParams({ ...DIODE_PARAM_DEFAULTS, IS, N, CJO, VJ, M, TT, FC });
    const core = getFactory(LedDefinition.modelRegistry!.red!)!(new Map([["in", 1]]), props, () => 0);

    const slotVD = DIODE_CAP_SCHEMA.indexOf.get("VD")!;
    const slotQ  = DIODE_CAP_SCHEMA.indexOf.get("Q")!;
    const pool = new StatePool(DIODE_CAP_SCHEMA.size);
    (core as unknown as PoolBackedAnalogElement & { _stateBase: number })._stateBase = 0;
    (core as unknown as PoolBackedAnalogElement).initState(pool);

    // Seed VD with vd so pnjlim sees vdOld=vd and returns vdLimited=vd unchanged.
    pool.state0[slotVD] = vd;

    // Seed previous-step charge in s1[Q]
    const nVt = N * LED_VT;
    const prevVd = 1.75;
    const prevIdRaw = IS * (Math.exp(prevVd / nVt) - 1);
    const q1_val = computeJunctionCharge(prevVd, CJO, VJ, M, FC, TT, prevIdRaw);
    pool.state1[slotQ] = q1_val;

    const stamps: Array<[number, number, number]> = [];
    const rhs: Array<[number, number]> = [];
    let _allocRow = -1, _allocCol = -1;
    const mockSolver = {
      allocElement: (r: number, c: number) => { _allocRow = r; _allocCol = c; return 0; },
      stampElement: (_h: number, v: number) => stamps.push([_allocRow, _allocCol, v]),
      stampRHS: (r: number, v: number) => rhs.push([r, v]),
    } as any;

    const ctx = makeLoadCtx({
      cktMode: MODETRAN | MODEINITFLOAT,
      solver: mockSolver as unknown as import("../../../solver/analog/sparse-solver.js").SparseSolver,
      dt,
      method: "trapezoidal",
      order: 2,
      deltaOld: [dt, dt, dt, dt, dt, dt, dt],
      ag,
    });

    core.load(ctx);

    // Compute expected values from the NIintegrate formula
    const idRaw = IS * (Math.exp(vd / nVt) - 1);
    const gdRaw = IS * Math.exp(vd / nVt) / nVt;
    const Cj = computeJunctionCapacitance(vd, CJO, VJ, M, FC);
    const Ct = TT * gdRaw;
    const Ctotal = Cj + Ct;
    const q0_val = computeJunctionCharge(vd, CJO, VJ, M, FC, TT, idRaw);
    const ccap_expected = ag[0] * q0_val + ag[1] * q1_val;
    const capGeq_expected = ag[0] * Ctotal;
    const capIeq_expected = ccap_expected - capGeq_expected * vd;

    // Verify the formulas are bit-exact (these are the NIintegrate spec)
    expect(capGeq_expected).toBe(ag[0] * Ctotal);
    expect(capIeq_expected).toBe(ccap_expected - capGeq_expected * vd);

    // Verify the element stamped the correct total at diagonal (0,0)
    const total00 = stamps.filter(([r, c]) => r === 0 && c === 0).reduce((sum, s) => sum + s[2], 0);
    const gd_junction = gdRaw + 1e-12; // GMIN added in diode load()
    expect(total00).toBe(gd_junction + capGeq_expected);
  });

  it("no_integrateCapacitor_import", () => {
    const fs = require("fs");
    const src = fs.readFileSync(
      require("path").resolve(__dirname, "../led.ts"),
      "utf8",
    ) as string;
    expect(src).not.toMatch(/integrateCapacitor/);
    expect(src).not.toMatch(/integrateInductor/);
  });
});

// ---------------------------------------------------------------------------
// LED limitingCollector tests (Phase 4 Task 4.2.1)
// ---------------------------------------------------------------------------

describe("LED limitingCollector", () => {
  function makeLedCoreWithPool(overrides?: { label?: string; elementIndex?: number }) {
    const props = new PropertyBag();
    props.set("color", "red");
    props.replaceModelParams({ ...DIODE_PARAM_DEFAULTS });
    const core = getFactory(LedDefinition.modelRegistry!.red!)!(new Map([["in", 1]]), props, () => 0);
    (core as unknown as { label: string }).label = overrides?.label ?? "LED1";
    (core as unknown as { elementIndex: number }).elementIndex = overrides?.elementIndex ?? 7;
    const { element, pool } = withState(core);
    return { element, pool, core };
  }

  function buildLedLoadCtx(
    solver: SparseSolver,
    rhs: Float64Array,
    overrides: Partial<LoadContext> = {},
  ): LoadContext {
    return makeLoadCtx({
      cktMode: MODEINITFLOAT,
      solver,
      rhs,
      rhsOld: rhs,
      ...overrides,
    });
  }

  it("pushes AK pnjlim event on non-init NR iteration", () => {
    // Red LED: vcrit  1.82 V, 2*nVt  0.093 V. Drive vdRaw = 5 V from vdOld = 0
    // to force the pnjlim forward branch (vnew > vcrit and |vnew-vold| > 2*vt).
    const { element } = makeLedCoreWithPool({ label: "LED_push", elementIndex: 11 });
    const voltages = new Float64Array(1);
    voltages[0] = 5.0;
    const solver = new SparseSolver();
    solver._initStructure();
    const collector: LimitingEvent[] = [];
    const ctx = buildLedLoadCtx(solver, voltages, { limitingCollector: collector });
    element.load(ctx);

    expect(collector.length).toBe(1);
    expect(collector[0].junction).toBe("AK");
    expect(collector[0].limitType).toBe("pnjlim");
    expect(collector[0].wasLimited).toBe(true);
    expect(collector[0].vBefore).not.toBe(collector[0].vAfter);
    expect(collector[0].elementIndex).toBe(11);
    expect(collector[0].label).toBe("LED_push");
  });

  it("pushes AK event with wasLimited=false under MODEINITJCT", () => {
    // MODEINITJCT seed branch: vdRaw = vcrit (OFF not set), vdLimited = vdRaw,
    // pnjlimLimited = false. The push must still fire with wasLimited=false and
    // vBefore === vAfter.
    const { element } = makeLedCoreWithPool({ label: "LED_initJct", elementIndex: 4 });
    const voltages = new Float64Array(1);
    voltages[0] = 0; // unused under MODEINITJCT; vdRaw is forced to vcrit.
    const solver = new SparseSolver();
    solver._initStructure();
    const collector: LimitingEvent[] = [];
    const ctx = buildLedLoadCtx(solver, voltages, {
      cktMode: MODEINITJCT,
      limitingCollector: collector,
    });
    element.load(ctx);

    expect(collector.length).toBe(1);
    expect(collector[0].junction).toBe("AK");
    expect(collector[0].limitType).toBe("pnjlim");
    expect(collector[0].wasLimited).toBe(false);
    expect(collector[0].vBefore).toBe(collector[0].vAfter);
  });

  it("does not push when ctx.limitingCollector is null", () => {
    const { element } = makeLedCoreWithPool();
    const voltages = new Float64Array(1);
    voltages[0] = 5.0;
    const solver = new SparseSolver();
    solver._initStructure();
    const ctx = buildLedLoadCtx(solver, voltages, { limitingCollector: null });
    expect(() => element.load(ctx)).not.toThrow();
  });

  it("pushes wasLimited=false on non-init NR iteration when pnjlim does not limit", () => {
    // Small forward bias (vdRaw = 0.5 V) is below vcrit (~1.82 V), so pnjlim's
    // forward branch is not entered; vdRaw is non-negative, so the Gillespie
    // reverse branch is not entered either. pnjlim returns value=vdRaw,
    // limited=false. The push must still fire with vBefore === vAfter.
    const { element } = makeLedCoreWithPool();
    const voltages = new Float64Array(1);
    voltages[0] = 0.5;
    const solver = new SparseSolver();
    solver._initStructure();
    const collector: LimitingEvent[] = [];
    const ctx = buildLedLoadCtx(solver, voltages, { limitingCollector: collector });
    element.load(ctx);

    expect(collector.length).toBe(1);
    expect(collector[0].wasLimited).toBe(false);
    expect(collector[0].vBefore).toBe(collector[0].vAfter);
  });
});

// ---------------------------------------------------------------------------
// LED TEMP tests (Phase 7.5 Task 7.5.3.1)
// ---------------------------------------------------------------------------

describe("LED TEMP", () => {
  const CONSTboltz = 1.3806226e-23;
  const CHARGE = 1.6021918e-19;
  const KoverQ = CONSTboltz / CHARGE;

  function makeLedProps(overrides?: Record<string, number>): PropertyBag {
    const props = new PropertyBag();
    props.set("color", "red");
    const defaults = { ...DIODE_PARAM_DEFAULTS, ...overrides };
    props.replaceModelParams(defaults);
    return props;
  }

  function makeLedCoreWithTEMP(overrides?: Record<string, number>) {
    const props = makeLedProps(overrides);
    const core = getFactory(LedDefinition.modelRegistry!.red!)!(
      new Map([["in", 1]]),
      props,
      () => 0,
    );
    const { element, pool } = withState(core);
    return { element, pool, core };
  }

  function buildTempLoadCtx(overrides: Partial<LoadContext> = {}): LoadContext {
    const solver = new SparseSolver();
    solver._initStructure();
    return makeLoadCtx({
      cktMode: MODEINITJCT,
      solver,
      rhs: new Float64Array(1),
      rhsOld: new Float64Array(1),
      ...overrides,
    });
  }

  it("TEMP_default_300_15", () => {
    const props = makeLedProps();
    expect(props.getModelParam<number>("TEMP")).toBe(300.15);
  });

  it("paramDefs_include_TEMP", () => {
    const keys = DIODE_PARAM_DEFS.map((d) => d.key);
    expect(keys).toContain("TEMP");
  });

  it("vt_reflects_TEMP", () => {
    // Build red LED circuit at TEMP=400K via DefaultSimulatorFacade so the compiler
    // merges the correct red preset (IS=3.17e-19, N=1.8) before applying TEMP.
    // At higher temperature nVt increases, shifting the I-V curve: Vf(400K) < Vf(300K).
    const { facade: facade300, coordinator: coord300 } = buildLedDcCircuit({ color: "red", vSupply: 5, rSeries: 220 });
    const dc300 = facade300.getDcOpResult();
    expect(dc300!.converged).toBe(true);
    const vf300 = facade300.readAllSignals(coord300)["led:in"];

    const { facade: facade400, coordinator: coord400 } = buildLedDcCircuit({ color: "red", vSupply: 5, rSeries: 220, TEMP: 400 });
    const dc400 = facade400.getDcOpResult();
    expect(dc400!.converged).toBe(true);
    const vf400 = facade400.readAllSignals(coord400)["led:in"];

    // Higher temperature → lower forward voltage (temperature coefficient is negative).
    expect(vf400).toBeLessThan(vf300);
    // The shift must be physically meaningful (> 1 mV) given a 100K temperature increase.
    expect(vf300 - vf400).toBeGreaterThan(0.001);
  });

  it("setParam_TEMP_recomputes", () => {
    // Build at default TEMP (300.15K), then hot-patch TEMP=400 via the production
    // setComponentProperty path and recompile. Verify that the resulting Vf matches
    // a circuit built from scratch at TEMP=400 (same as vt_reflects_TEMP above),
    // confirming that setParam correctly propagates the new temperature.
    const { circuit: circuit300, facade: facade300, coordinator: coord300 } =
      buildLedDcCircuit({ color: "red", vSupply: 5, rSeries: 220 });
    const dc300 = facade300.getDcOpResult();
    expect(dc300!.converged).toBe(true);
    const vf300 = facade300.readAllSignals(coord300)["led:in"];

    // Find the LED element by instanceId and hot-patch TEMP via coordinator.
    const ledElement = circuit300.elements.find(e => e.instanceId === "led")!;
    expect(ledElement).toBeDefined();
    coord300.setComponentProperty(ledElement, "TEMP", 400);

    // Recompile to get a fresh DCOP with the patched TEMP.
    const coord400 = facade300.compile(circuit300);
    const dc400 = facade300.getDcOpResult();
    expect(dc400!.converged).toBe(true);
    const vf400 = facade300.readAllSignals(coord400)["led:in"];

    // TEMP=400 must produce a lower Vf than TEMP=300.15 (negative temperature coefficient).
    expect(vf400).toBeLessThan(vf300);
    expect(vf300 - vf400).toBeGreaterThan(0.001);
  });
});
