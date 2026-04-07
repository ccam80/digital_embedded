/**
 * Tests for the NMOS and PMOS MOSFET components.
 *
 * Covers:
 *   - Cutoff region: Id ≈ 0 when Vgs < Vth
 *   - Saturation region: Id = KP/2*(W/L)*(Vgs-Vth)²*(1+LAMBDA*Vds)
 *   - Linear region: Id = KP*(W/L)*((Vgs-Vth)*Vds - Vds²/2)*(1+LAMBDA*Vds)
 *   - Body effect: Vth increases with Vsb via GAMMA parameter
 *   - Voltage limiting via fetlim()
 *   - PMOS polarity reversal
 *   - Integration: common-source NMOS DC operating point vs SPICE reference
 */

import { describe, it, expect, vi } from "vitest";
import {
  NmosfetDefinition,
  PmosfetDefinition,
  createMosfetElement,
  computeIds,
  computeGm,
  computeGds,
  computeGmbs,
  limitVoltages,
  computeCapacitances,
} from "../mosfet.js";
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
// withState — allocate a StatePool and call initState on the element
// ---------------------------------------------------------------------------

function withState(element: AnalogElementCore): ReactiveAnalogElement {
  const re = element as ReactiveAnalogElement;
  re.stateBaseOffset = 0;
  const pool = new StatePool(re.stateSize);
  re.initState(pool);
  return re;
}

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
// Default NMOS parameters (W=1µ, L=1µ, KP=120µA/V², VTO=0.7, LAMBDA=0.02)
// ---------------------------------------------------------------------------

const NMOS_DEFAULTS = {
  VTO: 0.7,
  KP: 120e-6,
  LAMBDA: 0.02,
  PHI: 0.6,
  GAMMA: 0.37,
  CBD: 0,
  CBS: 0,
  CGDO: 0,
  CGSO: 0,
  W: 1e-6,
  L: 1e-6,
};

// ---------------------------------------------------------------------------
// Mock SparseSolver
// ---------------------------------------------------------------------------

function makeMockSolver() {
  return {
    stamp: vi.fn(),
    stampRHS: vi.fn(),
  } as unknown as SparseSolverType;
}


function makeParamBag(params: Record<string, number>): PropertyBag {
  const bag = new PropertyBag();
  bag.replaceModelParams(params);
  return bag;
}

// ---------------------------------------------------------------------------
// Helper: create NMOS element driven to a specific operating point
//
// nodeG=2, nodeS=3, nodeD=1, (bulk=source=3)
// createMosfetElement pin order: [G, S, D]
// Voltages in the MNA solution vector are indexed at node-1.
// ---------------------------------------------------------------------------

function makeNmosAtVgs_Vds(
  vgs: number,
  vds: number,
  modelParams: Record<string, number> = NMOS_DEFAULTS,
): AnalogElement {
  const propsObj = makeParamBag(modelParams);
  const element = withState(createMosfetElement(1, new Map([["G", 2], ["S", 3], ["D", 1]]), [], -1, propsObj));
  // pinNodeIds: pinLayout order [G, D, S, B]; B=S for 3-terminal → [2, 1, 3, 3]
  Object.assign(element, { pinNodeIds: [2, 1, 3, 3], allNodeIds: [2, 1, 3, 3] });
  const elementWithPins = element as unknown as AnalogElement;

  // Drive to operating point: vG=vgs+vS, vD=vds+vS, vS=0
  const voltages = new Float64Array(3);
  voltages[0] = vds;  // V(node1=D) = Vds (source at 0)
  voltages[1] = vgs;  // V(node2=G) = Vgs
  voltages[2] = 0;    // V(node3=S) = 0

  // Iterate to converge voltage limiting
  for (let i = 0; i < 50; i++) {
    element.updateOperatingPoint!(voltages);
    voltages[0] = vds;
    voltages[1] = vgs;
    voltages[2] = 0;
  }
  return elementWithPins;
}

// ---------------------------------------------------------------------------
// Helper: inline resistor element for integration tests
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
// NMOS unit tests
// ---------------------------------------------------------------------------

describe("NMOS", () => {
  it("cutoff_region", () => {
    // Vgs = 0V < VTO = 0.7V → device off, Id ≈ 0
    const element = makeNmosAtVgs_Vds(0, 5, NMOS_DEFAULTS);
    const solver = makeMockSolver();

    element.stampNonlinear!(solver);

    const rhsCalls = (solver.stampRHS as ReturnType<typeof vi.fn>).mock.calls;

    // The Norton current at drain/source should be ≈ 0 (only GMIN leakage)
    // All RHS stamps will be present but very small
    for (const call of rhsCalls) {
      expect(Math.abs(call[1] as number)).toBeLessThan(1e-10);
    }
  });

  it("saturation_region", () => {
    // Vgs=3V, Vds=5V → saturation (Vds > Vgs - Vth = 3 - 0.7 = 2.3V)
    // Id = KP/2 * (W/L) * (Vgs-Vth)² * (1 + LAMBDA*Vds)
    const vgs = 3;
    const vds = 5;
    const vth = NMOS_DEFAULTS.VTO; // no body effect (Vsb=0)
    const vgst = vgs - vth;
    const expectedId =
      (NMOS_DEFAULTS.KP / 2) *
      (NMOS_DEFAULTS.W / NMOS_DEFAULTS.L) *
      vgst * vgst *
      (1 + NMOS_DEFAULTS.LAMBDA * vds);

    const { ids } = computeIds(vgs, vds, 0, NMOS_DEFAULTS);

    expect(ids).toBeCloseTo(expectedId, 8);
    expect(Math.abs(ids - expectedId) / expectedId).toBeLessThan(0.01); // within 1%
  });

  it("linear_region", () => {
    // Vgs=3V, Vds=0.5V → linear (Vds < Vgs - Vth = 2.3V)
    // Id = KP * (W/L) * ((Vgs-Vth)*Vds - Vds²/2) * (1 + LAMBDA*Vds)
    const vgs = 3;
    const vds = 0.5;
    const vth = NMOS_DEFAULTS.VTO;
    const vgst = vgs - vth;
    const expectedId =
      NMOS_DEFAULTS.KP *
      (NMOS_DEFAULTS.W / NMOS_DEFAULTS.L) *
      (vgst * vds - (vds * vds) / 2) *
      (1 + NMOS_DEFAULTS.LAMBDA * vds);

    const { ids } = computeIds(vgs, vds, 0, NMOS_DEFAULTS);

    expect(ids).toBeCloseTo(expectedId, 8);
    expect(Math.abs(ids - expectedId) / expectedId).toBeLessThan(0.01); // within 1%
  });

  it("body_effect", () => {
    // With Vsb=2V, Vth should increase by GAMMA*(sqrt(PHI+Vsb) - sqrt(PHI))
    const vsb = 2;
    const PHI = NMOS_DEFAULTS.PHI;
    const GAMMA = NMOS_DEFAULTS.GAMMA;
    const vthBase = NMOS_DEFAULTS.VTO;
    const expectedDeltaVth = GAMMA * (Math.sqrt(PHI + vsb) - Math.sqrt(PHI));
    const expectedVth = vthBase + expectedDeltaVth;

    // Check Vth via computeIds: compute at Vgs just below expected Vth
    const { vth } = computeIds(expectedVth + 0.01, 1, vsb, NMOS_DEFAULTS);

    expect(vth).toBeCloseTo(expectedVth, 6);

    // Verify Vth without body effect
    const { vth: vthNoBody } = computeIds(1, 1, 0, NMOS_DEFAULTS);
    expect(vthNoBody).toBeCloseTo(vthBase, 6);

    // Verify body effect increases Vth
    expect(vth).toBeGreaterThan(vthNoBody);
    expect(vth - vthNoBody).toBeCloseTo(expectedDeltaVth, 6);
  });

  it("voltage_limiting", () => {
    // SPICE3f5 three-zone fetlim: near-threshold zone (vold=2.0, vto=0.7, vtox=4.2)
    // Increasing step: clamp to min(vnew, vto+4) = min(5.0, 4.7) = 4.7
    const vgsOld = 2.0; // above threshold, near-threshold zone
    const vgsNewLarge = 5.0; // large step: 3V jump

    const { vgs: vgsLimited } = limitVoltages(vgsOld, vgsNewLarge, 2.0, 2.0, NMOS_DEFAULTS.VTO);

    // Near-threshold increasing: capped at vto+4 = 0.7+4 = 4.7
    expect(vgsLimited).toBeCloseTo(NMOS_DEFAULTS.VTO + 4, 10);
    expect(vgsLimited).toBeGreaterThan(vgsOld); // still moved in the right direction

    // Deep-on zone: large decreasing step should use vtstlo limiting
    const vgsOldDeepOn = 6.0; // >= vtox=4.2
    const vgsNewDecreasing = 1.0; // large decrease
    const { vgs: vgsLimited2 } = limitVoltages(vgsOldDeepOn, vgsNewDecreasing, 6.0, 2.0, NMOS_DEFAULTS.VTO);
    // vtstlo = |6.0-0.7|+1 = 6.3, but vnew=1.0 < vtox=4.2: floor at vto+2=2.7
    expect(vgsLimited2).toBeCloseTo(NMOS_DEFAULTS.VTO + 2, 10);
  });

  it("gm_positive_in_active_region", () => {
    const vgs = 3;
    const vds = 5;
    const gm = computeGm(vgs, vds, 0, NMOS_DEFAULTS);
    expect(gm).toBeGreaterThan(0);
  });

  it("gds_positive_in_active_region", () => {
    const vgs = 3;
    const vds = 5;
    const gds = computeGds(vgs, vds, 0, NMOS_DEFAULTS);
    expect(gds).toBeGreaterThan(0);
  });

  it("gmbs_positive_with_body_effect", () => {
    const vgs = 3;
    const vds = 5;
    const vsb = 2;
    const gmbs = computeGmbs(vgs, vds, vsb, NMOS_DEFAULTS);
    expect(gmbs).toBeGreaterThan(0);
  });

  it("gmbs_zero_when_gamma_zero", () => {
    const paramsNoGamma = { ...NMOS_DEFAULTS, GAMMA: 0 };
    const gmbs = computeGmbs(3, 5, 2, paramsNoGamma);
    expect(gmbs).toBe(0);
  });

  it("isNonlinear_true", () => {
    const propsObj = makeParamBag(NMOS_DEFAULTS);
    const element = createMosfetElement(1, new Map([["G", 2], ["S", 3], ["D", 1]]), [], -1, propsObj);
    expect(element.isNonlinear).toBe(true);
  });

  it("isReactive_false_when_no_capacitances", () => {
    // TOX: 0 ensures oxideCap is zero; all other cap params are zero in NMOS_DEFAULTS.
    const propsObj = makeParamBag({ ...NMOS_DEFAULTS, TOX: 0 });
    const element = createMosfetElement(1, new Map([["G", 2], ["S", 3], ["D", 1]]), [], -1, propsObj);
    expect(element.isReactive).toBe(false);
  });

  it("isReactive_true_when_cbd_nonzero", () => {
    const paramsWithCap = { ...NMOS_DEFAULTS, CBD: 1e-12 };
    const propsObj = makeParamBag(paramsWithCap);
    const element = createMosfetElement(1, new Map([["G", 2], ["S", 3], ["D", 1]]), [], -1, propsObj);
    expect(element.isReactive).toBe(true);
  });

  it("three_terminal_node_indices", () => {
    const propsObj = makeParamBag(NMOS_DEFAULTS);
    const element = createMosfetElement(1, new Map([["G", 2], ["S", 3], ["D", 1]]), [], -1, propsObj);
    // pinNodeIds set by compiler in production; here we verify the factory uses pin nodes correctly
    // by checking that stamp methods work when pinNodeIds is injected (pinLayout: [G, D, S, B])
    Object.assign(element, { pinNodeIds: [2, 1, 3, 3], allNodeIds: [2, 1, 3, 3] }); // G=2, D=1, S=3, B=S=3
    // pinNodeIds includes D, G, S, and bulk (= S when not specified)
    expect(element.pinNodeIds).toContain(1); // D
    expect(element.pinNodeIds).toContain(2); // G
    expect(element.pinNodeIds).toContain(3); // S
  });

  it("stamp_nonlinear_has_conductance_entries", () => {
    // Vgs=3V, Vds=5V (saturation): stampNonlinear should stamp nonzero conductances
    const element = makeNmosAtVgs_Vds(3, 5, NMOS_DEFAULTS);
    const solver = makeMockSolver();

    element.stampNonlinear!(solver);

    const stampCalls = (solver.stamp as ReturnType<typeof vi.fn>).mock.calls;
    expect(stampCalls.length).toBeGreaterThan(0);

    // At least one conductance stamp should be significantly nonzero
    const nonzeroStamps = stampCalls.filter((call) => Math.abs(call[2] as number) > 1e-15);
    expect(nonzeroStamps.length).toBeGreaterThan(0);
  });

  it("setSourceScale_zero_disables_current", () => {
    // setSourceScale(0) should zero all RHS contributions from stampNonlinear
    const element = makeNmosAtVgs_Vds(3, 5, NMOS_DEFAULTS);
    element.setSourceScale!(0);
    const solver = makeMockSolver();

    element.stampNonlinear!(solver);

    const rhsCalls = (solver.stampRHS as ReturnType<typeof vi.fn>).mock.calls;
    for (const call of rhsCalls) {
      expect(Math.abs(call[1] as number)).toBeCloseTo(0, 11);
    }

    const stampCalls = (solver.stamp as ReturnType<typeof vi.fn>).mock.calls;
    for (const call of stampCalls) {
      expect(Math.abs(call[2] as number)).toBeCloseTo(0, 11);
    }
  });

  it("setSourceScale_one_is_default", () => {
    // Without calling setSourceScale, behavior should match explicit setSourceScale(1)
    const elementDefault = makeNmosAtVgs_Vds(3, 5, NMOS_DEFAULTS);
    const elementScaled = makeNmosAtVgs_Vds(3, 5, NMOS_DEFAULTS);
    elementScaled.setSourceScale!(1);

    const solverDefault = makeMockSolver();
    const solverScaled = makeMockSolver();

    elementDefault.stampNonlinear!(solverDefault);
    elementScaled.stampNonlinear!(solverScaled);

    const defaultStamp = (solverDefault.stamp as ReturnType<typeof vi.fn>).mock.calls;
    const scaledStamp = (solverScaled.stamp as ReturnType<typeof vi.fn>).mock.calls;
    const defaultRhs = (solverDefault.stampRHS as ReturnType<typeof vi.fn>).mock.calls;
    const scaledRhs = (solverScaled.stampRHS as ReturnType<typeof vi.fn>).mock.calls;

    expect(defaultStamp.length).toBe(scaledStamp.length);
    for (let i = 0; i < defaultStamp.length; i++) {
      expect(defaultStamp[i][2]).toBeCloseTo(scaledStamp[i][2] as number, 15);
    }
    expect(defaultRhs.length).toBe(scaledRhs.length);
    for (let i = 0; i < defaultRhs.length; i++) {
      expect(defaultRhs[i][1]).toBeCloseTo(scaledRhs[i][1] as number, 15);
    }
  });
});

// ---------------------------------------------------------------------------
// PMOS unit tests
// ---------------------------------------------------------------------------

describe("PMOS", () => {
  it("polarity_reversed", () => {
    // PMOS: Vsg=3V (Vgs=-3V for PMOS convention), Vsd=5V
    // The PMOS model uses polarity=-1, so it mirrors NMOS with reversed signs
    // Drain current should be nonzero and flow in the opposite direction

    // For PMOS, we use Vsg=3V → Vgs=-3V, Vsd=5V → Vds=-5V in raw terms
    // nodeD=1, nodeG=2, nodeS=3; vS > vD for PMOS (source at high potential)

    const PMOS_DEFAULTS = {
      VTO: -0.7,
      KP: 60e-6,
      LAMBDA: 0.02,
      PHI: 0.6,
      GAMMA: 0.37,
      CBD: 0,
      CBS: 0,
      CGDO: 0,
      CGSO: 0,
      W: 1e-6,
      L: 1e-6,
    };

    // PMOS is on when Vgs < VTO (negative): use Vgs=-3V, Vds=-5V
    // In MNA: nodeS at high voltage (5V), nodeD at 0V, nodeG at 2V (so Vgs = 2-5 = -3V)
    // createMosfetElement pin order: [G, S, D]
    const propsObj = makeParamBag(PMOS_DEFAULTS);
    const element = withState(createMosfetElement(-1, new Map([["G", 2], ["S", 3], ["D", 1]]), [], -1, propsObj));

    // vS=5V (node3), vG=2V (node2), vD=0V (node1)
    // Vgs = 2-5 = -3V, Vds = 0-5 = -5V
    const voltages = new Float64Array(3);
    voltages[0] = 0;  // V(D)=0
    voltages[1] = 2;  // V(G)=2
    voltages[2] = 5;  // V(S)=5

    for (let i = 0; i < 50; i++) {
      element.updateOperatingPoint!(voltages);
      voltages[0] = 0;
      voltages[1] = 2;
      voltages[2] = 5;
    }

    const solver = makeMockSolver();
    element.stampNonlinear!(solver);

    // PMOS in saturation: Id should flow from S to D (conventional positive Isd)
    // Norton current at drain node should be positive (current entering drain = Isd)
    const rhsCalls = (solver.stampRHS as ReturnType<typeof vi.fn>).mock.calls;

    // Find drain node (node index 0 in solver = node 1)
    const drainRhs = rhsCalls.find((c) => c[0] === 0);
    const sourceRhs = rhsCalls.find((c) => c[0] === 2);

    // At least one RHS entry should be nonzero (device is conducting)
    const maxRhs = Math.max(...rhsCalls.map((c) => Math.abs(c[1] as number)));
    expect(maxRhs).toBeGreaterThan(1e-10);

    // PMOS conducts: there should be nonzero RHS entries with correct signs
    // The PMOS carries current from S to D: drain node gets current in, source loses current
    // This is opposite to NMOS which drains current from D to S
    expect(drainRhs).toBeDefined();
    if (drainRhs && sourceRhs) {
      // For PMOS: current flows into drain, out of source (opposite sign to NMOS)
      expect(Math.sign(drainRhs[1] as number)).toBe(-Math.sign(sourceRhs[1] as number));
    }
  });

  it("pmos_definition_has_correct_device_type", () => {
    expect(PmosfetDefinition.modelRegistry?.["spice-l1"]).toBeDefined();
    expect(PmosfetDefinition.modelRegistry?.["spice-l1"]?.kind).toBe("inline");
  });
});

// ---------------------------------------------------------------------------
// computeCapacitances unit tests
// ---------------------------------------------------------------------------

describe("computeCapacitances", () => {
  it("all_zero_when_params_zero", () => {
    const caps = computeCapacitances(NMOS_DEFAULTS);
    expect(caps.cgs).toBe(0);
    expect(caps.cgd).toBe(0);
    expect(caps.cbd).toBe(0);
    expect(caps.cbs).toBe(0);
  });

  it("cbd_from_model_param", () => {
    const params = { ...NMOS_DEFAULTS, CBD: 5e-12, CBS: 3e-12 };
    const caps = computeCapacitances(params);
    expect(caps.cbd).toBe(5e-12);
    expect(caps.cbs).toBe(3e-12);
  });

  it("overlap_caps_scale_with_width", () => {
    // CGDO and CGSO are per-unit-width capacitances (F/m)
    const params = { ...NMOS_DEFAULTS, CGDO: 1e-10, CGSO: 2e-10, W: 5e-6 };
    const caps = computeCapacitances(params);
    expect(caps.cgd).toBeCloseTo(1e-10 * 5e-6, 20);
    expect(caps.cgs).toBeCloseTo(2e-10 * 5e-6, 20);
  });
});

// ---------------------------------------------------------------------------
// ComponentDefinition unit tests
// ---------------------------------------------------------------------------

describe("NmosfetDefinition", () => {
  it("has_correct_fields", () => {
    expect(NmosfetDefinition.name).toBe("NMOS");
    expect(NmosfetDefinition.modelRegistry?.["spice-l1"]).toBeDefined();
    expect(NmosfetDefinition.modelRegistry?.["spice-l1"]?.kind).toBe("inline");
    expect((NmosfetDefinition.modelRegistry?.["spice-l1"] as {kind:"inline";factory:AnalogFactory}|undefined)?.factory).toBeDefined();
  });

  it("pin_layout_has_three_pins", () => {
    expect(NmosfetDefinition.pinLayout).toHaveLength(3);
    const labels = NmosfetDefinition.pinLayout.map((p) => p.label);
    expect(labels).toContain("D");
    expect(labels).toContain("G");
    expect(labels).toContain("S");
  });
});

// ---------------------------------------------------------------------------
// Integration test: common-source NMOS DC operating point
//
// Circuit: Vdd=5V → Rd=1kΩ → NMOS drain, NMOS gate=3V, NMOS source=gnd
// NMOS model: KP=120µA/V², VTO=0.7V, LAMBDA=0.02, W=10µ, L=1µ
//
// Expected operating point (ngspice reference):
//   Vds ≈ 1.84V
//   Id  ≈ 3.16mA
// ---------------------------------------------------------------------------

describe("Integration", () => {
  it("common_source_nmos", () => {
    // MNA layout:
    //   node 1 = drain
    //   node 2 = Vdd rail (5V)
    //   node 3 = gate (fixed at 3V via voltage source from ground)
    //   branch row 3 = Vdd source branch current
    //   branch row 4 = Vgate source branch current
    //   matrixSize = 5 (3 nodes + 2 branches)

    const matrixSize = 5;

    // Vdd=5V: node2(+) to ground, branch at row 3
    const vdd = makeDcVoltageSource(2, 0, 3, 5) as unknown as AnalogElement;

    // Vgate=3V: node3(+) to ground, branch at row 4
    const vgate = makeDcVoltageSource(3, 0, 4, 3) as unknown as AnalogElement;

    // Rd=1kΩ: between node2 (Vdd) and node1 (drain)
    const rd = makeResistorElement(2, 1, 1000);

    // NMOS: G=node3, S=ground(0), D=node1, W=10µ, L=1µ
    // createMosfetElement pin order: [G, S, D]
    const nmosParams = { ...NMOS_DEFAULTS, W: 10e-6, L: 1e-6 };
    const propsObj = makeParamBag(nmosParams);
    const nmos = withState(withNodeIds(createMosfetElement(1, new Map([["G", 3], ["S", 0], ["D", 1]]), [], -1, propsObj), [3, 0, 1]));

    const solver = new SparseSolver();
    const diagnostics = new DiagnosticCollector();

    const result = solveDcOperatingPoint({
      solver,
      elements: [vdd, vgate, rd, nmos],
      matrixSize,
      nodeCount: 3,
      params: DEFAULT_SIMULATION_PARAMS,
      diagnostics,
    });

    expect(result.converged).toBe(true);

    // node voltages: [V(1)=Vdrain, V(2)=Vdd=5V, V(3)=Vgate=3V, I_vdd, I_vgate]
    const vDrain = result.nodeVoltages[0];
    const vDd = result.nodeVoltages[1];
    const vGate = result.nodeVoltages[2];

    // Vdd should be 5V (enforced by source)
    expect(vDd).toBeCloseTo(5, 2);

    // Vgate should be 3V (enforced by source)
    expect(vGate).toBeCloseTo(3, 2);

    // ngspice reference: VTO=0.7, KP=120µ, W=10µ, L=1µ, LAMBDA=0.02
    expectSpiceRef(vDrain, 1.840508e+00, "V(drain)");

    const id = (vDd - vDrain) / 1000;
    expectSpiceRef(id, 3.159492e-03, "Id");
  });
});

// ---------------------------------------------------------------------------
// setParam behavioral verification — reads mutable params object, not captured locals
// ---------------------------------------------------------------------------

describe("setParam shifts DC OP to match SPICE reference", () => {
  it("setParam('VTO', 2.5) shifts DC OP to match SPICE reference", () => {
    const matrixSize = 5;
    const vdd = makeDcVoltageSource(2, 0, 3, 5) as unknown as AnalogElement;
    const vgate = makeDcVoltageSource(3, 0, 4, 3) as unknown as AnalogElement;
    const rd = makeResistorElement(2, 1, 1000);
    const nmosParams = { ...NMOS_DEFAULTS, W: 10e-6, L: 1e-6 };
    const propsObj = makeParamBag(nmosParams);
    const nmos = withState(withNodeIds(createMosfetElement(1, new Map([["G", 3], ["S", 0], ["D", 1]]), [], -1, propsObj), [3, 0, 1]));

    const solver = new SparseSolver();
    const diagnostics = new DiagnosticCollector();
    const elements = [vdd, vgate, rd, nmos];

    // Before: VTO=0.7
    const before = solveDcOperatingPoint({ solver, elements, matrixSize, nodeCount: 3, params: DEFAULT_SIMULATION_PARAMS, diagnostics });
    expect(before.converged).toBe(true);
    expectSpiceRef(before.nodeVoltages[0], 1.840508e+00, "V(drain) before");

    // setParam and re-solve
    nmos.setParam("VTO", 2.5);
    const after = solveDcOperatingPoint({ solver, elements, matrixSize, nodeCount: 3, params: DEFAULT_SIMULATION_PARAMS, diagnostics });
    expect(after.converged).toBe(true);
    expectSpiceRef(after.nodeVoltages[0], 4.835494e+00, "V(drain) after VTO=2.5");
    expectSpiceRef((after.nodeVoltages[1] - after.nodeVoltages[0]) / 1000, 1.645065e-04, "Id after VTO=2.5");
  });

  it("setParam('KP', 240µ) shifts DC OP to match SPICE reference", () => {
    const matrixSize = 5;
    const vdd = makeDcVoltageSource(2, 0, 3, 5) as unknown as AnalogElement;
    const vgate = makeDcVoltageSource(3, 0, 4, 3) as unknown as AnalogElement;
    const rd = makeResistorElement(2, 1, 1000);
    const nmosParams = { ...NMOS_DEFAULTS, W: 10e-6, L: 1e-6 };
    const propsObj = makeParamBag(nmosParams);
    const nmos = withState(withNodeIds(createMosfetElement(1, new Map([["G", 3], ["S", 0], ["D", 1]]), [], -1, propsObj), [3, 0, 1]));

    const solver = new SparseSolver();
    const diagnostics = new DiagnosticCollector();
    const elements = [vdd, vgate, rd, nmos];

    // Before: KP=120µ
    const before = solveDcOperatingPoint({ solver, elements, matrixSize, nodeCount: 3, params: DEFAULT_SIMULATION_PARAMS, diagnostics });
    expect(before.converged).toBe(true);
    expectSpiceRef(before.nodeVoltages[0], 1.840508e+00, "V(drain) before");

    // setParam and re-solve
    nmos.setParam("KP", 240e-6);
    const after = solveDcOperatingPoint({ solver, elements, matrixSize, nodeCount: 3, params: DEFAULT_SIMULATION_PARAMS, diagnostics });
    expect(after.converged).toBe(true);
    expectSpiceRef(after.nodeVoltages[0], 9.071396e-01, "V(drain) after KP=240µ");
    expectSpiceRef((after.nodeVoltages[1] - after.nodeVoltages[0]) / 1000, 4.092860e-03, "Id after KP=240µ");
  });
});
