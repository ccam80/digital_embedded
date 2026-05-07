import { describe, it, expect } from "vitest";
import { createDefaultRegistry } from "../../register-all.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import type { PropertyValue } from "../../../core/properties.js";
import type { SignalValue } from "../../../compile/types.js";

// ---------------------------------------------------------------------------
// DipSwitch canonical test set
// Canon categories applicable: 9 (bridge / digital interaction).
// File tier: fixture-only (digital-only IO source; DipSwitch has no analog
// model, no setup()/load(), no junction limiting, no LTE, no breakpoints,
// and a single digital model entry. buildFixture() requires an analog
// domain, so the canonical mechanic for digital-only IO sources is
// facade.build({components, connections}) + facade.compile() +
// coordinator.writeByLabel / step / readByLabel.
//
// DipSwitch is a multi-bit toggle source: executeFn is a no-op, the
// engine writes per-bit values into the output net via setSignalValue when
// the user clicks a slot. Cat 9 is therefore exercised by writing a
// digital pattern to the DipSwitch's labelled output address and
// observing it propagate through a downstream Out.
// ---------------------------------------------------------------------------

interface DipSwitchFixture {
  facade: DefaultSimulatorFacade;
  coordinator: ReturnType<DefaultSimulatorFacade["compile"]>;
}

function digital(value: number): SignalValue {
  return { type: "digital", value };
}

function buildDipSwitchFixture(opts: {
  bitCount: number;
  defaultValue?: number;
  switchLabel?: string;
  outLabel?: string;
}): DipSwitchFixture {
  const bitCount = opts.bitCount;
  const switchLabel = opts.switchLabel ?? "SW";
  const outLabel = opts.outLabel ?? "OUT";

  const switchProps: Record<string, PropertyValue> = {
    label: switchLabel,
    bitCount,
  };
  if (opts.defaultValue !== undefined) {
    switchProps.defaultValue = opts.defaultValue;
  }

  const components: Array<{ id: string; type: string; props: Record<string, PropertyValue> }> = [
    { id: "sw1", type: "DipSwitch", props: switchProps },
    { id: "out1", type: "Out", props: { label: outLabel, bitWidth: bitCount } },
  ];
  const connections: Array<[string, string]> = [
    ["sw1:out", "out1:in"],
  ];

  const registry = createDefaultRegistry();
  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({ components, connections });
  const coordinator = facade.compile(circuit);
  return { facade, coordinator };
}

// ===========================================================================
// DipSwitch — Cat 9 (digital interaction): externally driven output observed
// by downstream Out across bit widths and bit patterns.
// ===========================================================================

describe("DipSwitch — bridge / digital (Cat 9, T1)", () => {
  it("one_bit_externally_driven_zero_propagates_to_out", () => {
    const fix = buildDipSwitchFixture({ bitCount: 1 });
    fix.coordinator.writeByLabel("SW", digital(0));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("OUT")).toMatchObject({
      type: "digital",
      value: 0,
    });
    fix.coordinator.dispose();
  });

  it("one_bit_externally_driven_one_propagates_to_out", () => {
    const fix = buildDipSwitchFixture({ bitCount: 1 });
    fix.coordinator.writeByLabel("SW", digital(1));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("OUT")).toMatchObject({
      type: "digital",
      value: 1,
    });
    fix.coordinator.dispose();
  });

  it("four_bit_pattern_0b1010_propagates_to_out", () => {
    const fix = buildDipSwitchFixture({ bitCount: 4 });
    fix.coordinator.writeByLabel("SW", digital(0b1010));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("OUT")).toMatchObject({
      type: "digital",
      value: 0b1010,
    });
    fix.coordinator.dispose();
  });

  it("eight_bit_pattern_0xFF_propagates_to_out", () => {
    const fix = buildDipSwitchFixture({ bitCount: 8 });
    fix.coordinator.writeByLabel("SW", digital(0xFF));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("OUT")).toMatchObject({
      type: "digital",
      value: 0xFF,
    });
    fix.coordinator.dispose();
  });

  it("eight_bit_pattern_0xA5_propagates_to_out", () => {
    const fix = buildDipSwitchFixture({ bitCount: 8 });
    fix.coordinator.writeByLabel("SW", digital(0xA5));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("OUT")).toMatchObject({
      type: "digital",
      value: 0xA5,
    });
    fix.coordinator.dispose();
  });

  it("sixteen_bit_pattern_0xABCD_propagates_to_out", () => {
    const fix = buildDipSwitchFixture({ bitCount: 16 });
    fix.coordinator.writeByLabel("SW", digital(0xABCD));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("OUT")).toMatchObject({
      type: "digital",
      value: 0xABCD,
    });
    fix.coordinator.dispose();
  });

  it("rewriting_a_bit_pattern_replaces_the_previous_value_at_out", () => {
    // Sequence: write 0xF0, step, read 0xF0; then write 0x0F, step, read 0x0F.
    // Asserts the externally-driven output is the live value, not latched.
    const fix = buildDipSwitchFixture({ bitCount: 8 });
    fix.coordinator.writeByLabel("SW", digital(0xF0));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("OUT")).toMatchObject({
      type: "digital",
      value: 0xF0,
    });
    fix.coordinator.writeByLabel("SW", digital(0x0F));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("OUT")).toMatchObject({
      type: "digital",
      value: 0x0F,
    });
    fix.coordinator.dispose();
  });
});

// ===========================================================================
// DipSwitch — Cat 9 (digital interaction): defaultValue seeds the output net
// at digital init (no external write needed). Documented behaviour:
// init-sequence.ts seeds the output state with the defaultValue property at
// digital init time.
// ===========================================================================

describe("DipSwitch defaultValue seed — bridge / digital (Cat 9, T1)", () => {
  it("default_value_zero_one_bit_seeds_out_to_zero_after_step", () => {
    const fix = buildDipSwitchFixture({ bitCount: 1, defaultValue: 0 });
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("OUT")).toMatchObject({
      type: "digital",
      value: 0,
    });
    fix.coordinator.dispose();
  });

  it("default_value_one_one_bit_seeds_out_to_one_after_step", () => {
    const fix = buildDipSwitchFixture({ bitCount: 1, defaultValue: 1 });
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("OUT")).toMatchObject({
      type: "digital",
      value: 1,
    });
    fix.coordinator.dispose();
  });

  it("default_value_0b1010_four_bit_seeds_out_pattern_after_step", () => {
    const fix = buildDipSwitchFixture({ bitCount: 4, defaultValue: 0b1010 });
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("OUT")).toMatchObject({
      type: "digital",
      value: 0b1010,
    });
    fix.coordinator.dispose();
  });

  it("default_value_0xFF_eight_bit_seeds_out_pattern_after_step", () => {
    const fix = buildDipSwitchFixture({ bitCount: 8, defaultValue: 0xFF });
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("OUT")).toMatchObject({
      type: "digital",
      value: 0xFF,
    });
    fix.coordinator.dispose();
  });
});
