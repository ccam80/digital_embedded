import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import {
  DLL_PATH,
  describeIfDll,
} from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";
import { DIODE_SCHEMA } from "../diode.js";

const DTS_FORWARD = path.resolve("src/components/semiconductors/__tests__/fixtures/schottky-canon-forward.dts");
const DTS_REVERSE = path.resolve("src/components/semiconductors/__tests__/fixtures/schottky-canon-reverse.dts");

// ---------------------------------------------------------------------------
// Programmatic build helper for T1 fixtures.
// Schottky default props (CJO=1pF, RS=1Ω) → cap-active path → DIODE_SCHEMA.
// ---------------------------------------------------------------------------

function buildSchottkyForward(
  facade: import("../../../headless/default-facade.js").DefaultSimulatorFacade,
  overrides: Record<string, number> = {},
): import("../../../core/circuit.js").Circuit {
  return facade.build({
    components: [
      { id: "v1", type: "DcVoltageSource", props: { label: "V1", voltage: 0.5 } },
      { id: "d1", type: "SchottkyDiode",   props: { label: "D1", ...overrides } },
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

function findD1(fix: ReturnType<typeof buildFixture>) {
  const idx = fix.circuit.elements.findIndex(
    (_e, i) => fix.elementLabels.get(i) === "D1",
  );
  expect(idx).toBeGreaterThanOrEqual(0);
  const el = fix.circuit.elements[idx]!;
  return { idx, el };
}

// ---------------------------------------------------------------------------
// Category 1 — Initialization (T1)
// Asserts the warm-started state pool slot reads finite for the Schottky
// element after compile() + first coordinator.step(). Schottky delegates to
// createDiodeElement; with default CJO=1pF the element uses DIODE_SCHEMA.
// VD slot is the pnjlim-limited junction voltage.
// ---------------------------------------------------------------------------

describe("Schottky initialization (T1)", () => {
  const SLOT_VD = DIODE_SCHEMA.indexOf.get("VD")!;

  it("init_schottky_vd_seeded", () => {
    const fix = buildFixture({ build: (_r, f) => buildSchottkyForward(f) });
    const { el } = findD1(fix);
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
// Forward bias closed-form sanity: V=0.5V drives the Schottky through 300Ω.
// Schottky defaults (IS=1e-8, N=1.05, T=300.15K) → Vf ≈ 1.05·0.02585·ln(I/IS)
// ≈ 0.27V at I≈0.75mA. The collector-side resistor drop V_R = V_in - Vf ≈ 0.23V
// gives I = V_R/R ≈ 0.77mA. Closed-form bound: anode-cathode forward voltage
// stays below the silicon-diode 0.6V baseline and above 0.15V (Schottky barrier).
// ---------------------------------------------------------------------------

describe("Schottky DCOP analytical (T1)", () => {
  it("dcop_schottky_forward_vf_in_band", () => {
    const fix = buildFixture({ build: (_r, f) => buildSchottkyForward(f) });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);
    const vA = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("D1:A")!);
    const vK = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("D1:K")!);
    const vf = vA - vK;
    // Schottky forward-conduction band: well below 0.6V silicon Vf and above
    // 0.15V depletion onset. Closed-form ≈ 0.27V at I≈0.75mA with Schottky defaults.
    expect(vf).toBeGreaterThan(0.15);
    expect(vf).toBeLessThan(0.50);
  });
});

// ---------------------------------------------------------------------------
// Category 4 — Parameter hot-load (T1)
// One it() per representative model parameter group. Schottky exposes the
// diode-shared param surface: structural (IS, N, RS), depletion-cap (CJO),
// derived-state-recompute (TEMP — universal). Asserts the simulator output
// changed after setComponentProperty + step.
// ---------------------------------------------------------------------------

describe("Schottky parameter hot-load (T1)", () => {
  it("hotload_IS_changes_vf", () => {
    const fix = buildFixture({ build: (_r, f) => buildSchottkyForward(f) });
    const ce = fix.element("D1");
    const vAnode = fix.circuit.labelToNodeId.get("D1:A")!;
    const vCath = fix.circuit.labelToNodeId.get("D1:K")!;
    const before = fix.engine.getNodeVoltage(vAnode) - fix.engine.getNodeVoltage(vCath);
    fix.coordinator.setComponentProperty(ce, "IS", 1e-6);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vAnode) - fix.engine.getNodeVoltage(vCath);
    // Larger IS → lower Vf at the same current → forward voltage drops.
    expect(after).not.toBeCloseTo(before, 6);
    expect(after).toBeLessThan(before);
  });

  it("hotload_N_changes_vf", () => {
    const fix = buildFixture({ build: (_r, f) => buildSchottkyForward(f) });
    const ce = fix.element("D1");
    const vAnode = fix.circuit.labelToNodeId.get("D1:A")!;
    const vCath = fix.circuit.labelToNodeId.get("D1:K")!;
    const before = fix.engine.getNodeVoltage(vAnode) - fix.engine.getNodeVoltage(vCath);
    fix.coordinator.setComponentProperty(ce, "N", 2.0);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vAnode) - fix.engine.getNodeVoltage(vCath);
    // Larger N → larger thermal voltage scale → higher Vf at the same current.
    expect(after).not.toBeCloseTo(before, 6);
    expect(after).toBeGreaterThan(before);
  });

  it("hotload_RS_lowers_cathode_voltage", () => {
    // The anode is pinned by the 0.5 V source, so RS cannot move it. RS (the
    // internal series resistance) adds an IR drop that lowers the device current,
    // observable as a drop in the cathode node V_K = I·R1.
    const fix = buildFixture({ build: (_r, f) => buildSchottkyForward(f) });
    const ce = fix.element("D1");
    const vCath = fix.circuit.labelToNodeId.get("D1:K")!;
    fix.coordinator.dcOperatingPoint();
    const before = fix.engine.getNodeVoltage(vCath);
    fix.coordinator.setComponentProperty(ce, "RS", 50);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(vCath);
    // More series resistance → less current → lower cathode voltage.
    expect(after).not.toBeCloseTo(before, 6);
    expect(after).toBeLessThan(before);
  });

  it("hotload_CJO_changes_dynamic_response", () => {
    // CJO is a depletion-cap parameter — dormant at DCOP, active only under
    // transient excitation. The anode is source-pinned, so its effect appears on
    // the cathode. Compare a control (default CJO) against a fixture whose CJO is
    // hot-loaded mid-transient; stepped identically, the larger junction cap
    // holds the cathode node up, so V_K diverges observably from the control.
    const mk = (): ReturnType<typeof buildFixture> =>
      buildFixture({ build: (_r, f) => buildSchottkyForward(f), params: { tStop: 1e-6, maxTimeStep: 1e-8 } });
    const vK = (fix: ReturnType<typeof buildFixture>): number =>
      fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("D1:K")!);

    const ctrl = mk();
    const test = mk();
    ctrl.coordinator.step();
    test.coordinator.step();
    // Hot-load CJO on the test fixture only.
    test.coordinator.setComponentProperty(test.element("D1"), "CJO", 1e-9);
    ctrl.coordinator.step();
    test.coordinator.step();
    // The CJO hot-load diverges the cathode trajectory from the control.
    expect(vK(test)).not.toBeCloseTo(vK(ctrl), 6);
  });

  it("hotload_TEMP_changes_vf", () => {
    // TEMP is the derived-state-recompute parameter (universal). setParam
    // triggers recomputeTemp() which re-derives tIS / tVJ / tCJO / tVcrit / tBV.
    const fix = buildFixture({ build: (_r, f) => buildSchottkyForward(f) });
    const ce = fix.element("D1");
    const vAnode = fix.circuit.labelToNodeId.get("D1:A")!;
    const vCath = fix.circuit.labelToNodeId.get("D1:K")!;
    const before = fix.engine.getNodeVoltage(vAnode) - fix.engine.getNodeVoltage(vCath);
    fix.coordinator.setComponentProperty(ce, "TEMP", 400);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vAnode) - fix.engine.getNodeVoltage(vCath);
    // Raising T raises tIS exponentially → at the same current Vf drops.
    expect(after).not.toBeCloseTo(before, 6);
    expect(after).toBeLessThan(before);
  });
});

// ---------------------------------------------------------------------------
// Category 4 — computeTemperature engine-driven path (T1)
//
// SchottkyElement delegates to createDiodeElement (schottky.ts:74-80). The
// produced DiodeAnalogElement receives computeTemperature(ctx) from task 5.1.3.
// No override is needed in schottky.ts — inheritance is the contract.
//
// cite: diotemp.c:84-85 — if(!DIOtempGiven) here->DIOtemp = ckt->CKTtemp
// The engine-driven path updates tIS/tVJ/tCJO/tVcrit/tBV when ctx.cktTemp
// differs from 300.15 K (REFTEMP), producing measurably different node voltages.
// ---------------------------------------------------------------------------

describe("Schottky computeTemperature engine-driven path (T1)", () => {
  it("computeTemperature_ambient_propagates_to_vf", () => {
    // Build at default temperature (300.15 K). Run DCOP. Record Vf.
    const fixCold = buildFixture({ build: (_r, f) => buildSchottkyForward(f) });
    fixCold.coordinator.dcOperatingPoint();
    const vfCold =
      fixCold.engine.getNodeVoltage(fixCold.circuit.labelToNodeId.get("D1:A")!) -
      fixCold.engine.getNodeVoltage(fixCold.circuit.labelToNodeId.get("D1:K")!);

    // Build a second fixture; raise ambient temperature via setCircuitTemp.
    // This triggers the engine-driven computeTemperature pass on the DIO element
    // (DiodeAnalogElement.computeTemperature — provided by task 5.1.3).
    const fixHot = buildFixture({ build: (_r, f) => buildSchottkyForward(f) });
    fixHot.facade.setCircuitTemp(400);
    fixHot.coordinator.dcOperatingPoint();
    const vfHot =
      fixHot.engine.getNodeVoltage(fixHot.circuit.labelToNodeId.get("D1:A")!) -
      fixHot.engine.getNodeVoltage(fixHot.circuit.labelToNodeId.get("D1:K")!);

    // Raising T raises tIS exponentially → at the same current Vf drops.
    expect(vfHot).not.toBeCloseTo(vfCold, 6);
    expect(vfHot).toBeLessThan(vfCold);
  });

  it("computeTemperature_per_instance_override_wins_over_ambient", async () => {
    // Per-instance TEMP set via setParam must not be overwritten by the
    // engine-driven computeTemperature pass (diotemp.c:84 DIOtempGiven guard).
    // Unlike the (capacitor-free) zener, the Schottky carries a junction
    // capacitance, so the transient must run at an accurate timestep: at a coarse
    // dt the trapezoidal rule rings on the junction cap (~1.5 µV peak), which
    // would mask the steady state. maxTimeStep 1 ns collapses that ring to ~5e-11.
    const fix = buildFixture({
      build: (_r, f) => buildSchottkyForward(f),
      params: { tStop: 1e-7, maxTimeStep: 1e-9 },
    });
    const ce = fix.element("D1");

    // Set per-instance TEMP override to 450 K.
    fix.coordinator.setComponentProperty(ce, "TEMP", 450);
    fix.coordinator.dcOperatingPoint();
    const vfOverride =
      fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("D1:A")!) -
      fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("D1:K")!);

    // Now set ambient back to default. The device stays at 450 K (override), so
    // once the transient settles V_f must return to the 450 K operating point and
    // not the ambient (300.15 K) one. Run the transient to a settle time and read
    // the steady state — the genuine steady-state override check, not a single
    // unsettled step.
    fix.facade.setCircuitTemp(300.15);
    await fix.coordinator.stepToTime(1e-7);
    const vfAfter =
      fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("D1:A")!) -
      fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("D1:K")!);

    // The settled V_f must equal the 450 K DC operating point: the override holds
    // and the ambient change does not move it.
    expect(vfAfter).toBeCloseTo(vfOverride, 6);
  });
});

// ---------------------------------------------------------------------------
// Category 6 — Limiting events (T1, own engine)
// pnjlim fires on the diode AK junction during DCOP NR. Drive a forward-biased
// Schottky and read fix.coordinator.getLimitingEvents().
// ---------------------------------------------------------------------------

describe("Schottky limiting events own-engine (T1)", () => {
  it("limiting_pnjlim_fires_schottky_forward", () => {
    const fix = buildFixture({ build: (_r, f) => buildSchottkyForward(f) });
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
// Schottky implements getLteTimestep when hasCapacitance (CJO=1pF default).
// The proposal reads cktTerr() over Q / CCAP rollable slots. The rollback
// invariant is that after warm-start + a few transient steps, state0 and
// state1 both carry finite values for the rollable charge slot (rotation
// occurred, no NaN poisoning).
// ---------------------------------------------------------------------------

describe("Schottky LTE rollback (T1)", () => {
  it("lte_rollback_state_invariant", () => {
    const SLOT_Q = DIODE_SCHEMA.indexOf.get("Q")!;
    const fix = buildFixture({
      build: (_r, f) => buildSchottkyForward(f),
      params: { tStop: 1e-6, maxTimeStep: 1e-7 },
    });
    fix.coordinator.setConvergenceLogEnabled(true);
    for (let i = 0; i < 10; i++) fix.coordinator.step();
    const { el } = findD1(fix);
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

describeIfDll("Schottky forward-conduction paired vs ngspice (T3)", () => {
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

  // First it() owns the run. Hard throws here surface as failed tests
  // (not silent suite-level skips).
  it("transient_step_end_paired_forward", async () => {
    await session.runTransient(0, 1e-5, 1e-7);
    session.compareAllSteps();
  });

  it("dcop_paired_forward", () => {
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

  it("full_iteration_paired_forward", () => {
    session.compareAllAttempts();
  });

  it("limiting_paired_forward", () => {
    // Pair pnjlim limiting events on D1 AK junction across the first attempt
    // of step 0. wasLimited and {vBefore, vAfter} must agree bit-exact.
    const cmp = session.getLimitingComparison("D1", 0, 0);
    for (const j of cmp.junctions) {
      expect(j.limitingDiff).toBe(0);
    }
  });
});

describeIfDll("Schottky reverse-blocking paired vs ngspice (T3)", () => {
  // Reverse-bias regime exercises the smooth-reverse cubic and the cap formula
  // in reverse bias (Cj = CJO/(1-Vd/VJ)^M). Distinct code path from forward
  // conduction.
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

  it("transient_step_end_paired_reverse", async () => {
    await session.runTransient(0, 1e-5, 1e-7);
    session.compareAllSteps();
  });

  it("dcop_paired_reverse", () => {
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
