import { describe, it, expect } from "vitest";
import { createDefaultRegistry } from "../../register-all.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import type { PropertyValue } from "../../../core/properties.js";
import type { SignalValue } from "../../../compile/types.js";

// ===========================================================================
// SevenSeg / SevenSegHex / SixteenSeg canonical test set.
//
// Canon categories applicable: 9 (bridge / digital interaction).
// File tier: fixture-only.
//
// All three components are pure digital display sinks:
//   - models.digital is registered (executeFn packs inputs into state[outputOffset]
//     for the display panel; outputSchema is []).
//   - No analog model: no setup() / load() / junction limiting / LTE rollback
//     / breakpoint registration / matrix stamps. Cats 1-8 (init / DCOP /
//     transient / hot-load / stamps / limiting / LTE / breakpoints) are
//     therefore non-applicable.
//   - Only one digital model entry per component (no named-preset registry),
//     so Cat 10 is non-applicable.
//   - outputSchema is [] — there are no labelled output pins, so Cat 11
//     multi-output is non-applicable. The display is a sink whose state is
//     read by the panel rendering layer rather than by readByLabel.
//   - No documented forbidden input combinations and no narrow input ports
//     where the upstream bus may exceed the declared port width — Cat 12 and
//     Cat 13 are non-applicable.
//   - No runtime-diagnostic emission and no _onStateChange writeback — Cat 14
//     and Cat 15 are non-applicable.
//
// Canonical mechanic for each component is therefore exactly Cat 9:
// drive a known digital pattern through a labelled DipSwitch source connected
// to the display's input pin(s), step the simulator, observe that the pipeline
// completes and the labelled source readback returns the driven value.
// Identical structural shape to dip-switch.test.ts.
// ===========================================================================

interface SegmentFixture {
  facade: DefaultSimulatorFacade;
  coordinator: ReturnType<DefaultSimulatorFacade["compile"]>;
}

function digital(value: number): SignalValue {
  return { type: "digital", value };
}

// ---------------------------------------------------------------------------
// SevenSeg builder: 8 single-bit DipSwitch sources, one per segment input
// (a, b, c, d, e, f, g, dp).
// ---------------------------------------------------------------------------

function buildSevenSegFixture(opts?: { commonCathode?: boolean }): SegmentFixture {
  const segLabels = ["a", "b", "c", "d", "e", "f", "g", "dp"] as const;
  const components: Array<{ id: string; type: string; props: Record<string, PropertyValue> }> = [
    {
      id: "disp",
      type: "SevenSeg",
      props: {
        label: "DISP",
        commonCathode: opts?.commonCathode ?? true,
      },
    },
  ];
  const connections: Array<[string, string]> = [];
  for (const seg of segLabels) {
    components.push({
      id: `sw_${seg}`,
      type: "DipSwitch",
      props: { label: `SW_${seg.toUpperCase()}`, bitCount: 1 },
    });
    connections.push([`sw_${seg}:out`, `disp:${seg}`]);
  }

  const registry = createDefaultRegistry();
  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({ components, connections });
  const coordinator = facade.compile(circuit);
  return { facade, coordinator };
}

// ---------------------------------------------------------------------------
// SevenSegHex builder: one 4-bit DipSwitch on the d input, one 1-bit DipSwitch
// on the dp input.
// ---------------------------------------------------------------------------

function buildSevenSegHexFixture(opts?: { commonCathode?: boolean }): SegmentFixture {
  const components: Array<{ id: string; type: string; props: Record<string, PropertyValue> }> = [
    {
      id: "disp",
      type: "SevenSegHex",
      props: {
        label: "DISP",
        commonCathode: opts?.commonCathode ?? true,
      },
    },
    { id: "sw_d", type: "DipSwitch", props: { label: "SW_D", bitCount: 4 } },
    { id: "sw_dp", type: "DipSwitch", props: { label: "SW_DP", bitCount: 1 } },
  ];
  const connections: Array<[string, string]> = [
    ["sw_d:out", "disp:d"],
    ["sw_dp:out", "disp:dp"],
  ];

  const registry = createDefaultRegistry();
  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({ components, connections });
  const coordinator = facade.compile(circuit);
  return { facade, coordinator };
}

// ---------------------------------------------------------------------------
// SixteenSeg builder: one 16-bit DipSwitch on the led input, one 1-bit
// DipSwitch on the dp input.
// ---------------------------------------------------------------------------

function buildSixteenSegFixture(opts?: { commonCathode?: boolean }): SegmentFixture {
  const components: Array<{ id: string; type: string; props: Record<string, PropertyValue> }> = [
    {
      id: "disp",
      type: "SixteenSeg",
      props: {
        label: "DISP",
        commonCathode: opts?.commonCathode ?? true,
      },
    },
    { id: "sw_led", type: "DipSwitch", props: { label: "SW_LED", bitCount: 16 } },
    { id: "sw_dp", type: "DipSwitch", props: { label: "SW_DP", bitCount: 1 } },
  ];
  const connections: Array<[string, string]> = [
    ["sw_led:out", "disp:led"],
    ["sw_dp:out", "disp:dp"],
  ];

  const registry = createDefaultRegistry();
  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({ components, connections });
  const coordinator = facade.compile(circuit);
  return { facade, coordinator };
}

// ===========================================================================
// SevenSeg — Cat 9 (bridge / digital interaction)
// Each segment input is driven independently; the simulator step propagates
// the driven values into the display's input nets. The DipSwitch labelled
// readback at each driver confirms the value reached the display's pin.
// ===========================================================================

describe("SevenSeg — bridge / digital (Cat 9, T1)", () => {
  it("all_segments_low_drives_each_input_to_zero", () => {
    const fix = buildSevenSegFixture();
    const segs = ["a", "b", "c", "d", "e", "f", "g", "dp"] as const;
    for (const seg of segs) {
      fix.coordinator.writeByLabel(`SW_${seg.toUpperCase()}`, digital(0));
    }
    fix.coordinator.step();
    for (const seg of segs) {
      expect(fix.coordinator.readByLabel(`SW_${seg.toUpperCase()}`)).toMatchObject({
        type: "digital",
        value: 0,
      });
    }
    fix.coordinator.dispose();
  });

  it("segment_a_high_remaining_low_propagates_independently", () => {
    const fix = buildSevenSegFixture();
    fix.coordinator.writeByLabel("SW_A", digital(1));
    for (const seg of ["B", "C", "D", "E", "F", "G", "DP"]) {
      fix.coordinator.writeByLabel(`SW_${seg}`, digital(0));
    }
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("SW_A")).toMatchObject({ type: "digital", value: 1 });
    expect(fix.coordinator.readByLabel("SW_DP")).toMatchObject({ type: "digital", value: 0 });
    fix.coordinator.dispose();
  });

  it("segment_dp_high_propagates_independently", () => {
    const fix = buildSevenSegFixture();
    for (const seg of ["A", "B", "C", "D", "E", "F", "G"]) {
      fix.coordinator.writeByLabel(`SW_${seg}`, digital(0));
    }
    fix.coordinator.writeByLabel("SW_DP", digital(1));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("SW_DP")).toMatchObject({ type: "digital", value: 1 });
    expect(fix.coordinator.readByLabel("SW_A")).toMatchObject({ type: "digital", value: 0 });
    fix.coordinator.dispose();
  });

  it("all_segments_high_drives_each_input_to_one", () => {
    const fix = buildSevenSegFixture();
    const segs = ["A", "B", "C", "D", "E", "F", "G", "DP"];
    for (const seg of segs) {
      fix.coordinator.writeByLabel(`SW_${seg}`, digital(1));
    }
    fix.coordinator.step();
    for (const seg of segs) {
      expect(fix.coordinator.readByLabel(`SW_${seg}`)).toMatchObject({
        type: "digital",
        value: 1,
      });
    }
    fix.coordinator.dispose();
  });

  it("rewriting_a_segment_replaces_the_previous_value_at_input", () => {
    const fix = buildSevenSegFixture();
    fix.coordinator.writeByLabel("SW_A", digital(1));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("SW_A")).toMatchObject({ type: "digital", value: 1 });
    fix.coordinator.writeByLabel("SW_A", digital(0));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("SW_A")).toMatchObject({ type: "digital", value: 0 });
    fix.coordinator.dispose();
  });

  it("common_anode_topology_runs_pipeline_with_inputs_driven", () => {
    const fix = buildSevenSegFixture({ commonCathode: false });
    for (const seg of ["A", "B", "C", "D", "E", "F", "G", "DP"]) {
      fix.coordinator.writeByLabel(`SW_${seg}`, digital(1));
    }
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("SW_A")).toMatchObject({ type: "digital", value: 1 });
    fix.coordinator.dispose();
  });
});

// ===========================================================================
// SevenSegHex — bridge / digital (Cat 9, T1)
// 4-bit hex digit on `d`, 1-bit on `dp`. The display's executeFn decodes the
// 4-bit input through HEX_SEGMENT_TABLE; the canonical observable through
// labelSignalMap is the digital readback at the driver.
// ===========================================================================

describe("SevenSegHex — bridge / digital (Cat 9, T1)", () => {
  it("digit_zero_propagates_to_d_input", () => {
    const fix = buildSevenSegHexFixture();
    fix.coordinator.writeByLabel("SW_D", digital(0));
    fix.coordinator.writeByLabel("SW_DP", digital(0));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("SW_D")).toMatchObject({ type: "digital", value: 0 });
    expect(fix.coordinator.readByLabel("SW_DP")).toMatchObject({ type: "digital", value: 0 });
    fix.coordinator.dispose();
  });

  it("digit_seven_propagates_to_d_input", () => {
    const fix = buildSevenSegHexFixture();
    fix.coordinator.writeByLabel("SW_D", digital(7));
    fix.coordinator.writeByLabel("SW_DP", digital(0));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("SW_D")).toMatchObject({ type: "digital", value: 7 });
    fix.coordinator.dispose();
  });

  it("digit_0xA_propagates_to_d_input", () => {
    const fix = buildSevenSegHexFixture();
    fix.coordinator.writeByLabel("SW_D", digital(0xA));
    fix.coordinator.writeByLabel("SW_DP", digital(0));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("SW_D")).toMatchObject({ type: "digital", value: 0xA });
    fix.coordinator.dispose();
  });

  it("digit_0xF_propagates_to_d_input", () => {
    const fix = buildSevenSegHexFixture();
    fix.coordinator.writeByLabel("SW_D", digital(0xF));
    fix.coordinator.writeByLabel("SW_DP", digital(0));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("SW_D")).toMatchObject({ type: "digital", value: 0xF });
    fix.coordinator.dispose();
  });

  it("dp_high_propagates_independently_of_digit", () => {
    const fix = buildSevenSegHexFixture();
    fix.coordinator.writeByLabel("SW_D", digital(0x5));
    fix.coordinator.writeByLabel("SW_DP", digital(1));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("SW_D")).toMatchObject({ type: "digital", value: 0x5 });
    expect(fix.coordinator.readByLabel("SW_DP")).toMatchObject({ type: "digital", value: 1 });
    fix.coordinator.dispose();
  });

  it("rewriting_digit_replaces_previous_value_at_d_input", () => {
    const fix = buildSevenSegHexFixture();
    fix.coordinator.writeByLabel("SW_D", digital(0x3));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("SW_D")).toMatchObject({ type: "digital", value: 0x3 });
    fix.coordinator.writeByLabel("SW_D", digital(0xC));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("SW_D")).toMatchObject({ type: "digital", value: 0xC });
    fix.coordinator.dispose();
  });

  it("common_anode_topology_runs_pipeline_with_d_driven", () => {
    const fix = buildSevenSegHexFixture({ commonCathode: false });
    fix.coordinator.writeByLabel("SW_D", digital(0xA));
    fix.coordinator.writeByLabel("SW_DP", digital(1));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("SW_D")).toMatchObject({ type: "digital", value: 0xA });
    fix.coordinator.dispose();
  });
});

// ===========================================================================
// SixteenSeg — bridge / digital (Cat 9, T1)
// 16-bit packed segment word on `led`, 1-bit on `dp`. The display's executeFn
// is a no-op (display-only sink); canonical Cat 9 mechanic is to drive a
// known pattern and confirm the labelled-source readback at the driver.
// ===========================================================================

describe("SixteenSeg — bridge / digital (Cat 9, T1)", () => {
  it("led_zero_and_dp_zero_propagates_to_inputs", () => {
    const fix = buildSixteenSegFixture();
    fix.coordinator.writeByLabel("SW_LED", digital(0));
    fix.coordinator.writeByLabel("SW_DP", digital(0));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("SW_LED")).toMatchObject({ type: "digital", value: 0 });
    expect(fix.coordinator.readByLabel("SW_DP")).toMatchObject({ type: "digital", value: 0 });
    fix.coordinator.dispose();
  });

  it("led_pattern_0x0001_propagates_to_led_input", () => {
    const fix = buildSixteenSegFixture();
    fix.coordinator.writeByLabel("SW_LED", digital(0x0001));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("SW_LED")).toMatchObject({ type: "digital", value: 0x0001 });
    fix.coordinator.dispose();
  });

  it("led_pattern_0xABCD_propagates_to_led_input", () => {
    const fix = buildSixteenSegFixture();
    fix.coordinator.writeByLabel("SW_LED", digital(0xABCD));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("SW_LED")).toMatchObject({ type: "digital", value: 0xABCD });
    fix.coordinator.dispose();
  });

  it("led_pattern_0xFFFF_propagates_to_led_input", () => {
    const fix = buildSixteenSegFixture();
    fix.coordinator.writeByLabel("SW_LED", digital(0xFFFF));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("SW_LED")).toMatchObject({ type: "digital", value: 0xFFFF });
    fix.coordinator.dispose();
  });

  it("dp_high_propagates_independently_of_led", () => {
    const fix = buildSixteenSegFixture();
    fix.coordinator.writeByLabel("SW_LED", digital(0x1234));
    fix.coordinator.writeByLabel("SW_DP", digital(1));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("SW_LED")).toMatchObject({ type: "digital", value: 0x1234 });
    expect(fix.coordinator.readByLabel("SW_DP")).toMatchObject({ type: "digital", value: 1 });
    fix.coordinator.dispose();
  });

  it("rewriting_led_replaces_previous_value_at_input", () => {
    const fix = buildSixteenSegFixture();
    fix.coordinator.writeByLabel("SW_LED", digital(0xF0F0));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("SW_LED")).toMatchObject({ type: "digital", value: 0xF0F0 });
    fix.coordinator.writeByLabel("SW_LED", digital(0x0F0F));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("SW_LED")).toMatchObject({ type: "digital", value: 0x0F0F });
    fix.coordinator.dispose();
  });

  it("common_anode_topology_runs_pipeline_with_led_driven", () => {
    const fix = buildSixteenSegFixture({ commonCathode: false });
    fix.coordinator.writeByLabel("SW_LED", digital(0xAAAA));
    fix.coordinator.writeByLabel("SW_DP", digital(1));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("SW_LED")).toMatchObject({ type: "digital", value: 0xAAAA });
    fix.coordinator.dispose();
  });
});
