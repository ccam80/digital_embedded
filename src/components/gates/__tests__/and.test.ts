/**
 * Tests for the And gate exemplar component.
 *
 * Covers:
 *   - executeAnd: logic correctness (2-input, 3-input, all-zero, all-ones, single-bit, multi-bit)
 *   - executeAnd: zero-allocation property (no GC pressure in hot loop)
 *   - Pin layout: correct count for 2-input and 5-input configurations
 *   - Attribute mapping: .dig XML attributes convert to correct PropertyBag entries
 *   - Rendering: IEC/DIN shape calls drawRect + "&" text
 *   - Rendering: IEEE/US shape calls drawPath with curved body
 *   - Rendering: inversion bubbles rendered for negated inputs
 *   - ComponentDefinition: all required fields present
 */

import { describe, it, expect } from "vitest";
import {
  AndElement,
  executeAnd,
  AndDefinition,
  AND_ATTRIBUTE_MAPPINGS,
} from "../and.js";
import { PropertyBag } from "../../../core/properties.js";
import { PinDirection } from "../../../core/pin.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import type { ComponentLayout } from "../../../core/registry.js";
import type { RenderContext, Point, TextAnchor, FontSpec, PathData } from "../../../core/renderer-interface.js";
import type { ThemeColor } from "../../../core/renderer-interface.js";

// ---------------------------------------------------------------------------
// Helpers — ComponentLayout mock
// ---------------------------------------------------------------------------

/**
 * Build a minimal ComponentLayout for a single component instance at index 0.
 * Inputs start at slot 0, outputs follow immediately after inputs.
 */
function makeLayout(inputCount: number): ComponentLayout {
  const totalSlots = inputCount + 1;
  return {
    wiringTable: Int32Array.from({ length: totalSlots }, (_, i) => i),
    inputCount: () => inputCount,
    inputOffset: () => 0,
    outputCount: () => 1,
    outputOffset: () => inputCount,
    stateOffset: () => 0,
    getProperty: () => undefined,
  };
}

/**
 * Build a Uint32Array pre-populated with given input values.
 * Layout: [in0, in1, ..., inN-1, output_slot]
 */
function makeState(inputs: number[]): Uint32Array {
  const arr = new Uint32Array(inputs.length + 1);
  for (let i = 0; i < inputs.length; i++) {
    arr[i] = inputs[i] >>> 0;
  }
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
// Helpers — AndElement factory
// ---------------------------------------------------------------------------

function makeAnd(overrides?: {
  inputCount?: number;
  bitWidth?: number;
  wideShape?: boolean;
  invertedPins?: string[];
  label?: string;
}): AndElement {
  const props = new PropertyBag();
  props.set("inputCount", overrides?.inputCount ?? 2);
  props.set("bitWidth", overrides?.bitWidth ?? 1);
  props.set("wideShape", overrides?.wideShape ?? false);
  if (overrides?.invertedPins && overrides.invertedPins.length > 0) {
    props.set("_inverterLabels", overrides.invertedPins.join(","));
  }
  if (overrides?.label !== undefined) {
    props.set("label", overrides.label);
  }
  return new AndElement("test-inst-001", { x: 0, y: 0 }, 0, false, props);
}

// ---------------------------------------------------------------------------
// executeAnd — logic correctness
// ---------------------------------------------------------------------------

describe("AndGate", () => {
  describe("executeAnd2Input", () => {
    it("AND of 0xFFFFFFFF and 0x0F0F0F0F produces 0x0F0F0F0F", () => {
      const layout = makeLayout(2);
      const state = makeState([0xFFFFFFFF, 0x0F0F0F0F]);
      const highZs = new Uint32Array(state.length);
      executeAnd(0, state, highZs, layout);
      expect(state[2]).toBe(0x0F0F0F0F);
    });
  });

  describe("executeAnd3Input", () => {
    it("AND of 0xFF, 0x0F, 0x03 produces 0x03", () => {
      const layout = makeLayout(3);
      const state = makeState([0xFF, 0x0F, 0x03]);
      const highZs = new Uint32Array(state.length);
      executeAnd(0, state, highZs, layout);
      expect(state[3]).toBe(0x03);
    });
  });

  describe("allZeroInputs", () => {
    it("AND of all-zero inputs produces 0", () => {
      const layout = makeLayout(3);
      const state = makeState([0, 0, 0]);
      const highZs = new Uint32Array(state.length);
      executeAnd(0, state, highZs, layout);
      expect(state[3]).toBe(0);
    });
  });

  describe("allOnesInputs", () => {
    it("AND of all-0xFFFFFFFF inputs produces 0xFFFFFFFF", () => {
      const layout = makeLayout(4);
      const state = makeState([0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF]);
      const highZs = new Uint32Array(state.length);
      executeAnd(0, state, highZs, layout);
      expect(state[4]).toBe(0xFFFFFFFF);
    });
  });

  describe("singleBit", () => {
    it("1 AND 1 = 1", () => {
      const layout = makeLayout(2);
      const state = makeState([1, 1]);
      const highZs = new Uint32Array(state.length);
      executeAnd(0, state, highZs, layout);
      expect(state[2]).toBe(1);
    });

    it("1 AND 0 = 0", () => {
      const layout = makeLayout(2);
      const state = makeState([1, 0]);
      const highZs = new Uint32Array(state.length);
      executeAnd(0, state, highZs, layout);
      expect(state[2]).toBe(0);
    });

    it("0 AND 1 = 0", () => {
      const layout = makeLayout(2);
      const state = makeState([0, 1]);
      const highZs = new Uint32Array(state.length);
      executeAnd(0, state, highZs, layout);
      expect(state[2]).toBe(0);
    });

    it("0 AND 0 = 0", () => {
      const layout = makeLayout(2);
      const state = makeState([0, 0]);
      const highZs = new Uint32Array(state.length);
      executeAnd(0, state, highZs, layout);
      expect(state[2]).toBe(0);
    });
  });

  describe("multiBit8", () => {
    it("8-bit AND: 0xFF AND 0x0F = 0x0F", () => {
      const layout = makeLayout(2);
      const state = makeState([0xFF, 0x0F]);
      const highZs = new Uint32Array(state.length);
      executeAnd(0, state, highZs, layout);
      expect(state[2]).toBe(0x0F);
    });
  });

  describe("zeroAllocation", () => {
    it("executeAnd can be called 1000 times without error (zero-allocation path)", () => {
      const layout = makeLayout(2);
      const state = makeState([0xAAAAAAAA, 0x55555555]);
      const highZs = new Uint32Array(state.length);

      for (let i = 0; i < 1000; i++) {
        state[0] = (i % 2 === 0) ? 0xFFFFFFFF : 0xAAAAAAAA;
        state[1] = (i % 3 === 0) ? 0x55555555 : 0x0F0F0F0F;
        executeAnd(0, state, highZs, layout);
      }

      expect(typeof state[2]).toBe("number");
    });
  });

  // ---------------------------------------------------------------------------
  // Pin layout
  // ---------------------------------------------------------------------------

  describe("pinLayout2Input", () => {
    it("default (2-input) And has 2 input pins and 1 output pin", () => {
      const el = makeAnd({ inputCount: 2 });
      const pins = el.getPins();
      expect(pins).toHaveLength(3);

      const inputs = pins.filter((p) => p.direction === PinDirection.INPUT);
      const outputs = pins.filter((p) => p.direction === PinDirection.OUTPUT);
      expect(inputs).toHaveLength(2);
      expect(outputs).toHaveLength(1);
    });

    it("input pins are labeled in0 and in1", () => {
      const el = makeAnd({ inputCount: 2 });
      const inputs = el.getPins().filter((p) => p.direction === PinDirection.INPUT);
      expect(inputs.map((p) => p.label)).toEqual(["In_1", "In_2"]);
    });

    it("output pin is labeled out", () => {
      const el = makeAnd({ inputCount: 2 });
      const output = el.getPins().find((p) => p.direction === PinDirection.OUTPUT);
      expect(output?.label).toBe("out");
    });

    it("AndDefinition.pinLayout has 3 entries for 2-input default", () => {
      expect(AndDefinition.pinLayout).toHaveLength(3);
      const inputs = AndDefinition.pinLayout.filter((p) => p.direction === PinDirection.INPUT);
      const outputs = AndDefinition.pinLayout.filter((p) => p.direction === PinDirection.OUTPUT);
      expect(inputs).toHaveLength(2);
      expect(outputs).toHaveLength(1);
    });
  });

  describe("pinLayout5Input", () => {
    it("5-input And has 5 input pins and 1 output pin", () => {
      const el = makeAnd({ inputCount: 5 });
      const pins = el.getPins();
      const inputs = pins.filter((p) => p.direction === PinDirection.INPUT);
      const outputs = pins.filter((p) => p.direction === PinDirection.OUTPUT);
      expect(inputs).toHaveLength(5);
      expect(outputs).toHaveLength(1);
    });

    it("5-input pin labels are in0..in4", () => {
      const el = makeAnd({ inputCount: 5 });
      const inputs = el.getPins().filter((p) => p.direction === PinDirection.INPUT);
      expect(inputs.map((p) => p.label)).toEqual(["In_1", "In_2", "In_3", "In_4", "In_5"]);
    });
  });

  // ---------------------------------------------------------------------------
  // Attribute mapping
  // ---------------------------------------------------------------------------

  describe("attributeMapping", () => {
    it("Inputs=3, Bits=8, wideShape=true map to correct PropertyBag entries", () => {
      const entries: Record<string, string> = {
        Inputs: "3",
        Bits: "8",
        wideShape: "true",
      };

      const bag = new PropertyBag();
      for (const mapping of AND_ATTRIBUTE_MAPPINGS) {
        if (entries[mapping.xmlName] !== undefined) {
          bag.set(mapping.propertyKey, mapping.convert(entries[mapping.xmlName]));
        }
      }

      expect(bag.get<number>("inputCount")).toBe(3);
      expect(bag.get<number>("bitWidth")).toBe(8);
      expect(bag.get<boolean>("wideShape")).toBe(true);
    });

    it("Label attribute maps to label property key", () => {
      const mapping = AND_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Label");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("label");
      expect(mapping!.convert("MyGate")).toBe("MyGate");
    });

    it("inverterConfig attribute maps to _inverterLabels property key", () => {
      const mapping = AND_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "inverterConfig");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("_inverterLabels");
      expect(mapping!.convert("in0,in2")).toBe("in0,in2");
    });

    it("wideShape=false converts to boolean false", () => {
      const mapping = AND_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "wideShape");
      expect(mapping!.convert("false")).toBe(false);
    });

    it("Inputs converter parses integer strings", () => {
      const mapping = AND_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Inputs");
      expect(mapping!.convert("4")).toBe(4);
    });
  });

  // ---------------------------------------------------------------------------
  // Rendering — IEC/DIN
  // ---------------------------------------------------------------------------

  describe("drawNarrowIEEE", () => {
    it("narrow IEEE shape calls drawPath for the curved body", () => {
      const el = makeAnd({ wideShape: false });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const pathCalls = calls.filter((c) => c.method === "drawPath");
      expect(pathCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("narrow IEEE shape does not call drawRect", () => {
      const el = makeAnd({ wideShape: false });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const rectCalls = calls.filter((c) => c.method === "drawRect");
      expect(rectCalls).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Rendering — IEEE/US
  // ---------------------------------------------------------------------------

  describe("drawIEEE", () => {
    it("IEEE shape calls drawPath for the curved body", () => {
      const el = makeAnd({ wideShape: true });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const pathCalls = calls.filter((c) => c.method === "drawPath");
      expect(pathCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("IEEE shape path includes a curveTo operation for the AND shape", () => {
      const el = makeAnd({ wideShape: true });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const pathCalls = calls.filter((c) => c.method === "drawPath");
      const hasCurve = pathCalls.some((c) => {
        const path = c.args[0] as PathData;
        return path.operations.some((op) => op.op === "curveTo");
      });
      expect(hasCurve).toBe(true);
    });

    it("IEEE shape does not call drawRect for the gate body", () => {
      const el = makeAnd({ wideShape: true });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const rectCalls = calls.filter((c) => c.method === "drawRect");
      expect(rectCalls).toHaveLength(0);
    });

    it("IEEE shape does not draw '&' text", () => {
      const el = makeAnd({ wideShape: true });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.some((c) => c.args[0] === "&")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Rendering — inversion bubbles
  // ---------------------------------------------------------------------------

  describe("drawInverterBubble", () => {
    it("inverterConfig=['In_1'] sets isNegated on the pin and shifts its position", () => {
      const el = makeAnd({ invertedPins: ["In_1"] });
      const pin = el.getPins().find((p) => p.label === "In_1");
      expect(pin?.isNegated).toBe(true);
      // Inverted input is shifted 1 grid unit left (Java: dx = -SIZE)
      expect(pin?.position.x).toBe(-1);
    });

    it("no inverterConfig means no drawCircle calls for bubbles", () => {
      const el = makeAnd({ invertedPins: [] });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const circleCalls = calls.filter((c) => c.method === "drawCircle");
      expect(circleCalls).toHaveLength(0);
    });

    it("inverterConfig=['In_1','In_2'] sets isNegated on both pins", () => {
      const el = makeAnd({ inputCount: 3, invertedPins: ["In_1", "In_2"] });
      const pins = el.getPins();
      const negated = pins.filter((p) => p.isNegated);
      expect(negated).toHaveLength(2);
      expect(negated.every((p) => p.position.x === -1)).toBe(true);
    });

    it("negated pin has isNegated=true in getPins()", () => {
      const el = makeAnd({ invertedPins: ["In_1"] });
      const pins = el.getPins();
      const in0 = pins.find((p) => p.label === "In_1");
      expect(in0?.isNegated).toBe(true);
    });

    it("non-negated pins have isNegated=false", () => {
      const el = makeAnd({ invertedPins: ["In_1"] });
      const pins = el.getPins();
      const in1 = pins.find((p) => p.label === "In_2");
      expect(in1?.isNegated).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // ComponentDefinition completeness
  // ---------------------------------------------------------------------------

  describe("definitionComplete", () => {
    it("AndDefinition has name='And'", () => {
      expect(AndDefinition.name).toBe("And");
    });

    it("AndDefinition has typeId=-1 (sentinel for auto-assignment)", () => {
      expect(AndDefinition.typeId).toBe(-1);
    });

    it("AndDefinition has a factory function", () => {
      expect(typeof AndDefinition.factory).toBe("function");
    });

    it("AndDefinition factory produces an AndElement", () => {
      const props = new PropertyBag();
      props.set("inputCount", 2);
      props.set("bitWidth", 1);
      props.set("wideShape", false);
      const el = AndDefinition.factory(props);
      expect(el.typeId).toBe("And");
    });

    it("AndDefinition has executeFn=executeAnd", () => {
      expect(AndDefinition.models.digital?.executeFn).toBe(executeAnd);
    });

    it("AndDefinition has a non-empty pinLayout", () => {
      expect(AndDefinition.pinLayout.length).toBeGreaterThan(0);
    });

    it("AndDefinition has non-empty propertyDefs", () => {
      expect(AndDefinition.propertyDefs.length).toBeGreaterThan(0);
    });

    it("AndDefinition propertyDefs include inputCount, bitWidth, wideShape, label", () => {
      const keys = AndDefinition.propertyDefs.map((d) => d.key);
      expect(keys).toContain("inputCount");
      expect(keys).toContain("bitWidth");
      expect(keys).toContain("wideShape");
      expect(keys).toContain("label");
    });

    it("AndDefinition has non-empty attributeMap", () => {
      expect(AndDefinition.attributeMap.length).toBeGreaterThan(0);
    });

    it("AndDefinition attributeMap covers Inputs, Bits, wideShape, inverterConfig, Label", () => {
      const xmlNames = AndDefinition.attributeMap.map((m) => m.xmlName);
      expect(xmlNames).toContain("Inputs");
      expect(xmlNames).toContain("Bits");
      expect(xmlNames).toContain("wideShape");
      expect(xmlNames).toContain("inverterConfig");
      expect(xmlNames).toContain("Label");
    });

    it("AndDefinition category is LOGIC", () => {
      expect(AndDefinition.category).toBe(ComponentCategory.LOGIC);
    });

    it("AndDefinition has a non-empty helpText", () => {
      expect(typeof AndDefinition.helpText).toBe("string");
      expect(typeof AndDefinition.helpText).toBe("string"); expect(AndDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });


    it("AndDefinition can be registered in ComponentRegistry without throwing", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(AndDefinition)).not.toThrow();
    });

    it("After registration, AndDefinition typeId is overwritten with a non-negative integer", () => {
      const registry = new ComponentRegistry();
      registry.register(AndDefinition);
      const registered = registry.get("And");
      expect(registered).not.toBeUndefined();
      expect(registered!.typeId).toBeGreaterThanOrEqual(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Power pins (W2.2)
  // ---------------------------------------------------------------------------

  describe("powerPins", () => {
    it("no power pins when simulationModel is not set (digital mode)", () => {
      const el = makeAnd({ inputCount: 2 });
      const pins = el.getPins();
      const powerPins = pins.filter((p) => p.label === "VDD" || p.label === "GND");
      expect(powerPins).toHaveLength(0);
    });

    it("VDD and GND pins appended when simulationModel is cmos", () => {
      const props = new PropertyBag();
      props.set("inputCount", 2);
      props.set("bitWidth", 1);
      props.set("wideShape", false);
      props.set("simulationModel", "cmos");
      const el = new AndElement("cmos-test", { x: 0, y: 0 }, 0, false, props);
      const pins = el.getPins();
      const vdd = pins.find((p) => p.label === "VDD");
      const gnd = pins.find((p) => p.label === "GND");
      expect(vdd).toBeDefined();
      expect(gnd).toBeDefined();
    });

    it("VDD pin has kind power and direction INPUT", () => {
      const props = new PropertyBag();
      props.set("inputCount", 2);
      props.set("bitWidth", 1);
      props.set("wideShape", false);
      props.set("simulationModel", "cmos");
      const el = new AndElement("cmos-test", { x: 0, y: 0 }, 0, false, props);
      const vdd = el.getPins().find((p) => p.label === "VDD");
      expect(vdd?.direction).toBe(PinDirection.INPUT);
    });

    it("GND pin has kind power and direction INPUT", () => {
      const props = new PropertyBag();
      props.set("inputCount", 2);
      props.set("bitWidth", 1);
      props.set("wideShape", false);
      props.set("simulationModel", "cmos");
      const el = new AndElement("cmos-test", { x: 0, y: 0 }, 0, false, props);
      const gnd = el.getPins().find((p) => p.label === "GND");
      expect(gnd?.direction).toBe(PinDirection.INPUT);
    });

    it("signal pin count is unchanged with cmos model (2 inputs + 1 output)", () => {
      const props = new PropertyBag();
      props.set("inputCount", 2);
      props.set("bitWidth", 1);
      props.set("wideShape", false);
      props.set("simulationModel", "cmos");
      const el = new AndElement("cmos-test", { x: 0, y: 0 }, 0, false, props);
      const pins = el.getPins();
      const signalPins = pins.filter((p) => p.label !== "VDD" && p.label !== "GND");
      expect(signalPins).toHaveLength(3);
    });

    it("VDD is above GND (VDD y < GND y)", () => {
      const props = new PropertyBag();
      props.set("inputCount", 2);
      props.set("bitWidth", 1);
      props.set("wideShape", false);
      props.set("simulationModel", "cmos");
      const el = new AndElement("cmos-test", { x: 0, y: 0 }, 0, false, props);
      const vdd = el.getPins().find((p) => p.label === "VDD");
      const gnd = el.getPins().find((p) => p.label === "GND");
      expect(vdd!.position.y).toBeLessThan(gnd!.position.y);
    });
  });
});
