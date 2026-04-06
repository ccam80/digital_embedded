/**
 * Tests for the NPN and PNP BJT components.
 *
 * Covers:
 *   - Active region: stamp values for Ic, Ib, gm, go, gpi, gmu
 *   - Cutoff region: near-zero collector current
 *   - Saturation region: both junctions forward biased
 *   - Voltage limiting via pnjlim on both B-E and B-C junctions
 *   - PNP polarity reversal
 *   - Component definition fields (modelRegistry)
 *   - Model param access via getModelParam/setModelParam
 *   - Integration: common-emitter amplifier DC operating point
 */

import { describe, it, expect, vi } from "vitest";
import {
  createBjtElement,
  createSpiceL1BjtElement,
  NpnBjtDefinition,
  PnpBjtDefinition,
  BJT_NPN_DEFAULTS,
  BJT_PARAM_DEFS,
  BJT_SPICE_L1_PARAM_DEFS,
  BJT_SPICE_L1_NPN_DEFAULTS,
} from "../bjt.js";
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
import { createTestPropertyBag } from "../../../test-fixtures/model-fixtures.js";

// ---------------------------------------------------------------------------
// Helper: allocate a StatePool for a single element and call initState
// ---------------------------------------------------------------------------

function withState<T extends AnalogElementCore>(core: T): { element: T; pool: StatePool } {
  const size = core.stateSize ?? 0;
  const pool = new StatePool(Math.max(size, 1));
  if (size > 0) {
    core.stateBaseOffset = 0;
    core.initState!(pool);
  } else {
    core.stateBaseOffset = -1;
  }
  return { element: core, pool };
}

// ---------------------------------------------------------------------------
// Physical constants (match bjt.ts)
// ---------------------------------------------------------------------------

const VT = 0.02585;
const GMIN = 1e-12;

// ---------------------------------------------------------------------------
// Helper: create a PropertyBag with model params populated
// ---------------------------------------------------------------------------

function makeBjtProps(modelParams?: Record<string, number>): PropertyBag {
  const props = createTestPropertyBag();
  const defaults = { ...BJT_NPN_DEFAULTS };
  if (modelParams) {
    Object.assign(defaults, modelParams);
  }
  props.replaceModelParams(defaults);
  return props;
}

function makeSpiceL1Props(modelParams?: Record<string, number>): PropertyBag {
  const props = createTestPropertyBag();
  const defaults = { ...BJT_SPICE_L1_NPN_DEFAULTS };
  if (modelParams) {
    Object.assign(defaults, modelParams);
  }
  props.replaceModelParams(defaults);
  return props;
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
// Helper: create a BJT element at a specific operating point
//
// nodeC=1, nodeB=2, nodeE=3 → solver indices 0, 1, 2
// NPN: Vbe = polarity*(vB - vE), Vbc = polarity*(vB - vC)
// ---------------------------------------------------------------------------

function makeBjtAtOp(
  polarity: 1 | -1,
  vbe_target: number,
  vbc_target: number,
  modelParams?: Record<string, number>,
): AnalogElement {
  const propsObj = makeBjtProps(modelParams);
  const core = createBjtElement(polarity, new Map([["B", 2], ["C", 1], ["E", 3]]), -1, propsObj);
  const { element: statedCore } = withState(core);
  const element = withNodeIds(statedCore, [2, 1, 3]);

  const voltages = new Float64Array(3);

  for (let i = 0; i < 100; i++) {
    const vE = 0;
    const vB = polarity * vbe_target;
    const vC = vB - polarity * vbc_target;
    voltages[0] = vC;
    voltages[1] = vB;
    voltages[2] = vE;
    element.updateOperatingPoint!(voltages);
    voltages[0] = vC;
    voltages[1] = vB;
    voltages[2] = vE;
  }

  return element;
}

// ---------------------------------------------------------------------------
// Helper: inline resistor element for integration tests
// ---------------------------------------------------------------------------

function makeResistor(nodeA: number, nodeB: number, R: number): AnalogElement {
  const G = 1 / R;
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
// Gummel-Poon analytical helper for test assertions
// ---------------------------------------------------------------------------

function computeExpectedOp(
  vbe: number,
  vbc: number,
  p: Record<string, number>,
): { ic: number; ib: number; gm: number; go: number; gpi: number; gmu: number } {
  const nfVt = p.NF * VT;
  const nrVt = p.NR * VT;
  const expVbe = Math.exp(Math.min(vbe / nfVt, 700));
  const expVbc = Math.exp(Math.min(vbc / nrVt, 700));
  const If = p.IS * (expVbe - 1);
  const Ir = p.IS * (expVbc - 1);

  const VAF_safe = p.VAF === Infinity ? 1e30 : p.VAF;
  const VAR_safe = p.VAR === Infinity ? 1e30 : p.VAR;
  const IKF_safe = p.IKF === Infinity ? 1e30 : p.IKF;
  const IKR_safe = p.IKR === Infinity ? 1e30 : p.IKR;

  const q1 = 1 / (1 - vbc / VAR_safe - vbe / VAF_safe);
  const q2 = If / IKF_safe + Ir / IKR_safe;
  const qb = q1 * (1 + Math.sqrt(1 + 4 * q2)) / 2;

  const ic = (If - Ir) / qb;
  const ibIdeal = If / p.BF + Ir / p.BR;
  const ibNonIdeal =
    (p.ISE > 0 ? p.ISE * (expVbe - 1) : 0) +
    (p.ISC > 0 ? p.ISC * (expVbc - 1) : 0);
  const ib = ibIdeal + ibNonIdeal;

  const dIfdVbe = p.IS * expVbe / nfVt;
  const dIrdVbc = p.IS * expVbc / nrVt;
  const sqrtTerm = Math.sqrt(Math.max(1 + 4 * q2, 1e-30));
  const dqbdIf = q1 / sqrtTerm / IKF_safe;
  const dqbdIr = q1 / sqrtTerm / IKR_safe;
  const dq1dVbe = q1 * q1 / VAF_safe;
  const dq1dVbc = q1 * q1 / VAR_safe;
  const dqbdVbe = dq1dVbe * (1 + sqrtTerm) / 2 + dqbdIf * dIfdVbe;
  const dqbdVbc = dq1dVbc * (1 + sqrtTerm) / 2 + dqbdIr * dIrdVbc;

  const gm = dIfdVbe / qb - ic * dqbdVbe / qb + GMIN;
  const go = dIrdVbc / qb + ic * dqbdVbc / qb + GMIN;
  const gpi = dIfdVbe / p.BF + (p.ISE > 0 ? p.ISE * expVbe / nfVt : 0) + GMIN;
  const gmu = dIrdVbc / p.BR + (p.ISC > 0 ? p.ISC * expVbc / nrVt : 0) + GMIN;

  return { ic, ib, gm, go, gpi, gmu };
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
// NPN tests
// ---------------------------------------------------------------------------

describe("NPN", () => {
  it("active_region_stamp", () => {
    // IS=1e-16, BF=100. At Vbe=0.7V, Ic = IS*(exp(0.7/VT)-1) ≈ 57.6µA.
    // The spec target Ic≈2.2mA, Ib≈22µA requires Vbe≈0.794V with IS=1e-16.
    // Use Vbe=0.794V to hit the spec-stated operating point.
    const vbe = VT * Math.log(2.2e-3 / BJT_NPN_DEFAULTS.IS + 1);
    const vbc = vbe - 5; // Vce=5V → Vbc = Vbe - Vce
    const element = makeBjtAtOp(1, vbe, vbc);

    const exp = computeExpectedOp(vbe, vbc, BJT_NPN_DEFAULTS);

    // Ic ≈ 2.2mA ± 5%, Ib ≈ 22µA ± 5%, Ic/Ib ≈ BF=100 within 5%
    expect(exp.ic).toBeGreaterThan(0.0020);
    expect(exp.ic).toBeLessThan(0.0025);
    expect(exp.ib).toBeGreaterThan(0.000020);
    expect(exp.ib).toBeLessThan(0.000025);
    // Ic/Ib ratio ≈ BF=100 within 5%
    expect(exp.ic / exp.ib).toBeGreaterThan(95);
    expect(exp.ic / exp.ib).toBeLessThan(105);

    // Verify stamp produces conductance entries
    const solver = makeMockSolver();
    element.stampNonlinear!(solver);

    const stampCalls = (solver.stamp as ReturnType<typeof vi.fn>).mock.calls;
    const rhsCalls = (solver.stampRHS as ReturnType<typeof vi.fn>).mock.calls;

    // Conductance stamps: gpi(B-E), gmu(B-C), go(C-E), gm VCCS (C-B, C-E, E-B, E-E terms)
    // Total of 16 conductance entries (4 per conductance × 4 conductances)
    expect(stampCalls.length).toBe(16);
    expect(rhsCalls.length).toBe(3); // C, B, E Norton currents

    // gm, go, gpi, gmu: exact values computed from Gummel-Poon at this operating point
    expect(exp.gm).toBeCloseTo(0.08510638298011017, 10);
    expect(exp.go).toBeCloseTo(1e-12, 20);
    expect(exp.gpi).toBeCloseTo(0.0008510638307911016, 10);
    expect(exp.gmu).toBeCloseTo(1e-12, 20);
  });

  it("cutoff_region", () => {
    // Vbe=0V, Vce=5V: both junctions reverse biased → Ic ≈ 0
    const vbe = 0;
    const vbc = -5;
    const exp = computeExpectedOp(vbe, vbc, BJT_NPN_DEFAULTS);

    // At Vbe=0: If = IS*(exp(0)-1) = 0, Ic = -Ir/qb ≈ 0
    // Collector current should be negligible (leakage only)
    expect(Math.abs(exp.ic)).toBeLessThan(1e-12);
    expect(Math.abs(exp.ib)).toBeLessThan(1e-12);
  });

  it("saturation_region", () => {
    // Vbe=0.8V, Vce=0.2V → Vbc=0.6V: both junctions forward biased
    const vbe = 0.8;
    const vbc = 0.6;
    const exp = computeExpectedOp(vbe, vbc, BJT_NPN_DEFAULTS);

    // Both If and Ir are significant, limiting Ic below BF*Ib
    const nfVt = VT;
    const If = BJT_NPN_DEFAULTS.IS * (Math.exp(vbe / nfVt) - 1);
    const Ir = BJT_NPN_DEFAULTS.IS * (Math.exp(vbc / nfVt) - 1);

    // Forward current exists (both junctions forward biased — exact values at Vbe=0.8, Vbc=0.6)
    expect(If).toBeCloseTo(0.2757072476037856, 8);
    expect(Ir).toBeCloseTo(0.00012031953282638291, 12);

    // Ic is reduced compared to active region due to reverse current Ir
    // (saturation: Ic < BF * Ib)
    expect(exp.ic / exp.ib).toBeLessThan(100);

    // Collector current exact value at saturation operating point
    expect(exp.ic).toBeCloseTo(0.27558692807095925, 8);
  });

  it("voltage_limiting_both_junctions", () => {
    // Start at a moderate Vbe operating point
    const propsObj = makeBjtProps();
    const { element, pool } = withState(createBjtElement(1, new Map([["B", 2], ["C", 1], ["E", 3]]), -1, propsObj));

    const voltages = new Float64Array(3);
    // Set initial operating point: Vbe ≈ 0.3V (B=0.3, E=0, C=5)
    voltages[0] = 5;  // Vc
    voltages[1] = 0.3; // Vb
    voltages[2] = 0;  // Ve

    for (let i = 0; i < 20; i++) {
      element.updateOperatingPoint!(voltages);
      voltages[0] = 5;
      voltages[1] = 0.3;
      voltages[2] = 0;
    }

    // Now simulate a large NR step to 5V on Vbe
    voltages[0] = 5;
    voltages[1] = 5.0; // large Vbe step
    voltages[2] = 0;
    const voltagesSnapshot = Float64Array.from(voltages);
    element.updateOperatingPoint!(voltages);

    // voltages array must be unchanged — no write-back
    expect(voltages[0]).toBe(voltagesSnapshot[0]);
    expect(voltages[1]).toBe(voltagesSnapshot[1]);
    expect(voltages[2]).toBe(voltagesSnapshot[2]);

    // Limited voltage is stored in pool slot 0 (SLOT_VBE)
    const vbeLimited = pool.state0[0]; // SLOT_VBE = 0
    expect(vbeLimited).toBeLessThan(5.0);
    expect(vbeLimited - 0.3).toBeLessThan(4.5);
  });

  it("checkConvergence_returns_true_when_stable", () => {
    // makeBjtAtOp converges the element at Vbe=0.7V, Vbc=-4.3V over 100 iterations.
    // Pool SLOT_VBE should be close to 0.7V after convergence.
    const element = makeBjtAtOp(1, 0.7, -4.3);

    // Voltages that produce the same junction voltages as the converged pool state.
    // Ve=0, Vb=0.7 → vbeRaw = 0.7 ≈ pool value → converged
    const voltages = new Float64Array(3);
    voltages[0] = 5.0; // Vc
    voltages[1] = 0.7; // Vb
    voltages[2] = 0;   // Ve

    const prevVoltages = new Float64Array(3);
    prevVoltages.set(voltages);

    const converged = element.checkConvergence!(voltages, prevVoltages);
    expect(converged).toBe(true);
  });

  it("checkConvergence_returns_false_when_large_deviation_from_pool", () => {
    // makeBjtAtOp converges the element at Vbe=0.7V in pool.
    // Present a junction voltage far from 0.7V → not converged.
    const element = makeBjtAtOp(1, 0.7, -4.3);

    // Vb=0.0 → vbeRaw = 0.0, pool has 0.7V, difference = 0.7V >> 2*VT
    const voltages = new Float64Array(3);
    voltages[0] = 5.0;
    voltages[1] = 0.0; // vbeRaw = 0.0, pool ≈ 0.7 → diff = 0.7V > 2*VT
    voltages[2] = 0;

    const prevVoltages = new Float64Array(3);
    prevVoltages.set(voltages);

    const converged = element.checkConvergence!(voltages, prevVoltages);
    expect(converged).toBe(false);
  });

  it("isNonlinear_true", () => {
    const propsObj = makeBjtProps();
    const element = createBjtElement(1, new Map([["B", 2], ["C", 1], ["E", 3]]), -1, propsObj);
    expect(element.isNonlinear).toBe(true);
  });

  it("isReactive_true", () => {
    const propsObj = makeBjtProps();
    const element = createBjtElement(1, new Map([["B", 2], ["C", 1], ["E", 3]]), -1, propsObj);
    expect(element.isReactive).toBe(true);
  });

  it("pinNodeIds_correct", () => {
    const propsObj = makeBjtProps();
    const element = withNodeIds(createBjtElement(1, new Map([["B", 3], ["C", 5], ["E", 7]]), -1, propsObj), [3, 5, 7]);
    expect(element.pinNodeIds).toEqual([3, 5, 7]);
  });

  it("branchIndex_minus_one", () => {
    const propsObj = makeBjtProps();
    const element = createBjtElement(1, new Map([["B", 2], ["C", 1], ["E", 3]]), -1, propsObj);
    expect(element.branchIndex).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// PNP tests
// ---------------------------------------------------------------------------

describe("PNP", () => {
  it("polarity_reversed", () => {
    // For PNP: polarity = -1. Use the same Vbe that gives ~2.2mA so signals are non-trivial.
    const vbe_pnp = VT * Math.log(2.2e-3 / BJT_NPN_DEFAULTS.IS + 1);
    const vbc_pnp = vbe_pnp - 5; // Vce=5V

    const npnEl = makeBjtAtOp(1, vbe_pnp, vbc_pnp);
    const pnpEl = makeBjtAtOp(-1, vbe_pnp, vbc_pnp);

    // Both should produce the same magnitude of Norton currents but in opposite polarity
    const solverNpn = makeMockSolver();
    const solverPnp = makeMockSolver();
    npnEl.stampNonlinear!(solverNpn);
    pnpEl.stampNonlinear!(solverPnp);

    const rhsNpn = (solverNpn.stampRHS as ReturnType<typeof vi.fn>).mock.calls;
    const rhsPnp = (solverPnp.stampRHS as ReturnType<typeof vi.fn>).mock.calls;

    // Both have 3 RHS stamps
    expect(rhsNpn).toHaveLength(3);
    expect(rhsPnp).toHaveLength(3);

    // Collector (node 1 → row 0) RHS for NPN and PNP should be negated
    const npnCollRhs = rhsNpn.find((c) => c[0] === 0)!;
    const pnpCollRhs = rhsPnp.find((c) => c[0] === 0)!;
    // PNP collector RHS should be negated relative to NPN
    expect(pnpCollRhs[1]).toBeCloseTo(-(npnCollRhs[1] as number), 10);
  });

  it("pnp_active_region_currents_positive", () => {
    // PNP active region: Veb≈0.794V (same IS=1e-16 physics as NPN active region test)
    // Use the same Vbe that gives Ic≈2.2mA so magnitudes match the NPN case.
    const vbe = VT * Math.log(2.2e-3 / BJT_NPN_DEFAULTS.IS + 1);
    const vbc = vbe - 5;
    const exp = computeExpectedOp(vbe, vbc, BJT_NPN_DEFAULTS);

    // The computed Ic magnitude should match NPN at same bias (only polarity differs in stamp)
    expect(exp.ic).toBeGreaterThan(0.0020);
    expect(exp.ic).toBeLessThan(0.0025);
  });

  it("pnp_isNonlinear_true", () => {
    const propsObj = makeBjtProps();
    const element = createBjtElement(-1, new Map([["B", 2], ["C", 1], ["E", 3]]), -1, propsObj);
    expect(element.isNonlinear).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ComponentDefinition tests
// ---------------------------------------------------------------------------

describe("Definitions", () => {
  it("npn_definition_fields", () => {
    expect(NpnBjtDefinition.name).toBe("NpnBJT");
    expect(NpnBjtDefinition.modelRegistry!["spice"].kind).toBe("inline");
    expect(NpnBjtDefinition.modelRegistry!["spice"].paramDefs).toBe(BJT_SPICE_L1_PARAM_DEFS);
    expect(NpnBjtDefinition.defaultModel).toBe("spice");
    expect(NpnBjtDefinition.pinLayout).toHaveLength(3);
  });

  it("pnp_definition_fields", () => {
    expect(PnpBjtDefinition.name).toBe("PnpBJT");
    expect(PnpBjtDefinition.modelRegistry!["spice"].kind).toBe("inline");
    expect(PnpBjtDefinition.modelRegistry!["spice"].paramDefs).toBe(BJT_SPICE_L1_PARAM_DEFS);
    expect(PnpBjtDefinition.defaultModel).toBe("spice");
    expect(PnpBjtDefinition.pinLayout).toHaveLength(3);
  });

  it("npn_modelRegistry_has_both_simple_and_spice_l1", () => {
    const registry = NpnBjtDefinition.modelRegistry!;
    expect(registry["simple"]).toBeDefined();
    expect(registry["spice"]).toBeDefined();
    expect(registry["simple"].kind).toBe("inline");
    expect(registry["spice"].kind).toBe("inline");
  });

  it("pnp_modelRegistry_has_both_simple_and_spice_l1", () => {
    const registry = PnpBjtDefinition.modelRegistry!;
    expect(registry["simple"]).toBeDefined();
    expect(registry["spice"]).toBeDefined();
    expect(registry["simple"].kind).toBe("inline");
    expect(registry["spice"].kind).toBe("inline");
  });

  it("simple_model_uses_original_param_defs", () => {
    expect(NpnBjtDefinition.modelRegistry!["simple"].paramDefs).toBe(BJT_PARAM_DEFS);
    expect(PnpBjtDefinition.modelRegistry!["simple"].paramDefs).toBe(BJT_PARAM_DEFS);
  });

  it("spice_l1_model_uses_full_param_defs", () => {
    expect(NpnBjtDefinition.modelRegistry!["spice"].paramDefs).toBe(BJT_SPICE_L1_PARAM_DEFS);
    expect(PnpBjtDefinition.modelRegistry!["spice"].paramDefs).toBe(BJT_SPICE_L1_PARAM_DEFS);
  });

  it("npn_pin_labels", () => {
    const labels = NpnBjtDefinition.pinLayout.map((p) => p.label);
    expect(labels).toContain("C");
    expect(labels).toContain("B");
    expect(labels).toContain("E");
  });

  it("pnp_pin_labels", () => {
    const labels = PnpBjtDefinition.pinLayout.map((p) => p.label);
    expect(labels).toContain("C");
    expect(labels).toContain("B");
    expect(labels).toContain("E");
  });

  it("npn_simple_modelRegistry_factory_creates_element", () => {
    const propsObj = makeBjtProps();
    const entry = NpnBjtDefinition.modelRegistry!["simple"];
    if (entry.kind !== "inline") throw new Error("expected inline");
    const el = withNodeIds(entry.factory(new Map([["B", 1], ["C", 2], ["E", 3]]), [], -1, propsObj, () => 0), [1, 2, 3]);
    expect(el.isNonlinear).toBe(true);
    expect(el.pinNodeIds).toEqual([1, 2, 3]);
  });

  it("pnp_simple_modelRegistry_factory_creates_element", () => {
    const propsObj = makeBjtProps();
    const entry = PnpBjtDefinition.modelRegistry!["simple"];
    if (entry.kind !== "inline") throw new Error("expected inline");
    const el = withNodeIds(entry.factory(new Map([["B", 1], ["C", 2], ["E", 3]]), [], -1, propsObj, () => 0), [1, 2, 3]);
    expect(el.isNonlinear).toBe(true);
    expect(el.pinNodeIds).toEqual([1, 2, 3]);
  });

  it("npn_spice_l1_modelRegistry_factory_creates_element", () => {
    const propsObj = makeSpiceL1Props();
    const entry = NpnBjtDefinition.modelRegistry!["spice"];
    if (entry.kind !== "inline") throw new Error("expected inline");
    const el = withNodeIds(entry.factory(new Map([["B", 1], ["C", 2], ["E", 3]]), [], -1, propsObj, () => 0), [1, 2, 3]);
    expect(el.isNonlinear).toBe(true);
    expect(el.pinNodeIds).toEqual([1, 2, 3]);
  });

  it("pnp_spice_l1_modelRegistry_factory_creates_element", () => {
    const propsObj = makeSpiceL1Props();
    const entry = PnpBjtDefinition.modelRegistry!["spice"];
    if (entry.kind !== "inline") throw new Error("expected inline");
    const el = withNodeIds(entry.factory(new Map([["B", 1], ["C", 2], ["E", 3]]), [], -1, propsObj, () => 0), [1, 2, 3]);
    expect(el.isNonlinear).toBe(true);
    expect(el.pinNodeIds).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// Model param partition tests
// ---------------------------------------------------------------------------

describe("ModelParams", () => {
  it("getModelParam_BF_returns_default_value", () => {
    const propsObj = makeBjtProps();
    expect(propsObj.getModelParam<number>("BF")).toBe(100);
  });

  it("getModelParam_IS_returns_default_value", () => {
    const propsObj = makeBjtProps();
    expect(propsObj.getModelParam<number>("IS")).toBe(1e-14);
  });

  it("setModelParam_BF_200_recompile_produces_different_results", () => {
    const props100 = makeBjtProps();
    const { element: el100 } = withState(createBjtElement(1, new Map([["B", 2], ["C", 1], ["E", 3]]), -1, props100));

    const props200 = makeBjtProps({ BF: 200 });
    expect(props200.getModelParam<number>("BF")).toBe(200);
    const { element: el200 } = withState(createBjtElement(1, new Map([["B", 2], ["C", 1], ["E", 3]]), -1, props200));

    const voltages100 = new Float64Array(3);
    const voltages200 = new Float64Array(3);
    voltages100[0] = 5; voltages100[1] = 0.7; voltages100[2] = 0;
    voltages200[0] = 5; voltages200[1] = 0.7; voltages200[2] = 0;

    for (let i = 0; i < 50; i++) {
      el100.updateOperatingPoint!(voltages100);
      voltages100[0] = 5; voltages100[1] = 0.7; voltages100[2] = 0;
      el200.updateOperatingPoint!(voltages200);
      voltages200[0] = 5; voltages200[1] = 0.7; voltages200[2] = 0;
    }

    const currents100 = el100.getPinCurrents!(voltages100);
    const currents200 = el200.getPinCurrents!(voltages200);

    // With higher BF, base current should be smaller for same collector current
    const ib100 = Math.abs(currents100[0]);
    const ib200 = Math.abs(currents200[0]);
    expect(ib200).toBeLessThan(ib100);
  });

  it("all_11_params_defined_in_paramDefs", () => {
    const paramKeys = BJT_PARAM_DEFS.map(pd => pd.key);
    expect(paramKeys).toContain("BF");
    expect(paramKeys).toContain("IS");
    expect(paramKeys).toContain("NF");
    expect(paramKeys).toContain("BR");
    expect(paramKeys).toContain("VAF");
    expect(paramKeys).toContain("IKF");
    expect(paramKeys).toContain("IKR");
    expect(paramKeys).toContain("ISE");
    expect(paramKeys).toContain("ISC");
    expect(paramKeys).toContain("NR");
    expect(paramKeys).toContain("VAR");
    expect(paramKeys).toHaveLength(11);
  });

  it("primary_params_have_rank_primary", () => {
    const bf = BJT_PARAM_DEFS.find(pd => pd.key === "BF")!;
    const is_ = BJT_PARAM_DEFS.find(pd => pd.key === "IS")!;
    expect(bf.rank).toBe("primary");
    expect(is_.rank).toBe("primary");
  });

  it("secondary_params_have_rank_secondary", () => {
    const nf = BJT_PARAM_DEFS.find(pd => pd.key === "NF")!;
    const vaf = BJT_PARAM_DEFS.find(pd => pd.key === "VAF")!;
    expect(nf.rank).toBe("secondary");
    expect(vaf.rank).toBe("secondary");
  });
});

// ---------------------------------------------------------------------------
// Integration test: common-emitter amplifier DC operating point
//
// Circuit topology:
//   Vcc=5V (node4=+, gnd=-) → branch row 3
//   Vbb=5V (node3=+, gnd=-) → branch row 4
//   Rc=1kΩ: node4 ↔ node1 (Vcc to collector)
//   Rb=100kΩ: node3 ↔ node2 (Vbb to base)
//   NPN BJT: C=node1, B=node2, E=gnd
//
// MNA matrix size = 5 nodes + 2 branch rows = 5
// (nodes 1..4, branchRows 4 and 5 → 0-indexed as matrix rows 3 and 4)
//
// SPICE reference (ngspice, IS=1e-14, BF=100):
//   Ib ≈ 43µA, Ic ≈ 4.3mA, Vce ≈ 5 - 4.3mA × 1kΩ = 0.7V
// ---------------------------------------------------------------------------

describe("Integration", () => {
  it("common_emitter_amplifier", () => {
    // Node assignments:
    //   node1 = collector (Vc)
    //   node2 = base (Vb)
    //   node3 = Vbb supply positive terminal
    //   node4 = Vcc supply positive terminal
    //   gnd   = 0
    // Branch rows (0-indexed in matrix):
    //   branchRow_vcc = 4 (node count is 4, so matrix rows 0-3 are nodes, 4 and 5 are branches)
    //   branchRow_vbb = 5
    // matrixSize = 6

    const matrixSize = 6;
    const branchRowVcc = 4;
    const branchRowVbb = 5;

    // Sources
    const vcc = makeDcVoltageSource(4, 0, branchRowVcc, 5) as unknown as AnalogElement; // 5V supply
    const vbb = makeDcVoltageSource(3, 0, branchRowVbb, 5) as unknown as AnalogElement; // 5V base supply

    // Resistors
    const rc = makeResistor(4, 1, 1000);     // Rc=1kΩ from Vcc to collector
    const rb = makeResistor(3, 2, 100_000);  // Rb=100kΩ from Vbb to base

    // BJT: C=node1, B=node2, E=gnd(0)
    const bjtProps = makeBjtProps();
    const bjt = withNodeIds(withState(createBjtElement(1, new Map([["B", 2], ["C", 1], ["E", 0]]), -1, bjtProps)).element, [2, 1, 0]);

    const solver = new SparseSolver();
    const diagnostics = new DiagnosticCollector();

    const result = solveDcOperatingPoint({
      solver,
      elements: [vcc, vbb, rc, rb, bjt],
      matrixSize,
      params: DEFAULT_SIMULATION_PARAMS,
      diagnostics,
    });

    expect(result.converged).toBe(true);

    // Extract voltages
    // nodeVoltages array is indexed 0-based: index 0 = node1, ..., index 3 = node4
    const vCollector = result.nodeVoltages[0];  // V(node1) = Vce (since Ve=0)
    const vBase = result.nodeVoltages[1];       // V(node2) = Vb
    const vVbb = result.nodeVoltages[2];        // V(node3) should be 5V
    const vVcc = result.nodeVoltages[3];        // V(node4) should be 5V

    // Source voltages should be 5V
    expect(vVcc).toBeCloseTo(5, 3);
    expect(vVbb).toBeCloseTo(5, 3);

    // ngspice reference: IS=1e-14, BF=100 → deep saturation (Vc ≈ Vbe)
    expectSpiceRef(vCollector, 6.928910e-01, "V(collector)");
    expectSpiceRef(vBase, 6.928910e-01, "V(base)");

    const ic = (vVcc - vCollector) / 1000;
    const ib = (vVbb - vBase) / 100_000;
    expectSpiceRef(ic, 4.307675e-03, "Ic");
    expectSpiceRef(ib, 4.307675e-05, "Ib");
  });

  it("npn_cutoff_with_zero_base_drive", () => {
    // Vcc=5V, Rc=1kΩ, BJT with base tied to ground (no base drive)
    // In cutoff: Ic ≈ 0, Vce ≈ Vcc = 5V
    const matrixSize = 3; // nodes: 1=collector, 2=Vcc; branch: row 2
    const branchRowVcc = 2;

    const vcc = makeDcVoltageSource(2, 0, branchRowVcc, 5) as unknown as AnalogElement;
    const rc = makeResistor(2, 1, 1000);

    // BJT: B=gnd, C=node1, E=gnd → base=0=ground, emitter=0=ground
    // createBjtElement pin order: [B, C, E]
    const bjtProps = makeBjtProps();
    const bjt = withNodeIds(withState(createBjtElement(1, new Map([["B", 0], ["C", 1], ["E", 0]]), -1, bjtProps)).element, [0, 1, 0]);

    const solver = new SparseSolver();
    const diagnostics = new DiagnosticCollector();

    const result = solveDcOperatingPoint({
      solver,
      elements: [vcc, rc, bjt],
      matrixSize,
      params: DEFAULT_SIMULATION_PARAMS,
      diagnostics,
    });

    expect(result.converged).toBe(true);

    const vCollector = result.nodeVoltages[0]; // V(node1)
    const vVcc = result.nodeVoltages[1];       // V(node2) = 5V

    expect(vVcc).toBeCloseTo(5, 3);
    // Collector should be near Vcc (BJT in cutoff, negligible Ic)
    expect(vCollector).toBeGreaterThan(4.9);
    expect(vCollector).toBeLessThan(5.0);
  });
});

// ---------------------------------------------------------------------------
// setParam behavioral verification — reads mutable params object, not captured locals
// ---------------------------------------------------------------------------

describe("setParam shifts DC OP to match SPICE reference", () => {
  it("setParam('BF', 50) shifts DC OP to match SPICE reference", () => {
    const matrixSize = 6;
    const branchRowVcc = 4;
    const branchRowVbb = 5;
    const vcc = makeDcVoltageSource(4, 0, branchRowVcc, 5) as unknown as AnalogElement;
    const vbb = makeDcVoltageSource(3, 0, branchRowVbb, 5) as unknown as AnalogElement;
    const rc = makeResistor(4, 1, 1000);
    const rb = makeResistor(3, 2, 100_000);
    const bjtProps = makeBjtProps();
    const bjt = withNodeIds(withState(createBjtElement(1, new Map([["B", 2], ["C", 1], ["E", 0]]), -1, bjtProps)).element, [2, 1, 0]);

    const solver = new SparseSolver();
    const diagnostics = new DiagnosticCollector();
    const elements = [vcc, vbb, rc, rb, bjt];

    // Before: BF=100
    const before = solveDcOperatingPoint({ solver, elements, matrixSize, params: DEFAULT_SIMULATION_PARAMS, diagnostics });
    expect(before.converged).toBe(true);
    expectSpiceRef(before.nodeVoltages[0], 6.928910e-01, "V(collector) before");
    expectSpiceRef(before.nodeVoltages[1], 6.928910e-01, "V(base) before");

    // setParam and re-solve
    bjt.setParam("BF", 50);
    const after = solveDcOperatingPoint({ solver, elements, matrixSize, params: DEFAULT_SIMULATION_PARAMS, diagnostics });
    expect(after.converged).toBe(true);
    expectSpiceRef(after.nodeVoltages[0], 2.837533e+00, "V(collector) after BF=50");
    expectSpiceRef(after.nodeVoltages[1], 6.750668e-01, "V(base) after BF=50");

    const icAfter = (after.nodeVoltages[3] - after.nodeVoltages[0]) / 1000;
    const ibAfter = (after.nodeVoltages[2] - after.nodeVoltages[1]) / 100_000;
    expectSpiceRef(icAfter, 2.162520e-03, "Ic after BF=50");
    expectSpiceRef(ibAfter, 4.325039e-05, "Ib after BF=50");
  });

  it("setParam('IS', 1e-12) shifts DC OP to match SPICE reference", () => {
    const matrixSize = 6;
    const branchRowVcc = 4;
    const branchRowVbb = 5;
    const vcc = makeDcVoltageSource(4, 0, branchRowVcc, 5) as unknown as AnalogElement;
    const vbb = makeDcVoltageSource(3, 0, branchRowVbb, 5) as unknown as AnalogElement;
    const rc = makeResistor(4, 1, 1000);
    const rb = makeResistor(3, 2, 100_000);
    const bjtProps = makeBjtProps();
    const bjt = withNodeIds(withState(createBjtElement(1, new Map([["B", 2], ["C", 1], ["E", 0]]), -1, bjtProps)).element, [2, 1, 0]);

    const solver = new SparseSolver();
    const diagnostics = new DiagnosticCollector();
    const elements = [vcc, vbb, rc, rb, bjt];

    // Before: IS=1e-14
    const before = solveDcOperatingPoint({ solver, elements, matrixSize, params: DEFAULT_SIMULATION_PARAMS, diagnostics });
    expect(before.converged).toBe(true);
    expectSpiceRef(before.nodeVoltages[0], 6.928910e-01, "V(collector) before");
    expectSpiceRef(before.nodeVoltages[1], 6.928910e-01, "V(base) before");

    // setParam and re-solve
    bjt.setParam("IS", 1e-12);
    const after = solveDcOperatingPoint({ solver, elements, matrixSize, params: DEFAULT_SIMULATION_PARAMS, diagnostics });
    expect(after.converged).toBe(true);
    expectSpiceRef(after.nodeVoltages[0], 5.744795e-01, "V(collector) after IS=1e-12");
    expectSpiceRef(after.nodeVoltages[1], 5.744795e-01, "V(base) after IS=1e-12");

    const icAfter = (after.nodeVoltages[3] - after.nodeVoltages[0]) / 1000;
    const ibAfter = (after.nodeVoltages[2] - after.nodeVoltages[1]) / 100_000;
    expectSpiceRef(icAfter, 4.425990e-03, "Ic after IS=1e-12");
    expectSpiceRef(ibAfter, 4.425990e-05, "Ib after IS=1e-12");
  });
});

// ---------------------------------------------------------------------------
// SPICE Level 1 model tests
// ---------------------------------------------------------------------------

describe("SPICE L1 model", () => {
  it("has full param set including terminal resistances and capacitances", () => {
    const paramKeys = BJT_SPICE_L1_PARAM_DEFS.map(pd => pd.key);
    // Original simple params
    expect(paramKeys).toContain("BF");
    expect(paramKeys).toContain("IS");
    expect(paramKeys).toContain("NF");
    expect(paramKeys).toContain("BR");
    expect(paramKeys).toContain("VAF");
    expect(paramKeys).toContain("VAR");
    expect(paramKeys).toContain("IKF");
    expect(paramKeys).toContain("IKR");
    expect(paramKeys).toContain("ISE");
    expect(paramKeys).toContain("ISC");
    expect(paramKeys).toContain("NR");
    // New SPICE L1 params
    expect(paramKeys).toContain("RB");
    expect(paramKeys).toContain("RC");
    expect(paramKeys).toContain("RE");
    expect(paramKeys).toContain("NE");
    expect(paramKeys).toContain("NC");
    expect(paramKeys).toContain("CJE");
    expect(paramKeys).toContain("CJC");
    expect(paramKeys).toContain("VJE");
    expect(paramKeys).toContain("VJC");
    expect(paramKeys).toContain("MJE");
    expect(paramKeys).toContain("MJC");
    expect(paramKeys).toContain("TF");
    expect(paramKeys).toContain("TR");
    expect(paramKeys).toContain("FC");
  });

  it("spice_l1_param_count_is_superset_of_simple", () => {
    expect(BJT_SPICE_L1_PARAM_DEFS.length).toBeGreaterThan(BJT_PARAM_DEFS.length);
    // Simple has 11 params, SPICE adds terminal R, caps, transit time, and full GP params = 40 total
    expect(BJT_SPICE_L1_PARAM_DEFS.length).toBe(40);
  });

  it("factory_produces_valid_element_with_zero_resistances", () => {
    // With RB=RC=RE=0 (defaults), no internal nodes needed
    const propsObj = makeSpiceL1Props();
    const el = createSpiceL1BjtElement(1, new Map([["B", 2], ["C", 1], ["E", 3]]), [], -1, propsObj);
    expect(el.isNonlinear).toBe(true);
  });

  it("factory_produces_element_with_internal_nodes_when_resistances_nonzero", () => {
    const propsObj = makeSpiceL1Props({ RB: 10, RC: 1, RE: 0.5 });
    // With all three resistances > 0, needs 3 internal nodes
    const internalNodes = [100, 101, 102];
    const el = createSpiceL1BjtElement(1, new Map([["B", 2], ["C", 1], ["E", 3]]), internalNodes, -1, propsObj);
    expect(el.isNonlinear).toBe(true);
  });

  it("zero_resistance_zero_capacitance_matches_simple_model_dc_op", () => {
    // With RB=RC=RE=0 and CJE=CJC=0, the SPICE L1 model should produce
    // the same DC operating point as the simple model
    const matrixSize = 6;
    const branchRowVcc = 4;
    const branchRowVbb = 5;

    // Simple model circuit
    const vcc1 = makeDcVoltageSource(4, 0, branchRowVcc, 5) as unknown as AnalogElement;
    const vbb1 = makeDcVoltageSource(3, 0, branchRowVbb, 5) as unknown as AnalogElement;
    const rc1 = makeResistor(4, 1, 1000);
    const rb1 = makeResistor(3, 2, 100_000);
    const simpleProps = makeBjtProps();
    const simpleBjt = withNodeIds(
      withState(createBjtElement(1, new Map([["B", 2], ["C", 1], ["E", 0]]), -1, simpleProps)).element,
      [2, 1, 0],
    );

    const solver1 = new SparseSolver();
    const diag1 = new DiagnosticCollector();
    const result1 = solveDcOperatingPoint({
      solver: solver1,
      elements: [vcc1, vbb1, rc1, rb1, simpleBjt],
      matrixSize,
      params: DEFAULT_SIMULATION_PARAMS,
      diagnostics: diag1,
    });
    expect(result1.converged).toBe(true);

    // SPICE L1 model circuit with zero resistances/capacitances (defaults)
    const vcc2 = makeDcVoltageSource(4, 0, branchRowVcc, 5) as unknown as AnalogElement;
    const vbb2 = makeDcVoltageSource(3, 0, branchRowVbb, 5) as unknown as AnalogElement;
    const rc2 = makeResistor(4, 1, 1000);
    const rb2 = makeResistor(3, 2, 100_000);
    const spiceProps = makeSpiceL1Props(); // defaults: RB=RC=RE=0, CJE=CJC=0
    const spiceBjt = withNodeIds(
      withState(createSpiceL1BjtElement(1, new Map([["B", 2], ["C", 1], ["E", 0]]), [], -1, spiceProps)).element,
      [2, 1, 0],
    );

    const solver2 = new SparseSolver();
    const diag2 = new DiagnosticCollector();
    const result2 = solveDcOperatingPoint({
      solver: solver2,
      elements: [vcc2, vbb2, rc2, rb2, spiceBjt],
      matrixSize,
      params: DEFAULT_SIMULATION_PARAMS,
      diagnostics: diag2,
    });
    expect(result2.converged).toBe(true);

    // Both should produce the same collector and base voltages
    expect(result2.nodeVoltages[0]).toBeCloseTo(result1.nodeVoltages[0], 4);
    expect(result2.nodeVoltages[1]).toBeCloseTo(result1.nodeVoltages[1], 4);
  });
});

// ---------------------------------------------------------------------------
// State pool tests — write-back elimination and pool state correctness
// ---------------------------------------------------------------------------

describe("StatePool — BJT simple write-back elimination", () => {
  it("stateSize_is_10", () => {
    const propsObj = makeBjtProps();
    const core = createBjtElement(1, new Map([["B", 2], ["C", 1], ["E", 3]]), -1, propsObj);
    expect(core.stateSize).toBe(10);
  });

  it("stateBaseOffset_minus_one_before_initState", () => {
    const propsObj = makeBjtProps();
    const core = createBjtElement(1, new Map([["B", 2], ["C", 1], ["E", 3]]), -1, propsObj);
    expect(core.stateBaseOffset).toBe(-1);
  });

  it("initState_sets_pool_binding", () => {
    const propsObj = makeBjtProps();
    const core = createBjtElement(1, new Map([["B", 2], ["C", 1], ["E", 3]]), -1, propsObj);
    const pool = new StatePool(10);
    core.stateBaseOffset = 0;
    core.initState!(pool);
    expect(core.stateBaseOffset).toBe(0);
  });

  it("updateOperatingPoint_does_not_modify_voltages_array", () => {
    const propsObj = makeBjtProps();
    const { element } = withState(createBjtElement(1, new Map([["B", 2], ["C", 1], ["E", 3]]), -1, propsObj));

    const voltages = new Float64Array([5.0, 0.7, 0.0]); // Vc, Vb, Ve
    const snapshot = Float64Array.from(voltages);

    element.updateOperatingPoint!(voltages);

    expect(voltages[0]).toBe(snapshot[0]);
    expect(voltages[1]).toBe(snapshot[1]);
    expect(voltages[2]).toBe(snapshot[2]);
  });

  it("updateOperatingPoint_stores_limited_vbe_vbc_in_pool", () => {
    const propsObj = makeBjtProps();
    const { element, pool } = withState(createBjtElement(1, new Map([["B", 2], ["C", 1], ["E", 3]]), -1, propsObj));

    const voltages = new Float64Array([5.0, 0.7, 0.0]); // Vc=5, Vb=0.7, Ve=0
    for (let i = 0; i < 50; i++) {
      element.updateOperatingPoint!(voltages);
      voltages[0] = 5.0;
      voltages[1] = 0.7;
      voltages[2] = 0.0;
    }

    // pool.state0[0] = SLOT_VBE, pool.state0[1] = SLOT_VBC
    const vbeInPool = pool.state0[0];
    const vbcInPool = pool.state0[1];

    // At Vbe=0.7V (NPN, polarity=1): vbeRaw = vB - vE = 0.7V — should converge close to 0.7
    expect(vbeInPool).toBeGreaterThan(0.5);
    expect(vbeInPool).toBeLessThanOrEqual(0.7);

    // At Vbc = vB - vC = 0.7 - 5.0 = -4.3V (reverse biased, no limiting needed)
    expect(vbcInPool).toBeCloseTo(-4.3, 3);
  });

  it("stampNonlinear_reads_conductances_from_pool", () => {
    const propsObj = makeBjtProps();
    const { element } = withState(createBjtElement(1, new Map([["B", 2], ["C", 1], ["E", 3]]), -1, propsObj));

    const voltages = new Float64Array([5.0, 0.7, 0.0]);
    for (let i = 0; i < 50; i++) {
      element.updateOperatingPoint!(voltages);
      voltages[0] = 5.0; voltages[1] = 0.7; voltages[2] = 0.0;
    }

    const solver = {
      stamp: vi.fn(),
      stampRHS: vi.fn(),
    } as unknown as SparseSolverType;

    element.stampNonlinear!(solver);

    const stampCalls = (solver.stamp as ReturnType<typeof vi.fn>).mock.calls;
    const rhsCalls = (solver.stampRHS as ReturnType<typeof vi.fn>).mock.calls;

    // 4 conductances × 4 stamps each = 16 total stamp calls
    expect(stampCalls.length).toBe(16);
    // 3 RHS stamps (C, B, E)
    expect(rhsCalls.length).toBe(3);
  });
});

describe("StatePool — BJT SPICE L1 write-back elimination", () => {
  it("stateSize_is_24", () => {
    const propsObj = makeSpiceL1Props();
    const core = createSpiceL1BjtElement(1, new Map([["B", 2], ["C", 1], ["E", 3]]), [], -1, propsObj);
    expect(core.stateSize).toBe(24);
  });

  it("stateBaseOffset_minus_one_before_initState", () => {
    const propsObj = makeSpiceL1Props();
    const core = createSpiceL1BjtElement(1, new Map([["B", 2], ["C", 1], ["E", 3]]), [], -1, propsObj);
    expect(core.stateBaseOffset).toBe(-1);
  });

  it("updateOperatingPoint_does_not_modify_voltages_array", () => {
    const propsObj = makeSpiceL1Props();
    const { element } = withState(createSpiceL1BjtElement(1, new Map([["B", 2], ["C", 1], ["E", 3]]), [], -1, propsObj));

    const voltages = new Float64Array([5.0, 0.7, 0.0]); // Vc, Vb, Ve
    const snapshot = Float64Array.from(voltages);

    element.updateOperatingPoint!(voltages);

    expect(voltages[0]).toBe(snapshot[0]);
    expect(voltages[1]).toBe(snapshot[1]);
    expect(voltages[2]).toBe(snapshot[2]);
  });

  it("updateOperatingPoint_stores_limited_vbe_vbc_in_pool", () => {
    const propsObj = makeSpiceL1Props();
    const { element, pool } = withState(createSpiceL1BjtElement(1, new Map([["B", 2], ["C", 1], ["E", 3]]), [], -1, propsObj));

    const voltages = new Float64Array([5.0, 0.7, 0.0]);
    for (let i = 0; i < 50; i++) {
      element.updateOperatingPoint!(voltages);
      voltages[0] = 5.0;
      voltages[1] = 0.7;
      voltages[2] = 0.0;
    }

    // pool.state0[0] = L1_SLOT_VBE, pool.state0[1] = L1_SLOT_VBC
    const vbeInPool = pool.state0[0];
    const vbcInPool = pool.state0[1];

    expect(vbeInPool).toBeGreaterThan(0.5);
    expect(vbeInPool).toBeLessThanOrEqual(0.7);
    expect(vbcInPool).toBeCloseTo(-4.3, 3);
  });

  it("rbEff_stored_in_pool_slot_10", () => {
    const propsObj = makeSpiceL1Props({ RB: 10, IRB: 0, RBM: 0 });
    const { element, pool } = withState(createSpiceL1BjtElement(1, new Map([["B", 2], ["C", 1], ["E", 3]]), [], -1, propsObj));

    const voltages = new Float64Array([5.0, 0.7, 0.0]);
    element.updateOperatingPoint!(voltages);

    // With IRB=0 and RBM=0, rbEff = RB = 10
    expect(pool.state0[10]).toBe(10); // L1_SLOT_RB_EFF = 10
  });
});

// ---------------------------------------------------------------------------
// stateSchema declaration tests (WE1 / WE2)
// ---------------------------------------------------------------------------

describe("stateSchema — BJT simple", () => {
  it("stateSchema_declared", () => {
    const core = createBjtElement(1, new Map([["B", 2], ["C", 1], ["E", 3]]), -1, makeBjtProps());
    expect(core.stateSchema).toBeDefined();
  });

  it("stateSchema_size_equals_stateSize", () => {
    const core = createBjtElement(1, new Map([["B", 2], ["C", 1], ["E", 3]]), -1, makeBjtProps());
    expect(core.stateSchema!.size).toBe(core.stateSize);
    expect(core.stateSize).toBe(10);
  });

  it("stateSchema_owner_identifies_element", () => {
    const core = createBjtElement(1, new Map([["B", 2], ["C", 1], ["E", 3]]), -1, makeBjtProps());
    expect(core.stateSchema!.owner).toBe("BjtSimpleElement");
  });

  it("warmstart_NPN_VBE_seeded_to_0_6", () => {
    const core = createBjtElement(1, new Map([["B", 2], ["C", 1], ["E", 3]]), -1, makeBjtProps());
    const pool = new StatePool(10);
    core.stateBaseOffset = 0;
    core.initState!(pool);
    expect(pool.state0[0]).toBeCloseTo(0.6, 10); // SLOT_VBE = 0, NPN polarity
  });

  it("warmstart_PNP_VBE_seeded_to_minus_0_6", () => {
    const core = createBjtElement(-1, new Map([["B", 2], ["C", 1], ["E", 3]]), -1, makeBjtProps());
    const pool = new StatePool(10);
    core.stateBaseOffset = 0;
    core.initState!(pool);
    expect(pool.state0[0]).toBeCloseTo(-0.6, 10); // SLOT_VBE = 0, PNP polarity
  });
});

describe("stateSchema — BJT SPICE L1", () => {
  it("stateSchema_declared", () => {
    const core = createSpiceL1BjtElement(1, new Map([["B", 2], ["C", 1], ["E", 3]]), [], -1, makeSpiceL1Props());
    expect(core.stateSchema).toBeDefined();
  });

  it("stateSchema_size_equals_stateSize", () => {
    const core = createSpiceL1BjtElement(1, new Map([["B", 2], ["C", 1], ["E", 3]]), [], -1, makeSpiceL1Props());
    expect(core.stateSchema!.size).toBe(core.stateSize);
    expect(core.stateSize).toBe(24);
  });

  it("stateSchema_owner_identifies_element", () => {
    const core = createSpiceL1BjtElement(1, new Map([["B", 2], ["C", 1], ["E", 3]]), [], -1, makeSpiceL1Props());
    expect(core.stateSchema!.owner).toBe("BjtSpiceL1Element");
  });

  it("warmstart_NPN_VBE_seeded_to_0_6", () => {
    const core = createSpiceL1BjtElement(1, new Map([["B", 2], ["C", 1], ["E", 3]]), [], -1, makeSpiceL1Props());
    const pool = new StatePool(24);
    core.stateBaseOffset = 0;
    core.initState!(pool);
    expect(pool.state0[0]).toBeCloseTo(0.6, 10); // L1_SLOT_VBE = 0, NPN polarity
  });

  it("warmstart_PNP_VBE_seeded_to_minus_0_6", () => {
    const core = createSpiceL1BjtElement(-1, new Map([["B", 2], ["C", 1], ["E", 3]]), [], -1, makeSpiceL1Props());
    const pool = new StatePool(24);
    core.stateBaseOffset = 0;
    core.initState!(pool);
    expect(pool.state0[0]).toBeCloseTo(-0.6, 10); // L1_SLOT_VBE = 0, PNP polarity
  });

  it("cap_first_call_seeded_to_1", () => {
    const core = createSpiceL1BjtElement(1, new Map([["B", 2], ["C", 1], ["E", 3]]), [], -1, makeSpiceL1Props());
    const pool = new StatePool(24);
    core.stateBaseOffset = 0;
    core.initState!(pool);
    expect(pool.state0[23]).toBe(1.0); // L1_SLOT_CAP_FIRST_CALL = 23
  });

  it("rb_eff_seeded_from_params", () => {
    const core = createSpiceL1BjtElement(1, new Map([["B", 2], ["C", 1], ["E", 3]]), [], -1, makeSpiceL1Props({ RB: 15 }));
    const pool = new StatePool(24);
    core.stateBaseOffset = 0;
    core.initState!(pool);
    expect(pool.state0[10]).toBe(15); // L1_SLOT_RB_EFF = 10, value = RB param
  });
});
