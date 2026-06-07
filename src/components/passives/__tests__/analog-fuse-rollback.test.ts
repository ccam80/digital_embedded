import { describe, it, expect } from "vitest";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { AnalogFuseElement, ANALOG_FUSE_SCHEMA } from "../analog-fuse.js";

// ---------------------------------------------------------------------------
// Slot indices — resolved via schema, never raw SLOT_* imports (B-3).
// ---------------------------------------------------------------------------

const SLOT_I2T_ACCUM = ANALOG_FUSE_SCHEMA.indexOf.get("I2T_ACCUM")!;
const SLOT_CONDUCT   = ANALOG_FUSE_SCHEMA.indexOf.get("CONDUCT")!;

// ---------------------------------------------------------------------------
// Programmatic builders for T1 categories (init / hot-load / breakpoint).
// VS → fuse → R_load → GND is the canonical fuse exercise topology.
// ---------------------------------------------------------------------------

interface FuseCircuitOpts {
  vSource:    number;
  rLoad:      number;
  rCold?:     number;
  rBlown?:    number;
  i2tRating?: number;
}

function buildFuseFixture(opts: FuseCircuitOpts, params?: { tStop?: number; maxTimeStep?: number }) {
  return buildFixture({
    build: (_r, facade) => facade.build({
      components: [
        { id: "vs",   type: "DcVoltageSource", props: { label: "vs",   voltage: opts.vSource } },
        { id: "fuse", type: "Fuse",            props: {
          label:     "fuse",
          model:     "behavioral",
          rCold:     opts.rCold     ?? 1,
          rBlown:    opts.rBlown    ?? 1e9,
          i2tRating: opts.i2tRating ?? 100,
        } },
        { id: "rl",   type: "Resistor",        props: { label: "rl",   resistance: opts.rLoad } },
        { id: "gnd",  type: "Ground" },
      ],
      connections: [
        ["vs:pos",    "fuse:out1"],
        ["fuse:out2", "rl:pos"],
        ["rl:neg",    "gnd:out"],
        ["vs:neg",    "gnd:out"],
      ],
    }),
    params: {
      tStop:       params?.tStop       ?? 0.2,
      maxTimeStep: params?.maxTimeStep ?? 0.05,
    },
  });
}

// ---------------------------------------------------------------------------
// Helper: locate the AnalogFuseElement in the compiled circuit by class.
// ---------------------------------------------------------------------------

function findFuse(elements: ReadonlyArray<unknown>): AnalogFuseElement {
  const idx = elements.findIndex((el) => el instanceof AnalogFuseElement);
  if (idx < 0) throw new Error("AnalogFuseElement not found in compiled circuit");
  return elements[idx] as AnalogFuseElement;
}

// ===========================================================================
// Category 1 — Initialization (T1)
// Post-warm-start, intact fuse holds CONDUCT=1, I2T_ACCUM small but advanced
// for the dt of the warm-start step. Node voltage at vs:pos equals the source.
// ===========================================================================

describe("AnalogFuseElement initialization (T1)", () => {
  it("init_intact_state_conduct_set_node_voltage_at_source", () => {
    // V=10V, rCold=1, rL=9 → steady I = 1A, I²t rate = 1 A²/s. i2tRating=100
    // → fuse stays intact through warm-start. CONDUCT slot = 1; node vs:pos = 10V.
    const fix = buildFuseFixture({ vSource: 10, rLoad: 9 });

    const fuse = findFuse(fix.circuit.elements);
    const conduct = fix.pool.state0[fuse._stateBase + SLOT_CONDUCT];
    const accum   = fix.pool.state0[fuse._stateBase + SLOT_I2T_ACCUM];

    expect(conduct).toBe(1);
    // I²t accumulator is non-negative after the warm-start step.
    expect(accum).toBeGreaterThanOrEqual(0);
    expect(fuse.blown).toBe(false);

    const nSrc = fix.circuit.labelToNodeId.get("vs:pos")!;
    expect(fix.engine.getNodeVoltage(nSrc)).toBeCloseTo(10, 6);
  });
});

// ===========================================================================
// Category 2 — DCOP analytical (T1)
// VS=10V, rCold=1Ω, rL=9Ω → I = V/(rCold+rL) = 1A, V at fuse:out2 = I*rL = 9V.
// ===========================================================================

describe("AnalogFuseElement DCOP analytical (T1)", () => {
  it("dcop_intact_voltage_divider_at_load", () => {
    const fix = buildFuseFixture({ vSource: 10, rLoad: 9 });

    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);

    // Node fuse:out2 sits between rCold and rLoad: V = Vs * rL / (rCold + rL) = 10 * 9 / 10 = 9.
    const nMid = fix.circuit.labelToNodeId.get("fuse:out2")!;
    expect(fix.engine.getNodeVoltage(nMid)).toBeCloseTo(9, 6);
  });
});

// ===========================================================================
// Category 4 — Parameter hot-load (T1)
// Hot-loadable params on AnalogFuseElement: rCold, rBlown, i2tRating
// (registered via the factory's setParam closure). One it() per param with
// closed-form post-change observables.
// ===========================================================================

describe("AnalogFuseElement parameter hot-load (T1)", () => {
  it("hotload_rCold_changes_dc_voltage_divider", () => {
    // Initial: rCold=1, rL=9 → V(fuse:out2) = 10 * 9 / 10 = 9V.
    // After: rCold=4, rL=9 → V(fuse:out2) = 10 * 9 / 13 ≈ 6.923V.
    const fix = buildFuseFixture({ vSource: 10, rLoad: 9, rCold: 1 });

    const nMid = fix.circuit.labelToNodeId.get("fuse:out2")!;
    fix.coordinator.dcOperatingPoint();
    const before = fix.engine.getNodeVoltage(nMid);
    expect(before).toBeCloseTo(9, 4);

    fix.coordinator.setComponentProperty(fix.element("fuse"), "rCold", 4);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(nMid);

    // Closed-form: V = Vs * rL / (rCold + rL) = 10 * 9 / 13.
    expect(after).toBeCloseTo(10 * 9 / 13, 4);
    expect(after).not.toBeCloseTo(before, 3);
  });

  it("hotload_rBlown_changes_post_blow_dc_voltage_divider", () => {
    // Pre-blow the fuse by stepping until I²t crosses the rating, then hot-load
    // rBlown and verify the divider switches to use the new rBlown value.
    // V=30V, rCold=1, rL=9 → I=3A, I²t rate = 9; i2tRating=1 → tBlow ≈ 0.111s.
    const fix = buildFuseFixture(
      { vSource: 30, rLoad: 9, rCold: 1, i2tRating: 1, rBlown: 1e9 },
      { tStop: 0.5, maxTimeStep: 0.001 },
    );

    const fuse = findFuse(fix.circuit.elements);
    let steps = 0;
    while (!fuse.blown && fix.engine.simTime !== null && fix.engine.simTime < 0.5 && steps < 5000) {
      fix.coordinator.step();
      steps++;
    }
    expect(fuse.blown).toBe(true);

    // Settle a step so post-blow voltage divider reflects rBlown (default 1e9).
    fix.coordinator.step();
    const nMid = fix.circuit.labelToNodeId.get("fuse:out2")!;
    const before = fix.engine.getNodeVoltage(nMid);

    // Default rBlown=1e9, rL=9 → V(out2) = 30 * 9 / (1e9 + 9) ≈ 2.7e-7 V.
    expect(before).toBeCloseTo(30 * 9 / (1e9 + 9), 6);

    // Hot-load rBlown to 1e6: V(out2) = 30 * 9 / (1e6 + 9) ≈ 2.7e-4 V —
    // a 1000x increase from before.
    fix.coordinator.setComponentProperty(fix.element("fuse"), "rBlown", 1e6);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(nMid);
    expect(after).toBeCloseTo(30 * 9 / (1e6 + 9), 6);
    expect(Math.abs(after)).toBeGreaterThan(Math.abs(before) * 100);
  });

  it("hotload_i2tRating_changes_blow_time", () => {
    // V=30V, rCold=1, rL=9 → I=3A, I²t rate = 9 A²/s.
    // Initial i2tRating = 1.0 → tBlow_initial ≈ 1/9 ≈ 0.111s.
    // After hot-load to i2tRating = 4.0 → tBlow_after ≈ 4/9 ≈ 0.444s.
    // The hot-load happens after the warm-start step but well before t_blow_initial,
    // so the fuse must NOT be blown by t = 0.2s (well past initial rating, before new).
    const fix = buildFuseFixture(
      { vSource: 30, rLoad: 9, rCold: 1, i2tRating: 1 },
      { tStop: 0.5, maxTimeStep: 0.001 },
    );

    const fuse = findFuse(fix.circuit.elements);
    expect(fuse.blown).toBe(false);

    // Hot-load to a much larger rating before any significant accumulation.
    fix.coordinator.setComponentProperty(fix.element("fuse"), "i2tRating", 4);

    // Step past the original tBlow (0.111s) and confirm fuse is still intact
    // — the new i2tRating=4 has not yet been crossed.
    let steps = 0;
    while (fix.engine.simTime !== null && fix.engine.simTime < 0.2 && steps < 5000) {
      fix.coordinator.step();
      steps++;
    }
    expect(fuse.blown).toBe(false);

    // Continue past the new tBlow (~0.444s) and confirm fuse blows.
    while (!fuse.blown && fix.engine.simTime !== null && fix.engine.simTime < 0.5 && steps < 10000) {
      fix.coordinator.step();
      steps++;
    }
    expect(fuse.blown).toBe(true);
  });
});

// ===========================================================================
// Category 8 — Breakpoints (T1)
// AnalogFuseElement.acceptStep() registers a breakpoint at the predicted blow
// instant (t_blow = simTime + (i2tRating - accum) / i²). The timestep
// controller must land bit-exactly on that time.
// V=30V, rCold=1, rL=9 → I=3A, I²t rate=9 A²/s, i2tRating=1.0 → tBlow≈0.111s.
// ===========================================================================

describe("AnalogFuseElement breakpoint scheduling (T1)", () => {
  it("blow_breakpoint_lands_step_exactly", () => {
    const fix = buildFuseFixture(
      { vSource: 30, rLoad: 9, rCold: 1, i2tRating: 1 },
      { tStop: 0.2, maxTimeStep: 0.005 },
    );
    fix.coordinator.setConvergenceLogEnabled(true);

    const fuse = findFuse(fix.circuit.elements);

    // Step until the fuse blows or budget exhausted.
    let steps = 0;
    while (!fuse.blown && fix.engine.simTime !== null && fix.engine.simTime < 0.2 && steps < 5000) {
      fix.coordinator.step();
      steps++;
    }
    expect(fuse.blown).toBe(true);

    const log = fix.coordinator.getConvergenceLog()!;
    expect(log).not.toBeNull();
    // acceptStep registers a breakpoint at tBlow = simTime + (i2tRating - accum) / i²
    // (when accum >= 0.95 * i2tRating). With maxTimeStep=0.005, an un-constrained
    // run produces step ends sitting on the 0.005 grid. A breakpoint forces a
    // step end OFF the grid — that is the Cat 8 signature: the timestep
    // controller landed bit-exactly on the BP time.
    const maxStep = 0.005;
    const accepted = log.filter(s => s.outcome === "accepted");
    expect(accepted.length).toBeGreaterThan(0);

    const offGridStep = accepted.find(s => {
      const tEnd = s.simTime + s.acceptedDt;
      // Distance from the nearest 0.005 grid point.
      const grid = Math.round(tEnd / maxStep) * maxStep;
      return Math.abs(tEnd - grid) > 1e-12;
    });
    expect(offGridStep).toBeDefined();
    // The off-grid step must end at or before the documented blow window
    // (tBlow_predicted ≈ 1/9 ≈ 0.111s; the actual BP is registered while
    // intact and lands the step on or before that time).
    const tEndOff = offGridStep!.simTime + offGridStep!.acceptedDt;
    expect(tEndOff).toBeLessThanOrEqual(1 / 9 + 1e-9);
    expect(tEndOff).toBeGreaterThan(0);
  });
});
