/**
 * Canonical tests for BehavioralTFlipflopDriverElement.
 *
 * The driver is an `internalOnly: true` sub-element of the T_FF parent
 * component. The sanctioned access path is via the parent T_FF compiled in
 * `model: "behavioral"`, which constructs the driver inside the analog
 * subcircuit netlist (see `buildTFlipflopNetlist` in
 * `src/components/flipflops/t.ts`). Driving the parent's labelled T / C input
 * pins and observing its labelled Q / ~Q output pins through
 * `facade.setSignal` / `facade.stepToTime` / `facade.readSignal` exercises
 * the driver via the canonical Cat 9 bridge surface.
 *
 * Bridge timing contract: the coordinator's a→d bridge sync runs at the
 * START of each `_stepMixed` iteration, before `analog.step()`. So the digital
 * signal register reflects analog state AS OF THE END OF THE PRIOR coordinator
 * step. After mutating an analog input via `setSignal`, callers must advance
 * simulation time long enough for the new analog state to settle AND for the
 * coordinator to take at least one extra step that reads the new state into
 * the digital register. The `settle()` helper below uses the same
 * `SETTLE_TIME = 0.5 ms` value as `sequential-driver-ctrl-stamp.test.ts`,
 * which is far longer than the qPin/nqPin RC (~600 ps) and several internal
 * coordinator step cycles.
 *
 * Tier: fixture-only (T1).
 *
 * Canon coverage:
 *   - Cat 1  (init): post-warm-start Q / ~Q output state with no prior clock
 *     activity, after one settle() to let the warm-start analog state
 *     propagate into the digital register.
 *   - Cat 2  (DC operating point, analytical).
 *   - Cat 4  (parameter hot-load): forceToggle is a compile-time structural
 *     parameter selected by the T_FF `withEnable` prop, exercised as a
 *     structural Cat 4 (build-twice, observe shift). vIH/vIL hot-load
 *     deleted: the driver no longer carries vIH/vIL — it threshold-snaps
 *     internal driver-chain signals at 0.5 V (normalized {0,1} contract,
 *     see and-driver.ts).
 *   - Cat 9  (bridge / digital): drive labelled T / C pins, advance time,
 *     observe labelled Q / ~Q pins. Both topology variants
 *     (withEnable=true → forceToggle=0; withEnable=false → forceToggle=1).
 */

import { describe, it, expect } from "vitest";
import { buildFixture } from "../../__tests__/fixtures/build-fixture.js";
import { DefaultSimulatorFacade } from "../../../../headless/default-facade.js";
import type { ComponentRegistry } from "../../../../core/registry.js";
import { PropertyBag } from "../../../../core/properties.js";
import { BehavioralTFlipflopDriverElement } from "../t-flipflop-driver.js";

// ---------------------------------------------------------------------------
// Settle helper — same SETTLE_TIME pattern as sequential-driver-ctrl-stamp.
// 0.5 ms ≫ qPin/nqPin RC (~600 ps), and several internal coordinator step
// cycles, so the bridge a→d sync captures the new analog state before the
// digital signal register is read.
// ---------------------------------------------------------------------------

const SETTLE_TIME = 0.5e-3;

async function settle(fix: ReturnType<typeof buildFixture>): Promise<void> {
  const target = (fix.coordinator.simTime ?? 0) + SETTLE_TIME;
  await fix.facade.stepToTime(fix.coordinator, target);
}

// ---------------------------------------------------------------------------
// Topology builders.
//
// Two variants:
//   withEnable=true  → driver runs with forceToggle=0; T pin is real and
//                      gates the toggle.
//   withEnable=false → driver runs with forceToggle=1; T pin is wired to gnd
//                      internally and ignored.
// ---------------------------------------------------------------------------

interface TFFFixtureOpts {
  withEnable: boolean;
}

function buildTFFCircuit(opts: TFFFixtureOpts) {
  return (_registry: ComponentRegistry, facade: DefaultSimulatorFacade) => {
    const tffProps: Record<string, number | string | boolean> = {
      label: "tff",
      model: "behavioral",
      withEnable: opts.withEnable,
    };

    const components: Array<{ id: string; type: string; props?: Record<string, number | string | boolean> }> = [
      { id: "tff", type: "T_FF", props: tffProps },
      { id: "cIn", type: "In", props: { label: "C", bitWidth: 1 } },
      { id: "qOut", type: "Out", props: { label: "Q", bitWidth: 1 } },
      { id: "qbOut", type: "Out", props: { label: "QB", bitWidth: 1 } },
    ];
    const connections: Array<[string, string]> = [
      ["cIn:out", "tff:C"],
      ["tff:Q", "qOut:in"],
      ["tff:~Q", "qbOut:in"],
    ];
    if (opts.withEnable) {
      components.push({ id: "tIn", type: "In", props: { label: "T", bitWidth: 1 } });
      connections.push(["tIn:out", "tff:T"]);
    }
    return facade.build({ components, connections });
  };
}

/**
 * Drive a single labelled clock In through one full low-high-low cycle, with
 * a settle phase between transitions so each rising/falling edge propagates
 * through the analog subcircuit and into the digital signal register.
 */
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
// Cat 1 — Initialization
// ===========================================================================

describe("BehavioralTFlipflopDriver init (Cat 1)", () => {
  it("withEnable=true: post-warm-start Q=0, ~Q=1 with no prior clock activity", async () => {
    const fix = buildFixture({ build: buildTFFCircuit({ withEnable: true }) });
    await settle(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(0);
    expect(fix.facade.readSignal(fix.coordinator, "QB")).toBe(1);
  });

  it("withEnable=false: post-warm-start Q=0, ~Q=1 with no prior clock activity", async () => {
    const fix = buildFixture({ build: buildTFFCircuit({ withEnable: false }) });
    await settle(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(0);
    expect(fix.facade.readSignal(fix.coordinator, "QB")).toBe(1);
  });
});

// ===========================================================================
// Cat 2 — DC operating point (analytical)
// ===========================================================================

describe("BehavioralTFlipflopDriver DCOP (Cat 2 analytical)", () => {
  it("withEnable=true: DCOP converges with Q / ~Q complementary at the documented init level", async () => {
    const fix = buildFixture({ build: buildTFFCircuit({ withEnable: true }) });
    fix.facade.setSignal(fix.coordinator, "T", 0);
    fix.facade.setSignal(fix.coordinator, "C", 0);
    const result = fix.coordinator.dcOperatingPoint();
    expect(result!.converged).toBe(true);
    await settle(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(0);
    expect(fix.facade.readSignal(fix.coordinator, "QB")).toBe(1);
  });

  it("withEnable=false: DCOP converges with Q / ~Q complementary at the documented init level", async () => {
    const fix = buildFixture({ build: buildTFFCircuit({ withEnable: false }) });
    fix.facade.setSignal(fix.coordinator, "C", 0);
    const result = fix.coordinator.dcOperatingPoint();
    expect(result!.converged).toBe(true);
    await settle(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(0);
    expect(fix.facade.readSignal(fix.coordinator, "QB")).toBe(1);
  });
});

// ===========================================================================
// Cat 9 — Bridge / digital interaction
// ===========================================================================

describe("BehavioralTFlipflopDriver bridge / digital (Cat 9) — withEnable=true (forceToggle=0)", () => {
  it("first rising clock edge with T=1 toggles Q from 0 to 1", async () => {
    const fix = buildFixture({ build: buildTFFCircuit({ withEnable: true }) });
    fix.facade.setSignal(fix.coordinator, "T", 1);
    await settle(fix);
    await pulseClock(fix, "C");
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(1);
    expect(fix.facade.readSignal(fix.coordinator, "QB")).toBe(0);
  });

  it("two successive rising edges with T=1 toggle Q back to 0", async () => {
    const fix = buildFixture({ build: buildTFFCircuit({ withEnable: true }) });
    fix.facade.setSignal(fix.coordinator, "T", 1);
    await settle(fix);
    await pulseClock(fix, "C");
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(1);
    await pulseClock(fix, "C");
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(0);
    expect(fix.facade.readSignal(fix.coordinator, "QB")).toBe(1);
  });

  it("rising clock edge with T=0 holds Q at its current value", async () => {
    const fix = buildFixture({ build: buildTFFCircuit({ withEnable: true }) });
    fix.facade.setSignal(fix.coordinator, "T", 1);
    await settle(fix);
    await pulseClock(fix, "C");
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(1);
    fix.facade.setSignal(fix.coordinator, "T", 0);
    await settle(fix);
    await pulseClock(fix, "C");
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(1);
    expect(fix.facade.readSignal(fix.coordinator, "QB")).toBe(0);
  });

  it("falling clock edge with T=1 does not toggle Q", async () => {
    const fix = buildFixture({ build: buildTFFCircuit({ withEnable: true }) });
    fix.facade.setSignal(fix.coordinator, "T", 1);
    fix.facade.setSignal(fix.coordinator, "C", 0);
    await settle(fix);
    fix.facade.setSignal(fix.coordinator, "C", 1);
    await settle(fix);
    const qAfterRise = fix.facade.readSignal(fix.coordinator, "Q");
    fix.facade.setSignal(fix.coordinator, "C", 0);
    await settle(fix);
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(qAfterRise);
  });
});

describe("BehavioralTFlipflopDriver bridge / digital (Cat 9) — withEnable=false (forceToggle=1)", () => {
  it("first rising clock edge unconditionally toggles Q from 0 to 1", async () => {
    const fix = buildFixture({ build: buildTFFCircuit({ withEnable: false }) });
    await pulseClock(fix, "C");
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(1);
    expect(fix.facade.readSignal(fix.coordinator, "QB")).toBe(0);
  });

  it("two successive rising edges toggle Q 0→1→0 unconditionally", async () => {
    const fix = buildFixture({ build: buildTFFCircuit({ withEnable: false }) });
    await pulseClock(fix, "C");
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(1);
    await pulseClock(fix, "C");
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(0);
    expect(fix.facade.readSignal(fix.coordinator, "QB")).toBe(1);
  });
});

// ===========================================================================
// Cat 4 — Parameter hot-load (structural only)
//
// The driver no longer carries vIH/vIL/vOH/vOL/rOut model params — the
// {0, 1} normalized contract makes those meaningless inside the digital
// chain. forceToggle remains a compile-time structural parameter selected
// by the T_FF `withEnable` prop.
// ===========================================================================

describe("BehavioralTFlipflopDriver parameter hot-load (Cat 4)", () => {
  it("forceToggle structural: withEnable=false (forceToggle=1) toggles on rising edge even with T LOW; withEnable=true (forceToggle=0) does not", async () => {
    const fixGated = buildFixture({ build: buildTFFCircuit({ withEnable: true }) });
    fixGated.facade.setSignal(fixGated.coordinator, "T", 0);
    await settle(fixGated);
    await pulseClock(fixGated, "C");
    expect(fixGated.facade.readSignal(fixGated.coordinator, "Q")).toBe(0);

    const fixForce = buildFixture({ build: buildTFFCircuit({ withEnable: false }) });
    await pulseClock(fixForce, "C");
    expect(fixForce.facade.readSignal(fixForce.coordinator, "Q")).toBe(1);
  });
});

// ===========================================================================
// setParam — driver tolerates rOut/vOH/vOL keys without throwing.
//
// Drivers no longer carry rOut/vOH/vOL — those concepts moved to the pin
// boundary (DigitalOutputPinLoaded / BridgeOutputDriverElement). The
// driver's setParam is a no-op; external callers must continue to work.
// ===========================================================================

describe("BehavioralTFlipflopDriver tolerates legacy setParam without throwing", () => {
  it("accepts rOut/vOH/vOL via setParam without throwing", () => {
    const props = new PropertyBag();
    props.setModelParam("forceToggle", 0);
    const pinNodes = new Map<string, number>([
      ["T", 1], ["C", 2], ["Q", 3], ["~Q", 4], ["gnd", 0],
    ]);
    const el = new BehavioralTFlipflopDriverElement(pinNodes, props);
    expect(() => el.setParam("rOut", 200)).not.toThrow();
    expect(() => el.setParam("vOH", 3.3)).not.toThrow();
    expect(() => el.setParam("vOL", 0.5)).not.toThrow();
  });
});
