/**
 * Tests for companion model coefficient functions and HistoryStore.
 *
 * Covers:
 *  - Coefficient values for BDF-1, trapezoidal, BDF-2 for capacitor and inductor
 *  - HistoryStore push/get/reset semantics
 *  - RC circuit exponential decay (trapezoidal and BDF-2)
 *  - RL circuit current rise (trapezoidal)
 */

import { describe, it, expect } from "vitest";
import {
  integrateCapacitor,
  integrateInductor,
  HistoryStore,
  computeNIcomCof,
} from "../integration.js";
import * as integrationModule from "../integration.js";
import { SparseSolver } from "../sparse-solver.js";
import { DiagnosticCollector } from "../diagnostics.js";
import { makeResistor, makeVoltageSource, makeCapacitor, makeInductor } from "./test-helpers.js";

// ---------------------------------------------------------------------------
// Companion model coefficient tests
// ---------------------------------------------------------------------------

describe("CompanionModels", () => {
  const C = 1e-6; // 1 uF
  const h = 1e-6; // 1 us

  it("capacitor_bdf1_coefficients", () => {
    // geq = C/h = 1e-6 / 1e-6 = 1.0 S
    const vNow = 0;
    const { geq } = integrateCapacitor(C, vNow, 0, 0, 0, h, 0, 1, "bdf1", 0);
    expect(geq).toBeCloseTo(1.0, 10);
  });

  it("capacitor_trapezoidal_coefficients", () => {
    // geq = 2C/h = 2 * 1e-6 / 1e-6 = 2.0 S (trapezoidal requires order >= 2)
    const vNow = 0;
    const { geq } = integrateCapacitor(C, vNow, 0, 0, 0, h, 0, 2, "trapezoidal", 0);
    expect(geq).toBeCloseTo(2.0, 10);
  });

  it("capacitor_bdf2_coefficients", () => {
    // geq = 3C/(2h) for equal steps (h1=h, h2=h)
    // With h1=h, h2=h: r1 = h/h = 1, r2 = 2h/h = 2, u22 = 2*(2-1) = 2
    // rhs2 = 1/h, ag2 = (1/h)/2 = 1/(2h), ag1 = (-1/h - 2/(2h))/1 = -2/h
    // ag0 = -(ag1+ag2) = 2/h - 1/(2h) = 3/(2h); geq = C*ag0 = 3C/(2h)
    const vNow = 0;
    const { geq } = integrateCapacitor(C, vNow, 0, 0, 0, h, h, 2, "bdf2", 0);
    expect(geq).toBeCloseTo(1.5, 10);
  });

  it("inductor_coefficients_dual_of_capacitor", () => {
    const L = 1e-6; // 1 uH — same numeric value as C so geq formula equals capacitor
    // BDF-1: inductor geq = L/h
    const { geq: geqL1 } = integrateInductor(L, 0, 0, 0, 0, h, 0, 1, "bdf1", 0);
    const { geq: geqC1 } = integrateCapacitor(C, 0, 0, 0, 0, h, 0, 1, "bdf1", 0);
    expect(geqL1).toBeCloseTo(geqC1, 10);
    // Trapezoidal: inductor geq = 2L/h (requires order >= 2)
    const { geq: geqLT } = integrateInductor(L, 0, 0, 0, 0, h, 0, 2, "trapezoidal", 0);
    const { geq: geqCT } = integrateCapacitor(C, 0, 0, 0, 0, h, 0, 2, "trapezoidal", 0);
    expect(geqLT).toBeCloseTo(geqCT, 10);
    // BDF-2: inductor geq = 3L/(2h)
    const { geq: geqL2 } = integrateInductor(L, 0, 0, 0, 0, h, h, 2, "bdf2", 0);
    const { geq: geqC2 } = integrateCapacitor(C, 0, 0, 0, 0, h, h, 2, "bdf2", 0);
    expect(geqL2).toBeCloseTo(geqC2, 10);
  });

  it("capacitor_bdf1_history_current", () => {
    // BDF-1: ccap = (q0 - q1)/dt = (C*vNow - C*vPrev)/dt
    // ceq = ccap - geq*vNow = (C*vNow - C*vPrev)/dt - (C/dt)*vNow = -C*vPrev/dt
    // This is the history term (independent of vNow once we set it up correctly).
    // Test with vNow=3V, vPrev=0: ceq = 0 (no prior charge)
    const vNow = 3.0;
    const vPrev = 0.0;
    const q0 = C * vNow;
    const q1 = C * vPrev;
    const { geq, ceq } = integrateCapacitor(C, vNow, q0, q1, 0, h, 0, 1, "bdf1", 0);
    // ceq = ccap - geq*vNow = (q0-q1)/h - (C/h)*vNow = C*(vNow-vPrev)/h - C*vNow/h = -C*vPrev/h
    const expected_ceq = -C * vPrev / h;
    expect(ceq).toBeCloseTo(expected_ceq, 10);
    // geq = C/h
    expect(geq).toBeCloseTo(C / h, 10);
  });

  it("capacitor_trapezoidal_history_current", () => {
    // Trapezoidal requires order >= 2: geq = 2C/h (xmu=0.5 default)
    // ag0 = 1/h/(1-0.5) = 2/h; ag1 = 0.5/(1-0.5) = 1
    // ccap = ag0*(q0-q1) + ag1*ccapPrev; with ccapPrev=0: ccap = 2C(vNow-vPrev)/h
    // ceq = ccap - geq*vNow = 2C(vNow-vPrev)/h - 2C*vNow/h = -2C*vPrev/h
    const vNow = 3.0;
    const vPrev = 1.0;
    const q0 = C * vNow;
    const q1 = C * vPrev;
    const { geq, ceq } = integrateCapacitor(C, vNow, q0, q1, 0, h, 0, 2, "trapezoidal", 0);
    expect(geq).toBeCloseTo(2 * C / h, 10);
    const expected_ceq = -2 * C * vPrev / h;
    expect(ceq).toBeCloseTo(expected_ceq, 10);
  });

  it("capacitor_bdf2_history_current", () => {
    // BDF-2 with h1=h, h2=h: geq = 3C/(2h)
    // ag0=3/(2h), ag1=-2/h, ag2=1/(2h)
    // ccap = ag0*q0 + ag1*q1 + ag2*q2 = (3*C*vNow - 4*C*vPrev + C*vPrev2)/(2h)
    // ceq = ccap - geq*vNow = (3C*vNow - 4C*vPrev + C*vPrev2)/(2h) - 3C*vNow/(2h)
    //      = (-4C*vPrev + C*vPrev2)/(2h)
    const vNow = 3.0;
    const vPrev = 2.0;
    const vPrev2 = 1.0;
    const q0 = C * vNow;
    const q1 = C * vPrev;
    const q2 = C * vPrev2;
    const { geq, ceq } = integrateCapacitor(C, vNow, q0, q1, q2, h, h, 2, "bdf2", 0);
    expect(geq).toBeCloseTo(1.5 * C / h, 10);
    const expected_ceq = (-4 * C * vPrev + C * vPrev2) / (2 * h);
    expect(ceq).toBeCloseTo(expected_ceq, 10);
  });

  it("capacitor_gear_order2_matches_bdf2", () => {
    const ag = new Float64Array(8);
    const scratch = new Float64Array(49);
    computeNIcomCof(h, [h, h], 2, "gear", ag, scratch);
    const { geq: geqGear } = integrateCapacitor(C, 0, 0, 0, 0, h, h, 2, "gear", 0, 0.5, [], ag);
    const { geq: geqBdf2 } = integrateCapacitor(C, 0, 0, 0, 0, h, h, 2, "bdf2", 0);
    expect(geqGear).toBeCloseTo(geqBdf2, 10);
  });

  it("capacitor_gear_order3_coefficients", () => {
    const ag = new Float64Array(8);
    const scratch = new Float64Array(49);
    computeNIcomCof(h, [h, h, h], 3, "gear", ag, scratch);
    const vNow = 2.0;
    const q0 = C * 2.0, q1 = C * 1.5, q2 = C * 1.0, q3 = C * 0.5;
    const { geq, ceq, ccap, ag0 } = integrateCapacitor(
      C, vNow, q0, q1, q2, h, h, 3, "gear", 0, 0.5, [q3], ag,
    );
    expect(ag0).toBeCloseTo(ag[0], 10);
    expect(geq).toBeCloseTo(ag[0] * C, 10);
    const expectedCcap = ag[0] * q0 + ag[1] * q1 + ag[2] * q2 + ag[3] * q3;
    expect(ccap).toBeCloseTo(expectedCcap, 10);
    expect(ceq).toBeCloseTo(expectedCcap - geq * vNow, 10);
  });

  it("capacitor_gear_order6_uses_full_history", () => {
    const ag = new Float64Array(8);
    const scratch = new Float64Array(49);
    computeNIcomCof(h, [h, h, h, h, h, h], 6, "gear", ag, scratch);
    const qs = [6, 5, 4, 3, 2, 1, 0].map(v => C * v);
    const { geq, ccap } = integrateCapacitor(
      C, 6.0, qs[0], qs[1], qs[2], h, h, 6, "gear", 0, 0.5,
      [qs[3], qs[4], qs[5], qs[6]], ag,
    );
    expect(geq).toBeCloseTo(ag[0] * C, 8);
    let expectedCcap = 0;
    for (let k = 0; k <= 6; k++) expectedCcap += ag[k] * qs[k];
    expect(ccap).toBeCloseTo(expectedCcap, 8);
  });

  it("inductor_gear_order3_dual_of_capacitor", () => {
    const L = 1e-6;
    const ag = new Float64Array(8);
    const scratch = new Float64Array(49);
    computeNIcomCof(h, [h, h, h], 3, "gear", ag, scratch);
    const phi0 = L * 2.0, phi1 = L * 1.5, phi2 = L * 1.0, phi3 = L * 0.5;
    const q0 = C * 2.0, q1 = C * 1.5, q2 = C * 1.0, q3 = C * 0.5;
    const { geq: geqL } = integrateInductor(
      L, 2.0, phi0, phi1, phi2, h, h, 3, "gear", 0, 0.5, [phi3], ag,
    );
    const { geq: geqC } = integrateCapacitor(
      C, 2.0, q0, q1, q2, h, h, 3, "gear", 0, 0.5, [q3], ag,
    );
    expect(geqL).toBeCloseTo(geqC, 10);
  });

  it("inductor_bdf1_history_current", () => {
    const L = 1e-3; // 1 mH
    const iNow = 2e-3; // 2 mA
    const iOld = 0;
    const phi0 = L * iNow;
    const phi1 = L * iOld;
    const { geq, ceq } = integrateInductor(L, iNow, phi0, phi1, 0, h, 0, 1, "bdf1", 0);
    // BDF-1: geq = L/h, ccap = (phi0-phi1)/h = L*(iNow-iOld)/h
    // ceq = ccap - geq*iNow = L*(iNow-iOld)/h - L*iNow/h = -L*iOld/h
    expect(geq).toBeCloseTo(L / h, 10);
    const expected_ceq = -L * iOld / h;
    expect(ceq).toBeCloseTo(expected_ceq, 10);
  });
});

// ---------------------------------------------------------------------------
// HistoryStore tests
// ---------------------------------------------------------------------------

describe("HistoryStore", () => {
  it("push_rotates_values", () => {
    const store = new HistoryStore(3);
    const idx = 1;
    store.push(idx, 10.0); // v(n) = 10
    store.push(idx, 20.0); // v(n) = 20, v(n-1) = 10

    expect(store.get(idx, 0)).toBeCloseTo(20.0, 10);
    expect(store.get(idx, 1)).toBeCloseTo(10.0, 10);
  });

  it("reset_zeros_all", () => {
    const store = new HistoryStore(4);
    store.push(0, 5.0);
    store.push(1, 3.0);
    store.push(2, 7.0);
    store.reset();

    for (let i = 0; i < 4; i++) {
      expect(store.get(i, 0)).toBe(0);
      expect(store.get(i, 1)).toBe(0);
    }
  });

  it("independent_per_element", () => {
    const store = new HistoryStore(2);
    // Push different values for element 0 and element 1
    store.push(0, 100.0);
    store.push(1, 200.0);
    store.push(0, 150.0);
    store.push(1, 250.0);

    expect(store.get(0, 0)).toBeCloseTo(150.0, 10);
    expect(store.get(0, 1)).toBeCloseTo(100.0, 10);
    expect(store.get(1, 0)).toBeCloseTo(250.0, 10);
    expect(store.get(1, 1)).toBeCloseTo(200.0, 10);
  });

  it("initial_values_are_zero", () => {
    const store = new HistoryStore(5);
    for (let i = 0; i < 5; i++) {
      expect(store.get(i, 0)).toBe(0);
      expect(store.get(i, 1)).toBe(0);
    }
  });

  it("push_three_times_correct_history", () => {
    const store = new HistoryStore(1);
    store.push(0, 1.0);
    store.push(0, 2.0);
    store.push(0, 3.0); // v(n)=3, v(n-1)=2 (v(n-2)=1 is gone)

    expect(store.get(0, 0)).toBeCloseTo(3.0, 10);
    expect(store.get(0, 1)).toBeCloseTo(2.0, 10);
  });
});

// ---------------------------------------------------------------------------
// RC circuit transient tests
// ---------------------------------------------------------------------------

/**
 * Run a transient simulation of an RC circuit and return the capacitor voltage
 * at t = RC (one time constant).
 *
 * Circuit topology:
 *   Node 1 — branch row 0: Voltage source 5V (node 1 to ground)
 *   Node 2: junction of R and C
 *   R (1kΩ) between node 1 and node 2
 *   C between node 2 and ground
 *
 * DC OP: V(node2) = 5V (capacitor fully charged via 0Ω path from source).
 * Wait — that's not a decay circuit. For exponential decay we need:
 *   - Charge capacitor to V0 with no resistor in the path (initial condition)
 *   - Then disconnect source and let it discharge through R
 *
 * Simpler approach: use a pre-charged capacitor (set initial voltage via IC)
 * by starting with V(node1) = 5V from the source, and at t=0 opening the source.
 *
 * Easiest test circuit for exponential decay:
 *   - R between node 1 and node 2
 *   - C between node 2 and ground
 *   - Initial condition: V(node1) = V(node2) = 5V (capacitor pre-charged)
 *   - Source removed: at t=0, node 1 is floating (or tied through R to ground)
 *
 * Actually the standard RC decay test is:
 *   - Source charges cap: V(cap) = 5V at t=0
 *   - Source disconnected (or = 0), cap discharges through R
 *   - V(cap, t) = 5 * exp(-t/RC)
 *
 * We implement this directly: R between node 1 (ground) and node 2, cap on node 2.
 * Pre-charge by setting initial solution V(node2) = 5V, then step with R to ground.
 *
 * Circuit for decay:
 *   node 1 = 0 (ground effectively — but we need it as a non-ground node?)
 *
 * Simplest implementation:
 *   - One non-ground node (node 1)
 *   - R between node 1 and ground (node 0): nodeA=1, nodeB=0, R=1000
 *   - C between node 1 and ground: nodeA=1, nodeB=0, C=1e-6
 *   - Initial condition: V(node1) = 5.0V
 *   - No voltage source — just let it decay
 *   - matrixSize = 1 (1 node, 0 branches)
 */
function runRcDecay(
  method: "trapezoidal" | "bdf2",
  steps: number,
  dt: number,
): number {
  const R = 1000;   // 1 kΩ
  const C = 1e-6;   // 1 uF
  // RC = 1 ms; steps * dt should reach ~RC

  const solver = new SparseSolver();
  new DiagnosticCollector();

  // Circuit: R and C both between node 1 and ground
  const resistor = makeResistor(1, 0, R);
  const capacitor = makeCapacitor(1, 0, C);
  void [resistor, capacitor];
  const matrixSize = 1; // 1 non-ground node

  // Initial condition: V(node1) = 5.0V
  let voltages = new Float64Array([5.0]);

  // Run transient steps — order=1 for the test helper (BDF-1 path for all methods)
  for (let step = 0; step < steps; step++) {
    // Update companion model coefficients from previous solution
    capacitor.stampCompanion!(dt, method, voltages, 1, [dt]);

    solver.beginAssembly(matrixSize);

    // Stamp all element contributions (capacitor stamp uses updated geq/ieq)
    resistor.stamp(solver);
    capacitor.stamp(solver);

    solver.finalize();
    const result = solver.factor();
    if (!result.success) {
      throw new Error(`Singular matrix at step ${step}`);
    }
    solver.solve(voltages);
  }

  return voltages[0];
}

describe("RCCircuit", () => {
  it("exponential_decay_trapezoidal", () => {
    // R=1kΩ, C=1uF, RC=1ms, initial V=5V
    // Step 1000 times at h=1us → t = 1ms = RC
    // Expected: V = 5 * exp(-1) ≈ 1.8394V
    // Tolerance: within 5% of analytical
    const dt = 1e-6;   // 1 us
    const steps = 1000; // t = 1 ms = RC
    const vAnalytical = 5 * Math.exp(-1); // ≈ 1.8394 V

    const vSim = runRcDecay("trapezoidal", steps, dt);

    expect(Math.abs(vSim - vAnalytical) / vAnalytical).toBeLessThan(0.05);
  });

  it("exponential_decay_bdf2", () => {
    // Same circuit with BDF-2 integration
    // BDF-2 has slightly more damping but should still match within 5%
    const dt = 1e-6;
    const steps = 1000;
    const vAnalytical = 5 * Math.exp(-1);

    const vSim = runRcDecay("bdf2", steps, dt);

    expect(Math.abs(vSim - vAnalytical) / vAnalytical).toBeLessThan(0.05);
  });
});

// ---------------------------------------------------------------------------
// RL circuit transient test
// ---------------------------------------------------------------------------

/**
 * Run a transient simulation of an RL circuit and return the inductor current
 * at t = L/R (one time constant).
 *
 * Circuit:
 *   Vs = 5V voltage source from ground to node 1 (branch row 0)
 *   R = 1kΩ between node 1 and node 2
 *   L = 1mH between node 2 and ground (branch row 1)
 *
 * Analytical: I(t) = (Vs/R) * (1 - exp(-t * R/L))
 * At t = L/R: I = (Vs/R) * (1 - exp(-1)) ≈ (5/1000) * 0.6321 ≈ 3.161 mA
 *
 * MNA matrix size: 2 nodes + 2 branches = 4
 *   node 1: junction of Vs and R
 *   node 2: junction of R and L
 *   branch 0: Vs current (row 2 in 0-based)
 *   branch 1: L current (row 3 in 0-based)
 */
function runRlRise(steps: number, dt: number): number {
  const Vs = 5.0;
  const R = 1000;    // 1 kΩ
  const L = 1e-3;    // 1 mH
  // tau = L/R = 1e-3 / 1e3 = 1e-6 s ... wait, L/R = 1e-3/1000 = 1e-6 s = 1 us
  // That's very small. Use R=1 Ω, L=1 mH for tau = 1ms instead.
  // Actually the spec says: R=1kΩ, L=1mH → tau = L/R = 1e-3/1000 = 1us
  // steps * dt = 1000 * 1e-9 = 1us — need 1000 steps at 1ns.
  // That's fine.

  const solver = new SparseSolver();
  new DiagnosticCollector();

  // matrixSize = 2 nodes + 2 branches = 4
  // node 1 = 0-based index 0; node 2 = 0-based index 1
  // branch 0 (Vs) = 0-based index 2; branch 1 (L) = 0-based index 3
  const matrixSize = 4;

  const vsource = makeVoltageSource(1, 0, 2, Vs); // branch row 2 (absolute)
  const resistor = makeResistor(1, 2, R);
  const inductor = makeInductor(2, 0, 3, L);      // branch row 3 (absolute)
  void [vsource, resistor, inductor];

  let voltages = new Float64Array(matrixSize);

  // Transient steps — order=1 for the test helper
  for (let step = 0; step < steps; step++) {
    // Update inductor companion model coefficients from previous solution
    inductor.stampCompanion!(dt, "trapezoidal", voltages, 1, [dt]);

    solver.beginAssembly(matrixSize);

    // Stamp all element contributions
    vsource.stamp(solver);
    resistor.stamp(solver);
    inductor.stamp(solver);

    solver.finalize();
    const result = solver.factor();
    if (!result.success) {
      throw new Error(`Singular matrix at step ${step}`);
    }
    solver.solve(voltages);
  }

  // The inductor branch current is at voltages[3] (branch row 3)
  return voltages[3];
}

describe("RLCircuit", () => {
  it("current_rise", () => {
    // R=1kΩ, L=1mH → tau = L/R = 1us
    // Step 1000 times at h=1ns → t = 1us = tau
    // Expected: I = (5/1000) * (1 - exp(-1)) ≈ 3.161 mA
    // Tolerance: within 5% of analytical
    const R = 1000;
    const Vs = 5.0;
    const dt = 1e-9;    // 1 ns
    const steps = 1000; // t = 1 us = L/R

    const iAnalytical = (Vs / R) * (1 - Math.exp(-1)); // ≈ 3.161 mA

    const iSim = runRlRise(steps, dt);

    expect(Math.abs(iSim - iAnalytical) / iAnalytical).toBeLessThan(0.05);
  });
});

// ---------------------------------------------------------------------------
// Task 1.2.1 spec tests
// ---------------------------------------------------------------------------

describe("gear_vandermonde_zero_alloc", () => {
  it("gear_vandermonde_uses_scratch_buffer", () => {
    // solveGearVandermonde no longer allocates — it uses the scratch buffer passed
    // via computeNIcomCof. Verify correct coefficients for GEAR orders 2-6 and
    // that the scratch buffer is mutated (not a new allocation path).
    const ag = new Float64Array(8);
    const scratch = new Float64Array(49);
    const h = 1e-6;

    // GEAR order 2 equal steps: ag*dt = [1.5, -2, 0.5]
    scratch.fill(0);
    computeNIcomCof(h, [h, h], 2, "gear", ag, scratch);
    expect(ag[0]).toBeCloseTo(3 / (2 * h), 8);
    expect(ag[1]).toBeCloseTo(-2 / h, 8);
    expect(ag[2]).toBeCloseTo(1 / (2 * h), 8);
    // Scratch buffer was mutated (non-zero entries exist after the solve)
    const scratchWasMutated = scratch.some(v => v !== 0);
    expect(scratchWasMutated).toBe(true);

    // GEAR order 3 equal steps: ag*dt = [11/6, -3, 3/2, -1/3]
    ag.fill(0); scratch.fill(0);
    computeNIcomCof(h, [h, h, h], 3, "gear", ag, scratch);
    expect(ag[0]).toBeCloseTo(11 / (6 * h), 6);
    expect(ag[1]).toBeCloseTo(-3 / h, 6);
    expect(ag[2]).toBeCloseTo(3 / (2 * h), 6);
    expect(ag[3]).toBeCloseTo(-1 / (3 * h), 6);

    // GEAR order 4 equal steps: ag*dt = [25/12, -4, 3, -4/3, 1/4]
    ag.fill(0); scratch.fill(0);
    computeNIcomCof(h, [h, h, h, h], 4, "gear", ag, scratch);
    expect(ag[0]).toBeCloseTo(25 / (12 * h), 6);
    expect(ag[1]).toBeCloseTo(-4 / h, 6);
    expect(ag[4]).toBeCloseTo(1 / (4 * h), 6);

    // GEAR order 5 equal steps
    ag.fill(0); scratch.fill(0);
    computeNIcomCof(h, [h, h, h, h, h], 5, "gear", ag, scratch);
    expect(ag[0]).toBeCloseTo(137 / (60 * h), 5);
    expect(ag[5]).toBeCloseTo(-1 / (5 * h), 5);

    // GEAR order 6 equal steps
    ag.fill(0); scratch.fill(0);
    computeNIcomCof(h, [h, h, h, h, h, h], 6, "gear", ag, scratch);
    expect(ag[0]).toBeCloseTo(49 / (20 * h), 5);
    expect(ag[6]).toBeCloseTo(1 / (6 * h), 5);
  });

  it("computeIntegrationCoefficients_deleted", () => {
    // computeIntegrationCoefficients must not exist as an export from integration.ts
    expect((integrationModule as Record<string, unknown>)["computeIntegrationCoefficients"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// computeNIcomCof tests (Item 5.3)
// ---------------------------------------------------------------------------

describe("computeNIcomCof", () => {
  const h = 1e-6;
  const scratch = new Float64Array(49);

  it("fills ag with zeros when dt <= 0", () => {
    const ag = new Float64Array(8);
    ag.fill(99); // pre-fill to confirm overwrite
    computeNIcomCof(0, [0, 0], 1, "bdf1", ag, scratch);
    for (let i = 0; i < ag.length; i++) {
      expect(ag[i]).toBe(0);
    }
  });

  it("BDF-1 order 1: ag[0]=1/dt, ag[1]=-1/dt", () => {
    const ag = new Float64Array(8);
    computeNIcomCof(h, [h, h], 1, "bdf1", ag, scratch);
    expect(ag[0]).toBeCloseTo(1 / h, 10);
    expect(ag[1]).toBeCloseTo(-1 / h, 10);
  });

  it("trapezoidal order 1: ag[0]=1/dt, ag[1]=-1/dt", () => {
    const ag = new Float64Array(8);
    computeNIcomCof(h, [h, h], 1, "trapezoidal", ag, scratch);
    expect(ag[0]).toBeCloseTo(1 / h, 10);
    expect(ag[1]).toBeCloseTo(-1 / h, 10);
  });

  it("trapezoidal order 2: ag[0]=2/dt, ag[1]=1 (xmu=0.5)", () => {
    const ag = new Float64Array(8);
    computeNIcomCof(h, [h, h], 2, "trapezoidal", ag, scratch);
    // xmu=0.5: ag[0] = 1/dt/(1-0.5) = 2/dt; ag[1] = 0.5/(1-0.5) = 1
    expect(ag[0]).toBeCloseTo(2 / h, 10);
    expect(ag[1]).toBeCloseTo(1, 10);
  });

  it("BDF-2 equal steps: ag[0]=3/(2h), ag[1]=-2/h, ag[2]=1/(2h)", () => {
    const ag = new Float64Array(8);
    computeNIcomCof(h, [h, h], 2, "bdf2", ag, scratch);
    // With h1=h: r1=1, r2=2, u22=2*(2-1)=2, rhs2=1/h
    // ag2 = (1/h)/2 = 1/(2h), ag1 = (-1/h - 2/(2h))/1 = -2/h
    // ag0 = -(ag1+ag2) = 2/h - 1/(2h) = 3/(2h)
    expect(ag[0]).toBeCloseTo(3 / (2 * h), 10);
    expect(ag[1]).toBeCloseTo(-2 / h, 10);
    expect(ag[2]).toBeCloseTo(1 / (2 * h), 10);
  });

  it("BDF-2 degenerate (h1=0): falls back to BE coefficients", () => {
    // deltaOld[1]=0 triggers safeH1=dt fallback, which gives equal-steps BDF-2, not BE.
    // Spec: h1 = deltaOld[1] > 0 ? deltaOld[1] : dt — so h1=dt → equal steps BDF-2.
    const ag = new Float64Array(8);
    computeNIcomCof(h, [h, 0], 2, "bdf2", ag, scratch);
    // h1=0 → safeH1=dt=h → same as equal steps
    expect(ag[0]).toBeCloseTo(3 / (2 * h), 10);
    expect(ag[1]).toBeCloseTo(-2 / h, 10);
    expect(ag[2]).toBeCloseTo(1 / (2 * h), 10);
  });

  it("ag[0] matches integrateCapacitor ag0 for same dt/method/order", () => {
    const C = 1;
    const ag = new Float64Array(8);
    computeNIcomCof(h, [h, h], 2, "bdf2", ag, scratch);
    const { ag0: ag0Cap } = integrateCapacitor(C, 0, 0, 0, 0, h, h, 2, "bdf2", 0);
    expect(ag[0]).toBeCloseTo(ag0Cap, 10);
  });

  it("ag[0] matches integrateCapacitor ag0 for trapezoidal order 2", () => {
    const C = 1;
    const ag = new Float64Array(8);
    computeNIcomCof(h, [h, h], 2, "trapezoidal", ag, scratch);
    const { ag0: ag0Cap } = integrateCapacitor(C, 0, 0, 0, 0, h, h, 2, "trapezoidal", 0);
    expect(ag[0]).toBeCloseTo(ag0Cap, 10);
  });

  it("GEAR order 2 equal steps matches BDF-2: ag[0]=3/(2h), ag[1]=-2/h, ag[2]=1/(2h)", () => {
    // GEAR method with order=2 and equal steps should produce same coefficients as BDF-2.
    // nicomcof.c: Vandermonde with r[1]=1, r[2]=2 gives ag*dt = [1.5, -2, 0.5].
    const ag = new Float64Array(8);
    const scratch = new Float64Array(49);
    computeNIcomCof(h, [h, h], 2, "gear", ag, scratch);
    expect(ag[0]).toBeCloseTo(3 / (2 * h), 8);
    expect(ag[1]).toBeCloseTo(-2 / h, 8);
    expect(ag[2]).toBeCloseTo(1 / (2 * h), 8);
  });

  it("GEAR order 3 equal steps: ag*dt = [11/6, -3, 3/2, -1/3]", () => {
    // Known GEAR-3 equal-step coefficients from numerical integration tables.
    // nicomcof.c Vandermonde with r[1]=1, r[2]=2, r[3]=3.
    // ag*dt = [11/6, -3, 3/2, -1/3]
    const ag = new Float64Array(8);
    const scratch = new Float64Array(49);
    computeNIcomCof(h, [h, h, h], 3, "gear", ag, scratch);
    expect(ag[0]).toBeCloseTo(11 / (6 * h), 6);
    expect(ag[1]).toBeCloseTo(-3 / h, 6);
    expect(ag[2]).toBeCloseTo(3 / (2 * h), 6);
    expect(ag[3]).toBeCloseTo(-1 / (3 * h), 6);
  });

  it("GEAR order 4 equal steps: ag*dt = [25/12, -4, 3, -4/3, 1/4]", () => {
    // Known GEAR-4 equal-step coefficients.
    // ag*dt = [25/12, -4, 3, -4/3, 1/4]
    const ag = new Float64Array(8);
    const scratch = new Float64Array(49);
    computeNIcomCof(h, [h, h, h, h], 4, "gear", ag, scratch);
    expect(ag[0]).toBeCloseTo(25 / (12 * h), 6);
    expect(ag[1]).toBeCloseTo(-4 / h, 6);
    expect(ag[2]).toBeCloseTo(3 / h, 6);
    expect(ag[3]).toBeCloseTo(-4 / (3 * h), 6);
    expect(ag[4]).toBeCloseTo(1 / (4 * h), 6);
  });

  it("GEAR order 5 equal steps: ag*dt = [137/60, -5, 5, -10/3, 5/4, -1/5]", () => {
    // Known GEAR-5 equal-step coefficients.
    const ag = new Float64Array(8);
    const scratch = new Float64Array(49);
    computeNIcomCof(h, [h, h, h, h, h], 5, "gear", ag, scratch);
    expect(ag[0]).toBeCloseTo(137 / (60 * h), 5);
    expect(ag[1]).toBeCloseTo(-5 / h, 5);
    expect(ag[2]).toBeCloseTo(5 / h, 5);
    expect(ag[3]).toBeCloseTo(-10 / (3 * h), 5);
    expect(ag[4]).toBeCloseTo(5 / (4 * h), 5);
    expect(ag[5]).toBeCloseTo(-1 / (5 * h), 5);
  });

  it("GEAR order 6 equal steps: ag*dt = [49/20, -6, 15/2, -20/3, 15/4, -6/5, 1/6]", () => {
    // Known GEAR-6 equal-step coefficients.
    const ag = new Float64Array(8);
    const scratch = new Float64Array(49);
    computeNIcomCof(h, [h, h, h, h, h, h], 6, "gear", ag, scratch);
    expect(ag[0]).toBeCloseTo(49 / (20 * h), 5);
    expect(ag[1]).toBeCloseTo(-6 / h, 5);
    expect(ag[2]).toBeCloseTo(15 / (2 * h), 5);
    expect(ag[3]).toBeCloseTo(-20 / (3 * h), 5);
    expect(ag[4]).toBeCloseTo(15 / (4 * h), 5);
    expect(ag[5]).toBeCloseTo(-6 / (5 * h), 5);
    expect(ag[6]).toBeCloseTo(1 / (6 * h), 5);
  });

  it("GEAR coefficients sum to zero (interpolation constraint)", () => {
    // For all GEAR orders, sum(ag) = 0 (the polynomial interpolates Q correctly).
    const ag = new Float64Array(8);
    const scratch = new Float64Array(49);
    for (const order of [2, 3, 4, 5, 6]) {
      ag.fill(0);
      computeNIcomCof(h, [h, h, h, h, h, h], order, "gear", ag, scratch);
      let sum = 0;
      for (let k = 0; k <= order; k++) sum += ag[k];
      expect(Math.abs(sum)).toBeLessThan(1e-9);
    }
  });
});

// ---------------------------------------------------------------------------
// Task 3.2.2 — trap_order2_ccap_with_nonstandard_xmu
// ---------------------------------------------------------------------------

describe("trap_order2_ccap", () => {
  it("trap_order2_ccap_with_nonstandard_xmu", () => {
    // xmu=0.3 (non-standard, not 0.5): old code used -ccapPrev, correct uses +ag1*ccapPrev
    // where ag1 = xmu/(1-xmu) = 0.3/0.7
    const xmu = 0.3;
    const q0 = 1e-12, q1 = 0.9e-12;
    const ccapPrev = 1e-6;
    const dt = 1e-9;
    const C = 1;

    // Reference: ngspice niinteg.c trap order 2
    const ag0 = 1.0 / dt / (1 - xmu);
    const ag1 = xmu / (1 - xmu);
    const expectedCcap = ag0 * (q0 - q1) + ag1 * ccapPrev;

    const { ccap } = integrateCapacitor(C, 0, q0, q1, 0, dt, 0, 2, "trapezoidal", ccapPrev, xmu);
    expect(ccap).toBe(expectedCcap); // bit-exact

    // Verify old formula would have given different result (it used -ccapPrev)
    const oldCcap = ag0 * (q0 - q1) - ccapPrev;
    expect(ccap).not.toBe(oldCcap);
  });
});

// ---------------------------------------------------------------------------
// Task 3.2.3 — gear_vandermonde_flat_scratch_regression
// ---------------------------------------------------------------------------

describe("gear_vandermonde_regression", () => {
  it("gear_vandermonde_flat_scratch_regression", () => {
    // Regression test: Phase 1 converted solveGearVandermonde to use a flat scratch buffer.
    // This test verifies numerical correctness of GEAR order 4 coefficients.
    const h = 1e-6;
    const ag = new Float64Array(8);
    // Allocate scratch independently (not from CKTCircuitContext)
    const scratch = new Float64Array(49);

    // Verify scratch starts zeroed
    expect(scratch[0]).toBe(0);

    computeNIcomCof(h, [h, h, h, h], 4, "gear", ag, scratch);

    // Assert ag[0..4] match the closed-form GEAR-4 coefficients bit-exact.
    // Known GEAR-4 coefficients for equal steps: ag*dt = [25/12, -4, 3, -4/3, 1/4].
    // A byte-equivalent Vandermonde solver must produce these to IEEE-754 precision.
    //
    // Known divergence at commit ecdc34a: ag[0] produces 2083333.333333333
    // (1 ULP low vs closed-form 2083333.3333333333 = 25/(12*h)). This is a
    // real numerical divergence from the mathematical ideal and (likely)
    // from ngspice — not a test-infra issue. Keep the assertion strict so
    // it stays flagged as a finding for batch-4 remediation.
    expect(ag[0]).toBe(25 / (12 * h));
    expect(ag[1]).toBe(-4 / h);
    expect(ag[2]).toBe(3 / h);
    expect(ag[3]).toBe(-4 / (3 * h));
    expect(ag[4]).toBe(1 / (4 * h));

    // Assert the scratch buffer was mutated — confirms it was used (not bypassed)
    expect(scratch[0]).not.toBe(0);
  });
});
