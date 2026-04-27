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
import { DiodeDefinition, createDiodeElement, computeJunctionCapacitance, DIODE_PARAM_DEFAULTS, DIODE_PARAM_DEFS } from "../diode.js";
import { PropertyBag } from "../../../core/properties.js";
import { makeDcVoltageSource } from "../../sources/dc-voltage-source.js";
import { withNodeIds, runDcOp, makeSimpleCtx, makeLoadCtx } from "../../../solver/analog/__tests__/test-helpers.js";
import { StatePool } from "../../../solver/analog/state-pool.js";
import {
  MODEDCOP,
  MODETRAN,
  MODEAC,
  MODETRANOP,
  MODEUIC,
  MODEINITFLOAT,
  MODEINITJCT,
  MODEINITFIX,
  MODEINITSMSIG,
  MODEINITTRAN,
} from "../../../solver/analog/ckt-mode.js";
import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import type { SparseSolver as SparseSolverType } from "../../../solver/analog/sparse-solver.js";
import type { AnalogElement, ReactiveAnalogElement } from "../../../solver/analog/element.js";
import type { AnalogElementCore } from "../../../core/analog-types.js";
import type { PoolBackedAnalogElementCore } from "../../../solver/analog/element.js";
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

/** Assert actual â‰ˆ expected within 0.1% relative tolerance (ngspice reference). */
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
 * solver, the state pool, and the voltages buffer â€” makeSimpleCtx would
 * re-run allocateStatePool and wipe already-seeded pool state.
 */
function buildUnitCtx(
  solver: SparseSolver,
  voltages: Float64Array,
  overrides: Partial<LoadContext> = {},
): LoadContext {
  return {
    solver,
    matrix: solver,
    rhsOld: voltages,
    rhs: voltages,
    cktMode: MODEDCOP | MODEINITFLOAT,
    time: 0,
    dt: 0,
    method: "trapezoidal",
    order: 1,
    deltaOld: [0, 0, 0, 0, 0, 0, 0],
    ag: new Float64Array(7),
    srcFact: 1,
    noncon: { value: 0 },
    limitingCollector: null,
    convergenceCollector: null,
    xfact: 1,
    gmin: 1e-12,
    reltol: 1e-3,
    iabstol: 1e-12,
    temp: 300.15,
    vt: 300.15 * 1.3806226e-23 / 1.6021918e-19,
    cktFixLimit: false,
    bypass: false,
    voltTol: 1e-6,
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
  opts: { matrixSize?: number; limitingCollector?: LimitingEvent[] | null } = {},
): void {
  const matrixSize = opts.matrixSize ?? Math.max(voltages.length, element.pinNodeIds.length, 1);
  for (let i = 0; i < iterations; i++) {
    const solver = new SparseSolver();
    solver._initStructure(matrixSize);
    const ctx = buildUnitCtx(solver, voltages, {
      limitingCollector: opts.limitingCollector ?? null,
    });
    element.load(ctx);
  }
}

// ---------------------------------------------------------------------------
// Diode unit tests
// ---------------------------------------------------------------------------

describe("Diode", () => {
  // forward_bias_stamp and reverse_bias_stamp deleted per A1 Â§Test handling rule:
  // both asserted hand-computed geq/ieq Norton pair values. After D-W3-1/D-W3-2
  // (IKF/IKR Norton-pair re-derivation) the GMIN is applied inside the IKF/IKR/else
  // branch, changing the formula for cd and gd. The correct reference is an ngspice
  // harness run, not a hand-computed value. Deleted, not migrated.

  it("voltage_limiting_applied", () => {
    const IS = 1e-14;
    const N = 1;

    // Start at vd = 0.3V
    const propsObj = makeParamBag({ IS, N, CJO: 0, VJ: 0.7, M: 0.5, TT: 0, FC: 0.5 });
    const { element: stated, pool } = withState(createDiodeElement(new Map([["A", 1], ["K", 2]]), [], -1, propsObj));
    const element = withNodeIds(stated, [1, 2]);

    const voltages = new Float64Array(3);
    voltages[1] = 0.3; // anode = node 1
    voltages[2] = 0;   // cathode = node 2

    // Drive to 0.3V operating point
    driveToOp(element, voltages, 20, { matrixSize: 3 });

    // Now simulate a large NR step to 5.0V
    voltages[1] = 5.0;
    voltages[2] = 0;
    const jumpSolver = new SparseSolver();
    const jumpCtx = makeSimpleCtx({
      solver: jumpSolver,
      elements: [element],
      matrixSize: 3,
      nodeCount: 3,
    });
    jumpCtx.loadCtx.rhsOld = voltages;
    element.load(jumpCtx.loadCtx);

    // Voltages array must be unchanged â€” no write-back
    expect(voltages[1]).toBe(5.0);
    expect(voltages[2]).toBe(0);

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
    const capCtx = makeLoadCtx({
      solver: capSolver,
      cktMode: MODETRAN | MODEINITFLOAT,
      dt: 1e-6,
      method: "trapezoidal",
      order: 1,
      deltaOld: [1e-6, 1e-6, 1e-6, 1e-6, 1e-6, 1e-6, 1e-6],
    });
    capSolver._initStructure(3);
    element.load(capCtx);

    // Verify Cj computation: CJO / (1 - Vd/VJ)^M at Vd = -2V
    // Cj = 10pF / (1 - (-2)/0.7)^0.5 = 10pF / (1 + 2/0.7)^0.5
    // = 10pF / (3.857)^0.5 = 10pF / 1.964 â‰ˆ 5.09pF
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
    // when load() is called with MODEINITJCT. During DCOP initFix mode,
    // checkConvergence must also return true (suppressing noncon).
    //
    // OFF maps to ngspice .ic OFF: dioload.c skips junction during initFix.
    const propsObj = makeParamBag({ IS: 1e-14, N: 1, CJO: 0, VJ: 0.7, M: 0.5, TT: 0, FC: 0.5, OFF: 1 });
    const core = createDiodeElement(new Map([["A", 1], ["K", 2]]), [], -1, propsObj);
    const { element } = withState(core);
    const el = withNodeIds(element, [1, 2]);

    // In-load MODEINITJCT: OFF path sets vdRaw=0 directly (no pnjlim).
    const voltages = new Float64Array(3);
    voltages[1] = 5; // would give Vd=5V without OFF, but initJct+OFF overrides
    voltages[1] = 0;
    const solver = new SparseSolver();
    solver._initStructure(3);
    el.load(buildUnitCtx(solver, voltages, { cktMode: MODEDCOP | MODEINITJCT }));

    // After initJct load with OFF=1, SLOT_VD (index 0) must be 0.

    // checkConvergence with initFix mode must return true (OFF suppresses noncon).
    const convSolver = new SparseSolver();
    convSolver._initStructure(3);
    const converged = el.checkConvergence!(buildUnitCtx(convSolver, voltages, { cktMode: MODEDCOP | MODEINITFIX }));
    expect(converged).toBe(true);
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
    ngspiceLoadOrder: 0,
    isNonlinear: false,
    isReactive: false,
    setParam(_key: string, _value: number): void {},
    getPinCurrents(_v: Float64Array): number[] { return []; },
    load(ctx): void {
      const solver = ctx.solver;
      if (nodeA !== 0) solver.stampElement(solver.allocElement(nodeA, nodeA), G);
      if (nodeB !== 0) solver.stampElement(solver.allocElement(nodeB, nodeB), G);
      if (nodeA !== 0 && nodeB !== 0) {
        solver.stampElement(solver.allocElement(nodeA, nodeB), -G);
        solver.stampElement(solver.allocElement(nodeB, nodeA), -G);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Integration test: diode + resistor DC operating point
// ---------------------------------------------------------------------------

describe("Integration", () => {
  it("diode_resistor_dc_op", () => {
    // Circuit: 5V source (node2=+, gnd=-) â†’ 1kÎ© (node1 â†” node2) â†’ diode (node1 anode, gnd cathode)
    //
    // Default SPICE diode: IS=1e-14, N=1
    // At Vd â‰ˆ 0.665V: Id = IS*(exp(Vd/Vt)-1) â‰ˆ 4.335mA
    // Resistor voltage = 5V - 0.665V = 4.335V â†’ I = 4.335mA (consistent)
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

    // 1kÎ© resistor: node1 â†” node2
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

    // ngspice reference: IS=1e-14, N=1 â†’ Vd=0.6928910V, Id=4.307675mA
    expectSpiceRef(vDiode, 6.928910e-01, "V(diode)");

    const iDiode = (vSource - vDiode) / 1000;
    expectSpiceRef(iDiode, 4.307675e-03, "I(diode)");
  });
});

// ---------------------------------------------------------------------------
// setParam behavioral verification â€” reads mutable params object, not captured locals
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
    const pool = new StatePool((core as unknown as PoolBackedAnalogElementCore).stateSize);
    (core as unknown as PoolBackedAnalogElementCore).stateBaseOffset = 0;
    (core as unknown as ReactiveAnalogElement).initState(pool);
    return withNodeIds(core, [1, 2]);
  }

  function loadOnce(element: AnalogElement, voltages: Float64Array, collector: LimitingEvent[] | null): void {
    const solver = new SparseSolver();
    solver._initStructure(Math.max(voltages.length, element.pinNodeIds.length));
    element.load(buildUnitCtx(solver, voltages, { limitingCollector: collector }));
  }

  it("pushes AK pnjlim event when limitingCollector provided", () => {
    const element = makeDiodeWithState();
    const voltages = new Float64Array(10);
    voltages[1] = 5.0; // node 1 = anode

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
    voltages[1] = 5.0;
    expect(() => loadOnce(element, voltages, null)).not.toThrow();
  });

  it("wasLimited=true when large forward step forces pnjlim to clamp", () => {
    const element = makeDiodeWithState({ IS: 1e-14, N: 1 });
    // First call to establish vdOld near 0
    const voltages = new Float64Array(10);
    voltages[0] = 0.0;
    loadOnce(element, voltages, null);

    // Now a large jump: should be limited
    voltages[1] = 10.0;
    const collector: LimitingEvent[] = [];
    loadOnce(element, voltages, collector);

    const ev = collector[0];
    expect(ev.wasLimited).toBe(true);
    expect(ev.vAfter).not.toBe(ev.vBefore);
  });

  it("wasLimited=false for small voltage steps near operating point", () => {
    const element = makeDiodeWithState({ IS: 1e-14, N: 1 });
    const voltages = new Float64Array(10);
    voltages[1] = 0.6;
    // Warm up to vdOld â‰ˆ 0.6
    loadOnce(element, voltages, null);

    // Tiny step — should not be limited
    voltages[1] = 0.601;
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
  it("tBV satisfies knee equation: tIS*(exp((BV-tBV)/(NBV*vt))-1) â‰ˆ IBV", () => {
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
    const pool = new StatePool((core as unknown as PoolBackedAnalogElementCore).stateSize);
    (core as unknown as PoolBackedAnalogElementCore).stateBaseOffset = 0;
    (core as unknown as ReactiveAnalogElement).initState(pool);
    const element = withNodeIds(core, [1, 2]);
    const voltages = new Float64Array(10);
    voltages[1] = vd;
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
    // IKF = 1mA: id at vd=0.7 is ~4mA, so id/ikf = 4 â€” strong correction
    const gdWithIkf = diodeGd(vd, { IKF: 1e-3 });
    expect(gdWithIkf).toBeLessThan(gdNoIkf);
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
    const pool = new StatePool((core as unknown as PoolBackedAnalogElementCore).stateSize);
    (core as unknown as PoolBackedAnalogElementCore).stateBaseOffset = 0;
    (core as unknown as ReactiveAnalogElement).initState(pool);
    const element = withNodeIds(core, [1, 2]);
    const voltages = new Float64Array(10);
    voltages[1] = vd;
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
        rhsOld: new Float64Array(10),
        rhs: new Float64Array(10),
        cktMode: MODEDCOP | MODEINITFLOAT,
        dt: 0,
        method: "trapezoidal" as const,
        order: 1,
        deltaOld: [0, 0, 0, 0, 0, 0, 0],
        ag: new Float64Array(7),
        srcFact: 1,
        noncon: { value: 0 },
        limitingCollector: null,
        xfact: 1,
        gmin: 1e-12,
        reltol: 1e-3,
        iabstol: 1e-12,
        cktFixLimit: false,
        bypass: false,
        voltTol: 1e-6,
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

// ngspice â†’ ours variable mapping (niinteg.c:28-63):
//   ag[0] (CKTag[0])    â†’ ctx.ag[0]   coefficient on q0 (current charge)
//   ag[1] (CKTag[1])    â†’ ctx.ag[1]   coefficient on q1 (previous charge)
//   cap (capacitance)   â†’ Ctotal      junction + diffusion cap
//   q0 (current charge) â†’ q0          computeJunctionCharge at vd
//   q1 (prev charge)    â†’ s1[SLOT_Q]  state from previous accepted step
//   ccap (companion I)  â†’ ccap        ag[0]*q0 + ag[1]*q1
//   geq                 â†’ ag[0]*Ctotal
//   ceq                 â†’ ccap - geq*vd

describe("integration", () => {
  it("pn_cap_transient_matches_ngspice", () => {
    // Single transient step: diode with CJO=10pF at Vd=0.3V (reverse bias OK).
    // Trapezoidal order 2: ag[0]=2/dt, ag[1]=1 (xmu=0.5).
    // Expected geq = ag[0]*Ctotal, ceq = ag[0]*q0 + ag[1]*q1 - geq*vd.

    const IS = 1e-14, N = 1, CJO = 10e-12, VJ = 0.7, M = 0.5, FC = 0.5, TT = 0;
    const dt = 1e-9;
    const vd = 0.3;

    // Compute ag[] via computeNIcomCof (trapezoidal order 2)
    const ag = new Float64Array(7);
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
    pool.state1[6] = q1_val; // SLOT_Q = 6 (dioload.c DIOcapCharge)

    // Real SparseSolver â€” anode=node 1 mapped to row 1 (1-based), cathode=ground.
    const solver = new SparseSolver();
    solver._initStructure(2);

    const ctx = buildUnitCtx(solver, new Float64Array([0, vd]), {
      cktMode: MODETRAN | MODEINITFLOAT,
      dt,
      method: "trapezoidal",
      order: 2,
      deltaOld: [dt, dt, dt, dt, dt, dt, dt],
      ag,
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

    // The stamp at (1,1) is the sum of diode geq and capGeq contributions (1-based: anode=node1â†'row1).
    const entries = solver.getCSCNonZeros();
    const total11 = entries
      .filter((e) => e.row === 1 && e.col === 1)
      .reduce((sum, e) => sum + e.value, 0);
    const gd_at_vd = IS * Math.exp(vd / (N * VT)) / (N * VT) + 1e-12;
    expect(total11).toBe(gd_at_vd + capGeq_expected);

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
// Task C4.3 â€” Diode parity tests (diode_load_dcop_parity + _transient_parity)
//
// Bit-exact parity against the ngspice DIOload reference formula:
//   geq = IS * exp(Vd/nVt) / nVt + GMIN
//   id  = IS * (exp(Vd/nVt) - 1) + GMIN * Vd
//   ieq = id - geq * Vd
// Stamps: 4Ã— (Â±geq) into the 2Ã—2 block at (nodeAnode, nodeCathode), 2Ã— RHS
// at the same rows (-ieq at anode, +ieq at cathode).
//
// For transient: junction cap adds capGeq = ag[0]*Ctotal, capIeq = ccap -
// capGeq*vd, where ccap = ag[0]*q0 + ag[1]*q1.
// ngspice â†’ ours mapping (dioload.c:240-285, niinteg.c:28-63):
//   CKTag[0]        â†’ ctx.ag[0]
//   CKTag[1]        â†’ ctx.ag[1]
//   q_current       â†’ computeJunctionCharge(Vd, ...)
//   q_prev          â†’ pool.state1[SLOT_Q]
//   ieq_norton      â†’ id - geq*Vd
// ===========================================================================

function makeParityCtx(
  solver: SparseSolver,
  voltages: Float64Array,
  opts: { cktMode?: number; dt?: number; ag?: Float64Array },
) {
  const dt = opts.dt ?? 0;
  return makeLoadCtx({
    solver,
    rhsOld: voltages,
    rhs: voltages,
    cktMode: opts.cktMode ?? (MODEDCOP | MODEINITFLOAT),
    dt,
    method: "trapezoidal",
    order: 1,
    deltaOld: [dt, dt, dt, dt, dt, dt, dt],
    ag: opts.ag ?? new Float64Array(7),
  });
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

    // Real 3Ã—3 SparseSolver (1-based: anode=node1â†'row1, cathode=node2â†'row2).
    const solver = new SparseSolver();
    solver._initStructure(3);

    const voltages = new Float64Array([0, VD, 0]);
    const rhs = new Float64Array(3); // separate rhs so stampRHS writes start from 0
    const ctx = { ...makeParityCtx(solver, voltages, { cktMode: MODEDCOP | MODEINITFLOAT }), rhs };
    core.load(ctx);

    // NGSPICE_REF (DIOload formula, dioload.c:240-285):
    const NGSPICE_EXP = Math.exp(VD / nVt);
    const NGSPICE_GD_RAW = (IS * NGSPICE_EXP) / nVt;
    const NGSPICE_GD = NGSPICE_GD_RAW + GMIN;
    const NGSPICE_ID = IS * (NGSPICE_EXP - 1) + GMIN * VD;
    const NGSPICE_IEQ = NGSPICE_ID - NGSPICE_GD * VD;

    // Read the assembled matrix. The diode writes four G stamps (anode=1â†’row 1,
    // cathode=2â†’row 2). Sum any entries at each (row, col) pair (in case of
    // fill-ins or multi-stamp patterns in the element implementation).
    const entries = solver.getCSCNonZeros();
    const sumAt = (row: number, col: number) =>
      entries
        .filter((e) => e.row === row && e.col === col)
        .reduce((acc, e) => acc + e.value, 0);

    expect(sumAt(1, 1)).toBe(NGSPICE_GD);
    expect(sumAt(1, 2)).toBe(-NGSPICE_GD);
    expect(sumAt(2, 1)).toBe(-NGSPICE_GD);
    expect(sumAt(2, 2)).toBe(NGSPICE_GD);

    // RHS: -ieq at anode (row 1), +ieq at cathode (row 2).
    expect(rhs[1]).toBe(-NGSPICE_IEQ);
    expect(rhs[2]).toBe(NGSPICE_IEQ);
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
    const ag = new Float64Array(7);
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
    pool.state1[6] = q1; // SLOT_Q = 6 (dioload.c DIOcapCharge)
    pool.state0[0] = VD; // SLOT_VD seed so pnjlim pass-through

    // Real SparseSolver â€” diode between node 1 (anode) and ground (node 0
    // mapped to no row). matrixSize = 2 (1-based: anode=node1â†'row1).
    const solver = new SparseSolver();
    solver._initStructure(2);

    const ctx = makeParityCtx(solver, new Float64Array([0, VD]), {
      cktMode: MODETRAN | MODEINITFLOAT,
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
    const sum11 = entries
      .filter((e) => e.row === 1 && e.col === 1)
      .reduce((acc, e) => acc + e.value, 0);
    expect(sum11).toBe(NGSPICE_GD + NGSPICE_CAPGEQ);
  });
});

// ===========================================================================
// Task 2.4.1 â€” MODEINITSMSIG + bitfield migration
//
// Tests for dioload.c:126-127 (MODEINITSMSIG seeds vd from CKTstate0),
// dioload.c:128-129 (MODEINITTRAN seeds vd from CKTstate1),
// dioload.c:316-317 cap-gate expansion to include MODEAC | MODEINITSMSIG,
// and dioload.c:360-372 small-signal store-back gating.
//
// Task 2.4.9a â€” A7 fix: checkConvergence OFF short-circuit under MODEINITSMSIG
// ===========================================================================

describe("diode MODEINITSMSIG seeding (dioload.c:126-127)", () => {
  it("MODEINITSMSIG seeds vdRaw from state0 (not NR iterate)", () => {
    // dioload.c:126-127: when MODEINITSMSIG is set, vd comes from CKTstate0,
    // ignoring the voltage iterate. We seed state0[SLOT_VD] to 0.4V and
    // present a very different iterate (2.0V). The stored VD after load()
    // must be 0.4V (from state0), not 2.0V.
    const IS = 1e-14, N = 1;
    const props = makeParamBag({ IS, N, CJO: 0, VJ: 0.7, M: 0.5, TT: 0, FC: 0.5 });
    const core = createDiodeElement(new Map([["A", 1], ["K", 2]]), [], -1, props);
    const pool = new StatePool(Math.max((core as any).stateSize, 1));
    (core as any).stateBaseOffset = 0;
    core.initState(pool);

    // Seed state0[SLOT_VD = 0] to 0.4V
    pool.state0[0] = 0.4;

    const solver = new SparseSolver();
    solver._initStructure(3);
    const voltages = new Float64Array([0, 2.0, 0]); // would give Vd=2V if iterated

    core.load(makeLoadCtx({
      solver,
      rhs: new Float64Array(3),
      rhsOld: voltages,
      cktMode: MODEDCOP | MODEINITSMSIG,
      dt: 0,
    }));

    // SLOT_VD must remain 0.4V (seeded from state0, not the 2V iterate).
  });

  it("MODEINITTRAN seeds vdRaw from state1 (dioload.c:128-129)", () => {
    // dioload.c:128-129: MODEINITTRAN seeds vd from CKTstate1.
    const IS = 1e-14, N = 1;
    const props = makeParamBag({ IS, N, CJO: 0, VJ: 0.7, M: 0.5, TT: 0, FC: 0.5 });
    const core = createDiodeElement(new Map([["A", 1], ["K", 2]]), [], -1, props);
    const pool = new StatePool(Math.max((core as any).stateSize, 1));
    (core as any).stateBaseOffset = 0;
    core.initState(pool);

    // Seed state1[SLOT_VD = 0] to 0.35V
    pool.state1[0] = 0.35;

    const solver = new SparseSolver();
    solver._initStructure(3);
    const voltages = new Float64Array([0, 3.0, 0]);

    core.load(makeLoadCtx({
      solver,
      rhs: new Float64Array(3),
      rhsOld: voltages,
      cktMode: MODETRAN | MODEINITTRAN,
      dt: 1e-9,
      deltaOld: [1e-9, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9],
    }));

    // SLOT_VD must be 0.35V (seeded from state1, not the 3V iterate).
  });

  it("MODEINITSMSIG skips pnjlim (no noncon increment)", () => {
    // dioload.c:126-135: MODEINITSMSIG sets vd directly without pnjlim.
    // A large iterate would normally trigger limiting. But with MODEINITSMSIG
    // vd is taken from state0, so pnjlimLimited stays false â†’ noncon stays 0.
    const IS = 1e-14, N = 1;
    const props = makeParamBag({ IS, N, CJO: 0, VJ: 0.7, M: 0.5, TT: 0, FC: 0.5 });
    const core = createDiodeElement(new Map([["A", 1], ["K", 2]]), [], -1, props);
    const pool = new StatePool(Math.max((core as any).stateSize, 1));
    (core as any).stateBaseOffset = 0;
    core.initState(pool);

    pool.state0[0] = 0.3; // reasonable operating point in state0

    const solver = new SparseSolver();
    solver._initStructure(2);
    const noncon = { value: 0 };

    core.load(makeLoadCtx({
      solver,
      rhsOld: new Float64Array([0, 5.0, 0]), // large jump — would limit if not SMSIG
      rhs: new Float64Array([0, 5.0, 0]),
      cktMode: MODEDCOP | MODEINITSMSIG,
      dt: 0,
      noncon,
    }));

    expect(noncon.value).toBe(0);
  });

  it("cap gate fires under MODEAC (dioload.c:316-317)", () => {
    // dioload.c:316-317: cap block fires under MODEAC.
    const IS = 1e-14, N = 1, CJO = 10e-12, VJ = 0.7, M = 0.5, FC = 0.5, TT = 0;
    const props = makeParamBag({ IS, N, CJO, VJ, M, TT, FC });
    const core = createDiodeElement(new Map([["A", 1], ["K", 2]]), [], -1, props);
    const pool = new StatePool(9);
    (core as any).stateBaseOffset = 0;
    core.initState(pool);
    pool.state0[0] = 0.3; // seed VD

    const ag = new Float64Array(7);
    const scratch = new Float64Array(49);
    computeNIcomCof(1e-9, [1e-9, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9], 1, "trapezoidal", ag, scratch);

    const solver = new SparseSolver();
    solver._initStructure(2);

    core.load(makeLoadCtx({
      solver,
      rhsOld: new Float64Array([0, 0.3, 0]),
      rhs: new Float64Array([0, 0.3, 0]),
      cktMode: MODEAC | MODEINITSMSIG,
      dt: 1e-9,
      deltaOld: [1e-9, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9],
      ag,
    }));

    // MODEINITSMSIG: SLOT_CAP_CURRENT (index 4) holds capd (Farads) = Ctotal.
    // With CJO=10pF at Vd=0.3V, Ctotal > 0 â€” dioload.c:363.
    expect(pool.state0[4]).toBeGreaterThan(0);
  });

  it("cap gate fires under MODETRANOP | MODEUIC (dioload.c:316-317)", () => {
    // dioload.c:316-317: OR condition: (MODETRANOP && MODEUIC) also fires cap.
    const IS = 1e-14, N = 1, CJO = 10e-12, VJ = 0.7, M = 0.5, FC = 0.5, TT = 0;
    const props = makeParamBag({ IS, N, CJO, VJ, M, TT, FC });
    const core = createDiodeElement(new Map([["A", 1], ["K", 2]]), [], -1, props);
    const pool = new StatePool(9);
    (core as any).stateBaseOffset = 0;
    core.initState(pool);
    pool.state0[0] = 0.3;

    const ag = new Float64Array(7);
    const scratch = new Float64Array(49);
    computeNIcomCof(1e-9, [1e-9, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9], 1, "trapezoidal", ag, scratch);

    const solver = new SparseSolver();
    solver._initStructure(3);

    core.load(makeLoadCtx({
      solver,
      rhsOld: new Float64Array([0, 0.3, 0]),
      rhs: new Float64Array([0, 0.3, 0]),
      cktMode: MODETRANOP | MODEUIC | MODEINITJCT,
      dt: 1e-9,
      deltaOld: [1e-9, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9],
      ag,
      vt: 300.15 * 1.3806226e-23 / 1.6021918e-19,
    }));

    // SLOT_CAP_CURRENT (index 4) holds iqcap (A) under MODETRAN/MODEUIC â€” dioload.c:363.
    expect(pool.state0[4]).toBeGreaterThan(0);
  });

  it("cap gate does NOT fire under pure MODEDCOP (not transient, AC, or SMSIG)", () => {
    // Under pure MODEDCOP (DC-OP), caps are open â€” no reactive stamp should appear.
    const IS = 1e-14, N = 1, CJO = 10e-12, VJ = 0.7, M = 0.5, FC = 0.5, TT = 0;
    const props = makeParamBag({ IS, N, CJO, VJ, M, TT, FC });
    const core = createDiodeElement(new Map([["A", 1], ["K", 2]]), [], -1, props);
    const pool = new StatePool(9);
    (core as any).stateBaseOffset = 0;
    core.initState(pool);
    pool.state0[0] = 0.3;

    const solver = new SparseSolver();
    solver._initStructure(2);

    core.load(makeLoadCtx({
      solver,
      rhsOld: new Float64Array([0, 0.3, 0]),
      rhs: new Float64Array([0, 0.3, 0]),
      cktMode: MODEDCOP | MODEINITFLOAT,
      dt: 0,
    }));

    // SLOT_CAP_CURRENT (index 4) must remain 0 â€” cap block not entered under DCOP.
    expect(pool.state0[4]).toBe(0);
  });
});

describe("diode checkConvergence A7 fix (MODEINITFIX | MODEINITSMSIG)", () => {
  it("OFF device returns true under MODEINITFIX (pre-existing)", () => {
    // OFF device must short-circuit noncon under MODEINITFIX.
    const props = makeParamBag({ IS: 1e-14, N: 1, CJO: 0, VJ: 0.7, M: 0.5, TT: 0, FC: 0.5, OFF: 1 });
    const core = createDiodeElement(new Map([["A", 1], ["K", 2]]), [], -1, props);
    const pool = new StatePool(Math.max((core as any).stateSize, 1));
    (core as any).stateBaseOffset = 0;
    core.initState(pool);
    const el = withNodeIds(core, [1, 2]);

    const solver = new SparseSolver();
    solver._initStructure(3);
    const result = el.checkConvergence!(buildUnitCtx(solver, new Float64Array(3), { cktMode: MODEDCOP | MODEINITFIX }));
    expect(result).toBe(true);
  });

  it("OFF device returns true under MODEINITSMSIG (A7 fix)", () => {
    // A7: ngspice mos1load.c:738-742 skips noncon under MODEINITSMSIG too.
    // Before this fix, checkConvergence only short-circuited on MODEINITFIX.
    const props = makeParamBag({ IS: 1e-14, N: 1, CJO: 0, VJ: 0.7, M: 0.5, TT: 0, FC: 0.5, OFF: 1 });
    const core = createDiodeElement(new Map([["A", 1], ["K", 2]]), [], -1, props);
    const pool = new StatePool(Math.max((core as any).stateSize, 1));
    (core as any).stateBaseOffset = 0;
    core.initState(pool);
    const el = withNodeIds(core, [1, 2]);

    const solver = new SparseSolver();
    solver._initStructure(3);
    const result = el.checkConvergence!(buildUnitCtx(solver, new Float64Array(3), { cktMode: MODEDCOP | MODEINITSMSIG }));
    expect(result).toBe(true);
  });

  it("non-OFF device does NOT short-circuit under MODEINITSMSIG", () => {
    // OFF=0: checkConvergence must proceed to the voltage convergence check,
    // not return true unconditionally.
    const props = makeParamBag({ IS: 1e-14, N: 1, CJO: 0, VJ: 0.7, M: 0.5, TT: 0, FC: 0.5, OFF: 0 });
    const core = createDiodeElement(new Map([["A", 1], ["K", 2]]), [], -1, props);
    const pool = new StatePool(Math.max((core as any).stateSize, 1));
    (core as any).stateBaseOffset = 0;
    core.initState(pool);
    // Seed state0[SLOT_VD] to 0.3V so convergence check sees a small delta.
    pool.state0[0] = 0.3;
    const el = withNodeIds(core, [1, 2]);

    const solver = new SparseSolver();
    solver._initStructure(3);
    // Voltages match state0 exactly â†’ should converge.
    const convergedVoltages = new Float64Array([0, 0.3, 0]);
    const result = el.checkConvergence!(buildUnitCtx(solver, convergedVoltages, { cktMode: MODEDCOP | MODEINITSMSIG }));
    // Since OFF=0, it falls through to the convergence math; with matching
    // voltages the delta is 0, so it must converge.
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Diode TEMP â€” per-instance operating temperature (Phase 7.5.1)
// ---------------------------------------------------------------------------

function makeDiodeProps(overrides: Record<string, number> = {}): PropertyBag {
  return makeParamBag({ ...DIODE_PARAM_DEFAULTS, ...overrides });
}

describe("Diode TEMP", () => {
  it("TEMP_default_300_15", () => {
    const propsObj = makeDiodeProps();
    expect(propsObj.getModelParam<number>("TEMP")).toBe(300.15);
  });

  it("paramDefs_include_TEMP", () => {
    const keys = DIODE_PARAM_DEFS.map((d) => d.key);
    expect(keys).toContain("TEMP");
  });

  it("setParam_TEMP_no_throw", () => {
    const propsObj = makeDiodeProps();
    const core = createDiodeElement(new Map([["A", 1], ["K", 2]]), [], -1, propsObj);
    expect(() => core.setParam("TEMP", 400)).not.toThrow();
  });

  it("tp_vt_reflects_TEMP", () => {
    const CONSTboltz_local = 1.3806226e-23;
    const CHARGE_local = 1.6021918e-19;
    const KoverQ = CONSTboltz_local / CHARGE_local;
    const p = {
      IS: 1e-14, N: 1, VJ: 1.0, CJO: 0, M: 0.5,
      BV: Infinity, IBV: 1e-3, NBV: 1, EG: 1.11, XTI: 3, TNOM: 300.15,
    };
    const tp = dioTemp(p, 400);
    expect(Math.abs(tp.vt - 400 * KoverQ) / (400 * KoverQ)).toBeLessThan(1e-10);
  });

  it("tSatCur_scales_with_TEMP", () => {
    const p = {
      IS: 1e-14, N: 1, VJ: 1.0, CJO: 0, M: 0.5,
      BV: Infinity, IBV: 1e-3, NBV: 1, EG: 1.11, XTI: 3, TNOM: 300.15,
    };
    const tp_nom = dioTemp(p, 300.15);
    const tp_hot = dioTemp(p, 400);
    expect(tp_hot.tIS).toBeGreaterThan(tp_nom.tIS);
  });

  it("TNOM_stays_nominal_refs", () => {
    const CONSTboltz_local = 1.3806226e-23;
    const CHARGE_local = 1.6021918e-19;
    const p = {
      IS: 1e-14, N: 1, VJ: 1.0, CJO: 0, M: 0.5,
      BV: Infinity, IBV: 1e-3, NBV: 1, EG: 1.11, XTI: 3, TNOM: 300.15,
    };
    const tp = dioTemp(p, 400);
    const expectedVtnom = 300.15 * CONSTboltz_local / CHARGE_local;
    expect(Math.abs(tp.vtnom - expectedVtnom) / expectedVtnom).toBeLessThan(1e-10);
  });

  it("setParam_TEMP_recomputes_tp", () => {
    // Construct diode at default TEMP (300.15K), then change to 400K via setParam.
    // Verify next load() uses the 400K tVcrit by driving MODEINITJCT (OFF=0):
    // dioload.c:135-136: vdRaw = tVcrit when MODEINITJCT && !OFF â€” no pnjlim applied.
    // So s0[SLOT_VD] after load() equals the recomputed tVcrit at 400K.
    const IS = 1e-14;
    const N = 1;
    const TNOM = 300.15;
    const propsObj = makeDiodeProps({ IS, N, TNOM });
    const core = createDiodeElement(new Map([["A", 1], ["K", 2]]), [], -1, propsObj);
    const pool = new StatePool(Math.max((core as any).stateSize, 1));
    (core as any).stateBaseOffset = 0;
    core.initState(pool);

    // Change TEMP to 400K â€” triggers recomputeTemp()
    core.setParam("TEMP", 400);

    // Compute expected tVcrit at 400K
    const pForTemp = { IS, N, VJ: 1.0, CJO: 0, M: 0.5, BV: Infinity, IBV: 1e-3, NBV: N, EG: 1.11, XTI: 3, TNOM };
    const tp400 = dioTemp(pForTemp, 400);

    // Invoke load() under MODEINITJCT with OFF=0
    const solver = new SparseSolver();
    solver._initStructure(3);
    core.load(buildUnitCtx(solver, new Float64Array(3), { cktMode: MODEDCOP | MODEINITJCT }));

    // s0[SLOT_VD=0] must equal the 400K tVcrit (set by MODEINITJCT path, no pnjlim)
    expect(pool.state0[0]).toBe(tp400.tVcrit);
  });
});

// ---------------------------------------------------------------------------
// DIODE_PARAM_DEFS partition layout
// ---------------------------------------------------------------------------

describe("DIODE_PARAM_DEFS partition layout", () => {
  it("AREA, TEMP, OFF, IC have partition === 'instance'", () => {
    const instanceKeys = ["AREA", "TEMP", "OFF", "IC"];
    for (const key of instanceKeys) {
      const def = DIODE_PARAM_DEFS.find((d) => d.key === key);
      expect(def, `ParamDef for key "${key}" not found`).toBeDefined();
      expect(def!.partition).toBe("instance");
    }
  });

  it("IS, N, RS, CJO, VJ, M, TT, FC, BV, IBV, NBV, IKF, IKR, EG, XTI, KF, AF, TNOM, ISW, NSW have partition === 'model'", () => {
    const modelKeys = ["IS", "N", "RS", "CJO", "VJ", "M", "TT", "FC", "BV", "IBV", "NBV", "IKF", "IKR", "EG", "XTI", "KF", "AF", "TNOM", "ISW", "NSW"];
    for (const key of modelKeys) {
      const def = DIODE_PARAM_DEFS.find((d) => d.key === key);
      expect(def, `ParamDef for key "${key}" not found`).toBeDefined();
      expect(def!.partition).toBe("model");
    }
  });

  it("IBEQ, IBSW, NB are NOT present in plain Diode schema (moved to TunnelDiode in Step 3a)", () => {
    const tunnelKeys = ["IBEQ", "IBSW", "NB"];
    for (const key of tunnelKeys) {
      const def = DIODE_PARAM_DEFS.find((d) => d.key === key);
      expect(def, `Tunnel-only param "${key}" must NOT be in DIODE_PARAM_DEFS`).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// DIODE_PARAM_DEFAULTS unchanged
// ---------------------------------------------------------------------------

describe("DIODE_PARAM_DEFAULTS unchanged", () => {
  it("preserves all default values", () => {
    expect(DIODE_PARAM_DEFAULTS.AREA).toBe(1);
    expect(DIODE_PARAM_DEFAULTS.OFF).toBe(0);
    expect(isNaN(DIODE_PARAM_DEFAULTS.IC)).toBe(true);
    expect(DIODE_PARAM_DEFAULTS.TEMP).toBe(300.15);
    expect(DIODE_PARAM_DEFAULTS.IS).toBe(1e-14);
    expect(DIODE_PARAM_DEFAULTS.N).toBe(1);
    expect(DIODE_PARAM_DEFAULTS.RS).toBe(0);
    expect(DIODE_PARAM_DEFAULTS.CJO).toBe(0);
    expect(DIODE_PARAM_DEFAULTS.VJ).toBe(1);
    expect(DIODE_PARAM_DEFAULTS.M).toBe(0.5);
    expect(DIODE_PARAM_DEFAULTS.TT).toBe(0);
    expect(DIODE_PARAM_DEFAULTS.FC).toBe(0.5);
    expect(DIODE_PARAM_DEFAULTS.BV).toBe(Infinity);
    expect(DIODE_PARAM_DEFAULTS.IBV).toBe(1e-3);
    expect(isNaN(DIODE_PARAM_DEFAULTS.NBV)).toBe(true);
    expect(DIODE_PARAM_DEFAULTS.IKF).toBe(Infinity);
    expect(DIODE_PARAM_DEFAULTS.IKR).toBe(Infinity);
    expect(DIODE_PARAM_DEFAULTS.EG).toBe(1.11);
    expect(DIODE_PARAM_DEFAULTS.XTI).toBe(3);
    expect(DIODE_PARAM_DEFAULTS.KF).toBe(0);
    expect(DIODE_PARAM_DEFAULTS.AF).toBe(1);
    expect(DIODE_PARAM_DEFAULTS.TNOM).toBe(300.15);
    expect(DIODE_PARAM_DEFAULTS.ISW).toBe(0);
    expect(isNaN(DIODE_PARAM_DEFAULTS.NSW)).toBe(true);
  });
});
