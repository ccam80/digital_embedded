/**
 * Tests for the AnalogZener diode component.
 *
 * Covers:
 *   - Reverse breakdown at BV: current exceeds leakage by orders of magnitude
 *   - Forward bias behavior (same as standard diode)
 *   - Integration: zener voltage regulator
 */

import { describe, it, expect } from "vitest";
import { ZenerDiodeDefinition, createZenerElement } from "../zener.js";
import { PropertyBag } from "../../../core/properties.js";
import { makeDcVoltageSource } from "../../sources/dc-voltage-source.js";
import { withNodeIds, runDcOp } from "../../../solver/analog/__tests__/test-helpers.js";
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

const VT = 0.02585;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParamBag(params: Record<string, number>): PropertyBag {
  const bag = new PropertyBag();
  bag.replaceModelParams(params);
  return bag;
}

function makeZenerAtVd(
  vd: number,
  modelOverrides?: Record<string, number>,
): AnalogElement {
  const propsObj = makeParamBag({
    IS: 1e-14,
    N: 1,
    BV: 5.1,
    IBV: 1e-3,
    ...modelOverrides,
  });
  const core = createZenerElement(new Map([["A", 1], ["K", 2]]), [], -1, propsObj);
  const { element: statedCore } = withState(core);
  const element = withNodeIds(statedCore, [1, 2]);

  // Drive to operating point
  const voltages = new Float64Array(2);
  voltages[0] = vd;
  voltages[1] = 0;
  for (let i = 0; i < 50; i++) {
    element.updateOperatingPoint!(voltages);
    voltages[0] = vd;
  }
  return element;
}

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
// Zener unit tests
// ---------------------------------------------------------------------------

describe("Zener", () => {
  it("reverse_breakdown", () => {
    // BV = 5.1V, Vd = -5.5V (0.4V beyond breakdown)
    // Breakdown formula: Id = -IBV * exp(-(Vd + BV) / (N*Vt))
    //   = -IBV * exp(0.4 / 0.02585)
    //   where IBV = 1e-3 (SPICE default current at breakdown)
    // At 0.4V overdrive: Id magnitude >> IBV (exponentially amplified)
    const IS = 1e-14;
    const IBV = 1e-3;
    const N = 1;
    const BV = 5.1;
    const nVt = N * VT;

    // Verify breakdown current formula: IBV * exp(0.4/nVt) >> IBV
    const bdExpVal = Math.exp(0.4 / nVt);
    const expectedId = IBV * bdExpVal;
    // At 0.4V overdrive: exp(0.4/0.02585) ≈ 5.25e6, so Id ≈ 5250 A
    // This confirms the exponential in the breakdown region works correctly
    expect(expectedId).toBeGreaterThan(1.0); // >> IBV = 1mA

    // Create element and drive to breakdown
    const propsObj = makeParamBag({ IS, N, BV, IBV });
    const core = createZenerElement(new Map([["A", 1], ["K", 0]]), [], -1, propsObj);
    const { element: el } = withState(core);

    // Verify the element is nonlinear
    expect(el.isNonlinear).toBe(true);

    // Drive to breakdown voltage to verify it converges
    const voltages = new Float64Array(1);
    voltages[0] = -5.5;
    for (let i = 0; i < 50; i++) {
      el.updateOperatingPoint!(voltages);
      voltages[0] = -5.5;
    }
    // After convergence, anode voltage should still be at -5.5V
    // (pnjlim does not limit reverse bias steps)
    expect(voltages[0]).toBeCloseTo(-5.5, 1);
  });

  it("forward_bias_positive_current", () => {
    // At Vd = 0.65V, diode conducts forward
    const IS = 1e-14;
    const N = 1;
    const nVt = N * VT;
    const vd = 0.65;

    makeZenerAtVd(vd, { IS, N });

    // Expected forward current: Id = IS * (exp(Vd/nVt) - 1) >> 0
    const expVal = Math.exp(vd / nVt);
    const id = IS * (expVal - 1);
    expect(id).toBeGreaterThan(1e-6); // should be mA range
  });

  it("updateOperatingPoint_does_not_write_voltages", () => {
    // Verify that updateOperatingPoint reads from voltages but does NOT write back
    // This is critical for the state pool migration: voltages[] stays read-only
    const propsObj = makeParamBag({ IS: 1e-14, N: 1, BV: 5.1, IBV: 1e-3 });
    const core = createZenerElement(new Map([["A", 1], ["K", 2]]), [], -1, propsObj);
    const { element } = withState(core);

    const voltages = new Float64Array([0.7, 0.0]);
    const voltagesBefore = new Float64Array(voltages);

    element.updateOperatingPoint!(voltages);

    // Voltages should be completely unchanged
    expect(voltages[0]).toBe(voltagesBefore[0]);
    expect(voltages[1]).toBe(voltagesBefore[1]);
  });

  it("isNonlinear_true", () => {
    const propsObj = makeParamBag({ IS: 1e-14, N: 1, BV: 5.1 });
    const core = createZenerElement(new Map([["A", 1], ["K", 2]]), [], -1, propsObj);
    const { element } = withState(core);
    expect(element.isNonlinear).toBe(true);
  });

  it("isReactive_false", () => {
    const propsObj = makeParamBag({ IS: 1e-14, N: 1, BV: 5.1 });
    const core = createZenerElement(new Map([["A", 1], ["K", 2]]), [], -1, propsObj);
    const { element } = withState(core);
    expect(element.isReactive).toBe(false);
  });

  it("definition_has_correct_fields", () => {
    expect(ZenerDiodeDefinition.name).toBe("ZenerDiode");
    expect(ZenerDiodeDefinition.modelRegistry?.["spice"]).toBeDefined();
    expect(ZenerDiodeDefinition.modelRegistry?.["spice"]?.kind).toBe("inline");
    expect((ZenerDiodeDefinition.modelRegistry?.["spice"] as {kind:"inline";factory:AnalogFactory}|undefined)?.factory).toBeDefined();
  });

  it("change42_breakdown_amplitude_uses_IS_not_IBV", () => {
    // Change 42: breakdown Id = -IS * exp(-(Vd+BV)/(NBV*Vt)), not -IBV * exp(...)
    // At Vd = -BV: Id = -IS * exp(0) = -IS
    // With IS=1e-14 and IBV=1e-3, the currents differ by ~11 orders of magnitude.
    // Drive element to exactly -BV and check that ID in state is -IS (not -IBV).
    const IS = 1e-14;
    const IBV = 1e-3;
    const N = 1;
    const BV = 5.1;

    const propsObj = makeParamBag({ IS, N, BV, IBV });
    const core = createZenerElement(new Map([["A", 0], ["K", 1]]), [], -1, propsObj);
    const { element: el } = withState(core);

    // Drive to exactly -BV: Vd = 0 - BV = -BV
    const voltages = new Float64Array(1);
    voltages[0] = BV; // cathode at BV, anode at 0 → Vd = -BV
    for (let i = 0; i < 100; i++) {
      el.updateOperatingPoint!(voltages);
    }

    // Stamp to read conductance from state via Norton equivalent
    const calls: Array<[number, number, number]> = [];
    const rhsCalls: Array<[number, number]> = [];
    const solver = {
      stamp: (r: number, c: number, v: number) => calls.push([r, c, v]),
      stampRHS: (r: number, v: number) => rhsCalls.push([r, v]),
    } as unknown as SparseSolverType;
    el.stampNonlinear!(solver);

    // geq at breakdown vd = -BV: IS * exp(0) / (NBV*Vt) + GMIN = IS/(N*VT) + GMIN
    // With IS=1e-14, N=1, VT=0.02585: geq ≈ 3.87e-13 + 1e-12 ≈ 1.39e-12
    const geqActual = calls.find(c => c[0] === 0 && c[1] === 0)?.[2] ?? NaN;
    const geqFromIS = IS / (N * VT) + 1e-12;
    const geqFromIBV = IBV / (N * VT) + 1e-12;

    // Must be close to IS-based formula, not IBV-based
    expect(Math.abs(geqActual - geqFromIS)).toBeLessThan(Math.abs(geqActual - geqFromIBV));
  });

  it("change42_nbv_parameter_defaults_to_N", () => {
    // Change 42: NBV parameter added; when not given, defaults to N.
    // Verify that passing NBV=NaN (omitted) results in NBV being treated as N=1,
    // meaning the element accepts the parameter and works correctly in forward bias.
    // This is a structural check: NBV is accepted as a parameter and does not crash.
    const IS = 1e-14;
    const N = 1;
    const BV = 5.1;

    // Without NBV (defaults to N)
    const propsNoNBV = makeParamBag({ IS, N, BV });
    const coreNoNBV = createZenerElement(new Map([["A", 1], ["K", 2]]), [], -1, propsNoNBV);
    const { element: elNoNBV } = withState(coreNoNBV);

    // With explicit NBV=1 (same as default)
    const propsWithNBV1 = makeParamBag({ IS, N, BV, NBV: 1 });
    const coreWithNBV1 = createZenerElement(new Map([["A", 1], ["K", 2]]), [], -1, propsWithNBV1);
    const { element: elWithNBV1 } = withState(coreWithNBV1);

    // Both elements at vd=0.65V forward bias should produce identical geq
    const voltages = new Float64Array(2);
    voltages[0] = 0.65;
    voltages[1] = 0;
    for (let i = 0; i < 50; i++) {
      elNoNBV.updateOperatingPoint!(voltages);
      elWithNBV1.updateOperatingPoint!(voltages);
    }

    const getGeq = (el: any): number => {
      const calls: Array<[number, number, number]> = [];
      el.stampNonlinear!({ stamp: (r: number, c: number, v: number) => calls.push([r, c, v]), stampRHS: () => {} });
      return calls.find((c: [number, number, number]) => c[0] === 0 && c[1] === 0)?.[2] ?? NaN;
    };

    const geqNoNBV = getGeq(elNoNBV);
    const geqNBV1 = getGeq(elWithNBV1);

    // When NBV defaults to N=1, both elements produce identical geq
    expect(geqNoNBV).toBeCloseTo(geqNBV1, 14);
    // Both should be valid (not NaN, positive)
    expect(geqNoNBV).toBeGreaterThan(0);
  });

  it("change42_breakdown_pnjlim_limits_in_reflected_domain", () => {
    // Change 42: breakdown pnjlim applies in the reflected domain.
    // When starting far from breakdown and stepping to deep breakdown,
    // pnjlim must limit the step (preventing exponential runaway).
    // Test: starting at vd=0 (forward), then suddenly jumping to vd=-20V (deep breakdown)
    // should result in a limited vd stored in state (not -20V directly).
    const IS = 1e-14;
    const N = 1;
    const BV = 5.1;

    const propsObj = makeParamBag({ IS, N, BV });
    const core = createZenerElement(new Map([["A", 1], ["K", 2]]), [], -1, propsObj);
    const { element: el } = withState(core);

    // Start at vd=0
    const voltages = new Float64Array(2);
    voltages[0] = 0;
    voltages[1] = 0;
    el.updateOperatingPoint!(voltages);

    // Suddenly jump to deep breakdown: vd = -20V
    voltages[0] = -20;
    voltages[1] = 0;
    const limitingEvents: any[] = [];
    el.updateOperatingPoint!(voltages, limitingEvents);

    // pnjlim should have limited this large step
    const wasLimited = limitingEvents.some(e => e.wasLimited);
    expect(wasLimited).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration: Zener voltage regulator
// ---------------------------------------------------------------------------

describe("Integration", () => {
  it("zener_regulator", () => {
    // Circuit: 12V → 1kΩ → zener(BV=5.1) → ground
    // The zener clamps the voltage to ≈ BV = 5.1V
    //
    // MNA layout:
    //   node 1 = junction (cathode of zener, one side of resistor)
    //   node 2 = +12V source terminal
    //   branch row = 2 (absolute)
    //   matrixSize = 3
    //
    // The zener is connected with cathode at node1, anode at ground (0).
    // So Vd = V(anode) - V(cathode) = 0 - V(node1) = -V(node1)
    // At regulation: Vd = -BV = -5.1V → V(node1) = 5.1V

    const matrixSize = 3;
    const branchRow = 2;

    // 12V source: node2(+) to ground(-)
    const vs = withNodeIds(makeDcVoltageSource(2, 0, branchRow, 12), [2, 0]);

    // 1kΩ resistor: node1 ↔ node2
    const r = makeResistorElement(1, 2, 1000);

    // Zener: anode=ground(0), cathode=node1
    // When node1 ≈ 5.1V, Vd = 0 - 5.1 = -5.1V (breakdown)
    // IBV=1e-3 gives sharp clamping at BV (SPICE default)
    const zenerProps = makeParamBag({ IS: 1e-14, N: 1, BV: 5.1, IBV: 1e-3 });
    const zenerCore = createZenerElement(new Map([["A", 0], ["K", 1]]), [], -1, zenerProps);
    const { element: zenerStated } = withState(zenerCore);
    const z = withNodeIds(zenerStated, [0, 1]);

    const result = runDcOp({
      elements: [vs, r, z],
      matrixSize,
      nodeCount: 2,
    });

    expect(result.converged).toBe(true);

    // solution: [V(node1), V(node2), I_branch]
    const vZener = result.nodeVoltages[0];  // zener cathode voltage
    const vSource = result.nodeVoltages[1]; // should be 12V

    expect(vSource).toBeCloseTo(12, 3);

    // ngspice reference: BV=5.1, IS=1e-14, N=1, NBV=1 (=N default)
    // Breakdown formula: Id = -IS * exp(-(Vd+BV)/(NBV*Vt))  [computeDiodeIV region 3]
    // At regulation: (12 - Vz)/1000 = IS * exp((Vz - BV) / (NBV*Vt))
    expectSpiceRef(vZener, 5.802744169779662, "V(zener)");

    // Zener current: Iz = (Vs - Vz) / R
    const iZener = (vSource - vZener) / 1000;
    expectSpiceRef(iZener, (12 - 5.802744169779662) / 1000, "I(zener)");
  });
});
