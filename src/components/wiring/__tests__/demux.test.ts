/**
 * Tests for the Demultiplexer component.
 *
 * Covers:
 *   - executeDemux: truth table for 2-output and 4-output configs
 *   - executeDemux: multi-bit operation, unselected outputs = 0
 *   - Pin layout: correct counts and labels
 *   - Attribute mapping
 *   - Rendering
 *   - ComponentDefinition completeness
 */

import { describe, it, expect } from "vitest";
import {
  DemuxElement,
  executeDemux,
  DemuxDefinition,
  DEMUX_ATTRIBUTE_MAPPINGS,
  buildDemuxPinDeclarations,
} from "../demux.js";
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
    inputCount: () => inputCount,
    inputOffset: () => 0,
    outputCount: () => outputCount,
    outputOffset: () => inputCount,
    stateOffset: () => inputCount + outputCount,
  };
}

function makeState(inputs: number[], outputCount: number): Uint32Array {
  const arr = new Uint32Array(inputs.length + outputCount);
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

function makeDemux(overrides?: { selectorBits?: number; bitWidth?: number }): DemuxElement {
  const props = new PropertyBag();
  props.set("selectorBits", overrides?.selectorBits ?? 1);
  props.set("bitWidth", overrides?.bitWidth ?? 1);
  return new DemuxElement("test-demux-001", { x: 0, y: 0 }, 0, false, props);
}

// ---------------------------------------------------------------------------
// executeDemux — logic correctness
// ---------------------------------------------------------------------------

describe("Demultiplexer", () => {
  describe("execute2Input", () => {
    it("sel=0, in=0xAA routes to out_0; out_1=0", () => {
      // inputs: [sel=0, in=0xAA]; outputs: [out_0, out_1]
      const layout = makeLayout(2, 2);
      const state = makeState([0, 0xAA], 2);
      executeDemux(0, state, layout);
      expect(state[2]).toBe(0xAA); // out_0
      expect(state[3]).toBe(0);    // out_1
    });

    it("sel=1, in=0xBB routes to out_1; out_0=0", () => {
      const layout = makeLayout(2, 2);
      const state = makeState([1, 0xBB], 2);
      executeDemux(0, state, layout);
      expect(state[2]).toBe(0);    // out_0
      expect(state[3]).toBe(0xBB); // out_1
    });
  });

  describe("executeMultiInput", () => {
    it("4-output demux: sel=2 routes to out_2", () => {
      // inputs: [sel=2, in=0x55]; outputs: [out_0..out_3]
      const layout = makeLayout(2, 4);
      const state = makeState([2, 0x55], 4);
      executeDemux(0, state, layout);
      expect(state[2]).toBe(0);    // out_0
      expect(state[3]).toBe(0);    // out_1
      expect(state[4]).toBe(0x55); // out_2
      expect(state[5]).toBe(0);    // out_3
    });

    it("4-output demux: sel=3 routes to out_3, all others 0", () => {
      const layout = makeLayout(2, 4);
      const state = makeState([3, 0xFF], 4);
      executeDemux(0, state, layout);
      expect(state[2]).toBe(0);
      expect(state[3]).toBe(0);
      expect(state[4]).toBe(0);
      expect(state[5]).toBe(0xFF);
    });
  });

  describe("multiBit", () => {
    it("32-bit value routed to selected output", () => {
      const layout = makeLayout(2, 2);
      const state = makeState([1, 0xDEADBEEF], 2);
      executeDemux(0, state, layout);
      expect(state[2]).toBe(0);
      expect(state[3]).toBe(0xDEADBEEF >>> 0);
    });

    it("unselected outputs are always 0 regardless of previous state", () => {
      const layout = makeLayout(2, 2);
      const state = makeState([0, 0xAA], 2);
      // Pre-populate outputs with garbage
      state[2] = 0xFF;
      state[3] = 0xFF;
      executeDemux(0, state, layout);
      expect(state[2]).toBe(0xAA);
      expect(state[3]).toBe(0); // cleared
    });
  });

  // ---------------------------------------------------------------------------
  // Pin layout
  // ---------------------------------------------------------------------------

  describe("pinLayout1BitSelector", () => {
    it("1-bit selector produces 2 input pins (sel + in) and 2 output pins", () => {
      const el = makeDemux({ selectorBits: 1 });
      const pins = el.getPins();
      const inputs = pins.filter((p) => p.direction === PinDirection.INPUT);
      const outputs = pins.filter((p) => p.direction === PinDirection.OUTPUT);
      expect(inputs).toHaveLength(2);
      expect(outputs).toHaveLength(2);
    });

    it("input pins labeled 'sel' and 'in'", () => {
      const el = makeDemux({ selectorBits: 1 });
      const inputs = el.getPins().filter((p) => p.direction === PinDirection.INPUT);
      const labels = inputs.map((p) => p.label);
      expect(labels).toContain("sel");
      expect(labels).toContain("in");
    });

    it("output pins labeled 'out_0' and 'out_1'", () => {
      const el = makeDemux({ selectorBits: 1 });
      const outputs = el.getPins().filter((p) => p.direction === PinDirection.OUTPUT);
      expect(outputs.map((p) => p.label)).toEqual(["out_0", "out_1"]);
    });
  });

  describe("pinLayout2BitSelector", () => {
    it("2-bit selector produces 2 input pins and 4 output pins", () => {
      const el = makeDemux({ selectorBits: 2 });
      const pins = el.getPins();
      const inputs = pins.filter((p) => p.direction === PinDirection.INPUT);
      const outputs = pins.filter((p) => p.direction === PinDirection.OUTPUT);
      expect(inputs).toHaveLength(2);
      expect(outputs).toHaveLength(4);
    });

    it("4 output pins labeled out_0..out_3", () => {
      const el = makeDemux({ selectorBits: 2 });
      const outputs = el.getPins().filter((p) => p.direction === PinDirection.OUTPUT);
      expect(outputs.map((p) => p.label)).toEqual(["out_0", "out_1", "out_2", "out_3"]);
    });
  });

  describe("pinLayoutFromDeclarations", () => {
    it("buildDemuxPinDeclarations(1,1) produces 2 inputs + 2 outputs", () => {
      const decls = buildDemuxPinDeclarations(1, 1);
      expect(decls.filter((d) => d.direction === PinDirection.INPUT)).toHaveLength(2);
      expect(decls.filter((d) => d.direction === PinDirection.OUTPUT)).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Attribute mapping
  // ---------------------------------------------------------------------------

  describe("attributeMapping", () => {
    it("Bits and Selector Bits map correctly", () => {
      const entries: Record<string, string> = {
        Bits: "4",
        "Selector Bits": "2",
      };
      const bag = new PropertyBag();
      for (const mapping of DEMUX_ATTRIBUTE_MAPPINGS) {
        if (entries[mapping.xmlName] !== undefined) {
          bag.set(mapping.propertyKey, mapping.convert(entries[mapping.xmlName]));
        }
      }
      expect(bag.get<number>("bitWidth")).toBe(4);
      expect(bag.get<number>("selectorBits")).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  describe("draw", () => {
    it("draw() calls drawPolygon for trapezoid body", () => {
      const el = makeDemux();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const polygonCalls = calls.filter((c) => c.method === "drawPolygon");
      expect(polygonCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("draw() renders 'DEMUX' text", () => {
      const el = makeDemux();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.some((c) => c.args[0] === "DEMUX")).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // ComponentDefinition completeness
  // ---------------------------------------------------------------------------

  describe("definitionComplete", () => {
    it("DemuxDefinition has name='Demultiplexer'", () => {
      expect(DemuxDefinition.name).toBe("Demultiplexer");
    });

    it("DemuxDefinition has typeId=-1 (sentinel)", () => {
      expect(DemuxDefinition.typeId).toBe(-1);
    });

    it("DemuxDefinition factory produces a DemuxElement with correct typeId", () => {
      const props = new PropertyBag();
      props.set("selectorBits", 1);
      props.set("bitWidth", 1);
      const el = DemuxDefinition.factory(props);
      expect(el.typeId).toBe("Demultiplexer");
    });

    it("DemuxDefinition has executeFn=executeDemux", () => {
      expect(DemuxDefinition.executeFn).toBe(executeDemux);
    });

    it("DemuxDefinition has non-empty pinLayout", () => {
      expect(DemuxDefinition.pinLayout.length).toBeGreaterThan(0);
    });

    it("DemuxDefinition has non-empty propertyDefs", () => {
      expect(DemuxDefinition.propertyDefs.length).toBeGreaterThan(0);
    });

    it("DemuxDefinition propertyDefs include selectorBits and bitWidth", () => {
      const keys = DemuxDefinition.propertyDefs.map((d) => d.key);
      expect(keys).toContain("selectorBits");
      expect(keys).toContain("bitWidth");
    });

    it("DemuxDefinition attributeMap covers Bits and Selector Bits", () => {
      const xmlNames = DemuxDefinition.attributeMap.map((m) => m.xmlName);
      expect(xmlNames).toContain("Bits");
      expect(xmlNames).toContain("Selector Bits");
    });

    it("DemuxDefinition category is WIRING", () => {
      expect(DemuxDefinition.category).toBe(ComponentCategory.WIRING);
    });

    it("DemuxDefinition has a non-empty helpText", () => {
      expect(typeof DemuxDefinition.helpText).toBe("string");
      expect(typeof DemuxDefinition.helpText).toBe("string"); expect(DemuxDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });

    it("DemuxDefinition can be registered in ComponentRegistry without throwing", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(DemuxDefinition)).not.toThrow();
    });

    it("After registration, typeId is a non-negative integer", () => {
      const registry = new ComponentRegistry();
      registry.register(DemuxDefinition);
      const registered = registry.get("Demultiplexer");
      expect(registered).not.toBeUndefined();
      expect(registered!.typeId).toBeGreaterThanOrEqual(0);
    });
  });
});
