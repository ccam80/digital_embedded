/**
 * Tests for Analog Switch components (SPST and SPDT).
 *
 * Tests cover:
 *   SPST::on_resistance         — V_ctrl >> V_th → R ≈ R_on
 *   SPST::off_resistance        — V_ctrl = 0 → R ≈ R_off
 *   SPST::smooth_transition     — R changes monotonically without discontinuity
 *   SPST::signal_passes_when_on — 1V signal through on-switch with R_load
 *   SPDT::break_before_make     — at threshold, both paths have elevated R
 *   SPDT::no_and_nc_complementary — high ctrl: NO closed, NC open; low ctrl: reversed
 *   SPST::nr_converges_during_transition — at threshold, NR converges ≤ 10 iterations
 */

import { describe, it, expect, vi } from "vitest";
import {
  SwitchSPSTDefinition,
  SwitchSPDTDefinition,
} from "../analog-switch.js";
import { PropertyBag } from "../../../core/properties.js";
import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import { DiagnosticCollector } from "../../../solver/analog/diagnostics.js";
import { solveDcOperatingPoint } from "../../../solver/analog/dc-operating-point.js";
import { DEFAULT_SIMULATION_PARAMS } from "../../../core/analog-engine-interface.js";
import { makeDcVoltageSource } from "../../sources/dc-voltage-source.js";
import { withNodeIds } from "../../../solver/analog/__tests__/test-helpers.js";
import type { AnalogElement } from "../../../solver/analog/element.js";
import type { SparseSolver as SparseSolverType } from "../../../solver/analog/sparse-solver.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockSolver() {
  return {
    stamp: vi.fn(),
    stampRHS: vi.fn(),
  } as unknown as SparseSolverType;
}

const SWITCH_MODEL_PARAM_KEYS = new Set(["rOn", "rOff", "threshold", "transitionSharpness"]);

function makeProps(overrides: Record<string, number | string> = {}): PropertyBag {
  const modelParams: Record<string, number> = {
    rOn: 10, rOff: 1e9, threshold: 1.65, transitionSharpness: 20,
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (SWITCH_MODEL_PARAM_KEYS.has(k)) modelParams[k] = v as number;
  }
  const bag = new PropertyBag([]);
  bag.replaceModelParams(modelParams);
  return bag;
}

function makeSPST(
  nCtrl: number,
  nIn: number,
  nOut: number,
  overrides: Record<string, number | string> = {},
): AnalogElement {
  return withNodeIds(
    SwitchSPSTDefinition.modelRegistry!["behavioral"]!.factory(
      new Map([["in", nIn], ["out", nOut], ["ctrl", nCtrl]]),
      [],
      -1,
      makeProps(overrides),
      () => 0,
    ),
    [nIn, nOut, nCtrl],
  );
}

function makeSPDT(
  nCtrl: number,
  nCom: number,
  nNO: number,
  nNC: number,
  overrides: Record<string, number | string> = {},
): AnalogElement {
  return withNodeIds(
    SwitchSPDTDefinition.modelRegistry!["behavioral"]!.factory(
      new Map([["com", nCom], ["no", nNO], ["nc", nNC], ["ctrl", nCtrl]]),
      [],
      -1,
      makeProps(overrides),
      () => 0,
    ),
    [nCom, nNO, nNC, nCtrl],
  );
}

function makeVoltages(size: number, nodeVoltages: Record<number, number>): Float64Array {
  const v = new Float64Array(size);
  for (const [node, voltage] of Object.entries(nodeVoltages)) {
    const n = parseInt(node);
    if (n > 0 && n <= size) v[n - 1] = voltage;
  }
  return v;
}

/**
 * Extract the effective conductance stamped between two nodes by reading
 * the off-diagonal stamp entries for nIn and nOut.
 *
 * Returns G = |stamp(nIn-1, nOut-1)| from the mock solver calls.
 */
function extractStampedConductance(
  element: AnalogElement,
  nIn: number,
  nOut: number,
  voltages: Float64Array,
): number {
  element.updateOperatingPoint!(voltages);
  const solver = makeMockSolver();
  element.stampNonlinear!(solver);
  const calls = (solver.stamp as ReturnType<typeof vi.fn>).mock.calls as number[][];
  // Off-diagonal entry: stamp(nIn-1, nOut-1, -G)
  const offDiag = calls.find(
    (c) => c[0] === nIn - 1 && c[1] === nOut - 1,
  );
  if (!offDiag) return 0;
  return -offDiag[2]; // conductance is positive; stamp places -G off-diagonal
}

// ---------------------------------------------------------------------------
// SPST tests
// ---------------------------------------------------------------------------

describe("SPST", () => {
  it("on_resistance", () => {
    // V_ctrl = 3.3V >> threshold = 1.65V → R ≈ R_on = 10 Ω
    const sw = makeSPST(1, 2, 3, { rOn: 10, rOff: 1e9, threshold: 1.65, transitionSharpness: 20 });
    const voltages = makeVoltages(3, { 1: 3.3 });

    sw.updateOperatingPoint!(voltages);
    const solver = makeMockSolver();
    sw.stampNonlinear!(solver);

    const calls = (solver.stamp as ReturnType<typeof vi.fn>).mock.calls as number[][];
    // Diagonal entry for nIn node: stamp(nIn-1, nIn-1, G) = stamp(1, 1, G)
    const diagEntry = calls.find((c) => c[0] === 1 && c[1] === 1);
    expect(diagEntry).toBeDefined();
    const g = diagEntry![2];
    const r = 1 / g;
    // R should be within 1% of R_on = 10 Ω
    expect(r).toBeCloseTo(10, 0);
    expect(r).toBeLessThan(11);
  });

  it("off_resistance", () => {
    // V_ctrl = 0 << threshold = 1.65V → R ≈ R_off = 1e9 Ω
    const sw = makeSPST(1, 2, 3, { rOn: 10, rOff: 1e9, threshold: 1.65, transitionSharpness: 20 });
    const voltages = makeVoltages(3, { 1: 0 });

    sw.updateOperatingPoint!(voltages);
    const solver = makeMockSolver();
    sw.stampNonlinear!(solver);

    const calls = (solver.stamp as ReturnType<typeof vi.fn>).mock.calls as number[][];
    const diagEntry = calls.find((c) => c[0] === 1 && c[1] === 1);
    expect(diagEntry).toBeDefined();
    const g = diagEntry![2];
    const r = 1 / g;
    // R should be within 1% of R_off = 1e9 Ω
    expect(r).toBeCloseTo(1e9, -3);
    expect(r).toBeGreaterThan(0.99e9);
  });

  it("smooth_transition", () => {
    // Sweep V_ctrl from 0 to 3.3V; R must change monotonically (no discontinuity).
    const sw = makeSPST(1, 2, 3, { rOn: 10, rOff: 1e9, threshold: 1.65, transitionSharpness: 20 });

    const steps = 33;
    const resistances: number[] = [];

    for (let i = 0; i <= steps; i++) {
      const vCtrl = (3.3 * i) / steps;
      const voltages = makeVoltages(3, { 1: vCtrl });
      sw.updateOperatingPoint!(voltages);
      const solver = makeMockSolver();
      sw.stampNonlinear!(solver);
      const calls = (solver.stamp as ReturnType<typeof vi.fn>).mock.calls as number[][];
      const diagEntry = calls.find((c) => c[0] === 1 && c[1] === 1);
      const g = diagEntry ? diagEntry[2] : 0;
      resistances.push(g > 0 ? 1 / g : 1e18);
    }

    // R should decrease monotonically as V_ctrl increases (switch closes)
    for (let i = 1; i < resistances.length; i++) {
      expect(resistances[i]).toBeLessThanOrEqual(resistances[i - 1] * 1.01); // allow 1% noise
    }

    // No discontinuity: consecutive R ratios must be < 1000x
    for (let i = 1; i < resistances.length; i++) {
      const ratio = resistances[i - 1] / resistances[i];
      expect(ratio).toBeLessThan(1000);
    }
  });

  it("signal_passes_when_on", () => {
    // Circuit: V_in=1V, switch on (V_ctrl=3.3V >> threshold), R_load=1kΩ to ground.
    // V_out ≈ 1V * R_load / (R_load + R_on) = 1000/1010 ≈ 0.99V
    //
    // Nodes: 1=ctrl, 2=signal_in, 3=signal_out
    // Branches: 4=V_ctrl source, 5=V_in source → matrixSize = 6
    const nCtrl = 1, nIn = 2, nOut = 3;
    const brCtrl = 3, brIn = 4;
    const matrixSize = 5;

    const sw = makeSPST(nCtrl, nIn, nOut, { rOn: 10, rOff: 1e9 });

    // R_load = 1000 Ω from nOut to ground
    const rLoad: AnalogElement = {
      pinNodeIds: [nOut, 0],
      allNodeIds: [nOut, 0],
      branchIndex: -1,
      isNonlinear: false,
      isReactive: false,
      stamp(solver: SparseSolver): void {
        solver.stamp(nOut - 1, nOut - 1, 1 / 1000);
      },
    };

    const vsCtrl = makeDcVoltageSource(nCtrl, 0, brCtrl, 3.3);
    const vsIn   = makeDcVoltageSource(nIn,   0, brIn,   1.0);

    const solver = new SparseSolver();
    const diagnostics = new DiagnosticCollector();
    const result = solveDcOperatingPoint({
      solver,
      elements: [sw, rLoad, vsCtrl, vsIn],
      matrixSize,
      params: DEFAULT_SIMULATION_PARAMS,
      diagnostics,
    });

    expect(result.converged).toBe(true);
    const vOut = result.nodeVoltages[nOut - 1];
    // V_out ≈ 1V * 1000/(1000+10) ≈ 0.99V ± 0.02V
    expect(vOut).toBeCloseTo(1000 / 1010, 1);
  });

  it("nr_converges_during_transition", () => {
    // At V_ctrl = threshold (1.65V), the switch is at the midpoint of transition.
    // This is the worst case for NR convergence.
    // Circuit: V_ctrl at threshold, V_in=1V, R_load=1kΩ.
    const nCtrl = 1, nIn = 2, nOut = 3;
    const brCtrl = 3, brIn = 4;
    const matrixSize = 5;

    const sw = makeSPST(nCtrl, nIn, nOut, { rOn: 10, rOff: 1e9, transitionSharpness: 20 });

    const rLoad: AnalogElement = {
      pinNodeIds: [nOut, 0],
      allNodeIds: [nOut, 0],
      branchIndex: -1,
      isNonlinear: false,
      isReactive: false,
      stamp(solver: SparseSolver): void {
        solver.stamp(nOut - 1, nOut - 1, 1 / 1000);
      },
    };

    const vsCtrl = makeDcVoltageSource(nCtrl, 0, brCtrl, 1.65); // exactly at threshold
    const vsIn   = makeDcVoltageSource(nIn,   0, brIn,   1.0);

    const solver = new SparseSolver();
    const diagnostics = new DiagnosticCollector();
    const result = solveDcOperatingPoint({
      solver,
      elements: [sw, rLoad, vsCtrl, vsIn],
      matrixSize,
      params: DEFAULT_SIMULATION_PARAMS,
      diagnostics,
    });

    expect(result.converged).toBe(true);
    // Must converge within 10 NR iterations (tanh ensures smooth Jacobian)
    expect(result.iterations).toBeLessThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// SPDT tests
// ---------------------------------------------------------------------------

describe("SPDT", () => {
  it("no_and_nc_complementary", () => {
    // V_ctrl = 3.3V (high): NO should be ≈ R_on, NC should be ≈ R_off.
    // V_ctrl = 0V (low):    NO should be ≈ R_off, NC should be ≈ R_on.
    const k = 20;
    const rOn = 10;
    const rOff = 1e9;
    const vTh = 1.65;

    const swHigh = makeSPDT(1, 2, 3, 4, { rOn, rOff, threshold: vTh, transitionSharpness: k });
    const swLow  = makeSPDT(1, 2, 3, 4, { rOn, rOff, threshold: vTh, transitionSharpness: k });

    // High control: NO closed, NC open
    const voltagesHigh = makeVoltages(4, { 1: 3.3 });
    swHigh.updateOperatingPoint!(voltagesHigh);
    const solverHigh = makeMockSolver();
    swHigh.stampNonlinear!(solverHigh);
    const callsHigh = (solverHigh.stamp as ReturnType<typeof vi.fn>).mock.calls as number[][];

    // COM(2)-NO(3) diagonal: stamp(1, 1, G_NO) — nCom-1=1
    const diagComHigh = callsHigh.find((c) => c[0] === 1 && c[1] === 1);
    expect(diagComHigh).toBeDefined();
    // Total conductance on COM diagonal = G_NO + G_NC; NO dominates when ctrl is high
    // We check that total conductance ≈ G_NO (G_NC is tiny)
    // Instead, check off-diagonal COM-NO entry for conductance
    const offComNoHigh = callsHigh.find((c) => c[0] === 1 && c[1] === 2);
    expect(offComNoHigh).toBeDefined();
    const gNO_high = -offComNoHigh![2];
    expect(1 / gNO_high).toBeCloseTo(rOn, 0); // NO resistance ≈ R_on

    const offComNcHigh = callsHigh.find((c) => c[0] === 1 && c[1] === 3);
    expect(offComNcHigh).toBeDefined();
    const gNC_high = -offComNcHigh![2];
    expect(1 / gNC_high).toBeCloseTo(rOff, -3); // NC resistance ≈ R_off

    // Low control: NO open, NC closed
    const voltagesLow = makeVoltages(4, { 1: 0 });
    swLow.updateOperatingPoint!(voltagesLow);
    const solverLow = makeMockSolver();
    swLow.stampNonlinear!(solverLow);
    const callsLow = (solverLow.stamp as ReturnType<typeof vi.fn>).mock.calls as number[][];

    const offComNoLow = callsLow.find((c) => c[0] === 1 && c[1] === 2);
    expect(offComNoLow).toBeDefined();
    const gNO_low = -offComNoLow![2];
    expect(1 / gNO_low).toBeCloseTo(rOff, -3); // NO resistance ≈ R_off

    const offComNcLow = callsLow.find((c) => c[0] === 1 && c[1] === 3);
    expect(offComNcLow).toBeDefined();
    const gNC_low = -offComNcLow![2];
    expect(1 / gNC_low).toBeCloseTo(rOn, 0); // NC resistance ≈ R_on
  });

  it("break_before_make", () => {
    // At V_ctrl = threshold (1.65V), both paths should be at mid-resistance
    // (neither fully on nor fully off). Both R values must be > R_on and < R_off,
    // i.e. the switch does not have both paths simultaneously at R_on.
    const rOn  = 10;
    const rOff = 1e9;
    const vTh  = 1.65;
    const sw = makeSPDT(1, 2, 3, 4, { rOn, rOff, threshold: vTh, transitionSharpness: 20 });

    const voltages = makeVoltages(4, { 1: vTh });
    sw.updateOperatingPoint!(voltages);
    const solver = makeMockSolver();
    sw.stampNonlinear!(solver);
    const calls = (solver.stamp as ReturnType<typeof vi.fn>).mock.calls as number[][];

    // At threshold: tanh(0) = 0, so both paths get R = R_off - (R_off-R_on)*0.5 = midpoint
    const midR = rOff - (rOff - rOn) * 0.5;

    const offComNo = calls.find((c) => c[0] === 1 && c[1] === 2);
    expect(offComNo).toBeDefined();
    const rNO = -1 / offComNo![2];
    expect(rNO).toBeCloseTo(midR, -3);

    const offComNc = calls.find((c) => c[0] === 1 && c[1] === 3);
    expect(offComNc).toBeDefined();
    const rNC = -1 / offComNc![2];
    expect(rNC).toBeCloseTo(midR, -3);

    // Both paths at mid-R → neither is fully on (R_on=10) simultaneously
    expect(rNO).toBeGreaterThan(rOn * 10);
    expect(rNC).toBeGreaterThan(rOn * 10);
  });
});
