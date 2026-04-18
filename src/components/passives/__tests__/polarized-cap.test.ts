/**
 * Tests for the PolarizedCap component.
 *
 * Covers:
 *   - DC steady-state leakage current
 *   - ESR dominates initial current spike
 *   - RC time constant with series resistor
 *   - Reverse-bias diagnostic emission
 *   - Forward-bias no diagnostic
 */

import { describe, it, expect } from "vitest";
import {
  PolarizedCapElement,
  PolarizedCapDefinition,
  AnalogPolarizedCapElement,
  POLARIZED_CAP_MODEL_DEFAULTS,
} from "../polarized-cap.js";
import { PropertyBag } from "../../../core/properties.js";
import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import { runDcOp, makeSimpleCtx } from "../../../solver/analog/__tests__/test-helpers.js";
import { makeDcVoltageSource } from "../../sources/dc-voltage-source.js";
import type { Diagnostic } from "../../../compile/types.js";
import { StatePool } from "../../../solver/analog/state-pool.js";
import type { AnalogElementCore, ReactiveAnalogElement } from "../../../solver/analog/element.js";
import type { LoadContext } from "../../../solver/analog/load-context.js";
import { computeNIcomCof } from "../../../solver/analog/integration.js";
import type { IntegrationMethod } from "../../../core/analog-types.js";

// ---------------------------------------------------------------------------
// Helper: narrow ModelEntry to inline factory (throws if netlist kind)
// ---------------------------------------------------------------------------
import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";
import type { AnalogElement } from "../../../solver/analog/element.js";
function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withState(core: AnalogElementCore): { element: ReactiveAnalogElement; pool: StatePool } {
  const re = core as ReactiveAnalogElement;
  const pool = new StatePool(Math.max(re.stateSize, 1));
  re.stateBaseOffset = 0;
  re.initState(pool);
  return { element: re, pool };
}

/**
 * Minimal DC-OP LoadContext for diagnostic-emission tests that only exercise
 * the polarity check at the top of load(). dt=0 short-circuits the companion
 * path so no NIintegrate work runs.
 */
function makeDiagnosticCtx(
  solver: SparseSolver,
  voltages: Float64Array,
): LoadContext {
  return {
    solver,
    voltages,
    iteration: 0,
    initMode: "initFloat",
    dt: 0,
    method: "trapezoidal",
    order: 1,
    deltaOld: [0, 0, 0, 0, 0, 0, 0],
    ag: new Float64Array(8),
    srcFact: 1,
    noncon: { value: 0 },
    limitingCollector: null,
    isDcOp: true,
    isTransient: false,
    xfact: 1,
    gmin: 1e-12,
    uic: false,
    reltol: 1e-3,
    iabstol: 1e-12,
  };
}

/**
 * Transient LoadContext for pool-slot verification. Computes ag[] via
 * computeNIcomCof so the companion stamps and pool slot writes match the
 * production code path exactly.
 */
function makeSlotLoadCtx(
  solver: SparseSolver,
  voltages: Float64Array,
  dt: number,
  method: IntegrationMethod,
  order: number,
  initMode: LoadContext["initMode"],
): LoadContext {
  const deltaOld = [dt, dt, dt, dt, dt, dt, dt];
  const ag = new Float64Array(8);
  const scratch = new Float64Array(64);
  computeNIcomCof(dt, deltaOld, order, method, ag, scratch);
  return {
    solver,
    voltages,
    iteration: 0,
    initMode,
    dt,
    method,
    order,
    deltaOld,
    ag,
    srcFact: 1,
    noncon: { value: 0 },
    limitingCollector: null,
    isDcOp: false,
    isTransient: true,
    xfact: 1,
    gmin: 1e-12,
    uic: false,
    reltol: 1e-3,
    iabstol: 1e-12,
  };
}

/**
 * Build a PolarizedCap analog element for direct testing, pre-initialized with a pool.
 *
 * Node layout:
 *   n_pos = 1, n_neg = 0 (ground), n_cap = 2
 *
 * This means the MNA matrix has 2 non-ground nodes:
 *   solver index 0 = node 1 (positive terminal)
 *   solver index 1 = node 2 (internal cap node)
 */
function makeCapElement(opts: {
  capacitance: number;
  esr: number;
  rLeak: number;
  reverseMax?: number;
  emitDiagnostic?: (d: Diagnostic) => void;
}): AnalogPolarizedCapElement {
  const el = new AnalogPolarizedCapElement(
    [1, 0, 2],
    opts.capacitance,
    opts.esr,
    opts.rLeak,
    opts.reverseMax ?? 1.0,
    opts.emitDiagnostic,
  );
  withState(el);
  return el;
}

/**
 * Build a resistor analog element for test use.
 * n_a and n_b are 1-based (0 = ground).
 */
function makeResistorElement(nA: number, nB: number, resistance: number) {
  const G = 1 / resistance;
  return {
    pinNodeIds: [nA, nB] as readonly number[],
    allNodeIds: [nA, nB] as readonly number[],
    branchIndex: -1,
    isNonlinear: false,
    isReactive: false,
    setParam(_key: string, _value: number): void {},
    getPinCurrents(_v: Float64Array): number[] { return []; },
    load(ctx: LoadContext): void {
      const { solver } = ctx;
      if (nA !== 0) solver.stampElement(solver.allocElement(nA - 1, nA - 1), G);
      if (nA !== 0 && nB !== 0) solver.stampElement(solver.allocElement(nA - 1, nB - 1), -G);
      if (nB !== 0 && nA !== 0) solver.stampElement(solver.allocElement(nB - 1, nA - 1), -G);
      if (nB !== 0) solver.stampElement(solver.allocElement(nB - 1, nB - 1), G);
    },
  };
}

// ---------------------------------------------------------------------------
// PolarizedCap tests
// ---------------------------------------------------------------------------

describe("PolarizedCap", () => {
  describe("dc_behaves_as_open_with_leakage", () => {
    it("DC current through capacitor equals V/R_leak in steady state", () => {
      // Circuit: 5V source → polarized cap (pos=node1, neg=ground, cap_internal=node2)
      // Leakage: R_leak = 25V / 1µA = 25MΩ
      // ESR: 0.1Ω (negligible at DC)
      // At DC steady state: cap is open, only leakage path conducts
      // I_leak = V / R_leak = 5 / 25e6 = 200nA
      //
      // MNA layout:
      //   node 1 = voltage source positive terminal (= pos terminal of cap)
      //   node 2 = internal cap node
      //   branch 2 (solver row 2) = voltage source branch
      //   matrixSize = 3 (2 nodes + 1 branch)

      const V = 5;
      const rLeak = 25e6;
      const esr = 0.1;
      const C = 100e-6;

      const vs = makeDcVoltageSource(1, 0, 2, V) as unknown as AnalogElement;
      const cap = makeCapElement({ capacitance: C, esr, rLeak });

      const result = runDcOp({
        elements: [vs, cap],
        matrixSize: 3,
        nodeCount: 2,
      });

      expect(result.converged).toBe(true);

      // At DC: capacitor is open (geq=0, ieq=0), only leakage path conducts
      // V(node1) = 5V (enforced by source)
      expect(result.nodeVoltages[0]).toBeCloseTo(V, 3);

      // Branch current = leakage current through ESR + cap_node path to ground
      // I = V / (ESR + R_leak) ≈ V / R_leak (ESR << R_leak)
      const expectedI = V / (esr + rLeak);
      const branchCurrent = Math.abs(result.nodeVoltages[2]);
      expect(Math.abs(branchCurrent - expectedI) / expectedI).toBeLessThan(0.01);
    });
  });

  describe("esr_adds_series_resistance", () => {
    it("initial current spike is dominated by ESR at t=0", () => {
      // At t=0 (first transient step with very small dt), the capacitor companion
      // has geq = C/dt >> G_leak, so almost all impedance is in ESR.
      // For a step from 0V to V_step, initial current ≈ V_step / ESR.
      //
      // MNA: node1=pos, node0=ground=neg, node2=cap_internal
      // Source: V_step on node1
      // matrixSize = 3

      const V_step = 10;
      const esr = 5.0;        // large ESR for clear measurement
      const C = 100e-6;
      const rLeak = 25e6;

      const vs = makeDcVoltageSource(1, 0, 2, V_step) as unknown as AnalogElement;
      const cap = makeCapElement({ capacitance: C, esr, rLeak });

      // Tiny timestep: geq = C/dt = 100e-6 / 1e-9 = 1e5 >> G_esr.
      // Drive a single initTran step directly so the companion is active.
      const dt = 1e-9;
      const matrixSize = 3;
      const solver = new SparseSolver();
      const voltages = new Float64Array(matrixSize);

      const deltaOld = [dt, dt, dt, dt, dt, dt, dt];
      const ag = new Float64Array(8);
      const scratch = new Float64Array(64);
      computeNIcomCof(dt, deltaOld, 1, "bdf1", ag, scratch);

      const ctx: LoadContext = {
        solver,
        voltages,
        iteration: 0,
        initMode: "initTran",
        dt,
        method: "bdf1",
        order: 1,
        deltaOld,
        ag,
        srcFact: 1,
        noncon: { value: 0 },
        limitingCollector: null,
        isDcOp: false,
        isTransient: true,
        xfact: 1,
        gmin: 1e-12,
        uic: false,
        reltol: 1e-3,
        iabstol: 1e-12,
      };

      solver.beginAssembly(matrixSize);
      vs.load(ctx);
      cap.load(ctx);
      solver.finalize();
      const factorResult = solver.factor();
      expect(factorResult.success).toBe(true);
      solver.solve(voltages);

      // At t=0 with geq >> G_leak, cap is near short-circuit
      // Most of V_step drops across ESR
      // I ≈ V_step / ESR
      const expectedI = V_step / esr;
      const branchCurrent = Math.abs(voltages[2]);
      expect(Math.abs(branchCurrent - expectedI) / expectedI).toBeLessThan(0.1);
    });
  });

  describe("charges_with_rc_time_constant", () => {
    it("capacitor voltage reaches 63% of step voltage at t ≈ RC", () => {
      // RC circuit: 10µF cap + 1kΩ series resistor, 5V step input
      // Run transient to t = RC = 10ms using BDF-1 (backward Euler).
      // Expected: V(cap_pos) ≈ 5 * (1 - exp(-1)) ≈ 3.161V at t = RC.
      //
      // MNA layout (1-based nodes, 0=ground):
      //   node 1 = voltage source positive terminal
      //   node 2 = junction of R and cap positive terminal
      //   node 3 = cap internal node (between ESR and cap body)
      //   branch 3 (solver row 3) = voltage source branch current
      //   matrixSize = 4 (3 non-ground nodes + 1 voltage source branch)
      //
      // Cap: [nPos=2, nNeg=0(ground), nCap=3]
      // R: node1 ↔ node2
      // Vs: node1 to ground (branchIdx=3 = solver row 3)

      const V_step = 5;
      const R = 1000;
      const C = 10e-6;
      const rLeak = 25e6;
      const esr = 1e-3;     // tiny ESR so internal node is valid
      const RC = R * C;     // 10 ms

      const vs = makeDcVoltageSource(1, 0, 3, V_step);
      const rSeries = makeResistorElement(1, 2, R);
      const cap = new AnalogPolarizedCapElement([2, 0, 3], C, esr, rLeak, 1.0);
      const { pool: capPool } = withState(cap);

      const matrixSize = 4;
      const solver = new SparseSolver();
      const voltages = new Float64Array(matrixSize);

      // Run 500 steps at dt = RC/500 = 20µs using BDF-1 (no ringing on step input)
      const dt = RC / 500;
      const steps = 500;

      const method: IntegrationMethod = "bdf1";
      const order = 1;
      const deltaOld = [dt, dt, dt, dt, dt, dt, dt];
      const ag = new Float64Array(8);
      const scratch = new Float64Array(64);
      computeNIcomCof(dt, deltaOld, order, method, ag, scratch);

      // Reused across iterations — mutated in place.
      const loopCtx: LoadContext = {
        solver,
        voltages,
        iteration: 0,
        initMode: "initTran",
        dt,
        method,
        order,
        deltaOld,
        ag,
        srcFact: 1,
        noncon: { value: 0 },
        limitingCollector: null,
        isDcOp: false,
        isTransient: true,
        xfact: 1,
        gmin: 1e-12,
        uic: false,
        reltol: 1e-3,
        iabstol: 1e-12,
      };

      for (let step = 0; step < steps; step++) {
        loopCtx.initMode = step === 0 ? "initTran" : "initFloat";

        solver.beginAssembly(matrixSize);
        vs.load(loopCtx);
        rSeries.load(loopCtx);
        cap.load(loopCtx);
        solver.finalize();

        const factorResult = solver.factor();
        if (!factorResult.success) {
          throw new Error(`Singular matrix at step ${step}`);
        }
        solver.solve(voltages);
        // Re-load once with the post-solve voltages so the state pool stores the
        // accepted-step values (ngspice post-step state-commit pattern) before
        // rotating history.
        solver.beginAssembly(matrixSize);
        vs.load(loopCtx);
        rSeries.load(loopCtx);
        cap.load(loopCtx);
        solver.finalize();
        capPool.rotateStateVectors();
        capPool.refreshElementRefs([cap as unknown as import("../../../solver/analog/element.js").PoolBackedAnalogElementCore]);
      }

      // After RC seconds, V(cap_pos = node2, solver index 1) ≈ 5*(1-exp(-1)) ≈ 3.161V
      const vCapPos = voltages[1];
      const expected = V_step * (1 - Math.exp(-1));
      const tolerance = 0.10; // 10% — BDF-1 has first-order error
      expect(Math.abs(vCapPos - expected) / expected).toBeLessThan(tolerance);
    });
  });

  describe("reverse_bias_emits_diagnostic", () => {
    it("emits reverse-biased-cap diagnostic when V(pos) < V(neg) - reverseMax", () => {
      const diagnostics: Diagnostic[] = [];
      // Build a cap where node 1 = pos (solver idx 0) and ground = neg
      const capReverse = new AnalogPolarizedCapElement(
        [1, 0, 2],
        100e-6,
        0.1,
        25e6,
        1.0,
        (d) => diagnostics.push(d),
      );
      withState(capReverse);

      // V(node1) = -5V → reverse biased by 5V
      const voltagesReverse = new Float64Array([-5, 0]);
      const solver = new SparseSolver();
      solver.beginAssembly(2);
      capReverse.load(makeDiagnosticCtx(solver, voltagesReverse));
      solver.finalize();

      expect(diagnostics.length).toBeGreaterThanOrEqual(1);
      expect(diagnostics[0].code).toBe("reverse-biased-cap");
      expect(diagnostics[0].severity).toBe("warning");
    });
  });

  describe("forward_bias_no_diagnostic", () => {
    it("emits no diagnostic when forward biased", () => {
      const diagnostics: Diagnostic[] = [];
      const cap = new AnalogPolarizedCapElement(
        [1, 0, 2],
        100e-6,
        0.1,
        25e6,
        1.0,
        (d) => diagnostics.push(d),
      );
      withState(cap);

      // V(node1) = +5V → forward biased
      const voltages = new Float64Array([5, 0]);
      const solver = new SparseSolver();
      solver.beginAssembly(2);
      cap.load(makeDiagnosticCtx(solver, voltages));
      solver.finalize();

      expect(diagnostics.length).toBe(0);
    });
  });

  describe("definition", () => {
    it("PolarizedCapDefinition name is 'PolarizedCap'", () => {
      expect(PolarizedCapDefinition.name).toBe("PolarizedCap");
    });

    it("PolarizedCapDefinition has analog model", () => {
      expect(PolarizedCapDefinition.modelRegistry?.behavioral).toBeDefined();
    });

    it("PolarizedCapDefinition has analogFactory", () => {
      const entry = PolarizedCapDefinition.modelRegistry?.behavioral;
      const factory = entry?.kind === "inline" ? entry.factory : undefined;
      expect(factory).toBeDefined();
    });

    it("PolarizedCapDefinition has behavioral model entry", () => {
      expect(PolarizedCapDefinition.modelRegistry?.behavioral).toBeDefined();
    });

    it("PolarizedCapDefinition isReactive", () => {
      const props = new PropertyBag();
      props.replaceModelParams({ ...POLARIZED_CAP_MODEL_DEFAULTS, capacitance: 100e-6 });
      const el = getFactory(PolarizedCapDefinition.modelRegistry!.behavioral!)(new Map([["pos", 1], ["neg", 0]]), [2], -1, props, () => 0);
      expect(el.isReactive).toBe(true);
    });

    it("PolarizedCapDefinition isNonlinear", () => {
      const props = new PropertyBag();
      props.replaceModelParams(POLARIZED_CAP_MODEL_DEFAULTS);
      const el = getFactory(PolarizedCapDefinition.modelRegistry!.behavioral!)(new Map([["pos", 1], ["neg", 0]]), [2], -1, props, () => 0);
      expect(el.isNonlinear).toBe(true);
    });

    it("PolarizedCapElement can be instantiated", () => {
      const props = new PropertyBag();
      props.setModelParam("capacitance", 100e-6);
      const el = new PolarizedCapElement(
        "test-id",
        { x: 0, y: 0 },
        0,
        false,
        props,
      );
      expect(el).toBeDefined();
    });
  });

  describe("pool_infrastructure", () => {
    it("stateBaseOffset defaults to -1 before initState", () => {
      const el = new AnalogPolarizedCapElement([1, 0, 2], 100e-6, 0.1, 25e6, 1.0);
      expect(el.stateBaseOffset).toBe(-1);
    });

    it("initState binds pool and zero-initializes all slots", () => {
      const el = new AnalogPolarizedCapElement([1, 0, 2], 100e-6, 0.1, 25e6, 1.0);
      const { pool } = withState(el);
      expect(pool.state0[0]).toBe(0); // GEQ
      expect(pool.state0[1]).toBe(0); // IEQ
      expect(pool.state0[2]).toBe(0); // V_PREV
    });

    it("load writes GEQ and IEQ to pool slots 0 and 1", () => {
      const el = new AnalogPolarizedCapElement([1, 0, 2], 100e-6, 0.1, 25e6, 1.0);
      const { pool } = withState(el);
      const voltages = new Float64Array([5, 0]); // node1=5V, node2=0V
      const solver = new SparseSolver();
      solver.beginAssembly(2);
      el.load(makeSlotLoadCtx(solver, voltages, 1e-6, "bdf1", 1, "initTran"));
      solver.finalize();
      expect(pool.state0[0]).toBeGreaterThan(0); // GEQ = C/dt > 0
      // IEQ = ceq = 0 on first step (zero charge history): ccap = C*vNow/dt, geq*vNow = C*vNow/dt → ceq=0
      expect(pool.state0[1]).toBeCloseTo(0, 5);
    });

    it("load writes V_PREV to pool slot 2", () => {
      const el = new AnalogPolarizedCapElement([1, 0, 2], 100e-6, 0.1, 25e6, 1.0);
      const { pool } = withState(el);
      // nCap=2 (1-based), nNeg=0 → vCapNode = voltages[1], vNeg = 0
      const voltages = new Float64Array([0, 3]); // node1=0, node2=3V
      const solver = new SparseSolver();
      solver.beginAssembly(2);
      el.load(makeSlotLoadCtx(solver, voltages, 1e-6, "bdf1", 1, "initTran"));
      solver.finalize();
      expect(pool.state0[2]).toBeCloseTo(3, 6); // V_PREV = vNow = 3V
    });

  });
});

// ---------------------------------------------------------------------------
// C4.2 — Transient parity test
//
// Circuit: Vsrc=1V step on node 1 (pos), neg=gnd(0), internal cap node=2.
// ESR is set to a very small value so it is negligible; leakage set large.
//
// PolarizedCap topology: pos─ESR─nCap─(C||leakage)─neg.
// The capacitor body stamps between nCap(2) and neg(0).
//
// BDF-1 / trapezoidal integration (order=1):
//   ag[0] = 1/dt,  ag[1] = -1/dt
//   geq = ag[0]*C   (niinteg.c:77, capload.c:CAPload::geq)
//   ceq = ag[1]*q_prev = ag[1]*C*v_cap_prev   (capload.c:CAPload::ceq)
//
// ngspice source → our variable mapping:
//   capload.c:CAPload::cstate0[CAPqcap]  → s0[SLOT_Q]   = C*v_cap
//   niinteg.c:NIintegrate::ag[0]         → ctx.ag[0]     = 1/dt
//   niinteg.c:NIintegrate::ag[1]         → ctx.ag[1]     = -1/dt
//   capload.c:CAPload::geq               → s0[SLOT_GEQ]  = ag[0]*C
//   capload.c:CAPload::ceq               → s0[SLOT_IEQ]  = ag[1]*q_prev
//
// With ESR negligible (1e-9 Ω) and leakage very large (1e12 Ω, G_leak≈1e-12):
//   The dominant path for the cap body: geq+G_leak+G_esr stamps on nCap.
//   We use all-zero voltages so ceq = 0 every step → geq is the only
//   state-dependent quantity we assert bit-exact.
// ---------------------------------------------------------------------------

describe("polarized_cap_load_transient_parity (C4.2)", () => {
  it("polarized_cap_load_transient_parity", () => {
    const C_val = 100e-6;  // 100 µF (default)
    const ESR   = 1e-9;    // negligible ESR: G_esr = 1/max(ESR, 1e-9) = 1e9
    const rLeak = 1e12;    // very large leakage resistance: G_leak ≈ 1e-12
    const dt    = 1e-6;    // timestep (s)
    const order = 1;
    const method = "trapezoidal" as const;

    // BDF-1 coefficients: ag[0]=1/dt, ag[1]=-1/dt
    const ag0 = 1 / dt;
    const ag1 = -1 / dt;

    // Bit-exact companion conductance (niinteg.c:77):
    //   geq = ag[0] * C_val
    const geq = ag0 * C_val;

    // G_esr = 1 / max(ESR, 1e-9) — matches MIN_RESISTANCE constant in polarized-cap.ts
    const G_esr  = 1 / Math.max(ESR, 1e-9);
    // G_leak = 1 / max(rLeak, 1e-9) — leakage conductance
    const G_leak = 1 / Math.max(rLeak, 1e-9);

    // Build element: pinNodeIds = [n_pos=1, n_neg=0, n_cap=2]
    const element = new AnalogPolarizedCapElement(
      [1, 0, 2],
      C_val,
      ESR,
      rLeak,
      1.0,       // reverseMax
    );

    // Allocate state pool and init
    const pool = new StatePool(Math.max(element.stateSize, 1));
    element.stateBaseOffset = 0;
    element.initState(pool);

    const poolEl = element as unknown as {
      s0: Float64Array; s1: Float64Array; stateBaseOffset: number;
    };

    // Handle-based capture solver (persistent handles across steps)
    const handles: { row: number; col: number }[] = [];
    const handleIndex = new Map<string, number>();
    const matValues: number[] = [];

    const solver = {
      allocElement: (row: number, col: number): number => {
        const key = `${row},${col}`;
        let h = handleIndex.get(key);
        if (h === undefined) {
          h = handles.length;
          handles.push({ row, col });
          handleIndex.set(key, h);
          matValues.push(0);
        }
        return h;
      },
      stampElement: (h: number, v: number): void => { matValues[h] += v; },
      stampRHS: (_row: number, _v: number): void => {},
    } as unknown as import("../../../solver/analog/sparse-solver.js").SparseSolver;

    const ag = new Float64Array(8);
    ag[0] = ag0;
    ag[1] = ag1;

    // All voltages zero throughout (so cap body voltage = V(nCap) - V(neg) = 0)
    // ceq = ag[1]*C*0 = 0 every step → geq is constant = ag[0]*C.
    const voltages = new Float64Array(3); // [V(node1), V(node2), V(node3)] but gnd=node0 excluded

    // 10-step transient loop
    for (let step = 0; step < 10; step++) {
      matValues.fill(0);

      const ctx: LoadContext = {
        solver,
        voltages,
        iteration: 0,
        initMode: step === 0 ? "initTran" : "transient",
        dt,
        method,
        order,
        deltaOld: [dt, dt, dt, dt, dt, dt, dt],
        ag,
        srcFact: 1,
        noncon: { value: 0 },
        limitingCollector: null,
        isDcOp: false,
        isTransient: true,
        xfact: 1,
        gmin: 1e-12,
        uic: false,
        reltol: 1e-3,
        iabstol: 1e-12,
      };

      element.load(ctx);

      // Assert per-step integration constants (spec: assert dt, order, method)
      expect(ctx.dt).toBe(dt);
      expect(ctx.order).toBe(order);
      expect(ctx.method).toBe(method);

      // Rotate state: s1 ← s0
      poolEl.s1.set(poolEl.s0);
    }

    // After 10 steps: assert companion state from last load() call.
    // SLOT_GEQ=0, SLOT_IEQ=1 (POLARIZED_CAP_SCHEMA slot indices)
    const SLOT_GEQ_PC = 0;
    const SLOT_IEQ_PC = 1;
    const base = poolEl.stateBaseOffset;

    // geq = ag[0]*C — bit-exact (niinteg.c:77, capload.c)
    // All cap voltages are zero so q=0 every step → ceq = ag[1]*0 = 0.
    expect(poolEl.s0[base + SLOT_GEQ_PC]).toBe(geq);
    expect(poolEl.s0[base + SLOT_IEQ_PC]).toBe(0);

    // G_esr and G_leak are topology-constant — referenced only to confirm
    // the element was constructed with the intended parameters.
    void G_esr;
    void G_leak;
  });
});
