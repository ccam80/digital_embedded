/**
 * Tests for LookUpTable — combinational truth-table component.
 *
 * Covers:
 *   - Lookup correctness for all input combinations
 *   - Address formation (input 0 = LSB, input N-1 = MSB)
 *   - Multi-bit output
 *   - No backing store returns 0
 *   - Pin layout (N inputs + 1 output)
 *   - Attribute mappings
 *   - Rendering
 *   - ComponentDefinition completeness
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  LookUpTableElement,
  executeLookUpTable,
  LookUpTableDefinition,
  LUT_ATTRIBUTE_MAPPINGS,
  DataField,
  registerBackingStore,
  clearBackingStores,
} from "../lookup-table.js";
import { PropertyBag } from "../../../core/properties.js";
import { PinDirection } from "../../../core/pin.js";
import { ComponentCategory } from "../../../core/registry.js";
import type { ComponentLayout } from "../../../core/registry.js";

function makeLayout(inputCount: number, outputCount: number): {
  layout: ComponentLayout;
  state: Uint32Array;
} {
  const state = new Uint32Array(inputCount + outputCount);
  const layout: ComponentLayout = {
    wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: (_i: number) => inputCount,
    inputOffset: (_i: number) => 0,
    outputCount: (_i: number) => outputCount,
    outputOffset: (_i: number) => inputCount,
    stateOffset: (_i: number) => inputCount + outputCount,
    getProperty: () => undefined,
  };
  return { layout, state };
}

describe("LookUpTable", () => {
  beforeEach(() => {
    clearBackingStores();
  });

  it("lookupCorrectness2Input — 2-input, 1-bit table (AND gate)", () => {
    // Table: addr → value
    // 0b00 → 0, 0b01 → 0, 0b10 → 0, 0b11 → 1 (AND gate)
    const mem = new DataField(4); // 2^2 = 4 entries
    mem.write(0, 0); // 00 → 0
    mem.write(1, 0); // 01 → 0 (in0=1, in1=0)
    mem.write(2, 0); // 10 → 0 (in0=0, in1=1)
    mem.write(3, 1); // 11 → 1 (in0=1, in1=1)
    registerBackingStore(0, mem);

    // 2 inputs, 1 output
    const { layout, state } = makeLayout(2, 1);
    const highZs = new Uint32Array(state.length);

    state[0] = 0; state[1] = 0; executeLookUpTable(0, state, highZs, layout); expect(state[2]).toBe(0);
    state[0] = 1; state[1] = 0; executeLookUpTable(0, state, highZs, layout); expect(state[2]).toBe(0);
    state[0] = 0; state[1] = 1; executeLookUpTable(0, state, highZs, layout); expect(state[2]).toBe(0);
    state[0] = 1; state[1] = 1; executeLookUpTable(0, state, highZs, layout); expect(state[2]).toBe(1);
  });

  it("addressFormation — input 0 is LSB, input N-1 is MSB", () => {
    // 3 inputs, 8-entry table
    const mem = new DataField(8); // 2^3 = 8
    for (let i = 0; i < 8; i++) mem.write(i, i); // table[i] = i
    registerBackingStore(0, mem);

    const { layout, state } = makeLayout(3, 1);
    const highZs = new Uint32Array(state.length);

    // in0=1, in1=0, in2=0 → addr = 0b001 = 1
    state[0] = 1; state[1] = 0; state[2] = 0;
    executeLookUpTable(0, state, highZs, layout);
    expect(state[3]).toBe(1);

    // in0=0, in1=1, in2=0 → addr = 0b010 = 2
    state[0] = 0; state[1] = 1; state[2] = 0;
    executeLookUpTable(0, state, highZs, layout);
    expect(state[3]).toBe(2);

    // in0=1, in1=1, in2=1 → addr = 0b111 = 7
    state[0] = 1; state[1] = 1; state[2] = 1;
    executeLookUpTable(0, state, highZs, layout);
    expect(state[3]).toBe(7);
  });

  it("multibitOutput — 4-bit output values", () => {
    const mem = new DataField(4); // 2-input LUT
    mem.write(0, 0x0);
    mem.write(1, 0xA);
    mem.write(2, 0xB);
    mem.write(3, 0xF);
    registerBackingStore(0, mem);

    const { layout, state } = makeLayout(2, 1);
    const highZs = new Uint32Array(state.length);

    state[0] = 0; state[1] = 0; executeLookUpTable(0, state, highZs, layout); expect(state[2]).toBe(0x0);
    state[0] = 1; state[1] = 0; executeLookUpTable(0, state, highZs, layout); expect(state[2]).toBe(0xA);
    state[0] = 0; state[1] = 1; executeLookUpTable(0, state, highZs, layout); expect(state[2]).toBe(0xB);
    state[0] = 1; state[1] = 1; executeLookUpTable(0, state, highZs, layout); expect(state[2]).toBe(0xF);
  });

  it("noBackingStore — returns 0 gracefully", () => {
    const { layout, state } = makeLayout(2, 1);
    const highZs = new Uint32Array(state.length);
    state[0] = 1; state[1] = 1;
    executeLookUpTable(0, state, highZs, layout);
    expect(state[2]).toBe(0);
  });

  it("1InputLUT — single-input table (NOT gate)", () => {
    const mem = new DataField(2); // 2^1 = 2 entries
    mem.write(0, 1); // NOT 0 = 1
    mem.write(1, 0); // NOT 1 = 0
    registerBackingStore(0, mem);

    const { layout, state } = makeLayout(1, 1);
    const highZs = new Uint32Array(state.length);
    state[0] = 0; executeLookUpTable(0, state, highZs, layout); expect(state[1]).toBe(1);
    state[0] = 1; executeLookUpTable(0, state, highZs, layout); expect(state[1]).toBe(0);
  });

  it("4InputLUT — 4-input lookup table", () => {
    const mem = new DataField(16); // 2^4 = 16 entries
    for (let i = 0; i < 16; i++) mem.write(i, i * 2);
    registerBackingStore(0, mem);

    const { layout, state } = makeLayout(4, 1);
    const highZs = new Uint32Array(state.length);

    // addr = 5 = 0b0101 (in0=1, in1=0, in2=1, in3=0)
    state[0] = 1; state[1] = 0; state[2] = 1; state[3] = 0;
    executeLookUpTable(0, state, highZs, layout);
    expect(state[4]).toBe(10); // 5 * 2

    // addr = 15 = 0b1111 (all inputs = 1)
    state[0] = 1; state[1] = 1; state[2] = 1; state[3] = 1;
    executeLookUpTable(0, state, highZs, layout);
    expect(state[4]).toBe(30); // 15 * 2
  });

  it("pinLayout — correct number of inputs and single output", () => {
    const props = new PropertyBag();
    props.set("inputCount", 3);
    const el = new LookUpTableElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const pins = el.getPins();
    const inputs = pins.filter(p => p.direction === PinDirection.INPUT);
    const outputs = pins.filter(p => p.direction === PinDirection.OUTPUT);
    expect(inputs.length).toBe(3);
    expect(outputs.length).toBe(1);
    expect(outputs[0].label).toBe("out");
    // Input labels: "0", "1", "2"
    const inputLabels = inputs.map(p => p.label);
    expect(inputLabels).toContain("0");
    expect(inputLabels).toContain("1");
    expect(inputLabels).toContain("2");
  });

  it("pinLayout2Input — default 2-input layout", () => {
    const props = new PropertyBag();
    const el = new LookUpTableElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const pins = el.getPins();
    expect(pins.filter(p => p.direction === PinDirection.INPUT).length).toBe(2);
    expect(pins.filter(p => p.direction === PinDirection.OUTPUT).length).toBe(1);
  });

  it("attributeMapping — Bits, LutInputCount, Label map correctly", () => {
    const bitsMap = LUT_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "Bits");
    const lutMap = LUT_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "LutInputCount");
    const labelMap = LUT_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "Label");

    expect(bitsMap!.convert("8")).toBe(8);
    expect(lutMap!.convert("4")).toBe(4);
    expect(labelMap!.convert("F")).toBe("F");
  });

  it("draw — renders body with LUT label", () => {
    const props = new PropertyBag();
    const el = new LookUpTableElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);

    const texts: string[] = [];
    const calls: string[] = [];
    const ctx = {
      save: () => calls.push("save"),
      restore: () => calls.push("restore"),
      translate: () => {},
      setColor: () => {},
      setLineWidth: () => {},
      setFont: () => {},
      drawRect: () => calls.push("drawRect"),
      drawPolygon: () => calls.push("drawPolygon"),
      drawLine: () => {},
      drawCircle: () => {},
      drawArc: () => {},
      drawPath: () => {},
      rotate: () => {},
      scale: () => {},
      setLineDash: () => {},
      drawText: (text: string) => texts.push(text),
    };
    el.draw(ctx as never);
    expect(calls).toContain("save");
    expect(calls).toContain("restore");
    expect(calls).toContain("drawPolygon");
    expect(texts).toContain("LUT");
  });

  it("drawWithLabel — label appears in draw calls", () => {
    const props = new PropertyBag();
    props.set("label", "MyLUT");
    const el = new LookUpTableElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);

    const texts: string[] = [];
    const ctx = {
      save: () => {}, restore: () => {}, translate: () => {},
      setColor: () => {}, setLineWidth: () => {}, setFont: () => {},
      drawRect: () => {}, drawPolygon: () => {}, drawLine: () => {},
      drawCircle: () => {}, drawArc: () => {}, drawPath: () => {},
      rotate: () => {}, scale: () => {}, setLineDash: () => {},
      drawText: (t: string) => texts.push(t),
    };
    el.draw(ctx as never);
    expect(texts).toContain("MyLUT");
  });

  it("definitionComplete — LookUpTableDefinition has all required fields", () => {
    expect(LookUpTableDefinition.name).toBe("LookUpTable");
    expect(LookUpTableDefinition.factory).toBeDefined();
    expect(LookUpTableDefinition.models!.digital!.executeFn).toBeDefined();
    expect(LookUpTableDefinition.pinLayout).toBeDefined();
    expect(LookUpTableDefinition.propertyDefs).toBeDefined();
    expect(LookUpTableDefinition.attributeMap).toBeDefined();
    expect(LookUpTableDefinition.category).toBe(ComponentCategory.MEMORY);
    expect(LookUpTableDefinition.helpText).toBeDefined();
    expect(typeof LookUpTableDefinition.models!.digital!.defaultDelay).toBe("number");
  });

  it("factoryCreatesInstance — factory returns LookUpTableElement", () => {
    const props = new PropertyBag();
    expect(LookUpTableDefinition.factory(props)).toBeInstanceOf(LookUpTableElement);
  });

  it("boundingBox — returns non-zero dimensions", () => {
    const props = new PropertyBag();
    const el = new LookUpTableElement(crypto.randomUUID(), { x: 2, y: 3 }, 0, false, props);
    const bb = el.getBoundingBox();
    expect(bb.x).toBe(2.05);
    expect(bb.y).toBe(3 - 0.5);
    expect(bb.width).toBeGreaterThanOrEqual(2);
    expect(bb.height).toBeGreaterThanOrEqual(2);
  });
});
