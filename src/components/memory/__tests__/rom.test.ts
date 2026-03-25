/**
 * Tests for ROM components: ROM and ROMDualPort.
 *
 * Covers:
 *   - Read from DataField
 *   - Address boundary wrapping
 *   - isProgramMemory flag
 *   - autoReload flag
 *   - Chip-select (sel) gating
 *   - Dual-port independent reads
 *   - Pin layout correctness
 *   - Attribute mappings
 *   - Rendering (draw calls)
 *   - ComponentDefinition completeness
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  DataField,
  registerBackingStore,
  clearBackingStores,
  ROMElement,
  executeROM,
  ROMDefinition,
  ROM_ATTRIBUTE_MAPPINGS,
  ROMDualPortElement,
  executeROMDualPort,
  ROMDualPortDefinition,
  ROM_DUAL_PORT_ATTRIBUTE_MAPPINGS,
} from "../rom.js";
import { PropertyBag } from "../../../core/properties.js";
import { PinDirection } from "../../../core/pin.js";
import { ComponentCategory } from "../../../core/registry.js";
import type { ComponentLayout } from "../../../core/registry.js";

// ---------------------------------------------------------------------------
// Test layout helper — mimics a flat Uint32Array layout for one component.
// The component is always at index 0.
// Slot layout: [inputs... | outputs... | state...]
// ---------------------------------------------------------------------------

function makeLayout(inputCount: number, outputCount: number, stateCount: number): {
  layout: ComponentLayout & { stateOffset(i: number): number };
  state: Uint32Array;
} {
  const totalSlots = inputCount + outputCount + stateCount;
  const state = new Uint32Array(totalSlots);
  const layout: ComponentLayout & { stateOffset(i: number): number } = {
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

// ---------------------------------------------------------------------------
// ROM tests
// ---------------------------------------------------------------------------

describe("ROM", () => {
  beforeEach(() => {
    clearBackingStores();
  });

  it("readFromDataField — sel=1 returns memory[A]", () => {
    const mem = new DataField(16);
    mem.write(0, 0xAB);
    mem.write(3, 0xCD);
    registerBackingStore(0, mem);

    // Inputs: A=0, sel=1; Outputs: D
    const { layout, state } = makeLayout(2, 1, 0);
    const highZs = new Uint32Array(state.length);
    state[0] = 0;   // A
    state[1] = 1;   // sel
    executeROM(0, state, highZs, layout);
    expect(state[2]).toBe(0xAB);

    state[0] = 3;   // A
    executeROM(0, state, highZs, layout);
    expect(state[2]).toBe(0xCD);
  });

  it("chipSelectGating — sel=0 outputs 0 regardless of address", () => {
    const mem = new DataField(16);
    mem.write(0, 0xFF);
    registerBackingStore(0, mem);

    const { layout, state } = makeLayout(2, 1, 0);
    const highZs = new Uint32Array(state.length);
    state[0] = 0;   // A
    state[1] = 0;   // sel = 0
    executeROM(0, state, highZs, layout);
    expect(state[2]).toBe(0);
  });

  it("addressBoundaryWrapping — address wraps modulo size", () => {
    const mem = new DataField(4); // size = 4
    mem.write(0, 0x11);
    mem.write(1, 0x22);
    mem.write(2, 0x33);
    mem.write(3, 0x44);
    registerBackingStore(0, mem);

    const { layout, state } = makeLayout(2, 1, 0);
    const highZs = new Uint32Array(state.length);
    state[1] = 1; // sel = 1

    // Address 4 wraps to 0
    state[0] = 4;
    executeROM(0, state, highZs, layout);
    expect(state[2]).toBe(0x11);

    // Address 7 wraps to 3
    state[0] = 7;
    executeROM(0, state, highZs, layout);
    expect(state[2]).toBe(0x44);
  });

  it("noBackingStore — returns 0 when no DataField registered", () => {
    const { layout, state } = makeLayout(2, 1, 0);
    const highZs = new Uint32Array(state.length);
    state[0] = 0;
    state[1] = 1;
    executeROM(0, state, highZs, layout);
    expect(state[2]).toBe(0);
  });

  it("dataFieldInitFrom — initFrom populates multiple addresses", () => {
    const mem = new DataField(8);
    mem.initFrom([0x10, 0x20, 0x30, 0x40, 0x50]);
    registerBackingStore(0, mem);

    const { layout, state } = makeLayout(2, 1, 0);
    const highZs = new Uint32Array(state.length);
    state[1] = 1; // sel = 1

    for (let i = 0; i < 5; i++) {
      state[0] = i;
      executeROM(0, state, highZs, layout);
      expect(state[2]).toBe((i + 1) * 0x10);
    }
    // Uninitialised addresses return 0
    state[0] = 5;
    executeROM(0, state, highZs, layout);
    expect(state[2]).toBe(0);
  });

  it("isProgramMemoryFlag — element reports correct isProgramMemory", () => {
    const props = new PropertyBag();
    props.set("isProgramMemory", true);
    const el = new ROMElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    expect(el.isProgramMemory).toBe(true);
  });

  it("isProgramMemoryDefault — defaults to false", () => {
    const props = new PropertyBag();
    const el = new ROMElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    expect(el.isProgramMemory).toBe(false);
  });

  it("autoReloadFlag — element reports correct autoReload", () => {
    const props = new PropertyBag();
    props.set("autoReload", true);
    const el = new ROMElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    expect(el.autoReload).toBe(true);
  });

  it("autoReloadDefault — defaults to false", () => {
    const props = new PropertyBag();
    const el = new ROMElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    expect(el.autoReload).toBe(false);
  });

  it("pinLayout — ROM has 2 input pins and 1 output pin", () => {
    const props = new PropertyBag();
    const el = new ROMElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const pins = el.getPins();
    const inputs = pins.filter(p => p.direction === PinDirection.INPUT);
    const outputs = pins.filter(p => p.direction === PinDirection.OUTPUT);
    expect(inputs.length).toBe(2);
    expect(outputs.length).toBe(1);
    const labels = pins.map(p => p.label);
    expect(labels).toContain("A");
    expect(labels).toContain("sel");
    expect(labels).toContain("D");
  });

  it("attributeMapping — Bits and AddrBits map correctly", () => {
    const mapping = ROM_ATTRIBUTE_MAPPINGS;
    const bitsMapping = mapping.find(m => m.xmlName === "Bits");
    const addrMapping = mapping.find(m => m.xmlName === "AddrBits");
    const labelMapping = mapping.find(m => m.xmlName === "Label");
    const isPMMapping = mapping.find(m => m.xmlName === "isProgramMemory");
    const arMapping = mapping.find(m => m.xmlName === "AutoReloadRom");

    expect(bitsMapping).toBeDefined();
    expect(bitsMapping!.convert("16")).toBe(16);
    expect(addrMapping).toBeDefined();
    expect(addrMapping!.convert("8")).toBe(8);
    expect(labelMapping).toBeDefined();
    expect(labelMapping!.convert("myROM")).toBe("myROM");
    expect(isPMMapping).toBeDefined();
    expect(isPMMapping!.convert("true")).toBe(true);
    expect(isPMMapping!.convert("false")).toBe(false);
    expect(arMapping).toBeDefined();
    expect(arMapping!.convert("true")).toBe(true);
  });

  it("draw — calls ctx.drawPolygon and ctx.drawText", () => {
    const props = new PropertyBag();
    const el = new ROMElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);

    const calls: string[] = [];
    const ctx = {
      save: () => calls.push("save"),
      restore: () => calls.push("restore"),
      translate: () => calls.push("translate"),
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
      drawText: (_text: string) => calls.push(`drawText:${_text}`),
    };
    el.draw(ctx as never);

    expect(calls).toContain("save");
    expect(calls).toContain("restore");
    expect(calls).toContain("drawPolygon");
    expect(calls.some(c => c.startsWith("drawText:ROM"))).toBe(true);
  });

  it("drawWithLabel — label text appears in draw calls", () => {
    const props = new PropertyBag();
    props.set("label", "PROG");
    const el = new ROMElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);

    const texts: string[] = [];
    const ctx = {
      save: () => {},
      restore: () => {},
      translate: () => {},
      setColor: () => {},
      setLineWidth: () => {},
      setFont: () => {},
      drawRect: () => {},
      drawPolygon: () => {},
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
    expect(texts).toContain("PROG");
  });

  it("definitionComplete — ROMDefinition has all required fields", () => {
    expect(ROMDefinition.name).toBe("ROM");
    expect(ROMDefinition.factory).toBeDefined();
    expect(ROMDefinition.models!.digital!.executeFn).toBeDefined();
    expect(ROMDefinition.pinLayout).toBeDefined();
    expect(ROMDefinition.propertyDefs).toBeDefined();
    expect(ROMDefinition.attributeMap).toBeDefined();
    expect(ROMDefinition.category).toBe(ComponentCategory.MEMORY);
    expect(ROMDefinition.helpText).toBeDefined();
    expect(typeof ROMDefinition.models!.digital!.defaultDelay).toBe("number");
  });

  it("helpText — getHelpText returns non-empty string", () => {
    const props = new PropertyBag();
    const el = new ROMElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const help = el.getHelpText();
    expect(typeof help).toBe("string");
    expect(help.length).toBeGreaterThan(0);
  });

  it("boundingBox — returns non-zero dimensions", () => {
    const props = new PropertyBag();
    const el = new ROMElement(crypto.randomUUID(), { x: 5, y: 3 }, 0, false, props);
    const bb = el.getBoundingBox();
    expect(bb.x).toBe(5.05);
    expect(bb.y).toBe(3 - 0.5);
    expect(bb.width).toBeGreaterThanOrEqual(2);
    expect(bb.height).toBeGreaterThanOrEqual(2);
  });

  it("factoryCreatesInstance — ROMDefinition.factory returns ROMElement", () => {
    const props = new PropertyBag();
    const el = ROMDefinition.factory(props);
    expect(el).toBeInstanceOf(ROMElement);
  });
});

// ---------------------------------------------------------------------------
// ROMDualPort tests
// ---------------------------------------------------------------------------

describe("ROMDualPort", () => {
  beforeEach(() => {
    clearBackingStores();
  });

  it("dualPortIndependentRead — two ports read independently", () => {
    const mem = new DataField(16);
    mem.write(2, 0xAA);
    mem.write(5, 0xBB);
    registerBackingStore(0, mem);

    // Inputs: A1, s1, A2, s2 (4); Outputs: D1, D2 (2)
    const { layout, state } = makeLayout(4, 2, 0);
    const highZs = new Uint32Array(state.length);
    state[0] = 2;   // A1
    state[1] = 1;   // s1
    state[2] = 5;   // A2
    state[3] = 1;   // s2

    executeROMDualPort(0, state, highZs, layout);
    expect(state[4]).toBe(0xAA); // D1
    expect(state[5]).toBe(0xBB); // D2
  });

  it("port1Select — s1=0 disables port 1 output", () => {
    const mem = new DataField(16);
    mem.write(0, 0xFF);
    registerBackingStore(0, mem);

    const { layout, state } = makeLayout(4, 2, 0);
    const highZs = new Uint32Array(state.length);
    state[0] = 0; state[1] = 0; // A1=0, s1=0
    state[2] = 0; state[3] = 1; // A2=0, s2=1

    executeROMDualPort(0, state, highZs, layout);
    expect(state[4]).toBe(0);    // D1 = 0 (not selected)
    expect(state[5]).toBe(0xFF); // D2 = memory[0]
  });

  it("port2Select — s2=0 disables port 2 output", () => {
    const mem = new DataField(16);
    mem.write(1, 0x55);
    registerBackingStore(0, mem);

    const { layout, state } = makeLayout(4, 2, 0);
    const highZs = new Uint32Array(state.length);
    state[0] = 1; state[1] = 1; // A1=1, s1=1
    state[2] = 1; state[3] = 0; // A2=1, s2=0

    executeROMDualPort(0, state, highZs, layout);
    expect(state[4]).toBe(0x55); // D1
    expect(state[5]).toBe(0);    // D2 = 0 (not selected)
  });

  it("bothPortsDisabled — s1=0 and s2=0 produce all zeros", () => {
    const mem = new DataField(16);
    mem.write(0, 0xFF);
    registerBackingStore(0, mem);

    const { layout, state } = makeLayout(4, 2, 0);
    const highZs = new Uint32Array(state.length);
    state[0] = 0; state[1] = 0;
    state[2] = 0; state[3] = 0;

    executeROMDualPort(0, state, highZs, layout);
    expect(state[4]).toBe(0);
    expect(state[5]).toBe(0);
  });

  it("sharedBackingStore — both ports read from same memory", () => {
    const mem = new DataField(16);
    for (let i = 0; i < 16; i++) mem.write(i, i * 0x10);
    registerBackingStore(0, mem);

    const { layout, state } = makeLayout(4, 2, 0);
    const highZs = new Uint32Array(state.length);
    state[1] = 1; state[3] = 1;

    for (let a = 0; a < 16; a++) {
      state[0] = a; state[2] = (a + 1) % 16;
      executeROMDualPort(0, state, highZs, layout);
      expect(state[4]).toBe(a * 0x10);
      expect(state[5]).toBe(((a + 1) % 16) * 0x10);
    }
  });

  it("pinLayout — ROMDualPort has 4 input pins and 2 output pins", () => {
    const props = new PropertyBag();
    const el = new ROMDualPortElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const pins = el.getPins();
    const inputs = pins.filter(p => p.direction === PinDirection.INPUT);
    const outputs = pins.filter(p => p.direction === PinDirection.OUTPUT);
    expect(inputs.length).toBe(4);
    expect(outputs.length).toBe(2);
    const labels = pins.map(p => p.label);
    expect(labels).toContain("A1");
    expect(labels).toContain("s1");
    expect(labels).toContain("A2");
    expect(labels).toContain("s2");
    expect(labels).toContain("D1");
    expect(labels).toContain("D2");
  });

  it("isProgramMemoryFlag — ROMDualPortElement reports isProgramMemory", () => {
    const props = new PropertyBag();
    props.set("isProgramMemory", true);
    const el = new ROMDualPortElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    expect(el.isProgramMemory).toBe(true);
  });

  it("attributeMapping — dual port mappings correct", () => {
    const mapping = ROM_DUAL_PORT_ATTRIBUTE_MAPPINGS;
    const bitsMapping = mapping.find(m => m.xmlName === "Bits");
    expect(bitsMapping!.convert("32")).toBe(32);
    const arMapping = mapping.find(m => m.xmlName === "AutoReloadRom");
    expect(arMapping).toBeDefined();
  });

  it("draw — renders body with ROM2 symbol", () => {
    const props = new PropertyBag();
    const el = new ROMDualPortElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);

    const texts: string[] = [];
    const ctx = {
      save: () => {},
      restore: () => {},
      translate: () => {},
      setColor: () => {},
      setLineWidth: () => {},
      setFont: () => {},
      drawRect: () => {},
      drawPolygon: () => {},
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
    expect(texts.some(t => t.includes("ROM"))).toBe(true);
  });

  it("definitionComplete — ROMDualPortDefinition has all required fields", () => {
    expect(ROMDualPortDefinition.name).toBe("ROMDualPort");
    expect(ROMDualPortDefinition.factory).toBeDefined();
    expect(ROMDualPortDefinition.models!.digital!.executeFn).toBeDefined();
    expect(ROMDualPortDefinition.pinLayout).toBeDefined();
    expect(ROMDualPortDefinition.propertyDefs).toBeDefined();
    expect(ROMDualPortDefinition.attributeMap).toBeDefined();
    expect(ROMDualPortDefinition.category).toBe(ComponentCategory.MEMORY);
    expect(ROMDualPortDefinition.helpText).toBeDefined();
    expect(typeof ROMDualPortDefinition.models!.digital!.defaultDelay).toBe("number");
  });

  it("factoryCreatesInstance — factory returns ROMDualPortElement", () => {
    const props = new PropertyBag();
    const el = ROMDualPortDefinition.factory(props);
    expect(el).toBeInstanceOf(ROMDualPortElement);
  });

  it("noBackingStore — returns 0 for both ports", () => {
    const { layout, state } = makeLayout(4, 2, 0);
    const highZs = new Uint32Array(state.length);
    state[0] = 0; state[1] = 1;
    state[2] = 0; state[3] = 1;

    executeROMDualPort(0, state, highZs, layout);
    expect(state[4]).toBe(0);
    expect(state[5]).toBe(0);
  });
});
