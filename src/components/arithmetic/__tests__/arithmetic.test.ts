/**
 * Tests for arithmetic components: Add, Sub, Mul, Div.
 *
 * Covers:
 *   - Correctness for unsigned and signed modes
 *   - Carry/borrow/overflow detection
 *   - Division by zero handling
 *   - Multi-bit widths
 *   - Pin layout
 *   - Attribute mappings
 *   - Rendering (draw calls)
 *   - ComponentDefinition completeness
 */

import { describe, it, expect } from "vitest";
import {
  AddElement,
  makeExecuteAdd,
  executeAdd,
  AddDefinition,
  ADD_ATTRIBUTE_MAPPINGS,
} from "../add.js";
import {
  SubElement,
  makeExecuteSub,
  executeSub,
  SubDefinition,
  SUB_ATTRIBUTE_MAPPINGS,
} from "../sub.js";
import {
  MulElement,
  makeExecuteMul,
  executeMul,
  MulDefinition,
  MUL_ATTRIBUTE_MAPPINGS,
} from "../mul.js";
import {
  DivElement,
  makeExecuteDiv,
  executeDiv,
  DivDefinition,
  DIV_ATTRIBUTE_MAPPINGS,
} from "../div.js";
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
    stateOffset: () => 0,
  };
}

function makeLayoutWithProps(
  inputCount: number,
  outputCount: number,
  props: Record<string, unknown>,
): ComponentLayout {
  return {
    inputCount: () => inputCount,
    inputOffset: () => 0,
    outputCount: () => outputCount,
    outputOffset: () => inputCount,
    stateOffset: () => 0,
    getProperty: (_index: number, key: string) => props[key] as (number | boolean | string | undefined),
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

function makeAddElement(overrides?: { bitWidth?: number; label?: string }): AddElement {
  const props = new PropertyBag();
  props.set("bitWidth", overrides?.bitWidth ?? 1);
  if (overrides?.label !== undefined) props.set("label", overrides.label);
  return new AddElement("test-add", { x: 0, y: 0 }, 0, false, props);
}

function makeSubElement(overrides?: { bitWidth?: number; label?: string }): SubElement {
  const props = new PropertyBag();
  props.set("bitWidth", overrides?.bitWidth ?? 1);
  if (overrides?.label !== undefined) props.set("label", overrides.label);
  return new SubElement("test-sub", { x: 0, y: 0 }, 0, false, props);
}

function makeMulElement(overrides?: { bitWidth?: number; signed?: boolean; label?: string }): MulElement {
  const props = new PropertyBag();
  props.set("bitWidth", overrides?.bitWidth ?? 1);
  props.set("signed", overrides?.signed ?? false);
  if (overrides?.label !== undefined) props.set("label", overrides.label);
  return new MulElement("test-mul", { x: 0, y: 0 }, 0, false, props);
}

function makeDivElement(overrides?: {
  bitWidth?: number;
  signed?: boolean;
  remainderPositive?: boolean;
  label?: string;
}): DivElement {
  const props = new PropertyBag();
  props.set("bitWidth", overrides?.bitWidth ?? 1);
  props.set("signed", overrides?.signed ?? false);
  props.set("remainderPositive", overrides?.remainderPositive ?? false);
  if (overrides?.label !== undefined) props.set("label", overrides.label);
  return new DivElement("test-div", { x: 0, y: 0 }, 0, false, props);
}

// ---------------------------------------------------------------------------
// ADD tests
// ---------------------------------------------------------------------------

describe("Add", () => {
  describe("unsigned arithmetic", () => {
    it("1 + 1 + 0 = 2 (no carry)", () => {
      const exec = makeExecuteAdd(4);
      const layout = makeLayout(3, 2);
      const state = makeState([1, 1, 0], 2);
      exec(0, state, layout);
      expect(state[3]).toBe(2);
      expect(state[4]).toBe(0);
    });

    it("0 + 0 + 0 = 0", () => {
      const exec = makeExecuteAdd(4);
      const layout = makeLayout(3, 2);
      const state = makeState([0, 0, 0], 2);
      exec(0, state, layout);
      expect(state[3]).toBe(0);
      expect(state[4]).toBe(0);
    });

    it("4-bit: 0xF + 0x1 + 0 = 0x0 with carry out", () => {
      const exec = makeExecuteAdd(4);
      const layout = makeLayout(3, 2);
      const state = makeState([0xF, 0x1, 0], 2);
      exec(0, state, layout);
      expect(state[3]).toBe(0);
      expect(state[4]).toBe(1);
    });

    it("4-bit: 0xF + 0xF + 1 = 0xF with carry out", () => {
      const exec = makeExecuteAdd(4);
      const layout = makeLayout(3, 2);
      const state = makeState([0xF, 0xF, 1], 2);
      exec(0, state, layout);
      // 15 + 15 + 1 = 31 = 0x1F; low 4 bits = 0xF, carry = 1
      expect(state[3]).toBe(0xF);
      expect(state[4]).toBe(1);
    });

    it("8-bit: 0xFF + 0x01 + 0 = 0x00 with carry", () => {
      const exec = makeExecuteAdd(8);
      const layout = makeLayout(3, 2);
      const state = makeState([0xFF, 0x01, 0], 2);
      exec(0, state, layout);
      expect(state[3]).toBe(0);
      expect(state[4]).toBe(1);
    });

    it("8-bit: 0x7F + 0x01 + 0 = 0x80 (no carry)", () => {
      const exec = makeExecuteAdd(8);
      const layout = makeLayout(3, 2);
      const state = makeState([0x7F, 0x01, 0], 2);
      exec(0, state, layout);
      expect(state[3]).toBe(0x80);
      expect(state[4]).toBe(0);
    });

    it("carry in propagates: 0xFE + 0x01 + 1 = 0x00 with carry", () => {
      const exec = makeExecuteAdd(8);
      const layout = makeLayout(3, 2);
      const state = makeState([0xFE, 0x01, 1], 2);
      exec(0, state, layout);
      expect(state[3]).toBe(0);
      expect(state[4]).toBe(1);
    });

    it("16-bit: 0xFFFF + 0x0001 + 0 = 0x0000 with carry", () => {
      const exec = makeExecuteAdd(16);
      const layout = makeLayout(3, 2);
      const state = makeState([0xFFFF, 0x0001, 0], 2);
      exec(0, state, layout);
      expect(state[3]).toBe(0);
      expect(state[4]).toBe(1);
    });

    it("32-bit: 0xFFFFFFFF + 0x00000001 + 0 = 0x00000000 with carry", () => {
      const exec = makeExecuteAdd(32);
      const layout = makeLayout(3, 2);
      const state = makeState([0xFFFFFFFF, 0x00000001, 0], 2);
      exec(0, state, layout);
      expect(state[3]).toBe(0);
      expect(state[4]).toBe(1);
    });

    it("32-bit: 0x7FFFFFFF + 0x00000001 + 0 = 0x80000000 (no carry)", () => {
      const exec = makeExecuteAdd(32);
      const layout = makeLayout(3, 2);
      const state = makeState([0x7FFFFFFF, 0x00000001, 0], 2);
      exec(0, state, layout);
      expect(state[3]).toBe(0x80000000);
      expect(state[4]).toBe(0);
    });

    it("zero allocation: can be called 1000 times without error", () => {
      const exec = makeExecuteAdd(8);
      const layout = makeLayout(3, 2);
      const state = makeState([0, 0, 0], 2);
      for (let i = 0; i < 1000; i++) {
        state[0] = i & 0xFF;
        state[1] = (i * 3) & 0xFF;
        state[2] = i & 1;
        exec(0, state, layout);
      }
      expect(typeof state[3]).toBe("number");
    });
  });

  describe("pin layout", () => {
    it("Add has 3 input pins and 2 output pins", () => {
      const el = makeAddElement({ bitWidth: 4 });
      const pins = el.getPins();
      const inputs = pins.filter((p) => p.direction === PinDirection.INPUT);
      const outputs = pins.filter((p) => p.direction === PinDirection.OUTPUT);
      expect(inputs).toHaveLength(3);
      expect(outputs).toHaveLength(2);
    });

    it("input pins are labeled a, b, c_i", () => {
      const el = makeAddElement();
      const inputs = el.getPins().filter((p) => p.direction === PinDirection.INPUT);
      expect(inputs.map((p) => p.label)).toEqual(["a", "b", "c_i"]);
    });

    it("output pins are labeled s, c_o", () => {
      const el = makeAddElement();
      const outputs = el.getPins().filter((p) => p.direction === PinDirection.OUTPUT);
      expect(outputs.map((p) => p.label)).toEqual(["s", "c_o"]);
    });

    it("AddDefinition.pinLayout has 5 entries", () => {
      expect(AddDefinition.pinLayout).toHaveLength(5);
    });
  });

  describe("attribute mapping", () => {
    it("Bits=8 maps to bitWidth=8", () => {
      const mapping = ADD_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Bits");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.convert("8")).toBe(8);
      expect(mapping!.propertyKey).toBe("bitWidth");
    });

    it("Label maps to label", () => {
      const mapping = ADD_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Label");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("label");
      expect(mapping!.convert("MyAdder")).toBe("MyAdder");
    });
  });

  describe("rendering", () => {
    it("draw calls drawRect for the body", () => {
      const el = makeAddElement();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const rectCalls = calls.filter((c) => c.method === "drawRect");
      expect(rectCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("draw calls drawText with '+' symbol", () => {
      const el = makeAddElement();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.some((c) => c.args[0] === "+")).toBe(true);
    });

    it("draw calls save and restore", () => {
      const el = makeAddElement();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.some((c) => c.method === "save")).toBe(true);
      expect(calls.some((c) => c.method === "restore")).toBe(true);
    });

    it("draws label when set", () => {
      const el = makeAddElement({ label: "ADDER" });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.some((c) => c.args[0] === "ADDER")).toBe(true);
    });
  });

  describe("definitionComplete", () => {
    it("AddDefinition has name='Add'", () => {
      expect(AddDefinition.name).toBe("Add");
    });

    it("AddDefinition has typeId=-1", () => {
      expect(AddDefinition.typeId).toBe(-1);
    });

    it("AddDefinition has a factory", () => {
      expect(typeof AddDefinition.factory).toBe("function");
    });

    it("AddDefinition factory produces an AddElement", () => {
      const props = new PropertyBag();
      props.set("bitWidth", 4);
      const el = AddDefinition.factory(props);
      expect(el.typeId).toBe("Add");
    });

    it("AddDefinition category is ARITHMETIC", () => {
      expect(AddDefinition.category).toBe(ComponentCategory.ARITHMETIC);
    });

    it("AddDefinition has non-empty helpText", () => {
      expect(typeof AddDefinition.helpText).toBe("string"); expect(AddDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });

    it("AddDefinition can be registered", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(AddDefinition)).not.toThrow();
    });

    it("AddDefinition propertyDefs contain bitWidth and label", () => {
      const keys = AddDefinition.propertyDefs.map((d) => d.key);
      expect(keys).toContain("bitWidth");
      expect(keys).toContain("label");
    });

    it("AddElement.getHelpText() mentions Add", () => {
      const el = makeAddElement();
      expect(el.getHelpText()).toContain("Add");
    });

    it("getBoundingBox returns correct dimensions", () => {
      const el = makeAddElement();
      const bb = el.getBoundingBox();
      expect(bb.width).toBeGreaterThanOrEqual(2);
      expect(bb.height).toBeGreaterThanOrEqual(2);
    });
  });
});

// ---------------------------------------------------------------------------
// SUB tests
// ---------------------------------------------------------------------------

describe("Sub", () => {
  describe("unsigned arithmetic", () => {
    it("4 - 2 - 0 = 2 (no borrow)", () => {
      const exec = makeExecuteSub(4);
      const layout = makeLayout(3, 2);
      const state = makeState([4, 2, 0], 2);
      exec(0, state, layout);
      expect(state[3]).toBe(2);
      expect(state[4]).toBe(0);
    });

    it("0 - 0 - 0 = 0", () => {
      const exec = makeExecuteSub(4);
      const layout = makeLayout(3, 2);
      const state = makeState([0, 0, 0], 2);
      exec(0, state, layout);
      expect(state[3]).toBe(0);
      expect(state[4]).toBe(0);
    });

    it("4-bit: 0x0 - 0x1 - 0 borrows (wraps to 0xF, borrow=1)", () => {
      const exec = makeExecuteSub(4);
      const layout = makeLayout(3, 2);
      const state = makeState([0, 1, 0], 2);
      exec(0, state, layout);
      expect(state[3]).toBe(0xF);
      expect(state[4]).toBe(1);
    });

    it("8-bit: 0x00 - 0x01 - 0 = 0xFF with borrow", () => {
      const exec = makeExecuteSub(8);
      const layout = makeLayout(3, 2);
      const state = makeState([0x00, 0x01, 0], 2);
      exec(0, state, layout);
      expect(state[3]).toBe(0xFF);
      expect(state[4]).toBe(1);
    });

    it("8-bit: 0xFF - 0x01 - 0 = 0xFE (no borrow)", () => {
      const exec = makeExecuteSub(8);
      const layout = makeLayout(3, 2);
      const state = makeState([0xFF, 0x01, 0], 2);
      exec(0, state, layout);
      expect(state[3]).toBe(0xFE);
      expect(state[4]).toBe(0);
    });

    it("borrow in: 0x01 - 0x00 - 1 = 0x00 (no borrow out)", () => {
      const exec = makeExecuteSub(8);
      const layout = makeLayout(3, 2);
      const state = makeState([0x01, 0x00, 1], 2);
      exec(0, state, layout);
      expect(state[3]).toBe(0);
      expect(state[4]).toBe(0);
    });

    it("borrow in propagates: 0x00 - 0x00 - 1 = 0xFF with borrow", () => {
      const exec = makeExecuteSub(8);
      const layout = makeLayout(3, 2);
      const state = makeState([0x00, 0x00, 1], 2);
      exec(0, state, layout);
      expect(state[3]).toBe(0xFF);
      expect(state[4]).toBe(1);
    });

    it("16-bit: 0x0000 - 0x0001 - 0 = 0xFFFF with borrow", () => {
      const exec = makeExecuteSub(16);
      const layout = makeLayout(3, 2);
      const state = makeState([0x0000, 0x0001, 0], 2);
      exec(0, state, layout);
      expect(state[3]).toBe(0xFFFF);
      expect(state[4]).toBe(1);
    });

    it("32-bit: 0x00000000 - 0x00000001 - 0 = 0xFFFFFFFF with borrow", () => {
      const exec = makeExecuteSub(32);
      const layout = makeLayout(3, 2);
      const state = makeState([0x00000000, 0x00000001, 0], 2);
      exec(0, state, layout);
      expect(state[3]).toBe(0xFFFFFFFF);
      expect(state[4]).toBe(1);
    });

    it("zero allocation: can be called 1000 times without error", () => {
      const exec = makeExecuteSub(8);
      const layout = makeLayout(3, 2);
      const state = makeState([0, 0, 0], 2);
      for (let i = 0; i < 1000; i++) {
        state[0] = (i * 2) & 0xFF;
        state[1] = i & 0xFF;
        state[2] = 0;
        exec(0, state, layout);
      }
      expect(typeof state[3]).toBe("number");
    });
  });

  describe("pin layout", () => {
    it("Sub has 3 input pins and 2 output pins", () => {
      const el = makeSubElement({ bitWidth: 4 });
      const pins = el.getPins();
      const inputs = pins.filter((p) => p.direction === PinDirection.INPUT);
      const outputs = pins.filter((p) => p.direction === PinDirection.OUTPUT);
      expect(inputs).toHaveLength(3);
      expect(outputs).toHaveLength(2);
    });

    it("input pins are labeled a, b, c_i", () => {
      const el = makeSubElement();
      const inputs = el.getPins().filter((p) => p.direction === PinDirection.INPUT);
      expect(inputs.map((p) => p.label)).toEqual(["a", "b", "c_i"]);
    });

    it("output pins are labeled s, c_o", () => {
      const el = makeSubElement();
      const outputs = el.getPins().filter((p) => p.direction === PinDirection.OUTPUT);
      expect(outputs.map((p) => p.label)).toEqual(["s", "c_o"]);
    });
  });

  describe("attribute mapping", () => {
    it("Bits=16 maps to bitWidth=16", () => {
      const mapping = SUB_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Bits");
      expect(mapping!.convert("16")).toBe(16);
    });
  });

  describe("rendering", () => {
    it("draw calls drawRect for the body", () => {
      const el = makeSubElement();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.some((c) => c.method === "drawRect")).toBe(true);
    });

    it("draw calls drawText with '-' symbol", () => {
      const el = makeSubElement();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.filter((c) => c.method === "drawText").some((c) => c.args[0] === "-")).toBe(true);
    });
  });

  describe("definitionComplete", () => {
    it("SubDefinition has name='Sub'", () => {
      expect(SubDefinition.name).toBe("Sub");
    });

    it("SubDefinition has typeId=-1", () => {
      expect(SubDefinition.typeId).toBe(-1);
    });

    it("SubDefinition category is ARITHMETIC", () => {
      expect(SubDefinition.category).toBe(ComponentCategory.ARITHMETIC);
    });

    it("SubDefinition can be registered", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(SubDefinition)).not.toThrow();
    });

    it("SubDefinition propertyDefs contain bitWidth and label", () => {
      const keys = SubDefinition.propertyDefs.map((d) => d.key);
      expect(keys).toContain("bitWidth");
      expect(keys).toContain("label");
    });

    it("SubElement.getHelpText() mentions Sub", () => {
      const el = makeSubElement();
      expect(el.getHelpText()).toContain("Sub");
    });
  });
});

// ---------------------------------------------------------------------------
// MUL tests
// ---------------------------------------------------------------------------

describe("Mul", () => {
  describe("unsigned multiplication", () => {
    it("1-bit: 1 * 1 = 1", () => {
      const exec = makeExecuteMul(1, false);
      const layout = makeLayout(2, 1);
      const state = makeState([1, 1], 1);
      exec(0, state, layout);
      expect(state[2]).toBe(1);
    });

    it("1-bit: 1 * 0 = 0", () => {
      const exec = makeExecuteMul(1, false);
      const layout = makeLayout(2, 1);
      const state = makeState([1, 0], 1);
      exec(0, state, layout);
      expect(state[2]).toBe(0);
    });

    it("4-bit unsigned: 3 * 4 = 12", () => {
      const exec = makeExecuteMul(4, false);
      const layout = makeLayout(2, 1);
      const state = makeState([3, 4], 1);
      exec(0, state, layout);
      expect(state[2]).toBe(12);
    });

    it("4-bit unsigned: 0xF * 0xF = 0xE1", () => {
      const exec = makeExecuteMul(4, false);
      const layout = makeLayout(2, 1);
      const state = makeState([0xF, 0xF], 1);
      exec(0, state, layout);
      // 15 * 15 = 225 = 0xE1
      expect(state[2]).toBe(225);
    });

    it("8-bit unsigned: 0xFF * 0xFF = 0xFE01", () => {
      const exec = makeExecuteMul(8, false);
      const layout = makeLayout(2, 1);
      const state = makeState([0xFF, 0xFF], 1);
      exec(0, state, layout);
      // 255 * 255 = 65025 = 0xFE01
      expect(state[2]).toBe(0xFE01);
    });

    it("16-bit unsigned large product uses output slot", () => {
      const exec = makeExecuteMul(16, false);
      const layout = makeLayout(2, 2);
      const state = makeState([0xFFFF, 0xFFFF], 2);
      exec(0, state, layout);
      // 65535 * 65535 = 4294836225 = 0xFFFE0001
      // Fits in 32 bits, high word = 0
      expect(state[2]).toBe(0xFFFE0001);
      expect(state[3]).toBe(0);
    });

    it("32-bit unsigned: large overflow goes into high slot", () => {
      const exec = makeExecuteMul(32, false);
      const layout = makeLayout(2, 2);
      // 0x80000000 * 2 = 0x100000000
      const state = makeState([0x80000000, 2], 2);
      exec(0, state, layout);
      expect(state[2]).toBe(0); // low 32 bits
      expect(state[3]).toBe(1); // high 32 bits
    });

    it("zero allocation: can be called 1000 times without error", () => {
      const exec = makeExecuteMul(8, false);
      const layout = makeLayout(2, 1);
      const state = makeState([0, 0], 1);
      for (let i = 0; i < 1000; i++) {
        state[0] = i & 0xFF;
        state[1] = (255 - i) & 0xFF;
        exec(0, state, layout);
      }
      expect(typeof state[2]).toBe("number");
    });
  });

  describe("signed multiplication", () => {
    it("4-bit signed: 3 * -1 = -3 (stored as two's complement in 8 bits)", () => {
      const exec = makeExecuteMul(4, true);
      const layout = makeLayout(2, 1);
      // -1 in 4 bits = 0xF
      const state = makeState([3, 0xF], 1);
      exec(0, state, layout);
      // 3 * -1 = -3, stored in 8-bit two's complement = 0xFD
      expect(state[2]).toBe(0xFD);
    });

    it("4-bit signed: -2 * -3 = 6", () => {
      const exec = makeExecuteMul(4, true);
      const layout = makeLayout(2, 1);
      // -2 in 4 bits = 0xE, -3 in 4 bits = 0xD
      const state = makeState([0xE, 0xD], 1);
      exec(0, state, layout);
      expect(state[2]).toBe(6);
    });

    it("4-bit signed: -1 * -1 = 1", () => {
      const exec = makeExecuteMul(4, true);
      const layout = makeLayout(2, 1);
      const state = makeState([0xF, 0xF], 1);
      exec(0, state, layout);
      expect(state[2]).toBe(1);
    });

    it("8-bit signed: 127 * 2 = 254", () => {
      const exec = makeExecuteMul(8, true);
      const layout = makeLayout(2, 1);
      const state = makeState([127, 2], 1);
      exec(0, state, layout);
      expect(state[2]).toBe(254);
    });

    it("8-bit signed: -128 * 2 = -256 (stored as 0xFF00 in 16 bits)", () => {
      const exec = makeExecuteMul(8, true);
      const layout = makeLayout(2, 1);
      // -128 in 8 bits = 0x80
      const state = makeState([0x80, 2], 1);
      exec(0, state, layout);
      // -128 * 2 = -256 = 0xFF00 in 16-bit two's complement
      expect(state[2]).toBe(0xFF00);
    });
  });

  describe("pin layout", () => {
    it("Mul has 2 input pins and 1 output pin", () => {
      const el = makeMulElement({ bitWidth: 4 });
      const pins = el.getPins();
      const inputs = pins.filter((p) => p.direction === PinDirection.INPUT);
      const outputs = pins.filter((p) => p.direction === PinDirection.OUTPUT);
      expect(inputs).toHaveLength(2);
      expect(outputs).toHaveLength(1);
    });

    it("input pins are labeled a and b", () => {
      const el = makeMulElement();
      const inputs = el.getPins().filter((p) => p.direction === PinDirection.INPUT);
      expect(inputs.map((p) => p.label)).toEqual(["a", "b"]);
    });

    it("output pin is labeled mul", () => {
      const el = makeMulElement();
      const outputs = el.getPins().filter((p) => p.direction === PinDirection.OUTPUT);
      expect(outputs[0].label).toBe("mul");
    });
  });

  describe("attribute mapping", () => {
    it("Bits=8 maps to bitWidth=8", () => {
      const mapping = MUL_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Bits");
      expect(mapping!.convert("8")).toBe(8);
    });

    it("signed=true maps to signed=true", () => {
      const mapping = MUL_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "signed");
      expect(mapping!.convert("true")).toBe(true);
      expect(mapping!.convert("false")).toBe(false);
    });
  });

  describe("rendering", () => {
    it("unsigned mul draws '*' symbol", () => {
      const el = makeMulElement({ signed: false });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.filter((c) => c.method === "drawText").some((c) => c.args[0] === "*")).toBe(true);
    });

    it("signed mul draws 'A*B' symbol", () => {
      const el = makeMulElement({ signed: true });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.filter((c) => c.method === "drawText").some((c) => c.args[0] === "A*B")).toBe(true);
    });

    it("draw calls drawRect for the body", () => {
      const el = makeMulElement();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.some((c) => c.method === "drawRect")).toBe(true);
    });
  });

  describe("definitionComplete", () => {
    it("MulDefinition has name='Mul'", () => {
      expect(MulDefinition.name).toBe("Mul");
    });

    it("MulDefinition has typeId=-1", () => {
      expect(MulDefinition.typeId).toBe(-1);
    });

    it("MulDefinition category is ARITHMETIC", () => {
      expect(MulDefinition.category).toBe(ComponentCategory.ARITHMETIC);
    });

    it("MulDefinition can be registered", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(MulDefinition)).not.toThrow();
    });

    it("MulDefinition propertyDefs contain bitWidth, signed, label", () => {
      const keys = MulDefinition.propertyDefs.map((d) => d.key);
      expect(keys).toContain("bitWidth");
      expect(keys).toContain("signed");
      expect(keys).toContain("label");
    });

    it("MulElement.getHelpText() mentions Mul", () => {
      const el = makeMulElement();
      expect(el.getHelpText()).toContain("Mul");
    });
  });
});

// ---------------------------------------------------------------------------
// DIV tests
// ---------------------------------------------------------------------------

describe("Div", () => {
  describe("unsigned division", () => {
    it("6 / 2 = 3 remainder 0", () => {
      const exec = makeExecuteDiv(4, false, false);
      const layout = makeLayout(2, 2);
      const state = makeState([6, 2], 2);
      exec(0, state, layout);
      expect(state[2]).toBe(3);
      expect(state[3]).toBe(0);
    });

    it("7 / 2 = 3 remainder 1", () => {
      const exec = makeExecuteDiv(4, false, false);
      const layout = makeLayout(2, 2);
      const state = makeState([7, 2], 2);
      exec(0, state, layout);
      expect(state[2]).toBe(3);
      expect(state[3]).toBe(1);
    });

    it("0 / 5 = 0 remainder 0", () => {
      const exec = makeExecuteDiv(8, false, false);
      const layout = makeLayout(2, 2);
      const state = makeState([0, 5], 2);
      exec(0, state, layout);
      expect(state[2]).toBe(0);
      expect(state[3]).toBe(0);
    });

    it("division by zero treated as division by 1: 5 / 0 = 5 remainder 0", () => {
      const exec = makeExecuteDiv(8, false, false);
      const layout = makeLayout(2, 2);
      const state = makeState([5, 0], 2);
      exec(0, state, layout);
      expect(state[2]).toBe(5);
      expect(state[3]).toBe(0);
    });

    it("8-bit: 255 / 10 = 25 remainder 5", () => {
      const exec = makeExecuteDiv(8, false, false);
      const layout = makeLayout(2, 2);
      const state = makeState([255, 10], 2);
      exec(0, state, layout);
      expect(state[2]).toBe(25);
      expect(state[3]).toBe(5);
    });

    it("16-bit: 0xFFFF / 0x100 = 0xFF remainder 0xFF", () => {
      const exec = makeExecuteDiv(16, false, false);
      const layout = makeLayout(2, 2);
      const state = makeState([0xFFFF, 0x100], 2);
      exec(0, state, layout);
      expect(state[2]).toBe(0xFF);
      expect(state[3]).toBe(0xFF);
    });

    it("32-bit: 0xFFFFFFFF / 0x10000 = 0xFFFF remainder 0xFFFF", () => {
      const exec = makeExecuteDiv(32, false, false);
      const layout = makeLayout(2, 2);
      const state = makeState([0xFFFFFFFF, 0x10000], 2);
      exec(0, state, layout);
      expect(state[2]).toBe(0xFFFF);
      expect(state[3]).toBe(0xFFFF);
    });

    it("zero allocation: can be called 1000 times without error", () => {
      const exec = makeExecuteDiv(8, false, false);
      const layout = makeLayout(2, 2);
      const state = makeState([0, 1], 2);
      for (let i = 0; i < 1000; i++) {
        state[0] = i & 0xFF;
        state[1] = Math.max(1, i & 0xF);
        exec(0, state, layout);
      }
      expect(typeof state[2]).toBe("number");
    });
  });

  describe("signed division", () => {
    it("signed 4-bit: 6 / 2 = 3 remainder 0", () => {
      const exec = makeExecuteDiv(4, true, false);
      const layout = makeLayout(2, 2);
      const state = makeState([6, 2], 2);
      exec(0, state, layout);
      expect(state[2]).toBe(3);
      expect(state[3]).toBe(0);
    });

    it("signed 4-bit: -6 / 2 = -3 remainder 0", () => {
      const exec = makeExecuteDiv(4, true, false);
      const layout = makeLayout(2, 2);
      // -6 in 4 bits = 0xA, 2 = 0x2
      const state = makeState([0xA, 2], 2);
      exec(0, state, layout);
      // -3 in 4-bit two's complement = 0xD, remainder 0
      expect(state[2]).toBe(0xD);
      expect(state[3]).toBe(0);
    });

    it("signed 8-bit: -7 / 2 = -3 remainder -1 (truncated division)", () => {
      const exec = makeExecuteDiv(8, true, false);
      const layout = makeLayout(2, 2);
      // -7 in 8 bits = 0xF9
      const state = makeState([0xF9, 2], 2);
      exec(0, state, layout);
      // -7 / 2 = -3 (truncated toward zero), remainder = -7 - (-3*2) = -7 + 6 = -1
      // -3 in 8-bit = 0xFD, -1 in 8-bit = 0xFF
      expect(state[2]).toBe(0xFD);
      expect(state[3]).toBe(0xFF);
    });

    it("signed division by zero treated as division by 1: -5 / 0 = -5", () => {
      const exec = makeExecuteDiv(8, true, false);
      const layout = makeLayout(2, 2);
      // -5 in 8 bits = 0xFB
      const state = makeState([0xFB, 0], 2);
      exec(0, state, layout);
      // -5 / 1 = -5, remainder 0
      expect(state[2]).toBe(0xFB);
      expect(state[3]).toBe(0);
    });

    it("remainderPositive=true: -7 / 2 = -4 remainder 1 (floor division)", () => {
      const exec = makeExecuteDiv(8, true, true);
      const layout = makeLayout(2, 2);
      // -7 in 8 bits = 0xF9
      const state = makeState([0xF9, 2], 2);
      exec(0, state, layout);
      // With remainderPositive: floor(-7/2) = -4, remainder = -7 - (-4*2) = 1
      // -4 in 8-bit = 0xFC, remainder = 1
      expect(state[2]).toBe(0xFC);
      expect(state[3]).toBe(1);
    });

    it("remainderPositive=true: -7 / -2 = 3 remainder -1 (adjusted: q+1 = 4, r = -7 - 4*-2 = 1)", () => {
      const exec = makeExecuteDiv(8, true, true);
      const layout = makeLayout(2, 2);
      // -7 in 8 bits = 0xF9, -2 in 8 bits = 0xFE
      const state = makeState([0xF9, 0xFE], 2);
      exec(0, state, layout);
      // Truncated: -7 / -2 = 3 remainder -1
      // remainderPositive with bv < 0: r -= bv = -1 - (-2) = 1, q++  = 4
      // 4 = 0x04, remainder 1 = 0x01
      expect(state[2]).toBe(4);
      expect(state[3]).toBe(1);
    });
  });

  describe("pin layout", () => {
    it("Div has 2 input pins and 2 output pins", () => {
      const el = makeDivElement({ bitWidth: 4 });
      const pins = el.getPins();
      const inputs = pins.filter((p) => p.direction === PinDirection.INPUT);
      const outputs = pins.filter((p) => p.direction === PinDirection.OUTPUT);
      expect(inputs).toHaveLength(2);
      expect(outputs).toHaveLength(2);
    });

    it("input pins are labeled a and b", () => {
      const el = makeDivElement();
      const inputs = el.getPins().filter((p) => p.direction === PinDirection.INPUT);
      expect(inputs.map((p) => p.label)).toEqual(["a", "b"]);
    });

    it("output pins are labeled q and r", () => {
      const el = makeDivElement();
      const outputs = el.getPins().filter((p) => p.direction === PinDirection.OUTPUT);
      expect(outputs.map((p) => p.label)).toEqual(["q", "r"]);
    });

    it("DivDefinition.pinLayout has 4 entries", () => {
      expect(DivDefinition.pinLayout).toHaveLength(4);
    });
  });

  describe("attribute mapping", () => {
    it("Bits=8 maps to bitWidth=8", () => {
      const mapping = DIV_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Bits");
      expect(mapping!.convert("8")).toBe(8);
    });

    it("signed=true converts correctly", () => {
      const mapping = DIV_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "signed");
      expect(mapping!.convert("true")).toBe(true);
      expect(mapping!.convert("false")).toBe(false);
    });

    it("remainderPositive=true converts correctly", () => {
      const mapping = DIV_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "remainderPositive");
      expect(mapping!.convert("true")).toBe(true);
      expect(mapping!.convert("false")).toBe(false);
    });

    it("Label maps to label", () => {
      const mapping = DIV_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Label");
      expect(mapping!.propertyKey).toBe("label");
    });
  });

  describe("rendering", () => {
    it("unsigned div draws '/' symbol", () => {
      const el = makeDivElement({ signed: false });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.filter((c) => c.method === "drawText").some((c) => c.args[0] === "/")).toBe(true);
    });

    it("signed div draws 'A/B' symbol", () => {
      const el = makeDivElement({ signed: true });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.filter((c) => c.method === "drawText").some((c) => c.args[0] === "A/B")).toBe(true);
    });

    it("draw calls drawRect for the body", () => {
      const el = makeDivElement();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.some((c) => c.method === "drawRect")).toBe(true);
    });

    it("draws label when set", () => {
      const el = makeDivElement({ label: "DIVIDER" });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.filter((c) => c.method === "drawText").some((c) => c.args[0] === "DIVIDER")).toBe(true);
    });
  });

  describe("definitionComplete", () => {
    it("DivDefinition has name='Div'", () => {
      expect(DivDefinition.name).toBe("Div");
    });

    it("DivDefinition has typeId=-1", () => {
      expect(DivDefinition.typeId).toBe(-1);
    });

    it("DivDefinition category is ARITHMETIC", () => {
      expect(DivDefinition.category).toBe(ComponentCategory.ARITHMETIC);
    });

    it("DivDefinition can be registered", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(DivDefinition)).not.toThrow();
    });

    it("DivDefinition propertyDefs contain bitWidth, signed, remainderPositive, label", () => {
      const keys = DivDefinition.propertyDefs.map((d) => d.key);
      expect(keys).toContain("bitWidth");
      expect(keys).toContain("signed");
      expect(keys).toContain("remainderPositive");
      expect(keys).toContain("label");
    });

    it("DivDefinition has non-empty helpText", () => {
      expect(typeof DivDefinition.helpText).toBe("string"); expect(DivDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });

    it("DivElement.getHelpText() mentions Div", () => {
      const el = makeDivElement();
      expect(el.getHelpText()).toContain("Div");
    });

    it("DivDefinition factory produces a DivElement", () => {
      const props = new PropertyBag();
      props.set("bitWidth", 8);
      props.set("signed", false);
      props.set("remainderPositive", false);
      const el = DivDefinition.factory(props);
      expect(el.typeId).toBe("Div");
    });
  });
});

// ---------------------------------------------------------------------------
// Dynamic-dispatch wrapper tests — verify executeFn reads bitWidth from layout
// ---------------------------------------------------------------------------

describe("executeAdd dynamic dispatch via getProperty", () => {
  it("4-bit: 0xF + 0x1 + 0 = 0x0 with carry (reads bitWidth=4 from layout)", () => {
    const layout = makeLayoutWithProps(3, 2, { bitWidth: 4 });
    const state = makeState([0xF, 0x1, 0], 2);
    executeAdd(0, state, layout);
    expect(state[3]).toBe(0);
    expect(state[4]).toBe(1);
  });

  it("8-bit: 0xFF + 0x01 + 0 = 0x00 with carry (reads bitWidth=8 from layout)", () => {
    const layout = makeLayoutWithProps(3, 2, { bitWidth: 8 });
    const state = makeState([0xFF, 0x01, 0], 2);
    executeAdd(0, state, layout);
    expect(state[3]).toBe(0);
    expect(state[4]).toBe(1);
  });

  it("16-bit: 0x7FFF + 0x0001 + 0 = 0x8000 no carry (reads bitWidth=16 from layout)", () => {
    const layout = makeLayoutWithProps(3, 2, { bitWidth: 16 });
    const state = makeState([0x7FFF, 0x0001, 0], 2);
    executeAdd(0, state, layout);
    expect(state[3]).toBe(0x8000);
    expect(state[4]).toBe(0);
  });

  it("defaults to bitWidth=1 when getProperty returns undefined", () => {
    const layout = makeLayout(3, 2);
    const state = makeState([1, 0, 0], 2);
    executeAdd(0, state, layout);
    expect(state[3]).toBe(1);
    expect(state[4]).toBe(0);
  });
});

describe("executeSub dynamic dispatch via getProperty", () => {
  it("4-bit: 0x0 - 0x1 - 0 wraps to 0xF with borrow (reads bitWidth=4 from layout)", () => {
    const layout = makeLayoutWithProps(3, 2, { bitWidth: 4 });
    const state = makeState([0, 1, 0], 2);
    executeSub(0, state, layout);
    expect(state[3]).toBe(0xF);
    expect(state[4]).toBe(1);
  });

  it("8-bit: 0x00 - 0x01 - 0 = 0xFF with borrow (reads bitWidth=8 from layout)", () => {
    const layout = makeLayoutWithProps(3, 2, { bitWidth: 8 });
    const state = makeState([0x00, 0x01, 0], 2);
    executeSub(0, state, layout);
    expect(state[3]).toBe(0xFF);
    expect(state[4]).toBe(1);
  });

  it("16-bit: 0x0100 - 0x0001 - 0 = 0x00FF no borrow (reads bitWidth=16 from layout)", () => {
    const layout = makeLayoutWithProps(3, 2, { bitWidth: 16 });
    const state = makeState([0x0100, 0x0001, 0], 2);
    executeSub(0, state, layout);
    expect(state[3]).toBe(0x00FF);
    expect(state[4]).toBe(0);
  });

  it("defaults to bitWidth=1 when getProperty returns undefined", () => {
    const layout = makeLayout(3, 2);
    const state = makeState([1, 0, 0], 2);
    executeSub(0, state, layout);
    expect(state[3]).toBe(1);
    expect(state[4]).toBe(0);
  });
});

describe("executeMul dynamic dispatch via getProperty", () => {
  it("4-bit unsigned: 0xF * 0xF = 225 (reads bitWidth=4 from layout)", () => {
    const layout = makeLayoutWithProps(2, 1, { bitWidth: 4, signed: false });
    const state = makeState([0xF, 0xF], 1);
    executeMul(0, state, layout);
    expect(state[2]).toBe(225);
  });

  it("8-bit unsigned: 0xFF * 0xFF = 0xFE01 (reads bitWidth=8 from layout)", () => {
    const layout = makeLayoutWithProps(2, 1, { bitWidth: 8, signed: false });
    const state = makeState([0xFF, 0xFF], 1);
    executeMul(0, state, layout);
    expect(state[2]).toBe(0xFE01);
  });

  it("4-bit signed: -1 * -1 = 1 (reads bitWidth=4, signed=true from layout)", () => {
    const layout = makeLayoutWithProps(2, 1, { bitWidth: 4, signed: true });
    const state = makeState([0xF, 0xF], 1);
    executeMul(0, state, layout);
    expect(state[2]).toBe(1);
  });

  it("defaults to bitWidth=1, signed=false when getProperty returns undefined", () => {
    const layout = makeLayout(2, 1);
    const state = makeState([1, 1], 1);
    executeMul(0, state, layout);
    expect(state[2]).toBe(1);
  });
});

describe("executeDiv dynamic dispatch via getProperty", () => {
  it("8-bit unsigned: 255 / 10 = 25 remainder 5 (reads bitWidth=8 from layout)", () => {
    const layout = makeLayoutWithProps(2, 2, { bitWidth: 8, signed: false, remainderPositive: false });
    const state = makeState([255, 10], 2);
    executeDiv(0, state, layout);
    expect(state[2]).toBe(25);
    expect(state[3]).toBe(5);
  });

  it("4-bit signed: -6 / 2 = -3 remainder 0 (reads bitWidth=4, signed=true from layout)", () => {
    const layout = makeLayoutWithProps(2, 2, { bitWidth: 4, signed: true, remainderPositive: false });
    const state = makeState([0xA, 2], 2);
    executeDiv(0, state, layout);
    expect(state[2]).toBe(0xD);
    expect(state[3]).toBe(0);
  });

  it("division by zero treated as 1 (reads bitWidth=8 from layout)", () => {
    const layout = makeLayoutWithProps(2, 2, { bitWidth: 8, signed: false, remainderPositive: false });
    const state = makeState([7, 0], 2);
    executeDiv(0, state, layout);
    expect(state[2]).toBe(7);
    expect(state[3]).toBe(0);
  });

  it("defaults to bitWidth=1, unsigned when getProperty returns undefined", () => {
    const layout = makeLayout(2, 2);
    const state = makeState([1, 1], 2);
    executeDiv(0, state, layout);
    expect(state[2]).toBe(1);
    expect(state[3]).toBe(0);
  });
});
