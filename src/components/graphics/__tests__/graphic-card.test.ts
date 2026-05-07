import { describe, it, expect } from "vitest";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../../components/register-all.js";
import type { SimulationCoordinator } from "../../../solver/coordinator-types.js";

// ---------------------------------------------------------------------------
// GraphicCard canonical test set
// Canon categories: 4 (Parameter hot-load), 9 (Bridge / digital interaction)
// File tier: fixture-only (digital-only — `models.digital` only, no analog
// domain). buildFixture rejects digital-only circuits, so the canonical T1
// surface is the facade's digital signal API: facade.build / facade.compile /
// facade.setSignal / facade.step / facade.readSignal — thin wrappers over
// coordinator.writeSignal / coordinator.step() / coordinator.readSignal.
//
// The D output pin packs the inputs into a single observable per the
// executeFn pack expression:
//   D = ((A & 0xFFFF) << 0) | (str << 16) | (clk << 17) | (ld << 18) | (bank << 19)
// i.e. each input is observable as a distinct bit field on D.
// ---------------------------------------------------------------------------

const registry = createDefaultRegistry();

interface DigitalFixture {
  facade: DefaultSimulatorFacade;
  coordinator: SimulationCoordinator;
}

function computeAddrBits(memSize: number): number {
  let bits = 1;
  while ((1 << bits) < memSize) bits++;
  return bits;
}

function buildGraphicCardFixture(opts: {
  dataBits?: number;
  graphicWidth?: number;
  graphicHeight?: number;
}): DigitalFixture {
  const dataBits = opts.dataBits ?? 24;
  const graphicWidth = opts.graphicWidth ?? 8;
  const graphicHeight = opts.graphicHeight ?? 4;
  const addrBits = computeAddrBits(graphicWidth * graphicHeight * 2);

  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({
    components: [
      { id: "a",   type: "In",  props: { label: "A",   bitWidth: addrBits } },
      { id: "str", type: "In",  props: { label: "STR", bitWidth: 1 } },
      { id: "c",   type: "In",  props: { label: "C",   bitWidth: 1 } },
      { id: "ld",  type: "In",  props: { label: "LD",  bitWidth: 1 } },
      { id: "b",   type: "In",  props: { label: "B",   bitWidth: 1 } },
      {
        id: "gc",
        type: "GraphicCard",
        props: { label: "gc", dataBits, graphicWidth, graphicHeight },
      },
      { id: "dout", type: "Out", props: { label: "D", bitWidth: dataBits } },
    ],
    connections: [
      ["a:out",   "gc:A"],
      ["str:out", "gc:str"],
      ["c:out",   "gc:C"],
      ["ld:out",  "gc:ld"],
      ["b:out",   "gc:B"],
      ["gc:D",    "dout:in"],
    ],
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

// Closed-form expected D value from executeGraphicCard's pack expression.
function packedD(addr: number, str: number, clk: number, ld: number, bank: number): number {
  return (
    ((addr & 0xFFFF) << 0) |
    ((str & 1) << 16) |
    ((clk & 1) << 17) |
    ((ld & 1) << 18) |
    ((bank & 1) << 19)
  ) >>> 0;
}

// ===========================================================================
// Cat 9 — Bridge / digital interaction (T1 via DefaultSimulatorFacade)
//
// The D output is the documented packed sentinel. Each it() drives a distinct
// (A, str, C, ld, B) combination and asserts the closed-form expected value
// of D from the executeFn pack expression.
// ===========================================================================

describe("GraphicCard digital interaction (Cat 9)", () => {
  it("all_zero_inputs_produce_d_zero", () => {
    const fix = buildGraphicCardFixture({ graphicWidth: 8, graphicHeight: 4 });
    drive(fix, { A: 0, STR: 0, C: 0, LD: 0, B: 0 });
    expect(read(fix, "D")).toBe(packedD(0, 0, 0, 0, 0));
  });

  it("address_bits_encode_into_d_low_16_bits", () => {
    // graphicWidth=8, graphicHeight=4 -> memSize=64 -> addrBits=6.
    // Drive A=0x35 (53) to exercise multiple low-bit positions.
    const fix = buildGraphicCardFixture({ graphicWidth: 8, graphicHeight: 4 });
    drive(fix, { A: 0x35, STR: 0, C: 0, LD: 0, B: 0 });
    expect(read(fix, "D")).toBe(packedD(0x35, 0, 0, 0, 0));
  });

  it("str_sets_bit_16_of_d", () => {
    const fix = buildGraphicCardFixture({ graphicWidth: 8, graphicHeight: 4 });
    drive(fix, { A: 0, STR: 1, C: 0, LD: 0, B: 0 });
    expect(read(fix, "D")).toBe(packedD(0, 1, 0, 0, 0));
  });

  it("clk_sets_bit_17_of_d", () => {
    const fix = buildGraphicCardFixture({ graphicWidth: 8, graphicHeight: 4 });
    drive(fix, { A: 0, STR: 0, C: 1, LD: 0, B: 0 });
    expect(read(fix, "D")).toBe(packedD(0, 0, 1, 0, 0));
  });

  it("ld_sets_bit_18_of_d", () => {
    const fix = buildGraphicCardFixture({ graphicWidth: 8, graphicHeight: 4 });
    drive(fix, { A: 0, STR: 0, C: 0, LD: 1, B: 0 });
    expect(read(fix, "D")).toBe(packedD(0, 0, 0, 1, 0));
  });

  it("bank_sets_bit_19_of_d", () => {
    const fix = buildGraphicCardFixture({ graphicWidth: 8, graphicHeight: 4 });
    drive(fix, { A: 0, STR: 0, C: 0, LD: 0, B: 1 });
    expect(read(fix, "D")).toBe(packedD(0, 0, 0, 0, 1));
  });

  it("simultaneous_control_bits_compose_into_packed_encoding", () => {
    // A=7, str=1, C=1, LD=1, B=1 — every field set, exercises the full pack.
    const fix = buildGraphicCardFixture({ graphicWidth: 8, graphicHeight: 4 });
    drive(fix, { A: 7, STR: 1, C: 1, LD: 1, B: 1 });
    expect(read(fix, "D")).toBe(packedD(7, 1, 1, 1, 1));
  });

  it("clock_low_high_low_transition_produces_matching_d_sequence", () => {
    // The packed value tracks each step's input combination — the sequence
    // is the canonical Cat 9 observable for clocked components.
    const fix = buildGraphicCardFixture({ graphicWidth: 8, graphicHeight: 4 });
    drive(fix, { A: 3, STR: 1, C: 0, LD: 0, B: 0 });
    expect(read(fix, "D")).toBe(packedD(3, 1, 0, 0, 0));
    drive(fix, { A: 3, STR: 1, C: 1, LD: 0, B: 0 });
    expect(read(fix, "D")).toBe(packedD(3, 1, 1, 0, 0));
    drive(fix, { A: 3, STR: 1, C: 0, LD: 0, B: 0 });
    expect(read(fix, "D")).toBe(packedD(3, 1, 0, 0, 0));
  });

  it("address_only_sweep_yields_distinct_d_values_per_addr", () => {
    // The packed-D sentinel exists for the engine's change-detection hook —
    // distinct A values must produce distinct D values so the engine can tell
    // a memory-address change happened.
    const fix = buildGraphicCardFixture({ graphicWidth: 8, graphicHeight: 4 });
    const observed = new Set<number>();
    for (let a = 0; a < 8; a++) {
      drive(fix, { A: a, STR: 0, C: 0, LD: 0, B: 0 });
      observed.add(read(fix, "D"));
    }
    expect(observed.size).toBe(8);
  });
});

// ===========================================================================
// Cat 4 — Parameter hot-load (T1)
//
// GraphicCard params closed over at construction:
//   - dataBits    -> width of the D output bus
//   - graphicWidth, graphicHeight -> memory size and (via In) addrBits width
//
// Each it() builds two fixtures with different param values and demonstrates
// the documented contract change in the simulator output for the same logical
// inputs. Bit-exact post-change values are derivable closed-form from the
// param's contract (`dataBits` truncates the D bus; addrBits widens the
// observable A range). These properties are closed over at element-construction
// time, so a fresh compile is the documented hot-load mechanic — the same
// pattern arithmetic.test.ts uses for digital-only bitWidth hot-load.
// ===========================================================================

describe("GraphicCard param hot-load (Cat 4)", () => {
  it("dataBits_8_truncates_packed_d_low_byte_dataBits_24_preserves_full", () => {
    // Same logical inputs, different dataBits: low byte of D is identical, but
    // the upper bit fields (str@16, clk@17, ld@18, bank@19) only survive when
    // dataBits is wide enough.
    const fix8 = buildGraphicCardFixture({ dataBits: 8, graphicWidth: 4, graphicHeight: 2 });
    drive(fix8, { A: 5, STR: 1, C: 1, LD: 1, B: 1 });
    const dataBits8Mask = 0xFF;
    const expected8 = packedD(5, 1, 1, 1, 1) & dataBits8Mask;

    const fix24 = buildGraphicCardFixture({ dataBits: 24, graphicWidth: 4, graphicHeight: 2 });
    drive(fix24, { A: 5, STR: 1, C: 1, LD: 1, B: 1 });
    const expected24 = packedD(5, 1, 1, 1, 1);

    expect(read(fix8, "D")).toBe(expected8);
    expect(read(fix24, "D")).toBe(expected24);
    // The narrower-bus result must NOT be equal to the wide-bus result, since
    // the upper control-bit fields are masked away on dataBits=8.
    expect(read(fix8, "D")).not.toBe(read(fix24, "D"));
  });

  it("graphicWidth_4x2_addrBits_4_max_addr_15_vs_8x2_addrBits_5_max_addr_31", () => {
    // The component's addrBits is derived from graphicWidth*graphicHeight*2.
    // The In bus into A is sized to addrBits, so the observable max A
    // through the digital surface scales with the param.
    const fixSmall = buildGraphicCardFixture({ dataBits: 24, graphicWidth: 4, graphicHeight: 2 });
    drive(fixSmall, { A: 15, STR: 0, C: 0, LD: 0, B: 0 });
    const dSmallMax = read(fixSmall, "D");

    const fixWide = buildGraphicCardFixture({ dataBits: 24, graphicWidth: 8, graphicHeight: 2 });
    drive(fixWide, { A: 31, STR: 0, C: 0, LD: 0, B: 0 });
    const dWideMax = read(fixWide, "D");

    // Closed-form: the small fixture's max A is 15 (addrBits=4), the wide
    // fixture's max A is 31 (addrBits=5). The packed D values differ by their
    // address-field contribution alone.
    expect(dSmallMax).toBe(packedD(15, 0, 0, 0, 0));
    expect(dWideMax).toBe(packedD(31, 0, 0, 0, 0));
    expect(dSmallMax).not.toBe(dWideMax);
  });

  it("graphicHeight_change_shifts_addrBits_addr_bus_widens_with_memory_size", () => {
    // graphicWidth=4, graphicHeight=1 -> memSize=8  -> addrBits=3
    // graphicWidth=4, graphicHeight=4 -> memSize=32 -> addrBits=5
    // The In bus sizes track these; A=7 is the max in the short fixture and
    // an interior address in the tall fixture. The packed D for A=7 is the
    // same closed-form value (low 16 bits of 7 = 7), so this case demonstrates
    // a different observable: the In bitWidth on A differs (3 vs 5), which
    // makes the maximum drivable A differ. Driving A=7 saturates the short
    // fixture's bus and is just an interior value on the tall.
    const fixShort = buildGraphicCardFixture({ dataBits: 24, graphicWidth: 4, graphicHeight: 1 });
    drive(fixShort, { A: 7, STR: 0, C: 0, LD: 0, B: 0 });
    const dShortA7 = read(fixShort, "D");

    const fixTall = buildGraphicCardFixture({ dataBits: 24, graphicWidth: 4, graphicHeight: 4 });
    drive(fixTall, { A: 7, STR: 0, C: 0, LD: 0, B: 0 });
    const dTallA7 = read(fixTall, "D");

    // Packed D for A=7 depends only on A; both fixtures yield the same value.
    expect(dShortA7).toBe(packedD(7, 0, 0, 0, 0));
    expect(dTallA7).toBe(packedD(7, 0, 0, 0, 0));

    // Now drive an address only the tall fixture can express (A=20). The short
    // fixture's A bus is 3 bits wide -> A=20 truncates to 4 (20 & 0x7).
    drive(fixShort, { A: 20, STR: 0, C: 0, LD: 0, B: 0 });
    drive(fixTall, { A: 20, STR: 0, C: 0, LD: 0, B: 0 });
    expect(read(fixShort, "D")).toBe(packedD(20 & 0x7, 0, 0, 0, 0));
    expect(read(fixTall, "D")).toBe(packedD(20, 0, 0, 0, 0));
    expect(read(fixShort, "D")).not.toBe(read(fixTall, "D"));
  });
});
