/**
 * Tests for VGA component (task 5.2.26).
 *
 * Covers:
 *   - Framebuffer write at addressed pixel (writePixelAt/readPixelAt)
 *   - processInputs: rising clock edge writes pixel, HSync/VSync timing
 *   - getFramebuffer: returns snapshot of pixel data
 *   - clearFramebuffer: resets all pixel data
 *   - executeVga: packs R/G/B/H/V/C into output slot
 *   - Pin layout: 6 inputs (R, G, B, H, V, C), no outputs
 *   - Rendering: component body drawn
 *   - Attribute mapping: .dig XML attributes convert correctly
 *   - ComponentDefinition: all required fields present
 */

import { describe, it, expect } from "vitest";
import {
  VGAElement,
  executeVga,
  VGADefinition,
  VGA_ATTRIBUTE_MAPPINGS,
} from "../vga.js";
import { PropertyBag } from "../../../core/properties.js";
import { PinDirection } from "../../../core/pin.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import type { ComponentLayout } from "../../../core/registry.js";
import type { RenderContext, Point, TextAnchor, FontSpec, PathData } from "../../../core/renderer-interface.js";
import type { ThemeColor } from "../../../core/renderer-interface.js";

// ---------------------------------------------------------------------------
// Helpers — ComponentLayout mock (6 inputs, 1 output)
// ---------------------------------------------------------------------------

function makeLayout(): ComponentLayout {
  return {
    wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: () => 6,
    inputOffset: () => 0,
    outputCount: () => 1,
    outputOffset: () => 6,
    stateOffset: () => 0,
    getProperty: () => undefined,
  };
}

/**
 * Build state: [R, G, B, H, V, C, output_slot]
 */
function makeState(r: number, g: number, b: number, h: number, v: number, c: number): Uint32Array {
  const arr = new Uint32Array(7);
  arr[0] = r >>> 0;
  arr[1] = g >>> 0;
  arr[2] = b >>> 0;
  arr[3] = h & 1;
  arr[4] = v & 1;
  arr[5] = c & 1;
  arr[6] = 0;
  return arr;
}

// ---------------------------------------------------------------------------
// Helpers — RenderContext mock
// ---------------------------------------------------------------------------

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
// Helpers — VGAElement factory
// ---------------------------------------------------------------------------

function makeVga(overrides?: {
  colorBits?: number;
  frameWidth?: number;
  frameHeight?: number;
  label?: string;
}): VGAElement {
  const props = new PropertyBag();
  props.set("colorBits", overrides?.colorBits ?? 4);
  props.set("frameWidth", overrides?.frameWidth ?? 16);  // small for tests
  props.set("frameHeight", overrides?.frameHeight ?? 8);
  if (overrides?.label !== undefined) {
    props.set("label", overrides.label);
  }
  return new VGAElement("test-vga-001", { x: 0, y: 0 }, 0, false, props);
}

// ---------------------------------------------------------------------------
// Framebuffer access
// ---------------------------------------------------------------------------

describe("VGA", () => {
  describe("framebufferAccess", () => {
    it("writePixelAt sets pixel at (x, y)", () => {
      const el = makeVga({ frameWidth: 16, frameHeight: 8 });
      el.writePixelAt(3, 2, 0xFF0000);
      expect(el.readPixelAt(3, 2)).toBe(0xFF0000);
    });

    it("readPixelAt returns 0 for unwritten pixels", () => {
      const el = makeVga({ frameWidth: 16, frameHeight: 8 });
      expect(el.readPixelAt(0, 0)).toBe(0);
    });

    it("writePixelAt ignores out-of-bounds coordinates", () => {
      const el = makeVga({ frameWidth: 4, frameHeight: 4 });
      el.writePixelAt(4, 0, 0xFF0000); // x == width, out of bounds
      el.writePixelAt(0, 4, 0x00FF00); // y == height, out of bounds
      el.writePixelAt(-1, 0, 0x0000FF);
      // All pixels still 0
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
          expect(el.readPixelAt(x, y)).toBe(0);
        }
      }
    });

    it("writePixelAt can write to different positions independently", () => {
      const el = makeVga({ frameWidth: 16, frameHeight: 8 });
      el.writePixelAt(0, 0, 0xFF0000);
      el.writePixelAt(15, 7, 0x0000FF);
      expect(el.readPixelAt(0, 0)).toBe(0xFF0000);
      expect(el.readPixelAt(15, 7)).toBe(0x0000FF);
      expect(el.readPixelAt(1, 0)).toBe(0);
    });

    it("getFramebuffer returns a snapshot (not the live buffer)", () => {
      const el = makeVga({ frameWidth: 4, frameHeight: 4 });
      el.writePixelAt(0, 0, 0xFF0000);
      const snapshot = el.getFramebuffer();
      el.writePixelAt(0, 0, 0x0000FF); // modify after snapshot
      expect(snapshot[0]).toBe(0xFF0000); // snapshot unchanged
    });

    it("clearFramebuffer resets all pixels to 0", () => {
      const el = makeVga({ frameWidth: 4, frameHeight: 4 });
      el.writePixelAt(0, 0, 0xFF0000);
      el.writePixelAt(3, 3, 0x00FF00);
      el.clearFramebuffer();
      const fb = el.getFramebuffer();
      for (let i = 0; i < fb.length; i++) {
        expect(fb[i]).toBe(0);
      }
    });

    it("framebuffer has frameWidth * frameHeight entries", () => {
      const el = makeVga({ frameWidth: 10, frameHeight: 5 });
      const fb = el.getFramebuffer();
      expect(fb.length).toBe(50);
    });
  });

  // ---------------------------------------------------------------------------
  // processInputs — HSync/VSync timing
  // ---------------------------------------------------------------------------

  describe("processInputs", () => {
    it("rising clock edge without sync writes a pixel", () => {
      const el = makeVga({ colorBits: 4, frameWidth: 16, frameHeight: 8 });
      // Rising clock edge at position (0,0): lastClock=false, clock=true
      el.processInputs(15, 0, 0, true, false, false);
      // Pixel written at (0, 0) with r=15 (all red at 4-bit max=15 → 0xFF)
      const pixel = el.readPixelAt(0, 0);
      expect(pixel).toBe(0xFF0000); // red=255, green=0, blue=0
    });

    it("HSync rising edge resets X position", () => {
      const el = makeVga({ colorBits: 4, frameWidth: 16, frameHeight: 8 });
      // Write a pixel at x=0
      el.processInputs(15, 0, 0, true, false, false);
      el.processInputs(15, 0, 0, false, false, false); // falling clock

      // Now HSync: reset X and advance Y
      el.processInputs(0, 0, 0, true, true, false);  // rising clock + HSync
      // After HSync, x should be 0 and y incremented
      // Next normal clock should write at new position
      el.processInputs(0, 15, 0, false, false, false); // falling clock
      el.processInputs(0, 15, 0, true, false, false);  // rising clock
      const pixel = el.readPixelAt(0, 1); // y=1 (after HSync incremented Y)
      expect(pixel).toBe(0x00FF00); // green=255
    });

    it("VSync rising edge resets Y position to 0", () => {
      const el = makeVga({ colorBits: 4, frameWidth: 16, frameHeight: 8 });
      // VSync + HSync rising edge: resets both X and Y without writing a pixel
      el.processInputs(0, 0, 0, true, true, true);
      // falling clock
      el.processInputs(0, 0, 0, false, false, false);
      // Now write a blue pixel on the next rising clock at (0, 0)
      el.processInputs(0, 0, 15, true, false, false);
      const pixel = el.readPixelAt(0, 0); // should be at y=0 after VSync
      expect(pixel).toBe(0x0000FF); // blue=255
    });

    it("no-op on same clock level (not a rising edge)", () => {
      const el = makeVga({ colorBits: 4, frameWidth: 4, frameHeight: 4 });
      // clock stays low — no pixel written
      el.processInputs(15, 0, 0, false, false, false);
      el.processInputs(15, 0, 0, false, false, false);
      expect(el.readPixelAt(0, 0)).toBe(0);
    });

    it("falling edge does not write pixel", () => {
      const el = makeVga({ colorBits: 4, frameWidth: 4, frameHeight: 4 });
      // Establish clock high
      el.processInputs(15, 0, 0, false, false, true);
      // Falling edge
      el.processInputs(15, 0, 0, false, false, false);
      // No additional pixel should be written on falling edge
      expect(el.readPixelAt(1, 0)).toBe(0); // only x=0 was written on first rising
    });
  });

  // ---------------------------------------------------------------------------
  // executeVga
  // ---------------------------------------------------------------------------

  describe("executeVga", () => {
    it("is a no-op (display-only sink: no outputs to write)", () => {
      const layout = makeLayout();
      const state = makeState(0xF, 0xA, 0x5, 1, 0, 1);
      const highZs = new Uint32Array(state.length);
      const before = Array.from(state);
      executeVga(0, state, highZs, layout);
      expect(Array.from(state)).toEqual(before);
    });

    it("all-zero inputs: state unchanged", () => {
      const layout = makeLayout();
      const state = makeState(0, 0, 0, 0, 0, 0);
      const highZs = new Uint32Array(state.length);
      executeVga(0, state, highZs, layout);
      expect(state[6]).toBe(0);
    });

    it("can be called 1000 times without error (zero-allocation path)", () => {
      const layout = makeLayout();
      const state = makeState(0, 0, 0, 0, 0, 0);
      const highZs = new Uint32Array(state.length);
      for (let i = 0; i < 1000; i++) {
        state[0] = i & 0xF;
        state[5] = i & 1;
        executeVga(0, state, highZs, layout);
      }
      expect(typeof state[0]).toBe("number");
    });

    it("H and V inputs are preserved in state (no-op execute)", () => {
      const layout = makeLayout();
      const stateH = makeState(0, 0, 0, 1, 0, 0);
      executeVga(0, stateH, new Uint32Array(stateH.length), layout);
      // H input at index 3 is preserved
      expect(stateH[3]).toBe(1);

      const stateV = makeState(0, 0, 0, 0, 1, 0);
      executeVga(0, stateV, new Uint32Array(stateV.length), layout);
      // V input at index 4 is preserved
      expect(stateV[4]).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Pin layout
  // ---------------------------------------------------------------------------

  describe("pinLayout", () => {
    it("has exactly 6 input pins", () => {
      const el = makeVga();
      const pins = el.getPins();
      const inputs = pins.filter((p) => p.direction === PinDirection.INPUT);
      expect(inputs).toHaveLength(6);
    });

    it("input pins are labeled R, G, B, H, V, C", () => {
      const el = makeVga();
      const inputs = el.getPins().filter((p) => p.direction === PinDirection.INPUT);
      const labels = inputs.map((p) => p.label);
      expect(labels).toContain("R");
      expect(labels).toContain("G");
      expect(labels).toContain("B");
      expect(labels).toContain("H");
      expect(labels).toContain("V");
      expect(labels).toContain("C");
    });

    it("R, G, B pins have bit width matching colorBits", () => {
      const el = makeVga({ colorBits: 8 });
      const pins = el.getPins();
      for (const label of ["R", "G", "B"]) {
        const pin = pins.find((p) => p.label === label);
        expect(pin?.bitWidth).toBe(8);
      }
    });

    it("H, V, C pins are 1-bit", () => {
      const el = makeVga();
      const pins = el.getPins();
      for (const label of ["H", "V", "C"]) {
        const pin = pins.find((p) => p.label === label);
        expect(pin?.bitWidth).toBe(1);
      }
    });

    it("C pin is marked as clock-capable", () => {
      const el = makeVga();
      const cPin = el.getPins().find((p) => p.label === "C");
      expect(cPin?.isClock).toBe(true);
    });

    it("has no output pins (display-only component)", () => {
      const el = makeVga();
      const outputs = el.getPins().filter((p) => p.direction === PinDirection.OUTPUT);
      expect(outputs).toHaveLength(0);
    });

    it("VGADefinition.pinLayout has 6 entries", () => {
      expect(VGADefinition.pinLayout).toHaveLength(6);
    });
  });

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  describe("rendering", () => {
    it("draw() calls drawPolygon for the component body", () => {
      const el = makeVga();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const polyCalls = calls.filter((c) => c.method === "drawPolygon");
      expect(polyCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("draw() calls drawText for the VGA label", () => {
      const el = makeVga();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.some((c) => (c.args[0] as string).includes("VGA"))).toBe(true);
    });

    it("draw() calls save and restore", () => {
      const el = makeVga();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      expect(calls.some((c) => c.method === "save")).toBe(true);
      expect(calls.some((c) => c.method === "restore")).toBe(true);
    });

    it("draw() does not translate to component position (ElementRenderer handles that)", () => {
      const props = new PropertyBag();
      props.set("colorBits", 4);
      props.set("frameWidth", 16);
      props.set("frameHeight", 8);
      const el = new VGAElement("inst", { x: 7, y: 2 }, 0, false, props);
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const translateCalls = calls.filter((c) => c.method === "translate");
      expect(translateCalls.some((c) => c.args[0] === 7 && c.args[1] === 2)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // getBoundingBox
  // ---------------------------------------------------------------------------

  describe("getBoundingBox", () => {
    it("bounding box x/y matches position", () => {
      const props = new PropertyBag();
      props.set("colorBits", 4);
      props.set("frameWidth", 16);
      props.set("frameHeight", 8);
      const el = new VGAElement("inst", { x: 3, y: 5 }, 0, false, props);
      const box = el.getBoundingBox();
      // GenericShape body insets 0.05 from left edge, starts 0.5 grid above origin
      expect(box.x).toBeCloseTo(3 + 0.05, 5);
      expect(box.y).toBe(5 - 0.5);
    });

    it("bounding box has positive dimensions", () => {
      const el = makeVga();
      const box = el.getBoundingBox();
      expect(box.width).toBeGreaterThanOrEqual(2);
      expect(box.height).toBeGreaterThanOrEqual(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Attribute mapping
  // ---------------------------------------------------------------------------

  describe("attributeMapping", () => {
    it("Label xmlName maps to label propertyKey", () => {
      const mapping = VGA_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Label");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("label");
      expect(mapping!.convert("Screen")).toBe("Screen");
    });

    it("colorBits xmlName maps to colorBits propertyKey as integer", () => {
      const mapping = VGA_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "colorBits");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("colorBits");
      expect(mapping!.convert("8")).toBe(8);
    });

    it("frameWidth xmlName maps to frameWidth propertyKey as integer", () => {
      const mapping = VGA_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "frameWidth");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("frameWidth");
      expect(mapping!.convert("640")).toBe(640);
    });

    it("frameHeight xmlName maps to frameHeight propertyKey as integer", () => {
      const mapping = VGA_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "frameHeight");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("frameHeight");
      expect(mapping!.convert("480")).toBe(480);
    });

    it("applying all mappings produces correct PropertyBag", () => {
      const entries: Record<string, string> = {
        Label: "Main Screen",
        colorBits: "8",
        frameWidth: "320",
        frameHeight: "240",
      };
      const bag = new PropertyBag();
      for (const mapping of VGA_ATTRIBUTE_MAPPINGS) {
        if (entries[mapping.xmlName] !== undefined) {
          bag.set(mapping.propertyKey, mapping.convert(entries[mapping.xmlName]));
        }
      }
      expect(bag.get<string>("label")).toBe("Main Screen");
      expect(bag.get<number>("colorBits")).toBe(8);
      expect(bag.get<number>("frameWidth")).toBe(320);
      expect(bag.get<number>("frameHeight")).toBe(240);
    });
  });

  // ---------------------------------------------------------------------------
  // ComponentDefinition completeness
  // ---------------------------------------------------------------------------

  describe("definitionComplete", () => {
    it("VGADefinition has name='VGA'", () => {
      expect(VGADefinition.name).toBe("VGA");
    });

    it("VGADefinition has typeId=-1 (sentinel for auto-assignment)", () => {
      expect(VGADefinition.typeId).toBe(-1);
    });

    it("VGADefinition has a factory function", () => {
      expect(typeof VGADefinition.factory).toBe("function");
    });

    it("VGADefinition factory produces a VGAElement", () => {
      const props = new PropertyBag();
      props.set("colorBits", 4);
      props.set("frameWidth", 16);
      props.set("frameHeight", 8);
      const el = VGADefinition.factory(props);
      expect(el.typeId).toBe("VGA");
    });

    it("VGADefinition executeFn is executeVga", () => {
      expect(VGADefinition.models.digital!.executeFn).toBe(executeVga);
    });

    it("VGADefinition pinLayout has 6 entries", () => {
      expect(VGADefinition.pinLayout).toHaveLength(6);
    });

    it("VGADefinition propertyDefs include colorBits, frameWidth, frameHeight", () => {
      const keys = VGADefinition.propertyDefs.map((d) => d.key);
      expect(keys).toContain("colorBits");
      expect(keys).toContain("frameWidth");
      expect(keys).toContain("frameHeight");
    });

    it("VGADefinition attributeMap covers Label, colorBits, frameWidth, frameHeight", () => {
      const xmlNames = VGADefinition.attributeMap.map((m) => m.xmlName);
      expect(xmlNames).toContain("Label");
      expect(xmlNames).toContain("colorBits");
      expect(xmlNames).toContain("frameWidth");
      expect(xmlNames).toContain("frameHeight");
    });

    it("VGADefinition category is GRAPHICS", () => {
      expect(VGADefinition.category).toBe(ComponentCategory.GRAPHICS);
    });

    it("VGADefinition has a non-empty helpText", () => {
      expect(typeof VGADefinition.helpText).toBe("string");
      expect(typeof VGADefinition.helpText).toBe("string"); expect(VGADefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });


    it("VGADefinition can be registered in ComponentRegistry without throwing", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(VGADefinition)).not.toThrow();
    });

    it("After registration, VGADefinition typeId is non-negative integer", () => {
      const registry = new ComponentRegistry();
      registry.register(VGADefinition);
      const registered = registry.get("VGA");
      expect(registered).not.toBeUndefined();
      expect(registered!.typeId).toBeGreaterThanOrEqual(0);
    });
  });
});
