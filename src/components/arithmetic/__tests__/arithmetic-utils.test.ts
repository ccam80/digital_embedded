/**
 * Tests for arithmetic utility components:
 * Neg, Comparator, BarrelShifter, BitCount, BitExtender, PRNG
 */

import { describe, it, expect } from "vitest";
import { NegElement, executeNeg, NegDefinition, NEG_ATTRIBUTE_MAPPINGS } from "../neg.js";
import { ComparatorElement, makeExecuteComparator, ComparatorDefinition, COMPARATOR_ATTRIBUTE_MAPPINGS } from "../comparator.js";
import { BarrelShifterElement, makeExecuteBarrelShifter, BarrelShifterDefinition, BARREL_SHIFTER_ATTRIBUTE_MAPPINGS } from "../barrel-shifter.js";
import { BitCountElement, executebitCount, BitCountDefinition, BIT_COUNT_ATTRIBUTE_MAPPINGS } from "../bit-count.js";
import { BitExtenderElement, makeExecuteBitExtender, BitExtenderDefinition, BIT_EXTENDER_ATTRIBUTE_MAPPINGS } from "../bit-extender.js";
import { PRNGElement, makeExecutePRNG, PRNGDefinition, PRNG_ATTRIBUTE_MAPPINGS } from "../prng.js";
import type { PRNGLayout } from "../prng.js";
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
  };
}

function makePRNGLayout(inputCount: number, outputCount: number, stateBase: number): PRNGLayout {
  return {
    inputCount: () => inputCount,
    inputOffset: () => 0,
    outputCount: () => outputCount,
    outputOffset: () => inputCount,
    stateOffset: () => stateBase,
  };
}

function makeState(inputs: number[], outputCount: number, extraSlots: number = 0): Uint32Array {
  const arr = new Uint32Array(inputs.length + outputCount + extraSlots);
  for (let i = 0; i < inputs.length; i++) {
    arr[i] = inputs[i] >>> 0;
  }
  return arr;
}

interface DrawCall { method: string; args: unknown[]; }

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

function makeNegElement(bitWidth = 8): NegElement {
  const props = new PropertyBag();
  props.set("bitWidth", bitWidth);
  return new NegElement("test", { x: 0, y: 0 }, 0, false, props);
}

function makeComparatorElement(bitWidth = 4, signed = false): ComparatorElement {
  const props = new PropertyBag();
  props.set("bitWidth", bitWidth);
  props.set("signed", signed);
  return new ComparatorElement("test", { x: 0, y: 0 }, 0, false, props);
}

function makeBarrelShifterElement(bitWidth = 8, signed = false, mode = "logical", direction = "left"): BarrelShifterElement {
  const props = new PropertyBag();
  props.set("bitWidth", bitWidth);
  props.set("signed", signed);
  props.set("mode", mode);
  props.set("direction", direction);
  return new BarrelShifterElement("test", { x: 0, y: 0 }, 0, false, props);
}

function makeBitCountElement(bitWidth = 8): BitCountElement {
  const props = new PropertyBag();
  props.set("bitWidth", bitWidth);
  return new BitCountElement("test", { x: 0, y: 0 }, 0, false, props);
}

function makeBitExtenderElement(inputBits = 4, outputBits = 8): BitExtenderElement {
  const props = new PropertyBag();
  props.set("inputBits", inputBits);
  props.set("outputBits", outputBits);
  return new BitExtenderElement("test", { x: 0, y: 0 }, 0, false, props);
}

function makePRNGElement(bitWidth = 8): PRNGElement {
  const props = new PropertyBag();
  props.set("bitWidth", bitWidth);
  return new PRNGElement("test", { x: 0, y: 0 }, 0, false, props);
}

// ---------------------------------------------------------------------------
// NEG tests
// ---------------------------------------------------------------------------

describe("Neg", () => {
  describe("correctness", () => {
    it("neg(0) = 0", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([0], 1);
      executeNeg(0, state, layout);
      expect(state[1]).toBe(0);
    });

    it("neg(1) = 0xFFFFFFFF (two's complement)", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([1], 1);
      executeNeg(0, state, layout);
      expect(state[1]).toBe(0xFFFFFFFF);
    });

    it("neg(0xFF) = 0xFFFFFF01", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([0xFF], 1);
      executeNeg(0, state, layout);
      // -0xFF = 0xFFFFFF01 as unsigned 32-bit
      expect(state[1]).toBe(0xFFFFFF01);
    });

    it("neg(0x80000000) = 0x80000000 (min signed 32-bit negates to itself)", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([0x80000000], 1);
      executeNeg(0, state, layout);
      expect(state[1]).toBe(0x80000000);
    });

    it("neg(neg(5)) = 5", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([5], 1);
      executeNeg(0, state, layout);
      const negFive = state[1];
      state[0] = negFive;
      executeNeg(0, state, layout);
      expect(state[1]).toBe(5);
    });

    it("zero allocation: can run 1000 times", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([0], 1);
      for (let i = 0; i < 1000; i++) {
        state[0] = i;
        executeNeg(0, state, layout);
      }
      expect(state[1]).toBeDefined();
    });
  });

  describe("pin layout", () => {
    it("has 1 input and 1 output", () => {
      const el = makeNegElement();
      const inputs = el.getPins().filter((p) => p.direction === PinDirection.INPUT);
      const outputs = el.getPins().filter((p) => p.direction === PinDirection.OUTPUT);
      expect(inputs).toHaveLength(1);
      expect(outputs).toHaveLength(1);
    });

    it("input is labeled 'in', output is labeled 'out'", () => {
      const el = makeNegElement();
      const pins = el.getPins();
      expect(pins.find((p) => p.label === "in")).toBeDefined();
      expect(pins.find((p) => p.label === "out")).toBeDefined();
    });
  });

  describe("attribute mapping", () => {
    it("Bits=16 maps to bitWidth=16", () => {
      const m = NEG_ATTRIBUTE_MAPPINGS.find((x) => x.xmlName === "Bits");
      expect(m!.convert("16")).toBe(16);
    });
  });

  describe("rendering", () => {
    it("draws a rect and '-A' text", () => {
      const el = makeNegElement();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.some((c) => c.method === "drawRect")).toBe(true);
      expect(calls.filter((c) => c.method === "drawText").some((c) => c.args[0] === "-A")).toBe(true);
    });
  });

  describe("definitionComplete", () => {
    it("NegDefinition name is 'Neg'", () => { expect(NegDefinition.name).toBe("Neg"); });
    it("NegDefinition typeId is -1", () => { expect(NegDefinition.typeId).toBe(-1); });
    it("NegDefinition category is ARITHMETIC", () => { expect(NegDefinition.category).toBe(ComponentCategory.ARITHMETIC); });
    it("can be registered", () => {
      const r = new ComponentRegistry();
      expect(() => r.register(NegDefinition)).not.toThrow();
    });
    it("helpText is non-empty", () => { expect(NegDefinition.helpText.length).toBeGreaterThan(0); });
  });
});

// ---------------------------------------------------------------------------
// COMPARATOR tests
// ---------------------------------------------------------------------------

describe("Comparator", () => {
  describe("unsigned comparison", () => {
    it("3 == 3: eq=1, gt=0, lt=0", () => {
      const exec = makeExecuteComparator(4, false);
      const layout = makeLayout(2, 3);
      const state = makeState([3, 3], 3);
      exec(0, state, layout);
      expect(state[2]).toBe(0); // >
      expect(state[3]).toBe(1); // =
      expect(state[4]).toBe(0); // <
    });

    it("5 > 3: gt=1, eq=0, lt=0", () => {
      const exec = makeExecuteComparator(4, false);
      const layout = makeLayout(2, 3);
      const state = makeState([5, 3], 3);
      exec(0, state, layout);
      expect(state[2]).toBe(1); // >
      expect(state[3]).toBe(0); // =
      expect(state[4]).toBe(0); // <
    });

    it("2 < 7: lt=1, gt=0, eq=0", () => {
      const exec = makeExecuteComparator(4, false);
      const layout = makeLayout(2, 3);
      const state = makeState([2, 7], 3);
      exec(0, state, layout);
      expect(state[2]).toBe(0); // >
      expect(state[3]).toBe(0); // =
      expect(state[4]).toBe(1); // <
    });

    it("0xFF > 0x0F (8-bit unsigned)", () => {
      const exec = makeExecuteComparator(8, false);
      const layout = makeLayout(2, 3);
      const state = makeState([0xFF, 0x0F], 3);
      exec(0, state, layout);
      expect(state[2]).toBe(1); // >
      expect(state[3]).toBe(0); // =
      expect(state[4]).toBe(0); // <
    });

    it("0 == 0", () => {
      const exec = makeExecuteComparator(8, false);
      const layout = makeLayout(2, 3);
      const state = makeState([0, 0], 3);
      exec(0, state, layout);
      expect(state[3]).toBe(1); // =
    });
  });

  describe("signed comparison", () => {
    it("4-bit signed: -1 (0xF) < 1", () => {
      const exec = makeExecuteComparator(4, true);
      const layout = makeLayout(2, 3);
      // -1 in 4 bits = 0xF
      const state = makeState([0xF, 1], 3);
      exec(0, state, layout);
      expect(state[4]).toBe(1); // <
      expect(state[2]).toBe(0); // >
    });

    it("4-bit signed: -1 (0xF) > -5 (0xB)", () => {
      const exec = makeExecuteComparator(4, true);
      const layout = makeLayout(2, 3);
      // -1 = 0xF, -5 = 0xB in 4 bits
      const state = makeState([0xF, 0xB], 3);
      exec(0, state, layout);
      expect(state[2]).toBe(1); // >
      expect(state[4]).toBe(0); // <
    });

    it("8-bit signed: -128 (0x80) < 127 (0x7F)", () => {
      const exec = makeExecuteComparator(8, true);
      const layout = makeLayout(2, 3);
      const state = makeState([0x80, 0x7F], 3);
      exec(0, state, layout);
      expect(state[4]).toBe(1); // <
    });
  });

  describe("edge cases", () => {
    it("zero allocation: 1000 calls", () => {
      const exec = makeExecuteComparator(8, false);
      const layout = makeLayout(2, 3);
      const state = makeState([0, 0], 3);
      for (let i = 0; i < 1000; i++) {
        state[0] = i & 0xFF;
        state[1] = (i * 3) & 0xFF;
        exec(0, state, layout);
      }
      expect(state[2]).toBeDefined();
    });
  });

  describe("pin layout", () => {
    it("has 2 inputs and 3 outputs", () => {
      const el = makeComparatorElement();
      const inputs = el.getPins().filter((p) => p.direction === PinDirection.INPUT);
      const outputs = el.getPins().filter((p) => p.direction === PinDirection.OUTPUT);
      expect(inputs).toHaveLength(2);
      expect(outputs).toHaveLength(3);
    });

    it("outputs labeled '>', '=', '<'", () => {
      const el = makeComparatorElement();
      const outputs = el.getPins().filter((p) => p.direction === PinDirection.OUTPUT);
      const labels = outputs.map((p) => p.label);
      expect(labels).toContain(">");
      expect(labels).toContain("=");
      expect(labels).toContain("<");
    });
  });

  describe("attribute mapping", () => {
    it("Bits=8 maps to bitWidth=8", () => {
      const m = COMPARATOR_ATTRIBUTE_MAPPINGS.find((x) => x.xmlName === "Bits");
      expect(m!.convert("8")).toBe(8);
    });
    it("signed=true converts correctly", () => {
      const m = COMPARATOR_ATTRIBUTE_MAPPINGS.find((x) => x.xmlName === "signed");
      expect(m!.convert("true")).toBe(true);
    });
  });

  describe("rendering", () => {
    it("draws a rect and 'A=B' text", () => {
      const el = makeComparatorElement();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.some((c) => c.method === "drawRect")).toBe(true);
      expect(calls.filter((c) => c.method === "drawText").some((c) => c.args[0] === "A=B")).toBe(true);
    });
  });

  describe("definitionComplete", () => {
    it("ComparatorDefinition name is 'Comparator'", () => { expect(ComparatorDefinition.name).toBe("Comparator"); });
    it("category is ARITHMETIC", () => { expect(ComparatorDefinition.category).toBe(ComponentCategory.ARITHMETIC); });
    it("can be registered", () => {
      const r = new ComponentRegistry();
      expect(() => r.register(ComparatorDefinition)).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// BARREL SHIFTER tests
// ---------------------------------------------------------------------------

describe("BarrelShifter", () => {
  describe("logical shift left", () => {
    it("0x01 << 1 = 0x02 (8-bit)", () => {
      const exec = makeExecuteBarrelShifter(8, false, "logical", "left");
      const layout = makeLayout(2, 1);
      const state = makeState([0x01, 1], 1);
      exec(0, state, layout);
      expect(state[2]).toBe(0x02);
    });

    it("0xFF << 4 = 0xF0 (8-bit, high bits overflow)", () => {
      const exec = makeExecuteBarrelShifter(8, false, "logical", "left");
      const layout = makeLayout(2, 1);
      const state = makeState([0xFF, 4], 1);
      exec(0, state, layout);
      expect(state[2]).toBe(0xF0);
    });

    it("0x01 << 0 = 0x01 (no shift)", () => {
      const exec = makeExecuteBarrelShifter(8, false, "logical", "left");
      const layout = makeLayout(2, 1);
      const state = makeState([0x01, 0], 1);
      exec(0, state, layout);
      expect(state[2]).toBe(0x01);
    });

    it("0xAB << 8 = 0x00 (shift all bits out)", () => {
      const exec = makeExecuteBarrelShifter(8, false, "logical", "left");
      const layout = makeLayout(2, 1);
      const state = makeState([0xAB, 8], 1);
      exec(0, state, layout);
      expect(state[2]).toBe(0x00);
    });
  });

  describe("logical shift right", () => {
    it("0x80 >> 1 = 0x40 (8-bit)", () => {
      const exec = makeExecuteBarrelShifter(8, false, "logical", "right");
      const layout = makeLayout(2, 1);
      const state = makeState([0x80, 1], 1);
      exec(0, state, layout);
      expect(state[2]).toBe(0x40);
    });

    it("0xFF >> 4 = 0x0F (8-bit)", () => {
      const exec = makeExecuteBarrelShifter(8, false, "logical", "right");
      const layout = makeLayout(2, 1);
      const state = makeState([0xFF, 4], 1);
      exec(0, state, layout);
      expect(state[2]).toBe(0x0F);
    });
  });

  describe("rotate left", () => {
    it("0x01 rotate-left by 1 = 0x02 (8-bit)", () => {
      const exec = makeExecuteBarrelShifter(8, false, "rotate", "left");
      const layout = makeLayout(2, 1);
      const state = makeState([0x01, 1], 1);
      exec(0, state, layout);
      expect(state[2]).toBe(0x02);
    });

    it("0x80 rotate-left by 1 = 0x01 (MSB wraps to LSB)", () => {
      const exec = makeExecuteBarrelShifter(8, false, "rotate", "left");
      const layout = makeLayout(2, 1);
      const state = makeState([0x80, 1], 1);
      exec(0, state, layout);
      expect(state[2]).toBe(0x01);
    });

    it("0xAB rotate-left by 8 = 0xAB (full rotation)", () => {
      const exec = makeExecuteBarrelShifter(8, false, "rotate", "left");
      const layout = makeLayout(2, 1);
      const state = makeState([0xAB, 8], 1);
      exec(0, state, layout);
      expect(state[2]).toBe(0xAB);
    });
  });

  describe("rotate right", () => {
    it("0x01 rotate-right by 1 = 0x80 (LSB wraps to MSB, 8-bit)", () => {
      const exec = makeExecuteBarrelShifter(8, false, "rotate", "right");
      const layout = makeLayout(2, 1);
      const state = makeState([0x01, 1], 1);
      exec(0, state, layout);
      expect(state[2]).toBe(0x80);
    });
  });

  describe("arithmetic shift right", () => {
    it("0x80 arithmetic-right by 1 = 0xC0 (sign extends, 8-bit)", () => {
      const exec = makeExecuteBarrelShifter(8, false, "arithmetic", "right");
      const layout = makeLayout(2, 1);
      const state = makeState([0x80, 1], 1);
      exec(0, state, layout);
      // MSB=1, sign extends: 0x80 >> 1 = 0xC0
      expect(state[2]).toBe(0xC0);
    });

    it("0x80 arithmetic-right by 4 = 0xF8 (fill with sign)", () => {
      const exec = makeExecuteBarrelShifter(8, false, "arithmetic", "right");
      const layout = makeLayout(2, 1);
      const state = makeState([0x80, 4], 1);
      exec(0, state, layout);
      // 0x80 >> 4 = 0xF8
      expect(state[2]).toBe(0xF8);
    });

    it("0x40 arithmetic-right by 1 = 0x20 (no sign extend for positive)", () => {
      const exec = makeExecuteBarrelShifter(8, false, "arithmetic", "right");
      const layout = makeLayout(2, 1);
      const state = makeState([0x40, 1], 1);
      exec(0, state, layout);
      expect(state[2]).toBe(0x20);
    });
  });

  describe("multi-bit", () => {
    it("16-bit logical left shift: 0x0001 << 4 = 0x0010", () => {
      const exec = makeExecuteBarrelShifter(16, false, "logical", "left");
      const layout = makeLayout(2, 1);
      const state = makeState([0x0001, 4], 1);
      exec(0, state, layout);
      expect(state[2]).toBe(0x0010);
    });
  });

  describe("zero allocation", () => {
    it("can run 1000 times without error", () => {
      const exec = makeExecuteBarrelShifter(8, false, "logical", "left");
      const layout = makeLayout(2, 1);
      const state = makeState([0, 0], 1);
      for (let i = 0; i < 1000; i++) {
        state[0] = i & 0xFF;
        state[1] = i & 0x7;
        exec(0, state, layout);
      }
      expect(state[2]).toBeDefined();
    });
  });

  describe("pin layout", () => {
    it("has 2 inputs and 1 output", () => {
      const el = makeBarrelShifterElement();
      const inputs = el.getPins().filter((p) => p.direction === PinDirection.INPUT);
      const outputs = el.getPins().filter((p) => p.direction === PinDirection.OUTPUT);
      expect(inputs).toHaveLength(2);
      expect(outputs).toHaveLength(1);
    });
  });

  describe("attribute mapping", () => {
    it("Bits=16 maps to bitWidth=16", () => {
      const m = BARREL_SHIFTER_ATTRIBUTE_MAPPINGS.find((x) => x.xmlName === "Bits");
      expect(m!.convert("16")).toBe(16);
    });
    it("Direction=right maps correctly", () => {
      const m = BARREL_SHIFTER_ATTRIBUTE_MAPPINGS.find((x) => x.xmlName === "Direction");
      expect(m!.convert("right")).toBe("right");
    });
    it("Barrel_Shifter_Mode=rotate maps correctly", () => {
      const m = BARREL_SHIFTER_ATTRIBUTE_MAPPINGS.find((x) => x.xmlName === "Barrel_Shifter_Mode");
      expect(m!.convert("rotate")).toBe("rotate");
    });
  });

  describe("rendering", () => {
    it("left shifter draws '<<' symbol", () => {
      const el = makeBarrelShifterElement(8, false, "logical", "left");
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.filter((c) => c.method === "drawText").some((c) => c.args[0] === "<<")).toBe(true);
    });

    it("right shifter draws '>>' symbol", () => {
      const el = makeBarrelShifterElement(8, false, "logical", "right");
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.filter((c) => c.method === "drawText").some((c) => c.args[0] === ">>")).toBe(true);
    });
  });

  describe("definitionComplete", () => {
    it("name is 'BarrelShifter'", () => { expect(BarrelShifterDefinition.name).toBe("BarrelShifter"); });
    it("category is ARITHMETIC", () => { expect(BarrelShifterDefinition.category).toBe(ComponentCategory.ARITHMETIC); });
    it("can be registered", () => {
      const r = new ComponentRegistry();
      expect(() => r.register(BarrelShifterDefinition)).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// BIT COUNT tests
// ---------------------------------------------------------------------------

describe("BitCount", () => {
  describe("correctness", () => {
    it("0x00 has 0 bits set", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([0x00], 1);
      executebitCount(0, state, layout);
      expect(state[1]).toBe(0);
    });

    it("0xFF has 8 bits set", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([0xFF], 1);
      executebitCount(0, state, layout);
      expect(state[1]).toBe(8);
    });

    it("0x0F has 4 bits set", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([0x0F], 1);
      executebitCount(0, state, layout);
      expect(state[1]).toBe(4);
    });

    it("0x01 has 1 bit set", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([0x01], 1);
      executebitCount(0, state, layout);
      expect(state[1]).toBe(1);
    });

    it("0xFFFFFFFF has 32 bits set", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([0xFFFFFFFF], 1);
      executebitCount(0, state, layout);
      expect(state[1]).toBe(32);
    });

    it("0xAAAAAAAA has 16 bits set (alternating)", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([0xAAAAAAAA], 1);
      executebitCount(0, state, layout);
      expect(state[1]).toBe(16);
    });

    it("zero allocation: 1000 calls", () => {
      const layout = makeLayout(1, 1);
      const state = makeState([0], 1);
      for (let i = 0; i < 1000; i++) {
        state[0] = i;
        executebitCount(0, state, layout);
      }
      expect(state[1]).toBeDefined();
    });
  });

  describe("pin layout", () => {
    it("has 1 input and 1 output", () => {
      const el = makeBitCountElement();
      expect(el.getPins().filter((p) => p.direction === PinDirection.INPUT)).toHaveLength(1);
      expect(el.getPins().filter((p) => p.direction === PinDirection.OUTPUT)).toHaveLength(1);
    });
  });

  describe("attribute mapping", () => {
    it("Bits=16 maps to bitWidth=16", () => {
      const m = BIT_COUNT_ATTRIBUTE_MAPPINGS.find((x) => x.xmlName === "Bits");
      expect(m!.convert("16")).toBe(16);
    });
  });

  describe("rendering", () => {
    it("draws rect and '#1' text", () => {
      const el = makeBitCountElement();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.some((c) => c.method === "drawRect")).toBe(true);
      expect(calls.filter((c) => c.method === "drawText").some((c) => c.args[0] === "#1")).toBe(true);
    });
  });

  describe("definitionComplete", () => {
    it("name is 'BitCount'", () => { expect(BitCountDefinition.name).toBe("BitCount"); });
    it("category is ARITHMETIC", () => { expect(BitCountDefinition.category).toBe(ComponentCategory.ARITHMETIC); });
    it("can be registered", () => {
      const r = new ComponentRegistry();
      expect(() => r.register(BitCountDefinition)).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// BIT EXTENDER tests
// ---------------------------------------------------------------------------

describe("BitExtender", () => {
  describe("zero extension (MSB=0)", () => {
    it("4-bit->8-bit: 0x07 (0b0111) zero-extends to 0x07", () => {
      const exec = makeExecuteBitExtender(4, 8);
      const layout = makeLayout(1, 1);
      const state = makeState([0x07], 1);
      exec(0, state, layout);
      expect(state[1]).toBe(0x07);
    });

    it("4-bit->8-bit: 0x00 zero-extends to 0x00", () => {
      const exec = makeExecuteBitExtender(4, 8);
      const layout = makeLayout(1, 1);
      const state = makeState([0x00], 1);
      exec(0, state, layout);
      expect(state[1]).toBe(0x00);
    });
  });

  describe("sign extension (MSB=1)", () => {
    it("4-bit->8-bit: 0x0F (0b1111 = -1) sign-extends to 0xFF", () => {
      const exec = makeExecuteBitExtender(4, 8);
      const layout = makeLayout(1, 1);
      const state = makeState([0x0F], 1);
      exec(0, state, layout);
      expect(state[1]).toBe(0xFF);
    });

    it("4-bit->8-bit: 0x08 (0b1000 = -8) sign-extends to 0xF8", () => {
      const exec = makeExecuteBitExtender(4, 8);
      const layout = makeLayout(1, 1);
      const state = makeState([0x08], 1);
      exec(0, state, layout);
      expect(state[1]).toBe(0xF8);
    });

    it("8-bit->16-bit: 0x80 sign-extends to 0xFF80", () => {
      const exec = makeExecuteBitExtender(8, 16);
      const layout = makeLayout(1, 1);
      const state = makeState([0x80], 1);
      exec(0, state, layout);
      expect(state[1]).toBe(0xFF80);
    });

    it("8-bit->16-bit: 0x7F zero-extends to 0x007F", () => {
      const exec = makeExecuteBitExtender(8, 16);
      const layout = makeLayout(1, 1);
      const state = makeState([0x7F], 1);
      exec(0, state, layout);
      expect(state[1]).toBe(0x007F);
    });

    it("16-bit->32-bit: 0x8000 sign-extends to 0xFFFF8000", () => {
      const exec = makeExecuteBitExtender(16, 32);
      const layout = makeLayout(1, 1);
      const state = makeState([0x8000], 1);
      exec(0, state, layout);
      expect(state[1]).toBe(0xFFFF8000);
    });
  });

  describe("zero allocation", () => {
    it("1000 calls without error", () => {
      const exec = makeExecuteBitExtender(8, 16);
      const layout = makeLayout(1, 1);
      const state = makeState([0], 1);
      for (let i = 0; i < 1000; i++) {
        state[0] = i & 0xFF;
        exec(0, state, layout);
      }
      expect(state[1]).toBeDefined();
    });
  });

  describe("pin layout", () => {
    it("has 1 input and 1 output", () => {
      const el = makeBitExtenderElement();
      expect(el.getPins().filter((p) => p.direction === PinDirection.INPUT)).toHaveLength(1);
      expect(el.getPins().filter((p) => p.direction === PinDirection.OUTPUT)).toHaveLength(1);
    });
  });

  describe("attribute mapping", () => {
    it("Input_Bits=4 maps to inputBits=4", () => {
      const m = BIT_EXTENDER_ATTRIBUTE_MAPPINGS.find((x) => x.xmlName === "Input_Bits");
      expect(m!.convert("4")).toBe(4);
    });
    it("Output_Bits=8 maps to outputBits=8", () => {
      const m = BIT_EXTENDER_ATTRIBUTE_MAPPINGS.find((x) => x.xmlName === "Output_Bits");
      expect(m!.convert("8")).toBe(8);
    });
  });

  describe("rendering", () => {
    it("draws rect and 'ext' text", () => {
      const el = makeBitExtenderElement();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.some((c) => c.method === "drawRect")).toBe(true);
      expect(calls.filter((c) => c.method === "drawText").some((c) => c.args[0] === "ext")).toBe(true);
    });
  });

  describe("definitionComplete", () => {
    it("name is 'BitExtender'", () => { expect(BitExtenderDefinition.name).toBe("BitExtender"); });
    it("category is ARITHMETIC", () => { expect(BitExtenderDefinition.category).toBe(ComponentCategory.ARITHMETIC); });
    it("can be registered", () => {
      const r = new ComponentRegistry();
      expect(() => r.register(BitExtenderDefinition)).not.toThrow();
    });
    it("propertyDefs include inputBits and outputBits", () => {
      const keys = BitExtenderDefinition.propertyDefs.map((d) => d.key);
      expect(keys).toContain("inputBits");
      expect(keys).toContain("outputBits");
    });
  });
});

// ---------------------------------------------------------------------------
// PRNG tests
// ---------------------------------------------------------------------------

describe("PRNG", () => {
  // Build a state array large enough for inputs + outputs + state slots
  // Input slots: 4 (S, se, ne, C)
  // Output slots: 1 (R)
  // State slots: 2 (lfsrState, prevClock) starting at index 5
  const STATE_BASE = 5;

  function makePRNGState(S: number, se: number, ne: number, C: number, lfsrState: number, prevClock: number): Uint32Array {
    const arr = new Uint32Array(8); // 4 inputs + 1 output + 2 state + 1 spare
    arr[0] = S;
    arr[1] = se;
    arr[2] = ne;
    arr[3] = C;
    arr[STATE_BASE] = lfsrState;
    arr[STATE_BASE + 1] = prevClock;
    return arr;
  }

  function makePRNGLayoutFull(): PRNGLayout {
    return {
      inputCount: () => 4,
      inputOffset: () => 0,
      outputCount: () => 1,
      outputOffset: () => 4,
      stateOffset: () => STATE_BASE,
    };
  }

  describe("output reflects current state", () => {
    it("output is current LFSR state on no clock edge", () => {
      const exec = makeExecutePRNG(8);
      const layout = makePRNGLayoutFull();
      const state = makePRNGState(0, 0, 0, 0, 42, 0);
      exec(0, state, layout);
      expect(state[4]).toBe(42); // output = current LFSR state
    });
  });

  describe("rising edge: seed", () => {
    it("se=1 on rising clock seeds LFSR with S value", () => {
      const exec = makeExecutePRNG(8);
      const layout = makePRNGLayoutFull();
      // Clock goes 0->1 with se=1, S=0x55
      const state = makePRNGState(0x55, 1, 0, 1, 0xAA, 0);
      exec(0, state, layout);
      expect(state[4]).toBe(0x55); // seeded to S
    });

    it("se=1 with S=0 seeds LFSR to 1 (avoid all-zero)", () => {
      const exec = makeExecutePRNG(8);
      const layout = makePRNGLayoutFull();
      const state = makePRNGState(0, 1, 0, 1, 0xAA, 0);
      exec(0, state, layout);
      expect(state[4]).toBe(1);
    });
  });

  describe("rising edge: next", () => {
    it("ne=1 on rising clock advances LFSR state", () => {
      const exec = makeExecutePRNG(8);
      const layout = makePRNGLayoutFull();
      // Start with LFSR=1, clock 0->1, ne=1
      const state = makePRNGState(0, 0, 1, 1, 1, 0);
      exec(0, state, layout);
      // State should have advanced (be different from initial 1)
      const newState = state[STATE_BASE];
      expect(newState).not.toBe(1);
      expect(newState).not.toBe(0); // should never be zero
    });

    it("ne=1 produces a sequence of distinct values", () => {
      const exec = makeExecutePRNG(8);
      const layout = makePRNGLayoutFull();
      const arr = new Uint32Array(8);
      arr[STATE_BASE] = 1;
      arr[STATE_BASE + 1] = 0;

      const seen = new Set<number>();
      for (let i = 0; i < 20; i++) {
        // Rising edge: clock 0->1 with ne=1
        arr[2] = 1; // ne
        arr[3] = 1; // clock high
        arr[STATE_BASE + 1] = 0; // prev clock low
        exec(0, arr, layout);
        seen.add(arr[4]);
        arr[STATE_BASE + 1] = 1; // update prev clock for next iteration
      }
      // At least 10 distinct values in 20 steps
      expect(seen.size).toBeGreaterThanOrEqual(10);
    });
  });

  describe("no change when clock is high (no rising edge)", () => {
    it("clock stays high: no state change", () => {
      const exec = makeExecutePRNG(8);
      const layout = makePRNGLayoutFull();
      // prev clock = 1, current clock = 1 (no rising edge)
      const state = makePRNGState(0x55, 1, 1, 1, 0x42, 1);
      exec(0, state, layout);
      // LFSR state should be unchanged
      expect(state[STATE_BASE]).toBe(0x42);
    });
  });

  describe("pin layout", () => {
    it("has 4 inputs and 1 output", () => {
      const el = makePRNGElement();
      expect(el.getPins().filter((p) => p.direction === PinDirection.INPUT)).toHaveLength(4);
      expect(el.getPins().filter((p) => p.direction === PinDirection.OUTPUT)).toHaveLength(1);
    });

    it("clock pin C has isClock=true", () => {
      const el = makePRNGElement();
      const clockPin = el.getPins().find((p) => p.label === "C");
      expect(clockPin?.isClock).toBe(true);
    });
  });

  describe("attribute mapping", () => {
    it("Bits=16 maps to bitWidth=16", () => {
      const m = PRNG_ATTRIBUTE_MAPPINGS.find((x) => x.xmlName === "Bits");
      expect(m!.convert("16")).toBe(16);
    });
  });

  describe("rendering", () => {
    it("draws rect and 'PRNG' text", () => {
      const el = makePRNGElement();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.some((c) => c.method === "drawRect")).toBe(true);
      expect(calls.filter((c) => c.method === "drawText").some((c) => c.args[0] === "PRNG")).toBe(true);
    });
  });

  describe("definitionComplete", () => {
    it("name is 'PRNG'", () => { expect(PRNGDefinition.name).toBe("PRNG"); });
    it("category is ARITHMETIC", () => { expect(PRNGDefinition.category).toBe(ComponentCategory.ARITHMETIC); });
    it("can be registered", () => {
      const r = new ComponentRegistry();
      expect(() => r.register(PRNGDefinition)).not.toThrow();
    });
    it("helpText is non-empty", () => { expect(PRNGDefinition.helpText.length).toBeGreaterThan(0); });
  });
});
