/**
 * Canonical tests for the D flip-flop (D_FF) behavioral / CMOS / digital
 * model registry. Categories applied:
 *
 *   • Cat 9 (Bridge / digital interaction, T1) — drive labelled D / C inputs
 *     and observe the labelled Q / ~Q outputs through the sanctioned
 *     facade.setSignal / step / readSignal surface. Covers the default
 *     digital truth function on a rising clock edge.
 *   • Cat 10 (Named model preset, T1) — D_FF.modelRegistry exposes two
 *     analog netlist presets (`behavioral`, `cmos`). Each preset replaces
 *     the analog implementation but the documented digital observable
 *     (Q / ~Q after rising-edge capture) is the same closed-form truth as
 *     the default digital model. The canonical Cat 10 assertion compares
 *     the default-model Q / ~Q observable against each preset's Q / ~Q
 *     observable for the same D / C drive sequence.
 *
 * No Cat 1..5 (no analog state slots / DCOP / transient parity at the
 * D_FF level; the behavioural and CMOS subcircuits decompose to leaf
 * elements whose own state is exercised in their dedicated test files).
 * No Cat 6..8 (no junction limiting, no LTE rollback, no breakpoint
 * registration). No Cat 11 (Q / ~Q are trivially complementary). No
 * Cat 12..15.
 */

import { describe, it, expect } from "vitest";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../../components/register-all.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Drive a labelled clock pin through one full low → high → low cycle so a
 * single rising edge reaches the flip-flop. The flip-flop samples D at the
 * 0 → 1 transition; the trailing 1 → 0 keeps successive helper calls
 * independent (each call delivers exactly one rising edge).
 */
function pulseClock(
  facade: DefaultSimulatorFacade,
  coord: ReturnType<DefaultSimulatorFacade["compile"]>,
  clkLabel: string,
): void {
  facade.setSignal(coord, clkLabel, 0);
  facade.step(coord);
  facade.setSignal(coord, clkLabel, 1);
  facade.step(coord);
  facade.setSignal(coord, clkLabel, 0);
  facade.step(coord);
}

// ---------------------------------------------------------------------------
// Category 9 — Bridge / digital interaction (T1)
//
// Default `digital` model. Drives D / C labelled inputs, reads Q / ~Q via
// labelled Out components. The sanctioned binary-canonical-gate path:
// facade.setSignal → facade.step → facade.readSignal (thin wrappers over
// coordinator.writeSignal / step() / readSignal).
// ---------------------------------------------------------------------------

describe("D_FF Cat 9 bridge / digital (default digital model)", () => {
  function buildD(facade: DefaultSimulatorFacade) {
    return facade.build({
      components: [
        { id: "d",  type: "In",  props: { label: "D",  bitWidth: 1 } },
        { id: "c",  type: "In",  props: { label: "C",  bitWidth: 1 } },
        { id: "ff", type: "D_FF" },
        { id: "q",  type: "Out", props: { label: "Q",  bitWidth: 1 } },
        { id: "qb", type: "Out", props: { label: "QB", bitWidth: 1 } },
      ],
      connections: [
        ["d:out",  "ff:D"],
        ["c:out",  "ff:C"],
        ["ff:Q",   "q:in"],
        ["ff:~Q",  "qb:in"],
      ],
    });
  }

  it("d_high_captured_on_rising_edge_drives_q_high_qbar_low", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildD(facade));
    facade.setSignal(coord, "D", 1);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    expect(facade.readSignal(coord, "QB")).toBe(0);
  });

  it("d_low_captured_on_rising_edge_drives_q_low_qbar_high", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildD(facade));
    // Seed Q=1 first so capturing D=0 is an actual change.
    facade.setSignal(coord, "D", 1);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    facade.setSignal(coord, "D", 0);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(0);
    expect(facade.readSignal(coord, "QB")).toBe(1);
  });

  it("q_persists_between_rising_edges_when_clock_idles_low", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildD(facade));
    facade.setSignal(coord, "D", 1);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    // D changes while C is held low → no rising edge → Q stays latched.
    facade.setSignal(coord, "D", 0);
    facade.setSignal(coord, "C", 0);
    facade.step(coord);
    facade.step(coord);
    expect(facade.readSignal(coord, "Q")).toBe(1);
  });

  it("d_change_with_clock_held_high_does_not_capture", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildD(facade));
    // Latch Q=0 by capturing D=0, then drive clock high and hold.
    facade.setSignal(coord, "D", 0);
    facade.setSignal(coord, "C", 0);
    facade.step(coord);
    facade.setSignal(coord, "C", 1);
    facade.step(coord);
    expect(facade.readSignal(coord, "Q")).toBe(0);
    // No new 0 → 1 edge while C remains high → Q must stay 0.
    facade.setSignal(coord, "D", 1);
    facade.step(coord);
    facade.step(coord);
    expect(facade.readSignal(coord, "Q")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Category 10 — Named model preset application (T1)
//
// modelRegistry: { behavioral, cmos } (two entries). The contract digiTS
// owes is that each named preset replaces the analog implementation while
// preserving the documented digital truth function on Q / ~Q. Default
// model is `digital`; each preset's Q / ~Q observable for the same
// rising-edge D = 1 capture must equal the default model's Q / ~Q.
//
// Mechanic: build the same circuit twice — once at default, once with
// `props: { model: "<preset>" }` — drive the same D / C sequence, compare
// the labelled Q / ~Q observables. Closed-form Δ = 0 (presets must
// preserve the digital truth function).
// ---------------------------------------------------------------------------

describe("D_FF Cat 10 named-model preset (analog netlist swap)", () => {
  function buildDForModel(facade: DefaultSimulatorFacade, model?: string) {
    const ff =
      model === undefined
        ? { id: "ff", type: "D_FF" }
        : { id: "ff", type: "D_FF", props: { model } };
    return facade.build({
      components: [
        { id: "d",  type: "In",  props: { label: "D",  bitWidth: 1 } },
        { id: "c",  type: "In",  props: { label: "C",  bitWidth: 1 } },
        ff,
        { id: "q",  type: "Out", props: { label: "Q",  bitWidth: 1 } },
        { id: "qb", type: "Out", props: { label: "QB", bitWidth: 1 } },
      ],
      connections: [
        ["d:out",  "ff:D"],
        ["c:out",  "ff:C"],
        ["ff:Q",   "q:in"],
        ["ff:~Q",  "qb:in"],
      ],
    });
  }

  function captureRisingEdgeD1(model?: string): { q: number; qb: number } {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildDForModel(facade, model));
    facade.setSignal(coord, "D", 1);
    pulseClock(facade, coord, "C");
    facade.step(coord);   // let A2D bridge propagate settled analog Q into digital domain
    return {
      q:  Number(facade.readSignal(coord, "Q")),
      qb: Number(facade.readSignal(coord, "QB")),
    };
  }

  it("behavioral_preset_preserves_digital_truth_q_qbar_after_rising_edge_d1", () => {
    // Default digital model captures D=1 on rising edge → Q=1, ~Q=0.
    const fixDefault = captureRisingEdgeD1(undefined);
    expect(fixDefault.q).toBe(1);
    expect(fixDefault.qb).toBe(0);

    // `behavioral` preset replaces the analog implementation; the
    // documented Q / ~Q truth must match the default. Closed-form Δ = 0.
    const fixBehavioral = captureRisingEdgeD1("behavioral");
    expect(fixBehavioral.q).toBe(fixDefault.q);
    expect(fixBehavioral.qb).toBe(fixDefault.qb);
  });

  it("cmos_preset_preserves_digital_truth_q_qbar_after_rising_edge_d1", () => {
    // Default digital model captures D=1 on rising edge → Q=1, ~Q=0.
    const fixDefault = captureRisingEdgeD1(undefined);
    expect(fixDefault.q).toBe(1);
    expect(fixDefault.qb).toBe(0);

    // `cmos` preset (master-slave transmission-gate netlist) must
    // preserve the same documented Q / ~Q truth as the default model.
    // Closed-form Δ = 0.
    const fixCmos = captureRisingEdgeD1("cmos");
    expect(fixCmos.q).toBe(fixDefault.q);
    expect(fixCmos.qb).toBe(fixDefault.qb);
  });
});
