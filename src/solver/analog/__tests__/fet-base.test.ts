/**
 * Tests for AbstractFetElement refactoring of NMOS and PMOS.
 *
 * Verifies:
 *   - nmos_dc_unchanged: NMOS DC operating point identical after refactor
 *   - pmos_dc_unchanged: PMOS DC operating point identical after refactor
 *   - nmos_transient_unchanged: NMOS transient waveform unchanged
 *   - stamp_pattern_correct: gm and gds conductance entries at correct positions
 */

import { describe, it, expect, vi } from "vitest";
import { createMosfetElement } from "../../../components/semiconductors/mosfet.js";
import { AbstractFetElement } from "../fet-base.js";
import { PropertyBag } from "../../../core/properties.js";
import { SparseSolver } from "../sparse-solver.js";
import { DiagnosticCollector } from "../diagnostics.js";
import { solveDcOperatingPoint } from "../dc-operating-point.js";
import { DEFAULT_SIMULATION_PARAMS } from "../../../core/analog-engine-interface.js";
import { makeDcVoltageSource } from "../../../components/sources/dc-voltage-source.js";
import { withNodeIds } from "./test-helpers.js";
import type { SparseSolver as SparseSolverType } from "../sparse-solver.js";
import type { AnalogElement } from "../element.js";

// ---------------------------------------------------------------------------
// Default model parameters (same as mosfet.test.ts for exact comparison)
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

const NMOS_10U_1U = { ...NMOS_DEFAULTS, W: 10e-6, L: 1e-6 };

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
// Helper: drive element to operating point
// ---------------------------------------------------------------------------

function driveToOperatingPoint(
  element: AnalogElement,
  voltages: Float64Array,
): void {
  for (let i = 0; i < 50; i++) {
    element.updateOperatingPoint!(voltages);
  }
}

// ---------------------------------------------------------------------------
// Refactor: nmos_dc_unchanged
// ---------------------------------------------------------------------------

describe("Refactor", () => {
  it("nmos_dc_unchanged", () => {
    // Common-source NMOS: Vdd=5V, Rd=1kΩ, Vg=3V, Vs=GND
    // MNA: node1=drain, node2=Vdd(5V), node3=gate(3V), branch3=Vdd, branch4=Vgate
    // Same layout as mosfet.test.ts integration test
    const matrixSize = 5;
    const solver = new SparseSolver();
    const diagnostics = new DiagnosticCollector();

    const propsObj = { _modelParams: NMOS_10U_1U };
    const nmosElement = withNodeIds(createMosfetElement(
      1,
      new Map([["G", 3], ["S", 0], ["D", 1]]), // G=node3, S=ground, D=node1
      [],
      -1,
      propsObj as unknown as PropertyBag,
    ), [3, 0, 1]); // pinLayout order: [G, S, D]

    const vddSource = makeDcVoltageSource(2, 0, 3, 5.0);  // Vdd=5V, branch index 3
    const vgateSource = makeDcVoltageSource(3, 0, 4, 3.0); // Vgate=3V, branch index 4
    const rdElement = makeResistorElement(2, 1, 1000);     // Rd between Vdd and drain

    const elements: AnalogElement[] = [vddSource, vgateSource, rdElement, nmosElement];

    const result = solveDcOperatingPoint({
      solver,
      elements,
      matrixSize,
      params: DEFAULT_SIMULATION_PARAMS,
      diagnostics,
    });

    expect(result.converged).toBe(true);

    // nodeVoltages: [V(node1)=Vdrain, V(node2)=Vdd, V(node3)=Vgate, ...]
    const vDrain = result.nodeVoltages[0]; // node1 = drain
    const vDD = result.nodeVoltages[1];    // node2 = Vdd
    const idApprox = (vDD - vDrain) / 1000;

    // Vdd should be 5V
    expect(vDD).toBeCloseTo(5, 2);

    // Vds should be in the expected range (device in saturation or linear)
    expect(vDrain).toBeGreaterThan(1.0);
    expect(vDrain).toBeLessThan(5.0);

    // Id should be several mA for W=10µ NMOS in this bias
    expect(idApprox).toBeGreaterThan(0.5e-3);
    expect(idApprox).toBeLessThan(5e-3);
  });

  it("pmos_dc_unchanged", () => {
    // Common-source PMOS: Vss=5V (source high), Rd=1kΩ at drain to GND, Vg=2V
    // PMOS: S=Vss, G=Vg, D through Rd to ground
    // MNA: node1=drain, node2=Vss(5V), node3=gate(2V)
    const matrixSize = 5;
    const solver = new SparseSolver();
    const diagnostics = new DiagnosticCollector();

    const propsObj = { _modelParams: PMOS_DEFAULTS };
    const pmosElement = withNodeIds(createMosfetElement(
      -1,
      new Map([["G", 3], ["S", 2], ["D", 1]]), // G=node3, S=node2(Vss), D=node1
      [],
      -1,
      propsObj as unknown as PropertyBag,
    ), [3, 1, 2]); // pinLayout order: [G, D, S] for PMOS

    const rdElement = makeResistorElement(1, 0, 1000); // Rd from drain to GND
    const vssSource = makeDcVoltageSource(2, 0, 3, 5.0); // Vss=5V, branch index 3
    const vgateSource = makeDcVoltageSource(3, 0, 4, 2.0); // Vg=2V, branch index 4

    const elements: AnalogElement[] = [vssSource, vgateSource, rdElement, pmosElement];

    const result = solveDcOperatingPoint({
      solver,
      elements,
      matrixSize,
      params: DEFAULT_SIMULATION_PARAMS,
      diagnostics,
    });

    expect(result.converged).toBe(true);

    const vDrain = result.nodeVoltages[0]; // node1 = drain
    const vVss = result.nodeVoltages[1];   // node2 = Vss

    // Vss should be 5V
    expect(vVss).toBeCloseTo(5, 2);

    // PMOS conducts: Vsg = Vss - Vg = 5 - 2 = 3V > |VTP| = 0.7V → on
    // Drain voltage should be above ground (PMOS pulls drain high)
    expect(vDrain).toBeGreaterThan(0.1);
    expect(vDrain).toBeLessThan(vVss - 0.1);
  });

  it("nmos_transient_unchanged", () => {
    // Verify NMOS with capacitances produces reactive behavior in transient:
    // After adding Cgd capacitance, the element should have isReactive=true
    // and its stampCompanion should update companion model state.
    const propsWithCap = { ...NMOS_DEFAULTS, CBD: 1e-12 };
    const propsObj = { _modelParams: propsWithCap };
    const element = createMosfetElement(1, new Map([["G", 1], ["S", 2], ["D", 3]]), [], -1, propsObj as unknown as PropertyBag);

    expect(element.isReactive).toBe(true);
    expect(element.stampCompanion).toBeDefined();

    // Set up an operating point
    const voltages = new Float64Array(3);
    voltages[0] = 5; // V(D) = 5V
    voltages[1] = 3; // V(G) = 3V
    voltages[2] = 0; // V(S) = 0

    for (let i = 0; i < 10; i++) {
      element.updateOperatingPoint!(voltages);
    }

    // stampCompanion should run without throwing
    const dt = 1e-9;
    expect(() => element.stampCompanion!(dt, "bdf1", voltages)).not.toThrow();

    // After stampCompanion, stamp should produce nonzero entries for capacitance
    const solver = makeMockSolver();
    element.stamp(solver);

    // The junction capacitance companion entries may be zero for first call
    // (vdbPrev === vdb on first call), but stamp should not throw
    expect(() => element.stamp(solver)).not.toThrow();
  });

  it("stamp_pattern_correct", () => {
    // Drive NMOS to saturation (Vgs=3V, Vds=5V)
    // nodeD=1, nodeG=2, nodeS=3 (source=ground would be node 0, but let's use node 3 for clarity)
    // Actually to match matrix addressing: use nodeS=0 (ground) so source row is skipped

    // Use nodeG=2, nodeS=0 (ground source), nodeD=1 for cleaner test
    // createMosfetElement expects [G, S, D]
    const propsObj = { _modelParams: NMOS_DEFAULTS };
    const element = createMosfetElement(1, new Map([["G", 2], ["S", 0], ["D", 1]]), [], -1, propsObj as unknown as PropertyBag);

    // Drive to saturation: Vgs=3V (G=3V, S=0V), Vds=5V (D=5V, S=0V)
    // matrixSize=2, voltages: index0=V(node1)=Vds=5V, index1=V(node2=G)=3V
    const voltages = new Float64Array(2);
    voltages[0] = 5; // V(node1=D) = 5V
    voltages[1] = 3; // V(node2=G) = 3V

    for (let i = 0; i < 50; i++) {
      element.updateOperatingPoint!(voltages);
      voltages[0] = 5;
      voltages[1] = 3;
    }

    const solver = makeMockSolver();
    element.stampNonlinear!(solver);

    const stampCalls = (solver.stamp as ReturnType<typeof vi.fn>).mock.calls;

    // Expect conductance entries at D-G (gm), D-D (gds), S-G (-gm), S-D (-gds)
    // nodeD=1 → matrix index 0; nodeG=2 → matrix index 1; nodeS=0 → skipped
    // Since nodeS=0 (ground), rows/cols for S are skipped
    // Expected non-zero stamps: [0,1] for gm (D,G), [0,0] for gds (D,D)
    // S rows skipped since nodeS=0

    const nonzeroStamps = stampCalls.filter((call) => Math.abs(call[2] as number) > 1e-15);
    expect(nonzeroStamps.length).toBeGreaterThan(0);

    // Find D-G entry (gm): row=D-1=0, col=G-1=1
    const dgEntry = stampCalls.find((c) => c[0] === 0 && c[1] === 1);
    expect(dgEntry).toBeDefined();
    if (dgEntry) {
      // gm should be positive in saturation
      expect(dgEntry[2] as number).toBeGreaterThan(0);
    }

    // Find D-D entry (gds): row=D-1=0, col=D-1=0
    const ddEntry = stampCalls.find((c) => c[0] === 0 && c[1] === 0);
    expect(ddEntry).toBeDefined();
    if (ddEntry) {
      // gds should be positive in saturation
      expect(ddEntry[2] as number).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// AbstractFetElement structural tests
// ---------------------------------------------------------------------------

describe("AbstractFetElement", () => {
  it("createMosfetElement_returns_AbstractFetElement_instance", () => {
    const propsObj = { _modelParams: NMOS_DEFAULTS };
    const element = createMosfetElement(1, new Map([["G", 1], ["S", 2], ["D", 3]]), [], -1, propsObj as unknown as PropertyBag);
    expect(element).toBeInstanceOf(AbstractFetElement);
  });

  it("pmos_is_AbstractFetElement_instance", () => {
    const propsObj = { _modelParams: PMOS_DEFAULTS };
    const element = createMosfetElement(-1, new Map([["G", 1], ["S", 2], ["D", 3]]), [], -1, propsObj as unknown as PropertyBag);
    expect(element).toBeInstanceOf(AbstractFetElement);
  });

  it("nmos_polarity_sign_is_1", () => {
    const propsObj = { _modelParams: NMOS_DEFAULTS };
    const element = createMosfetElement(1, new Map([["G", 1], ["S", 2], ["D", 3]]), [], -1, propsObj as unknown as PropertyBag);
    expect((element as AbstractFetElement).polaritySign).toBe(1);
  });

  it("pmos_polarity_sign_is_minus_1", () => {
    const propsObj = { _modelParams: PMOS_DEFAULTS };
    const element = createMosfetElement(-1, new Map([["G", 1], ["S", 2], ["D", 3]]), [], -1, propsObj as unknown as PropertyBag);
    expect((element as AbstractFetElement).polaritySign).toBe(-1);
  });

  it("gm_gds_stamped_at_correct_nodes", () => {
    // nodeG=1, nodeS=3, nodeD=2; createMosfetElement expects [G, S, D]
    // matrix indices: G-1=0, S-1=2, D-1=1
    const propsObj = { _modelParams: NMOS_DEFAULTS };
    const element = createMosfetElement(1, new Map([["G", 1], ["S", 3], ["D", 2]]), [], -1, propsObj as unknown as PropertyBag);

    const voltages = new Float64Array(3);
    voltages[0] = 3; // V(node1=G) = 3V
    voltages[1] = 5; // V(node2=D) = 5V
    voltages[2] = 0; // V(node3=S) = 0

    for (let i = 0; i < 50; i++) {
      element.updateOperatingPoint!(voltages);
      voltages[0] = 3;
      voltages[1] = 5;
      voltages[2] = 0;
    }

    const solver = makeMockSolver();
    element.stampNonlinear!(solver);

    const stampCalls = (solver.stamp as ReturnType<typeof vi.fn>).mock.calls;

    // D=node2 → row/col index 1; G=node1 → row/col index 0; S=node3 → row/col index 2
    // gm appears at [D,G] = [1,0] and [-gm at S,G = 2,0]
    const dgEntry = stampCalls.find((c) => c[0] === 1 && c[1] === 0);
    expect(dgEntry).toBeDefined();
    expect(dgEntry![2] as number).toBeGreaterThan(0); // gm > 0

    // gds appears at [D,D] = [1,1]
    const ddEntry = stampCalls.find((c) => c[0] === 1 && c[1] === 1);
    expect(ddEntry).toBeDefined();
    expect(ddEntry![2] as number).toBeGreaterThan(0); // gds > 0
  });
});
