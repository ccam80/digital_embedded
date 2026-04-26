/**
 * Tests for the Newton-Raphson iteration loop, voltage limiting functions,
 * and the makeDiode test element.
 */

import { describe, it, expect } from "vitest";
import { SparseSolver, spSINGULAR } from "../sparse-solver.js";
import { DiagnosticCollector } from "../diagnostics.js";
import { newtonRaphson, pnjlim, fetlim } from "../newton-raphson.js";
import { CKTCircuitContext } from "../ckt-context.js";
import { makeResistor, makeVoltageSource, makeDiode, allocateStatePool } from "./test-helpers.js";
import { DEFAULT_SIMULATION_PARAMS } from "../../../core/analog-engine-interface.js";
import { MODETRANOP, MODEUIC, MODEDCOP, MODEINITFLOAT, MODEINITJCT, MODETRAN, MODEINITTRAN, MODEINITPRED, setInitf, setAnalysis, initf } from "../ckt-mode.js";

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

  const ctx = new CKTCircuitContext(circuit, DEFAULT_SIMULATION_PARAMS, noopBreakpoint, new SparseSolver());
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

  const ctx = new CKTCircuitContext(circuit, DEFAULT_SIMULATION_PARAMS, noopBreakpoint, new SparseSolver());
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
    // |0.65 - 0.60| = 0.05, 2*vt = 0.052, so 0.05 <= 0.052 → no limiting.
    // When limited===false, pnjlim returns vnew unchanged — bit-identical.
    const result = pnjlim(0.65, 0.60, 0.026, 0.6);
    expect(result.value).toBe(0.65);
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

    // Deep-on zone: large enough step triggers vtsthi clamp.
    // ngspice DEVfetlim formula: vtsthi = |2*(vold-vto)|+2 = |2*(5.0-0.7)|+2
    //                            vnew = vold + vtsthi when delv > vtsthi
    const result3 = fetlim(20.0, 5.0, 0.7);
    const vtsthi3 = Math.abs(2 * (5.0 - 0.7)) + 2;
    expect(result3).toBe(5.0 + vtsthi3);
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
    ctx2.rhsOld.set(guess);

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
    ctx.cktMode = setInitf(setAnalysis(ctx.cktMode, MODETRAN), MODEINITTRAN);

    newtonRaphson(ctx);

    expect(ctx.nrResult.converged).toBe(true);
    expect(ctx.nrResult.iterations).toBeGreaterThanOrEqual(2);
  });

  it("nonlinear_circuit_forced_noncon_on_iteration_0", () => {
    // Even when NR would otherwise converge in iteration 0 (hypothetically),
    // noncon is forced to 1 after iteration 0 for nonlinear circuits,
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
    ctx.cktMode = setInitf(setAnalysis(ctx.cktMode, MODETRAN), MODEINITTRAN);

    newtonRaphson(ctx);

    expect(ctx.nrResult.converged).toBe(true);
    // After NR completes, INITF must have decayed to MODEINITFLOAT
    // (niiter.c:1070-1071 INITF dispatcher, cktdefs.h:177).
    expect(initf(ctx.cktMode)).toBe(MODEINITFLOAT);
  });

  it("initPred_transitions_to_initFloat_immediately", () => {
    const ctx = makeDiodeCtx(5.0);
    ctx.cktMode = setInitf(setAnalysis(ctx.cktMode, MODETRAN), MODEINITPRED);

    newtonRaphson(ctx);

    expect(ctx.nrResult.converged).toBe(true);
    expect(initf(ctx.cktMode)).toBe(MODEINITFLOAT);
  });

  it("transient_mode_allows_convergence_without_ladder", () => {
    const ctx = makeDiodeCtx(5.0);
    ctx.cktMode = setInitf(setAnalysis(ctx.cktMode, MODETRAN), MODEINITFLOAT);

    newtonRaphson(ctx);

    expect(ctx.nrResult.converged).toBe(true);
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
    // Gate: isTranOp(cktMode) && isUic(cktMode) — transient-boot DCOP with UIC.
    // ngspice dctran.c:117-189: single CKTload, no NR iteration.
    const ctx = makeDiodeCtx(5.0);
    // Set cktMode to MODETRANOP | MODEUIC | MODEINITJCT (transient-boot DCOP + UIC).
    ctx.cktMode = MODETRANOP | MODEUIC | MODEINITJCT;

    newtonRaphson(ctx);

    expect(ctx.nrResult.converged).toBe(true);
    expect(ctx.nrResult.iterations).toBe(0);
  });

  it("uic_bypass_not_triggered_without_tranop", () => {
    // Standalone .OP with UIC=true must NOT take the single-load exit.
    // The bypass only fires on MODETRANOP (transient-boot), not MODEDCOP.
    const ctx = makeDiodeCtx(5.0);
    ctx.cktMode = MODEDCOP | MODEINITJCT | MODEUIC;

    newtonRaphson(ctx);

    // Without MODETRANOP the UIC bypass is skipped; NR runs fully.
    // iterations must not be 0 with converged=true simultaneously.
    expect(ctx.nrResult.converged === true && ctx.nrResult.iterations === 0).toBe(false);
  });

});

// ---------------------------------------------------------------------------
// Wave 2.1: pnjlim ngspice-exact tests
// ---------------------------------------------------------------------------

describe("pnjlim ngspice-exact", () => {
  it("pnjlim_matches_ngspice_forward_bias", () => {
    // vold=0.7, vnew=1.5, vt=0.02585, vcrit=0.6
    // Condition: 1.5 > 0.6 and |1.5-0.7|=0.8 > vt+vt=0.0517 → limiting fires
    // vold=0.7 > 0: arg = 1 + (1.5-0.7)/0.02585 = 31.946...; arg > 0
    // result = 0.7 + 0.02585 * Math.log(arg)
    const vold = 0.7;
    const vnew = 1.5;
    const vt = 0.02585;
    const vcrit = 0.6;
    const arg = 1 + (vnew - vold) / vt;
    const expected = vold + vt * Math.log(arg);
    const result = pnjlim(vnew, vold, vt, vcrit);
    expect(result.value).toBe(expected);
    expect(result.limited).toBe(true);
  });

  it("pnjlim_matches_ngspice_arg_le_zero_branch", () => {
    // Construct inputs where arg = 1 + (vnew-vold)/vt <= 0
    // vold=0.5 (>0), vcrit=0.3, vt=0.02585, vnew=0.42
    // Condition: 0.42 > 0.3 ✓ and |0.42-0.5|=0.08 > 0.0517 ✓
    // arg = 1 + (0.42-0.5)/0.02585 = 1 - 3.095... < 0 → vnew = vcrit = 0.3
    const vold = 0.5;
    const vnew = 0.42;
    const vt = 0.02585;
    const vcrit = 0.3;
    const result = pnjlim(vnew, vold, vt, vcrit);
    expect(result.value).toBe(vcrit);
    expect(result.limited).toBe(true);
  });

  it("pnjlim_matches_ngspice_cold_junction_branch", () => {
    // vold=-0.1 (≤0), vnew=0.5, vt=0.02585, vcrit=0.3
    // Condition: 0.5 > 0.3 ✓ and |0.5-(-0.1)|=0.6 > 0.0517 ✓
    // vold=-0.1 ≤ 0: vnew = vt * Math.log(vnew/vt)
    const vold = -0.1;
    const vnew = 0.5;
    const vt = 0.02585;
    const vcrit = 0.3;
    const expected = vt * Math.log(vnew / vt);
    const result = pnjlim(vnew, vold, vt, vcrit);
    expect(result.value).toBe(expected);
    expect(result.limited).toBe(true);
  });

  it("pnjlim_no_limiting_when_below_vcrit", () => {
    // vnew=0.3 < vcrit=0.6: outer condition fails → no limiting, return vnew unchanged
    const vold = 0.2;
    const vnew = 0.3;
    const vt = 0.02585;
    const vcrit = 0.6;
    const result = pnjlim(vnew, vold, vt, vcrit);
    expect(result.value).toBe(vnew);
    expect(result.limited).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Wave 2.1: fetlim ngspice-exact tests
// ---------------------------------------------------------------------------

describe("fetlim ngspice-exact", () => {
  it("fetlim_matches_ngspice_deep_on", () => {
    // vold=5.0, vnew=8.0, vto=1.0
    // vtsthi = |2*(5-1)|+2 = 10, vtstlo = 10/2+2 = 7 (fixed formula)
    // vtox = 1+3.5 = 4.5; vold=5 >= vtox: deep on zone
    // delv = 3 > 0 (increasing); 3 < vtsthi=10 → no clamping → vnew=8.0 unchanged
    const result = fetlim(8.0, 5.0, 1.0);
    expect(result).toBe(8.0);
  });

  it("fetlim_matches_ngspice_off_region", () => {
    // vold=-1.0, vnew=3.0, vto=1.0
    // vtsthi = |2*(-1-1)|+2 = 6, vtstlo = 6/2+2 = 5
    // vold=-1 < vto=1: OFF zone, delv=4 > 0 (increasing)
    // vtemp = vto+0.5 = 1.5; vnew=3 > vtemp → vnew = vtemp = 1.5
    const result = fetlim(3.0, -1.0, 1.0);
    expect(result).toBe(1.5);
  });
});

// ---------------------------------------------------------------------------
// Wave 2.1.3: ipass gated by hadNodeset
// ---------------------------------------------------------------------------

describe("ipass hadNodeset gate", () => {
  it("ipass_skipped_without_nodesets", () => {
    // Circuit with no nodesets and nrModeLadder: after initFix→initFloat,
    // hadNodeset=false so ipass is never decremented — convergence fires immediately
    // when noncon===0 and tolerances pass.
    const vs = makeVoltageSource(1, 0, 2, 5.0);
    const r = makeResistor(1, 2, 1000);
    const d = makeDiode(2, 0, 1e-14, 1);
    const elements = [vs, r, d];
    const pool = allocateStatePool(elements);

    const circuit = { nodeCount: 2, branchCount: 1, matrixSize: 3, elements, statePool: pool };
    const ctx = new CKTCircuitContext(circuit, DEFAULT_SIMULATION_PARAMS, noopBreakpoint, new SparseSolver());
    ctx.diagnostics = new DiagnosticCollector();
    ctx.cktMode = MODEDCOP | MODEINITFLOAT;
    // No nodesets added — hadNodeset stays false
    expect(ctx.hadNodeset).toBe(false);

    let initFloatBeginIter = -1;
    let convergeIter = -1;

    ctx.nrModeLadder = {
      onModeBegin(phase: "dcopInitJct" | "dcopInitFix" | "dcopInitFloat", iter: number): void {
        if (phase === "dcopInitFloat") initFloatBeginIter = iter;
      },
      onModeEnd(_phase: "dcopInitJct" | "dcopInitFix" | "dcopInitFloat", iter: number, conv: boolean): void {
        if (conv) convergeIter = iter;
      },
    };

    newtonRaphson(ctx);

    expect(ctx.nrResult.converged).toBe(true);
    expect(ctx.hadNodeset).toBe(false);
    // With a primed diode junction and no nodesets, initFloat begins at a
    // converged operating point: noncon===0 on the very first initFloat
    // iteration, and without the ipass gate firing convergence must be
    // observed on that same iteration.
    expect(initFloatBeginIter).toBeGreaterThanOrEqual(0);
    expect(convergeIter).toBe(initFloatBeginIter);
  });

  it("ipass_fires_with_nodesets", () => {
    // Circuit with a nodeset: hadNodeset=true after updateHadNodeset().
    // After initFix→initFloat transition, ipass=1 is set. With hadNodeset=true,
    // the ipass decrement fires: one extra NR iteration before convergence returns.
    const vs = makeVoltageSource(1, 0, 2, 5.0);
    const r = makeResistor(1, 2, 1000);
    const d = makeDiode(2, 0, 1e-14, 1);
    const elements = [vs, r, d];
    const pool = allocateStatePool(elements);

    const circuit = { nodeCount: 2, branchCount: 1, matrixSize: 3, elements, statePool: pool };
    const ctx = new CKTCircuitContext(circuit, DEFAULT_SIMULATION_PARAMS, noopBreakpoint, new SparseSolver());
    ctx.diagnostics = new DiagnosticCollector();
    ctx.cktMode = MODEDCOP | MODEINITFLOAT;

    // Add a nodeset and update hadNodeset
    ctx.nodesets.set(1, 5.0);
    ctx.updateHadNodeset();
    expect(ctx.hadNodeset).toBe(true);

    let initFloatBeginIter = -1;
    let convergeIter = -1;

    ctx.nrModeLadder = {
      onModeBegin(phase: "dcopInitJct" | "dcopInitFix" | "dcopInitFloat", iter: number): void {
        if (phase === "dcopInitFloat") initFloatBeginIter = iter;
      },
      onModeEnd(_phase: "dcopInitJct" | "dcopInitFix" | "dcopInitFloat", iter: number, conv: boolean): void {
        if (conv) convergeIter = iter;
      },
    };

    newtonRaphson(ctx);

    expect(ctx.nrResult.converged).toBe(true);
    expect(ctx.hadNodeset).toBe(true);
    // With nodesets, ipass fires: convergeIter must be at least 1 iteration after
    // initFloat began (ipass=1 was decremented once, forcing one extra iteration)
    expect(convergeIter).toBeGreaterThanOrEqual(initFloatBeginIter + 1);
  });
});

// ---------------------------------------------------------------------------
// Wave 2.1.3: singular retry — factorNumerical failure triggers forceReorder
// ---------------------------------------------------------------------------

describe("NR singular retry", () => {
  it("nr_retries_with_reorder_after_numerical_singular", () => {
    // Verify that when factor() returns spSINGULAR from the SMPluFac (reuse)
    // path — i.e. lastFactorWalkedReorder=false — the NR loop calls
    // forceReorder() and retries. Mirrors niiter.c:881-902 else-arm.
    const diagnostics = new DiagnosticCollector();

    let forceReorderCalled = false;
    let factorCallCount = 0;
    let stubWalkedReorder = false;

    const realSolver = new SparseSolver();

    const proxySolver = new Proxy(realSolver, {
      get(target, prop) {
        if (prop === "factor") {
          return () => {
            factorCallCount++;
            if (factorCallCount === 1) {
              // Simulate SMPluFac (reuse) path returning spSINGULAR.
              stubWalkedReorder = false;
              return spSINGULAR;
            }
            stubWalkedReorder = (target as SparseSolver).lastFactorWalkedReorder;
            return (target as SparseSolver).factor();
          };
        }
        if (prop === "lastFactorWalkedReorder") {
          return stubWalkedReorder;
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
    const ctx = new CKTCircuitContext(circuit, DEFAULT_SIMULATION_PARAMS, noopBreakpoint, new SparseSolver());
    ctx.diagnostics = diagnostics;
    ctx.solver = proxySolver;

    newtonRaphson(ctx);

    expect(forceReorderCalled).toBe(true);
    expect(ctx.nrResult.converged).toBe(true);
  });

  it("nr_emits_singular_diagnostic_when_reorder_also_fails", () => {
    // When factor() returns spSINGULAR from the SMPreorder path —
    // lastFactorWalkedReorder=true — the retry gate cannot fire and NR
    // must emit a singular-matrix diagnostic with converged=false.
    // Mirrors niiter.c:881-902 if-arm (NISHOULDREORDER → SMPreorder).
    const diagnostics = new DiagnosticCollector();

    const realSolver = new SparseSolver();

    const proxySolver = new Proxy(realSolver, {
      get(target, prop) {
        if (prop === "factor") {
          return () => spSINGULAR;
        }
        if (prop === "lastFactorWalkedReorder") {
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
    const ctx = new CKTCircuitContext(circuit, DEFAULT_SIMULATION_PARAMS, noopBreakpoint, new SparseSolver());
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
    // Run NR with nrModeLadder starting in initJct mode.
    // The STEP J initJct branch calls forceReorder() after transitioning to initFix.
    const vs = makeVoltageSource(1, 0, 2, 5.0);
    const r = makeResistor(1, 2, 1000);
    const d = makeDiode(2, 0, 1e-14, 1);
    const elements = [vs, r, d];
    const pool = allocateStatePool(elements);

    const circuit = { nodeCount: 2, branchCount: 1, matrixSize: 3, elements, statePool: pool };
    const ctx = new CKTCircuitContext(circuit, DEFAULT_SIMULATION_PARAMS, noopBreakpoint, new SparseSolver());
    ctx.diagnostics = new DiagnosticCollector();

    let forceReorderCalled = false;
    const realSolver = ctx.solver;
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
    ctx.cktMode = setInitf(MODEDCOP, MODEINITJCT);
    ctx.nrModeLadder = {
      onModeBegin(_phase: "dcopInitJct" | "dcopInitFix" | "dcopInitFloat", _iter: number): void {},
      onModeEnd(_phase: "dcopInitJct" | "dcopInitFix" | "dcopInitFloat", _iter: number, _converged: boolean): void {},
    };

    newtonRaphson(ctx);

    expect(forceReorderCalled).toBe(true);
    expect(initf(ctx.cktMode)).not.toBe(MODEINITJCT);
  });

  it("forceReorder_called_on_initTran_first_iteration", () => {
    // Run NR with cktMode INITF bits = MODEINITTRAN. On iteration 0, the
    // STEP J initTran branch calls forceReorder() when iteration <= 0
    // (mirrors niiter.c:856-859 NISHOULDREORDER trigger).
    const vs = makeVoltageSource(1, 0, 2, 5.0);
    const r = makeResistor(1, 2, 1000);
    const d = makeDiode(2, 0, 1e-14, 1);
    const elements = [vs, r, d];
    const pool = allocateStatePool(elements);

    const circuit = { nodeCount: 2, branchCount: 1, matrixSize: 3, elements, statePool: pool };
    const ctx = new CKTCircuitContext(circuit, DEFAULT_SIMULATION_PARAMS, noopBreakpoint, new SparseSolver());
    ctx.diagnostics = new DiagnosticCollector();
    ctx.cktMode = setInitf(MODETRAN, MODEINITTRAN);

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
    // the top of the NR loop to re-execute cktLoad before re-factoring.
    const diagnostics = new DiagnosticCollector();

    let forceReorderCalledAfterFailure = false;
    let factorCallCount = 0;
    let beginAssemblyAfterFailure = 0;
    let singularIterationSeen = false;
    let stubWalkedReorder = false;

    const vs = makeVoltageSource(1, 0, 2, 5.0);
    const r = makeResistor(1, 2, 1000);
    const d = makeDiode(2, 0, 1e-14, 1);
    const elements = [vs, r, d];
    const pool = allocateStatePool(elements);

    const circuit = { nodeCount: 2, branchCount: 1, matrixSize: 3, elements, statePool: pool };
    const ctx = new CKTCircuitContext(circuit, DEFAULT_SIMULATION_PARAMS, noopBreakpoint, new SparseSolver());
    ctx.diagnostics = diagnostics;

    const realSolver = ctx.solver;

    const proxySolver = new Proxy(realSolver, {
      get(target, prop) {
        if (prop === "factor") {
          return () => {
            factorCallCount++;
            if (factorCallCount === 2) {
              singularIterationSeen = true;
              // Simulate SMPluFac (reuse) returning spSINGULAR — eligible
              // for the NR-side NISHOULDREORDER retry.
              stubWalkedReorder = false;
              return spSINGULAR;
            }
            const errorCode = (target as SparseSolver).factor();
            stubWalkedReorder = (target as SparseSolver).lastFactorWalkedReorder;
            return errorCode;
          };
        }
        if (prop === "lastFactorWalkedReorder") {
          return stubWalkedReorder;
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
            return (target as SparseSolver)._initStructure(...(args as [number]));
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
    let stubWalkedReorder = false;

    const vs = makeVoltageSource(1, 0, 2, 5.0);
    const r = makeResistor(1, 2, 1000);
    const d = makeDiode(2, 0, 1e-14, 1);
    const elements = [vs, r, d];
    const pool = allocateStatePool(elements);

    const circuit = { nodeCount: 2, branchCount: 1, matrixSize: 3, elements, statePool: pool };
    const ctx = new CKTCircuitContext(circuit, DEFAULT_SIMULATION_PARAMS, noopBreakpoint, new SparseSolver());
    ctx.diagnostics = diagnostics;

    const realSolver = ctx.solver;

    const proxySolver = new Proxy(realSolver, {
      get(target, prop) {
        if (prop === "factor") {
          return () => {
            factorCallCount++;
            if (factorCallCount === 2) {
              singularSeen = true;
              stubWalkedReorder = false;
              return spSINGULAR;
            }
            const errorCode = (target as SparseSolver).factor();
            stubWalkedReorder = (target as SparseSolver).lastFactorWalkedReorder;
            return errorCode;
          };
        }
        if (prop === "lastFactorWalkedReorder") {
          return stubWalkedReorder;
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
            return (target as SparseSolver)._initStructure(...(args as [number]));
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
