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
import type { SparseSolver as SparseSolverType } from "../../../solver/analog/sparse-solver.js";
import type { AnalogElement } from "../../../solver/analog/element.js";
import type { AnalogFactory } from "../../../core/registry.js";

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

const VT = 0.02585;
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
  const element = withNodeIds(core, [1, 2]);

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
    const expectedId = IS * (expVal - 1);
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
    const element = createDiodeElement(new Map([["A", 1], ["K", 2]]), [], -1, propsObj);

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

    // After pnjlim, the anode voltage should have been compressed, not = 5V
    // The limited vd should be much less than 5V - 0.3V = 4.7V step
    const limitedVd = voltages[0] - voltages[1];
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
    const element = createDiodeElement(new Map([["A", 1], ["K", 2]]), [], -1, propsObj);

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

    element.stampCompanion!(1e-6, "trapezoidal", voltages);

    // Now stamp should include capacitor contributions
    const solver2 = makeMockSolver();
    element.stamp(solver2);

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
    expect(DiodeDefinition.modelRegistry?.["spice-l1"]).toBeDefined();
    expect(DiodeDefinition.modelRegistry?.["spice-l1"]?.kind).toBe("inline");
    expect((DiodeDefinition.modelRegistry?.["spice-l1"] as {kind:"inline";factory:AnalogFactory}|undefined)?.factory).toBeDefined();
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
    const d = withNodeIds(createDiodeElement(new Map([["A", 1], ["K", 0]]), [], -1, diodeProps), [1, 0]);

    const solver = new SparseSolver();
    const diagnostics = new DiagnosticCollector();

    const result = solveDcOperatingPoint({
      solver,
      elements: [vs, r, d],
      matrixSize,
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
    const d = withNodeIds(createDiodeElement(new Map([["A", 1], ["K", 0]]), [], -1, diodeProps), [1, 0]);

    const solver = new SparseSolver();
    const diagnostics = new DiagnosticCollector();
    const elements = [vs, r, d];

    // Before: default IS=1e-14
    const before = solveDcOperatingPoint({ solver, elements, matrixSize, params: DEFAULT_SIMULATION_PARAMS, diagnostics });
    expect(before.converged).toBe(true);
    expectSpiceRef(before.nodeVoltages[0], 6.928910e-01, "V(diode) before");
    expectSpiceRef((before.nodeVoltages[1] - before.nodeVoltages[0]) / 1000, 4.307675e-03, "I(diode) before");

    // setParam and re-solve
    d.setParam("IS", 1e-11);
    const after = solveDcOperatingPoint({ solver, elements, matrixSize, params: DEFAULT_SIMULATION_PARAMS, diagnostics });
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
    const d = withNodeIds(createDiodeElement(new Map([["A", 1], ["K", 0]]), [], -1, diodeProps), [1, 0]);

    const solver = new SparseSolver();
    const diagnostics = new DiagnosticCollector();
    const elements = [vs, r, d];

    // Before: default N=1
    const before = solveDcOperatingPoint({ solver, elements, matrixSize, params: DEFAULT_SIMULATION_PARAMS, diagnostics });
    expect(before.converged).toBe(true);
    expectSpiceRef(before.nodeVoltages[0], 6.928910e-01, "V(diode) before");
    expectSpiceRef((before.nodeVoltages[1] - before.nodeVoltages[0]) / 1000, 4.307675e-03, "I(diode) before");

    // setParam and re-solve
    d.setParam("N", 2);
    const after = solveDcOperatingPoint({ solver, elements, matrixSize, params: DEFAULT_SIMULATION_PARAMS, diagnostics });
    expect(after.converged).toBe(true);
    expectSpiceRef(after.nodeVoltages[0], 1.376835e+00, "V(diode) after N=2");
    expectSpiceRef((after.nodeVoltages[1] - after.nodeVoltages[0]) / 1000, 3.623504e-03, "I(diode) after N=2");
  });
});
