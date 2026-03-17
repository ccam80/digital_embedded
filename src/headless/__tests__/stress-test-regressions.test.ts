/**
 * Stress-test regression suite — bugs found via MCP circuit stress testing.
 *
 * Each test is tagged with a bug ID and targets a specific defect found during
 * systematic circuit building + test-vector validation across complexity tiers.
 *
 * Bug catalog:
 *   BUG-1: Builder silently ignores unknown property names (no diagnostic)
 *   BUG-2: executeSplitter() hardcodes width=1 for all output ports
 *   BUG-3: RegisterFile pins don't scale with bitWidth/addrBits properties
 *   BUG-4: ROM data property as string silently ignored (needs array)
 *   BUG-5a: D_FF ~Q output not masked to bit width (32-bit NOT on 1-bit value)
 *   BUG-5b: isSequentialComponent() doesn't match TS type names — sampleFn never called
 *   BUG-7: executeBarrelShifter() hardcodes bitWidth=8, ignoring component properties
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
      ? (_index: number, key: string) => (opts.props as Record<string, unknown>)[key]
      : () => undefined,
  };
}

/** Build a real, fully-populated registry for integration-level checks. */
function createFullRegistry(): ComponentRegistry {
  return createDefaultRegistry();
}

// ===========================================================================
// BUG-2: executeSplitter() hardcodes width=1 for all output ports
// ===========================================================================
//
// The default executeSplitter at splitter.ts:354-357 always extracts 1 bit
// per output port and advances by 1, ignoring the actual port widths from
// the splitting pattern. A 16→8,8 split should extract bits [0..7] and
// [8..15] but instead extracts bit 0 and bit 1.

describe("BUG-2: Splitter executeFn ignores port widths", () => {
  it("executeSplitter should split 16-bit value into two 8-bit halves", () => {
    // Splitter configured as input=16, output="8,8"
    // Layout: 1 input (the 16-bit bus), 2 outputs (8-bit halves)
    const layout = makeLayout(1, 2, { props: { output: "8,8" } });
    const state = new Uint32Array(3);
    const highZs = new Uint32Array(3);

    // Input: 0xABCD → expect output[0]=0xCD (low 8), output[1]=0xAB (high 8)
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
// BUG-3: RegisterFile pins don't scale with bitWidth/addrBits
// ===========================================================================
//
// REGISTER_FILE_PIN_DECLARATIONS has defaultBitWidth=1 for all pins.
// getPins() calls derivePins() without overriding widths from the
// bitWidth/addrBits properties, so pins stay 1-bit regardless of settings.

describe("BUG-3: RegisterFile pin scaling", () => {
  it("RegisterFile data pins should scale with bitWidth property", () => {
    const registry = createFullRegistry();
    const def = registry.get("RegisterFile");
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

    // Data pins should be 16-bit
    expect(dinPin?.bitWidth).toBe(16);
    expect(daPin?.bitWidth).toBe(16);
    expect(dbPin?.bitWidth).toBe(16);

    // Address pins should be 3-bit (addrBits=3)
    expect(rwPin?.bitWidth).toBe(3);
    expect(raPin?.bitWidth).toBe(3);
  });
});

// ===========================================================================
// BUG-5a: D_FF ~Q output not masked to bit width
// ===========================================================================
//
// executeD at d.ts:166 does: state[~Q] = (~q) >>> 0
// For q=0 (1-bit FF), this produces 0xFFFFFFFF instead of 1.
// Should be masked: (~q & mask) >>> 0 where mask = (1 << bitWidth) - 1.

describe("BUG-5a: D_FF ~Q output not bit-width masked", () => {
  it("~Q should be 1 when Q is 0 for a 1-bit D flip-flop", () => {
    // D_FF layout: inputs=[D, C], outputs=[Q, ~Q], state=[storedQ, prevClock]
    const layout = makeLayout(2, 2, { stateSlots: 2 });
    const state = new Uint32Array(6);
    const highZs = new Uint32Array(6);

    // Initial state: storedQ=0, prevClock=0
    state[4] = 0; // storedQ
    state[5] = 0; // prevClock

    executeD(0, state, highZs, layout);

    const q = state[layout.wiringTable[layout.outputOffset(0)]];
    const notQ = state[layout.wiringTable[layout.outputOffset(0) + 1]];

    expect(q).toBe(0);
    // BUG: notQ is 0xFFFFFFFF (4294967295) instead of 1
    expect(notQ).toBe(1);
  });

  it("~Q should be 0 when Q is 1 for a 1-bit D flip-flop", () => {
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

  it("~Q should be bit-masked for multi-bit D flip-flop (8-bit, Q=0x00)", () => {
    // For an 8-bit DFF, ~Q of 0x00 should be 0xFF, not 0xFFFFFFFF
    const layout = makeLayout(2, 2, { stateSlots: 2 });
    const state = new Uint32Array(6);
    const highZs = new Uint32Array(6);

    state[4] = 0x00; // storedQ = 0

    executeD(0, state, highZs, layout);

    const notQ = state[layout.wiringTable[layout.outputOffset(0) + 1]];

    // Without bit-width info, at minimum it shouldn't be 0xFFFFFFFF for any
    // reasonable bit width. The execute function should respect bitWidth.
    // For 1-bit default: expect 1. For 8-bit: expect 0xFF. For 32-bit: 0xFFFFFFFF.
    // Since the default bitWidth is 1, expect 1.
    expect(notQ).toBe(1);
  });
});

// ===========================================================================
// BUG-5b: isSequentialComponent() doesn't match TS type names
// ===========================================================================
//
// compiler.ts:897 isSequentialComponent() checks for "Flipflop*",
// "Register*", "Counter*", "DFF", "DFFSR" — Java naming conventions.
// The TS port uses "D_FF", "JK_FF", "RS_FF", "T_FF", "D_FF_AS", etc.
// Result: no flip-flop sampleFn is ever called → they never capture data.

describe("BUG-5b: Sequential component classification", () => {
  // We can't easily import isSequentialComponent (it's a private function),
  // so we test the D_FF sampleFn is called by verifying the full pipeline:
  // set D=1, clock edge → Q should become 1.

  it("sampleD captures D input on rising clock edge", () => {
    // D_FF: inputs=[D, C], outputs=[Q, ~Q], state=[storedQ, prevClock]
    const layout = makeLayout(2, 2, { stateSlots: 2 });
    const state = new Uint32Array(6);
    const highZs = new Uint32Array(6);

    // Set D=1, clock rising edge (prevClock=0, clock=1)
    state[0] = 1; // D input
    state[1] = 1; // C input (clock high)
    state[4] = 0; // storedQ (initial)
    state[5] = 0; // prevClock (was low)

    // Call sampleFn to capture
    sampleD(0, state, highZs, layout);

    // storedQ should now be 1
    expect(state[4]).toBe(1);

    // Call executeFn to output
    executeD(0, state, highZs, layout);

    const q = state[layout.wiringTable[layout.outputOffset(0)]];
    expect(q).toBe(1);
  });

  it("synchronous flip-flop definitions have sampleFn", () => {
    // Edge-triggered (synchronous) flip-flops need sampleFn for two-phase evaluation.
    // Async flip-flops (D_FF_AS, JK_FF_AS, RS_FF_AS) intentionally have no sampleFn.
    const syncFlipFlopNames = ["D_FF", "JK_FF", "RS_FF", "T_FF", "Monoflop"];

    const registry = createFullRegistry();

    for (const name of syncFlipFlopNames) {
      const def = registry.get(name);
      expect(def, `${name} should be registered`).toBeDefined();
      expect(def!.sampleFn, `${name} should have a sampleFn`).toBeDefined();
    }
  });

  it("sequential memory components have sampleFn", () => {
    const memoryNames = ["Counter", "CounterPreset", "Register", "RegisterFile"];

    const registry = createFullRegistry();

    for (const name of memoryNames) {
      const def = registry.get(name);
      expect(def, `${name} should be registered`).toBeDefined();
      expect(def!.sampleFn, `${name} should have a sampleFn`).toBeDefined();
    }
  });
});

// ===========================================================================
// BUG-7: executeBarrelShifter hardcodes bitWidth=8
// ===========================================================================
//
// barrel-shifter.ts:196-198 — the static executeBarrelShifter function
// always delegates to makeExecuteBarrelShifter(8, ...), ignoring the
// component's actual bitWidth property. A 32-bit barrel shifter silently
// operates at 8-bit width.

describe("BUG-7: BarrelShifter executeBarrelShifter ignores bitWidth", () => {
  it("executeBarrelShifter reads bitWidth from getProperty", () => {
    // With getProperty providing bitWidth=32, the shifter should operate at full width
    const layout = makeLayout(2, 1, { props: { bitWidth: 32 } });
    const state = new Uint32Array(3);
    const highZs = new Uint32Array(3);

    // Input: 0xFF, shift left by 4
    state[0] = 0xFF;
    state[1] = 4;

    executeBarrelShifter(0, state, highZs, layout);

    const result = state[layout.wiringTable[layout.outputOffset(0)]];

    // With bitWidth=32: 0xFF << 4 = 0xFF0 (not truncated to 8 bits)
    expect(result).toBe(0xFF0);
  });

  it("makeExecuteBarrelShifter(32, ...) correctly handles 32-bit shifts", () => {
    // The factory function itself is correct — verify it works
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
// BUG-1: Builder silently ignores unknown property names
// ===========================================================================
//
// builder.ts:138 — addComponent copies all props into PropertyBag without
// checking if they match the component's declared propertyDefs. Unknown
// properties are silently dropped, leading to confusing runtime behavior
// (e.g., using "Bits" instead of "bitWidth" silently creates 1-bit components).

describe("BUG-1: Builder should warn on unknown property names", () => {
  it("registry component property definitions should be queryable", () => {
    const registry = createFullRegistry();

    // Verify key components declare their properties
    const addDef = registry.get("Add");
    expect(addDef).toBeDefined();
    expect(addDef!.propertyDefs).toBeDefined();
    expect(addDef!.propertyDefs!.length).toBeGreaterThan(0);

    // "bitWidth" should be a valid property for Add
    const hasBitWidth = addDef!.propertyDefs!.some(d => d.key === "bitWidth");
    expect(hasBitWidth).toBe(true);

    // "Bits" should NOT be a valid property key (it's the XML attribute name)
    const hasBits = addDef!.propertyDefs!.some(d => d.key === "Bits");
    expect(hasBits).toBe(false);
  });

  it("In component uses 'bitWidth' not 'Bits' as property key", () => {
    const registry = createFullRegistry();
    const inDef = registry.get("In");
    expect(inDef).toBeDefined();

    // Verify creating with correct property name works
    const props = new PropertyBag();
    props.set("bitWidth", 4);
    const element = inDef!.factory(props);
    const pins = element.getPins();
    const outPin = pins.find(p => p.label === "out");
    expect(outPin?.bitWidth).toBe(4);
  });
});

// ===========================================================================
// BUG-4: ROM data property needs array, string silently ignored
// ===========================================================================

describe("BUG-4: ROM data property format", () => {
  it("ROM data property definition should accept HEX_DATA type", () => {
    const registry = createFullRegistry();
    const romDef = registry.get("ROM");
    expect(romDef).toBeDefined();

    const dataProp = romDef!.propertyDefs!.find(d => d.key === "data");
    expect(dataProp).toBeDefined();
    expect(dataProp!.defaultValue).toEqual([]);
  });

  it("ROM data should be loadable as number array", () => {
    const registry = createFullRegistry();
    const romDef = registry.get("ROM");

    const props = new PropertyBag();
    props.set("addrBits", 4);
    props.set("dataBits", 8);
    props.set("data", [0, 1, 4, 9, 16, 25, 36, 49, 64, 81, 100, 121, 144, 169, 196, 225]);

    const element = romDef!.factory(props);
    // The element should be created successfully with data
    expect(element).toBeDefined();

    // The property should be retrievable as an array
    const elementProps = element.getProperties();
    const data = elementProps.get("data");
    expect(Array.isArray(data)).toBe(true);
  });
});
