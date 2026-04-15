/**
 * Tests for the Newton-Raphson iteration loop, voltage limiting functions,
 * and the makeDiode test element.
 */

import { describe, it, expect } from "vitest";
import { SparseSolver } from "../sparse-solver.js";
import { DiagnosticCollector } from "../diagnostics.js";
import { newtonRaphson, pnjlim, fetlim, applyNodesetsAndICs } from "../newton-raphson.js";
import { makeResistor, makeVoltageSource, makeDiode, allocateStatePool } from "./test-helpers.js";
import { StatePool } from "../state-pool.js";

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
  const elements = [vs, r, d];
  allocateStatePool(elements);

  return { solver, diagnostics, elements, matrixSize: 3 };
}

// ---------------------------------------------------------------------------
// pnjlim tests
// ---------------------------------------------------------------------------

describe("NR", () => {
  it("pnjlim_clamps_large_step", () => {
    // Large forward step: 0.5V → 100V — should be compressed logarithmically
    const result = pnjlim(100, 0.5, 0.026, 0.6);
    // Must be dramatically less than 100 (logarithmic compression)
    expect(result.value).toBeLessThan(10);
    // Must still be greater than vold (forward biased)
    expect(result.value).toBeGreaterThan(0.5);
    expect(result.limited).toBe(true);
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
    expect(result.value).toBeCloseTo(0.65, 10);
    expect(result.limited).toBe(false);
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
      iabstol: 1e-12,
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
      iabstol: 1e-12,
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
      iabstol: 1e-12,
      diagnostics,
    });

    expect(result.converged).toBe(true);

    // In reverse bias: anode voltage ≈ -5V (clamped by Is ≈ -1e-14 A)
    // Current through resistor = (Vs_node - anode_node)/R ≈ tiny leakage
    // Node 1 (index 0) = Vs+ = -5V (forced by voltage source)
    // Node 2 (index 1) = diode anode ≈ -5V (tiny reverse current)
    // Current = (node1_v - node2_v) / 1000 should be negligible (< 1e-11 A)
    const vNode1 = result.voltages[0]; // Vs+
    const vNode2 = result.voltages[1]; // anode
    const current = Math.abs((vNode1 - vNode2) / 1000);
    expect(current).toBeLessThan(1e-11);
  });

  // ---------------------------------------------------------------------------
  // Blame scalars on NRResult
  // ---------------------------------------------------------------------------

  it("blame_scalars_populated", () => {
    const { solver, diagnostics, elements, matrixSize } = makeDiodeCircuit(5.0);

    const result = newtonRaphson({
      solver,
      elements,
      matrixSize,
      maxIterations: 100,
      reltol: 1e-3,
      abstol: 1e-6,
      iabstol: 1e-12,
      diagnostics,
      enableBlameTracking: true,
    });

    expect(result.converged).toBe(true);
    // largestChangeNode is a valid node index (>= 0) after a nonlinear solve
    expect(result.largestChangeNode).toBeGreaterThanOrEqual(0);
    // largestChangeElement is a valid element index (>= 0) for a circuit with nonlinear elements
    expect(result.largestChangeElement).toBeGreaterThanOrEqual(0);
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
      iabstol: 1e-12,
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
      iabstol: 1e-12,
      initialGuess: guess,
      diagnostics: diag2,
    });

    expect(resultWithGuess.converged).toBe(true);
    expect(resultNoGuess.converged).toBe(true);
    // A good initial guess should converge in fewer or equal iterations
    expect(resultWithGuess.iterations).toBeLessThanOrEqual(resultNoGuess.iterations);
  });

  // ---------------------------------------------------------------------------
  // Wave 2: forced 2-iteration minimum for nonlinear circuits
  // ---------------------------------------------------------------------------

  it("nonlinear_circuit_runs_at_least_2_iterations_with_state_pool", () => {
    // A diode+resistor circuit with a statePool in initTran mode must run at
    // least 2 NR iterations (Change 6: iteration===0 forces noncon=1).
    const { solver, diagnostics, elements, matrixSize } = makeDiodeCircuit(5.0);
    const pool = new StatePool(0);
    pool.initMode = "initTran";

    const result = newtonRaphson({
      solver,
      elements,
      matrixSize,
      maxIterations: 100,
      reltol: 1e-3,
      abstol: 1e-6,
      iabstol: 1e-12,
      diagnostics,
      statePool: pool,
    });

    expect(result.converged).toBe(true);
    expect(result.iterations).toBeGreaterThanOrEqual(2);
  });

  it("nonlinear_circuit_forced_noncon_on_iteration_0", () => {
    // Even when NR would otherwise converge in iteration 0 (hypothetically),
    // Change 6 ensures assembler.noncon is forced to 1 after iteration 0,
    // preventing early return. Verify by checking iteration count >= 2.
    const { solver, diagnostics, elements, matrixSize } = makeDiodeCircuit(5.0);

    // No statePool: Change 6 still applies (forced noncon=1 at iteration===0)
    const result = newtonRaphson({
      solver,
      elements,
      matrixSize,
      maxIterations: 100,
      reltol: 1e-3,
      abstol: 1e-6,
      iabstol: 1e-12,
      diagnostics,
    });

    expect(result.converged).toBe(true);
    expect(result.iterations).toBeGreaterThanOrEqual(2);
  });

  // ---------------------------------------------------------------------------
  // Wave 2: convergence gate — initTran blocks convergence until initFloat
  // ---------------------------------------------------------------------------

  it("initTran_transitions_to_initFloat_after_iteration_0", () => {
    // With statePool.initMode = "initTran", the mode automaton must transition
    // to "initFloat" after iteration 0 completes. NR must then converge.
    const { solver, diagnostics, elements, matrixSize } = makeDiodeCircuit(5.0);
    const pool = new StatePool(0);
    pool.initMode = "initTran";

    const result = newtonRaphson({
      solver,
      elements,
      matrixSize,
      maxIterations: 100,
      reltol: 1e-3,
      abstol: 1e-6,
      iabstol: 1e-12,
      diagnostics,
      statePool: pool,
    });

    expect(result.converged).toBe(true);
    // After NR completes, initMode must be "initFloat"
    expect(pool.initMode).toBe("initFloat");
  });

  it("initPred_transitions_to_initFloat_immediately", () => {
    // With statePool.initMode = "initPred", the automaton transitions to
    // "initFloat" after the first updateOperatingPoints call (iteration 0).
    const { solver, diagnostics, elements, matrixSize } = makeDiodeCircuit(5.0);
    const pool = new StatePool(0);
    pool.initMode = "initPred";

    const result = newtonRaphson({
      solver,
      elements,
      matrixSize,
      maxIterations: 100,
      reltol: 1e-3,
      abstol: 1e-6,
      iabstol: 1e-12,
      diagnostics,
      statePool: pool,
    });

    expect(result.converged).toBe(true);
    expect(pool.initMode).toBe("initFloat");
  });

  it("transient_mode_allows_convergence_without_ladder", () => {
    // With statePool.initMode = "transient" and no ladder, the canConverge
    // gate must allow convergence (initMode === "transient" is a valid terminal).
    const { solver, diagnostics, elements, matrixSize } = makeDiodeCircuit(5.0);
    const pool = new StatePool(0);
    pool.initMode = "transient";

    const result = newtonRaphson({
      solver,
      elements,
      matrixSize,
      maxIterations: 100,
      reltol: 1e-3,
      abstol: 1e-6,
      iabstol: 1e-12,
      diagnostics,
      statePool: pool,
    });

    expect(result.converged).toBe(true);
    // "transient" mode stays unchanged (no automaton fires for it)
    expect(pool.initMode).toBe("transient");
  });

  it("no_pool_allows_convergence", () => {
    // Without any statePool, canConverge must be true.
    const { solver, diagnostics, elements, matrixSize } = makeDiodeCircuit(5.0);

    const result = newtonRaphson({
      solver,
      elements,
      matrixSize,
      maxIterations: 100,
      reltol: 1e-3,
      abstol: 1e-6,
      iabstol: 1e-12,
      diagnostics,
    });

    expect(result.converged).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Wave 7.1: UIC bypass — single CKTload, no NR iteration
  // ---------------------------------------------------------------------------

  it("uic_bypass_returns_converged_with_zero_iterations", () => {
    // When isDcOp=true and statePool.uic=true, NR must skip all iteration and
    // return { converged: true, iterations: 0 } after a single CKTload.
    const { solver, diagnostics, elements, matrixSize } = makeDiodeCircuit(5.0);
    const statePool = { state0: new Float64Array(0), uic: true };

    const result = newtonRaphson({
      solver,
      elements,
      matrixSize,
      maxIterations: 100,
      reltol: 1e-3,
      abstol: 1e-6,
      iabstol: 1e-12,
      diagnostics,
      isDcOp: true,
      statePool,
    });

    expect(result.converged).toBe(true);
    expect(result.iterations).toBe(0);
  });

  it("uic_bypass_not_triggered_without_isDcOp", () => {
    // When isDcOp is not set (transient path), statePool.uic must not trigger the bypass.
    // The UIC bypass signature is { converged: true, iterations: 0 }. Verify that
    // combination does NOT appear — the NR loop must enter the iteration path.
    const { solver, diagnostics, elements, matrixSize } = makeDiodeCircuit(5.0);
    const statePool = { state0: new Float64Array(0), uic: true };

    const result = newtonRaphson({
      solver,
      elements,
      matrixSize,
      maxIterations: 100,
      reltol: 1e-3,
      abstol: 1e-6,
      iabstol: 1e-12,
      diagnostics,
      isDcOp: false,
      statePool,
    });

    // The UIC bypass would return { converged: true, iterations: 0 }.
    // Without isDcOp=true that path is skipped, so iterations must not be 0
    // with converged=true simultaneously.
    expect(result.converged === true && result.iterations === 0).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Wave 7.2: applyNodesetsAndICs — 1e10 conductance enforcement
  // ---------------------------------------------------------------------------

  it("applyNodesetsAndICs_stamps_nodeset_in_initJct_mode", () => {
    // In initJct mode, nodeset stamps must be applied to the solver.
    // Verify by checking cooCount increased and RHS received the correct value.
    const G_NODESET = 1e10;
    const solver = new SparseSolver();
    solver.beginAssembly(3);
    const nodesets = new Map([[1, 2.5]]);
    const ics = new Map<number, number>();
    applyNodesetsAndICs(solver, nodesets, ics, 1.0, "initJct");
    // One nodeset entry → one COO stamp added
    expect(solver.cooCount).toBe(1);
    // RHS at row 1 must be G_NODESET * 2.5 * 1.0
    const rhs = solver.getRhsSnapshot();
    expect(rhs[1]).toBeCloseTo(G_NODESET * 2.5, 0);
  });

  it("applyNodesetsAndICs_stamps_nodeset_in_initFix_mode", () => {
    // In initFix mode, nodeset stamps must also be applied.
    const G_NODESET = 1e10;
    const solver = new SparseSolver();
    solver.beginAssembly(3);
    const nodesets = new Map([[2, 1.0]]);
    const ics = new Map<number, number>();
    applyNodesetsAndICs(solver, nodesets, ics, 1.0, "initFix");
    // One nodeset entry → one COO stamp added
    expect(solver.cooCount).toBe(1);
    // RHS at row 2 must be G_NODESET * 1.0 * 1.0
    const rhs = solver.getRhsSnapshot();
    expect(rhs[2]).toBeCloseTo(G_NODESET * 1.0, 0);
  });

  it("applyNodesetsAndICs_skips_nodesets_in_initFloat_mode", () => {
    // In initFloat mode, nodesets must NOT be stamped (only ICs persist).
    // With no ICs either, COO count must remain 0 and RHS stays zero.
    const solver = new SparseSolver();
    solver.beginAssembly(3);
    const nodesets = new Map([[1, 2.5]]);
    const ics = new Map<number, number>();
    applyNodesetsAndICs(solver, nodesets, ics, 1.0, "initFloat");
    // initFloat skips nodesets — no stamps added
    expect(solver.cooCount).toBe(0);
    const rhs = solver.getRhsSnapshot();
    expect(rhs[1]).toBe(0);
  });

  it("applyNodesetsAndICs_always_stamps_ics_regardless_of_mode", () => {
    // ICs must be stamped in ALL modes, including initFloat.
    const G_NODESET = 1e10;
    const solver = new SparseSolver();
    solver.beginAssembly(3);
    const nodesets = new Map<number, number>();
    const ics = new Map([[1, 1.5]]);
    applyNodesetsAndICs(solver, nodesets, ics, 1.0, "initFloat");
    // IC stamp applied even in initFloat mode
    expect(solver.cooCount).toBe(1);
    const rhs = solver.getRhsSnapshot();
    expect(rhs[1]).toBeCloseTo(G_NODESET * 1.5, 0);
  });

  it("applyNodesetsAndICs_scales_by_srcFact", () => {
    // With srcFact=0.5, the RHS stamp must use G_NODESET * value * 0.5.
    const G_NODESET = 1e10;
    const solver = new SparseSolver();
    solver.beginAssembly(3);
    const nodesets = new Map([[1, 2.0]]);
    const ics = new Map([[2, 1.0]]);
    applyNodesetsAndICs(solver, nodesets, ics, 0.5, "initJct");
    // Both nodeset (node 1) and IC (node 2) get one COO stamp each
    expect(solver.cooCount).toBe(2);
    const rhs = solver.getRhsSnapshot();
    // nodeset: G_NODESET * 2.0 * 0.5 = 1e10
    expect(rhs[1]).toBeCloseTo(G_NODESET * 2.0 * 0.5, 0);
    // IC: G_NODESET * 1.0 * 0.5 = 5e9
    expect(rhs[2]).toBeCloseTo(G_NODESET * 1.0 * 0.5, 0);
  });
});

// ---------------------------------------------------------------------------
// Wave 2.1.3: singular retry — factorNumerical failure triggers forceReorder
// ---------------------------------------------------------------------------

describe("NR singular retry", () => {
  it("nr_retries_with_reorder_after_numerical_singular", () => {
    // Verify that when factor() returns { success: false } with lastFactorUsedReorder=false
    // (numerical path), the NR loop calls forceReorder() and retries factor().
    // On the second call (after forceReorder), factor() succeeds.
    const diagnostics = new DiagnosticCollector();

    let forceReorderCalled = false;
    let factorCallCount = 0;

    const realSolver = new SparseSolver();

    // Intercept factor() on the proxy: fail on the first call (numerical path),
    // then delegate to the real solver after forceReorder has been called.
    const proxySolver = new Proxy(realSolver, {
      get(target, prop) {
        if (prop === "factor") {
          return () => {
            factorCallCount++;
            if (factorCallCount === 1) {
              // First call: simulate numerical-path failure
              return { success: false };
            }
            // Subsequent calls: real solver (after forceReorder was called)
            return (target as SparseSolver).factor();
          };
        }
        if (prop === "lastFactorUsedReorder") {
          // First factor() call failed on numerical path (not reorder)
          return factorCallCount <= 1 ? false : (target as SparseSolver).lastFactorUsedReorder;
        }
        if (prop === "forceReorder") {
          return () => {
            forceReorderCalled = true;
            return (target as SparseSolver).forceReorder();
          };
        }
        const val = (target as unknown as Record<string | symbol, unknown>)[prop];
        if (typeof val === "function") return val.bind(target);
        return val;
      },
    }) as SparseSolver;

    const vs = makeVoltageSource(1, 0, 2, 5.0);
    const r = makeResistor(1, 2, 1000);
    const d = makeDiode(2, 0, 1e-14, 1);
    const elements = [vs, r, d];
    allocateStatePool(elements);

    const result = newtonRaphson({
      solver: proxySolver,
      elements,
      matrixSize: 3,
      maxIterations: 100,
      reltol: 1e-3,
      abstol: 1e-6,
      iabstol: 1e-12,
      diagnostics,
    });

    // After the numerical-path failure, the NR loop must have called forceReorder()
    // and retried. The circuit must still converge.
    expect(forceReorderCalled).toBe(true);
    expect(result.converged).toBe(true);
  });

  it("nr_emits_singular_diagnostic_when_reorder_also_fails", () => {
    // When factor() always fails and lastFactorUsedReorder is false (numerical path),
    // the retry path also fails, so NR must emit a singular-matrix diagnostic
    // and return converged=false.
    const diagnostics = new DiagnosticCollector();

    const realSolver = new SparseSolver();

    const proxySolver = new Proxy(realSolver, {
      get(target, prop) {
        if (prop === "factor") {
          return () => {
            return { success: false };
          };
        }
        if (prop === "lastFactorUsedReorder") {
          return false;
        }
        const val = (target as unknown as Record<string | symbol, unknown>)[prop];
        if (typeof val === "function") return val.bind(target);
        return val;
      },
    }) as SparseSolver;

    const vs = makeVoltageSource(1, 0, 2, 5.0);
    const r = makeResistor(1, 2, 1000);
    const d = makeDiode(2, 0, 1e-14, 1);
    const elements = [vs, r, d];
    allocateStatePool(elements);

    const result = newtonRaphson({
      solver: proxySolver,
      elements,
      matrixSize: 3,
      maxIterations: 100,
      reltol: 1e-3,
      abstol: 1e-6,
      iabstol: 1e-12,
      diagnostics,
    });

    expect(result.converged).toBe(false);
    const diags = diagnostics.getDiagnostics();
    expect(diags.some(d => d.code === "singular-matrix")).toBe(true);
  });
});
