/**
 * Tests for ProgramCounter- edge-triggered counter with jump support.
 *
 * Covers:
 *   - Count increment on rising clock edge with en=1
 *   - Jump (load) to address D when ld=1
 *   - No action when en=0 and ld=0
 *   - No action on falling/sustained clock
 *   - Overflow on 32-bit wrap
 *   - isProgramCounter flag
 *   - Pin layout
 *   - Attribute mappings
 *   - Rendering
 *   - ComponentDefinition completeness
 */

import { describe, it, expect } from "vitest";
import {
  ProgramCounterElement,
  executeProgramCounter,
  ProgramCounterDefinition,
  PROGRAM_COUNTER_ATTRIBUTE_MAPPINGS,
} from "../program-counter.js";
import type { ProgramCounterLayout } from "../program-counter.js";
import { PropertyBag } from "../../../core/properties.js";
import { PinDirection } from "../../../core/pin.js";
import { ComponentCategory } from "../../../core/registry.js";
import type { ComponentLayout } from "../../../core/registry.js";

// ---------------------------------------------------------------------------
// Layout helper
// Input layout:  [D=0, en=1, C=2, ld=3] - 4 inputs
// Output layout: [Q=0, ovf=1]            - 2 outputs
// State layout:  [counter=0, prevClock=1]- 2 state slots
// ---------------------------------------------------------------------------

function makeLayout(): {
  layout: ComponentLayout & ProgramCounterLayout;
  state: Uint32Array;
} {
  // Total: 4 inputs + 2 outputs + 2 state = 8 slots
  const state = new Uint32Array(8);
  const layout: ComponentLayout & ProgramCounterLayout = {
    wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: (_i: number) => 4,
    inputOffset: (_i: number) => 0,
    outputCount: (_i: number) => 2,
    outputOffset: (_i: number) => 4,
    stateOffset: (_i: number) => 6,
    getProperty: () => undefined,
  };
  return { layout, state };
}

// Helper: apply one clock cycle (rising edge if prevClk=0, falling if prevClk=1)
function tick(state: Uint32Array, highZs: Uint32Array, layout: ComponentLayout & ProgramCounterLayout, clkHigh: boolean): void {
  state[2] = clkHigh ? 1 : 0; // C
  executeProgramCounter(0, state, highZs, layout);
}

describe("ProgramCounter", () => {
  it("incrementOnRisingEdge- en=1, ld=0 increments counter", () => {
    const { layout, state } = makeLayout();
    const highZs = new Uint32Array(state.length);
    state[0] = 0;  // D
    state[1] = 1;  // en
    state[3] = 0;  // ld

    // Rising edge
    tick(state, highZs, layout, true);
    expect(state[4]).toBe(1); // Q = 1

    // Falling edge- no change
    tick(state, highZs, layout, false);
    expect(state[4]).toBe(1);

    // Rising edge again
    tick(state, highZs, layout, true);
    expect(state[4]).toBe(2); // Q = 2
  });

  it("jumpOnLoad- ld=1 loads D value", () => {
    const { layout, state } = makeLayout();
    const highZs = new Uint32Array(state.length);
    state[0] = 0x50; // D
    state[1] = 0;    // en
    state[3] = 1;    // ld

    // Rising edge → jump to 0x50
    tick(state, highZs, layout, true);
    expect(state[4]).toBe(0x50); // Q = 0x50
  });

  it("loadTakesPriorityOverEnable- ld=1 and en=1, load wins", () => {
    const { layout, state } = makeLayout();
    const highZs = new Uint32Array(state.length);
    state[0] = 0x20; // D = 0x20
    state[1] = 1;    // en
    state[3] = 1;    // ld

    tick(state, highZs, layout, true);
    expect(state[4]).toBe(0x20); // loaded, not incremented from 0
  });

  it("noActionWhenDisabled- en=0, ld=0, counter stays same", () => {
    const { layout, state } = makeLayout();
    const highZs = new Uint32Array(state.length);
    state[6] = 0x42; // counter = 0x42 initial
    state[1] = 0;    // en
    state[3] = 0;    // ld

    tick(state, highZs, layout, true);
    expect(state[4]).toBe(0x42); // unchanged
  });

  it("noActionOnHighClock- no rising edge when clock stays high", () => {
    const { layout, state } = makeLayout();
    const highZs = new Uint32Array(state.length);
    state[1] = 1; state[3] = 0; // en=1, ld=0

    // First rising edge
    tick(state, highZs, layout, true);
    expect(state[4]).toBe(1);

    // Clock stays high → no rising edge → no increment
    tick(state, highZs, layout, true);
    expect(state[4]).toBe(1);
  });

  it("multipleIncrements- counter increments on each rising edge", () => {
    const { layout, state } = makeLayout();
    const highZs = new Uint32Array(state.length);
    state[1] = 1; state[3] = 0;

    for (let i = 1; i <= 10; i++) {
      tick(state, highZs, layout, false); // falling
      tick(state, highZs, layout, true);  // rising
      expect(state[4]).toBe(i);
    }
  });

  it("jumpThenIncrement- jump to address then continue incrementing", () => {
    const { layout, state } = makeLayout();
    const highZs = new Uint32Array(state.length);
    state[0] = 100; state[3] = 1; state[1] = 0;

    // Jump to 100
    tick(state, highZs, layout, true);
    expect(state[4]).toBe(100);

    // Switch to increment mode
    state[3] = 0; state[1] = 1;
    tick(state, highZs, layout, false);
    tick(state, highZs, layout, true);
    expect(state[4]).toBe(101);
  });

  it("overflowAt32Bit- wraps from 0xFFFFFFFF to 0", () => {
    const { layout, state } = makeLayout();
    const highZs = new Uint32Array(state.length);
    state[6] = 0xFFFFFFFF; // counter at max 32-bit value
    state[1] = 1; state[3] = 0;

    tick(state, highZs, layout, true);
    expect(state[4]).toBe(0); // wrapped to 0
    expect(state[5]).toBe(1); // ovf = 1
  });

  it("noOverflowOnNormalIncrement- ovf stays 0 normally", () => {
    const { layout, state } = makeLayout();
    const highZs = new Uint32Array(state.length);
    state[6] = 5;
    state[1] = 1; state[3] = 0;

    tick(state, highZs, layout, true);
    expect(state[5]).toBe(0); // no overflow
  });

  it("isProgramCounterFlag- element reports correctly", () => {
    const props = new PropertyBag();
    props.set("isProgramCounter", true);
    const el = new ProgramCounterElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    expect(el.isProgramCounter).toBe(true);
  });

  it("isProgramCounterDefault- defaults to true", () => {
    const props = new PropertyBag();
    const el = new ProgramCounterElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    expect(el.isProgramCounter).toBe(true);
  });

  it("pinLayout- 4 input pins and 2 output pins", () => {
    const props = new PropertyBag();
    const el = new ProgramCounterElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const pins = el.getPins();
    const inputs = pins.filter(p => p.direction === PinDirection.INPUT);
    const outputs = pins.filter(p => p.direction === PinDirection.OUTPUT);
    expect(inputs.length).toBe(4);
    expect(outputs.length).toBe(2);
    const labels = pins.map(p => p.label);
    expect(labels).toContain("D");
    expect(labels).toContain("en");
    expect(labels).toContain("C");
    expect(labels).toContain("ld");
    expect(labels).toContain("Q");
    expect(labels).toContain("ovf");
  });

  it("clockPinMarked- C pin is clock-capable", () => {
    const props = new PropertyBag();
    const el = new ProgramCounterElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const cPin = el.getPins().find(p => p.label === "C");
    expect(cPin).toBeDefined();
    expect(cPin!.isClock).toBe(true);
  });

  it("attributeMapping- Bits and Label map correctly", () => {
    const bitsMap = PROGRAM_COUNTER_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "Bits");
    const labelMap = PROGRAM_COUNTER_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "Label");
    const pcMap = PROGRAM_COUNTER_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "isProgramCounter");

    expect(bitsMap!.convert("16")).toBe(16);
    expect(labelMap!.convert("PC")).toBe("PC");
    expect(pcMap!.convert("true")).toBe(true);
    expect(pcMap!.convert("false")).toBe(false);
  });

  it("draw- renders body with PC label", () => {
    const props = new PropertyBag();
    const el = new ProgramCounterElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);

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
      drawLine: () => {},
    };
    el.draw(ctx as never);
    expect(calls).toContain("save");
    expect(calls).toContain("restore");
    expect(calls).toContain("drawRect");
    expect(texts).toContain("PC");
  });

  it("definitionComplete- ProgramCounterDefinition has all required fields", () => {
    expect(ProgramCounterDefinition.name).toBe("ProgramCounter");
    expect(ProgramCounterDefinition.factory).toBeDefined();
    expect(ProgramCounterDefinition.models!.digital!.executeFn).toBeDefined();
    expect(ProgramCounterDefinition.pinLayout).toBeDefined();
    expect(ProgramCounterDefinition.propertyDefs).toBeDefined();
    expect(ProgramCounterDefinition.attributeMap).toBeDefined();
    expect(ProgramCounterDefinition.category).toBe(ComponentCategory.MEMORY);
    expect(ProgramCounterDefinition.helpText).toBeDefined();
    expect(typeof ProgramCounterDefinition.models!.digital!.defaultDelay).toBe("number");
  });

  it("factoryCreatesInstance- factory returns ProgramCounterElement", () => {
    const props = new PropertyBag();
    expect(ProgramCounterDefinition.factory(props)).toBeInstanceOf(ProgramCounterElement);
  });
});
