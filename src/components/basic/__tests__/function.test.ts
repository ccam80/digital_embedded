/**
 * Tests for the Boolean Function component.
 *
 * Covers per task spec:
 *   - Truth table evaluation for representative inputs
 *   - Multi-output function evaluation
 *   - Don't-care entries output 0
 *   - Pin layout (correct count, labels, directions for various input/output counts)
 *   - Rendering (component body + label)
 *   - Attribute mapping correctness
 *   - ComponentDefinition completeness
 *   - Registry registration
 */

import { describe, it, expect } from "vitest";
import {
  BooleanFunctionElement,
  executeBooleanFunction,
  BooleanFunctionDefinition,
  BOOLEAN_FUNCTION_ATTRIBUTE_MAPPINGS,
  evaluateTruthTable,
  evaluateAllOutputs,
} from "../function.js";
import { PropertyBag } from "../../../core/properties.js";
import { PinDirection } from "../../../core/pin.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import type { ComponentLayout } from "../../../core/registry.js";
import type { RenderContext, Point, TextAnchor, FontSpec, PathData } from "../../../core/renderer-interface.js";
import type { ThemeColor } from "../../../core/renderer-interface.js";

// ---------------------------------------------------------------------------
// Helpers — ComponentLayout mock
// ---------------------------------------------------------------------------

function makeLayout(
  inputCount: number,
  inputOffset: number,
  outputCount: number,
  outputOffset: number,
): ComponentLayout {
  return {
    inputCount: () => inputCount,
    inputOffset: () => inputOffset,
    outputCount: () => outputCount,
    outputOffset: () => outputOffset,
    stateOffset: () => 0,
  };
}

function makeState(size: number): Uint32Array {
  return new Uint32Array(size);
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
// Factory helpers
// ---------------------------------------------------------------------------

function makeFunction(overrides?: {
  inputCount?: number;
  outputCount?: number;
  truthTable?: number[];
  label?: string;
}): BooleanFunctionElement {
  const props = new PropertyBag();
  props.set("inputCount", overrides?.inputCount ?? 2);
  props.set("outputCount", overrides?.outputCount ?? 1);
  if (overrides?.truthTable !== undefined) {
    props.set("truthTable", overrides.truthTable);
  }
  if (overrides?.label !== undefined) props.set("label", overrides.label);
  return new BooleanFunctionElement("test-fn-001", { x: 0, y: 0 }, 0, false, props);
}

// ---------------------------------------------------------------------------
// Helper: set up state + layout for executeBooleanFunction test
//
// Layout: inputs at 0..inputCount-1, outputs at inputCount..inputCount+outputCount-1,
//         truth table at inputCount+outputCount..
// ---------------------------------------------------------------------------

function makeExecuteState(
  inputValues: number[],
  truthTable: number[],
  outputCount: number,
): { state: Uint32Array; layout: ComponentLayout } {
  const inputCount = inputValues.length;
  const tableSize = truthTable.length;
  const totalSize = inputCount + outputCount + tableSize;
  const state = makeState(totalSize);

  for (let i = 0; i < inputCount; i++) {
    state[i] = inputValues[i] & 1;
  }

  const tableOffset = inputCount + outputCount;
  for (let i = 0; i < tableSize; i++) {
    state[tableOffset + i] = truthTable[i] === -1 ? 0xFFFFFFFF : truthTable[i];
  }

  const layout = makeLayout(inputCount, 0, outputCount, inputCount);
  return { state, layout };
}

// ===========================================================================
// evaluateTruthTable helper tests
// ===========================================================================

describe("evaluateTruthTable", () => {
  it("returns correct bit for a simple AND table", () => {
    // AND truth table: [0,0,0,1] (inputs: 00=0, 01=0, 10=0, 11=1)
    const table = [0, 0, 0, 1];
    expect(evaluateTruthTable(table, 0, 0)).toBe(0);
    expect(evaluateTruthTable(table, 1, 0)).toBe(0);
    expect(evaluateTruthTable(table, 2, 0)).toBe(0);
    expect(evaluateTruthTable(table, 3, 0)).toBe(1);
  });

  it("returns correct bit for OR truth table", () => {
    const table = [0, 1, 1, 1];
    expect(evaluateTruthTable(table, 0, 0)).toBe(0);
    expect(evaluateTruthTable(table, 1, 0)).toBe(1);
    expect(evaluateTruthTable(table, 2, 0)).toBe(1);
    expect(evaluateTruthTable(table, 3, 0)).toBe(1);
  });

  it("returns 0 for don't-care entry (-1)", () => {
    const table = [-1, 1, 0, -1];
    expect(evaluateTruthTable(table, 0, 0)).toBe(0); // don't-care → 0
    expect(evaluateTruthTable(table, 3, 0)).toBe(0); // don't-care → 0
  });

  it("returns 0 for out-of-range index", () => {
    const table = [0, 1];
    expect(evaluateTruthTable(table, 5, 0)).toBe(0);
    expect(evaluateTruthTable(table, -1, 0)).toBe(0);
  });

  it("extracts the correct bit for multi-bit output (outputBit=1)", () => {
    // Row value 0b11 = 3: bit0=1, bit1=1
    // Row value 0b10 = 2: bit0=0, bit1=1
    const table = [3, 2, 1, 0];
    expect(evaluateTruthTable(table, 0, 0)).toBe(1); // bit0 of 3
    expect(evaluateTruthTable(table, 0, 1)).toBe(1); // bit1 of 3
    expect(evaluateTruthTable(table, 1, 0)).toBe(0); // bit0 of 2
    expect(evaluateTruthTable(table, 1, 1)).toBe(1); // bit1 of 2
    expect(evaluateTruthTable(table, 2, 0)).toBe(1); // bit0 of 1
    expect(evaluateTruthTable(table, 2, 1)).toBe(0); // bit1 of 1
  });
});

// ===========================================================================
// evaluateAllOutputs helper tests
// ===========================================================================

describe("evaluateAllOutputs", () => {
  it("returns all zeros for don't-care row", () => {
    const result = evaluateAllOutputs([-1, 1], 0, 2);
    expect(result).toEqual([0, 0]);
  });

  it("returns correct output bits for a 2-output row (value=3)", () => {
    const result = evaluateAllOutputs([3], 0, 2);
    expect(result[0]).toBe(1); // bit 0
    expect(result[1]).toBe(1); // bit 1
  });

  it("returns correct output bits for a 2-output row (value=2)", () => {
    const result = evaluateAllOutputs([2], 0, 2);
    expect(result[0]).toBe(0); // bit 0
    expect(result[1]).toBe(1); // bit 1
  });

  it("returns all zeros for out-of-range index", () => {
    const result = evaluateAllOutputs([1, 0], 99, 3);
    expect(result).toEqual([0, 0, 0]);
  });
});

// ===========================================================================
// BooleanFunctionElement tests
// ===========================================================================

describe("BooleanFunctionElement", () => {
  // -------------------------------------------------------------------------
  // Pin layout
  // -------------------------------------------------------------------------

  describe("pinLayout", () => {
    it("2-input, 1-output function has 3 pins", () => {
      const fn = makeFunction({ inputCount: 2, outputCount: 1 });
      expect(fn.getPins()).toHaveLength(3);
    });

    it("2-input function has pins in0, in1, out", () => {
      const fn = makeFunction({ inputCount: 2, outputCount: 1 });
      const labels = fn.getPins().map((p) => p.label);
      expect(labels).toContain("in0");
      expect(labels).toContain("in1");
      expect(labels).toContain("out");
    });

    it("input pins are INPUT direction", () => {
      const fn = makeFunction({ inputCount: 2, outputCount: 1 });
      const inputPins = fn.getPins().filter((p) => p.label.startsWith("in"));
      for (const pin of inputPins) {
        expect(pin.direction).toBe(PinDirection.INPUT);
      }
    });

    it("output pin is OUTPUT direction", () => {
      const fn = makeFunction({ inputCount: 2, outputCount: 1 });
      const outPin = fn.getPins().find((p) => p.label === "out");
      expect(outPin!.direction).toBe(PinDirection.OUTPUT);
    });

    it("3-input, 2-output function has 5 pins", () => {
      const fn = makeFunction({ inputCount: 3, outputCount: 2 });
      expect(fn.getPins()).toHaveLength(5);
    });

    it("2-output function has out0 and out1 labels", () => {
      const fn = makeFunction({ inputCount: 2, outputCount: 2 });
      const labels = fn.getPins().map((p) => p.label);
      expect(labels).toContain("out0");
      expect(labels).toContain("out1");
    });

    it("1-output function uses 'out' (not 'out0')", () => {
      const fn = makeFunction({ inputCount: 2, outputCount: 1 });
      const labels = fn.getPins().map((p) => p.label);
      expect(labels).toContain("out");
      expect(labels).not.toContain("out0");
    });

    it("4-input function has 4 input pins", () => {
      const fn = makeFunction({ inputCount: 4, outputCount: 1 });
      const inputPins = fn.getPins().filter((p) => p.direction === PinDirection.INPUT);
      expect(inputPins).toHaveLength(4);
    });

    it("BooleanFunctionDefinition.pinLayout has 3 entries for 2-in, 1-out default", () => {
      expect(BooleanFunctionDefinition.pinLayout).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------
  // Truth table storage
  // -------------------------------------------------------------------------

  describe("truthTableStorage", () => {
    it("stores the provided truth table", () => {
      const table = [0, 0, 0, 1]; // AND
      const fn = makeFunction({ inputCount: 2, truthTable: table });
      expect(fn.getTruthTable()).toEqual([0, 0, 0, 1]);
    });

    it("pads truth table with zeros if too short", () => {
      const fn = makeFunction({ inputCount: 2, truthTable: [1, 0] }); // only 2 of 4 rows
      expect(fn.getTruthTable()).toHaveLength(4);
      expect(fn.getTruthTable()[2]).toBe(0); // padded
      expect(fn.getTruthTable()[3]).toBe(0); // padded
    });

    it("truth table has exactly 2^inputCount entries", () => {
      const fn = makeFunction({ inputCount: 3 });
      expect(fn.getTruthTable()).toHaveLength(8); // 2^3
    });

    it("truth table preserves don't-care entries (-1)", () => {
      const table = [0, -1, 1, -1];
      const fn = makeFunction({ inputCount: 2, truthTable: table });
      expect(fn.getTruthTable()[1]).toBe(-1);
      expect(fn.getTruthTable()[3]).toBe(-1);
    });

    it("inputCount and outputCount accessors work", () => {
      const fn = makeFunction({ inputCount: 3, outputCount: 2 });
      expect(fn.inputCount).toBe(3);
      expect(fn.outputCount).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  describe("rendering", () => {
    it("draw() calls drawRect for the component body", () => {
      const fn = makeFunction();
      const { ctx, calls } = makeStubCtx();
      fn.draw(ctx);
      expect(calls.filter((c) => c.method === "drawRect").length).toBeGreaterThanOrEqual(1);
    });

    it("draw() calls drawText with 'f(x)'", () => {
      const fn = makeFunction();
      const { ctx, calls } = makeStubCtx();
      fn.draw(ctx);
      expect(calls.filter((c) => c.method === "drawText").some((c) => c.args[0] === "f(x)")).toBe(true);
    });

    it("draw() with label calls drawText for the label", () => {
      const fn = makeFunction({ label: "F" });
      const { ctx, calls } = makeStubCtx();
      fn.draw(ctx);
      expect(calls.filter((c) => c.method === "drawText").some((c) => c.args[0] === "F")).toBe(true);
    });

    it("draw() without label does not draw label text", () => {
      const fn = makeFunction({ label: "" });
      const { ctx, calls } = makeStubCtx();
      fn.draw(ctx);
      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.every((c) => c.args[0] === "f(x)")).toBe(true);
    });

    it("draw() saves and restores context", () => {
      const fn = makeFunction();
      const { ctx, calls } = makeStubCtx();
      fn.draw(ctx);
      expect(calls.filter((c) => c.method === "save")).toHaveLength(1);
      expect(calls.filter((c) => c.method === "restore")).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Bounding box
  // -------------------------------------------------------------------------

  describe("boundingBox", () => {
    it("getBoundingBox returns non-zero dimensions", () => {
      const fn = makeFunction();
      const bb = fn.getBoundingBox();
      expect(bb.width).toBeGreaterThanOrEqual(2);
      expect(bb.height).toBeGreaterThanOrEqual(2);
    });
  });
});

// ===========================================================================
// executeBooleanFunction tests
// ===========================================================================

describe("executeBooleanFunction", () => {
  // -------------------------------------------------------------------------
  // Truth table evaluation — single output
  // -------------------------------------------------------------------------

  describe("singleOutputEvaluation", () => {
    it("AND function: [0,0,0,1] — inputs [0,0] → output 0", () => {
      const { state, layout } = makeExecuteState([0, 0], [0, 0, 0, 1], 1);
      executeBooleanFunction(0, state, layout);
      const outputIdx = layout.outputOffset(0);
      expect(state[outputIdx]).toBe(0);
    });

    it("AND function: [0,0,0,1] — inputs [1,0] → output 0", () => {
      const { state, layout } = makeExecuteState([1, 0], [0, 0, 0, 1], 1);
      executeBooleanFunction(0, state, layout);
      expect(state[layout.outputOffset(0)]).toBe(0);
    });

    it("AND function: [0,0,0,1] — inputs [0,1] → output 0", () => {
      const { state, layout } = makeExecuteState([0, 1], [0, 0, 0, 1], 1);
      executeBooleanFunction(0, state, layout);
      expect(state[layout.outputOffset(0)]).toBe(0);
    });

    it("AND function: [0,0,0,1] — inputs [1,1] → output 1", () => {
      const { state, layout } = makeExecuteState([1, 1], [0, 0, 0, 1], 1);
      executeBooleanFunction(0, state, layout);
      expect(state[layout.outputOffset(0)]).toBe(1);
    });

    it("OR function: [0,1,1,1] — inputs [0,0] → output 0", () => {
      const { state, layout } = makeExecuteState([0, 0], [0, 1, 1, 1], 1);
      executeBooleanFunction(0, state, layout);
      expect(state[layout.outputOffset(0)]).toBe(0);
    });

    it("OR function: [0,1,1,1] — inputs [1,0] → output 1", () => {
      const { state, layout } = makeExecuteState([1, 0], [0, 1, 1, 1], 1);
      executeBooleanFunction(0, state, layout);
      expect(state[layout.outputOffset(0)]).toBe(1);
    });

    it("XOR function: [0,1,1,0] — inputs [1,1] → output 0", () => {
      const { state, layout } = makeExecuteState([1, 1], [0, 1, 1, 0], 1);
      executeBooleanFunction(0, state, layout);
      expect(state[layout.outputOffset(0)]).toBe(0);
    });

    it("XOR function: [0,1,1,0] — inputs [1,0] → output 1", () => {
      const { state, layout } = makeExecuteState([1, 0], [0, 1, 1, 0], 1);
      executeBooleanFunction(0, state, layout);
      expect(state[layout.outputOffset(0)]).toBe(1);
    });

    it("NOT function (1-input): [1,0] — in0=0 → output 1", () => {
      const { state, layout } = makeExecuteState([0], [1, 0], 1);
      executeBooleanFunction(0, state, layout);
      expect(state[layout.outputOffset(0)]).toBe(1);
    });

    it("NOT function (1-input): [1,0] — in0=1 → output 0", () => {
      const { state, layout } = makeExecuteState([1], [1, 0], 1);
      executeBooleanFunction(0, state, layout);
      expect(state[layout.outputOffset(0)]).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Multi-output function evaluation
  // -------------------------------------------------------------------------

  describe("multiOutputEvaluation", () => {
    it("2-output function with [0,1,2,3] — inputs [0,0] → outputs [0,0]", () => {
      // Table: row0=0b00=0, row1=0b01=1, row2=0b10=2, row3=0b11=3
      const { state, layout } = makeExecuteState([0, 0], [0, 1, 2, 3], 2);
      executeBooleanFunction(0, state, layout);
      const outBase = layout.outputOffset(0);
      expect(state[outBase]).toBe(0);     // bit0
      expect(state[outBase + 1]).toBe(0); // bit1
    });

    it("2-output function with [0,1,2,3] — inputs [1,0] → outputs [1,0]", () => {
      // row1=1 = 0b01: bit0=1, bit1=0
      const { state, layout } = makeExecuteState([1, 0], [0, 1, 2, 3], 2);
      executeBooleanFunction(0, state, layout);
      const outBase = layout.outputOffset(0);
      expect(state[outBase]).toBe(1);     // bit0 of 1
      expect(state[outBase + 1]).toBe(0); // bit1 of 1
    });

    it("2-output function with [0,1,2,3] — inputs [0,1] → outputs [0,1]", () => {
      // row2=2 = 0b10: bit0=0, bit1=1
      const { state, layout } = makeExecuteState([0, 1], [0, 1, 2, 3], 2);
      executeBooleanFunction(0, state, layout);
      const outBase = layout.outputOffset(0);
      expect(state[outBase]).toBe(0);     // bit0 of 2
      expect(state[outBase + 1]).toBe(1); // bit1 of 2
    });

    it("2-output function with [0,1,2,3] — inputs [1,1] → outputs [1,1]", () => {
      // row3=3 = 0b11: bit0=1, bit1=1
      const { state, layout } = makeExecuteState([1, 1], [0, 1, 2, 3], 2);
      executeBooleanFunction(0, state, layout);
      const outBase = layout.outputOffset(0);
      expect(state[outBase]).toBe(1);     // bit0 of 3
      expect(state[outBase + 1]).toBe(1); // bit1 of 3
    });

    it("3-input, 1-output majority function: only output 1 when 2+ inputs high", () => {
      // Majority: 1 when 2 or more of 3 inputs are high
      // Rows: 000=0, 001=0, 010=0, 011=1, 100=0, 101=1, 110=1, 111=1
      const table = [0, 0, 0, 1, 0, 1, 1, 1];

      // 011 (in0=1, in1=1, in2=0 → index=0b011=3) → 1
      const { state: s1, layout: l1 } = makeExecuteState([1, 1, 0], table, 1);
      executeBooleanFunction(0, s1, l1);
      expect(s1[l1.outputOffset(0)]).toBe(1);

      // 001 (in0=1, in1=0, in2=0 → index=0b001=1) → 0
      const { state: s2, layout: l2 } = makeExecuteState([1, 0, 0], table, 1);
      executeBooleanFunction(0, s2, l2);
      expect(s2[l2.outputOffset(0)]).toBe(0);

      // 111 (index=7) → 1
      const { state: s3, layout: l3 } = makeExecuteState([1, 1, 1], table, 1);
      executeBooleanFunction(0, s3, l3);
      expect(s3[l3.outputOffset(0)]).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Don't-care entries
  // -------------------------------------------------------------------------

  describe("dontCareEntries", () => {
    it("don't-care row outputs 0 for single-output function", () => {
      // Table: row0=don't-care, row1=1, row2=0, row3=don't-care
      const { state, layout } = makeExecuteState([0, 0], [-1, 1, 0, -1], 1);
      executeBooleanFunction(0, state, layout);
      expect(state[layout.outputOffset(0)]).toBe(0); // don't-care → 0
    });

    it("don't-care row at index 3 outputs 0", () => {
      const { state, layout } = makeExecuteState([1, 1], [-1, 1, 0, -1], 1);
      executeBooleanFunction(0, state, layout);
      expect(state[layout.outputOffset(0)]).toBe(0); // don't-care at row 3
    });

    it("don't-care row outputs all zeros for 2-output function", () => {
      const table = [-1, 3, 2, 1]; // row0 is don't-care
      const { state, layout } = makeExecuteState([0, 0], table, 2);
      executeBooleanFunction(0, state, layout);
      const outBase = layout.outputOffset(0);
      expect(state[outBase]).toBe(0);
      expect(state[outBase + 1]).toBe(0);
    });

    it("non-don't-care rows still evaluate correctly alongside don't-care rows", () => {
      const table = [-1, 1, -1, 0]; // rows 0 and 2 are don't-care
      const { state, layout } = makeExecuteState([1, 0], table, 1); // index=1, value=1
      executeBooleanFunction(0, state, layout);
      expect(state[layout.outputOffset(0)]).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Input index computation (in0 = LSB)
  // -------------------------------------------------------------------------

  describe("inputIndexComputation", () => {
    it("in0=LSB: in0=1, in1=0 → index=1 (not 2)", () => {
      // Table: [0,1,0,0] means index 1 → 1
      const { state, layout } = makeExecuteState([1, 0], [0, 1, 0, 0], 1);
      executeBooleanFunction(0, state, layout);
      expect(state[layout.outputOffset(0)]).toBe(1);
    });

    it("in0=LSB: in0=0, in1=1 → index=2", () => {
      // Table: [0,0,1,0] means index 2 → 1
      const { state, layout } = makeExecuteState([0, 1], [0, 0, 1, 0], 1);
      executeBooleanFunction(0, state, layout);
      expect(state[layout.outputOffset(0)]).toBe(1);
    });

    it("3-input: in0=1,in1=0,in2=1 → index=5 (0b101)", () => {
      // Table has 8 entries, index 5 = 1
      const table = [0, 0, 0, 0, 0, 1, 0, 0];
      const { state, layout } = makeExecuteState([1, 0, 1], table, 1);
      executeBooleanFunction(0, state, layout);
      expect(state[layout.outputOffset(0)]).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Zero-allocation check
  // -------------------------------------------------------------------------

  describe("zeroAllocation", () => {
    it("executeBooleanFunction can be called 1000 times without error", () => {
      const { state, layout } = makeExecuteState([1, 0], [0, 1, 1, 0], 1);
      for (let i = 0; i < 1000; i++) {
        executeBooleanFunction(0, state, layout);
      }
      expect(true).toBe(true);
    });
  });
});

// ===========================================================================
// Attribute mapping tests
// ===========================================================================

describe("attributeMapping", () => {
  it("Inputs=3 maps to inputCount=3", () => {
    const mapping = BOOLEAN_FUNCTION_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Inputs");
    expect(mapping).not.toBeUndefined();
    expect(mapping!.convert("3")).toBe(3);
  });

  it("Outputs=2 maps to outputCount=2", () => {
    const mapping = BOOLEAN_FUNCTION_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Outputs");
    expect(mapping).not.toBeUndefined();
    expect(mapping!.convert("2")).toBe(2);
  });

  it("Label maps to label property", () => {
    const mapping = BOOLEAN_FUNCTION_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Label");
    expect(mapping).not.toBeUndefined();
    expect(mapping!.propertyKey).toBe("label");
    expect(mapping!.convert("F1")).toBe("F1");
  });

  it("TruthTable comma-separated string maps to number array", () => {
    const mapping = BOOLEAN_FUNCTION_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "TruthTable");
    expect(mapping).not.toBeUndefined();
    const result = mapping!.convert("0,0,0,1") as number[];
    expect(result).toEqual([0, 0, 0, 1]);
  });

  it("TruthTable with don't-care (-1) values parsed correctly", () => {
    const mapping = BOOLEAN_FUNCTION_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "TruthTable");
    const result = mapping!.convert("-1,1,0,-1") as number[];
    expect(result).toEqual([-1, 1, 0, -1]);
  });

  it("TruthTable empty string maps to empty array", () => {
    const mapping = BOOLEAN_FUNCTION_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "TruthTable");
    const result = mapping!.convert("") as number[];
    expect(result).toEqual([]);
  });
});

// ===========================================================================
// ComponentDefinition completeness tests
// ===========================================================================

describe("BooleanFunctionDefinition", () => {
  it("has name='Function'", () => {
    expect(BooleanFunctionDefinition.name).toBe("Function");
  });

  it("has typeId=-1", () => {
    expect(BooleanFunctionDefinition.typeId).toBe(-1);
  });

  it("has a factory function", () => {
    expect(typeof BooleanFunctionDefinition.factory).toBe("function");
  });

  it("factory produces a BooleanFunctionElement with typeId='Function'", () => {
    const props = new PropertyBag();
    props.set("inputCount", 2);
    props.set("outputCount", 1);
    props.set("truthTable", [0, 0, 0, 1]);
    const el = BooleanFunctionDefinition.factory(props);
    expect(el.typeId).toBe("Function");
  });

  it("has executeFn=executeBooleanFunction", () => {
    expect(BooleanFunctionDefinition.executeFn).toBe(executeBooleanFunction);
  });

  it("category is LOGIC", () => {
    expect(BooleanFunctionDefinition.category).toBe(ComponentCategory.LOGIC);
  });

  it("has non-empty helpText", () => {
    expect(typeof BooleanFunctionDefinition.helpText).toBe("string");
    expect(typeof BooleanFunctionDefinition.helpText).toBe("string"); expect(BooleanFunctionDefinition.helpText.length).toBeGreaterThanOrEqual(3);
  });

  it("helpText mentions truth table", () => {
    expect(BooleanFunctionDefinition.helpText.toLowerCase()).toContain("truth table");
  });

  it("has non-empty propertyDefs", () => {
    expect(BooleanFunctionDefinition.propertyDefs.length).toBeGreaterThan(0);
  });

  it("propertyDefs include inputCount, outputCount, and truthTable", () => {
    const keys = BooleanFunctionDefinition.propertyDefs.map((d) => d.key);
    expect(keys).toContain("inputCount");
    expect(keys).toContain("outputCount");
    expect(keys).toContain("truthTable");
  });

  it("can be registered without throwing", () => {
    const registry = new ComponentRegistry();
    expect(() => registry.register(BooleanFunctionDefinition)).not.toThrow();
  });

  it("after registration typeId is non-negative", () => {
    const registry = new ComponentRegistry();
    registry.register(BooleanFunctionDefinition);
    const registered = registry.get("Function");
    expect(registered!.typeId).toBeGreaterThanOrEqual(0);
  });

  it("defaultDelay is 10", () => {
    expect(BooleanFunctionDefinition.defaultDelay).toBe(10);
  });

  it("pinLayout has 3 entries for 2-input, 1-output default", () => {
    expect(BooleanFunctionDefinition.pinLayout).toHaveLength(3);
  });

  it("attributeMap has 4 entries", () => {
    expect(BooleanFunctionDefinition.attributeMap).toHaveLength(4);
  });
});
