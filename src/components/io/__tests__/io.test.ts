/**
 * Tests for basic I/O components: In, Out, Clock, Const, Ground, VDD, NotConnected.
 *
 * Covers:
 *   - execute*: correct simulation behavior
 *   - draw: renders correctly (label shown, value display for Out)
 *   - attributeMapping: .dig attributes map correctly
 *   - interactiveToggle (In): verify pass-through behavior
 *   - radixDisplay (Out): hex, decimal, binary display formatting
 */

import { describe, it, expect } from "vitest";
import {
  InElement,
  executeIn,
  InDefinition,
  IN_ATTRIBUTE_MAPPINGS,
} from "../in.js";
import {
  OutElement,
  executeOut,
  OutDefinition,
  OUT_ATTRIBUTE_MAPPINGS,
  formatValue,
} from "../out.js";
import {
  ClockElement,
  executeClock,
  ClockDefinition,
  CLOCK_ATTRIBUTE_MAPPINGS,
} from "../clock.js";
import {
  ConstElement,
  executeConst,
  ConstDefinition,
  CONST_ATTRIBUTE_MAPPINGS,
} from "../const.js";
import {
  GroundElement,
  executeGround,
  GroundDefinition,
  GROUND_ATTRIBUTE_MAPPINGS,
} from "../ground.js";
import {
  VddElement,
  executeVdd,
  VddDefinition,
  VDD_ATTRIBUTE_MAPPINGS,
} from "../vdd.js";
import {
  NotConnectedElement,
  executeNotConnected,
  NotConnectedDefinition,
  NOT_CONNECTED_ATTRIBUTE_MAPPINGS,
} from "../not-connected.js";
import { PropertyBag } from "../../../core/properties.js";
import { PinDirection } from "../../../core/pin.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import type { ComponentLayout } from "../../../core/registry.js";
import type {
  RenderContext,
  Point,
  TextAnchor,
  FontSpec,
  PathData,
  ThemeColor,
} from "../../../core/renderer-interface.js";

// ---------------------------------------------------------------------------
// Helpers- ComponentLayout mock
// ---------------------------------------------------------------------------

function makeLayout(inputCount: number): ComponentLayout {
  const wt = new Int32Array(64).map((_, i) => i);
  return {
    inputCount: () => inputCount,
    inputOffset: () => 0,
    outputCount: () => 1,
    outputOffset: () => inputCount,
    stateOffset: () => 0,
    wiringTable: wt,
    getProperty: () => undefined,
  };
}

function makeLayoutNoInputs(): ComponentLayout {
  const wt = new Int32Array(64).map((_, i) => i);
  return {
    inputCount: () => 0,
    inputOffset: () => 0,
    outputCount: () => 1,
    outputOffset: () => 0,
    stateOffset: () => 0,
    wiringTable: wt,
    getProperty: () => undefined,
  };
}

function makeState(inputs: number[], outputSlots = 1): Uint32Array {
  const arr = new Uint32Array(inputs.length + outputSlots);
  for (let i = 0; i < inputs.length; i++) {
    arr[i] = inputs[i] >>> 0;
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Helpers- RenderContext mock
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
// Helpers- element factories
// ---------------------------------------------------------------------------

function makeIn(overrides?: {
  bitWidth?: number;
  label?: string;
  defaultValue?: number;
  small?: boolean;
}): InElement {
  const props = new PropertyBag();
  props.set("bitWidth", overrides?.bitWidth ?? 1);
  props.set("label", overrides?.label ?? "");
  props.set("defaultValue", overrides?.defaultValue ?? 0);
  props.set("small", overrides?.small ?? false);
  return new InElement("test-in-001", { x: 0, y: 0 }, 0, false, props);
}

function makeOut(overrides?: {
  bitWidth?: number;
  label?: string;
  intFormat?: string;
}): OutElement {
  const props = new PropertyBag();
  props.set("bitWidth", overrides?.bitWidth ?? 1);
  props.set("label", overrides?.label ?? "");
  props.set("intFormat", overrides?.intFormat ?? "hex");
  return new OutElement("test-out-001", { x: 0, y: 0 }, 0, false, props);
}

function makeClock(overrides?: {
  label?: string;
  frequency?: number;
  runRealTime?: boolean;
}): ClockElement {
  const props = new PropertyBag();
  props.set("label", overrides?.label ?? "");
  props.set("Frequency", overrides?.frequency ?? 1);
  props.set("runRealTime", overrides?.runRealTime ?? false);
  return new ClockElement("test-clk-001", { x: 0, y: 0 }, 0, false, props);
}

function makeConst(overrides?: { value?: number; bitWidth?: number }): ConstElement {
  const props = new PropertyBag();
  props.set("value", overrides?.value ?? 1);
  props.set("bitWidth", overrides?.bitWidth ?? 1);
  return new ConstElement("test-const-001", { x: 0, y: 0 }, 0, false, props);
}

function makeGround(): GroundElement {
  const props = new PropertyBag();
  return new GroundElement("test-gnd-001", { x: 0, y: 0 }, 0, false, props);
}

function makeVdd(overrides?: { bitWidth?: number }): VddElement {
  const props = new PropertyBag();
  props.set("bitWidth", overrides?.bitWidth ?? 1);
  return new VddElement("test-vdd-001", { x: 0, y: 0 }, 0, false, props);
}

function makeNotConnected(): NotConnectedElement {
  const props = new PropertyBag();
  return new NotConnectedElement("test-nc-001", { x: 0, y: 0 }, 0, false, props);
}

// ===========================================================================
// In component
// ===========================================================================

describe("InComponent", () => {
  describe("execute", () => {
    it("executeIn is a no-op- does not write to output slot", () => {
      const layout = makeLayoutNoInputs();
      const state = new Uint32Array(1);
      const highZs = new Uint32Array(state.length);
      state[0] = 42;
      executeIn(0, state, highZs, layout);
      // executeIn must not alter the output slot (externally managed)
      expect(state[0]).toBe(42);
    });

    it("executeIn called 1000 times does not throw", () => {
      const layout = makeLayoutNoInputs();
      const state = new Uint32Array(1);
      const highZs = new Uint32Array(state.length);
      expect(() => {
        for (let i = 0; i < 1000; i++) {
          executeIn(0, state, highZs, layout);
        }
      }).not.toThrow();
    });
  });

  describe("interactiveToggle", () => {
    it("In output value can be set externally and executeIn preserves it", () => {
      const layout = makeLayoutNoInputs();
      const state = new Uint32Array(1);
      const highZs = new Uint32Array(state.length);
      // Simulate external engine.setSignalValue
      state[0] = 1;
      executeIn(0, state, highZs, layout);
      expect(state[0]).toBe(1);

      state[0] = 0;
      executeIn(0, state, highZs, layout);
      expect(state[0]).toBe(0);
    });
  });

  describe("draw", () => {
    it("draw calls drawPolygon for the component body", () => {
      const el = makeIn();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const polyCalls = calls.filter((c) => c.method === "drawPolygon");
      expect(polyCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("draw shows label when label is set", () => {
      const el = makeIn({ label: "A" });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.some((c) => c.args[0] === "A")).toBe(true);
    });

    it("draw calls drawText once (empty label draws empty string)", () => {
      const el = makeIn({ label: "" });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.length).toBe(1);
      expect(textCalls[0].args[0]).toBe("");
    });
  });

  describe("pins", () => {
    it("In has exactly 1 output pin", () => {
      const el = makeIn();
      const pins = el.getPins();
      expect(pins).toHaveLength(1);
      expect(pins[0].direction).toBe(PinDirection.OUTPUT);
    });

    it("In output pin is labeled 'out'", () => {
      const el = makeIn();
      expect(el.getPins()[0].label).toBe("out");
    });
  });

  describe("attributeMapping", () => {
    it("Bits maps to bitWidth", () => {
      const m = IN_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Bits");
      expect(m).toBeDefined();
      expect(m!.convert("8")).toBe(8);
      expect(m!.propertyKey).toBe("bitWidth");
    });

    it("Label maps to label", () => {
      const m = IN_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Label");
      expect(m).toBeDefined();
      expect(m!.convert("CLK")).toBe("CLK");
    });

    it("Default maps to defaultValue", () => {
      const m = IN_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Default");
      expect(m).toBeDefined();
      expect(m!.convert("3")).toBe(3);
    });

    it("small maps to small boolean", () => {
      const m = IN_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "small");
      expect(m).toBeDefined();
      expect(m!.convert("true")).toBe(true);
      expect(m!.convert("false")).toBe(false);
    });
  });

  describe("definitionComplete", () => {
    it("InDefinition name is 'In'", () => {
      expect(InDefinition.name).toBe("In");
    });

    it("InDefinition typeId is -1 sentinel", () => {
      expect(InDefinition.typeId).toBe(-1);
    });

    it("InDefinition category is IO", () => {
      expect(InDefinition.category).toBe(ComponentCategory.IO);
    });

    it("InDefinition has factory function", () => {
      expect(typeof InDefinition.factory).toBe("function");
    });

    it("InDefinition executeFn is executeIn", () => {
      expect(InDefinition.models.digital!.executeFn).toBe(executeIn);
    });

    it("InDefinition has non-empty pinLayout", () => {
      expect(InDefinition.pinLayout.length).toBeGreaterThan(0);
    });

    it("InDefinition can be registered", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(InDefinition)).not.toThrow();
    });

    it("InDefinition factory produces an InElement", () => {
      const props = new PropertyBag();
      props.set("bitWidth", 1);
      const el = InDefinition.factory(props);
      expect(el.typeId).toBe("In");
    });
  });
});

// ===========================================================================
// Out component
// ===========================================================================

describe("OutComponent", () => {
  describe("execute", () => {
    it("executeOut copies input value to output slot", () => {
      const layout = makeLayout(1);
      const state = makeState([0xAB]);
      const highZs = new Uint32Array(state.length);
      executeOut(0, state, highZs, layout);
      expect(state[1]).toBe(0xAB);
    });

    it("executeOut with value 0 writes 0 to output", () => {
      const layout = makeLayout(1);
      const state = makeState([0]);
      const highZs = new Uint32Array(state.length);
      executeOut(0, state, highZs, layout);
      expect(state[1]).toBe(0);
    });

    it("executeOut with 0xFFFFFFFF preserves all bits", () => {
      const layout = makeLayout(1);
      const state = makeState([0xFFFFFFFF]);
      const highZs = new Uint32Array(state.length);
      executeOut(0, state, highZs, layout);
      expect(state[1]).toBe(0xFFFFFFFF);
    });
  });

  describe("radixDisplay", () => {
    it("formatValue hex: 255 → '0xFF'", () => {
      expect(formatValue(255, 8, "hex")).toBe("0xFF");
    });

    it("formatValue hex: 0 → '0x00' (padded)", () => {
      expect(formatValue(0, 8, "hex")).toBe("0x00");
    });

    it("formatValue dec: 255 → '255'", () => {
      expect(formatValue(255, 8, "dec")).toBe("255");
    });

    it("formatValue bin: 5 → '0b00000101' (8-bit)", () => {
      expect(formatValue(5, 8, "bin")).toBe("0b00000101");
    });

    it("formatValue bin: 1 → '0b1' (1-bit)", () => {
      expect(formatValue(1, 1, "bin")).toBe("0b1");
    });

    it("formatValue oct: 8 → '0o10'", () => {
      expect(formatValue(8, 8, "oct")).toBe("0o10");
    });

    it("formatValue hex: 0xDEAD → '0xDEAD' (16-bit)", () => {
      expect(formatValue(0xDEAD, 16, "hex")).toBe("0xDEAD");
    });
  });

  describe("draw", () => {
    it("draw calls drawCircle for component body (two concentric circles)", () => {
      const el = makeOut();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const circleCalls = calls.filter((c) => c.method === "drawCircle");
      expect(circleCalls.length).toBeGreaterThanOrEqual(2);
    });

    it("draw shows label when set", () => {
      const el = makeOut({ label: "Q" });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.some((c) => c.args[0] === "Q")).toBe(true);
    });
  });

  describe("pins", () => {
    it("Out has exactly 1 input pin", () => {
      const el = makeOut();
      const pins = el.getPins();
      expect(pins).toHaveLength(1);
      expect(pins[0].direction).toBe(PinDirection.INPUT);
    });

    it("Out input pin is labeled 'in'", () => {
      const el = makeOut();
      expect(el.getPins()[0].label).toBe("in");
    });
  });

  describe("attributeMapping", () => {
    it("Bits maps to bitWidth", () => {
      const m = OUT_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Bits");
      expect(m).toBeDefined();
      expect(m!.convert("16")).toBe(16);
    });

    it("Label maps to label", () => {
      const m = OUT_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Label");
      expect(m).toBeDefined();
      expect(m!.convert("Output")).toBe("Output");
    });

    it("intFormat maps to intFormat", () => {
      const m = OUT_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "intFormat");
      expect(m).toBeDefined();
      expect(m!.convert("bin")).toBe("bin");
      expect(m!.convert("hex")).toBe("hex");
    });
  });

  describe("definitionComplete", () => {
    it("OutDefinition name is 'Out'", () => {
      expect(OutDefinition.name).toBe("Out");
    });

    it("OutDefinition typeId is -1 sentinel", () => {
      expect(OutDefinition.typeId).toBe(-1);
    });

    it("OutDefinition category is IO", () => {
      expect(OutDefinition.category).toBe(ComponentCategory.IO);
    });

    it("OutDefinition executeFn is executeOut", () => {
      expect(OutDefinition.models.digital!.executeFn).toBe(executeOut);
    });

    it("OutDefinition can be registered", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(OutDefinition)).not.toThrow();
    });
  });
});

// ===========================================================================
// Clock component
// ===========================================================================

describe("ClockComponent", () => {
  describe("execute", () => {
    it("executeClock is a no-op- output unchanged", () => {
      const layout = makeLayoutNoInputs();
      const state = new Uint32Array(1);
      const highZs = new Uint32Array(state.length);
      state[0] = 1;
      executeClock(0, state, highZs, layout);
      expect(state[0]).toBe(1);
    });

    it("executeClock does not throw when called repeatedly", () => {
      const layout = makeLayoutNoInputs();
      const state = new Uint32Array(1);
      const highZs = new Uint32Array(state.length);
      expect(() => {
        for (let i = 0; i < 100; i++) {
          executeClock(0, state, highZs, layout);
        }
      }).not.toThrow();
    });
  });

  describe("draw", () => {
    it("draw calls drawLine for clock waveform symbol", () => {
      const el = makeClock();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const lineCalls = calls.filter((c) => c.method === "drawLine");
      expect(lineCalls.length).toBeGreaterThanOrEqual(4);
    });

    it("draw shows label when set", () => {
      const el = makeClock({ label: "CLK" });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.some((c) => c.args[0] === "CLK")).toBe(true);
    });

    it("draw calls drawText with empty string when label is empty", () => {
      const el = makeClock({ label: "" });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.length).toBe(1);
      expect(textCalls[0].args[0]).toBe("");
    });
  });

  describe("pins", () => {
    it("Clock has exactly 1 output pin", () => {
      const el = makeClock();
      const pins = el.getPins();
      expect(pins).toHaveLength(1);
      expect(pins[0].direction).toBe(PinDirection.OUTPUT);
    });
  });

  describe("properties", () => {
    it("frequency property is readable", () => {
      const el = makeClock({ frequency: 10 });
      expect(el.frequency).toBe(10);
    });

    it("runRealTime property is readable", () => {
      const el = makeClock({ runRealTime: true });
      expect(el.runRealTime).toBe(true);
    });
  });

  describe("attributeMapping", () => {
    it("Label maps to label", () => {
      const m = CLOCK_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Label");
      expect(m).toBeDefined();
      expect(m!.convert("C")).toBe("C");
    });

    it("Frequency maps to Frequency as integer", () => {
      const m = CLOCK_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Frequency");
      expect(m).toBeDefined();
      expect(m!.convert("50")).toBe(50);
    });

    it("runRealTime maps to boolean", () => {
      const m = CLOCK_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "runRealTime");
      expect(m).toBeDefined();
      expect(m!.convert("true")).toBe(true);
      expect(m!.convert("false")).toBe(false);
    });
  });

  describe("definitionComplete", () => {
    it("ClockDefinition name is 'Clock'", () => {
      expect(ClockDefinition.name).toBe("Clock");
    });

    it("ClockDefinition executeFn is executeClock", () => {
      expect(ClockDefinition.models.digital!.executeFn).toBe(executeClock);
    });

    it("ClockDefinition category is IO", () => {
      expect(ClockDefinition.category).toBe(ComponentCategory.IO);
    });

    it("ClockDefinition can be registered", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(ClockDefinition)).not.toThrow();
    });

    it("ClockDefinition propertyDefs include Frequency and runRealTime", () => {
      const keys = ClockDefinition.propertyDefs.map((d) => d.key);
      expect(keys).toContain("Frequency");
      expect(keys).toContain("runRealTime");
    });
  });
});

// ===========================================================================
// Const component
// ===========================================================================

describe("ConstComponent", () => {
  describe("execute", () => {
    it("executeConst writes the configured value to output", () => {
      const wt = new Int32Array(64).map((_, i) => i);
      const layout: ComponentLayout = {
        inputCount: () => 0, inputOffset: () => 0,
        outputCount: () => 1, outputOffset: () => 0,
        stateOffset: () => 0, wiringTable: wt,
        getProperty: (_i: number, key: string) => key === "value" ? 0xBEEF : undefined,
      };
      const state = new Uint32Array(1);
      const highZs = new Uint32Array(state.length);
      state[0] = 0;
      executeConst(0, state, highZs, layout);
      expect(state[0]).toBe(0xBEEF);
    });

    it("executeConst with value 0 writes 0 to output", () => {
      const wt = new Int32Array(64).map((_, i) => i);
      const layout: ComponentLayout = {
        inputCount: () => 0, inputOffset: () => 0,
        outputCount: () => 1, outputOffset: () => 0,
        stateOffset: () => 0, wiringTable: wt,
        getProperty: (_i: number, key: string) => key === "value" ? 0 : undefined,
      };
      const state = new Uint32Array(1);
      const highZs = new Uint32Array(state.length);
      state[0] = 99;
      executeConst(0, state, highZs, layout);
      expect(state[0]).toBe(0);
    });
  });

  describe("draw", () => {
    it("draw renders text only, no body rect", () => {
      const el = makeConst({ value: 7 });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const rectCalls = calls.filter((c) => c.method === "drawRect");
      expect(rectCalls.length).toBe(0);
      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.length).toBeGreaterThanOrEqual(1);
      expect(textCalls.some((c) => c.args[0] === "7")).toBe(true);
    });

    it("draw renders the constant value as text", () => {
      const el = makeConst({ value: 42 });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.some((c) => c.args[0] === "42")).toBe(true);
    });
  });

  describe("pins", () => {
    it("Const has exactly 1 output pin", () => {
      const el = makeConst();
      const pins = el.getPins();
      expect(pins).toHaveLength(1);
      expect(pins[0].direction).toBe(PinDirection.OUTPUT);
    });
  });

  describe("properties", () => {
    it("value property is accessible", () => {
      const el = makeConst({ value: 0xFF });
      expect(el.value).toBe(0xFF);
    });

    it("value 0 is accessible", () => {
      const el = makeConst({ value: 0 });
      expect(el.value).toBe(0);
    });
  });

  describe("attributeMapping", () => {
    it("Bits maps to bitWidth", () => {
      const m = CONST_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Bits");
      expect(m).toBeDefined();
      expect(m!.convert("4")).toBe(4);
    });

    it("Value maps to value as integer", () => {
      const m = CONST_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Value");
      expect(m).toBeDefined();
      expect(m!.convert("255")).toBe(255);
    });
  });

  describe("definitionComplete", () => {
    it("ConstDefinition name is 'Const'", () => {
      expect(ConstDefinition.name).toBe("Const");
    });

    it("ConstDefinition executeFn is executeConst", () => {
      expect(ConstDefinition.models.digital!.executeFn).toBe(executeConst);
    });

    it("ConstDefinition category is IO", () => {
      expect(ConstDefinition.category).toBe(ComponentCategory.IO);
    });

    it("ConstDefinition can be registered", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(ConstDefinition)).not.toThrow();
    });
  });
});

// ===========================================================================
// Ground component
// ===========================================================================

describe("GroundComponent", () => {
  describe("execute", () => {
    it("executeGround writes 0 to output", () => {
      const layout = makeLayoutNoInputs();
      const state = new Uint32Array(1);
      const highZs = new Uint32Array(state.length);
      state[0] = 0xFFFFFFFF;
      executeGround(0, state, highZs, layout);
      expect(state[0]).toBe(0);
    });

    it("executeGround always writes 0 regardless of prior value", () => {
      const layout = makeLayoutNoInputs();
      const state = new Uint32Array(1);
      const highZs = new Uint32Array(state.length);
      for (const prior of [0xDEAD, 0xBEEF, 0x1, 0xFF]) {
        state[0] = prior;
        executeGround(0, state, highZs, layout);
        expect(state[0]).toBe(0);
      }
    });
  });

  describe("draw", () => {
    it("draw calls drawLine for the ground symbol", () => {
      const el = makeGround();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const lineCalls = calls.filter((c) => c.method === "drawLine");
      expect(lineCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("pins", () => {
    it("Ground has exactly 1 output pin", () => {
      const el = makeGround();
      const pins = el.getPins();
      expect(pins).toHaveLength(1);
      expect(pins[0].direction).toBe(PinDirection.OUTPUT);
    });
  });

  describe("attributeMapping", () => {
    it("Ground maps Bits to bitWidth", () => {
      expect(GROUND_ATTRIBUTE_MAPPINGS).toHaveLength(1);
      expect(GROUND_ATTRIBUTE_MAPPINGS[0]!.xmlName).toBe("Bits");
      expect(GROUND_ATTRIBUTE_MAPPINGS[0]!.propertyKey).toBe("bitWidth");
    });
  });

  describe("definitionComplete", () => {
    it("GroundDefinition name is 'Ground'", () => {
      expect(GroundDefinition.name).toBe("Ground");
    });

    it("GroundDefinition executeFn is executeGround", () => {
      expect(GroundDefinition.models.digital!.executeFn).toBe(executeGround);
    });

    it("GroundDefinition category is IO", () => {
      expect(GroundDefinition.category).toBe(ComponentCategory.IO);
    });

    it("GroundDefinition can be registered", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(GroundDefinition)).not.toThrow();
    });
  });
});

// ===========================================================================
// VDD component
// ===========================================================================

describe("VddComponent", () => {
  describe("execute", () => {
    it("executeVdd writes 0xFFFFFFFF to output", () => {
      const layout = makeLayoutNoInputs();
      const state = new Uint32Array(1);
      const highZs = new Uint32Array(state.length);
      state[0] = 0;
      executeVdd(0, state, highZs, layout);
      expect(state[0]).toBe(0xFFFFFFFF);
    });

    it("executeVdd always writes all-ones regardless of prior value", () => {
      const layout = makeLayoutNoInputs();
      const state = new Uint32Array(1);
      const highZs = new Uint32Array(state.length);
      for (const prior of [0, 0xAB, 0x1234, 0]) {
        state[0] = prior;
        executeVdd(0, state, highZs, layout);
        expect(state[0]).toBe(0xFFFFFFFF);
      }
    });
  });

  describe("draw", () => {
    it("draw renders VDD symbol with triangle path and stem line", () => {
      const el = makeVdd();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const lineCalls = calls.filter((c) => c.method === "drawLine");
      expect(lineCalls.length).toBeGreaterThanOrEqual(1);
      const pathCalls = calls.filter((c) => c.method === "drawPath");
      expect(pathCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("pins", () => {
    it("VDD has exactly 1 output pin", () => {
      const el = makeVdd();
      const pins = el.getPins();
      expect(pins).toHaveLength(1);
      expect(pins[0].direction).toBe(PinDirection.OUTPUT);
    });
  });

  describe("attributeMapping", () => {
    it("Bits maps to bitWidth", () => {
      const m = VDD_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Bits");
      expect(m).toBeDefined();
      expect(m!.convert("8")).toBe(8);
    });
  });

  describe("definitionComplete", () => {
    it("VddDefinition name is 'VDD'", () => {
      expect(VddDefinition.name).toBe("VDD");
    });

    it("VddDefinition executeFn is executeVdd", () => {
      expect(VddDefinition.models.digital!.executeFn).toBe(executeVdd);
    });

    it("VddDefinition category is IO", () => {
      expect(VddDefinition.category).toBe(ComponentCategory.IO);
    });

    it("VddDefinition can be registered", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(VddDefinition)).not.toThrow();
    });

    it("VddDefinition propertyDefs include bitWidth", () => {
      const keys = VddDefinition.propertyDefs.map((d) => d.key);
      expect(keys).toContain("bitWidth");
    });
  });
});

// ===========================================================================
// NotConnected component
// ===========================================================================

describe("NotConnectedComponent", () => {
  describe("execute", () => {
    it("executeNotConnected is a no-op", () => {
      const layout = makeLayout(1);
      const state = new Uint32Array(2);
      const highZs = new Uint32Array(state.length);
      state[0] = 0xAB;
      state[1] = 0xCD;
      executeNotConnected(0, state, highZs, layout);
      expect(state[0]).toBe(0xAB);
      expect(state[1]).toBe(0xCD);
    });

    it("executeNotConnected does not throw", () => {
      const layout = makeLayout(1);
      const state = new Uint32Array(2);
      const highZs = new Uint32Array(state.length);
      expect(() => executeNotConnected(0, state, highZs, layout)).not.toThrow();
    });
  });

  describe("draw", () => {
    it("draw calls drawLine for the X marker", () => {
      const el = makeNotConnected();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const lineCalls = calls.filter((c) => c.method === "drawLine");
      expect(lineCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("pins", () => {
    it("NotConnected has exactly 1 input pin", () => {
      const el = makeNotConnected();
      const pins = el.getPins();
      expect(pins).toHaveLength(1);
      expect(pins[0].direction).toBe(PinDirection.INPUT);
    });

    it("NotConnected pin is labeled 'nc'", () => {
      const el = makeNotConnected();
      expect(el.getPins()[0].label).toBe("nc");
    });
  });

  describe("attributeMapping", () => {
    it("NotConnected has no attribute mappings", () => {
      expect(NOT_CONNECTED_ATTRIBUTE_MAPPINGS).toHaveLength(0);
    });
  });

  describe("definitionComplete", () => {
    it("NotConnectedDefinition name is 'NotConnected'", () => {
      expect(NotConnectedDefinition.name).toBe("NotConnected");
    });

    it("NotConnectedDefinition executeFn is executeNotConnected", () => {
      expect(NotConnectedDefinition.models.digital!.executeFn).toBe(executeNotConnected);
    });

    it("NotConnectedDefinition category is IO", () => {
      expect(NotConnectedDefinition.category).toBe(ComponentCategory.IO);
    });

    it("NotConnectedDefinition typeId is -1 sentinel", () => {
      expect(NotConnectedDefinition.typeId).toBe(-1);
    });

    it("NotConnectedDefinition can be registered", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(NotConnectedDefinition)).not.toThrow();
    });

    it("NotConnectedDefinition has non-empty helpText", () => {
      expect(typeof NotConnectedDefinition.helpText).toBe("string"); expect(NotConnectedDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });
  });
});
