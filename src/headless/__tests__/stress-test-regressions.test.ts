/**
 * Regression suite- component execution and registry validation tests
 * found via MCP circuit stress testing.
 */

import { describe, it, expect } from "vitest";
import type { ComponentLayout } from "@/core/registry";
import { ComponentRegistry } from "@/core/registry";
import { PropertyBag } from "@/core/properties";
import { createDefaultRegistry } from "@/components/register-all";

// Component execute functions under test
import { executeSplitter, extractBits, parsePorts } from "@/components/wiring/splitter";
import { executeD, sampleD } from "@/components/flipflops/d";
import { executeBarrelShifter, makeExecuteBarrelShifter } from "@/components/arithmetic/barrel-shifter";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal ComponentLayout for unit-testing execute functions. */
function makeLayout(
  inputCount: number,
  outputCount: number,
  opts?: { stateSlots?: number; props?: Record<string, unknown> },
): ComponentLayout {
  const stateSlots = opts?.stateSlots ?? 0;
  const totalSlots = inputCount + outputCount + stateSlots;
  return {
    wiringTable: Int32Array.from({ length: totalSlots }, (_, i) => i),
    inputCount: () => inputCount,
    inputOffset: () => 0,
    outputCount: () => outputCount,
    outputOffset: () => inputCount,
    stateOffset: () => inputCount + outputCount,
    getProperty: opts?.props
      ? (_index: number, key: string) => (opts.props as Record<string, unknown>)[key] as import('../../core/properties.js').PropertyValue | undefined
      : () => undefined,
  };
}

/** Build a real, fully-populated registry for integration-level checks. */
function createFullRegistry(): ComponentRegistry {
  return createDefaultRegistry();
}

// ===========================================================================
// Splitter port-width extraction
// ===========================================================================

describe("Splitter executeFn respects port widths", () => {
  it("executeSplitter splits 16-bit value into two 8-bit halves", () => {
    const layout = makeLayout(1, 2, { props: { "output splitting": "8,8" } });
    const state = new Uint32Array(3);
    const highZs = new Uint32Array(3);

    state[0] = 0xABCD;

    executeSplitter(0, state, highZs, layout);

    expect(state[layout.wiringTable[layout.outputOffset(0)]]).toBe(0xCD);
    expect(state[layout.wiringTable[layout.outputOffset(0) + 1]]).toBe(0xAB);
  });

  it("extractBits helper works correctly for multi-bit extraction", () => {
    expect(extractBits(0xABCD, 0, 8)).toBe(0xCD);
    expect(extractBits(0xABCD, 8, 8)).toBe(0xAB);
    expect(extractBits(0xFFFF, 4, 8)).toBe(0xFF);
    expect(extractBits(0x12345678, 16, 16)).toBe(0x1234);
  });

  it("parsePorts correctly parses 8,8 into two 8-bit ports", () => {
    const ports = parsePorts("8,8");
    expect(ports).toHaveLength(2);
    expect(ports[0]).toEqual({ pos: 0, bits: 8, name: "0-7" });
    expect(ports[1]).toEqual({ pos: 8, bits: 8, name: "8-15" });
  });
});

// ===========================================================================
// RegisterFile pin scaling
// ===========================================================================

describe("RegisterFile pin scaling", () => {
  it("data pins scale with bitWidth, address pins scale with addrBits", () => {
    const registry = createFullRegistry();
    const def = registry.getStandalone("RegisterFile");
    expect(def).toBeDefined();

    const props = new PropertyBag();
    props.set("bitWidth", 16);
    props.set("addrBits", 3);
    const element = def!.factory(props);
    const pins = element.getPins();

    const dinPin = pins.find(p => p.label === "Din");
    const daPin = pins.find(p => p.label === "Da");
    const dbPin = pins.find(p => p.label === "Db");
    const rwPin = pins.find(p => p.label === "Rw");
    const raPin = pins.find(p => p.label === "Ra");

    expect(dinPin?.bitWidth).toBe(16);
    expect(daPin?.bitWidth).toBe(16);
    expect(dbPin?.bitWidth).toBe(16);

    expect(rwPin?.bitWidth).toBe(3);
    expect(raPin?.bitWidth).toBe(3);
  });
});

// ===========================================================================
// D_FF ~Q output bit-width masking
// ===========================================================================

describe("D_FF ~Q output is bit-width masked", () => {
  it("~Q is 1 when Q is 0 for a 1-bit D flip-flop", () => {
    const layout = makeLayout(2, 2, { stateSlots: 2 });
    const state = new Uint32Array(6);
    const highZs = new Uint32Array(6);

    state[4] = 0; // storedQ
    state[5] = 0; // prevClock

    executeD(0, state, highZs, layout);

    const q = state[layout.wiringTable[layout.outputOffset(0)]];
    const notQ = state[layout.wiringTable[layout.outputOffset(0) + 1]];

    expect(q).toBe(0);
    expect(notQ).toBe(1);
  });

  it("~Q is 0 when Q is 1 for a 1-bit D flip-flop", () => {
    const layout = makeLayout(2, 2, { stateSlots: 2 });
    const state = new Uint32Array(6);
    const highZs = new Uint32Array(6);

    state[4] = 1; // storedQ = 1
    state[5] = 0; // prevClock

    executeD(0, state, highZs, layout);

    const q = state[layout.wiringTable[layout.outputOffset(0)]];
    const notQ = state[layout.wiringTable[layout.outputOffset(0) + 1]];

    expect(q).toBe(1);
    expect(notQ).toBe(0);
  });

  it("~Q is masked for default bitWidth (1-bit)", () => {
    const layout = makeLayout(2, 2, { stateSlots: 2 });
    const state = new Uint32Array(6);
    const highZs = new Uint32Array(6);

    state[4] = 0x00; // storedQ = 0

    executeD(0, state, highZs, layout);

    const notQ = state[layout.wiringTable[layout.outputOffset(0) + 1]];
    expect(notQ).toBe(1);
  });
});

// ===========================================================================
// Sequential component classification
// ===========================================================================

describe("Sequential component classification", () => {
  it("sampleD captures D input on rising clock edge", () => {
    const layout = makeLayout(2, 2, { stateSlots: 2 });
    const state = new Uint32Array(6);
    const highZs = new Uint32Array(6);

    state[0] = 1; // D input
    state[1] = 1; // C input (clock high)
    state[4] = 0; // storedQ (initial)
    state[5] = 0; // prevClock (was low)

    sampleD(0, state, highZs, layout);

    expect(state[4]).toBe(1);

    executeD(0, state, highZs, layout);

    const q = state[layout.wiringTable[layout.outputOffset(0)]];
    expect(q).toBe(1);
  });

  it("synchronous flip-flop definitions have sampleFn", () => {
    const syncFlipFlopNames = ["D_FF", "JK_FF", "RS_FF", "T_FF", "Monoflop"];
    const registry = createFullRegistry();

    for (const name of syncFlipFlopNames) {
      const def = registry.getStandalone(name);
      expect(def, `${name} should be registered`).toBeDefined();
      expect(def!.models?.digital?.sampleFn, `${name} should have a sampleFn`).toBeDefined();
    }
  });

  it("sequential memory components have sampleFn", () => {
    const memoryNames = ["Counter", "CounterPreset", "Register", "RegisterFile"];
    const registry = createFullRegistry();

    for (const name of memoryNames) {
      const def = registry.getStandalone(name);
      expect(def, `${name} should be registered`).toBeDefined();
      expect(def!.models?.digital?.sampleFn, `${name} should have a sampleFn`).toBeDefined();
    }
  });
});

// ===========================================================================
// BarrelShifter bitWidth from properties
// ===========================================================================

describe("BarrelShifter reads bitWidth from properties", () => {
  it("executeBarrelShifter uses bitWidth=32 from getProperty", () => {
    const layout = makeLayout(2, 1, { props: { bitWidth: 32 } });
    const state = new Uint32Array(3);
    const highZs = new Uint32Array(3);

    state[0] = 0xFF;
    state[1] = 4;

    executeBarrelShifter(0, state, highZs, layout);

    const result = state[layout.wiringTable[layout.outputOffset(0)]];
    expect(result).toBe(0xFF0);
  });

  it("makeExecuteBarrelShifter(32, ...) handles 32-bit shifts", () => {
    const execute32 = makeExecuteBarrelShifter(32, false, "logical", "left");
    const layout = makeLayout(2, 1);
    const state = new Uint32Array(3);
    const highZs = new Uint32Array(3);

    state[0] = 0xFF;
    state[1] = 4;
    execute32(0, state, highZs, layout);
    expect(state[layout.wiringTable[layout.outputOffset(0)]]).toBe(0xFF0);

    state[0] = 1;
    state[1] = 16;
    execute32(0, state, highZs, layout);
    expect(state[layout.wiringTable[layout.outputOffset(0)]]).toBe(0x10000);

    state[0] = 1;
    state[1] = 31;
    execute32(0, state, highZs, layout);
    expect(state[layout.wiringTable[layout.outputOffset(0)]]).toBe(0x80000000);
  });

  it("makeExecuteBarrelShifter(32, ...) right shift", () => {
    const executeRight = makeExecuteBarrelShifter(32, false, "logical", "right");
    const layout = makeLayout(2, 1);
    const state = new Uint32Array(3);
    const highZs = new Uint32Array(3);

    state[0] = 0x80000000;
    state[1] = 16;
    executeRight(0, state, highZs, layout);
    expect(state[layout.wiringTable[layout.outputOffset(0)]]).toBe(0x8000);
  });
});

// ===========================================================================
// Builder property key validation
// ===========================================================================

describe("Builder property key validation", () => {
  it("registry component property definitions are queryable", () => {
    const registry = createFullRegistry();

    const addDef = registry.getStandalone("Add");
    expect(addDef).toBeDefined();
    expect(addDef!.propertyDefs).toBeDefined();
    expect(addDef!.propertyDefs!.length).toBeGreaterThan(0);

    const hasBitWidth = addDef!.propertyDefs!.some(d => d.key === "bitWidth");
    expect(hasBitWidth).toBe(true);

    // "Bits" is the XML attribute name, not the internal property key
    const hasBits = addDef!.propertyDefs!.some(d => d.key === "Bits");
    expect(hasBits).toBe(false);
  });

  it("In component uses 'bitWidth' as property key", () => {
    const registry = createFullRegistry();
    const inDef = registry.getStandalone("In");
    expect(inDef).toBeDefined();

    const props = new PropertyBag();
    props.set("bitWidth", 4);
    const element = inDef!.factory(props);
    const pins = element.getPins();
    const outPin = pins.find(p => p.label === "out");
    expect(outPin?.bitWidth).toBe(4);
  });
});

// ===========================================================================
// ROM data property format
// ===========================================================================

describe("ROM data property format", () => {
  it("ROM data property definition uses HEX_DATA type", () => {
    const registry = createFullRegistry();
    const romDef = registry.getStandalone("ROM");
    expect(romDef).toBeDefined();

    const dataProp = romDef!.propertyDefs!.find(d => d.key === "data");
    expect(dataProp).toBeDefined();
    expect(dataProp!.defaultValue).toEqual([]);
  });

  it("ROM data is loadable as number array", () => {
    const registry = createFullRegistry();
    const romDef = registry.getStandalone("ROM");

    const props = new PropertyBag();
    props.set("addrBits", 4);
    props.set("dataBits", 8);
    props.set("data", [0, 1, 4, 9, 16, 25, 36, 49, 64, 81, 100, 121, 144, 169, 196, 225]);

    const element = romDef!.factory(props);
    expect(element).toBeDefined();

    const elementProps = element.getProperties();
    const data = elementProps.get("data");
    expect(Array.isArray(data)).toBe(true);
  });
});
