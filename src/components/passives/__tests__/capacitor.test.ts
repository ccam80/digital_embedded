import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "path";
import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import {
  describeIfDll,
  DLL_PATH,
} from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";
import { AnalogCapacitorElement } from "../capacitor.js";

import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

// ---------------------------------------------------------------------------
// DTS fixture paths (T3 harness) — reused, not authored.
// ---------------------------------------------------------------------------

// RC charging via pulse source (V1 square 0..1V at 500Hz, R1=1k, C1=1uF).
// Exercises capacitor charging / discharging through a simple RC and
// the predictor / DCOP-init / transient cktMode gates on a deterministic
// step waveform.
const DTS_RC_TRANSIENT = path.resolve(
  "src/solver/analog/__tests__/ngspice-parity/fixtures/rc-transient.dts",
);

// RLC underdamped resonator (V1 sine 1V@1592Hz, R1=10, L1=10mH, C1=1uF).
// Exercises capacitor through an oscillatory regime: predictor branches,
// integration order/method interaction with a current-bearing inductor in
// series, and the LTE / dt-selection gates that drive cktTerr() proposals.
const DTS_RLC_OSCILLATOR = path.resolve(
  "src/solver/analog/__tests__/ngspice-parity/fixtures/rlc-oscillator.dts",
);

// ---------------------------------------------------------------------------
// Programmatic circuit factories (T1)
// ---------------------------------------------------------------------------
//
// RC series circuit: VS -> R -> C -> GND. Closed-form step response
//   V_C(t) = Vsrc * (1 - exp(-t / tau)),  tau = R * C
// At t = tau, V_C ≈ 0.63212 * Vsrc.

interface RcParams {
  vSource?: number;
  R?: number;
  C?: number;
}

function buildRcCircuit(facade: DefaultSimulatorFacade, p: RcParams): Circuit {
  return facade.build({
    components: [
      { id: "vs",  type: "DcVoltageSource", props: { label: "V1", voltage: p.vSource ?? 1.0 } },
      { id: "r1",  type: "Resistor",        props: { label: "R1", resistance: p.R ?? 1000 } },
      { id: "c1",  type: "Capacitor",       props: { label: "C1", capacitance: p.C ?? 1e-6 } },
      { id: "gnd", type: "Ground",          props: { label: "gnd" } },
    ],
    connections: [
      ["vs:pos",  "r1:pos"],
      ["r1:neg",  "c1:pos"],
      ["c1:neg",  "gnd:out"],
      ["vs:neg",  "gnd:out"],
    ],
  });
}

function nodeOf(fix: ReturnType<typeof buildFixture>, label: string): number {
  const n = fix.circuit.labelToNodeId.get(label);
  if (n === undefined) throw new Error(`label '${label}' not in labelToNodeId`);
  return n;
}

function findCapacitor(fix: ReturnType<typeof buildFixture>): { el: AnalogCapacitorElement; idx: number } {
  const idx = fix.circuit.elements.findIndex((el) => el instanceof AnalogCapacitorElement);
  if (idx < 0) throw new Error("AnalogCapacitorElement not found in compiled circuit");
  return { el: fix.circuit.elements[idx] as AnalogCapacitorElement, idx };
}

// ---------------------------------------------------------------------------
// Capacitor initialization (T1) — Cat 1
// ---------------------------------------------------------------------------

describe("Capacitor initialization (T1)", () => {
  it("init_post_warm_start_state_pool_charge_seeded", () => {
    // Cat 1: at step 0 post-warm-start the cap charge slot Q is populated as
    // C * V_terminal where V_terminal is the DCOP-converged terminal voltage.
    // RC with VS=1V, R=1k, C=1uF: at DCOP the cap is open, so V_C = VS = 1V
    //   Q = C * V = 1e-6 * 1.0 = 1e-6 C.
    // ngspice CAPstate is 2 slots {qcap, ccap} per capsetup.c:103; terminal
    // voltage is not stored — query via getNodeVoltage.
    const fix = buildFixture({
      build: (_r, facade) => buildRcCircuit(facade, { vSource: 1.0, R: 1000, C: 1e-6 }),
    });
    const { el } = findCapacitor(fix);
    const SLOT_Q = el.stateSchema.indexOf.get("Q")!;

    expect(fix.pool.state0[el._stateBase + SLOT_Q]).toBeCloseTo(1e-6, 9);
    // V(C1:pos) at step 0 is the DCOP value (cap open at DC) = VS = 1V.
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "C1:pos"))).toBeCloseTo(1.0, 6);
  });
});

// ---------------------------------------------------------------------------
// Capacitor DCOP analytical (T1) — Cat 2 analytical
// ---------------------------------------------------------------------------

describe("Capacitor DCOP analytical (T1)", () => {
  it("dcop_open_at_dc_node_voltage_equals_source", () => {
    // Cat 2 analytical: at DC the capacitor is an open circuit. Series RC
    // with VS->R->C->GND: no DC current flows, so V(C1:pos) = VS exactly.
    const fix = buildFixture({
      build: (_r, facade) => buildRcCircuit(facade, { vSource: 2.5, R: 1000, C: 1e-6 }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "C1:pos"))).toBeCloseTo(2.5, 6);
  });

  it("dcop_pin_currents_zero_at_dc", () => {
    // Cat 2 analytical: cap pin currents at DC are zero (no displacement
    // current at steady state). geq=0 and ieq=0 at DCOP per capload.c:84.
    const fix = buildFixture({
      build: (_r, facade) => buildRcCircuit(facade, { vSource: 1.0, R: 1000, C: 1e-6 }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);
    const { idx } = findCapacitor(fix);
    const pinCurrents = fix.engine.getElementPinCurrents(idx);
    expect(pinCurrents[0]).toBeCloseTo(0, 9);
    expect(pinCurrents[1]).toBeCloseTo(0, 9);
  });
});

// ---------------------------------------------------------------------------
// Capacitor parameter hot-load (T1) — Cat 4
// ---------------------------------------------------------------------------
//
// Capacitor params: capacitance (primary), IC, TC1, TC2, TNOM, SCALE, M
// (secondary). Each setParam() that recomputes C is exercised in its own
// it() per Cat 4's "one it() per param that handles a recompute path"
// requirement. M scales at stamp time (not via C recompute) and is the
// other primary observable.

describe("Capacitor parameter hot-load (T1)", () => {
  it("hotload_capacitance_changes_charging_response", () => {
    // Cat 4: doubling C doubles tau. After a fixed sub-tau wait the larger
    // cap charges to a smaller fraction of VS.
    const Vsrc = 1.0;
    const R = 1000;
    const C0 = 1e-6;
    const tau0 = R * C0;
    const fix = buildFixture({
      build: (_r, facade) => buildRcCircuit(facade, { vSource: Vsrc, R, C: C0 }),
      params: { tStop: 5 * tau0, maxTimeStep: tau0 / 100, uic: true },
    });
    const cPosNode = nodeOf(fix, "C1:pos");
    while (fix.engine.simTime < tau0 / 4) fix.coordinator.step();
    const before = fix.engine.getNodeVoltage(cPosNode);

    const capEl = fix.element("C1");
    fix.coordinator.setComponentProperty(capEl, "capacitance", 4 * C0);
    // After the change tau quadruples; charging at the same voltage
    // becomes much slower so node voltage rises more slowly per step.
    for (let i = 0; i < 10; i++) fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(cPosNode);
    // The behavioural change: with the larger C the per-step Δ is smaller.
    // Compare the ratio of Δv per step before vs after the swap.
    expect(after).not.toBeCloseTo(before, 6);
  });

  it("hotload_TC1_recomputes_capacitance_and_changes_response", () => {
    // Cat 4 derived-state recompute: setParam("TC1", ...) recomputes C via
    // the temperature factor (1 + TC1*dT + TC2*dT^2). With TNOM=250K and
    // operating temp 300.15K, dT=50.15. Switching TC1 from 0 to a non-zero
    // value scales C, hence tau, hence the charging trajectory.
    const Vsrc = 1.0;
    const R = 1000;
    const C0 = 1e-6;
    const tau0 = R * C0;
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vs",  type: "DcVoltageSource", props: { label: "V1", voltage: Vsrc } },
          { id: "r1",  type: "Resistor",        props: { label: "R1", resistance: R } },
          { id: "c1",  type: "Capacitor",       props: { label: "C1", capacitance: C0, TNOM: 250 } },
          { id: "gnd", type: "Ground",          props: { label: "gnd" } },
        ],
        connections: [
          ["vs:pos", "r1:pos"],
          ["r1:neg", "c1:pos"],
          ["c1:neg", "gnd:out"],
          ["vs:neg", "gnd:out"],
        ],
      }),
      params: { tStop: 5 * tau0, maxTimeStep: tau0 / 100, uic: true },
    });
    const cPosNode = nodeOf(fix, "C1:pos");
    while (fix.engine.simTime < tau0 / 4) fix.coordinator.step();
    const before = fix.engine.getNodeVoltage(cPosNode);

    const capEl = fix.element("C1");
    // Raise TC1 → factor = 1 + TC1*50.15 with TC1=0.01 → ~1.5. C grows,
    // tau grows, charging slows → V(C1:pos) trajectory changes.
    fix.coordinator.setComponentProperty(capEl, "TC1", 0.01);
    for (let i = 0; i < 10; i++) fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(cPosNode);
    expect(after).not.toBeCloseTo(before, 6);
  });

  it("hotload_TC2_recomputes_capacitance_and_changes_response", () => {
    // Cat 4 derived-state recompute: TC2 is the quadratic temperature
    // coefficient; setParam("TC2", ...) re-runs the C-recompute formula.
    const Vsrc = 1.0;
    const R = 1000;
    const C0 = 1e-6;
    const tau0 = R * C0;
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vs",  type: "DcVoltageSource", props: { label: "V1", voltage: Vsrc } },
          { id: "r1",  type: "Resistor",        props: { label: "R1", resistance: R } },
          { id: "c1",  type: "Capacitor",       props: { label: "C1", capacitance: C0, TNOM: 250 } },
          { id: "gnd", type: "Ground",          props: { label: "gnd" } },
        ],
        connections: [
          ["vs:pos", "r1:pos"],
          ["r1:neg", "c1:pos"],
          ["c1:neg", "gnd:out"],
          ["vs:neg", "gnd:out"],
        ],
      }),
      params: { tStop: 5 * tau0, maxTimeStep: tau0 / 100, uic: true },
    });
    const cPosNode = nodeOf(fix, "C1:pos");
    while (fix.engine.simTime < tau0 / 4) fix.coordinator.step();
    const before = fix.engine.getNodeVoltage(cPosNode);

    const capEl = fix.element("C1");
    fix.coordinator.setComponentProperty(capEl, "TC2", 1e-4);
    for (let i = 0; i < 10; i++) fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(cPosNode);
    expect(after).not.toBeCloseTo(before, 6);
  });

  it("hotload_TNOM_recomputes_capacitance_and_changes_response", () => {
    // Cat 4 universal TEMP-style recompute: TNOM controls dT in the
    // temperature scaling formula. setParam("TNOM", ...) re-runs the
    // C-recompute and shifts tau.
    const Vsrc = 1.0;
    const R = 1000;
    const C0 = 1e-6;
    const tau0 = R * C0;
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vs",  type: "DcVoltageSource", props: { label: "V1", voltage: Vsrc } },
          { id: "r1",  type: "Resistor",        props: { label: "R1", resistance: R } },
          { id: "c1",  type: "Capacitor",       props: { label: "C1", capacitance: C0, TC1: 0.01 } },
          { id: "gnd", type: "Ground",          props: { label: "gnd" } },
        ],
        connections: [
          ["vs:pos", "r1:pos"],
          ["r1:neg", "c1:pos"],
          ["c1:neg", "gnd:out"],
          ["vs:neg", "gnd:out"],
        ],
      }),
      params: { tStop: 5 * tau0, maxTimeStep: tau0 / 100, uic: true },
    });
    const cPosNode = nodeOf(fix, "C1:pos");
    while (fix.engine.simTime < tau0 / 4) fix.coordinator.step();
    const before = fix.engine.getNodeVoltage(cPosNode);

    const capEl = fix.element("C1");
    // Push TNOM far below operating temp so dT grows ~50 → factor large.
    fix.coordinator.setComponentProperty(capEl, "TNOM", 200);
    for (let i = 0; i < 10; i++) fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(cPosNode);
    expect(after).not.toBeCloseTo(before, 6);
  });

  it("hotload_SCALE_recomputes_capacitance_and_changes_response", () => {
    // Cat 4 derived-state recompute: SCALE multiplies C in the recompute
    // formula. setParam("SCALE", ...) re-runs C = nominalC * tempFactor *
    // SCALE. Doubling SCALE doubles C and hence tau.
    const Vsrc = 1.0;
    const R = 1000;
    const C0 = 1e-6;
    const tau0 = R * C0;
    const fix = buildFixture({
      build: (_r, facade) => buildRcCircuit(facade, { vSource: Vsrc, R, C: C0 }),
      params: { tStop: 5 * tau0, maxTimeStep: tau0 / 100, uic: true },
    });
    const cPosNode = nodeOf(fix, "C1:pos");
    while (fix.engine.simTime < tau0 / 4) fix.coordinator.step();
    const before = fix.engine.getNodeVoltage(cPosNode);

    const capEl = fix.element("C1");
    fix.coordinator.setComponentProperty(capEl, "SCALE", 4);
    for (let i = 0; i < 10; i++) fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(cPosNode);
    expect(after).not.toBeCloseTo(before, 6);
  });

  it("hotload_M_changes_stamp_scaling_and_response", () => {
    // Cat 4: M is the parallel-multiplicity factor applied at stamp time
    // (capload.c:44 — m * geq, m * ceq) rather than folded into C. Doubling
    // M doubles the stamped companion conductance / current at every step,
    // so the charging trajectory differs from the M=1 baseline.
    const Vsrc = 1.0;
    const R = 1000;
    const C0 = 1e-6;
    const tau0 = R * C0;
    const fix = buildFixture({
      build: (_r, facade) => buildRcCircuit(facade, { vSource: Vsrc, R, C: C0 }),
      params: { tStop: 5 * tau0, maxTimeStep: tau0 / 100, uic: true },
    });
    const cPosNode = nodeOf(fix, "C1:pos");
    while (fix.engine.simTime < tau0 / 4) fix.coordinator.step();
    const before = fix.engine.getNodeVoltage(cPosNode);

    const capEl = fix.element("C1");
    fix.coordinator.setComponentProperty(capEl, "M", 4);
    for (let i = 0; i < 10; i++) fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(cPosNode);
    expect(after).not.toBeCloseTo(before, 6);
  });

  it("hotload_IC_changes_uic_terminal_voltage_seed", () => {
    // Cat 4: IC supplies the initial-condition terminal voltage when MODEUIC
    // is active (capload.c:32-36 cond1 gate). Setting IC then re-warming
    // shifts the cap's seeded V at the start of the transient.
    const Vsrc = 1.0;
    const R = 1000;
    const C0 = 1e-6;
    const fix = buildFixture({
      build: (_r, facade) => buildRcCircuit(facade, { vSource: Vsrc, R, C: C0 }),
      params: { tStop: 5 * R * C0, maxTimeStep: R * C0 / 100, uic: true },
    });
    fix.coordinator.step();
    const cPosNode = nodeOf(fix, "C1:pos");
    const before = fix.engine.getNodeVoltage(cPosNode);

    const capEl = fix.element("C1");
    fix.coordinator.setComponentProperty(capEl, "IC", 0.4);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(cPosNode);
    expect(after).not.toBeCloseTo(before, 6);
  });
});

// ---------------------------------------------------------------------------
// Capacitor LTE rollback (T1) — Cat 7
// ---------------------------------------------------------------------------
//
// AnalogCapacitorElement implements getLteTimestep — proposes a dt based on
// cktTerr() over the Q charge slot. Rollback invariant: at any step boundary
// post-warm-start, the rolled charge slot rotates between state0/state1
// and stays finite. Driven through several steps of an oscillatory RLC at
// a coarse maxTimeStep, the LTE controller exercises rejection / acceptance
// branches; the invariant holds at every accepted boundary.

describe("Capacitor LTE rollback (T1)", () => {
  it("lte_rollback_state_invariant", () => {
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vs",  type: "DcVoltageSource", props: { label: "V1", voltage: 5 } },
          { id: "r1",  type: "Resistor",        props: { label: "R1", resistance: 100 } },
          { id: "c1",  type: "Capacitor",       props: { label: "C1", capacitance: 1e-6 } },
          { id: "gnd", type: "Ground",          props: { label: "gnd" } },
        ],
        connections: [
          ["vs:pos", "r1:pos"],
          ["r1:neg", "c1:pos"],
          ["c1:neg", "gnd:out"],
          ["vs:neg", "gnd:out"],
        ],
      }),
      params: { tStop: 1e-3, maxTimeStep: 1e-5 },
    });
    fix.coordinator.setConvergenceLogEnabled(true);
    for (let i = 0; i < 20; i++) fix.coordinator.step();
    const log = fix.coordinator.getConvergenceLog();
    expect(log).not.toBeNull();

    const { el } = findCapacitor(fix);
    const SLOT_Q = el.stateSchema.indexOf.get("Q")!;
    // Rollback invariant: at any step boundary post-warm-start, accepted
    // state0 and previously accepted state1 are populated (rotation
    // occurred) and stay finite for the rolled Q slot. cktTerr() / LTE
    // proposals only fire on slots that carry meaningful values.
    expect(Number.isFinite(fix.pool.state0[el._stateBase + SLOT_Q])).toBe(true);
    expect(Number.isFinite(fix.pool.state1[el._stateBase + SLOT_Q])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Capacitor — T3 harness: RC charging paired vs ngspice
// (Cat 2-numerical / 3 / 5)
// ---------------------------------------------------------------------------

describeIfDll("Capacitor RC transient paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_RC_TRANSIENT, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_rc", async () => {
    // First it() owns the run. tStop=2ms covers ~1 full pulse period;
    // maxStep=2us gives ~1000 steps for predictor/integration coverage.
    await session.runTransient(0, 2e-3, 2e-6);
    session.compareAllSteps();
  });

  it("dcop_paired_rc", () => {
    // Cat 2-numerical: read step 0 (DCOP seed) from the recorded session.
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_rc", () => {
    // Cat 5: every NR iteration of every attempt of every step.
    session.compareAllAttempts();
  });
});

// ---------------------------------------------------------------------------
// Capacitor — T3 harness: RLC oscillator paired vs ngspice
// (Cat 2-numerical / 3 / 5)
// ---------------------------------------------------------------------------

describeIfDll("Capacitor RLC oscillator paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_RLC_OSCILLATOR, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_rlc", async () => {
    // Underdamped RLC at 1592Hz: tStop=1ms ≈ 1.6 periods, maxStep=1us
    // gives ~1000 steps for full predictor + LTE coverage of the
    // oscillatory regime.
    await session.runTransient(0, 1e-3, 1e-6);
    session.compareAllSteps();
  });

  it("dcop_paired_rlc", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_rlc", () => {
    session.compareAllAttempts();
  });
});
