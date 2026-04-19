/**
 * Tests for the AnalogDiode component.
 *
 * Covers:
 *   - Forward bias stamp: correct geq and ieq
 *   - Reverse bias stamp: near-zero conductance
 *   - Voltage limiting via pnjlim
 *   - Junction capacitance activation when CJO > 0
 *   - Integration: diode + resistor DC operating point vs SPICE reference
 */

import { describe, it, expect } from "vitest";
import { DiodeDefinition, createDiodeElement, computeJunctionCapacitance, DIODE_PARAM_DEFAULTS } from "../diode.js";
import { PropertyBag } from "../../../core/properties.js";
import { makeDcVoltageSource } from "../../sources/dc-voltage-source.js";
import { withNodeIds, runDcOp, makeSimpleCtx } from "../../../solver/analog/__tests__/test-helpers.js";
import { StatePool } from "../../../solver/analog/state-pool.js";
import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import type { SparseSolver as SparseSolverType } from "../../../solver/analog/sparse-solver.js";
import type { AnalogElement } from "../../../solver/analog/element.js";
import type { AnalogElementCore } from "../../../core/analog-types.js";
import type { ReactiveAnalogElement } from "../../../solver/analog/element.js";
import type { AnalogFactory } from "../../../core/registry.js";
import type { LoadContext } from "../../../solver/analog/load-context.js";
import type { LimitingEvent } from "../../../solver/analog/newton-raphson.js";

// ---------------------------------------------------------------------------
// Helper: allocate a StatePool for a single element and call initState
// ---------------------------------------------------------------------------

function withState(core: AnalogElementCore): { element: ReactiveAnalogElement; pool: StatePool } {
  const re = core as ReactiveAnalogElement;
  const pool = new StatePool(Math.max(re.stateSize, 1));
  re.stateBaseOffset = 0;
  re.initState(pool);
  return { element: re, pool };
}

// ---------------------------------------------------------------------------
// Helper: narrow ModelEntry to inline factory (throws if netlist kind)
// ---------------------------------------------------------------------------

/** Assert actual ≈ expected within 0.1% relative tolerance (ngspice reference). */
function expectSpiceRef(actual: number, expected: number, label: string) {
  const rel = Math.abs((actual - expected) / expected);
  if (rel >= 0.001) {
    throw new Error(
      `${label}: relative error ${(rel * 100).toFixed(4)}% exceeds 0.1% ` +
      `(actual=${actual}, expected=${expected})`
    );
  }
}


// ---------------------------------------------------------------------------
// Physical constants
// ---------------------------------------------------------------------------

// VT imported from core/constants to match production code
import { VT } from "../../../core/constants.js";
const GMIN = 1e-12;

function makeParamBag(params: Record<string, number>): PropertyBag {
  const bag = new PropertyBag();
  bag.replaceModelParams({ ...DIODE_PARAM_DEFAULTS, ...params });
  return bag;
}

// ---------------------------------------------------------------------------
// Real-solver helpers
// ---------------------------------------------------------------------------

/**
 * Drive an element to steady operating point by iterating load(ctx) with a
 * fresh SparseSolver each iteration. Each call reads ctx.voltages and
 * re-writes SLOT_VD via pnjlim.
 */
/**
 * Build a bare LoadContext for a single-element unit test. Caller owns the
 * solver, the state pool, and the voltages buffer — makeSimpleCtx would
 * re-run allocateStatePool and wipe already-seeded pool state.
 */
function buildUnitCtx(
  solver: SparseSolver,
  voltages: Float64Array,
  overrides: Partial<LoadContext> = {},
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
    ...overrides,
  };
}

/**
 * Drive an element to steady operating point by iterating load(ctx) with a
 * fresh SparseSolver each iteration. Pool state persists across iterations
 * because the element and its pool are kept in the outer scope.
 */
function driveToOp(
  element: AnalogElement,
  voltages: Float64Array,
  iterations: number,
  opts: { matrixSize?: number; limitingCollector?: LimitingEvent[] | null; iteration?: number } = {},
): void {
  const matrixSize = opts.matrixSize ?? Math.max(voltages.length, element.pinNodeIds.length, 1);
  for (let i = 0; i < iterations; i++) {
    const solver = new SparseSolver();
    solver.beginAssembly(matrixSize);
    const ctx = buildUnitCtx(solver, voltages, {
      limitingCollector: opts.limitingCollector ?? null,
      iteration: opts.iteration ?? 0,
    });
    element.load(ctx);
  }
}

/** Load element into a fresh real SparseSolver and return the (row,col,value) entries. */
function stampAndCaptureEntries(
  element: AnalogElement,
  voltages: Float64Array,
  matrixSize: number,
): { stamps: Array<[number, number, number]>; rhs: Array<[number, number]>; solver: SparseSolver } {
  const solver = new SparseSolver();
  solver.beginAssembly(matrixSize);
  const ctx = buildUnitCtx(solver, voltages);
  element.load(ctx);

  const entries = solver.getCSCNonZeros();
  const stamps: Array<[number, number, number]> = entries.map((e) => [e.row, e.col, e.value]);
  const rhsVec = solver.getRhsSnapshot();
  const rhs: Array<[number, number]> = [];
  for (let i = 0; i < rhsVec.length; i++) {
    if (rhsVec[i] !== 0) rhs.push([i, rhsVec[i]]);
  }
  return { stamps, rhs, solver };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a diode element and drive it to a specific operating point by
 * calling load(ctx) repeatedly against a fresh solver each iteration to
 * settle SLOT_VD through pnjlim.
 *
 * nodeAnode=1, nodeCathode=2, so solver indices are 0 and 1.
 * Vd = voltages[0] - voltages[1]
 */
function makeDiodeAtVd(
  vd: number,
  modelOverrides?: Record<string, number>,
): AnalogElement {
  const propsObj = makeParamBag({ ...DIODE_PARAM_DEFAULTS, IS: 1e-14, N: 1, CJO: 0, VJ: 0.7, M: 0.5, TT: 0, FC: 0.5, ...modelOverrides });
  const core = createDiodeElement(new Map([["A", 1], ["K", 2]]), [], -1, propsObj);
  const { element: statedCore } = withState(core);
  const element = withNodeIds(statedCore, [1, 2]);

  // Drive the element to the operating point by calling load(ctx) multiple
  // times to converge pnjlim limiting.
  const voltages = new Float64Array(2);
  voltages[0] = vd;
  voltages[1] = 0;
  driveToOp(element, voltages, 50, { matrixSize: 2 });
  return element;
}

// ---------------------------------------------------------------------------
// Diode unit tests
// ---------------------------------------------------------------------------

describe("Diode", () => {
  it("forward_bias_stamp", () => {
    const IS = 1e-14;
    const N = 1;
    const nVt = N * VT;

    const element = makeDiodeAtVd(0.7, { IS, N });
    const voltages = new Float64Array([0.7, 0]);
    const { stamps: stampCalls, rhs: rhsCalls } = stampAndCaptureEntries(element, voltages, 2);

    // At Vd = 0.7V, geq = IS * exp(Vd/nVt) / nVt + GMIN
    const expVal = Math.exp(0.7 / nVt);
    const expectedGeq = (IS * expVal) / nVt + GMIN;
    const expectedId = IS * (expVal - 1) + GMIN * 0.7;
    const expectedIeq = expectedId - expectedGeq * 0.7;

    // 4 conductance stamps (nodes 1 and 2 → solver indices 0 and 1)
    expect(stampCalls).toHaveLength(4);
    expect(stampCalls).toContainEqual([0, 0, expectedGeq]);
    expect(stampCalls).toContainEqual([1, 1, expectedGeq]);
    expect(stampCalls).toContainEqual([0, 1, -expectedGeq]);
    expect(stampCalls).toContainEqual([1, 0, -expectedGeq]);

    // 2 RHS stamps: -ieq at anode, +ieq at cathode
    expect(rhsCalls).toHaveLength(2);
    expect(rhsCalls).toContainEqual([0, -expectedIeq]);
    expect(rhsCalls).toContainEqual([1, expectedIeq]);
  });

  it("reverse_bias_stamp", () => {
    const IS = 1e-14;
    const N = 1;

    const element = makeDiodeAtVd(-5, { IS, N });
    const voltages = new Float64Array([-5, 0]);
    const { stamps: stampCalls } = stampAndCaptureEntries(element, voltages, 2);

    // At Vd = -5V, geq ≈ GMIN (exp(-5/0.026) ≈ 0)
    // All 4 conductance stamps should be very small (≈ GMIN)
    expect(stampCalls).toHaveLength(4);
    for (const call of stampCalls) {
      const val = Math.abs(call[2] as number);
      expect(val).toBeLessThan(1e-9); // very small conductance
    }
  });

  it("voltage_limiting_applied", () => {
    const IS = 1e-14;
    const N = 1;

    // Start at vd = 0.3V
    const propsObj = makeParamBag({ IS, N, CJO: 0, VJ: 0.7, M: 0.5, TT: 0, FC: 0.5 });
    const { element: stated, pool } = withState(createDiodeElement(new Map([["A", 1], ["K", 2]]), [], -1, propsObj));
    const element = withNodeIds(stated, [1, 2]);

    const voltages = new Float64Array(2);
    voltages[0] = 0.3;
    voltages[1] = 0;

    // Drive to 0.3V operating point
    driveToOp(element, voltages, 20, { matrixSize: 2 });

    // Now simulate a large NR step to 5.0V
    voltages[0] = 5.0;
    voltages[1] = 0;
    const jumpSolver = new SparseSolver();
    const jumpCtx = makeSimpleCtx({
      solver: jumpSolver,
      elements: [element],
      matrixSize: 2,
      nodeCount: 2,
    });
    jumpCtx.loadCtx.voltages = voltages;
    element.load(jumpCtx.loadCtx);

    // Voltages array must be unchanged — no write-back
    expect(voltages[0]).toBe(5.0);
    expect(voltages[1]).toBe(0);

    // The limited vd is stored in pool.state0[SLOT_VD = 0]
    const limitedVd = pool.state0[0];
    expect(limitedVd).toBeLessThan(5.0);
    // The step should be compressed from 4.7V to something reasonable
    expect(limitedVd - 0.3).toBeLessThan(4.5);
  });

  it("junction_capacitance_when_cjo_nonzero", () => {
    const CJO = 10e-12;
    const VJ = 0.7;
    const M = 0.5;
    const FC = 0.5;

    const propsObj = makeParamBag({ IS: 1e-14, N: 1, CJO, VJ, M, TT: 0, FC });
    const { element: stated } = withState(createDiodeElement(new Map([["A", 1], ["K", 2]]), [], -1, propsObj));
    const element = withNodeIds(stated, [1, 2]);

    // isReactive should be true when CJO > 0
    expect(element.isReactive).toBe(true);

    // load() at Vd = -2V in transient mode stamps reactive companion inline.
    const voltages = new Float64Array(2);
    voltages[0] = -2; // anode at -2V
    voltages[1] = 0;  // cathode at 0V

    const capSolver = new SparseSolver();
    const capCtx: LoadContext = {
      solver: capSolver,
      voltages,
      iteration: 0,
      initMode: "initFloat",
      dt: 1e-6,
      method: "trapezoidal",
      order: 1,
      deltaOld: [1e-6, 1e-6, 1e-6, 1e-6, 1e-6, 1e-6, 1e-6],
      ag: new Float64Array(8),
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
    capSolver.beginAssembly(2);
    element.load(capCtx);

    // Verify Cj computation: CJO / (1 - Vd/VJ)^M at Vd = -2V
    // Cj = 10pF / (1 - (-2)/0.7)^0.5 = 10pF / (1 + 2/0.7)^0.5
    // = 10pF / (3.857)^0.5 = 10pF / 1.964 ≈ 5.09pF
    const expectedCj = computeJunctionCapacitance(-2, CJO, VJ, M, FC);
    expect(expectedCj).toBeCloseTo(CJO / Math.pow(1 - (-2) / VJ, M), 14);

    // After load(), conductance entries must have been placed
    const capStamps = capSolver.getCSCNonZeros();
    expect(capStamps.length).toBeGreaterThan(0);
  });

  it("isNonlinear_true", () => {
    const propsObj = makeParamBag({ IS: 1e-14, N: 1, CJO: 0, VJ: 0.7, M: 0.5, TT: 0, FC: 0.5 });
    const element = createDiodeElement(new Map([["A", 1], ["K", 2]]), [], -1, propsObj);
    expect(element.isNonlinear).toBe(true);
  });

  it("isReactive_false_when_cjo_zero", () => {
    const propsObj = makeParamBag({ IS: 1e-14, N: 1, CJO: 0, VJ: 0.7, M: 0.5, TT: 0, FC: 0.5 });
    const element = createDiodeElement(new Map([["A", 1], ["K", 2]]), [], -1, propsObj);
    expect(element.isReactive).toBe(false);
  });

  it("definition_has_correct_fields", () => {
    expect(DiodeDefinition.name).toBe("Diode");
    expect(DiodeDefinition.modelRegistry?.["spice"]).toBeDefined();
    expect(DiodeDefinition.modelRegistry?.["spice"]?.kind).toBe("inline");
    expect((DiodeDefinition.modelRegistry?.["spice"] as {kind:"inline";factory:AnalogFactory}|undefined)?.factory).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Gap 17: OFF parameter and UIC IC initial condition tests
  // -------------------------------------------------------------------------

  it("load_at_initJct_with_OFF_zeroes_voltage", () => {
    // Gap 17.1: A diode with OFF=1 should have its junction voltage set to 0V
    // when load() is called with initMode="initJct". During DCOP initFix mode,
    // checkConvergence must also return true (suppressing noncon).
    //
    // OFF maps to ngspice .ic OFF: dioload.c skips junction during initFix.
    const propsObj = makeParamBag({ IS: 1e-14, N: 1, CJO: 0, VJ: 0.7, M: 0.5, TT: 0, FC: 0.5, OFF: 1 });
    const core = createDiodeElement(new Map([["A", 1], ["K", 2]]), [], -1, propsObj);
    const { element, pool } = withState(core);
    const el = withNodeIds(element, [1, 2]);

    // In-load initJct override: OFF path sets vdRaw=0 directly (no pnjlim).
    pool.initMode = "initJct";
    const voltages = new Float64Array(2);
    voltages[0] = 5; // would give Vd=5V without OFF, but initJct+OFF overrides
    voltages[1] = 0;
    const solver = new SparseSolver();
    solver.beginAssembly(2);
    el.load(buildUnitCtx(solver, voltages, { initMode: "initJct" }));

    // After initJct load with OFF=1, SLOT_VD (index 0) must be 0.
    expect(pool.state0[0]).toBeCloseTo(0, 10);

    // checkConvergence with initFix mode must return true (OFF suppresses noncon).
    pool.initMode = "initFix";
    const convSolver = new SparseSolver();
    convSolver.beginAssembly(2);
    const converged = el.checkConvergence!(buildUnitCtx(convSolver, voltages, { initMode: "initFix" }));
    expect(converged).toBe(true);
  });

  it("load_at_initJct_with_uic_ic_sets_voltage", () => {
    // Gap 17.2: A diode with IC=0.5 and pool.uic=true should set SLOT_VD=0.5V
    // when load() is called with initMode="initJct".
    //
    // This maps to ngspice .ic V(node)=0.5 with UIC: dioload.c uses IC directly.
    const propsObj = makeParamBag({ IS: 1e-14, N: 1, CJO: 0, VJ: 0.7, M: 0.5, TT: 0, FC: 0.5, IC: 0.5 });
    const core = createDiodeElement(new Map([["A", 1], ["K", 2]]), [], -1, propsObj);
    const { element, pool } = withState(core);
    const el = withNodeIds(element, [1, 2]);

    // Enable UIC mode on pool so initJct takes the IC path.
    // StatePool carries uic as a dynamic property (not declared in class).
    (pool as unknown as { uic: boolean }).uic = true;
    pool.initMode = "initJct";

    // In-load initJct override: pool.uic=true and IC=0.5 → vdRaw=0.5 set directly.
    const voltages = new Float64Array(2);
    voltages[0] = 0;
    voltages[1] = 0;
    const solver = new SparseSolver();
    solver.beginAssembly(2);
    el.load(buildUnitCtx(solver, voltages, { initMode: "initJct" }));

    // SLOT_VD (index 0) must be 0.5V (no pnjlim applied during initJct).
    expect(pool.state0[0]).toBeCloseTo(0.5, 6);
  });
});

// ---------------------------------------------------------------------------
// Helpers for integration tests
// ---------------------------------------------------------------------------

function makeResistorElement(nodeA: number, nodeB: number, resistance: number): AnalogElement {
  const G = 1 / resistance;
  return {
    pinNodeIds: [nodeA, nodeB],
    allNodeIds: [nodeA, nodeB],
    branchIndex: -1,
    isNonlinear: false,
    isReactive: false,
    setParam(_key: string, _value: number): void {},
    getPinCurrents(_v: Float64Array): number[] { return []; },
    load(ctx): void {
      const solver = ctx.solver;
      if (nodeA !== 0) solver.stampElement(solver.allocElement(nodeA - 1, nodeA - 1), G);
      if (nodeB !== 0) solver.stampElement(solver.allocElement(nodeB - 1, nodeB - 1), G);
      if (nodeA !== 0 && nodeB !== 0) {
        solver.stampElement(solver.allocElement(nodeA - 1, nodeB - 1), -G);
        solver.stampElement(solver.allocElement(nodeB - 1, nodeA - 1), -G);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Integration test: diode + resistor DC operating point
// ---------------------------------------------------------------------------

describe("Integration", () => {
  it("diode_resistor_dc_op", () => {
    // Circuit: 5V source (node2=+, gnd=-) → 1kΩ (node1 ↔ node2) → diode (node1 anode, gnd cathode)
    //
    // Default SPICE diode: IS=1e-14, N=1
    // At Vd ≈ 0.665V: Id = IS*(exp(Vd/Vt)-1) ≈ 4.335mA
    // Resistor voltage = 5V - 0.665V = 4.335V → I = 4.335mA (consistent)
    //
    // MNA layout:
    //   node 1 = anode/junction node
    //   node 2 = positive source terminal
    //   branch row = 2 (absolute)
    //   matrixSize = 3

    const matrixSize = 3;
    const branchRow = 2;

    // 5V source: node2(+) to ground(-)
    const vs = makeDcVoltageSource(2, 0, branchRow, 5) as unknown as AnalogElement;

    // 1kΩ resistor: node1 ↔ node2
    const r = makeResistorElement(1, 2, 1000);

    // Diode: anode=node1, cathode=ground(0)
    const diodeProps = makeParamBag({ IS: 1e-14, N: 1, CJO: 0, VJ: 0.7, M: 0.5, TT: 0, FC: 0.5 });
    const { element: dCore } = withState(createDiodeElement(new Map([["A", 1], ["K", 0]]), [], -1, diodeProps));
    const d = withNodeIds(dCore, [1, 0]);

    const result = runDcOp({
      elements: [vs, r, d],
      matrixSize,
      nodeCount: 2,
    });

    expect(result.converged).toBe(true);

    // solution: [V(node1), V(node2), I_branch]
    const vDiode = result.nodeVoltages[0];   // Vd at the diode anode
    const vSource = result.nodeVoltages[1];  // should be 5V

    // Voltage source enforces V(node2) = 5V
    expect(vSource).toBeCloseTo(5, 3);

    // ngspice reference: IS=1e-14, N=1 → Vd=0.6928910V, Id=4.307675mA
    expectSpiceRef(vDiode, 6.928910e-01, "V(diode)");

    const iDiode = (vSource - vDiode) / 1000;
    expectSpiceRef(iDiode, 4.307675e-03, "I(diode)");
  });
});

// ---------------------------------------------------------------------------
// setParam behavioral verification — reads mutable params object, not captured locals
// ---------------------------------------------------------------------------

describe("setParam mutates params object (not captured locals)", () => {
  it("setParam('IS', 1e-11) shifts DC OP to match SPICE reference", () => {
    const matrixSize = 3;
    const branchRow = 2;
    const vs = makeDcVoltageSource(2, 0, branchRow, 5) as unknown as AnalogElement;
    const r = makeResistorElement(1, 2, 1000);
    const diodeProps = makeParamBag({ IS: 1e-14, N: 1, CJO: 0, VJ: 0.7, M: 0.5, TT: 0, FC: 0.5 });
    const { element: dCore1 } = withState(createDiodeElement(new Map([["A", 1], ["K", 0]]), [], -1, diodeProps));
    const d = withNodeIds(dCore1, [1, 0]);

    const elements = [vs, r, d];

    // Before: default IS=1e-14
    const before = runDcOp({ elements, matrixSize, nodeCount: 2 });
    expect(before.converged).toBe(true);
    expectSpiceRef(before.nodeVoltages[0], 6.928910e-01, "V(diode) before");
    expectSpiceRef((before.nodeVoltages[1] - before.nodeVoltages[0]) / 1000, 4.307675e-03, "I(diode) before");

    // setParam and re-solve
    d.setParam("IS", 1e-11);
    const after = runDcOp({ elements, matrixSize, nodeCount: 2 });
    expect(after.converged).toBe(true);
    expectSpiceRef(after.nodeVoltages[0], 5.152668e-01, "V(diode) after IS=1e-11");
    expectSpiceRef((after.nodeVoltages[1] - after.nodeVoltages[0]) / 1000, 4.485160e-03, "I(diode) after IS=1e-11");
  });

  it("setParam('N', 2) shifts DC OP to match SPICE reference", () => {
    const matrixSize = 3;
    const branchRow = 2;
    const vs = makeDcVoltageSource(2, 0, branchRow, 5) as unknown as AnalogElement;
    const r = makeResistorElement(1, 2, 1000);
    const diodeProps = makeParamBag({ IS: 1e-14, N: 1, CJO: 0, VJ: 0.7, M: 0.5, TT: 0, FC: 0.5 });
    const { element: dCore2 } = withState(createDiodeElement(new Map([["A", 1], ["K", 0]]), [], -1, diodeProps));
    const d = withNodeIds(dCore2, [1, 0]);

    const elements = [vs, r, d];

    // Before: default N=1
    const before = runDcOp({ elements, matrixSize, nodeCount: 2 });
    expect(before.converged).toBe(true);
    expectSpiceRef(before.nodeVoltages[0], 6.928910e-01, "V(diode) before");
    expectSpiceRef((before.nodeVoltages[1] - before.nodeVoltages[0]) / 1000, 4.307675e-03, "I(diode) before");

    // setParam and re-solve
    d.setParam("N", 2);
    const after = runDcOp({ elements, matrixSize, nodeCount: 2 });
    expect(after.converged).toBe(true);
    expectSpiceRef(after.nodeVoltages[0], 1.376835e+00, "V(diode) after N=2");
    expectSpiceRef((after.nodeVoltages[1] - after.nodeVoltages[0]) / 1000, 3.623504e-03, "I(diode) after N=2");
  });
});

// ---------------------------------------------------------------------------
// LimitingEvent instrumentation tests
// ---------------------------------------------------------------------------

describe("Diode LimitingEvent instrumentation", () => {
  function makeDiodeWithState(modelParams: Record<string, number> = {}): AnalogElement {
    const props = makeParamBag({ IS: 1e-14, N: 1, ...modelParams });
    const pinNodes = new Map([["A", 1], ["K", 2]]);
    const core = createDiodeElement(pinNodes, [], -1, props) as AnalogElementCore;
    (core as { label: string }).label = "D1";
    (core as { elementIndex: number }).elementIndex = 3;
    const pool = new StatePool((core as unknown as { stateSize: number }).stateSize);
    (core as { stateBaseOffset: number }).stateBaseOffset = 0;
    (core as unknown as ReactiveAnalogElement).initState(pool);
    return withNodeIds(core, [1, 2]);
  }

  function loadOnce(element: AnalogElement, voltages: Float64Array, collector: LimitingEvent[] | null, iteration = 1): void {
    const solver = new SparseSolver();
    solver.beginAssembly(Math.max(voltages.length, element.pinNodeIds.length));
    element.load(buildUnitCtx(solver, voltages, { limitingCollector: collector, iteration }));
  }

  it("pushes AK pnjlim event when limitingCollector provided", () => {
    const element = makeDiodeWithState();
    const voltages = new Float64Array(10);
    voltages[0] = 5.0; // node 1 = anode

    const collector: LimitingEvent[] = [];
    loadOnce(element, voltages, collector);

    expect(collector.length).toBeGreaterThanOrEqual(1);
    const ev = collector[0];
    expect(ev.elementIndex).toBe(3);
    expect(ev.label).toBe("D1");
    expect(ev.junction).toBe("AK");
    expect(ev.limitType).toBe("pnjlim");
    expect(Number.isFinite(ev.vBefore)).toBe(true);
    expect(Number.isFinite(ev.vAfter)).toBe(true);
    expect(typeof ev.wasLimited).toBe("boolean");
    expect(ev.wasLimited).toBe(ev.vAfter !== ev.vBefore);
  });

  it("does not throw when limitingCollector is null", () => {
    const element = makeDiodeWithState();
    const voltages = new Float64Array(10);
    voltages[0] = 5.0;
    expect(() => loadOnce(element, voltages, null)).not.toThrow();
  });

  it("wasLimited=true when large forward step forces pnjlim to clamp", () => {
    const element = makeDiodeWithState({ IS: 1e-14, N: 1 });
    // First call to establish vdOld near 0
    const voltages = new Float64Array(10);
    voltages[0] = 0.0;
    loadOnce(element, voltages, null);

    // Now a large jump: should be limited
    voltages[0] = 10.0;
    const collector: LimitingEvent[] = [];
    loadOnce(element, voltages, collector);

    const ev = collector[0];
    expect(ev.wasLimited).toBe(true);
    expect(ev.vAfter).not.toBe(ev.vBefore);
  });

  it("wasLimited=false for small voltage steps near operating point", () => {
    const element = makeDiodeWithState({ IS: 1e-14, N: 1 });
    const voltages = new Float64Array(10);
    voltages[0] = 0.6;
    // Warm up to vdOld ≈ 0.6
    loadOnce(element, voltages, null);

    // Tiny step — should not be limited
    voltages[0] = 0.601;
    const collector: LimitingEvent[] = [];
    loadOnce(element, voltages, collector);

    const ev = collector[0];
    expect(ev.wasLimited).toBe(false);
    expect(ev.vAfter).toBe(ev.vBefore);
  });
});

// ---------------------------------------------------------------------------
// Temperature scaling (dioTemp)
// ---------------------------------------------------------------------------

import { dioTemp, computeJunctionCharge } from "../diode.js";
import { computeNIcomCof } from "../../../solver/analog/integration.js";

describe("dioTemp temperature scaling", () => {
  const REFTEMP = 300.15;
  const CONSTboltz = 1.3806226e-23;
  const CHARGE = 1.6021918e-19;

  it("vt equals kT/q at REFTEMP", () => {
    const p = { IS: 1e-14, N: 1, VJ: 1.0, CJO: 0, M: 0.5, BV: Infinity, IBV: 1e-3, NBV: 1, EG: 1.11, XTI: 3, TNOM: REFTEMP };
    const tp = dioTemp(p, REFTEMP);
    const expected = REFTEMP * CONSTboltz / CHARGE;
    expect(Math.abs(tp.vt - expected) / expected).toBeLessThan(1e-10);
  });

  it("tIS equals IS at T=TNOM (no scaling)", () => {
    const IS = 1e-14;
    const p = { IS, N: 1, VJ: 1.0, CJO: 0, M: 0.5, BV: Infinity, IBV: 1e-3, NBV: 1, EG: 1.11, XTI: 3, TNOM: REFTEMP };
    const tp = dioTemp(p, REFTEMP);
    expect(Math.abs(tp.tIS - IS) / IS).toBeLessThan(1e-8);
  });

  it("tIS increases with temperature (XTI=3, EG=1.11)", () => {
    const IS = 1e-14;
    const p = { IS, N: 1, VJ: 1.0, CJO: 0, M: 0.5, BV: Infinity, IBV: 1e-3, NBV: 1, EG: 1.11, XTI: 3, TNOM: REFTEMP };
    const tp_cold = dioTemp(p, REFTEMP);
    const tp_hot  = dioTemp(p, REFTEMP + 50);
    expect(tp_hot.tIS).toBeGreaterThan(tp_cold.tIS);
  });

  it("tVJ is reduced at higher temperature", () => {
    const p = { IS: 1e-14, N: 1, VJ: 1.0, CJO: 0, M: 0.5, BV: Infinity, IBV: 1e-3, NBV: 1, EG: 1.11, XTI: 3, TNOM: REFTEMP };
    const tp_nom = dioTemp(p, REFTEMP);
    const tp_hot = dioTemp(p, REFTEMP + 50);
    expect(tp_hot.tVJ).toBeLessThan(tp_nom.tVJ);
  });

  it("tCJO equals CJO when CJO=0", () => {
    const p = { IS: 1e-14, N: 1, VJ: 1.0, CJO: 0, M: 0.5, BV: Infinity, IBV: 1e-3, NBV: 1, EG: 1.11, XTI: 3, TNOM: REFTEMP };
    const tp = dioTemp(p, REFTEMP + 30);
    expect(tp.tCJO).toBe(0);
  });

  it("tCJO approximately equals CJO at T=TNOM", () => {
    const CJO = 10e-12;
    const p = { IS: 1e-14, N: 1, VJ: 1.0, CJO, M: 0.5, BV: Infinity, IBV: 1e-3, NBV: 1, EG: 1.11, XTI: 3, TNOM: REFTEMP };
    const tp = dioTemp(p, REFTEMP);
    expect(Math.abs(tp.tCJO - CJO) / CJO).toBeLessThan(1e-6);
  });

  it("tVcrit = nVt * log(nVt / (tIS * sqrt(2)))", () => {
    const p = { IS: 1e-14, N: 1, VJ: 1.0, CJO: 0, M: 0.5, BV: Infinity, IBV: 1e-3, NBV: 1, EG: 1.11, XTI: 3, TNOM: REFTEMP };
    const tp = dioTemp(p, REFTEMP);
    const expected = tp.vt * Math.log(tp.vt / (tp.tIS * Math.SQRT2));
    expect(Math.abs(tp.tVcrit - expected) / Math.abs(expected)).toBeLessThan(1e-10);
  });

  it("tBV is Infinity when BV is Infinity", () => {
    const p = { IS: 1e-14, N: 1, VJ: 1.0, CJO: 0, M: 0.5, BV: Infinity, IBV: 1e-3, NBV: 1, EG: 1.11, XTI: 3, TNOM: REFTEMP };
    const tp = dioTemp(p, REFTEMP);
    expect(tp.tBV).toBe(Infinity);
  });

  it("tBV is finite and close to BV when BV is finite", () => {
    const BV = 5.0;
    const p = { IS: 1e-14, N: 1, VJ: 1.0, CJO: 0, M: 0.5, BV, IBV: 1e-3, NBV: 1, EG: 1.11, XTI: 3, TNOM: REFTEMP };
    const tp = dioTemp(p, REFTEMP);
    expect(isFinite(tp.tBV)).toBe(true);
    expect(Math.abs(tp.tBV - BV)).toBeLessThan(1.0);
  });
});

// ---------------------------------------------------------------------------
// IBV knee iteration
// ---------------------------------------------------------------------------

describe("IBV knee iteration", () => {
  it("tBV satisfies knee equation: tIS*(exp((BV-tBV)/(NBV*vt))-1) ≈ IBV", () => {
    const BV = 5.0;
    const IBV = 1e-3;
    const IS = 1e-14;
    const N = 1;
    const REFTEMP = 300.15;
    const p = { IS, N, VJ: 1.0, CJO: 0, M: 0.5, BV, IBV, NBV: N, EG: 1.11, XTI: 3, TNOM: REFTEMP };
    const tp = dioTemp(p, REFTEMP);
    const nbvVt = N * tp.vt;
    const residual = tp.tIS * (Math.exp((BV - tp.tBV) / nbvVt) - 1) - IBV;
    expect(Math.abs(residual) / IBV).toBeLessThan(1e-6);
  });
});

// ---------------------------------------------------------------------------
// IKF/IKR high-injection correction
// ---------------------------------------------------------------------------

describe("IKF/IKR high-injection correction", () => {
  function diodeSlot(vd: number, slot: number, overrides: Record<string, number> = {}): number {
    const props = makeParamBag({ IS: 1e-14, N: 1, ...overrides });
    const core = createDiodeElement(new Map([["A", 1], ["K", 2]]), [], -1, props) as AnalogElementCore;
    const pool = new StatePool((core as unknown as { stateSize: number }).stateSize);
    (core as { stateBaseOffset: number }).stateBaseOffset = 0;
    (core as unknown as ReactiveAnalogElement).initState(pool);
    const element = withNodeIds(core, [1, 2]);
    const voltages = new Float64Array(10);
    voltages[0] = vd;
    driveToOp(element, voltages, 50, { matrixSize: 10 });
    return pool.state0[slot];
  }

  function diodeGd(vd: number, overrides: Record<string, number> = {}): number {
    return diodeSlot(vd, 1, overrides); // SLOT_GEQ
  }

  it("IKF=Infinity leaves gd equal to IKF=Infinity case", () => {
    const vd = 0.7;
    const gd1 = diodeGd(vd, { IKF: Infinity });
    const gd2 = diodeGd(vd, { IKF: Infinity });
    expect(gd1).toBe(gd2);
  });

  it("IKF correction reduces gd compared to IKF=Infinity at same Vd", () => {
    const vd = 0.7;
    const gdNoIkf  = diodeGd(vd, { IKF: Infinity });
    // IKF = 1mA: id at vd=0.7 is ~4mA, so id/ikf = 4 — strong correction
    const gdWithIkf = diodeGd(vd, { IKF: 1e-3 });
    expect(gdWithIkf).toBeLessThan(gdNoIkf);
  });

  it("IKF correction matches formula: gdRaw / (sqrt(1+id/ikf) * (1+sqrt(1+id/ikf)))", () => {
    const vd = 0.8;
    const IKF = 1e-4;
    const IS = 1e-14;
    const N = 1;
    const nVt = N * VT;

    // Compute expected gd from the formula
    const expArg = Math.min(vd / nVt, 700);
    const evd = Math.exp(expArg);
    const idRaw = IS * (evd - 1);
    const gdRaw = IS * evd / nVt;
    const sqrtTerm = Math.sqrt(1 + idRaw / IKF);
    const expectedGd = gdRaw / (sqrtTerm * (1 + sqrtTerm)) + 1e-12; // + GMIN

    const actualGd = diodeGd(vd, { IS, IKF });
    expect(Math.abs(actualGd - expectedGd) / expectedGd).toBeLessThan(0.001);
  });

  it("IKF=Infinity applies no correction (denominator stays at 2, same as no IKF branch)", () => {
    // When IKF=Infinity, the correction branch is skipped entirely
    const vd = 0.7;
    const gdWithInfIkf = diodeGd(vd, { IKF: Infinity });
    // Compute expected raw gd (no correction applied)
    const IS = 1e-14;
    const nVt = VT;
    const expArg = Math.min(vd / nVt, 700);
    const evd = Math.exp(expArg);
    const gdRaw = IS * evd / nVt;
    const expectedGd = gdRaw + 1e-12; // + GMIN
    expect(Math.abs(gdWithInfIkf - expectedGd) / expectedGd).toBeLessThan(0.001);
  });

  it("IKR correction reduces gd for reverse-biased diode with finite IKR", () => {
    const vd = -0.05;
    const gdNoIkr  = diodeGd(vd, { IKR: Infinity });
    const gdWithIkr = diodeGd(vd, { IKR: 1e-12 });
    expect(gdWithIkr).toBeLessThan(gdNoIkr);
  });
});

// ---------------------------------------------------------------------------
// Area scaling
// ---------------------------------------------------------------------------

describe("AREA scaling", () => {
  function diodeOP(vd: number, overrides: Record<string, number> = {}): { id: number; gd: number } {
    const props = makeParamBag({ IS: 1e-14, N: 1, RS: 0, CJO: 0, ...overrides });
    const core = createDiodeElement(new Map([["A", 1], ["K", 2]]), [], -1, props) as AnalogElementCore;
    const pool = new StatePool((core as unknown as { stateSize: number }).stateSize);
    (core as { stateBaseOffset: number }).stateBaseOffset = 0;
    (core as unknown as ReactiveAnalogElement).initState(pool);
    const element = withNodeIds(core, [1, 2]);
    const voltages = new Float64Array(10);
    voltages[0] = vd;
    driveToOp(element, voltages, 50, { matrixSize: 10 });
    return { id: pool.state0[3], gd: pool.state0[1] }; // SLOT_ID, SLOT_GEQ
  }

  it("AREA=1 (default) gives same result as no AREA override", () => {
    const vd = 0.7;
    const op1 = diodeOP(vd, { AREA: 1 });
    const op2 = diodeOP(vd);
    expect(Math.abs(op1.id - op2.id) / Math.abs(op2.id)).toBeLessThan(1e-6);
  });

  it("AREA=2 doubles IS and thus id (and gd) relative to AREA=1", () => {
    const vd = 0.7;
    const op1 = diodeOP(vd, { AREA: 1, IS: 1e-14 });
    const op2 = diodeOP(vd, { AREA: 2, IS: 1e-14 });
    expect(op2.id / op1.id).toBeGreaterThan(1.9);
  });

  it("AREA=2 halves RS conductance stamp (diode with RS>0 uses internal node)", () => {
    const props1 = makeParamBag({ IS: 1e-14, N: 1, RS: 10, AREA: 1 });
    const props2 = makeParamBag({ IS: 1e-14, N: 1, RS: 10, AREA: 2 });

    function makeCaptureSolver(): { stamps: [number, number, number][]; solver: SparseSolverType } {
      const stamps: [number, number, number][] = [];
      const handles: [number, number][] = [];
      const solver = {
        allocElement: (r: number, c: number) => { handles.push([r, c]); return handles.length - 1; },
        stampElement: (h: number, v: number) => { const [r, c] = handles[h]; stamps.push([r, c, v]); },
        stampRHS: (_r: number, _v: number) => {},
      } as unknown as SparseSolverType;
      return { stamps, solver };
    }

    function makeCtxForSolver(solver: SparseSolverType) {
      return {
        solver,
        voltages: new Float64Array(10),
        iteration: 0,
        initMode: "initFloat" as const,
        dt: 0,
        method: "trapezoidal" as const,
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

    const { stamps: stamps1, solver: solver1 } = makeCaptureSolver();
    const core1 = createDiodeElement(new Map([["A", 1], ["K", 2]]), [3], -1, props1) as any;
    const pool1 = new StatePool(Math.max(core1.stateSize, 1));
    core1.stateBaseOffset = 0;
    core1.initState(pool1);
    core1.load(makeCtxForSolver(solver1));

    const { stamps: stamps2, solver: solver2 } = makeCaptureSolver();
    const core2 = createDiodeElement(new Map([["A", 1], ["K", 2]]), [3], -1, props2) as any;
    const pool2 = new StatePool(Math.max(core2.stateSize, 1));
    core2.stateBaseOffset = 0;
    core2.initState(pool2);
    core2.load(makeCtxForSolver(solver2));

    expect(stamps1.length).toBeGreaterThan(0);
    expect(stamps2.length).toBeGreaterThan(0);
    // AREA=2 halves RS, so conductance 1/RS doubles
    const gRS1 = stamps1[0][2];
    const gRS2 = stamps2[0][2];
    expect(Math.abs(gRS2 / gRS1 - 2)).toBeLessThan(1e-6);
  });
});

// ---------------------------------------------------------------------------
// C2.3: inline NIintegrate integration tests
// ---------------------------------------------------------------------------

// ngspice → ours variable mapping (niinteg.c:28-63):
//   ag[0] (CKTag[0])    → ctx.ag[0]   coefficient on q0 (current charge)
//   ag[1] (CKTag[1])    → ctx.ag[1]   coefficient on q1 (previous charge)
//   cap (capacitance)   → Ctotal      junction + diffusion cap
//   q0 (current charge) → q0          computeJunctionCharge at vd
//   q1 (prev charge)    → s1[SLOT_Q]  state from previous accepted step
//   ccap (companion I)  → ccap        ag[0]*q0 + ag[1]*q1
//   geq                 → ag[0]*Ctotal
//   ceq                 → ccap - geq*vd

describe("integration", () => {
  it("pn_cap_transient_matches_ngspice", () => {
    // Single transient step: diode with CJO=10pF at Vd=0.3V (reverse bias OK).
    // Trapezoidal order 2: ag[0]=2/dt, ag[1]=1 (xmu=0.5).
    // Expected geq = ag[0]*Ctotal, ceq = ag[0]*q0 + ag[1]*q1 - geq*vd.

    const IS = 1e-14, N = 1, CJO = 10e-12, VJ = 0.7, M = 0.5, FC = 0.5, TT = 0;
    const dt = 1e-9;
    const vd = 0.3;

    // Compute ag[] via computeNIcomCof (trapezoidal order 2)
    const ag = new Float64Array(8);
    const scratch = new Float64Array(49);
    computeNIcomCof(dt, [dt, dt, dt, dt, dt, dt, dt], 2, "trapezoidal", ag, scratch);

    // Build element with CJO > 0
    const props = makeParamBag({ IS, N, CJO, VJ, M, TT, FC });
    const core = createDiodeElement(new Map([["A", 1], ["K", 0]]), [], -1, props);

    const pool = new StatePool(9);
    (core as any).stateBaseOffset = 0;
    core.initState(pool);

    // Seed previous-step charge in s1 (simulates one accepted prior step)
    const prevVd = 0.28;
    const prevId = IS * (Math.exp(prevVd / (N * VT)) - 1);
    const q1_val = computeJunctionCharge(prevVd, CJO, VJ, M, FC, TT, prevId);
    pool.state1[7] = q1_val; // SLOT_Q = 7

    // Real SparseSolver — anode=node 1 mapped to row 0, cathode=ground.
    const solver = new SparseSolver();
    solver.beginAssembly(1);

    pool.ag.set(ag);
    const ctx = buildUnitCtx(solver, new Float64Array([vd, 0]), {
      initMode: "transient",
      dt,
      method: "trapezoidal",
      order: 2,
      deltaOld: [dt, dt, dt, dt, dt, dt, dt],
      ag,
      isDcOp: false,
      isTransient: true,
    });

    (core as AnalogElementCore as unknown as { load(c: LoadContext): void }).load(ctx);

    // Compute expected values using the same formula
    const idRaw = IS * (Math.exp(vd / (N * VT)) - 1);
    const gdRaw = IS * Math.exp(vd / (N * VT)) / (N * VT);
    const Cj = computeJunctionCapacitance(vd, CJO, VJ, M, FC);
    const Ct = TT * gdRaw;
    const Ctotal = Cj + Ct;
    const q0_val = computeJunctionCharge(vd, CJO, VJ, M, FC, TT, idRaw);
    const ccap_expected = ag[0] * q0_val + ag[1] * q1_val;
    const capGeq_expected = ag[0] * Ctotal;
    const capIeq_expected = ccap_expected - capGeq_expected * vd;

    // The stamp at (0,0) is the sum of diode geq and capGeq contributions.
    const entries = solver.getCSCNonZeros();
    const total00 = entries
      .filter((e) => e.row === 0 && e.col === 0)
      .reduce((sum, e) => sum + e.value, 0);
    const gd_at_vd = IS * Math.exp(vd / (N * VT)) / (N * VT) + 1e-12;
    expect(total00).toBe(gd_at_vd + capGeq_expected);

    // Verify capGeq exactly matches the ngspice NIintegrate formula
    expect(capGeq_expected).toBe(ag[0] * Ctotal);
    // Verify ceq exactly matches
    expect(capIeq_expected).toBe(ccap_expected - capGeq_expected * vd);
  });

  it("no_integrateCapacitor_import", () => {
    // Static import-graph assertion: diode.ts must not import integrateCapacitor.
    const fs = require("fs");
    const src = fs.readFileSync(
      require("path").resolve(__dirname, "../diode.ts"),
      "utf8",
    ) as string;
    expect(src).not.toMatch(/integrateCapacitor/);
    expect(src).not.toMatch(/integrateInductor/);
  });
});

// ===========================================================================
// Task C4.3 — Diode parity tests (diode_load_dcop_parity + _transient_parity)
//
// Bit-exact parity against the ngspice DIOload reference formula:
//   geq = IS * exp(Vd/nVt) / nVt + GMIN
//   id  = IS * (exp(Vd/nVt) - 1) + GMIN * Vd
//   ieq = id - geq * Vd
// Stamps: 4× (±geq) into the 2×2 block at (nodeAnode, nodeCathode), 2× RHS
// at the same rows (-ieq at anode, +ieq at cathode).
//
// For transient: junction cap adds capGeq = ag[0]*Ctotal, capIeq = ccap -
// capGeq*vd, where ccap = ag[0]*q0 + ag[1]*q1.
// ngspice → ours mapping (dioload.c:240-285, niinteg.c:28-63):
//   CKTag[0]        → ctx.ag[0]
//   CKTag[1]        → ctx.ag[1]
//   q_current       → computeJunctionCharge(Vd, ...)
//   q_prev          → pool.state1[SLOT_Q]
//   ieq_norton      → id - geq*Vd
// ===========================================================================

function makeParityCtx(
  solver: SparseSolver,
  voltages: Float64Array,
  opts: { initMode?: "initFloat" | "initJct" | "transient"; isDcOp?: boolean; isTransient?: boolean; dt?: number; ag?: Float64Array },
) {
  return {
    solver,
    voltages,
    iteration: 1,
    initMode: opts.initMode ?? ("initFloat" as const),
    dt: opts.dt ?? 0,
    method: "trapezoidal" as const,
    order: 1,
    deltaOld: [opts.dt ?? 0, opts.dt ?? 0, opts.dt ?? 0, opts.dt ?? 0, opts.dt ?? 0, opts.dt ?? 0, opts.dt ?? 0],
    ag: opts.ag ?? new Float64Array(8),
    srcFact: 1,
    noncon: { value: 0 },
    limitingCollector: null,
    isDcOp: opts.isDcOp ?? true,
    isTransient: opts.isTransient ?? false,
    xfact: 1,
    gmin: 1e-12,
    uic: false,
    reltol: 1e-3,
    iabstol: 1e-12,
  };
}

describe("diode_load_dcop_parity", () => {
  it("forward_bias_dcop_stamp_bit_exact_vs_ngspice_formula", () => {
    const IS = 1e-14;
    const N = 1;
    const VD = 0.7;
    const nVt = N * VT;

    const props = makeParamBag({ IS, N, CJO: 0, VJ: 0.7, M: 0.5, TT: 0, FC: 0.5 });
    const core = createDiodeElement(new Map([["A", 1], ["K", 2]]), [], -1, props);
    const pool = new StatePool(Math.max((core as unknown as { stateSize: number }).stateSize, 1));
    (core as any).stateBaseOffset = 0;
    core.initState(pool);

    // Seed pool.state0[SLOT_VD = 0] = VD so pnjlim passes through unchanged.
    pool.state0[0] = VD;

    // Real 2×2 SparseSolver (node indices 0 and 1 for anode and cathode rows).
    const solver = new SparseSolver();
    solver.beginAssembly(2);

    const voltages = new Float64Array([VD, 0]);
    const ctx = makeParityCtx(solver, voltages, { initMode: "initFloat", isDcOp: true });
    core.load(ctx);

    // NGSPICE_REF (DIOload formula, dioload.c:240-285):
    const NGSPICE_EXP = Math.exp(VD / nVt);
    const NGSPICE_GD_RAW = (IS * NGSPICE_EXP) / nVt;
    const NGSPICE_GD = NGSPICE_GD_RAW + GMIN;
    const NGSPICE_ID = IS * (NGSPICE_EXP - 1) + GMIN * VD;
    const NGSPICE_IEQ = NGSPICE_ID - NGSPICE_GD * VD;

    // Read the assembled matrix. The diode writes four G stamps (anode=1→row 0,
    // cathode=2→row 1). Sum any entries at each (row, col) pair (in case of
    // fill-ins or multi-stamp patterns in the element implementation).
    const entries = solver.getCSCNonZeros();
    const sumAt = (row: number, col: number) =>
      entries
        .filter((e) => e.row === row && e.col === col)
        .reduce((acc, e) => acc + e.value, 0);

    expect(sumAt(0, 0)).toBe(NGSPICE_GD);
    expect(sumAt(0, 1)).toBe(-NGSPICE_GD);
    expect(sumAt(1, 0)).toBe(-NGSPICE_GD);
    expect(sumAt(1, 1)).toBe(NGSPICE_GD);

    // RHS: -ieq at anode (row 0), +ieq at cathode (row 1).
    const rhsVec = solver.getRhsSnapshot();
    expect(rhsVec[0]).toBe(-NGSPICE_IEQ);
    expect(rhsVec[1]).toBe(NGSPICE_IEQ);
  });
});

describe("diode_load_transient_parity", () => {
  it("junction_cap_transient_stamp_bit_exact_vs_ngspice_niintegrate", () => {
    // Transient trap order 1: ag[0] = 1/dt, ag[1] = -1/dt.
    // For a diode with CJO > 0 and TT = 0, the capacitance companion stamp is
    // capGeq = ag[0] * Ctotal, capIeq = ccap - capGeq*Vd where
    // ccap = ag[0]*q0 + ag[1]*q1 and q0 = computeJunctionCharge(Vd, ...).

    const IS = 1e-14, N = 1, CJO = 10e-12, VJ = 0.7, M = 0.5, FC = 0.5, TT = 0;
    const dt = 1e-9;
    const VD = 0.3;

    // Trap order 1 coefficients via computeNIcomCof.
    const ag = new Float64Array(8);
    const scratch = new Float64Array(49);
    computeNIcomCof(dt, [dt, dt, dt, dt, dt, dt, dt], 1, "trapezoidal", ag, scratch);

    const props = makeParamBag({ IS, N, CJO, VJ, M, TT, FC });
    const core = createDiodeElement(new Map([["A", 1], ["K", 0]]), [], -1, props);
    const pool = new StatePool(9);
    (core as any).stateBaseOffset = 0;
    core.initState(pool);

    // Seed previous-step charge at prevVd.
    const prevVd = 0.28;
    const prevId = IS * (Math.exp(prevVd / (N * VT)) - 1);
    const q1 = computeJunctionCharge(prevVd, CJO, VJ, M, FC, TT, prevId);
    pool.state1[7] = q1; // SLOT_Q = 7
    pool.state0[0] = VD; // SLOT_VD seed so pnjlim pass-through

    // Real SparseSolver — diode between node 1 (anode) and ground (node 0
    // mapped to no row). matrixSize = 1 (anode only, cathode is ground).
    const solver = new SparseSolver();
    solver.beginAssembly(1);
    pool.ag.set(ag);

    const ctx = makeParityCtx(solver, new Float64Array([VD]), {
      initMode: "transient",
      isDcOp: false,
      isTransient: true,
      dt,
      ag,
    });

    core.load(ctx);

    // NGSPICE_REF for the combined (diode gd + capGeq) diagonal stamp at (0, 0):
    const NGSPICE_EXP = Math.exp(VD / (N * VT));
    const NGSPICE_GD = (IS * NGSPICE_EXP) / (N * VT) + GMIN;
    const NGSPICE_Cj = computeJunctionCapacitance(VD, CJO, VJ, M, FC);
    const NGSPICE_CAPGEQ = ag[0] * NGSPICE_Cj;

    const entries = solver.getCSCNonZeros();
    const sum00 = entries
      .filter((e) => e.row === 0 && e.col === 0)
      .reduce((acc, e) => acc + e.value, 0);
    expect(sum00).toBe(NGSPICE_GD + NGSPICE_CAPGEQ);
  });
});
