/**
 * Tests for the Probe component.
 *
 * Covers:
 *   - executeProbe: copies input to output/storage slot
 *   - Pin layout: one input, one output (storage slot)
 *   - probeMode and intFormat properties
 *   - Rendering: circle symbol + label
 *   - Attribute mapping: Label, Bits, intFormat, ProbeMode
 *   - ComponentDefinition completeness
 */

import { describe, it, expect } from "vitest";
import {
  ProbeElement,
  executeProbe,
  ProbeDefinition,
  PROBE_ATTRIBUTE_MAPPINGS,
} from "../probe.js";
import { PropertyBag } from "../../../core/properties.js";
import { PinDirection } from "../../../core/pin.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import type { ComponentLayout } from "../../../core/registry.js";
import type { RenderContext, Point, TextAnchor, FontSpec, PathData } from "../../../core/renderer-interface.js";
import type { ThemeColor } from "../../../core/renderer-interface.js";
import type { SparseSolver } from "../../../analog/sparse-solver.js";

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

function makeProbe(overrides?: {
  label?: string;
  bitWidth?: number;
  intFormat?: string;
  probeMode?: string;
}): ProbeElement {
  const props = new PropertyBag();
  props.set("label", overrides?.label ?? "");
  props.set("bitWidth", overrides?.bitWidth ?? 1);
  props.set("intFormat", overrides?.intFormat ?? "hex");
  props.set("probeMode", overrides?.probeMode ?? "VALUE");
  return new ProbeElement("test-probe-001", { x: 0, y: 0 }, 0, false, props);
}

// ---------------------------------------------------------------------------
// executeProbe tests
// ---------------------------------------------------------------------------

describe("Probe", () => {
  describe("execute", () => {
    it("executeProbe copies input value to output slot", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([0xAB], 1);
      const highZs = new Uint32Array(state.length);
      executeProbe(0, state, highZs, layout);
      expect(state[1]).toBe(0xAB);
    });

    it("executeProbe with input=0 stores 0", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([0], 1);
      const highZs = new Uint32Array(state.length);
      executeProbe(0, state, highZs, layout);
      expect(state[1]).toBe(0);
    });

    it("executeProbe with input=0xFFFFFFFF stores 0xFFFFFFFF", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([0xFFFFFFFF], 1);
      const highZs = new Uint32Array(state.length);
      executeProbe(0, state, highZs, layout);
      expect(state[1]).toBe(0xFFFFFFFF);
    });

    it("executeProbe can be called 1000 times without error", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([0x55], 1);
      const highZs = new Uint32Array(state.length);
      for (let i = 0; i < 1000; i++) {
        state[0] = i & 0xFFFFFFFF;
        executeProbe(0, state, highZs, layout);
      }
      expect(typeof state[1]).toBe("number");
    });
  });

  // ---------------------------------------------------------------------------
  // Probe value reading concept
  // ---------------------------------------------------------------------------

  describe("probeValueReading", () => {
    it("probe stores last seen input in output slot after execute", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([42], 1);
      const highZs = new Uint32Array(state.length);
      executeProbe(0, state, highZs, layout);
      expect(state[1]).toBe(42);

      // Update input and re-execute
      state[0] = 99;
      executeProbe(0, state, highZs, layout);
      expect(state[1]).toBe(99);
    });
  });

  // ---------------------------------------------------------------------------
  // radix display concept
  // ---------------------------------------------------------------------------

  describe("radixDisplay", () => {
    it("Probe stores intFormat='hex' property correctly", () => {
      const el = makeProbe({ intFormat: "hex" });
      expect(el.intFormat).toBe("hex");
    });

    it("Probe stores intFormat='bin' property correctly", () => {
      const el = makeProbe({ intFormat: "bin" });
      expect(el.intFormat).toBe("bin");
    });

    it("Probe stores intFormat='dec' property correctly", () => {
      const el = makeProbe({ intFormat: "dec" });
      expect(el.intFormat).toBe("dec");
    });

    it("Probe stores intFormat='oct' property correctly", () => {
      const el = makeProbe({ intFormat: "oct" });
      expect(el.intFormat).toBe("oct");
    });
  });

  // ---------------------------------------------------------------------------
  // probeMode
  // ---------------------------------------------------------------------------

  describe("probeMode", () => {
    it("probeMode defaults to VALUE", () => {
      const el = makeProbe();
      expect(el.probeMode).toBe("VALUE");
    });

    it("probeMode=UP stored correctly", () => {
      const el = makeProbe({ probeMode: "UP" });
      expect(el.probeMode).toBe("UP");
    });

    it("probeMode=DOWN stored correctly", () => {
      const el = makeProbe({ probeMode: "DOWN" });
      expect(el.probeMode).toBe("DOWN");
    });

    it("probeMode=BOTH stored correctly", () => {
      const el = makeProbe({ probeMode: "BOTH" });
      expect(el.probeMode).toBe("BOTH");
    });
  });

  // ---------------------------------------------------------------------------
  // Pin layout
  // ---------------------------------------------------------------------------

  describe("pinLayout", () => {
    it("Probe has 1 input pin labeled 'in'", () => {
      const el = makeProbe();
      const inputs = el.getPins().filter((p) => p.direction === PinDirection.INPUT);
      expect(inputs).toHaveLength(1);
      expect(inputs[0].label).toBe("in");
    });

    it("Probe bitWidth=8 has input pin with bitWidth=8", () => {
      const el = makeProbe({ bitWidth: 8 });
      const input = el.getPins().find((p) => p.direction === PinDirection.INPUT);
      expect(input!.bitWidth).toBe(8);
    });

    it("ProbeDefinition.pinLayout has 1 entry", () => {
      expect(ProbeDefinition.pinLayout).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  describe("draw", () => {
    it("draw renders text only, no body rect (matches Java ProbeShape)", () => {
      const el = makeProbe();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const rects = calls.filter((c) => c.method === "drawRect");
      expect(rects).toHaveLength(0);
      const circles = calls.filter((c) => c.method === "drawCircle");
      expect(circles).toHaveLength(0);
    });

    it("draw calls save and restore", () => {
      const el = makeProbe();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.some((c) => c.method === "save")).toBe(true);
      expect(calls.some((c) => c.method === "restore")).toBe(true);
    });

    it("draw renders label when set", () => {
      const el = makeProbe({ label: "P1" });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.some((c) => c.args[0] === "P1")).toBe(true);
    });

    it("draw renders '?' placeholder when label is empty (matches Java ProbeShape)", () => {
      const el = makeProbe({ label: "" });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.length).toBeGreaterThanOrEqual(1);
      expect(textCalls.some((c) => c.args[0] === "?")).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Attribute mapping
  // ---------------------------------------------------------------------------

  describe("attributeMapping", () => {
    it("Label maps to 'label'", () => {
      const m = PROBE_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Label");
      expect(m).toBeDefined();
      expect(m!.propertyKey).toBe("label");
      expect(m!.convert("P1")).toBe("P1");
    });

    it("Bits maps to 'bitWidth' as integer", () => {
      const m = PROBE_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Bits");
      expect(m).toBeDefined();
      expect(m!.propertyKey).toBe("bitWidth");
      expect(m!.convert("8")).toBe(8);
    });

    it("intFormat maps to 'intFormat'", () => {
      const m = PROBE_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "intFormat");
      expect(m).toBeDefined();
      expect(m!.propertyKey).toBe("intFormat");
      expect(m!.convert("bin")).toBe("bin");
    });

    it("ProbeMode maps to 'probeMode'", () => {
      const m = PROBE_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "ProbeMode");
      expect(m).toBeDefined();
      expect(m!.propertyKey).toBe("probeMode");
      expect(m!.convert("UP")).toBe("UP");
    });
  });

  // ---------------------------------------------------------------------------
  // ComponentDefinition completeness
  // ---------------------------------------------------------------------------

  describe("definitionComplete", () => {
    it("ProbeDefinition name is 'Probe'", () => {
      expect(ProbeDefinition.name).toBe("Probe");
    });

    it("ProbeDefinition typeId is -1 (sentinel)", () => {
      expect(ProbeDefinition.typeId).toBe(-1);
    });

    it("ProbeDefinition factory produces a ProbeElement", () => {
      const props = new PropertyBag();
      props.set("label", "");
      props.set("bitWidth", 1);
      props.set("intFormat", "hex");
      props.set("probeMode", "VALUE");
      const el = ProbeDefinition.factory(props);
      expect(el.typeId).toBe("Probe");
    });

    it("ProbeDefinition executeFn is executeProbe", () => {
      expect(ProbeDefinition.executeFn).toBe(executeProbe);
    });

    it("ProbeDefinition category is IO", () => {
      expect(ProbeDefinition.category).toBe(ComponentCategory.IO);
    });

    it("ProbeDefinition has non-empty helpText", () => {
      expect(typeof ProbeDefinition.helpText).toBe("string"); expect(ProbeDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });

    it("ProbeDefinition can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(ProbeDefinition)).not.toThrow();
    });

    it("ProbeElement.getHelpText() contains 'Probe'", () => {
      const el = makeProbe();
      expect(el.getHelpText()).toContain("Probe");
    });
  });

  // ---------------------------------------------------------------------------
  // AnalogProbe tests
  // ---------------------------------------------------------------------------

  describe("AnalogProbe", () => {
    it("stamp_is_noop calls no solver methods", () => {
      const props = new PropertyBag();
      const stampCalls: string[] = [];

      const mockSolver: SparseSolver = {
        stamp: () => stampCalls.push("stamp"),
        stampRHS: () => stampCalls.push("stampRHS"),
        beginAssembly: () => {},
        finalize: () => {},
        solve: () => new Float64Array([]),
      };

      const analogElement = ProbeDefinition.analogFactory!(
        new Map([["in", 3]]),
        [],
        -1,
        props,
        () => 0,
      );
      Object.assign(analogElement, { pinNodeIds: [3] });

      analogElement.stamp(mockSolver);

      expect(stampCalls).toHaveLength(0);
    });

    it("reads_node_voltage returns voltage at node index", () => {
      const props = new PropertyBag();
      const analogElement = ProbeDefinition.analogFactory!(
        new Map([["in", 3]]),
        [],
        -1,
        props,
        () => 0,
      );
      Object.assign(analogElement, { pinNodeIds: [3] });

      const voltages = new Float64Array(5);
      voltages[3] = 4.72;

      const voltage = (analogElement as any).getVoltage(voltages);
      expect(voltage).toBe(4.72);
    });

    it("definition_has_engine_type_both", () => {
      expect(ProbeDefinition.engineType).toBe("both");
    });

    it("appears_in_both_palettes", () => {
      const registry = new ComponentRegistry();
      registry.register(ProbeDefinition);

      const digitalComponents = registry.getByEngineType("digital");
      const analogComponents = registry.getByEngineType("analog");

      const probeInDigital = digitalComponents.some((c) => c.name === "Probe");
      const probeInAnalog = analogComponents.some((c) => c.name === "Probe");

      expect(probeInDigital).toBe(true);
      expect(probeInAnalog).toBe(true);
    });

    it("analogFactory returns AnalogElement with correct properties", () => {
      const props = new PropertyBag();
      const analogElement = ProbeDefinition.analogFactory!(
        new Map([["in", 5]]),
        [],
        -1,
        props,
        () => 0,
      );
      Object.assign(analogElement, { pinNodeIds: [5] });

      expect(analogElement.pinNodeIds).toEqual([5]);
      expect(analogElement.branchIndex).toBe(-1);
      expect(analogElement.isNonlinear).toBe(false);
      expect(analogElement.isReactive).toBe(false);
    });
  });
});
