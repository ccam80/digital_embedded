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
import { makeDcVoltageSource } from "../../sources/dc-voltage-source.js";
import { withNodeIds, runDcOp } from "../../../solver/analog/__tests__/test-helpers.js";
import { StatePool } from "../../../solver/analog/state-pool.js";
import type { AnalogElement } from "../../../solver/analog/element.js";
import type { AnalogElementCore } from "../../../core/analog-types.js";
import type { ReactiveAnalogElement } from "../../../solver/analog/element.js";
import type { SparseSolver as SparseSolverType } from "../../../solver/analog/sparse-solver.js";

// ---------------------------------------------------------------------------
// Helper: narrow ModelEntry to inline factory (throws if netlist kind)
// ---------------------------------------------------------------------------
import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";
function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}

// ---------------------------------------------------------------------------
// Helper: allocate a StatePool for a single element and call initState
// ---------------------------------------------------------------------------

function withState(core: AnalogElementCore): { element: ReactiveAnalogElement; pool: StatePool } {
  const re = core as ReactiveAnalogElement;
  const pool = new StatePool(Math.max(re.stateSize, 1));
  re.stateBaseOffset = 0;
  re.initState(pool);
  return { element: re, pool };
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
    it("executeLed: input=1 → output=1 (on)", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([1], 1);
      const highZs = new Uint32Array(state.length);
      executeLed(0, state, highZs, layout);
      expect(state[1]).toBe(1);
    });

    it("executeLed: input=0 → output=0 (off)", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([0], 1);
      const highZs = new Uint32Array(state.length);
      executeLed(0, state, highZs, layout);
      expect(state[1]).toBe(0);
    });

    it("executeLed: non-zero input → output=1 (on)", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([0xFF], 1);
      const highZs = new Uint32Array(state.length);
      executeLed(0, state, highZs, layout);
      expect(state[1]).toBe(1);
    });

    it("executeLed: large non-zero input → output=1", () => {
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
    it("anode=1, cathode=0 → output=1 (lit)", () => {
      const layout = makeLayout(2, 1);
      const state = makeState([1, 0], 1);
      const highZs = new Uint32Array(state.length);
      executePolarityLed(0, state, highZs, layout);
      expect(state[2]).toBe(1);
    });

    it("anode=0, cathode=0 → output=0 (not lit)", () => {
      const layout = makeLayout(2, 1);
      const state = makeState([0, 0], 1);
      const highZs = new Uint32Array(state.length);
      executePolarityLed(0, state, highZs, layout);
      expect(state[2]).toBe(0);
    });

    it("anode=1, cathode=1 → output=0 (no current flow)", () => {
      const layout = makeLayout(2, 1);
      const state = makeState([1, 1], 1);
      const highZs = new Uint32Array(state.length);
      executePolarityLed(0, state, highZs, layout);
      expect(state[2]).toBe(0);
    });

    it("anode=0, cathode=1 → output=0 (reverse bias)", () => {
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
    it("executeLightBulb: input=1 → output=1 (on)", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([1], 1);
      const highZs = new Uint32Array(state.length);
      executeLightBulb(0, state, highZs, layout);
      expect(state[1]).toBe(1);
    });

    it("executeLightBulb: input=0 → output=0 (off)", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([0], 1);
      const highZs = new Uint32Array(state.length);
      executeLightBulb(0, state, highZs, layout);
      expect(state[1]).toBe(0);
    });

    it("executeLightBulb: non-zero input → output=1", () => {
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
    it("R=1, G=0, B=0 → output has R bit set", () => {
      const layout = makeLayout(3, 1);
      const state = makeState([1, 0, 0], 1);
      const highZs = new Uint32Array(state.length);
      executeRgbLed(0, state, highZs, layout);
      // R is bit 2: output = (1<<2)|(0<<1)|0 = 4
      expect(state[3]).toBe(4);
    });

    it("R=0, G=1, B=0 → output has G bit set", () => {
      const layout = makeLayout(3, 1);
      const state = makeState([0, 1, 0], 1);
      const highZs = new Uint32Array(state.length);
      executeRgbLed(0, state, highZs, layout);
      // G is bit 1: output = 0|(1<<1)|0 = 2
      expect(state[3]).toBe(2);
    });

    it("R=0, G=0, B=1 → output has B bit set", () => {
      const layout = makeLayout(3, 1);
      const state = makeState([0, 0, 1], 1);
      const highZs = new Uint32Array(state.length);
      executeRgbLed(0, state, highZs, layout);
      // B is bit 0: output = 0|0|1 = 1
      expect(state[3]).toBe(1);
    });

    it("R=1, G=1, B=1 → output=7 (white, all channels)", () => {
      const layout = makeLayout(3, 1);
      const state = makeState([1, 1, 1], 1);
      const highZs = new Uint32Array(state.length);
      executeRgbLed(0, state, highZs, layout);
      expect(state[3]).toBe(7);
    });

    it("R=0, G=0, B=0 → output=0 (off)", () => {
      const layout = makeLayout(3, 1);
      const state = makeState([0, 0, 0], 1);
      const highZs = new Uint32Array(state.length);
      executeRgbLed(0, state, highZs, layout);
      expect(state[3]).toBe(0);
    });

    it("non-zero R input → R channel active", () => {
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
  return {
    pinNodeIds: [nodeA, nodeB],
    allNodeIds: [nodeA, nodeB],
    branchIndex: -1,
    isNonlinear: false,
    isReactive: false,
    setParam(_key: string, _value: number): void {},
    getPinCurrents(_v: Float64Array): number[] { return []; },
    stampAc(solver: SparseSolverType): void {
      if (nodeA !== 0) solver.stampElement(solver.allocElement(nodeA - 1, nodeA - 1), G);
      if (nodeB !== 0) solver.stampElement(solver.allocElement(nodeB - 1, nodeB - 1), G);
      if (nodeA !== 0 && nodeB !== 0) {
        solver.stampElement(solver.allocElement(nodeA - 1, nodeB - 1), -G);
        solver.stampElement(solver.allocElement(nodeB - 1, nodeA - 1), -G);
      }
    },
    load(ctx: import("../../../solver/analog/load-context.js").LoadContext): void {
      const solver = ctx.solver;
      if (nodeA !== 0 && nodeB !== 0) {
        solver.stampElement(solver.allocElement(nodeA - 1, nodeA - 1), +G);
        solver.stampElement(solver.allocElement(nodeB - 1, nodeB - 1), +G);
        solver.stampElement(solver.allocElement(nodeA - 1, nodeB - 1), -G);
        solver.stampElement(solver.allocElement(nodeB - 1, nodeA - 1), -G);
      } else if (nodeA !== 0) {
        solver.stampElement(solver.allocElement(nodeA - 1, nodeA - 1), +G);
      } else if (nodeB !== 0) {
        solver.stampElement(solver.allocElement(nodeB - 1, nodeB - 1), +G);
      }
    },
  };
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

  it("analog_factory_produces_nonlinear_element", () => {
    const props = new PropertyBag();
    props.set("color", "red");
    props.replaceModelParams({ IS: 3.17e-19, N: 1.8, CJO: 0, VJ: 1, M: 0.5, TT: 0, FC: 0.5 });
    const core = getFactory(LedDefinition.modelRegistry!.red!)!(new Map([["in", 1]]), [], -1, props, () => 0);
    const { element } = withState(core);
    expect(element.isNonlinear).toBe(true);
    expect(element.isReactive).toBe(false);
  });

  it("red_led_forward_drop", () => {
    // Circuit: 5V → 220Ω → red LED (anode=node1, cathode=gnd) → ground
    // Red LED Vf ≈ 1.8V ± 0.15V at the operating point
    //
    // MNA: node1 = LED anode / resistor junction
    //      node2 = +5V source terminal
    //      branch row = 2
    //      matrixSize = 3

    const matrixSize = 3;
    const branchRow = 2;

    const vs = withNodeIds(makeDcVoltageSource(2, 0, branchRow, 5), [2, 0]);
    const r = makeResistorElementForLed(1, 2, 220);

    const props = new PropertyBag();
    props.set("color", "red");
    props.replaceModelParams({ IS: 3.17e-19, N: 1.8, CJO: 0, VJ: 1, M: 0.5, TT: 0, FC: 0.5 });
    const ledCore = getFactory(LedDefinition.modelRegistry!.red!)!(new Map([["in", 1]]), [], -1, props, () => 0);
    const { element: ledStateWrapped } = withState(ledCore);
    const led = withNodeIds(ledStateWrapped, [1, 0]);

    const result = runDcOp({
      elements: [vs, r, led],
      matrixSize,
      nodeCount: 2,
    });

    expect(result.converged).toBe(true);

    // V(node1) = LED forward voltage
    const vf = result.nodeVoltages[0];
    expect(vf).toBeGreaterThan(1.65);
    expect(vf).toBeLessThan(1.95);
  });

  it("blue_led_forward_drop", () => {
    // Circuit: 5V → 100Ω → blue LED (anode=node1, cathode=gnd) → ground
    // Blue LED Vf ≈ 3.2V ± 0.15V

    const matrixSize = 3;
    const branchRow = 2;

    const vs = withNodeIds(makeDcVoltageSource(2, 0, branchRow, 5), [2, 0]);
    const r = makeResistorElementForLed(1, 2, 100);

    const props = new PropertyBag();
    props.set("color", "blue");
    props.replaceModelParams({ IS: 6.26e-24, N: 2.5, CJO: 0, VJ: 1, M: 0.5, TT: 0, FC: 0.5 });
    const ledCore = getFactory(LedDefinition.modelRegistry!.blue!)!(new Map([["in", 1]]), [], -1, props, () => 0);
    const { element: ledStateWrapped } = withState(ledCore);
    const led = withNodeIds(ledStateWrapped, [1, 0]);

    const result = runDcOp({
      elements: [vs, r, led],
      matrixSize,
      nodeCount: 2,
    });

    expect(result.converged).toBe(true);

    const vf = result.nodeVoltages[0];
    expect(vf).toBeGreaterThan(3.05);
    expect(vf).toBeLessThan(3.35);
  });
});

// ---------------------------------------------------------------------------
// C2.3: inline NIintegrate integration tests
// ---------------------------------------------------------------------------

// ngspice → ours variable mapping (niinteg.c:28-63):
//   ag[0] (CKTag[0])    → ctx.ag[0]   coefficient on q0 (current charge)
//   ag[1] (CKTag[1])    → ctx.ag[1]   coefficient on q1 (previous charge)
//   cap                 → Ctotal      junction + transit-time cap
//   q0                  → computeJunctionCharge at vdLimited
//   q1                  → s1[SLOT_Q]  from previous accepted step
//   ccap                → ag[0]*q0 + ag[1]*q1
//   geq                 → ag[0]*Ctotal
//   ceq                 → ccap - geq*vdLimited

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
    props.replaceModelParams({ IS, N, CJO, VJ, M, TT, FC });
    const core = getFactory(LedDefinition.modelRegistry!.red!)!(new Map([["in", 1]]), [], -1, props, () => 0);

    const pool = new StatePool(9);
    (core as any).stateBaseOffset = 0;
    core.initState(pool);

    // Seed SLOT_VD=0 with vd so pnjlim sees vdOld=vd and returns vdLimited=vd unchanged.
    pool.state0[0] = vd;

    // Seed previous-step charge in s1[SLOT_Q=7]
    const nVt = N * LED_VT;
    const prevVd = 1.75;
    const prevIdRaw = IS * (Math.exp(prevVd / nVt) - 1);
    const q1_val = computeJunctionCharge(prevVd, CJO, VJ, M, FC, TT, prevIdRaw);
    pool.state1[7] = q1_val;

    const stamps: Array<[number, number, number]> = [];
    const rhs: Array<[number, number]> = [];
    const mockSolver = {
      stamp: (r: number, c: number, v: number) => stamps.push([r, c, v]),
      stampRHS: (r: number, v: number) => rhs.push([r, v]),
    } as any;

    const ctx = {
      solver: mockSolver,
      voltages: new Float64Array([vd]),
      iteration: 0,
      initMode: "transient" as const,
      dt,
      method: "trapezoidal" as const,
      order: 2,
      deltaOld: [dt, dt, dt, dt, dt, dt, dt],
      ag,
      srcFact: 1,
      noncon: { value: 0 },
      limitingCollector: null,
      isDcOp: false,
      isTransient: true,
      isTransientDcop: false,
      isAc: false,
      xfact: 1,
      gmin: 1e-12,
      uic: false,
      reltol: 1e-3,
      iabstol: 1e-12,
    };

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
    const gd_junction = gdRaw + 1e-12; // LED_GMIN added in load()
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
