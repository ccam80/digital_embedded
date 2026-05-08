/**
 * Canonical tests for wiring components: Driver, DriverInvSel, Splitter,
 * BusSplitter, Tunnel.
 *
 * Tier: T1 — facade.build({components, connections}) + facade.compile() +
 *       coordinator.writeByLabel / step / readByLabel. All five components are
 *       pure-digital wiring helpers (digital model only, no analog model in
 *       the active build path). buildFixture requires an analog domain, so
 *       digital-only circuits drive the facade signal API directly per the
 *       sibling pattern in or.test.ts and lookup-table.test.ts.
 *
 * Canon coverage per component:
 *   - Cat 9 (digital interaction): drive labelled In ports, step, observe
 *     labelled Out ports.
 */

import { describe, it, expect } from "vitest";
import { createDefaultRegistry } from "../../register-all.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import type { PropertyValue } from "../../../core/properties.js";
import type { SignalValue } from "../../../compile/types.js";

interface DigitalFixture {
  facade: DefaultSimulatorFacade;
  coordinator: ReturnType<DefaultSimulatorFacade["compile"]>;
}

function digital(value: number): SignalValue {
  return { type: "digital", value };
}

function buildDigital(spec: {
  components: ReadonlyArray<{ id: string; type: string; props?: Record<string, PropertyValue> }>;
  connections: ReadonlyArray<readonly [string, string]>;
}): DigitalFixture {
  const registry = createDefaultRegistry();
  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({
    components: spec.components.map((c) => ({
      id: c.id,
      type: c.type,
      ...(c.props ? { props: c.props } : {}),
    })),
    connections: spec.connections.map((c) => [c[0], c[1]] as [string, string]),
  });
  const coordinator = facade.compile(circuit);
  return { facade, coordinator };
}

function readDigital(fix: DigitalFixture, label: string): number {
  const sv = fix.coordinator.readByLabel(label);
  if (sv.type !== "digital") {
    throw new Error(`readDigital: label '${label}' is not digital (got ${sv.type})`);
  }
  return sv.value;
}

// ===========================================================================
// Driver — Cat 9 (tri-state buffer: sel=1 → out=in; sel=0 → high-Z=0)
// ===========================================================================

function buildDriverFixture(bitWidth = 1): DigitalFixture {
  return buildDigital({
    components: [
      { id: "in",  type: "In",     props: { label: "IN",  bitWidth } },
      { id: "sel", type: "In",     props: { label: "SEL", bitWidth: 1 } },
      { id: "drv", type: "Driver", props: { bitWidth } },
      { id: "out", type: "Out",    props: { label: "OUT", bitWidth } },
    ],
    connections: [
      ["in:out",  "drv:in"],
      ["sel:out", "drv:sel"],
      ["drv:out", "out:in"],
    ],
  });
}

describe("Driver — Cat 9 digital interaction (T1)", () => {
  it("sel_high_passes_input_to_output_one_bit", () => {
    const fix = buildDriverFixture(1);
    fix.coordinator.writeByLabel("IN", digital(1));
    fix.coordinator.writeByLabel("SEL", digital(1));
    fix.coordinator.step();
    expect(readDigital(fix, "OUT")).toBe(1);

    fix.coordinator.writeByLabel("IN", digital(0));
    fix.coordinator.step();
    expect(readDigital(fix, "OUT")).toBe(0);
    fix.coordinator.dispose();
  });

  it("sel_high_passes_wide_input_to_output_eight_bit", () => {
    const fix = buildDriverFixture(8);
    fix.coordinator.writeByLabel("IN", digital(0xAB));
    fix.coordinator.writeByLabel("SEL", digital(1));
    fix.coordinator.step();
    expect(readDigital(fix, "OUT")).toBe(0xAB);

    fix.coordinator.writeByLabel("IN", digital(0xFF));
    fix.coordinator.step();
    expect(readDigital(fix, "OUT")).toBe(0xFF);
    fix.coordinator.dispose();
  });

  it("sel_low_drives_output_high_z_zero", () => {
    const fix = buildDriverFixture(8);
    fix.coordinator.writeByLabel("IN", digital(0xAB));
    fix.coordinator.writeByLabel("SEL", digital(0));
    fix.coordinator.step();
    // sel=0 → output cleared to 0, highZ=0xFFFFFFFF on the slot. The signal
    // observable is 0 (no driver present on the net).
    expect(readDigital(fix, "OUT")).toBe(0);
    fix.coordinator.dispose();
  });
});

// ===========================================================================
// DriverInvSel — Cat 9 (active-low enable: sel=0 → out=in; sel=1 → high-Z=0)
// ===========================================================================

function buildDriverInvFixture(bitWidth = 1): DigitalFixture {
  return buildDigital({
    components: [
      { id: "in",  type: "In",            props: { label: "IN",  bitWidth } },
      { id: "sel", type: "In",            props: { label: "SEL", bitWidth: 1 } },
      { id: "drv", type: "DriverInvSel", props: { bitWidth } },
      { id: "out", type: "Out",           props: { label: "OUT", bitWidth } },
    ],
    connections: [
      ["in:out",  "drv:in"],
      ["sel:out", "drv:sel"],
      ["drv:out", "out:in"],
    ],
  });
}

describe("DriverInvSel — Cat 9 digital interaction (T1)", () => {
  it("sel_low_passes_input_to_output_one_bit", () => {
    const fix = buildDriverInvFixture(1);
    fix.coordinator.writeByLabel("IN", digital(1));
    fix.coordinator.writeByLabel("SEL", digital(0));
    fix.coordinator.step();
    expect(readDigital(fix, "OUT")).toBe(1);

    fix.coordinator.writeByLabel("IN", digital(0));
    fix.coordinator.step();
    expect(readDigital(fix, "OUT")).toBe(0);
    fix.coordinator.dispose();
  });

  it("sel_low_passes_wide_input_to_output_eight_bit", () => {
    const fix = buildDriverInvFixture(8);
    fix.coordinator.writeByLabel("IN", digital(0xCD));
    fix.coordinator.writeByLabel("SEL", digital(0));
    fix.coordinator.step();
    expect(readDigital(fix, "OUT")).toBe(0xCD);
    fix.coordinator.dispose();
  });

  it("sel_high_drives_output_high_z_zero", () => {
    const fix = buildDriverInvFixture(8);
    fix.coordinator.writeByLabel("IN", digital(0xAB));
    fix.coordinator.writeByLabel("SEL", digital(1));
    fix.coordinator.step();
    expect(readDigital(fix, "OUT")).toBe(0);
    fix.coordinator.dispose();
  });
});

// ===========================================================================
// Splitter — Cat 9 (split a wide bus into narrow ports / merge narrow into wide)
//
// Splitter pin labels follow parsePorts/portName:
//   "8"      → single port "0-7" (8 bits, range form)
//   "4,4"    → two ports "0-3", "4-7"
//   "1,1,1,1,4" → ports "0", "1", "2", "3", "4-7"
//   "2"      → single port "0,1" (2 bits, two-wide form)
//   "3"      → single port "0-2"
// ===========================================================================

describe("Splitter — Cat 9 digital interaction (T1)", () => {
  it("split_eight_bit_bus_into_two_four_bit_nibbles", () => {
    // Input: 8-bit IN → Splitter (input "8", output "4,4") → two 4-bit Outs.
    // For 0xAB = 0b10101011: low nibble = 0xB, high nibble = 0xA.
    const fix = buildDigital({
      components: [
        { id: "in",   type: "In",       props: { label: "IN", bitWidth: 8 } },
        { id: "spl",  type: "Splitter", props: { "inputSplitting": "8", "outputSplitting": "4,4" } },
        { id: "lo",   type: "Out",      props: { label: "LO", bitWidth: 4 } },
        { id: "hi",   type: "Out",      props: { label: "HI", bitWidth: 4 } },
      ],
      connections: [
        ["in:out",   "spl:0-7"],
        ["spl:0-3",  "lo:in"],
        ["spl:4-7",  "hi:in"],
      ],
    });
    fix.coordinator.writeByLabel("IN", digital(0xAB));
    fix.coordinator.step();
    expect(readDigital(fix, "LO")).toBe(0xB);
    expect(readDigital(fix, "HI")).toBe(0xA);
    fix.coordinator.dispose();
  });

  it("merge_two_four_bit_nibbles_into_eight_bit_bus", () => {
    // Two 4-bit Ins → Splitter (input "4,4", output "8") → 8-bit Out.
    // Inputs LO=0xB and HI=0xA → merged into 0xAB.
    const fix = buildDigital({
      components: [
        { id: "lo",  type: "In",       props: { label: "LO", bitWidth: 4 } },
        { id: "hi",  type: "In",       props: { label: "HI", bitWidth: 4 } },
        { id: "spl", type: "Splitter", props: { "inputSplitting": "4,4", "outputSplitting": "8" } },
        { id: "out", type: "Out",      props: { label: "OUT", bitWidth: 8 } },
      ],
      connections: [
        ["lo:out",   "spl:0-3"],
        ["hi:out",   "spl:4-7"],
        ["spl:0-7",  "out:in"],
      ],
    });
    fix.coordinator.writeByLabel("LO", digital(0xB));
    fix.coordinator.writeByLabel("HI", digital(0xA));
    fix.coordinator.step();
    expect(readDigital(fix, "OUT")).toBe(0xAB);
    fix.coordinator.dispose();
  });

  it("split_pattern_one_one_one_one_four_extracts_individual_bits_and_nibble", () => {
    // Pattern "1,1,1,1,4" on 8-bit bus:
    // - port 0 (label "0")   → bit 0
    // - port 1 (label "1")   → bit 1
    // - port 2 (label "2")   → bit 2
    // - port 3 (label "3")   → bit 3
    // - port 4 (label "4-7") → bits 4..7
    // For 0xF5 = 0b11110101: bit0=1, bit1=0, bit2=1, bit3=0, bits4-7=0xF.
    const fix = buildDigital({
      components: [
        { id: "in",  type: "In",       props: { label: "IN", bitWidth: 8 } },
        { id: "spl", type: "Splitter", props: { "inputSplitting": "8", "outputSplitting": "1,1,1,1,4" } },
        { id: "b0",  type: "Out",      props: { label: "B0",  bitWidth: 1 } },
        { id: "b1",  type: "Out",      props: { label: "B1",  bitWidth: 1 } },
        { id: "b2",  type: "Out",      props: { label: "B2",  bitWidth: 1 } },
        { id: "b3",  type: "Out",      props: { label: "B3",  bitWidth: 1 } },
        { id: "nib", type: "Out",      props: { label: "NIB", bitWidth: 4 } },
      ],
      connections: [
        ["in:out",  "spl:0-7"],
        ["spl:0",   "b0:in"],
        ["spl:1",   "b1:in"],
        ["spl:2",   "b2:in"],
        ["spl:3",   "b3:in"],
        ["spl:4-7", "nib:in"],
      ],
    });
    fix.coordinator.writeByLabel("IN", digital(0xF5));
    fix.coordinator.step();
    expect(readDigital(fix, "B0")).toBe(1);
    expect(readDigital(fix, "B1")).toBe(0);
    expect(readDigital(fix, "B2")).toBe(1);
    expect(readDigital(fix, "B3")).toBe(0);
    expect(readDigital(fix, "NIB")).toBe(0xF);
    fix.coordinator.dispose();
  });
});

// ===========================================================================
// BusSplitter — Cat 9 (OE-gated bidirectional bus splitter)
//
// Pin layout:
//   D       (output, bitWidth=bits)            — common bus
//   OE      (input,  bitWidth=1)               — output enable
//   D0..Dn  (output, bitWidth=1, n=bits-1)     — individual bit lines
//
// When OE=1: D drives D0..D(bits-1) with extracted bits.
// When OE=0: D0..D(bits-1) all forced to 0.
// ===========================================================================

describe("BusSplitter — Cat 9 digital interaction (T1)", () => {
  it("oe_high_splits_d_into_individual_bit_outputs", () => {
    // 4-bit BusSplitter. D net driven by 4-bit IN. OE=1.
    // For D=0xA = 0b1010: D0=0, D1=1, D2=0, D3=1.
    const fix = buildDigital({
      components: [
        { id: "in",  type: "In",          props: { label: "IN", bitWidth: 4 } },
        { id: "oe",  type: "In",          props: { label: "OE", bitWidth: 1 } },
        { id: "bs",  type: "BusSplitter", props: { bitWidth: 4 } },
        { id: "od0", type: "Out",         props: { label: "OD0", bitWidth: 1 } },
        { id: "od1", type: "Out",         props: { label: "OD1", bitWidth: 1 } },
        { id: "od2", type: "Out",         props: { label: "OD2", bitWidth: 1 } },
        { id: "od3", type: "Out",         props: { label: "OD3", bitWidth: 1 } },
      ],
      connections: [
        ["in:out", "bs:D"],
        ["oe:out", "bs:OE"],
        ["bs:D0",  "od0:in"],
        ["bs:D1",  "od1:in"],
        ["bs:D2",  "od2:in"],
        ["bs:D3",  "od3:in"],
      ],
    });
    fix.coordinator.writeByLabel("IN", digital(0xA));
    fix.coordinator.writeByLabel("OE", digital(1));
    fix.coordinator.step();
    expect(readDigital(fix, "OD0")).toBe(0);
    expect(readDigital(fix, "OD1")).toBe(1);
    expect(readDigital(fix, "OD2")).toBe(0);
    expect(readDigital(fix, "OD3")).toBe(1);
    fix.coordinator.dispose();
  });

  it("oe_low_clears_all_individual_bit_outputs_to_zero", () => {
    const fix = buildDigital({
      components: [
        { id: "in",  type: "In",          props: { label: "IN", bitWidth: 4 } },
        { id: "oe",  type: "In",          props: { label: "OE", bitWidth: 1 } },
        { id: "bs",  type: "BusSplitter", props: { bitWidth: 4 } },
        { id: "od0", type: "Out",         props: { label: "OD0", bitWidth: 1 } },
        { id: "od1", type: "Out",         props: { label: "OD1", bitWidth: 1 } },
        { id: "od2", type: "Out",         props: { label: "OD2", bitWidth: 1 } },
        { id: "od3", type: "Out",         props: { label: "OD3", bitWidth: 1 } },
      ],
      connections: [
        ["in:out", "bs:D"],
        ["oe:out", "bs:OE"],
        ["bs:D0",  "od0:in"],
        ["bs:D1",  "od1:in"],
        ["bs:D2",  "od2:in"],
        ["bs:D3",  "od3:in"],
      ],
    });
    fix.coordinator.writeByLabel("IN", digital(0xF));
    fix.coordinator.writeByLabel("OE", digital(0));
    fix.coordinator.step();
    expect(readDigital(fix, "OD0")).toBe(0);
    expect(readDigital(fix, "OD1")).toBe(0);
    expect(readDigital(fix, "OD2")).toBe(0);
    expect(readDigital(fix, "OD3")).toBe(0);
    fix.coordinator.dispose();
  });
});

// ===========================================================================
// Tunnel — Cat 9 (named-net merging via NetName)
//
// Two Tunnels with the same NetName have their `in` pins merged into the same
// digital net at compile time (extract-connectivity.ts:154 — Tunnel-merge step
// 3). Driving an In into one Tunnel's net and observing an Out wired through
// a second Tunnel's net asserts that the merge happened end-to-end.
// ===========================================================================

describe("Tunnel — Cat 9 digital interaction (T1)", () => {
  it("two_tunnels_with_same_netname_merge_into_one_net", () => {
    // IN drives net A; tunnel t1 (NetName="BUS") shares its 'in' pin with
    // net A. Tunnel t2 (NetName="BUS") shares its 'in' pin with the OUT input
    // net. The compile-time tunnel merge unifies the two tunnel pin nets, so
    // OUT reads the IN value.
    const fix = buildDigital({
      components: [
        { id: "src", type: "In",     props: { label: "IN",  bitWidth: 1 } },
        { id: "t1",  type: "Tunnel", props: { NetName: "BUS", bitWidth: 1 } },
        { id: "t2",  type: "Tunnel", props: { NetName: "BUS", bitWidth: 1 } },
        { id: "snk", type: "Out",    props: { label: "OUT", bitWidth: 1 } },
      ],
      connections: [
        ["src:out", "t1:in"],
        ["t2:in",   "snk:in"],
      ],
    });
    fix.coordinator.writeByLabel("IN", digital(1));
    fix.coordinator.step();
    expect(readDigital(fix, "OUT")).toBe(1);

    fix.coordinator.writeByLabel("IN", digital(0));
    fix.coordinator.step();
    expect(readDigital(fix, "OUT")).toBe(0);
    fix.coordinator.dispose();
  });

  it("two_tunnels_with_different_netnames_do_not_merge", () => {
    // Tunnels with distinct NetNames are NOT merged; the two halves remain
    // electrically independent. Driving IN does not propagate to OUT — OUT
    // reads its default (0) since nothing drives its net.
    const fix = buildDigital({
      components: [
        { id: "src", type: "In",     props: { label: "IN",  bitWidth: 1 } },
        { id: "t1",  type: "Tunnel", props: { NetName: "NET_A", bitWidth: 1 } },
        { id: "t2",  type: "Tunnel", props: { NetName: "NET_B", bitWidth: 1 } },
        { id: "snk", type: "Out",    props: { label: "OUT", bitWidth: 1 } },
      ],
      connections: [
        ["src:out", "t1:in"],
        ["t2:in",   "snk:in"],
      ],
    });
    fix.coordinator.writeByLabel("IN", digital(1));
    fix.coordinator.step();
    expect(readDigital(fix, "OUT")).toBe(0);
    fix.coordinator.dispose();
  });
});
