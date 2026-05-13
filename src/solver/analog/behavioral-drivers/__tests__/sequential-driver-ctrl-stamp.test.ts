/**
 * Ctrl-stamp tests for Wave 4.2 sequential driver leaves:
 *   - BehavioralDFlipflopDriverElement       (D flip-flop)
 *   - BehavioralJKFlipflopDriverElement      (JK flip-flop)
 *   - BehavioralTFlipflopDriverElement       (T flip-flop, withEnable=true)
 *   - BehavioralRSFlipflopDriverElement      (RS flip-flop)
 *   - BehavioralDAsyncFlipflopDriverElement  (D flip-flop with async Set/Clr)
 *   - BehavioralJKAsyncFlipflopDriverElement (JK flip-flop with async Set/Clr)
 *   - BehavioralRSAsyncLatchDriverElement    (RS async latch, level-sensitive)
 *
 * Each driver emits two Norton stamps at ctrl_q and ctrl_nq. After one load()
 * pass the stamp at ctrl_q reflects vOH when Q=1, vOL when Q=0; ctrl_nq is
 * always complementary. The observable surface is the parent flipflop Q and
 * ~Q output port digital readings via readSignal.
 *
 * Tier: T1 (buildFixture, headless).
 *
 * Test cases per driver:
 *   - stamps complementary Norton at ctrl_q / ctrl_nq after rising clock with
 *     D=HIGH (or appropriate SET condition)
 *   - stamps complementary Norton with D=LOW (or RESET condition)
 *   - holds prior Q across a flat-clock (no rising edge) load
 */

import { describe, it, expect } from "vitest";
import { buildFixture } from "../../__tests__/fixtures/build-fixture.js";
import { DefaultSimulatorFacade } from "../../../../headless/default-facade.js";
import type { ComponentRegistry } from "../../../../core/registry.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// Each set-signal-then-settle phase advances analog simTime by SETTLE_TIME,
// which is far longer than the qPin/nqPin RC (~600 ps) so analog Q / ~Q
// reach their rails and clear the bridge's indeterminate band. The next
// coordinator.step() (via stepToTime's internal loop) then captures the
// settled analog state into the digital signal register.
const SETTLE_TIME = 0.5e-3;

async function settle(fix: ReturnType<typeof buildFixture>): Promise<void> {
  const target = (fix.coordinator.simTime ?? 0) + SETTLE_TIME;
  await fix.facade.stepToTime(fix.coordinator, target);
}

async function pulseClock(
  fix: ReturnType<typeof buildFixture>,
  clkLabel: string,
): Promise<void> {
  fix.facade.setSignal(fix.coordinator, clkLabel, 0);
  await settle(fix);
  fix.facade.setSignal(fix.coordinator, clkLabel, 1);
  await settle(fix);
  fix.facade.setSignal(fix.coordinator, clkLabel, 0);
  await settle(fix);
}

// ===========================================================================
// D Flip-Flop
// ===========================================================================

function buildDFFFixture() {
  return buildFixture({
    build: (_r: ComponentRegistry, facade: DefaultSimulatorFacade) => facade.build({
      components: [
        { id: "ff",    type: "D_FF", props: { label: "ff", model: "behavioral" } },
        { id: "dIn",   type: "In",   props: { label: "D", bitWidth: 1 } },
        { id: "cIn",   type: "In",   props: { label: "C", bitWidth: 1 } },
        { id: "qOut",  type: "Out",  props: { label: "Q", bitWidth: 1 } },
        { id: "qbOut", type: "Out",  props: { label: "QB", bitWidth: 1 } },
      ],
      connections: [
        ["dIn:out", "ff:D"],
        ["cIn:out", "ff:C"],
        ["ff:Q",    "qOut:in"],
        ["ff:~Q",   "qbOut:in"],
      ],
    }),
  });
}

describe("BehavioralDFlipflopDriver -- ctrl_q / ctrl_nq Norton stamps (Cat 9)", () => {
  it("stamps complementary Norton after rising clock with D=high: Q=1, ~Q=0", async () => {
    const fix = buildDFFFixture();
    fix.facade.setSignal(fix.coordinator, "D", 1);
    await pulseClock(fix, "C");
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(1);
    expect(fix.facade.readSignal(fix.coordinator, "QB")).toBe(0);
  });

  it("stamps complementary Norton with D=low: Q=0, ~Q=1", async () => {
    const fix = buildDFFFixture();
    fix.facade.setSignal(fix.coordinator, "D", 0);
    await pulseClock(fix, "C");
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(0);
    expect(fix.facade.readSignal(fix.coordinator, "QB")).toBe(1);
  });

  it("holds prior Q across flat-clock load (no rising edge)", async () => {
    const fix = buildDFFFixture();
    fix.facade.setSignal(fix.coordinator, "D", 1);
    await pulseClock(fix, "C");
    const qAfterRise = fix.facade.readSignal(fix.coordinator, "Q");
    fix.facade.setSignal(fix.coordinator, "D", 0);
    fix.facade.setSignal(fix.coordinator, "C", 0);
    await settle(fix);
    await settle(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(qAfterRise);
  });
});

// ===========================================================================
// JK Flip-Flop
// ===========================================================================

function buildJKFFFixture() {
  return buildFixture({
    build: (_r: ComponentRegistry, facade: DefaultSimulatorFacade) => facade.build({
      components: [
        { id: "ff",    type: "JK_FF", props: { label: "ff", model: "behavioral" } },
        { id: "jIn",   type: "In",    props: { label: "J", bitWidth: 1 } },
        { id: "cIn",   type: "In",    props: { label: "C", bitWidth: 1 } },
        { id: "kIn",   type: "In",    props: { label: "K", bitWidth: 1 } },
        { id: "qOut",  type: "Out",   props: { label: "Q", bitWidth: 1 } },
        { id: "qbOut", type: "Out",   props: { label: "QB", bitWidth: 1 } },
      ],
      connections: [
        ["jIn:out", "ff:J"],
        ["cIn:out", "ff:C"],
        ["kIn:out", "ff:K"],
        ["ff:Q",    "qOut:in"],
        ["ff:~Q",   "qbOut:in"],
      ],
    }),
  });
}

describe("BehavioralJKFlipflopDriver -- ctrl_q / ctrl_nq Norton stamps (Cat 9)", () => {
  it("stamps complementary Norton after rising clock with J=1, K=0: Q=1, ~Q=0", async () => {
    const fix = buildJKFFFixture();
    fix.facade.setSignal(fix.coordinator, "J", 1);
    fix.facade.setSignal(fix.coordinator, "K", 0);
    await pulseClock(fix, "C");
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(1);
    expect(fix.facade.readSignal(fix.coordinator, "QB")).toBe(0);
  });

  it("stamps complementary Norton with J=0, K=1: Q=0, ~Q=1", async () => {
    const fix = buildJKFFFixture();
    fix.facade.setSignal(fix.coordinator, "J", 1);
    fix.facade.setSignal(fix.coordinator, "K", 0);
    await pulseClock(fix, "C");
    fix.facade.setSignal(fix.coordinator, "J", 0);
    fix.facade.setSignal(fix.coordinator, "K", 1);
    await pulseClock(fix, "C");
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(0);
    expect(fix.facade.readSignal(fix.coordinator, "QB")).toBe(1);
  });

  it("holds prior Q across flat-clock load (no rising edge)", async () => {
    const fix = buildJKFFFixture();
    fix.facade.setSignal(fix.coordinator, "J", 1);
    fix.facade.setSignal(fix.coordinator, "K", 0);
    await pulseClock(fix, "C");
    fix.facade.setSignal(fix.coordinator, "C", 0);
    await settle(fix);
    await settle(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(1);
  });
});

// ===========================================================================
// T Flip-Flop (withEnable=true)
// ===========================================================================

function buildTFFFixture() {
  return buildFixture({
    build: (_r: ComponentRegistry, facade: DefaultSimulatorFacade) => facade.build({
      components: [
        { id: "ff",    type: "T_FF", props: { label: "ff", model: "behavioral", withEnable: true } },
        { id: "tIn",   type: "In",   props: { label: "T", bitWidth: 1 } },
        { id: "cIn",   type: "In",   props: { label: "C", bitWidth: 1 } },
        { id: "qOut",  type: "Out",  props: { label: "Q", bitWidth: 1 } },
        { id: "qbOut", type: "Out",  props: { label: "QB", bitWidth: 1 } },
      ],
      connections: [
        ["tIn:out", "ff:T"],
        ["cIn:out", "ff:C"],
        ["ff:Q",    "qOut:in"],
        ["ff:~Q",   "qbOut:in"],
      ],
    }),
  });
}

describe("BehavioralTFlipflopDriver -- ctrl_q / ctrl_nq Norton stamps (Cat 9)", () => {
  it("stamps complementary Norton after rising clock with T=1: Q toggles 0 to 1", async () => {
    const fix = buildTFFFixture();
    fix.facade.setSignal(fix.coordinator, "T", 1);
    await pulseClock(fix, "C");
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(1);
    expect(fix.facade.readSignal(fix.coordinator, "QB")).toBe(0);
  });

  it("stamps complementary Norton with T=0: Q stays at 0 (hold)", async () => {
    const fix = buildTFFFixture();
    fix.facade.setSignal(fix.coordinator, "T", 0);
    await pulseClock(fix, "C");
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(0);
    expect(fix.facade.readSignal(fix.coordinator, "QB")).toBe(1);
  });

  it("holds prior Q across flat-clock load (no rising edge)", async () => {
    const fix = buildTFFFixture();
    fix.facade.setSignal(fix.coordinator, "T", 1);
    await pulseClock(fix, "C");
    const qAfterRise = fix.facade.readSignal(fix.coordinator, "Q");
    fix.facade.setSignal(fix.coordinator, "C", 0);
    await settle(fix);
    await settle(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(qAfterRise);
  });
});

// ===========================================================================
// RS Flip-Flop
// ===========================================================================

function buildRSFFFixture() {
  return buildFixture({
    build: (_r: ComponentRegistry, facade: DefaultSimulatorFacade) => facade.build({
      components: [
        { id: "ff",    type: "RS_FF", props: { label: "ff", model: "behavioral" } },
        { id: "sIn",   type: "In",    props: { label: "S", bitWidth: 1 } },
        { id: "cIn",   type: "In",    props: { label: "C", bitWidth: 1 } },
        { id: "rIn",   type: "In",    props: { label: "R", bitWidth: 1 } },
        { id: "qOut",  type: "Out",   props: { label: "Q", bitWidth: 1 } },
        { id: "qbOut", type: "Out",   props: { label: "QB", bitWidth: 1 } },
      ],
      connections: [
        ["sIn:out", "ff:S"],
        ["cIn:out", "ff:C"],
        ["rIn:out", "ff:R"],
        ["ff:Q",    "qOut:in"],
        ["ff:~Q",   "qbOut:in"],
      ],
    }),
  });
}

describe("BehavioralRSFlipflopDriver -- ctrl_q / ctrl_nq Norton stamps (Cat 9)", () => {
  it("stamps complementary Norton after rising clock with S=1, R=0: Q=1, ~Q=0", async () => {
    const fix = buildRSFFFixture();
    fix.facade.setSignal(fix.coordinator, "S", 1);
    fix.facade.setSignal(fix.coordinator, "R", 0);
    await pulseClock(fix, "C");
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(1);
    expect(fix.facade.readSignal(fix.coordinator, "QB")).toBe(0);
  });

  it("stamps complementary Norton with S=0, R=1: Q=0, ~Q=1", async () => {
    const fix = buildRSFFFixture();
    fix.facade.setSignal(fix.coordinator, "S", 1);
    fix.facade.setSignal(fix.coordinator, "R", 0);
    await pulseClock(fix, "C");
    fix.facade.setSignal(fix.coordinator, "S", 0);
    fix.facade.setSignal(fix.coordinator, "R", 1);
    await pulseClock(fix, "C");
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(0);
    expect(fix.facade.readSignal(fix.coordinator, "QB")).toBe(1);
  });

  it("holds prior Q across flat-clock load (no rising edge)", async () => {
    const fix = buildRSFFFixture();
    fix.facade.setSignal(fix.coordinator, "S", 1);
    fix.facade.setSignal(fix.coordinator, "R", 0);
    await pulseClock(fix, "C");
    fix.facade.setSignal(fix.coordinator, "C", 0);
    await settle(fix);
    await settle(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(1);
  });
});

// ===========================================================================
// D Flip-Flop with async Set/Clr
// ===========================================================================

function buildDAsyncFFFixture() {
  return buildFixture({
    build: (_r: ComponentRegistry, facade: DefaultSimulatorFacade) => facade.build({
      components: [
        { id: "ff",    type: "D_FF_AS", props: { label: "ff", model: "behavioral" } },
        { id: "setIn", type: "In",      props: { label: "Set", bitWidth: 1 } },
        { id: "dIn",   type: "In",      props: { label: "D", bitWidth: 1 } },
        { id: "cIn",   type: "In",      props: { label: "C", bitWidth: 1 } },
        { id: "clrIn", type: "In",      props: { label: "Clr", bitWidth: 1 } },
        { id: "qOut",  type: "Out",     props: { label: "Q", bitWidth: 1 } },
        { id: "qbOut", type: "Out",     props: { label: "QB", bitWidth: 1 } },
      ],
      connections: [
        ["setIn:out", "ff:Set"],
        ["dIn:out",   "ff:D"],
        ["cIn:out",   "ff:C"],
        ["clrIn:out", "ff:Clr"],
        ["ff:Q",      "qOut:in"],
        ["ff:~Q",     "qbOut:in"],
      ],
    }),
  });
}

describe("BehavioralDAsyncFlipflopDriver -- ctrl_q / ctrl_nq Norton stamps (Cat 9)", () => {
  it("stamps complementary Norton after rising clock with D=1: Q=1, ~Q=0", async () => {
    const fix = buildDAsyncFFFixture();
    fix.facade.setSignal(fix.coordinator, "Set", 0);
    fix.facade.setSignal(fix.coordinator, "D", 1);
    fix.facade.setSignal(fix.coordinator, "Clr", 0);
    await pulseClock(fix, "C");
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(1);
    expect(fix.facade.readSignal(fix.coordinator, "QB")).toBe(0);
  });

  it("stamps complementary Norton with D=0: Q=0, ~Q=1", async () => {
    const fix = buildDAsyncFFFixture();
    fix.facade.setSignal(fix.coordinator, "Set", 0);
    fix.facade.setSignal(fix.coordinator, "D", 0);
    fix.facade.setSignal(fix.coordinator, "Clr", 0);
    await pulseClock(fix, "C");
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(0);
    expect(fix.facade.readSignal(fix.coordinator, "QB")).toBe(1);
  });

  it("async Set forces Q=1 without a clock edge", async () => {
    const fix = buildDAsyncFFFixture();
    fix.facade.setSignal(fix.coordinator, "Set", 1);
    fix.facade.setSignal(fix.coordinator, "D", 0);
    fix.facade.setSignal(fix.coordinator, "Clr", 0);
    fix.facade.setSignal(fix.coordinator, "C", 0);
    await settle(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(1);
    expect(fix.facade.readSignal(fix.coordinator, "QB")).toBe(0);
  });

  it("holds prior Q across flat-clock load (no rising edge)", async () => {
    const fix = buildDAsyncFFFixture();
    fix.facade.setSignal(fix.coordinator, "Set", 0);
    fix.facade.setSignal(fix.coordinator, "D", 1);
    fix.facade.setSignal(fix.coordinator, "Clr", 0);
    await pulseClock(fix, "C");
    fix.facade.setSignal(fix.coordinator, "D", 0);
    fix.facade.setSignal(fix.coordinator, "C", 0);
    await settle(fix);
    await settle(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(1);
  });
});

// ===========================================================================
// JK Flip-Flop with async Set/Clr
// ===========================================================================

function buildJKAsyncFFFixture() {
  return buildFixture({
    build: (_r: ComponentRegistry, facade: DefaultSimulatorFacade) => facade.build({
      components: [
        { id: "ff",    type: "JK_FF_AS", props: { label: "ff", model: "behavioral" } },
        { id: "setIn", type: "In",       props: { label: "Set", bitWidth: 1 } },
        { id: "jIn",   type: "In",       props: { label: "J", bitWidth: 1 } },
        { id: "cIn",   type: "In",       props: { label: "C", bitWidth: 1 } },
        { id: "kIn",   type: "In",       props: { label: "K", bitWidth: 1 } },
        { id: "clrIn", type: "In",       props: { label: "Clr", bitWidth: 1 } },
        { id: "qOut",  type: "Out",      props: { label: "Q", bitWidth: 1 } },
        { id: "qbOut", type: "Out",      props: { label: "QB", bitWidth: 1 } },
      ],
      connections: [
        ["setIn:out", "ff:Set"],
        ["jIn:out",   "ff:J"],
        ["cIn:out",   "ff:C"],
        ["kIn:out",   "ff:K"],
        ["clrIn:out", "ff:Clr"],
        ["ff:Q",      "qOut:in"],
        ["ff:~Q",     "qbOut:in"],
      ],
    }),
  });
}

describe("BehavioralJKAsyncFlipflopDriver -- ctrl_q / ctrl_nq Norton stamps (Cat 9)", () => {
  it("stamps complementary Norton after rising clock with J=1, K=0: Q=1, ~Q=0", async () => {
    const fix = buildJKAsyncFFFixture();
    fix.facade.setSignal(fix.coordinator, "Set", 0);
    fix.facade.setSignal(fix.coordinator, "J", 1);
    fix.facade.setSignal(fix.coordinator, "K", 0);
    fix.facade.setSignal(fix.coordinator, "Clr", 0);
    await pulseClock(fix, "C");
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(1);
    expect(fix.facade.readSignal(fix.coordinator, "QB")).toBe(0);
  });

  it("stamps complementary Norton with J=0, K=1: Q=0, ~Q=1", async () => {
    const fix = buildJKAsyncFFFixture();
    fix.facade.setSignal(fix.coordinator, "Set", 0);
    fix.facade.setSignal(fix.coordinator, "J", 1);
    fix.facade.setSignal(fix.coordinator, "K", 0);
    fix.facade.setSignal(fix.coordinator, "Clr", 0);
    await pulseClock(fix, "C");
    fix.facade.setSignal(fix.coordinator, "J", 0);
    fix.facade.setSignal(fix.coordinator, "K", 1);
    await pulseClock(fix, "C");
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(0);
    expect(fix.facade.readSignal(fix.coordinator, "QB")).toBe(1);
  });

  it("async Set forces Q=1 without a clock edge", async () => {
    const fix = buildJKAsyncFFFixture();
    fix.facade.setSignal(fix.coordinator, "Set", 1);
    fix.facade.setSignal(fix.coordinator, "J", 0);
    fix.facade.setSignal(fix.coordinator, "K", 0);
    fix.facade.setSignal(fix.coordinator, "Clr", 0);
    fix.facade.setSignal(fix.coordinator, "C", 0);
    await settle(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(1);
    expect(fix.facade.readSignal(fix.coordinator, "QB")).toBe(0);
  });

  it("holds prior Q across flat-clock load (no rising edge)", async () => {
    const fix = buildJKAsyncFFFixture();
    fix.facade.setSignal(fix.coordinator, "Set", 0);
    fix.facade.setSignal(fix.coordinator, "J", 1);
    fix.facade.setSignal(fix.coordinator, "K", 0);
    fix.facade.setSignal(fix.coordinator, "Clr", 0);
    await pulseClock(fix, "C");
    fix.facade.setSignal(fix.coordinator, "C", 0);
    await settle(fix);
    await settle(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(1);
  });
});

// ===========================================================================
// RS Async Latch (level-sensitive, no clock)
// ===========================================================================

function buildRSAsyncLatchFixture() {
  return buildFixture({
    build: (_r: ComponentRegistry, facade: DefaultSimulatorFacade) => facade.build({
      components: [
        { id: "ff",    type: "RS_FF_AS", props: { label: "ff", model: "behavioral" } },
        { id: "sIn",   type: "In",       props: { label: "S", bitWidth: 1 } },
        { id: "rIn",   type: "In",       props: { label: "R", bitWidth: 1 } },
        { id: "qOut",  type: "Out",      props: { label: "Q", bitWidth: 1 } },
        { id: "qbOut", type: "Out",      props: { label: "QB", bitWidth: 1 } },
      ],
      connections: [
        ["sIn:out", "ff:S"],
        ["rIn:out", "ff:R"],
        ["ff:Q",    "qOut:in"],
        ["ff:~Q",   "qbOut:in"],
      ],
    }),
  });
}

describe("BehavioralRSAsyncLatchDriver -- ctrl_q / ctrl_nq Norton stamps (Cat 9)", () => {
  it("stamps complementary Norton at ctrl_q / ctrl_nq when S=1, R=0: Q=1, ~Q=0", async () => {
    const fix = buildRSAsyncLatchFixture();
    fix.facade.setSignal(fix.coordinator, "S", 1);
    fix.facade.setSignal(fix.coordinator, "R", 0);
    await settle(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(1);
    expect(fix.facade.readSignal(fix.coordinator, "QB")).toBe(0);
  });

  it("stamps complementary Norton with S=0, R=1: Q=0, ~Q=1", async () => {
    const fix = buildRSAsyncLatchFixture();
    fix.facade.setSignal(fix.coordinator, "S", 1);
    fix.facade.setSignal(fix.coordinator, "R", 0);
    await settle(fix);
    fix.facade.setSignal(fix.coordinator, "S", 0);
    fix.facade.setSignal(fix.coordinator, "R", 1);
    await settle(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(0);
    expect(fix.facade.readSignal(fix.coordinator, "QB")).toBe(1);
  });

  it("holds prior Q when S=0, R=0 (hold condition)", async () => {
    const fix = buildRSAsyncLatchFixture();
    fix.facade.setSignal(fix.coordinator, "S", 1);
    fix.facade.setSignal(fix.coordinator, "R", 0);
    await settle(fix);
    fix.facade.setSignal(fix.coordinator, "S", 0);
    fix.facade.setSignal(fix.coordinator, "R", 0);
    await settle(fix);
    await settle(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(1);
  });
});
