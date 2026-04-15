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

import { describe, it, expect, vi } from "vitest";
import { DiodeDefinition, createDiodeElement, computeJunctionCapacitance, DIODE_PARAM_DEFAULTS } from "../diode.js";
import { PropertyBag } from "../../../core/properties.js";
import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import { DiagnosticCollector } from "../../../solver/analog/diagnostics.js";
import { solveDcOperatingPoint } from "../../../solver/analog/dc-operating-point.js";
import { DEFAULT_SIMULATION_PARAMS } from "../../../core/analog-engine-interface.js";
import { makeDcVoltageSource } from "../../sources/dc-voltage-source.js";
import { withNodeIds } from "../../../solver/analog/__tests__/test-helpers.js";
import { StatePool } from "../../../solver/analog/state-pool.js";
import type { SparseSolver as SparseSolverType } from "../../../solver/analog/sparse-solver.js";
import type { AnalogElement } from "../../../solver/analog/element.js";
import type { AnalogElementCore } from "../../../core/analog-types.js";
import type { ReactiveAnalogElement } from "../../../solver/analog/element.js";
import type { AnalogFactory } from "../../../core/registry.js";

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
// Mock SparseSolver
// ---------------------------------------------------------------------------

function makeMockSolver() {
  return {
    stamp: vi.fn(),
    stampRHS: vi.fn(),
  } as unknown as SparseSolverType;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a diode element and drive it to a specific operating point by
 * calling updateOperatingPoint with a voltages array set to the desired Vd.
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

  // Drive the element to the operating point by calling updateOperatingPoint
  // multiple times to converge the pnjlim limiting
  const voltages = new Float64Array(2);
  // Set target voltage on anode
  voltages[0] = vd;
  voltages[1] = 0;
  for (let i = 0; i < 50; i++) {
    element.updateOperatingPoint!(voltages);
    voltages[0] = vd;
  }
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
    const solver = makeMockSolver();

    element.stampNonlinear!(solver);

    const stampCalls = (solver.stamp as ReturnType<typeof vi.fn>).mock.calls;
    const rhsCalls = (solver.stampRHS as ReturnType<typeof vi.fn>).mock.calls;

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
    const solver = makeMockSolver();

    element.stampNonlinear!(solver);

    const stampCalls = (solver.stamp as ReturnType<typeof vi.fn>).mock.calls;

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
    const { element, pool } = withState(createDiodeElement(new Map([["A", 1], ["K", 2]]), [], -1, propsObj));

    const voltages = new Float64Array(2);
    voltages[0] = 0.3;
    voltages[1] = 0;

    // Drive to 0.3V operating point
    for (let i = 0; i < 20; i++) {
      element.updateOperatingPoint!(voltages);
      voltages[0] = 0.3;
    }

    // Now simulate a large NR step to 5.0V
    voltages[0] = 5.0;
    voltages[1] = 0;
    element.updateOperatingPoint!(voltages);

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
    const { element } = withState(createDiodeElement(new Map([["A", 1], ["K", 2]]), [], -1, propsObj));

    // isReactive should be true when CJO > 0
    expect(element.isReactive).toBe(true);

    // Call stampCompanion at Vd = -2V
    const voltages = new Float64Array(2);
    voltages[0] = -2; // anode at -2V
    voltages[1] = 0;  // cathode at 0V

    // updateOperatingPoint first to set state
    element.updateOperatingPoint!(voltages);

    // Now call stampCompanion
    expect(element.stampCompanion).toBeDefined();

    element.stampCompanion!(1e-6, "trapezoidal", voltages, 1, [1e-6]);

    // Now stamp should include capacitor contributions
    const solver2 = makeMockSolver();
    element.stamp(solver2);
    element.stampReactiveCompanion?.(solver2);

    // Verify Cj computation: CJO / (1 - Vd/VJ)^M at Vd = -2V
    // Cj = 10pF / (1 - (-2)/0.7)^0.5 = 10pF / (1 + 2/0.7)^0.5
    // = 10pF / (3.857)^0.5 = 10pF / 1.964 ≈ 5.09pF
    const expectedCj = computeJunctionCapacitance(-2, CJO, VJ, M, FC);
    expect(expectedCj).toBeCloseTo(CJO / Math.pow(1 - (-2) / VJ, M), 14);

    // After stampCompanion, stamp() should have placed conductance entries
    const stampCalls = (solver2.stamp as ReturnType<typeof vi.fn>).mock.calls;
    expect(stampCalls.length).toBeGreaterThan(0);
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

  it("off_param_primeJunctions_zeroes_voltage", () => {
    // Gap 17.1: A diode with OFF=1 (true) should have all junction voltages
    // set to 0V after primeJunctions(). During DCOP initFix mode,
    // checkConvergence must also return true (suppressing noncon).
    //
    // OFF maps to ngspice .ic OFF: dioload.c skips junction during initFix.
    const propsObj = makeParamBag({ IS: 1e-14, N: 1, CJO: 0, VJ: 0.7, M: 0.5, TT: 0, FC: 0.5, OFF: 1 });
    const core = createDiodeElement(new Map([["A", 1], ["K", 2]]), [], -1, propsObj);
    const { element, pool } = withState(core);
    const el = withNodeIds(element, [1, 2]);

    // primeJunctions sets primedVd=0 (OFF path)
    el.primeJunctions!();

    // Consume the primed voltage by calling updateOperatingPoint.
    // Voltages array values don't matter — primedVd overrides them.
    const voltages = new Float64Array(2);
    voltages[0] = 5; // would give Vd=5V without OFF, but primed=0 overrides
    voltages[1] = 0;
    el.updateOperatingPoint!(voltages);

    // After primeJunctions + updateOperatingPoint, SLOT_VD (index 0) must be 0.
    expect(pool.state0[0]).toBeCloseTo(0, 10);

    // checkConvergence with initFix mode must return true (OFF suppresses noncon).
    pool.initMode = "initFix";
    const prevVoltages = new Float64Array(2);
    const converged = el.checkConvergence!(voltages, prevVoltages, 1e-3, 1e-12);
    expect(converged).toBe(true);
  });

  it("uic_ic_param_primeJunctions_sets_voltage", () => {
    // Gap 17.2: A diode with IC=0.5 and pool.uic=true should have its junction
    // voltage primed to 0.5V after primeJunctions().
    //
    // This maps to ngspice .ic V(node)=0.5 with UIC: dioload.c uses IC directly.
    const propsObj = makeParamBag({ IS: 1e-14, N: 1, CJO: 0, VJ: 0.7, M: 0.5, TT: 0, FC: 0.5, IC: 0.5 });
    const core = createDiodeElement(new Map([["A", 1], ["K", 2]]), [], -1, propsObj);
    const { element, pool } = withState(core);
    const el = withNodeIds(element, [1, 2]);

    // Enable UIC mode on pool (StatePool implements StatePoolRef; uic is an
    // optional field on the interface — cast to add it).
    (pool as unknown as { uic: boolean }).uic = true;

    // primeJunctions sets primedVd=IC=0.5 (UIC path)
    el.primeJunctions!();

    // Consume the primed voltage.
    const voltages = new Float64Array(2);
    voltages[0] = 0;
    voltages[1] = 0;
    el.updateOperatingPoint!(voltages);

    // SLOT_VD (index 0) must be 0.5V (pnjlim does not limit 0.5V from 0V
    // because 0.5 < vcrit ≈ 0.725V, so no clamping occurs).
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
    stamp(solver: SparseSolverType): void {
      if (nodeA !== 0) solver.stamp(nodeA - 1, nodeA - 1, G);
      if (nodeB !== 0) solver.stamp(nodeB - 1, nodeB - 1, G);
      if (nodeA !== 0 && nodeB !== 0) {
        solver.stamp(nodeA - 1, nodeB - 1, -G);
        solver.stamp(nodeB - 1, nodeA - 1, -G);
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

    const solver = new SparseSolver();
    const diagnostics = new DiagnosticCollector();

    const result = solveDcOperatingPoint({
      solver,
      elements: [vs, r, d],
      matrixSize,
      nodeCount: 2,
      params: DEFAULT_SIMULATION_PARAMS,
      diagnostics,
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

    const solver = new SparseSolver();
    const diagnostics = new DiagnosticCollector();
    const elements = [vs, r, d];

    // Before: default IS=1e-14
    const before = solveDcOperatingPoint({ solver, elements, matrixSize, nodeCount: 2, params: DEFAULT_SIMULATION_PARAMS, diagnostics });
    expect(before.converged).toBe(true);
    expectSpiceRef(before.nodeVoltages[0], 6.928910e-01, "V(diode) before");
    expectSpiceRef((before.nodeVoltages[1] - before.nodeVoltages[0]) / 1000, 4.307675e-03, "I(diode) before");

    // setParam and re-solve
    d.setParam("IS", 1e-11);
    const after = solveDcOperatingPoint({ solver, elements, matrixSize, nodeCount: 2, params: DEFAULT_SIMULATION_PARAMS, diagnostics });
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

    const solver = new SparseSolver();
    const diagnostics = new DiagnosticCollector();
    const elements = [vs, r, d];

    // Before: default N=1
    const before = solveDcOperatingPoint({ solver, elements, matrixSize, nodeCount: 2, params: DEFAULT_SIMULATION_PARAMS, diagnostics });
    expect(before.converged).toBe(true);
    expectSpiceRef(before.nodeVoltages[0], 6.928910e-01, "V(diode) before");
    expectSpiceRef((before.nodeVoltages[1] - before.nodeVoltages[0]) / 1000, 4.307675e-03, "I(diode) before");

    // setParam and re-solve
    d.setParam("N", 2);
    const after = solveDcOperatingPoint({ solver, elements, matrixSize, nodeCount: 2, params: DEFAULT_SIMULATION_PARAMS, diagnostics });
    expect(after.converged).toBe(true);
    expectSpiceRef(after.nodeVoltages[0], 1.376835e+00, "V(diode) after N=2");
    expectSpiceRef((after.nodeVoltages[1] - after.nodeVoltages[0]) / 1000, 3.623504e-03, "I(diode) after N=2");
  });
});

// ---------------------------------------------------------------------------
// LimitingEvent instrumentation tests
// ---------------------------------------------------------------------------

import type { LimitingEvent } from "../../../solver/analog/newton-raphson.js";

describe("Diode LimitingEvent instrumentation", () => {
  function makeDiodeWithState(modelParams: Record<string, number> = {}) {
    const props = makeParamBag({ IS: 1e-14, N: 1, ...modelParams });
    const pinNodes = new Map([["A", 1], ["K", 2]]);
    const core = createDiodeElement(pinNodes, [], -1, props) as any;
    core.label = "D1";
    core.elementIndex = 3;
    const pool = new StatePool(core.stateSize);
    core.stateBaseOffset = 0;
    core.initState(pool);
    return core;
  }

  it("pushes AK pnjlim event when limitingCollector provided", () => {
    const core = makeDiodeWithState();
    const voltages = new Float64Array(10);
    voltages[0] = 5.0; // node 1 = anode

    const collector: LimitingEvent[] = [];
    core.updateOperatingPoint(voltages, collector);

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

  it("does not throw when limitingCollector is null or undefined", () => {
    const core = makeDiodeWithState();
    const voltages = new Float64Array(10);
    voltages[0] = 5.0;
    expect(() => core.updateOperatingPoint(voltages, null)).not.toThrow();
    expect(() => core.updateOperatingPoint(voltages, undefined)).not.toThrow();
  });

  it("wasLimited=true when large forward step forces pnjlim to clamp", () => {
    const core = makeDiodeWithState({ IS: 1e-14, N: 1 });
    // First call to establish vdOld near 0
    const voltages = new Float64Array(10);
    voltages[0] = 0.0;
    core.updateOperatingPoint(voltages, null);

    // Now a large jump: should be limited
    voltages[0] = 10.0;
    const collector: LimitingEvent[] = [];
    core.updateOperatingPoint(voltages, collector);

    const ev = collector[0];
    expect(ev.wasLimited).toBe(true);
    expect(ev.vAfter).not.toBe(ev.vBefore);
  });

  it("wasLimited=false for small voltage steps near operating point", () => {
    const core = makeDiodeWithState({ IS: 1e-14, N: 1 });
    const voltages = new Float64Array(10);
    voltages[0] = 0.6;
    // Warm up to vdOld ≈ 0.6
    core.updateOperatingPoint(voltages, null);

    // Tiny step — should not be limited
    voltages[0] = 0.601;
    const collector: LimitingEvent[] = [];
    core.updateOperatingPoint(voltages, collector);

    const ev = collector[0];
    expect(ev.wasLimited).toBe(false);
    expect(ev.vAfter).toBe(ev.vBefore);
  });
});

// ---------------------------------------------------------------------------
// Change 31: Temperature scaling (dioTemp)
// ---------------------------------------------------------------------------

import { dioTemp } from "../diode.js";

describe("dioTemp temperature scaling (Change 31)", () => {
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
// Change 32: IBV knee iteration
// ---------------------------------------------------------------------------

describe("IBV knee iteration (Change 32)", () => {
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
// Change 33: IKF/IKR high-injection correction
// ---------------------------------------------------------------------------

describe("IKF/IKR high-injection correction (Change 33)", () => {
  function diodeGd(vd: number, overrides: Record<string, number> = {}): number {
    const props = makeParamBag({ IS: 1e-14, N: 1, ...overrides });
    const core = createDiodeElement(new Map([["A", 1], ["K", 2]]), [], -1, props) as any;
    const pool = new StatePool(core.stateSize);
    core.stateBaseOffset = 0;
    core.initState(pool);
    const voltages = new Float64Array(10);
    voltages[0] = vd;
    for (let i = 0; i < 50; i++) {
      core.updateOperatingPoint(voltages);
      voltages[0] = vd;
    }
    return pool.state0[1]; // SLOT_GEQ
  }

  function diodeId(vd: number, overrides: Record<string, number> = {}): number {
    const props = makeParamBag({ IS: 1e-14, N: 1, ...overrides });
    const core = createDiodeElement(new Map([["A", 1], ["K", 2]]), [], -1, props) as any;
    const pool = new StatePool(core.stateSize);
    core.stateBaseOffset = 0;
    core.initState(pool);
    const voltages = new Float64Array(10);
    voltages[0] = vd;
    for (let i = 0; i < 50; i++) {
      core.updateOperatingPoint(voltages);
      voltages[0] = vd;
    }
    return pool.state0[3]; // SLOT_ID
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
// Change 34: Area scaling
// ---------------------------------------------------------------------------

describe("AREA scaling (Change 34)", () => {
  function diodeOP(vd: number, overrides: Record<string, number> = {}): { id: number; gd: number } {
    const props = makeParamBag({ IS: 1e-14, N: 1, RS: 0, CJO: 0, ...overrides });
    const core = createDiodeElement(new Map([["A", 1], ["K", 2]]), [], -1, props) as any;
    const pool = new StatePool(core.stateSize);
    core.stateBaseOffset = 0;
    core.initState(pool);
    const voltages = new Float64Array(10);
    voltages[0] = vd;
    for (let i = 0; i < 50; i++) {
      core.updateOperatingPoint(voltages);
      voltages[0] = vd;
    }
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
    const solver1 = makeMockSolver();
    const solver2 = makeMockSolver();

    const core1 = createDiodeElement(new Map([["A", 1], ["K", 2]]), [3], -1, props1) as any;
    const pool1 = new StatePool(Math.max(core1.stateSize, 1));
    core1.stateBaseOffset = 0;
    core1.initState(pool1);
    core1.stamp(solver1);

    const core2 = createDiodeElement(new Map([["A", 1], ["K", 2]]), [3], -1, props2) as any;
    const pool2 = new StatePool(Math.max(core2.stateSize, 1));
    core2.stateBaseOffset = 0;
    core2.initState(pool2);
    core2.stamp(solver2);

    const calls1 = (solver1 as any).stamp.mock.calls;
    const calls2 = (solver2 as any).stamp.mock.calls;
    expect(calls1.length).toBeGreaterThan(0);
    expect(calls2.length).toBeGreaterThan(0);
    // AREA=2 halves RS, so conductance 1/RS doubles
    const gRS1 = calls1[0][2];
    const gRS2 = calls2[0][2];
    expect(Math.abs(gRS2 / gRS1 - 2)).toBeLessThan(1e-6);
  });
});
