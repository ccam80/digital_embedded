/**
 * AC Small-Signal Analysis Engine.
 *
 * Implements SPICE-style .AC analysis: given a converged DC operating point,
 * linearize all nonlinear elements at their operating points, then sweep
 * frequency to compute the complex transfer function H(f) = V_out(f) / V_in(f).
 *
 * The analysis builds a ComplexSparseSolver of the same dimension as the real
 * MNA system. For each frequency point:
 *   1. Clear the complex matrix.
 *   2. Call element.stampAc(complexSolver, omega) on every element.
 *   3. Inject 1+0j at the AC source node.
 *   4. Solve the complex system.
 *   5. Read node voltages for the requested output nodes.
 *
 * Passive element AC stamps:
 *   Resistor R:    Y = G = 1/R      (real admittance)
 *   Capacitor C:   Y = jωC          (imaginary admittance)
 *   Inductor L:    Y = 1/(jωL)      (imaginary admittance, negative imaginary part)
 *
 * Nonlinear elements stamp their small-signal conductances (gm, gds, gπ) from
 * the last NR iteration stored internally after DC OP convergence.
 */

import { ComplexSparseSolver } from "./complex-sparse-solver.js";
import { DiagnosticCollector, makeDiagnostic } from "./diagnostics.js";
import { solveDcOperatingPoint } from "./dc-operating-point.js";
import { SparseSolver } from "./sparse-solver.js";
import type { AnalogElement } from "./element.js";
import type { SimulationParams } from "../../core/analog-engine-interface.js";
import type { Diagnostic } from "../../compile/types.js";
import { DEFAULT_SIMULATION_PARAMS } from "../../core/analog-engine-interface.js";

// ---------------------------------------------------------------------------
// AcParams, AcResult — canonical home is core/analog-types.ts; re-exported here
// ---------------------------------------------------------------------------

import type { AcParams, AcResult } from "../../core/analog-types.js";
export type { AcParams, AcResult };

// ---------------------------------------------------------------------------
// AcAnalysis
// ---------------------------------------------------------------------------

/**
 * Compiled circuit shape expected by AcAnalysis.
 */
export interface AcCompiledCircuit {
  readonly nodeCount: number;
  readonly branchCount: number;
  readonly matrixSize: number;
  readonly elements: readonly AnalogElement[];
  readonly labelToNodeId: Map<string, number>;
}

/**
 * AC small-signal analysis.
 *
 * Usage:
 *   const ac = new AcAnalysis(compiled);
 *   const result = ac.run(params);
 */
export class AcAnalysis {
  private readonly _compiled: AcCompiledCircuit;
  private readonly _params: SimulationParams;

  constructor(compiled: AcCompiledCircuit, params?: Partial<SimulationParams>) {
    this._compiled = compiled;
    this._params = { ...DEFAULT_SIMULATION_PARAMS, ...params };
  }

  /**
   * Run AC analysis.
   *
   * Steps:
   *   1. Solve DC operating point to linearize nonlinear elements.
   *   2. Build frequency array from params.
   *   3. For each frequency, stamp complex admittances and solve.
   *   4. Extract transfer function at output nodes.
   */
  run(params: AcParams): AcResult {
    const { compiled, diagnostics } = this._setupAnalysis();

    // Step 1: Solve DC operating point
    const dcSolver = new SparseSolver();
    const dcDiagnostics = new DiagnosticCollector();
    const dcResult = solveDcOperatingPoint({
      solver: dcSolver,
      elements: compiled.elements,
      matrixSize: compiled.matrixSize,
      nodeCount: compiled.nodeCount,
      params: this._params,
      diagnostics: dcDiagnostics,
    });

    // After DC OP, nonlinear elements have their small-signal parameters set.
    // We don't need the DC voltages explicitly — they're baked into element state.

    // Step 2: Find AC source node
    const sourceNodeId = compiled.labelToNodeId.get(params.sourceLabel);
    if (sourceNodeId === undefined) {
      diagnostics.emit(
        makeDiagnostic("ac-no-source", "error", `AC source '${params.sourceLabel}' not found`, {
          explanation:
            `No node with label '${params.sourceLabel}' was found in the circuit. ` +
            "Specify the label of a voltage source node as the AC excitation source.",
        }),
      );
      return this._emptyResult(params, diagnostics.getDiagnostics());
    }

    // Emit diagnostic if DC OP did not converge (warn but proceed)
    if (!dcResult.converged) {
      diagnostics.emit(
        makeDiagnostic("convergence-failed", "warning", "DC operating point did not converge before AC sweep", {
          explanation:
            "AC small-signal analysis uses the DC operating point to linearize nonlinear elements. " +
            "The DC OP failed to converge; AC results may be inaccurate.",
        }),
      );
    }

    // Step 3: Build frequency array
    const frequencies = buildFrequencyArray(params);
    const numFreq = frequencies.length;

    // Step 4: Collect output node IDs
    const outputNodeIds = new Map<string, number>();
    for (const label of params.outputNodes) {
      const nodeId = compiled.labelToNodeId.get(label);
      if (nodeId !== undefined) {
        outputNodeIds.set(label, nodeId);
      }
    }

    // Allocate result arrays
    const magnitudeMap = new Map<string, Float64Array>();
    const phaseMap = new Map<string, Float64Array>();
    const realMap = new Map<string, Float64Array>();
    const imagMap = new Map<string, Float64Array>();

    for (const label of params.outputNodes) {
      magnitudeMap.set(label, new Float64Array(numFreq));
      phaseMap.set(label, new Float64Array(numFreq));
      realMap.set(label, new Float64Array(numFreq));
      imagMap.set(label, new Float64Array(numFreq));
    }

    // MNA matrix size — expand by 1 for the AC voltage source branch row
    const N = compiled.matrixSize;
    const N_ac = N + 1;               // AC system size: add one branch row for V_ac
    const branchRow = N;              // 0-based index of the AC source branch row
    const sourceNodeIdx = sourceNodeId - 1; // 0-based node index (sourceNodeId is 1-based)

    // Allocate solution vectors (reused each frequency)
    const xRe = new Float64Array(N_ac);
    const xIm = new Float64Array(N_ac);

    // Step 5: Frequency sweep
    const complexSolver = new ComplexSparseSolver();

    for (let fi = 0; fi < numFreq; fi++) {
      const f = frequencies[fi];
      const omega = 2 * Math.PI * f;

      // Assemble complex MNA matrix for this frequency
      complexSolver.beginAssembly(N_ac);

      // Stamp all element AC contributions
      for (const el of compiled.elements) {
        if (el.stampAc) {
          el.stampAc(complexSolver, omega);
        }
      }

      // Stamp the ideal AC voltage source: V(sourceNode) = 1 + 0j
      // MNA voltage source stamp (node positive = sourceNodeId, negative = ground):
      //   B[sourceNodeIdx, branchRow] += 1   (B sub-matrix: node row, branch col)
      //   C[branchRow, sourceNodeIdx] += 1   (C sub-matrix: branch row, node col)
      //   RHS[branchRow] = 1 + 0j            (voltage constraint: V_src = 1V AC)
      if (sourceNodeIdx >= 0) {
        complexSolver.stamp(sourceNodeIdx, branchRow, 1.0, 0.0);
        complexSolver.stamp(branchRow, sourceNodeIdx, 1.0, 0.0);
      }
      complexSolver.stampRHS(branchRow, 1.0, 0.0);

      complexSolver.finalize();
      const ok = complexSolver.factor();

      if (ok) {
        complexSolver.solve(xRe, xIm);

        // Extract transfer function at each output node
        for (const [label, nodeId] of outputNodeIds) {
          const idx = nodeId - 1; // 0-based solver index
          if (idx >= 0 && idx < N) {
            const re = xRe[idx];
            const im = xIm[idx];
            const mag = Math.sqrt(re * re + im * im);
            const magDb = mag > 0 ? 20 * Math.log10(mag) : -300;
            const phaseDeg = (Math.atan2(im, re) * 180) / Math.PI;

            realMap.get(label)![fi] = re;
            imagMap.get(label)![fi] = im;
            magnitudeMap.get(label)![fi] = magDb;
            phaseMap.get(label)![fi] = phaseDeg;
          }
        }
      }
      // On solver failure at this frequency: leave arrays at 0 (already initialized)
    }

    return {
      frequencies,
      magnitude: magnitudeMap,
      phase: phaseMap,
      real: realMap,
      imag: imagMap,
      diagnostics: diagnostics.getDiagnostics(),
    };
  }

  private _setupAnalysis(): {
    compiled: AcCompiledCircuit;
    diagnostics: DiagnosticCollector;
  } {
    const diagnostics = new DiagnosticCollector();
    return { compiled: this._compiled, diagnostics };
  }

  private _emptyResult(params: AcParams, diagList: Diagnostic[]): AcResult {
    const frequencies = buildFrequencyArray(params);
    const n = frequencies.length;
    const magnitude = new Map<string, Float64Array>();
    const phase = new Map<string, Float64Array>();
    const real = new Map<string, Float64Array>();
    const imag = new Map<string, Float64Array>();
    for (const label of params.outputNodes) {
      magnitude.set(label, new Float64Array(n));
      phase.set(label, new Float64Array(n));
      real.set(label, new Float64Array(n));
      imag.set(label, new Float64Array(n));
    }
    return { frequencies, magnitude, phase, real, imag, diagnostics: diagList };
  }
}

// ---------------------------------------------------------------------------
// buildFrequencyArray — generate frequency points for a sweep
// ---------------------------------------------------------------------------

/**
 * Generate the frequency array for an AC sweep.
 *
 * - 'lin': numPoints equally-spaced from fStart to fStop (inclusive).
 * - 'dec': numPoints per decade; total = ceil(log10(fStop/fStart)) * numPoints.
 * - 'oct': numPoints per octave; total = ceil(log2(fStop/fStart)) * numPoints.
 */
export function buildFrequencyArray(params: AcParams): Float64Array {
  const { type, numPoints, fStart, fStop } = params;

  if (type === "lin") {
    const n = Math.max(1, numPoints);
    const freqs = new Float64Array(n);
    if (n === 1) {
      freqs[0] = fStart;
    } else {
      const step = (fStop - fStart) / (n - 1);
      for (let i = 0; i < n; i++) {
        freqs[i] = fStart + i * step;
      }
    }
    return freqs;
  }

  if (type === "dec") {
    const decades = Math.log10(fStop / fStart);
    const total = Math.round(decades * numPoints);
    const freqs = new Float64Array(total);
    for (let i = 0; i < total; i++) {
      freqs[i] = fStart * Math.pow(10, (i / numPoints));
    }
    return freqs;
  }

  // 'oct'
  const octaves = Math.log2(fStop / fStart);
  const total = Math.round(octaves * numPoints);
  const freqs = new Float64Array(total);
  for (let i = 0; i < total; i++) {
    freqs[i] = fStart * Math.pow(2, i / numPoints);
  }
  return freqs;
}
