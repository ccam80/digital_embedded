/**
 * Canonical tests for the Demultiplexer combinational component.
 *
 * Tier: fixture-only (T1) — pure-digital combinational; no analog domain,
 *   no transient dynamics, no junctions / LTE / breakpoints / preset registry.
 * Driver: facade.build({components, connections}) + facade.compile()
 *   + setSignal / step / readSignal.
 *
 * Canon coverage:
 *   - Cat 4  param hot-load (selectorBits / bitWidth — structural compile-time
 *            seeds; build-twice mechanic from the Canon Cat 4 compile-time-seeded
 *            paragraph).
 *   - Cat 9  digital interaction: drive sel + in, observe one of N outputs.
 *   - Cat 11 multi-output observability: each out_i is independently observable
 *            (Demux.outputSchema returns N pins; values differ for the same
 *            (sel, in) pair).
 *   - Cat 13 port-width clamp on sel: an In of width=selectorBits driven with a
 *            value larger than 2^selectorBits-1 masks via BitVector.fromNumber
 *            in setSignal before reaching executeDemux.
 */

import { describe, it, expect } from "vitest";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../../components/register-all.js";
import type { SimulationCoordinator } from "../../../solver/coordinator-types.js";

const registry = createDefaultRegistry();

// ---------------------------------------------------------------------------
// Canonical builder: a single Demultiplexer driven by labelled In ports
// (SEL, IN) and observed via labelled Out ports (OUT_0..OUT_{N-1}).
// ---------------------------------------------------------------------------

interface DigitalFixture {
  facade: DefaultSimulatorFacade;
  coordinator: SimulationCoordinator;
}

function buildDemuxFixture(opts: { selectorBits: number; bitWidth: number }): DigitalFixture {
  const { selectorBits, bitWidth } = opts;
  const outputCount = 1 << selectorBits;

  const components: Array<{ id: string; type: string; props?: Record<string, number | string | boolean> }> = [
    { id: "sel", type: "In",  props: { label: "SEL", bitWidth: selectorBits } },
    { id: "din", type: "In",  props: { label: "IN",  bitWidth } },
    { id: "dem", type: "Demultiplexer", props: { selectorBits, bitWidth } },
  ];
  const connections: Array<readonly [string, string]> = [
    ["sel:out", "dem:sel"],
    ["din:out", "dem:in"],
  ];
  for (let i = 0; i < outputCount; i++) {
    components.push({ id: `o${i}`, type: "Out", props: { label: `OUT_${i}`, bitWidth } });
    connections.push([`dem:out_${i}`, `o${i}:in`]);
  }

  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({
    components: components.map((c) => ({ id: c.id, type: c.type, ...(c.props ? { props: c.props } : {}) })),
    connections: connections.map((c) => [c[0], c[1]] as [string, string]),
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

// ===========================================================================
// Cat 9 — digital interaction
// ===========================================================================

describe("Demultiplexer digital interaction (Cat 9)", () => {
  it("1-bit selector, sel=0 routes IN to OUT_0; OUT_1 = 0", () => {
    const fix = buildDemuxFixture({ selectorBits: 1, bitWidth: 1 });
    drive(fix, { SEL: 0, IN: 1 });
    expect(read(fix, "OUT_0")).toBe(1);
    expect(read(fix, "OUT_1")).toBe(0);
  });

  it("1-bit selector, sel=1 routes IN to OUT_1; OUT_0 = 0", () => {
    const fix = buildDemuxFixture({ selectorBits: 1, bitWidth: 1 });
    drive(fix, { SEL: 1, IN: 1 });
    expect(read(fix, "OUT_0")).toBe(0);
    expect(read(fix, "OUT_1")).toBe(1);
  });

  it("2-bit selector, sel=2 routes IN to OUT_2; all others 0", () => {
    const fix = buildDemuxFixture({ selectorBits: 2, bitWidth: 8 });
    drive(fix, { SEL: 2, IN: 0x55 });
    expect(read(fix, "OUT_0")).toBe(0);
    expect(read(fix, "OUT_1")).toBe(0);
    expect(read(fix, "OUT_2")).toBe(0x55);
    expect(read(fix, "OUT_3")).toBe(0);
  });

  it("2-bit selector, sel=3 routes IN=0xFF to OUT_3; all others 0", () => {
    const fix = buildDemuxFixture({ selectorBits: 2, bitWidth: 8 });
    drive(fix, { SEL: 3, IN: 0xFF });
    expect(read(fix, "OUT_0")).toBe(0);
    expect(read(fix, "OUT_1")).toBe(0);
    expect(read(fix, "OUT_2")).toBe(0);
    expect(read(fix, "OUT_3")).toBe(0xFF);
  });

  it("multi-bit data: 32-bit value routed to selected output", () => {
    const fix = buildDemuxFixture({ selectorBits: 1, bitWidth: 32 });
    drive(fix, { SEL: 1, IN: 0xDEADBEEF });
    expect(read(fix, "OUT_0")).toBe(0);
    expect(read(fix, "OUT_1")).toBe(0xDEADBEEF);
  });

  it("3-bit selector, sel=5 routes IN to OUT_5; OUT_0..OUT_4, OUT_6, OUT_7 are 0", () => {
    const fix = buildDemuxFixture({ selectorBits: 3, bitWidth: 4 });
    drive(fix, { SEL: 5, IN: 0xA });
    expect(read(fix, "OUT_0")).toBe(0);
    expect(read(fix, "OUT_1")).toBe(0);
    expect(read(fix, "OUT_2")).toBe(0);
    expect(read(fix, "OUT_3")).toBe(0);
    expect(read(fix, "OUT_4")).toBe(0);
    expect(read(fix, "OUT_5")).toBe(0xA);
    expect(read(fix, "OUT_6")).toBe(0);
    expect(read(fix, "OUT_7")).toBe(0);
  });

  it("changing sel reroutes the value — previously selected output drops to 0", () => {
    const fix = buildDemuxFixture({ selectorBits: 2, bitWidth: 8 });
    drive(fix, { SEL: 1, IN: 0xAB });
    expect(read(fix, "OUT_1")).toBe(0xAB);
    expect(read(fix, "OUT_2")).toBe(0);
    drive(fix, { SEL: 2, IN: 0xAB });
    expect(read(fix, "OUT_1")).toBe(0);
    expect(read(fix, "OUT_2")).toBe(0xAB);
  });
});

// ===========================================================================
// Cat 11 — multi-output digital observability
//
// Demultiplexer.models.digital.outputSchema returns N output pins (one per
// 2^selectorBits). For the same (sel, in) input, the N output pins take
// different values: the selected pin = in, all others = 0. Each pin is
// observed independently after a single step (canonical mechanic).
// ===========================================================================

describe("Demultiplexer multi-output observability (Cat 11)", () => {
  it("4-output: sel=0, in=0xCC → OUT_0=0xCC and OUT_1=OUT_2=OUT_3=0 in one step", () => {
    const fix = buildDemuxFixture({ selectorBits: 2, bitWidth: 8 });
    drive(fix, { SEL: 0, IN: 0xCC });
    expect(read(fix, "OUT_0")).toBe(0xCC);
    expect(read(fix, "OUT_1")).toBe(0);
    expect(read(fix, "OUT_2")).toBe(0);
    expect(read(fix, "OUT_3")).toBe(0);
  });

  it("4-output: sel=2, in=0x33 — every output asserted independently after one step", () => {
    const fix = buildDemuxFixture({ selectorBits: 2, bitWidth: 8 });
    drive(fix, { SEL: 2, IN: 0x33 });
    expect(read(fix, "OUT_0")).toBe(0);
    expect(read(fix, "OUT_1")).toBe(0);
    expect(read(fix, "OUT_2")).toBe(0x33);
    expect(read(fix, "OUT_3")).toBe(0);
  });

  it("8-output: sel=7, in=0xF — one output drives the data, seven drive 0", () => {
    const fix = buildDemuxFixture({ selectorBits: 3, bitWidth: 4 });
    drive(fix, { SEL: 7, IN: 0xF });
    for (let i = 0; i < 7; i++) {
      expect(read(fix, `OUT_${i}`)).toBe(0);
    }
    expect(read(fix, "OUT_7")).toBe(0xF);
  });
});

// ===========================================================================
// Cat 4 — parameter hot-load (compile-time-seeded structural properties)
//
// selectorBits and bitWidth are PropertyType.INT / BIT_WIDTH with
// structural: true — they are consumed at compile() to determine the pin
// layout and the output count. The Canon's compile-time-seeded paragraph
// (build-twice mechanic) is the documented hot-load shape for these.
// ===========================================================================

describe("Demultiplexer param hot-load (Cat 4)", () => {
  it("selectorBits=1 vs selectorBits=2: same (sel=1, in=0xAA) drives different output sets", () => {
    // selectorBits=1: only OUT_0 / OUT_1 exist; sel=1 → OUT_1=0xAA.
    const fix1 = buildDemuxFixture({ selectorBits: 1, bitWidth: 8 });
    drive(fix1, { SEL: 1, IN: 0xAA });
    expect(read(fix1, "OUT_0")).toBe(0);
    expect(read(fix1, "OUT_1")).toBe(0xAA);

    // selectorBits=2: OUT_0..OUT_3 exist; sel=1 still drives OUT_1, but OUT_2 / OUT_3
    // are now observable and zero. The post-build observable shape changed.
    const fix2 = buildDemuxFixture({ selectorBits: 2, bitWidth: 8 });
    drive(fix2, { SEL: 1, IN: 0xAA });
    expect(read(fix2, "OUT_0")).toBe(0);
    expect(read(fix2, "OUT_1")).toBe(0xAA);
    expect(read(fix2, "OUT_2")).toBe(0);
    expect(read(fix2, "OUT_3")).toBe(0);
  });

  it("bitWidth=4 truncates IN's high nibble at the In-port; bitWidth=8 preserves it", () => {
    // bitWidth=4: IN port is 4 bits wide; 0xAB driven into a 4-bit In gets masked
    // to 0xB before reaching the demux.
    const fix4 = buildDemuxFixture({ selectorBits: 1, bitWidth: 4 });
    drive(fix4, { SEL: 0, IN: 0xAB });
    expect(read(fix4, "OUT_0")).toBe(0xB);

    // bitWidth=8: IN port is 8 bits wide; 0xAB passes through unmasked.
    const fix8 = buildDemuxFixture({ selectorBits: 1, bitWidth: 8 });
    drive(fix8, { SEL: 0, IN: 0xAB });
    expect(read(fix8, "OUT_0")).toBe(0xAB);
  });
});

// ===========================================================================
// Cat 13 — port-width clamping on overrun
//
// The sel port is `selectorBits` bits wide. The In component upstream of sel
// is declared with `bitWidth: selectorBits`, so a value larger than
// 2^selectorBits-1 driven via setSignal is masked by BitVector.fromNumber
// inside setSignal before being delivered to the sel port. The masked value
// is closed-form: source & ((1 << selectorBits) - 1).
// ===========================================================================

describe("Demultiplexer sel-port width clamp (Cat 13)", () => {
  it("selectorBits=2, sel=4 (1 bit over) masks to 0; IN routes to OUT_0", () => {
    // 4 = 0b100 → masked to 0b00 = 0.
    const fix = buildDemuxFixture({ selectorBits: 2, bitWidth: 8 });
    drive(fix, { SEL: 4, IN: 0x77 });
    expect(read(fix, "OUT_0")).toBe(0x77);
    expect(read(fix, "OUT_1")).toBe(0);
    expect(read(fix, "OUT_2")).toBe(0);
    expect(read(fix, "OUT_3")).toBe(0);
  });

  it("selectorBits=2, sel=7 masks to 3; IN routes to OUT_3", () => {
    // 7 = 0b111 → masked to 0b11 = 3.
    const fix = buildDemuxFixture({ selectorBits: 2, bitWidth: 8 });
    drive(fix, { SEL: 7, IN: 0x44 });
    expect(read(fix, "OUT_0")).toBe(0);
    expect(read(fix, "OUT_1")).toBe(0);
    expect(read(fix, "OUT_2")).toBe(0);
    expect(read(fix, "OUT_3")).toBe(0x44);
  });

  it("selectorBits=3, sel=10 masks to 2; IN routes to OUT_2", () => {
    // 10 = 0b1010 → masked to 0b010 = 2.
    const fix = buildDemuxFixture({ selectorBits: 3, bitWidth: 4 });
    drive(fix, { SEL: 10, IN: 0xC });
    for (let i = 0; i < 8; i++) {
      expect(read(fix, `OUT_${i}`)).toBe(i === 2 ? 0xC : 0);
    }
  });
});
