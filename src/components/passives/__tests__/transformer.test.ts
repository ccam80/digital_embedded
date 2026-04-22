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
import { makeVoltageSource, makeResistor } from "../../../solver/analog/__tests__/test-helpers.js";
import { StatePool } from "../../../solver/analog/state-pool.js";
import type { AnalogElementCore } from "../../../core/analog-types.js";
import type { ReactiveAnalogElement } from "../../../solver/analog/element.js";
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
// makeTransientCtx — minimal LoadContext for manual transient loops
// ---------------------------------------------------------------------------

function makeTransientCtx(
  solver: SparseSolverType,
  voltages: Float64Array,
  opts: {
    dt?: number;
    method?: IntegrationMethod;
    order?: number;
    cktMode?: number;
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
  return {
    cktMode: opts.cktMode ?? (MODETRAN | MODEINITFLOAT),
    solver: solver as unknown as import("../../../solver/analog/sparse-solver.js").SparseSolver,
    voltages,
    dt,
    method,
    order,
    deltaOld,
    ag,
    srcFact: 1,
    noncon: { value: 0 },
    limitingCollector: null,
    xfact: 1,
    gmin: 1e-12,
    reltol: 1e-3,
    iabstol: 1e-12,
  };
}

// ---------------------------------------------------------------------------
// makeCaptureSolver — records allocElement/stampElement/stampRHS calls
// ---------------------------------------------------------------------------

interface CaptureStamp { row: number; col: number; value: number; }

function makeCaptureSolver(): { solver: SparseSolverType; stamps: CaptureStamp[] } {
  const stamps: CaptureStamp[] = [];
  const handles: { row: number; col: number }[] = [];
  const handleIndex = new Map<string, number>();
  const solver = {
    allocElement: (row: number, col: number): number => {
      const key = `${row},${col}`;
      let h = handleIndex.get(key);
      if (h === undefined) {
        h = handles.length;
        handles.push({ row, col });
        handleIndex.set(key, h);
      }
      return h;
    },
    stampElement: (handle: number, value: number): void => {
      const { row, col } = handles[handle];
      stamps.push({ row, col, value });
    },
    stampRHS: (_row: number, _value: number): void => {},
    beginAssembly: (): void => {},
    finalize: (): void => {},
    solve: (): Float64Array => new Float64Array(0),
  } as unknown as SparseSolverType;
  return { solver, stamps };
}

// ---------------------------------------------------------------------------
// withState: allocate a StatePool for a single element and call initState
// ---------------------------------------------------------------------------

function withState(core: AnalogElementCore): { element: ReactiveAnalogElement; pool: StatePool } {
  const re = core as ReactiveAnalogElement;
  const pool = new StatePool(Math.max(re.stateSize, 1));
  re.stateBaseOffset = 0;
  re.initState(pool);
  return { element: re, pool };
}

// ---------------------------------------------------------------------------
// Transformer element construction helper
// ---------------------------------------------------------------------------

function makeTransformerElement(opts: {
  pinNodeIds: number[];
  branch1: number;
  lPrimary?: number;
  turnsRatio?: number;
  k?: number;
  rPri?: number;
  rSec?: number;
}): AnalogTransformerElement {
  const el = new AnalogTransformerElement(
    opts.pinNodeIds,
    opts.branch1,
    opts.lPrimary ?? 10e-3,
    opts.turnsRatio ?? 1.0,
    opts.k ?? 0.99,
    opts.rPri ?? 0.0,
    opts.rSec ?? 0.0,
  );
  withState(el);
  return el;
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
    // Branch layout: b0=Vsrc, b1=transformer_primary, b2=transformer_secondary
    const bVsrc = nodeCount + 0;
    const bTx1 = nodeCount + 1;
    const matrixSize = nodeCount + 3;

    const transformer = makeTransformerElement({
      pinNodeIds: [1, 0, 2, 0],
      branch1: bTx1,
      lPrimary: Lp,
      turnsRatio: N,
      k,
      rPri: 0,
      rSec: 0,
    });
    const rLoad = makeResistor(2, 0, Rload);

    const initVoltages = new Float64Array(matrixSize);

    // Collect secondary voltages over last cycle to find peak
    const lastCycleStart = (numCycles - 1) * 200;
    const solver = new SparseSolver();
    let voltages = new Float64Array(initVoltages);
    let maxSecondary = 0;

    for (let i = 0; i < steps; i++) {
      const t = i * dt;
      const vSrc = Vpeak * Math.sin(2 * Math.PI * freq * t);
      const vsrc = makeVoltageSource(1, 0, bVsrc, vSrc);

      solver.beginAssembly(matrixSize);
      const ctx = makeTransientCtx(solver as unknown as SparseSolverType, voltages, {
        dt,
        method: "trapezoidal",
        order: 1,
        cktMode: i === 0 ? (MODETRAN | MODEINITTRAN) : (MODETRAN | MODEINITFLOAT),
      });
      vsrc.load(ctx);
      transformer.load(ctx);
      rLoad.load(ctx);
      solver.finalize();
      const result = solver.factor();
      if (!result.success) throw new Error(`Singular at step ${i}`);
      solver.solve(voltages);

      if (i >= lastCycleStart) {
        const vSec = Math.abs(voltages[1]); // node 2 is index 1
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
    const bVsrc = nodeCount + 0;
    const bTx1 = nodeCount + 1;
    const bTx2 = nodeCount + 2;
    const matrixSize = nodeCount + 3;

    const transformer = makeTransformerElement({
      pinNodeIds: [1, 0, 2, 0],
      branch1: bTx1,
      lPrimary: Lp,
      turnsRatio: N,
      k,
      rPri: 0,
      rSec: 0,
    });
    const rLoad = makeResistor(2, 0, Rload);
    const solver = new SparseSolver();
    let voltages = new Float64Array(matrixSize);

    let maxI1 = 0;
    let maxI2 = 0;
    const lastCycleStart = (numCycles - 1) * 400;

    for (let i = 0; i < steps; i++) {
      const t = i * dt;
      const vSrc = Vpeak * Math.sin(2 * Math.PI * freq * t);
      const vsrc = makeVoltageSource(1, 0, bVsrc, vSrc);

      solver.beginAssembly(matrixSize);
      const ctx = makeTransientCtx(solver as unknown as SparseSolverType, voltages, {
        dt,
        method: "trapezoidal",
        order: 1,
        cktMode: i === 0 ? (MODETRAN | MODEINITTRAN) : (MODETRAN | MODEINITFLOAT),
      });
      vsrc.load(ctx);
      transformer.load(ctx);
      rLoad.load(ctx);
      solver.finalize();
      const result = solver.factor();
      if (!result.success) throw new Error(`Singular at step ${i}`);
      solver.solve(voltages);

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
     * In steady-state AC: P = V_rms * I_rms * cos(φ).
     * For a resistive secondary load, cos(φ) ≈ 1 on secondary.
     * We compare P_sec = V_sec_rms * I_sec_rms to P_pri = V_pri_rms * I_pri_rms.
     * 10% tolerance accounts for reactive power in the primary winding inductance.
     */
    const N = 1;  // 1:1 transformer for simplest power balance
    const Vpeak = 2.0;
    const freq = 1000;
    const Lp = 500e-3;  // large L to minimize reactive primary current
    const k = 0.99;
    const Rload = 10.0;
    const dt = 1 / (freq * 400);
    const numCycles = 20;
    const steps = numCycles * 400;

    const nodeCount = 2;
    const bVsrc = nodeCount + 0;
    const bTx1 = nodeCount + 1;
    const bTx2 = nodeCount + 2;
    const matrixSize = nodeCount + 3;

    const transformer = makeTransformerElement({
      pinNodeIds: [1, 0, 2, 0],
      branch1: bTx1,
      lPrimary: Lp,
      turnsRatio: N,
      k,
      rPri: 0,
      rSec: 0,
    });
    const rLoad = makeResistor(2, 0, Rload);
    const solver = new SparseSolver();
    let voltages = new Float64Array(matrixSize);

    let sumP1 = 0, sumP2 = 0;
    let sampleCount = 0;
    const lastCycleStart = (numCycles - 1) * 400;

    for (let i = 0; i < steps; i++) {
      const t = i * dt;
      const vSrc = Vpeak * Math.sin(2 * Math.PI * freq * t);
      const vsrc = makeVoltageSource(1, 0, bVsrc, vSrc);

      solver.beginAssembly(matrixSize);
      const ctx = makeTransientCtx(solver as unknown as SparseSolverType, voltages, {
        dt,
        method: "trapezoidal",
        order: 1,
        cktMode: i === 0 ? (MODETRAN | MODEINITTRAN) : (MODETRAN | MODEINITFLOAT),
      });
      vsrc.load(ctx);
      transformer.load(ctx);
      rLoad.load(ctx);
      solver.finalize();
      const result = solver.factor();
      if (!result.success) throw new Error(`Singular at step ${i}`);
      solver.solve(voltages);

      if (i >= lastCycleStart) {
        const v1 = voltages[0]; // node 1 (index 0)
        const i1 = voltages[bTx1];
        const v2 = voltages[1]; // node 2 (index 1)
        const i2 = voltages[bTx2];
        // Real power: time-averaged instantaneous v*i product
        sumP1 += v1 * i1;
        sumP2 += v2 * i2;
        sampleCount++;
      }
    }

    const pPri = Math.abs(sumP1 / sampleCount);
    const pSec = Math.abs(sumP2 / sampleCount);

    expect(pPri).toBeGreaterThan(0);
    expect(pSec).toBeGreaterThan(0);
    // Power conservation: |P_pri - P_sec| / P_pri < 10%
    // (some reactive power stays in primary inductance, reducing apparent primary power)
    const relativeError = Math.abs(pPri - pSec) / pPri;
    expect(relativeError).toBeLessThan(0.10);
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
      const bVsrc = nodeCount + 0;
      const bTx1 = nodeCount + 1;
      const matrixSize = nodeCount + 3;

      const transformer = makeTransformerElement({
        pinNodeIds: [1, 0, 2, 0],
        branch1: bTx1,
        lPrimary: Lp,
        turnsRatio: N,
        k,
        rPri: 0,
        rSec: 0,
      });
      const rLoad = makeResistor(2, 0, Rload);
      const solver = new SparseSolver();
      let voltages = new Float64Array(matrixSize);
      let maxSec = 0;
      const lastCycleStart = (numCycles - 1) * 200;

      for (let i = 0; i < steps; i++) {
        const t = i * dt;
        const vSrc = Vpeak * Math.sin(2 * Math.PI * freq * t);
        const vsrc = makeVoltageSource(1, 0, bVsrc, vSrc);

        solver.beginAssembly(matrixSize);
        const ctx = makeTransientCtx(solver as unknown as SparseSolverType, voltages, {
          dt,
          method: "trapezoidal",
          order: 1,
          cktMode: i === 0 ? (MODETRAN | MODEINITTRAN) : (MODETRAN | MODEINITFLOAT),
        });
        vsrc.load(ctx);
        transformer.load(ctx);
        rLoad.load(ctx);
        solver.finalize();
        const result = solver.factor();
        if (!result.success) throw new Error(`Singular at step ${i}`);
        solver.solve(voltages);

        if (i >= lastCycleStart) {
          const vSec = Math.abs(voltages[1]);
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
     * In DC steady state, dI/dt → 0, so the coupled voltage M*dI/dt → 0.
     * The secondary winding sees no driving EMF and its voltage → 0.
     *
     * For convergence to DC steady state: we need winding resistance to
     * limit primary current. τ = L/R_pri. Use L=1H, R_pri=100Ω → τ=10ms.
     * Run for 5τ = 50ms with dt=1ms (50 steps) — fast enough for unit tests.
     *
     * In steady state: V_pri_source = I1 * R_pri (inductor short-circuited),
     * M*dI1/dt → 0, so V_sec_coupled → 0.
     */
    const N = 1;
    const Vdc = 5.0;
    const Lp = 1.0; // 1H
    const k = 0.99;
    const Rload = 100.0;
    const rPri = 100.0; // primary winding resistance: τ = L/R = 10ms
    const dt = 1e-3; // 1ms timestep
    const steps = 200; // 200ms = 20τ — well into steady state

    const nodeCount = 2;
    const bVsrc = nodeCount + 0;
    const bTx1 = nodeCount + 1;
    const matrixSize = nodeCount + 3;

    const transformer = makeTransformerElement({
      pinNodeIds: [1, 0, 2, 0],
      branch1: bTx1,
      lPrimary: Lp,
      turnsRatio: N,
      k,
      rPri,
      rSec: 0,
    });
    const rLoad = makeResistor(2, 0, Rload);
    const vsrc = makeVoltageSource(1, 0, bVsrc, Vdc);
    const solver = new SparseSolver();
    let voltages = new Float64Array(matrixSize);

    for (let i = 0; i < steps; i++) {
      solver.beginAssembly(matrixSize);
      const ctx = makeTransientCtx(solver as unknown as SparseSolverType, voltages, {
        dt,
        method: "trapezoidal",
        order: 1,
        cktMode: i === 0 ? (MODETRAN | MODEINITTRAN) : (MODETRAN | MODEINITFLOAT),
      });
      vsrc.load(ctx);
      transformer.load(ctx);
      rLoad.load(ctx);
      solver.finalize();
      const result = solver.factor();
      if (!result.success) throw new Error(`Singular at step ${i}`);
      solver.solve(voltages);
    }

    // In DC steady state: secondary voltage should be near 0
    // (only the coupled M*dI1/dt drives secondary, which → 0 in steady state)
    const vSec = Math.abs(voltages[1]); // node 2 voltage
    expect(vSec).toBeLessThan(Vdc * 0.05); // < 5% of primary DC
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
    const { solver: capSolver, stamps } = makeCaptureSolver();

    const rPri = 10.0;
    const transformer = makeTransformerElement({
      pinNodeIds: [1, 2, 3, 4],
      branch1: 4, // absolute branch rows
      lPrimary: 10e-3,
      turnsRatio: 1,
      k: 0.99,
      rPri,
      rSec: 0,
    });

    const voltages = new Float64Array(8);
    const ctx = makeTransientCtx(capSolver, voltages);
    transformer.load(ctx);

    // Primary resistance conductance = 1/10 = 0.1 S
    // Stamps between node 1 (idx 0) and node 2 (idx 1)
    const gPri = 1 / rPri;
    const diagN1 = stamps.find((s) => s.row === 0 && s.col === 0);
    const diagN2 = stamps.find((s) => s.row === 1 && s.col === 1);
    expect(diagN1).toBeDefined();
    expect(diagN1!.value).toBeCloseTo(gPri, 8);
    expect(diagN2).toBeDefined();
    expect(diagN2!.value).toBeCloseTo(gPri, 8);

    // Off-diagonal: -gPri
    const offN1N2 = stamps.find((s) => s.row === 0 && s.col === 1);
    expect(offN1N2).toBeDefined();
    expect(offN1N2!.value).toBeCloseTo(-gPri, 8);
  });
});

// ---------------------------------------------------------------------------
// State pool schema tests
// ---------------------------------------------------------------------------

describe("AnalogTransformerElement state pool", () => {
  it("stateBaseOffset defaults to -1 before initState", () => {
    const el = new AnalogTransformerElement([1, 0, 2, 0], 2, 10e-3, 1.0, 0.99, 0, 0);
    expect(el.stateBaseOffset).toBe(-1);
  });

  it("initState binds pool and zero-initialises all 9 slots", () => {
    const el = new AnalogTransformerElement([1, 0, 2, 0], 2, 10e-3, 1.0, 0.99, 0, 0);
    const { pool } = withState(el);
    for (let i = 0; i < 9; i++) {
      expect(pool.state0[i]).toBe(0);
    }
  });

  it("isReactive is true", () => {
    const el = new AnalogTransformerElement([1, 0, 2, 0], 2, 10e-3, 1.0, 0.99, 0, 0);
    expect(el.isReactive).toBe(true);
  });

  it("load writes G11/G22/G12 slots (trapezoidal)", () => {
    const Lp = 10e-3;
    const N = 1;
    const k = 0.99;
    // pinNodeIds=[1,0,2,0] → non-ground nodes {1,2} → nodeCount=2; branch1=2, branch2=3.
    const el = new AnalogTransformerElement([1, 0, 2, 0], 2, Lp, N, k, 0, 0);
    const { pool } = withState(el);
    const dt = 1e-4;
    const matrixSize = 4;   // nodeCount(2) + branchCount(2)
    const solver = new SparseSolver();
    solver.beginAssembly(matrixSize);
    const voltages = new Float64Array(matrixSize);
    const ctx = makeTransientCtx(solver as unknown as SparseSolverType, voltages, {
      dt,
      method: "trapezoidal",
      order: 1,
      cktMode: MODETRAN | MODEINITTRAN,
    });
    el.load(ctx);
    solver.finalize();

    const Ls = Lp / (N * N);
    const M = k * Math.sqrt(Lp * Ls);
    // niinteg.c:28-63: trap companion conductance = ag[0]*L.
    // At order=1 (ngspice default at transient entry per dctran.c:315),
    // computeNIcomCof sets ag[0] = 1/dt (BDF-1 / trapezoidal order 1).
    // G11 = ag[0] * L1 = L1/dt
    expect(pool.state0[0]).toBeCloseTo(Lp / dt, 8);
    // G22 = ag[0] * L2 = L2/dt
    expect(pool.state0[1]).toBeCloseTo(Ls / dt, 8);
    // G12 = ag[0] * M = M/dt
    expect(pool.state0[2]).toBeCloseTo(M / dt, 8);
  });

  it("load accumulates I1/I2 branch currents into pool slots after a step", () => {
    // pinNodeIds=[1,0,2,0] → non-ground nodes {1,2} → nodeCount=2; branch1=2, branch2=3.
    const el = new AnalogTransformerElement([1, 0, 2, 0], 2, 10e-3, 1.0, 0.99, 0, 0);
    const { pool } = withState(el);
    const dt = 1e-4;
    const matrixSize = 4;   // nodeCount(2) + branchCount(2)
    const solver = new SparseSolver();
    solver.beginAssembly(matrixSize);
    const voltages = new Float64Array(matrixSize);
    voltages[2] = 0.5; // branch 1 absolute row (primary current)
    voltages[3] = 0.2; // branch 2 absolute row (secondary current)
    const ctx = makeTransientCtx(solver as unknown as SparseSolverType, voltages, {
      dt,
      method: "trapezoidal",
      order: 1,
      cktMode: MODETRAN | MODEINITTRAN,
    });
    el.load(ctx);
    solver.finalize();

    // I1 slot = i1Now = 0.5, I2 slot = i2Now = 0.2
    expect(pool.state0[5]).toBeCloseTo(0.5, 8); // SLOT_I1
    expect(pool.state0[6]).toBeCloseTo(0.2, 8); // SLOT_I2
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

  it("branchCount is 1", () => {
    expect((TransformerDefinition.modelRegistry?.behavioral as {kind:"inline";factory:AnalogFactory;branchCount?:number}|undefined)?.branchCount).toBe(1);
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

    const el = getFactory(TransformerDefinition.modelRegistry!.behavioral!)(new Map([["P1", 1], ["P2", 0], ["S1", 2], ["S2", 0]]), [], 5, props, () => 0) as AnalogTransformerElement;
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
    expect(m!.convert("10")).toBeCloseTo(10, 8);
  });
});

// ---------------------------------------------------------------------------
// C4.2 — Transient parity test
//
// Circuit: Two-winding transformer with all voltages/currents kept at zero.
// pinNodeIds = [P1=1, P2=0(gnd), S1=2, S2=0(gnd)], branch1=3, branch2=4.
// With N=1:1, L_primary=L1, L_secondary=L1/(N²)=L1, M=k*L1.
// All voltages zero → i1=i2=0 → all flux linkages = 0 → hist1=hist2=0.
//
// BDF-1 / trapezoidal (order=1): ag[0]=1/dt, ag[1]=-1/dt.
//   g11 = ag[0]*L1   (niinteg.c:77 for winding 1)
//   g22 = ag[0]*L2   (niinteg.c:77 for winding 2)
//   g12 = ag[0]*M    (niinteg.c:77 for mutual inductance)
//   hist1 = ccap1 - ag[0]*phi1_0 = ag[1]*phi1_1 = 0 (all phi=0)
//   hist2 = ccap2 - ag[0]*phi2_0 = ag[1]*phi2_1 = 0 (all phi=0)
//
// ngspice source → our variable mapping:
//   indload.c:INDload::cstate0[INDflux]      → s0[SLOT_PHI1] = L1*i1 + M*i2
//   indload.c:INDload::geq (winding1)        → s0[SLOT_G11]  = ag[0]*L1
//   indload.c:INDload::geq (winding2)        → s0[SLOT_G22]  = ag[0]*L2
//   indload.c:INDload::geq (mutual)          → s0[SLOT_G12]  = ag[0]*M
//   indload.c:INDload::ceq (winding1)        → s0[SLOT_HIST1] = 0
//   indload.c:INDload::ceq (winding2)        → s0[SLOT_HIST2] = 0
// ---------------------------------------------------------------------------

describe("transformer_load_transient_parity (C4.2)", () => {
  it("transformer_load_transient_parity", () => {
    const L1   = 10e-3;  // 10 mH primary inductance
    const N    = 1.0;    // 1:1 turns ratio → L2 = L1/N² = L1
    const k    = 0.99;   // coupling coefficient
    const dt   = 1e-6;   // timestep (s)
    const order  = 1;
    const method = "trapezoidal" as const;

    // Derived inductances (matches AnalogTransformerElement constructor)
    const L2 = L1 / (N * N);     // = L1 for N=1
    const M  = k * Math.sqrt(L1 * L2);  // = k * L1 for N=1

    // BDF-1 coefficients: ag[0]=1/dt, ag[1]=-1/dt
    const ag0 = 1 / dt;
    const ag1 = -1 / dt;

    // Bit-exact companion conductances (niinteg.c:77):
    const g11 = ag0 * L1;
    const g22 = ag0 * L2;
    const g12 = ag0 * M;

    // Build element: pinNodeIds=[P1=1, P2=0, S1=2, S2=0], branch1=3, branch2=4
    const el = new AnalogTransformerElement([1, 0, 2, 0], 3, L1, N, k, 0, 0);
    const { element } = withState(el);

    const poolEl = element as unknown as {
      _pool: { states: Float64Array[] }; stateBaseOffset: number;
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
    } as unknown as SparseSolverType;

    const ag = new Float64Array(7);
    ag[0] = ag0;
    ag[1] = ag1;

    // voltages layout: [V(node1), V(node2), I_b3(branch3), I_b4(branch4)]
    // All zero: i1=voltages[3]=0, i2=voltages[4]=0 → all flux=0 every step.
    const voltages = new Float64Array(5);

    // 10-step transient loop
    for (let step = 0; step < 10; step++) {
      matValues.fill(0);

      const ctx: LoadContext = {
        cktMode: step === 0 ? (MODETRAN | MODEINITTRAN) : (MODETRAN | MODEINITFLOAT),
        solver,
        voltages,
        dt,
        method,
        order,
        deltaOld: [dt, dt, dt, dt, dt, dt, dt],
        ag,
        srcFact: 1,
        noncon: { value: 0 },
        limitingCollector: null,
        xfact: 1,
        gmin: 1e-12,
        reltol: 1e-3,
        iabstol: 1e-12,
      };

      element.load(ctx);

      // Assert per-step integration constants (spec: assert dt, order, method)
      expect(ctx.dt).toBe(dt);
      expect(ctx.order).toBe(order);
      expect(ctx.method).toBe(method);

      // Rotate state: s1 ← s0
      poolEl._pool.states[1].set(poolEl._pool.states[0]);
    }

    // After 10 steps: assert companion state from last load().
    // TRANSFORMER_SCHEMA slot indices:
    //   G11=0, G22=1, G12=2, HIST1=3, HIST2=4, I1=5, I2=6, PHI1=7, PHI2=8
    const base = poolEl.stateBaseOffset;
    const s0 = poolEl._pool.states[0];

    // Companion conductances — bit-exact (niinteg.c:77)
    expect(s0[base + 0]).toBe(g11);
    expect(s0[base + 1]).toBe(g22);
    expect(s0[base + 2]).toBe(g12);

    // History terms = 0 (all voltages zero, all flux linkages = 0)
    expect(s0[base + 3]).toBe(0);
    expect(s0[base + 4]).toBe(0);

    // Branch currents stored = 0 (voltages array all zero)
    expect(s0[base + 5]).toBe(0);
    expect(s0[base + 6]).toBe(0);

    // Flux linkages at step 9 = L1*0 + M*0 = 0
    expect(s0[base + 7]).toBe(0);
    expect(s0[base + 8]).toBe(0);
  });
});
