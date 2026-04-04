/**
 * Tests for the Newton-Raphson iteration loop, voltage limiting functions,
 * and the makeDiode test element.
 */

import { describe, it, expect } from "vitest";
import { SparseSolver } from "../sparse-solver.js";
import { DiagnosticCollector } from "../diagnostics.js";
import { newtonRaphson, pnjlim, fetlim } from "../newton-raphson.js";
import { makeResistor, makeVoltageSource, makeDiode } from "./test-helpers.js";

// ---------------------------------------------------------------------------
// Helpers — build a simple diode+resistor circuit
//
// Topology:
//   Node 0 = ground
//   Node 1 = anode (Vs positive terminal)
//   Node 2 = junction between resistor and diode cathode
//   Branch row 2 = voltage source branch
//
// Circuit: 5V source → 1kΩ resistor → diode → ground
//   Vs: nodes (1, 0), branch row 2, voltage = 5V
//   R:  nodes (1, 2), R = 1000 Ω
//   D:  nodes (2, 0), Is = 1e-14, n = 1
//
// matrixSize = 3 (2 nodes + 1 branch)
// ---------------------------------------------------------------------------

function makeDiodeCircuit(sourceVoltage: number) {
  const solver = new SparseSolver();
  const diagnostics = new DiagnosticCollector();

  // Node 1 = Vs+, Node 2 = anode/resistor junction, Node 0 = ground/cathode
  // Branch row index = 2 (absolute, 0-based in solver)
  const vs = makeVoltageSource(1, 0, 2, sourceVoltage);
  const r = makeResistor(1, 2, 1000);
  const d = makeDiode(2, 0, 1e-14, 1);

  return { solver, diagnostics, elements: [vs, r, d], matrixSize: 3 };
}

// ---------------------------------------------------------------------------
// pnjlim tests
// ---------------------------------------------------------------------------

describe("NR", () => {
  it("pnjlim_clamps_large_step", () => {
    // Large forward step: 0.5V → 100V — should be compressed logarithmically
    const result = pnjlim(100, 0.5, 0.026, 0.6);
    // Must be dramatically less than 100 (logarithmic compression)
    expect(result).toBeLessThan(10);
    // Must still be greater than vold (forward biased)
    expect(result).toBeGreaterThan(0.5);
  });

  it("pnjlim_passes_small_step", () => {
    // Small step within 2*Vt: 0.60V → 0.65V, Vt=0.026, vcrit=0.6
    // |vnew - vold| = 0.05 > 2*0.026 = 0.052 — just barely triggers
    // But vnew = 0.65 > vcrit = 0.6, so limiting engages
    // After limiting: vold + Vt * ln(1 + (vnew-vold)/Vt) = 0.60 + 0.026*ln(1+0.05/0.026)
    // = 0.60 + 0.026*ln(2.923) = 0.60 + 0.026*1.073 ≈ 0.628
    // The spec test says pnjlim(0.65, 0.60, 0.026, 0.6) returns 0.65 (unchanged)
    // Let's check: |0.65 - 0.60| = 0.05, 2*vt = 0.052, so 0.05 <= 0.052 → no limiting
    const result = pnjlim(0.65, 0.60, 0.026, 0.6);
    expect(result).toBeCloseTo(0.65, 10);
  });

  // ---------------------------------------------------------------------------
  // fetlim tests
  // ---------------------------------------------------------------------------

  it("fetlim_clamps_above_threshold", () => {
    // SPICE3f5 three-zone algorithm:
    // vold=1.0, vto=0.7: near-threshold zone (vold >= vto but < vto+3.5=4.2)
    // Increasing step (delv=2.0 > 0): clamp to min(vnew, vto+4) = min(3.0, 4.7) = 3.0
    const result = fetlim(3.0, 1.0, 0.7);
    expect(result).toBeLessThanOrEqual(1.0 + 0.7 + 4); // capped at vto+4
    expect(result).toBeGreaterThan(1.0);

    // Deep-on zone: large enough step triggers vtsthi clamp
    // vtsthi = |2*(5.0-0.7)|+2 = 10.6, delv=15 > 10.6 → clamp to 5+10.6=15.6
    const result3 = fetlim(20.0, 5.0, 0.7);
    expect(result3).toBeCloseTo(5.0 + (Math.abs(2 * (5.0 - 0.7)) + 2), 10);
  });

  // ---------------------------------------------------------------------------
  // Linear circuit: should converge in exactly 1 iteration
  // ---------------------------------------------------------------------------

  it("linear_converges_in_one_iteration", () => {
    // Resistor divider: 5V source, R1=1kΩ, R2=1kΩ → midpoint = 2.5V
    // Topology:
    //   Node 1 = Vs+, Node 2 = midpoint, Node 0 = ground
    //   Branch row 2 = Vs branch
    //   matrixSize = 3
    const solver = new SparseSolver();
    const diagnostics = new DiagnosticCollector();

    const vs = makeVoltageSource(1, 0, 2, 5.0);
    const r1 = makeResistor(1, 2, 1000);
    const r2 = makeResistor(2, 0, 1000);

    const result = newtonRaphson({
      solver,
      elements: [vs, r1, r2],
      matrixSize: 3,
      maxIterations: 100,
      reltol: 1e-3,
      abstol: 1e-6,
      diagnostics,
    });

    expect(result.converged).toBe(true);
    expect(result.iterations).toBe(1);
    // Node 2 (index 1 in 0-based solver) = midpoint voltage ~2.5V
    expect(result.voltages[1]).toBeCloseTo(2.5, 4);
  });

  // ---------------------------------------------------------------------------
  // Diode forward bias
  // ---------------------------------------------------------------------------

  it("diode_circuit_converges", () => {
    const { solver, diagnostics, elements, matrixSize } = makeDiodeCircuit(5.0);

    const result = newtonRaphson({
      solver,
      elements,
      matrixSize,
      maxIterations: 100,
      reltol: 1e-3,
      abstol: 1e-6,
      diagnostics,
    });

    expect(result.converged).toBe(true);
    expect(result.iterations).toBeLessThan(20);

    // Node 2 = diode anode voltage (= forward voltage drop since cathode is grounded)
    // For Is=1e-14, n=1, Id≈4.3mA → Vd ≈ 0.026*ln(4.3e-3/1e-14) = ~0.68V
    const vd = result.voltages[1]; // node 2, 0-based index 1
    expect(vd).toBeGreaterThan(0.6);
    expect(vd).toBeLessThan(0.75);
  });

  // ---------------------------------------------------------------------------
  // Diode reverse bias
  // ---------------------------------------------------------------------------

  it("diode_reverse_bias", () => {
    const { solver, diagnostics, elements, matrixSize } = makeDiodeCircuit(-5.0);

    const result = newtonRaphson({
      solver,
      elements,
      matrixSize,
      maxIterations: 100,
      reltol: 1e-3,
      abstol: 1e-6,
      diagnostics,
    });

    expect(result.converged).toBe(true);

    // In reverse bias: anode voltage ≈ -5V (clamped by Is ≈ -1e-14 A)
    // Current through resistor = (Vs_node - anode_node)/R ≈ tiny leakage
    // Node 1 (index 0) = Vs+ = -5V (forced by voltage source)
    // Node 2 (index 1) = diode anode ≈ -5V (tiny reverse current)
    // Current = (node1_v - node2_v) / 1000 should be < 1e-12 A in magnitude
    const vNode1 = result.voltages[0]; // Vs+
    const vNode2 = result.voltages[1]; // anode
    const current = Math.abs((vNode1 - vNode2) / 1000);
    expect(current).toBeLessThan(1e-12);
  });

  // ---------------------------------------------------------------------------
  // Non-convergence reporting
  // ---------------------------------------------------------------------------

  it("reports_non_convergence", () => {
    const { solver, diagnostics, elements, matrixSize } = makeDiodeCircuit(5.0);

    const result = newtonRaphson({
      solver,
      elements,
      matrixSize,
      maxIterations: 2,
      reltol: 1e-3,
      abstol: 1e-6,
      diagnostics,
    });

    expect(result.converged).toBe(false);
    expect(result.iterations).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // ConvergenceTrace population
  // ---------------------------------------------------------------------------

  it("convergence_trace_populated", () => {
    const { solver, diagnostics, elements, matrixSize } = makeDiodeCircuit(5.0);

    const result = newtonRaphson({
      solver,
      elements,
      matrixSize,
      maxIterations: 100,
      reltol: 1e-3,
      abstol: 1e-6,
      diagnostics,
    });

    expect(result.converged).toBe(true);
    // One trace entry per iteration
    expect(result.trace.length).toBe(result.iterations);
    // Each trace has a valid largestChangeNode (>= 0)
    for (const entry of result.trace) {
      expect(entry.largestChangeNode).toBeGreaterThanOrEqual(0);
      expect(entry.iteration).toBeGreaterThanOrEqual(0);
    }
  });

  // ---------------------------------------------------------------------------
  // Initial guess reduces iteration count
  // ---------------------------------------------------------------------------

  it("initial_guess_used", () => {
    const { solver: solver1, diagnostics: diag1, elements: elem1, matrixSize } =
      makeDiodeCircuit(5.0);

    // Solve without initial guess
    const resultNoGuess = newtonRaphson({
      solver: solver1,
      elements: elem1,
      matrixSize,
      maxIterations: 100,
      reltol: 1e-3,
      abstol: 1e-6,
      diagnostics: diag1,
    });

    const { solver: solver2, diagnostics: diag2, elements: elem2 } = makeDiodeCircuit(5.0);

    // Solve with initial guess close to the solution
    const guess = new Float64Array(matrixSize);
    guess[0] = -5.0;  // Vs+ node (node 1, index 0) — set by voltage source
    guess[1] = 0.68;  // diode anode (node 2, index 1) — near expected Vd
    guess[2] = 0.0043; // branch current (index 2)

    const resultWithGuess = newtonRaphson({
      solver: solver2,
      elements: elem2,
      matrixSize,
      maxIterations: 100,
      reltol: 1e-3,
      abstol: 1e-6,
      initialGuess: guess,
      diagnostics: diag2,
    });

    expect(resultWithGuess.converged).toBe(true);
    expect(resultNoGuess.converged).toBe(true);
    // A good initial guess should converge in fewer or equal iterations
    expect(resultWithGuess.iterations).toBeLessThanOrEqual(resultNoGuess.iterations);
  });
});
