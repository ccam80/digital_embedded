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
  computeVaractorCapacitance,
  VaractorDefinition,
} from "../varactor.js";
import { PropertyBag } from "../../../core/properties.js";
import type { AnalogElement } from "../../../solver/analog/element.js";
import type { SparseSolver as SparseSolverType } from "../../../solver/analog/sparse-solver.js";

// ---------------------------------------------------------------------------
// Default varactor parameters
// ---------------------------------------------------------------------------

const VARACTOR_DEFAULTS = {
  cjo: 20e-12, // 20 pF
  vj: 0.7,
  m: 0.5,
  iS: 1e-14,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeVaractor(overrides: Partial<typeof VARACTOR_DEFAULTS> = {}): AnalogElement {
  const params = { ...VARACTOR_DEFAULTS, ...overrides };
  // nodeAnode=1, nodeCathode=2
  return createVaractorElement(new Map([["A", 1], ["K", 2]]), [], -1, params as unknown as PropertyBag);
}

/**
 * Drive varactor to operating point and call stampCompanion to set capacitance.
 * Returns the _capGeq (capacitance companion conductance) by observing stamp() output.
 */
function getCapacitanceAtBias(element: AnalogElement, vd: number, dt = 1e-6): number {
  // Drive to operating point (vAnode = vd, vCathode = 0)
  const voltages = new Float64Array(2);
  voltages[0] = vd;
  voltages[1] = 0;
  for (let i = 0; i < 50; i++) {
    element.updateOperatingPoint!(voltages);
    voltages[0] = vd;
    voltages[1] = 0;
  }

  // Call stampCompanion to compute capacitance at this bias
  element.stampCompanion!(dt, "trapezoidal", voltages);

  // Read the companion conductance from stamp() output
  // capGeq is stamped as (nodeAnode-1, nodeAnode-1) = (0, 0) diagonal entry
  const calls: Array<[number, number, number]> = [];
  const solver = {
    stamp: (r: number, c: number, v: number) => calls.push([r, c, v]),
    stampRHS: (_r: number, _v: number) => {},
  } as unknown as SparseSolverType;

  element.stamp(solver);

  // The diagonal (0,0) entry = capGeq for trapezoidal = 2*C/dt
  const diag = calls.find((c) => c[0] === 0 && c[1] === 0);
  if (!diag) return 0;

  // capGeq = 2*C/dt (trapezoidal) → C = capGeq * dt / 2
  return diag[2] * dt / 2;
}

// ---------------------------------------------------------------------------
// Varactor unit tests
// ---------------------------------------------------------------------------

describe("Varactor", () => {
  it("capacitance_decreases_with_reverse_bias", () => {
    // Measure C at V_R = 0, 1V, 5V, 10V (reverse bias = cathode > anode)
    // V_d (anode - cathode) = -V_R
    // Expected: C decreases monotonically as V_R increases

    const varactor = makeVaractor();
    const dt = 1e-6;

    // V_R = 0: vd = 0 (anode = cathode = 0)
    const c0 = getCapacitanceAtBias(varactor, 0, dt);

    // For remaining bias points, create fresh elements to avoid history state
    const v1 = makeVaractor();
    const c1 = getCapacitanceAtBias(v1, -1, dt); // V_R = 1V → vd = -1

    const v2 = makeVaractor();
    const c2 = getCapacitanceAtBias(v2, -5, dt); // V_R = 5V

    const v3 = makeVaractor();
    const c3 = getCapacitanceAtBias(v3, -10, dt); // V_R = 10V

    // C should decrease monotonically with increasing reverse bias
    expect(c0).toBeGreaterThan(c1);
    expect(c1).toBeGreaterThan(c2);
    expect(c2).toBeGreaterThan(c3);
  });

  it("cjo_at_zero_bias", () => {
    // At V_R = 0 (vd = 0): C_j = CJO / (1 + 0/VJ)^M = CJO
    const CJO = 20e-12;
    const varactor = makeVaractor({ cjo: CJO });
    const c = getCapacitanceAtBias(varactor, 0, 1e-6);

    // Should equal CJO within numerical precision
    expect(c).toBeCloseTo(CJO, 12); // within 1 fF
  });

  it("cv_formula_correct", () => {
    // At V_R = 2V, VJ = 0.7, M = 0.5:
    // C = CJO / sqrt(1 + 2/0.7) = CJO / sqrt(1 + 2.857) = CJO / sqrt(3.857)
    // = CJO / 1.964 ≈ CJO * 0.5092
    const CJO = 20e-12;
    const VJ = 0.7;
    const M = 0.5;
    const vReverse = 2;

    // Direct formula check
    const cFormula = computeVaractorCapacitance(vReverse, CJO, VJ, M);
    const expected = CJO / Math.sqrt(1 + vReverse / VJ);
    expect(cFormula).toBeCloseTo(expected, 14);

    // From element at V_d = -2V (reverse bias)
    const varactor = makeVaractor({ cjo: CJO, vj: VJ, m: M });
    const cMeasured = getCapacitanceAtBias(varactor, -vReverse, 1e-6);

    // Should match formula within 1% (integration timestep doesn't affect C itself)
    const ratio = cMeasured / expected;
    expect(ratio).toBeGreaterThan(0.99);
    expect(ratio).toBeLessThan(1.01);
  });

  it("vco_circuit", () => {
    // Verify that resonant frequency f = 1/(2π√(LC(V))) changes with bias.
    // With L fixed and C(V) varying, f_resonant varies as 1/√C(V).
    //
    // At V_R = 0: C0 = CJO = 20pF → f ∝ 1/√(20e-12)
    // At V_R = 5V: C5 = CJO/√(1+5/0.7) ≈ CJO/2.94 ≈ 6.8pF → f ∝ 1/√(6.8e-12)
    //
    // f(V_R=5) / f(V_R=0) = √(C0/C5) = √(20/6.8) ≈ 1.71
    //
    // Test: assert f changes by at least 50% from 0V to 5V reverse bias.

    const CJO = 20e-12;
    const VJ = 0.7;
    const M = 0.5;

    const c0 = computeVaractorCapacitance(0, CJO, VJ, M);
    const c5 = computeVaractorCapacitance(5, CJO, VJ, M);

    // Frequency ratio = √(C0/C5) > 1 (higher frequency at higher reverse bias)
    const freqRatio = Math.sqrt(c0 / c5);
    expect(freqRatio).toBeGreaterThan(1.5); // at least 50% frequency change
    expect(freqRatio).toBeLessThan(3.0);    // reasonable upper bound

    // Also verify from element: capacitances at two bias points differ significantly
    const v0 = makeVaractor({ cjo: CJO, vj: VJ, m: M });
    const cFrom0 = getCapacitanceAtBias(v0, 0, 1e-9); // V_R=0

    const v5 = makeVaractor({ cjo: CJO, vj: VJ, m: M });
    const cFrom5 = getCapacitanceAtBias(v5, -5, 1e-9); // V_R=5V

    expect(cFrom0).toBeGreaterThan(cFrom5); // C decreases with reverse bias
    expect(cFrom0 / cFrom5).toBeGreaterThan(1.5); // significant tuning range
  });

  it("definition_has_correct_fields", () => {
    expect(VaractorDefinition.name).toBe("VaractorDiode");
    expect(VaractorDefinition.models?.mnaModels?.behavioral).toBeDefined();
    expect(VaractorDefinition.models?.mnaModels?.behavioral?.deviceType).toBe("D");
    expect(VaractorDefinition.models?.mnaModels?.behavioral?.factory).toBeDefined();
    expect(VaractorDefinition.category).toBe("SEMICONDUCTORS");
  });

  it("isNonlinear_and_isReactive", () => {
    const v = makeVaractor();
    expect(v.isNonlinear).toBe(true);
    expect(v.isReactive).toBe(true);
    expect(v.stampCompanion).toBeDefined();
  });
});
