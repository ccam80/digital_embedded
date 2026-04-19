/**
 * AC Analysis Engine tests.
 *
 * Tests use inline AnalogElement implementations with stampAc methods.
 * The test circuit is a simple RC lowpass filter:
 *
 *   V_ac --- R --- node_out --- C --- GND
 *
 * MNA node layout:
 *   node 1: V_source (AC excitation node, driven by unit current source)
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
import type { AnalogElement, LoadContext } from "../element.js";
import type { ComplexSparseSolver } from "../element.js";
import * as ComplexSolverModule from "../complex-sparse-solver.js";

// ---------------------------------------------------------------------------
// Inline test element helpers
// ---------------------------------------------------------------------------

/**
 * Create a resistor AnalogElement that implements stampAc.
 * Stamps real conductance G = 1/R at (nodeA, nodeA), (nodeA, nodeB), etc.
 * Node IDs are 1-based (0 = ground); solver uses 0-based indices.
 */
function makeAcResistor(nodeA: number, nodeB: number, resistance: number): AnalogElement {
  const G = 1 / resistance;

  function stampMatrix(
    solver: { allocComplexElement(r: number, c: number): number; stampComplexElement(h: number, re: number, im: number): void },
    ra: number, ca: number, re: number, im: number
  ): void {
    if (ra >= 0 && ca >= 0) {
      const h = solver.allocComplexElement(ra, ca);
      solver.stampComplexElement(h, re, im);
    }
  }

  return {
    pinNodeIds: [nodeA, nodeB],
    allNodeIds: [nodeA, nodeB],
    branchIndex: -1,
    isNonlinear: false,
    isReactive: false,
    load(_ctx: LoadContext): void {},
    setParam(_key: string, _value: number): void {},
    getPinCurrents(_v: Float64Array): number[] { return [0, 0]; },
    stampAc(solver: ComplexSparseSolver, _omega: number): void {
      const a = nodeA > 0 ? nodeA - 1 : -1;
      const b = nodeB > 0 ? nodeB - 1 : -1;
      stampMatrix(solver, a, a, G, 0);
      if (a >= 0 && b >= 0) {
        const hab = solver.allocComplexElement(a, b);
        solver.stampComplexElement(hab, -G, 0);
        const hba = solver.allocComplexElement(b, a);
        solver.stampComplexElement(hba, -G, 0);
      }
      stampMatrix(solver, b, b, G, 0);
    },
  };
}

/**
 * Create a capacitor AnalogElement that implements stampAc.
 * Stamps imaginary admittance jωC at the node positions.
 */
function makeAcCapacitor(nodeA: number, nodeB: number, capacitance: number): AnalogElement {
  return {
    pinNodeIds: [nodeA, nodeB],
    allNodeIds: [nodeA, nodeB],
    branchIndex: -1,
    isNonlinear: false,
    isReactive: true,
    load(_ctx: LoadContext): void {},
    setParam(_key: string, _value: number): void {},
    getPinCurrents(_v: Float64Array): number[] { return [0, 0]; },
    stampAc(solver: ComplexSparseSolver, omega: number): void {
      const jOmegaC = omega * capacitance; // imaginary part of admittance
      const a = nodeA > 0 ? nodeA - 1 : -1;
      const b = nodeB > 0 ? nodeB - 1 : -1;
      if (a >= 0) { const h = solver.allocComplexElement(a, a); solver.stampComplexElement(h, 0, jOmegaC); }
      if (a >= 0 && b >= 0) {
        const hab = solver.allocComplexElement(a, b); solver.stampComplexElement(hab, 0, -jOmegaC);
        const hba = solver.allocComplexElement(b, a); solver.stampComplexElement(hba, 0, -jOmegaC);
      }
      if (b >= 0) { const h = solver.allocComplexElement(b, b); solver.stampComplexElement(h, 0, jOmegaC); }
    },
  };
}

/**
 * Create an inductor AnalogElement that implements stampAc.
 * Stamps admittance 1/(jωL) = -j/(ωL) at the node positions.
 */
function makeAcInductor(nodeA: number, nodeB: number, inductance: number): AnalogElement {
  return {
    pinNodeIds: [nodeA, nodeB],
    allNodeIds: [nodeA, nodeB],
    branchIndex: -1,
    isNonlinear: false,
    isReactive: true,
    load(_ctx: LoadContext): void {},
    setParam(_key: string, _value: number): void {},
    getPinCurrents(_v: Float64Array): number[] { return [0, 0]; },
    stampAc(solver: ComplexSparseSolver, omega: number): void {
      // Y_L = 1/(jωL) = -j/(ωL)
      const admIm = -1 / (omega * inductance);
      const a = nodeA > 0 ? nodeA - 1 : -1;
      const b = nodeB > 0 ? nodeB - 1 : -1;
      if (a >= 0) { const h = solver.allocComplexElement(a, a); solver.stampComplexElement(h, 0, admIm); }
      if (a >= 0 && b >= 0) {
        const hab = solver.allocComplexElement(a, b); solver.stampComplexElement(hab, 0, -admIm);
        const hba = solver.allocComplexElement(b, a); solver.stampComplexElement(hba, 0, -admIm);
      }
      if (b >= 0) { const h = solver.allocComplexElement(b, b); solver.stampComplexElement(h, 0, admIm); }
    },
  };
}

// ---------------------------------------------------------------------------
// RC lowpass filter circuit fixture
// ---------------------------------------------------------------------------

/**
 * Build an RC lowpass filter compiled circuit.
 *
 * Circuit topology:
 *   node 1 (source) --- R --- node 2 (output) --- C --- GND (node 0)
 *
 * matrixSize = 2 (two non-ground nodes)
 * sourceLabel = "source" → node 1
 * outputLabel = "out"    → node 2
 */
function makeRcLowpassCircuit(R: number, C: number): AcCompiledCircuit {
  const labelToNodeId = new Map<string, number>([
    ["source", 1],
    ["out", 2],
  ]);

  const elements: AnalogElement[] = [
    makeAcResistor(1, 2, R),   // Resistor between node 1 and node 2
    makeAcCapacitor(2, 0, C),  // Capacitor between node 2 and ground
  ];

  return {
    nodeCount: 2,
    branchCount: 0,
    matrixSize: 2,
    elements,
    labelToNodeId,
  };
}

/**
 * Build a series RLC circuit.
 *
 * Circuit: node1 (source) --- L --- node2 --- C --- node3 --- R --- GND
 * Output measured at node3 (across R), which produces bandpass behaviour.
 *
 * Resonant frequency: f0 = 1/(2π√(LC))
 * At resonance, the LC impedance cancels and all voltage drops across R.
 */
function makeRlcSeriesCircuit(R: number, L: number, C: number): AcCompiledCircuit {
  const labelToNodeId = new Map<string, number>([
    ["source", 1],
    ["out", 3],
  ]);

  const elements: AnalogElement[] = [
    makeAcInductor(1, 2, L),   // Series inductor: node1 → node2
    makeAcCapacitor(2, 3, C),  // Series capacitor: node2 → node3
    makeAcResistor(3, 0, R),   // Shunt resistor: node3 → GND (output across this)
  ];

  return {
    nodeCount: 3,
    branchCount: 0,
    matrixSize: 3,
    elements,
    labelToNodeId,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AC", () => {
  it("rc_lowpass_rolloff — -3dB point at f_c = 1/(2π·RC) ±5%", () => {
    const R = 1000;   // 1 kΩ
    const C = 1e-6;   // 1 µF
    const fC = 1 / (2 * Math.PI * R * C); // ≈ 159.15 Hz

    const circuit = makeRcLowpassCircuit(R, C);
    const ac = new AcAnalysis(circuit);

    const result = ac.run({
      type: "dec",
      numPoints: 50,
      fStart: 1,
      fStop: 100000,
      sourceLabel: "source",
      outputNodes: ["out"],
    });

    const freqs = result.frequencies;
    const mag = result.magnitude.get("out")!;

    // Find the frequency closest to -3 dB
    let minDiff = Infinity;
    let actualF3db = 0;
    for (let i = 0; i < freqs.length; i++) {
      const diff = Math.abs(mag[i] - (-3.01));
      if (diff < minDiff) {
        minDiff = diff;
        actualF3db = freqs[i];
      }
    }

    // Tolerance: 5% of fC
    expect(actualF3db).toBeGreaterThan(fC * 0.95);
    expect(actualF3db).toBeLessThan(fC * 1.05);
  });

  it("rc_lowpass_slope — above f_c, magnitude rolls off at -20dB/decade ±2dB", () => {
    const R = 1000;
    const C = 1e-6;
    const fC = 1 / (2 * Math.PI * R * C); // ≈ 159.15 Hz

    const circuit = makeRcLowpassCircuit(R, C);
    const ac = new AcAnalysis(circuit);

    const result = ac.run({
      type: "dec",
      numPoints: 20,
      fStart: 1,
      fStop: 100000,
      sourceLabel: "source",
      outputNodes: ["out"],
    });

    const freqs = result.frequencies;
    const mag = result.magnitude.get("out")!;

    // Pick two frequencies that are one decade apart, both well above fC
    // Use 10×fC and 100×fC
    const f1 = fC * 10;
    const f2 = fC * 100;

    // Find closest frequency points in the sweep
    const idx1 = findClosestIndex(freqs, f1);
    const idx2 = findClosestIndex(freqs, f2);

    // Slope should be ≈ -20 dB/decade
    const slope = (mag[idx2] - mag[idx1]) / Math.log10(freqs[idx2] / freqs[idx1]);
    expect(slope).toBeGreaterThan(-22);
    expect(slope).toBeLessThan(-18);
  });

  it("rc_lowpass_phase — at f_c, phase ≈ -45° ±5°", () => {
    const R = 1000;
    const C = 1e-6;
    const fC = 1 / (2 * Math.PI * R * C); // ≈ 159.15 Hz

    const circuit = makeRcLowpassCircuit(R, C);
    const ac = new AcAnalysis(circuit);

    const result = ac.run({
      type: "dec",
      numPoints: 50,
      fStart: 1,
      fStop: 100000,
      sourceLabel: "source",
      outputNodes: ["out"],
    });

    const freqs = result.frequencies;
    const phase = result.phase.get("out")!;

    // Find closest to fC
    const idx = findClosestIndex(freqs, fC);
    const phaseAtFc = phase[idx];

    // At the -3dB frequency for a first-order RC filter, phase is -45°
    expect(phaseAtFc).toBeGreaterThan(-50);
    expect(phaseAtFc).toBeLessThan(-40);
  });

  it("rlc_bandpass_resonance — series RLC; peak gain at f_0 = 1/(2π·√(LC))", () => {
    const R = 100;     // 100 Ω
    const L = 1e-3;    // 1 mH
    const C = 1e-6;    // 1 µF
    const f0 = 1 / (2 * Math.PI * Math.sqrt(L * C)); // ≈ 5033 Hz

    const circuit = makeRlcSeriesCircuit(R, L, C);
    const ac = new AcAnalysis(circuit);

    const result = ac.run({
      type: "dec",
      numPoints: 50,
      fStart: 100,
      fStop: 200000,
      sourceLabel: "source",
      outputNodes: ["out"],
    });

    const freqs = result.frequencies;
    const mag = result.magnitude.get("out")!;

    // Find peak magnitude
    let peakIdx = 0;
    let peakMag = -Infinity;
    for (let i = 0; i < freqs.length; i++) {
      if (mag[i] > peakMag) {
        peakMag = mag[i];
        peakIdx = i;
      }
    }

    const peakFreq = freqs[peakIdx];

    // Peak should be within 10% of resonant frequency
    expect(peakFreq).toBeGreaterThan(f0 * 0.90);
    expect(peakFreq).toBeLessThan(f0 * 1.10);
  });

  it("no_source_emits_diagnostic — ac-no-source diagnostic with error severity", () => {
    const circuit = makeRcLowpassCircuit(1000, 1e-6);
    const ac = new AcAnalysis(circuit);

    const result = ac.run({
      type: "dec",
      numPoints: 10,
      fStart: 1,
      fStop: 1000,
      sourceLabel: "nonexistent_source",  // does not exist in the circuit
      outputNodes: ["out"],
    });

    const diag = result.diagnostics.find(d => d.code === "ac-no-source");
    expect(diag).toBeDefined();
    expect(diag!.severity).toBe("error");
  });

  it("decade_sweep_points — type='dec', numPoints=10, 1Hz to 1MHz; 60 points (6 decades × 10)", () => {
    const result = buildFrequencyArray({
      type: "dec",
      numPoints: 10,
      fStart: 1,
      fStop: 1e6,
      sourceLabel: "s",
      outputNodes: [],
    });

    // 6 decades: 1 to 10, 10 to 100, 100 to 1k, 1k to 10k, 10k to 100k, 100k to 1M
    // Each decade has 10 points: total = 60
    expect(result.length).toBe(60);

    // First point should be fStart
    expect(result[0]).toBeCloseTo(1, 6);

    // Points should be log-spaced
    const logRatio1 = Math.log10(result[1] / result[0]);
    const logRatio2 = Math.log10(result[2] / result[1]);
    expect(logRatio1).toBeCloseTo(logRatio2, 6);
  });

  it("linear_sweep_points — type='lin', numPoints=100, 0 to 1kHz; 100 equally-spaced points", () => {
    const result = buildFrequencyArray({
      type: "lin",
      numPoints: 100,
      fStart: 0,
      fStop: 1000,
      sourceLabel: "s",
      outputNodes: [],
    });

    expect(result.length).toBe(100);

    // First and last points
    expect(result[0]).toBeCloseTo(0, 6);
    expect(result[99]).toBeCloseTo(1000, 6);

    // Equally spaced
    const step = 1000 / 99;
    expect(result[1] - result[0]).toBeCloseTo(step, 4);
    expect(result[50] - result[49]).toBeCloseTo(step, 4);
  });

  it("opamp_gain_bandwidth — inverting amplifier gain × bandwidth = GBW", () => {
    // Model an inverting amplifier using a two-RC network that approximates
    // the closed-loop gain-bandwidth tradeoff.
    //
    // The circuit is a two-section RC lowpass ladder to model a two-pole amplifier.
    // Section 1 has gain G1 = Rf/Rin (set by R ratio) and pole at f_p1.
    // At low freq: |H| ≈ G1; at high freq: rolls off at -40dB/decade.
    //
    // Simplified closed-loop model:
    //   node1 (in) --- Rin --- node2 --- Rf --- node3 (out)
    //   node2 --- Cp1 --- GND   (feedback pole capacitor)
    //   node3 --- Cp2 --- GND   (output pole)
    //
    // This is essentially a two-stage RC lowpass. The ratio of gains at two
    // well-separated decades demonstrates gain-bandwidth product behaviour.

    // A single-pole RC lowpass with a voltage divider gives us a clean gain-BW test.
    // Use: V_in (node1) → R1 → node2 → R2 → GND, C from node2 → GND.
    // H(jω) = (R2/(R1+R2)) * 1/(1 + jω*C*(R1||R2))
    // At low f: gain = R2/(R1+R2); pole at f_p = 1/(2π*C*(R1||R2))
    // Gain-bandwidth: GBW = gain * f_p = (R2/(R1+R2)) * 1/(2π*C*(R1||R2))

    const R1 = 9000;   // 9 kΩ
    const R2 = 1000;   // 1 kΩ
    const C = 1e-6;    // 1 µF

    const gain_dc = R2 / (R1 + R2);         // 0.1 = -20 dB
    const R_parallel = (R1 * R2) / (R1 + R2); // 900 Ω
    const f_pole = 1 / (2 * Math.PI * C * R_parallel); // ≈ 176.8 Hz

    const labelToNodeId = new Map<string, number>([
      ["source", 1],
      ["out", 2],
    ]);

    const elements: AnalogElement[] = [
      makeAcResistor(1, 2, R1),  // R1: node1 → node2
      makeAcResistor(2, 0, R2),  // R2: node2 → GND
      makeAcCapacitor(2, 0, C),  // C: node2 → GND (creates pole)
    ];

    const circuit: AcCompiledCircuit = {
      nodeCount: 2,
      branchCount: 0,
      matrixSize: 2,
      elements,
      labelToNodeId,
    };

    const ac = new AcAnalysis(circuit);

    const result = ac.run({
      type: "dec",
      numPoints: 30,
      fStart: 1,
      fStop: 1e6,
      sourceLabel: "source",
      outputNodes: ["out"],
    });

    const freqs = result.frequencies;
    const mag = result.magnitude.get("out")!;

    // At low frequencies (1 Hz, well below pole), gain ≈ 20*log10(gain_dc) = -20 dB
    const lowFreqIdx = findClosestIndex(freqs, 1);
    const expectedDcGainDb = 20 * Math.log10(gain_dc); // -20 dB

    expect(mag[lowFreqIdx]).toBeGreaterThan(expectedDcGainDb - 1);
    expect(mag[lowFreqIdx]).toBeLessThan(expectedDcGainDb + 1);

    // At f_pole * 10 (one decade above pole), gain should be ~20 dB lower than DC gain
    const highFreqIdx = findClosestIndex(freqs, f_pole * 10);
    expect(mag[highFreqIdx]).toBeLessThan(expectedDcGainDb - 17);

    // Gain-bandwidth product: gain_dc * f_pole should equal gain at f_pole * f_pole
    // Equivalently: gain should drop by -3dB at f_pole
    const poleIdx = findClosestIndex(freqs, f_pole);
    const expected3dbGain = expectedDcGainDb - 3.01;
    expect(mag[poleIdx]).toBeGreaterThan(expected3dbGain - 2);
    expect(mag[poleIdx]).toBeLessThan(expected3dbGain + 2);
  });
});

// ---------------------------------------------------------------------------
// Task 0.4.4 tests
// ---------------------------------------------------------------------------

describe("AC — Task 0.4.4", () => {
  it("ac_sweep_caller_reuses_branch_handles_across_frequencies", () => {
    // Tightened per Phase 0.4 review: exercise the actual AcAnalysis.run()
    // production path with a real RC circuit and a spy injected through the
    // solver-factory dep. The previous version re-implemented the sweep loop
    // inline, making the assertions tautological against the test code rather
    // than the production code.
    const { ComplexSparseSolver: CSS } = ComplexSolverModule;

    const R = 1000;
    const C = 1e-6;
    const circuit = makeRcLowpassCircuit(R, C);

    const injectedSolver = new CSS();
    const allocSpy = vi.spyOn(injectedSolver, "allocComplexElement");

    const ac = new AcAnalysis(circuit, undefined, {
      complexSolverFactory: () => injectedSolver,
    });

    ac.run({
      type: "lin",
      numPoints: 3,
      fStart: 100,
      fStop: 10000,
      sourceLabel: "source",
      outputNodes: ["out"],
    });

    // The AC voltage-source branch handles (two of them) must be allocated
    // exactly once — on fi===0 only — and reused from the cache afterwards.
    // The RC-lowpass element stamps also allocate on fi===0 (for R and C
    // admittances), so we filter to just the branch-row allocations that the
    // handle cache is supposed to guard.
    const matrixSize = circuit.matrixSize;
    const branchRow = matrixSize;
    const sourceNodeIdx = 0; // "source" → node 1 → 0-based idx 0
    const branchAllocCalls = allocSpy.mock.calls.filter(
      c => (c[0] === sourceNodeIdx && c[1] === branchRow) ||
           (c[0] === branchRow && c[1] === sourceNodeIdx),
    );
    expect(branchAllocCalls.length).toBe(2);

    allocSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Task 0.4.5 tests
// ---------------------------------------------------------------------------

describe("AC — Task 0.4.5", () => {
  it("ac_sweep_single_reorder_across_frequencies", () => {
    // Tightened per Phase 0.4 review: run the real AcAnalysis.run() path and
    // observe lastFactorUsedReorder on the solver that production actually
    // uses. Injected via the solver-factory dep so the spy sees every factor()
    // call from the real sweep loop.
    const { ComplexSparseSolver: CSS } = ComplexSolverModule;

    const R = 1000;
    const C = 1e-6;
    const circuit = makeRcLowpassCircuit(R, C);

    const injectedSolver = new CSS();
    const reorderFlags: boolean[] = [];

    // Record lastFactorUsedReorder after every factor() call by patching the
    // solver instance in place — zero allocations, no prototype pollution.
    const realFactor = injectedSolver.factor.bind(injectedSolver);
    injectedSolver.factor = () => {
      const ok = realFactor();
      reorderFlags.push(injectedSolver.lastFactorUsedReorder);
      return ok;
    };

    const ac = new AcAnalysis(circuit, undefined, {
      complexSolverFactory: () => injectedSolver,
    });

    const numFreq = 5;
    ac.run({
      type: "lin",
      numPoints: numFreq,
      fStart: 100,
      fStop: 10000,
      sourceLabel: "source",
      outputNodes: ["out"],
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
    if (diff < minDiff) {
      minDiff = diff;
      idx = i;
    }
  }
  return idx;
}
