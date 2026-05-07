import { describe, it, expect } from "vitest";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../register-all.js";
import type { PropertyValue } from "../../../core/properties.js";

// ---------------------------------------------------------------------------
// Counter + CounterPreset canonical test set
// Canon categories: 9 (Bridge / digital interaction), 11 (Multi-output digital)
// File tier: fixture-only (digital-only — both components expose only
// `models.digital.executeFn`; no analog domain, no getLteTimestep, no
// acceptStep, no *lim. Programmatic build via facade.build is the sanctioned
// surface; signals are driven via facade.setSignal and read via
// facade.readSignal.)
//
// Counter: 3 inputs (en, C, clr), 2 outputs (out, ovf).
// CounterPreset: 6 inputs (en, C, dir, in, ld, clr), 2 outputs (out, ovf).
// Both clock pins ("C") are rising-edge triggered.
// ---------------------------------------------------------------------------

const registry = createDefaultRegistry();

interface CounterFixture {
  facade: DefaultSimulatorFacade;
  coordinator: ReturnType<DefaultSimulatorFacade["compile"]>;
}

function buildCounterFixture(opts: { bitWidth?: number } = {}): CounterFixture {
  const bitWidth = opts.bitWidth ?? 4;
  const components: Array<{ id: string; type: string; props: Record<string, PropertyValue> }> = [
    { id: "in_en",  type: "In",      props: { label: "EN",  bitWidth: 1 } },
    { id: "in_c",   type: "In",      props: { label: "CLK", bitWidth: 1 } },
    { id: "in_clr", type: "In",      props: { label: "CLR", bitWidth: 1 } },
    { id: "cnt",    type: "Counter", props: { label: "CNT", bitWidth } },
    { id: "out_q",  type: "Out",     props: { label: "Q",   bitWidth } },
    { id: "out_ov", type: "Out",     props: { label: "OVF", bitWidth: 1 } },
  ];
  const connections: Array<[string, string]> = [
    ["in_en:out",  "cnt:en"],
    ["in_c:out",   "cnt:C"],
    ["in_clr:out", "cnt:clr"],
    ["cnt:out",    "out_q:in"],
    ["cnt:ovf",    "out_ov:in"],
  ];

  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({ components, connections });
  const coordinator = facade.compile(circuit);
  return { facade, coordinator };
}

interface CounterPresetFixture {
  facade: DefaultSimulatorFacade;
  coordinator: ReturnType<DefaultSimulatorFacade["compile"]>;
}

function buildCounterPresetFixture(opts: {
  bitWidth?: number;
  maxValue?: number;
} = {}): CounterPresetFixture {
  const bitWidth = opts.bitWidth ?? 4;
  const maxValue = opts.maxValue ?? 0;
  const components: Array<{ id: string; type: string; props: Record<string, PropertyValue> }> = [
    { id: "in_en",  type: "In",            props: { label: "EN",  bitWidth: 1 } },
    { id: "in_c",   type: "In",            props: { label: "CLK", bitWidth: 1 } },
    { id: "in_dir", type: "In",            props: { label: "DIR", bitWidth: 1 } },
    { id: "in_in",  type: "In",            props: { label: "IN",  bitWidth } },
    { id: "in_ld",  type: "In",            props: { label: "LD",  bitWidth: 1 } },
    { id: "in_clr", type: "In",            props: { label: "CLR", bitWidth: 1 } },
    { id: "cnt",    type: "CounterPreset", props: { label: "CNT", bitWidth, maxValue } },
    { id: "out_q",  type: "Out",           props: { label: "Q",   bitWidth } },
    { id: "out_ov", type: "Out",           props: { label: "OVF", bitWidth: 1 } },
  ];
  const connections: Array<[string, string]> = [
    ["in_en:out",  "cnt:en"],
    ["in_c:out",   "cnt:C"],
    ["in_dir:out", "cnt:dir"],
    ["in_in:out",  "cnt:in"],
    ["in_ld:out",  "cnt:ld"],
    ["in_clr:out", "cnt:clr"],
    ["cnt:out",    "out_q:in"],
    ["cnt:ovf",    "out_ov:in"],
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
function risingEdge(fix: CounterFixture | CounterPresetFixture): void {
  fix.facade.setSignal(fix.coordinator, "CLK", 0);
  fix.facade.step(fix.coordinator);
  fix.facade.setSignal(fix.coordinator, "CLK", 1);
  fix.facade.step(fix.coordinator);
}

// ===========================================================================
// Counter — Cat 9 + Cat 11
// ===========================================================================

describe("Counter — bridge / digital (T1)", () => {
  it("count_up_one_edge_with_en_high_drives_out_to_one", () => {
    // Documented contract: en=1, clr=0 → on rising edge, counter increments
    // from 0 to 1; OUT pin reflects new counter value.
    const fix = buildCounterFixture({ bitWidth: 4 });
    fix.facade.setSignal(fix.coordinator, "EN", 1);
    fix.facade.setSignal(fix.coordinator, "CLR", 0);
    risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(1);
    fix.coordinator.dispose();
  });

  it("count_up_three_edges_drives_out_to_three", () => {
    // Documented contract: three rising edges with en=1 increment counter to 3.
    const fix = buildCounterFixture({ bitWidth: 4 });
    fix.facade.setSignal(fix.coordinator, "EN", 1);
    fix.facade.setSignal(fix.coordinator, "CLR", 0);
    risingEdge(fix);
    risingEdge(fix);
    risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(3);
    fix.coordinator.dispose();
  });

  it("wrap_from_max_to_zero_4bit", () => {
    // Documented contract: counter wraps from maxValue (15 for bitWidth=4)
    // back to 0 on the next rising edge.
    const fix = buildCounterFixture({ bitWidth: 4 });
    fix.facade.setSignal(fix.coordinator, "EN", 1);
    fix.facade.setSignal(fix.coordinator, "CLR", 0);
    for (let i = 0; i < 15; i++) risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(15);
    risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(0);
    fix.coordinator.dispose();
  });

  it("wrap_from_max_to_zero_8bit", () => {
    // Documented contract: maxValue scales with bitWidth; for bitWidth=8 the
    // wrap point is 255.
    const fix = buildCounterFixture({ bitWidth: 8 });
    fix.facade.setSignal(fix.coordinator, "EN", 1);
    fix.facade.setSignal(fix.coordinator, "CLR", 0);
    for (let i = 0; i < 255; i++) risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(255);
    risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(0);
    fix.coordinator.dispose();
  });

  it("clr_resets_counter_to_zero_on_clock_edge", () => {
    // Documented contract: clr=1 forces counter to 0 on the rising edge,
    // takes priority over the increment path.
    const fix = buildCounterFixture({ bitWidth: 4 });
    fix.facade.setSignal(fix.coordinator, "EN", 1);
    fix.facade.setSignal(fix.coordinator, "CLR", 0);
    risingEdge(fix);
    risingEdge(fix);
    risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(3);

    fix.facade.setSignal(fix.coordinator, "CLR", 1);
    risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(0);
    fix.coordinator.dispose();
  });

  it("en_low_holds_counter_unchanged_on_clock_edge", () => {
    // Documented contract: en=0 → counter does not increment on rising edge.
    const fix = buildCounterFixture({ bitWidth: 4 });
    fix.facade.setSignal(fix.coordinator, "EN", 1);
    fix.facade.setSignal(fix.coordinator, "CLR", 0);
    risingEdge(fix);
    risingEdge(fix);
    risingEdge(fix);
    risingEdge(fix);
    risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(5);

    fix.facade.setSignal(fix.coordinator, "EN", 0);
    risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(5);
    fix.coordinator.dispose();
  });

  it("falling_edge_does_not_increment", () => {
    // Documented contract: only rising edges advance the counter.
    const fix = buildCounterFixture({ bitWidth: 4 });
    fix.facade.setSignal(fix.coordinator, "EN", 1);
    fix.facade.setSignal(fix.coordinator, "CLR", 0);
    risingEdge(fix);
    risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(2);

    // Falling edge sequence: CLK=1 → CLK=0.
    fix.facade.setSignal(fix.coordinator, "CLK", 1);
    fix.facade.step(fix.coordinator);
    fix.facade.setSignal(fix.coordinator, "CLK", 0);
    fix.facade.step(fix.coordinator);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(2);
    fix.coordinator.dispose();
  });

  // ---- Cat 11 — multi-output digital observability (out + ovf) -----------

  it("ovf_high_at_max_value_with_en_high_independent_of_out", () => {
    // Documented contract: ovf=1 when counter==maxValue AND en=1; out=
    // counter value. Both pins are observed independently after a single
    // step (not packed into one read).
    const fix = buildCounterFixture({ bitWidth: 4 });
    fix.facade.setSignal(fix.coordinator, "EN", 1);
    fix.facade.setSignal(fix.coordinator, "CLR", 0);
    for (let i = 0; i < 15; i++) risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(15);
    expect(fix.facade.readSignal(fix.coordinator, "OVF")).toBe(1);
    fix.coordinator.dispose();
  });

  it("ovf_low_below_max_value_independent_of_out", () => {
    // Documented contract: ovf=0 while counter < maxValue regardless of en.
    const fix = buildCounterFixture({ bitWidth: 4 });
    fix.facade.setSignal(fix.coordinator, "EN", 1);
    fix.facade.setSignal(fix.coordinator, "CLR", 0);
    for (let i = 0; i < 7; i++) risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(7);
    expect(fix.facade.readSignal(fix.coordinator, "OVF")).toBe(0);
    fix.coordinator.dispose();
  });

  it("ovf_low_at_max_when_en_low_independent_of_out", () => {
    // Documented contract: ovf gated on en; counter at maxValue with en=0
    // → ovf=0 (the count would not advance, so no overflow event).
    const fix = buildCounterFixture({ bitWidth: 4 });
    fix.facade.setSignal(fix.coordinator, "EN", 1);
    fix.facade.setSignal(fix.coordinator, "CLR", 0);
    for (let i = 0; i < 15; i++) risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(15);
    expect(fix.facade.readSignal(fix.coordinator, "OVF")).toBe(1);

    fix.facade.setSignal(fix.coordinator, "EN", 0);
    fix.facade.step(fix.coordinator);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(15);
    expect(fix.facade.readSignal(fix.coordinator, "OVF")).toBe(0);
    fix.coordinator.dispose();
  });
});

// ===========================================================================
// CounterPreset — Cat 9 + Cat 11
// ===========================================================================

describe("CounterPreset — bridge / digital (T1)", () => {
  it("count_up_one_edge_with_en_high_dir_low_drives_out_to_one", () => {
    // Documented contract: dir=0 → up-counter; en=1 → first rising edge
    // advances counter from 0 to 1.
    const fix = buildCounterPresetFixture({ bitWidth: 4 });
    fix.facade.setSignal(fix.coordinator, "EN", 1);
    fix.facade.setSignal(fix.coordinator, "DIR", 0);
    fix.facade.setSignal(fix.coordinator, "CLR", 0);
    fix.facade.setSignal(fix.coordinator, "LD", 0);
    fix.facade.setSignal(fix.coordinator, "IN", 0);
    risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(1);
    fix.coordinator.dispose();
  });

  it("count_down_one_edge_with_en_high_dir_high_decrements_from_five_to_four", () => {
    // Documented contract: dir=1 → down-counter; first load via ld then
    // a count-down edge yields 5→4.
    const fix = buildCounterPresetFixture({ bitWidth: 4 });
    fix.facade.setSignal(fix.coordinator, "EN", 1);
    fix.facade.setSignal(fix.coordinator, "DIR", 0);
    fix.facade.setSignal(fix.coordinator, "CLR", 0);
    fix.facade.setSignal(fix.coordinator, "LD", 1);
    fix.facade.setSignal(fix.coordinator, "IN", 5);
    risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(5);

    fix.facade.setSignal(fix.coordinator, "LD", 0);
    fix.facade.setSignal(fix.coordinator, "DIR", 1);
    risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(4);
    fix.coordinator.dispose();
  });

  it("count_up_wraps_from_max_to_zero_4bit", () => {
    // Documented contract: when counting up, wraps from maxValue back to 0.
    // For bitWidth=4 with maxValue=0 (defaulting to mask 15), wrap from 15→0.
    const fix = buildCounterPresetFixture({ bitWidth: 4 });
    fix.facade.setSignal(fix.coordinator, "EN", 1);
    fix.facade.setSignal(fix.coordinator, "DIR", 0);
    fix.facade.setSignal(fix.coordinator, "CLR", 0);
    fix.facade.setSignal(fix.coordinator, "LD", 1);
    fix.facade.setSignal(fix.coordinator, "IN", 15);
    risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(15);

    fix.facade.setSignal(fix.coordinator, "LD", 0);
    risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(0);
    fix.coordinator.dispose();
  });

  it("count_down_wraps_from_zero_to_max_4bit", () => {
    // Documented contract: when counting down (dir=1), wraps from 0 back to
    // maxValue (15 for bitWidth=4 with maxValue=0).
    const fix = buildCounterPresetFixture({ bitWidth: 4 });
    fix.facade.setSignal(fix.coordinator, "EN", 1);
    fix.facade.setSignal(fix.coordinator, "DIR", 1);
    fix.facade.setSignal(fix.coordinator, "CLR", 0);
    fix.facade.setSignal(fix.coordinator, "LD", 0);
    fix.facade.setSignal(fix.coordinator, "IN", 0);
    risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(15);
    fix.coordinator.dispose();
  });

  it("clr_resets_counter_to_zero_on_clock_edge", () => {
    // Documented contract: clr=1 takes priority on rising edge; counter→0.
    const fix = buildCounterPresetFixture({ bitWidth: 4 });
    fix.facade.setSignal(fix.coordinator, "EN", 1);
    fix.facade.setSignal(fix.coordinator, "DIR", 0);
    fix.facade.setSignal(fix.coordinator, "CLR", 0);
    fix.facade.setSignal(fix.coordinator, "LD", 1);
    fix.facade.setSignal(fix.coordinator, "IN", 7);
    risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(7);

    fix.facade.setSignal(fix.coordinator, "LD", 0);
    fix.facade.setSignal(fix.coordinator, "CLR", 1);
    risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(0);
    fix.coordinator.dispose();
  });

  it("clr_takes_priority_over_ld", () => {
    // Documented contract: clr=1 with ld=1 simultaneously → counter=0 (clr
    // priority documented in counter-preset.ts header comment).
    const fix = buildCounterPresetFixture({ bitWidth: 4 });
    fix.facade.setSignal(fix.coordinator, "EN", 1);
    fix.facade.setSignal(fix.coordinator, "DIR", 0);
    fix.facade.setSignal(fix.coordinator, "CLR", 0);
    fix.facade.setSignal(fix.coordinator, "LD", 1);
    fix.facade.setSignal(fix.coordinator, "IN", 7);
    risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(7);

    fix.facade.setSignal(fix.coordinator, "CLR", 1);
    fix.facade.setSignal(fix.coordinator, "IN", 9);
    risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(0);
    fix.coordinator.dispose();
  });

  it("ld_loads_in_value_when_clr_is_zero", () => {
    // Documented contract: ld=1, clr=0 → counter takes value from 'in' on
    // rising edge.
    const fix = buildCounterPresetFixture({ bitWidth: 4 });
    fix.facade.setSignal(fix.coordinator, "EN", 1);
    fix.facade.setSignal(fix.coordinator, "DIR", 0);
    fix.facade.setSignal(fix.coordinator, "CLR", 0);
    fix.facade.setSignal(fix.coordinator, "LD", 1);
    fix.facade.setSignal(fix.coordinator, "IN", 9);
    risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(9);
    fix.coordinator.dispose();
  });

  it("en_low_holds_counter_unchanged_on_clock_edge", () => {
    // Documented contract: en=0 → counter does not advance on rising edge.
    const fix = buildCounterPresetFixture({ bitWidth: 4 });
    fix.facade.setSignal(fix.coordinator, "EN", 1);
    fix.facade.setSignal(fix.coordinator, "DIR", 0);
    fix.facade.setSignal(fix.coordinator, "CLR", 0);
    fix.facade.setSignal(fix.coordinator, "LD", 1);
    fix.facade.setSignal(fix.coordinator, "IN", 7);
    risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(7);

    fix.facade.setSignal(fix.coordinator, "LD", 0);
    fix.facade.setSignal(fix.coordinator, "EN", 0);
    risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(7);
    fix.coordinator.dispose();
  });

  it("custom_max_value_wraps_at_nine_when_counting_up", () => {
    // Documented contract: maxValue property sets the wrap-around value.
    // With maxValue=9, counter at 9 wraps to 0 on the next up-edge.
    const fix = buildCounterPresetFixture({ bitWidth: 4, maxValue: 9 });
    fix.facade.setSignal(fix.coordinator, "EN", 1);
    fix.facade.setSignal(fix.coordinator, "DIR", 0);
    fix.facade.setSignal(fix.coordinator, "CLR", 0);
    fix.facade.setSignal(fix.coordinator, "LD", 1);
    fix.facade.setSignal(fix.coordinator, "IN", 9);
    risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(9);

    fix.facade.setSignal(fix.coordinator, "LD", 0);
    risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(0);
    fix.coordinator.dispose();
  });

  it("custom_max_value_wraps_to_max_when_counting_down_from_zero", () => {
    // Documented contract: down-counting from 0 wraps to maxValue.
    // With maxValue=9, 0 → 9 on the down-edge.
    const fix = buildCounterPresetFixture({ bitWidth: 4, maxValue: 9 });
    fix.facade.setSignal(fix.coordinator, "EN", 1);
    fix.facade.setSignal(fix.coordinator, "DIR", 1);
    fix.facade.setSignal(fix.coordinator, "CLR", 0);
    fix.facade.setSignal(fix.coordinator, "LD", 0);
    fix.facade.setSignal(fix.coordinator, "IN", 0);
    risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(9);
    fix.coordinator.dispose();
  });

  // ---- Cat 11 — multi-output digital observability (out + ovf) -----------

  it("ovf_high_at_max_value_when_counting_up_with_en_high_independent_of_out", () => {
    // Documented contract: when counting up (dir=0), ovf=1 at maxValue.
    // out and ovf observed independently after a single step.
    const fix = buildCounterPresetFixture({ bitWidth: 4 });
    fix.facade.setSignal(fix.coordinator, "EN", 1);
    fix.facade.setSignal(fix.coordinator, "DIR", 0);
    fix.facade.setSignal(fix.coordinator, "CLR", 0);
    fix.facade.setSignal(fix.coordinator, "LD", 1);
    fix.facade.setSignal(fix.coordinator, "IN", 15);
    risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(15);
    expect(fix.facade.readSignal(fix.coordinator, "OVF")).toBe(1);
    fix.coordinator.dispose();
  });

  it("ovf_high_at_zero_when_counting_down_with_en_high_independent_of_out", () => {
    // Documented contract: when counting down (dir=1), ovf=1 at 0 (the
    // down-direction overflow event).
    const fix = buildCounterPresetFixture({ bitWidth: 4 });
    fix.facade.setSignal(fix.coordinator, "EN", 1);
    fix.facade.setSignal(fix.coordinator, "DIR", 1);
    fix.facade.setSignal(fix.coordinator, "CLR", 1);
    fix.facade.setSignal(fix.coordinator, "LD", 0);
    fix.facade.setSignal(fix.coordinator, "IN", 0);
    risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(0);
    expect(fix.facade.readSignal(fix.coordinator, "OVF")).toBe(1);
    fix.coordinator.dispose();
  });

  it("ovf_low_below_overflow_position_independent_of_out", () => {
    // Documented contract: ovf=0 when counter is not at the overflow
    // boundary for the active direction.
    const fix = buildCounterPresetFixture({ bitWidth: 4 });
    fix.facade.setSignal(fix.coordinator, "EN", 1);
    fix.facade.setSignal(fix.coordinator, "DIR", 0);
    fix.facade.setSignal(fix.coordinator, "CLR", 0);
    fix.facade.setSignal(fix.coordinator, "LD", 1);
    fix.facade.setSignal(fix.coordinator, "IN", 7);
    risingEdge(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(7);
    expect(fix.facade.readSignal(fix.coordinator, "OVF")).toBe(0);
    fix.coordinator.dispose();
  });
});
