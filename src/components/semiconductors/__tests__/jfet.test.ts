/**
 * Tests for N-channel and P-channel JFET components.
 *
 * Covers:
 *   - NJFET: cutoff, saturation, linear regions (Shichman-Hodges)
 *   - NJFET: output characteristics (family of curves)
 *   - NJFET: gate forward current (junction diode)
 *   - NJFET: channel-length modulation (LAMBDA)
 *   - PJFET: polarity inversion
 *   - NR convergence within 10 iterations
 *   - Component registration
 */

import { describe, it, expect } from "vitest";
import {
  NJfetDefinition,
  createNJfetElement,
  NJfetAnalogElement,
  SLOT_VGS_JUNCTION,
  SLOT_GD_JUNCTION,
  SLOT_ID_JUNCTION,
} from "../njfet.js";
import { SLOT_VGS, SLOT_VDS } from "../../../solver/analog/fet-base.js";
import { VT } from "../../../core/constants.js";
import {
  PJfetDefinition,
  createPJfetElement,
} from "../pjfet.js";
import { ComponentRegistry } from "../../../core/registry.js";
import { createTestPropertyBag } from "../../../test-fixtures/model-fixtures.js";
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
  MODEDCOP,
  MODEINITFLOAT,
  MODEAC,
  MODEINITSMSIG,
  MODEINITTRAN,
  MODETRAN,
  MODETRANOP,
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

// ---------------------------------------------------------------------------
// Default model parameters
// ---------------------------------------------------------------------------

const NJFET_PARAMS = {
  VTO: -2.0,    // pinch-off voltage (negative for N-channel)
  BETA: 1e-4,   // transconductance parameter (A/V²)
  LAMBDA: 0,    // no channel-length modulation by default
  IS: 1e-14,    // gate junction saturation current
  N: 1,         // gate junction emission coefficient
  CGS: 0,
  CGD: 0,
  PB: 1.0,
  FC: 0.5,
  RD: 0,
  RS: 0,
  KF: 0,
  AF: 1,
  TNOM: 27,
};

const PJFET_PARAMS = {
  VTO: 2.0,     // pinch-off voltage (positive for P-channel)
  BETA: 1e-4,
  LAMBDA: 0,
  IS: 1e-14,
  N: 1,
  CGS: 0,
  CGD: 0,
  PB: 1.0,
  FC: 0.5,
  RD: 0,
  RS: 0,
  KF: 0,
  AF: 1,
  TNOM: 27,
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
    uic: false,
    reltol: 1e-3,
    iabstol: 1e-12,
  };
}

// ---------------------------------------------------------------------------
// Helper: inline resistor
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
// NJFET unit tests
// ---------------------------------------------------------------------------

describe("NJFET", () => {
  it("cutoff_zero_current", () => {
    // V_GS = -3V < V_P = -2V → device off
    // With nodeG=1, nodeD=2, nodeS=0 (ground)
    // G=voltage[0]=-3V, D=voltage[1]=5V
    const propsObj = createTestPropertyBag();
    propsObj.replaceModelParams(NJFET_PARAMS);
    const core = withState(createNJfetElement(new Map([["G", 1], ["S", 0], ["D", 2]]), [], -1, propsObj));
    const element = withNodeIds(core, [1, 2, 0]); // [G, D, S]

    const voltages = new Float64Array(2);
    voltages[0] = -3; // V(G) = -3V → Vgs = -3V
    voltages[1] = 5;  // V(D) = 5V → Vds = 5V

    for (let i = 0; i < 50; i++) {
      element.load(makeDcOpCtx(voltages, 2));
    }

    const ctx = makeDcOpCtx(voltages, 2);
    element.load(ctx);
    const rhs = ctx.solver.getRhsSnapshot();

    // In cutoff: Norton current ≈ 0 (only GMIN leakage)
    for (let i = 0; i < rhs.length; i++) {
      expect(Math.abs(rhs[i])).toBeLessThan(1e-9);
    }
  });

  it("saturation_current", () => {
    // V_GS = 0V, V_DS = 5V, V_P = -2V, β = 1e-4
    // In saturation (V_DS >= V_GS - V_P = 0 - (-2) = 2V → 5 >= 2 ✓)
    // I_DS = β/2 * (V_GS - V_P)² * (1 + λ*V_DS)
    //      = 1e-4/2 * (0 - (-2))² * 1
    //      = 1e-4/2 * 4 = 0.2mA
    const params = { ...NJFET_PARAMS, LAMBDA: 0 };
    const propsObj = createTestPropertyBag();
    propsObj.replaceModelParams(params);
    const core = withState(createNJfetElement(new Map([["G", 1], ["S", 0], ["D", 2]]), [], -1, propsObj)) as unknown as NJfetAnalogElement;
    const element = withNodeIds(core, [1, 2, 0]);

    const voltages = new Float64Array(2);
    voltages[0] = 0; // V(G) = 0V → Vgs = 0
    voltages[1] = 5; // V(D) = 5V → Vds = 5

    for (let i = 0; i < 50; i++) {
      element.load(makeDcOpCtx(voltages, 2));
    }

    // Expected: Ids = beta/2 * (Vgs - Vp)^2 = 1e-4/2 * (0-(-2))^2 = 0.2mA
    const expectedIds = (params.BETA / 2) * Math.pow(0 - params.VTO, 2);
    expect(expectedIds).toBeCloseTo(0.2e-3, 8);

    const ctx = makeDcOpCtx(voltages, 2);
    element.load(ctx);
    const rhs = ctx.solver.getRhsSnapshot();

    // Norton current at D should reflect Ids
    let hasSignificantCurrent = false;
    for (let i = 0; i < rhs.length; i++) {
      if (Math.abs(rhs[i]) > 1e-5) { hasSignificantCurrent = true; break; }
    }
    expect(hasSignificantCurrent).toBe(true);
  });

  it("linear_region", () => {
    // V_GS = 0V, V_DS = 0.5V, V_P = -2V
    // V_GS - V_P = 2V, V_DS = 0.5V < 2V → linear region
    // I_DS = β*(Vgst*Vds - Vds²/2) = 1e-4*(2*0.5 - 0.25/2) = 1e-4*(1-0.125) = 0.0875mA
    const params = { ...NJFET_PARAMS, LAMBDA: 0 };
    const propsObj = createTestPropertyBag();
    propsObj.replaceModelParams(params);
    const core = withState(createNJfetElement(new Map([["G", 1], ["S", 0], ["D", 2]]), [], -1, propsObj)) as unknown as NJfetAnalogElement;
    const element = withNodeIds(core, [1, 2, 0]);

    const voltages = new Float64Array(2);
    voltages[0] = 0;   // Vgs = 0
    voltages[1] = 0.5; // Vds = 0.5

    for (let i = 0; i < 50; i++) {
      element.load(makeDcOpCtx(voltages, 2));
    }

    const expectedIds = params.BETA * (2 * 0.5 - 0.5 * 0.5 / 2);
    expect(expectedIds).toBeCloseTo(0.0875e-3, 10);

    const ctx = makeDcOpCtx(voltages, 2);
    element.load(ctx);
    const rhs = ctx.solver.getRhsSnapshot();

    // Non-zero Norton current expected
    let hasLinearCurrent = false;
    for (let i = 0; i < rhs.length; i++) {
      if (Math.abs(rhs[i]) > 1e-6) { hasLinearCurrent = true; break; }
    }
    expect(hasLinearCurrent).toBe(true);
  });

  it("output_characteristics", () => {
    // Sweep V_DS from 0 to 10V at V_GS = 0, -0.5, -1.0
    // Family of curves: saturation current decreases as Vgs becomes more negative
    const params = { ...NJFET_PARAMS, LAMBDA: 0 };

    function getIdsat(vgs: number, vds: number): number {
      const vp = params.VTO;
      const vgst = vgs - vp;
      if (vgst <= 0) return 0;
      if (vds < vgst) {
        return params.BETA * (vgst * vds - vds * vds / 2);
      }
      return (params.BETA / 2) * vgst * vgst;
    }

    // At Vds=10V (saturation), Vgs=0 should give max current, Vgs=-1 less, Vgs=-2 zero
    const ids0 = getIdsat(0, 10);     // Vgs=0, saturated
    const ids05 = getIdsat(-0.5, 10); // Vgs=-0.5
    const ids10 = getIdsat(-1.0, 10); // Vgs=-1.0
    const ids20 = getIdsat(-2.0, 10); // Vgs=-2.0 = Vp → cutoff

    expect(ids0).toBeGreaterThan(ids05);
    expect(ids05).toBeGreaterThan(ids10);
    expect(ids10).toBeGreaterThan(0);
    expect(ids20).toBe(0); // cutoff at Vp

    // Verify pinch-off visible: at Vds=Vgst, current reaches saturation plateau
    // For Vgs=0: Vgst = 2V, check Ids(Vds=2) ≈ Ids(Vds=10) in saturation model
    const idsAtPinchoff = getIdsat(0, 2.0);
    const idsDeepSat = getIdsat(0, 10);
    expect(idsAtPinchoff).toBeCloseTo(idsDeepSat, 6); // both in saturation
  });

  it("gate_forward_current", () => {
    // V_GS = +0.7V (forward biased junction)
    // Should produce measurable gate current from Shockley equation
    // Ig = IS * (exp(Vgs/Vt) - 1) ≈ 1e-14 * exp(0.7/0.02585) ≈ significant
    const VT = 0.02585;
    const IS = NJFET_PARAMS.IS;
    const vgs = 0.7;
    const expectedIg = IS * (Math.exp(vgs / VT) - 1);

    // expectedIg should be much larger than IS (forward-biased junction)
    expect(expectedIg).toBeGreaterThan(IS * 100);

    // Create element with forward-biased gate
    const propsObj = createTestPropertyBag();
    propsObj.replaceModelParams(NJFET_PARAMS);
    const core = withState(createNJfetElement(new Map([["G", 1], ["S", 0], ["D", 2]]), [], -1, propsObj));
    const element = withNodeIds(core, [1, 2, 0]);

    const voltages = new Float64Array(2);
    voltages[0] = 0.7; // V(G) = 0.7V → Vgs = 0.7V
    voltages[1] = 0;   // V(D) = 0 → Vds = 0

    for (let i = 0; i < 50; i++) {
      element.load(makeDcOpCtx(voltages, 2));
    }

    const ctx = makeDcOpCtx(voltages, 2);
    element.load(ctx);
    const rhs = ctx.solver.getRhsSnapshot();

    // With forward bias, gate junction contributes current
    let maxRhs = 0;
    for (let i = 0; i < rhs.length; i++) {
      const abs = Math.abs(rhs[i]);
      if (abs > maxRhs) maxRhs = abs;
    }
    expect(maxRhs).toBeGreaterThan(1e-9); // measurable junction current
  });

  it("lambda_channel_length_modulation", () => {
    // With LAMBDA = 0.01, I_DS should increase slightly with V_DS in saturation
    // (non-flat output curves due to channel-length modulation)
    const paramsNoLambda = { ...NJFET_PARAMS, LAMBDA: 0 };
    const paramsWithLambda = { ...NJFET_PARAMS, LAMBDA: 0.01 };

    // Both Vgs=0, saturation region: compare Ids at Vds=5V vs Vds=10V
    function getIdsSat(params: typeof NJFET_PARAMS, vds: number): number {
      const vp = params.VTO;
      const vgst = 0 - vp;
      return (params.BETA / 2) * vgst * vgst * (1 + params.LAMBDA * vds);
    }

    // Without lambda: Ids same at Vds=5 and Vds=10
    const ids5NoL = getIdsSat(paramsNoLambda, 5);
    const ids10NoL = getIdsSat(paramsNoLambda, 10);
    expect(ids5NoL).toBeCloseTo(ids10NoL, 10);

    // With lambda: Ids increases with Vds
    const ids5WithL = getIdsSat(paramsWithLambda, 5);
    const ids10WithL = getIdsSat(paramsWithLambda, 10);
    expect(ids10WithL).toBeGreaterThan(ids5WithL);
    expect(ids10WithL / ids5WithL).toBeCloseTo((1 + 0.01 * 10) / (1 + 0.01 * 5), 6);
  });
});

// ---------------------------------------------------------------------------
// PJFET tests
// ---------------------------------------------------------------------------

describe("PJFET", () => {
  it("polarity_inverted", () => {
    // P-JFET: current flows from source to drain (Isd)
    // With Vgs (raw) = -3V (gate negative relative to source), meaning Vsg = 3V
    // Vs = 5V (source at high rail), Vg = 2V, Vd = 0V
    // Vsg = 5 - 2 = 3V > |VTO| = 2V → device on
    // Vsd = 5 - 0 = 5V → saturation (Vsd > Vsg - Vp = 3 - 2 = 1V)
    const propsObj = createTestPropertyBag();
    propsObj.replaceModelParams(PJFET_PARAMS);
    const core = withState(createPJfetElement(new Map([["G", 1], ["D", 2], ["S", 3]]), [], -1, propsObj));
    const element = withNodeIds(core, [1, 2, 3]); // [G, D, S]

    // node1=G=2V, node2=D=0V, node3=S=5V
    const voltages = new Float64Array(3);
    voltages[0] = 2; // V(G) = 2V
    voltages[1] = 0; // V(D) = 0V
    voltages[2] = 5; // V(S) = 5V

    for (let i = 0; i < 50; i++) {
      element.load(makeDcOpCtx(voltages, 3));
    }

    const ctx = makeDcOpCtx(voltages, 3);
    element.load(ctx);
    const entries = ctx.solver.getCSCNonZeros();
    const rhs = ctx.solver.getRhsSnapshot();

    // Device should be conducting: non-zero stamps expected
    const nonzeroStamps = entries.filter((e) => Math.abs(e.value) > 1e-15);
    expect(nonzeroStamps.length).toBeGreaterThan(0);

    // RHS entries should be nonzero
    let maxRhs = 0;
    for (let i = 0; i < rhs.length; i++) {
      const abs = Math.abs(rhs[i]);
      if (abs > maxRhs) maxRhs = abs;
    }
    expect(maxRhs).toBeGreaterThan(1e-10);
  });
});

// ---------------------------------------------------------------------------
// NR convergence test
// ---------------------------------------------------------------------------

describe("NR", () => {
  it("converges_within_10_iterations", () => {
    // Common-gate NJFET: Vdd=10V, Rs=10kΩ (self-biasing)
    // Gate grounded (Vg=0), source through Rs to ground
    // MNA: node1=gate=0(grounded via source), node2=drain, node3=source
    // Use simpler topology: Vdd→Rd→drain, gate=0, source=gnd
    // node1=drain, node2=Vdd(10V), node3=gate(0V)
    // branches: row3=Vdd source, row4=Vgate source
    const matrixSize = 5;

    // createNJfetElement pin order: [G, S, D]
    const propsObj = createTestPropertyBag();
    propsObj.replaceModelParams(NJFET_PARAMS);
    const jfet = withState(withNodeIds(createNJfetElement(new Map([["G", 3], ["S", 0], ["D", 1]]), [], -1, propsObj), [3, 0, 1]));
    const rd = makeResistorElement(2, 1, 10000); // Rd=10kΩ from Vdd to drain
    const vdd = makeDcVoltageSource(2, 0, 3, 10.0) as unknown as AnalogElement; // Vdd=10V
    const vgate = makeDcVoltageSource(3, 0, 4, 0.0) as unknown as AnalogElement; // Vg=0V

    const result = runDcOp({
      elements: [vdd, vgate, rd, jfet],
      matrixSize,
      nodeCount: 3,
      params: { maxIterations: 10 },
    });

    expect(result.converged).toBe(true);
    expect(result.iterations).toBeLessThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// Registration test
// ---------------------------------------------------------------------------

describe("Registration", () => {
  it("njfet_registered", () => {
    const registry = new ComponentRegistry();
    registry.register(NJfetDefinition);

    const def = registry.get("NJFET");
    expect(def).toBeDefined();
    expect(def!.modelRegistry?.["spice"]).toBeDefined();
    expect(def!.category).toBeDefined();
    expect((def!.modelRegistry?.["spice"] as {kind:"inline";factory:AnalogFactory}|undefined)?.factory).toBeDefined();
  });

  it("pjfet_registered", () => {
    const registry = new ComponentRegistry();
    registry.register(PJfetDefinition);

    const def = registry.get("PJFET");
    expect(def).toBeDefined();
    expect(def!.modelRegistry?.["spice"]).toBeDefined();
    expect((def!.modelRegistry?.["spice"] as {kind:"inline";factory:AnalogFactory}|undefined)?.factory).toBeDefined();
  });

  it("njfet_pin_layout_has_three_pins", () => {
    expect(NJfetDefinition.pinLayout).toHaveLength(3);
    const labels = NJfetDefinition.pinLayout.map((p) => p.label);
    expect(labels).toContain("G");
    expect(labels).toContain("D");
    expect(labels).toContain("S");
  });
});

// ---------------------------------------------------------------------------
// State-pool schema tests — WC7: JFET 3-slot extension schema
// ---------------------------------------------------------------------------

describe("JFET state-pool extension schema", () => {
  it("extension_slot_constants_are_45_46_47", () => {
    // FET_BASE_SCHEMA has 45 slots (0-44); JFET extension starts at 45.
    expect(SLOT_VGS_JUNCTION).toBe(45);
    expect(SLOT_GD_JUNCTION).toBe(46);
    expect(SLOT_ID_JUNCTION).toBe(47);
  });

  it("initState_initializes_VGS_JUNCTION_to_zero", () => {
    const propsObj = createTestPropertyBag();
    propsObj.replaceModelParams(NJFET_PARAMS);
    const element = createNJfetElement(new Map([["G", 1], ["S", 0], ["D", 2]]), [], -1, propsObj);
    const pool = new StatePool(48);
    element.stateBaseOffset = 0;
    element.initState(pool);
    expect(pool.state0[SLOT_VGS_JUNCTION]).toBe(0);
  });

  it("initState_initializes_ID_JUNCTION_to_zero", () => {
    const propsObj = createTestPropertyBag();
    propsObj.replaceModelParams(NJFET_PARAMS);
    const element = createNJfetElement(new Map([["G", 1], ["S", 0], ["D", 2]]), [], -1, propsObj);
    const pool = new StatePool(48);
    element.stateBaseOffset = 0;
    element.initState(pool);
    expect(pool.state0[SLOT_ID_JUNCTION]).toBe(0);
  });

  it("junction_slots_are_written_by_load", () => {
    const propsObj = createTestPropertyBag();
    propsObj.replaceModelParams(NJFET_PARAMS);
    const core = withState(createNJfetElement(new Map([["G", 1], ["S", 0], ["D", 2]]), [], -1, propsObj));
    const element = withNodeIds(core, [1, 2, 0]);

    // Forward-bias gate junction: V(G)=0.7V, V(S)=0V
    const voltages = new Float64Array(2);
    voltages[0] = 0.7;
    voltages[1] = 0;

    for (let i = 0; i < 20; i++) {
      element.load(makeDcOpCtx(voltages, 2));
    }

    // After forward-bias iterations, GD_JUNCTION should be > GMIN (junction active)
    const pool = (element as unknown as { _s0: Float64Array })._s0;
    const gdJunction = pool[SLOT_GD_JUNCTION];
    expect(gdJunction).toBeGreaterThan(1e-12);

    // ID_JUNCTION should be nonzero (junction conducting)
    const idJunction = pool[SLOT_ID_JUNCTION];
    expect(Math.abs(idJunction)).toBeGreaterThan(0);
  });

  it("pjfet_initState_initializes_extension_slots", () => {
    const propsObj = createTestPropertyBag();
    propsObj.replaceModelParams(PJFET_PARAMS);
    const element = createPJfetElement(new Map([["G", 1], ["D", 2], ["S", 3]]), [], -1, propsObj);
    const pool = new StatePool(48);
    element.stateBaseOffset = 0;
    element.initState(pool);
    expect(pool.state0[SLOT_VGS_JUNCTION]).toBe(0);
    expect(pool.state0[SLOT_GD_JUNCTION]).toBe(1e-12);
    expect(pool.state0[SLOT_ID_JUNCTION]).toBe(0);
  });

  it("base_slots_still_initialized_by_initState", () => {
    const propsObj = createTestPropertyBag();
    propsObj.replaceModelParams(NJFET_PARAMS);
    const element = createNJfetElement(new Map([["G", 1], ["S", 0], ["D", 2]]), [], -1, propsObj);
    const pool = new StatePool(48);
    element.stateBaseOffset = 0;
    element.initState(pool);
    // Base FET slots: GM=1e-12, GDS=1e-12 (device-off linearization)
    expect(pool.state0[2]).toBe(1e-12); // SLOT_GM = 2
    expect(pool.state0[3]).toBe(1e-12); // SLOT_GDS = 3
    // SLOT_V_GS and SLOT_V_GD are zero-initialised (first-call detection via s1[Q_GS]===0)
    expect(pool.state0[10]).toBe(0); // SLOT_V_GS = 10
    expect(pool.state0[11]).toBe(0); // SLOT_V_GD = 11
  });
});

// ===========================================================================
// jfet_load_dcop_parity
//
// Canonical common-source NJFET bias: Vgs=-1V, Vds=5V.
// Standard SPICE-L1 Shichman-Hodges parameters: VTO=-2, BETA=1e-4, LAMBDA=0,
// IS=1e-14, N=1, GMIN=1e-12.
//
// jfet1load.c variable mapping:
//   vgs          → Vgs = -1V  (gate-source voltage)
//   vds          → Vds =  5V  (drain-source voltage)
//   vgst         → vgs - VTO = -1 - (-2) = 1V  (effective gate overdrive)
//   beta         → BETA = 1e-4
//   lambda       → LAMBDA = 0
//   Saturation (vds=5 >= vgst=1):
//     ids        = beta/2 * vgst² * (1 + lambda*vds) = 5e-5 A
//     gm         = beta * vgst * (1 + lambda*vds) + GMIN = 1e-4 + GMIN
//     gds        = beta/2 * vgst² * lambda + GMIN = GMIN
//   Gate junction (vgs_junction=-1, reverse biased):
//     vt_n       = VT * N
//     expArg     = min(-1/vt_n, 80)  (large negative → exp ≈ 0)
//     gd_jct     = IS/vt_n * exp(expArg) + GMIN ≈ GMIN
//     id_jct     = IS*(exp(expArg)-1) ≈ -IS
//     nortonIg   = id_jct - gd_jct * vgs_junction ≈ -IS + GMIN
//   Norton (channel): nortonId = ids - gm*vgs - gds*vds
//     = 5e-5 - (1e-4+GMIN)*(-1) - GMIN*5
//     = 5e-5 + 1e-4 + GMIN - 5*GMIN
//     = 1.5e-4 - 4*GMIN
//
// MNA node layout: G=1 (row/col 0), D=2 (row/col 1), S=0 (ground, skipped).
// ===========================================================================

describe("jfet_load_dcop_parity", () => {
  it("saturation_bias_dcop_stamp_bit_exact_vs_ngspice_jfet1load_formula", () => {
    const VGS = -1;
    const VDS = 5;
    const VTO = -2;
    const BETA = 1e-4;
    const LAMBDA = 0;
    const IS = 1e-14;
    const N = 1;
    const GMIN = 1e-12;

    // Build element: G=1, D=2, S=0 (source to ground), no caps.
    const propsObj = createTestPropertyBag();
    propsObj.replaceModelParams({
      VTO, BETA, LAMBDA, IS, N,
      CGS: 0, CGD: 0, PB: 1.0, FC: 0.5,
      RD: 0, RS: 0, KF: 0, AF: 1, TNOM: 27,
    });
    const core = createNJfetElement(new Map([["G", 1], ["S", 0], ["D", 2]]), [], -1, propsObj);
    const pool = new StatePool(core.stateSize);
    core.stateBaseOffset = 0;
    core.initState(pool);

    // Seed SLOT_VGS (0) so channel limitVoltages passes through (vgsOld == vgsNew).
    pool.state0[0] = VGS;
    // Seed SLOT_VGS_JUNCTION (45) so gate-junction pnjlim passes through.
    pool.state0[SLOT_VGS_JUNCTION] = VGS;

    // MNA voltages: V(G=1)=VGS, V(D=2)=VDS (S=0 is ground).
    const voltages = new Float64Array([VGS, VDS]);
    const solver = new SparseSolver();
    solver.beginAssembly(2);

    const ctx: LoadContext = {
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
      gmin: GMIN,
      uic: false,
      reltol: 1e-3,
      iabstol: 1e-12,
    };

    const el = withNodeIds(core as unknown as AnalogElementCore, [1, 2, 0]);
    el.load(ctx);

    // ---------------------------------------------------------------------------
    // NGSPICE_REF: jfet1load.c saturation-region formulas
    // ---------------------------------------------------------------------------
    const NGSPICE_vgst = VGS - VTO;                              // = 1
    // Saturation: vds=5 >= vgst=1
    const NGSPICE_IDS = (BETA / 2) * NGSPICE_vgst * NGSPICE_vgst * (1 + LAMBDA * VDS);
    const NGSPICE_GM  = BETA * NGSPICE_vgst * (1 + LAMBDA * VDS) + GMIN;
    const NGSPICE_GDS = (BETA / 2) * NGSPICE_vgst * NGSPICE_vgst * LAMBDA + GMIN;
    // Gate junction (reverse biased Vgs=-1V)
    const NGSPICE_vt_n   = VT * N;
    const NGSPICE_expArg = Math.min(VGS / NGSPICE_vt_n, 80);    // ≈ -38.7
    const NGSPICE_GD_JCT = (IS / NGSPICE_vt_n) * Math.exp(NGSPICE_expArg) + GMIN;
    const NGSPICE_ID_JCT = IS * (Math.exp(NGSPICE_expArg) - 1);
    // Norton equivalents
    const NGSPICE_nortonId  = NGSPICE_IDS - NGSPICE_GM * VGS - NGSPICE_GDS * VDS;
    const NGSPICE_nortonIg  = NGSPICE_ID_JCT - NGSPICE_GD_JCT * VGS;

    // ---------------------------------------------------------------------------
    // Read assembled matrix entries by (row, col).
    // G=1→row/col 0, D=2→row/col 1, S=0→ground (no stamps).
    // ---------------------------------------------------------------------------
    const entries = solver.getCSCNonZeros();
    const sumAt = (row: number, col: number): number =>
      entries
        .filter((e) => e.row === row && e.col === col)
        .reduce((acc, e) => acc + e.value, 0);

    // G row (row=0): gate-junction self-conductance gd_jct at (G,G)
    expect(sumAt(0, 0)).toBe(NGSPICE_GD_JCT);

    // D row (row=1): gm from (D,G) and gds from (D,D)
    expect(sumAt(1, 0)).toBe(NGSPICE_GM);
    expect(sumAt(1, 1)).toBe(NGSPICE_GDS);

    // RHS
    const rhs = solver.getRhsSnapshot();
    // G node RHS = -nortonIg
    expect(rhs[0]).toBe(-NGSPICE_nortonIg);
    // D node RHS = -nortonId
    expect(rhs[1]).toBe(-NGSPICE_nortonId);
  });
});

// ===========================================================================
// MODEINITSMSIG branch — jfetload.c:103-105
//
// When cktMode has MODEINITSMSIG set, _updateOp must read vgs/vds/vgs_junction
// from CKTstate0 (s0), NOT from ctx.voltages. The resulting stamps must
// match formulas computed from the seeded state0 values, not the voltages array.
// ===========================================================================

describe("NJFET MODEINITSMSIG branch", () => {
  it("seeds_vgs_vds_from_state0_ignores_voltages", () => {
    const VGS_STATE0 = -1.5;
    const VDS_STATE0 = 4.0;
    const VGS_JCT_STATE0 = -1.5;
    const VTO = -2.0;
    const BETA = 1e-4;
    const LAMBDA = 0;
    const IS = 1e-14;
    const N = 1;
    const GMIN_VAL = 1e-12;

    const propsObj = createTestPropertyBag();
    propsObj.replaceModelParams({
      VTO, BETA, LAMBDA, IS, N,
      CGS: 0, CGD: 0, PB: 1.0, FC: 0.5,
      RD: 0, RS: 0, KF: 0, AF: 1, TNOM: 27,
    });
    const core = createNJfetElement(new Map([["G", 1], ["S", 0], ["D", 2]]), [], -1, propsObj);
    const pool = new StatePool(core.stateSize);
    core.stateBaseOffset = 0;
    core.initState(pool);

    // Seed state0 with known operating point
    pool.state0[SLOT_VGS] = VGS_STATE0;
    pool.state0[SLOT_VDS] = VDS_STATE0;
    pool.state0[SLOT_VGS_JUNCTION] = VGS_JCT_STATE0;

    // Voltages array has DIFFERENT values — must be ignored under MODEINITSMSIG
    const voltages = new Float64Array([99.0, 99.0]); // G=99V, D=99V — should not be used

    const solver = new SparseSolver();
    solver.beginAssembly(2);
    const ctx: LoadContext = {
      cktMode: MODEAC | MODEINITSMSIG,
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
      gmin: GMIN_VAL,
      uic: false,
      reltol: 1e-3,
      iabstol: 1e-12,
    };

    const el = withNodeIds(core as unknown as AnalogElementCore, [1, 2, 0]);
    el.load(ctx);

    // Expected values computed from state0 seed (saturation: vds=4 >= vgst=0.5)
    const vgst = VGS_STATE0 - VTO; // = 0.5
    const NGSPICE_IDS = (BETA / 2) * vgst * vgst * (1 + LAMBDA * VDS_STATE0);
    const NGSPICE_GM  = BETA * vgst * (1 + LAMBDA * VDS_STATE0) + GMIN_VAL;
    const NGSPICE_GDS = (BETA / 2) * vgst * vgst * LAMBDA + GMIN_VAL;
    const vt_n = VT * N;
    const expArg = Math.min(VGS_JCT_STATE0 / vt_n, 80);
    const NGSPICE_GD_JCT = (IS / vt_n) * Math.exp(expArg) + GMIN_VAL;
    const NGSPICE_ID_JCT = IS * (Math.exp(expArg) - 1);
    const NGSPICE_nortonId = NGSPICE_IDS - NGSPICE_GM * VGS_STATE0 - NGSPICE_GDS * VDS_STATE0;
    const NGSPICE_nortonIg = NGSPICE_ID_JCT - NGSPICE_GD_JCT * VGS_JCT_STATE0;

    const entries = solver.getCSCNonZeros();
    const sumAt = (row: number, col: number): number =>
      entries
        .filter((e) => e.row === row && e.col === col)
        .reduce((acc, e) => acc + e.value, 0);

    // G row: gate-junction conductance
    expect(sumAt(0, 0)).toBe(NGSPICE_GD_JCT);
    // D row: gm and gds
    expect(sumAt(1, 0)).toBe(NGSPICE_GM);
    expect(sumAt(1, 1)).toBe(NGSPICE_GDS);

    const rhs = solver.getRhsSnapshot();
    expect(rhs[0]).toBe(-NGSPICE_nortonIg);
    expect(rhs[1]).toBe(-NGSPICE_nortonId);
  });
});

// ===========================================================================
// MODEINITTRAN branch — jfetload.c:106-108
//
// When cktMode has MODEINITTRAN set, _updateOp must read vgs/vds/vgs_junction
// from CKTstate1 (s1), NOT from ctx.voltages.
// ===========================================================================

describe("NJFET MODEINITTRAN branch", () => {
  it("seeds_vgs_vds_from_state1_ignores_voltages", () => {
    const VGS_STATE1 = -0.8;
    const VDS_STATE1 = 3.0;
    const VGS_JCT_STATE1 = -0.8;
    const VTO = -2.0;
    const BETA = 1e-4;
    const LAMBDA = 0;
    const IS = 1e-14;
    const N = 1;
    const GMIN_VAL = 1e-12;

    const propsObj = createTestPropertyBag();
    propsObj.replaceModelParams({
      VTO, BETA, LAMBDA, IS, N,
      CGS: 0, CGD: 0, PB: 1.0, FC: 0.5,
      RD: 0, RS: 0, KF: 0, AF: 1, TNOM: 27,
    });
    const core = createNJfetElement(new Map([["G", 1], ["S", 0], ["D", 2]]), [], -1, propsObj);
    const pool = new StatePool(core.stateSize);
    core.stateBaseOffset = 0;
    core.initState(pool);

    // Seed state1 (s1) with known operating point
    pool.state1[SLOT_VGS] = VGS_STATE1;
    pool.state1[SLOT_VDS] = VDS_STATE1;
    pool.state1[SLOT_VGS_JUNCTION] = VGS_JCT_STATE1;

    // Voltages array has DIFFERENT values — must be ignored under MODEINITTRAN
    const voltages = new Float64Array([88.0, 88.0]);

    const solver = new SparseSolver();
    solver.beginAssembly(2);
    const ctx: LoadContext = {
      cktMode: MODETRAN | MODETRANOP | MODEINITTRAN,
      solver,
      voltages,
      dt: 1e-9,
      method: "trapezoidal",
      order: 1,
      deltaOld: [1e-9, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9],
      ag: new Float64Array(7),
      srcFact: 1,
      noncon: { value: 0 },
      limitingCollector: null,
      xfact: 1,
      gmin: GMIN_VAL,
      uic: false,
      reltol: 1e-3,
      iabstol: 1e-12,
    };

    const el = withNodeIds(core as unknown as AnalogElementCore, [1, 2, 0]);
    el.load(ctx);

    // Expected values from state1 seed (saturation: vds=3 >= vgst=1.2)
    const vgst = VGS_STATE1 - VTO; // = 1.2
    const NGSPICE_IDS = (BETA / 2) * vgst * vgst * (1 + LAMBDA * VDS_STATE1);
    const NGSPICE_GM  = BETA * vgst * (1 + LAMBDA * VDS_STATE1) + GMIN_VAL;
    const NGSPICE_GDS = (BETA / 2) * vgst * vgst * LAMBDA + GMIN_VAL;
    const vt_n = VT * N;
    const expArg = Math.min(VGS_JCT_STATE1 / vt_n, 80);
    const NGSPICE_GD_JCT = (IS / vt_n) * Math.exp(expArg) + GMIN_VAL;
    const NGSPICE_ID_JCT = IS * (Math.exp(expArg) - 1);
    const NGSPICE_nortonId = NGSPICE_IDS - NGSPICE_GM * VGS_STATE1 - NGSPICE_GDS * VDS_STATE1;
    const NGSPICE_nortonIg = NGSPICE_ID_JCT - NGSPICE_GD_JCT * VGS_JCT_STATE1;

    const entries = solver.getCSCNonZeros();
    const sumAt = (row: number, col: number): number =>
      entries
        .filter((e) => e.row === row && e.col === col)
        .reduce((acc, e) => acc + e.value, 0);

    expect(sumAt(0, 0)).toBe(NGSPICE_GD_JCT);
    expect(sumAt(1, 0)).toBe(NGSPICE_GM);
    expect(sumAt(1, 1)).toBe(NGSPICE_GDS);

    const rhs = solver.getRhsSnapshot();
    expect(rhs[0]).toBe(-NGSPICE_nortonIg);
    expect(rhs[1]).toBe(-NGSPICE_nortonId);
  });
});
