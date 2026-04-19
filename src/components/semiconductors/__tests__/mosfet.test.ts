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
  computeIds,
  computeGm,
  computeGds,
  computeGmbs,
  limitVoltages,
  computeCapacitances,
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
import { computeNIcomCof } from "../../../solver/analog/integration.js";
import {
  SLOT_Q_DB,
  SLOT_CCAP_DB,
  SLOT_CAP_GEQ_DB,
  SLOT_CAP_IEQ_DB,
} from "../../../solver/analog/fet-base.js";

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
    solver,
    voltages,
    iteration: 1,
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
<<<<<<< HEAD

    isTransientDcop: false,

=======
>>>>>>> e427e072 (D4: add isAc flag and pass LoadContext to stampAc (ngspice alignment))
    isAc: false,
    xfact: 1,
    gmin: 1e-12,
    uic: false,
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

  it("checkConvergence_without_cqbd_uses_mode_ids_minus_cbdI", () => {
    // Gap 16.1: checkConvergence must use cd = mode * ids - cbdI directly,
    // NOT subtract the capacitor companion current (cqbd).
    //
    // We drive the NMOS to a known saturation operating point, then call
    // checkConvergence with identical voltages. Because pnjlimLimited=false
    // and the voltages haven't changed, convergence should be declared.
    //
    // The key assertion is that convergence IS reached (not perpetually rejected
    // due to incorrect inclusion of cap companion current in the cd formula).

    // Create NMOS at Vgs=3V, Vds=5V (saturation), with CBD=1e-12 to exercise
    // the drain-bulk capacitance path. If cqbd were subtracted, cd would be
    // shifted by the cap companion current and convergence would be harder.
    const paramsWithCap = { ...NMOS_DEFAULTS, CBD: 1e-12 };
    const propsObj = makeParamBag(paramsWithCap);
    const core = withState(createMosfetElement(1, new Map([["G", 2], ["S", 3], ["D", 1]]), [], -1, propsObj));
    const element = withNodeIds(core, [2, 1, 3, 3]) as unknown as AnalogElement;

    // Set up state pool so analysisMode="tran" (transient)
    // The pool is accessed via the element's internal reference (_pool).
    const pool = (core as unknown as { _pool: { analysisMode: string; initMode: string } })._pool;
    pool.analysisMode = "tran";
    pool.initMode = "transient";

    // Drive to operating point: Vgs=3V, Vds=5V, Vs=0
    const voltages = new Float64Array(3);
    voltages[0] = 5;   // V(node1=D)
    voltages[1] = 3;   // V(node2=G)
    voltages[2] = 0;   // V(node3=S)

    for (let i = 0; i < 50; i++) {
      element.load(makeDcOpCtx(voltages, 3));
      voltages[0] = 5;
      voltages[1] = 3;
      voltages[2] = 0;
    }

    // checkConvergence with identical current (no change). The new-shape
    // signature is checkConvergence(ctx: LoadContext) — build a ctx whose
    // voltages match the element's last converged operating point.
    const ctx = makeDcOpCtx(voltages, 3);
    const converged = element.checkConvergence!(ctx);

    // With no voltage change and a converged operating point, checkConvergence
    // must return true. If cqbd were incorrectly subtracted, the cd formula
    // would be wrong and this might not hold.
    expect(converged).toBe(true);
  });

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
// gm and gds return 0 in cutoff (not GMIN)
// ---------------------------------------------------------------------------

describe("Cutoff gm/gds return 0", () => {
  it("gm_is_zero_in_cutoff", () => {
    // Vgs=0 < VTO=0.7: device is in cutoff
    const gm = computeGm(0, 5, 0, { ...NMOS_DEFAULTS });
    expect(gm).toBe(0);
  });

  it("gds_is_zero_in_cutoff", () => {
    // Vgs=0 < VTO=0.7: device is in cutoff
    const gds = computeGds(0, 5, 0, { ...NMOS_DEFAULTS });
    expect(gds).toBe(0);
  });

  it("gm_nonzero_above_threshold", () => {
    // Vgs=2 > VTO=0.7: device is active
    const gm = computeGm(2, 1, 0, { ...NMOS_DEFAULTS });
    expect(gm).toBeGreaterThan(0);
  });

  it("gds_nonzero_above_threshold", () => {
    // Vgs=2 > VTO=0.7: device is active
    const gds = computeGds(2, 1, 0, { ...NMOS_DEFAULTS });
    expect(gds).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// M multiplicity parameter scales current and capacitances
// ---------------------------------------------------------------------------

describe("MOSFET M multiplicity", () => {
  it("m2_doubles_drain_current_in_saturation", () => {
    // Two parallel MOSFETs = one MOSFET with M=2: drain current doubles
    const idM1 = computeIds(2, 5, 0, { ...NMOS_DEFAULTS }).ids;
    const idM2 = computeIds(2, 5, 0, { ...NMOS_DEFAULTS, M: 2 }).ids;
    expect(idM2).toBeCloseTo(2 * idM1, 10);
  });

  it("m2_doubles_gm", () => {
    const gmM1 = computeGm(2, 5, 0, { ...NMOS_DEFAULTS });
    const gmM2 = computeGm(2, 5, 0, { ...NMOS_DEFAULTS, M: 2 });
    expect(gmM2).toBeCloseTo(2 * gmM1, 10);
  });

  it("m2_doubles_gds", () => {
    const gdsM1 = computeGds(2, 1, 0, { ...NMOS_DEFAULTS });
    const gdsM2 = computeGds(2, 1, 0, { ...NMOS_DEFAULTS, M: 2 });
    expect(gdsM2).toBeCloseTo(2 * gdsM1, 10);
  });

  it("m2_doubles_overlap_capacitances", () => {
    const params = { ...NMOS_DEFAULTS, CGDO: 1e-10, CGSO: 2e-10, CGBO: 0.5e-10 };
    const capsM1 = computeCapacitances(params);
    const capsM2 = computeCapacitances({ ...params, M: 2 });
    expect(capsM2.cgd).toBeCloseTo(2 * capsM1.cgd, 15);
    expect(capsM2.cgs).toBeCloseTo(2 * capsM1.cgs, 15);
    expect(capsM2.cgb).toBeCloseTo(2 * capsM1.cgb, 15);
  });

  it("m1_is_default_unity", () => {
    // M=1 should produce the same result as no M specified
    const idDefault = computeIds(2, 5, 0, { ...NMOS_DEFAULTS }).ids;
    const idM1 = computeIds(2, 5, 0, { ...NMOS_DEFAULTS, M: 1 }).ids;
    expect(idM1).toBe(idDefault);
  });
});

// ---------------------------------------------------------------------------
// primeJunctions — MOSFET MODEINITJCT non-zero startup voltages
// ---------------------------------------------------------------------------

describe("MOSFET primeJunctions", () => {
  // SLOT indices from fet-base (must match the actual slot layout)
  const SLOT_VGS = 0;
  const SLOT_VDS = 1;
  const SLOT_VBS_OLD = 29;
  const SLOT_VBD_OLD = 30;

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

  it("primeJunctions_sets_vgs_to_tVto_and_vds_to_zero", () => {
    const { element, pool } = makeNmosElement();
    element.primeJunctions();
    // SLOT_VGS = tVto (temperature-corrected VTO, equals VTO at room temp)
    const vgs = pool.states[0][SLOT_VGS];
    const vds = pool.states[0][SLOT_VDS];
    expect(vgs).toBeCloseTo(NMOS_DEFAULTS.VTO, 6);
    expect(vds).toBeCloseTo(0, 6);
  });

  it("primeJunctions_sets_vbs_old_to_minus_one", () => {
    const { element, pool } = makeNmosElement();
    element.primeJunctions();
    const vbsOld = pool.states[0][SLOT_VBS_OLD];
    const vbdOld = pool.states[0][SLOT_VBD_OLD];
    expect(vbsOld).toBeCloseTo(-1, 6);
    expect(vbdOld).toBeCloseTo(-1, 6);
  });

  it("primeJunctions_with_OFF_sets_all_voltages_to_zero", () => {
    const { element, pool } = makeNmosElement({ OFF: 1 });
    element.primeJunctions();
    // primeJunctions writes directly to s0 slots; check before calling load()
    const vgs = pool.states[0][SLOT_VGS];
    const vds = pool.states[0][SLOT_VDS];
    const vbsOld = pool.states[0][SLOT_VBS_OLD];
    const vbdOld = pool.states[0][SLOT_VBD_OLD];
    expect(vgs).toBeCloseTo(0, 6);
    expect(vds).toBeCloseTo(0, 6);
    expect(vbsOld).toBeCloseTo(0, 6);
    expect(vbdOld).toBeCloseTo(0, 6);
  });

  it("checkConvergence_returns_true_during_initFix_when_OFF", () => {
    const { element, pool } = makeNmosElement({ OFF: 1 });
    pool.initMode = "initFix";
    const voltages = new Float64Array(4);
    const ctx = makeDcOpCtx(voltages, 4);
    ctx.initMode = "initFix";
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
  it("cgs_cgd_transient_matches_ngspice_mos1", () => {
    // Single transient step: NMOS with CBD=10pF at Vds=0.5V, Vgs=2V.
    // Bulk = Source = 0V (3-terminal device, nodeB = nodeS).
    // vbd = vBulk - vDrain = 0 - 0.5 = -0.5V (reverse bias).
    // Trapezoidal order 2: ag[0]=2/dt, ag[1]=1 (xmu=0.5).
    // Expected: geq_db = ag[0]*czbd_eff, ccap_db = ag[0]*q0 + ag[1]*q1,
    //           ceq_db = ccap_db - ag[0]*q0.

    const CBD = 10e-12;
    const PB = 0.7;  // bulk junction potential (MJ default = 0.5)
    const MJ = 0.5;

    const dt = 1e-9;
    const vds = 0.5;
    const vgs = 2.0;

    // ag[] for trapezoidal order 2
    const ag = new Float64Array(7);
    const agScratch = new Float64Array(49);
    computeNIcomCof(dt, [dt, dt, dt, dt, dt, dt, dt], 2, "trapezoidal", ag, agScratch);

    // Build NMOS with CBD > 0, no CJ (so czbd = _tCbd ≈ CBD at room temp)
    // Nodes: D=1, G=2, S=3, B=S=3
    const bag = makeParamBag({
      ...NMOS_DEFAULTS,
      CBD,
      CBS: CBD,
      PB,
      MJ,
      MJSW: 0.33,
    });
    const core = createMosfetElement(
      1,
      new Map([["G", 2], ["S", 3], ["D", 1]]),
      [],
      -1,
      bag,
    ) as any;

    const pool = new StatePool(core.stateSize);
    core.stateBaseOffset = 0;
    core.initState(pool);
    Object.assign(core, { pinNodeIds: [2, 1, 3, 3], allNodeIds: [2, 1, 3, 3] });

    // Compute expected czbd at room temperature (capfact ≈ 1 at TNOM=300.15K=REFTEMP)
    // vbd = -vds = -0.5V (reverse bias, below tDepCap which requires argD > 0)
    // czbd ≈ CBD (at room temp, capfact = 1)
    const czbd = CBD;
    // Seed previous-step charge in s1 (simulates one accepted prior step)
    const prevVbd = -0.4;
    const prevArgD = 1 - prevVbd / PB;
    const prevSargD = Math.exp(-MJ * Math.log(prevArgD));
    const q1_db = PB * czbd * (1 - prevArgD * prevSargD) / (1 - MJ);
    pool.state1[SLOT_Q_DB] = q1_db;

    // Build minimal LoadContext: voltages[0]=vD=vds, voltages[1]=vG=vgs, voltages[2]=vS=0
    const solver = new SparseSolver();
    solver.beginAssembly(3);

    pool.ag.set(ag);
    const ctx: LoadContext = {
      solver,
      voltages: new Float64Array([vds, vgs, 0]),
      iteration: 0,
      initMode: "transient",
      dt,
      method: "trapezoidal",
      order: 2,
      deltaOld: [dt, dt, dt, dt, dt, dt, dt],
      ag,
      srcFact: 1,
      noncon: { value: 0 },
      limitingCollector: null,
      isDcOp: false,
      isTransient: true,
<<<<<<< HEAD

      isTransientDcop: false,

=======
>>>>>>> e427e072 (D4: add isAc flag and pass LoadContext to stampAc (ngspice alignment))
      isAc: false,
      xfact: 1,
      gmin: 1e-12,
      uic: false,
      reltol: 1e-3,
      iabstol: 1e-12,
    };

    pool.initMode = "transient";
    core.load(ctx);

    // The _stampCompanion path writes directly to s0 slots
    const s0 = pool.state0;

    // Read what the element stored
    const q0_db = s0[SLOT_Q_DB];
    const q2_db = pool.state2[SLOT_Q_DB];
    const stored_geq = s0[SLOT_CAP_GEQ_DB];
    const stored_ceq = s0[SLOT_CAP_IEQ_DB];
    const stored_ccap = s0[SLOT_CCAP_DB];

    // Derive capbd from stored geq: capbd = geq / ag[0]
    const capbd_from_element = stored_geq / ag[0];

    // Verify NIintegrate identity: geq = ag[0] * capbd (bit-exact)
    expect(stored_geq).toBe(ag[0] * capbd_from_element);

    // Verify ccap = ag[0]*q0 + ag[1]*q1 + ag[2]*q2 (bit-exact)
    const ccap_expected = ag[0] * q0_db + ag[1] * q1_db + ag[2] * q2_db;
    expect(stored_ccap).toBe(ccap_expected);

    // Verify ceq = ccap - ag[0]*q0 (bit-exact)
    const ceq_expected = ccap_expected - ag[0] * q0_db;
    expect(stored_ceq).toBe(ceq_expected);
  });

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

// ===========================================================================
// mosfet_spicel1_load_dcop_parity
//
// Canonical saturation-region NMOS (SPICE-L1):
//   Vgs=2V, Vds=3V, Vt=VTO=1V, KP=100µA/V², W=L=1µm, GAMMA=0, LAMBDA=0.
//   TNOM=300.15K (=REFTEMP) → temperature correction factor = 1 (identity).
//
// mos1load.c variable mapping:
//   vgs      = 2V,  vds = 3V
//   tKP      = KP = 100e-6  (ratio=REFTEMP/TNOM=1, ratio4=1, _tTransconductance=KP/1)
//   tPhi     = PHI = 0.6
//   tVto     = VTO = 1  (no temperature shift at TNOM=REFTEMP)
//   GAMMA=0  → body effect sarg=sqrt(PHI), vth=VTO (no Vsb body term since Vsb=0)
//   vgst     = vgs - vth = 1V
//   vdsat    = 1V (= vgst in saturation)
//   vds=3 >= vgst=1 → SATURATION
//   Beta     = tKP * W/L = 100e-6
//   ids      = Beta * vgst² * 0.5 = 5e-5 A
//   gm       = Beta * vgst + GMIN = 1e-4 + GMIN
//   gds      = Beta * LAMBDA * vgst² * 0.5 + GMIN = GMIN  (LAMBDA=0)
//   gmbs     = 0  (GAMMA=0)
//
// Bulk junctions (B=S=0=ground, IS=1e-14):
//   vbs=0, vbd=-3V (<= -3*VT → gbd=GMIN, cbdI=GMIN*(-3)-IS)
//   gbs = IS/VT + GMIN, cbsI = 0  (vbs=0 → evbs=1, cbsI=IS*(1-1)=0)
//   ceqbd = cbdI - gbd*vbd = (-3*GMIN-IS) - GMIN*(-3) = -IS
//   ceqbs = 0 - gbs*0 = 0
//
// MNA node layout: D=1 (row/col 0), G=2 (row/col 1), S=0 (ground), B=0 (ground).
// Stamps survive only where both row and col are non-zero.
//
// Matrix entries:
//   (D,D) = gds + gbd = GMIN + GMIN = 2*GMIN
//   (D,G) = gm = KP + GMIN
//   RHS[D] = -(ids-gm*vgs-gds*vds) + IS  (channel Norton + bulk drain Norton)
// ===========================================================================

describe("mosfet_spicel1_load_dcop_parity", () => {
  it("saturation_nmos_dcop_stamp_bit_exact_vs_ngspice_mos1load_formula", () => {
    const VGS    = 2;
    const VDS    = 3;
    const VTO    = 1;
    const KP     = 100e-6;
    const W      = 1e-6;
    const L      = 1e-6;
    const PHI    = 0.6;
    const GAMMA  = 0;
    const LAMBDA = 0;
    const IS_JCT = 1e-14;
    const GMIN   = 1e-12;

    // TNOM = 300.15 K (= REFTEMP) so all temperature correction factors = 1.
    const TNOM   = 300.15;

    // Build NMOS element: polarity=1, G=2, S=0 (ground), D=1, B=0 (tied to source).
    // All caps zero, RD=RS=0 (no internal nodes).
    const propsObj = makeParamBag({
      VTO, KP, LAMBDA, W, L, PHI, GAMMA,
      CBD: 0, CBS: 0, CGDO: 0, CGSO: 0, CGBO: 0,
      RD: 0, RS: 0, IS: IS_JCT, PB: 0.8,
      CJ: 0, MJ: 0.5, CJSW: 0, MJSW: 0.5, JS: 0, RSH: 0,
      AD: 0, AS: 0, PD: 0, PS: 0,
      TOX: 0, NSUB: 0, NSS: 0, TPG: 1, LD: 0, UO: 600,
      KF: 0, AF: 1, FC: 0.5, M: 1, OFF: 0,
      TNOM,
    });

    // polarity=1 (NMOS), D=1, G=2, S=0, B tied to S → factory uses B=S=0
    const core = createMosfetElement(1, new Map([["G", 2], ["S", 0], ["D", 1]]), [], -1, propsObj);
    const pool = new StatePool(core.stateSize);
    (core as any).stateBaseOffset = 0;
    core.initState(pool);

    // Seed SLOT_VGS (0) and SLOT_VDS (1) so fetlim/limitVoltages passes through unchanged.
    pool.state0[0] = VGS;  // SLOT_VGS
    pool.state0[1] = VDS;  // SLOT_VDS
    // Seed SLOT_VON (28) to VTO so fetlim uses the correct threshold.
    pool.state0[28] = VTO; // SLOT_VON
    // Seed SLOT_VBS_OLD (29) = 0 so pnjlim on vbs=0 passes through.
    pool.state0[29] = 0;   // SLOT_VBS_OLD
    // SLOT_VBD_OLD (30) = 0 (default from initState, consistent with reverse-bias start).
    pool.state0[30] = 0;   // SLOT_VBD_OLD

    // MNA voltages: V(D=1)=VDS, V(G=2)=VGS (S=0=ground, B=0=ground).
    const voltages = new Float64Array([VDS, VGS]);
    const solver = new SparseSolver();
    solver.beginAssembly(2);

    const ctx: LoadContext = {
      solver,
      voltages,
      iteration: 1,
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
<<<<<<< HEAD

      isTransientDcop: false,

=======
>>>>>>> e427e072 (D4: add isAc flag and pass LoadContext to stampAc (ngspice alignment))
      isAc: false,
      xfact: 1,
      gmin: GMIN,
      uic: false,
      reltol: 1e-3,
      iabstol: 1e-12,
    };

    // withNodeIds: pinLayout [G, D, S, B] → nodeIds [2, 1, 0, 0]
    const el = withNodeIds(core as unknown as AnalogElementCore, [2, 1, 0, 0]);
    el.load(ctx);

    // ---------------------------------------------------------------------------
    // NGSPICE_REF: mos1load.c saturation-region formulas
    // ---------------------------------------------------------------------------
    // At TNOM=REFTEMP: tKP=KP, tPhi=PHI, tVto=VTO, tempFactor=1.
    const NGSPICE_tKP    = KP;                              // temperature-corrected KP
    const NGSPICE_vth    = VTO;                             // no body effect (GAMMA=0, vsb=0)
    const NGSPICE_vgst   = VGS - NGSPICE_vth;              // = 1
    const NGSPICE_Beta   = NGSPICE_tKP * W / L;            // = 100e-6
    // Saturation: vds=3 >= vgst=1
    const NGSPICE_IDS    = NGSPICE_Beta * NGSPICE_vgst * NGSPICE_vgst * 0.5
                          * (1 + LAMBDA * VDS);             // = 5e-5
    const NGSPICE_GM     = NGSPICE_Beta * (1 + LAMBDA * VDS) * NGSPICE_vgst + GMIN; // = 1e-4 + GMIN
    const NGSPICE_GDS    = NGSPICE_Beta * LAMBDA * NGSPICE_vgst * NGSPICE_vgst * 0.5 + GMIN; // = GMIN
    const NGSPICE_GMBS   = 0;                              // GAMMA=0 → no body effect
    // Bulk drain junction: vbd = vbs - vds = 0 - 3 = -3V (< -3*VT → reverse saturation)
    const NGSPICE_GBD    = GMIN;                           // gbd = GMIN when vbd <= -3*VT
    // Norton: ids - gm*vgs - gds*vds - gmbs*vbs (vbs=0)
    const NGSPICE_nortonId = NGSPICE_IDS
      - NGSPICE_GM  * VGS
      - NGSPICE_GDS * VDS
      - NGSPICE_GMBS * 0;

    // ---------------------------------------------------------------------------
    // Read assembled matrix entries.
    // D=1→row/col 0, G=2→row/col 1, S=0→ground (skipped), B=0→ground (skipped).
    // ---------------------------------------------------------------------------
    const entries = solver.getCSCNonZeros();
    const sumAt = (row: number, col: number): number =>
      entries
        .filter((e) => e.row === row && e.col === col)
        .reduce((acc, e) => acc + e.value, 0);

    // (D, D): gds from channel + gbd from drain-bulk junction
    expect(sumAt(0, 0)).toBe(NGSPICE_GDS + NGSPICE_GBD);

    // (D, G): gm from transconductance stamp
    expect(sumAt(0, 1)).toBe(NGSPICE_GM);

    // (G, *): no G-row stamps (gate has no conductance to itself)
    expect(sumAt(1, 0)).toBe(0);
    expect(sumAt(1, 1)).toBe(0);

    // RHS[D]: channel Norton + bulk drain Norton (-polarity * ceqbd = IS)
    const rhs = solver.getRhsSnapshot();
    expect(rhs[0]).toBe(-NGSPICE_nortonId + IS_JCT);
    // RHS[G]: no stamps on gate row
    expect(rhs[1]).toBe(0);
  });
});
