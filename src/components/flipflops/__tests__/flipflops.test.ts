import { describe, it, expect } from "vitest";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../../components/register-all.js";

const registry = createDefaultRegistry();

// ---------------------------------------------------------------------------
// Category 9 — Bridge / digital interaction (T1)
//
// Every flip-flop in this file carries a `models.digital` entry; capability
// gate 9 is satisfied by all of them. Categories 1-8 do not apply to pure
// digital components: there is no analog state pool, no MNA matrix, no DCOP,
// no junction limiting, no LTE rollback, no breakpoint registration via
// acceptStep, and no analog transient dynamics for a paired ngspice run.
//
// Cat 9 worked structure: drive labeled In / Clock pins through
// facade.setSignal, advance the engine via facade.step, observe labeled Out
// pins via facade.readSignal. facade.setSignal / step / readSignal are thin
// wrappers over coordinator.writeSignal / step() / readSignal i.e. the
// sanctioned simulator surface from Step 2b's binary canonical gate.
// ---------------------------------------------------------------------------

/**
 * Drive a clock pin through one full low-high-low cycle so a single rising
 * edge reaches the flip-flop. The flip-flop samples the data inputs at the
 * 0->1 transition of C; the trailing 1->0 keeps successive calls of this
 * helper independent (each call delivers exactly one rising edge).
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
// D Flip-Flop (D_FF) — edge-triggered D latch
// Pin layout: inputs [D, C], outputs [Q, ~Q]
// ===========================================================================

describe("D_FF (Cat 9 bridge / digital)", () => {
  function buildD(facade: DefaultSimulatorFacade) {
    return facade.build({
      components: [
        { id: "d",   type: "In",  props: { label: "D",  bitWidth: 1 } },
        { id: "c",   type: "In",  props: { label: "C",  bitWidth: 1 } },
        { id: "ff",  type: "D_FF" },
        { id: "q",   type: "Out", props: { label: "Q",  bitWidth: 1 } },
        { id: "qb",  type: "Out", props: { label: "QB", bitWidth: 1 } },
      ],
      connections: [
        ["d:out",  "ff:D"],
        ["c:out",  "ff:C"],
        ["ff:Q",   "q:in"],
        ["ff:~Q",  "qb:in"],
      ],
    });
  }

  it("D=1 captured on rising clock edge yields Q=1, ~Q=0", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildD(facade));
    facade.setSignal(coord, "D", 1);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    expect(facade.readSignal(coord, "QB")).toBe(0);
  });

  it("D=0 captured on rising clock edge yields Q=0, ~Q=1", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildD(facade));
    // First seed Q=1 so the subsequent D=0 capture is a real change.
    facade.setSignal(coord, "D", 1);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    facade.setSignal(coord, "D", 0);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(0);
    expect(facade.readSignal(coord, "QB")).toBe(1);
  });

  it("Q persists between clock edges (D change with clock low does not propagate)", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildD(facade));
    facade.setSignal(coord, "D", 1);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    // Change D while clock is low — Q must stay latched at 1.
    facade.setSignal(coord, "D", 0);
    facade.setSignal(coord, "C", 0);
    facade.step(coord);
    facade.step(coord);
    expect(facade.readSignal(coord, "Q")).toBe(1);
  });

  it("only rising edge triggers capture — steady-high clock ignores D change", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildD(facade));
    // Latch Q=0 with D=0 then leave clock HIGH (do not return it to low).
    facade.setSignal(coord, "D", 0);
    facade.setSignal(coord, "C", 0);
    facade.step(coord);
    facade.setSignal(coord, "C", 1);
    facade.step(coord);
    expect(facade.readSignal(coord, "Q")).toBe(0);
    // Change D=1 while clock stays HIGH — no new rising edge, Q must remain 0.
    facade.setSignal(coord, "D", 1);
    facade.step(coord);
    facade.step(coord);
    expect(facade.readSignal(coord, "Q")).toBe(0);
  });
});

// ===========================================================================
// D Flip-Flop Async (D_FF_AS) — edge-triggered D with async Set / Clear
// Pin layout: inputs [Set, D, C, Clr], outputs [Q, ~Q]
// ===========================================================================

describe("D_FF_AS (Cat 9 bridge / digital)", () => {
  function buildDAsync(facade: DefaultSimulatorFacade) {
    return facade.build({
      components: [
        { id: "set",  type: "In",  props: { label: "SET", bitWidth: 1 } },
        { id: "d",    type: "In",  props: { label: "D",   bitWidth: 1 } },
        { id: "c",    type: "In",  props: { label: "C",   bitWidth: 1 } },
        { id: "clr",  type: "In",  props: { label: "CLR", bitWidth: 1 } },
        { id: "ff",   type: "D_FF_AS" },
        { id: "q",    type: "Out", props: { label: "Q",   bitWidth: 1 } },
        { id: "qb",   type: "Out", props: { label: "QB",  bitWidth: 1 } },
      ],
      connections: [
        ["set:out",  "ff:Set"],
        ["d:out",    "ff:D"],
        ["c:out",    "ff:C"],
        ["clr:out",  "ff:Clr"],
        ["ff:Q",     "q:in"],
        ["ff:~Q",    "qb:in"],
      ],
    });
  }

  it("D=1 captured on rising clock edge when Set=0 Clr=0 yields Q=1", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildDAsync(facade));
    facade.setSignal(coord, "SET", 0);
    facade.setSignal(coord, "CLR", 0);
    facade.setSignal(coord, "D", 1);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    expect(facade.readSignal(coord, "QB")).toBe(0);
  });

  it("async Set=1 forces Q=1 immediately regardless of clock", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildDAsync(facade));
    facade.setSignal(coord, "SET", 0);
    facade.setSignal(coord, "CLR", 0);
    facade.setSignal(coord, "D", 0);
    // Latch Q=0 first via a clock edge.
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(0);
    // Assert Set with no clock — Q must immediately become 1.
    facade.setSignal(coord, "SET", 1);
    facade.step(coord);
    expect(facade.readSignal(coord, "Q")).toBe(1);
    expect(facade.readSignal(coord, "QB")).toBe(0);
  });

  it("async Clr=1 forces Q=0 immediately regardless of clock", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildDAsync(facade));
    facade.setSignal(coord, "SET", 0);
    facade.setSignal(coord, "CLR", 0);
    facade.setSignal(coord, "D", 1);
    // Latch Q=1 first via a clock edge.
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    // Assert Clr with no clock — Q must immediately become 0.
    facade.setSignal(coord, "CLR", 1);
    facade.step(coord);
    expect(facade.readSignal(coord, "Q")).toBe(0);
    expect(facade.readSignal(coord, "QB")).toBe(1);
  });

  it("Set overrides D=0 on simultaneous clock edge", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildDAsync(facade));
    facade.setSignal(coord, "D", 0);
    facade.setSignal(coord, "CLR", 0);
    // Set=1 active while triggering a rising edge.
    facade.setSignal(coord, "SET", 1);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
  });
});

// ===========================================================================
// JK Flip-Flop (JK_FF) — edge-triggered with J/K/toggle logic
// Pin layout: inputs [J, C, K], outputs [Q, ~Q]
// ===========================================================================

describe("JK_FF (Cat 9 bridge / digital)", () => {
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

  it("J=1 K=0 on rising edge sets Q=1 (set operation)", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildJK(facade));
    facade.setSignal(coord, "J", 1);
    facade.setSignal(coord, "K", 0);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    expect(facade.readSignal(coord, "QB")).toBe(0);
  });

  it("J=0 K=1 on rising edge resets Q=0 (reset operation)", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildJK(facade));
    // First set Q=1.
    facade.setSignal(coord, "J", 1);
    facade.setSignal(coord, "K", 0);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    // Now reset.
    facade.setSignal(coord, "J", 0);
    facade.setSignal(coord, "K", 1);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(0);
    expect(facade.readSignal(coord, "QB")).toBe(1);
  });

  it("J=1 K=1 on rising edge toggles Q (Q was 0, becomes 1)", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildJK(facade));
    // Initial Q=0 after compile (no prior clock edge).
    facade.setSignal(coord, "J", 1);
    facade.setSignal(coord, "K", 1);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
  });

  it("J=1 K=1 toggles Q again (Q was 1, becomes 0)", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildJK(facade));
    facade.setSignal(coord, "J", 1);
    facade.setSignal(coord, "K", 1);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(0);
  });

  it("J=0 K=0 on rising edge holds Q unchanged", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildJK(facade));
    // Set Q=1 first.
    facade.setSignal(coord, "J", 1);
    facade.setSignal(coord, "K", 0);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    // Hold: J=0 K=0.
    facade.setSignal(coord, "J", 0);
    facade.setSignal(coord, "K", 0);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
  });

  it("no update on falling clock edge — K=1 with 1->0 transition does not reset Q", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildJK(facade));
    // Set Q=1: start from clock=0, go 0->1 with J=1 K=0 to set, then hold clock=1.
    facade.setSignal(coord, "J", 1);
    facade.setSignal(coord, "K", 0);
    facade.setSignal(coord, "C", 0);
    facade.step(coord);
    facade.setSignal(coord, "C", 1);
    facade.step(coord);
    expect(facade.readSignal(coord, "Q")).toBe(1);
    // Clock is now HIGH. Change to K=1 then drive only 1->0 (falling) — no reset.
    facade.setSignal(coord, "J", 0);
    facade.setSignal(coord, "K", 1);
    // Still high — no transition yet.
    facade.step(coord);
    expect(facade.readSignal(coord, "Q")).toBe(1);
    // Falling edge: 1->0.
    facade.setSignal(coord, "C", 0);
    facade.step(coord);
    // Q must stay 1 — falling edge does not trigger JK action.
    expect(facade.readSignal(coord, "Q")).toBe(1);
  });
});

// ===========================================================================
// JK Flip-Flop Async (JK_FF_AS) — edge-triggered JK with async Set / Clear
// Pin layout: inputs [Set, J, C, K, Clr], outputs [Q, ~Q]
// ===========================================================================

describe("JK_FF_AS (Cat 9 bridge / digital)", () => {
  function buildJKAsync(facade: DefaultSimulatorFacade) {
    return facade.build({
      components: [
        { id: "set",  type: "In",  props: { label: "SET", bitWidth: 1 } },
        { id: "j",    type: "In",  props: { label: "J",   bitWidth: 1 } },
        { id: "c",    type: "In",  props: { label: "C",   bitWidth: 1 } },
        { id: "k",    type: "In",  props: { label: "K",   bitWidth: 1 } },
        { id: "clr",  type: "In",  props: { label: "CLR", bitWidth: 1 } },
        { id: "ff",   type: "JK_FF_AS" },
        { id: "q",    type: "Out", props: { label: "Q",   bitWidth: 1 } },
        { id: "qb",   type: "Out", props: { label: "QB",  bitWidth: 1 } },
      ],
      connections: [
        ["set:out",  "ff:Set"],
        ["j:out",    "ff:J"],
        ["c:out",    "ff:C"],
        ["k:out",    "ff:K"],
        ["clr:out",  "ff:Clr"],
        ["ff:Q",     "q:in"],
        ["ff:~Q",    "qb:in"],
      ],
    });
  }

  it("J=1 K=0 on rising edge sets Q=1 when Set=0 Clr=0", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildJKAsync(facade));
    facade.setSignal(coord, "SET", 0);
    facade.setSignal(coord, "CLR", 0);
    facade.setSignal(coord, "J", 1);
    facade.setSignal(coord, "K", 0);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    expect(facade.readSignal(coord, "QB")).toBe(0);
  });

  it("async Set=1 forces Q=1 regardless of clock", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildJKAsync(facade));
    facade.setSignal(coord, "SET", 0);
    facade.setSignal(coord, "CLR", 0);
    // Reset first so Q=0.
    facade.setSignal(coord, "J", 0);
    facade.setSignal(coord, "K", 1);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(0);
    // Assert Set with no clock.
    facade.setSignal(coord, "SET", 1);
    facade.step(coord);
    expect(facade.readSignal(coord, "Q")).toBe(1);
    expect(facade.readSignal(coord, "QB")).toBe(0);
  });

  it("async Clr=1 forces Q=0 regardless of clock", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildJKAsync(facade));
    facade.setSignal(coord, "SET", 0);
    facade.setSignal(coord, "CLR", 0);
    // Set Q=1 first.
    facade.setSignal(coord, "J", 1);
    facade.setSignal(coord, "K", 0);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    // Assert Clr with no clock.
    facade.setSignal(coord, "CLR", 1);
    facade.step(coord);
    expect(facade.readSignal(coord, "Q")).toBe(0);
    expect(facade.readSignal(coord, "QB")).toBe(1);
  });
});

// ===========================================================================
// RS Flip-Flop (RS_FF) — clocked SR
// Pin layout: inputs [S, C, R], outputs [Q, ~Q]
// ===========================================================================

describe("RS_FF (Cat 9 bridge / digital)", () => {
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

  it("S=1 R=0 on rising clock edge sets Q=1", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildRS(facade));
    facade.setSignal(coord, "S", 1);
    facade.setSignal(coord, "R", 0);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    expect(facade.readSignal(coord, "QB")).toBe(0);
  });

  it("S=0 R=1 on rising clock edge resets Q=0", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildRS(facade));
    // Set first.
    facade.setSignal(coord, "S", 1);
    facade.setSignal(coord, "R", 0);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    // Now reset.
    facade.setSignal(coord, "S", 0);
    facade.setSignal(coord, "R", 1);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(0);
    expect(facade.readSignal(coord, "QB")).toBe(1);
  });

  it("S=0 R=0 on rising edge holds Q unchanged", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildRS(facade));
    // Set Q=1 first.
    facade.setSignal(coord, "S", 1);
    facade.setSignal(coord, "R", 0);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    // Hold.
    facade.setSignal(coord, "S", 0);
    facade.setSignal(coord, "R", 0);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
  });

  it("Q persists when clock stays low after set", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildRS(facade));
    facade.setSignal(coord, "S", 1);
    facade.setSignal(coord, "R", 0);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    // With clock low and R=1, Q must not change (no rising edge).
    facade.setSignal(coord, "R", 1);
    facade.setSignal(coord, "C", 0);
    facade.step(coord);
    facade.step(coord);
    expect(facade.readSignal(coord, "Q")).toBe(1);
  });
});

// ===========================================================================
// RS Flip-Flop Async (RS_FF_AS) — level-sensitive SR latch (no clock pin)
// Pin layout: inputs [S, R], outputs [Q, ~Q]
// ===========================================================================

describe("RS_FF_AS (Cat 9 bridge / digital)", () => {
  function buildRSAsync(facade: DefaultSimulatorFacade) {
    return facade.build({
      components: [
        { id: "s",  type: "In",  props: { label: "S",  bitWidth: 1 } },
        { id: "r",  type: "In",  props: { label: "R",  bitWidth: 1 } },
        { id: "ff", type: "RS_FF_AS" },
        { id: "q",  type: "Out", props: { label: "Q",  bitWidth: 1 } },
        { id: "qb", type: "Out", props: { label: "QB", bitWidth: 1 } },
      ],
      connections: [
        ["s:out",  "ff:S"],
        ["r:out",  "ff:R"],
        ["ff:Q",   "q:in"],
        ["ff:~Q",  "qb:in"],
      ],
    });
  }

  it("S=1 R=0 immediately drives Q=1 (level-sensitive, no clock)", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildRSAsync(facade));
    facade.setSignal(coord, "S", 1);
    facade.setSignal(coord, "R", 0);
    facade.step(coord);
    expect(facade.readSignal(coord, "Q")).toBe(1);
    expect(facade.readSignal(coord, "QB")).toBe(0);
  });

  it("S=0 R=1 immediately drives Q=0", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildRSAsync(facade));
    // Set first.
    facade.setSignal(coord, "S", 1);
    facade.setSignal(coord, "R", 0);
    facade.step(coord);
    expect(facade.readSignal(coord, "Q")).toBe(1);
    // Reset.
    facade.setSignal(coord, "S", 0);
    facade.setSignal(coord, "R", 1);
    facade.step(coord);
    expect(facade.readSignal(coord, "Q")).toBe(0);
    expect(facade.readSignal(coord, "QB")).toBe(1);
  });

  it("S=0 R=0 holds current state (Q=1 stays 1)", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildRSAsync(facade));
    facade.setSignal(coord, "S", 1);
    facade.setSignal(coord, "R", 0);
    facade.step(coord);
    expect(facade.readSignal(coord, "Q")).toBe(1);
    facade.setSignal(coord, "S", 0);
    facade.step(coord);
    facade.step(coord);
    expect(facade.readSignal(coord, "Q")).toBe(1);
  });

  it("S=0 R=0 holds current state (Q=0 stays 0)", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildRSAsync(facade));
    // Leave Q at initial 0, apply S=0 R=0 hold.
    facade.setSignal(coord, "S", 0);
    facade.setSignal(coord, "R", 0);
    facade.step(coord);
    facade.step(coord);
    expect(facade.readSignal(coord, "Q")).toBe(0);
  });

  // Category 12 — Forbidden / undefined input combinations.
  // Original test name: `FlipflopRSAsync > truth table (level-sensitive) >
  //   S=1 R=1 → forbidden state: Q=0, ~Q=0`.
  // S=1 R=1 is the documented forbidden combination for the level-sensitive
  // SR latch; the spec mandates Q=0 AND ~Q=0 (both outputs low).
  it("S=1 R=1 drives forbidden state Q=0, ~Q=0 (Cat 12)", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildRSAsync(facade));
    facade.setSignal(coord, "S", 1);
    facade.setSignal(coord, "R", 1);
    facade.step(coord);
    expect(facade.readSignal(coord, "Q")).toBe(0);
    expect(facade.readSignal(coord, "QB")).toBe(0);
  });
});

// ===========================================================================
// T Flip-Flop (T_FF) — toggle flip-flop, two topology variants
//   Variant A: withEnable=false — single clock input C, toggles unconditionally
//   Variant B: withEnable=true  — inputs [T, C], toggles only when T=1
// ===========================================================================

describe("T_FF withEnable=false (Cat 9 bridge / digital)", () => {
  function buildTNoEnable(facade: DefaultSimulatorFacade) {
    return facade.build({
      components: [
        { id: "c",  type: "In",  props: { label: "C",  bitWidth: 1 } },
        { id: "ff", type: "T_FF", props: { withEnable: false } },
        { id: "q",  type: "Out", props: { label: "Q",  bitWidth: 1 } },
        { id: "qb", type: "Out", props: { label: "QB", bitWidth: 1 } },
      ],
      connections: [
        ["c:out",  "ff:C"],
        ["ff:Q",   "q:in"],
        ["ff:~Q",  "qb:in"],
      ],
    });
  }

  it("toggles Q from 0 to 1 on first rising clock edge", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildTNoEnable(facade));
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    expect(facade.readSignal(coord, "QB")).toBe(0);
  });

  it("toggles Q from 1 to 0 on second rising clock edge", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildTNoEnable(facade));
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(0);
    expect(facade.readSignal(coord, "QB")).toBe(1);
  });

  it("does not toggle on falling clock edge — 1->0 transition leaves Q unchanged", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildTNoEnable(facade));
    // Toggle Q to 1 via a 0->1 rising edge; leave clock HIGH after the edge.
    facade.setSignal(coord, "C", 0);
    facade.step(coord);
    facade.setSignal(coord, "C", 1);
    facade.step(coord);
    expect(facade.readSignal(coord, "Q")).toBe(1);
    // Clock is now HIGH. Drive only the falling edge (1->0) — no toggle expected.
    facade.setSignal(coord, "C", 0);
    facade.step(coord);
    // Q must still be 1 — the 1->0 transition does not trigger a toggle.
    expect(facade.readSignal(coord, "Q")).toBe(1);
  });
});

describe("T_FF withEnable=true (Cat 9 bridge / digital)", () => {
  function buildTWithEnable(facade: DefaultSimulatorFacade) {
    return facade.build({
      components: [
        { id: "t",  type: "In",  props: { label: "T",  bitWidth: 1 } },
        { id: "c",  type: "In",  props: { label: "C",  bitWidth: 1 } },
        { id: "ff", type: "T_FF", props: { withEnable: true } },
        { id: "q",  type: "Out", props: { label: "Q",  bitWidth: 1 } },
        { id: "qb", type: "Out", props: { label: "QB", bitWidth: 1 } },
      ],
      connections: [
        ["t:out",  "ff:T"],
        ["c:out",  "ff:C"],
        ["ff:Q",   "q:in"],
        ["ff:~Q",  "qb:in"],
      ],
    });
  }

  it("T=1: toggles Q on rising clock edge", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildTWithEnable(facade));
    facade.setSignal(coord, "T", 1);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
  });

  it("T=0: holds Q unchanged on rising clock edge", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildTWithEnable(facade));
    // Set Q=1 first with T=1.
    facade.setSignal(coord, "T", 1);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    // Now hold T=0 and clock again — Q must stay 1.
    facade.setSignal(coord, "T", 0);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
  });

  it("T=1 toggles Q on consecutive rising edges (0->1->0)", () => {
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

