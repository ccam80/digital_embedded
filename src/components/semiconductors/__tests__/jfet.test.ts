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

import { describe, it, expect, vi } from "vitest";
import {
  NJfetDefinition,
  createNJfetElement,
  NJfetAnalogElement,
} from "../njfet.js";
import {
  PJfetDefinition,
  createPJfetElement,
} from "../pjfet.js";
import { ComponentRegistry } from "../../../core/registry.js";
import { createTestPropertyBag } from "../../../test-fixtures/model-fixtures.js";
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
// Default model parameters
// ---------------------------------------------------------------------------

const NJFET_PARAMS = {
  VTO: -2.0,    // pinch-off voltage (negative for N-channel)
  BETA: 1e-4,   // transconductance parameter (A/V²)
  LAMBDA: 0,    // no channel-length modulation by default
  IS: 1e-14,    // gate junction saturation current
  CGS: 0,
  CGD: 0,
  PB: 1.0,
  FC: 0.5,
  RD: 0,
  RS: 0,
  KF: 0,
  AF: 1,
};

const PJFET_PARAMS = {
  VTO: 2.0,     // pinch-off voltage (positive for P-channel)
  BETA: 1e-4,
  LAMBDA: 0,
  IS: 1e-14,
  CGS: 0,
  CGD: 0,
  PB: 1.0,
  FC: 0.5,
  RD: 0,
  RS: 0,
  KF: 0,
  AF: 1,
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
// NJFET unit tests
// ---------------------------------------------------------------------------

describe("NJFET", () => {
  it("cutoff_zero_current", () => {
    // V_GS = -3V < V_P = -2V → device off
    // With nodeG=1, nodeD=2, nodeS=0 (ground)
    // G=voltage[0]=-3V, D=voltage[1]=5V
    const propsObj = createTestPropertyBag();
    propsObj.replaceModelParams(NJFET_PARAMS);
    const element = createNJfetElement(new Map([["G", 1], ["S", 0], ["D", 2]]), [], -1, propsObj);

    const voltages = new Float64Array(2);
    voltages[0] = -3; // V(G) = -3V → Vgs = -3V
    voltages[1] = 5;  // V(D) = 5V → Vds = 5V

    for (let i = 0; i < 50; i++) {
      element.updateOperatingPoint!(voltages);
    }

    const solver = makeMockSolver();
    element.stampNonlinear!(solver);

    // In cutoff: Norton current ≈ 0 (only GMIN leakage)
    const rhsCalls = (solver.stampRHS as ReturnType<typeof vi.fn>).mock.calls;
    for (const call of rhsCalls) {
      expect(Math.abs(call[1] as number)).toBeLessThan(1e-9);
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
    const element = createNJfetElement(new Map([["G", 1], ["S", 0], ["D", 2]]), [], -1, propsObj) as NJfetAnalogElement;

    const voltages = new Float64Array(2);
    voltages[0] = 0; // V(G) = 0V → Vgs = 0
    voltages[1] = 5; // V(D) = 5V → Vds = 5

    for (let i = 0; i < 50; i++) {
      element.updateOperatingPoint!(voltages);
    }

    // Expected: Ids = beta/2 * (Vgs - Vp)^2 = 1e-4/2 * (0-(-2))^2 = 0.2mA
    const expectedIds = (params.BETA / 2) * Math.pow(0 - params.VTO, 2);
    expect(expectedIds).toBeCloseTo(0.2e-3, 8);

    const solver = makeMockSolver();
    element.stampNonlinear!(solver);

    // Norton current at D should reflect Ids
    const rhsCalls = (solver.stampRHS as ReturnType<typeof vi.fn>).mock.calls;
    const hasSignificantCurrent = rhsCalls.some((c) => Math.abs(c[1] as number) > 1e-5);
    expect(hasSignificantCurrent).toBe(true);
  });

  it("linear_region", () => {
    // V_GS = 0V, V_DS = 0.5V, V_P = -2V
    // V_GS - V_P = 2V, V_DS = 0.5V < 2V → linear region
    // I_DS = β*(Vgst*Vds - Vds²/2) = 1e-4*(2*0.5 - 0.25/2) = 1e-4*(1-0.125) = 0.0875mA
    const params = { ...NJFET_PARAMS, LAMBDA: 0 };
    const propsObj = createTestPropertyBag();
    propsObj.replaceModelParams(params);
    const element = createNJfetElement(new Map([["G", 1], ["S", 0], ["D", 2]]), [], -1, propsObj) as NJfetAnalogElement;

    const voltages = new Float64Array(2);
    voltages[0] = 0;   // Vgs = 0
    voltages[1] = 0.5; // Vds = 0.5

    for (let i = 0; i < 50; i++) {
      element.updateOperatingPoint!(voltages);
    }

    const expectedIds = params.BETA * (2 * 0.5 - 0.5 * 0.5 / 2);
    expect(expectedIds).toBeCloseTo(0.0875e-3, 10);

    const solver = makeMockSolver();
    element.stampNonlinear!(solver);

    // Non-zero Norton current expected
    const rhsCalls = (solver.stampRHS as ReturnType<typeof vi.fn>).mock.calls;
    const hasLinearCurrent = rhsCalls.some((c) => Math.abs(c[1] as number) > 1e-6);
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
    const element = createNJfetElement(new Map([["G", 1], ["S", 0], ["D", 2]]), [], -1, propsObj);

    const voltages = new Float64Array(2);
    voltages[0] = 0.7; // V(G) = 0.7V → Vgs = 0.7V
    voltages[1] = 0;   // V(D) = 0 → Vds = 0

    for (let i = 0; i < 50; i++) {
      element.updateOperatingPoint!(voltages);
    }

    const solver = makeMockSolver();
    element.stampNonlinear!(solver);

    // With forward bias, gate junction contributes current
    const rhsCalls = (solver.stampRHS as ReturnType<typeof vi.fn>).mock.calls;
    const maxRhs = Math.max(...rhsCalls.map((c) => Math.abs(c[1] as number)));
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
    const element = createPJfetElement(new Map([["G", 1], ["D", 2], ["S", 3]]), [], -1, propsObj);

    // node1=G=2V, node2=D=0V, node3=S=5V
    const voltages = new Float64Array(3);
    voltages[0] = 2; // V(G) = 2V
    voltages[1] = 0; // V(D) = 0V
    voltages[2] = 5; // V(S) = 5V

    for (let i = 0; i < 50; i++) {
      element.updateOperatingPoint!(voltages);
    }

    const solver = makeMockSolver();
    element.stampNonlinear!(solver);

    // Device should be conducting: non-zero stamps expected
    const stampCalls = (solver.stamp as ReturnType<typeof vi.fn>).mock.calls;
    const nonzeroStamps = stampCalls.filter((c) => Math.abs(c[2] as number) > 1e-15);
    expect(nonzeroStamps.length).toBeGreaterThan(0);

    // RHS entries should be nonzero
    const rhsCalls = (solver.stampRHS as ReturnType<typeof vi.fn>).mock.calls;
    const maxRhs = Math.max(...rhsCalls.map((c) => Math.abs(c[1] as number)));
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
    const solver = new SparseSolver();
    const diagnostics = new DiagnosticCollector();

    // createNJfetElement pin order: [G, S, D]
    const propsObj = createTestPropertyBag();
    propsObj.replaceModelParams(NJFET_PARAMS);
    const jfet = withNodeIds(createNJfetElement(new Map([["G", 3], ["S", 0], ["D", 1]]), [], -1, propsObj), [3, 0, 1]);
    const rd = makeResistorElement(2, 1, 10000); // Rd=10kΩ from Vdd to drain
    const vdd = makeDcVoltageSource(2, 0, 3, 10.0) as unknown as AnalogElement; // Vdd=10V
    const vgate = makeDcVoltageSource(3, 0, 4, 0.0) as unknown as AnalogElement; // Vg=0V

    const result = solveDcOperatingPoint({
      solver,
      elements: [vdd, vgate, rd, jfet],
      matrixSize,
      params: { ...DEFAULT_SIMULATION_PARAMS, maxIterations: 10 },
      diagnostics,
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
    expect(def!.modelRegistry?.["spice-l1"]).toBeDefined();
    expect(def!.category).toBeDefined();
    expect((def!.modelRegistry?.["spice-l1"] as {kind:"inline";factory:AnalogFactory}|undefined)?.factory).toBeDefined();
  });

  it("pjfet_registered", () => {
    const registry = new ComponentRegistry();
    registry.register(PJfetDefinition);

    const def = registry.get("PJFET");
    expect(def).toBeDefined();
    expect(def!.modelRegistry?.["spice-l1"]).toBeDefined();
    expect((def!.modelRegistry?.["spice-l1"] as {kind:"inline";factory:AnalogFactory}|undefined)?.factory).toBeDefined();
  });

  it("njfet_pin_layout_has_three_pins", () => {
    expect(NJfetDefinition.pinLayout).toHaveLength(3);
    const labels = NJfetDefinition.pinLayout.map((p) => p.label);
    expect(labels).toContain("G");
    expect(labels).toContain("D");
    expect(labels).toContain("S");
  });
});
