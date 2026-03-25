/**
 * Tests for the Ideal Op-Amp component.
 *
 * The op-amp uses a linear MNA stamp in the unsaturated region:
 *   G[out,out]  += G_out
 *   G[out,in+]  -= gain * G_out
 *   G[out,in-]  += gain * G_out
 *
 * In saturation, only G_out stamps and a Norton current source drives
 * the output to the rail voltage.
 *
 * Unit tests verify the stamp entries directly.
 * Integration tests verify full DC operating point solutions.
 */

import { describe, it, expect, vi } from "vitest";
import { OpAmpDefinition } from "../opamp.js";
import { PropertyBag } from "../../../core/properties.js";
import { SparseSolver } from "../../../analog/sparse-solver.js";
import { DiagnosticCollector } from "../../../analog/diagnostics.js";
import { solveDcOperatingPoint } from "../../../analog/dc-operating-point.js";
import { DEFAULT_SIMULATION_PARAMS } from "../../../core/analog-engine-interface.js";
import { makeDcVoltageSource } from "../../sources/dc-voltage-source.js";
import { withNodeIds } from "../../../analog/test-elements.js";
import type { AnalogElement } from "../../../analog/element.js";
import type { SparseSolver as SparseSolverType } from "../../../analog/sparse-solver.js";

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
// Helper: create an op-amp element
// ---------------------------------------------------------------------------

function makeOpAmp(opts: {
  nInp?: number;
  nInn?: number;
  nOut?: number;
  nVccP?: number;
  nVccN?: number;
  gain?: number;
  rOut?: number;
}): AnalogElement {
  const {
    nInp = 1,
    nInn = 2,
    nOut = 3,
    nVccP = 4,
    nVccN = 5,
    gain = 1e6,
    rOut = 75,
  } = opts;
  const props = new PropertyBag([
    ["gain", gain],
    ["rOut", rOut],
  ]);
  return OpAmpDefinition.models!.analog!.factory(
    new Map([["in+", nInp], ["in-", nInn], ["out", nOut]]),
    [],
    -1,
    props,
    () => 0,
  );
}

/**
 * Build a solution vector with given node voltages (1-based node IDs).
 */
function makeSolutionVector(
  size: number,
  nodeVoltages: Record<number, number>,
): Float64Array {
  const v = new Float64Array(size);
  for (const [node, voltage] of Object.entries(nodeVoltages)) {
    const n = parseInt(node);
    if (n > 0 && n <= size) {
      v[n - 1] = voltage;
    }
  }
  return v;
}

// ---------------------------------------------------------------------------
// OpAmp unit tests
// ---------------------------------------------------------------------------

describe("OpAmp", () => {
  it("linear_region", () => {
    // In linear region: stamp() places VCVS entries, stampNonlinear() is a no-op.
    // G[out,out] += G_out
    // G[out,in+] -= gain*G_out
    // G[out,in-] += gain*G_out
    const opamp = makeOpAmp({ gain: 1e6, rOut: 75 });
    const G_out = 1 / 75;

    // Set operating point with Vout in linear range (not at rail)
    const voltages = makeSolutionVector(6, {
      1: 1e-6,   // in+
      2: 0,      // in-
      3: 1.0,    // out — within linear range (between -15 and +15)
      4: 15,     // Vcc+
      5: -15,    // Vcc-
    });
    opamp.updateOperatingPoint!(voltages);

    const solver = makeMockSolver();
    opamp.stamp(solver);

    const stampCalls = (solver.stamp as ReturnType<typeof vi.fn>).mock.calls;

    // G_out on out diagonal: stamp(out-1, out-1, G_out) = stamp(2, 2, G_out)
    expect(stampCalls).toContainEqual([2, 2, G_out]);

    // VCVS: G[out, in+] -= gain*G_out → stamp(2, 0, -gain*G_out)
    expect(stampCalls).toContainEqual([2, 0, -1e6 * G_out]);

    // VCVS: G[out, in-] += gain*G_out → stamp(2, 1, +gain*G_out)
    expect(stampCalls).toContainEqual([2, 1, 1e6 * G_out]);

    // stampNonlinear in linear region: no RHS contribution
    const nlSolver = makeMockSolver();
    opamp.stampNonlinear!(nlSolver);
    expect((nlSolver.stampRHS as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("positive_saturation", () => {
    // When Vout >= Vcc+: saturated, stamp omits VCVS, stampNonlinear drives to rail.
    const opamp = makeOpAmp({ gain: 1e6, rOut: 75 });
    const G_out = 1 / 75;

    // Set Vout = 20V > Vcc+ = 15V → saturated
    const voltages = makeSolutionVector(6, {
      1: 1e-3,   // in+
      2: 0,      // in-
      3: 20,     // out — above Vcc+
      4: 15,     // Vcc+
      5: -15,    // Vcc-
    });
    opamp.updateOperatingPoint!(voltages);

    // stamp(): G_out on diagonal only, no VCVS entries
    const stampSolver = makeMockSolver();
    opamp.stamp(stampSolver);
    const stampCalls = (stampSolver.stamp as ReturnType<typeof vi.fn>).mock.calls;
    expect(stampCalls).toContainEqual([2, 2, G_out]);
    // No large Jacobian entries (no VCVS in saturation)
    const hasVcvsEntry = stampCalls.some(
      (c: number[]) => c[0] === 2 && (c[1] === 0 || c[1] === 1) && Math.abs(c[2]) > 1,
    );
    expect(hasVcvsEntry).toBe(false);

    // stampNonlinear(): Norton current to clamp output to Vcc+=15V
    const nlSolver = makeMockSolver();
    opamp.stampNonlinear!(nlSolver);
    const rhsCalls = (nlSolver.stampRHS as ReturnType<typeof vi.fn>).mock.calls;
    const rhsAtOut = rhsCalls.find((c: number[]) => c[0] === 2);
    expect(rhsAtOut).toBeDefined();
    expect(rhsAtOut![1]).toBeCloseTo(15 * G_out, 6);
  });

  it("negative_saturation", () => {
    // When Vout <= Vcc-: saturated, stampNonlinear drives output to Vcc-.
    const opamp = makeOpAmp({ gain: 1e6, rOut: 75 });
    const G_out = 1 / 75;

    // Set Vout = -20V < Vcc- = -15V → saturated
    const voltages = makeSolutionVector(6, {
      1: -1e-3,  // in+
      2: 0,      // in-
      3: -20,    // out — below Vcc-
      4: 15,     // Vcc+
      5: -15,    // Vcc-
    });
    opamp.updateOperatingPoint!(voltages);

    const nlSolver = makeMockSolver();
    opamp.stampNonlinear!(nlSolver);
    const rhsCalls = (nlSolver.stampRHS as ReturnType<typeof vi.fn>).mock.calls;
    const rhsAtOut = rhsCalls.find((c: number[]) => c[0] === 2);
    expect(rhsAtOut).toBeDefined();
    expect(rhsAtOut![1]).toBeCloseTo(-15 * G_out, 6);
  });

  it("output_impedance", () => {
    // Circuit: Vin=2µV fixes in+, in- grounded by VS, R_load=75Ω on output.
    // Vout_open = gain * Vin = 1e6 * 2e-6 = 2V
    // With R_load = R_out = 75Ω: Vout = 2 * R_load/(R_out+R_load) = 1V ± 0.1V
    //
    // MNA: nodes 1..5, branches 5..8 → matrixSize = 9
    //   node 1 = in+, node 2 = in- (grounded via VS), node 3 = out
    //   node 4 = Vcc+, node 5 = Vcc-
    const nInp = 1, nInn = 2, nOut = 3, nVccP = 4, nVccN = 5;
    const brVin = 5, brVinn = 6, brVccP = 7, brVccN = 8;
    const matrixSize = 9;

    const props = new PropertyBag([["gain", 1e6], ["rOut", 75]]);
    const opampEl = withNodeIds(OpAmpDefinition.models!.analog!.factory(
      new Map([["in+", nInp], ["in-", nInn], ["out", nOut]]), [], -1, props, () => 0,
    ), [nInn, nInp, nOut]); // pinLayout order: [in-, in+, out]

    // 75Ω load on output
    const G_load = 1 / 75;
    const rLoadEl: AnalogElement = {
      pinNodeIds: [nOut, 0],
      allNodeIds: [nOut, 0],
      branchIndex: -1, isNonlinear: false, isReactive: false,
      stamp(solver: SparseSolver): void {
        solver.stamp(nOut - 1, nOut - 1, G_load);
      },
    };

    const vinSource  = makeDcVoltageSource(nInp,  0, brVin,  2e-6);
    const vinnSource = makeDcVoltageSource(nInn,  0, brVinn, 0);
    const vccPSource = makeDcVoltageSource(nVccP, 0, brVccP, 15);
    const vccNSource = makeDcVoltageSource(nVccN, 0, brVccN, -15);

    const solver = new SparseSolver();
    const diagnostics = new DiagnosticCollector();
    const result = solveDcOperatingPoint({
      solver,
      elements: [opampEl, rLoadEl, vinSource, vinnSource, vccPSource, vccNSource],
      matrixSize,
      params: DEFAULT_SIMULATION_PARAMS,
      diagnostics,
    });

    expect(result.converged).toBe(true);
    const vOut = result.nodeVoltages[nOut - 1];
    // Vout = 2V * (75/(75+75)) = 1V ± 0.1V
    expect(vOut).toBeCloseTo(1.0, 0);
  });
});

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("Integration", () => {
  function makeResistor(nodeA: number, nodeB: number, resistance: number): AnalogElement {
    const G = 1 / resistance;
    return {
      pinNodeIds: [nodeA, nodeB],
      allNodeIds: [nodeA, nodeB],
      branchIndex: -1, isNonlinear: false, isReactive: false,
      stamp(solver: SparseSolver): void {
        if (nodeA > 0) solver.stamp(nodeA - 1, nodeA - 1, G);
        if (nodeB > 0) solver.stamp(nodeB - 1, nodeB - 1, G);
        if (nodeA > 0 && nodeB > 0) {
          solver.stamp(nodeA - 1, nodeB - 1, -G);
          solver.stamp(nodeB - 1, nodeA - 1, -G);
        }
      },
    };
  }

  it("inverting_amplifier", () => {
    // Inverting amplifier: gain = -Rf/Rin = -10kΩ/1kΩ = -10
    // Vin = 1V → Vout ≈ -10V ± 0.01V
    //
    // Node assignments:
    //   node 1 = Vin terminal
    //   node 2 = in- (inverting, virtual ground)
    //   node 3 = out
    //   node 4 = in+ (grounded via VS)
    //   node 5 = Vcc+
    //   node 6 = Vcc-
    // Branch rows: 6..9 → matrixSize = 10
    const nVin = 1, nInn = 2, nOut = 3, nInp = 4, nVccP = 5, nVccN = 6;
    const brVin = 6, brInp = 7, brVccP = 8, brVccN = 9;
    const matrixSize = 10;

    const props = new PropertyBag([["gain", 1e6], ["rOut", 75]]);
    const opampEl = withNodeIds(OpAmpDefinition.models!.analog!.factory(
      new Map([["in+", nInp], ["in-", nInn], ["out", nOut]]), [], -1, props, () => 0,
    ), [nInn, nInp, nOut]); // pinLayout order: [in-, in+, out]

    const rin = makeResistor(nVin, nInn, 1000);
    const rf  = makeResistor(nInn, nOut, 10000);

    const vsVin  = makeDcVoltageSource(nVin,  0, brVin,  1.0);
    const vsInp  = makeDcVoltageSource(nInp,  0, brInp,  0.0);
    const vsVccP = makeDcVoltageSource(nVccP, 0, brVccP, 15);
    const vsVccN = makeDcVoltageSource(nVccN, 0, brVccN, -15);

    const solver = new SparseSolver();
    const diagnostics = new DiagnosticCollector();
    const result = solveDcOperatingPoint({
      solver,
      elements: [opampEl, rin, rf, vsVin, vsInp, vsVccP, vsVccN],
      matrixSize,
      params: DEFAULT_SIMULATION_PARAMS,
      diagnostics,
    });

    expect(result.converged).toBe(true);
    const vOut = result.nodeVoltages[nOut - 1];
    // Ideal inverting gain = -Rf/Rin = -10 → Vout = -10V ± 0.05V
    expect(vOut).toBeCloseTo(-10, 1);
  });

  it("voltage_follower", () => {
    // Voltage follower: in- connected to out → Vout = Vin = 3.7V ± 0.001V
    //
    // Model: in- and out share the same node (node 2).
    // Node 1 = in+, node 2 = in- = out, node 3 = Vcc+, node 4 = Vcc-
    // Branches: brVin=4, brVccP=5, brVccN=6 → matrixSize = 7
    const nInp = 1, nFeedback = 2, nVccP = 3, nVccN = 4;
    const brVin = 4, brVccP = 5, brVccN = 6;
    const matrixSize = 7;

    const props = new PropertyBag([["gain", 1e6], ["rOut", 75]]);
    // in- and out share nFeedback (voltage follower)
    const opampEl = withNodeIds(OpAmpDefinition.models!.analog!.factory(
      new Map([["in+", nInp], ["in-", nFeedback], ["out", nFeedback]]), [], -1, props, () => 0,
    ), [nFeedback, nInp, nFeedback]); // pinLayout order: [in-, in+, out]

    const vsVin  = makeDcVoltageSource(nInp,  0, brVin,  3.7);
    const vsVccP = makeDcVoltageSource(nVccP, 0, brVccP, 15);
    const vsVccN = makeDcVoltageSource(nVccN, 0, brVccN, -15);

    const solver = new SparseSolver();
    const diagnostics = new DiagnosticCollector();
    const result = solveDcOperatingPoint({
      solver,
      elements: [opampEl, vsVin, vsVccP, vsVccN],
      matrixSize,
      params: DEFAULT_SIMULATION_PARAMS,
      diagnostics,
    });

    expect(result.converged).toBe(true);
    const vOut = result.nodeVoltages[nFeedback - 1];
    // Voltage follower: Vout = Vin = 3.7V ± 0.005V
    expect(vOut).toBeCloseTo(3.7, 2);
  });
});
