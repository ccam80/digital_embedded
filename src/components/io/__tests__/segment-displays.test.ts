/**
 * Tests for Segment Display components: SevenSeg, SevenSegHex, SixteenSeg.
 *
 * Covers:
 *   - Correct segment mapping for all hex digits (SevenSegHex)
 *   - Direct segment drive (SevenSeg)
 *   - Decimal point input
 *   - Common anode vs cathode polarity
 *   - 16-segment packing (SixteenSeg)
 *   - Pin layout
 *   - Attribute mapping
 *   - ComponentDefinition completeness
 */

import { describe, it, expect } from "vitest";
import {
  SevenSegElement,
  executeSevenSeg,
  SevenSegDefinition,
  SEVEN_SEG_ATTRIBUTE_MAPPINGS,
} from "../seven-seg.js";
import {
  SevenSegHexElement,
  executeSevenSegHex,
  SevenSegHexDefinition,
  SEVEN_SEG_HEX_ATTRIBUTE_MAPPINGS,
  HEX_SEGMENT_TABLE,
} from "../seven-seg-hex.js";
import {
  SixteenSegElement,
  executeSixteenSeg,
  SixteenSegDefinition,
  SIXTEEN_SEG_ATTRIBUTE_MAPPINGS,
} from "../sixteen-seg.js";
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

function makeSevenSeg(overrides?: { commonCathode?: boolean; color?: string }): SevenSegElement {
  const props = new PropertyBag();
  props.set("commonCathode", overrides?.commonCathode ?? true);
  props.set("color", overrides?.color ?? "red");
  return new SevenSegElement("test-7seg-001", { x: 0, y: 0 }, 0, false, props);
}

function makeSevenSegHex(overrides?: { commonCathode?: boolean }): SevenSegHexElement {
  const props = new PropertyBag();
  props.set("commonCathode", overrides?.commonCathode ?? true);
  props.set("color", "red");
  return new SevenSegHexElement("test-7seghex-001", { x: 0, y: 0 }, 0, false, props);
}

function makeSixteenSeg(overrides?: { commonCathode?: boolean }): SixteenSegElement {
  const props = new PropertyBag();
  props.set("commonCathode", overrides?.commonCathode ?? true);
  props.set("color", "red");
  return new SixteenSegElement("test-16seg-001", { x: 0, y: 0 }, 0, false, props);
}

// ---------------------------------------------------------------------------
// SevenSeg tests
// ---------------------------------------------------------------------------

describe("SevenSeg", () => {
  describe("directSegmentDrive", () => {
    it("all segments off → output=0", () => {
      const layout = makeLayout(8, 1);
      const state = makeState([0, 0, 0, 0, 0, 0, 0, 0], 1);
      const highZs = new Uint32Array(state.length);
      executeSevenSeg(0, state, highZs, layout);
      expect(state[8]).toBe(0);
    });

    it("segment a (index 0) on → bit 0 set in output", () => {
      const layout = makeLayout(8, 1);
      // a=1, rest=0
      const state = makeState([1, 0, 0, 0, 0, 0, 0, 0], 1);
      const highZs = new Uint32Array(state.length);
      executeSevenSeg(0, state, highZs, layout);
      expect(state[8] & 1).toBe(1);
    });

    it("segment dp (index 7) on → bit 7 set in output", () => {
      const layout = makeLayout(8, 1);
      // a=0,...,g=0,dp=1
      const state = makeState([0, 0, 0, 0, 0, 0, 0, 1], 1);
      const highZs = new Uint32Array(state.length);
      executeSevenSeg(0, state, highZs, layout);
      expect((state[8] >> 7) & 1).toBe(1);
    });

    it("all segments on → output=0xFF", () => {
      const layout = makeLayout(8, 1);
      const state = makeState([1, 1, 1, 1, 1, 1, 1, 1], 1);
      const highZs = new Uint32Array(state.length);
      executeSevenSeg(0, state, highZs, layout);
      expect(state[8]).toBe(0xFF);
    });

    it("segments a, g on → bits 0 and 6 set", () => {
      const layout = makeLayout(8, 1);
      // a=1, b=0, c=0, d=0, e=0, f=0, g=1, dp=0
      const state = makeState([1, 0, 0, 0, 0, 0, 1, 0], 1);
      const highZs = new Uint32Array(state.length);
      executeSevenSeg(0, state, highZs, layout);
      expect(state[8] & 0b1000001).toBe(0b1000001);
    });
  });

  describe("decimalPoint", () => {
    it("dp input on → bit 7 set", () => {
      const layout = makeLayout(8, 1);
      const state = makeState([0, 0, 0, 0, 0, 0, 0, 1], 1);
      const highZs = new Uint32Array(state.length);
      executeSevenSeg(0, state, highZs, layout);
      expect((state[8] & 0x80) !== 0).toBe(true);
    });

    it("dp input off → bit 7 clear", () => {
      const layout = makeLayout(8, 1);
      const state = makeState([1, 1, 1, 1, 1, 1, 1, 0], 1);
      const highZs = new Uint32Array(state.length);
      executeSevenSeg(0, state, highZs, layout);
      expect((state[8] & 0x80)).toBe(0);
    });
  });

  describe("pinLayout", () => {
    it("SevenSeg has 8 input pins", () => {
      const el = makeSevenSeg();
      const inputs = el.getPins().filter((p) => p.direction === PinDirection.INPUT);
      expect(inputs).toHaveLength(8);
    });

    it("SevenSeg input pins include 'a' and 'dp'", () => {
      const el = makeSevenSeg();
      const labels = el.getPins().map((p) => p.label);
      expect(labels).toContain("a");
      expect(labels).toContain("dp");
    });

    it("SevenSegDefinition.pinLayout has 8 input pins", () => {
      const inputs = SevenSegDefinition.pinLayout.filter((p) => p.direction === PinDirection.INPUT);
      expect(inputs).toHaveLength(8);
    });
  });

  describe("rendering", () => {
    it("draw calls save and restore", () => {
      const el = makeSevenSeg();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.some((c) => c.method === "save")).toBe(true);
      expect(calls.some((c) => c.method === "restore")).toBe(true);
    });

    it("draw calls drawPolygon for segment outlines", () => {
      const el = makeSevenSeg();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const polys = calls.filter((c) => c.method === "drawPolygon");
      expect(polys.length).toBeGreaterThanOrEqual(7);
    });

    it("draw renders component background polygon", () => {
      const el = makeSevenSeg();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const polys = calls.filter((c) => c.method === "drawPolygon");
      expect(polys.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("commonAnodeVsCathode", () => {
    it("commonCathode=true stored correctly", () => {
      const el = makeSevenSeg({ commonCathode: true });
      expect(el.commonCathode).toBe(true);
    });

    it("commonCathode=false stored correctly", () => {
      const el = makeSevenSeg({ commonCathode: false });
      expect(el.commonCathode).toBe(false);
    });
  });

  describe("attributeMapping", () => {
    it("CommonCathode=true maps to boolean true", () => {
      const mapping = SEVEN_SEG_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "CommonCathode");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.convert("true")).toBe(true);
    });

    it("CommonCathode=false maps to boolean false", () => {
      const mapping = SEVEN_SEG_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "CommonCathode");
      expect(mapping!.convert("false")).toBe(false);
    });

    it("Color attribute maps to color property", () => {
      const mapping = SEVEN_SEG_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Color");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.convert("green")).toBe("green");
    });
  });

  describe("definitionComplete", () => {
    it("SevenSegDefinition has name='SevenSeg'", () => {
      expect(SevenSegDefinition.name).toBe("SevenSeg");
    });

    it("SevenSegDefinition has typeId=-1", () => {
      expect(SevenSegDefinition.typeId).toBe(-1);
    });

    it("SevenSegDefinition factory produces SevenSegElement", () => {
      const props = new PropertyBag();
      props.set("commonCathode", true);
      props.set("color", "red");
      const el = SevenSegDefinition.factory(props);
      expect(el.typeId).toBe("SevenSeg");
    });

    it("SevenSegDefinition executeFn is executeSevenSeg", () => {
      expect(SevenSegDefinition.models.digital!.executeFn).toBe(executeSevenSeg);
    });

    it("SevenSegDefinition category is IO", () => {
      expect(SevenSegDefinition.category).toBe(ComponentCategory.IO);
    });

    it("SevenSegDefinition has non-empty helpText", () => {
      expect(typeof SevenSegDefinition.helpText).toBe("string"); expect(SevenSegDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });

    it("SevenSegDefinition can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(SevenSegDefinition)).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// SevenSegHex tests
// ---------------------------------------------------------------------------

describe("SevenSegHex", () => {
  describe("hexDigitDecoding", () => {
    it("digit 0 → segment pattern for '0' (a,b,c,d,e,f on, g off)", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([0], 1);
      const highZs = new Uint32Array(state.length);
      executeSevenSegHex(0, state, highZs, layout);
      // 0 = 0b0111111 = segments a,b,c,d,e,f (no g)
      expect(state[1]).toBe(0b0111111);
    });

    it("digit 1 → segment pattern for '1' (b,c on)", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([1], 1);
      const highZs = new Uint32Array(state.length);
      executeSevenSegHex(0, state, highZs, layout);
      expect(state[1]).toBe(0b0000110);
    });

    it("digit 7 → segment pattern for '7' (a,b,c on)", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([7], 1);
      const highZs = new Uint32Array(state.length);
      executeSevenSegHex(0, state, highZs, layout);
      expect(state[1]).toBe(0b0000111);
    });

    it("digit 8 → all segments on", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([8], 1);
      const highZs = new Uint32Array(state.length);
      executeSevenSegHex(0, state, highZs, layout);
      expect(state[1]).toBe(0b1111111);
    });

    it("digit 0xA → segment pattern for 'A'", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([0xA], 1);
      const highZs = new Uint32Array(state.length);
      executeSevenSegHex(0, state, highZs, layout);
      expect(state[1]).toBe(0b1110111);
    });

    it("digit 0xF → segment pattern for 'F'", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([0xF], 1);
      const highZs = new Uint32Array(state.length);
      executeSevenSegHex(0, state, highZs, layout);
      expect(state[1]).toBe(0b1110001);
    });

    it("only lower 4 bits of input used (mask 0xF)", () => {
      const layout = makeLayout(1, 1);
      // Input 0x10 → digit 0 (lower 4 bits = 0)
      const state = makeState([0x10], 1);
      const highZs = new Uint32Array(state.length);
      executeSevenSegHex(0, state, highZs, layout);
      expect(state[1]).toBe(HEX_SEGMENT_TABLE[0]);
    });

    it("HEX_SEGMENT_TABLE has 16 entries", () => {
      expect(HEX_SEGMENT_TABLE.length).toBe(16);
    });

    it("all 16 hex digits produce distinct segment patterns", () => {
      const patterns = new Set(HEX_SEGMENT_TABLE);
      expect(patterns.size).toBe(16);
    });
  });

  describe("pinLayout", () => {
    it("SevenSegHex has 2 input pins: d (4-bit) and dp (1-bit)", () => {
      const el = makeSevenSegHex();
      const inputs = el.getPins().filter((p) => p.direction === PinDirection.INPUT);
      expect(inputs).toHaveLength(2);
      expect(inputs[0].label).toBe("d");
      expect(inputs[0].bitWidth).toBe(4);
      expect(inputs[1].label).toBe("dp");
      expect(inputs[1].bitWidth).toBe(1);
    });
  });

  describe("rendering", () => {
    it("draw calls save and restore", () => {
      const el = makeSevenSegHex();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.some((c) => c.method === "save")).toBe(true);
      expect(calls.some((c) => c.method === "restore")).toBe(true);
    });

    it("draw renders component polygon", () => {
      const el = makeSevenSegHex();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const polys = calls.filter((c) => c.method === "drawPolygon");
      expect(polys.length).toBeGreaterThanOrEqual(1);
    });

    it("draw renders segment shapes via drawPolygon (reuses SevenSeg shape)", () => {
      const el = makeSevenSegHex();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      // SevenSegHex reuses drawSevenSegShape which draws segment outlines as polygons
      const polys = calls.filter((c) => c.method === "drawPolygon");
      expect(polys.length).toBeGreaterThanOrEqual(7);
    });
  });

  describe("commonAnodeVsCathode", () => {
    it("commonCathode=true stored correctly", () => {
      const el = makeSevenSegHex({ commonCathode: true });
      expect(el.commonCathode).toBe(true);
    });

    it("commonCathode=false stored correctly", () => {
      const el = makeSevenSegHex({ commonCathode: false });
      expect(el.commonCathode).toBe(false);
    });
  });

  describe("attributeMapping", () => {
    it("CommonCathode maps correctly", () => {
      const mapping = SEVEN_SEG_HEX_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "CommonCathode");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.convert("true")).toBe(true);
      expect(mapping!.convert("false")).toBe(false);
    });

    it("Color attribute maps to color property", () => {
      const mapping = SEVEN_SEG_HEX_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Color");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.convert("green")).toBe("green");
    });
  });

  describe("definitionComplete", () => {
    it("SevenSegHexDefinition has name='SevenSegHex'", () => {
      expect(SevenSegHexDefinition.name).toBe("SevenSegHex");
    });

    it("SevenSegHexDefinition has typeId=-1", () => {
      expect(SevenSegHexDefinition.typeId).toBe(-1);
    });

    it("SevenSegHexDefinition factory produces SevenSegHexElement", () => {
      const props = new PropertyBag();
      props.set("commonCathode", true);
      props.set("color", "red");
      const el = SevenSegHexDefinition.factory(props);
      expect(el.typeId).toBe("SevenSegHex");
    });

    it("SevenSegHexDefinition executeFn is executeSevenSegHex", () => {
      expect(SevenSegHexDefinition.models.digital!.executeFn).toBe(executeSevenSegHex);
    });

    it("SevenSegHexDefinition category is IO", () => {
      expect(SevenSegHexDefinition.category).toBe(ComponentCategory.IO);
    });

    it("SevenSegHexDefinition has non-empty helpText", () => {
      expect(typeof SevenSegHexDefinition.helpText).toBe("string"); expect(SevenSegHexDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });

    it("SevenSegHexDefinition can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(SevenSegHexDefinition)).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// SixteenSeg tests
// ---------------------------------------------------------------------------

describe("SixteenSeg", () => {
  describe("segmentPacking", () => {
    it("is a no-op (display-only sink: no outputs to write)", () => {
      // SixteenSeg now has 2 inputs: led (16-bit packed) and dp (1-bit)
      // executeSixteenSeg does nothing — display panel reads inputs directly
      const layout = makeLayout(2, 0);
      const state = makeState([0xFFFF, 1], 0);
      const highZs = new Uint32Array(state.length);
      const before = Array.from(state);
      executeSixteenSeg(0, state, highZs, layout);
      expect(Array.from(state)).toEqual(before);
    });

    it("led input (16-bit packed segments) is preserved in state", () => {
      const layout = makeLayout(2, 0);
      const state = makeState([0xABCD, 0], 0);
      const highZs = new Uint32Array(state.length);
      executeSixteenSeg(0, state, highZs, layout);
      expect(state[0]).toBe(0xABCD);
    });

    it("dp input (1-bit) is preserved in state", () => {
      const layout = makeLayout(2, 0);
      const state = makeState([0, 1], 0);
      const highZs = new Uint32Array(state.length);
      executeSixteenSeg(0, state, highZs, layout);
      expect(state[1]).toBe(1);
    });

    it("can be called 1000 times without error", () => {
      const layout = makeLayout(2, 0);
      const state = makeState([0xFFFF, 1], 0);
      const highZs = new Uint32Array(state.length);
      for (let i = 0; i < 1000; i++) {
        executeSixteenSeg(0, state, highZs, layout);
      }
      expect(state[0]).toBe(0xFFFF);
    });
  });

  describe("pinLayout", () => {
    it("SixteenSeg has 2 input pins", () => {
      const el = makeSixteenSeg();
      const inputs = el.getPins().filter((p) => p.direction === PinDirection.INPUT);
      expect(inputs).toHaveLength(2);
    });

    it("SixteenSeg input pins are 'led' (16-bit) and 'dp' (1-bit)", () => {
      const el = makeSixteenSeg();
      const inputs = el.getPins().filter((p) => p.direction === PinDirection.INPUT);
      const ledPin = inputs.find((p) => p.label === "led");
      const dpPin = inputs.find((p) => p.label === "dp");
      expect(ledPin).toBeDefined();
      expect(ledPin!.bitWidth).toBe(16);
      expect(dpPin).toBeDefined();
      expect(dpPin!.bitWidth).toBe(1);
    });

    it("SixteenSegDefinition.pinLayout has 2 input pins", () => {
      const inputs = SixteenSegDefinition.pinLayout.filter((p) => p.direction === PinDirection.INPUT);
      expect(inputs).toHaveLength(2);
    });
  });

  describe("rendering", () => {
    it("draw calls save and restore", () => {
      const el = makeSixteenSeg();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.some((c) => c.method === "save")).toBe(true);
      expect(calls.some((c) => c.method === "restore")).toBe(true);
    });

    it("draw renders component polygon", () => {
      const el = makeSixteenSeg();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const polys = calls.filter((c) => c.method === "drawPolygon");
      expect(polys.length).toBeGreaterThanOrEqual(1);
    });

    it("draw calls drawPolygon for segment outlines", () => {
      const el = makeSixteenSeg();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const polys = calls.filter((c) => c.method === "drawPolygon");
      expect(polys.length).toBeGreaterThanOrEqual(10);
    });
  });

  describe("commonAnodeVsCathode", () => {
    it("commonCathode=true stored correctly", () => {
      const el = makeSixteenSeg({ commonCathode: true });
      expect(el.commonCathode).toBe(true);
    });

    it("commonCathode=false stored correctly", () => {
      const el = makeSixteenSeg({ commonCathode: false });
      expect(el.commonCathode).toBe(false);
    });
  });

  describe("attributeMapping", () => {
    it("CommonCathode maps correctly", () => {
      const mapping = SIXTEEN_SEG_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "CommonCathode");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.convert("true")).toBe(true);
      expect(mapping!.convert("false")).toBe(false);
    });

    it("Color attribute maps to color property", () => {
      const mapping = SIXTEEN_SEG_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Color");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.convert("blue")).toBe("blue");
    });
  });

  describe("definitionComplete", () => {
    it("SixteenSegDefinition has name='SixteenSeg'", () => {
      expect(SixteenSegDefinition.name).toBe("SixteenSeg");
    });

    it("SixteenSegDefinition has typeId=-1", () => {
      expect(SixteenSegDefinition.typeId).toBe(-1);
    });

    it("SixteenSegDefinition factory produces SixteenSegElement", () => {
      const props = new PropertyBag();
      props.set("commonCathode", true);
      props.set("color", "red");
      const el = SixteenSegDefinition.factory(props);
      expect(el.typeId).toBe("SixteenSeg");
    });

    it("SixteenSegDefinition executeFn is executeSixteenSeg", () => {
      expect(SixteenSegDefinition.models.digital!.executeFn).toBe(executeSixteenSeg);
    });

    it("SixteenSegDefinition category is IO", () => {
      expect(SixteenSegDefinition.category).toBe(ComponentCategory.IO);
    });

    it("SixteenSegDefinition has non-empty helpText", () => {
      expect(typeof SixteenSegDefinition.helpText).toBe("string"); expect(SixteenSegDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });

    it("SixteenSegDefinition can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(SixteenSegDefinition)).not.toThrow();
    });

    it("SixteenSegElement.getHelpText() contains 'SixteenSeg'", () => {
      const el = makeSixteenSeg();
      expect(el.getHelpText()).toContain("SixteenSeg");
    });
  });
});
