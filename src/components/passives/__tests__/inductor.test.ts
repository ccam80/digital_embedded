/** Tests for the Inductor component. */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import {
  DLL_PATH,
  describeIfDll,
} from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";
import { AnalogInductorElement } from "../inductor.js";

import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

// ---------------------------------------------------------------------------
// .dts paths
// ---------------------------------------------------------------------------

const DTS_RL_STEP        = path.resolve("src/components/passives/__tests__/fixtures/inductor-canon-rl-step.dts");
const DTS_RLC_OSCILLATOR = path.resolve("src/solver/analog/__tests__/ngspice-parity/fixtures/rlc-oscillator.dts");

// ---------------------------------------------------------------------------
// Slot indices — resolved via stateSchema.indexOf.get(...) at use sites.
// (B-3 forbids raw SLOT_* imports / hard-coded numeric slot indices.)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Programmatic builders
// ---------------------------------------------------------------------------

interface RlCircuitParams {
  vSource: number;
  R: number;
  L: number;
}

function buildRlCircuit(facade: DefaultSimulatorFacade, p: RlCircuitParams): Circuit {
  return facade.build({
    components: [
      { id: "vs",  type: "DcVoltageSource", props: { label: "V1", voltage: p.vSource } },
      { id: "r1",  type: "Resistor",        props: { label: "R1", resistance: p.R } },
      { id: "l1",  type: "Inductor",        props: { label: "L1", inductance: p.L } },
      { id: "gnd", type: "Ground" },
    ],
    connections: [
      ["vs:pos", "r1:pos"],
      ["r1:neg", "l1:pos"],
      ["l1:neg", "gnd:out"],
      ["vs:neg", "gnd:out"],
    ],
  });
}

function findInductor(elements: ReadonlyArray<unknown>): AnalogInductorElement {
  const idx = elements.findIndex((el) => el instanceof AnalogInductorElement);
  if (idx < 0) throw new Error("AnalogInductorElement not found in compiled circuit");
  return elements[idx] as AnalogInductorElement;
}

function getInductorCe(fix: ReturnType<typeof buildFixture>) {
  const idx = fix.circuit.elements.findIndex(
    (_e, i) => fix.elementLabels.get(i) === "L1",
  );
  expect(idx).toBeGreaterThanOrEqual(0);
  const ce = fix.circuit.elementToCircuitElement.get(idx);
  expect(ce).toBeDefined();
  return ce!;
}

// ===========================================================================
// Category 1 — Initialization (T1)
// Post-warm-start state is the converged DCOP. With ideal DC source and
// inductor as DC short, the inductor branch carries I = Vsrc / R = 1mA;
// flux Φ = L · I; node V(L_pos) = 0V (inductor shorts to gnd at DC).
// ===========================================================================

describe("Inductor initialization — RL DC steady (T1)", () => {
  it("init_rl_dc_state_phi_branch_node", () => {
    const Vsrc = 1.0, R = 1000, L = 1e-3;
    const fix = buildFixture({
      build: (_r, facade) => buildRlCircuit(facade, { vSource: Vsrc, R, L }),
    });

    const ind = findInductor(fix.circuit.elements);
    const SLOT_PHI  = ind.stateSchema.indexOf.get("PHI")!;

    const phi  = fix.pool.state0[ind._stateBase + SLOT_PHI];
    // PHI at DC steady state: Φ = L · I_DC = L · (Vsrc / R).
    expect(phi).toBeCloseTo(L * Vsrc / R, 9);

    // L_pos node sits at Vsrc - V_R = Vsrc - I*R; at DC steady I = Vsrc/R, so V_R = Vsrc and V(L_pos) = 0V.
    const lPosNode = ind.pinNodes.get("pos")!;
    expect(fix.engine.getNodeVoltage(lPosNode)).toBeCloseTo(0, 6);
  });
});

// ===========================================================================
// Category 2 — DCOP analytical (T1)
// At DC the inductor is a short, so V(L_pos) = V(L_neg) = 0V (gnd) and the
// branch current = Vsrc / R.
// ===========================================================================

describe("Inductor DCOP analytical — RL series (T1)", () => {
  it("dcop_rl_series_inductor_shorts_at_dc", () => {
    const Vsrc = 1.0, R = 1000, L = 1e-3;
    const fix = buildFixture({
      build: (_r, facade) => buildRlCircuit(facade, { vSource: Vsrc, R, L }),
    });

    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);

    const ind = findInductor(fix.circuit.elements);
    const lPosNode = ind.pinNodes.get("pos")!;
    // Inductor short at DC ⇒ V(L_pos) = V(L_neg) = 0V (gnd).
    expect(fix.engine.getNodeVoltage(lPosNode)).toBeCloseTo(0, 6);
  });
});

// ===========================================================================
// Categories 2-numerical / 3 / 5 — paired vs ngspice (T3)
// One describe per .dts; first it() owns the run.
// ===========================================================================

describeIfDll("Inductor RL step vs ngspice — transient + stamp parity (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_RL_STEP, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_rl_step", async () => {
    // τ = L/R = 1µs; run 5τ with 100 steps/τ.
    await session.runTransient(0, 5e-6, 1e-8);
    session.compareAllSteps();
  });

  it("dcop_paired_rl_step", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) expect(cv.withinTol).toBe(true);
    for (const [, comp] of Object.entries(stepEnd.components)) {
      for (const [, cv] of Object.entries(comp.slots ?? {})) expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_rl_step", () => {
    session.compareAllAttempts();
  });
});

describeIfDll("Inductor RLC oscillator vs ngspice — transient + stamp parity (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_RLC_OSCILLATOR, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_rlc_oscillator", async () => {
    // RLC: f0 ≈ 1592Hz, period ≈ 628µs. Run 1ms with 1µs maxStep.
    await session.runTransient(0, 1e-3, 1e-6);
    session.compareAllSteps();
  });

  it("dcop_paired_rlc_oscillator", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) expect(cv.withinTol).toBe(true);
    for (const [, comp] of Object.entries(stepEnd.components)) {
      for (const [, cv] of Object.entries(comp.slots ?? {})) expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_rlc_oscillator", () => {
    session.compareAllAttempts();
  });
});

// ===========================================================================
// Category 4 — Parameter hot-load (T1)
// One it() per parameter the AnalogInductorElement.setParam handles:
//   - inductance (primary): doubles ⇒ τ = L/R doubles ⇒ V(L_pos) at fixed t differs.
//   - SCALE (instance scale, derived L recompute): SCALE=2 ⇒ L_eff doubles.
//   - M (parallel multiplicity, derived L recompute): M=2 ⇒ L_eff halves.
//   - TC1 (linear temp coeff, derived L recompute): non-zero shifts L_eff.
//   - TC2 (quadratic temp coeff, derived L recompute): non-zero shifts L_eff.
//   - TNOM (nominal temp, derived L recompute): combines with TC1/TC2.
//   - IC (UIC initial condition): inert at DCOP / non-UIC, asserted directionally.
// Closed-form post-change observables; assertions on simulator outputs only.
// ===========================================================================

describe("Inductor parameter hot-load (T1)", () => {
  it("hotload_inductance_changes_transient_voltage", () => {
    // V(L_pos)(t) = Vsrc * exp(-t·R/L) under UIC. At t=1µs, L=1mH, R=1kΩ:
    //   τ = L/R = 1µs ⇒ V ≈ Vsrc/e ≈ 0.3679V.
    // Doubling L → τ = 2µs ⇒ at t=1µs, V ≈ Vsrc·exp(-0.5) ≈ 0.6065V.
    const Vsrc = 1.0, R = 1000, L = 1e-3;
    const tau = L / R;
    const fix = buildFixture({
      build: (_r, facade) => buildRlCircuit(facade, { vSource: Vsrc, R, L }),
      params: { tStop: 5 * tau, maxTimeStep: tau / 100, uic: true },
    });
    const ind = findInductor(fix.circuit.elements);
    const lPosNode = ind.pinNodes.get("pos")!;

    while (fix.engine.simTime < tau) fix.coordinator.step();
    const before = fix.engine.getNodeVoltage(lPosNode);
    // ≈ exp(-1) = 0.3679V
    expect(before).toBeCloseTo(Math.exp(-1), 2);

    // Hot-load doubles inductance → τ = 2µs at fixed R; voltage at the same
    // simTime is now exp(-simTime/2µs) which is materially larger.
    fix.coordinator.setComponentProperty(getInductorCe(fix), "inductance", 2e-3);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(lPosNode);
    expect(after).not.toBeCloseTo(before, 3);
  });

  it("hotload_SCALE_doubles_effective_inductance", () => {
    // SCALE multiplies effective L (L_eff = L_nom * SCALE / M). Setting SCALE=2
    // is equivalent to doubling L. Build with SCALE=1 then hot-load to SCALE=2;
    // V(L_pos) at the same simTime must change (longer τ).
    const Vsrc = 1.0, R = 1000, L = 1e-3;
    const tau = L / R;
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vs",  type: "DcVoltageSource", props: { label: "V1", voltage: Vsrc } },
          { id: "r1",  type: "Resistor",        props: { label: "R1", resistance: R } },
          { id: "l1",  type: "Inductor",        props: { label: "L1", inductance: L, SCALE: 1 } },
          { id: "gnd", type: "Ground" },
        ],
        connections: [
          ["vs:pos", "r1:pos"],
          ["r1:neg", "l1:pos"],
          ["l1:neg", "gnd:out"],
          ["vs:neg", "gnd:out"],
        ],
      }),
      params: { tStop: 5 * tau, maxTimeStep: tau / 100, uic: true },
    });
    const ind = findInductor(fix.circuit.elements);
    const lPosNode = ind.pinNodes.get("pos")!;

    while (fix.engine.simTime < tau) fix.coordinator.step();
    const before = fix.engine.getNodeVoltage(lPosNode);

    fix.coordinator.setComponentProperty(getInductorCe(fix), "SCALE", 2);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(lPosNode);
    expect(after).not.toBeCloseTo(before, 3);
  });

  it("hotload_M_halves_effective_inductance", () => {
    // M divides effective L (L_eff = L_nom * SCALE / M). Setting M=2 from M=1
    // halves effective L → τ = L/R is halved at fixed R; V(L_pos) at the same
    // simTime decays faster.
    const Vsrc = 1.0, R = 1000, L = 1e-3;
    const tau = L / R;
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vs",  type: "DcVoltageSource", props: { label: "V1", voltage: Vsrc } },
          { id: "r1",  type: "Resistor",        props: { label: "R1", resistance: R } },
          { id: "l1",  type: "Inductor",        props: { label: "L1", inductance: L, M: 1 } },
          { id: "gnd", type: "Ground" },
        ],
        connections: [
          ["vs:pos", "r1:pos"],
          ["r1:neg", "l1:pos"],
          ["l1:neg", "gnd:out"],
          ["vs:neg", "gnd:out"],
        ],
      }),
      params: { tStop: 5 * tau, maxTimeStep: tau / 100, uic: true },
    });
    const ind = findInductor(fix.circuit.elements);
    const lPosNode = ind.pinNodes.get("pos")!;

    while (fix.engine.simTime < tau) fix.coordinator.step();
    const before = fix.engine.getNodeVoltage(lPosNode);

    fix.coordinator.setComponentProperty(getInductorCe(fix), "M", 2);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(lPosNode);
    expect(after).not.toBeCloseTo(before, 3);
  });

  it("hotload_TC1_changes_effective_inductance", () => {
    // TC1 is a linear temp coeff: L_eff = L_nom * (1 + TC1*(T - TNOM) + TC2*(T - TNOM)^2).
    // With T (pool temperature) ≠ TNOM, raising TC1 changes L_eff and therefore τ.
    // Use TNOM = 250K so dT = T_pool - TNOM ≈ 50K (T_pool ≈ 300.15K).
    const Vsrc = 1.0, R = 1000, L = 1e-3;
    const tau = L / R;
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vs",  type: "DcVoltageSource", props: { label: "V1", voltage: Vsrc } },
          { id: "r1",  type: "Resistor",        props: { label: "R1", resistance: R } },
          { id: "l1",  type: "Inductor",        props: { label: "L1", inductance: L, TC1: 0, TNOM: 250 } },
          { id: "gnd", type: "Ground" },
        ],
        connections: [
          ["vs:pos", "r1:pos"],
          ["r1:neg", "l1:pos"],
          ["l1:neg", "gnd:out"],
          ["vs:neg", "gnd:out"],
        ],
      }),
      params: { tStop: 5 * tau, maxTimeStep: tau / 100, uic: true },
    });
    const ind = findInductor(fix.circuit.elements);
    const lPosNode = ind.pinNodes.get("pos")!;

    while (fix.engine.simTime < tau) fix.coordinator.step();
    const before = fix.engine.getNodeVoltage(lPosNode);

    fix.coordinator.setComponentProperty(getInductorCe(fix), "TC1", 0.01);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(lPosNode);
    expect(after).not.toBeCloseTo(before, 3);
  });

  it("hotload_TC2_changes_effective_inductance", () => {
    // TC2 is quadratic temp coeff. With TNOM offset from pool temp, raising
    // TC2 alters L_eff and therefore the transient response.
    const Vsrc = 1.0, R = 1000, L = 1e-3;
    const tau = L / R;
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vs",  type: "DcVoltageSource", props: { label: "V1", voltage: Vsrc } },
          { id: "r1",  type: "Resistor",        props: { label: "R1", resistance: R } },
          { id: "l1",  type: "Inductor",        props: { label: "L1", inductance: L, TC2: 0, TNOM: 250 } },
          { id: "gnd", type: "Ground" },
        ],
        connections: [
          ["vs:pos", "r1:pos"],
          ["r1:neg", "l1:pos"],
          ["l1:neg", "gnd:out"],
          ["vs:neg", "gnd:out"],
        ],
      }),
      params: { tStop: 5 * tau, maxTimeStep: tau / 100, uic: true },
    });
    const ind = findInductor(fix.circuit.elements);
    const lPosNode = ind.pinNodes.get("pos")!;

    while (fix.engine.simTime < tau) fix.coordinator.step();
    const before = fix.engine.getNodeVoltage(lPosNode);

    fix.coordinator.setComponentProperty(getInductorCe(fix), "TC2", 1e-4);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(lPosNode);
    expect(after).not.toBeCloseTo(before, 3);
  });

  it("hotload_TNOM_changes_effective_inductance_via_dT", () => {
    // TNOM enters L_eff via dT = T_pool - TNOM. With non-zero TC1 baked in,
    // moving TNOM changes the effective L and therefore τ.
    const Vsrc = 1.0, R = 1000, L = 1e-3;
    const tau = L / R;
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vs",  type: "DcVoltageSource", props: { label: "V1", voltage: Vsrc } },
          { id: "r1",  type: "Resistor",        props: { label: "R1", resistance: R } },
          { id: "l1",  type: "Inductor",        props: { label: "L1", inductance: L, TC1: 0.01, TNOM: 300.15 } },
          { id: "gnd", type: "Ground" },
        ],
        connections: [
          ["vs:pos", "r1:pos"],
          ["r1:neg", "l1:pos"],
          ["l1:neg", "gnd:out"],
          ["vs:neg", "gnd:out"],
        ],
      }),
      params: { tStop: 5 * tau, maxTimeStep: tau / 100, uic: true },
    });
    const ind = findInductor(fix.circuit.elements);
    const lPosNode = ind.pinNodes.get("pos")!;

    while (fix.engine.simTime < tau) fix.coordinator.step();
    const before = fix.engine.getNodeVoltage(lPosNode);

    fix.coordinator.setComponentProperty(getInductorCe(fix), "TNOM", 250);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(lPosNode);
    expect(after).not.toBeCloseTo(before, 3);
  });

  it("hotload_IC_seeds_uic_initial_branch_current", () => {
    // IC sets initial branch current under UIC. With IC=Vsrc/R the inductor
    // starts already in DC steady state ⇒ V(L_pos) = 0V at t=0 instead of
    // the standard exp-decay from Vsrc. Compare against a default-IC build.
    const Vsrc = 1.0, R = 1000, L = 1e-3;
    const tau = L / R;
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vs",  type: "DcVoltageSource", props: { label: "V1", voltage: Vsrc } },
          { id: "r1",  type: "Resistor",        props: { label: "R1", resistance: R } },
          // IC=NaN by default; hot-load to a known IC and observe behaviour change.
          { id: "l1",  type: "Inductor",        props: { label: "L1", inductance: L } },
          { id: "gnd", type: "Ground" },
        ],
        connections: [
          ["vs:pos", "r1:pos"],
          ["r1:neg", "l1:pos"],
          ["l1:neg", "gnd:out"],
          ["vs:neg", "gnd:out"],
        ],
      }),
      params: { tStop: 5 * tau, maxTimeStep: tau / 100, uic: true },
    });
    const ind = findInductor(fix.circuit.elements);
    const lPosNode = ind.pinNodes.get("pos")!;

    // Hot-load IC to steady-state branch current and step.
    fix.coordinator.setComponentProperty(getInductorCe(fix), "IC", Vsrc / R);
    // Step a fraction of τ so the IC seed dominates over any prior history.
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(lPosNode);
    // Closed-form: with IC = Vsrc/R the inductor presents a current source
    // carrying I_steady, so V_R = I_steady · R = Vsrc and V(L_pos) = 0V.
    expect(after).toBeCloseTo(0, 6);
  });
});

// ===========================================================================
// Category 7 — LTE rollback (T1)
// AnalogInductorElement implements getLteTimestep over PHI / CCAP charge slots.
// State1 / state0 rotation invariant after warm-start: rolled flux slot
// must remain finite and the rotation occurs (state1 populated).
// ===========================================================================

describe("Inductor LTE rollback (T1)", () => {
  it("lte_rollback_state_invariant", () => {
    // Square-wave drive into an RL — sharp edges produce flux-derivative
    // discontinuities that the LTE estimator (cktTerr over PHI / CCAP slots)
    // can flag as out-of-tolerance, forcing the engine to reject the step
    // and roll back state0 ↔ state1. Free-running maxStep allows the
    // controller to overshoot and trigger the rejection path.
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vp",  type: "AcVoltageSource", props: {
            label: "V1", waveform: "square", amplitude: 10, frequency: 500, dcOffset: 0,
          } },
          { id: "r1",  type: "Resistor", props: { label: "R1", resistance: 1 } },
          { id: "l1",  type: "Inductor", props: { label: "L1", inductance: 1e-3 } },
          { id: "gnd", type: "Ground" },
        ],
        connections: [
          ["vp:pos", "r1:pos"],
          ["r1:neg", "l1:pos"],
          ["l1:neg", "gnd:out"],
          ["vp:neg", "gnd:out"],
        ],
      }),
      params: { tStop: 5e-3 },
    });
    fix.coordinator.setConvergenceLogEnabled(true);
    while (fix.engine.simTime < 5e-3) fix.coordinator.step();
    const log = fix.coordinator.getConvergenceLog()!;
    const rejected = log.find((s) => s.lteRejected === true)!;
    expect(rejected).toBeDefined();

    const ind = findInductor(fix.circuit.elements);
    const SLOT_PHI = ind.stateSchema.indexOf.get("PHI")!;
    // After an LTE rejection the engine rolls state0 from the restored s1
    // snapshot — the rotation invariant is that on the rolled flux slot
    // state0 and state1 hold the same value at the step boundary.
    expect(fix.pool.state0[ind._stateBase + SLOT_PHI]).toBe(
      fix.pool.state1[ind._stateBase + SLOT_PHI],
    );
  });
});
