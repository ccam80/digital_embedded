/**
 * Tests for CKTCircuitContext — Phase 1 Task 1.1.1
 *
 * Verifies:
 *   1. All Float64Array fields have correct lengths after construction.
 *   2. assembler field exists and is a non-null MNAAssembler instance.
 *   3. nrResult and dcopResult exist as mutable class instances with default values.
 *   4. Pre-computed element lists are populated correctly.
 *   5. Zero Float64Array allocations after initial construction (monkey-patch pattern).
 */

import { describe, it, expect } from "vitest";
import { CKTCircuitContext, NRResult, DcOpResult } from "../ckt-context.js";
import { MNAAssembler } from "../mna-assembler.js";
import { makeResistor, makeDiode, makeCapacitor, allocateStatePool } from "./test-helpers.js";
import { DEFAULT_SIMULATION_PARAMS } from "../../../core/analog-engine-interface.js";
import { isPoolBacked } from "../element.js";

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
    const ctx = new CKTCircuitContext(circuit, defaultParams, noopBreakpoint);

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

    // assembler exists and is non-null MNAAssembler
    expect(ctx.assembler).not.toBeNull();
    expect(ctx.assembler).toBeInstanceOf(MNAAssembler);

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
    expect(ctx.poolBackedElements.length).toBeGreaterThan(0);

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
    const ctx = new CKTCircuitContext(circuit, defaultParams, noopBreakpoint);

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
    const ctx = new CKTCircuitContext(circuit, defaultParams, noopBreakpoint);

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

    // poolBackedElements: exactly pool-backed elements
    const expectedPoolBacked = circuit.elements.filter(el => isPoolBacked(el));
    expect(ctx.poolBackedElements.length).toBe(expectedPoolBacked.length);
    for (const el of expectedPoolBacked) {
      expect(ctx.poolBackedElements).toContain(el);
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
    const ctx = new CKTCircuitContext(circuit, defaultParams, noopBreakpoint);

    const lc = ctx.loadCtx;

    // solver field — must be the SparseSolver instance on ctx
    expect(lc.solver).toBe(ctx.solver);

    // voltages — points into rhsOld
    expect(lc.voltages).toBeInstanceOf(Float64Array);
    expect(lc.voltages).toBe(ctx.rhsOld);

    // iteration — 0-based, starts at 0
    expect(typeof lc.iteration).toBe("number");
    expect(lc.iteration).toBe(0);

    // initMode — one of the valid InitMode values
    const validModes = ["initJct", "initFix", "initFloat", "initTran", "initPred", "initSmsig", "transient"];
    expect(validModes).toContain(lc.initMode);

    // dt — 0 at construction (DC mode)
    expect(typeof lc.dt).toBe("number");
    expect(lc.dt).toBe(0);

    // method — valid integration method string
    const validMethods = ["trapezoidal", "bdf1", "bdf2", "gear"];
    expect(validMethods).toContain(lc.method);

    // order — positive integer
    expect(typeof lc.order).toBe("number");
    expect(lc.order).toBeGreaterThanOrEqual(1);

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

    // noncon — mutable ref object with numeric value
    expect(typeof lc.noncon).toBe("object");
    expect(lc.noncon).not.toBeNull();
    expect(typeof lc.noncon.value).toBe("number");

    // limitingCollector — null at construction
    expect(lc.limitingCollector).toBeNull();

    // isDcOp / isTransient — boolean flags
    expect(typeof lc.isDcOp).toBe("boolean");
    expect(typeof lc.isTransient).toBe("boolean");

    // xfact — numeric
    expect(typeof lc.xfact).toBe("number");

    // gmin — positive number
    expect(typeof lc.gmin).toBe("number");
    expect(lc.gmin).toBeGreaterThan(0);

    // uic — boolean
    expect(typeof lc.uic).toBe("boolean");

    // reltol — matches params
    expect(typeof lc.reltol).toBe("number");
    expect(lc.reltol).toBe(defaultParams.reltol);

    // iabstol — matches params abstol
    expect(typeof lc.iabstol).toBe("number");
    expect(lc.iabstol).toBe(defaultParams.abstol);
  });
});
