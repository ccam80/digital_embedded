import { describe, it, expect } from "vitest";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../../components/register-all.js";

const registry = createDefaultRegistry();

// ---------------------------------------------------------------------------
// Category 9 — Bridge / digital interaction (T1)
//
// Monoflop carries a `models.digital` entry (executeFn / sampleFn,
// inputSchema ["C","R"], outputSchema ["Q","~Q"], stateSlotCount 3) and no
// `modelRegistry` analog models. Capability gate 9 is the only canon
// category that applies: there is no analog state pool, no MNA matrix,
// no DCOP, no junction limiting, no LTE rollback, no breakpoint
// registration via acceptStep, and no analog transient dynamics for a
// paired ngspice run.
//
// Cat 9 worked structure: drive labeled In pins (C, R) through
// facade.setSignal, advance the engine via facade.step, observe labeled
// Out pins (Q, QB) via facade.readSignal. facade.setSignal / step /
// readSignal are thin wrappers over coordinator.writeSignal / step() /
// readSignal i.e. the sanctioned simulator surface from Step 2b's binary
// canonical gate.
// ---------------------------------------------------------------------------

/**
 * Drive a clock pin through one full low-high-low cycle so a single rising
 * edge reaches the Monoflop. The Monoflop's sampleFn detects the 0->1
 * transition of C and arms storedQ=1 with counter=timerDelay; the trailing
 * 1->0 keeps successive calls of this helper independent.
 */
function pulseClock(facade: DefaultSimulatorFacade, coord: ReturnType<DefaultSimulatorFacade["compile"]>, clkLabel: string): void {
  facade.setSignal(coord, clkLabel, 0);
  facade.step(coord);
  facade.setSignal(coord, clkLabel, 1);
  facade.step(coord);
  facade.setSignal(coord, clkLabel, 0);
  facade.step(coord);
}

// ===========================================================================
// Monoflop — monostable multivibrator, edge-triggered pulse generator
// Pin layout: inputs [C, R], outputs [Q, ~Q]
// Property: timerDelay (number of clock ticks Q stays high after trigger)
// ===========================================================================

describe("Monoflop", () => {
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

  it("trigger_rising_edge_sets_q_high", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildMono(facade, 3));
    facade.setSignal(coord, "R", 0);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    expect(facade.readSignal(coord, "QB")).toBe(0);
  });

  it("pulse_returns_low_after_timerDelay_ticks", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const timerDelay = 3;
    const coord = facade.compile(buildMono(facade, timerDelay));
    facade.setSignal(coord, "R", 0);
    // Trigger pulse via rising edge.
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    // Hold C low; advance enough clock ticks to drain the counter.
    // pulseClock above already advanced 3 steps total (one with C=0, one with
    // C=1, one with C=0). Drive additional steps with C steady-low until Q
    // returns to 0. The counter decrements once per step when not
    // retriggered; allow a generous margin.
    facade.setSignal(coord, "C", 0);
    let qFinal = facade.readSignal(coord, "Q");
    for (let i = 0; i < timerDelay + 5 && qFinal === 1; i++) {
      facade.step(coord);
      qFinal = facade.readSignal(coord, "Q");
    }
    expect(qFinal).toBe(0);
    expect(facade.readSignal(coord, "QB")).toBe(1);
  });

  it("retrigger_during_pulse_resets_counter", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const timerDelay = 5;
    const coord = facade.compile(buildMono(facade, timerDelay));
    facade.setSignal(coord, "R", 0);
    // First trigger.
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    // Advance partway through the pulse with C low.
    facade.setSignal(coord, "C", 0);
    facade.step(coord);
    facade.step(coord);
    expect(facade.readSignal(coord, "Q")).toBe(1);
    // Retrigger via a fresh rising edge. The counter should reset to
    // timerDelay, so Q remains high after stepping further than the
    // remaining post-first-trigger budget would have allowed.
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    // Step a couple more times — still within the new pulse window.
    facade.setSignal(coord, "C", 0);
    facade.step(coord);
    facade.step(coord);
    expect(facade.readSignal(coord, "Q")).toBe(1);
  });

  it("r_high_forces_q_low_immediately", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildMono(facade, 5));
    facade.setSignal(coord, "R", 0);
    // Set Q=1 via trigger.
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    // Assert R high. Q must drop to 0 on the next step regardless of
    // remaining counter value.
    facade.setSignal(coord, "C", 0);
    facade.setSignal(coord, "R", 1);
    facade.step(coord);
    expect(facade.readSignal(coord, "Q")).toBe(0);
    expect(facade.readSignal(coord, "QB")).toBe(1);
  });

  it("r_high_prevents_trigger_on_rising_edge", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildMono(facade, 5));
    // Hold R high while delivering a rising edge on C.
    facade.setSignal(coord, "R", 1);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(0);
    expect(facade.readSignal(coord, "QB")).toBe(1);
  });

  it("clock_stays_high_no_trigger", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildMono(facade, 5));
    facade.setSignal(coord, "R", 0);
    // Set C high from the start; without a 0->1 transition, no trigger.
    facade.setSignal(coord, "C", 1);
    facade.step(coord);
    facade.step(coord);
    facade.step(coord);
    expect(facade.readSignal(coord, "Q")).toBe(0);
  });

  it("falling_edge_does_not_trigger", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildMono(facade, 5));
    facade.setSignal(coord, "R", 0);
    // Establish C=1 as the prevClock baseline. Step once with C=1 so the
    // engine records prevClock=1 without seeing a 0->1 transition (initial
    // prevClock is 0; this first step IS a rising edge, so we then must
    // reset). Use R briefly to force Q=0 in case the first step armed it.
    facade.setSignal(coord, "C", 1);
    facade.step(coord);
    facade.setSignal(coord, "R", 1);
    facade.step(coord);
    facade.setSignal(coord, "R", 0);
    facade.step(coord);
    expect(facade.readSignal(coord, "Q")).toBe(0);
    // Now drive only the falling edge 1->0. No new rising edge occurs;
    // Q must remain 0.
    facade.setSignal(coord, "C", 0);
    facade.step(coord);
    expect(facade.readSignal(coord, "Q")).toBe(0);
  });

  it("q_and_qb_complementary", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildMono(facade, 5));
    facade.setSignal(coord, "R", 0);
    // Idle: Q=0, QB=1. Step once to settle outputs from initial state.
    facade.setSignal(coord, "C", 0);
    facade.step(coord);
    const qIdle = facade.readSignal(coord, "Q");
    const qbIdle = facade.readSignal(coord, "QB");
    expect(qIdle).toBe(0);
    expect(qbIdle).toBe(1);
    expect(qIdle + qbIdle).toBe(1);
    // Active: trigger pulse, observe Q=1, QB=0.
    pulseClock(facade, coord, "C");
    const qActive = facade.readSignal(coord, "Q");
    const qbActive = facade.readSignal(coord, "QB");
    expect(qActive).toBe(1);
    expect(qbActive).toBe(0);
    expect(qActive + qbActive).toBe(1);
  });
});
