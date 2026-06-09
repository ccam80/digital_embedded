import { describe, it, expect } from "vitest";
import { createDefaultRegistry } from "../../../components/register-all.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import type { PropertyValue } from "../../../core/properties.js";
import type { SignalValue } from "../../../compile/types.js";

// ---------------------------------------------------------------------------
// Counter / CounterPreset / Register canonical test set
//
// Component family: edge-triggered digital sequential elements (memory).
// Canon categories applicable:
//   - 4  Param hot-load (compile-time-seeded structural `bitWidth`).
//   - 9  Bridge / digital interaction (clock-edge state updates; control pins).
//   - 11 Multi-output digital observability (Counter / CounterPreset emit
//        `out` + `ovf` independently on the same step).
// File tier: fixture-only (digital-only — no analog domain, so buildFixture
//   is not applicable; canonical mechanic is facade.compile + coordinator
//   writeByLabel/step/readByLabel per the same pattern as Decoder).
// Categories not applicable:
//   - 1 Init: no analog state pool slots; the post-compile observable is
//     covered by Cat 9 ("output reads 0 before any clock edge").
//   - 2/3/5 DCOP/transient/stamp: no analog dynamics.
//   - 6 Limiting / 7 LTE / 8 Breakpoints: no junctions, no LTE timestep,
//     no breakpoint registration.
//   - 10 Named model preset: each definition's modelRegistry exposes a
//     single `behavioral` entry — nothing for a preset path to swap.
//   - 12 Forbidden inputs: spec is silent on combined clr/ld priority
//     beyond the single comment "clr > ld > count" in counter-preset.ts.
//   - 13 Port-width clamp: signal-bit pins are 1-wide; the multi-bit `in`
//     port on CounterPreset matches the bus width by construction.
//   - 14/15: no runtime-diagnostic emission, no _onStateChange writeback.
// ---------------------------------------------------------------------------

function digital(value: number): SignalValue {
  return { type: "digital", value };
}

interface DigitalFixture {
  facade: DefaultSimulatorFacade;
  coordinator: ReturnType<DefaultSimulatorFacade["compile"]>;
}

// ---------------------------------------------------------------------------
// Counter fixture: 1-bit count output (bitWidth=1 keeps the canonical
// observation surface to one labelled `Out` per pin without losing semantic
// coverage — overflow at maxValue=1 cycles every two rising edges).
// ---------------------------------------------------------------------------

function buildCounterFixture(opts: { bitWidth: number }): DigitalFixture {
  const bitWidth = opts.bitWidth;
  const components: Array<{ id: string; type: string; props: Record<string, PropertyValue> }> = [
    { id: "enIn",  type: "In",     props: { label: "EN",  bitWidth: 1 } },
    { id: "cIn",   type: "In",     props: { label: "C",   bitWidth: 1 } },
    { id: "clrIn", type: "In",     props: { label: "CLR", bitWidth: 1 } },
    { id: "ctr",   type: "Counter", props: { label: "CTR", bitWidth } },
    { id: "outOut", type: "Out",   props: { label: "OUT", bitWidth } },
    { id: "ovfOut", type: "Out",   props: { label: "OVF", bitWidth: 1 } },
  ];
  const connections: Array<[string, string]> = [
    ["enIn:out",  "ctr:en"],
    ["cIn:out",   "ctr:C"],
    ["clrIn:out", "ctr:clr"],
    ["ctr:out",   "outOut:in"],
    ["ctr:ovf",   "ovfOut:in"],
  ];
  const registry = createDefaultRegistry();
  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({ components, connections });
  const coordinator = facade.compile(circuit);
  return { facade, coordinator };
}

// ---------------------------------------------------------------------------
// CounterPreset fixture: full 6-input control surface (en/C/dir/in/ld/clr).
// ---------------------------------------------------------------------------

function buildCounterPresetFixture(opts: { bitWidth: number }): DigitalFixture {
  const bitWidth = opts.bitWidth;
  const components: Array<{ id: string; type: string; props: Record<string, PropertyValue> }> = [
    { id: "enIn",  type: "In",            props: { label: "EN",   bitWidth: 1 } },
    { id: "cIn",   type: "In",            props: { label: "C",    bitWidth: 1 } },
    { id: "dirIn", type: "In",            props: { label: "DIR",  bitWidth: 1 } },
    { id: "inIn",  type: "In",            props: { label: "LDIN", bitWidth } },
    { id: "ldIn",  type: "In",            props: { label: "LD",   bitWidth: 1 } },
    { id: "clrIn", type: "In",            props: { label: "CLR",  bitWidth: 1 } },
    { id: "ctp",   type: "CounterPreset", props: { label: "CTP",  bitWidth } },
    { id: "outOut", type: "Out",          props: { label: "OUT",  bitWidth } },
    { id: "ovfOut", type: "Out",          props: { label: "OVF",  bitWidth: 1 } },
  ];
  const connections: Array<[string, string]> = [
    ["enIn:out",  "ctp:en"],
    ["cIn:out",   "ctp:C"],
    ["dirIn:out", "ctp:dir"],
    ["inIn:out",  "ctp:in"],
    ["ldIn:out",  "ctp:ld"],
    ["clrIn:out", "ctp:clr"],
    ["ctp:out",   "outOut:in"],
    ["ctp:ovf",   "ovfOut:in"],
  ];
  const registry = createDefaultRegistry();
  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({ components, connections });
  const coordinator = facade.compile(circuit);
  return { facade, coordinator };
}

// ---------------------------------------------------------------------------
// Register fixture: D/C/en in, Q out (single bus port at the configured width).
// ---------------------------------------------------------------------------

function buildRegisterFixture(opts: { bitWidth: number }): DigitalFixture {
  const bitWidth = opts.bitWidth;
  const components: Array<{ id: string; type: string; props: Record<string, PropertyValue> }> = [
    { id: "dIn",   type: "In",       props: { label: "D",  bitWidth } },
    { id: "cIn",   type: "In",       props: { label: "C",  bitWidth: 1 } },
    { id: "enIn",  type: "In",       props: { label: "EN", bitWidth: 1 } },
    { id: "reg",   type: "Register", props: { label: "REG", bitWidth } },
    { id: "qOut",  type: "Out",      props: { label: "Q",  bitWidth } },
  ];
  const connections: Array<[string, string]> = [
    ["dIn:out",  "reg:D"],
    ["cIn:out",  "reg:C"],
    ["enIn:out", "reg:en"],
    ["reg:Q",    "qOut:in"],
  ];
  const registry = createDefaultRegistry();
  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({ components, connections });
  const coordinator = facade.compile(circuit);
  return { facade, coordinator };
}

// Helper: single rising-edge clock pulse driving sample/execute on the
// downstream sequential component. Returns after the rising-edge step.
function pulseClock(fix: DigitalFixture): void {
  fix.coordinator.writeByLabel("C", digital(0));
  fix.coordinator.step();
  fix.coordinator.writeByLabel("C", digital(1));
  fix.coordinator.step();
}

// ---------------------------------------------------------------------------
// Counter — Cat 9 (Bridge / digital), Cat 11 (Multi-output), Cat 4 (hot-load)
// ---------------------------------------------------------------------------

describe("Counter — bridge / digital (T1)", () => {
  // -------------------------------------------------------------------------
  // Cat 9: rising-edge clock with en=1, clr=0 increments the count by 1.
  // bitWidth=4 → maxValue=15 → first rising edge advances 0 → 1.
  // -------------------------------------------------------------------------

  it("rising_edge_with_enable_increments_count_by_one", () => {
    const fix = buildCounterFixture({ bitWidth: 4 });
    fix.coordinator.writeByLabel("EN",  digital(1));
    fix.coordinator.writeByLabel("CLR", digital(0));
    pulseClock(fix);
    expect(fix.coordinator.readByLabel("OUT")).toMatchObject({ type: "digital", value: 1 });
    fix.coordinator.dispose();
  });

  // -------------------------------------------------------------------------
  // Cat 9: with en=0 the counter does not increment on a rising clock edge.
  // -------------------------------------------------------------------------

  it("rising_edge_with_enable_low_holds_count", () => {
    const fix = buildCounterFixture({ bitWidth: 4 });
    fix.coordinator.writeByLabel("EN",  digital(0));
    fix.coordinator.writeByLabel("CLR", digital(0));
    pulseClock(fix);
    pulseClock(fix);
    expect(fix.coordinator.readByLabel("OUT")).toMatchObject({ type: "digital", value: 0 });
    fix.coordinator.dispose();
  });

  // -------------------------------------------------------------------------
  // Cat 9: clr=1 takes priority on rising edge — count resets to 0 even when
  // en=1 would have incremented.
  // -------------------------------------------------------------------------

  it("clear_on_rising_edge_resets_count_to_zero", () => {
    const fix = buildCounterFixture({ bitWidth: 4 });
    // First, drive the count up to 2 with clr=0.
    fix.coordinator.writeByLabel("EN",  digital(1));
    fix.coordinator.writeByLabel("CLR", digital(0));
    pulseClock(fix);
    pulseClock(fix);
    expect(fix.coordinator.readByLabel("OUT")).toMatchObject({ type: "digital", value: 2 });

    // Now assert clr on a rising edge — count returns to 0.
    fix.coordinator.writeByLabel("CLR", digital(1));
    pulseClock(fix);
    expect(fix.coordinator.readByLabel("OUT")).toMatchObject({ type: "digital", value: 0 });
    fix.coordinator.dispose();
  });

  // -------------------------------------------------------------------------
  // Cat 9: at bitWidth=4 the counter wraps from maxValue=15 back to 0 on the
  // 16th rising edge.
  // -------------------------------------------------------------------------

  it("wraps_from_max_value_back_to_zero", () => {
    const fix = buildCounterFixture({ bitWidth: 4 });
    fix.coordinator.writeByLabel("EN",  digital(1));
    fix.coordinator.writeByLabel("CLR", digital(0));
    for (let i = 0; i < 15; i++) pulseClock(fix);
    expect(fix.coordinator.readByLabel("OUT")).toMatchObject({ type: "digital", value: 15 });
    pulseClock(fix);
    expect(fix.coordinator.readByLabel("OUT")).toMatchObject({ type: "digital", value: 0 });
    fix.coordinator.dispose();
  });

  // -------------------------------------------------------------------------
  // Cat 11: Counter outputSchema declares two outputs (`out`, `ovf`) that
  // take independent values on the same step. At maxValue and en=1, ovf=1
  // while out reads the current count. Observe both independently.
  // -------------------------------------------------------------------------

  it("emits_out_and_ovf_independently_at_max_value_with_enable", () => {
    const fix = buildCounterFixture({ bitWidth: 4 });
    fix.coordinator.writeByLabel("EN",  digital(1));
    fix.coordinator.writeByLabel("CLR", digital(0));
    // Drive the count to 15 (maxValue) — 15 rising edges from the post-compile
    // initial state.
    for (let i = 0; i < 15; i++) pulseClock(fix);
    // After settling at maxValue=15 with en=1, ovf goes high. Drive a final
    // sample step (clock low → high transition is not required to observe
    // ovf; executeCounter sets ovf as a combinational function of count and
    // en — but writeByLabel + step is what the bridge needs to propagate).
    fix.coordinator.writeByLabel("C", digital(0));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("OUT")).toMatchObject({ type: "digital", value: 15 });
    expect(fix.coordinator.readByLabel("OVF")).toMatchObject({ type: "digital", value: 1 });
    fix.coordinator.dispose();
  });

  // -------------------------------------------------------------------------
  // Cat 11: with en=0, ovf stays 0 even at maxValue (ovf gate requires en=1).
  // Documents the independence of `out` and `ovf` on the same step.
  // -------------------------------------------------------------------------

  it("ovf_low_when_enable_low_even_at_max_value", () => {
    const fix = buildCounterFixture({ bitWidth: 4 });
    fix.coordinator.writeByLabel("EN",  digital(1));
    fix.coordinator.writeByLabel("CLR", digital(0));
    for (let i = 0; i < 15; i++) pulseClock(fix);
    // Now drop en — ovf must drop to 0 while out remains at 15.
    fix.coordinator.writeByLabel("EN", digital(0));
    fix.coordinator.writeByLabel("C", digital(0));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("OUT")).toMatchObject({ type: "digital", value: 15 });
    expect(fix.coordinator.readByLabel("OVF")).toMatchObject({ type: "digital", value: 0 });
    fix.coordinator.dispose();
  });

  // -------------------------------------------------------------------------
  // Cat 4 (compile-time-seeded structural property): bitWidth is structural
  // (`structural: true` in COUNTER_PROPERTY_DEFS). Build the same circuit
  // twice — once at bitWidth=2 (maxValue=3), once at bitWidth=4 (maxValue=15)
  // — and assert that the documented post-compile observable (the count
  // value at which ovf rises after enabled rising edges) differs.
  // -------------------------------------------------------------------------

  it("bit_width_seeds_max_value_observable_at_overflow", () => {
    // bitWidth=2 → maxValue=3; ovf rises after 3 enabled rising edges.
    const fix2 = buildCounterFixture({ bitWidth: 2 });
    fix2.coordinator.writeByLabel("EN",  digital(1));
    fix2.coordinator.writeByLabel("CLR", digital(0));
    for (let i = 0; i < 3; i++) pulseClock(fix2);
    fix2.coordinator.writeByLabel("C", digital(0));
    fix2.coordinator.step();
    expect(fix2.coordinator.readByLabel("OUT")).toMatchObject({ type: "digital", value: 3 });
    expect(fix2.coordinator.readByLabel("OVF")).toMatchObject({ type: "digital", value: 1 });
    fix2.coordinator.dispose();

    // bitWidth=4 → maxValue=15; ovf is still 0 after only 3 enabled edges.
    const fix4 = buildCounterFixture({ bitWidth: 4 });
    fix4.coordinator.writeByLabel("EN",  digital(1));
    fix4.coordinator.writeByLabel("CLR", digital(0));
    for (let i = 0; i < 3; i++) pulseClock(fix4);
    fix4.coordinator.writeByLabel("C", digital(0));
    fix4.coordinator.step();
    expect(fix4.coordinator.readByLabel("OUT")).toMatchObject({ type: "digital", value: 3 });
    expect(fix4.coordinator.readByLabel("OVF")).toMatchObject({ type: "digital", value: 0 });
    fix4.coordinator.dispose();
  });
});

// ---------------------------------------------------------------------------
// CounterPreset — Cat 9, Cat 11, Cat 4
// ---------------------------------------------------------------------------

describe("CounterPreset — bridge / digital (T1)", () => {
  // -------------------------------------------------------------------------
  // Cat 9: dir=0 counts up; rising edge with en=1, clr=0, ld=0 increments.
  // -------------------------------------------------------------------------

  it("up_direction_with_enable_increments_count", () => {
    const fix = buildCounterPresetFixture({ bitWidth: 4 });
    fix.coordinator.writeByLabel("EN",   digital(1));
    fix.coordinator.writeByLabel("DIR",  digital(0));
    fix.coordinator.writeByLabel("LDIN", digital(0));
    fix.coordinator.writeByLabel("LD",   digital(0));
    fix.coordinator.writeByLabel("CLR",  digital(0));
    pulseClock(fix);
    pulseClock(fix);
    expect(fix.coordinator.readByLabel("OUT")).toMatchObject({ type: "digital", value: 2 });
    fix.coordinator.dispose();
  });

  // -------------------------------------------------------------------------
  // Cat 9: dir=1 counts down; from count=0 the wrap-around behaviour drives
  // count → maxValue (=15 at bitWidth=4) on the next rising edge.
  // -------------------------------------------------------------------------

  it("down_direction_wraps_from_zero_to_max_value", () => {
    const fix = buildCounterPresetFixture({ bitWidth: 4 });
    fix.coordinator.writeByLabel("EN",   digital(1));
    fix.coordinator.writeByLabel("DIR",  digital(1));
    fix.coordinator.writeByLabel("LDIN", digital(0));
    fix.coordinator.writeByLabel("LD",   digital(0));
    fix.coordinator.writeByLabel("CLR",  digital(0));
    pulseClock(fix);
    expect(fix.coordinator.readByLabel("OUT")).toMatchObject({ type: "digital", value: 15 });
    fix.coordinator.dispose();
  });

  // -------------------------------------------------------------------------
  // Cat 9: ld=1 on rising edge overrides count and loads `in` value.
  // -------------------------------------------------------------------------

  it("load_on_rising_edge_loads_in_value_into_count", () => {
    const fix = buildCounterPresetFixture({ bitWidth: 4 });
    fix.coordinator.writeByLabel("EN",   digital(1));
    fix.coordinator.writeByLabel("DIR",  digital(0));
    fix.coordinator.writeByLabel("LDIN", digital(0xA));
    fix.coordinator.writeByLabel("LD",   digital(1));
    fix.coordinator.writeByLabel("CLR",  digital(0));
    pulseClock(fix);
    expect(fix.coordinator.readByLabel("OUT")).toMatchObject({ type: "digital", value: 0xA });
    fix.coordinator.dispose();
  });

  // -------------------------------------------------------------------------
  // Cat 9: clr=1 takes priority over ld on rising edge — count resets to 0.
  // -------------------------------------------------------------------------

  it("clear_takes_priority_over_load", () => {
    const fix = buildCounterPresetFixture({ bitWidth: 4 });
    fix.coordinator.writeByLabel("EN",   digital(1));
    fix.coordinator.writeByLabel("DIR",  digital(0));
    fix.coordinator.writeByLabel("LDIN", digital(0xA));
    fix.coordinator.writeByLabel("LD",   digital(1));
    fix.coordinator.writeByLabel("CLR",  digital(1));
    pulseClock(fix);
    expect(fix.coordinator.readByLabel("OUT")).toMatchObject({ type: "digital", value: 0 });
    fix.coordinator.dispose();
  });

  // -------------------------------------------------------------------------
  // Cat 11: CounterPreset outputSchema declares two outputs (`out`, `ovf`)
  // that take independent values. dir=0 + count=maxValue + en=1 → ovf=1.
  // -------------------------------------------------------------------------

  it("emits_out_and_ovf_independently_when_counting_up_at_max", () => {
    const fix = buildCounterPresetFixture({ bitWidth: 4 });
    fix.coordinator.writeByLabel("EN",   digital(1));
    fix.coordinator.writeByLabel("DIR",  digital(0));
    fix.coordinator.writeByLabel("LDIN", digital(0xF));
    fix.coordinator.writeByLabel("LD",   digital(1));
    fix.coordinator.writeByLabel("CLR",  digital(0));
    pulseClock(fix);
    // Now LD=0 and observe ovf at maxValue=15.
    fix.coordinator.writeByLabel("LD", digital(0));
    fix.coordinator.writeByLabel("C",  digital(0));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("OUT")).toMatchObject({ type: "digital", value: 15 });
    expect(fix.coordinator.readByLabel("OVF")).toMatchObject({ type: "digital", value: 1 });
    fix.coordinator.dispose();
  });

  // -------------------------------------------------------------------------
  // Cat 11: dir=1 (down) + count=0 + en=1 → ovf=1; observed independently.
  // -------------------------------------------------------------------------

  it("emits_out_and_ovf_independently_when_counting_down_at_zero", () => {
    const fix = buildCounterPresetFixture({ bitWidth: 4 });
    fix.coordinator.writeByLabel("EN",   digital(1));
    fix.coordinator.writeByLabel("DIR",  digital(1));
    fix.coordinator.writeByLabel("LDIN", digital(0));
    fix.coordinator.writeByLabel("LD",   digital(0));
    fix.coordinator.writeByLabel("CLR",  digital(1));
    pulseClock(fix);
    // Now drop CLR/LD; the count is 0 and dir=1 → ovf=1 on the next sample.
    fix.coordinator.writeByLabel("CLR", digital(0));
    fix.coordinator.writeByLabel("C",   digital(0));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("OUT")).toMatchObject({ type: "digital", value: 0 });
    expect(fix.coordinator.readByLabel("OVF")).toMatchObject({ type: "digital", value: 1 });
    fix.coordinator.dispose();
  });

  // -------------------------------------------------------------------------
  // Cat 4 (compile-time-seeded structural property): bitWidth is structural.
  // Build the same circuit twice (bitWidth=2 vs bitWidth=4) and assert that
  // the load-then-observe path returns different values when the supplied
  // `in` overflows the narrower width.
  // -------------------------------------------------------------------------

  it("bit_width_seeds_load_observable_via_mask", () => {
    // bitWidth=2 → mask=0b11=3; loading 0xA masks to 0xA & 0x3 = 2.
    const fix2 = buildCounterPresetFixture({ bitWidth: 2 });
    fix2.coordinator.writeByLabel("EN",   digital(1));
    fix2.coordinator.writeByLabel("DIR",  digital(0));
    fix2.coordinator.writeByLabel("LDIN", digital(0xA));
    fix2.coordinator.writeByLabel("LD",   digital(1));
    fix2.coordinator.writeByLabel("CLR",  digital(0));
    pulseClock(fix2);
    expect(fix2.coordinator.readByLabel("OUT")).toMatchObject({ type: "digital", value: 0xA & 0x3 });
    fix2.coordinator.dispose();

    // bitWidth=4 → mask=0xF; loading 0xA stays 0xA.
    const fix4 = buildCounterPresetFixture({ bitWidth: 4 });
    fix4.coordinator.writeByLabel("EN",   digital(1));
    fix4.coordinator.writeByLabel("DIR",  digital(0));
    fix4.coordinator.writeByLabel("LDIN", digital(0xA));
    fix4.coordinator.writeByLabel("LD",   digital(1));
    fix4.coordinator.writeByLabel("CLR",  digital(0));
    pulseClock(fix4);
    expect(fix4.coordinator.readByLabel("OUT")).toMatchObject({ type: "digital", value: 0xA });
    fix4.coordinator.dispose();
  });
});

// ---------------------------------------------------------------------------
// Register — Cat 9, Cat 4
// ---------------------------------------------------------------------------

describe("Register — bridge / digital (T1)", () => {
  // -------------------------------------------------------------------------
  // Cat 9: rising edge with en=1 latches D into Q.
  // -------------------------------------------------------------------------

  it("rising_edge_with_enable_latches_d_into_q", () => {
    const fix = buildRegisterFixture({ bitWidth: 8 });
    fix.coordinator.writeByLabel("EN", digital(1));
    fix.coordinator.writeByLabel("D",  digital(0xA5));
    pulseClock(fix);
    expect(fix.coordinator.readByLabel("Q")).toMatchObject({ type: "digital", value: 0xA5 });
    fix.coordinator.dispose();
  });

  // -------------------------------------------------------------------------
  // Cat 9: rising edge with en=0 does NOT latch — Q retains pre-edge value.
  // -------------------------------------------------------------------------

  it("rising_edge_with_enable_low_does_not_latch", () => {
    const fix = buildRegisterFixture({ bitWidth: 8 });
    // First latch a known value.
    fix.coordinator.writeByLabel("EN", digital(1));
    fix.coordinator.writeByLabel("D",  digital(0x55));
    pulseClock(fix);
    expect(fix.coordinator.readByLabel("Q")).toMatchObject({ type: "digital", value: 0x55 });

    // Drop en; drive a new D value; the latch must not fire on this edge.
    fix.coordinator.writeByLabel("EN", digital(0));
    fix.coordinator.writeByLabel("D",  digital(0xAA));
    pulseClock(fix);
    expect(fix.coordinator.readByLabel("Q")).toMatchObject({ type: "digital", value: 0x55 });
    fix.coordinator.dispose();
  });

  // -------------------------------------------------------------------------
  // Cat 9: latched value persists through subsequent clock pulses with en=0
  // and changing D — i.e. Q drives the stored value combinationally, not D.
  // -------------------------------------------------------------------------

  it("latched_value_persists_across_pulses_when_enable_low", () => {
    const fix = buildRegisterFixture({ bitWidth: 8 });
    fix.coordinator.writeByLabel("EN", digital(1));
    fix.coordinator.writeByLabel("D",  digital(0x3C));
    pulseClock(fix);
    expect(fix.coordinator.readByLabel("Q")).toMatchObject({ type: "digital", value: 0x3C });

    fix.coordinator.writeByLabel("EN", digital(0));
    for (const newD of [0x00, 0xFF, 0x55, 0xAA]) {
      fix.coordinator.writeByLabel("D", digital(newD));
      pulseClock(fix);
      expect(fix.coordinator.readByLabel("Q")).toMatchObject({ type: "digital", value: 0x3C });
    }
    fix.coordinator.dispose();
  });

  // -------------------------------------------------------------------------
  // Cat 4 (compile-time-seeded structural property): bitWidth is structural.
  // Build the register twice — at bitWidth=4 the high nibble of a stored
  // value is masked off; at bitWidth=8 the full byte is preserved.
  // -------------------------------------------------------------------------

  it("bit_width_seeds_storage_observable_via_mask", () => {
    // bitWidth=4 → only the low 4 bits round-trip; 0xA5 → 0x5.
    const fix4 = buildRegisterFixture({ bitWidth: 4 });
    fix4.coordinator.writeByLabel("EN", digital(1));
    fix4.coordinator.writeByLabel("D",  digital(0xA5));
    pulseClock(fix4);
    expect(fix4.coordinator.readByLabel("Q")).toMatchObject({ type: "digital", value: 0xA5 & 0xF });
    fix4.coordinator.dispose();

    // bitWidth=8 → full byte round-trips.
    const fix8 = buildRegisterFixture({ bitWidth: 8 });
    fix8.coordinator.writeByLabel("EN", digital(1));
    fix8.coordinator.writeByLabel("D",  digital(0xA5));
    pulseClock(fix8);
    expect(fix8.coordinator.readByLabel("Q")).toMatchObject({ type: "digital", value: 0xA5 });
    fix8.coordinator.dispose();
  });
});

// ---------------------------------------------------------------------------
// Cat 9 — pin-loading override propagates through Counter component.
// `digitalPinLoadingOverrides` on circuit.metadata marks individual pins as
// `loaded` (resistor-divider sag against the digital input load) or `ideal`
// (no sag). The Counter is the canonical sequential vehicle for confirming
// that override propagation reaches a real registered component (vs. the
// stub-registry coverage in src/solver/analog/__tests__/digital-pin-loading
// .test.ts and src/headless/__tests__/digital-pin-loading-mcp.test.ts).
//
// Closed-form: vsEN=5 V drives ctr:en through rEN=10 kΩ; the loaded boundary
//   node sees v_en = 5 · 1e7 / (10 kΩ + 1e7) ≈ 4.99500 V (cmos-3v3 bridge input
//   impedance rIn=1e7). This voltage is on the analog net (rEN:neg) — the
//   counter's "ctr:en" signal reports the thresholded digital level, not the
//   boundary voltage. Ideal pins (C, clr) see the full 5 V: the override stamps
//   no loading conductance and the sources are stiff (no series resistor).
// ---------------------------------------------------------------------------

describe("Counter — pin-loading override (T1)", () => {
  it("loaded_en_sees_voltage_sag_ideal_clk_clr_see_no_sag", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);

    const circuit = facade.build({
      components: [
        { id: "vsEN",  type: "DcVoltageSource", props: { voltage: 5.0 } },
        { id: "rEN",   type: "Resistor",        props: { resistance: 10000 } },
        { id: "vsCLK", type: "DcVoltageSource", props: { voltage: 5.0 } },
        { id: "vsCLR", type: "DcVoltageSource", props: { voltage: 5.0 } },
        { id: "ctr",   type: "Counter",         props: { bitWidth: 4, label: "ctr" } },
        { id: "rOut",  type: "Resistor",        props: { resistance: 10000 } },
        { id: "rOvf",  type: "Resistor",        props: { resistance: 10000 } },
        { id: "gnd",   type: "Ground" },
      ],
      connections: [
        ["vsEN:pos",  "rEN:pos"],
        ["rEN:neg",   "ctr:en"],
        ["vsCLK:pos", "ctr:C"],
        ["vsCLR:pos", "ctr:clr"],
        ["ctr:out",   "rOut:pos"],
        ["ctr:ovf",   "rOvf:pos"],
        ["rOut:neg",  "gnd:out"],
        ["rOvf:neg",  "gnd:out"],
        ["vsEN:neg",  "gnd:out"],
        ["vsCLK:neg", "gnd:out"],
        ["vsCLR:neg", "gnd:out"],
      ],
    });
    circuit.metadata.digitalPinLoadingOverrides = [
      { anchor: { type: "pin", instanceId: "ctr", pinLabel: "en" },  loading: "loaded" },
      { anchor: { type: "pin", instanceId: "ctr", pinLabel: "C" },   loading: "ideal" },
      { anchor: { type: "pin", instanceId: "ctr", pinLabel: "clr" }, loading: "ideal" },
    ];

    const coordinator = facade.compile(circuit);
    coordinator.dcOperatingPoint();
    const signals = facade.readAllSignals(coordinator);

    // en is the loaded boundary: read the analog net (rEN:neg), not the digital
    // pin signal. 5·1e7/(10kΩ+1e7) = 4.995004995…V.
    const vEN = signals["rEN:neg"] as number;
    expect(vEN).toBeCloseTo(4.995004995004995, 6);

    // C and clr are ideal + stiff-driven → full 5 V, no sag.
    expect(signals["vsCLK:pos"] as number).toBeCloseTo(5.0, 6);
    expect(signals["vsCLR:pos"] as number).toBeCloseTo(5.0, 6);

    coordinator.dispose();
  });
});
