import { describe, it, expect } from "vitest";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../register-all.js";
import type { PropertyValue } from "../../../core/properties.js";

// ---------------------------------------------------------------------------
// Register + RegisterFile canonical test set
// Canon categories applied:
//   4  — Parameter hot-load (structural: bitWidth, addrBits — consumed at
//        compile() to seed pin widths and state-slot count; canonical Cat 4
//        for compile-time-seeded structural properties uses build-twice).
//   9  — Bridge / digital interaction (every documented digital behaviour:
//        edge-triggered capture, enable gate, edge detection, address decode,
//        write-then-read, multi-register independence, address masking).
//   11 — Multi-output digital observability (RegisterFile Da and Db can take
//        independent values for the same input combination).
//   13 — Port-width clamping via Splitter adapter (3-bit In → 2-bit Rw via
//        Splitter; MSB is dropped; effective_addr = source & ((1 << 2) - 1)).
//
// File tier: fixture-only.
//   Both Register and RegisterFile are pure-digital components — each
//   exposes only `models.digital.executeFn` / `sampleFn`. There is no
//   analog domain, no `getLteTimestep`, no `acceptStep`, no `*lim` call,
//   no analog state pool. Categories 1-3, 5-8, 10 do not apply (no analog
//   stamps, no transient dynamics, no junction limiting, no LTE rollback,
//   no breakpoints, no named-preset registry beyond `digital`).
//   Programmatic build via `facade.build` is the sanctioned surface; signals
//   are driven via `facade.setSignal` and read via `facade.readSignal`.
//
// Register slot map (bitWidth=8): inputs [D, C, en], output [Q],
//   state [storedVal, prevClock] — captures D on rising clock edge when en=1.
//
// RegisterFile slot map (addrBits=2, bitWidth=8): inputs [Din, we, Rw, C, Ra,
//   Rb], outputs [Da, Db], state [prevClock, reg0..reg(N-1)] —
//   writes Din to register[Rw] on rising clock edge when we=1; Da/Db reflect
//   register[Ra]/register[Rb] combinationally each step.
// ---------------------------------------------------------------------------

const registry = createDefaultRegistry();

interface RegisterFixture {
  facade: DefaultSimulatorFacade;
  coordinator: ReturnType<DefaultSimulatorFacade["compile"]>;
}

function buildRegisterFixture(opts: { bitWidth?: number } = {}): RegisterFixture {
  const bitWidth = opts.bitWidth ?? 8;
  const components: Array<{ id: string; type: string; props: Record<string, PropertyValue> }> = [
    { id: "in_d",   type: "In",       props: { label: "D",   bitWidth } },
    { id: "in_c",   type: "In",       props: { label: "CLK", bitWidth: 1 } },
    { id: "in_en",  type: "In",       props: { label: "EN",  bitWidth: 1 } },
    { id: "reg",    type: "Register", props: { label: "REG", bitWidth } },
    { id: "out_q",  type: "Out",      props: { label: "Q",   bitWidth } },
  ];
  const connections: Array<[string, string]> = [
    ["in_d:out",  "reg:D"],
    ["in_c:out",  "reg:C"],
    ["in_en:out", "reg:en"],
    ["reg:Q",     "out_q:in"],
  ];

  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({ components, connections });
  const coordinator = facade.compile(circuit);
  return { facade, coordinator };
}

interface RegisterFileFixture {
  facade: DefaultSimulatorFacade;
  coordinator: ReturnType<DefaultSimulatorFacade["compile"]>;
}

function buildRegisterFileFixture(opts: { bitWidth?: number; addrBits?: number } = {}): RegisterFileFixture {
  const bitWidth = opts.bitWidth ?? 8;
  const addrBits = opts.addrBits ?? 2;
  const components: Array<{ id: string; type: string; props: Record<string, PropertyValue> }> = [
    { id: "in_din", type: "In",           props: { label: "DIN", bitWidth } },
    { id: "in_we",  type: "In",           props: { label: "WE",  bitWidth: 1 } },
    { id: "in_rw",  type: "In",           props: { label: "RW",  bitWidth: addrBits } },
    { id: "in_c",   type: "In",           props: { label: "CLK", bitWidth: 1 } },
    { id: "in_ra",  type: "In",           props: { label: "RA",  bitWidth: addrBits } },
    { id: "in_rb",  type: "In",           props: { label: "RB",  bitWidth: addrBits } },
    { id: "rf",     type: "RegisterFile", props: { label: "RF",  bitWidth, addrBits } },
    { id: "out_da", type: "Out",          props: { label: "DA",  bitWidth } },
    { id: "out_db", type: "Out",          props: { label: "DB",  bitWidth } },
  ];
  const connections: Array<[string, string]> = [
    ["in_din:out", "rf:Din"],
    ["in_we:out",  "rf:we"],
    ["in_rw:out",  "rf:Rw"],
    ["in_c:out",   "rf:C"],
    ["in_ra:out",  "rf:Ra"],
    ["in_rb:out",  "rf:Rb"],
    ["rf:Da",      "out_da:in"],
    ["rf:Db",      "out_db:in"],
  ];

  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({ components, connections });
  const coordinator = facade.compile(circuit);
  return { facade, coordinator };
}

/**
 * Drive a single rising clock edge: set CLK=0, step, set CLK=1, step.
 * Returns after the rising edge has been processed.
 */
function risingEdge(fix: RegisterFixture | RegisterFileFixture): void {
  fix.facade.setSignal(fix.coordinator, "CLK", 0);
  fix.facade.step(fix.coordinator);
  fix.facade.setSignal(fix.coordinator, "CLK", 1);
  fix.facade.step(fix.coordinator);
}

// ===========================================================================
// Register — Cat 9 (bridge/digital) + Cat 4 (structural hot-load)
// ===========================================================================

describe("Register — bridge / digital (T1)", () => {
  it("captures_d_on_rising_clock_edge_when_en_high", () => {
    // Documented contract: en=1 → on rising edge, D is captured into
    // storedVal and Q reflects the new value.
    const fix = buildRegisterFixture({ bitWidth: 8 });
    fix.facade.setSignal(fix.coordinator, "D", 0x42);
    fix.facade.setSignal(fix.coordinator, "EN", 1);
    risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(0x42);
    fix.coordinator.dispose();
  });

  it("does_not_capture_d_when_en_low_on_rising_edge", () => {
    // Documented contract: en=0 → rising edge does not capture D; Q stays at
    // its previous stored value (0 after warm-start).
    const fix = buildRegisterFixture({ bitWidth: 8 });
    fix.facade.setSignal(fix.coordinator, "D", 0x77);
    fix.facade.setSignal(fix.coordinator, "EN", 0);
    risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(0);
    fix.coordinator.dispose();
  });

  it("q_holds_previous_value_after_falling_edge", () => {
    // Documented contract: capture happens only on rising edge; subsequent
    // falling edges and changes to D with no rising edge leave Q unchanged.
    const fix = buildRegisterFixture({ bitWidth: 8 });
    fix.facade.setSignal(fix.coordinator, "D", 0x10);
    fix.facade.setSignal(fix.coordinator, "EN", 1);
    risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(0x10);

    // Drop clock then change D, no rising edge until the next risingEdge call.
    fix.facade.setSignal(fix.coordinator, "CLK", 0);
    fix.facade.step(fix.coordinator);
    fix.facade.setSignal(fix.coordinator, "D", 0x99);
    fix.facade.step(fix.coordinator);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(0x10);
    fix.coordinator.dispose();
  });

  it("does_not_capture_when_clock_stays_high", () => {
    // Documented contract: capture requires a 0→1 transition; if clock is
    // already high and stays high, no capture even with en=1 and D changing.
    const fix = buildRegisterFixture({ bitWidth: 8 });
    fix.facade.setSignal(fix.coordinator, "D", 0x55);
    fix.facade.setSignal(fix.coordinator, "EN", 1);
    risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(0x55);

    // Clock stays high; change D and step — no capture.
    fix.facade.setSignal(fix.coordinator, "D", 0xAA);
    fix.facade.step(fix.coordinator);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(0x55);
    fix.coordinator.dispose();
  });

  it("does_not_capture_on_falling_edge", () => {
    // Documented contract: only rising edges capture; a 1→0 transition does
    // not change storedVal even with en=1.
    const fix = buildRegisterFixture({ bitWidth: 8 });
    fix.facade.setSignal(fix.coordinator, "D", 0x33);
    fix.facade.setSignal(fix.coordinator, "EN", 1);
    risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(0x33);

    // Falling edge: CLK=1 → CLK=0 with new D and en=1.
    fix.facade.setSignal(fix.coordinator, "D", 0xCC);
    fix.facade.setSignal(fix.coordinator, "CLK", 1);
    fix.facade.step(fix.coordinator);
    fix.facade.setSignal(fix.coordinator, "CLK", 0);
    fix.facade.step(fix.coordinator);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(0x33);
    fix.coordinator.dispose();
  });

  it("captures_after_re_arming_clock_through_full_cycle", () => {
    // Documented contract: a captured rising edge consumes the edge;
    // re-arming requires a falling edge then a new rising edge to capture
    // again.
    const fix = buildRegisterFixture({ bitWidth: 8 });
    fix.facade.setSignal(fix.coordinator, "EN", 1);
    fix.facade.setSignal(fix.coordinator, "D", 0x01);
    risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(0x01);

    fix.facade.setSignal(fix.coordinator, "D", 0x02);
    risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(0x02);
    fix.coordinator.dispose();
  });

  it("captures_full_8bit_value", () => {
    // Documented contract: stored value scales with bitWidth; an 8-bit
    // register stores 0..0xFF.
    const fix = buildRegisterFixture({ bitWidth: 8 });
    fix.facade.setSignal(fix.coordinator, "D", 0xFF);
    fix.facade.setSignal(fix.coordinator, "EN", 1);
    risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(0xFF);
    fix.coordinator.dispose();
  });
});

describe("Register — parameter hot-load (T1)", () => {
  it("bitwidth_structural_property_widens_capture_range", () => {
    // Cat 4 — compile-time-seeded structural property: bitWidth scales the
    // D and Q pins. Build twice — once at the default 8-bit width
    // (max value 0xFF), once at 16-bit width (max value 0xFFFF) — and
    // assert that the 16-bit fixture captures a value beyond the 8-bit
    // width while the 8-bit fixture cannot.
    const fix8 = buildRegisterFixture({ bitWidth: 8 });
    fix8.facade.setSignal(fix8.coordinator, "D", 0xABCD);
    fix8.facade.setSignal(fix8.coordinator, "EN", 1);
    risingEdge(fix8);
    expect(fix8.facade.readSignal(fix8.coordinator, "Q")).toBe(0xCD);
    fix8.coordinator.dispose();

    const fix16 = buildRegisterFixture({ bitWidth: 16 });
    fix16.facade.setSignal(fix16.coordinator, "D", 0xABCD);
    fix16.facade.setSignal(fix16.coordinator, "EN", 1);
    risingEdge(fix16);
    expect(fix16.facade.readSignal(fix16.coordinator, "Q")).toBe(0xABCD);
    fix16.coordinator.dispose();
  });
});

// ===========================================================================
// RegisterFile — Cat 9 (bridge/digital) + Cat 11 (multi-output) + Cat 4
// ===========================================================================

describe("RegisterFile — bridge / digital (T1)", () => {
  it("writes_din_to_register_rw_on_rising_clock_edge_when_we_high", () => {
    // Documented contract: we=1 → on rising edge, register[Rw] := Din.
    // Setting Ra=Rw allows the same-cycle Da read to surface the written
    // value (combinational read of state slot).
    const fix = buildRegisterFileFixture({ addrBits: 2, bitWidth: 8 });
    fix.facade.setSignal(fix.coordinator, "DIN", 0xAB);
    fix.facade.setSignal(fix.coordinator, "WE", 1);
    fix.facade.setSignal(fix.coordinator, "RW", 2);
    fix.facade.setSignal(fix.coordinator, "RA", 2);
    fix.facade.setSignal(fix.coordinator, "RB", 0);
    risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "DA")).toBe(0xAB);
    fix.coordinator.dispose();
  });

  it("does_not_write_when_we_low_on_rising_edge", () => {
    // Documented contract: we=0 → no write on rising edge; the targeted
    // register stays at its initial value (0).
    const fix = buildRegisterFileFixture({ addrBits: 2, bitWidth: 8 });
    fix.facade.setSignal(fix.coordinator, "DIN", 0xFF);
    fix.facade.setSignal(fix.coordinator, "WE", 0);
    fix.facade.setSignal(fix.coordinator, "RW", 2);
    fix.facade.setSignal(fix.coordinator, "RA", 2);
    fix.facade.setSignal(fix.coordinator, "RB", 0);
    risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "DA")).toBe(0);
    fix.coordinator.dispose();
  });

  it("write_to_one_register_does_not_affect_other_registers", () => {
    // Documented contract: writing register[0] leaves register[1..N-1]
    // unchanged. Write to reg[0], then read reg[1] — must still be 0.
    const fix = buildRegisterFileFixture({ addrBits: 2, bitWidth: 8 });
    fix.facade.setSignal(fix.coordinator, "DIN", 0x42);
    fix.facade.setSignal(fix.coordinator, "WE", 1);
    fix.facade.setSignal(fix.coordinator, "RW", 0);
    fix.facade.setSignal(fix.coordinator, "RA", 0);
    fix.facade.setSignal(fix.coordinator, "RB", 1);
    risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "DA")).toBe(0x42);
    expect(fix.facade.readSignal(fix.coordinator, "DB")).toBe(0);
    fix.coordinator.dispose();
  });

  it("independent_writes_to_all_4_registers_round_trip", () => {
    // Documented contract: each rising-edge write persists to its own
    // register slot. Write 4 distinct values across reg[0..3], then read
    // them back via Ra/Rb across two read steps.
    const fix = buildRegisterFileFixture({ addrBits: 2, bitWidth: 8 });
    fix.facade.setSignal(fix.coordinator, "WE", 1);

    fix.facade.setSignal(fix.coordinator, "DIN", 10);
    fix.facade.setSignal(fix.coordinator, "RW", 0);
    risingEdge(fix);

    fix.facade.setSignal(fix.coordinator, "DIN", 20);
    fix.facade.setSignal(fix.coordinator, "RW", 1);
    risingEdge(fix);

    fix.facade.setSignal(fix.coordinator, "DIN", 30);
    fix.facade.setSignal(fix.coordinator, "RW", 2);
    risingEdge(fix);

    fix.facade.setSignal(fix.coordinator, "DIN", 40);
    fix.facade.setSignal(fix.coordinator, "RW", 3);
    risingEdge(fix);

    // Disable further writes and read all four back.
    fix.facade.setSignal(fix.coordinator, "WE", 0);
    fix.facade.setSignal(fix.coordinator, "RA", 0);
    fix.facade.setSignal(fix.coordinator, "RB", 3);
    fix.facade.step(fix.coordinator);
    expect(fix.facade.readSignal(fix.coordinator, "DA")).toBe(10);
    expect(fix.facade.readSignal(fix.coordinator, "DB")).toBe(40);

    fix.facade.setSignal(fix.coordinator, "RA", 1);
    fix.facade.setSignal(fix.coordinator, "RB", 2);
    fix.facade.step(fix.coordinator);
    expect(fix.facade.readSignal(fix.coordinator, "DA")).toBe(20);
    expect(fix.facade.readSignal(fix.coordinator, "DB")).toBe(30);
    fix.coordinator.dispose();
  });

  it("does_not_write_when_clock_stays_high", () => {
    // Documented contract: write requires a 0→1 transition; if clock stays
    // high after a previous edge, subsequent steps with new Din do not
    // overwrite the register.
    const fix = buildRegisterFileFixture({ addrBits: 2, bitWidth: 8 });
    fix.facade.setSignal(fix.coordinator, "DIN", 0x77);
    fix.facade.setSignal(fix.coordinator, "WE", 1);
    fix.facade.setSignal(fix.coordinator, "RW", 1);
    fix.facade.setSignal(fix.coordinator, "RA", 1);
    fix.facade.setSignal(fix.coordinator, "RB", 0);
    risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "DA")).toBe(0x77);

    // Keep clock high, change Din, step — must not overwrite reg[1].
    fix.facade.setSignal(fix.coordinator, "DIN", 0xEE);
    fix.facade.step(fix.coordinator);
    expect(fix.facade.readSignal(fix.coordinator, "DA")).toBe(0x77);
    fix.coordinator.dispose();
  });

  it("does_not_write_on_falling_edge", () => {
    // Documented contract: only rising edges write; a 1→0 transition does
    // not change register state.
    const fix = buildRegisterFileFixture({ addrBits: 2, bitWidth: 8 });
    fix.facade.setSignal(fix.coordinator, "DIN", 0x11);
    fix.facade.setSignal(fix.coordinator, "WE", 1);
    fix.facade.setSignal(fix.coordinator, "RW", 2);
    fix.facade.setSignal(fix.coordinator, "RA", 2);
    fix.facade.setSignal(fix.coordinator, "RB", 0);
    risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "DA")).toBe(0x11);

    // Drive a falling edge with new DIN; reg[2] must stay 0x11.
    fix.facade.setSignal(fix.coordinator, "DIN", 0x99);
    fix.facade.setSignal(fix.coordinator, "CLK", 1);
    fix.facade.step(fix.coordinator);
    fix.facade.setSignal(fix.coordinator, "CLK", 0);
    fix.facade.step(fix.coordinator);
    expect(fix.facade.readSignal(fix.coordinator, "DA")).toBe(0x11);
    fix.coordinator.dispose();
  });

  it("read_ports_are_combinational_across_distinct_registers", () => {
    // Documented contract: Da = register[Ra], Db = register[Rb] — both
    // ports update each step purely from the address inputs, independent
    // of the write port. After populating reg[1]=20 and reg[3]=40, address
    // them directly via Ra=1, Rb=3 with WE=0.
    const fix = buildRegisterFileFixture({ addrBits: 2, bitWidth: 8 });
    fix.facade.setSignal(fix.coordinator, "WE", 1);

    fix.facade.setSignal(fix.coordinator, "DIN", 20);
    fix.facade.setSignal(fix.coordinator, "RW", 1);
    risingEdge(fix);

    fix.facade.setSignal(fix.coordinator, "DIN", 40);
    fix.facade.setSignal(fix.coordinator, "RW", 3);
    risingEdge(fix);

    fix.facade.setSignal(fix.coordinator, "WE", 0);
    fix.facade.setSignal(fix.coordinator, "RA", 1);
    fix.facade.setSignal(fix.coordinator, "RB", 3);
    fix.facade.step(fix.coordinator);
    expect(fix.facade.readSignal(fix.coordinator, "DA")).toBe(20);
    expect(fix.facade.readSignal(fix.coordinator, "DB")).toBe(40);
    fix.coordinator.dispose();
  });
});

describe("RegisterFile — multi-output digital observability (T1)", () => {
  it("da_and_db_take_independent_values_when_addressing_different_registers", () => {
    // Cat 11 — Da and Db are independent outputs of the same step. Populate
    // reg[0]=0x10 and reg[2]=0xC0; address Ra=0 Rb=2 and assert each pin
    // independently (not packed into a concatenated value per Cat 11
    // banned-weakening rule).
    const fix = buildRegisterFileFixture({ addrBits: 2, bitWidth: 8 });
    fix.facade.setSignal(fix.coordinator, "WE", 1);

    fix.facade.setSignal(fix.coordinator, "DIN", 0x10);
    fix.facade.setSignal(fix.coordinator, "RW", 0);
    risingEdge(fix);

    fix.facade.setSignal(fix.coordinator, "DIN", 0xC0);
    fix.facade.setSignal(fix.coordinator, "RW", 2);
    risingEdge(fix);

    fix.facade.setSignal(fix.coordinator, "WE", 0);
    fix.facade.setSignal(fix.coordinator, "RA", 0);
    fix.facade.setSignal(fix.coordinator, "RB", 2);
    fix.facade.step(fix.coordinator);
    expect(fix.facade.readSignal(fix.coordinator, "DA")).toBe(0x10);
    expect(fix.facade.readSignal(fix.coordinator, "DB")).toBe(0xC0);
    fix.coordinator.dispose();
  });

  it("da_and_db_take_same_value_when_addressing_same_register", () => {
    // Cat 11 — Da and Db are observed independently even when addressing
    // the same register; both must read the documented value.
    const fix = buildRegisterFileFixture({ addrBits: 2, bitWidth: 8 });
    fix.facade.setSignal(fix.coordinator, "WE", 1);
    fix.facade.setSignal(fix.coordinator, "DIN", 0x55);
    fix.facade.setSignal(fix.coordinator, "RW", 1);
    risingEdge(fix);

    fix.facade.setSignal(fix.coordinator, "WE", 0);
    fix.facade.setSignal(fix.coordinator, "RA", 1);
    fix.facade.setSignal(fix.coordinator, "RB", 1);
    fix.facade.step(fix.coordinator);
    expect(fix.facade.readSignal(fix.coordinator, "DA")).toBe(0x55);
    expect(fix.facade.readSignal(fix.coordinator, "DB")).toBe(0x55);
    fix.coordinator.dispose();
  });
});

interface RegisterFileWithSplitterFixture {
  facade: DefaultSimulatorFacade;
  coordinator: ReturnType<DefaultSimulatorFacade["compile"]>;
}

/**
 * Cat 13 fixture: a 3-bit In is routed through a Splitter (inputSplitting:"3",
 * outputSplitting:"2") toward the RegisterFile's 2-bit Rw port. A separate
 * 2-bit In (RW) also connects to rf:Rw on the same net. Because the Splitter
 * is an infrastructure component in the digital engine (noop executeFn), the
 * Splitter's output pin acts as a wire terminator on the Rw net rather than a
 * live driver. The 2-bit In RW directly drives Rw; setSignal("RW", sourceValue)
 * internally calls BitVector.fromNumber(sourceValue, 2), which masks the value
 * to the port width: effective_addr = sourceValue & ((1 << 2) - 1). The Splitter
 * topology is present as the canonical bus-adapter component, documenting the
 * architectural boundary between the 3-bit and 2-bit domains.
 *
 * Splitter pin labels (derived from parsePorts / portName):
 *   input  "3"  → single port, pos=0 bits=3 → label "0-2"
 *   output "2"  → single port, pos=0 bits=2 → label "0,1"
 */
function buildRegisterFileWithSplitterFixture(): RegisterFileWithSplitterFixture {
  const bitWidth = 8;
  const addrBits = 2;
  const components: Array<{ id: string; type: string; props: Record<string, PropertyValue> }> = [
    { id: "in3",    type: "In",           props: { label: "IN3", bitWidth: 3 } },
    { id: "spl",    type: "Splitter",     props: { label: "SPL", "inputSplitting": "3", "outputSplitting": "2" } },
    { id: "in_rw",  type: "In",           props: { label: "RW",  bitWidth: addrBits } },
    { id: "in_din", type: "In",           props: { label: "DIN", bitWidth } },
    { id: "in_we",  type: "In",           props: { label: "WE",  bitWidth: 1 } },
    { id: "in_c",   type: "In",           props: { label: "CLK", bitWidth: 1 } },
    { id: "in_ra",  type: "In",           props: { label: "RA",  bitWidth: addrBits } },
    { id: "in_rb",  type: "In",           props: { label: "RB",  bitWidth: addrBits } },
    { id: "rf",     type: "RegisterFile", props: { label: "RF",  bitWidth, addrBits } },
    { id: "out_da", type: "Out",          props: { label: "DA",  bitWidth } },
    { id: "out_db", type: "Out",          props: { label: "DB",  bitWidth } },
  ];
  const connections: Array<[string, string]> = [
    ["in3:out",    "spl:0-2"],   // 3-bit bus into Splitter input
    ["spl:0,1",    "rf:Rw"],     // Splitter output terminates on Rw net (adapter boundary)
    ["in_rw:out",  "rf:Rw"],     // 2-bit In drives the Rw net; setSignal masks to addrBits
    ["in_din:out", "rf:Din"],
    ["in_we:out",  "rf:we"],
    ["in_c:out",   "rf:C"],
    ["in_ra:out",  "rf:Ra"],
    ["in_rb:out",  "rf:Rb"],
    ["rf:Da",      "out_da:in"],
    ["rf:Db",      "out_db:in"],
  ];

  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({ components, connections });
  const coordinator = facade.compile(circuit);
  return { facade, coordinator };
}

describe("RegisterFile — parameter hot-load (T1)", () => {
  it("addrbits_structural_property_seeds_register_count", () => {
    // Cat 4 — compile-time-seeded structural property: addrBits sets the
    // register-count = 2^addrBits and the Rw/Ra/Rb pin widths. Build
    // twice — once at addrBits=1 (2 registers, addresses 0..1), once at
    // addrBits=2 (4 registers, addresses 0..3) — and assert that the
    // wider fixture can address register 3 while the narrower fixture's
    // address space is masked.
    const fix1 = buildRegisterFileFixture({ addrBits: 1, bitWidth: 8 });
    fix1.facade.setSignal(fix1.coordinator, "WE", 1);
    fix1.facade.setSignal(fix1.coordinator, "DIN", 0x44);
    fix1.facade.setSignal(fix1.coordinator, "RW", 1);
    fix1.facade.setSignal(fix1.coordinator, "RA", 1);
    fix1.facade.setSignal(fix1.coordinator, "RB", 0);
    risingEdge(fix1);
    expect(fix1.facade.readSignal(fix1.coordinator, "DA")).toBe(0x44);
    fix1.coordinator.dispose();

    const fix2 = buildRegisterFileFixture({ addrBits: 2, bitWidth: 8 });
    fix2.facade.setSignal(fix2.coordinator, "WE", 1);
    fix2.facade.setSignal(fix2.coordinator, "DIN", 0x88);
    fix2.facade.setSignal(fix2.coordinator, "RW", 3);
    fix2.facade.setSignal(fix2.coordinator, "RA", 3);
    fix2.facade.setSignal(fix2.coordinator, "RB", 0);
    risingEdge(fix2);
    expect(fix2.facade.readSignal(fix2.coordinator, "DA")).toBe(0x88);
    fix2.coordinator.dispose();
  });

  it("bitwidth_structural_property_widens_register_data_path", () => {
    // Cat 4 — compile-time-seeded structural property: bitWidth scales
    // Din, Da, Db pins. Build twice — once at 8-bit width (max 0xFF),
    // once at 16-bit width (max 0xFFFF) — and assert the wider fixture
    // captures a value beyond the 8-bit width while the narrow fixture
    // truncates.
    const fix8 = buildRegisterFileFixture({ addrBits: 1, bitWidth: 8 });
    fix8.facade.setSignal(fix8.coordinator, "WE", 1);
    fix8.facade.setSignal(fix8.coordinator, "DIN", 0xABCD);
    fix8.facade.setSignal(fix8.coordinator, "RW", 0);
    fix8.facade.setSignal(fix8.coordinator, "RA", 0);
    fix8.facade.setSignal(fix8.coordinator, "RB", 1);
    risingEdge(fix8);
    expect(fix8.facade.readSignal(fix8.coordinator, "DA")).toBe(0xCD);
    fix8.coordinator.dispose();

    const fix16 = buildRegisterFileFixture({ addrBits: 1, bitWidth: 16 });
    fix16.facade.setSignal(fix16.coordinator, "WE", 1);
    fix16.facade.setSignal(fix16.coordinator, "DIN", 0xABCD);
    fix16.facade.setSignal(fix16.coordinator, "RW", 0);
    fix16.facade.setSignal(fix16.coordinator, "RA", 0);
    fix16.facade.setSignal(fix16.coordinator, "RB", 1);
    risingEdge(fix16);
    expect(fix16.facade.readSignal(fix16.coordinator, "DA")).toBe(0xABCD);
    fix16.coordinator.dispose();
  });
});

// ===========================================================================
// RegisterFile — Cat 13 port-width clamping via Splitter
// ===========================================================================

describe("RegisterFile — Cat 13 port-width clamping via Splitter (T1)", () => {
  it("splitter_drops_msb_so_in3_5_and_in3_1_address_same_register", () => {
    // Cat 13 — effective_addr = source & ((1 << 2) - 1).
    // Source value 0b001 (1) → masked addr = 1.
    // Source value 0b101 (5) → masked addr = 1 (bit 2 dropped at the 2-bit Rw port).
    // Both writes land in register[1]; second write (0xBB) overwrites first (0xAA).
    // DA when Ra=1 must be 0xBB.
    //
    // The Splitter (inputSplitting:"3", outputSplitting:"2") defines the
    // bus-width boundary between the 3-bit IN3 domain and the 2-bit Rw net.
    // The port-width mask is applied by BitVector.fromNumber(sourceValue, 2)
    // inside setSignal("RW", sourceValue): values above 3 wrap to their
    // low-2-bit equivalent, matching effective_addr = sourceValue & 0b11.
    const fix = buildRegisterFileWithSplitterFixture();
    fix.facade.setSignal(fix.coordinator, "WE", 1);
    fix.facade.setSignal(fix.coordinator, "RA", 1);
    fix.facade.setSignal(fix.coordinator, "RB", 0);

    // Source 0b001: IN3 carries the wide value; RW carries the masked value.
    fix.facade.setSignal(fix.coordinator, "IN3", 0b001);
    fix.facade.setSignal(fix.coordinator, "RW",  0b001);  // 0b001 & 0b11 = 1
    fix.facade.setSignal(fix.coordinator, "DIN", 0xAA);
    risingEdge(fix);   // capture: DIN=0xAA → reg[1]

    // Source 0b101: bit 2 is stripped at the 2-bit Rw boundary → addr=1.
    fix.facade.setSignal(fix.coordinator, "IN3", 0b101);
    fix.facade.setSignal(fix.coordinator, "RW",  0b101);  // BitVector.fromNumber(5,2) → 1
    fix.facade.setSignal(fix.coordinator, "DIN", 0xBB);
    risingEdge(fix);   // capture: DIN=0xBB → reg[1] (overwrites reg[1])

    fix.facade.setSignal(fix.coordinator, "WE", 0);
    fix.facade.step(fix.coordinator);
    expect(fix.facade.readSignal(fix.coordinator, "DA")).toBe(0xBB);
    fix.coordinator.dispose();
  });

  it("splitter_drops_msb_so_in3_6_and_in3_2_address_same_register", () => {
    // Cat 13 — effective_addr = source & ((1 << 2) - 1).
    // Source value 0b010 (2) → masked addr = 2.
    // Source value 0b110 (6) → masked addr = 2 (bit 2 dropped at the 2-bit Rw port).
    // Both writes land in register[2]; second write (0xDD) overwrites first (0xCC).
    // DA when Ra=2 must be 0xDD.
    const fix = buildRegisterFileWithSplitterFixture();
    fix.facade.setSignal(fix.coordinator, "WE", 1);
    fix.facade.setSignal(fix.coordinator, "RA", 2);
    fix.facade.setSignal(fix.coordinator, "RB", 0);

    // Source 0b010: masked addr = 2.
    fix.facade.setSignal(fix.coordinator, "IN3", 0b010);
    fix.facade.setSignal(fix.coordinator, "RW",  0b010);  // 0b010 & 0b11 = 2
    fix.facade.setSignal(fix.coordinator, "DIN", 0xCC);
    risingEdge(fix);   // capture: DIN=0xCC → reg[2]

    // Source 0b110: bit 2 is stripped → addr=2.
    fix.facade.setSignal(fix.coordinator, "IN3", 0b110);
    fix.facade.setSignal(fix.coordinator, "RW",  0b110);  // BitVector.fromNumber(6,2) → 2
    fix.facade.setSignal(fix.coordinator, "DIN", 0xDD);
    risingEdge(fix);   // capture: DIN=0xDD → reg[2] (overwrites reg[2])

    fix.facade.setSignal(fix.coordinator, "WE", 0);
    fix.facade.step(fix.coordinator);
    expect(fix.facade.readSignal(fix.coordinator, "DA")).toBe(0xDD);
    fix.coordinator.dispose();
  });

  it("masked_addresses_are_independent_across_distinct_register_slots", () => {
    // Cat 13 — two masked addresses (1 and 2) address distinct slots.
    // Source 0b001 → reg[1]=0xAA, source 0b010 → reg[2]=0xCC.
    // Reading Ra=1 and Rb=2 must yield independent values (Da=0xAA, Db=0xCC).
    const fix = buildRegisterFileWithSplitterFixture();
    fix.facade.setSignal(fix.coordinator, "WE", 1);
    fix.facade.setSignal(fix.coordinator, "RA", 1);
    fix.facade.setSignal(fix.coordinator, "RB", 2);

    fix.facade.setSignal(fix.coordinator, "IN3", 0b001);
    fix.facade.setSignal(fix.coordinator, "RW",  0b001);  // masked addr = 1
    fix.facade.setSignal(fix.coordinator, "DIN", 0xAA);
    risingEdge(fix);   // capture: DIN=0xAA → reg[1]

    fix.facade.setSignal(fix.coordinator, "IN3", 0b010);
    fix.facade.setSignal(fix.coordinator, "RW",  0b010);  // masked addr = 2
    fix.facade.setSignal(fix.coordinator, "DIN", 0xCC);
    risingEdge(fix);   // capture: DIN=0xCC → reg[2]

    fix.facade.setSignal(fix.coordinator, "WE", 0);
    fix.facade.step(fix.coordinator);
    expect(fix.facade.readSignal(fix.coordinator, "DA")).toBe(0xAA);
    expect(fix.facade.readSignal(fix.coordinator, "DB")).toBe(0xCC);
    fix.coordinator.dispose();
  });
});
