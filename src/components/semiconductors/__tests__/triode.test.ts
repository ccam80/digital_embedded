/**
 * Triode (Koren model) — canonical analog component tests.
 * Canon set: 1, 2, 3, 4, 5. File tier: harness (T3 + T1).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import { describeIfDll } from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";
import { isPoolBacked, type PoolBackedAnalogElement } from "../../../solver/analog/element.js";

const DTS_TRIODE_CC = path.resolve(
  "src/components/semiconductors/__tests__/fixtures/triode-canon-common-cathode.dts",
);
const DTS_TRIODE_CUTOFF = path.resolve(
  "src/components/semiconductors/__tests__/fixtures/triode-canon-cutoff.dts",
);

// ---------------------------------------------------------------------------
// Helper: build a programmatic 12AX7 common-cathode amplifier fixture.
// V_PP = 250V, R_P = 100kΩ → forward-active operating point with V_GK ≈ -2V
// from a 1MΩ grid resistor pulled to a 2V negative bias source.
// ---------------------------------------------------------------------------

function buildCommonCathode(): ReturnType<typeof buildFixture> {
  return buildFixture({
    build: (_r, f) => f.build({
      components: [
        { id: "vp",  type: "DcVoltageSource", props: { label: "V_PP",   voltage: 250 } },
        { id: "vg",  type: "DcVoltageSource", props: { label: "V_BIAS", voltage: 2   } },
        { id: "rp",  type: "Resistor",        props: { label: "R_P",    resistance: 100000  } },
        { id: "rg",  type: "Resistor",        props: { label: "R_G",    resistance: 1000000 } },
        { id: "v1",  type: "Triode",          props: { label: "V1" } },
        { id: "gnd", type: "Ground",          props: { label: "GND" } },
      ],
      connections: [
        ["vp:pos", "rp:pos"],
        ["rp:neg", "v1:P"],
        ["vg:neg", "rg:pos"],
        ["rg:neg", "v1:G"],
        ["v1:K",   "gnd:out"],
        ["vp:neg", "gnd:out"],
        ["vg:pos", "gnd:out"],
      ],
    }),
  });
}

function findTriodeAnalog(fix: ReturnType<typeof buildFixture>): {
  idx: number;
  el: PoolBackedAnalogElement;
} {
  // The user-facing Triode is a netlist subcircuit emitting one TriodeAnalog
  // sub-element. The pool-backed analog leaf is what carries stateSchema and
  // pool slots, so locate the leaf by Koren-distinctive state-schema slots.
  for (let i = 0; i < fix.circuit.elements.length; i++) {
    const candidate = fix.circuit.elements[i]!;
    if (!isPoolBacked(candidate)) continue;
    if (candidate.stateSchema.indexOf.has("VGK")
        && candidate.stateSchema.indexOf.has("IP")) {
      return { idx: i, el: candidate };
    }
  }
  throw new Error("Triode analog leaf not found in compiled circuit");
}

// ---------------------------------------------------------------------------
// Category 1 — Initialization (T1)
// Post-warm-start contract: cathode is bonded to GND, so V_K === 0 exactly,
// and the V_PP rail node sits at +V_PP = 250V (DC source clamps it). The
// cached-op-point pool slots VPK and VGK must equal the closed-form node
// differences observed at the post-warm-start solution (V_PK = V_P - V_K =
// V_P, V_GK = V_G - V_K = V_G).
// ---------------------------------------------------------------------------

describe("Triode initialization (T1)", () => {
  it("init_seeded_op_point_slots", () => {
    const fix = buildCommonCathode();
    const { el } = findTriodeAnalog(fix);
    const SLOT_VGK = el.stateSchema.indexOf.get("VGK")!;
    const SLOT_VPK = el.stateSchema.indexOf.get("VPK")!;

    // Cathode bonded directly to ground → V_K = 0 exactly.
    const vK = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("V1:K")!);
    expect(vK).toBe(0);

    // V_PP source clamps its positive node to +250V.
    const vPP = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("V_PP:pos")!);
    expect(vPP).toBeCloseTo(250, 9);

    // Post-warm-start, cached VPK / VGK slots equal the closed-form
    // differences of the solved node voltages (slots are caches of the
    // node-voltage subtractions evaluated at the converged operating point).
    const vP = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("V1:P")!);
    const vG = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("V1:G")!);
    expect(fix.pool.state0[el._stateBase + SLOT_VPK]).toBeCloseTo(vP - vK, 9);
    expect(fix.pool.state0[el._stateBase + SLOT_VGK]).toBeCloseTo(vG - vK, 9);
  });
});

// ---------------------------------------------------------------------------
// Category 2 — DC operating point (T1, analytical sanity)
// Forward-active common-cathode amplifier: V_PP = 250V into R_P = 100kΩ then
// triode plate. Default 12AX7 Koren params produce I_P on the order of
// 1 mA at V_GK ≈ -2V → plate voltage drops below V_PP by I_P · R_P.
// Strictly: 0 < V_P < V_PP and the cathode is at ground.
// ---------------------------------------------------------------------------

describe("Triode DCOP analytical sanity (T1)", () => {
  it("dcop_common_cathode_grid_and_cathode_closed_form", () => {
    const fix = buildCommonCathode();
    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);

    // Closed-form node voltages at the operating point:
    //   V_K === 0 (cathode bonded directly to ground).
    //   V_PP === +250 (DC source clamps the rail).
    //   V_G ≈ -2 (V_BIAS source ties V_BIAS:neg to -2V w.r.t. ground;
    //   R_G carries ~zero grid current at V_GK<0 cutoff so V_G follows
    //   V_BIAS:neg).
    const vK = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("V1:K")!);
    const vPP = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("V_PP:pos")!);
    const vG = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("V1:G")!);
    expect(vK).toBe(0);
    expect(vPP).toBeCloseTo(250, 9);
    expect(vG).toBeCloseTo(-2, 3);
  });
});

// ---------------------------------------------------------------------------
// Category 4 — Parameter hot-load (T1)
// Triode model parameters: mu, kp, kg1 (primary structural); kvb, ex, rGI
// (secondary). One it() per primary-group representative plus one for the
// rGI grid-input-resistance secondary parameter. Each asserts the plate
// node moves observably after setComponentProperty + step.
// ---------------------------------------------------------------------------

describe("Triode parameter hot-load (T1)", () => {
  it("hotload_mu_changes_plate", () => {
    const fix = buildCommonCathode();
    const ce = fix.element("V1");
    const vpNode = fix.circuit.labelToNodeId.get("V1:P")!;
    const before = fix.engine.getNodeVoltage(vpNode);
    // µ = 100 → 50: lower amplification factor reduces plate-current
    // dependence on grid bias; at V_GK ≈ -2V, lower µ raises I_P → V_P drops.
    fix.coordinator.setComponentProperty(ce, "mu", 50);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vpNode);
    expect(after).not.toBeCloseTo(before, 6);
  });

  it("hotload_kp_changes_plate", () => {
    const fix = buildCommonCathode();
    const ce = fix.element("V1");
    const vpNode = fix.circuit.labelToNodeId.get("V1:P")!;
    const before = fix.engine.getNodeVoltage(vpNode);
    // K_P scales the inner argument of the log1p(exp(...)) Koren term;
    // doubling it changes the V_PK sensitivity of E1 and thus I_P.
    fix.coordinator.setComponentProperty(ce, "kp", 1200);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vpNode);
    expect(after).not.toBeCloseTo(before, 6);
  });

  it("hotload_kg1_changes_plate", () => {
    const fix = buildCommonCathode();
    const ce = fix.element("V1");
    const vpNode = fix.circuit.labelToNodeId.get("V1:P")!;
    const before = fix.engine.getNodeVoltage(vpNode);
    // K_G1 scales the transconductance: I_P = (E1/K_G1)^EX.
    // Doubling K_G1 reduces I_P, raising V_P toward V_PP.
    fix.coordinator.setComponentProperty(ce, "kg1", 2120);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vpNode);
    expect(after).not.toBeCloseTo(before, 6);
    expect(after).toBeGreaterThan(before);
  });

  it("hotload_ex_changes_plate", () => {
    const fix = buildCommonCathode();
    const ce = fix.element("V1");
    const vpNode = fix.circuit.labelToNodeId.get("V1:P")!;
    const before = fix.engine.getNodeVoltage(vpNode);
    // EX is the Koren current exponent; raising it from 1.4 to 1.6 increases
    // I_P sensitivity to E1 → V_P shifts.
    fix.coordinator.setComponentProperty(ce, "ex", 1.6);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vpNode);
    expect(after).not.toBeCloseTo(before, 6);
  });

  it("hotload_kvb_changes_plate", () => {
    const fix = buildCommonCathode();
    const ce = fix.element("V1");
    const vpNode = fix.circuit.labelToNodeId.get("V1:P")!;
    const before = fix.engine.getNodeVoltage(vpNode);
    // K_VB enters the sqrt(K_VB + V_PK²) denominator inside E1; a 10× change
    // shifts the grid-plate interaction term and reshapes I_P.
    fix.coordinator.setComponentProperty(ce, "kvb", 30);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vpNode);
    expect(after).not.toBeCloseTo(before, 6);
  });

  it("hotload_rGI_changes_plate", () => {
    const fix = buildCommonCathode();
    const ce = fix.element("V1");
    const vpNode = fix.circuit.labelToNodeId.get("V1:P")!;
    const before = fix.engine.getNodeVoltage(vpNode);
    // rGI is the grid input resistance (secondary param). Changing it
    // observably modifies the grid-side load and thus the operating point.
    fix.coordinator.setComponentProperty(ce, "rGI", 4000);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vpNode);
    expect(after).not.toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Category 2-numerical / 3 / 5 — Harness sessions (T3)
// One describe()/session per .dts. Sessions open in beforeAll, runs go in the
// FIRST it() per session-sharing rules, dispose in afterAll. Gated on
// canonical dllAvailable() via describeIfDll.
// ---------------------------------------------------------------------------

describeIfDll("Triode common-cathode paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.createSelfCompare({
      dtsPath: DTS_TRIODE_CC,
      analysis: "tran",
      tStop: 1e-4,
      maxStep: 1e-6,
    });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_common_cathode", async () => {
    await session.runTransient(0, 1e-4, 1e-6);
    session.compareAllSteps();
  });

  it("dcop_paired_common_cathode", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
    for (const [, comp] of Object.entries(stepEnd.components)) {
      for (const [, cv] of Object.entries(comp.slots ?? {})) {
        expect(cv.withinTol).toBe(true);
      }
    }
  });

  it("full_iteration_paired_common_cathode", () => {
    session.compareAllAttempts();
  });
});

describeIfDll("Triode cutoff paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.createSelfCompare({
      dtsPath: DTS_TRIODE_CUTOFF,
      analysis: "tran",
      tStop: 1e-4,
      maxStep: 1e-6,
    });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_cutoff", async () => {
    await session.runTransient(0, 1e-4, 1e-6);
    session.compareAllSteps();
  });

  it("dcop_paired_cutoff", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
    for (const [, comp] of Object.entries(stepEnd.components)) {
      for (const [, cv] of Object.entries(comp.slots ?? {})) {
        expect(cv.withinTol).toBe(true);
      }
    }
  });

  it("full_iteration_paired_cutoff", () => {
    session.compareAllAttempts();
  });
});
