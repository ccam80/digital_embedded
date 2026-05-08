import { describe, it, expect } from "vitest";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../register-all.js";
import type { PropertyValue } from "../../../core/properties.js";

// ---------------------------------------------------------------------------
// BitSelector canonical test set
//
// Canon categories applied:
//   4  — Parameter hot-load (structural: selectorBits is consumed at compile()
//        to size the `in` (2^selectorBits wide) and `sel` (selectorBits wide)
//        pins; canonical Cat 4 for compile-time-seeded structural properties
//        uses the build-twice mechanic).
//   9  — Bridge / digital interaction (the documented digital behaviour:
//        out = (in >> sel) & 1).
//   13 — Port-width clamping on overrun (sel port is selectorBits wide; when a
//        wider source bus drives sel, the value is masked to the port width
//        before the executeFn reads it; documented mask is
//        sel_effective = sel_source & ((1 << selectorBits) - 1)).
//
// File tier: fixture-only.
//   BitSelector is a pure-digital component — its only model entry is
//   `models.digital.executeFn`. There is no analog leaf, no state pool, no
//   `setup()` / `load()`, no `getLteTimestep`, no `acceptStep`, no `*lim`
//   call, no named-preset registry beyond `digital`, no multi-output schema
//   (single `out` pin), no `_onStateChange` writeback, no runtime-diagnostic
//   emit site, no spec-mandated forbidden input combination. Categories
//   1, 2, 3, 5, 6, 7, 8, 10, 11, 12, 14, 15 do not apply.
//
//   Programmatic build via `facade.build` is the sanctioned surface; signals
//   are driven via `facade.setSignal` and read via `facade.readSignal`.
//
// BitSelector pin layout (selectorBits=3): inputs [in (8-bit), sel (3-bit)],
//   output [out (1-bit)]. The executeFn is combinational and stateless —
//   no rising-edge mechanic, no state slots, no warm-start.
// ---------------------------------------------------------------------------

const registry = createDefaultRegistry();

interface BitSelFixture {
  facade: DefaultSimulatorFacade;
  coordinator: ReturnType<DefaultSimulatorFacade["compile"]>;
}

function buildBitSelFixture(opts: { selectorBits?: number } = {}): BitSelFixture {
  const selectorBits = opts.selectorBits ?? 3;
  const inBits = 1 << selectorBits;

  const components: Array<{ id: string; type: string; props: Record<string, PropertyValue> }> = [
    { id: "in_data", type: "In",          props: { label: "DATA", bitWidth: inBits } },
    { id: "in_sel",  type: "In",          props: { label: "SEL",  bitWidth: selectorBits } },
    { id: "bsel",    type: "BitSelector", props: { label: "BS",   selectorBits } },
    { id: "out_y",   type: "Out",         props: { label: "Y",    bitWidth: 1 } },
  ];
  const connections: Array<[string, string]> = [
    ["in_data:out", "bsel:in"],
    ["in_sel:out",  "bsel:sel"],
    ["bsel:out",    "out_y:in"],
  ];

  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({ components, connections });
  const coordinator = facade.compile(circuit);
  return { facade, coordinator };
}

// ---------------------------------------------------------------------------
// Cat 9 — bridge / digital interaction
// ---------------------------------------------------------------------------

describe("BitSelector — bridge / digital (T1)", () => {
  it("selects_bit_zero_returns_lsb_of_input", () => {
    // Documented contract: out = (in >> sel) & 1. With sel=0, out is bit 0 of
    // in. Driving in=0b1010 → bit 0 is 0.
    const fix = buildBitSelFixture({ selectorBits: 3 });
    fix.facade.setSignal(fix.coordinator, "DATA", 0b1010);
    fix.facade.setSignal(fix.coordinator, "SEL", 0);
    fix.facade.step(fix.coordinator);
    expect(fix.facade.readSignal(fix.coordinator, "Y")).toBe(0);
    fix.coordinator.dispose();
  });

  it("selects_bit_one_returns_bit_at_index_1", () => {
    // Documented contract: sel=1 → out is bit 1. in=0b1010 → bit 1 is 1.
    const fix = buildBitSelFixture({ selectorBits: 3 });
    fix.facade.setSignal(fix.coordinator, "DATA", 0b1010);
    fix.facade.setSignal(fix.coordinator, "SEL", 1);
    fix.facade.step(fix.coordinator);
    expect(fix.facade.readSignal(fix.coordinator, "Y")).toBe(1);
    fix.coordinator.dispose();
  });

  it("selects_bit_two_returns_bit_at_index_2", () => {
    // Documented contract: sel=2 → out is bit 2. in=0b1010 → bit 2 is 0.
    const fix = buildBitSelFixture({ selectorBits: 3 });
    fix.facade.setSignal(fix.coordinator, "DATA", 0b1010);
    fix.facade.setSignal(fix.coordinator, "SEL", 2);
    fix.facade.step(fix.coordinator);
    expect(fix.facade.readSignal(fix.coordinator, "Y")).toBe(0);
    fix.coordinator.dispose();
  });

  it("selects_bit_three_returns_msb_of_4bit_pattern", () => {
    // Documented contract: sel=3 → out is bit 3. in=0b1010 → bit 3 is 1.
    const fix = buildBitSelFixture({ selectorBits: 3 });
    fix.facade.setSignal(fix.coordinator, "DATA", 0b1010);
    fix.facade.setSignal(fix.coordinator, "SEL", 3);
    fix.facade.step(fix.coordinator);
    expect(fix.facade.readSignal(fix.coordinator, "Y")).toBe(1);
    fix.coordinator.dispose();
  });

  it("all_ones_input_returns_one_for_every_selector", () => {
    // Documented contract: every bit of an all-ones input is 1, so out=1 for
    // every valid sel. Sweep all 8 sel values for selectorBits=3 (8-bit data).
    const fix = buildBitSelFixture({ selectorBits: 3 });
    fix.facade.setSignal(fix.coordinator, "DATA", 0xFF);
    for (let sel = 0; sel < 8; sel++) {
      fix.facade.setSignal(fix.coordinator, "SEL", sel);
      fix.facade.step(fix.coordinator);
      expect(fix.facade.readSignal(fix.coordinator, "Y")).toBe(1);
    }
    fix.coordinator.dispose();
  });

  it("all_zeros_input_returns_zero_for_every_selector", () => {
    // Documented contract: every bit of an all-zeros input is 0, so out=0 for
    // every valid sel.
    const fix = buildBitSelFixture({ selectorBits: 3 });
    fix.facade.setSignal(fix.coordinator, "DATA", 0x00);
    for (let sel = 0; sel < 8; sel++) {
      fix.facade.setSignal(fix.coordinator, "SEL", sel);
      fix.facade.step(fix.coordinator);
      expect(fix.facade.readSignal(fix.coordinator, "Y")).toBe(0);
    }
    fix.coordinator.dispose();
  });

  it("alternating_pattern_0xAA_yields_alternating_bits_per_selector", () => {
    // Documented contract: in=0xAA = 0b10101010 → even sel returns 0,
    // odd sel returns 1. Closed-form: out = (0xAA >> sel) & 1 = sel & 1.
    const fix = buildBitSelFixture({ selectorBits: 3 });
    fix.facade.setSignal(fix.coordinator, "DATA", 0xAA);
    for (let sel = 0; sel < 8; sel++) {
      fix.facade.setSignal(fix.coordinator, "SEL", sel);
      fix.facade.step(fix.coordinator);
      expect(fix.facade.readSignal(fix.coordinator, "Y")).toBe(sel & 1);
    }
    fix.coordinator.dispose();
  });

  it("output_is_combinational_no_clock_required", () => {
    // Documented contract: BitSelector has no clock or state — changing in or
    // sel and stepping once produces the new out value.
    const fix = buildBitSelFixture({ selectorBits: 3 });
    fix.facade.setSignal(fix.coordinator, "DATA", 0b00010000);
    fix.facade.setSignal(fix.coordinator, "SEL", 4);
    fix.facade.step(fix.coordinator);
    expect(fix.facade.readSignal(fix.coordinator, "Y")).toBe(1);

    // Change inputs and step again — out follows immediately.
    fix.facade.setSignal(fix.coordinator, "DATA", 0b00010000);
    fix.facade.setSignal(fix.coordinator, "SEL", 0);
    fix.facade.step(fix.coordinator);
    expect(fix.facade.readSignal(fix.coordinator, "Y")).toBe(0);
    fix.coordinator.dispose();
  });
});

// ---------------------------------------------------------------------------
// Cat 4 — parameter hot-load (compile-time-seeded structural property)
// ---------------------------------------------------------------------------

describe("BitSelector — parameter hot-load (T1)", () => {
  it("selectorbits_structural_property_widens_input_pin", () => {
    // Cat 4 — compile-time-seeded structural property: selectorBits
    // determines the data-pin width (= 2^selectorBits) and the sel-pin width
    // (= selectorBits). Build twice — once at selectorBits=2 (4-bit data,
    // 2-bit sel), once at selectorBits=4 (16-bit data, 4-bit sel) — and
    // assert that the wider config exposes a bit at index 8 that the narrow
    // config cannot reach.
    //
    // selectorBits=2: data is 4-bit; driving 0x100 truncates to 0x00 (the
    // upstream In masks to its declared 4-bit width). Selecting bit 0..3
    // returns 0 across the board.
    const fixNarrow = buildBitSelFixture({ selectorBits: 2 });
    fixNarrow.facade.setSignal(fixNarrow.coordinator, "DATA", 0x100);
    fixNarrow.facade.setSignal(fixNarrow.coordinator, "SEL", 0);
    fixNarrow.facade.step(fixNarrow.coordinator);
    expect(fixNarrow.facade.readSignal(fixNarrow.coordinator, "Y")).toBe(0);
    fixNarrow.coordinator.dispose();

    // selectorBits=4: data is 16-bit; driving 0x100 keeps bit 8 set.
    // Selecting bit 8 returns 1.
    const fixWide = buildBitSelFixture({ selectorBits: 4 });
    fixWide.facade.setSignal(fixWide.coordinator, "DATA", 0x100);
    fixWide.facade.setSignal(fixWide.coordinator, "SEL", 8);
    fixWide.facade.step(fixWide.coordinator);
    expect(fixWide.facade.readSignal(fixWide.coordinator, "Y")).toBe(1);
    fixWide.coordinator.dispose();
  });
});

// ---------------------------------------------------------------------------
// Cat 13 — port-width clamping on overrun
// ---------------------------------------------------------------------------

describe("BitSelector — port-width clamping (T1)", () => {
  it("sel_port_masks_oversized_drive_to_selectorbits_width", () => {
    // Cat 13 — sel port is `selectorBits` wide (selectorBits=3 → sel port is
    // 3 bits). The upstream `In` declares matching width 3, so driving
    // sel=8 (1000b) is wider than the declared 3-bit `In` and is masked at
    // the In's `BitVector.fromNumber(value, 3)` to 8 & 0b111 = 0. With
    // in=0b00000001 and the masked sel=0, the executeFn reads bit 0 → 1.
    //
    // This asserts the documented mask: sel_effective = sel_source &
    // ((1 << selectorBits) - 1). The port-width clamp at the In maps
    // sel_source=8 to sel_effective=0 → out = (in >> 0) & 1 = 1.
    const fix = buildBitSelFixture({ selectorBits: 3 });
    fix.facade.setSignal(fix.coordinator, "DATA", 0b00000001);
    fix.facade.setSignal(fix.coordinator, "SEL", 8);
    fix.facade.step(fix.coordinator);
    expect(fix.facade.readSignal(fix.coordinator, "Y")).toBe(1);
    fix.coordinator.dispose();
  });

  it("sel_port_masks_oversized_drive_to_nonzero_residue", () => {
    // Cat 13 — driving sel=11 (1011b) over a 3-bit sel port masks to
    // 11 & 0b111 = 3. With in=0b00001000 (bit 3 set), the masked sel=3
    // returns 1.
    const fix = buildBitSelFixture({ selectorBits: 3 });
    fix.facade.setSignal(fix.coordinator, "DATA", 0b00001000);
    fix.facade.setSignal(fix.coordinator, "SEL", 11);
    fix.facade.step(fix.coordinator);
    expect(fix.facade.readSignal(fix.coordinator, "Y")).toBe(1);
    fix.coordinator.dispose();
  });
});
