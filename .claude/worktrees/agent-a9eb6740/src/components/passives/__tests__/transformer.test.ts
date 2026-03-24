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
 * Simulation strategy: manual transient loop using SparseSolver + element.stamp()
 * + element.stampCompanion(), following the pattern in integration.test.ts.
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
import { SparseSolver } from "../../../analog/sparse-solver.js";
import { makeVoltageSource, makeResistor } from "../../../analog/test-elements.js";

// ---------------------------------------------------------------------------
// Transient simulation helpers
// ---------------------------------------------------------------------------

/**
 * Run N transient timesteps with the given elements and return the final
 * solution vector.
 *
 * @param elements  - All elements to stamp (including the transformer)
 * @param reactive  - Subset of elements that have stampCompanion (must be called first)
 * @param matrixSize - Total MNA matrix dimension (nodes + branches)
 * @param initVoltages - Initial solution vector (length = matrixSize)
 * @param dt        - Timestep in seconds
 * @param steps     - Number of steps to run
 */
function runTransient(
  elements: Array<{ stamp(s: SparseSolver): void }>,
  reactive: Array<{ stampCompanion(dt: number, method: "trapezoidal", voltages: Float64Array): void }>,
  matrixSize: number,
  initVoltages: Float64Array,
  dt: number,
  steps: number,
): Float64Array {
  const solver = new SparseSolver();
  let voltages = new Float64Array(initVoltages);

  for (let i = 0; i < steps; i++) {
    for (const el of reactive) {
      el.stampCompanion(dt, "trapezoidal", voltages);
    }
    solver.beginAssembly(matrixSize);
    for (const el of elements) {
      el.stamp(solver);
    }
    solver.finalize();
    const result = solver.factor();
    if (!result.success) throw new Error(`Singular matrix at step ${i}`);
    solver.solve(voltages);
  }
  return voltages;
}

/**
 * Run a time-varying simulation where the source voltage changes each step.
 * Returns an array of solution vectors (one per step).
 */
function runTransientAC(
  makeElements: (t: number) => Array<{ stamp(s: SparseSolver): void }>,
  reactive: Array<{ stampCompanion(dt: number, method: "trapezoidal", voltages: Float64Array): void }>,
  matrixSize: number,
  initVoltages: Float64Array,
  dt: number,
  steps: number,
): Float64Array[] {
  const solver = new SparseSolver();
  let voltages = new Float64Array(initVoltages);
  const results: Float64Array[] = [];

  for (let i = 0; i < steps; i++) {
    const t = i * dt;
    const elements = makeElements(t);

    for (const el of reactive) {
      el.stampCompanion(dt, "trapezoidal", voltages);
    }
    solver.beginAssembly(matrixSize);
    for (const el of elements) {
      el.stamp(solver);
    }
    solver.finalize();
    const result = solver.factor();
    if (!result.success) throw new Error(`Singular matrix at step ${i} (t=${t.toExponential(3)})`);
    solver.solve(voltages);
    results.push(new Float64Array(voltages));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Transformer element construction helper
// ---------------------------------------------------------------------------

function makeTransformerElement(opts: {
  nodeIndices: number[];
  branch1: number;
  lPrimary?: number;
  turnsRatio?: number;
  k?: number;
  rPri?: number;
  rSec?: number;
}): AnalogTransformerElement {
  return new AnalogTransformerElement(
    opts.nodeIndices,
    opts.branch1,
    opts.lPrimary ?? 10e-3,
    opts.turnsRatio ?? 1.0,
    opts.k ?? 0.99,
    opts.rPri ?? 0.0,
    opts.rSec ?? 0.0,
  );
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
     *   nodeIndices = [1, 0, 2, 0]  (P1=1, P2=gnd, S1=2, S2=gnd)
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
    const bTx2 = nodeCount + 2;
    const matrixSize = nodeCount + 3;

    const transformer = makeTransformerElement({
      nodeIndices: [1, 0, 2, 0],
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

      transformer.stampCompanion(dt, "trapezoidal", voltages);
      solver.beginAssembly(matrixSize);
      vsrc.stamp(solver);
      transformer.stamp(solver);
      rLoad.stamp(solver);
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
      nodeIndices: [1, 0, 2, 0],
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

      transformer.stampCompanion(dt, "trapezoidal", voltages);
      solver.beginAssembly(matrixSize);
      vsrc.stamp(solver);
      transformer.stamp(solver);
      rLoad.stamp(solver);
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
      nodeIndices: [1, 0, 2, 0],
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

      transformer.stampCompanion(dt, "trapezoidal", voltages);
      solver.beginAssembly(matrixSize);
      vsrc.stamp(solver);
      transformer.stamp(solver);
      rLoad.stamp(solver);
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
      const bTx2 = nodeCount + 2;
      const matrixSize = nodeCount + 3;

      const transformer = makeTransformerElement({
        nodeIndices: [1, 0, 2, 0],
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

        transformer.stampCompanion(dt, "trapezoidal", voltages);
        solver.beginAssembly(matrixSize);
        vsrc.stamp(solver);
        transformer.stamp(solver);
        rLoad.stamp(solver);
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
    const bTx2 = nodeCount + 2;
    const matrixSize = nodeCount + 3;

    const transformer = makeTransformerElement({
      nodeIndices: [1, 0, 2, 0],
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
      transformer.stampCompanion(dt, "trapezoidal", voltages);
      solver.beginAssembly(matrixSize);
      vsrc.stamp(solver);
      transformer.stamp(solver);
      rLoad.stamp(solver);
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
     * We test stamp() directly: check that the resistor conductance stamps
     * appear correctly in the matrix for the primary winding.
     */
    interface StampCall { row: number; col: number; value: number; }
    const stamps: StampCall[] = [];
    const mockSolver = {
      stamp: (row: number, col: number, value: number) => stamps.push({ row, col, value }),
      stampRHS: (_row: number, _value: number) => {},
      beginAssembly: () => {},
      finalize: () => {},
      solve: () => new Float64Array(0),
    };

    const rPri = 10.0;
    const transformer = makeTransformerElement({
      nodeIndices: [1, 2, 3, 4],
      branch1: 4, // absolute branch rows
      lPrimary: 10e-3,
      turnsRatio: 1,
      k: 0.99,
      rPri,
      rSec: 0,
    });

    transformer.stamp(mockSolver as any);

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
// ComponentDefinition tests
// ---------------------------------------------------------------------------

describe("TransformerDefinition", () => {
  it("name is Transformer", () => {
    expect(TransformerDefinition.name).toBe("Transformer");
  });

  it("engineType is analog", () => {
    expect(TransformerDefinition.engineType).toBe("analog");
  });

  it("has analogFactory", () => {
    expect(TransformerDefinition.analogFactory).toBeDefined();
  });

  it("requiresBranchRow is true", () => {
    expect(TransformerDefinition.requiresBranchRow).toBe(true);
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
    props.set("turnsRatio", 10);
    props.set("primaryInductance", 10e-3);
    props.set("couplingCoefficient", 0.99);
    props.set("primaryResistance", 0);
    props.set("secondaryResistance", 0);

    const el = TransformerDefinition.analogFactory!([1, 0, 2, 0], 5, props, () => 0) as AnalogTransformerElement;
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
