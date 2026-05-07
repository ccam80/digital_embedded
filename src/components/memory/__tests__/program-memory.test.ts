import { describe, it, expect } from "vitest";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../register-all.js";
import type { PropertyValue } from "../../../core/properties.js";
import type { SignalValue } from "../../../compile/types.js";

// ---------------------------------------------------------------------------
// ProgramMemory canonical test set
// Component: ProgramMemory (digital ROM with auto-increment address register)
// Canon set: 9 (Bridge / digital interaction)
// File tier: fixture-only (digital-only — facade.compile + coordinator
// writeByLabel/step/readByLabel; buildFixture requires an analog domain).
//
// Cat 1/2/3/5/6/7/8 do not apply: there is no analog state pool, no MNA
// matrix, no DCOP, no junction limiting, no LTE rollback, no acceptStep
// breakpoint registration, and no analog transient dynamics.
// Cat 4 applies via the compile-time-seeded structural-property variant:
// the `data` PropertyBag entry is consumed at compile() to seed the
// engine-managed DataField backing store. The canonical mechanic builds
// the same circuit twice (default vs `data: [...]`) and asserts the
// post-compile observable on D differs.
// Cat 10 does not apply: modelRegistry has only the single digital model.
// Cat 11 does not apply: the digital outputSchema declares one output (D).
// Cat 12 does not apply: no documented forbidden / undefined input
// combinations for this device.
// Cat 13 does not apply: no narrow input port whose declared bit-width is
// narrower than its driving bus.
// Cat 14 does not apply: production source emits no runtime diagnostics
// keyed on simulation observables.
// Cat 15 does not apply: production source registers no _onStateChange
// writeback subscription.
// ---------------------------------------------------------------------------

const registry = createDefaultRegistry();

function digital(value: number): SignalValue {
  return { type: "digital", value };
}

interface PMemFixture {
  facade: DefaultSimulatorFacade;
  coordinator: ReturnType<DefaultSimulatorFacade["compile"]>;
}

/**
 * Build a circuit with a single ProgramMemory driven by labelled In pins
 * (A, ld, C) and observed via a labelled Out pin (D). The data preload
 * populates the engine-managed backing store at compile time via the
 * digital engine's initializeBackingStores pass.
 */
function buildPMemFixture(opts: {
  data?: number[];
  addrBits?: number;
  dataBits?: number;
}): PMemFixture {
  const addrBits = opts.addrBits ?? 4;
  const dataBits = opts.dataBits ?? 8;
  const pmemProps: Record<string, PropertyValue> = {
    label: "PM",
    addrBits,
    dataBits,
  };
  if (opts.data !== undefined) {
    // `data` is consumed by digital-engine.initializeBackingStores at
    // compile time to seed the DataField backing store.
    pmemProps.data = opts.data;
  }

  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({
    components: [
      { id: "a",   type: "In",  props: { label: "A",  bitWidth: addrBits } },
      { id: "ld",  type: "In",  props: { label: "LD", bitWidth: 1 } },
      { id: "c",   type: "In",  props: { label: "C",  bitWidth: 1 } },
      { id: "pm",  type: "ProgramMemory", props: pmemProps },
      { id: "out", type: "Out", props: { label: "D",  bitWidth: dataBits } },
    ],
    connections: [
      ["a:out",  "pm:A"],
      ["ld:out", "pm:ld"],
      ["c:out",  "pm:C"],
      ["pm:D",   "out:in"],
    ],
  });
  const coordinator = facade.compile(circuit);
  return { facade, coordinator };
}

/**
 * Drive the C input through one full low->high->low cycle so a single
 * rising edge reaches the ProgramMemory. The address register is updated
 * on the 0->1 transition; the trailing 1->0 keeps successive calls of
 * this helper independent (each call delivers exactly one rising edge).
 */
function pulseClock(fix: PMemFixture): void {
  fix.coordinator.writeByLabel("C", digital(0));
  fix.coordinator.step();
  fix.coordinator.writeByLabel("C", digital(1));
  fix.coordinator.step();
  fix.coordinator.writeByLabel("C", digital(0));
  fix.coordinator.step();
}

function readD(fix: PMemFixture): number {
  const v = fix.coordinator.readByLabel("D");
  if (v.type !== "digital") {
    throw new Error(`expected digital read on D, got ${v.type}`);
  }
  return v.value;
}

// ===========================================================================
// Cat 4 — Parameter hot-load (compile-time-seeded structural property)
// ===========================================================================

describe("ProgramMemory — compile-time-seeded data property (T1)", () => {
  it("data_property_seeds_d_at_addr_zero_observable", () => {
    // Documented contract: `data` is consumed at compile() to seed the
    // DataField backing store; D reflects memory[addrReg] with addrReg=0
    // at step 0. Build the same circuit twice — once with data unset,
    // once with data set — and assert the post-compile observable on D
    // differs.
    const fixDefault = buildPMemFixture({ addrBits: 4, dataBits: 8 });
    fixDefault.coordinator.writeByLabel("LD", digital(0));
    fixDefault.coordinator.writeByLabel("C", digital(0));
    fixDefault.coordinator.writeByLabel("A", digital(0));
    fixDefault.coordinator.step();
    expect(readD(fixDefault)).toBe(0);
    fixDefault.coordinator.dispose();

    const fixSeeded = buildPMemFixture({
      data: [0xAA, 0xBB, 0xCC],
      addrBits: 4,
      dataBits: 8,
    });
    fixSeeded.coordinator.writeByLabel("LD", digital(0));
    fixSeeded.coordinator.writeByLabel("C", digital(0));
    fixSeeded.coordinator.writeByLabel("A", digital(0));
    fixSeeded.coordinator.step();
    expect(readD(fixSeeded)).toBe(0xAA);
    fixSeeded.coordinator.dispose();
  });

  it("data_property_seeds_d_at_jumped_address", () => {
    // Documented contract: after a jump (ld=1, A=2) on a rising edge,
    // addrReg=2 and D=memory[2]. Build twice — default vs seeded — and
    // assert the seeded build produces data[2] while the default produces 0.
    const fixDefault = buildPMemFixture({ addrBits: 4, dataBits: 8 });
    fixDefault.coordinator.writeByLabel("A", digital(2));
    fixDefault.coordinator.writeByLabel("LD", digital(1));
    pulseClock(fixDefault);
    expect(readD(fixDefault)).toBe(0);
    fixDefault.coordinator.dispose();

    const fixSeeded = buildPMemFixture({
      data: [0x10, 0x11, 0x12, 0x13, 0x14],
      addrBits: 4,
      dataBits: 8,
    });
    fixSeeded.coordinator.writeByLabel("A", digital(2));
    fixSeeded.coordinator.writeByLabel("LD", digital(1));
    pulseClock(fixSeeded);
    expect(readD(fixSeeded)).toBe(0x12);
    fixSeeded.coordinator.dispose();
  });

  it("data_property_size_smaller_than_address_space_wraps_modulo_data_length", () => {
    // Documented contract: when `data` length is smaller than the
    // 2^addrBits backing-store size, addresses past data.length read 0
    // (backing store zero-init contract). With addrBits=4 (size 16) and
    // data length 4, jumping to A=4 reads the documented value at
    // memory[4] which is 0.
    const fix = buildPMemFixture({
      data: [0xA, 0xB, 0xC, 0xD],
      addrBits: 4,
      dataBits: 8,
    });
    fix.coordinator.writeByLabel("A", digital(4));
    fix.coordinator.writeByLabel("LD", digital(1));
    pulseClock(fix);
    expect(readD(fix)).toBe(0);
    fix.coordinator.dispose();
  });
});

// ===========================================================================
// Cat 9 — Bridge / digital interaction
// ===========================================================================

describe("ProgramMemory — bridge / digital (T1)", () => {
  it("preloaded_data_appears_on_D_at_addrReg_zero_after_compile", () => {
    // Documented contract: D always reflects memory[addrReg]; addrReg starts
    // at 0; preloaded data populates the backing store at compile.
    const fix = buildPMemFixture({
      data: [0xAA, 0xBB, 0xCC, 0xDD],
      addrBits: 4,
      dataBits: 8,
    });
    fix.coordinator.writeByLabel("LD", digital(0));
    fix.coordinator.writeByLabel("C", digital(0));
    fix.coordinator.writeByLabel("A", digital(0));
    fix.coordinator.step();
    expect(readD(fix)).toBe(0xAA);
    fix.coordinator.dispose();
  });

  it("auto_increment_advances_one_word_per_rising_clock_edge", () => {
    // Documented contract: on each rising edge with ld=0, addrReg += 1 and
    // D reflects memory[addrReg].
    const fix = buildPMemFixture({
      data: [10, 20, 30, 40, 50],
      addrBits: 4,
      dataBits: 8,
    });
    fix.coordinator.writeByLabel("LD", digital(0));
    fix.coordinator.writeByLabel("A", digital(0));
    fix.coordinator.writeByLabel("C", digital(0));
    fix.coordinator.step();
    expect(readD(fix)).toBe(10);
    pulseClock(fix);
    expect(readD(fix)).toBe(20);
    pulseClock(fix);
    expect(readD(fix)).toBe(30);
    pulseClock(fix);
    expect(readD(fix)).toBe(40);
    pulseClock(fix);
    expect(readD(fix)).toBe(50);
    fix.coordinator.dispose();
  });

  it("ld_high_loads_external_address_A_into_addrReg_on_rising_clock", () => {
    // Documented contract: with ld=1, the rising edge loads addrReg = A.
    const fix = buildPMemFixture({
      data: [0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19],
      addrBits: 4,
      dataBits: 8,
    });
    fix.coordinator.writeByLabel("A", digital(8));
    fix.coordinator.writeByLabel("LD", digital(1));
    pulseClock(fix);
    expect(readD(fix)).toBe(0x18); // memory[8]
    fix.coordinator.dispose();
  });

  it("jump_then_auto_increment_resumes_from_loaded_address", () => {
    // Documented contract: after a jump (ld=1) sets addrReg, switching back
    // to ld=0 auto-increments from the loaded address.
    const data = Array.from({ length: 16 }, (_, i) => i + 100);
    const fix = buildPMemFixture({ data, addrBits: 4, dataBits: 8 });

    // Jump to address 5.
    fix.coordinator.writeByLabel("A", digital(5));
    fix.coordinator.writeByLabel("LD", digital(1));
    pulseClock(fix);
    expect(readD(fix)).toBe(105);

    // Auto-increment: addrReg 5 -> 6 -> 7.
    fix.coordinator.writeByLabel("LD", digital(0));
    pulseClock(fix);
    expect(readD(fix)).toBe(106);
    pulseClock(fix);
    expect(readD(fix)).toBe(107);
    fix.coordinator.dispose();
  });

  it("falling_edge_does_not_advance_address", () => {
    // Documented contract: only the rising edge increments addrReg.
    const fix = buildPMemFixture({
      data: [0xF0, 0xF1, 0xF2, 0xF3],
      addrBits: 4,
      dataBits: 8,
    });
    fix.coordinator.writeByLabel("LD", digital(0));
    fix.coordinator.writeByLabel("A", digital(0));

    // One rising edge -> addrReg = 1, D = memory[1].
    pulseClock(fix);
    expect(readD(fix)).toBe(0xF1);

    // Falling edge sequence: drop C from 0 to 0 -> 0; no rising edge fires.
    fix.coordinator.writeByLabel("C", digital(0));
    fix.coordinator.step();
    fix.coordinator.step();
    expect(readD(fix)).toBe(0xF1);
    fix.coordinator.dispose();
  });

  it("sustained_high_clock_advances_address_only_on_first_rising_edge", () => {
    // Documented contract: edge-triggered, not level-sensitive — once C is
    // high, holding it high produces no further increments.
    const fix = buildPMemFixture({
      data: [0xA0, 0xA1, 0xA2, 0xA3],
      addrBits: 4,
      dataBits: 8,
    });
    fix.coordinator.writeByLabel("LD", digital(0));
    fix.coordinator.writeByLabel("A", digital(0));
    fix.coordinator.writeByLabel("C", digital(0));
    fix.coordinator.step();
    expect(readD(fix)).toBe(0xA0);

    fix.coordinator.writeByLabel("C", digital(1));
    fix.coordinator.step();
    expect(readD(fix)).toBe(0xA1);

    // Hold C high — no second rising edge, no further increment.
    fix.coordinator.step();
    fix.coordinator.step();
    expect(readD(fix)).toBe(0xA1);
    fix.coordinator.dispose();
  });

  it("no_preloaded_data_yields_D_zero_at_every_address", () => {
    // Documented contract: when no backing store data is preloaded, the
    // DataField defaults to all zeros.
    const fix = buildPMemFixture({ addrBits: 4, dataBits: 8 });
    fix.coordinator.writeByLabel("LD", digital(0));
    fix.coordinator.writeByLabel("A", digital(0));
    fix.coordinator.writeByLabel("C", digital(0));
    fix.coordinator.step();
    expect(readD(fix)).toBe(0);

    pulseClock(fix);
    expect(readD(fix)).toBe(0);
    pulseClock(fix);
    expect(readD(fix)).toBe(0);
    fix.coordinator.dispose();
  });

  it("address_wraps_modulo_data_field_size", () => {
    // Documented contract: addrReg auto-increment beyond addrBits range
    // wraps via the DataField's address masking. With addrBits=2 the
    // backing store has size 4 and A=4 wraps to 0.
    const fix = buildPMemFixture({
      data: [0x91, 0x92, 0x93, 0x94],
      addrBits: 2,
      dataBits: 8,
    });
    fix.coordinator.writeByLabel("A", digital(4)); // outside [0..3]
    fix.coordinator.writeByLabel("LD", digital(1));
    pulseClock(fix);
    // addrReg = A & 3 = 0 -> memory[0] = 0x91.
    expect(readD(fix)).toBe(0x91);
    fix.coordinator.dispose();
  });

  it("jump_to_high_address_reads_documented_word", () => {
    // Documented contract: jump (ld=1) loads any A within [0, 2^addrBits)
    // and D = memory[A] after the rising edge.
    const data = Array.from({ length: 16 }, (_, i) => 0x80 + i);
    const fix = buildPMemFixture({ data, addrBits: 4, dataBits: 8 });
    fix.coordinator.writeByLabel("A", digital(15));
    fix.coordinator.writeByLabel("LD", digital(1));
    pulseClock(fix);
    expect(readD(fix)).toBe(0x8F);
    fix.coordinator.dispose();
  });

  it("multi_bit_data_path_propagates_full_word_width", () => {
    // Documented contract: dataBits sets the D pin width; values up to
    // 2^dataBits-1 round-trip without truncation.
    const fix = buildPMemFixture({
      data: [0x12345678, 0xDEADBEEF],
      addrBits: 4,
      dataBits: 32,
    });
    fix.coordinator.writeByLabel("LD", digital(0));
    fix.coordinator.writeByLabel("A", digital(0));
    fix.coordinator.writeByLabel("C", digital(0));
    fix.coordinator.step();
    expect(readD(fix)).toBe(0x12345678);
    pulseClock(fix);
    expect(readD(fix)).toBe(0xDEADBEEF);
    fix.coordinator.dispose();
  });

  it("ld_can_be_reasserted_to_jump_again_mid_program", () => {
    // Documented contract: a second ld=1 pulse loads a new external address
    // mid-stream; subsequent ld=0 cycles auto-increment from there.
    const data = Array.from({ length: 16 }, (_, i) => 200 + i);
    const fix = buildPMemFixture({ data, addrBits: 4, dataBits: 8 });

    // Auto-increment from 0 to 2.
    fix.coordinator.writeByLabel("LD", digital(0));
    fix.coordinator.writeByLabel("A", digital(0));
    fix.coordinator.writeByLabel("C", digital(0));
    fix.coordinator.step();
    expect(readD(fix)).toBe(200);
    pulseClock(fix);
    expect(readD(fix)).toBe(201);
    pulseClock(fix);
    expect(readD(fix)).toBe(202);

    // Jump to 10.
    fix.coordinator.writeByLabel("A", digital(10));
    fix.coordinator.writeByLabel("LD", digital(1));
    pulseClock(fix);
    expect(readD(fix)).toBe(210);

    // Auto-increment from 10 to 11.
    fix.coordinator.writeByLabel("LD", digital(0));
    pulseClock(fix);
    expect(readD(fix)).toBe(211);
    fix.coordinator.dispose();
  });
});
