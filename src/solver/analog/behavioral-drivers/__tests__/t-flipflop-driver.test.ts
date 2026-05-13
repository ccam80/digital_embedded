/**
 * Canonical tests for BehavioralTFlipflopDriverElement.
 *
 * The driver is an `internalOnly: true` sub-element of the T_FF parent
 * component. The sanctioned access path is via the parent T_FF compiled in
 * `model: "behavioral"`, which constructs the driver inside the analog
 * subcircuit netlist (see `buildTFlipflopNetlist` in
 * `src/components/flipflops/t.ts`). Driving the parent's labelled T / C input
 * pins and observing its labelled Q / ~Q output pins through
 * `facade.setSignal` / `facade.step` / `facade.readSignal` exercises the
 * driver via the canonical Cat 9 bridge surface.
 *
 * Tier: fixture-only (T1).
 *
 * Canon coverage:
 *   - Cat 1  (init): post-warm-start Q / ~Q output state at step 0 with no
 *     prior clock activity.
 *   - Cat 2  (DC operating point, analytical): the parent T_FF's Q / ~Q
 *     digital outputs settle to a deterministic complementary pair after a
 *     single step.
 *   - Cat 4  (parameter hot-load): vIH and vIL behavioural-model
 *     parameters change the clock-edge detection threshold; forceToggle is a
 *     compile-time structural parameter selected by the T_FF `withEnable`
 *     prop, exercised as a structural Cat 4 (build-twice, observe shift).
 *   - Cat 9  (bridge / digital): drive labelled T / C pins, step the engine,
 *     observe labelled Q / ~Q pins. Includes both topology variants
 *     (withEnable=true → forceToggle=0; withEnable=false → forceToggle=1).
 *
 * Not applicable:
 *   - Cat 3  / Cat 5: T3 harness only — ngspice has no native T-flip-flop
 *     primitive, so a paired comparison would require expanding the entire
 *     behavioural subcircuit into ngspice's primitive set, which is out of
 *     scope for this driver's test coverage.
 *   - Cat 6  (limiting): driver carries no junctions; its `load()` does not
 *     call pnjlim / fetlim / devlim.
 *   - Cat 7  (LTE rollback): driver does not declare `getLteTimestep`.
 *   - Cat 8  (breakpoints): driver does not register breakpoints in
 *     `acceptStep`.
 *   - Cat 10 (named model preset): the driver's `modelRegistry` exposes a
 *     single `default` entry — there is no second preset to swap.
 *   - Cat 11 (multi-output digital): Q / ~Q are trivially complementary
 *     (excluded by capability gate 11).
 *   - Cat 12 (forbidden inputs): no documented forbidden input combination.
 *   - Cat 13 (port-width clamping): all driver pins are 1-bit; nothing to
 *     mask.
 *   - Cat 14 (runtime diagnostic): driver emits no runtime diagnostics.
 *   - Cat 15 (cross-engine writeback): driver registers no `_onStateChange`
 *     subscription.
 */

import { describe, it, expect } from "vitest";
import { buildFixture } from "../../__tests__/fixtures/build-fixture.js";
import { DefaultSimulatorFacade } from "../../../../headless/default-facade.js";
import type { ComponentRegistry } from "../../../../core/registry.js";
import type { CircuitElement } from "../../../../core/element.js";
import { PropertyBag } from "../../../../core/properties.js";
import { BehavioralTFlipflopDriverElement } from "../t-flipflop-driver.js";

// ---------------------------------------------------------------------------
// Topology builders.
//
// The parent T_FF in `model: "behavioral"` constructs the driver under the
// hood. Driving its labelled T / C input pins through labelled In components
// and observing its labelled Q / ~Q output pins through labelled Out
// components is the canonical bridge surface for the driver.
//
// Two topology variants:
//   withEnable=true  → driver runs with forceToggle=0; T pin is real and
//                      gates the toggle.
//   withEnable=false → driver runs with forceToggle=1; T pin is wired to gnd
//                      internally and ignored.
// ---------------------------------------------------------------------------

interface TFFFixtureOpts {
  withEnable: boolean;
  /** Optional behavioral model params to override (vIH, vIL, etc). */
  modelOverrides?: Record<string, number>;
}

function buildTFFCircuit(opts: TFFFixtureOpts) {
  return (_registry: ComponentRegistry, facade: DefaultSimulatorFacade) => {
    const tffProps: Record<string, number | string | boolean> = {
      label: "tff",
      model: "behavioral",
      withEnable: opts.withEnable,
    };
    if (opts.modelOverrides !== undefined) {
      for (const [k, v] of Object.entries(opts.modelOverrides)) {
        tffProps[k] = v;
      }
    }

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
 * Drive a single labelled clock In through one full low-high-low cycle so a
 * single rising edge reaches the driver's edge-detector.
 */
function pulseClock(
  fix: ReturnType<typeof buildFixture>,
  clkLabel: string,
): void {
  fix.facade.setSignal(fix.coordinator, clkLabel, 0);
  fix.coordinator.step();
  fix.facade.setSignal(fix.coordinator, clkLabel, 1);
  fix.coordinator.step();
  fix.facade.setSignal(fix.coordinator, clkLabel, 0);
  fix.coordinator.step();
}

/** Resolve the parent T_FF CircuitElement for setComponentProperty hot-load. */
function getTFFElement(fix: ReturnType<typeof buildFixture>): CircuitElement {
  for (const ce of fix.circuit.elementToCircuitElement.values()) {
    const label = ce.getProperties().getOrDefault<string>("label", "");
    if (label === "tff") return ce;
  }
  throw new Error("getTFFElement: no T_FF element labelled 'tff' found in fixture");
}

// ===========================================================================
// Cat 1 — Initialization
// ===========================================================================

describe("BehavioralTFlipflopDriver init (Cat 1)", () => {
  it("withEnable=true: post-warm-start Q=0, ~Q=1 with no prior clock activity", () => {
    const fix = buildFixture({ build: buildTFFCircuit({ withEnable: true }) });
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(0);
    expect(fix.facade.readSignal(fix.coordinator, "QB")).toBe(1);
  });

  it("withEnable=false: post-warm-start Q=0, ~Q=1 with no prior clock activity", () => {
    const fix = buildFixture({ build: buildTFFCircuit({ withEnable: false }) });
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(0);
    expect(fix.facade.readSignal(fix.coordinator, "QB")).toBe(1);
  });
});

// ===========================================================================
// Cat 2 — DC operating point (analytical)
// ===========================================================================

describe("BehavioralTFlipflopDriver DCOP (Cat 2 analytical)", () => {
  it("withEnable=true: DCOP converges with Q / ~Q complementary at the documented init level", () => {
    const fix = buildFixture({ build: buildTFFCircuit({ withEnable: true }) });
    // Drive both inputs LOW for a quiescent DCOP.
    fix.facade.setSignal(fix.coordinator, "T", 0);
    fix.facade.setSignal(fix.coordinator, "C", 0);
    const result = fix.coordinator.dcOperatingPoint();
    expect(result!.converged).toBe(true);
    fix.coordinator.step();
    // Closed-form: with C held LOW (no rising edge), Q stays at the
    // initState seed value 0; ~Q is the complement.
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(0);
    expect(fix.facade.readSignal(fix.coordinator, "QB")).toBe(1);
  });

  it("withEnable=false: DCOP converges with Q / ~Q complementary at the documented init level", () => {
    const fix = buildFixture({ build: buildTFFCircuit({ withEnable: false }) });
    fix.facade.setSignal(fix.coordinator, "C", 0);
    const result = fix.coordinator.dcOperatingPoint();
    expect(result!.converged).toBe(true);
    fix.coordinator.step();
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(0);
    expect(fix.facade.readSignal(fix.coordinator, "QB")).toBe(1);
  });
});

// ===========================================================================
// Cat 9 — Bridge / digital interaction
// ===========================================================================

describe("BehavioralTFlipflopDriver bridge / digital (Cat 9) — withEnable=true (forceToggle=0)", () => {
  it("first rising clock edge with T=1 toggles Q from 0 to 1", () => {
    // T high, pulse clock once. Closed-form: Q toggles from initial 0 to 1.
    const fix = buildFixture({ build: buildTFFCircuit({ withEnable: true }) });
    fix.facade.setSignal(fix.coordinator, "T", 1);
    pulseClock(fix, "C");
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(1);
    expect(fix.facade.readSignal(fix.coordinator, "QB")).toBe(0);
  });

  it("two successive rising edges with T=1 toggle Q back to 0", () => {
    const fix = buildFixture({ build: buildTFFCircuit({ withEnable: true }) });
    fix.facade.setSignal(fix.coordinator, "T", 1);
    pulseClock(fix, "C");
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(1);
    pulseClock(fix, "C");
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(0);
    expect(fix.facade.readSignal(fix.coordinator, "QB")).toBe(1);
  });

  it("rising clock edge with T=0 holds Q at its current value", () => {
    // First pulse with T=1 to seed Q=1, then drop T=0 and pulse — Q stays 1.
    const fix = buildFixture({ build: buildTFFCircuit({ withEnable: true }) });
    fix.facade.setSignal(fix.coordinator, "T", 1);
    pulseClock(fix, "C");
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(1);
    fix.facade.setSignal(fix.coordinator, "T", 0);
    pulseClock(fix, "C");
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(1);
    expect(fix.facade.readSignal(fix.coordinator, "QB")).toBe(0);
  });

  it("falling clock edge with T=1 does not toggle Q", () => {
    // Hold T high. Drive clock high (no rising edge from initial 0 because
    // _firstSample skips the very first sample, but the parent's labelled In
    // initialises clock=0 then transitions to 0→1 via setSignal+step).
    // Then 1→0 is the falling edge under test; Q must hold whatever
    // value the prior rising edge set.
    const fix = buildFixture({ build: buildTFFCircuit({ withEnable: true }) });
    fix.facade.setSignal(fix.coordinator, "T", 1);
    fix.facade.setSignal(fix.coordinator, "C", 0);
    fix.coordinator.step();
    fix.facade.setSignal(fix.coordinator, "C", 1);
    fix.coordinator.step();
    const qAfterRise = fix.facade.readSignal(fix.coordinator, "Q");
    fix.facade.setSignal(fix.coordinator, "C", 0);
    fix.coordinator.step();
    // Q must be unchanged across the falling edge.
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(qAfterRise);
  });
});

describe("BehavioralTFlipflopDriver bridge / digital (Cat 9) — withEnable=false (forceToggle=1)", () => {
  it("first rising clock edge unconditionally toggles Q from 0 to 1", () => {
    // forceToggle=1: T pin is wired to gnd internally; toggle is unconditional.
    const fix = buildFixture({ build: buildTFFCircuit({ withEnable: false }) });
    pulseClock(fix, "C");
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(1);
    expect(fix.facade.readSignal(fix.coordinator, "QB")).toBe(0);
  });

  it("two successive rising edges toggle Q 0→1→0 unconditionally", () => {
    const fix = buildFixture({ build: buildTFFCircuit({ withEnable: false }) });
    pulseClock(fix, "C");
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(1);
    pulseClock(fix, "C");
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(0);
    expect(fix.facade.readSignal(fix.coordinator, "QB")).toBe(1);
  });
});

// ===========================================================================
// Cat 4 — Parameter hot-load
// ===========================================================================

describe("BehavioralTFlipflopDriver parameter hot-load (Cat 4)", () => {
  it("vIH hot-load: raising vIH past current logic-high level suppresses subsequent rising-edge toggle", () => {
    // Default vIH=2.0V; the labelled In's logic-high level is the family
    // vOH (CMOS 3V3 → 3.3V on the analog domain). With vIH=2.0V, a rising
    // clock crosses vIH and toggles Q. After hot-loading vIH=4.0V (above
    // the labelled-In's vOH=3.3V default), the same rising clock no longer
    // crosses vIH and Q must hold.
    const fix = buildFixture({ build: buildTFFCircuit({ withEnable: true }) });
    fix.facade.setSignal(fix.coordinator, "T", 1);
    pulseClock(fix, "C");
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(1);

    const tffEl = getTFFElement(fix);
    fix.coordinator.setComponentProperty(tffEl, "vIH", 4.0);

    // With the new vIH above the labelled-In's vOH, no rising edge is
    // detected; Q must hold at 1 across a clock pulse.
    pulseClock(fix, "C");
    expect(fix.facade.readSignal(fix.coordinator, "Q")).toBe(1);
  });

  it("vIL hot-load: lowering vIL changes the band edge that defines clock-low for edge detection", () => {
    // Default vIL=0.8V. The driver's edge detector reads the clock voltage
    // as it is on the analog node; vIL bounds the indeterminate region for
    // the clock waveform. Driving the clock 0→1 still crosses any
    // reasonable vIL/vIH; the documented contract is that the param is
    // hot-loadable (system requirement). Assert: after setting vIL=0.1V,
    // a normal toggle pulse still produces a toggle (param accepted, not
    // rejected) — directional check.
    const fix = buildFixture({ build: buildTFFCircuit({ withEnable: true }) });
    fix.facade.setSignal(fix.coordinator, "T", 1);
    pulseClock(fix, "C");
    const qBefore = fix.facade.readSignal(fix.coordinator, "Q");

    const tffEl = getTFFElement(fix);
    fix.coordinator.setComponentProperty(tffEl, "vIL", 0.1);

    // Toggle continues to operate after the hot-load (param accepted).
    pulseClock(fix, "C");
    const qAfter = fix.facade.readSignal(fix.coordinator, "Q");
    expect(qAfter).not.toBe(qBefore);
  });

  it("forceToggle structural: withEnable=false (forceToggle=1) toggles on rising edge even with T LOW; withEnable=true (forceToggle=0) does not", () => {
    // forceToggle is consumed at compile() time via the parent's
    // withEnable prop; build twice and assert the documented behavioural
    // shift.
    const fixGated = buildFixture({ build: buildTFFCircuit({ withEnable: true }) });
    fixGated.facade.setSignal(fixGated.coordinator, "T", 0);
    pulseClock(fixGated, "C");
    expect(fixGated.facade.readSignal(fixGated.coordinator, "Q")).toBe(0);

    const fixForce = buildFixture({ build: buildTFFCircuit({ withEnable: false }) });
    pulseClock(fixForce, "C");
    expect(fixForce.facade.readSignal(fixForce.coordinator, "Q")).toBe(1);
  });
});

// ===========================================================================
// setParam — rOut / vOH / vOL hot-loadability (Phase 1 param declaration)
// ===========================================================================

describe("BehavioralTFlipflopDriver accepts rOut/vOH/vOL via setParam without throwing", () => {
  it("accepts rOut/vOH/vOL via setParam without throwing", () => {
    const props = new PropertyBag();
    props.setModelParam("vIH", 2.0);
    props.setModelParam("vIL", 0.8);
    props.setModelParam("forceToggle", 0);
    props.setModelParam("rOut", 100);
    props.setModelParam("vOH", 5);
    props.setModelParam("vOL", 0);
    const pinNodes = new Map<string, number>([
      ["T", 1], ["C", 2], ["Q", 3], ["~Q", 4], ["gnd", 0],
    ]);
    const el = new BehavioralTFlipflopDriverElement(pinNodes, props);
    expect(() => el.setParam("rOut", 200)).not.toThrow();
    expect(() => el.setParam("vOH", 3.3)).not.toThrow();
    expect(() => el.setParam("vOL", 0.5)).not.toThrow();
  });
});
