import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import {
  DLL_PATH,
  describeIfDll,
} from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";
import { DIODE_SCHEMA } from "../diode.js";

const DTS_REVERSE = path.resolve(
  "src/components/semiconductors/__tests__/fixtures/varactor-canon-reverse.dts",
);
const DTS_FORWARD = path.resolve(
  "src/components/semiconductors/__tests__/fixtures/varactor-canon-forward.dts",
);

// ---------------------------------------------------------------------------
// Programmatic build helpers for T1 fixtures.
// VaractorDiode routes through createDiodeElement with cap-tuned defaults
// (CJO=20pF). With CJO > 0 the diode element uses DIODE_SCHEMA
// and registers getLteTimestep on the rollable charge slot.
//
// Forward topology: V1 -> VD:A; VD:K -> R1 -> ground. Drives the AK junction
// into forward conduction so pnjlim limiting fires.
// Reverse topology: V1 -> R1 -> VD:K; VD:A -> ground. Drives the junction
// into reverse bias (Varactor's documented operating regime: voltage-tuned Cj).
// ---------------------------------------------------------------------------

function buildVaractorForward(
  facade: import("../../../headless/default-facade.js").DefaultSimulatorFacade,
  overrides: Record<string, number> = {},
): import("../../../core/circuit.js").Circuit {
  return facade.build({
    components: [
      { id: "v1", type: "DcVoltageSource", props: { label: "V1", voltage: 0.5 } },
      { id: "d1", type: "VaractorDiode",   props: { label: "D1", ...overrides } },
      { id: "r1", type: "Resistor",        props: { label: "R1", resistance: 300 } },
      { id: "gnd", type: "Ground",         props: { label: "GND" } },
    ],
    connections: [
      ["v1:pos", "d1:A"],
      ["d1:K",   "r1:pos"],
      ["r1:neg", "gnd:out"],
      ["v1:neg", "gnd:out"],
    ],
  });
}

function buildVaractorReverse(
  facade: import("../../../headless/default-facade.js").DefaultSimulatorFacade,
  overrides: Record<string, number> = {},
): import("../../../core/circuit.js").Circuit {
  return facade.build({
    components: [
      { id: "v1", type: "DcVoltageSource", props: { label: "V1", voltage: 2 } },
      { id: "d1", type: "VaractorDiode",   props: { label: "D1", ...overrides } },
      { id: "r1", type: "Resistor",        props: { label: "R1", resistance: 10000 } },
      { id: "gnd", type: "Ground",         props: { label: "GND" } },
    ],
    connections: [
      ["v1:pos", "r1:pos"],
      ["r1:neg", "d1:K"],
      ["d1:A",   "gnd:out"],
      ["v1:neg", "gnd:out"],
    ],
  });
}

function findVD(fix: ReturnType<typeof buildFixture>) {
  const idx = fix.circuit.elements.findIndex(
    (_e, i) => fix.elementLabels.get(i) === "D1",
  );
  expect(idx).toBeGreaterThanOrEqual(0);
  const el = fix.circuit.elements[idx]!;
  const ce = fix.circuit.elementToCircuitElement.get(idx);
  expect(ce).toBeDefined();
  return { idx, el, ce: ce! };
}

// ---------------------------------------------------------------------------
// Category 1 — Initialization (T1)
// Asserts the warm-started state pool slot reads finite for the Varactor
// element after compile() + first coordinator.step(). Varactor delegates to
// createDiodeElement; with CJO=20pF default the element uses DIODE_SCHEMA.
// VD slot is the pnjlim-limited junction voltage.
// ---------------------------------------------------------------------------

describe("Varactor initialization (T1)", () => {
  const SLOT_VD = DIODE_SCHEMA.indexOf.get("VD")!;

  it("init_varactor_vd_seeded_reverse", () => {
    const fix = buildFixture({ build: (_r, f) => buildVaractorReverse(f) });
    const { el } = findVD(fix);
    const vd = fix.pool.state0[el._stateBase + SLOT_VD];
    expect(Number.isFinite(vd)).toBe(true);
    const vA = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("D1:A")!);
    const vK = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("D1:K")!);
    expect(Number.isFinite(vA)).toBe(true);
    expect(Number.isFinite(vK)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Category 2 — DC operating point (T1, analytical)
// Reverse-bias closed-form: V1=2V across the (R=10kΩ + reverse-blocked
// varactor) series chain. The reverse-blocked junction passes only IS-scale
// leakage current (≪ 1µA at 300K), so essentially V_R ≈ 0 and the cathode
// node sits at V1; the anode is grounded. Varactor reverse voltage Vd =
// V_A - V_K ≈ -2V. Bound: anode-cathode voltage stays below 0V (reverse) and
// the magnitude is close to V1.
// ---------------------------------------------------------------------------

describe("Varactor DCOP analytical (T1)", () => {
  it("dcop_varactor_reverse_vd_negative", () => {
    const fix = buildFixture({ build: (_r, f) => buildVaractorReverse(f) });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);
    const vA = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("D1:A")!);
    const vK = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("D1:K")!);
    const vd = vA - vK;
    // Reverse-bias Varactor blocks: V_R drop across R1 is microscopic, so
    // V_K ≈ V1 = 2V, V_A = 0V → Vd ≈ -2V.
    expect(vd).toBeLessThan(0);
    expect(vd).toBeLessThan(-1.5);
    expect(vd).toBeGreaterThan(-2.1);
  });
});

// ---------------------------------------------------------------------------
// Category 4 — Parameter hot-load (T1)
// Varactor exposes the diode-shared param surface via VARACTOR_PARAM_DEFS.
// Structural (CJO, IS, VJ, M, RS), depletion-cap (CJO/VJ/M govern Cj(V_R)),
// derived-state-recompute (TEMP — universal). Asserts simulator output
// changes after setComponentProperty + step.
// ---------------------------------------------------------------------------

describe("Varactor parameter hot-load (T1)", () => {
  it("hotload_IS_changes_vd_forward", () => {
    const fix = buildFixture({ build: (_r, f) => buildVaractorForward(f) });
    const { ce } = findVD(fix);
    const vAnode = fix.circuit.labelToNodeId.get("D1:A")!;
    const vCath = fix.circuit.labelToNodeId.get("D1:K")!;
    const before = fix.engine.getNodeVoltage(vAnode) - fix.engine.getNodeVoltage(vCath);
    fix.coordinator.setComponentProperty(ce, "IS", 1e-6);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vAnode) - fix.engine.getNodeVoltage(vCath);
    // Larger IS → lower forward Vf at the same current.
    expect(after).not.toBeCloseTo(before, 6);
    expect(after).toBeLessThan(before);
  });

  it("hotload_CJO_changes_dynamic_response_reverse", () => {
    // CJO is the headline Varactor parameter (junction capacitance at zero
    // bias). At DCOP the cap path is dormant (capGate is false outside
    // MODETRAN/MODEAC/MODEINITSMSIG); drive a transient step to expose the
    // cap-block recompute. Larger CJO → larger junction Cj at the same V_R.
    const fix = buildFixture({
      build: (_r, f) => buildVaractorReverse(f),
      params: { tStop: 1e-6, maxTimeStep: 1e-8 },
    });
    const { ce } = findVD(fix);
    const vCath = fix.circuit.labelToNodeId.get("D1:K")!;
    fix.coordinator.step();
    const before = fix.engine.getNodeVoltage(vCath);
    fix.coordinator.setComponentProperty(ce, "CJO", 200e-12);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vCath);
    expect(after).not.toBe(before);
  });

  it("hotload_VJ_changes_dynamic_response_reverse", () => {
    // VJ shifts the junction built-in potential, which scales the depletion
    // cap formula Cj(V_R) = CJO/(1 - V_d/VJ)^M. Drive a transient to surface
    // the cap-block recompute through the cathode-node voltage.
    const fix = buildFixture({
      build: (_r, f) => buildVaractorReverse(f),
      params: { tStop: 1e-6, maxTimeStep: 1e-8 },
    });
    const { ce } = findVD(fix);
    const vCath = fix.circuit.labelToNodeId.get("D1:K")!;
    fix.coordinator.step();
    const before = fix.engine.getNodeVoltage(vCath);
    fix.coordinator.setComponentProperty(ce, "VJ", 1.4);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vCath);
    expect(after).not.toBe(before);
  });

  it("hotload_M_changes_dynamic_response_reverse", () => {
    // M is the grading coefficient (sharpness of Cj(V) curve). Doubling M
    // changes the reverse-bias capacitance noticeably under transient drive.
    const fix = buildFixture({
      build: (_r, f) => buildVaractorReverse(f),
      params: { tStop: 1e-6, maxTimeStep: 1e-8 },
    });
    const { ce } = findVD(fix);
    const vCath = fix.circuit.labelToNodeId.get("D1:K")!;
    fix.coordinator.step();
    const before = fix.engine.getNodeVoltage(vCath);
    fix.coordinator.setComponentProperty(ce, "M", 0.95);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vCath);
    expect(after).not.toBe(before);
  });

  it("hotload_RS_changes_anode_voltage_forward", () => {
    const fix = buildFixture({ build: (_r, f) => buildVaractorForward(f) });
    const { ce } = findVD(fix);
    const vAnode = fix.circuit.labelToNodeId.get("D1:A")!;
    const before = fix.engine.getNodeVoltage(vAnode);
    fix.coordinator.setComponentProperty(ce, "RS", 50);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vAnode);
    // Larger RS → additional series voltage drop across the device →
    // anode-side node voltage shifts observably.
    expect(after).not.toBeCloseTo(before, 6);
  });

  it("hotload_TEMP_changes_vf_forward", () => {
    // TEMP is the derived-state-recompute parameter (universal). setParam
    // triggers recomputeTemp() which re-derives tIS / tVJ / tCJO / tVcrit / tBV.
    const fix = buildFixture({ build: (_r, f) => buildVaractorForward(f) });
    const { ce } = findVD(fix);
    const vAnode = fix.circuit.labelToNodeId.get("D1:A")!;
    const vCath = fix.circuit.labelToNodeId.get("D1:K")!;
    const before = fix.engine.getNodeVoltage(vAnode) - fix.engine.getNodeVoltage(vCath);
    fix.coordinator.setComponentProperty(ce, "TEMP", 400);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vAnode) - fix.engine.getNodeVoltage(vCath);
    // Raising T raises tIS exponentially → at the same forward current Vf drops.
    expect(after).not.toBeCloseTo(before, 6);
    expect(after).toBeLessThan(before);
  });
});

// ---------------------------------------------------------------------------
// Category 6 — Limiting events (T1, own engine)
// pnjlim fires on the AK junction during forward-bias DCOP NR. Drive the
// forward topology and read fix.coordinator.getLimitingEvents().
// ---------------------------------------------------------------------------

describe("Varactor limiting events own-engine (T1)", () => {
  it("limiting_pnjlim_fires_varactor_forward", () => {
    const fix = buildFixture({ build: (_r, f) => buildVaractorForward(f) });
    fix.coordinator.setLimitingCapture(true);
    fix.coordinator.dcOperatingPoint();
    const events = fix.coordinator.getLimitingEvents();
    const ak = events.find(e => e.label === "D1" && e.junction === "AK");
    expect(ak).toBeDefined();
    expect(ak!.limitType).toBe("pnjlim");
    expect(Number.isFinite(ak!.vBefore)).toBe(true);
    expect(Number.isFinite(ak!.vAfter)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Category 7 — LTE rollback (T1)
// Varactor delegates to createDiodeElement which registers getLteTimestep
// when hasCapacitance (CJO=20pF default). The proposal reads cktTerr() over
// Q / CCAP rollable slots. Rollback invariant: after warm-start + a few
// transient steps, state0 and state1 both carry finite values for the
// rollable charge slot (rotation occurred, no NaN poisoning).
// ---------------------------------------------------------------------------

describe("Varactor LTE rollback (T1)", () => {
  it("lte_rollback_state_invariant", () => {
    const SLOT_Q = DIODE_SCHEMA.indexOf.get("Q")!;
    const fix = buildFixture({
      build: (_r, f) => buildVaractorReverse(f),
      params: { tStop: 1e-6, maxTimeStep: 1e-7 },
    });
    fix.coordinator.setConvergenceLogEnabled(true);
    for (let i = 0; i < 10; i++) fix.coordinator.step();
    const { el } = findVD(fix);
    expect(Number.isFinite(fix.pool.state0[el._stateBase + SLOT_Q])).toBe(true);
    expect(Number.isFinite(fix.pool.state1[el._stateBase + SLOT_Q])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Category 2-numerical / 3 / 5 / 6-paired — Harness sessions (T3)
// One describe()/session per .dts. Each opens once in beforeAll, runs the
// transient inside the FIRST it() (so a hard throw shows as a failed test
// rather than a silent suite-skip), reuses across categories that share that
// circuit, disposes in afterAll. Gated on canonical dllAvailable() via
// describeIfDll.
// ---------------------------------------------------------------------------

describeIfDll("Varactor reverse-bias paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({
      dtsPath: DTS_REVERSE,
      dllPath: DLL_PATH,
    });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  // First it() owns the run. Hard throws here surface as failed tests
  // (not silent suite-level skips).
  it("transient_step_end_paired_reverse", async () => {
    await session.runTransient(0, 1e-5, 1e-7);
    session.compareAllSteps();
  });

  it("dcop_paired_reverse", () => {
    // Step 0 of a transient is the first-time DCOP solve. getStepEnd(0)
    // exposes converged DC node and component slot values.
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

  it("full_iteration_paired_reverse", () => {
    session.compareAllAttempts();
  });
});

describeIfDll("Varactor forward-conduction paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({
      dtsPath: DTS_FORWARD,
      dllPath: DLL_PATH,
    });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_forward", async () => {
    await session.runTransient(0, 1e-5, 1e-7);
    session.compareAllSteps();
  });

  it("dcop_paired_forward", () => {
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

  it("full_iteration_paired_forward", () => {
    session.compareAllAttempts();
  });

  it("limiting_paired_forward", () => {
    // Pair pnjlim limiting events on VD AK junction across the first attempt
    // of step 0. wasLimited and {vBefore, vAfter} must agree bit-exact.
    const cmp = session.getLimitingComparison("VD", 0, 0);
    for (const j of cmp.junctions) {
      expect(j.limitingDiff).toBe(0);
    }
  });
});
