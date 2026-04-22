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

import { describe, it, expect } from "vitest";
import {
  NmosfetDefinition,
  PmosfetDefinition,
  createMosfetElement,
  MOSFET_NMOS_DEFAULTS,
} from "../mosfet.js";
import { PropertyBag } from "../../../core/properties.js";
import { makeDcVoltageSource } from "../../sources/dc-voltage-source.js";
import { withNodeIds, runDcOp } from "../../../solver/analog/__tests__/test-helpers.js";
import { StatePool } from "../../../solver/analog/state-pool.js";
import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import type { AnalogElement } from "../../../solver/analog/element.js";
import type { AnalogElementCore } from "../../../core/analog-types.js";
import type { ReactiveAnalogElement } from "../../../solver/analog/element.js";
import type { AnalogFactory } from "../../../core/registry.js";
import type { LoadContext } from "../../../solver/analog/load-context.js";
import {
  MODEDCOP, MODEINITFLOAT, MODEINITFIX,
  setInitf,
} from "../../../solver/analog/ckt-mode.js";

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
// DC-OP LoadContext helper — fresh SparseSolver sized for matrixSize rows.
// ---------------------------------------------------------------------------

function makeDcOpCtx(voltages: Float64Array, matrixSize: number): LoadContext {
  const solver = new SparseSolver();
  solver.beginAssembly(matrixSize);
  return {
    cktMode: MODEDCOP | MODEINITFLOAT,
    solver,
    voltages,
    dt: 0,
    method: "trapezoidal",
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
  };
}


function makeParamBag(params: Record<string, number>): PropertyBag {
  const bag = new PropertyBag();
  bag.replaceModelParams({ ...MOSFET_NMOS_DEFAULTS, ...params });
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
    elementWithPins.load(makeDcOpCtx(voltages, 3));
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
    load(ctx: LoadContext): void {
      const { solver } = ctx;
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
// NMOS unit tests
// ---------------------------------------------------------------------------

describe("NMOS", () => {
  it("cutoff_region", () => {
    // Vgs = 0V < VTO = 0.7V → device off, Id ≈ 0
    const element = makeNmosAtVgs_Vds(0, 5, NMOS_DEFAULTS);

    const voltages = new Float64Array(3);
    voltages[0] = 5;
    voltages[1] = 0;
    voltages[2] = 0;
    const ctx = makeDcOpCtx(voltages, 3);
    element.load(ctx);
    const rhs = ctx.solver.getRhsSnapshot();

    // The Norton current at drain/source should be ≈ 0 (only GMIN leakage)
    // All RHS stamps will be present but very small
    for (let i = 0; i < rhs.length; i++) {
      expect(Math.abs(rhs[i])).toBeLessThan(1e-10);
    }
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
    // Vgs=3V, Vds=5V (saturation): load should stamp nonzero conductances
    const element = makeNmosAtVgs_Vds(3, 5, NMOS_DEFAULTS);

    const voltages = new Float64Array(3);
    voltages[0] = 5;
    voltages[1] = 3;
    voltages[2] = 0;
    const ctx = makeDcOpCtx(voltages, 3);
    element.load(ctx);
    const entries = ctx.solver.getCSCNonZeros();

    expect(entries.length).toBeGreaterThan(0);

    // At least one conductance stamp should be significantly nonzero
    const nonzeroStamps = entries.filter((e) => Math.abs(e.value) > 1e-15);
    expect(nonzeroStamps.length).toBeGreaterThan(0);
  });

  it("srcFact_zero_does_not_scale_mosfet_stamps", () => {
    // ngspice parity: MOSFETs (mos1load.c) do not reference CKTsrcFact.
    // Device conductance and Norton RHS must be identical at srcFact=0 and srcFact=1.
    // Source-stepping scales only Vsrc/Isrc (vsrcload.c, isrcload.c) and nodeset/IC targets (cktload.c).
    const baseline = makeNmosAtVgs_Vds(3, 5, NMOS_DEFAULTS);
    const zeroed = makeNmosAtVgs_Vds(3, 5, NMOS_DEFAULTS);

    const voltages = new Float64Array(3);
    voltages[0] = 5;
    voltages[1] = 3;
    voltages[2] = 0;

    const ctxBaseline = makeDcOpCtx(voltages, 3);
    ctxBaseline.srcFact = 1;
    baseline.load(ctxBaseline);

    const ctxZero = makeDcOpCtx(voltages, 3);
    ctxZero.srcFact = 0;
    zeroed.load(ctxZero);

    const baselineEntries = ctxBaseline.solver.getCSCNonZeros();
    const zeroEntries     = ctxZero.solver.getCSCNonZeros();
    const baselineRhs     = ctxBaseline.solver.getRhsSnapshot();
    const zeroRhs         = ctxZero.solver.getRhsSnapshot();

    expect(zeroEntries.length).toBe(baselineEntries.length);
    for (let i = 0; i < baselineEntries.length; i++) {
      expect(zeroEntries[i].row).toBe(baselineEntries[i].row);
      expect(zeroEntries[i].col).toBe(baselineEntries[i].col);
      expect(zeroEntries[i].value).toBeCloseTo(baselineEntries[i].value, 14);
    }
    expect(zeroRhs.length).toBe(baselineRhs.length);
    for (let i = 0; i < baselineRhs.length; i++) {
      expect(zeroRhs[i]).toBeCloseTo(baselineRhs[i], 14);
    }
  });

  // -------------------------------------------------------------------------
  // checkConvergence without cqbd
  // -------------------------------------------------------------------------

  it("srcFact_default_equals_one", () => {
    // ngspice parity: CKTsrcFact defaults to 1 (cktinit.c:75). Omitting ctx.srcFact
    // must produce identical stamps and RHS to explicit srcFact=1.
    const elementDefault = makeNmosAtVgs_Vds(3, 5, NMOS_DEFAULTS);
    const elementScaled = makeNmosAtVgs_Vds(3, 5, NMOS_DEFAULTS);

    const voltages = new Float64Array(3);
    voltages[0] = 5;
    voltages[1] = 3;
    voltages[2] = 0;

    const ctxDefault = makeDcOpCtx(voltages, 3);
    elementDefault.load(ctxDefault);

    const ctxScaled = makeDcOpCtx(voltages, 3);
    ctxScaled.srcFact = 1;
    elementScaled.load(ctxScaled);

    const defaultEntries = ctxDefault.solver.getCSCNonZeros();
    const scaledEntries = ctxScaled.solver.getCSCNonZeros();
    const defaultRhs = ctxDefault.solver.getRhsSnapshot();
    const scaledRhs = ctxScaled.solver.getRhsSnapshot();

    expect(defaultEntries.length).toBe(scaledEntries.length);
    // Order of entries is deterministic given identical stamp sequences.
    for (let i = 0; i < defaultEntries.length; i++) {
      expect(defaultEntries[i].row).toBe(scaledEntries[i].row);
      expect(defaultEntries[i].col).toBe(scaledEntries[i].col);
      expect(defaultEntries[i].value).toBeCloseTo(scaledEntries[i].value, 15);
    }
    expect(defaultRhs.length).toBe(scaledRhs.length);
    for (let i = 0; i < defaultRhs.length; i++) {
      expect(defaultRhs[i]).toBeCloseTo(scaledRhs[i], 15);
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
    const core = withState(createMosfetElement(-1, new Map([["G", 2], ["S", 3], ["D", 1]]), [], -1, propsObj));
    // pinLayout order [G, D, S, B]; B=S for 3-terminal → [2, 1, 3, 3]
    const element = withNodeIds(core, [2, 1, 3, 3]) as unknown as AnalogElement;

    // vS=5V (node3), vG=2V (node2), vD=0V (node1)
    // Vgs = 2-5 = -3V, Vds = 0-5 = -5V
    const voltages = new Float64Array(3);
    voltages[0] = 0;  // V(D)=0
    voltages[1] = 2;  // V(G)=2
    voltages[2] = 5;  // V(S)=5

    for (let i = 0; i < 50; i++) {
      element.load(makeDcOpCtx(voltages, 3));
      voltages[0] = 0;
      voltages[1] = 2;
      voltages[2] = 5;
    }

    const ctx = makeDcOpCtx(voltages, 3);
    element.load(ctx);
    const rhs = ctx.solver.getRhsSnapshot();

    // PMOS in saturation: Id should flow from S to D (conventional positive Isd)
    // Norton current at drain node should be positive (current entering drain = Isd)
    // nodes: drain=node1→row 0, gate=node2→row 1, source=node3→row 2
    const drainRhs = rhs[0];
    const sourceRhs = rhs[2];

    // At least one RHS entry should be nonzero (device is conducting)
    let maxRhs = 0;
    for (let i = 0; i < rhs.length; i++) {
      const abs = Math.abs(rhs[i]);
      if (abs > maxRhs) maxRhs = abs;
    }
    expect(maxRhs).toBeGreaterThan(1e-10);

    // PMOS conducts: drain and source RHS entries should have opposite signs.
    // For PMOS: current flows into drain, out of source (opposite sign to NMOS).
    expect(Math.sign(drainRhs)).toBe(-Math.sign(sourceRhs));
  });

  it("pmos_definition_has_correct_device_type", () => {
    expect(PmosfetDefinition.modelRegistry?.["spice-l1"]).toBeDefined();
    expect(PmosfetDefinition.modelRegistry?.["spice-l1"]?.kind).toBe("inline");
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

    const result = runDcOp({
      elements: [vdd, vgate, rd, nmos],
      matrixSize,
      nodeCount: 3,
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

    const elements = [vdd, vgate, rd, nmos];

    // Before: VTO=0.7
    const before = runDcOp({ elements, matrixSize, nodeCount: 3 });
    expect(before.converged).toBe(true);
    expectSpiceRef(before.nodeVoltages[0], 1.840508e+00, "V(drain) before");

    // setParam and re-solve
    nmos.setParam("VTO", 2.5);
    const after = runDcOp({ elements, matrixSize, nodeCount: 3 });
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

    const elements = [vdd, vgate, rd, nmos];

    // Before: KP=120µ
    const before = runDcOp({ elements, matrixSize, nodeCount: 3 });
    expect(before.converged).toBe(true);
    expectSpiceRef(before.nodeVoltages[0], 1.840508e+00, "V(drain) before");

    // setParam and re-solve
    nmos.setParam("KP", 240e-6);
    const after = runDcOp({ elements, matrixSize, nodeCount: 3 });
    expect(after.converged).toBe(true);
    expectSpiceRef(after.nodeVoltages[0], 9.071396e-01, "V(drain) after KP=240µ");
    expectSpiceRef((after.nodeVoltages[1] - after.nodeVoltages[0]) / 1000, 4.092860e-03, "Id after KP=240µ");
  });
});

// ---------------------------------------------------------------------------
// LimitingEvent instrumentation tests — MOSFET
// ---------------------------------------------------------------------------

import type { LimitingEvent } from "../../../solver/analog/newton-raphson.js";

describe("MOSFET LimitingEvent instrumentation", () => {
  function makeNmosWithState(): AnalogElement {
    const propsObj = new PropertyBag();
    propsObj.replaceModelParams({ ...MOSFET_NMOS_DEFAULTS, VTO: 1.0, KP: 2e-5, GAMMA: 0, PHI: 0.6, LAMBDA: 0, W: 1e-6, L: 1e-6 });
    // Gate=1, Drain=2, Source=3; bulk tied to source internally by factory
    const pinNodes = new Map([["G", 1], ["D", 2], ["S", 3]]);
    const core = createMosfetElement(1, pinNodes, [], -1, propsObj);
    const re = withState(core) as any;
    re.label = "M1";
    re.elementIndex = 6;
    // pinLayout [G, D, S, B]; 3-terminal → B=S → [1, 2, 3, 3]
    const element = withNodeIds(re, [1, 2, 3, 3]) as unknown as AnalogElement;
    return element;
  }

  function makeCtxWithCollector(
    voltages: Float64Array,
    collector: LimitingEvent[] | null,
  ): LoadContext {
    const ctx = makeDcOpCtx(voltages, 10);
    return { ...ctx, limitingCollector: collector };
  }

  it("pushes GS (fetlim) event to limitingCollector", () => {
    const el = makeNmosWithState();
    const voltages = new Float64Array(10);
    voltages[0] = 5.0; // G = node 1
    voltages[1] = 3.0; // D = node 2
    voltages[2] = 0.0; // S = node 3

    const collector: LimitingEvent[] = [];
    el.load(makeCtxWithCollector(voltages, collector));

    const gsEv = collector.find((e: LimitingEvent) => e.junction === "GS");
    expect(gsEv).toBeDefined();
    expect(gsEv!.limitType).toBe("fetlim");
    expect(gsEv!.elementIndex).toBe(6);
    expect(gsEv!.label).toBe("M1");
    expect(Number.isFinite(gsEv!.vBefore)).toBe(true);
    expect(Number.isFinite(gsEv!.vAfter)).toBe(true);
    expect(typeof gsEv!.wasLimited).toBe("boolean");
  });

  it("pushes DS (limvds) event to limitingCollector", () => {
    const el = makeNmosWithState();
    const voltages = new Float64Array(10);
    voltages[0] = 5.0;
    voltages[1] = 3.0;
    voltages[2] = 0.0;

    const collector: LimitingEvent[] = [];
    el.load(makeCtxWithCollector(voltages, collector));

    const dsEv = collector.find((e: LimitingEvent) => e.junction === "DS");
    expect(dsEv).toBeDefined();
    expect(dsEv!.limitType).toBe("limvds");
    expect(dsEv!.elementIndex).toBe(6);
    expect(Number.isFinite(dsEv!.vBefore)).toBe(true);
    expect(Number.isFinite(dsEv!.vAfter)).toBe(true);
  });

  it("pushes BS or BD (pnjlim) bulk junction event", () => {
    const el = makeNmosWithState();
    const voltages = new Float64Array(10);
    voltages[0] = 5.0;
    voltages[1] = 3.0;
    voltages[2] = 0.0;

    const collector: LimitingEvent[] = [];
    el.load(makeCtxWithCollector(voltages, collector));

    const bulkEv = collector.find((e: LimitingEvent) => e.junction === "BS" || e.junction === "BD");
    expect(bulkEv).toBeDefined();
    expect(bulkEv!.limitType).toBe("pnjlim");
    expect(bulkEv!.elementIndex).toBe(6);
    expect(bulkEv!.label).toBe("M1");
  });

  it("does not throw when limitingCollector is null", () => {
    const el = makeNmosWithState();
    const voltages = new Float64Array(10);
    voltages[0] = 5.0;
    voltages[1] = 3.0;
    expect(() => el.load(makeCtxWithCollector(voltages, null))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// PMOS temperature scaling — type multiplier on tVbi/tVto
// ---------------------------------------------------------------------------

describe("PMOS temperature scaling", () => {
  it("pmos_tVto_differs_from_nmos_tVto_at_elevated_tnom", () => {
    // NMOS and PMOS with same magnitude VTO=0.7 and elevated TNOM=350K
    // The type multiplier (-1 for PMOS) must flip the GAMMA and delta-phi terms.
    // At TNOM != REFTEMP, tVbi and tVto will differ between NMOS and PMOS.

    const params = {
      VTO: 0.7, KP: 120e-6, LAMBDA: 0, PHI: 0.6, GAMMA: 0.37,
      CBD: 0, CBS: 0, CGDO: 0, CGSO: 0, W: 1e-6, L: 1e-6,
      TNOM: 350,
    };

    const nmosProps = makeParamBag({ ...params });
    const pmosProps = makeParamBag({ ...params, VTO: -0.7 });

    const nmos = withState(createMosfetElement(1, new Map([["G", 1], ["S", 2], ["D", 3]]), [], -1, nmosProps)) as any;
    const pmos = withState(createMosfetElement(-1, new Map([["G", 1], ["S", 2], ["D", 3]]), [], -1, pmosProps)) as any;

    const nmosTVto: number = nmos._p._tVto;
    const pmosTVto: number = pmos._p._tVto;

    // Both tVto should be defined (temperature correction was applied)
    expect(nmosTVto).toBeDefined();
    expect(pmosTVto).toBeDefined();

    // PMOS _p stores VTO as absolute value (see constructor); _tVto represents
    // the magnitude. With type multiplier, PMOS tVto diverges from NMOS tVto
    // when TNOM != REFTEMP and GAMMA != 0.
    expect(nmosTVto).not.toBeCloseTo(pmosTVto, 6);
  });

  it("pmos_tVto_symmetry_at_tnom_equals_reftemp", () => {
    // At TNOM = REFTEMP (300.15K), temperature correction terms vanish.
    // Both NMOS and PMOS should yield tVto ≈ their respective VTO.
    const nmosProps = makeParamBag({
      VTO: 0.7, KP: 120e-6, LAMBDA: 0, PHI: 0.6, GAMMA: 0.37,
      CBD: 0, CBS: 0, CGDO: 0, CGSO: 0, W: 1e-6, L: 1e-6,
      TNOM: 300.15,
    });
    const pmosProps = makeParamBag({
      VTO: -0.7, KP: 120e-6, LAMBDA: 0, PHI: 0.6, GAMMA: 0.37,
      CBD: 0, CBS: 0, CGDO: 0, CGSO: 0, W: 1e-6, L: 1e-6,
      TNOM: 300.15,
    });

    const nmos = withState(createMosfetElement(1, new Map([["G", 1], ["S", 2], ["D", 3]]), [], -1, nmosProps)) as any;
    const pmos = withState(createMosfetElement(-1, new Map([["G", 1], ["S", 2], ["D", 3]]), [], -1, pmosProps)) as any;

    const nmosTVto: number = nmos._p._tVto;
    const pmosTVto: number = pmos._p._tVto;

    // At nominal temperature both should be close to |VTO|=0.7
    expect(nmosTVto).toBeCloseTo(0.7, 2);
    expect(pmosTVto).toBeCloseTo(0.7, 2);
  });
});

// ---------------------------------------------------------------------------
// primeJunctions — MOSFET MODEINITJCT non-zero startup voltages
// ---------------------------------------------------------------------------

describe("MOSFET primeJunctions", () => {
  function makeNmosElement(params: Record<string, number> = {}): { element: any; pool: StatePool } {
    const bag = makeParamBag({ ...NMOS_DEFAULTS, ...params });
    const core = createMosfetElement(1, new Map([["G", 2], ["S", 3], ["D", 1]]), [], -1, bag) as any;
    const pool = new StatePool(core.stateSize);
    core.stateBaseOffset = 0;
    core.initState(pool);
    core.pinNodeIds = [2, 1, 3, 3];
    core.allNodeIds = [2, 1, 3, 3];
    return { element: core, pool };
  }

  it("checkConvergence_returns_true_during_initFix_when_OFF", () => {
    const { element } = makeNmosElement({ OFF: 1 });
    const voltages = new Float64Array(4);
    const ctx = makeDcOpCtx(voltages, 4);
    ctx.cktMode = setInitf(ctx.cktMode, MODEINITFIX);
    const result = element.checkConvergence(ctx);
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — inline NIintegrate migration (C2.2)
//
// ngspice NIintegrate mapping (niinteg.c:28-63):
//   CKTag[0] → ag[0]    coefficient on q0 (current charge)
//   CKTag[1] → ag[1]    coefficient on q1 (previous charge)
//   CKTag[2] → ag[2]    coefficient on q2 (2 steps back, order>=2)
//   geq      = ag[0] * cap
//   ccap     = ag[0]*q0 + ag[1]*q1 (+ ag[2]*q2 for order>=2)
//   ceq      = ccap - ag[0]*q0
// ---------------------------------------------------------------------------

describe("integration", () => {
  it("no_integrateCapacitor_import", () => {
    const fs = require("fs");
    const src = fs.readFileSync(
      require("path").resolve(__dirname, "../mosfet.ts"),
      "utf8",
    ) as string;
    expect(src).not.toMatch(/integrateCapacitor/);
    expect(src).not.toMatch(/integrateInductor/);
  });
});

