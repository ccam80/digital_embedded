import { describe, it, expect } from "vitest";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { AnalogFuseElement, ANALOG_FUSE_SCHEMA } from "../analog-fuse.js";

import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

// ---------------------------------------------------------------------------
// Programmatic circuit factory (T1)
//
// Topology: Vsource (vs) -> fuse:out1 -> fuse:out2 -> Resistor (rl) -> Ground.
// vs:neg also tied to Ground. Steady-state intact current
//   I = vSource / (rCold + rLoad)
// Voltage at fuse:out2 (the rl:pos node) =
//   vSource * rLoad / (rLoad + rCold).
// ---------------------------------------------------------------------------

interface FuseCircuitParams {
  vSource: number;
  rLoad: number;
  rCold?: number;
  rBlown?: number;
  i2tRating: number;
}

function buildFuseCircuit(facade: DefaultSimulatorFacade, p: FuseCircuitParams): Circuit {
  return facade.build({
    components: [
      { id: "vs",   type: "DcVoltageSource", props: { label: "vs", voltage: p.vSource } },
      { id: "fuse", type: "Fuse",            props: { label: "fuse", model: "behavioral", rCold: p.rCold ?? 0.01, rBlown: p.rBlown ?? 1e9, i2tRating: p.i2tRating } },
      { id: "rl",   type: "Resistor",        props: { label: "rl", resistance: p.rLoad } },
      { id: "gnd",  type: "Ground",          props: { label: "gnd" } },
    ],
    connections: [
      ["vs:pos",    "fuse:out1"],
      ["fuse:out2", "rl:pos"],
      ["rl:neg",    "gnd:out"],
      ["vs:neg",    "gnd:out"],
    ],
  });
}

function nodeOf(fix: ReturnType<typeof buildFixture>, label: string): number {
  const n = fix.circuit.labelToNodeId.get(label);
  if (n === undefined) throw new Error(`label '${label}' not in labelToNodeId`);
  return n;
}

function findFuseElement(elements: ReadonlyArray<unknown>): AnalogFuseElement {
  const idx = elements.findIndex((el) => el instanceof AnalogFuseElement);
  if (idx < 0) throw new Error("AnalogFuseElement not found in compiled circuit");
  return elements[idx] as AnalogFuseElement;
}

// ---------------------------------------------------------------------------
// Cat 1 — Initialization (T1)
// ---------------------------------------------------------------------------

describe("AnalogFuse initialization (T1)", () => {
  it("init_pool_slots_post_warm_start_intact", () => {
    // Cat 1: post-warm-start, the fuse is intact -> CONDUCT slot reads 1 in
    // both pool bands (load() writes s0[CONDUCT] each iter from _intact;
    // accepted step rotation copies s0->s1). I2T_ACCUM has had ~1 dt of
    // accumulation but is well below i2tRating, so the fuse is still intact.
    const fix = buildFixture({
      build: (_r, facade) => buildFuseCircuit(facade, {
        vSource: 5.0, rLoad: 9.0, rCold: 0.01, i2tRating: 100.0,
      }),
      params: { tStop: 1e-3, maxTimeStep: 1e-5 },
    });
    const fuse = findFuseElement(fix.circuit.elements);
    const slotConduct = ANALOG_FUSE_SCHEMA.indexOf.get("CONDUCT")!;
    expect(fix.pool.state0[fuse._stateBase + slotConduct]).toBe(1);
    expect(fix.pool.state1[fuse._stateBase + slotConduct]).toBe(1);
    expect(fuse.blown).toBe(false);
  });

  it("init_node_voltages_post_warm_start_intact_divider", () => {
    // Cat 1: closed-form node voltage at fuse:out2.
    //   I = 5 / (0.01 + 9) = 0.55494A
    //   V(fuse:out2) = I * rLoad = 0.55494 * 9 = 4.99445V
    const fix = buildFixture({
      build: (_r, facade) => buildFuseCircuit(facade, {
        vSource: 5.0, rLoad: 9.0, rCold: 0.01, i2tRating: 100.0,
      }),
      params: { tStop: 1e-3, maxTimeStep: 1e-5 },
    });
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "fuse:out2"))).toBeCloseTo(
      5.0 * 9.0 / (9.0 + 0.01), 4,
    );
  });
});

// ---------------------------------------------------------------------------
// Cat 2 analytical — DCOP (T1)
// ---------------------------------------------------------------------------

describe("AnalogFuse DCOP analytical (T1)", () => {
  it("dcop_intact_voltage_divider", () => {
    // Cat 2 analytical: intact regime, closed-form DC voltages.
    //   V(fuse:out1) = vs (5V).
    //   V(fuse:out2) = 5 * 9/(9+0.01) = 4.99445V.
    const fix = buildFixture({
      build: (_r, facade) => buildFuseCircuit(facade, {
        vSource: 5.0, rLoad: 9.0, rCold: 0.01, i2tRating: 100.0,
      }),
    });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "fuse:out1"))).toBeCloseTo(5.0, 6);
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "fuse:out2"))).toBeCloseTo(
      5.0 * 9.0 / (9.0 + 0.01), 4,
    );
  });

  it("dcop_intact_low_voltage_lower_divider", () => {
    // Cat 2 analytical second operating-region: lower vSource and rCold pinned
    // to the same value -> verifies linearity of the cold-resistance stamp.
    //   V(fuse:out2) = 1 * 9/(9+0.01) = 0.99889V.
    const fix = buildFixture({
      build: (_r, facade) => buildFuseCircuit(facade, {
        vSource: 1.0, rLoad: 9.0, rCold: 0.01, i2tRating: 100.0,
      }),
    });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "fuse:out2"))).toBeCloseTo(
      1.0 * 9.0 / (9.0 + 0.01), 4,
    );
  });
});

// ---------------------------------------------------------------------------
// Cat 4 — Parameter hot-load (T1)
// ---------------------------------------------------------------------------

describe("AnalogFuse parameter hot-load (T1)", () => {
  it("hotload_rCold_changes_intact_output_voltage", () => {
    // Cat 4: setComponentProperty on rCold changes the voltage-divider ratio
    // between fuse:out1 and fuse:out2.
    //   rCold=0.01 -> V(fuse:out2) = 5 * 9/(9+0.01)  = 4.99445V
    //   rCold=100  -> V(fuse:out2) = 5 * 9/(9+100)   = 0.41284V
    const fix = buildFixture({
      build: (_r, facade) => buildFuseCircuit(facade, {
        vSource: 5.0, rLoad: 9.0, rCold: 0.01, i2tRating: 100.0,
      }),
    });
    const outNode = nodeOf(fix, "fuse:out2");
    const before = fix.engine.getNodeVoltage(outNode);
    expect(before).toBeCloseTo(5.0 * 9.0 / (9.0 + 0.01), 4);

    const fuseCe = fix.element("fuse");
    fix.coordinator.setComponentProperty(fuseCe, "rCold", 100);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(outNode);
    expect(after).not.toBeCloseTo(before);
    expect(after).toBeCloseTo(5.0 * 9.0 / (9.0 + 100), 4);
  });

  it("hotload_i2tRating_shifts_blow_time", () => {
    // Cat 4: setComponentProperty on i2tRating changes when the fuse blows.
    //   I = 30 / (0.01 + 1) = 29.7030A; I^2 = 882.27 A^2
    //   With rating=10  A^2s, t_blow_pred = 10 / 882.27  = 0.011333 s.
    //   With rating=0.1 A^2s, t_blow_pred = 0.1 / 882.27 = 0.0001133 s
    //                                                   = 113.3 us.
    // Drop the rating before blow has occurred -> the fuse must blow at the
    // smaller predicted time.
    const fix = buildFixture({
      build: (_r, facade) => buildFuseCircuit(facade, {
        vSource: 30.0, rLoad: 1.0, rCold: 0.01, i2tRating: 10.0,
      }),
      params: { tStop: 1e-3, maxTimeStep: 1e-6 },
    });
    const fuse = findFuseElement(fix.circuit.elements);
    expect(fuse.blown).toBe(false);

    const fuseCe = fix.element("fuse");
    fix.coordinator.setComponentProperty(fuseCe, "i2tRating", 0.1);

    // Step until blown or simTime exceeds the original (rating=10) prediction.
    while (!fuse.blown && fix.engine.simTime !== null && fix.engine.simTime < 5e-4) {
      fix.coordinator.step();
    }
    expect(fuse.blown).toBe(true);
    // Blow occurred well before the rating=10 prediction (0.0113s).
    expect(fix.engine.simTime!).toBeLessThan(1e-3);
  });
});

// ---------------------------------------------------------------------------
// Cat 8 — Breakpoint registration (T1)
// ---------------------------------------------------------------------------

describe("AnalogFuse breakpoint registration (T1)", () => {
  it("breakpoint_blow_predicted_time_lands_in_convergence_log", () => {
    // Cat 8: acceptStep predicts t_blow = simTime + (rating - accum)/i^2 and
    // calls addBreakpoint(t_blow). The transient controller then lands a step
    // at exactly t_blow -> a step record with that endTime appears in the
    // convergence log.
    //   I = 30/(0.01+1) = 29.7030A; I^2 = 882.27 A^2
    //   With rating=1, t_blow = 1 / 882.27 = 1.1335e-3 s.
    const fix = buildFixture({
      build: (_r, facade) => buildFuseCircuit(facade, {
        vSource: 30.0, rLoad: 1.0, rCold: 0.01, i2tRating: 1.0,
      }),
      params: { tStop: 5e-3, maxTimeStep: 1e-4 },
    });
    fix.coordinator.setConvergenceLogEnabled(true);

    const fuse = findFuseElement(fix.circuit.elements);
    while (!fuse.blown && fix.engine.simTime !== null && fix.engine.simTime < 5e-3) {
      fix.coordinator.step();
    }
    expect(fuse.blown).toBe(true);

    // The log records every accepted step; one of them must end exactly at
    // the blow instant the engine landed on after acceptStep registered it.
    const log = fix.coordinator.getConvergenceLog()!;
    expect(log).not.toBeNull();
    const blowEndTime = fix.engine.simTime!;
    const bpStep = log.find((s) => (s.simTime + s.acceptedDt) === blowEndTime);
    expect(bpStep).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Cat 14 — Runtime-diagnostic emission (T1)
//
// AnalogFuseElement.acceptStep() emits exactly one "fuse-blown" info-severity
// diagnostic the first accepted step after I²t crosses i2tRating, gated by
// _diagEmitted. Engine wires emission through coordinator.getRuntimeDiagnostics().
// ---------------------------------------------------------------------------

describe("AnalogFuse runtime-diagnostic emission (Cat 14)", () => {
  it("emits_fuse_blown_when_i2t_exceeds_rating", () => {
    // V=30V, rCold=1, rBlown=1e9, rL=9 → I = 3A, I² = 9 A²/s.
    // i2tRating = 1 A²·s → t_blow ≈ 1/9 ≈ 0.111s < 0.5s tStop bound.
    const fix = buildFixture({
      build: (_r, facade) => buildFuseCircuit(facade, {
        vSource: 30.0, rLoad: 9.0, rCold: 1.0, rBlown: 1e9, i2tRating: 1.0,
      }),
      params: { tStop: 0.5, maxTimeStep: 1e-3 },
    });
    const fuse = findFuseElement(fix.circuit.elements);
    while (!fuse.blown && fix.engine.simTime !== null && fix.engine.simTime < 0.5) {
      fix.coordinator.step();
    }
    expect(fuse.blown).toBe(true);

    const diags = fix.coordinator.getRuntimeDiagnostics()
      .filter((d) => d.code === "fuse-blown");
    expect(diags.length).toBe(1);
    expect(diags[0].severity).toBe("info");
  });
});

// ---------------------------------------------------------------------------
// Cat 15 — Cross-engine state-bridge writeback (T1)
//
// AnalogFuseElement's factory installs an _onStateChange callback that mirrors
// the blown flag into the CircuitElement's PropertyBag. Once the fuse blows,
// the documented "blown" key must read true via CircuitElement.getProperties().
// ---------------------------------------------------------------------------

describe("AnalogFuse cross-engine writeback (Cat 15)", () => {
  it("writeback_blown_flag_when_i2t_exceeds_rating", () => {
    // Same topology and bound as the Cat 14 test- once the fuse blows, the
    // PropertyBag bridge writes `blown: true` for the visual/digital layer.
    const fix = buildFixture({
      build: (_r, facade) => buildFuseCircuit(facade, {
        vSource: 30.0, rLoad: 9.0, rCold: 1.0, rBlown: 1e9, i2tRating: 1.0,
      }),
      params: { tStop: 0.5, maxTimeStep: 1e-3 },
    });
    const fuse = findFuseElement(fix.circuit.elements);
    while (!fuse.blown && fix.engine.simTime !== null && fix.engine.simTime < 0.5) {
      fix.coordinator.step();
    }
    expect(fuse.blown).toBe(true);

    const fuseCe = fix.element("fuse");
    const props = fuseCe.getProperties();
    expect(props.get("blown")).toBe(true);
  });
});
