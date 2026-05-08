import { describe, it, expect } from "vitest";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../../components/register-all.js";

const registry = createDefaultRegistry();

// ---------------------------------------------------------------------------
// Component roster: JK_FF, RS_FF, T_FF, JK_FF_AS, RS_FF_AS, D_FF_AS.
// All six are pure digital flip-flops carrying a `models.digital` entry; only
// Cat 9 (bridge / digital interaction, T1) applies. Cat 1-8 require an analog
// state pool / MNA stamping / DCOP / junction limiting / LTE / acceptStep —
// none of which apply to a digital-only component. Cat 10 is gated out
// because each definition's `modelRegistry` exposes a single behavioural
// netlist (no named-preset family). Cat 11 is gated out because the only
// outputs are Q / ~Q, which are trivially complementary. Cat 12 applies to
// RS_FF_AS only (S=1 R=1 forbidden state). Cat 13-15 do not apply.
// ---------------------------------------------------------------------------

/**
 * Drive a clock pin through a complete low-high-low cycle so the flip-flop
 * sees exactly one rising edge (sampleFn captures storedQ on the 0->1
 * transition; the trailing 1->0 leaves the next call independent).
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
// JK_FF — edge-triggered J/K with hold/set/reset/toggle on rising clock.
// Pin layout: inputs [J, C, K], outputs [Q, ~Q].
// ===========================================================================

describe("JK_FF (Cat 9 bridge / digital)", () => {
  function buildJK(facade: DefaultSimulatorFacade) {
    return facade.build({
      components: [
        { id: "j",  type: "In",    props: { label: "J", bitWidth: 1 } },
        { id: "c",  type: "In",    props: { label: "C", bitWidth: 1 } },
        { id: "k",  type: "In",    props: { label: "K", bitWidth: 1 } },
        { id: "ff", type: "JK_FF" },
        { id: "q",  type: "Out",   props: { label: "Q",  bitWidth: 1 } },
        { id: "qb", type: "Out",   props: { label: "QB", bitWidth: 1 } },
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

  it("J=1 K=0 on rising edge sets Q=1 and drives complementary ~Q=0", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildJK(facade));
    facade.setSignal(coord, "J", 1);
    facade.setSignal(coord, "K", 0);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    expect(facade.readSignal(coord, "QB")).toBe(0);
  });

  it("J=0 K=1 on rising edge resets Q=0 (after a prior set)", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildJK(facade));
    facade.setSignal(coord, "J", 1);
    facade.setSignal(coord, "K", 0);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    facade.setSignal(coord, "J", 0);
    facade.setSignal(coord, "K", 1);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(0);
    expect(facade.readSignal(coord, "QB")).toBe(1);
  });

  it("J=0 K=0 on rising edge holds Q at its previous value", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildJK(facade));
    // Set Q=1 first.
    facade.setSignal(coord, "J", 1);
    facade.setSignal(coord, "K", 0);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    // Hold via J=0 K=0.
    facade.setSignal(coord, "J", 0);
    facade.setSignal(coord, "K", 0);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
  });

  it("J=1 K=1 toggles Q on each consecutive rising edge (0->1->0)", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildJK(facade));
    facade.setSignal(coord, "J", 1);
    facade.setSignal(coord, "K", 1);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(0);
    expect(facade.readSignal(coord, "QB")).toBe(1);
  });
});

// ===========================================================================
// RS_FF — edge-triggered S/R with hold/set/reset on rising clock.
// Pin layout: inputs [S, C, R], outputs [Q, ~Q].
// ===========================================================================

describe("RS_FF (Cat 9 bridge / digital)", () => {
  function buildRS(facade: DefaultSimulatorFacade) {
    return facade.build({
      components: [
        { id: "s",  type: "In",    props: { label: "S", bitWidth: 1 } },
        { id: "c",  type: "In",    props: { label: "C", bitWidth: 1 } },
        { id: "r",  type: "In",    props: { label: "R", bitWidth: 1 } },
        { id: "ff", type: "RS_FF" },
        { id: "q",  type: "Out",   props: { label: "Q",  bitWidth: 1 } },
        { id: "qb", type: "Out",   props: { label: "QB", bitWidth: 1 } },
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

  it("S=1 R=0 on rising edge sets Q=1 and drives ~Q=0", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildRS(facade));
    facade.setSignal(coord, "S", 1);
    facade.setSignal(coord, "R", 0);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    expect(facade.readSignal(coord, "QB")).toBe(0);
  });

  it("S=0 R=1 on rising edge resets Q=0 (after a prior set)", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildRS(facade));
    facade.setSignal(coord, "S", 1);
    facade.setSignal(coord, "R", 0);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    facade.setSignal(coord, "S", 0);
    facade.setSignal(coord, "R", 1);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(0);
    expect(facade.readSignal(coord, "QB")).toBe(1);
  });

  it("S=0 R=0 on rising edge holds Q at its previous value", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildRS(facade));
    facade.setSignal(coord, "S", 1);
    facade.setSignal(coord, "R", 0);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    facade.setSignal(coord, "S", 0);
    facade.setSignal(coord, "R", 0);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
  });
});

// ===========================================================================
// T_FF — toggle flip-flop, two topology variants:
//   withEnable=false: single C input, toggles unconditionally on rising edge.
//   withEnable=true : inputs [T, C], toggles only when T=1.
// ===========================================================================

describe("T_FF withEnable=false (Cat 9 bridge / digital)", () => {
  function buildTNoEnable(facade: DefaultSimulatorFacade) {
    return facade.build({
      components: [
        { id: "c",  type: "In",   props: { label: "C", bitWidth: 1 } },
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

  it("toggles Q on consecutive rising clock edges (0->1->0)", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildTNoEnable(facade));
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    expect(facade.readSignal(coord, "QB")).toBe(0);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(0);
    expect(facade.readSignal(coord, "QB")).toBe(1);
  });
});

describe("T_FF withEnable=true (Cat 9 bridge / digital)", () => {
  function buildTWithEnable(facade: DefaultSimulatorFacade) {
    return facade.build({
      components: [
        { id: "t",  type: "In",   props: { label: "T", bitWidth: 1 } },
        { id: "c",  type: "In",   props: { label: "C", bitWidth: 1 } },
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

  it("T=1 toggles Q on rising clock edge", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildTWithEnable(facade));
    facade.setSignal(coord, "T", 1);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
  });

  it("T=0 holds Q on rising clock edge", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildTWithEnable(facade));
    // Toggle to Q=1 with T=1 first.
    facade.setSignal(coord, "T", 1);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    // Disable and clock again — Q must stay at 1.
    facade.setSignal(coord, "T", 0);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
  });
});

// ===========================================================================
// JK_FF_AS — JK with async Set / Clear that override the clocked path.
// Pin layout: inputs [Set, J, C, K, Clr], outputs [Q, ~Q].
// ===========================================================================

describe("JK_FF_AS (Cat 9 bridge / digital)", () => {
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

  it("async Set=1 forces Q=1 with no clock edge", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildJKAsync(facade));
    facade.setSignal(coord, "SET", 0);
    facade.setSignal(coord, "CLR", 0);
    // Drive Q=0 first via reset.
    facade.setSignal(coord, "J", 0);
    facade.setSignal(coord, "K", 1);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(0);
    // Assert Set with no clock edge — Q must immediately go high.
    facade.setSignal(coord, "SET", 1);
    facade.step(coord);
    expect(facade.readSignal(coord, "Q")).toBe(1);
    expect(facade.readSignal(coord, "QB")).toBe(0);
  });

  it("async Clr=1 forces Q=0 with no clock edge", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildJKAsync(facade));
    facade.setSignal(coord, "SET", 0);
    facade.setSignal(coord, "CLR", 0);
    // Drive Q=1 first via set.
    facade.setSignal(coord, "J", 1);
    facade.setSignal(coord, "K", 0);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    // Assert Clr with no clock edge — Q must immediately go low.
    facade.setSignal(coord, "CLR", 1);
    facade.step(coord);
    expect(facade.readSignal(coord, "Q")).toBe(0);
    expect(facade.readSignal(coord, "QB")).toBe(1);
  });
});

// ===========================================================================
// RS_FF_AS — level-sensitive S/R latch (no clock pin).
// Pin layout: inputs [S, R], outputs [Q, ~Q].
// ===========================================================================

describe("RS_FF_AS (Cat 9 bridge / digital)", () => {
  function buildRSAsync(facade: DefaultSimulatorFacade) {
    return facade.build({
      components: [
        { id: "s",  type: "In",       props: { label: "S", bitWidth: 1 } },
        { id: "r",  type: "In",       props: { label: "R", bitWidth: 1 } },
        { id: "ff", type: "RS_FF_AS" },
        { id: "q",  type: "Out",      props: { label: "Q",  bitWidth: 1 } },
        { id: "qb", type: "Out",      props: { label: "QB", bitWidth: 1 } },
      ],
      connections: [
        ["s:out",  "ff:S"],
        ["r:out",  "ff:R"],
        ["ff:Q",   "q:in"],
        ["ff:~Q",  "qb:in"],
      ],
    });
  }

  it("S=1 R=0 immediately drives Q=1 (level-sensitive set)", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildRSAsync(facade));
    facade.setSignal(coord, "S", 1);
    facade.setSignal(coord, "R", 0);
    facade.step(coord);
    expect(facade.readSignal(coord, "Q")).toBe(1);
    expect(facade.readSignal(coord, "QB")).toBe(0);
  });

  it("S=0 R=1 immediately drives Q=0 (level-sensitive reset)", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildRSAsync(facade));
    facade.setSignal(coord, "S", 1);
    facade.setSignal(coord, "R", 0);
    facade.step(coord);
    expect(facade.readSignal(coord, "Q")).toBe(1);
    facade.setSignal(coord, "S", 0);
    facade.setSignal(coord, "R", 1);
    facade.step(coord);
    expect(facade.readSignal(coord, "Q")).toBe(0);
    expect(facade.readSignal(coord, "QB")).toBe(1);
  });

  it("S=0 R=0 holds the previously latched Q value", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildRSAsync(facade));
    facade.setSignal(coord, "S", 1);
    facade.setSignal(coord, "R", 0);
    facade.step(coord);
    expect(facade.readSignal(coord, "Q")).toBe(1);
    facade.setSignal(coord, "S", 0);
    facade.setSignal(coord, "R", 0);
    facade.step(coord);
    facade.step(coord);
    expect(facade.readSignal(coord, "Q")).toBe(1);
  });

  // Cat 12 — Forbidden / undefined input combination.
  // RS_FF_AS documents S=1 R=1 as the forbidden state with mandated
  // Q=0 AND ~Q=0 (both outputs driven low). The exact Q=0,~Q=0 pattern
  // is the spec-mandated observable, not "either consistent state".
  it("S=1 R=1 drives the documented forbidden state Q=0, ~Q=0 (Cat 12)", () => {
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
// D_FF_AS — D flip-flop with async Set / Clear that override the clocked path.
// Pin layout: inputs [Set, D, C, Clr], outputs [Q, ~Q].
// ===========================================================================

describe("D_FF_AS (Cat 9 bridge / digital)", () => {
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

  it("D=1 captured on rising clock edge yields Q=1 when Set=0 Clr=0", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildDAsync(facade));
    facade.setSignal(coord, "SET", 0);
    facade.setSignal(coord, "CLR", 0);
    facade.setSignal(coord, "D", 1);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    expect(facade.readSignal(coord, "QB")).toBe(0);
  });

  it("D=0 captured on rising clock edge yields Q=0 (after prior Q=1)", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildDAsync(facade));
    facade.setSignal(coord, "SET", 0);
    facade.setSignal(coord, "CLR", 0);
    facade.setSignal(coord, "D", 1);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    facade.setSignal(coord, "D", 0);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(0);
    expect(facade.readSignal(coord, "QB")).toBe(1);
  });

  it("async Set=1 forces Q=1 with no clock edge", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildDAsync(facade));
    facade.setSignal(coord, "SET", 0);
    facade.setSignal(coord, "CLR", 0);
    // Latch Q=0 first via clocked path.
    facade.setSignal(coord, "D", 0);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(0);
    facade.setSignal(coord, "SET", 1);
    facade.step(coord);
    expect(facade.readSignal(coord, "Q")).toBe(1);
    expect(facade.readSignal(coord, "QB")).toBe(0);
  });

  it("async Clr=1 forces Q=0 with no clock edge", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildDAsync(facade));
    facade.setSignal(coord, "SET", 0);
    facade.setSignal(coord, "CLR", 0);
    // Latch Q=1 first via clocked path.
    facade.setSignal(coord, "D", 1);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(1);
    facade.setSignal(coord, "CLR", 1);
    facade.step(coord);
    expect(facade.readSignal(coord, "Q")).toBe(0);
    expect(facade.readSignal(coord, "QB")).toBe(1);
  });
});
