/**
 * Tests for ProgramMemory- ROM with address auto-increment.
 *
 * Covers:
 *   - Auto-increment on rising clock edge
 *   - Jump (ld=1) to external address A
 *   - Output D always reflects memory[addrReg]
 *   - No change on falling/sustained clock
 *   - No backing store returns 0
 *   - isProgramMemory flag
 *   - Sequential fetch sequence
 *   - Pin layout
 *   - Attribute mappings
 *   - Rendering
 *   - ComponentDefinition completeness
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  ProgramMemoryElement,
  executeProgramMemory,
  ProgramMemoryDefinition,
  PROGRAM_MEMORY_ATTRIBUTE_MAPPINGS,
  DataField,
  registerBackingStore,
  clearBackingStores,
} from "../program-memory.js";
import type { ProgramMemoryLayout } from "../program-memory.js";
import { PropertyBag } from "../../../core/properties.js";
import { PinDirection } from "../../../core/pin.js";
import { ComponentCategory } from "../../../core/registry.js";
import type { ComponentLayout } from "../../../core/registry.js";

// ---------------------------------------------------------------------------
// Layout helper
// Input layout:  [A=0, ld=1, C=2] - 3 inputs
// Output layout: [D=0]            - 1 output
// State layout:  [addrReg=0, prevClock=1]- 2 state slots
// ---------------------------------------------------------------------------

function makeLayout(): {
  layout: ComponentLayout & ProgramMemoryLayout;
  state: Uint32Array;
} {
  const state = new Uint32Array(3 + 1 + 2); // 6 slots
  const layout: ComponentLayout & ProgramMemoryLayout = {
    wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: (_i: number) => 3,
    inputOffset: (_i: number) => 0,
    outputCount: (_i: number) => 1,
    outputOffset: (_i: number) => 3,
    stateOffset: (_i: number) => 4,
    getProperty: () => undefined,
  };
  return { layout, state };
}

function tick(state: Uint32Array, highZs: Uint32Array, layout: ComponentLayout & ProgramMemoryLayout, clkHigh: boolean): void {
  state[2] = clkHigh ? 1 : 0;
  executeProgramMemory(0, state, highZs, layout);
}

describe("ProgramMemory", () => {
  beforeEach(() => {
    clearBackingStores();
  });

  it("autoIncrement- sequential fetch reads consecutive addresses", () => {
    const mem = new DataField(16);
    for (let i = 0; i < 16; i++) mem.write(i, i * 10);
    registerBackingStore(0, mem);

    const { layout, state } = makeLayout();
    const highZs = new Uint32Array(state.length);
    state[1] = 0; // ld = 0

    // First call: addrReg=0, read memory[0] = 0
    tick(state, highZs, layout, false);
    expect(state[3]).toBe(0); // D = memory[0]

    // Rising edge: addrReg increments to 1
    tick(state, highZs, layout, true);
    expect(state[3]).toBe(10); // D = memory[1]

    tick(state, highZs, layout, false);
    tick(state, highZs, layout, true);
    expect(state[3]).toBe(20); // D = memory[2]

    tick(state, highZs, layout, false);
    tick(state, highZs, layout, true);
    expect(state[3]).toBe(30); // D = memory[3]
  });

  it("jumpOnLoad- ld=1 loads A into address register", () => {
    const mem = new DataField(16);
    mem.write(8, 0xAB);
    registerBackingStore(0, mem);

    const { layout, state } = makeLayout();
    const highZs = new Uint32Array(state.length);
    state[0] = 8;  // A = 8
    state[1] = 1;  // ld = 1

    tick(state, highZs, layout, true);
    expect(state[3]).toBe(0xAB); // memory[8]
    expect(state[4]).toBe(8);    // addrReg = 8
  });

  it("jumpThenFetch- jump to address then auto-increment", () => {
    const mem = new DataField(16);
    for (let i = 0; i < 16; i++) mem.write(i, i + 100);
    registerBackingStore(0, mem);

    const { layout, state } = makeLayout();
    const highZs = new Uint32Array(state.length);

    // Jump to address 5
    state[0] = 5; state[1] = 1;
    tick(state, highZs, layout, false);
    tick(state, highZs, layout, true);
    expect(state[4]).toBe(5); // addrReg = 5
    expect(state[3]).toBe(105); // memory[5]

    // Switch to auto-increment
    state[1] = 0;
    tick(state, highZs, layout, false);
    tick(state, highZs, layout, true);
    expect(state[4]).toBe(6); // addrReg = 6
    expect(state[3]).toBe(106); // memory[6]
  });

  it("noChangeOnFallingClock- falling edge does not increment", () => {
    const mem = new DataField(16);
    mem.write(0, 0xFF);
    mem.write(1, 0xEE);
    registerBackingStore(0, mem);

    const { layout, state } = makeLayout();
    const highZs = new Uint32Array(state.length);
    state[1] = 0;

    // Rising edge → increment to 1
    tick(state, highZs, layout, true);
    expect(state[4]).toBe(1);

    // Falling edge → no change
    tick(state, highZs, layout, false);
    expect(state[4]).toBe(1);

    // Another falling edge → still no change
    tick(state, highZs, layout, false);
    expect(state[4]).toBe(1);
  });

  it("noChangeOnSustainedHighClock- second high tick does not increment", () => {
    const mem = new DataField(16);
    registerBackingStore(0, mem);

    const { layout, state } = makeLayout();
    const highZs = new Uint32Array(state.length);
    state[1] = 0;

    // Rising edge → addr=1
    tick(state, highZs, layout, true);
    expect(state[4]).toBe(1);

    // Clock stays high → no additional increment
    tick(state, highZs, layout, true);
    expect(state[4]).toBe(1);
  });

  it("noBackingStore- output is 0, no crash", () => {
    const { layout, state } = makeLayout();
    const highZs = new Uint32Array(state.length);
    state[1] = 0;
    tick(state, highZs, layout, true);
    expect(state[3]).toBe(0);
  });

  it("outputCurrentAddress- D always reflects memory[addrReg] after each call", () => {
    const mem = new DataField(8);
    mem.write(0, 0xAA);
    mem.write(1, 0xBB);
    registerBackingStore(0, mem);

    const { layout, state } = makeLayout();
    const highZs = new Uint32Array(state.length);
    state[1] = 0;

    // Before first clock: addrReg=0
    tick(state, highZs, layout, false);
    expect(state[3]).toBe(0xAA); // memory[0]

    // Rising edge: addrReg → 1
    tick(state, highZs, layout, true);
    expect(state[3]).toBe(0xBB); // memory[1]
  });

  it("wrap32bit- address wraps after 32-bit overflow", () => {
    const mem = new DataField(4);
    mem.write(0, 0x99);
    registerBackingStore(0, mem);

    const { layout, state } = makeLayout();
    const highZs = new Uint32Array(state.length);
    state[4] = 0xFFFFFFFF; // addrReg at max
    state[1] = 0;

    tick(state, highZs, layout, true);
    // address wraps to 0
    expect(state[4]).toBe(0);
    expect(state[3]).toBe(0x99); // memory[0]
  });

  it("isProgramMemoryFlag- element reports isProgramMemory", () => {
    const props = new PropertyBag();
    props.set("isProgramMemory", true);
    const el = new ProgramMemoryElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    expect(el.isProgramMemory).toBe(true);
  });

  it("isProgramMemoryDefault- defaults to true", () => {
    const props = new PropertyBag();
    const el = new ProgramMemoryElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    expect(el.isProgramMemory).toBe(true);
  });

  it("pinLayout- 3 input pins and 1 output pin", () => {
    const props = new PropertyBag();
    const el = new ProgramMemoryElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const pins = el.getPins();
    const inputs = pins.filter(p => p.direction === PinDirection.INPUT);
    const outputs = pins.filter(p => p.direction === PinDirection.OUTPUT);
    expect(inputs.length).toBe(3);
    expect(outputs.length).toBe(1);
    const labels = pins.map(p => p.label);
    expect(labels).toContain("A");
    expect(labels).toContain("ld");
    expect(labels).toContain("C");
    expect(labels).toContain("D");
  });

  it("clockPinMarked- C pin is clock-capable", () => {
    const props = new PropertyBag();
    const el = new ProgramMemoryElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const cPin = el.getPins().find(p => p.label === "C");
    expect(cPin).toBeDefined();
    expect(cPin!.isClock).toBe(true);
  });

  it("attributeMapping- Bits, AddrBits, Label, isProgramMemory map correctly", () => {
    const bitsMap = PROGRAM_MEMORY_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "Bits");
    const addrMap = PROGRAM_MEMORY_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "AddrBits");
    const labelMap = PROGRAM_MEMORY_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "Label");
    const isPMMap = PROGRAM_MEMORY_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "isProgramMemory");

    expect(bitsMap!.convert("16")).toBe(16);
    expect(addrMap!.convert("12")).toBe(12);
    expect(labelMap!.convert("BIOS")).toBe("BIOS");
    expect(isPMMap!.convert("true")).toBe(true);
    expect(isPMMap!.convert("false")).toBe(false);
  });

  it("draw- renders body with PMEM symbol", () => {
    const props = new PropertyBag();
    const el = new ProgramMemoryElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);

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
      drawText: (t: string) => texts.push(t),
    };
    el.draw(ctx as never);
    expect(calls).toContain("save");
    expect(calls).toContain("restore");
    expect(calls).toContain("drawRect");
    expect(texts).toContain("PMEM");
  });

  it("drawWithLabel- label appears in draw output", () => {
    const props = new PropertyBag();
    props.set("label", "CODE");
    const el = new ProgramMemoryElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);

    const texts: string[] = [];
    const ctx = {
      save: () => {}, restore: () => {}, translate: () => {},
      setColor: () => {}, setLineWidth: () => {}, setFont: () => {},
      drawRect: () => {}, drawText: (t: string) => texts.push(t),
    };
    el.draw(ctx as never);
    expect(texts).toContain("CODE");
  });

  it("definitionComplete- ProgramMemoryDefinition has all required fields", () => {
    expect(ProgramMemoryDefinition.name).toBe("ProgramMemory");
    expect(ProgramMemoryDefinition.factory).toBeDefined();
    expect(ProgramMemoryDefinition.models!.digital!.executeFn).toBeDefined();
    expect(ProgramMemoryDefinition.pinLayout).toBeDefined();
    expect(ProgramMemoryDefinition.propertyDefs).toBeDefined();
    expect(ProgramMemoryDefinition.attributeMap).toBeDefined();
    expect(ProgramMemoryDefinition.category).toBe(ComponentCategory.MEMORY);
    expect(ProgramMemoryDefinition.helpText).toBeDefined();
    expect(typeof ProgramMemoryDefinition.models!.digital!.defaultDelay).toBe("number");
  });

  it("factoryCreatesInstance- factory returns ProgramMemoryElement", () => {
    const props = new PropertyBag();
    expect(ProgramMemoryDefinition.factory(props)).toBeInstanceOf(ProgramMemoryElement);
  });

  it("boundingBox- returns non-zero dimensions", () => {
    const props = new PropertyBag();
    const el = new ProgramMemoryElement(crypto.randomUUID(), { x: 1, y: 2 }, 0, false, props);
    const bb = el.getBoundingBox();
    expect(bb.x).toBe(1);
    expect(bb.y).toBe(2);
    expect(bb.width).toBeGreaterThanOrEqual(2);
    expect(bb.height).toBeGreaterThanOrEqual(2);
  });
});
