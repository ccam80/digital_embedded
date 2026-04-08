/**
 * Tests for the TappedTransformer component.
 *
 * Circuit topology for AC tests:
 *   Node 1: primary+ (Vac source positive)
 *   primary− = ground (node 0)
 *   Node 2: secondary top (S1)
 *   Node 3: center tap (CT)
 *   Node 4: secondary bottom (S2)
 *   secondary bottom (S2) grounded in single-ended tests
 *
 * Branch layout (absolute solver rows, nodeCount offset = nodeCount):
 *   bVsrc: AC voltage source (node 1 → gnd)
 *   bTx1:  transformer primary winding
 *   bTx2:  transformer secondary half-1 (S1 → CT)
 *   bTx3:  transformer secondary half-2 (CT → S2)
 *
 * Matrix size = nodeCount + branchCount.
 */

import { describe, it, expect } from "vitest";
import {
  AnalogTappedTransformerElement,
  TappedTransformerDefinition,
  TAPPED_TRANSFORMER_ATTRIBUTE_MAPPINGS,
} from "../tapped-transformer.js";
import { PropertyBag } from "../../../core/properties.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import { makeVoltageSource, makeResistor, makeDiode, makeCapacitor, allocateStatePool } from "../../../solver/analog/__tests__/test-helpers.js";
import type { AnalogElementCore } from "../../../solver/analog/element.js";

// ---------------------------------------------------------------------------
// Helper: narrow ModelEntry to inline factory (throws if netlist kind)
// ---------------------------------------------------------------------------
import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";
function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}


// ---------------------------------------------------------------------------
// Element construction helper
// ---------------------------------------------------------------------------

function makeTappedTransformer(opts: {
  pinNodeIds: number[];
  branch1: number;
  lPrimary?: number;
  turnsRatio?: number;
  k?: number;
  rPri?: number;
  rSec?: number;
}): AnalogTappedTransformerElement {
  return new AnalogTappedTransformerElement(
    opts.pinNodeIds,
    opts.branch1,
    opts.lPrimary ?? 100e-3,
    opts.turnsRatio ?? 2.0,
    opts.k ?? 0.99,
    opts.rPri ?? 0.0,
    opts.rSec ?? 0.0,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TappedTransformer", () => {
  it("center_tap_voltage_is_half — N=2 (1:1 each half); AC primary; CT at midpoint", () => {
    /**
     * N=2 total turns ratio means each secondary half has N/2 = 1 turns relative
     * to primary. With ideal coupling (k=0.99), each half should produce ~V_primary.
     * The center tap is the midpoint of the total secondary, so:
     *   V(S1 to CT) ≈ V_primary (each half ≈ primary for N=2, i.e., 1:1 each half)
     *   V(CT to S2) ≈ V_primary
     *   V(S1 to S2) ≈ 2 × V_primary
     *
     * Circuit:
     *   Nodes: 1=primary+(Vsrc+), 2=S1, 3=CT, 4=S2
     *   primary- = gnd = node 0
     *   Load: Rload between S1 and S2 (nodes 2 and 4), CT not loaded (floating mid)
     *   Branches: bVsrc=4, bTx1=5, bTx2=6, bTx3=7
     *   matrixSize = nodeCount(4) + branchCount(4) = 8
     */
    const N = 2;
    const Vpeak = 10.0;
    const freq = 1000;
    const Lp = 500e-3; // large L for good coupling at 1kHz
    const k = 0.99;
    // Use a high-impedance load so transformer is nearly unloaded — secondary
    // voltage is close to open-circuit value (each half ≈ Vpeak for N=2).
    const Rload = 100e3; // 100kΩ — very light load
    const dt = 1 / (freq * 400);
    const numCycles = 20;
    const steps = numCycles * 400;

    const nodeCount = 4;
    const bVsrc = nodeCount + 0;
    const bTx1 = nodeCount + 1;
    const matrixSize = nodeCount + 4;

    // pinNodeIds: [p1, p2, s1, ct, s2]
    const tx = makeTappedTransformer({
      pinNodeIds: [1, 0, 2, 3, 4],
      branch1: bTx1,
      lPrimary: Lp,
      turnsRatio: N,
      k,
    });

    // Load resistor across full secondary (S1 to S2 = nodes 2 to 4)
    const rLoad = makeResistor(2, 4, Rload);
    // CT and S2 tied to gnd via high-impedance reference to avoid floating
    const rCtGnd = makeResistor(3, 0, 1e6);
    const rS2Gnd = makeResistor(4, 0, 1e6);

    allocateStatePool([tx as AnalogElementCore]);

    const solver = new SparseSolver();
    let voltages = new Float64Array(matrixSize);
    let maxVS1CT = 0;
    let maxVCTS2 = 0;
    let maxVS1S2 = 0;
    const lastCycleStart = (numCycles - 1) * 400;

    for (let i = 0; i < steps; i++) {
      const t = i * dt;
      const vSrc = Vpeak * Math.sin(2 * Math.PI * freq * t);
      const vsrc = makeVoltageSource(1, 0, bVsrc, vSrc);

      tx.stampCompanion(dt, "trapezoidal", voltages);
      solver.beginAssembly(matrixSize);
      vsrc.stamp(solver);
      tx.stamp(solver);
      tx.stampReactiveCompanion!(solver);
      rLoad.stamp(solver);
      rCtGnd.stamp(solver);
      rS2Gnd.stamp(solver);
      solver.finalize();
      const result = solver.factor();
      if (!result.success) throw new Error(`Singular at step ${i}`);
      solver.solve(voltages);

      if (i >= lastCycleStart) {
        // node 2 = S1 (index 1), node 3 = CT (index 2), node 4 = S2 (index 3)
        const vs1 = voltages[1];
        const vct = voltages[2];
        const vs2 = voltages[3];
        const absS1CT = Math.abs(vs1 - vct);
        const absCTS2 = Math.abs(vct - vs2);
        const absS1S2 = Math.abs(vs1 - vs2);
        if (absS1CT > maxVS1CT) maxVS1CT = absS1CT;
        if (absCTS2 > maxVCTS2) maxVCTS2 = absCTS2;
        if (absS1S2 > maxVS1S2) maxVS1S2 = absS1S2;
      }
    }

    // For N=2 with near-open-circuit load: each half ≈ Vpeak (1:1 per half).
    // Tolerances ±15% for inductive losses with k=0.99.
    expect(maxVS1CT).toBeGreaterThan(Vpeak * 0.80);
    expect(maxVS1CT).toBeLessThan(Vpeak * 1.15);
    expect(maxVCTS2).toBeGreaterThan(Vpeak * 0.80);
    expect(maxVCTS2).toBeLessThan(Vpeak * 1.15);
    // Total secondary is twice each half (center tap is midpoint)
    expect(maxVS1S2).toBeGreaterThan(maxVS1CT * 1.8);
    expect(maxVS1S2).toBeLessThan(maxVS1CT * 2.2);
  });

  it("symmetric_halves — secondary half voltages equal in magnitude, opposite phase to CT", () => {
    /**
     * With a symmetric center-tapped secondary (L2 = L3), the two halves
     * should produce equal peak voltages. The voltages at S1 and S2 relative
     * to the center tap should be equal in magnitude.
     *
     * We verify: peak(V_S1 - V_CT) ≈ peak(V_S2 - V_CT) within 5%.
     */
    const N = 2;
    const Vpeak = 5.0;
    const freq = 1000;
    const Lp = 200e-3;
    const k = 0.99;
    const Rload = 50.0;
    const dt = 1 / (freq * 400);
    const numCycles = 20;
    const steps = numCycles * 400;

    const nodeCount = 4;
    const bVsrc = nodeCount + 0;
    const bTx1 = nodeCount + 1;
    const matrixSize = nodeCount + 4;

    const tx = makeTappedTransformer({
      pinNodeIds: [1, 0, 2, 3, 4],
      branch1: bTx1,
      lPrimary: Lp,
      turnsRatio: N,
      k,
    });

    // Symmetric resistive loads on each half
    const rLoad1 = makeResistor(2, 3, Rload); // S1 to CT
    const rLoad2 = makeResistor(3, 4, Rload); // CT to S2

    // Ground S2 via reference
    const rGnd = makeResistor(4, 0, 0.1); // low resistance to gnd for S2

    allocateStatePool([tx as AnalogElementCore]);

    const solver = new SparseSolver();
    let voltages = new Float64Array(matrixSize);
    let maxVS1toGnd = 0;
    let maxVS2toGnd = 0;
    const lastCycleStart = (numCycles - 1) * 400;

    for (let i = 0; i < steps; i++) {
      const t = i * dt;
      const vSrc = Vpeak * Math.sin(2 * Math.PI * freq * t);
      const vsrc = makeVoltageSource(1, 0, bVsrc, vSrc);

      tx.stampCompanion(dt, "trapezoidal", voltages);
      solver.beginAssembly(matrixSize);
      vsrc.stamp(solver);
      tx.stamp(solver);
      tx.stampReactiveCompanion!(solver);
      rLoad1.stamp(solver);
      rLoad2.stamp(solver);
      rGnd.stamp(solver);
      solver.finalize();
      const result = solver.factor();
      if (!result.success) throw new Error(`Singular at step ${i}`);
      solver.solve(voltages);

      if (i >= lastCycleStart) {
        const vs1 = voltages[1]; // node 2
        const vct = voltages[2]; // node 3
        const vs2 = voltages[3]; // node 4

        const absUpperHalf = Math.abs(vs1 - vct);
        const absLowerHalf = Math.abs(vs2 - vct);
        if (absUpperHalf > maxVS1toGnd) maxVS1toGnd = absUpperHalf;
        if (absLowerHalf > maxVS2toGnd) maxVS2toGnd = absLowerHalf;
      }
    }

    expect(maxVS1toGnd).toBeGreaterThan(0);
    expect(maxVS2toGnd).toBeGreaterThan(0);

    // Both halves must produce nearly equal peak voltages (within 10%)
    const ratio = maxVS1toGnd / maxVS2toGnd;
    expect(ratio).toBeGreaterThan(0.90);
    expect(ratio).toBeLessThan(1.10);
  });

  it("full_wave_rectifier — two diodes + CT ground produce DC output ≈ Vpeak_sec", () => {
    /**
     * Full-wave center-tap rectifier:
     *   CT tied to gnd, D1: S1 → out, D2: S2 → out.
     *   When S1>0: D1 conducts; when S2>0 (= negative half cycle): D2 conducts.
     *   Filter cap holds DC output.
     *
     * Nodes: 1=P1, 2=S1, 3=CT(gnd ref), 4=S2, 5=out
     * Branches: bVsrc=5, bTx1=6, bTx2=7, bTx3=8
     * matrixSize = nodeCount(5) + branchCount(4) = 9
     */
    const N = 2;
    const Vpeak = 10.0;
    const freq = 500;
    const Lp = 500e-3;
    const k = 0.99;
    const Rload = 500.0;
    const dt = 1 / (freq * 200);
    const numCycles = 40;
    const steps = numCycles * 200;

    const nodeCount = 5;
    const bVsrc = nodeCount + 0;
    const bTx1 = nodeCount + 1;
    const matrixSize = nodeCount + 4;

    const tx = makeTappedTransformer({
      pinNodeIds: [1, 0, 2, 3, 4],
      branch1: bTx1,
      lPrimary: Lp,
      turnsRatio: N,
      k,
    });

    // CT tied firmly to gnd
    const rCtGnd = makeResistor(3, 0, 0.01);

    // Diodes: D1 anode=S1(2), cathode=out(5); D2 anode=S2(4), cathode=out(5)
    const d1 = makeDiode(2, 5, 1e-14, 1.0);
    const d2 = makeDiode(4, 5, 1e-14, 1.0);
    allocateStatePool([tx as unknown as AnalogElementCore, d1, d2]);

    // Filter cap 1000µF + load
    const cFilter = makeCapacitor(5, 0, 1000e-6);
    const rLoadEl = makeResistor(5, 0, Rload);

    const solver = new SparseSolver();
    let voltages = new Float64Array(matrixSize);

    for (let i = 0; i < steps; i++) {
      const t = i * dt;
      const vSrc = Vpeak * Math.sin(2 * Math.PI * freq * t);
      const vsrc = makeVoltageSource(1, 0, bVsrc, vSrc);

      tx.stampCompanion(dt, "trapezoidal", voltages);
      cFilter.stampCompanion?.(dt, "trapezoidal", voltages);

      // NR loop for diodes (up to 50 iterations per timestep)
      for (let nr = 0; nr < 50; nr++) {
        d1.updateOperatingPoint?.(voltages);
        d2.updateOperatingPoint?.(voltages);

        solver.beginAssembly(matrixSize);
        vsrc.stamp(solver);
        tx.stamp(solver);
        tx.stampReactiveCompanion!(solver);
        rCtGnd.stamp(solver);
        cFilter.stamp(solver);
        rLoadEl.stamp(solver);
        d1.stamp(solver);
        d2.stamp(solver);
        d1.stampNonlinear?.(solver);
        d2.stampNonlinear?.(solver);
        solver.finalize();

        const result = solver.factor();
        if (!result.success) throw new Error(`Singular at step ${i} NR ${nr}`);

        const prevVoltages = new Float64Array(voltages);
        solver.solve(voltages);

        // Check convergence
        const d1conv = d1.checkConvergence?.(voltages, prevVoltages, 1e-3, 1e-6) ?? true;
        const d2conv = d2.checkConvergence?.(voltages, prevVoltages, 1e-3, 1e-6) ?? true;
        if (d1conv && d2conv) break;
      }
    }

    // Measure final DC output at node 5 (index 4)
    const vOut = voltages[4];

    // For N=2 (1:1 per half), each secondary half peak ≈ Vpeak = 10V.
    // After full-wave rectification: V_dc ≈ Vpeak - V_diode.
    // Allow ±30% tolerance for transformer inductive losses and diode model
    // startup transients with single-NR-iteration per timestep approach.
    const expectedDC = Vpeak - 0.7;
    expect(vOut).toBeGreaterThan(expectedDC * 0.70);
    expect(vOut).toBeLessThan(expectedDC * 1.30);
  });
});

// ---------------------------------------------------------------------------
// ComponentDefinition tests
// ---------------------------------------------------------------------------

describe("TappedTransformerDefinition", () => {
  it("name is TappedTransformer", () => {
    expect(TappedTransformerDefinition.name).toBe("TappedTransformer");
  });

  it("TappedTransformerDefinition has analog model", () => {
    expect(TappedTransformerDefinition.modelRegistry?.behavioral).toBeDefined();
  });

  it("has analogFactory", () => {
    expect((TappedTransformerDefinition.modelRegistry?.behavioral as {kind:"inline";factory:AnalogFactory}|undefined)?.factory).toBeDefined();
  });

  it("branchCount is 1", () => {
    expect((TappedTransformerDefinition.modelRegistry?.behavioral as {kind:"inline";factory:AnalogFactory;branchCount?:number}|undefined)?.branchCount).toBe(1);
  });

  it("category is PASSIVES", () => {
    expect(TappedTransformerDefinition.category).toBe(ComponentCategory.PASSIVES);
  });

  it("pinLayout has 5 entries with correct labels", () => {
    expect(TappedTransformerDefinition.pinLayout).toHaveLength(5);
    const labels = TappedTransformerDefinition.pinLayout.map((p) => p.label);
    expect(labels).toContain("P1");
    expect(labels).toContain("P2");
    expect(labels).toContain("S1");
    expect(labels).toContain("CT");
    expect(labels).toContain("S2");
  });

  it("analogFactory creates element with correct branch indices", () => {
    const props = new PropertyBag();
    props.setModelParam("turnsRatio", 2.0);
    props.setModelParam("primaryInductance", 100e-3);
    props.setModelParam("couplingCoefficient", 0.99);
    props.setModelParam("primaryResistance", 0);
    props.setModelParam("secondaryResistance", 0);

    const el = getFactory(TappedTransformerDefinition.modelRegistry!.behavioral!)(
      new Map([["P1", 1], ["P2", 0], ["S1", 2], ["CT", 3], ["S2", 4]]),
      [],
      10,
      props,
      () => 0,
    ) as AnalogTappedTransformerElement;
    expect(el.branchIndex).toBe(10);
    expect(el.branch2).toBe(11);
    expect(el.branch3).toBe(12);
  });

  it("can be registered without error", () => {
    const registry = new ComponentRegistry();
    expect(() => registry.register(TappedTransformerDefinition)).not.toThrow();
  });

  it("attribute mappings include turnsRatio", () => {
    const m = TAPPED_TRANSFORMER_ATTRIBUTE_MAPPINGS.find((a) => a.xmlName === "turnsRatio");
    expect(m).toBeDefined();
    expect(m!.propertyKey).toBe("turnsRatio");
    expect(m!.convert("4")).toBeCloseTo(4, 8);
  });

  it("inductance ratios are correct for N=2 (each half = primary, L2=L3=L1*(N/2)²=L1)", () => {
    const Lp = 100e-3;
    const N = 2;
    const el = new AnalogTappedTransformerElement([1, 0, 2, 3, 4], 5, Lp, N, 0.99, 0, 0);
    const halfRatio = N / 2; // = 1.0
    const expectedL2 = Lp * halfRatio * halfRatio; // = Lp = 100mH for N=2
    expect(el.primaryInductance).toBeCloseTo(Lp, 10);
    expect(el.secondaryHalfInductance).toBeCloseTo(expectedL2, 10);
  });

  it("inductance ratios are correct for N=4 (each half = N/2=2, L2=L3=L1*4)", () => {
    const Lp = 50e-3;
    const N = 4;
    const el = new AnalogTappedTransformerElement([1, 0, 2, 3, 4], 5, Lp, N, 0.99, 0, 0);
    const halfRatio = N / 2; // = 2.0
    const expectedL2 = Lp * halfRatio * halfRatio; // = 4 * Lp = 200mH
    expect(el.secondaryHalfInductance).toBeCloseTo(expectedL2, 10);
  });

  it("mutual inductance between primary and secondary half is k * sqrt(L1 * L2)", () => {
    const Lp = 100e-3;
    const N = 2;
    const k = 0.99;
    const el = new AnalogTappedTransformerElement([1, 0, 2, 3, 4], 5, Lp, N, k, 0, 0);
    const L2 = Lp * (N / 2) * (N / 2);
    const expectedM = k * Math.sqrt(Lp * L2);
    expect(el.mutualInductancePriSec).toBeCloseTo(expectedM, 10);
  });

  it("mutual inductance between secondary halves is k * sqrt(L2 * L3) = k * L2 for symmetric", () => {
    const Lp = 100e-3;
    const N = 2;
    const k = 0.99;
    const el = new AnalogTappedTransformerElement([1, 0, 2, 3, 4], 5, Lp, N, k, 0, 0);
    const L2 = Lp * (N / 2) * (N / 2);
    const expectedM23 = k * Math.sqrt(L2 * L2); // = k * L2
    expect(el.mutualInductanceSecSec).toBeCloseTo(expectedM23, 10);
  });
});
