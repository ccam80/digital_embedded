/**
 * Tests for the Newton-Raphson iteration loop, voltage limiting functions,
 * and the makeDiode test element.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SparseSolver } from "../sparse-solver.js";
import { DiagnosticCollector } from "../diagnostics.js";
import { newtonRaphson, pnjlim, fetlim, applyNodesetsAndICs } from "../newton-raphson.js";
import { CKTCircuitContext } from "../ckt-context.js";
import { makeResistor, makeVoltageSource, makeDiode, allocateStatePool } from "./test-helpers.js";
import { StatePool } from "../state-pool.js";
import { DEFAULT_SIMULATION_PARAMS } from "../../../core/analog-engine-interface.js";

// ---------------------------------------------------------------------------
// Helpers — build CKTCircuitContext for test circuits
// ---------------------------------------------------------------------------

const noopBreakpoint = (_t: number): void => {};

/**
 * Build a CKTCircuitContext for the diode+resistor+voltage-source circuit.
 *
 * Topology:
 *   Node 0 = ground
 *   Node 1 = anode (Vs positive terminal)
 *   Node 2 = junction between resistor and diode cathode
 *   Branch row 2 = voltage source branch
 *
 * Circuit: Vs source → 1kΩ resistor → diode → ground
 *   matrixSize = 3 (2 nodes + 1 branch)
 */
function makeDiodeCtx(sourceVoltage: number): CKTCircuitContext {
  const vs = makeVoltageSource(1, 0, 2, sourceVoltage);
  const r = makeResistor(1, 2, 1000);
  const d = makeDiode(2, 0, 1e-14, 1);
  const elements = [vs, r, d];
  const pool = allocateStatePool(elements);

  const circuit = {
    nodeCount: 2,
    branchCount: 1,
    matrixSize: 3,
    elements,
    statePool: pool,
  };

  const ctx = new CKTCircuitContext(circuit, DEFAULT_SIMULATION_PARAMS, noopBreakpoint);
  ctx.diagnostics = new DiagnosticCollector();
  return ctx;
}

/**
 * Build a CKTCircuitContext for a resistor divider (linear circuit).
 *
 * Circuit: Vs=5V → R1=1kΩ → node2 → R2=1kΩ → ground
 *   matrixSize = 3 (2 nodes + 1 branch)
 */
function makeResistorDividerCtx(voltage: number): CKTCircuitContext {
  const vs = makeVoltageSource(1, 0, 2, voltage);
  const r1 = makeResistor(1, 2, 1000);
  const r2 = makeResistor(2, 0, 1000);
  const elements = [vs, r1, r2];

  const circuit = {
    nodeCount: 2,
    branchCount: 1,
    matrixSize: 3,
    elements,
    statePool: null,
  };

  const ctx = new CKTCircuitContext(circuit, DEFAULT_SIMULATION_PARAMS, noopBreakpoint);
  ctx.diagnostics = new DiagnosticCollector();
  return ctx;
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
    // |0.65 - 0.60| = 0.05, 2*vt = 0.052, so 0.05 <= 0.052 → no limiting
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
  // Linear circuit: should converge in exactly 2 iterations
  // ---------------------------------------------------------------------------

  it("linear_converges_in_two_iterations", () => {
    // Resistor divider: 5V source, R1=1kΩ, R2=1kΩ → midpoint = 2.5V
    // Per ngspice NIiter: iteration 0 forces noncon=1. Iteration 1 confirms convergence.
    const ctx = makeResistorDividerCtx(5.0);

    newtonRaphson(ctx);

    expect(ctx.nrResult.converged).toBe(true);
    expect(ctx.nrResult.iterations).toBe(2);
    // Node 2 (index 1 in 0-based solver) = midpoint voltage ~2.5V
    expect(ctx.nrResult.voltages[1]).toBeCloseTo(2.5, 4);
  });

  // ---------------------------------------------------------------------------
  // New spec test: writes_into_ctx_nrResult
  // ---------------------------------------------------------------------------

  it("writes_into_ctx_nrResult", () => {
    // Call newtonRaphson(ctx) on a simple resistive circuit.
    // Assert ctx.nrResult.converged, ctx.nrResult.iterations, and ctx.nrResult.voltages.
    const ctx = makeResistorDividerCtx(5.0);

    newtonRaphson(ctx);

    expect(ctx.nrResult.converged).toBe(true);
    expect(ctx.nrResult.iterations).toBeGreaterThan(0);
    // nrResult.voltages points into ctx.rhs — must be a valid buffer
    expect(ctx.nrResult.voltages).toBeInstanceOf(Float64Array);
    expect(ctx.nrResult.voltages.length).toBe(3);
    // Midpoint node (index 1) = 2.5V for a symmetric divider at 5V
    expect(ctx.nrResult.voltages[1]).toBeCloseTo(2.5, 4);
  });

  // ---------------------------------------------------------------------------
  // New spec test: zero_allocations_in_nr_loop
  // ---------------------------------------------------------------------------

  it("zero_allocations_in_nr_loop", () => {
    // Use monkey-patch pattern to count Float64Array allocations.
    // Run NR on a nonlinear (diode) circuit. After the first NR call completes,
    // reset the counter and run again. Assert zero allocations on the second call.
    const RealF64 = globalThis.Float64Array;
    let allocCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).Float64Array = new Proxy(RealF64, {
      construct(target, args) {
        allocCount++;
        return new target(...(args as [number]));
      },
    });

    try {
      const ctx = makeDiodeCtx(5.0);
      // First call: warm up (allocations during ctx construction don't count here)
      allocCount = 0;
      newtonRaphson(ctx);
      allocCount = 0;

      // Reset ctx state for second call
      ctx.rhs.fill(0);
      ctx.rhsOld.fill(0);
      ctx.nrResult.reset();
      ctx.initialGuess = null;

      newtonRaphson(ctx);

      // No Float64Array allocations during the second NR call
      expect(allocCount).toBe(0);
      expect(ctx.nrResult.converged).toBe(true);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).Float64Array = RealF64;
    }
  });

  // ---------------------------------------------------------------------------
  // Diode forward bias
  // ---------------------------------------------------------------------------

  it("diode_circuit_converges", () => {
    const ctx = makeDiodeCtx(5.0);

    newtonRaphson(ctx);

    expect(ctx.nrResult.converged).toBe(true);
    expect(ctx.nrResult.iterations).toBeLessThan(20);

    // Node 2 = diode anode voltage (= forward voltage drop since cathode is grounded)
    // For Is=1e-14, n=1, Id≈4.3mA → Vd ≈ 0.026*ln(4.3e-3/1e-14) = ~0.68V
    const vd = ctx.nrResult.voltages[1]; // node 2, 0-based index 1
    expect(vd).toBeGreaterThan(0.6);
    expect(vd).toBeLessThan(0.75);
  });

  // ---------------------------------------------------------------------------
  // Diode reverse bias
  // ---------------------------------------------------------------------------

  it("diode_reverse_bias", () => {
    const ctx = makeDiodeCtx(-5.0);

    newtonRaphson(ctx);

    expect(ctx.nrResult.converged).toBe(true);

    // In reverse bias: anode voltage ≈ -5V (clamped by Is ≈ -1e-14 A)
    const vNode1 = ctx.nrResult.voltages[0]; // Vs+
    const vNode2 = ctx.nrResult.voltages[1]; // anode
    const current = Math.abs((vNode1 - vNode2) / 1000);
    expect(current).toBeLessThan(1e-11);
  });

  // ---------------------------------------------------------------------------
  // Blame scalars on nrResult
  // ---------------------------------------------------------------------------

  it("blame_scalars_populated", () => {
    const ctx = makeDiodeCtx(5.0);
    ctx.enableBlameTracking = true;

    newtonRaphson(ctx);

    expect(ctx.nrResult.converged).toBe(true);
    // largestChangeNode is a valid node index (>= 0) after a nonlinear solve
    expect(ctx.nrResult.largestChangeNode).toBeGreaterThanOrEqual(0);
    // largestChangeElement is a valid element index (>= 0) for a circuit with nonlinear elements
    expect(ctx.nrResult.largestChangeElement).toBeGreaterThanOrEqual(0);
  });

  // ---------------------------------------------------------------------------
  // Initial guess reduces iteration count
  // ---------------------------------------------------------------------------

  it("initial_guess_used", () => {
    // Solve without initial guess
    const ctx1 = makeDiodeCtx(5.0);
    newtonRaphson(ctx1);
    const itersNoGuess = ctx1.nrResult.iterations;

    // Solve with initial guess close to the solution
    const ctx2 = makeDiodeCtx(5.0);
    const guess = new Float64Array(3);
    guess[0] = -5.0;   // Vs+ node (node 1, index 0) — set by voltage source
    guess[1] = 0.68;   // diode anode (node 2, index 1) — near expected Vd
    guess[2] = 0.0043; // branch current (index 2)
    ctx2.initialGuess = guess;

    newtonRaphson(ctx2);

    expect(ctx2.nrResult.converged).toBe(true);
    expect(ctx1.nrResult.converged).toBe(true);
    // A good initial guess should converge in fewer or equal iterations
    expect(ctx2.nrResult.iterations).toBeLessThanOrEqual(itersNoGuess);
  });

  // ---------------------------------------------------------------------------
  // Wave 2: forced 2-iteration minimum for nonlinear circuits
  // ---------------------------------------------------------------------------

  it("nonlinear_circuit_runs_at_least_2_iterations_with_state_pool", () => {
    const ctx = makeDiodeCtx(5.0);
    ctx.statePool!.initMode = "initTran";

    newtonRaphson(ctx);

    expect(ctx.nrResult.converged).toBe(true);
    expect(ctx.nrResult.iterations).toBeGreaterThanOrEqual(2);
  });

  it("nonlinear_circuit_forced_noncon_on_iteration_0", () => {
    // Even when NR would otherwise converge in iteration 0 (hypothetically),
    // Change 6 ensures assembler.noncon is forced to 1 after iteration 0,
    // preventing early return. Verify by checking iteration count >= 2.
    const ctx = makeDiodeCtx(5.0);

    newtonRaphson(ctx);

    expect(ctx.nrResult.converged).toBe(true);
    expect(ctx.nrResult.iterations).toBeGreaterThanOrEqual(2);
  });

  // ---------------------------------------------------------------------------
  // Wave 2: convergence gate — initTran blocks convergence until initFloat
  // ---------------------------------------------------------------------------

  it("initTran_transitions_to_initFloat_after_iteration_0", () => {
    const ctx = makeDiodeCtx(5.0);
    ctx.statePool!.initMode = "initTran";

    newtonRaphson(ctx);

    expect(ctx.nrResult.converged).toBe(true);
    // After NR completes, initMode must be "initFloat"
    expect(ctx.statePool!.initMode).toBe("initFloat");
  });

  it("initPred_transitions_to_initFloat_immediately", () => {
    const ctx = makeDiodeCtx(5.0);
    ctx.statePool!.initMode = "initPred";

    newtonRaphson(ctx);

    expect(ctx.nrResult.converged).toBe(true);
    expect(ctx.statePool!.initMode).toBe("initFloat");
  });

  it("transient_mode_allows_convergence_without_ladder", () => {
    const ctx = makeDiodeCtx(5.0);
    ctx.statePool!.initMode = "transient";

    newtonRaphson(ctx);

    expect(ctx.nrResult.converged).toBe(true);
    // "transient" mode stays unchanged (no automaton fires for it)
    expect(ctx.statePool!.initMode).toBe("transient");
  });

  it("no_pool_allows_convergence", () => {
    const ctx = makeResistorDividerCtx(5.0);

    newtonRaphson(ctx);

    expect(ctx.nrResult.converged).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Wave 7.1: UIC bypass — single CKTload, no NR iteration
  // ---------------------------------------------------------------------------

  it("uic_bypass_returns_converged_with_zero_iterations", () => {
    // When isDcOp=true and statePool.uic=true, NR must skip all iteration and
    // return { converged: true, iterations: 0 } after a single CKTload.
    const ctx = makeDiodeCtx(5.0);
    // Replace statePool with one that has uic=true
    (ctx.statePool as unknown as { uic: boolean }).uic = true;
    ctx.isDcOp = true;

    newtonRaphson(ctx);

    expect(ctx.nrResult.converged).toBe(true);
    expect(ctx.nrResult.iterations).toBe(0);
  });

  it("uic_bypass_not_triggered_without_isDcOp", () => {
    // When isDcOp is not set (transient path), statePool.uic must not trigger the bypass.
    const ctx = makeDiodeCtx(5.0);
    (ctx.statePool as unknown as { uic: boolean }).uic = true;
    ctx.isDcOp = false;

    newtonRaphson(ctx);

    // The UIC bypass would return { converged: true, iterations: 0 }.
    // Without isDcOp=true that path is skipped, so iterations must not be 0
    // with converged=true simultaneously.
    expect(ctx.nrResult.converged === true && ctx.nrResult.iterations === 0).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Wave 7.2: applyNodesetsAndICs — 1e10 conductance enforcement
  // ---------------------------------------------------------------------------

  it("applyNodesetsAndICs_stamps_nodeset_in_initJct_mode", () => {
    const G_NODESET = 1e10;
    const solver = new SparseSolver();
    solver.beginAssembly(3);
    const nodesets = new Map([[1, 2.5]]);
    const ics = new Map<number, number>();
    applyNodesetsAndICs(solver, nodesets, ics, 1.0, "initJct");
    expect(solver.elementCount).toBe(1);
    const rhs = solver.getRhsSnapshot();
    expect(rhs[1]).toBeCloseTo(G_NODESET * 2.5, 0);
  });

  it("applyNodesetsAndICs_stamps_nodeset_in_initFix_mode", () => {
    const G_NODESET = 1e10;
    const solver = new SparseSolver();
    solver.beginAssembly(3);
    const nodesets = new Map([[2, 1.0]]);
    const ics = new Map<number, number>();
    applyNodesetsAndICs(solver, nodesets, ics, 1.0, "initFix");
    expect(solver.elementCount).toBe(1);
    const rhs = solver.getRhsSnapshot();
    expect(rhs[2]).toBeCloseTo(G_NODESET * 1.0, 0);
  });

  it("applyNodesetsAndICs_skips_nodesets_in_initFloat_mode", () => {
    const solver = new SparseSolver();
    solver.beginAssembly(3);
    const nodesets = new Map([[1, 2.5]]);
    const ics = new Map<number, number>();
    applyNodesetsAndICs(solver, nodesets, ics, 1.0, "initFloat");
    expect(solver.elementCount).toBe(0);
    const rhs = solver.getRhsSnapshot();
    expect(rhs[1]).toBe(0);
  });

  it("applyNodesetsAndICs_always_stamps_ics_regardless_of_mode", () => {
    const G_NODESET = 1e10;
    const solver = new SparseSolver();
    solver.beginAssembly(3);
    const nodesets = new Map<number, number>();
    const ics = new Map([[1, 1.5]]);
    applyNodesetsAndICs(solver, nodesets, ics, 1.0, "initFloat");
    expect(solver.elementCount).toBe(1);
    const rhs = solver.getRhsSnapshot();
    expect(rhs[1]).toBeCloseTo(G_NODESET * 1.5, 0);
  });

  it("applyNodesetsAndICs_scales_by_srcFact", () => {
    const G_NODESET = 1e10;
    const solver = new SparseSolver();
    solver.beginAssembly(3);
    const nodesets = new Map([[1, 2.0]]);
    const ics = new Map([[2, 1.0]]);
    applyNodesetsAndICs(solver, nodesets, ics, 0.5, "initJct");
    expect(solver.elementCount).toBe(2);
    const rhs = solver.getRhsSnapshot();
    expect(rhs[1]).toBeCloseTo(G_NODESET * 2.0 * 0.5, 0);
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
    const diagnostics = new DiagnosticCollector();

    let forceReorderCalled = false;
    let factorCallCount = 0;

    const realSolver = new SparseSolver();

    const proxySolver = new Proxy(realSolver, {
      get(target, prop) {
        if (prop === "factor") {
          return () => {
            factorCallCount++;
            if (factorCallCount === 1) {
              return { success: false };
            }
            return (target as SparseSolver).factor();
          };
        }
        if (prop === "lastFactorUsedReorder") {
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
    const pool = allocateStatePool(elements);

    const circuit = { nodeCount: 2, branchCount: 1, matrixSize: 3, elements, statePool: pool };
    const ctx = new CKTCircuitContext(circuit, DEFAULT_SIMULATION_PARAMS, noopBreakpoint);
    ctx.diagnostics = diagnostics;
    ctx.solver = proxySolver;

    newtonRaphson(ctx);

    expect(forceReorderCalled).toBe(true);
    expect(ctx.nrResult.converged).toBe(true);
  });

  it("nr_emits_singular_diagnostic_when_reorder_also_fails", () => {
    // When factor() always fails and lastFactorUsedReorder is true (reorder path),
    // NR must emit a singular-matrix diagnostic and return converged=false.
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
          return true;
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
    const pool = allocateStatePool(elements);

    const circuit = { nodeCount: 2, branchCount: 1, matrixSize: 3, elements, statePool: pool };
    const ctx = new CKTCircuitContext(circuit, DEFAULT_SIMULATION_PARAMS, noopBreakpoint);
    ctx.diagnostics = diagnostics;
    ctx.solver = proxySolver;

    newtonRaphson(ctx);

    expect(ctx.nrResult.converged).toBe(false);
    const diags = diagnostics.getDiagnostics();
    expect(diags.some(d => d.code === "singular-matrix")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Wave 0.3.1: forceReorder at ngspice-matching points
// ---------------------------------------------------------------------------

describe("NR NISHOULDREORDER lifecycle", () => {
  it("forceReorder_called_on_initJct_to_initFix", () => {
    // Run NR with dcopModeLadder starting in initJct mode.
    // The STEP J initJct branch calls forceReorder() after transitioning to initFix.
    const vs = makeVoltageSource(1, 0, 2, 5.0);
    const r = makeResistor(1, 2, 1000);
    const d = makeDiode(2, 0, 1e-14, 1);
    const elements = [vs, r, d];
    const pool = allocateStatePool(elements);

    const circuit = { nodeCount: 2, branchCount: 1, matrixSize: 3, elements, statePool: pool };
    const ctx = new CKTCircuitContext(circuit, DEFAULT_SIMULATION_PARAMS, noopBreakpoint);
    ctx.diagnostics = new DiagnosticCollector();

    let forceReorderCalled = false;
    const realSolver = ctx.solver;
    const pool2 = { initMode: "initJct" as "initJct" | "initFix" | "initFloat" | "initTran" | "initPred" | "initSmsig" | "transient" };

    const proxySolver = new Proxy(realSolver, {
      get(target, prop) {
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

    ctx.solver = proxySolver;
    ctx.dcopModeLadder = {
      runPrimeJunctions(): void {},
      pool: pool2,
      onModeBegin(_phase: "dcopInitJct" | "dcopInitFix" | "dcopInitFloat", _iter: number): void {},
      onModeEnd(_phase: "dcopInitJct" | "dcopInitFix" | "dcopInitFloat", _iter: number, _converged: boolean): void {},
    };

    newtonRaphson(ctx);

    expect(forceReorderCalled).toBe(true);
    expect(pool2.initMode).not.toBe("initJct");
  });

  it("forceReorder_called_on_initTran_first_iteration", () => {
    // Run NR with statePool.initMode = "initTran". On iteration 0, the STEP J
    // initTran branch calls forceReorder() when iteration <= 0.
    const vs = makeVoltageSource(1, 0, 2, 5.0);
    const r = makeResistor(1, 2, 1000);
    const d = makeDiode(2, 0, 1e-14, 1);
    const elements = [vs, r, d];
    const pool = allocateStatePool(elements);

    const circuit = { nodeCount: 2, branchCount: 1, matrixSize: 3, elements, statePool: pool };
    const ctx = new CKTCircuitContext(circuit, DEFAULT_SIMULATION_PARAMS, noopBreakpoint);
    ctx.diagnostics = new DiagnosticCollector();
    ctx.statePool!.initMode = "initTran";

    let forceReorderCallCount = 0;
    const realSolver = ctx.solver;

    const proxySolver = new Proxy(realSolver, {
      get(target, prop) {
        if (prop === "forceReorder") {
          return () => {
            forceReorderCallCount++;
            return (target as SparseSolver).forceReorder();
          };
        }
        const val = (target as unknown as Record<string | symbol, unknown>)[prop];
        if (typeof val === "function") return val.bind(target);
        return val;
      },
    }) as SparseSolver;

    ctx.solver = proxySolver;

    newtonRaphson(ctx);

    expect(forceReorderCallCount).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Wave 0.3.2: E_SINGULAR recovery re-loads then re-factors
// ---------------------------------------------------------------------------

describe("NR E_SINGULAR recovery via continue", () => {
  it("e_singular_recovers_via_continue", () => {
    // The E_SINGULAR recovery path must: call forceReorder(), then continue to
    // the top of the NR loop to re-execute CKTload (stampAll) before re-factoring.
    const diagnostics = new DiagnosticCollector();

    let forceReorderCalledAfterFailure = false;
    let factorCallCount = 0;
    let beginAssemblyAfterFailure = 0;
    let singularIterationSeen = false;

    const vs = makeVoltageSource(1, 0, 2, 5.0);
    const r = makeResistor(1, 2, 1000);
    const d = makeDiode(2, 0, 1e-14, 1);
    const elements = [vs, r, d];
    const pool = allocateStatePool(elements);

    const circuit = { nodeCount: 2, branchCount: 1, matrixSize: 3, elements, statePool: pool };
    const ctx = new CKTCircuitContext(circuit, DEFAULT_SIMULATION_PARAMS, noopBreakpoint);
    ctx.diagnostics = diagnostics;

    const realSolver = ctx.solver;

    const proxySolver = new Proxy(realSolver, {
      get(target, prop) {
        if (prop === "factor") {
          return () => {
            factorCallCount++;
            if (factorCallCount === 2) {
              singularIterationSeen = true;
              return { success: false };
            }
            return (target as SparseSolver).factor();
          };
        }
        if (prop === "lastFactorUsedReorder") {
          return factorCallCount === 2 ? false : (target as SparseSolver).lastFactorUsedReorder;
        }
        if (prop === "forceReorder") {
          return () => {
            if (singularIterationSeen) forceReorderCalledAfterFailure = true;
            return (target as SparseSolver).forceReorder();
          };
        }
        if (prop === "beginAssembly") {
          return (...args: unknown[]) => {
            if (singularIterationSeen) beginAssemblyAfterFailure++;
            return (target as SparseSolver).beginAssembly(...(args as [number]));
          };
        }
        const val = (target as unknown as Record<string | symbol, unknown>)[prop];
        if (typeof val === "function") return val.bind(target);
        return val;
      },
    }) as SparseSolver;

    ctx.solver = proxySolver;

    newtonRaphson(ctx);

    expect(ctx.nrResult.converged).toBe(true);
    expect(singularIterationSeen).toBe(true);
    expect(forceReorderCalledAfterFailure).toBe(true);
    expect(beginAssemblyAfterFailure).toBeGreaterThan(0);
  });

  it("e_singular_recovery_reloads_and_refactors", () => {
    const diagnostics = new DiagnosticCollector();

    let forceReorderCalled = false;
    let factorCallCount = 0;
    let beginAssemblyAfterFailure = 0;
    let singularSeen = false;

    const vs = makeVoltageSource(1, 0, 2, 5.0);
    const r = makeResistor(1, 2, 1000);
    const d = makeDiode(2, 0, 1e-14, 1);
    const elements = [vs, r, d];
    const pool = allocateStatePool(elements);

    const circuit = { nodeCount: 2, branchCount: 1, matrixSize: 3, elements, statePool: pool };
    const ctx = new CKTCircuitContext(circuit, DEFAULT_SIMULATION_PARAMS, noopBreakpoint);
    ctx.diagnostics = diagnostics;

    const realSolver = ctx.solver;

    const proxySolver = new Proxy(realSolver, {
      get(target, prop) {
        if (prop === "factor") {
          return () => {
            factorCallCount++;
            if (factorCallCount === 2) {
              singularSeen = true;
              return { success: false };
            }
            return (target as SparseSolver).factor();
          };
        }
        if (prop === "lastFactorUsedReorder") {
          return factorCallCount === 2 ? false : (target as SparseSolver).lastFactorUsedReorder;
        }
        if (prop === "forceReorder") {
          return () => {
            forceReorderCalled = true;
            return (target as SparseSolver).forceReorder();
          };
        }
        if (prop === "beginAssembly") {
          return (...args: unknown[]) => {
            if (singularSeen) beginAssemblyAfterFailure++;
            return (target as SparseSolver).beginAssembly(...(args as [number]));
          };
        }
        const val = (target as unknown as Record<string | symbol, unknown>)[prop];
        if (typeof val === "function") return val.bind(target);
        return val;
      },
    }) as SparseSolver;

    ctx.solver = proxySolver;

    newtonRaphson(ctx);

    expect(ctx.nrResult.converged).toBe(true);
    expect(forceReorderCalled).toBe(true);
    expect(beginAssemblyAfterFailure).toBeGreaterThan(0);
  });
});
