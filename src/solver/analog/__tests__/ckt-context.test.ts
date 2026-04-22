/**
 * Tests for CKTCircuitContext — Phase 1 Task 1.1.1
 *
 * Verifies:
 *   1. All Float64Array fields have correct lengths after construction.
 *   2. nrResult and dcopResult exist as mutable class instances with default values.
 *   3. Pre-computed element lists are populated correctly.
 *   4. Zero Float64Array allocations after initial construction (monkey-patch pattern).
 */

import { describe, it, expect } from "vitest";
import { CKTCircuitContext, NRResult, DcOpResult } from "../ckt-context.js";
import { makeResistor, makeDiode, makeCapacitor, allocateStatePool } from "./test-helpers.js";
import { DEFAULT_SIMULATION_PARAMS } from "../../../core/analog-engine-interface.js";
import { SparseSolver } from "../sparse-solver.js";

// ---------------------------------------------------------------------------
// Test circuit factories
// ---------------------------------------------------------------------------

/**
 * Build a minimal 10-node circuit for buffer-size assertions.
 * 9 nodes + 1 branch = matrixSize 10.
 * Includes 1 nonlinear element (diode), 1 reactive element (capacitor).
 */
function makeTestCircuit(nodeCount = 9, branchCount = 1) {
  const matrixSize = nodeCount + branchCount;

  // Elements with varying flags for pre-computed list tests
  const r1 = makeResistor(1, 2, 1000);   // linear, non-reactive
  const r2 = makeResistor(2, 3, 2000);
  const d1 = makeDiode(3, 0, 1e-14, 1); // nonlinear + reactive, pool-backed, has checkConvergence
  const cap = makeCapacitor(4, 0, 1e-9); // reactive, has getLteTimestep + acceptStep is absent
  const elements = [r1, r2, d1, cap];

  const pool = allocateStatePool(elements);

  return {
    nodeCount,
    branchCount,
    matrixSize,
    elements,
    statePool: pool,
  };
}

/**
 * Build a circuit with explicit element flags for list-matching tests.
 */
function makeListTestCircuit() {
  const r = makeResistor(1, 2, 100);    // isNonlinear=false, isReactive=false
  const d = makeDiode(2, 0, 1e-14, 1); // isNonlinear=true, isReactive=true, poolBacked=true
  const c = makeCapacitor(1, 0, 1e-6); // isNonlinear=false, isReactive=true
  const elements = [r, d, c];

  const pool = allocateStatePool(elements);

  return {
    nodeCount: 2,
    branchCount: 0,
    matrixSize: 2,
    elements,
    statePool: pool,
  };
}

const defaultParams = DEFAULT_SIMULATION_PARAMS;
const noopBreakpoint = (_t: number): void => {};

// ---------------------------------------------------------------------------
// Test: allocates_all_buffers_at_init
// ---------------------------------------------------------------------------

describe("CKTCircuitContext", () => {
  it("allocates_all_buffers_at_init", () => {
    const circuit = makeTestCircuit(9, 1);
    const ctx = new CKTCircuitContext(circuit, defaultParams, noopBreakpoint, new SparseSolver());

    const sz = circuit.matrixSize; // 10
    const stateSlots = circuit.statePool!.totalSlots;

    // Node voltage buffers — length = matrixSize
    expect(ctx.rhsOld).toBeInstanceOf(Float64Array);
    expect(ctx.rhsOld.length).toBe(sz);
    expect(ctx.rhs).toBeInstanceOf(Float64Array);
    expect(ctx.rhs.length).toBe(sz);
    expect(ctx.rhsSpare).toBeInstanceOf(Float64Array);
    expect(ctx.rhsSpare.length).toBe(sz);

    // Accepted solution buffers — length = matrixSize
    expect(ctx.acceptedVoltages).toBeInstanceOf(Float64Array);
    expect(ctx.acceptedVoltages.length).toBe(sz);
    expect(ctx.prevAcceptedVoltages).toBeInstanceOf(Float64Array);
    expect(ctx.prevAcceptedVoltages.length).toBe(sz);

    // DC-OP scratch — voltage buffers = matrixSize
    expect(ctx.dcopVoltages).toBeInstanceOf(Float64Array);
    expect(ctx.dcopVoltages.length).toBe(sz);
    expect(ctx.dcopSavedVoltages).toBeInstanceOf(Float64Array);
    expect(ctx.dcopSavedVoltages.length).toBe(sz);

    // DC-OP scratch — state0 snapshots = statePool.totalSlots
    expect(ctx.dcopSavedState0).toBeInstanceOf(Float64Array);
    expect(ctx.dcopSavedState0.length).toBe(stateSlots);
    expect(ctx.dcopOldState0).toBeInstanceOf(Float64Array);
    expect(ctx.dcopOldState0.length).toBe(stateSlots);

    // Integration — length 7
    expect(ctx.ag).toBeInstanceOf(Float64Array);
    expect(ctx.ag.length).toBe(7);
    expect(ctx.agp).toBeInstanceOf(Float64Array);
    expect(ctx.agp.length).toBe(7);

    // deltaOld — pre-allocated length 7 array
    expect(Array.isArray(ctx.deltaOld)).toBe(true);
    expect(ctx.deltaOld.length).toBe(7);

    // Gear scratch — 7×7 flat = 49
    expect(ctx.gearMatScratch).toBeInstanceOf(Float64Array);
    expect(ctx.gearMatScratch.length).toBe(49);

    // LTE scratch — at least matrixSize elements
    expect(ctx.lteScratch).toBeInstanceOf(Float64Array);
    expect(ctx.lteScratch.length).toBeGreaterThanOrEqual(sz);

    // nrResult exists with default values
    expect(ctx.nrResult).toBeInstanceOf(NRResult);
    expect(ctx.nrResult.converged).toBe(false);
    expect(ctx.nrResult.iterations).toBe(0);
    expect(ctx.nrResult.largestChangeElement).toBe(-1);
    expect(ctx.nrResult.largestChangeNode).toBe(-1);
    expect(ctx.nrResult.voltages).toBeInstanceOf(Float64Array);

    // dcopResult exists with default values
    expect(ctx.dcopResult).toBeInstanceOf(DcOpResult);
    expect(ctx.dcopResult.converged).toBe(false);
    expect(ctx.dcopResult.iterations).toBe(0);
    expect(ctx.dcopResult.nodeVoltages).toBeInstanceOf(Float64Array);

    // Pre-computed element lists are populated
    expect(ctx.nonlinearElements.length).toBeGreaterThan(0);
    expect(ctx.reactiveElements.length).toBeGreaterThan(0);

    // matrixSize and nodeCount match input
    expect(ctx.matrixSize).toBe(sz);
    expect(ctx.nodeCount).toBe(circuit.nodeCount);

    // statePool is set
    expect(ctx.statePool).toBe(circuit.statePool);
  });

  // -------------------------------------------------------------------------
  // Test: zero_allocations_on_reuse
  // -------------------------------------------------------------------------

  it("zero_allocations_on_reuse", () => {
    const circuit = makeTestCircuit(4, 0);
    const ctx = new CKTCircuitContext(circuit, defaultParams, noopBreakpoint, new SparseSolver());

    // Monkey-patch Float64Array to count constructor calls
    const RealF64 = Float64Array;
    let allocCount = 0;

    globalThis.Float64Array = new Proxy(RealF64, {
      construct(target, args) {
        allocCount++;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return Reflect.construct(target, args) as any;
      },
    }) as unknown as typeof Float64Array;

    try {
      // Reset counter after initial setup — only count allocations during reuse
      allocCount = 0;

      // Simulate NR reuse: read and write through existing ctx buffers
      // (the same operations newtonRaphson would perform)
      ctx.rhsOld.fill(0);
      ctx.rhs.fill(0);
      ctx.noncon = 0;
      ctx.nrResult.reset();

      // Second invocation — still zero allocations
      ctx.rhsOld.fill(1);
      ctx.rhs.fill(1);
      ctx.noncon = 0;
      ctx.nrResult.reset();

      expect(allocCount).toBe(0);
    } finally {
      // Always restore, even if assertion throws
      globalThis.Float64Array = RealF64;
    }
  });

  // -------------------------------------------------------------------------
  // Test: precomputed_lists_match_element_flags
  // -------------------------------------------------------------------------

  it("precomputed_lists_match_element_flags", () => {
    const circuit = makeListTestCircuit();
    const ctx = new CKTCircuitContext(circuit, defaultParams, noopBreakpoint, new SparseSolver());

    // nonlinearElements: exactly elements with isNonlinear === true
    const expectedNonlinear = circuit.elements.filter(el => el.isNonlinear);
    expect(ctx.nonlinearElements.length).toBe(expectedNonlinear.length);
    for (const el of expectedNonlinear) {
      expect(ctx.nonlinearElements).toContain(el);
    }

    // reactiveElements: exactly elements with isReactive === true
    const expectedReactive = circuit.elements.filter(el => el.isReactive);
    expect(ctx.reactiveElements.length).toBe(expectedReactive.length);
    for (const el of expectedReactive) {
      expect(ctx.reactiveElements).toContain(el);
    }

    // elementsWithConvergence: elements implementing checkConvergence()
    const expectedWithConvergence = circuit.elements.filter(
      el => typeof (el as { checkConvergence?: unknown }).checkConvergence === "function",
    );
    expect(ctx.elementsWithConvergence.length).toBe(expectedWithConvergence.length);
    for (const el of expectedWithConvergence) {
      expect(ctx.elementsWithConvergence).toContain(el);
    }

    // elementsWithLte: elements implementing getLteTimestep()
    const expectedWithLte = circuit.elements.filter(
      el => typeof (el as { getLteTimestep?: unknown }).getLteTimestep === "function",
    );
    expect(ctx.elementsWithLte.length).toBe(expectedWithLte.length);
    for (const el of expectedWithLte) {
      expect(ctx.elementsWithLte).toContain(el);
    }

    // elementsWithAcceptStep: elements implementing acceptStep()
    const expectedWithAcceptStep = circuit.elements.filter(
      el => typeof (el as { acceptStep?: unknown }).acceptStep === "function",
    );
    expect(ctx.elementsWithAcceptStep.length).toBe(expectedWithAcceptStep.length);
    for (const el of expectedWithAcceptStep) {
      expect(ctx.elementsWithAcceptStep).toContain(el);
    }
  });

  // -------------------------------------------------------------------------
  // Test: loadCtx_fields_populated
  // -------------------------------------------------------------------------

  it("loadCtx_fields_populated", () => {
    const circuit = makeTestCircuit(9, 1);
    const ctx = new CKTCircuitContext(circuit, defaultParams, noopBreakpoint, new SparseSolver());

    const lc = ctx.loadCtx;

    // solver field — must be the SparseSolver instance on ctx
    expect(lc.solver).toBe(ctx.solver);

    // voltages — points into rhsOld
    expect(lc.voltages).toBeInstanceOf(Float64Array);
    expect(lc.voltages).toBe(ctx.rhsOld);

    // Deleted per Phase 2.5 W2.2 (C3 + D1) + A1 §Test handling rule:
    //   lc.iteration — removed by C3 (cktLoad no longer takes an iteration param;
    //   iteration-sensitive behavior keys on cktMode INITF bits).
    //   lc.initMode — removed by D1; INITF state lives in cktMode bitfield only.
    //   These assertions inspected non-existent LoadContext fields.
    //
    // cktMode check — bitfield is the sole source of truth for analysis + INITF.
    expect(typeof lc.cktMode).toBe("number");

    // dt — 0 at construction (DC mode)
    expect(typeof lc.dt).toBe("number");
    expect(lc.dt).toBe(0);

    // method — valid integration method string
    const validMethods = ["trapezoidal", "bdf1", "bdf2", "gear"];
    expect(validMethods).toContain(lc.method);

    // order — default is 1 at construction
    expect(lc.order).toBe(1);

    // deltaOld — length-7 array
    expect(Array.isArray(lc.deltaOld)).toBe(true);
    expect(lc.deltaOld.length).toBe(7);

    // ag — Float64Array length 7, same instance as ctx.ag
    expect(lc.ag).toBeInstanceOf(Float64Array);
    expect(lc.ag.length).toBe(7);
    expect(lc.ag).toBe(ctx.ag);

    // srcFact — starts at 1 (full source magnitude)
    expect(typeof lc.srcFact).toBe("number");
    expect(lc.srcFact).toBe(1);

    // noncon — mutable ref object, value starts at 0
    expect(lc.noncon).not.toBeNull();
    expect(lc.noncon.value).toBe(0);

    // limitingCollector — null at construction
    expect(lc.limitingCollector).toBeNull();

    // Deleted per Phase 2.5 W2.2 (A2+A3 already landed) + A1 §Test handling:
    //   lc.isDcOp / lc.isTransient / lc.uic — all removed in A2/A3/C2. The
    //   canonical readers test against cktMode bitfield bits (MODEDCOP,
    //   MODETRAN, MODEUIC) per ckt-mode.ts helpers.

    // xfact — 0 until first step computes deltaOld[0]/deltaOld[1]
    expect(lc.xfact).toBe(0);

    // gmin — positive number
    expect(typeof lc.gmin).toBe("number");
    expect(lc.gmin).toBeGreaterThan(0);

    // reltol — matches params
    expect(typeof lc.reltol).toBe("number");
    expect(lc.reltol).toBe(defaultParams.reltol);

    // iabstol — matches params abstol
    expect(typeof lc.iabstol).toBe("number");
    expect(lc.iabstol).toBe(defaultParams.abstol);
  });
});

// ---------------------------------------------------------------------------
// Task C6.2 — DcOpResult.reset() must not reallocate diagnostics
// ---------------------------------------------------------------------------

describe("DcOpResult", () => {
  it("reset_preserves_array_identity", () => {
    // After C6.2, DcOpResult.reset() clears diagnostics in place
    // via `this.diagnostics.length = 0` rather than allocating a fresh array.
    const circuit = makeTestCircuit(4, 0);
    const ctx = new CKTCircuitContext(circuit, defaultParams, noopBreakpoint, new SparseSolver());

    const arr = ctx.dcopResult.diagnostics;
    arr.push({
      code: "dc-op-converged",
      severity: "info",
      message: "sentinel entry",
    });
    expect(arr.length).toBe(1);

    ctx.dcopResult.reset();

    // Same array instance, cleared in place.
    expect(ctx.dcopResult.diagnostics).toBe(arr);
    expect(ctx.dcopResult.diagnostics.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Task C6.4 — solver must be passed in and not re-allocated
// ---------------------------------------------------------------------------

describe("solver", () => {
  it("single_allocation", () => {
    // C6.4: construct a ctx with an explicit solver instance; assert
    // ctx.solver === passedSolver with .toBe identity. This guards against
    // the double-allocation bug where CKTCircuitContext used to create its
    // own SparseSolver internally and required callers to overwrite it.
    const circuit = makeTestCircuit(4, 0);
    const passedSolver = new SparseSolver();
    const ctx = new CKTCircuitContext(circuit, defaultParams, noopBreakpoint, passedSolver);

    expect(ctx.solver).toBe(passedSolver);
    // loadCtx.solver must also point at the same instance.
    expect(ctx.loadCtx.solver).toBe(passedSolver);
  });
});
