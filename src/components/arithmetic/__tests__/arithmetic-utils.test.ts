/**
 * Canonical tests for arithmetic utility components: Neg, Comparator
 * (MagnitudeComparator), BarrelShifter, BitCount, BitExtender, PRNG.
 *
 * Tier: T1 — facade.build({components, connections}) + facade.compile() +
 *       setSignal / step / readSignal. Pure-digital combinational/clocked
 *       components have no analog domain, so neither buildFixture (analog
 *       fixture only) nor ComparisonSession (paired ngspice domain) applies.
 *       The sanctioned T1 surface for digital-only circuits is the facade
 *       signal API, which routes to coordinator.writeSignal /
 *       coordinator.readSignal (default-facade.ts setSignal/step/readSignal).
 *
 * Canon coverage per component:
 *   - Cat 9 (digital interaction): drive labelled In ports, step, observe
 *     labelled Out ports.
 *   - Cat 4 (param hot-load): structural properties (bitWidth, signed, mode,
 *     direction, inputBits, outputBits) close over compile time. The
 *     documented hot-load mechanic is to re-build+compile with the changed
 *     property and observe a different output for the same logical inputs;
 *     this matches the sibling pattern in arithmetic.test.ts.draft.
 *
 * Cats 1, 2, 3, 5, 6, 7, 8 do not apply — pure-digital components have no
 * analog model, no DCOP, no NR limiting / convergence stress, no LTE rollback
 * / dt control, and no breakpoint registration via acceptStep.
 */

import { describe, it, expect } from "vitest";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../../components/register-all.js";
import type { SimulationCoordinator } from "../../../solver/coordinator-types.js";

const registry = createDefaultRegistry();

// ---------------------------------------------------------------------------
// Canonical fixture builder for digital-only circuits.
//
// build() validates topology and width agreement at compile time, so the
// helper is intentionally thin: callers describe components + connections,
// the helper compiles, and exposes the facade + coordinator pair through
// which every signal is driven and observed.
// ---------------------------------------------------------------------------

interface DigitalFixture {
  facade: DefaultSimulatorFacade;
  coordinator: SimulationCoordinator;
}

function buildDigital(spec: {
  components: ReadonlyArray<{ id: string; type: string; props?: Record<string, number | string | boolean> }>;
  connections: ReadonlyArray<readonly [string, string]>;
}): DigitalFixture {
  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({
    components: spec.components.map((c) => ({ id: c.id, type: c.type, props: c.props })),
    connections: spec.connections.map((c) => [c[0], c[1]] as [string, string]),
  });
  const coordinator = facade.compile(circuit);
  return { facade, coordinator };
}

function drive(fix: DigitalFixture, values: Record<string, number>): void {
  for (const [label, value] of Object.entries(values)) {
    fix.facade.setSignal(fix.coordinator, label, value);
  }
  fix.facade.step(fix.coordinator);
}

function read(fix: DigitalFixture, label: string): number {
  return fix.facade.readSignal(fix.coordinator, label) as number;
}

// shiftBitsFor mirrors barrel-shifter.ts: ceil(log2(bitWidth)), min 1.
// Required to size the In driving the BarrelShifter "shift" port.
function shiftBitsFor(bitWidth: number): number {
  let n = bitWidth - 1;
  let bits = 0;
  while (n > 0) { bits++; n >>= 1; }
  return Math.max(1, bits);
}

// outBitsFor mirrors bit-count.ts: bits needed to hold popcount(bitWidth).
// Required to size the Out receiving the BitCount "out" port.
function outBitsFor(bitWidth: number): number {
  let n = bitWidth;
  let bits = 0;
  while (n > 0) { bits++; n >>= 1; }
  return Math.max(1, bits);
}

// ===========================================================================
// NEG — Cat 9 (digital interaction) + Cat 4 (param hot-load via bitWidth)
// Pin schema: in (bitWidth) -> out (bitWidth). out = -in mod 2^bitWidth.
// ===========================================================================

function buildNegFixture(bitWidth: number): DigitalFixture {
  return buildDigital({
    components: [
      { id: "a",   type: "In",  props: { label: "A", bitWidth } },
      { id: "neg", type: "Neg", props: { bitWidth } },
      { id: "y",   type: "Out", props: { label: "Y", bitWidth } },
    ],
    connections: [
      ["a:out",   "neg:in"],
      ["neg:out", "y:in"],
    ],
  });
}

describe("Neg digital interaction (Cat 9)", () => {
  it("8-bit: -0 = 0", () => {
    const fix = buildNegFixture(8);
    drive(fix, { A: 0 });
    expect(read(fix, "Y")).toBe(0);
  });

  it("8-bit: -1 = 0xFF (two's complement)", () => {
    const fix = buildNegFixture(8);
    drive(fix, { A: 1 });
    expect(read(fix, "Y")).toBe(0xFF);
  });

  it("8-bit: -0x7F = 0x81", () => {
    const fix = buildNegFixture(8);
    drive(fix, { A: 0x7F });
    expect(read(fix, "Y")).toBe(0x81);
  });

  it("8-bit: -0x80 = 0x80 (min signed value negates to itself)", () => {
    const fix = buildNegFixture(8);
    drive(fix, { A: 0x80 });
    expect(read(fix, "Y")).toBe(0x80);
  });

  it("32-bit: -1 = 0xFFFFFFFF", () => {
    const fix = buildNegFixture(32);
    drive(fix, { A: 1 });
    expect(read(fix, "Y")).toBe(0xFFFFFFFF);
  });

  it("32-bit: -0x80000000 = 0x80000000 (min 32-bit signed negates to itself)", () => {
    const fix = buildNegFixture(32);
    drive(fix, { A: 0x80000000 });
    expect(read(fix, "Y")).toBe(0x80000000);
  });

  it("16-bit: -(255) = 0xFF01", () => {
    // -255 in 16-bit two's complement: 0x10000 - 0xFF = 0xFF01
    const fix = buildNegFixture(16);
    drive(fix, { A: 0xFF });
    expect(read(fix, "Y")).toBe(0xFF01);
  });
});

describe("Neg param hot-load bitWidth (Cat 4)", () => {
  it("bitWidth=8 vs bitWidth=16: same input 1 -> different output mask widths", () => {
    const fix8  = buildNegFixture(8);
    const fix16 = buildNegFixture(16);
    drive(fix8,  { A: 1 });
    drive(fix16, { A: 1 });
    // -1 wrapped to 8 bits = 0xFF
    expect(read(fix8,  "Y")).toBe(0xFF);
    // -1 wrapped to 16 bits = 0xFFFF
    expect(read(fix16, "Y")).toBe(0xFFFF);
  });
});

// ===========================================================================
// COMPARATOR (MagnitudeComparator) — Cat 9 + Cat 4 (bitWidth, signed)
// Pin schema: a (bitWidth), b (bitWidth) -> > (1), = (1), < (1).
// Output names are literally ">", "=", "<" per comparator.ts pin layout.
// ===========================================================================

function buildComparatorFixture(bitWidth: number, signed: boolean): DigitalFixture {
  return buildDigital({
    components: [
      { id: "a",   type: "In",                  props: { label: "A",  bitWidth } },
      { id: "b",   type: "In",                  props: { label: "B",  bitWidth } },
      { id: "cmp", type: "MagnitudeComparator", props: { bitWidth, signed } },
      { id: "gt",  type: "Out", props: { label: "GT", bitWidth: 1 } },
      { id: "eq",  type: "Out", props: { label: "EQ", bitWidth: 1 } },
      { id: "lt",  type: "Out", props: { label: "LT", bitWidth: 1 } },
    ],
    connections: [
      ["a:out", "cmp:a"],
      ["b:out", "cmp:b"],
      ["cmp:>", "gt:in"],
      ["cmp:=", "eq:in"],
      ["cmp:<", "lt:in"],
    ],
  });
}

describe("Comparator unsigned digital interaction (Cat 9)", () => {
  it("4-bit unsigned: 3 == 3 -> EQ=1, GT=0, LT=0", () => {
    const fix = buildComparatorFixture(4, false);
    drive(fix, { A: 3, B: 3 });
    expect(read(fix, "EQ")).toBe(1);
    expect(read(fix, "GT")).toBe(0);
    expect(read(fix, "LT")).toBe(0);
  });

  it("4-bit unsigned: 5 > 3 -> GT=1, EQ=0, LT=0", () => {
    const fix = buildComparatorFixture(4, false);
    drive(fix, { A: 5, B: 3 });
    expect(read(fix, "GT")).toBe(1);
    expect(read(fix, "EQ")).toBe(0);
    expect(read(fix, "LT")).toBe(0);
  });

  it("4-bit unsigned: 2 < 7 -> LT=1, EQ=0, GT=0", () => {
    const fix = buildComparatorFixture(4, false);
    drive(fix, { A: 2, B: 7 });
    expect(read(fix, "LT")).toBe(1);
    expect(read(fix, "EQ")).toBe(0);
    expect(read(fix, "GT")).toBe(0);
  });

  it("8-bit unsigned: 0xFF > 0x0F (high values stay positive in unsigned)", () => {
    const fix = buildComparatorFixture(8, false);
    drive(fix, { A: 0xFF, B: 0x0F });
    expect(read(fix, "GT")).toBe(1);
    expect(read(fix, "EQ")).toBe(0);
    expect(read(fix, "LT")).toBe(0);
  });

  it("8-bit unsigned: 0 == 0", () => {
    const fix = buildComparatorFixture(8, false);
    drive(fix, { A: 0, B: 0 });
    expect(read(fix, "EQ")).toBe(1);
  });
});

describe("Comparator signed digital interaction (Cat 9)", () => {
  it("4-bit signed: -1 (0xF) < 1 -> LT=1", () => {
    const fix = buildComparatorFixture(4, true);
    drive(fix, { A: 0xF, B: 1 });
    expect(read(fix, "LT")).toBe(1);
    expect(read(fix, "GT")).toBe(0);
  });

  it("4-bit signed: -1 (0xF) > -5 (0xB) -> GT=1", () => {
    const fix = buildComparatorFixture(4, true);
    drive(fix, { A: 0xF, B: 0xB });
    expect(read(fix, "GT")).toBe(1);
    expect(read(fix, "LT")).toBe(0);
  });

  it("8-bit signed: -128 (0x80) < 127 (0x7F) -> LT=1", () => {
    const fix = buildComparatorFixture(8, true);
    drive(fix, { A: 0x80, B: 0x7F });
    expect(read(fix, "LT")).toBe(1);
  });

  it("8-bit signed: -1 (0xFF) == -1 (0xFF) -> EQ=1", () => {
    const fix = buildComparatorFixture(8, true);
    drive(fix, { A: 0xFF, B: 0xFF });
    expect(read(fix, "EQ")).toBe(1);
  });
});

describe("Comparator param hot-load bitWidth and signed (Cat 4)", () => {
  it("signed=false vs signed=true: 4-bit 0xF vs 1 — unsigned says GT, signed says LT", () => {
    // In unsigned 4-bit, 0xF=15 > 1, so GT=1.
    // In signed 4-bit, 0xF = -1 < 1, so LT=1.
    const fixU = buildComparatorFixture(4, false);
    const fixS = buildComparatorFixture(4, true);
    drive(fixU, { A: 0xF, B: 1 });
    drive(fixS, { A: 0xF, B: 1 });
    expect(read(fixU, "GT")).toBe(1);
    expect(read(fixS, "LT")).toBe(1);
    expect(read(fixU, "GT")).not.toBe(read(fixS, "GT"));
  });

  it("bitWidth=4 vs bitWidth=8: same logical inputs, different sign-bit positions in signed mode", () => {
    // 4-bit signed: 0x8 has the sign bit set -> -8, so 0x8 < 0
    const fix4 = buildComparatorFixture(4, true);
    drive(fix4, { A: 0x8, B: 0 });
    expect(read(fix4, "LT")).toBe(1);
    // 8-bit signed: 0x8 = +8, so 0x8 > 0
    const fix8 = buildComparatorFixture(8, true);
    drive(fix8, { A: 0x8, B: 0 });
    expect(read(fix8, "GT")).toBe(1);
  });
});

// ===========================================================================
// BARREL SHIFTER — Cat 9 + Cat 4 (bitWidth, mode, direction)
// Pin schema: in (bitWidth), shift (shiftBitsFor(bitWidth) [+1 if signed])
//             -> out (bitWidth).
// ===========================================================================

function buildBarrelShifterFixture(
  bitWidth: number,
  mode: "logical" | "rotate" | "arithmetic",
  direction: "left" | "right",
): DigitalFixture {
  const shiftWidth = shiftBitsFor(bitWidth); // signed=false in all our tests
  return buildDigital({
    components: [
      { id: "in",  type: "In",            props: { label: "IN",    bitWidth } },
      { id: "sh",  type: "In",            props: { label: "SHIFT", bitWidth: shiftWidth } },
      { id: "bs",  type: "BarrelShifter", props: { bitWidth, signed: false, mode, direction } },
      { id: "out", type: "Out",           props: { label: "OUT",   bitWidth } },
    ],
    connections: [
      ["in:out",  "bs:in"],
      ["sh:out",  "bs:shift"],
      ["bs:out",  "out:in"],
    ],
  });
}

describe("BarrelShifter logical-left digital interaction (Cat 9)", () => {
  it("8-bit logical-left: 0x01 << 1 = 0x02", () => {
    const fix = buildBarrelShifterFixture(8, "logical", "left");
    drive(fix, { IN: 0x01, SHIFT: 1 });
    expect(read(fix, "OUT")).toBe(0x02);
  });

  it("8-bit logical-left: 0xFF << 4 = 0xF0 (high bits drop)", () => {
    const fix = buildBarrelShifterFixture(8, "logical", "left");
    drive(fix, { IN: 0xFF, SHIFT: 4 });
    expect(read(fix, "OUT")).toBe(0xF0);
  });

  it("8-bit logical-left: 0x01 << 0 = 0x01 (no shift)", () => {
    const fix = buildBarrelShifterFixture(8, "logical", "left");
    drive(fix, { IN: 0x01, SHIFT: 0 });
    expect(read(fix, "OUT")).toBe(0x01);
  });

  it("16-bit logical-left: 0x0001 << 4 = 0x0010", () => {
    const fix = buildBarrelShifterFixture(16, "logical", "left");
    drive(fix, { IN: 0x0001, SHIFT: 4 });
    expect(read(fix, "OUT")).toBe(0x0010);
  });
});

describe("BarrelShifter logical-right digital interaction (Cat 9)", () => {
  it("8-bit logical-right: 0x80 >> 1 = 0x40", () => {
    const fix = buildBarrelShifterFixture(8, "logical", "right");
    drive(fix, { IN: 0x80, SHIFT: 1 });
    expect(read(fix, "OUT")).toBe(0x40);
  });

  it("8-bit logical-right: 0xFF >> 4 = 0x0F", () => {
    const fix = buildBarrelShifterFixture(8, "logical", "right");
    drive(fix, { IN: 0xFF, SHIFT: 4 });
    expect(read(fix, "OUT")).toBe(0x0F);
  });
});

describe("BarrelShifter rotate digital interaction (Cat 9)", () => {
  it("8-bit rotate-left by 1: 0x01 -> 0x02", () => {
    const fix = buildBarrelShifterFixture(8, "rotate", "left");
    drive(fix, { IN: 0x01, SHIFT: 1 });
    expect(read(fix, "OUT")).toBe(0x02);
  });

  it("8-bit rotate-left by 1: 0x80 wraps MSB to LSB -> 0x01", () => {
    const fix = buildBarrelShifterFixture(8, "rotate", "left");
    drive(fix, { IN: 0x80, SHIFT: 1 });
    expect(read(fix, "OUT")).toBe(0x01);
  });

  it("8-bit rotate-right by 1: 0x01 wraps LSB to MSB -> 0x80", () => {
    const fix = buildBarrelShifterFixture(8, "rotate", "right");
    drive(fix, { IN: 0x01, SHIFT: 1 });
    expect(read(fix, "OUT")).toBe(0x80);
  });
});

describe("BarrelShifter arithmetic-right digital interaction (Cat 9)", () => {
  it("8-bit arithmetic-right by 1: 0x80 sign-extends to 0xC0", () => {
    const fix = buildBarrelShifterFixture(8, "arithmetic", "right");
    drive(fix, { IN: 0x80, SHIFT: 1 });
    expect(read(fix, "OUT")).toBe(0xC0);
  });

  it("8-bit arithmetic-right by 4: 0x80 sign-extends to 0xF8", () => {
    const fix = buildBarrelShifterFixture(8, "arithmetic", "right");
    drive(fix, { IN: 0x80, SHIFT: 4 });
    expect(read(fix, "OUT")).toBe(0xF8);
  });

  it("8-bit arithmetic-right by 1: 0x40 has clear sign bit -> 0x20 (no extension)", () => {
    const fix = buildBarrelShifterFixture(8, "arithmetic", "right");
    drive(fix, { IN: 0x40, SHIFT: 1 });
    expect(read(fix, "OUT")).toBe(0x20);
  });
});

describe("BarrelShifter param hot-load mode and direction (Cat 4)", () => {
  it("logical vs rotate at the same shift amount produces different outputs (8-bit, left, 0x80 << 1)", () => {
    // logical-left: 0x80 << 1 = 0x100 masked to 8 bits = 0x00
    const fixLogical = buildBarrelShifterFixture(8, "logical", "left");
    drive(fixLogical, { IN: 0x80, SHIFT: 1 });
    // rotate-left:  0x80 -> 0x01 (MSB wraps)
    const fixRotate = buildBarrelShifterFixture(8, "rotate", "left");
    drive(fixRotate, { IN: 0x80, SHIFT: 1 });
    expect(read(fixLogical, "OUT")).toBe(0x00);
    expect(read(fixRotate,  "OUT")).toBe(0x01);
    expect(read(fixLogical, "OUT")).not.toBe(read(fixRotate, "OUT"));
  });

  it("logical vs arithmetic right shift differs only when MSB is set (8-bit, 0x80 >> 1)", () => {
    // logical-right:    0x80 >> 1 = 0x40 (zero fill)
    const fixLogical = buildBarrelShifterFixture(8, "logical", "right");
    drive(fixLogical, { IN: 0x80, SHIFT: 1 });
    // arithmetic-right: 0x80 >> 1 = 0xC0 (sign fill)
    const fixArith = buildBarrelShifterFixture(8, "arithmetic", "right");
    drive(fixArith, { IN: 0x80, SHIFT: 1 });
    expect(read(fixLogical, "OUT")).toBe(0x40);
    expect(read(fixArith,   "OUT")).toBe(0xC0);
  });

  it("direction=left vs direction=right at the same shift amount produces different outputs", () => {
    // 0x10 << 1 logical = 0x20
    const fixLeft = buildBarrelShifterFixture(8, "logical", "left");
    drive(fixLeft, { IN: 0x10, SHIFT: 1 });
    // 0x10 >> 1 logical = 0x08
    const fixRight = buildBarrelShifterFixture(8, "logical", "right");
    drive(fixRight, { IN: 0x10, SHIFT: 1 });
    expect(read(fixLeft,  "OUT")).toBe(0x20);
    expect(read(fixRight, "OUT")).toBe(0x08);
  });
});

// ---------------------------------------------------------------------------
// BarrelShifter — Cat 13 (port-width clamping on overrun)
// bitWidth=8 → shift port is ceil(log2(8))=3 bits wide. The upstream In sized
// to that 3-bit port masks any wider value to (source & 0b111) before it
// reaches the BarrelShifter. Documented mask: out-of-range shift amounts wrap
// to their low-order shiftBits.
// ---------------------------------------------------------------------------

describe("BarrelShifter port-width clamping on overrun (Cat 13)", () => {
  it("barrelshifter_shift_overrun_masks_to_zero", () => {
    // bitWidth=8 → shift port = 3 bits. SHIFT=8 (1000b) masks to 000b = 0,
    // so logical-left of 0xAB by 0 is 0xAB (no shift).
    const fix = buildBarrelShifterFixture(8, "logical", "left");
    drive(fix, { IN: 0xAB, SHIFT: 8 });
    expect(read(fix, "OUT")).toBe(0xAB);
  });

  it("barrelshifter_shift_overrun_wraps_to_nonzero_masked_shift", () => {
    // bitWidth=8 → shift port = 3 bits. SHIFT=10 (1010b) masks to 010b = 2,
    // so logical-left of 0x01 by 2 is 0x04.
    const fix = buildBarrelShifterFixture(8, "logical", "left");
    drive(fix, { IN: 0x01, SHIFT: 10 });
    expect(read(fix, "OUT")).toBe(0x04);
  });
});

// ===========================================================================
// BIT COUNT — Cat 9 + Cat 4 (bitWidth)
// Pin schema: in (bitWidth) -> out (outBitsFor(bitWidth))
// out = popcount(in)
// ===========================================================================

function buildBitCountFixture(bitWidth: number): DigitalFixture {
  return buildDigital({
    components: [
      { id: "a",   type: "In",       props: { label: "A",   bitWidth } },
      { id: "bc",  type: "BitCount", props: { bitWidth } },
      { id: "out", type: "Out",      props: { label: "CNT", bitWidth: outBitsFor(bitWidth) } },
    ],
    connections: [
      ["a:out",  "bc:in"],
      ["bc:out", "out:in"],
    ],
  });
}

describe("BitCount digital interaction (Cat 9)", () => {
  it("8-bit: popcount(0x00) = 0", () => {
    const fix = buildBitCountFixture(8);
    drive(fix, { A: 0x00 });
    expect(read(fix, "CNT")).toBe(0);
  });

  it("8-bit: popcount(0xFF) = 8", () => {
    const fix = buildBitCountFixture(8);
    drive(fix, { A: 0xFF });
    expect(read(fix, "CNT")).toBe(8);
  });

  it("8-bit: popcount(0x0F) = 4", () => {
    const fix = buildBitCountFixture(8);
    drive(fix, { A: 0x0F });
    expect(read(fix, "CNT")).toBe(4);
  });

  it("8-bit: popcount(0x01) = 1", () => {
    const fix = buildBitCountFixture(8);
    drive(fix, { A: 0x01 });
    expect(read(fix, "CNT")).toBe(1);
  });

  it("8-bit: popcount(0xAA) = 4 (alternating)", () => {
    const fix = buildBitCountFixture(8);
    drive(fix, { A: 0xAA });
    expect(read(fix, "CNT")).toBe(4);
  });

  it("32-bit: popcount(0xFFFFFFFF) = 32", () => {
    const fix = buildBitCountFixture(32);
    drive(fix, { A: 0xFFFFFFFF });
    expect(read(fix, "CNT")).toBe(32);
  });

  it("32-bit: popcount(0xAAAAAAAA) = 16 (alternating)", () => {
    const fix = buildBitCountFixture(32);
    drive(fix, { A: 0xAAAAAAAA });
    expect(read(fix, "CNT")).toBe(16);
  });
});

describe("BitCount param hot-load bitWidth (Cat 4)", () => {
  it("bitWidth=8 vs bitWidth=16: same all-ones-shaped input gives different counts at the In source mask", () => {
    // The In component masks outgoing values to its bitWidth, so 0xFFFF on a
    // bitWidth=8 In is truncated to 0xFF before reaching the BitCount.
    const fix8  = buildBitCountFixture(8);
    const fix16 = buildBitCountFixture(16);
    drive(fix8,  { A: 0xFF });
    drive(fix16, { A: 0xFFFF });
    expect(read(fix8,  "CNT")).toBe(8);
    expect(read(fix16, "CNT")).toBe(16);
  });
});

// ===========================================================================
// BIT EXTENDER — Cat 9 + Cat 4 (inputBits, outputBits)
// Pin schema: in (inputBits) -> out (outputBits)
// MSB=0 => zero-extend; MSB=1 => sign-extend (high bits set to 1).
// ===========================================================================

function buildBitExtenderFixture(inputBits: number, outputBits: number): DigitalFixture {
  return buildDigital({
    components: [
      { id: "a",   type: "In",          props: { label: "A",   bitWidth: inputBits } },
      { id: "ex",  type: "BitExtender", props: { inputBits, outputBits } },
      { id: "out", type: "Out",         props: { label: "OUT", bitWidth: outputBits } },
    ],
    connections: [
      ["a:out",  "ex:in"],
      ["ex:out", "out:in"],
    ],
  });
}

describe("BitExtender digital interaction (Cat 9)", () => {
  it("4->8: 0x07 (MSB clear) zero-extends to 0x07", () => {
    const fix = buildBitExtenderFixture(4, 8);
    drive(fix, { A: 0x07 });
    expect(read(fix, "OUT")).toBe(0x07);
  });

  it("4->8: 0x00 zero-extends to 0x00", () => {
    const fix = buildBitExtenderFixture(4, 8);
    drive(fix, { A: 0x00 });
    expect(read(fix, "OUT")).toBe(0x00);
  });

  it("4->8: 0x0F (-1, MSB set) sign-extends to 0xFF", () => {
    const fix = buildBitExtenderFixture(4, 8);
    drive(fix, { A: 0x0F });
    expect(read(fix, "OUT")).toBe(0xFF);
  });

  it("4->8: 0x08 (-8, MSB set) sign-extends to 0xF8", () => {
    const fix = buildBitExtenderFixture(4, 8);
    drive(fix, { A: 0x08 });
    expect(read(fix, "OUT")).toBe(0xF8);
  });

  it("8->16: 0x80 (MSB set) sign-extends to 0xFF80", () => {
    const fix = buildBitExtenderFixture(8, 16);
    drive(fix, { A: 0x80 });
    expect(read(fix, "OUT")).toBe(0xFF80);
  });

  it("8->16: 0x7F (MSB clear) zero-extends to 0x007F", () => {
    const fix = buildBitExtenderFixture(8, 16);
    drive(fix, { A: 0x7F });
    expect(read(fix, "OUT")).toBe(0x007F);
  });

  it("16->32: 0x8000 sign-extends to 0xFFFF8000", () => {
    const fix = buildBitExtenderFixture(16, 32);
    drive(fix, { A: 0x8000 });
    expect(read(fix, "OUT")).toBe(0xFFFF8000);
  });
});

describe("BitExtender param hot-load inputBits and outputBits (Cat 4)", () => {
  it("4->8 vs 4->16: same input 0x0F sign-extends to different widths", () => {
    const fix8  = buildBitExtenderFixture(4, 8);
    const fix16 = buildBitExtenderFixture(4, 16);
    drive(fix8,  { A: 0x0F });
    drive(fix16, { A: 0x0F });
    expect(read(fix8,  "OUT")).toBe(0x00FF);
    expect(read(fix16, "OUT")).toBe(0xFFFF);
  });

  it("inputBits=4 vs inputBits=8 with outputBits=16: 0x08 sign-extended differently", () => {
    // inputBits=4: 0x08 has the 4-bit MSB set -> sign-extend -> 0xFFF8
    const fix4to16 = buildBitExtenderFixture(4, 16);
    drive(fix4to16, { A: 0x08 });
    // inputBits=8: 0x08 has the 8-bit MSB clear -> zero-extend -> 0x0008
    const fix8to16 = buildBitExtenderFixture(8, 16);
    drive(fix8to16, { A: 0x08 });
    expect(read(fix4to16, "OUT")).toBe(0xFFF8);
    expect(read(fix8to16, "OUT")).toBe(0x0008);
  });
});

// ===========================================================================
// PRNG — Cat 9 + Cat 4 (bitWidth)
// Pin schema: S (bitWidth), se (1), ne (1), C (1, clock) -> R (bitWidth).
// On rising C edge: se=1 seeds LFSR with S (or 1 if S=0); ne=1 advances LFSR.
// R always reflects the current LFSR state.
//
// Driving the clock through one full low-high-low cycle delivers exactly one
// rising edge; mirrors the canonical pulseClock helper used in
// flipflops.test.ts.draft for clocked-digital components.
// ===========================================================================

function buildPRNGFixture(bitWidth: number): DigitalFixture {
  return buildDigital({
    components: [
      { id: "s",    type: "In",   props: { label: "S",   bitWidth } },
      { id: "se",   type: "In",   props: { label: "SE",  bitWidth: 1 } },
      { id: "ne",   type: "In",   props: { label: "NE",  bitWidth: 1 } },
      { id: "c",    type: "In",   props: { label: "C",   bitWidth: 1 } },
      { id: "prng", type: "PRNG", props: { bitWidth } },
      { id: "r",    type: "Out",  props: { label: "R",   bitWidth } },
    ],
    connections: [
      ["s:out",   "prng:S"],
      ["se:out",  "prng:se"],
      ["ne:out",  "prng:ne"],
      ["c:out",   "prng:C"],
      ["prng:R",  "r:in"],
    ],
  });
}

function pulseClock(fix: DigitalFixture, label: string): void {
  fix.facade.setSignal(fix.coordinator, label, 0);
  fix.facade.step(fix.coordinator);
  fix.facade.setSignal(fix.coordinator, label, 1);
  fix.facade.step(fix.coordinator);
  fix.facade.setSignal(fix.coordinator, label, 0);
  fix.facade.step(fix.coordinator);
}

describe("PRNG seed digital interaction (Cat 9)", () => {
  it("8-bit: se=1 with S=0x55 on rising clock seeds R to 0x55", () => {
    const fix = buildPRNGFixture(8);
    drive(fix, { S: 0x55, SE: 1, NE: 0, C: 0 });
    pulseClock(fix, "C");
    expect(read(fix, "R")).toBe(0x55);
  });

  it("8-bit: se=1 with S=0 on rising clock seeds R to 1 (no all-zero lock-up)", () => {
    const fix = buildPRNGFixture(8);
    drive(fix, { S: 0, SE: 1, NE: 0, C: 0 });
    pulseClock(fix, "C");
    expect(read(fix, "R")).toBe(1);
  });

  it("16-bit: se=1 with S=0xCAFE on rising clock seeds R to 0xCAFE", () => {
    const fix = buildPRNGFixture(16);
    drive(fix, { S: 0xCAFE, SE: 1, NE: 0, C: 0 });
    pulseClock(fix, "C");
    expect(read(fix, "R")).toBe(0xCAFE);
  });
});

describe("PRNG advance digital interaction (Cat 9)", () => {
  it("8-bit: after seeding to 1, ne=1 on rising clock changes R to a non-zero, non-1 value", () => {
    const fix = buildPRNGFixture(8);
    // Seed first.
    drive(fix, { S: 1, SE: 1, NE: 0, C: 0 });
    pulseClock(fix, "C");
    expect(read(fix, "R")).toBe(1);
    // Advance.
    drive(fix, { S: 1, SE: 0, NE: 1, C: 0 });
    pulseClock(fix, "C");
    const next = read(fix, "R");
    expect(next).not.toBe(1);
    expect(next).not.toBe(0);
  });

  it("8-bit: ne=1 over many clock edges produces multiple distinct values", () => {
    const fix = buildPRNGFixture(8);
    drive(fix, { S: 1, SE: 1, NE: 0, C: 0 });
    pulseClock(fix, "C");
    drive(fix, { S: 0, SE: 0, NE: 1, C: 0 });
    const seen = new Set<number>();
    for (let i = 0; i < 20; i++) {
      pulseClock(fix, "C");
      seen.add(read(fix, "R"));
    }
    // 8-bit maximal-length LFSR has period 255; 20 steps should yield many distinct values.
    expect(seen.size).toBeGreaterThanOrEqual(10);
  });
});

describe("PRNG hold digital interaction (Cat 9)", () => {
  it("8-bit: with no rising clock edge after seeding, R remains the seed value", () => {
    const fix = buildPRNGFixture(8);
    // Seed with a single rising edge.
    drive(fix, { S: 0x42, SE: 1, NE: 0, C: 0 });
    pulseClock(fix, "C");
    expect(read(fix, "R")).toBe(0x42);
    // Now drop SE and assert NE high but never produce another rising edge.
    fix.facade.setSignal(fix.coordinator, "SE", 0);
    fix.facade.setSignal(fix.coordinator, "NE", 1);
    fix.facade.setSignal(fix.coordinator, "C", 0);
    fix.facade.step(fix.coordinator);
    fix.facade.step(fix.coordinator);
    expect(read(fix, "R")).toBe(0x42);
  });
});

describe("PRNG param hot-load bitWidth (Cat 4)", () => {
  it("bitWidth=8 vs bitWidth=16: same seed mechanism, different LFSR widths reach different seeded values", () => {
    const fix8  = buildPRNGFixture(8);
    const fix16 = buildPRNGFixture(16);
    drive(fix8,  { S: 0x55,   SE: 1, NE: 0, C: 0 });
    drive(fix16, { S: 0x1234, SE: 1, NE: 0, C: 0 });
    pulseClock(fix8,  "C");
    pulseClock(fix16, "C");
    expect(read(fix8,  "R")).toBe(0x55);
    expect(read(fix16, "R")).toBe(0x1234);
  });
});

