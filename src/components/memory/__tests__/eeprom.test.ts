/**
 * Tests for EEPROM components: EEPROM and EEPROMDualPort.
 *
 * Covers:
 *   - EEPROM write (falling-edge triggered) and read
 *   - Chip-select (CS) and output-enable (OE) gating
 *   - WE edge detection (rising captures address, falling commits write)
 *   - EEPROM write-then-read-back
 *   - EEPROMDualPort clock-synchronous write and combinational read
 *   - Address boundary wrapping
 *   - isProgramMemory flag
 *   - Pin layout correctness
 *   - Attribute mappings
 *   - Rendering (draw calls)
 *   - ComponentDefinition completeness
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  EEPROMElement,
  sampleEEPROM,
  executeEEPROM,
  EEPROMDefinition,
  EEPROM_ATTRIBUTE_MAPPINGS,
  EEPROMDualPortElement,
  sampleEEPROMDualPort,
  executeEEPROMDualPort,
  EEPROMDualPortDefinition,
  EEPROM_DUAL_PORT_ATTRIBUTE_MAPPINGS,
} from "../eeprom.js";
import {
  DataField,
  registerBackingStore,
  clearBackingStores,
} from "../ram.js";
import type { EEPROMLayout } from "../eeprom.js";
import { PropertyBag } from "../../../core/properties.js";
import { PinDirection } from "../../../core/pin.js";
import { ComponentCategory } from "../../../core/registry.js";
import type { ComponentLayout } from "../../../core/registry.js";

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

function makeLayout(inputCount: number, outputCount: number, stateCount: number): {
  layout: ComponentLayout & EEPROMLayout;
  state: Uint32Array;
} {
  const state = new Uint32Array(inputCount + outputCount + stateCount);
  const layout: ComponentLayout & EEPROMLayout = {
    wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: (_i: number) => inputCount,
    inputOffset: (_i: number) => 0,
    outputCount: (_i: number) => outputCount,
    outputOffset: (_i: number) => inputCount,
    stateOffset: (_i: number) => inputCount + outputCount,
  };
  return { layout, state };
}

// ---------------------------------------------------------------------------
// EEPROM tests
// ---------------------------------------------------------------------------

describe("EEPROM", () => {
  // Inputs: A(0), CS(1), WE(2), OE(3), Din(4) — 5 inputs
  // Outputs: D(0) — 1 output
  // State: lastWE(0), writeAddr(1) — 2 state slots
  const IN = 5;
  const OUT = 1;
  const STATE = 2;

  beforeEach(() => {
    clearBackingStores();
  });

  it("readWithCSandOE — CS=1 OE=1 WE=0 outputs memory[A]", () => {
    const mem = new DataField(16);
    mem.write(0, 0xAB);
    registerBackingStore(0, mem);

    const { layout, state } = makeLayout(IN, OUT, STATE);
    const highZs = new Uint32Array(state.length);
    state[0] = 0; // A
    state[1] = 1; // CS
    state[2] = 0; // WE
    state[3] = 1; // OE
    state[4] = 0; // Din

    executeEEPROM(0, state, highZs, layout);
    expect(state[IN]).toBe(0xAB); // D
  });

  it("readGating — CS=0 suppresses output", () => {
    const mem = new DataField(16);
    mem.write(0, 0xFF);
    registerBackingStore(0, mem);

    const { layout, state } = makeLayout(IN, OUT, STATE);
    const highZs = new Uint32Array(state.length);
    state[0] = 0; state[1] = 0; state[2] = 0; state[3] = 1; state[4] = 0;
    executeEEPROM(0, state, highZs, layout);
    expect(state[IN]).toBe(0);
  });

  it("readGating — OE=0 suppresses output", () => {
    const mem = new DataField(16);
    mem.write(0, 0xFF);
    registerBackingStore(0, mem);

    const { layout, state } = makeLayout(IN, OUT, STATE);
    const highZs = new Uint32Array(state.length);
    state[0] = 0; state[1] = 1; state[2] = 0; state[3] = 0; state[4] = 0;
    executeEEPROM(0, state, highZs, layout);
    expect(state[IN]).toBe(0);
  });

  it("readGating — WE=1 suppresses output even with CS and OE asserted", () => {
    const mem = new DataField(16);
    mem.write(0, 0xFF);
    registerBackingStore(0, mem);

    const { layout, state } = makeLayout(IN, OUT, STATE);
    const highZs = new Uint32Array(state.length);
    state[0] = 0; state[1] = 1; state[2] = 1; state[3] = 1; state[4] = 0;
    // lastWE starts at 0 → this is WE rising edge (address capture only)
    executeEEPROM(0, state, highZs, layout);
    expect(state[IN]).toBe(0);
  });

  it("writeThenRead — WE rising edge captures address, falling edge commits write", () => {
    const mem = new DataField(16);
    registerBackingStore(0, mem);

    const { layout, state } = makeLayout(IN, OUT, STATE);
    const highZs = new Uint32Array(state.length);

    // Step 1: Rising edge of WE at address 5 with CS=1
    // lastWE=0 (initial) → WE goes to 1
    state[0] = 5;   // A (captured write address)
    state[1] = 1;   // CS
    state[2] = 1;   // WE (rising)
    state[3] = 0;   // OE
    state[4] = 0;   // Din (not yet relevant)
    sampleEEPROM(0, state, highZs, layout);
    executeEEPROM(0, state, highZs, layout);
    // lastWE should now be 1, writeAddr = 5
    expect(state[IN + OUT + 0]).toBe(1);   // lastWE
    expect(state[IN + OUT + 1]).toBe(5);   // writeAddr

    // Step 2: Falling edge of WE with Din = 0xBE
    state[0] = 9;   // A changes (irrelevant for write — uses captured addr=5)
    state[1] = 1;   // CS
    state[2] = 0;   // WE (falling)
    state[3] = 0;   // OE
    state[4] = 0xBE; // Din
    sampleEEPROM(0, state, highZs, layout);
    executeEEPROM(0, state, highZs, layout);
    // memory[5] should now be 0xBE
    expect(mem.read(5)).toBe(0xBE);

    // Step 3: Read back from address 5
    state[0] = 5;
    state[1] = 1; // CS
    state[2] = 0; // WE
    state[3] = 1; // OE
    state[4] = 0;
    executeEEPROM(0, state, highZs, layout);
    expect(state[IN]).toBe(0xBE);
  });

  it("noWriteWithoutCS — write does not occur when CS=0 on falling WE", () => {
    const mem = new DataField(16);
    registerBackingStore(0, mem);

    const { layout, state } = makeLayout(IN, OUT, STATE);
    const highZs = new Uint32Array(state.length);

    // Rising edge of WE without CS
    state[0] = 2; state[1] = 0; state[2] = 1; state[3] = 0; state[4] = 0;
    sampleEEPROM(0, state, highZs, layout);
    executeEEPROM(0, state, highZs, layout);

    // Falling edge of WE without CS
    state[2] = 0; state[4] = 0x99;
    sampleEEPROM(0, state, highZs, layout);
    executeEEPROM(0, state, highZs, layout);

    // Nothing should have been written
    expect(mem.read(2)).toBe(0);
  });

  it("multipleWrites — sequential writes to different addresses", () => {
    const mem = new DataField(16);
    registerBackingStore(0, mem);

    const { layout, state } = makeLayout(IN, OUT, STATE);
    const highZs = new Uint32Array(state.length);
    state[1] = 1; // CS always asserted

    const writeValue = (addr: number, val: number) => {
      // Rising edge
      state[0] = addr; state[2] = 1; state[3] = 0; state[4] = 0;
      sampleEEPROM(0, state, highZs, layout);
      executeEEPROM(0, state, highZs, layout);
      // Falling edge
      state[2] = 0; state[4] = val;
      sampleEEPROM(0, state, highZs, layout);
      executeEEPROM(0, state, highZs, layout);
    };

    writeValue(1, 0x11);
    writeValue(2, 0x22);
    writeValue(3, 0x33);

    expect(mem.read(1)).toBe(0x11);
    expect(mem.read(2)).toBe(0x22);
    expect(mem.read(3)).toBe(0x33);
  });

  it("addressWrapping — address wraps modulo DataField size", () => {
    const mem = new DataField(4);
    mem.write(0, 0xAA);
    registerBackingStore(0, mem);

    const { layout, state } = makeLayout(IN, OUT, STATE);
    const highZs = new Uint32Array(state.length);
    state[0] = 4; // wraps to 0
    state[1] = 1;
    state[2] = 0;
    state[3] = 1;
    state[4] = 0;
    executeEEPROM(0, state, highZs, layout);
    expect(state[IN]).toBe(0xAA);
  });

  it("noBackingStore — read returns 0 gracefully", () => {
    const { layout, state } = makeLayout(IN, OUT, STATE);
    const highZs = new Uint32Array(state.length);
    state[0] = 0; state[1] = 1; state[2] = 0; state[3] = 1; state[4] = 0;
    executeEEPROM(0, state, highZs, layout);
    expect(state[IN]).toBe(0);
  });

  it("isProgramMemoryFlag — element reports isProgramMemory correctly", () => {
    const props = new PropertyBag();
    props.set("isProgramMemory", true);
    const el = new EEPROMElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    expect(el.isProgramMemory).toBe(true);
  });

  it("isProgramMemoryDefault — defaults to false", () => {
    const props = new PropertyBag();
    const el = new EEPROMElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    expect(el.isProgramMemory).toBe(false);
  });

  it("pinLayout — EEPROM has 5 input pins and 1 output pin", () => {
    const props = new PropertyBag();
    const el = new EEPROMElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const pins = el.getPins();
    const inputs = pins.filter(p => p.direction === PinDirection.INPUT);
    const outputs = pins.filter(p => p.direction === PinDirection.OUTPUT);
    expect(inputs.length).toBe(5);
    expect(outputs.length).toBe(1);
    const labels = pins.map(p => p.label);
    expect(labels).toContain("A");
    expect(labels).toContain("CS");
    expect(labels).toContain("WE");
    expect(labels).toContain("OE");
    expect(labels).toContain("Din");
    expect(labels).toContain("D");
  });

  it("weClockCapable — WE pin is marked as clock-capable", () => {
    const props = new PropertyBag();
    const el = new EEPROMElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const pins = el.getPins();
    const wePin = pins.find(p => p.label === "WE");
    expect(wePin).toBeDefined();
    expect(wePin!.isClock).toBe(true);
  });

  it("attributeMapping — Bits, AddrBits, Label, isProgramMemory map correctly", () => {
    const mapping = EEPROM_ATTRIBUTE_MAPPINGS;
    const bitsMap = mapping.find(m => m.xmlName === "Bits");
    const addrMap = mapping.find(m => m.xmlName === "AddrBits");
    const labelMap = mapping.find(m => m.xmlName === "Label");
    const isPMMap = mapping.find(m => m.xmlName === "isProgramMemory");

    expect(bitsMap!.convert("8")).toBe(8);
    expect(addrMap!.convert("10")).toBe(10);
    expect(labelMap!.convert("BOOT")).toBe("BOOT");
    expect(isPMMap!.convert("true")).toBe(true);
    expect(isPMMap!.convert("false")).toBe(false);
  });

  it("draw — calls ctx.drawRect and ctx.drawText with EEPROM label", () => {
    const props = new PropertyBag();
    const el = new EEPROMElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);

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
      drawText: (text: string) => texts.push(text),
    };
    el.draw(ctx as never);
    expect(calls).toContain("save");
    expect(calls).toContain("restore");
    expect(calls).toContain("drawRect");
    expect(texts.some(t => t.includes("EEPROM"))).toBe(true);
  });

  it("definitionComplete — EEPROMDefinition has all required fields", () => {
    expect(EEPROMDefinition.name).toBe("EEPROM");
    expect(EEPROMDefinition.factory).toBeDefined();
    expect(EEPROMDefinition.executeFn).toBeDefined();
    expect(EEPROMDefinition.pinLayout).toBeDefined();
    expect(EEPROMDefinition.propertyDefs).toBeDefined();
    expect(EEPROMDefinition.attributeMap).toBeDefined();
    expect(EEPROMDefinition.category).toBe(ComponentCategory.MEMORY);
    expect(EEPROMDefinition.helpText).toBeDefined();
    expect(typeof EEPROMDefinition.defaultDelay).toBe("number");
  });

  it("helpText — returns non-empty string", () => {
    const props = new PropertyBag();
    const el = new EEPROMElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    expect(el.getHelpText().length).toBeGreaterThan(0);
  });

  it("factoryCreatesInstance — EEPROMDefinition.factory returns EEPROMElement", () => {
    const props = new PropertyBag();
    expect(EEPROMDefinition.factory(props)).toBeInstanceOf(EEPROMElement);
  });
});

// ---------------------------------------------------------------------------
// EEPROMDualPort tests
// ---------------------------------------------------------------------------

describe("EEPROMDualPort", () => {
  // Inputs: A(0), Din(1), str(2), C(3), ld(4) — 5 inputs
  // Outputs: D(0) — 1 output
  // State: lastClk(0) — 1 state slot
  const IN = 5;
  const OUT = 1;
  const STATE = 1;

  beforeEach(() => {
    clearBackingStores();
  });

  it("writeThenRead — clock-edge write then load read", () => {
    const mem = new DataField(16);
    registerBackingStore(0, mem);

    const { layout, state } = makeLayout(IN, OUT, STATE);
    const highZs = new Uint32Array(state.length);

    // Write 0xAB to address 3 on rising clock edge
    state[0] = 3;   // A
    state[1] = 0xAB; // Din
    state[2] = 1;   // str
    state[3] = 1;   // C (rising: lastClk was 0)
    state[4] = 0;   // ld

    sampleEEPROMDualPort(0, state, highZs, layout);
    executeEEPROMDualPort(0, state, highZs, layout);
    expect(mem.read(3)).toBe(0xAB);

    // Read back from address 3
    state[0] = 3;
    state[2] = 0;   // str
    state[3] = 0;   // C (falling, no edge)
    state[4] = 1;   // ld

    sampleEEPROMDualPort(0, state, highZs, layout);
    executeEEPROMDualPort(0, state, highZs, layout);
    expect(state[IN]).toBe(0xAB);
  });

  it("noWriteWithoutClockEdge — str=1 but no rising edge → no write", () => {
    const mem = new DataField(16);
    registerBackingStore(0, mem);

    const { layout, state } = makeLayout(IN, OUT, STATE);
    const highZs = new Uint32Array(state.length);

    // Set lastClk = 1 first by running a cycle with clk=1
    state[0] = 0; state[1] = 0xAA; state[2] = 1; state[3] = 1; state[4] = 0;
    sampleEEPROMDualPort(0, state, highZs, layout);
    executeEEPROMDualPort(0, state, highZs, layout);
    // Now write with clk still high (no rising edge — lastClk=1)
    state[1] = 0xFF; state[2] = 1; state[3] = 1;
    sampleEEPROMDualPort(0, state, highZs, layout);
    executeEEPROMDualPort(0, state, highZs, layout);
    // Only the first write (on first rising edge) should have occurred
    expect(mem.read(0)).toBe(0xAA);
  });

  it("noWriteWhenStrLow — rising clock edge with str=0 → no write", () => {
    const mem = new DataField(16);
    registerBackingStore(0, mem);

    const { layout, state } = makeLayout(IN, OUT, STATE);
    const highZs = new Uint32Array(state.length);
    state[0] = 0; state[1] = 0x77; state[2] = 0; state[3] = 1; state[4] = 0;
    sampleEEPROMDualPort(0, state, highZs, layout);
    executeEEPROMDualPort(0, state, highZs, layout);
    expect(mem.read(0)).toBe(0);
  });

  it("readWithLd — ld=1 outputs memory[A]", () => {
    const mem = new DataField(16);
    mem.write(7, 0xCC);
    registerBackingStore(0, mem);

    const { layout, state } = makeLayout(IN, OUT, STATE);
    const highZs = new Uint32Array(state.length);
    state[0] = 7; state[1] = 0; state[2] = 0; state[3] = 0; state[4] = 1;
    executeEEPROMDualPort(0, state, highZs, layout);
    expect(state[IN]).toBe(0xCC);
  });

  it("readGating — ld=0 outputs 0", () => {
    const mem = new DataField(16);
    mem.write(0, 0xDD);
    registerBackingStore(0, mem);

    const { layout, state } = makeLayout(IN, OUT, STATE);
    const highZs = new Uint32Array(state.length);
    state[0] = 0; state[1] = 0; state[2] = 0; state[3] = 0; state[4] = 0;
    executeEEPROMDualPort(0, state, highZs, layout);
    expect(state[IN]).toBe(0);
  });

  it("clockEdgeTracking — lastClk updated correctly after each cycle", () => {
    const mem = new DataField(16);
    registerBackingStore(0, mem);

    const { layout, state } = makeLayout(IN, OUT, STATE);
    const highZs = new Uint32Array(state.length);

    // Cycle 1: clk=0 → lastClk stays 0
    state[3] = 0;
    sampleEEPROMDualPort(0, state, highZs, layout);
    executeEEPROMDualPort(0, state, highZs, layout);
    expect(state[IN + OUT]).toBe(0); // lastClk = 0

    // Cycle 2: clk=1 (rising) → writes if str=1
    state[0] = 4; state[1] = 0x11; state[2] = 1; state[3] = 1;
    sampleEEPROMDualPort(0, state, highZs, layout);
    executeEEPROMDualPort(0, state, highZs, layout);
    expect(state[IN + OUT]).toBe(1); // lastClk = 1
    expect(mem.read(4)).toBe(0x11);

    // Cycle 3: clk=0 (falling) → no rising edge, no write
    state[1] = 0x22; state[3] = 0;
    sampleEEPROMDualPort(0, state, highZs, layout);
    executeEEPROMDualPort(0, state, highZs, layout);
    expect(state[IN + OUT]).toBe(0); // lastClk = 0
    expect(mem.read(4)).toBe(0x11); // unchanged
  });

  it("addressWrapping — address wraps modulo DataField size", () => {
    const mem = new DataField(4);
    mem.write(2, 0x55);
    registerBackingStore(0, mem);

    const { layout, state } = makeLayout(IN, OUT, STATE);
    const highZs = new Uint32Array(state.length);
    state[0] = 6; // wraps to 2
    state[4] = 1; // ld
    state[3] = 0; // no clock
    executeEEPROMDualPort(0, state, highZs, layout);
    expect(state[IN]).toBe(0x55);
  });

  it("pinLayout — EEPROMDualPort has 5 input pins and 1 output pin", () => {
    const props = new PropertyBag();
    const el = new EEPROMDualPortElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const pins = el.getPins();
    const inputs = pins.filter(p => p.direction === PinDirection.INPUT);
    const outputs = pins.filter(p => p.direction === PinDirection.OUTPUT);
    expect(inputs.length).toBe(5);
    expect(outputs.length).toBe(1);
    const labels = pins.map(p => p.label);
    expect(labels).toContain("A");
    expect(labels).toContain("Din");
    expect(labels).toContain("str");
    expect(labels).toContain("C");
    expect(labels).toContain("ld");
    expect(labels).toContain("D");
  });

  it("clockPinMarked — C pin is clock-capable", () => {
    const props = new PropertyBag();
    const el = new EEPROMDualPortElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const pins = el.getPins();
    const cPin = pins.find(p => p.label === "C");
    expect(cPin).toBeDefined();
    expect(cPin!.isClock).toBe(true);
  });

  it("isProgramMemoryFlag — element reports isProgramMemory", () => {
    const props = new PropertyBag();
    props.set("isProgramMemory", true);
    const el = new EEPROMDualPortElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    expect(el.isProgramMemory).toBe(true);
  });

  it("attributeMapping — Bits, AddrBits, Label, isProgramMemory", () => {
    const mapping = EEPROM_DUAL_PORT_ATTRIBUTE_MAPPINGS;
    const bitsMap = mapping.find(m => m.xmlName === "Bits");
    const addrMap = mapping.find(m => m.xmlName === "AddrBits");
    expect(bitsMap!.convert("16")).toBe(16);
    expect(addrMap!.convert("12")).toBe(12);
  });

  it("draw — renders body with EEPROM2 symbol", () => {
    const props = new PropertyBag();
    const el = new EEPROMDualPortElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);

    const texts: string[] = [];
    const ctx = {
      save: () => {},
      restore: () => {},
      translate: () => {},
      setColor: () => {},
      setLineWidth: () => {},
      setFont: () => {},
      drawRect: () => {},
      drawText: (text: string) => texts.push(text),
    };
    el.draw(ctx as never);
    expect(texts.some(t => t.includes("EEPROM"))).toBe(true);
  });

  it("definitionComplete — EEPROMDualPortDefinition has all required fields", () => {
    expect(EEPROMDualPortDefinition.name).toBe("EEPROMDualPort");
    expect(EEPROMDualPortDefinition.factory).toBeDefined();
    expect(EEPROMDualPortDefinition.executeFn).toBeDefined();
    expect(EEPROMDualPortDefinition.pinLayout).toBeDefined();
    expect(EEPROMDualPortDefinition.propertyDefs).toBeDefined();
    expect(EEPROMDualPortDefinition.attributeMap).toBeDefined();
    expect(EEPROMDualPortDefinition.category).toBe(ComponentCategory.MEMORY);
    expect(EEPROMDualPortDefinition.helpText).toBeDefined();
    expect(typeof EEPROMDualPortDefinition.defaultDelay).toBe("number");
  });

  it("factoryCreatesInstance — factory returns EEPROMDualPortElement", () => {
    const props = new PropertyBag();
    expect(EEPROMDualPortDefinition.factory(props)).toBeInstanceOf(EEPROMDualPortElement);
  });

  it("helpText — returns non-empty string", () => {
    const props = new PropertyBag();
    const el = new EEPROMDualPortElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    expect(el.getHelpText().length).toBeGreaterThan(0);
  });

  it("noBackingStore — read returns 0 gracefully", () => {
    const { layout, state } = makeLayout(IN, OUT, STATE);
    const highZs = new Uint32Array(state.length);
    state[4] = 1; // ld
    executeEEPROMDualPort(0, state, highZs, layout);
    expect(state[IN]).toBe(0);
  });
});
