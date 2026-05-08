/**
 * Canonical tests for ROM family digital memory components: ROM and ROMDualPort.
 *
 * Tier: fixture-only (pure-digital, combinational; no analog domain).
 * Driver: facade.build({components, connections}) + facade.compile() +
 *   coordinator.writeByLabel / step / readByLabel.
 *
 * Canon coverage per variant:
 *   - Cat 4 (param hot-load — compile-time-seeded structural property `data`):
 *     `data` is consumed at compile() to seed the engine-managed DataField
 *     backing store. Canonical mechanic: build the same circuit twice —
 *     once with `data` unset, once with `data: [...]` — and assert the
 *     post-compile observable on D / D1 / D2 differs as documented.
 *   - Cat 9 (bridge / digital interaction): drive labelled inputs (address,
 *     chip-select), step the engine, observe labelled outputs.
 *
 * Cat 1/2/3/5/6/7/8 do not apply: these components are pure digital with
 * no analog state pool, no MNA matrix, no DCOP, no junction limiting,
 * no LTE rollback, no breakpoints, no transient dynamics.
 * Cat 10 does not apply: each definition's modelRegistry is empty (no named
 * presets to swap).
 * Cat 11 does not apply: ROM has a single output (D); ROMDualPort has two
 * outputs (D1, D2) but each port reads from the same backing store via its
 * own independent address — they are independent observables on different
 * inputs, not multiple outputs from the same input combination over the same
 * computation. (Each port's output is exercised independently in Cat 9.)
 * Cat 12 does not apply: no documented forbidden / undefined input
 * combinations.
 * Cat 13 does not apply: the address port is `addrBits` wide and the In
 * driving it is sized to match (no port narrower than its bus).
 * Cat 14 does not apply: production source emits no runtime diagnostics
 * keyed on simulation observables.
 * Cat 15 does not apply: production source registers no _onStateChange
 * writeback subscription.
 */

import { describe, it, expect } from "vitest";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../register-all.js";
import type { SimulationCoordinator } from "../../../solver/coordinator-types.js";

const registry = createDefaultRegistry();

// ---------------------------------------------------------------------------
// Canonical builder for a digital fixture driven by labelled In ports and
// observed via labelled Out ports.
// ---------------------------------------------------------------------------

interface DigitalFixture {
  facade: DefaultSimulatorFacade;
  coordinator: SimulationCoordinator;
}

function buildDigital(spec: {
  components: ReadonlyArray<{ id: string; type: string; props?: Record<string, number | string | boolean | number[]> }>;
  connections: ReadonlyArray<readonly [string, string]>;
}): DigitalFixture {
  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({
    components: spec.components.map((c) =>
      c.props === undefined
        ? { id: c.id, type: c.type }
        : { id: c.id, type: c.type, props: c.props },
    ),
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

// ===========================================================================
// ROM — Cat 9 + Cat 4
// Pin layout: inputs [A (addrBits), sel (1)]; output [D (dataBits)]
// Combinational: if sel=1, D = memory[A]; else D = 0.
// ===========================================================================

function buildROM(opts: {
  addrBits?: number;
  dataBits?: number;
  data?: number[];
}): DigitalFixture {
  const addrBits = opts.addrBits ?? 4;
  const dataBits = opts.dataBits ?? 8;
  const romProps: Record<string, number | string | boolean | number[]> = {
    addrBits,
    dataBits,
  };
  if (opts.data !== undefined) {
    romProps.data = opts.data;
  }
  return buildDigital({
    components: [
      { id: "a",   type: "In",  props: { label: "A",   bitWidth: addrBits } },
      { id: "se",  type: "In",  props: { label: "SEL", bitWidth: 1 } },
      { id: "rom", type: "ROM", props: romProps },
      { id: "d",   type: "Out", props: { label: "D",   bitWidth: dataBits } },
    ],
    connections: [
      ["a:out",  "rom:A"],
      ["se:out", "rom:sel"],
      ["rom:D",  "d:in"],
    ],
  });
}

describe("ROM digital interaction (Cat 9)", () => {
  it("sel=0: D drives 0 regardless of address", () => {
    const fix = buildROM({ addrBits: 4, dataBits: 8, data: [0xAB, 0xCD, 0xEF] });
    drive(fix, { A: 0, SEL: 0 });
    expect(read(fix, "D")).toBe(0);
    drive(fix, { A: 1, SEL: 0 });
    expect(read(fix, "D")).toBe(0);
    drive(fix, { A: 2, SEL: 0 });
    expect(read(fix, "D")).toBe(0);
  });

  it("sel=1 with empty memory: D = 0 at any address", () => {
    const fix = buildROM({ addrBits: 4, dataBits: 8 });
    drive(fix, { A: 0, SEL: 1 });
    expect(read(fix, "D")).toBe(0);
    drive(fix, { A: 7, SEL: 1 });
    expect(read(fix, "D")).toBe(0);
  });

  it("sel=1: D = memory[A] when memory is seeded via data property", () => {
    const fix = buildROM({ addrBits: 4, dataBits: 8, data: [0xAB, 0xCD] });
    drive(fix, { A: 0, SEL: 1 });
    expect(read(fix, "D")).toBe(0xAB);
    drive(fix, { A: 1, SEL: 1 });
    expect(read(fix, "D")).toBe(0xCD);
  });

  it("address out of seeded data range reads 0 (backing-store zero-init)", () => {
    // addrBits=4 → backing store size 16. data length 3, so addresses 3..15
    // read 0 (zero-init beyond data.length).
    const fix = buildROM({ addrBits: 4, dataBits: 8, data: [0x10, 0x20, 0x30] });
    drive(fix, { A: 5, SEL: 1 });
    expect(read(fix, "D")).toBe(0);
    drive(fix, { A: 15, SEL: 1 });
    expect(read(fix, "D")).toBe(0);
  });

  it("transition sel 1->0 then 0->1 toggles D between memory[A] and 0", () => {
    const fix = buildROM({ addrBits: 4, dataBits: 8, data: [0x77, 0x88] });
    drive(fix, { A: 1, SEL: 1 });
    expect(read(fix, "D")).toBe(0x88);
    drive(fix, { A: 1, SEL: 0 });
    expect(read(fix, "D")).toBe(0);
    drive(fix, { A: 1, SEL: 1 });
    expect(read(fix, "D")).toBe(0x88);
  });
});

describe("ROM param hot-load addrBits / dataBits (Cat 4)", () => {
  it("addrBits=2 vs addrBits=4: address pin width differs — A=4 wraps to A=0 with 2-bit pin", () => {
    // addrBits=2 → A pin is 2 bits, so driving A=4 truncates to 0.
    // The seeded memory size = 2^addrBits = 4 entries.
    const fix2 = buildROM({ addrBits: 2, dataBits: 8, data: [0xAA, 0xBB, 0xCC, 0xDD] });
    drive(fix2, { A: 4, SEL: 1 });
    expect(read(fix2, "D")).toBe(0xAA); // 4 truncated to 0 → mem[0] = 0xAA

    // addrBits=4 → A pin is 4 bits, so A=4 stays 4. mem[4] is 0 (data only seeds [0..3]).
    const fix4 = buildROM({ addrBits: 4, dataBits: 8, data: [0xAA, 0xBB, 0xCC, 0xDD] });
    drive(fix4, { A: 4, SEL: 1 });
    expect(read(fix4, "D")).toBe(0);
  });

  it("dataBits=4 truncates D to 4-bit; dataBits=8 keeps the full byte", () => {
    // dataBits is structural; the D port is dataBits-wide.
    const fix4 = buildROM({ addrBits: 4, dataBits: 4, data: [0xFF] });
    drive(fix4, { A: 0, SEL: 1 });
    expect(read(fix4, "D")).toBe(0x0F);

    const fix8 = buildROM({ addrBits: 4, dataBits: 8, data: [0xFF] });
    drive(fix8, { A: 0, SEL: 1 });
    expect(read(fix8, "D")).toBe(0xFF);
  });
});

describe("ROM data property seeds memory at compile time (Cat 4 — C5)", () => {
  it("data=[0x10,0x20,0x30] vs unset: D differs at A=0 / SEL=1 post-compile", () => {
    const fixDefault = buildROM({ addrBits: 4, dataBits: 8 });
    drive(fixDefault, { A: 0, SEL: 1 });
    expect(read(fixDefault, "D")).toBe(0);

    const fixSeeded = buildROM({ addrBits: 4, dataBits: 8, data: [0x10, 0x20, 0x30] });
    drive(fixSeeded, { A: 0, SEL: 1 });
    expect(read(fixSeeded, "D")).toBe(0x10);
  });

  it("data=[0xA,0xB,0xC,0xD]: D reads 0xC at A=2 (mid-array seeded correctly)", () => {
    const fix = buildROM({ addrBits: 4, dataBits: 8, data: [0xA, 0xB, 0xC, 0xD] });
    drive(fix, { A: 2, SEL: 1 });
    expect(read(fix, "D")).toBe(0xC);
  });
});

// ===========================================================================
// ROMDualPort — Cat 9 + Cat 4
// Pin layout: inputs [A1 (addrBits), s1 (1), A2 (addrBits), s2 (1)];
//             outputs [D1 (dataBits), D2 (dataBits)]
// Combinational: D1 = s1 ? memory[A1] : 0; D2 = s2 ? memory[A2] : 0.
// Both ports read from the same backing store.
// ===========================================================================

function buildROMDualPort(opts: {
  addrBits?: number;
  dataBits?: number;
  data?: number[];
}): DigitalFixture {
  const addrBits = opts.addrBits ?? 4;
  const dataBits = opts.dataBits ?? 8;
  const romProps: Record<string, number | string | boolean | number[]> = {
    addrBits,
    dataBits,
  };
  if (opts.data !== undefined) {
    romProps.data = opts.data;
  }
  return buildDigital({
    components: [
      { id: "a1",  type: "In",  props: { label: "A1", bitWidth: addrBits } },
      { id: "s1",  type: "In",  props: { label: "S1", bitWidth: 1 } },
      { id: "a2",  type: "In",  props: { label: "A2", bitWidth: addrBits } },
      { id: "s2",  type: "In",  props: { label: "S2", bitWidth: 1 } },
      { id: "rom", type: "ROMDualPort", props: romProps },
      { id: "d1",  type: "Out", props: { label: "D1", bitWidth: dataBits } },
      { id: "d2",  type: "Out", props: { label: "D2", bitWidth: dataBits } },
    ],
    connections: [
      ["a1:out", "rom:A1"],
      ["s1:out", "rom:s1"],
      ["a2:out", "rom:A2"],
      ["s2:out", "rom:s2"],
      ["rom:D1", "d1:in"],
      ["rom:D2", "d2:in"],
    ],
  });
}

describe("ROMDualPort digital interaction (Cat 9)", () => {
  it("both selects=0: D1 and D2 drive 0 regardless of addresses", () => {
    const fix = buildROMDualPort({ addrBits: 4, dataBits: 8, data: [0xAA, 0xBB, 0xCC] });
    drive(fix, { A1: 0, S1: 0, A2: 1, S2: 0 });
    expect(read(fix, "D1")).toBe(0);
    expect(read(fix, "D2")).toBe(0);
  });

  it("port-1 selected, port-2 disabled: D1=memory[A1], D2=0", () => {
    const fix = buildROMDualPort({ addrBits: 4, dataBits: 8, data: [0x11, 0x22, 0x33] });
    drive(fix, { A1: 1, S1: 1, A2: 2, S2: 0 });
    expect(read(fix, "D1")).toBe(0x22);
    expect(read(fix, "D2")).toBe(0);
  });

  it("port-2 selected, port-1 disabled: D1=0, D2=memory[A2]", () => {
    const fix = buildROMDualPort({ addrBits: 4, dataBits: 8, data: [0x11, 0x22, 0x33] });
    drive(fix, { A1: 1, S1: 0, A2: 2, S2: 1 });
    expect(read(fix, "D1")).toBe(0);
    expect(read(fix, "D2")).toBe(0x33);
  });

  it("both ports selected, distinct addresses: D1 and D2 read independently from the same backing store", () => {
    const fix = buildROMDualPort({
      addrBits: 4,
      dataBits: 8,
      data: [0x10, 0x20, 0x30, 0x40, 0x50],
    });
    drive(fix, { A1: 0, S1: 1, A2: 4, S2: 1 });
    expect(read(fix, "D1")).toBe(0x10);
    expect(read(fix, "D2")).toBe(0x50);
  });

  it("both ports selected, same address: D1 and D2 produce the same value", () => {
    const fix = buildROMDualPort({ addrBits: 4, dataBits: 8, data: [0xAA, 0xBB, 0xCC] });
    drive(fix, { A1: 2, S1: 1, A2: 2, S2: 1 });
    expect(read(fix, "D1")).toBe(0xCC);
    expect(read(fix, "D2")).toBe(0xCC);
  });

  it("address out of seeded data range reads 0 on the corresponding port", () => {
    // addrBits=4 → backing-store size 16; data length 2 seeds only [0,1].
    const fix = buildROMDualPort({ addrBits: 4, dataBits: 8, data: [0x77, 0x88] });
    drive(fix, { A1: 0, S1: 1, A2: 7, S2: 1 });
    expect(read(fix, "D1")).toBe(0x77);
    expect(read(fix, "D2")).toBe(0);
  });
});

describe("ROMDualPort param hot-load addrBits / dataBits (Cat 4)", () => {
  it("addrBits=2 vs addrBits=4: address pin width differs — A1=4 wraps to 0 with 2-bit pin", () => {
    // addrBits=2 → memory size 4; A1 pin 2 bits truncates A1=4 to 0.
    const fix2 = buildROMDualPort({
      addrBits: 2,
      dataBits: 8,
      data: [0xAA, 0xBB, 0xCC, 0xDD],
    });
    drive(fix2, { A1: 4, S1: 1, A2: 1, S2: 1 });
    expect(read(fix2, "D1")).toBe(0xAA); // 4 truncates to 0
    expect(read(fix2, "D2")).toBe(0xBB);

    // addrBits=4 → A1 pin 4 bits, A1=4 stays 4. data only seeded [0..3].
    const fix4 = buildROMDualPort({
      addrBits: 4,
      dataBits: 8,
      data: [0xAA, 0xBB, 0xCC, 0xDD],
    });
    drive(fix4, { A1: 4, S1: 1, A2: 1, S2: 1 });
    expect(read(fix4, "D1")).toBe(0); // mem[4] = 0
    expect(read(fix4, "D2")).toBe(0xBB);
  });

  it("dataBits=4 truncates D1/D2 to 4-bit; dataBits=8 keeps the full byte", () => {
    const fix4 = buildROMDualPort({ addrBits: 4, dataBits: 4, data: [0xFF, 0xEE] });
    drive(fix4, { A1: 0, S1: 1, A2: 1, S2: 1 });
    expect(read(fix4, "D1")).toBe(0x0F);
    expect(read(fix4, "D2")).toBe(0x0E);

    const fix8 = buildROMDualPort({ addrBits: 4, dataBits: 8, data: [0xFF, 0xEE] });
    drive(fix8, { A1: 0, S1: 1, A2: 1, S2: 1 });
    expect(read(fix8, "D1")).toBe(0xFF);
    expect(read(fix8, "D2")).toBe(0xEE);
  });
});

describe("ROMDualPort data property seeds memory at compile time (Cat 4 — C5)", () => {
  it("data=[0xF0,0xF1,0xF2] vs unset: D1 differs at A1=0 / S1=1 post-compile", () => {
    const fixDefault = buildROMDualPort({ addrBits: 4, dataBits: 8 });
    drive(fixDefault, { A1: 0, S1: 1, A2: 0, S2: 1 });
    expect(read(fixDefault, "D1")).toBe(0);
    expect(read(fixDefault, "D2")).toBe(0);

    const fixSeeded = buildROMDualPort({
      addrBits: 4,
      dataBits: 8,
      data: [0xF0, 0xF1, 0xF2],
    });
    drive(fixSeeded, { A1: 0, S1: 1, A2: 0, S2: 1 });
    expect(read(fixSeeded, "D1")).toBe(0xF0);
    expect(read(fixSeeded, "D2")).toBe(0xF0);
  });

  it("data=[1,2,3,4,5]: shared backing store — D1 at A1=2 reads 3; D2 at A2=4 reads 5 simultaneously", () => {
    const fix = buildROMDualPort({
      addrBits: 4,
      dataBits: 8,
      data: [1, 2, 3, 4, 5],
    });
    drive(fix, { A1: 2, S1: 1, A2: 4, S2: 1 });
    expect(read(fix, "D1")).toBe(3);
    expect(read(fix, "D2")).toBe(5);
  });
});
