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
  capacitorConductance,
  capacitorHistoryCurrent,
  inductorConductance,
  inductorHistoryCurrent,
  HistoryStore,
} from "../integration.js";
import { SparseSolver } from "../sparse-solver.js";
import { DiagnosticCollector } from "../diagnostics.js";
import { makeResistor, makeVoltageSource, makeCapacitor, makeInductor } from "../test-elements.js";
import { newtonRaphson } from "../newton-raphson.js";

// ---------------------------------------------------------------------------
// Companion model coefficient tests
// ---------------------------------------------------------------------------

describe("CompanionModels", () => {
  const C = 1e-6; // 1 uF
  const h = 1e-6; // 1 us

  it("capacitor_bdf1_coefficients", () => {
    // geq = C/h = 1e-6 / 1e-6 = 1.0 S
    const geq = capacitorConductance(C, h, "bdf1");
    expect(geq).toBeCloseTo(1.0, 10);
  });

  it("capacitor_trapezoidal_coefficients", () => {
    // geq = 2C/h = 2 * 1e-6 / 1e-6 = 2.0 S
    const geq = capacitorConductance(C, h, "trapezoidal");
    expect(geq).toBeCloseTo(2.0, 10);
  });

  it("capacitor_bdf2_coefficients", () => {
    // geq = 3C/(2h) = 3*1e-6/(2*1e-6) = 1.5 S
    const geq = capacitorConductance(C, h, "bdf2");
    expect(geq).toBeCloseTo(1.5, 10);
  });

  it("inductor_coefficients_dual_of_capacitor", () => {
    const L = 1e-6; // 1 uH — same numeric value as C so geq formula equals capacitor
    // BDF-1: inductor geq = L/h
    expect(inductorConductance(L, h, "bdf1")).toBeCloseTo(capacitorConductance(C, h, "bdf1"), 10);
    // Trapezoidal: inductor geq = 2L/h
    expect(inductorConductance(L, h, "trapezoidal")).toBeCloseTo(
      capacitorConductance(C, h, "trapezoidal"),
      10,
    );
    // BDF-2: inductor geq = 3L/(2h)
    expect(inductorConductance(L, h, "bdf2")).toBeCloseTo(capacitorConductance(C, h, "bdf2"), 10);
  });

  it("capacitor_bdf1_history_current", () => {
    // ieq = -geq * v(n)
    const geq = capacitorConductance(C, h, "bdf1");
    const vNow = 3.0;
    const ieq = capacitorHistoryCurrent(C, h, "bdf1", vNow, 0, 0);
    expect(ieq).toBeCloseTo(-geq * vNow, 10);
  });

  it("capacitor_trapezoidal_history_current", () => {
    // ieq = -geq * v(n) - i(n)
    const geq = capacitorConductance(C, h, "trapezoidal");
    const vNow = 3.0;
    const iNow = 0.5e-3; // 0.5 mA
    const ieq = capacitorHistoryCurrent(C, h, "trapezoidal", vNow, 0, iNow);
    expect(ieq).toBeCloseTo(-geq * vNow - iNow, 10);
  });

  it("capacitor_bdf2_history_current", () => {
    // ieq = -geq * (4/3 * v(n) - 1/3 * v(n-1))
    const geq = capacitorConductance(C, h, "bdf2");
    const vNow = 3.0;
    const vPrev = 2.0;
    const ieq = capacitorHistoryCurrent(C, h, "bdf2", vNow, vPrev, 0);
    const expected = -geq * ((4 / 3) * vNow - (1 / 3) * vPrev);
    expect(ieq).toBeCloseTo(expected, 10);
  });

  it("inductor_bdf1_history_current", () => {
    const L = 1e-3; // 1 mH
    const geq = inductorConductance(L, h, "bdf1");
    const iNow = 2e-3; // 2 mA
    const ieq = inductorHistoryCurrent(L, h, "bdf1", iNow, 0, 0);
    expect(ieq).toBeCloseTo(-geq * iNow, 10);
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
  const diagnostics = new DiagnosticCollector();

  // Circuit: R and C both between node 1 and ground
  const resistor = makeResistor(1, 0, R);
  const capacitor = makeCapacitor(1, 0, C);
  const elements = [resistor, capacitor];
  const matrixSize = 1; // 1 non-ground node

  // Initial condition: V(node1) = 5.0V
  let voltages = new Float64Array([5.0]);

  // Run transient steps
  for (let step = 0; step < steps; step++) {
    // Update companion model coefficients from previous solution
    capacitor.stampCompanion!(dt, method, voltages);

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
  const diagnostics = new DiagnosticCollector();

  // matrixSize = 2 nodes + 2 branches = 4
  // node 1 = 0-based index 0; node 2 = 0-based index 1
  // branch 0 (Vs) = 0-based index 2; branch 1 (L) = 0-based index 3
  const matrixSize = 4;

  const vsource = makeVoltageSource(1, 0, 2, Vs); // branch row 2 (absolute)
  const resistor = makeResistor(1, 2, R);
  const inductor = makeInductor(2, 0, 3, L);      // branch row 3 (absolute)
  const elements = [vsource, resistor, inductor];

  let voltages = new Float64Array(matrixSize);

  // Transient steps
  for (let step = 0; step < steps; step++) {
    // Update inductor companion model coefficients from previous solution
    inductor.stampCompanion!(dt, "trapezoidal", voltages);

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
