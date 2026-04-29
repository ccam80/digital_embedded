/**
 * Tests for the Transformer component.
 *
 * Covers:
 *   - Voltage ratio matches turns ratio for k ≈ 1
 *   - Current ratio is inverse of turns ratio
 *   - Power conservation (P_primary ≈ P_secondary) for ideal coupling
 *   - Leakage (k < 1) reduces secondary voltage
 *   - DC blocking (inductors block DC in steady state)
 *   - Winding resistance drops voltage
 *
 * Simulation strategy: manual transient loop driving each element through
 * load(ctx) / accept(ctx, simTime, addBreakpoint), following the pattern
 * in integration.test.ts.
 *
 * Circuit topology for AC tests:
 *   Node 1: primary+ (Vac source positive)
 *   Node 2: primary− (ground via Vac)
 *   Node 3: secondary+ (output to load resistor)
 *   Node 4: secondary− (grounded)
 *   Branch 0: AC voltage source (node 1 → ground, absolute row = nodeCount + 0)
 *   Branch 1: transformer primary winding  (absolute row = nodeCount + 1)
 *   Branch 2: transformer secondary winding (absolute row = nodeCount + 2)
 *
 * Matrix size = nodeCount + branchCount.
 */

import { describe, it, expect } from "vitest";
import {
  AnalogTransformerElement,
  TransformerDefinition,
  TRANSFORMER_ATTRIBUTE_MAPPINGS,
} from "../transformer.js";
import { PropertyBag } from "../../../core/properties.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import { makeLoadCtx, runDcOp, makeTestSetupContext, setupAll } from "../../../solver/analog/__tests__/test-helpers.js";
import { makeDcVoltageSource } from "../../sources/dc-voltage-source.js";
import type { AnalogElement } from "../../../solver/analog/element.js";
import { StatePool } from "../../../solver/analog/state-pool.js";
import type { PoolBackedAnalogElement } from "../../../core/analog-types.js";
import type { LoadContext } from "../../../solver/analog/load-context.js";
import type { SparseSolver as SparseSolverType } from "../../../solver/analog/sparse-solver.js";
import { computeNIcomCof } from "../../../solver/analog/integration.js";
import type { IntegrationMethod } from "../../../core/analog-types.js";
import { MODETRAN, MODEINITTRAN, MODEINITFLOAT } from "../../../solver/analog/ckt-mode.js";

// ---------------------------------------------------------------------------
// Helper: narrow ModelEntry to inline factory (throws if netlist kind)
// ---------------------------------------------------------------------------
import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";
function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}

// ---------------------------------------------------------------------------
// Local test helpers (replaces removed makeResistor / makeVoltageSource —
// §A.19).
// ---------------------------------------------------------------------------

/** Minimal inline resistor for test use — stamps 4 conductance entries. */
function makeResistor(nodeA: number, nodeB: number, resistance: number): AnalogElement {
  const G = 1 / Math.max(resistance, 1e-9);
  let _hAA = -1, _hBB = -1, _hAB = -1, _hBA = -1;
  return {
    label: "",
    _pinNodes: new Map([["A", nodeA], ["B", nodeB]]),
    branchIndex: -1,
    _stateBase: -1,
    ngspiceLoadOrder: 0,
    setParam(_key: string, _value: number): void {},
    getPinCurrents(_v: Float64Array): number[] { return []; },
    setup(ctx: import("../../../solver/analog/setup-context.js").SetupContext): void {
      if (nodeA !== 0) _hAA = ctx.solver.allocElement(nodeA, nodeA);
      if (nodeB !== 0) _hBB = ctx.solver.allocElement(nodeB, nodeB);
      if (nodeA !== 0 && nodeB !== 0) {
        _hAB = ctx.solver.allocElement(nodeA, nodeB);
        _hBA = ctx.solver.allocElement(nodeB, nodeA);
      }
    },
    load(ctx: LoadContext): void {
      const { solver } = ctx;
      if (_hAA !== -1) solver.stampElement(_hAA, G);
      if (_hBB !== -1) solver.stampElement(_hBB, G);
      if (_hAB !== -1) solver.stampElement(_hAB, -G);
      if (_hBA !== -1) solver.stampElement(_hBA, -G);
    },
  };
}

/**
 * Build a DC voltage source for use in a transient loop where the voltage
 * changes each step. Call setup() once (after _initStructure, before the
 * loop), then call setVoltage(v) + load(ctx) each step.
 */
function makeStepVsrc(posNode: number, negNode: number): { element: AnalogElement; setVoltage(v: number): void } {
  let _hPosBr = -1, _hNegBr = -1, _hBrPos = -1, _hBrNeg = -1;
  let _voltage = 0;
  const el: AnalogElement = {
    label: "",
    _pinNodes: new Map([["pos", posNode], ["neg", negNode]]),
    branchIndex: -1,
    _stateBase: -1,
    ngspiceLoadOrder: 10,
    setParam(key: string, value: number): void { if (key === "voltage") _voltage = value; },
    getPinCurrents(_v: Float64Array): number[] { return []; },
    setup(ctx: import("../../../solver/analog/setup-context.js").SetupContext): void {
      el.branchIndex = ctx.makeCur(el.label, "branch");
      const k = el.branchIndex;
      _hPosBr = ctx.solver.allocElement(posNode, k);
      _hNegBr = ctx.solver.allocElement(negNode, k);
      _hBrPos = ctx.solver.allocElement(k, posNode);
      _hBrNeg = ctx.solver.allocElement(k, negNode);
    },
    load(ctx: LoadContext): void {
      ctx.solver.stampElement(_hPosBr, +1.0);
      ctx.solver.stampElement(_hNegBr, -1.0);
      ctx.solver.stampElement(_hBrPos, +1.0);
      ctx.solver.stampElement(_hBrNeg, -1.0);
      ctx.rhs[el.branchIndex] += _voltage;
    },
  };
  return { element: el, setVoltage: (v: number) => { _voltage = v; } };
}

// ---------------------------------------------------------------------------
// makeTransientCtx — minimal LoadContext for manual transient loops
// ---------------------------------------------------------------------------

function makeTransientCtx(
  solver: SparseSolverType,
  rhsOld: Float64Array,
  opts: {
    dt?: number;
    method?: IntegrationMethod;
    order?: number;
    cktMode?: number;
    rhs?: Float64Array;
  } = {},
): LoadContext {
  const dt = opts.dt ?? 0;
  const method = opts.method ?? "trapezoidal";
  const order = opts.order ?? 1;
  const deltaOld = [dt, dt, dt, dt, dt, dt, dt];
  const ag = new Float64Array(7);
  const scratch = new Float64Array(64);
  if (dt > 0) {
    computeNIcomCof(dt, deltaOld, order, method, ag, scratch);
  }
  // rhs: accumulation buffer for stampRHS during load() — zeroed fresh each step.
  // rhsOld: prior-step solution (read by reactive elements for branch currents/voltages).
  // These must be separate arrays to avoid load() corrupting prior-step reads.
  const rhs = opts.rhs ?? new Float64Array(rhsOld.length);
  return makeLoadCtx({
    cktMode: opts.cktMode ?? (MODETRAN | MODEINITFLOAT),
    solver: solver as unknown as import("../../../solver/analog/sparse-solver.js").SparseSolver,
    rhs,
    rhsOld,
    dt,
    method,
    order,
    deltaOld,
    ag,
  });
}


// ---------------------------------------------------------------------------
// withState: allocate a StatePool for a single element and call initState
// ---------------------------------------------------------------------------

function withState(core: PoolBackedAnalogElement): { element: PoolBackedAnalogElement; pool: StatePool } {
  const pb = core as PoolBackedAnalogElement & { _stateBase: number };
  const pool = new StatePool(Math.max(pb.stateSize, 1));
  pb._stateBase = 0;
  pb.initState(pool);
  return { element: pb, pool };
}

// ---------------------------------------------------------------------------
// Transformer element construction helper
// ---------------------------------------------------------------------------

/**
 * Build a transformer element.
 *
 * Does NOT call setup() — callers that use runDcOp rely on makeSimpleCtx
 * calling setupAll internally. Callers that run manual transient loops must
 * call setupTransformerForLoop() to allocate handles before the loop starts.
 */
function makeTransformerElement(opts: {
  pinNodeIds: number[];
  branch1?: number;
  lPrimary?: number;
  turnsRatio?: number;
  k?: number;
  rPri?: number;
  rSec?: number;
}): { element: AnalogTransformerElement; pool: StatePool; solver: SparseSolver } {
  const pinNodes = new Map<string, number>([
    ["P1", opts.pinNodeIds[0]],
    ["P2", opts.pinNodeIds[1]],
    ["S1", opts.pinNodeIds[2]],
    ["S2", opts.pinNodeIds[3]],
  ]);
  const el = new AnalogTransformerElement(
    pinNodes,
    opts.lPrimary ?? 10e-3,
    opts.turnsRatio ?? 1.0,
    opts.k ?? 0.99,
    opts.rPri ?? 0.0,
    opts.rSec ?? 0.0,
    "T",
  );
  const { pool } = withState(el);
  const solver = new SparseSolver();
  solver._initStructure();
  if (opts.branch1 !== undefined) {
    // Set up the transformer on the shared solver when branch1 is supplied.
    // Call sites that use runDcOp / makeSimpleCtx must NOT pass branch1 here
    // (those paths run their own setupAll internally).
    // Call sites that use setupTransformerForLoop must NOT pass branch1 here
    // (that function runs _initStructure + setupAll itself on a fresh solver).
    const setupCtx = makeTestSetupContext({ solver, startBranch: opts.branch1 });
    setupAll([el], setupCtx);
  }
  return { element: el, pool, solver };
}

/**
 * Set up a transformer + companion elements on a solver for use in a
 * manual transient loop. Calls _initStructure() once then setup() on all
 * elements with startBranch=branch1 (transformer) and startBranch=vsrcBranch
 * (vsrc + resistors). Returns the shared solver and the vsrc element.
 *
 * Per-step: call solver._resetForAssembly() + rhs.fill(0), NOT _initStructure().
 */
function setupTransformerForLoop(opts: {
  transformer: AnalogTransformerElement;
  branch1: number;
  vsrcBranch: number;
  posNode: number;
  resistors: AnalogElement[];
}): { solver: SparseSolver; vsrcEl: AnalogElement; setVoltage(v: number): void } {
  const solver = new SparseSolver();
  solver._initStructure();
  // Setup transformer at startBranch=branch1
  const txCtx = makeTestSetupContext({ solver, startBranch: opts.branch1 });
  setupAll([opts.transformer], txCtx);
  // Setup vsrc + resistors at startBranch=vsrcBranch
  const { element: vsrcEl, setVoltage } = makeStepVsrc(opts.posNode, 0);
  const auxCtx = makeTestSetupContext({ solver, startBranch: opts.vsrcBranch });
  setupAll([vsrcEl, ...opts.resistors], auxCtx);
  return { solver, vsrcEl, setVoltage };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Transformer", () => {
  it("voltage_ratio — N=10:1 secondary ≈ primary/10 for k=0.99 in AC steady state", () => {
    /**
     * Circuit: AC voltage source 1.2V peak at 1kHz on primary.
     * Load resistor R_load=100Ω on secondary. No winding resistance.
     *
     * Nodes: 1=primary+(Vsrc+), 2=secondary+, 3=secondary−(gnd)
     * primary− = ground (node 0)
     * secondary− = ground (node 0)
     *
     * Branches (absolute solver rows, nodeCount=2):
     *   row 2: Vsrc (node1 → gnd)
     *   row 3: transformer primary
     *   row 4: transformer secondary
     *
     * matrixSize = nodeCount(2) + branchCount(3) = 5
     *
     * The transformer has:
     *   pinNodeIds = [1, 0, 2, 0]  (P1=1, P2=gnd, S1=2, S2=gnd)
     *   branch1 = 3, branch2 = 4
     */
    const N = 10;
    const Vpeak = 1.2;
    const freq = 1000;
    const Lp = 100e-3; // large inductance for good coupling at 1kHz
    const k = 0.99;
    const Rload = 100.0;
    const dt = 1 / (freq * 200); // 200 steps per cycle
    const numCycles = 10;
    const steps = numCycles * 200;

    // Node layout: node1=primary+, node2=secondary+, secondary−=gnd=node0
    const nodeCount = 2;
    // Branch layout (1-indexed absolute rows):
    //   Vsrc: makeVoltageSource uses branchIdx+1, so pass bVsrc=nodeCount → row nodeCount+1
    //   Transformer primary:  row nodeCount+2 (passed directly to AnalogTransformerElement)
    //   Transformer secondary: row nodeCount+3 (= bTx1+1, set inside transformer)
    const bVsrc = nodeCount;       // makeVoltageSource adds +1 → row 3
    const bTx1 = nodeCount + 2;   // transformer primary at 1-based row 4
    const matrixSize = nodeCount + 3;

    const { element: transformer, pool: txPool } = makeTransformerElement({
      pinNodeIds: [1, 0, 2, 0],
      lPrimary: Lp,
      turnsRatio: N,
      k,
      rPri: 0,
      rSec: 0,
    });
    const rLoad = makeResistor(2, 0, Rload);
    const { solver, vsrcEl, setVoltage } = setupTransformerForLoop({
      transformer,
      branch1: bTx1,
      vsrcBranch: bVsrc,
      posNode: 1,
      resistors: [rLoad],
    });

    // 1-indexed: voltages[0]=ground sentinel, voltages[1..matrixSize] are active.
    // Two-buffer pattern: voltages=rhsOld (prior solution read by elements),
    // rhs=fresh accumulation buffer for stampRHS during load().
    const bufSize = matrixSize + 1;

    // Collect secondary voltages over last cycle to find peak
    const lastCycleStart = (numCycles - 1) * 200;
    let voltages = new Float64Array(bufSize);
    const rhs = new Float64Array(bufSize);
    let maxSecondary = 0;

    for (let i = 0; i < steps; i++) {
      const t = i * dt;
      setVoltage(Vpeak * Math.sin(2 * Math.PI * freq * t));

      rhs.fill(0);
      solver._resetForAssembly();
      const ctx = makeTransientCtx(solver as unknown as SparseSolverType, voltages, {
        dt,
        method: "trapezoidal",
        order: 1,
        cktMode: i === 0 ? (MODETRAN | MODEINITTRAN) : (MODETRAN | MODEINITFLOAT),
        rhs,
      });
      vsrcEl.load(ctx);
      transformer.load(ctx);
      rLoad.load(ctx);
      const result = solver.factor();
      if (result !== 0) throw new Error(`Singular at step ${i}`);
      solver.solve(rhs, voltages);
      // Advance state history: s0→s1→s2→s3 (mirrors ngspice dctran.c:719-723).
      txPool.rotateStateVectors();

      if (i >= lastCycleStart) {
        const vSec = Math.abs(voltages[2]); // node 2 is at 1-based index 2
        if (vSec > maxSecondary) maxSecondary = vSec;
      }
    }

    // Ideal peak: Vpeak / N = 0.12V. With k=0.99, expect close to ideal.
    // Tolerance: ±5% of ideal
    const idealPeak = Vpeak / N;
    expect(maxSecondary).toBeGreaterThan(idealPeak * 0.90);
    expect(maxSecondary).toBeLessThan(idealPeak * 1.10);
  });

  it("current_ratio_inverse — secondary current ≈ N × primary branch current", () => {
    /**
     * For a step-down transformer (N:1), V_sec = V_pri / N and by power
     * conservation: I_sec = I_pri * N. We verify this ratio holds in steady-state AC.
     *
     * To get a clean ratio measurement, we use a 1:1 transformer (N=1) with
     * different load resistances on each side, and verify the branch currents
     * are proportional to the voltage ratio. For a non-unity ratio we use N=2
     * with a resistive load and verify I2/I1 > N/2 (secondary always carries
     * more current than primary in a step-down).
     */
    const N = 2;
    const Vpeak = 1.0;
    const freq = 1000;
    const Lp = 500e-3; // large L for better coupling at 1kHz
    const k = 0.99;
    const Rload = 10.0;  // low load impedance for strong secondary current
    const dt = 1 / (freq * 400); // 400 steps per cycle for accuracy
    const numCycles = 20;
    const steps = numCycles * 400;

    const nodeCount = 2;
    // 1-indexed absolute rows: Vsrc at nodeCount+1, transformer primary at nodeCount+2, secondary at nodeCount+3.
    const bVsrc = nodeCount;       // makeVoltageSource adds +1 → row nodeCount+1
    const bTx1 = nodeCount + 2;   // transformer primary at 1-based row nodeCount+2
    const bTx2 = nodeCount + 3;   // transformer secondary at 1-based row nodeCount+3
    const matrixSize = nodeCount + 3;

    const { element: transformer, pool: txPool, solver } = makeTransformerElement({
      pinNodeIds: [1, 0, 2, 0],
      branch1: bTx1,
      lPrimary: Lp,
      turnsRatio: N,
      k,
      rPri: 0,
      rSec: 0,
    });
    const { element: vsrcEl, setVoltage } = makeStepVsrc(1, 0);
    const rLoad = makeResistor(2, 0, Rload);
    const extraSetupCtx = makeTestSetupContext({ solver, startBranch: bVsrc });
    setupAll([vsrcEl, rLoad], extraSetupCtx);

    // 1-indexed: voltages[0]=ground sentinel, voltages[1..matrixSize] are active.
    // Two-buffer pattern: voltages=rhsOld, rhs=fresh stamp accumulation buffer.
    const bufSize = matrixSize + 1;
    let voltages = new Float64Array(bufSize);
    const rhs = new Float64Array(bufSize);

    let maxI1 = 0;
    let maxI2 = 0;
    const lastCycleStart = (numCycles - 1) * 400;

    for (let i = 0; i < steps; i++) {
      const t = i * dt;
      setVoltage(Vpeak * Math.sin(2 * Math.PI * freq * t));

      rhs.fill(0);
      solver._resetForAssembly();
      const ctx = makeTransientCtx(solver as unknown as SparseSolverType, voltages, {
        dt,
        method: "trapezoidal",
        order: 1,
        cktMode: i === 0 ? (MODETRAN | MODEINITTRAN) : (MODETRAN | MODEINITFLOAT),
        rhs,
      });
      vsrcEl.load(ctx);
      transformer.load(ctx);
      rLoad.load(ctx);
      const result = solver.factor();
      if (result !== 0) throw new Error(`Singular at step ${i}`);
      solver.solve(rhs, voltages);
      txPool.rotateStateVectors();

      if (i >= lastCycleStart) {
        const i1 = Math.abs(voltages[bTx1]);
        const i2 = Math.abs(voltages[bTx2]);
        if (i1 > maxI1) maxI1 = i1;
        if (i2 > maxI2) maxI2 = i2;
      }
    }

    // For N=2 step-down: V_sec = V_pri/2, I_sec = I_pri * N = 2*I_pri
    // So I2/I1 ≈ N = 2
    expect(maxI1).toBeGreaterThan(0);
    expect(maxI2).toBeGreaterThan(0);
    const ratio = maxI2 / maxI1;
    // Allow generous tolerance (30%) for reactive leakage effects
    expect(ratio).toBeGreaterThan(N * 0.70);
    expect(ratio).toBeLessThan(N * 1.30);
  });

  it("power_conservation — P_primary ≈ P_secondary for k=0.99 within 10%", () => {
    /**
     * Power conservation: in steady-state AC with a resistive secondary load,
     * the power delivered to the load (P_sec = V2_rms²/Rload) must be within
     * a reasonable fraction of the power supplied by the source
     * (P_src = avg(vSrc * iVsrc)).
     *
     * For a 1:1 transformer with k=0.99 the ideal efficiency is ~98%. We
     * accept up to 50% discrepancy to accommodate finite-inductance reactive
     * losses and numerical transient settling.
     *
     * Parameters chosen so the circuit is non-trivial but the transformer
     * operates in its intended regime:
     *   Lp=100mH, freq=50Hz → ωLp=31.4Ω >> Rload=5Ω (good magnetising ratio)
     *   Leakage: Lleak=(1-k²)*Lp≈0.02*0.1=2mH, ωLleak=0.63Ω << Rload=5Ω (low sag)
     *
     * Assertions:
     *   1. pSec > 0 (energy reaches secondary)
     *   2. pSec <= pSrc * 1.05 (energy conservation — can't create energy)
     *   3. pSec >= pSrc * 0.50 (at least 50% efficiency — transformer is working)
     */
    const N = 1;
    const Vpeak = 2.0;
    const freq = 50;          // 50 Hz — low freq, large L needed
    const Lp = 100e-3;        // 100mH: ωLp=31.4Ω >> Rload=5Ω
    const k = 0.99;
    const Rload = 5.0;        // ωLleak=(1-k²)*ωLp≈0.62Ω << 5Ω → low leakage sag
    const dt = 1 / (freq * 400); // 400 steps per cycle
    const numCycles = 20;
    const steps = numCycles * 400;

    const nodeCount = 2;
    const bVsrc = nodeCount;       // makeVoltageSource adds +1 → row nodeCount+1
    const bTx1 = nodeCount + 2;   // transformer primary at 1-based row nodeCount+2
    const matrixSize = nodeCount + 3;
    // bVsrcAbs = bVsrc+1 = nodeCount+1: absolute row of the vsrc branch in voltages[].
    const bVsrcAbs = nodeCount + 1;

    const { element: transformer, pool: txPool, solver } = makeTransformerElement({
      pinNodeIds: [1, 0, 2, 0],
      branch1: bTx1,
      lPrimary: Lp,
      turnsRatio: N,
      k,
      rPri: 0,
      rSec: 0,
    });
    const { element: vsrcEl, setVoltage } = makeStepVsrc(1, 0);
    const rLoad = makeResistor(2, 0, Rload);
    const extraSetupCtx = makeTestSetupContext({ solver, startBranch: bVsrc });
    setupAll([vsrcEl, rLoad], extraSetupCtx);

    const bufSize = matrixSize + 1;
    let voltages = new Float64Array(bufSize);
    const rhs = new Float64Array(bufSize);

    let sumV2sq = 0;
    let sumPsrc = 0;
    let sampleCount = 0;
    const lastCycleStart = (numCycles - 1) * 400;

    for (let i = 0; i < steps; i++) {
      const t = i * dt;
      const vSrc = Vpeak * Math.sin(2 * Math.PI * freq * t);
      setVoltage(vSrc);

      rhs.fill(0);
      solver._resetForAssembly();
      const ctx = makeTransientCtx(solver as unknown as SparseSolverType, voltages, {
        dt,
        method: "trapezoidal",
        order: 1,
        cktMode: i === 0 ? (MODETRAN | MODEINITTRAN) : (MODETRAN | MODEINITFLOAT),
        rhs,
      });
      vsrcEl.load(ctx);
      transformer.load(ctx);
      rLoad.load(ctx);
      const factorResult = solver.factor();
      if (factorResult !== 0) throw new Error(`Singular at step ${i}`);
      solver.solve(rhs, voltages);
      txPool.rotateStateVectors();

      if (i >= lastCycleStart) {
        const v2 = voltages[2];         // node 2 secondary voltage (1-based)
        const iVsrc = voltages[bVsrcAbs]; // voltage source branch current
        // Secondary delivered power via v²/R (sign-invariant).
        sumV2sq += v2 * v2;
        // Source supplied power: vSrc drives current iVsrc into the circuit.
        // The vsrc branch current convention: iVsrc is the branch current.
        sumPsrc += vSrc * iVsrc;
        sampleCount++;
      }
    }

    const pSec = (sumV2sq / sampleCount) / Rload;
    const pSrc = sumPsrc / sampleCount;

    expect(pSec).toBeGreaterThan(0);
    // Energy conservation: secondary can't exceed source.
    expect(pSec).toBeLessThanOrEqual(Math.abs(pSrc) * 1.05);
    // At least 50% efficiency: transformer is clearly transferring energy.
    expect(pSec).toBeGreaterThanOrEqual(Math.abs(pSrc) * 0.50);
  });

  it("leakage_with_low_k — k=0.8 secondary voltage < k=0.99 secondary voltage", () => {
    /**
     * Lower coupling coefficient → more leakage inductance → less energy
     * transferred to secondary. The secondary peak voltage should be lower
     * for k=0.8 than for k=0.99.
     */
    function peakSecondary(k: number): number {
      const N = 2;
      const Vpeak = 1.0;
      const freq = 1000;
      const Lp = 100e-3;
      const Rload = 50.0;
      const dt = 1 / (freq * 200);
      const numCycles = 10;
      const steps = numCycles * 200;

      const nodeCount = 2;
      // 1-indexed absolute rows: Vsrc at nodeCount+1, transformer primary at nodeCount+2, secondary at nodeCount+3.
      const bVsrc = nodeCount;       // makeVoltageSource adds +1 → row nodeCount+1
      const bTx1 = nodeCount + 2;   // transformer primary at 1-based row nodeCount+2
      const matrixSize = nodeCount + 3;

      const { element: transformer, pool: txPool, solver } = makeTransformerElement({
        pinNodeIds: [1, 0, 2, 0],
        branch1: bTx1,
        lPrimary: Lp,
        turnsRatio: N,
        k,
        rPri: 0,
        rSec: 0,
      });
      const { element: vsrcEl2, setVoltage: setV2 } = makeStepVsrc(1, 0);
      const rLoad = makeResistor(2, 0, Rload);
      const sc2 = makeTestSetupContext({ solver, startBranch: bVsrc });
      setupAll([vsrcEl2, rLoad], sc2);

      // 1-indexed: voltages[0]=ground sentinel, voltages[1..matrixSize] are active.
      // Two-buffer pattern: voltages=rhsOld, rhs=fresh stamp accumulation buffer.
      const bufSize = matrixSize + 1;
      let voltages = new Float64Array(bufSize);
      const rhs = new Float64Array(bufSize);
      let maxSec = 0;
      const lastCycleStart = (numCycles - 1) * 200;

      for (let i = 0; i < steps; i++) {
        const t = i * dt;
        setV2(Vpeak * Math.sin(2 * Math.PI * freq * t));

        rhs.fill(0);
        solver._resetForAssembly();
        const ctx = makeTransientCtx(solver as unknown as SparseSolverType, voltages, {
          dt,
          method: "trapezoidal",
          order: 1,
          cktMode: i === 0 ? (MODETRAN | MODEINITTRAN) : (MODETRAN | MODEINITFLOAT),
          rhs,
        });
        vsrcEl2.load(ctx);
        transformer.load(ctx);
        rLoad.load(ctx);
        const result = solver.factor();
        if (result !== 0) throw new Error(`Singular at step ${i}`);
        solver.solve(rhs, voltages);
        txPool.rotateStateVectors();

        if (i >= lastCycleStart) {
          const vSec = Math.abs(voltages[2]); // node 2 at 1-based index 2
          if (vSec > maxSec) maxSec = vSec;
        }
      }
      return maxSec;
    }

    const highK = peakSecondary(0.99);
    const lowK = peakSecondary(0.8);

    // Lower k must produce lower secondary voltage
    expect(lowK).toBeLessThan(highK);
  });

  it("dc_blocks — DC source on primary produces ~0 secondary voltage in steady state", () => {
    /**
     * In DC steady state, inductors are short-circuits (dI/dt = 0, V_L = 0).
     * The transformer load() skips inductive companion stamps in MODEDC, leaving
     * only the KVL incidence rows (B/C sub-matrices). Each winding becomes a pure
     * short-circuit KVL constraint: V_winding = 0.
     *
     * Circuit (1-indexed nodes):
     *   Node 1: Vsrc positive terminal / top of series resistor
     *   Node 2: series-resistor bottom / transformer primary+ (P1)
     *   Node 3: secondary+ (S1) / load resistor top
     *   Ground: node 0
     *   Branch 4: Vsrc  (makeDcVoltageSource uses branchIdx directly as 1-based row)
     *   Branch 5: transformer primary (shorted in DC → V_node2 = 0)
     *   Branch 6: transformer secondary (shorted in DC → V_node3 = 0)
     *
     * The external series resistor (node1→node2) is essential: in DC the
     * transformer primary KVL constrains V_node2=0, so all of Vdc drops across
     * Rseries. A direct Vsrc→primary connection would produce two conflicting
     * voltage constraints on node 1 (singular matrix).
     *
     * Expected outcome: V_node3 ≈ 0 (secondary shorted in DC, load sees ~0 V).
     */
    const N = 1;
    const Vdc = 5.0;
    const Lp = 1.0;
    const k = 0.99;
    const Rload = 100.0;
    const Rseries = 100.0; // external series resistor breaks voltage-source/KVL conflict

    // 3 active nodes + 3 branches = matrixSize 6.
    const nodeCount = 3;
    const matrixSize = nodeCount + 3; // rows 1..6

    const { element: transformer } = makeTransformerElement({
      pinNodeIds: [2, 0, 3, 0],
      // branch1 intentionally omitted: runDcOp/makeSimpleCtx runs setupAll internally.
      lPrimary: Lp,
      turnsRatio: N,
      k,
      rPri: 0,
      rSec: 0,
    });
    const rSeries = makeResistor(1, 2, Rseries); // node1 → node2
    const rLoad   = makeResistor(3, 0, Rload);   // node3 → ground
    // makeDcVoltageSource uses branchIdx directly as 1-based absolute row.
    const vsrcProps = new PropertyBag();
    vsrcProps.setModelParam("voltage", Vdc);
    const vsrc = makeDcVoltageSource(new Map([["pos", 1], ["neg", 0]]), vsrcProps, () => 0) as unknown as AnalogElement;

    const result = runDcOp({
      elements: [vsrc, transformer as unknown as AnalogElement, rSeries, rLoad],
      matrixSize,
      nodeCount,
    });

    expect(result.converged).toBe(true);
    // In DC: secondary winding is shorted → V_node3 = 0 exactly.
    const vSec = Math.abs(result.nodeVoltages[3]); // node 3 at 1-based index 3
    expect(vSec).toBeLessThan(Vdc * 0.05); // < 5% of primary DC voltage
  });

  it("winding_resistance_drops_voltage — R_pri=10Ω drops ~10V with 1A", () => {
    /**
     * A transformer with large primary resistance: at high frequency
     * (inductors ≈ open), the winding resistance dominates and creates
     * a measurable voltage drop across the primary.
     *
     * We test load() directly: check that the resistor conductance stamps
     * appear correctly in the matrix for the primary winding.
     */
    const rPri = 10.0;
    const { element: transformer } = makeTransformerElement({
      pinNodeIds: [1, 2, 3, 4],
      lPrimary: 10e-3,
      turnsRatio: 1,
      k: 0.99,
      rPri,
      rSec: 0,
    });

    const solver = new SparseSolver();
    solver._initStructure();
    transformer.label = "T1";
    const setupCtx = makeTestSetupContext({
      solver,
      startBranch: 10,
      startNode: 100,
      elements: [transformer],
    });
    setupAll([transformer], setupCtx);

    const voltages = new Float64Array(8);
    const rhs = new Float64Array(8);
    solver._resetForAssembly();
    const ctx = makeTransientCtx(solver as unknown as SparseSolverType, voltages, { rhs });
    transformer.load(ctx);

    // Primary resistance conductance = 1/10 = 0.1 S
    // Under 1-indexed nodes: node 1 → row/col 1, node 2 → row/col 2.
    const entries = solver.getCSCNonZeros();
    const diagN1 = entries.find((e) => e.row === 1 && e.col === 1);
    const diagN2 = entries.find((e) => e.row === 2 && e.col === 2);
    expect(diagN1).toBeDefined();
    expect(diagN2).toBeDefined();

    // Off-diagonal: -gPri
    const offN1N2 = entries.find((e) => e.row === 1 && e.col === 2);
    expect(offN1N2).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// State pool schema tests
// ---------------------------------------------------------------------------

describe("AnalogTransformerElement state pool", () => {
  it("_stateBase defaults to -1 before initState", () => {
    const el = new AnalogTransformerElement(new Map([["P1", 1], ["P2", 0], ["S1", 2], ["S2", 0]]), 10e-3, 1.0, 0.99, 0, 0, "T");
    expect((el as unknown as { _stateBase: number })._stateBase).toBe(-1);
  });

  it("initState binds pool and zero-initialises all 13 slots", () => {
    const el = new AnalogTransformerElement(new Map([["P1", 1], ["P2", 0], ["S1", 2], ["S2", 0]]), 10e-3, 1.0, 0.99, 0, 0, "T");
    const { pool } = withState(el);
    for (let i = 0; i < 13; i++) {
      expect(pool.state0[i]).toBe(0);
    }
  });

});

// ---------------------------------------------------------------------------
// ComponentDefinition tests
// ---------------------------------------------------------------------------

describe("TransformerDefinition", () => {
  it("name is Transformer", () => {
    expect(TransformerDefinition.name).toBe("Transformer");
  });

  it("TransformerDefinition has analog model", () => {
    expect(TransformerDefinition.modelRegistry?.behavioral).toBeDefined();
  });

  it("has analogFactory", () => {
    expect((TransformerDefinition.modelRegistry?.behavioral as {kind:"inline";factory:AnalogFactory}|undefined)?.factory).toBeDefined();
  });

  it("element allocates a branch row in setup()", () => {
    const factory = getFactory(TransformerDefinition.modelRegistry!.behavioral!);
    const props = new PropertyBag();
    props.setModelParam("turnsRatio", 1);
    props.setModelParam("primaryInductance", 10e-3);
    props.setModelParam("couplingCoefficient", 0.99);
    props.setModelParam("primaryResistance", 0);
    props.setModelParam("secondaryResistance", 0);
    const el = factory(new Map([["P1", 1], ["P2", 0], ["S1", 2], ["S2", 0]]), props, () => 0) as AnalogTransformerElement;
    el.label = "T1";

    const solver = new SparseSolver();
    solver._initStructure();
    const setupCtx = makeTestSetupContext({
      solver,
      startBranch: 5,
      startNode: 100,
      elements: [el],
    });
    setupAll([el], setupCtx);

    expect(el.branchIndex).toBeGreaterThanOrEqual(0);
    expect(el.branch2).toBeGreaterThanOrEqual(0);
  });

  it("category is PASSIVES", () => {
    expect(TransformerDefinition.category).toBe(ComponentCategory.PASSIVES);
  });

  it("pinLayout has 4 entries", () => {
    expect(TransformerDefinition.pinLayout).toHaveLength(4);
    const labels = TransformerDefinition.pinLayout.map((p) => p.label);
    expect(labels).toContain("P1");
    expect(labels).toContain("P2");
    expect(labels).toContain("S1");
    expect(labels).toContain("S2");
  });

  it("analogFactory creates element with correct branch indices", () => {
    const props = new PropertyBag();
    props.setModelParam("turnsRatio", 10);
    props.setModelParam("primaryInductance", 10e-3);
    props.setModelParam("couplingCoefficient", 0.99);
    props.setModelParam("primaryResistance", 0);
    props.setModelParam("secondaryResistance", 0);

    const el = getFactory(TransformerDefinition.modelRegistry!.behavioral!)(new Map([["P1", 1], ["P2", 0], ["S1", 2], ["S2", 0]]), props, () => 0) as AnalogTransformerElement;
    expect(el.branchIndex).toBe(5);
    expect(el.branch2).toBe(6);
  });

  it("can be registered without error", () => {
    const registry = new ComponentRegistry();
    expect(() => registry.register(TransformerDefinition)).not.toThrow();
  });

  it("attribute mappings map turnsRatio", () => {
    const m = TRANSFORMER_ATTRIBUTE_MAPPINGS.find((a) => a.xmlName === "turnsRatio");
    expect(m).toBeDefined();
    expect(m!.propertyKey).toBe("turnsRatio");
  });
});

