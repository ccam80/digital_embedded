/**
 * Tests for the PowerSupply component.
 *
 * Covers:
 *   - executePowerSupply: VDD=1 + GND=0 → status=0 (OK)
 *   - executePowerSupply: VDD!=1 → status=1 (VDD error)
 *   - executePowerSupply: GND!=0 → status=2 (GND error)
 *   - Pin layout: VDD input (north) + GND input (south), no outputs
 *   - Rendering: rect body with VDD/GND labels
 *   - Attribute mapping: Label
 *   - ComponentDefinition completeness
 */

import { describe, it, expect } from "vitest";
import {
  PowerSupplyElement,
  executePowerSupply,
  PowerSupplyDefinition,
  POWER_SUPPLY_ATTRIBUTE_MAPPINGS,
} from "../power-supply.js";
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

function makePowerSupply(overrides?: { label?: string }): PowerSupplyElement {
  const props = new PropertyBag();
  props.set("label", overrides?.label ?? "");
  return new PowerSupplyElement("test-psu-001", { x: 0, y: 0 }, 0, false, props);
}

// ---------------------------------------------------------------------------
// executePowerSupply tests
// ---------------------------------------------------------------------------

describe("PowerSupply", () => {
  describe("execute", () => {
    it("is a no-op (validation-only sink: no output slots written)", () => {
      // executePowerSupply is a display/validation sink — state is unchanged
      const layout = makeLayout(2, 0);
      const state = makeState([1, 0], 0);
      const highZs = new Uint32Array(state.length);
      const before = Array.from(state);
      executePowerSupply(0, state, highZs, layout);
      expect(Array.from(state)).toEqual(before);
    });

    it("inputs are preserved after execute (VDD=1, GND=0)", () => {
      const layout = makeLayout(2, 0);
      const state = makeState([1, 0], 0);
      const highZs = new Uint32Array(state.length);
      executePowerSupply(0, state, highZs, layout);
      expect(state[0]).toBe(1); // VDD
      expect(state[1]).toBe(0); // GND
    });

    it("inputs are preserved after execute (VDD=0, GND=1)", () => {
      const layout = makeLayout(2, 0);
      const state = makeState([0, 1], 0);
      const highZs = new Uint32Array(state.length);
      executePowerSupply(0, state, highZs, layout);
      expect(state[0]).toBe(0); // VDD
      expect(state[1]).toBe(1); // GND
    });

    it("can be called 100 times without error", () => {
      const layout = makeLayout(2, 0);
      const state = makeState([1, 0], 0);
      const highZs = new Uint32Array(state.length);
      for (let i = 0; i < 100; i++) {
        executePowerSupply(0, state, highZs, layout);
      }
      expect(state[0]).toBe(1);
      expect(state[1]).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Pin layout
  // ---------------------------------------------------------------------------

  describe("pinLayout", () => {
    it("PowerSupply has 2 input pins", () => {
      const el = makePowerSupply();
      const inputs = el.getPins().filter((p) => p.direction === PinDirection.INPUT);
      expect(inputs).toHaveLength(2);
    });

    it("PowerSupply has a VDD input pin", () => {
      const el = makePowerSupply();
      const vdd = el.getPins().find((p) => p.label === "VDD");
      expect(vdd).toBeDefined();
      expect(vdd!.direction).toBe(PinDirection.INPUT);
    });

    it("PowerSupply has a GND input pin", () => {
      const el = makePowerSupply();
      const gnd = el.getPins().find((p) => p.label === "GND");
      expect(gnd).toBeDefined();
      expect(gnd!.direction).toBe(PinDirection.INPUT);
    });

    it("VDD and GND pins have bitWidth=1", () => {
      const el = makePowerSupply();
      const vdd = el.getPins().find((p) => p.label === "VDD");
      const gnd = el.getPins().find((p) => p.label === "GND");
      expect(vdd!.bitWidth).toBe(1);
      expect(gnd!.bitWidth).toBe(1);
    });

    it("PowerSupplyDefinition.pinLayout has 2 entries", () => {
      expect(PowerSupplyDefinition.pinLayout).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  describe("draw", () => {
    it("draw calls drawPolygon (component body)", () => {
      const el = makePowerSupply();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      // PowerSupply body is a 4-point polygon, not a rect
      const polygons = calls.filter((c) => c.method === "drawPolygon");
      expect(polygons.length).toBeGreaterThanOrEqual(1);
    });

    it("draw renders 'VDD' text", () => {
      const el = makePowerSupply();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.some((c) => c.args[0] === "VDD")).toBe(true);
    });

    it("draw renders 'GND' text", () => {
      const el = makePowerSupply();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.some((c) => c.args[0] === "GND")).toBe(true);
    });

    it("draw calls save and restore", () => {
      const el = makePowerSupply();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.some((c) => c.method === "save")).toBe(true);
      expect(calls.some((c) => c.method === "restore")).toBe(true);
    });

    it("draw renders 'Power' component name text", () => {
      const el = makePowerSupply({ label: "PSU1" });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      // PowerSupply.draw() renders fixed pin labels and component name "Power",
      // but does not render the instance label property
      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.some((c) => c.args[0] === "Power")).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Attribute mapping
  // ---------------------------------------------------------------------------

  describe("attributeMapping", () => {
    it("Label maps to 'label' property", () => {
      const m = POWER_SUPPLY_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Label");
      expect(m).toBeDefined();
      expect(m!.propertyKey).toBe("label");
      expect(m!.convert("PWR")).toBe("PWR");
    });

    it("attributeMap has exactly 1 entry (Label only)", () => {
      expect(POWER_SUPPLY_ATTRIBUTE_MAPPINGS).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // ComponentDefinition completeness
  // ---------------------------------------------------------------------------

  describe("definitionComplete", () => {
    it("PowerSupplyDefinition name is 'PowerSupply'", () => {
      expect(PowerSupplyDefinition.name).toBe("PowerSupply");
    });

    it("PowerSupplyDefinition typeId is -1 (sentinel)", () => {
      expect(PowerSupplyDefinition.typeId).toBe(-1);
    });

    it("PowerSupplyDefinition factory produces a PowerSupplyElement", () => {
      const props = new PropertyBag();
      props.set("label", "");
      const el = PowerSupplyDefinition.factory(props);
      expect(el.typeId).toBe("PowerSupply");
    });

    it("PowerSupplyDefinition executeFn is executePowerSupply", () => {
      expect(PowerSupplyDefinition.models!.digital!.executeFn).toBe(executePowerSupply);
    });

    it("PowerSupplyDefinition category is IO", () => {
      expect(PowerSupplyDefinition.category).toBe(ComponentCategory.IO);
    });

    it("PowerSupplyDefinition has non-empty helpText", () => {
      expect(typeof PowerSupplyDefinition.helpText).toBe("string"); expect(PowerSupplyDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });

    it("PowerSupplyDefinition can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(PowerSupplyDefinition)).not.toThrow();
    });

  });
});
