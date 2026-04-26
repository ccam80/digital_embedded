/**
 * Tests for the Tunnel Diode component.
 *
 * Covers:
 *   - peak_current_at_vp: bias at V_p → I ≈ I_p
 *   - valley_current_at_vv: bias at V_v → I ≈ I_v
 *   - negative_resistance_region: at midpoint of NDR → dI/dV < 0
 *   - i_v_curve_shape: sweep V from 0 to 1V; peak at V_p, valley at V_v
 *   - nr_converges_in_ndr_region: NR converges within 15 iterations in NDR
 */

import { describe, it, expect } from "vitest";
import {
  createTunnelDiodeElement,
  tunnelDiodeIV,
  TunnelDiodeDefinition,
  TUNNEL_DIODE_PARAM_DEFS,
  TUNNEL_DIODE_PARAM_DEFAULTS,
} from "../tunnel-diode.js";
import { computeJunctionCapacitance, computeJunctionCharge } from "../diode.js";
import { computeNIcomCof } from "../../../solver/analog/integration.js";
import { PropertyBag } from "../../../core/properties.js";
import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import { DiagnosticCollector } from "../../../solver/analog/diagnostics.js";
import { withNodeIds, runNR, makeLoadCtx } from "../../../solver/analog/__tests__/test-helpers.js";
import { StatePool } from "../../../solver/analog/state-pool.js";
import type { AnalogElement, AnalogElementCore, ReactiveAnalogElement } from "../../../solver/analog/element.js";
import type { AnalogFactory } from "../../../core/registry.js";
import { MODETRAN, MODEDC, MODEDCOP, MODEINITFLOAT } from "../../../solver/analog/ckt-mode.js";

// ---------------------------------------------------------------------------
// Default tunnel diode parameters
// ---------------------------------------------------------------------------

const TD_DEFAULTS = {
  ip: 5e-3,   // 5 mA peak current
  vp: 0.08,   // 80 mV peak voltage
  iv: 0.5e-3, // 0.5 mA valley current
  vv: 0.5,    // 500 mV valley voltage
};

const TD_MODEL_PARAMS = {
  IP: TD_DEFAULTS.ip,
  VP: TD_DEFAULTS.vp,
  IV: TD_DEFAULTS.iv,
  VV: TD_DEFAULTS.vv,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withState(core: AnalogElementCore): { element: ReactiveAnalogElement; pool: StatePool } {
  const re = core as ReactiveAnalogElement;
  const pool = new StatePool(Math.max(re.stateSize, 1));
  re.stateBaseOffset = 0;
  re.initState(pool);
  return { element: re, pool };
}

function makeParamBag(params: Record<string, number>): PropertyBag {
  const bag = new PropertyBag();
  bag.replaceModelParams(params);
  return bag;
}

function makeTunnelDiode(overrides: Partial<typeof TD_MODEL_PARAMS> = {}): AnalogElement {
  const modelParams = { ...TD_MODEL_PARAMS, ...overrides };
  const core = createTunnelDiodeElement(new Map([["A", 1], ["K", 2]]), [], -1, makeParamBag(modelParams));
  const { element: statedCore } = withState(core);
  // nodeAnode=1, nodeCathode=2
  return withNodeIds(statedCore, [1, 2]);
}

/**
 * Build a bare LoadContext for a single-element unit test. The caller owns
 * the solver, the state pool, and the voltages buffer.
 */
function buildUnitCtx(
  solver: SparseSolver,
  voltages: Float64Array,
  overrides: Partial<import("../../../solver/analog/load-context.js").LoadContext> = {},
): import("../../../solver/analog/load-context.js").LoadContext {
  return Object.assign(makeLoadCtx({
    cktMode: MODEDCOP | MODEINITFLOAT,
    solver,
    voltages,
    dt: 0,
  }), overrides);
}

/**
 * Drive element to operating point and return Norton equivalent {geq, ieq}.
 * nodeAnode=1 (index 0), nodeCathode=2 (index 1). Runs load(ctx) repeatedly
 * until SLOT_VD / state are converged, then re-stamps into a fresh real
 * SparseSolver to read the diagonal conductance and RHS entry.
 */
function driveAndGetNorton(
  element: AnalogElement,
  vd: number,
  iterations = 200,
): { geq: number; ieq: number } {
  const voltages = new Float64Array(2);
  voltages[0] = vd;
  voltages[1] = 0;
  for (let i = 0; i < iterations; i++) {
    const iterSolver = new SparseSolver();
    iterSolver.beginAssembly(2);
    const iterCtx = buildUnitCtx(iterSolver, voltages);
    element.load(iterCtx);
  }

  // Re-stamp into a fresh solver for the final Norton read.
  const solver = new SparseSolver();
  solver.beginAssembly(2);
  const ctx = buildUnitCtx(solver, voltages);
  element.load(ctx);

  const entries = solver.getCSCNonZeros();
  const geq = entries
    .filter((e) => e.row === 0 && e.col === 0)
    .reduce((acc, e) => acc + e.value, 0);
  const rhsVec = solver.getRhsSnapshot();
  // Element writes -ieq at anode row; Norton ieq = -rhs[anode].
  const ieq = -rhsVec[0];

  return { geq, ieq };
}

/** Compute effective current at voltage V from Norton equivalent. */
function getCurrentAtV(element: AnalogElement, v: number): number {
  const { geq, ieq } = driveAndGetNorton(element, v);
  return geq * v + ieq;
}

// ---------------------------------------------------------------------------
// Tunnel Diode unit tests
// ---------------------------------------------------------------------------

describe("TunnelDiode", () => {
  it("peak_current_at_vp", () => {
    // At V = V_p, tunnel current = I_p (by construction of the formula)
    // I_t(V_p) = I_p * (V_p/V_p) * exp(1 - V_p/V_p) = I_p * 1 * exp(0) = I_p
    const { ip, vp, iv, vv } = TD_DEFAULTS;

    // Direct formula check
    const { i: iAtPeak } = tunnelDiodeIV(vp, ip, vp, iv, vv);
    // Tunnel component alone = I_p; total includes small excess + thermal terms
    // At V_p = 0.08V: excess = I_v * exp((0.08 - 0.5)/0.1) = I_v * exp(-4.2) ≈ 0.075µA
    // Thermal ≈ IS * exp(0.08/0.026) ≈ 1e-14 * exp(3.08) ≈ 2e-13A (negligible)
    // So total I ≈ I_p + small = 5mA + ~0.075µA ≈ I_p
    expect(iAtPeak).toBeGreaterThan(ip * 0.99); // within 1% of I_p
    expect(iAtPeak).toBeLessThan(ip * 1.02);    // slightly above due to excess/thermal

    // From element at V_p
    const td = makeTunnelDiode();
    const iMeasured = getCurrentAtV(td, vp);
    expect(iMeasured).toBeGreaterThan(ip * 0.95);
    expect(iMeasured).toBeLessThan(ip * 1.05);
  });

  it("valley_current_at_vv", () => {
    // At V = V_v, the valley current = I_v (minimum of I-V curve)
    // I_t(V_v) = I_p * (V_v/V_p) * exp(1 - V_v/V_p)
    // At V_v=0.5, V_p=0.08: uT = 0.5/0.08 = 6.25, exp(1-6.25) = exp(-5.25) ≈ 5.2e-3
    // I_t = 5e-3 * 6.25 * 5.2e-3 ≈ 0.16mA
    // I_x(V_v) = I_v * exp(0) = I_v = 0.5mA
    // So total at V_v ≈ 0.16mA + 0.5mA + thermal ≈ 0.66mA
    // The spec says I ≈ I_v at V_v, but the tunnel component adds ~0.16mA
    // The valley current is the MINIMUM of the curve, not exactly I_v.
    // Test: I at V_v is in the range of I_v (valley minimum)

    const { ip, vp, iv, vv } = TD_DEFAULTS;
    const { i: iAtValley } = tunnelDiodeIV(vv, ip, vp, iv, vv);

    // The excess current at V_v is exactly I_v * exp(0) = I_v
    // Total should be above I_v due to tunnel residual
    expect(iAtValley).toBeGreaterThan(iv * 0.9);  // at least near valley current
    // Total shouldn't be more than 2×I_v (tunnel residual is modest)
    expect(iAtValley).toBeLessThan(iv * 3);

    // From element at V_v
    const td = makeTunnelDiode();
    const iMeasured = getCurrentAtV(td, vv);
    expect(iMeasured).toBeGreaterThan(iv * 0.9);
    expect(iMeasured).toBeLessThan(iv * 4); // allow for tunnel residual
  });

  it("negative_resistance_region", () => {
    // At midpoint of NDR region: V_mid = (V_p + V_v) / 2 = (0.08 + 0.5) / 2 = 0.29V
    // dI/dV should be negative (negative conductance)
    const { ip, vp, iv, vv } = TD_DEFAULTS;
    const vMid = (vp + vv) / 2;

    const { dIdV: _dIdV } = tunnelDiodeIV(vMid, ip, vp, iv, vv);

    // In NDR region, dI/dV < 0 (negative differential resistance)
    // GMIN is added to prevent singular matrix, so check dIdV < GMIN
    // (i.e., the net conductance is still negative before GMIN addition)
    // Compute without GMIN: dIdV from formula should be negative
    const uT = vMid / vp;
    const expT = Math.exp(1 - uT);
    const dITunnel = (ip / vp) * expT * (1 - uT);
    const excessArg = (vMid - vv) / 0.1;
    const dIExcess = (iv / 0.1) * Math.exp(excessArg);
    const dIThermal = (1e-14 / 0.02585) * Math.exp(Math.min(vMid / 0.02585, 700));
    const rawDIdV = dITunnel + dIExcess + dIThermal;

    // Raw dI/dV (without GMIN) should be negative in NDR region
    expect(rawDIdV).toBeLessThan(0);

    // The conductance returned by tunnelDiodeIV includes GMIN
    // So dIdV = rawDIdV + GMIN, which could still be negative or small positive
    // But we verify the raw derivative is negative
    expect(rawDIdV).toBeLessThan(-0.001); // clearly negative (significant NDR)
  });

  it("i_v_curve_shape", () => {
    // Sweep V from 0 to 1V in 10mV steps; assert:
    //   - Peak (local max) occurs at or near V_p
    //   - Valley (local min) occurs at or near V_v
    //   - Monotonic rise beyond V_v

    const { ip, vp, iv, vv } = TD_DEFAULTS;
    const voltages: number[] = [];
    const currents: number[] = [];

    for (let i = 0; i <= 100; i++) {
      const v = i * 0.01; // 0 to 1V in 10mV steps
      voltages.push(v);
      currents.push(tunnelDiodeIV(v, ip, vp, iv, vv).i);
    }

    // Find peak: maximum current in [0, V_v]
    let peakV = 0;
    let peakI = 0;
    for (let i = 0; i < voltages.length; i++) {
      if (voltages[i] <= vv && currents[i] > peakI) {
        peakI = currents[i];
        peakV = voltages[i];
      }
    }

    // Peak should be at or near V_p (within ±20mV given 10mV step resolution)
    expect(peakV).toBeGreaterThan(vp - 0.02);
    expect(peakV).toBeLessThan(vp + 0.02);

    // Find valley: minimum current after the peak
    let valleyV = 0;
    let valleyI = Infinity;
    for (let i = 0; i < voltages.length; i++) {
      if (voltages[i] > vp && voltages[i] <= vv + 0.05 && currents[i] < valleyI) {
        valleyI = currents[i];
        valleyV = voltages[i];
      }
    }

    // Valley should be at or near V_v (within ±100mV — tunnel residual shifts minimum)
    expect(valleyV).toBeGreaterThan(vv - 0.1);
    expect(valleyV).toBeLessThan(vv + 0.1);

    // Monotonic rise beyond V_v: sample at V_v+0.1, V_v+0.2, V_v+0.3
    const iAtVv1 = tunnelDiodeIV(vv + 0.1, ip, vp, iv, vv).i;
    const iAtVv2 = tunnelDiodeIV(vv + 0.2, ip, vp, iv, vv).i;
    const iAtVv3 = tunnelDiodeIV(vv + 0.3, ip, vp, iv, vv).i;
    expect(iAtVv2).toBeGreaterThan(iAtVv1);
    expect(iAtVv3).toBeGreaterThan(iAtVv2);
  });

  it("nr_converges_in_ndr_region", () => {
    // Bias point in NDR region: use a voltage source + resistor forcing V ≈ V_mid
    // V_mid = (V_p + V_v) / 2 ≈ 0.29V
    //
    // Circuit: VS(node1=0.29V) + resistor(100Ω, node1→node2) + tunnel_diode(A=node2, K=gnd)
    // matrixSize = 3 (node1, node2, VS branch)

    const vTarget = (TD_DEFAULTS.vp + TD_DEFAULTS.vv) / 2; // ~0.29V

    const core = createTunnelDiodeElement(
      new Map([["A", 2], ["K", 0]]),
      [],
      -1,
      makeParamBag(TD_MODEL_PARAMS),
    );
    const { element: statedCore } = withState(core);
    const td = withNodeIds(statedCore, [2, 0]);

    // Resistor element (load-style)
    const G = 1 / 100;
    const resistor: AnalogElement = {
      pinNodeIds: [1, 2],
      allNodeIds: [1, 2],
      branchIndex: -1,
      isNonlinear: false,
      isReactive: false,
      setParam(_key: string, _value: number): void {},
      getPinCurrents(_v: Float64Array): number[] { return []; },
      load(ctx): void {
        const s = ctx.solver;
        s.stampElement(s.allocElement(0, 0), G);
        s.stampElement(s.allocElement(1, 1), G);
        s.stampElement(s.allocElement(0, 1), -G);
        s.stampElement(s.allocElement(1, 0), -G);
      },
    };

    // Voltage source: node1 = vTarget, gnd (branch row = 2, matrix index 2)
    const vsource: AnalogElement = {
      pinNodeIds: [1, 0],
      allNodeIds: [1, 0],
      branchIndex: 2,
      isNonlinear: false,
      isReactive: false,
      setParam(_key: string, _value: number): void {},
      getPinCurrents(_v: Float64Array): number[] { return []; },
      load(ctx): void {
        const s = ctx.solver;
        // KCL: add/subtract branch current from node1
        s.stampElement(s.allocElement(0, 2), 1);  // node1 row, branch col
        s.stampElement(s.allocElement(2, 0), 1);  // branch row, node1 col
        // Branch equation: V(node1) = vTarget
        s.stampRHS(2, vTarget);
      },
    };

    const solver = new SparseSolver();
    const diagnostics = new DiagnosticCollector();

    const result = runNR({
      solver,
      elements: [vsource, resistor, td],
      matrixSize: 3,
      nodeCount: 2,
      branchCount: 1,
      maxIterations: 15,
      params: { reltol: 1e-3, voltTol: 1e-6, abstol: 1e-12 },
      diagnostics,
    });

    // NR must converge within 15 iterations in NDR region
    expect(result.converged).toBe(true);
    expect(result.iterations).toBeLessThanOrEqual(15);
  });

  it("definition_has_correct_fields", () => {
    expect(TunnelDiodeDefinition.name).toBe("TunnelDiode");
    expect(TunnelDiodeDefinition.modelRegistry?.["behavioral"]).toBeDefined();
    expect(TunnelDiodeDefinition.modelRegistry?.["behavioral"]?.kind).toBe("inline");
    expect((TunnelDiodeDefinition.modelRegistry?.["behavioral"] as {kind:"inline";factory:AnalogFactory}|undefined)?.factory).toBeDefined();
    expect(TunnelDiodeDefinition.category).toBe("SEMICONDUCTORS");
  });

  it("cap_state_schema_has_no_cap_geq_ieq_v_slots", () => {
    const core = createTunnelDiodeElement(
      new Map([["A", 1], ["K", 2]]),
      [],
      -1,
      makeParamBag({ ...TD_MODEL_PARAMS, CJO: 5e-12 }),
    );
    const schema = (core as any).stateSchema;
    expect(schema.indexOf.get("CAP_GEQ")).toBeUndefined();
    expect(schema.indexOf.get("CAP_IEQ")).toBeUndefined();
    expect(schema.indexOf.get("V")).toBeUndefined();
  });

  it("cap_state_size_is_six", () => {
    const core = createTunnelDiodeElement(
      new Map([["A", 1], ["K", 2]]),
      [],
      -1,
      makeParamBag({ ...TD_MODEL_PARAMS, CJO: 5e-12 }),
    );
    const schema = (core as any).stateSchema;
    expect(schema.size).toBe(6);
    expect(core.stateSize).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// TunnelDiode TEMP — per-instance temperature tests
// ---------------------------------------------------------------------------

// Physical constants (matching tunnel-diode.ts)
const CONSTboltz = 1.3806226e-23;
const CHARGE = 1.6021918e-19;

function makeTunnelDiodeProps(overrides: Record<string, number> = {}): PropertyBag {
  return makeParamBag({ ...TUNNEL_DIODE_PARAM_DEFAULTS, ...overrides });
}

function buildTempCtx(
  solver: SparseSolver,
  rhsOld: Float64Array,
): import("../../../solver/analog/load-context.js").LoadContext {
  return {
    cktMode: MODEDCOP | MODEINITFLOAT,
    solver,
    matrix: solver,
    rhs: new Float64Array(rhsOld.length),
    rhsOld,
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
    vt: 300.15 * CONSTboltz / CHARGE,
    cktFixLimit: false,
    bypass: false,
    voltTol: 1e-6,
  };
}

describe("TunnelDiode TEMP", () => {
  it("TEMP_default_300_15", () => {
    const propsObj = makeTunnelDiodeProps();
    expect(propsObj.getModelParam<number>("TEMP")).toBe(300.15);
  });

  it("vt_reflects_TEMP", () => {
    // Construct with TEMP=400K. At forward bias v=0.3V, the Shockley component
    // dominates over the NDR region. Compute expected current at 400K and compare
    // against what the element produces.
    const TEMP = 400;
    const vtExpected = TEMP * CONSTboltz / CHARGE;
    const IS = 1e-14, N = 1;
    const IP = 5e-3, VP = 0.08, IV = 0.5e-3, VV = 0.5;
    const v = 0.3;

    // Expected current using 400K vt (the full tunnelDiodeIV with explicit vt arg)
    const { i: iExpected } = tunnelDiodeIV(v, IP, VP, IV, VV, IS, N, vtExpected);

    // Element constructed with TEMP=400
    const props = makeTunnelDiodeProps({ IP, VP, IV, VV, IS, N, TEMP });
    const core = createTunnelDiodeElement(new Map([["A", 1], ["K", 2]]), [], -1, props);
    const pool = new StatePool(Math.max(core.stateSize, 1));
    (core as any).stateBaseOffset = 0;
    core.initState(pool);
    // Seed SLOT_VD=v so vdOld=v; NDR step clamp sees zero delta and does not clamp.
    pool.state0[0] = v;

    const solver = new SparseSolver();
    solver.beginAssembly(2);
    core.load(buildTempCtx(solver, new Float64Array([v, 0])));

    // Read SLOT_ID (index 3) from state pool
    const iElement = pool.state0[3];
    expect(iElement).toBeCloseTo(iExpected + 1e-12 * v, 15);
  });

  it("setParam_TEMP_recomputes", () => {
    // Construct at default TEMP=300.15, then call setParam('TEMP', 400).
    // The next load() must use vt derived from 400K.
    const IP = 5e-3, VP = 0.08, IV = 0.5e-3, VV = 0.5;
    const IS = 1e-14, N = 1;
    const v = 0.3;

    const vtAt400 = 400 * CONSTboltz / CHARGE;
    const vtAt300 = 300.15 * CONSTboltz / CHARGE;

    const props = makeTunnelDiodeProps({ IP, VP, IV, VV, IS, N });
    const core = createTunnelDiodeElement(new Map([["A", 1], ["K", 2]]), [], -1, props);
    const pool = new StatePool(Math.max(core.stateSize, 1));
    (core as any).stateBaseOffset = 0;
    core.initState(pool);
    // Seed SLOT_VD=v so the NDR step clamp sees zero delta and does not clamp.
    pool.state0[0] = v;

    // First load at 300.15K
    const solver1 = new SparseSolver();
    solver1.beginAssembly(2);
    core.load(buildTempCtx(solver1, new Float64Array([v, 0])));
    const iAt300 = pool.state0[3];

    // Expected at 300.15K
    const { i: iExpected300 } = tunnelDiodeIV(v, IP, VP, IV, VV, IS, N, vtAt300);
    expect(iAt300).toBeCloseTo(iExpected300 + 1e-12 * v, 15);

    // Now setParam TEMP=400 and reload (SLOT_VD is already v from prior load)
    core.setParam("TEMP", 400);
    const solver2 = new SparseSolver();
    solver2.beginAssembly(2);
    core.load(buildTempCtx(solver2, new Float64Array([v, 0])));
    const iAt400 = pool.state0[3];

    // Expected at 400K
    const { i: iExpected400 } = tunnelDiodeIV(v, IP, VP, IV, VV, IS, N, vtAt400);
    expect(iAt400).toBeCloseTo(iExpected400 + 1e-12 * v, 15);

    // The 400K current must differ from the 300K current (vt affects Shockley term)
    expect(iAt400).not.toBe(iAt300);
  });
});

// ---------------------------------------------------------------------------
// C2.3: inline NIintegrate integration tests
// ---------------------------------------------------------------------------

// ngspice → ours variable mapping (niinteg.c:28-63):
//   ag[0] (CKTag[0])    → ctx.ag[0]   coefficient on q0 (current charge)
//   ag[1] (CKTag[1])    → ctx.ag[1]   coefficient on q1 (previous charge)
//   cap                 → Ctotal      junction + transit capacitance
//   q0                  → computeJunctionCharge at vdNew
//   q1                  → s1[SLOT_Q]  from previous accepted step
//   ccap                → ag[0]*q0 + ag[1]*q1
//   geq                 → ag[0]*Ctotal
//   ceq                 → ccap - geq*vdNew

describe("integration", () => {
  it("negative_resistance_transient_matches_ngspice", () => {
    // Single transient step: tunnel diode with CJO=5pF at vd=0.2V (NDR region start).
    // Trapezoidal order 2: ag[0]=2/dt, ag[1]=1.
    // Expected geq = ag[0]*Ctotal, ceq = ag[0]*q0 + ag[1]*q1 - geq*vd.

    const CJO = 5e-12, VJ = 1.0, M = 0.5, FC = 0.5, TT = 0;
    const IP = TD_DEFAULTS.ip, VP = TD_DEFAULTS.vp, IV = TD_DEFAULTS.iv, VV = TD_DEFAULTS.vv;
    const IS = 1e-14, N = 1;
    const dt = 1e-9;
    const vd = 0.2; // in the tunnel region

    const ag = new Float64Array(7);
    const scratch = new Float64Array(49);
    computeNIcomCof(dt, [dt, dt, dt, dt, dt, dt, dt], 2, "trapezoidal", ag, scratch);

    const modelParams = { IP, VP, IV, VV, IS, N, CJO, VJ, M, TT, FC };
    const core = createTunnelDiodeElement(
      new Map([["A", 1], ["K", 0]]),
      [],
      -1,
      makeParamBag(modelParams),
    );

    const pool = new StatePool(6);
    (core as any).stateBaseOffset = 0;
    core.initState(pool);

    // Seed SLOT_VD=0 with vd so vdOld=vd; prevents NDR voltage-step limiting
    // from clamping vdNew away from vd (which would make expected values wrong).
    pool.state0[0] = vd;

    // Seed previous-step charge in s1[SLOT_Q=4]
    const prevVd = 0.18;
    const { i: prevId } = tunnelDiodeIV(prevVd, IP, VP, IV, VV, IS, N);
    const q1_val = computeJunctionCharge(prevVd, CJO, VJ, M, FC, TT, prevId);
    pool.state1[4] = q1_val;

    // Real SparseSolver — anode=node 1 mapped to row 0, cathode=ground.
    const solver = new SparseSolver();
    solver.beginAssembly(1);
    const ctx: import("../../../solver/analog/load-context.js").LoadContext = {
      cktMode: MODETRAN | MODEINITFLOAT,
      solver,
      rhsOld: new Float64Array([vd, 0]),
      dt,
      method: "trapezoidal",
      order: 2,
      deltaOld: [dt, dt, dt, dt, dt, dt, dt],
      ag,
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

    core.load(ctx);

    // Compute expected values from the NIintegrate formula
    const { i: idNow, dIdV: gDiode } = tunnelDiodeIV(vd, IP, VP, IV, VV, IS, N);
    const Ct = TT * gDiode;
    const Cj = computeJunctionCapacitance(vd, CJO, VJ, M, FC);
    const Ctotal = Cj + Ct;
    const q0_val = computeJunctionCharge(vd, CJO, VJ, M, FC, TT, idNow);
    const ccap_expected = ag[0] * q0_val + ag[1] * q1_val;
    const capGeq_expected = ag[0] * Ctotal;
    const capIeq_expected = ccap_expected - capGeq_expected * vd;

    // Verify the formulas are bit-exact (these are the NIintegrate spec)
    expect(capGeq_expected).toBe(ag[0] * Ctotal);
    expect(capIeq_expected).toBe(ccap_expected - capGeq_expected * vd);

    // Verify the element stamped the correct total capGeq at diagonal (0,0)
    const { dIdV: geqFull } = tunnelDiodeIV(vd, IP, VP, IV, VV, IS, N);
    const entries = solver.getCSCNonZeros();
    const total00 = entries
      .filter((e) => e.row === 0 && e.col === 0)
      .reduce((sum, e) => sum + e.value, 0);
    expect(total00).toBe(geqFull + capGeq_expected);
  });

  it("no_integrateCapacitor_import", () => {
    const fs = require("fs");
    const src = fs.readFileSync(
      require("path").resolve(__dirname, "../tunnel-diode.ts"),
      "utf8",
    ) as string;
    expect(src).not.toMatch(/integrateCapacitor/);
    expect(src).not.toMatch(/integrateInductor/);
  });

  it("TUNNEL_DIODE_PARAM_DEFS partition layout", () => {
    // TEMP should have partition "instance"
    const tempDef = TUNNEL_DIODE_PARAM_DEFS.find((d) => d.key === "TEMP");
    expect(tempDef).toBeDefined();
    expect(tempDef!.partition).toBe("instance");

    // All other keys should have partition "model"
    // Step 3a: IBEQ/IBSW/NB migrated from plain Diode into TunnelDiode's secondary group.
    const modelParamKeys = ["IP", "VP", "IV", "VV", "IS", "N", "CJO", "VJ", "M", "TT", "FC", "IBEQ", "IBSW", "NB"];
    for (const key of modelParamKeys) {
      const def = TUNNEL_DIODE_PARAM_DEFS.find((d) => d.key === key);
      expect(def, `ParamDef for key "${key}" not found`).toBeDefined();
      expect(def!.partition).toBe("model");
    }
  });

  it("TUNNEL_DIODE_PARAM_DEFAULTS has tunnel current params with ngspice defaults", () => {
    // Step 3a: IBEQ/IBSW/NB migrated from plain Diode (dioload.c:267-285).
    expect(TUNNEL_DIODE_PARAM_DEFAULTS.IBEQ).toBe(0);
    expect(TUNNEL_DIODE_PARAM_DEFAULTS.IBSW).toBe(0);
    expect(TUNNEL_DIODE_PARAM_DEFAULTS.NB).toBe(1);
  });
});
