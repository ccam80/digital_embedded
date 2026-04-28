/**
 * Tests for CKTCircuitContext — Phase 1 Task 1.1.1
 *
 * Verifies:
 *   1. All Float64Array fields have correct lengths after construction.
 *   2. nrResult and dcopResult exist as mutable class instances with default values.
 *   3. Zero Float64Array allocations after initial construction (monkey-patch pattern).
 */

import { describe, it, expect } from "vitest";
import { CKTCircuitContext, NRResult, DcOpResult } from "../ckt-context.js";
import { allocateStatePool } from "./test-helpers.js";
import { DEFAULT_SIMULATION_PARAMS } from "../../../core/analog-engine-interface.js";
import { SparseSolver } from "../sparse-solver.js";
import { NGSPICE_LOAD_ORDER } from "../../../core/analog-types.js";
import type { AnalogElement } from "../element.js";
import type { LoadContext } from "../load-context.js";
import type { SetupContext } from "../setup-context.js";

function makeResistor(nodeA: number, nodeB: number, resistance: number): AnalogElement {
  const G = 1 / resistance;
  let _hPP = -1, _hNN = -1, _hPN = -1, _hNP = -1;
  const el: AnalogElement = {
    label: "",
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.RES,
    _pinNodes: new Map([["A", nodeA], ["B", nodeB]]),
    _stateBase: -1,
    branchIndex: -1,
    setup(ctx: SetupContext): void {
      const s = ctx.solver;
      if (nodeA !== 0) _hPP = s.allocElement(nodeA, nodeA);
      if (nodeB !== 0) _hNN = s.allocElement(nodeB, nodeB);
      if (nodeA !== 0 && nodeB !== 0) {
        _hPN = s.allocElement(nodeA, nodeB);
        _hNP = s.allocElement(nodeB, nodeA);
      }
    },
    load(ctx: LoadContext): void {
      const s = ctx.solver;
      if (_hPP !== -1) s.stampElement(_hPP,  G);
      if (_hNN !== -1) s.stampElement(_hNN,  G);
      if (_hPN !== -1) s.stampElement(_hPN, -G);
      if (_hNP !== -1) s.stampElement(_hNP, -G);
    },
    getPinCurrents(rhs: Float64Array): number[] {
      const vA = rhs[nodeA] ?? 0;
      const vB = rhs[nodeB] ?? 0;
      return [G * (vA - vB), G * (vB - vA)];
    },
    setParam(_key: string, _value: number): void {},
  };
  return el;
}

function makeDiode(nodeAnode: number, nodeCathode: number, IS: number, N: number): AnalogElement {
  const VT = 0.025852;
  let _hAA = -1, _hKK = -1, _hAK = -1, _hKA = -1;
  const el: AnalogElement = {
    label: "",
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.DIO,
    _pinNodes: new Map([["A", nodeAnode], ["K", nodeCathode]]),
    _stateBase: -1,
    branchIndex: -1,
    setup(ctx: SetupContext): void {
      const s = ctx.solver;
      if (nodeAnode !== 0) _hAA = s.allocElement(nodeAnode, nodeAnode);
      if (nodeCathode !== 0) _hKK = s.allocElement(nodeCathode, nodeCathode);
      if (nodeAnode !== 0 && nodeCathode !== 0) {
        _hAK = s.allocElement(nodeAnode, nodeCathode);
        _hKA = s.allocElement(nodeCathode, nodeAnode);
      }
    },
    load(ctx: LoadContext): void {
      const vA = ctx.rhsOld[nodeAnode] ?? 0;
      const vK = ctx.rhsOld[nodeCathode] ?? 0;
      const vD = Math.min(vA - vK, 0.7);
      const Id = IS * (Math.exp(vD / (N * VT)) - 1);
      const Gd = IS / (N * VT) * Math.exp(vD / (N * VT));
      const Ieq = Id - Gd * vD;
      const s = ctx.solver;
      if (_hAA !== -1) s.stampElement(_hAA,  Gd);
      if (_hKK !== -1) s.stampElement(_hKK,  Gd);
      if (_hAK !== -1) s.stampElement(_hAK, -Gd);
      if (_hKA !== -1) s.stampElement(_hKA, -Gd);
      if (nodeAnode !== 0) ctx.rhs[nodeAnode] -= Ieq;
      if (nodeCathode !== 0) ctx.rhs[nodeCathode] += Ieq;
    },
    getPinCurrents(_rhs: Float64Array): number[] { return [0, 0]; },
    setParam(_key: string, _value: number): void {},
  };
  return el;
}

function makeCapacitor(nodePos: number, nodeNeg: number, _capacitance: number): AnalogElement {
  let _hPP = -1, _hNN = -1, _hPN = -1, _hNP = -1;
  const el: AnalogElement = {
    label: "",
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.CAP,
    _pinNodes: new Map([["pos", nodePos], ["neg", nodeNeg]]),
    _stateBase: -1,
    branchIndex: -1,
    setup(ctx: SetupContext): void {
      const s = ctx.solver;
      if (nodePos !== 0) _hPP = s.allocElement(nodePos, nodePos);
      if (nodeNeg !== 0) _hNN = s.allocElement(nodeNeg, nodeNeg);
      if (nodePos !== 0 && nodeNeg !== 0) {
        _hPN = s.allocElement(nodePos, nodeNeg);
        _hNP = s.allocElement(nodeNeg, nodePos);
      }
    },
    load(ctx: LoadContext): void {
      const s = ctx.solver;
      if (_hPP !== -1) s.stampElement(_hPP,  0);
      if (_hNN !== -1) s.stampElement(_hNN,  0);
      if (_hPN !== -1) s.stampElement(_hPN,  0);
      if (_hNP !== -1) s.stampElement(_hNP,  0);
    },
    getPinCurrents(_rhs: Float64Array): number[] { return [0, 0]; },
    setParam(_key: string, _value: number): void {},
  };
  return el;
}

// ---------------------------------------------------------------------------
// Test circuit factories
// ---------------------------------------------------------------------------

/**
 * Build a minimal 10-node circuit for buffer-size assertions.
 * 9 nodes + 1 branch = matrixSize 10.
 */
function makeTestCircuit(nodeCount = 9, branchCount = 1) {
  const matrixSize = nodeCount + branchCount;

  const r1 = makeResistor(1, 2, 1000);
  const r2 = makeResistor(2, 3, 2000);
  const d1 = makeDiode(3, 0, 1e-14, 1);
  const cap = makeCapacitor(4, 0, 1e-9);
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
  // Test: loadCtx_fields_populated
  // -------------------------------------------------------------------------

  it("loadCtx_fields_populated", () => {
    const circuit = makeTestCircuit(9, 1);
    const ctx = new CKTCircuitContext(circuit, defaultParams, noopBreakpoint, new SparseSolver());

    const lc = ctx.loadCtx;

    // solver field — must be the SparseSolver instance on ctx
    expect(lc.solver).toBe(ctx.solver);

    // voltages — points into rhsOld
    expect(lc.rhsOld).toBeInstanceOf(Float64Array);
    expect(lc.rhsOld).toBe(ctx.rhsOld);

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
    const validMethods = ["trapezoidal", "gear"];
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

  // -------------------------------------------------------------------------
  // Test: deltaOld init (Task 5.0.2)
  // -------------------------------------------------------------------------

  describe("deltaOld init", () => {
    it("seeded_to_maxTimeStep", () => {
      // Task 5.0.2: verify deltaOld[i] is seeded to params.maxTimeStep per dctran.c:317
      const customParams = { ...defaultParams, maxTimeStep: 1e-6 };
      const circuit = makeTestCircuit(9, 1);
      const ctx = new CKTCircuitContext(circuit, customParams, noopBreakpoint, new SparseSolver());

      // All 7 slots should be seeded to maxTimeStep
      for (let i = 0; i < 7; i++) {
        expect(ctx.loadCtx.deltaOld[i]).toBe(1e-6);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Test: LoadContext defaults (Task 5.0.1)
  // -------------------------------------------------------------------------

  describe("LoadContext defaults", () => {
    it("bypass_defaults_to_false", () => {
      // cite: cktinit.c:53-55 — CKTbypass defaults to false
      const circuit = makeTestCircuit(9, 1);
      const ctx = new CKTCircuitContext(circuit, defaultParams, noopBreakpoint, new SparseSolver());
      expect(ctx.loadCtx.bypass).toBe(false);
    });

    it("voltTol_defaults_to_1e_minus_6", () => {
      // cite: cktinit.c:53-55 — CKTvoltTol defaults to 1e-6
      const circuit = makeTestCircuit(9, 1);
      const ctx = new CKTCircuitContext(circuit, defaultParams, noopBreakpoint, new SparseSolver());
      expect(ctx.loadCtx.voltTol).toBe(1e-6);
    });
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
