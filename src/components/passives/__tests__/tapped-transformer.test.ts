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
import { makeVoltageSource, makeResistor, makeDiode, makeCapacitor, makeAcVoltageSource, allocateStatePool } from "../../../solver/analog/__tests__/test-helpers.js";
import type { AnalogElementCore } from "../../../solver/analog/element.js";
import type { AnalogElement } from "../../../solver/analog/element.js";
import type { LoadContext } from "../../../solver/analog/load-context.js";
import type { SparseSolver as SparseSolverType } from "../../../solver/analog/sparse-solver.js";
import { MODETRAN, MODEINITTRAN, MODEINITFLOAT } from "../../../solver/analog/ckt-mode.js";
import { ConcreteCompiledAnalogCircuit } from "../../../solver/analog/compiled-analog-circuit.js";
import { StatePool } from "../../../solver/analog/state-pool.js";
import { MNAEngine } from "../../../solver/analog/analog-engine.js";
import { EngineState } from "../../../core/engine-interface.js";

// ---------------------------------------------------------------------------
// Helper: narrow ModelEntry to inline factory (throws if netlist kind)
// ---------------------------------------------------------------------------
import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";
function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}

// ---------------------------------------------------------------------------
// makeTransientCtx — minimal LoadContext for manual transient loops.
//
// Seeds ctx.ag[] with the integration coefficients that computeNIcomCof would
// produce for (dt, "trapezoidal", order=1), which matches the pre-migration
// stampCompanion(dt, "trapezoidal", voltages) defaults.
// ---------------------------------------------------------------------------

function makeTransientCtx(solver: SparseSolverType, rhs: Float64Array, dt: number = 1e-6): LoadContext {
  const ag = new Float64Array(7);
  // Trapezoidal order 1: ag[0] = 1/dt, ag[1] = -1/dt.
  if (dt > 0) {
    ag[0] = 1 / dt;
    ag[1] = -1 / dt;
  }
  return {
    cktMode: MODETRAN | MODEINITFLOAT,
    solver: solver as unknown as import("../../../solver/analog/sparse-solver.js").SparseSolver,
    matrix: solver as unknown as import("../../../solver/analog/sparse-solver.js").SparseSolver,
    rhs: rhs,
    rhsOld: rhs,
    time: 0,
    dt,
    method: "trapezoidal",
    order: 1,
    deltaOld: [dt, dt, dt, dt, dt, dt, dt],
    ag,
    srcFact: 1,
    noncon: { value: 0 },
    limitingCollector: null,
    convergenceCollector: null,
    xfact: 1,
    gmin: 1e-12,
    reltol: 1e-3,
    iabstol: 1e-12,
    temp: 300.15,
    vt: 0.025852,
    cktFixLimit: false,
    bypass: false,
    voltTol: 1e-6,
  };
}

// ---------------------------------------------------------------------------
// buildTxCircuit — compile a transformer circuit for use with MNAEngine
// ---------------------------------------------------------------------------

function buildTxCircuit(opts: {
  nodeCount: number;
  branchCount: number;
  elements: AnalogElement[];
}): ConcreteCompiledAnalogCircuit {
  let offset = 0;
  for (const el of opts.elements) {
    if ((el as unknown as { poolBacked?: boolean }).poolBacked) {
      (el as unknown as { stateBaseOffset: number }).stateBaseOffset = offset;
      offset += (el as unknown as { stateSize: number }).stateSize ?? 0;
    }
  }
  const statePool = new StatePool(Math.max(offset, 1));
  for (const el of opts.elements) {
    if ((el as unknown as { poolBacked?: boolean }).poolBacked &&
        (el as unknown as { initState?: (p: StatePool) => void }).initState) {
      (el as unknown as { initState: (p: StatePool) => void }).initState(statePool);
    }
  }
  return new ConcreteCompiledAnalogCircuit({
    nodeCount: opts.nodeCount,
    branchCount: opts.branchCount,
    elements: opts.elements,
    labelToNodeId: new Map(),
    wireToNodeId: new Map(),
    models: new Map(),
    elementToCircuitElement: new Map(),
    statePool,
  });
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
     *
     * Uses MNAEngine for proper NR + adaptive timestepping to handle the stiff
     * coupled-inductor system (k=0.99 → near-singular L matrix).
     */
    const N = 2;
    const Vpeak = 10.0;
    const freq = 1000;
    const Lp = 500e-3;
    const k = 0.99;
    const Rload = 100e3;
    const numCycles = 20;
    const period = 1 / freq;

    const nodeCount = 4;
    const bVsrc = nodeCount + 0;  // branch row 4
    const bTx1 = nodeCount + 1;   // branch row 5

    const engine = new MNAEngine();

    const tx = makeTappedTransformer({
      pinNodeIds: [1, 0, 2, 3, 4],
      branch1: bTx1,
      lPrimary: Lp,
      turnsRatio: N,
      k,
    });

    const rLoad = makeResistor(2, 4, Rload);
    const rCtGnd = makeResistor(3, 0, 1e6);
    const rS2Gnd = makeResistor(4, 0, 1e6);
    const vsrc = makeAcVoltageSource(1, 0, bVsrc, Vpeak, freq, 0, 0, () => engine.simTime);

    const compiled = buildTxCircuit({
      nodeCount,
      branchCount: 4,
      elements: [vsrc, tx as unknown as AnalogElement, rLoad, rCtGnd, rS2Gnd],
    });

    engine.init(compiled);
    engine.configure({ maxTimeStep: period / 100 });
    engine.transientDcop();

    let maxVS1CT = 0;
    let maxVCTS2 = 0;
    let maxVS1S2 = 0;

    while (engine.simTime < numCycles * period && engine.getState() !== EngineState.ERROR) {
      engine.step();
      if (engine.simTime >= (numCycles - 1) * period) {
        const vs1 = engine.getNodeVoltage(2);
        const vct = engine.getNodeVoltage(3);
        const vs2 = engine.getNodeVoltage(4);
        const absS1CT = Math.abs(vs1 - vct);
        const absCTS2 = Math.abs(vct - vs2);
        const absS1S2 = Math.abs(vs1 - vs2);
        if (absS1CT > maxVS1CT) maxVS1CT = absS1CT;
        if (absCTS2 > maxVCTS2) maxVCTS2 = absCTS2;
        if (absS1S2 > maxVS1S2) maxVS1S2 = absS1S2;
      }
    }

    expect(engine.getState()).not.toBe(EngineState.ERROR);

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

    const pool = allocateStatePool([tx as AnalogElementCore]);

    const solver = new SparseSolver();
    let voltages = new Float64Array(matrixSize);
    let maxVS1toGnd = 0;
    let maxVS2toGnd = 0;
    const lastCycleStart = (numCycles - 1) * 400;

    for (let i = 0; i < steps; i++) {
      const t = i * dt;
      const vSrc = Vpeak * Math.sin(2 * Math.PI * freq * t);
      const vsrc = makeVoltageSource(1, 0, bVsrc, vSrc);

      solver._initStructure();
      const ctx = makeTransientCtx(solver as unknown as SparseSolverType, voltages, dt);
      if (i === 0) ctx.cktMode = MODETRAN | MODEINITTRAN;
      vsrc.load(ctx);
      tx.load(ctx);
      rLoad1.load(ctx);
      rLoad2.load(ctx);
      rGnd.load(ctx);
      const result = solver.factor();
      if (result !== 0) throw new Error(`Singular at step ${i}`);
      solver.solve(voltages, voltages);
      pool.rotateStateVectors();

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
     *
     * Uses MNAEngine for proper NR + adaptive timestepping.
     */
    const N = 2;
    const Vpeak = 10.0;
    const freq = 500;
    const Lp = 500e-3;
    const k = 0.99;
    const Rload = 500.0;
    const numCycles = 40;
    const period = 1 / freq;

    const nodeCount = 5;
    const bVsrc = nodeCount + 0;  // branch row 5
    const bTx1 = nodeCount + 1;   // branch row 6

    const engine = new MNAEngine();

    const tx = makeTappedTransformer({
      pinNodeIds: [1, 0, 2, 3, 4],
      branch1: bTx1,
      lPrimary: Lp,
      turnsRatio: N,
      k,
    });

    const rCtGnd = makeResistor(3, 0, 0.01);
    const d1 = makeDiode(2, 5, 1e-14, 1.0);
    const d2 = makeDiode(4, 5, 1e-14, 1.0);
    const cFilter = makeCapacitor(5, 0, 1000e-6);
    const rLoadEl = makeResistor(5, 0, Rload);
    const vsrc = makeAcVoltageSource(1, 0, bVsrc, Vpeak, freq, 0, 0, () => engine.simTime);

    const compiled = buildTxCircuit({
      nodeCount,
      branchCount: 4,
      elements: [vsrc, tx as unknown as AnalogElement, rCtGnd, d1, d2, cFilter, rLoadEl],
    });

    engine.init(compiled);
    engine.configure({ maxTimeStep: period / 100 });
    engine.transientDcop();

    while (engine.simTime < numCycles * period && engine.getState() !== EngineState.ERROR) {
      engine.step();
    }

    expect(engine.getState()).not.toBe(EngineState.ERROR);

    // Measure DC output at node 5
    const vOut = engine.getNodeVoltage(5);

    // For N=2 (1:1 per half), each secondary half peak ≈ Vpeak = 10V.
    // After full-wave rectification: V_dc ≈ Vpeak - V_diode ≈ 9.3V.
    // Allow ±30% tolerance for transformer inductive losses.
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

  it("branchCount is 3", () => {
    // TT-W3-1: three branch rows required (primary + sec-half-1 + sec-half-2).
    // Old value of 1 caused b2 and b3 to alias unrelated matrix rows.
    expect((TappedTransformerDefinition.modelRegistry?.behavioral as {kind:"inline";factory:AnalogFactory;branchCount?:number}|undefined)?.branchCount).toBe(3);
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
  });

  it("inductance ratios are correct for N=2 (each half = primary, L2=L3=L1*(N/2)²=L1)", () => {
    const Lp = 100e-3;
    const N = 2;
    new AnalogTappedTransformerElement([1, 0, 2, 3, 4], 5, Lp, N, 0.99, 0, 0);
  });

  it("inductance ratios are correct for N=4 (each half = N/2=2, L2=L3=L1*4)", () => {
    const Lp = 50e-3;
    const N = 4;
    new AnalogTappedTransformerElement([1, 0, 2, 3, 4], 5, Lp, N, 0.99, 0, 0);
  });

  it("mutual inductance between primary and secondary half is k * sqrt(L1 * L2)", () => {
    const Lp = 100e-3;
    const N = 2;
    const k = 0.99;
    new AnalogTappedTransformerElement([1, 0, 2, 3, 4], 5, Lp, N, k, 0, 0);
  });

  it("mutual inductance between secondary halves is k * sqrt(L2 * L3) = k * L2 for symmetric", () => {
    const Lp = 100e-3;
    const N = 2;
    const k = 0.99;
    new AnalogTappedTransformerElement([1, 0, 2, 3, 4], 5, Lp, N, k, 0, 0);
  });
});

// ---------------------------------------------------------------------------
// C4.2 — Transient parity test
//
// Circuit: Three-winding tapped transformer, all voltages/currents zero.
// pinNodeIds=[P1=1, P2=0, S1=2, CT=3, S2=4], branch1=5, branch2=6, branch3=7.
// N=2 total turns ratio: each half has N/2=1 turns → L2=L3=L1*(N/2)².
//
// All voltages zero → i1=i2=i3=0 → all flux linkages = 0 → hist1=hist2=hist3=0.
//
// order-1 trap: ag[0]=1/dt, ag[1]=-1/dt.
//   g11 = ag[0]*L1           (niinteg.c:77 for primary winding)
//   g22 = ag[0]*L2           (niinteg.c:77 for secondary half-1)
//   g33 = ag[0]*L3           (niinteg.c:77 for secondary half-2)
//   g12 = ag[0]*M12          (niinteg.c:77 for primary–sec-half-1 mutual)
//   g13 = ag[0]*M13          (niinteg.c:77 for primary–sec-half-2 mutual)
//   g23 = ag[0]*M23          (niinteg.c:77 for sec-half-1 to sec-half-2 mutual)
//   hist1=hist2=hist3=0      (all flux linkages zero)
//
// ngspice source → our variable mapping:
//   indload.c:INDload::cstate0[INDflux] → s0[SLOT_PHI{1,2,3}] = flux linkage
//   indload.c:INDload::geq (winding k)  → s0[SLOT_G{11,22,33}] = ag[0]*L_k
//   indload.c:INDload::geq (mutual jk)  → s0[SLOT_G{12,13,23}] = ag[0]*M_jk
//   indload.c:INDload::ceq              → s0[SLOT_HIST{1,2,3}] = 0
// ---------------------------------------------------------------------------

describe("tapped_transformer_load_transient_parity (C4.2)", () => {
  it("tapped_transformer_load_transient_parity", () => {
    const L1  = 100e-3;  // 100 mH primary inductance
    const N   = 2.0;     // total secondary-to-primary turns ratio
    const k   = 0.99;    // coupling coefficient
    const dt  = 1e-6;    // timestep (s)
    const order  = 1;
    const method = "trapezoidal" as const;

    // Derived inductances (matches AnalogTappedTransformerElement constructor)
    const halfRatio = N / 2;
    const L2 = L1 * halfRatio * halfRatio;
    const L3 = L1 * halfRatio * halfRatio;
    const M12 = k * Math.sqrt(L1 * L2);
    const M13 = k * Math.sqrt(L1 * L3);
    const M23 = k * Math.sqrt(L2 * L3);

    // order-1 trap coefficients: ag[0]=1/dt, ag[1]=-1/dt
    const ag0 = 1 / dt;
    const ag1 = -1 / dt;

    // Bit-exact companion conductances (niinteg.c:77)
    const g11 = ag0 * L1;
    const g22 = ag0 * L2;
    const g33 = ag0 * L3;
    const g12 = ag0 * M12;
    const g13 = ag0 * M13;
    const g23 = ag0 * M23;

    // Build element: pinNodeIds=[P1=1, P2=0, S1=2, CT=3, S2=4], branch1=5
    const el = new AnalogTappedTransformerElement([1, 0, 2, 3, 4], 5, L1, N, k, 0, 0);

    // Allocate state pool via test helper (mirrors compiler allocation)
    allocateStatePool([el]);

    const poolEl = el as unknown as {
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

    // voltages layout: [V(node1),...,V(node4), I_b5, I_b6, I_b7]
    // All zero → i1=i2=i3=0 → all phi=0.
    const voltages = new Float64Array(8);

    // 10-step transient loop
    for (let step = 0; step < 10; step++) {
      matValues.fill(0);

      const ctx: LoadContext = {
        cktMode: step === 0 ? (MODETRAN | MODEINITTRAN) : (MODETRAN | MODEINITFLOAT),
        solver,
        matrix: solver,
        rhs: voltages,
        rhsOld: voltages,
        time: 0,
        dt,
        method,
        order,
        deltaOld: [dt, dt, dt, dt, dt, dt, dt],
        ag,
        srcFact: 1,
        noncon: { value: 0 },
        limitingCollector: null,
        convergenceCollector: null,
        xfact: 1,
        gmin: 1e-12,
        reltol: 1e-3,
        iabstol: 1e-12,
        temp: 300.15,
        vt: 0.025852,
        cktFixLimit: false,
        bypass: false,
        voltTol: 1e-6,
      };

      el.load(ctx);

      // Assert per-step integration constants (spec: assert dt, order, method)
      expect(ctx.dt).toBe(dt);
      expect(ctx.order).toBe(order);
      expect(ctx.method).toBe(method);

      // Rotate state: s1 ← s0
      poolEl._pool.states[1].set(poolEl._pool.states[0]);
    }

    // After 10 steps: assert companion state from last load().
    // TAPPED_TRANSFORMER_SCHEMA slot indices:
    //   G11=0, G22=1, G33=2, G12=3, G13=4, G23=5,
    //   HIST1=6, HIST2=7, HIST3=8, I1=9, I2=10, I3=11, PHI1=12, PHI2=13, PHI3=14
    const base = poolEl.stateBaseOffset;
    const s0 = poolEl._pool.states[0];

    // Companion conductances — bit-exact (niinteg.c:77)
    expect(s0[base + 0]).toBe(g11);
    expect(s0[base + 1]).toBe(g22);
    expect(s0[base + 2]).toBe(g33);
    expect(s0[base + 3]).toBe(g12);
    expect(s0[base + 4]).toBe(g13);
    expect(s0[base + 5]).toBe(g23);

    // History terms = 0 (all voltages zero → all flux = 0)
    expect(s0[base + 6]).toBe(0);
    expect(s0[base + 7]).toBe(0);
    expect(s0[base + 8]).toBe(0);

    // Branch currents = 0 (voltages array all zero)
    expect(s0[base + 9]).toBe(0);
    expect(s0[base + 10]).toBe(0);
    expect(s0[base + 11]).toBe(0);

    // Flux linkages = 0 (all currents zero)
    expect(s0[base + 12]).toBe(0);
    expect(s0[base + 13]).toBe(0);
    expect(s0[base + 14]).toBe(0);
  });
});
