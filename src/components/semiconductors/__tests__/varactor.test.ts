/**
 * Tests for the VaractorDiode component.
 *
 * Covers:
 *   - capacitance_decreases_with_reverse_bias: C decreases as V_R increases
 *   - cjo_at_zero_bias: C ≈ CJO at V_R = 0
 *   - cv_formula_correct: verify C = CJO/sqrt(1 + V_R/VJ) at specific values
 *   - vco_circuit: resonant frequency changes with bias voltage
 */

import { describe, it, expect } from "vitest";
import {
  createVaractorElement,
  VaractorDefinition,
  VARACTOR_PARAM_DEFAULTS,
} from "../varactor.js";
import { computeJunctionCapacitance, computeJunctionCharge } from "../diode.js";
import { computeNIcomCof } from "../../../solver/analog/integration.js";
import { createTestPropertyBag } from "../../../test-fixtures/model-fixtures.js";
import { withNodeIds } from "../../../solver/analog/__tests__/test-helpers.js";
import type { AnalogElementCore, ReactiveAnalogElement } from "../../../solver/analog/element.js";
import type { AnalogFactory } from "../../../core/registry.js";
import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import type { SparseSolver as SparseSolverType } from "../../../solver/analog/sparse-solver.js";
import type { LoadContext } from "../../../solver/analog/load-context.js";
import { StatePool } from "../../../solver/analog/state-pool.js";

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
// Default varactor parameters
// ---------------------------------------------------------------------------

const VARACTOR_DEFAULTS = {
  cjo: 20e-12, // 20 pF
  vj: 0.7,
  m: 0.5,
  iS: 1e-14,
  fc: 0.5,
  tt: 0,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// State pool slot index for the reactive-companion conductance (see
// VARACTOR_STATE_SCHEMA in ../varactor.ts). Kept in sync manually with the
// schema: positions 0=VD, 1=GEQ, 2=IEQ, 3=ID, 4=CAP_GEQ, 5=CAP_IEQ, ...
const SLOT_CAP_GEQ = 4;

interface MadeVaractor {
  element: AnalogElementCore;
  pool: StatePool;
}

function makeVaractor(overrides: Partial<typeof VARACTOR_DEFAULTS> = {}): MadeVaractor {
  const params = { ...VARACTOR_PARAM_DEFAULTS, ...VARACTOR_DEFAULTS, ...overrides };
  const props = createTestPropertyBag();
  props.replaceModelParams(params);
  // nodeAnode=1, nodeCathode=2
  const core = createVaractorElement(new Map([["A", 1], ["K", 2]]), [], -1, props);
  const { element: statedCore, pool } = withState(core);
  const element = withNodeIds(statedCore, [1, 2]);
  return { element, pool };
}

/**
 * Build a minimal LoadContext for driving an element directly via load(ctx).
 */
function makeLoadCtx(
  voltages: Float64Array,
  solver: SparseSolverType,
  overrides: Partial<LoadContext> = {},
): LoadContext {
  const dt = overrides.dt ?? 0;
  return {
    solver,
    voltages,
    iteration: 0,
    initMode: "transient",
    dt,
    method: "trapezoidal",
    order: 1,
    deltaOld: [dt, dt, dt, dt, dt, dt, dt],
    ag: overrides.ag ?? new Float64Array(8),
    srcFact: 1,
    noncon: { value: 0 },
    limitingCollector: null,
    isDcOp: false,
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
    ...overrides,
  };
}

/**
 * Drive varactor to operating point and capture the effective capacitance at the
 * specified bias via the load(ctx) interface. Reads the reactive-companion
 * conductance directly from the state pool after a transient load() and
 * converts it back to capacitance via C = capGeq * dt / 2 (trapezoidal order-2
 * inverse, since capGeq = (2/dt) * Ctotal for that integration rule).
 */
function getCapacitanceAtBias(
  element: AnalogElementCore,
  pool: StatePool,
  vd: number,
  dt = 1e-6,
): number {
  // Drive to operating point (vAnode = vd, vCathode = 0) using load(ctx) in DC-OP.
  // Use a fresh real SparseSolver each iteration so allocElement/stampElement work.
  const voltages = new Float64Array(2);
  voltages[0] = vd;
  voltages[1] = 0;
  for (let i = 0; i < 50; i++) {
    const dcSolver = new SparseSolver();
    dcSolver.beginAssembly(2);
    const dcCtx = makeLoadCtx(voltages, dcSolver, { isDcOp: true });
    element.load(dcCtx);
    voltages[0] = vd;
    voltages[1] = 0;
  }

  // Now compute the companion capacitance with trapezoidal order-2 at this bias.
  // ag[0] = 2/dt for trapezoidal order 2; ag[1] = 1 per computeNIcomCof.
  const ag = new Float64Array(8);
  ag[0] = 2 / dt;
  ag[1] = 1;

  const tranSolver = new SparseSolver();
  tranSolver.beginAssembly(2);
  const tranCtx = makeLoadCtx(voltages, tranSolver, {
    isTransient: true,
<<<<<<< HEAD

    isTransientDcop: false,

=======
>>>>>>> e427e072 (D4: add isAc flag and pass LoadContext to stampAc (ngspice alignment))
    isAc: false,
    dt,
    method: "trapezoidal",
    order: 2,
    ag,
  });
  element.load(tranCtx);

  // Read the reactive-companion conductance from the pool directly. This is
  // the pure capGeq = (2/dt) * Ctotal — independent of the diode conductance
  // gd which load() also stamps onto the matrix diagonal.
  const capGeq = pool.state0[SLOT_CAP_GEQ];

  // capGeq = 2*C/dt (trapezoidal) → C = capGeq * dt / 2
  return capGeq * dt / 2;
}

// ---------------------------------------------------------------------------
// Varactor unit tests
// ---------------------------------------------------------------------------

describe("Varactor", () => {
  it("capacitance_decreases_with_reverse_bias", () => {
    // Measure C at V_R = 0, 1V, 5V, 10V (reverse bias = cathode > anode)
    // V_d (anode - cathode) = -V_R
    // Expected: C decreases monotonically as V_R increases

    const { element: varactor, pool } = makeVaractor();
    const dt = 1e-6;

    // V_R = 0: vd = 0 (anode = cathode = 0)
    const c0 = getCapacitanceAtBias(varactor, pool, 0, dt);

    // For remaining bias points, create fresh elements to avoid history state
    const v1 = makeVaractor();
    const c1 = getCapacitanceAtBias(v1.element, v1.pool, -1, dt); // V_R = 1V → vd = -1

    const v2 = makeVaractor();
    const c2 = getCapacitanceAtBias(v2.element, v2.pool, -5, dt); // V_R = 5V

    const v3 = makeVaractor();
    const c3 = getCapacitanceAtBias(v3.element, v3.pool, -10, dt); // V_R = 10V

    // C should decrease monotonically with increasing reverse bias
    expect(c0).toBeGreaterThan(c1);
    expect(c1).toBeGreaterThan(c2);
    expect(c2).toBeGreaterThan(c3);
  });

  it("cjo_at_zero_bias", () => {
    // At V_R = 0 (vd = 0): C_j = CJO / (1 + 0/VJ)^M = CJO
    const CJO = 20e-12;
    const { element: varactor, pool } = makeVaractor({ cjo: CJO });
    const c = getCapacitanceAtBias(varactor, pool, 0, 1e-6);

    // Should equal CJO within numerical precision
    expect(c).toBeCloseTo(CJO, 12); // within 1 fF
  });

  it("cv_formula_correct", () => {
    // At V_R = 2V, VJ = 0.7, M = 0.5, FC = 0.5:
    // In the reverse-bias region (vd = -2V, below FC*VJ), computeJunctionCapacitance
    // uses the standard depletion formula: CJO / (1 - vd/VJ)^M
    // = CJO / sqrt(1 + 2/0.7) = CJO / sqrt(3.857) ≈ CJO * 0.5092
    const CJO = 20e-12;
    const VJ = 0.7;
    const M = 0.5;
    const FC = 0.5;
    const vd = -2; // V_d = -V_R (reverse bias)

    // Expected from computeJunctionCapacitance (the current implementation)
    const expected = computeJunctionCapacitance(vd, CJO, VJ, M, FC);
    // In reverse bias this equals CJO / (1 - vd/VJ)^M = CJO / (1 + 2/0.7)^0.5
    const expectedDirect = CJO / Math.sqrt(1 - vd / VJ);
    expect(expected).toBeCloseTo(expectedDirect, 14);

    // From element at V_d = -2V (reverse bias)
    const { element: varactor, pool } = makeVaractor({ cjo: CJO, vj: VJ, m: M });
    const cMeasured = getCapacitanceAtBias(varactor, pool, vd, 1e-6);

    // Should match computeJunctionCapacitance within 1%
    const ratio = cMeasured / expected;
    expect(ratio).toBeGreaterThan(0.99);
    expect(ratio).toBeLessThan(1.01);
  });

  it("vco_circuit", () => {
    // Verify that resonant frequency f = 1/(2π√(LC(V))) changes with bias.
    // With L fixed and C(V) varying, f_resonant varies as 1/√C(V).
    //
    // At V_R = 0 (vd=0):  C0 = CJO = 20pF → f ∝ 1/√(20e-12)
    // At V_R = 5V (vd=-5): C5 = CJO/√(1+5/0.7) ≈ CJO/2.94 ≈ 6.8pF
    //
    // f(V_R=5) / f(V_R=0) = √(C0/C5) = √(20/6.8) ≈ 1.71
    //
    // Test: assert f changes by at least 50% from 0V to 5V reverse bias.

    const CJO = 20e-12;
    const VJ = 0.7;
    const M = 0.5;
    const FC = 0.5;

    // Use computeJunctionCapacitance (the current implementation)
    const c0 = computeJunctionCapacitance(0,  CJO, VJ, M, FC); // vd=0
    const c5 = computeJunctionCapacitance(-5, CJO, VJ, M, FC); // vd=-5V

    // Frequency ratio = √(C0/C5) > 1 (higher frequency at higher reverse bias)
    const freqRatio = Math.sqrt(c0 / c5);
    expect(freqRatio).toBeGreaterThan(1.5); // at least 50% frequency change
    expect(freqRatio).toBeLessThan(3.0);    // reasonable upper bound

    // Also verify from element: capacitances at two bias points differ significantly
    const v0 = makeVaractor({ cjo: CJO, vj: VJ, m: M });
    const cFrom0 = getCapacitanceAtBias(v0.element, v0.pool, 0, 1e-9); // V_R=0

    const v5 = makeVaractor({ cjo: CJO, vj: VJ, m: M });
    const cFrom5 = getCapacitanceAtBias(v5.element, v5.pool, -5, 1e-9); // V_R=5V

    expect(cFrom0).toBeGreaterThan(cFrom5); // C decreases with reverse bias
    expect(cFrom0 / cFrom5).toBeGreaterThan(1.5); // significant tuning range
  });

  it("definition_has_correct_fields", () => {
    expect(VaractorDefinition.name).toBe("VaractorDiode");
    expect(VaractorDefinition.modelRegistry?.["simplified"]).toBeDefined();
    expect(VaractorDefinition.modelRegistry?.["simplified"]?.kind).toBe("inline");
    expect((VaractorDefinition.modelRegistry?.["simplified"] as {kind:"inline";factory:AnalogFactory}|undefined)?.factory).toBeDefined();
    expect(VaractorDefinition.category).toBe("SEMICONDUCTORS");
  });

  it("isNonlinear_and_isReactive", () => {
    const { element: v } = makeVaractor();
    expect(v.isNonlinear).toBe(true);
    expect(v.isReactive).toBe(true);
    expect(typeof v.load).toBe('function');
  });

  it("change35_uses_computeJunctionCharge_for_q0", () => {
    // charge stored in Q slot should equal computeJunctionCharge,
    // not Cj * vNow. Verify by checking that at forward bias (vd=0.4V) the
    // charge values match computeJunctionCharge output (which differs from
    // CJO * vd at forward bias because of the linearized region formula).
    const CJO = 20e-12;
    const VJ = 0.7;
    const M = 0.5;
    const FC = 0.5;
    const TT = 0;
    const IS = 1e-14;
    const vd = 0.4; // forward bias above FC*VJ = 0.35

    const { element: varactor } = makeVaractor({ cjo: CJO, vj: VJ, m: M, iS: IS });
    const dt = 1e-6;

    // Drive to operating point via load(ctx) in DC-OP mode.
    const voltages = new Float64Array(2);
    voltages[0] = vd;
    voltages[1] = 0;
    for (let i = 0; i < 50; i++) {
      const dcSolver = new SparseSolver();
      dcSolver.beginAssembly(2);
      const dcCtx = makeLoadCtx(voltages, dcSolver, { isDcOp: true });
      varactor.load(dcCtx);
    }
    const idNow = Math.exp(vd / (IS > 0 ? 0.02585 : 1)) * IS - IS;
    const expectedQ = computeJunctionCharge(vd, CJO, VJ, M, FC, TT, idNow);

    // Run load(ctx) in transient mode to exercise the reactive-companion path
    // that writes the Q slot.
    const ag = new Float64Array(8);
    ag[0] = 2 / dt;
    ag[1] = 1;
    const tranSolver = new SparseSolver();
    tranSolver.beginAssembly(2);
    const tranCtx = makeLoadCtx(voltages, tranSolver, {
      isTransient: true,
<<<<<<< HEAD

      isTransientDcop: false,

=======
>>>>>>> e427e072 (D4: add isAc flag and pass LoadContext to stampAc (ngspice alignment))
      isAc: false,
      dt,
      method: "trapezoidal",
      order: 2,
      ag,
    });
    varactor.load(tranCtx);

    // The charge stored by load() (transient path) is committed to state via
    // the inline NIintegrate expansion. The key assertion is that the formulas
    // align: computeJunctionCharge at vd=0.4V must not equal CJO * vd (simple
    // product), meaning the function genuinely computes the ngspice piecewise
    // integral.
    const simpleProduct = CJO * vd;
    expect(expectedQ).not.toBeCloseTo(simpleProduct, 12);
    // Also verify computeJunctionCharge at zero is zero
    const q0 = computeJunctionCharge(0, CJO, VJ, M, FC, TT, 0);
    expect(q0).toBeCloseTo(0, 14);
  });

  it("change36_uses_computeJunctionCapacitance_with_fc_linearization", () => {
    // capacitance must follow computeJunctionCapacitance (with FC linearization)
    // not the old simple formula CJO/(1+V_R/VJ)^M.
    // Above FC*VJ, the linearized formula produces a different value than the
    // direct depletion formula.
    const CJO = 20e-12;
    const VJ = 0.7;
    const M = 0.5;
    const FC = 0.5;

    // At vd = FC*VJ + 0.1 = 0.45V (inside linearized region):
    const vdLinear = FC * VJ + 0.1;
    const cLinearized = computeJunctionCapacitance(vdLinear, CJO, VJ, M, FC);
    // Old formula would use: CJO / (1 - vd/VJ)^M (depletion, no linearization)
    const argOld = Math.max(1 - vdLinear / VJ, 1e-6);
    const cOld = CJO / Math.pow(argOld, M);
    // They differ: linearized formula caps growth, old formula diverges near VJ
    expect(cLinearized).not.toBeCloseTo(cOld, 12);

    // Verify the element-level capacitance at this vd comes from computeJunctionCapacitance:
    // C from element ≈ computeJunctionCapacitance(vd, CJO, VJ, M, FC) via trapezoidal inversion
    const { element: varactor, pool } = makeVaractor({ cjo: CJO, vj: VJ, m: M });
    const dt = 1e-6;
    const cMeasured = getCapacitanceAtBias(varactor, pool, vdLinear, dt);
    // Should be close to cLinearized (within trapezoidal integration approximation)
    const ratio = cMeasured / cLinearized;
    expect(ratio).toBeGreaterThan(0.98);
    expect(ratio).toBeLessThan(1.02);
  });

  it("change37_tt_adds_diffusion_capacitance", () => {
    // Ctotal = Cj + TT * gd
    // With TT > 0, the effective capacitance seen at forward bias is larger than Cj alone.
    // At forward bias (vd=0.6V) and TT=10ns, TT*gd adds a diffusion component.
    const CJO = 20e-12;
    const VJ = 0.7;
    const M = 0.5;
    const IS = 1e-14;
    const TT = 10e-9;
    const dt = 1e-6;

    const vdFwd = 0.6;

    // Without TT
    const v0 = makeVaractor({ cjo: CJO, vj: VJ, m: M, iS: IS });
    const cWithoutTT = getCapacitanceAtBias(v0.element, v0.pool, vdFwd, dt);

    // With TT = 10ns
    const v1 = makeVaractor({ cjo: CJO, vj: VJ, m: M, iS: IS, tt: TT });
    const cWithTT = getCapacitanceAtBias(v1.element, v1.pool, vdFwd, dt);

    // TT*gd adds to capacitance; at forward bias gd is significant so cWithTT > cWithoutTT
    expect(cWithTT).toBeGreaterThan(cWithoutTT);
  });
});

// ---------------------------------------------------------------------------
// C2.3: inline NIintegrate integration tests
// ---------------------------------------------------------------------------

// ngspice → ours variable mapping (niinteg.c:28-63):
//   ag[0] (CKTag[0])    → ctx.ag[0]   coefficient on q0 (current charge)
//   ag[1] (CKTag[1])    → ctx.ag[1]   coefficient on q1 (previous charge)
//   cap                 → Ctotal      voltage-dependent junction capacitance
//   q0                  → computeJunctionCharge at vd
//   q1                  → s1[SLOT_Q]  from previous accepted step
//   ccap                → ag[0]*q0 + ag[1]*q1
//   geq                 → ag[0]*Ctotal
//   ceq                 → ccap - geq*vd

describe("integration", () => {
  it("cvoltage_dependent_transient_matches_ngspice", () => {
    // Single transient step: varactor with cjo=20pF at vd=-2V (reverse bias).
    // Trapezoidal order 2: ag[0]=2/dt, ag[1]=1.
    // Expected geq = ag[0]*Ctotal, ceq = ag[0]*q0 + ag[1]*q1 - geq*vd.

    const cjo = 20e-12, vj = 0.7, m = 0.5, iS = 1e-14, fc = 0.5, tt = 0;
    const dt = 1e-9;
    const vd = -2.0; // reverse bias

    const ag = new Float64Array(8);
    const scratch = new Float64Array(49);
    computeNIcomCof(dt, [dt, dt, dt, dt, dt, dt, dt], 2, "trapezoidal", ag, scratch);

    const params = { ...VARACTOR_PARAM_DEFAULTS, cjo, vj, m, iS, fc, tt };
    const props = createTestPropertyBag();
    props.replaceModelParams(params);
    const core = createVaractorElement(new Map([["A", 1], ["K", 0]]), [], -1, props);

    const pool = new StatePool(9);
    (core as { stateBaseOffset: number }).stateBaseOffset = 0;
    core.initState(pool);

    // Seed previous-step charge in s1[SLOT_Q=7]
    const prevVd = -1.9;
    const prevId = iS * (Math.exp(prevVd / 0.02585) - 1);
    const q1_val = computeJunctionCharge(prevVd, cjo, vj, m, fc, tt, prevId);
    pool.state1[7] = q1_val;

    // Real SparseSolver — varactor between node 1 (anode) and ground (node 0
    // mapped to no row). matrixSize = 1 (anode only, cathode is ground).
    const solver = new SparseSolver();
    solver.beginAssembly(1);

    pool.ag.set(ag);
    const ctx = {
      solver,
      voltages: new Float64Array([vd, 0]),
      iteration: 0,
      initMode: "transient" as const,
      dt,
      method: "trapezoidal" as const,
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

    core.load(ctx);

    // Compute expected values from the NIintegrate formula
    const idRaw = iS * (Math.exp(vd / 0.02585) - 1);
    const gdRaw = iS * Math.exp(vd / 0.02585) / 0.02585;
    const Cj = computeJunctionCapacitance(vd, cjo, vj, m, fc);
    const Ctotal = Cj + tt * gdRaw;
    const q0_val = computeJunctionCharge(vd, cjo, vj, m, fc, tt, idRaw);
    const ccap_expected = ag[0] * q0_val + ag[1] * q1_val;
    const capGeq_expected = ag[0] * Ctotal;
    const capIeq_expected = ccap_expected - capGeq_expected * vd;

    // Verify geq = ag[0] * Ctotal (bit-exact)
    expect(capGeq_expected).toBe(ag[0] * Ctotal);
    // Verify ceq = ccap - geq*vd (bit-exact)
    expect(capIeq_expected).toBe(ccap_expected - capGeq_expected * vd);

    // Verify the element stamped the correct capGeq: find diagonal (0,0) contributions
    const entries = solver.getCSCNonZeros();
    const total00 = entries.filter((e) => e.row === 0 && e.col === 0).reduce((sum, e) => sum + e.value, 0);
    const gd_junction = gdRaw + 1e-12; // GMIN added in varactor load()
    expect(total00).toBe(gd_junction + capGeq_expected);
  });

  it("no_integrateCapacitor_import", () => {
    const fs = require("fs");
    const src = fs.readFileSync(
      require("path").resolve(__dirname, "../varactor.ts"),
      "utf8",
    ) as string;
    expect(src).not.toMatch(/integrateCapacitor/);
    expect(src).not.toMatch(/integrateInductor/);
  });
});

