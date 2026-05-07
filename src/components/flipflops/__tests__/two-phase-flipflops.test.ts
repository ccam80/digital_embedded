import { describe, it, expect } from "vitest";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../../components/register-all.js";

const registry = createDefaultRegistry();

// ---------------------------------------------------------------------------
// Category 9 — Bridge / digital interaction (T1)
//
// Every flip-flop covered here (D_FF, D_FF_AS, JK_FF, JK_FF_AS, RS_FF,
// RS_FF_AS, T_FF withEnable={true,false}, Monoflop) carries a `models.digital`
// entry; capability gate 9 is the only canon category that applies. Categories
// 1-8 do not apply to pure digital components: there is no analog state pool,
// no MNA matrix, no DCOP, no junction limiting, no LTE rollback, no breakpoint
// registration via acceptStep, and no analog transient dynamics for a paired
// ngspice run.
//
// The file's authoring purpose is the two-phase split (sample phase reads
// inputs / updates internal state on edges; execute phase drives outputs from
// state). That split is an internal scheduling detail of the digital engine
// pipeline; the canonical observable at the simulator surface is the
// post-step output read via coordinator.readSignal. Each canonical it()
// drives inputs through facade.setSignal, advances the engine via
// facade.step, and observes labeled Out pins via facade.readSignal — these
// are thin wrappers over coordinator.writeSignal / step() / readSignal i.e.
// the sanctioned simulator surface from Step 2b's binary canonical gate.
// ---------------------------------------------------------------------------

/**
 * Drive a clock pin through one full low-high-low cycle so a single rising
 * edge reaches the flip-flop. The flip-flop's sample phase observes the 0->1
 * transition of C and updates internal state; the execute phase then drives
 * Q / ~Q from the updated state. The trailing 1->0 keeps successive calls
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

// ===========================================================================
// D_FF — sample phase latches D on rising clock edge; execute phase drives
//         Q / ~Q from latched state.
// ===========================================================================

describe("D_FF two-phase observable (Cat 9)", () => {
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

  it("rising_edge_latches_d_high_then_executes_q_high", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildD(facade));
    facade.setSignal(coord, "D", 1);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    expect(facade.readSignal(coord, "QB")).toBe(0);
  });

  it("falling_edge_does_not_latch", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildD(facade));
    // Establish C high with D=0 by stepping at C=1 (sees first 0->1, latches Q=0).
    facade.setSignal(coord, "D", 0);
    facade.setSignal(coord, "C", 0);
    facade.step(coord);
    facade.setSignal(coord, "C", 1);
    facade.step(coord);
    expect(facade.readSignal(coord, "Q")).toBe(0);
    // Drive only the falling edge with D=1 — Q must remain 0 (no rising edge).
    facade.setSignal(coord, "D", 1);
    facade.setSignal(coord, "C", 0);
    facade.step(coord);
    expect(facade.readSignal(coord, "Q")).toBe(0);
  });

  it("execute_drives_q_from_state_not_inputs", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildD(facade));
    // Latch Q=0 via rising edge with D=0.
    facade.setSignal(coord, "D", 0);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(0);
    // Now hold C high (no new rising edge) and change D=1. Execute phase reads
    // state, not D — Q must stay 0.
    facade.setSignal(coord, "D", 1);
    facade.setSignal(coord, "C", 1);
    facade.step(coord);
    facade.step(coord);
    expect(facade.readSignal(coord, "Q")).toBe(0);
  });
});

// ===========================================================================
// D_FF_AS — async D flip-flop. The async path has no separate sample phase;
//   the spec asserts that async Set / Clr override the latched state and
//   propagate without a clock edge.
// ===========================================================================

describe("D_FF_AS async-override observable (Cat 9)", () => {
  function buildDAsync(facade: DefaultSimulatorFacade) {
    return facade.build({
      components: [
        { id: "set", type: "In",      props: { label: "SET", bitWidth: 1 } },
        { id: "d",   type: "In",      props: { label: "D",   bitWidth: 1 } },
        { id: "c",   type: "In",      props: { label: "C",   bitWidth: 1 } },
        { id: "clr", type: "In",      props: { label: "CLR", bitWidth: 1 } },
        { id: "ff",  type: "D_FF_AS" },
        { id: "q",   type: "Out",     props: { label: "Q",   bitWidth: 1 } },
        { id: "qb",  type: "Out",     props: { label: "QB",  bitWidth: 1 } },
      ],
      connections: [
        ["set:out", "ff:Set"],
        ["d:out",   "ff:D"],
        ["c:out",   "ff:C"],
        ["clr:out", "ff:Clr"],
        ["ff:Q",    "q:in"],
        ["ff:~Q",   "qb:in"],
      ],
    });
  }

  it("async_set_drives_q_high_without_clock_edge", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildDAsync(facade));
    facade.setSignal(coord, "SET", 0);
    facade.setSignal(coord, "CLR", 0);
    facade.setSignal(coord, "D", 0);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(0);
    // No new clock edge — assert Set and step.
    facade.setSignal(coord, "SET", 1);
    facade.step(coord);
    expect(facade.readSignal(coord, "Q")).toBe(1);
    expect(facade.readSignal(coord, "QB")).toBe(0);
  });

  it("async_clr_drives_q_low_without_clock_edge", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildDAsync(facade));
    facade.setSignal(coord, "SET", 0);
    facade.setSignal(coord, "CLR", 0);
    facade.setSignal(coord, "D", 1);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    facade.setSignal(coord, "CLR", 1);
    facade.step(coord);
    expect(facade.readSignal(coord, "Q")).toBe(0);
    expect(facade.readSignal(coord, "QB")).toBe(1);
  });
});

// ===========================================================================
// JK_FF — sample phase computes next state from J/K on rising edge; execute
//         phase drives Q / ~Q from state.
// ===========================================================================

describe("JK_FF two-phase observable (Cat 9)", () => {
  function buildJK(facade: DefaultSimulatorFacade) {
    return facade.build({
      components: [
        { id: "j",  type: "In",  props: { label: "J",  bitWidth: 1 } },
        { id: "c",  type: "In",  props: { label: "C",  bitWidth: 1 } },
        { id: "k",  type: "In",  props: { label: "K",  bitWidth: 1 } },
        { id: "ff", type: "JK_FF" },
        { id: "q",  type: "Out", props: { label: "Q",  bitWidth: 1 } },
        { id: "qb", type: "Out", props: { label: "QB", bitWidth: 1 } },
      ],
      connections: [
        ["j:out",  "ff:J"],
        ["c:out",  "ff:C"],
        ["k:out",  "ff:K"],
        ["ff:Q",   "q:in"],
        ["ff:~Q",  "qb:in"],
      ],
    });
  }

  it("rising_edge_with_j_high_computes_set_then_executes_q_high", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildJK(facade));
    facade.setSignal(coord, "J", 1);
    facade.setSignal(coord, "K", 0);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    expect(facade.readSignal(coord, "QB")).toBe(0);
  });

  it("rising_edge_with_jk_high_computes_toggle_then_executes_inverted_q", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildJK(facade));
    // Set Q=1 via J=1, K=0.
    facade.setSignal(coord, "J", 1);
    facade.setSignal(coord, "K", 0);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    // J=1, K=1 toggles: Q must become 0.
    facade.setSignal(coord, "J", 1);
    facade.setSignal(coord, "K", 1);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(0);
    expect(facade.readSignal(coord, "QB")).toBe(1);
  });
});

// ===========================================================================
// JK_FF_AS — async JK flip-flop. Async Set / Clr override state without a
//   clock edge.
// ===========================================================================

describe("JK_FF_AS async-override observable (Cat 9)", () => {
  function buildJKAsync(facade: DefaultSimulatorFacade) {
    return facade.build({
      components: [
        { id: "set", type: "In",       props: { label: "SET", bitWidth: 1 } },
        { id: "j",   type: "In",       props: { label: "J",   bitWidth: 1 } },
        { id: "c",   type: "In",       props: { label: "C",   bitWidth: 1 } },
        { id: "k",   type: "In",       props: { label: "K",   bitWidth: 1 } },
        { id: "clr", type: "In",       props: { label: "CLR", bitWidth: 1 } },
        { id: "ff",  type: "JK_FF_AS" },
        { id: "q",   type: "Out",      props: { label: "Q",   bitWidth: 1 } },
        { id: "qb",  type: "Out",      props: { label: "QB",  bitWidth: 1 } },
      ],
      connections: [
        ["set:out", "ff:Set"],
        ["j:out",   "ff:J"],
        ["c:out",   "ff:C"],
        ["k:out",   "ff:K"],
        ["clr:out", "ff:Clr"],
        ["ff:Q",    "q:in"],
        ["ff:~Q",   "qb:in"],
      ],
    });
  }

  it("async_set_drives_q_high_without_clock_edge", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildJKAsync(facade));
    facade.setSignal(coord, "SET", 0);
    facade.setSignal(coord, "CLR", 0);
    facade.setSignal(coord, "J", 0);
    facade.setSignal(coord, "K", 1);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(0);
    facade.setSignal(coord, "SET", 1);
    facade.step(coord);
    expect(facade.readSignal(coord, "Q")).toBe(1);
    expect(facade.readSignal(coord, "QB")).toBe(0);
  });
});

// ===========================================================================
// RS_FF — sample phase latches set/reset on rising clock edge; execute phase
//         drives Q / ~Q from state.
// ===========================================================================

describe("RS_FF two-phase observable (Cat 9)", () => {
  function buildRS(facade: DefaultSimulatorFacade) {
    return facade.build({
      components: [
        { id: "s",  type: "In",  props: { label: "S",  bitWidth: 1 } },
        { id: "c",  type: "In",  props: { label: "C",  bitWidth: 1 } },
        { id: "r",  type: "In",  props: { label: "R",  bitWidth: 1 } },
        { id: "ff", type: "RS_FF" },
        { id: "q",  type: "Out", props: { label: "Q",  bitWidth: 1 } },
        { id: "qb", type: "Out", props: { label: "QB", bitWidth: 1 } },
      ],
      connections: [
        ["s:out",  "ff:S"],
        ["c:out",  "ff:C"],
        ["r:out",  "ff:R"],
        ["ff:Q",   "q:in"],
        ["ff:~Q",  "qb:in"],
      ],
    });
  }

  it("rising_edge_with_s_high_latches_set_then_executes_q_high", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildRS(facade));
    facade.setSignal(coord, "S", 1);
    facade.setSignal(coord, "R", 0);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    expect(facade.readSignal(coord, "QB")).toBe(0);
  });

  it("rising_edge_with_r_high_latches_reset_then_executes_q_low", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildRS(facade));
    // Pre-set Q=1.
    facade.setSignal(coord, "S", 1);
    facade.setSignal(coord, "R", 0);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    // Reset.
    facade.setSignal(coord, "S", 0);
    facade.setSignal(coord, "R", 1);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(0);
    expect(facade.readSignal(coord, "QB")).toBe(1);
  });
});

// ===========================================================================
// T_FF — withEnable=true variant: sample phase toggles state on rising edge
//         when T=1; execute phase drives Q / ~Q from state.
// ===========================================================================

describe("T_FF withEnable=true two-phase observable (Cat 9)", () => {
  function buildTWithEnable(facade: DefaultSimulatorFacade) {
    return facade.build({
      components: [
        { id: "t",  type: "In",   props: { label: "T",  bitWidth: 1 } },
        { id: "c",  type: "In",   props: { label: "C",  bitWidth: 1 } },
        { id: "ff", type: "T_FF", props: { withEnable: true } },
        { id: "q",  type: "Out",  props: { label: "Q",  bitWidth: 1 } },
        { id: "qb", type: "Out",  props: { label: "QB", bitWidth: 1 } },
      ],
      connections: [
        ["t:out",  "ff:T"],
        ["c:out",  "ff:C"],
        ["ff:Q",   "q:in"],
        ["ff:~Q",  "qb:in"],
      ],
    });
  }

  it("rising_edge_with_t_high_toggles_state_then_executes_q_high", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildTWithEnable(facade));
    facade.setSignal(coord, "T", 1);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    expect(facade.readSignal(coord, "QB")).toBe(0);
  });

  it("two_consecutive_rising_edges_with_t_high_toggle_back_to_zero", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildTWithEnable(facade));
    facade.setSignal(coord, "T", 1);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(0);
    expect(facade.readSignal(coord, "QB")).toBe(1);
  });
});

// ===========================================================================
// T_FF — withEnable=false variant: no T pin; sample phase unconditionally
//         toggles state on every rising edge; execute phase drives Q / ~Q
//         from state.
// ===========================================================================

describe("T_FF withEnable=false two-phase observable (Cat 9)", () => {
  function buildTNoEnable(facade: DefaultSimulatorFacade) {
    return facade.build({
      components: [
        { id: "c",  type: "In",   props: { label: "C",  bitWidth: 1 } },
        { id: "ff", type: "T_FF", props: { withEnable: false } },
        { id: "q",  type: "Out",  props: { label: "Q",  bitWidth: 1 } },
        { id: "qb", type: "Out",  props: { label: "QB", bitWidth: 1 } },
      ],
      connections: [
        ["c:out",  "ff:C"],
        ["ff:Q",   "q:in"],
        ["ff:~Q",  "qb:in"],
      ],
    });
  }

  it("rising_edge_unconditionally_toggles_state_then_executes_q_high", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildTNoEnable(facade));
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    expect(facade.readSignal(coord, "QB")).toBe(0);
  });

  it("two_consecutive_rising_edges_toggle_back_to_zero", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildTNoEnable(facade));
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(0);
    expect(facade.readSignal(coord, "QB")).toBe(1);
  });
});

// ===========================================================================
// Monoflop — sample phase arms internal counter on rising clock edge; execute
//         phase drives Q from counter / state.
// ===========================================================================

describe("Monoflop two-phase observable (Cat 9)", () => {
  function buildMono(facade: DefaultSimulatorFacade, timerDelay: number) {
    return facade.build({
      components: [
        { id: "c",  type: "In",       props: { label: "C",  bitWidth: 1 } },
        { id: "r",  type: "In",       props: { label: "R",  bitWidth: 1 } },
        { id: "m",  type: "Monoflop", props: { timerDelay } },
        { id: "q",  type: "Out",      props: { label: "Q",  bitWidth: 1 } },
        { id: "qb", type: "Out",      props: { label: "QB", bitWidth: 1 } },
      ],
      connections: [
        ["c:out",  "m:C"],
        ["r:out",  "m:R"],
        ["m:Q",    "q:in"],
        ["m:~Q",   "qb:in"],
      ],
    });
  }

  it("rising_edge_arms_counter_then_executes_q_high", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildMono(facade, 5));
    facade.setSignal(coord, "R", 0);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    expect(facade.readSignal(coord, "QB")).toBe(0);
  });
});
