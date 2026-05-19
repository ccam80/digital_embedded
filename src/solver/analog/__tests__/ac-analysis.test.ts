/**
 * AC Analysis Engine tests.
 *
 * Tests use inline AnalogElement implementations with stampAc methods, run
 * through the unified SparseSolver in complex mode (the same factor/solve
 * path as DC and transient). The test circuit is a simple RC lowpass filter:
 *
 *   V_ac --- R --- node_out --- C --- GND
 *
 * MNA node layout (1-based; node 0 = ground = TrashCan):
 *   node 1: V_source (AC excitation node)
 *   node 2: V_out    (output measurement node)
 *
 * For the RC lowpass analysis:
 *   H(jω) = V_out / V_in = 1 / (1 + jωRC)
 *
 * The -3dB point is at f_c = 1/(2π·R·C).
 */

import { describe, it, expect, vi } from "vitest";
import { AcAnalysis, buildFrequencyArray } from "../ac-analysis.js";
import type { AcCompiledCircuit } from "../ac-analysis.js";
import { AnalogElement } from "../element.js";
import type { DeviceFamily } from "../ngspice-load-order.js";
import type { LoadContext } from "../load-context.js";
import { SparseSolver, type SparseSolverStamp } from "../sparse-solver.js";

// ---------------------------------------------------------------------------
// Inline test element helpers
//
// All addressing is 1-based with node 0 = ground = TrashCan (ngspice-faithful,
// identical to the DC/transient solver). allocElement(0, x) returns the
// TrashCan handle 0; stamping there is discarded- exactly the MNA treatment
// of the ground row/column, so no per-node ground guards are needed.
// ---------------------------------------------------------------------------

/** Resistor: real conductance G = 1/R at (A,A),(B,B) and -G at (A,B),(B,A). */
function makeAcResistor(nodeA: number, nodeB: number, resistance: number): AnalogElement {
  const G = 1 / resistance;
  const pinNodes = new Map([["pos", nodeA], ["neg", nodeB]]);
  class AcResistor extends AnalogElement {
    readonly ngspiceLoadOrder = 0;
    readonly deviceFamily: DeviceFamily = "RES";
    setup(_ctx: import("../setup-context.js").SetupContext): void {}
    load(_ctx: LoadContext): void {}
    setParam(_key: string, _value: number): void {}
    getPinCurrents(_v: Float64Array): number[] { return [0, 0]; }
    stampAc(solver: SparseSolverStamp, _omega: number, _ctx: LoadContext): void {
      solver.stampElement(solver.allocElement(nodeA, nodeA),  G);
      solver.stampElement(solver.allocElement(nodeB, nodeB),  G);
      solver.stampElement(solver.allocElement(nodeA, nodeB), -G);
      solver.stampElement(solver.allocElement(nodeB, nodeA), -G);
    }
  }
  return new AcResistor(pinNodes);
}

/** Capacitor: imaginary admittance jωC at the same four positions. */
function makeAcCapacitor(nodeA: number, nodeB: number, capacitance: number): AnalogElement {
  const pinNodes = new Map([["pos", nodeA], ["neg", nodeB]]);
  class AcCapacitor extends AnalogElement {
    readonly ngspiceLoadOrder = 0;
    readonly deviceFamily: DeviceFamily = "CAP";
    setup(_ctx: import("../setup-context.js").SetupContext): void {}
    load(_ctx: LoadContext): void {}
    setParam(_key: string, _value: number): void {}
    getPinCurrents(_v: Float64Array): number[] { return [0, 0]; }
    stampAc(solver: SparseSolverStamp, omega: number, _ctx: LoadContext): void {
      const wC = omega * capacitance;
      solver.stampElementImag(solver.allocElement(nodeA, nodeA),  wC);
      solver.stampElementImag(solver.allocElement(nodeB, nodeB),  wC);
      solver.stampElementImag(solver.allocElement(nodeA, nodeB), -wC);
      solver.stampElementImag(solver.allocElement(nodeB, nodeA), -wC);
    }
  }
  return new AcCapacitor(pinNodes);
}

/** Inductor (test nodal model): admittance 1/(jωL) = -j/(ωL). */
function makeAcInductor(nodeA: number, nodeB: number, inductance: number): AnalogElement {
  const pinNodes = new Map([["pos", nodeA], ["neg", nodeB]]);
  class AcInductor extends AnalogElement {
    readonly ngspiceLoadOrder = 0;
    readonly deviceFamily: DeviceFamily = "IND";
    setup(_ctx: import("../setup-context.js").SetupContext): void {}
    load(_ctx: LoadContext): void {}
    setParam(_key: string, _value: number): void {}
    getPinCurrents(_v: Float64Array): number[] { return [0, 0]; }
    stampAc(solver: SparseSolverStamp, omega: number, _ctx: LoadContext): void {
      const admIm = -1 / (omega * inductance);
      solver.stampElementImag(solver.allocElement(nodeA, nodeA),  admIm);
      solver.stampElementImag(solver.allocElement(nodeB, nodeB),  admIm);
      solver.stampElementImag(solver.allocElement(nodeA, nodeB), -admIm);
      solver.stampElementImag(solver.allocElement(nodeB, nodeA), -admIm);
    }
  }
  return new AcInductor(pinNodes);
}

// ---------------------------------------------------------------------------
// Circuit fixtures
// ---------------------------------------------------------------------------

/**
 * RC lowpass: node 1 (source) --- R --- node 2 (out) --- C --- GND.
 * matrixSize = 2 (two non-ground nodes); the AC source branch is index 3.
 */
function makeRcLowpassCircuit(R: number, C: number): AcCompiledCircuit {
  const labelToNodeId = new Map<string, number>([
    ["source", 1],
    ["out", 2],
  ]);
  const elements: AnalogElement[] = [
    makeAcResistor(1, 2, R),
    makeAcCapacitor(2, 0, C),
  ];
  const elementsByFamily = new Map<DeviceFamily, readonly AnalogElement[]>([
    ["RES", [elements[0]]],
    ["CAP", [elements[1]]],
  ]);
  return { nodeCount: 2, matrixSize: 2, elements, elementsByFamily, labelToNodeId };
}

/**
 * Series RLC: node1 (source) --- L --- node2 --- C --- node3 --- R --- GND.
 * Output across R at node3 → bandpass; resonance f0 = 1/(2π√(LC)).
 */
function makeRlcSeriesCircuit(R: number, L: number, C: number): AcCompiledCircuit {
  const labelToNodeId = new Map<string, number>([
    ["source", 1],
    ["out", 3],
  ]);
  const elements: AnalogElement[] = [
    makeAcInductor(1, 2, L),
    makeAcCapacitor(2, 3, C),
    makeAcResistor(3, 0, R),
  ];
  const elementsByFamily = new Map<DeviceFamily, readonly AnalogElement[]>([
    ["IND", [elements[0]]],
    ["CAP", [elements[1]]],
    ["RES", [elements[2]]],
  ]);
  return { nodeCount: 3, matrixSize: 3, elements, elementsByFamily, labelToNodeId };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AC", () => {
  it("rc_lowpass_rolloff- -3dB point at f_c = 1/(2π·RC) ±5%", () => {
    const R = 1000;
    const C = 1e-6;
    const fC = 1 / (2 * Math.PI * R * C); // ≈ 159.15 Hz

    const ac = new AcAnalysis(makeRcLowpassCircuit(R, C));
    const result = ac.run({
      type: "dec", numPoints: 50, fStart: 1, fStop: 100000,
      sourceLabel: "source", outputNodes: ["out"],
    });

    const freqs = result.frequencies;
    const mag = result.magnitude.get("out")!;

    let minDiff = Infinity;
    let actualF3db = 0;
    for (let i = 0; i < freqs.length; i++) {
      const diff = Math.abs(mag[i] - (-3.01));
      if (diff < minDiff) { minDiff = diff; actualF3db = freqs[i]; }
    }

    expect(actualF3db).toBeGreaterThan(fC * 0.95);
    expect(actualF3db).toBeLessThan(fC * 1.05);
  });

  it("rc_lowpass_slope- above f_c, magnitude rolls off at -20dB/decade ±2dB", () => {
    const R = 1000;
    const C = 1e-6;
    const fC = 1 / (2 * Math.PI * R * C);

    const ac = new AcAnalysis(makeRcLowpassCircuit(R, C));
    const result = ac.run({
      type: "dec", numPoints: 20, fStart: 1, fStop: 100000,
      sourceLabel: "source", outputNodes: ["out"],
    });

    const freqs = result.frequencies;
    const mag = result.magnitude.get("out")!;
    const idx1 = findClosestIndex(freqs, fC * 10);
    const idx2 = findClosestIndex(freqs, fC * 100);

    const slope = (mag[idx2] - mag[idx1]) / Math.log10(freqs[idx2] / freqs[idx1]);
    expect(slope).toBeGreaterThan(-22);
    expect(slope).toBeLessThan(-18);
  });

  it("rc_lowpass_phase- at f_c, phase ≈ -45° ±5°", () => {
    const R = 1000;
    const C = 1e-6;
    const fC = 1 / (2 * Math.PI * R * C);

    const ac = new AcAnalysis(makeRcLowpassCircuit(R, C));
    const result = ac.run({
      type: "dec", numPoints: 50, fStart: 1, fStop: 100000,
      sourceLabel: "source", outputNodes: ["out"],
    });

    const idx = findClosestIndex(result.frequencies, fC);
    const phaseAtFc = result.phase.get("out")![idx];
    expect(phaseAtFc).toBeGreaterThan(-50);
    expect(phaseAtFc).toBeLessThan(-40);
  });

  it("rlc_bandpass_resonance- series RLC; peak gain at f_0 = 1/(2π·√(LC))", () => {
    const R = 100;
    const L = 1e-3;
    const C = 1e-6;
    const f0 = 1 / (2 * Math.PI * Math.sqrt(L * C)); // ≈ 5033 Hz

    const ac = new AcAnalysis(makeRlcSeriesCircuit(R, L, C));
    const result = ac.run({
      type: "dec", numPoints: 50, fStart: 100, fStop: 200000,
      sourceLabel: "source", outputNodes: ["out"],
    });

    const freqs = result.frequencies;
    const mag = result.magnitude.get("out")!;

    let peakIdx = 0;
    let peakMag = -Infinity;
    for (let i = 0; i < freqs.length; i++) {
      if (mag[i] > peakMag) { peakMag = mag[i]; peakIdx = i; }
    }

    const peakFreq = freqs[peakIdx];
    expect(peakFreq).toBeGreaterThan(f0 * 0.90);
    expect(peakFreq).toBeLessThan(f0 * 1.10);
  });

  it("no_source_emits_diagnostic- ac-no-source diagnostic with error severity", () => {
    const ac = new AcAnalysis(makeRcLowpassCircuit(1000, 1e-6));
    const result = ac.run({
      type: "dec", numPoints: 10, fStart: 1, fStop: 1000,
      sourceLabel: "nonexistent_source",
      outputNodes: ["out"],
    });

    const diag = result.diagnostics.find(d => d.code === "ac-no-source");
    expect(diag).toBeDefined();
    expect(diag!.severity).toBe("error");
  });

  it("decade_sweep_points- type='dec', numPoints=10, 1Hz to 1MHz; 60 points", () => {
    const result = buildFrequencyArray({
      type: "dec", numPoints: 10, fStart: 1, fStop: 1e6,
      sourceLabel: "s", outputNodes: [],
    });

    expect(result.length).toBe(60);
    expect(result[0]).toBeCloseTo(1, 10);
    const ratio0 = result[1] / result[0];
    const ratio1 = result[2] / result[1];
    expect(ratio0).toBeCloseTo(ratio1, 10);
    expect(ratio0).toBeCloseTo(Math.pow(10, 1 / 10), 10);
  });

  it("linear_sweep_points- type='lin', numPoints=100, 0 to 1kHz", () => {
    const result = buildFrequencyArray({
      type: "lin", numPoints: 100, fStart: 0, fStop: 1000,
      sourceLabel: "s", outputNodes: [],
    });

    expect(result.length).toBe(100);
    expect(result[0]).toBeCloseTo(0, 10);
    expect(result[result.length - 1]).toBeCloseTo(1000, 10);
    const step0 = result[1] - result[0];
    const step1 = result[2] - result[1];
    expect(step0).toBeCloseTo(step1, 10);
    expect(step0).toBeCloseTo((1000 - 0) / (result.length - 1), 10);
  });

  it("opamp_gain_bandwidth- single-pole divider; -3dB at the pole", () => {
    const R1 = 9000;
    const R2 = 1000;
    const C = 1e-6;

    const gain_dc = R2 / (R1 + R2);
    const R_parallel = (R1 * R2) / (R1 + R2);
    const f_pole = 1 / (2 * Math.PI * C * R_parallel);

    const labelToNodeId = new Map<string, number>([
      ["source", 1],
      ["out", 2],
    ]);
    const elements: AnalogElement[] = [
      makeAcResistor(1, 2, R1),
      makeAcResistor(2, 0, R2),
      makeAcCapacitor(2, 0, C),
    ];
    const elementsByFamily = new Map<DeviceFamily, readonly AnalogElement[]>([
      ["RES", [elements[0], elements[1]]],
      ["CAP", [elements[2]]],
    ]);
    const circuit: AcCompiledCircuit = {
      nodeCount: 2, matrixSize: 2, elements, elementsByFamily, labelToNodeId,
    };

    const ac = new AcAnalysis(circuit);
    const result = ac.run({
      type: "dec", numPoints: 30, fStart: 1, fStop: 1e6,
      sourceLabel: "source", outputNodes: ["out"],
    });

    const freqs = result.frequencies;
    const mag = result.magnitude.get("out")!;
    const expectedDcGainDb = 20 * Math.log10(gain_dc); // -20 dB

    const lowFreqIdx = findClosestIndex(freqs, 1);
    expect(mag[lowFreqIdx]).toBeGreaterThan(expectedDcGainDb - 1);
    expect(mag[lowFreqIdx]).toBeLessThan(expectedDcGainDb + 1);

    const highFreqIdx = findClosestIndex(freqs, f_pole * 10);
    expect(mag[highFreqIdx]).toBeLessThan(expectedDcGainDb - 17);

    const poleIdx = findClosestIndex(freqs, f_pole);
    const expected3dbGain = expectedDcGainDb - 3.01;
    expect(mag[poleIdx]).toBeGreaterThan(expected3dbGain - 2);
    expect(mag[poleIdx]).toBeLessThan(expected3dbGain + 2);
  });
});

// ---------------------------------------------------------------------------
// Solver-lifecycle tests- the real AcAnalysis.run() path with a spied solver
// injected through the solver-factory dep.
// ---------------------------------------------------------------------------

describe("AC- solver lifecycle", () => {
  it("ac_sweep_caller_reuses_branch_handles_across_frequencies", () => {
    const circuit = makeRcLowpassCircuit(1000, 1e-6);
    const injectedSolver = new SparseSolver();
    const allocSpy = vi.spyOn(injectedSolver, "allocElement");

    const ac = new AcAnalysis(circuit, undefined, {
      solverFactory: () => injectedSolver,
    });

    ac.run({
      type: "lin", numPoints: 3, fStart: 100, fStop: 10000,
      sourceLabel: "source", outputNodes: ["out"],
    });

    // The AC voltage-source branch cells (sourceNode↔branch, both directions)
    // must be allocated exactly once- on fi===0- and reused from the handle
    // cache afterwards. sourceLabel "source" → node 1; branch = matrixSize+1.
    const sourceNodeId = 1;
    const branchExt = circuit.matrixSize + 1; // 3
    const branchAllocCalls = allocSpy.mock.calls.filter(
      c => (c[0] === sourceNodeId && c[1] === branchExt) ||
           (c[0] === branchExt && c[1] === sourceNodeId),
    );
    expect(branchAllocCalls.length).toBe(2);

    allocSpy.mockRestore();
  });

  it("ac_sweep_single_reorder_across_frequencies", () => {
    const circuit = makeRcLowpassCircuit(1000, 1e-6);
    const injectedSolver = new SparseSolver();

    // Record whether each factor() walked the reorder body. ngspice reuses
    // the pivot order across AC frequencies: frequency 0 reorders
    // (spOrderAndFactor), every later frequency reuses it (FactorComplexMatrix).
    const reorderFlags: boolean[] = [];
    const realFactor = injectedSolver.factor.bind(injectedSolver);
    injectedSolver.factor = (pivTol?: number, gmin?: number) => {
      const err = realFactor(pivTol, gmin);
      reorderFlags.push(injectedSolver.lastFactorWalkedReorder);
      return err;
    };

    const ac = new AcAnalysis(circuit, undefined, {
      solverFactory: () => injectedSolver,
    });

    const numFreq = 5;
    ac.run({
      type: "lin", numPoints: numFreq, fStart: 100, fStop: 10000,
      sourceLabel: "source", outputNodes: ["out"],
    });

    expect(reorderFlags.length).toBe(numFreq);
    expect(reorderFlags[0]).toBe(true);
    for (let fi = 1; fi < numFreq; fi++) {
      expect(reorderFlags[fi]).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function findClosestIndex(freqs: Float64Array, target: number): number {
  let minDiff = Infinity;
  let idx = 0;
  for (let i = 0; i < freqs.length; i++) {
    const diff = Math.abs(freqs[i] - target);
    if (diff < minDiff) { minDiff = diff; idx = i; }
  }
  return idx;
}
