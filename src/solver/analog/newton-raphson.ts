/**
 * Newton-Raphson nonlinear iteration loop for MNA circuit simulation.
 *
 * Implements the core NR loop with separate linear/nonlinear stamp passes,
 * voltage limiting (pnjlim for PN junctions, fetlim for MOSFETs), global and
 * element-specific convergence checking, and ConvergenceTrace blame tracking.
 */

import type { SparseSolver } from "./sparse-solver.js";
import type { AnalogElement } from "./element.js";
import { MNAAssembler } from "./mna-assembler.js";
import type { DiagnosticCollector, ConvergenceTrace } from "./diagnostics.js";
import { makeDiagnostic } from "./diagnostics.js";

// ---------------------------------------------------------------------------
// NROptions / NRResult
// ---------------------------------------------------------------------------

/** Configuration for a single Newton-Raphson solve. */
export interface NROptions {
  /** Shared sparse solver instance (pre-configured for this circuit). */
  solver: SparseSolver;
  /** All analog elements in the circuit. */
  elements: readonly AnalogElement[];
  /** MNA matrix size = nodeCount + branchCount. */
  matrixSize: number;
  /** Maximum number of NR iterations before declaring failure. */
  maxIterations: number;
  /** Relative convergence tolerance. */
  reltol: number;
  /** Absolute voltage convergence tolerance in volts. */
  abstol: number;
  /** Optional initial guess for the solution vector. */
  initialGuess?: Float64Array;
  /** Diagnostic collector for emitting solver events. */
  diagnostics: DiagnosticCollector;
}

/** Result of a Newton-Raphson solve. */
export interface NRResult {
  /** Whether the iteration converged within maxIterations. */
  converged: boolean;
  /** Number of iterations performed. */
  iterations: number;
  /** Final solution vector (node voltages + branch currents). */
  voltages: Float64Array;
  /** Per-iteration convergence trace for blame tracking. */
  trace: ConvergenceTrace[];
}

// ---------------------------------------------------------------------------
// Voltage limiting functions
// ---------------------------------------------------------------------------

/**
 * PN-junction voltage limiting (pnjlim).
 *
 * Prevents exponential runaway in diode/BJT junction voltage updates by
 * compressing large forward-bias steps logarithmically, and clamping
 * large reverse-bias steps.
 *
 * When |vnew - vold| <= 2*vt AND vnew <= vcrit, the step is within the
 * quasi-linear region and is returned unchanged. Otherwise the step is
 * compressed:
 * - Forward (vnew > vcrit, large step): vold + vt*(1 + ln((vnew-vold)/vt))
 * - Reverse (large negative step): vold - 2*vt
 *
 * @param vnew  - Proposed new junction voltage
 * @param vold  - Previous junction voltage
 * @param vt    - Thermal voltage (kT/q, ~0.02585 V at 300 K)
 * @param vcrit - Critical voltage above which limiting engages
 * @returns     - Voltage-limited new junction voltage
 */
export function pnjlim(vnew: number, vold: number, vt: number, vcrit: number): number {
  if (vnew > vcrit && Math.abs(vnew - vold) > 2 * vt) {
    // Large forward-bias step: compress logarithmically to prevent exp() overflow
    if (vold > 0) {
      const arg = 1 + (vnew - vold) / vt;
      if (arg > 0) {
        vnew = vold + vt * Math.log(arg);
      } else {
        vnew = vcrit;
      }
    } else {
      vnew = vt * Math.log(vnew / vt);
    }
  }
  // Reverse-bias steps are not limited: exp(vnew/vt) ≈ 0 for large negative
  // vnew, so no exponential runaway can occur. Limiting reverse steps would
  // cause extremely slow convergence for reverse-biased junctions.
  return vnew;
}

/**
 * MOSFET gate-source voltage limiting (fetlim).
 *
 * Three-zone algorithm from SPICE3f5/ngspice DEVfetlim (devsup.c):
 *
 *   Zone 1 — Deep ON (vold >= vto + 3.5):
 *     Decreasing: clamp to max(-delta, vtstlo); floor at vto + 2
 *     Increasing: clamp to +vtsthi
 *
 *   Zone 2 — Near threshold (vto <= vold < vto + 3.5):
 *     Decreasing: floor at vto - 0.5
 *     Increasing: cap at vto + 4
 *
 *   Zone 3 — OFF (vold < vto):
 *     Decreasing: clamp to -vtsthi
 *     Increasing toward threshold: clamp to vtstlo; hard cap at vto + 0.5
 *
 * @param vnew - Proposed new Vgs
 * @param vold - Previous Vgs
 * @param vto  - Threshold voltage
 * @returns    - Voltage-limited new Vgs
 */
export function fetlim(vnew: number, vold: number, vto: number): number {
  const vtsthi = Math.abs(2 * (vold - vto)) + 2;
  const vtstlo = Math.abs(vold - vto) + 1;
  const vtox = vto + 3.5;
  const delv = vnew - vold;

  if (vold >= vto) {
    // ON
    if (vold >= vtox) {
      // Deep on
      if (delv <= 0) {
        // Decreasing
        if (vnew >= vtox) {
          if (-delv > vtstlo) vnew = vold - vtstlo;
        } else {
          vnew = Math.max(vnew, vto + 2);
        }
      } else {
        // Increasing
        if (delv >= vtsthi) vnew = vold + vtsthi;
      }
    } else {
      // Near threshold
      if (delv <= 0) {
        vnew = Math.max(vnew, vto - 0.5);
      } else {
        vnew = Math.min(vnew, vto + 4);
      }
    }
  } else {
    // OFF
    if (delv <= 0) {
      if (-delv > vtsthi) vnew = vold - vtsthi;
    } else {
      const vtemp = vto + 0.5;
      if (vnew <= vtemp) {
        if (delv > vtstlo) vnew = vold + vtstlo;
      } else {
        vnew = vtemp;
      }
    }
  }
  return vnew;
}

/**
 * MOSFET drain-source voltage limiting (limvds).
 *
 * Prevents large Vds swings per NR iteration. Critical for switching
 * circuits where Vds can swing across the full supply range.
 *
 * Algorithm from SPICE3f5/ngspice DEVlimvds (devsup.c).
 *
 * @param vnew - Proposed new Vds
 * @param vold - Previous Vds
 * @returns    - Voltage-limited new Vds
 */
export function limvds(vnew: number, vold: number): number {
  if (vold >= 3.5) {
    if (vnew > vold) {
      vnew = Math.min(vnew, 3 * vold + 2);
    } else if (vnew < 3.5) {
      vnew = Math.max(vnew, 2);
    }
  } else {
    if (vnew > vold) {
      vnew = Math.min(vnew, 4);
    } else {
      vnew = Math.max(vnew, -0.5);
    }
  }
  return vnew;
}

// ---------------------------------------------------------------------------
// Newton-Raphson iteration loop
// ---------------------------------------------------------------------------

/**
 * Run the Newton-Raphson nonlinear iteration loop.
 *
 * Each iteration:
 *  1. Clears the MNA matrix via `solver.beginAssembly`
 *  2. Stamps linear contributions (topology-constant)
 *  3. Stamps nonlinear contributions at the current operating point
 *  4. Finalizes and factors the matrix
 *  5. Solves for updated voltages
 *  6. Node damping (ngspice heuristic): if max voltage change > 10 V, scale
 *     all updates down (min factor 0.1) to prevent runaway steps
 *  7. Backtracking line search: if the max voltage change is growing vs the
 *     previous iteration, halve the step to break divergence
 *  8. Updates operating points — elements apply voltage limiting and update
 *     their linearized companion model (geq/ieq) for the next iteration
 *  9. Checks global node-voltage convergence and element-specific checks
 * 10. Records a ConvergenceTrace entry
 *
 * Non-convergence is returned via the result object, never thrown. The caller
 * (DC operating point solver) decides the appropriate fallback strategy.
 *
 * @param opts - NR iteration options
 * @returns    - NRResult with convergence status, iterations, voltages, trace
 */
export function newtonRaphson(opts: NROptions): NRResult {
  const { solver, elements, matrixSize, maxIterations, reltol, abstol, diagnostics } = opts;

  const assembler = new MNAAssembler(solver);
  const voltages = new Float64Array(matrixSize);
  const prevVoltages = new Float64Array(matrixSize);
  const trace: ConvergenceTrace[] = [];
  let prevIterMaxChange = Infinity; // max voltage change from the previous iteration (for line search)

  // Initialize from initial guess if provided
  if (opts.initialGuess) {
    voltages.set(opts.initialGuess);
  }

  // Detect whether any nonlinear elements are present.
  // A purely linear circuit solves exactly in one matrix solve; there is no
  // need to compare consecutive iterates — the first solution is the answer.
  const hasNonlinear = elements.some((el) => el.isNonlinear);

  // Initialize all nonlinear elements to the starting operating point
  // (sets up geq/ieq for the first stampNonlinear call)
  assembler.updateOperatingPoints(elements, voltages);

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // Save previous voltages for convergence check
    prevVoltages.set(voltages);

    // 1. Clear matrix and re-stamp both linear and nonlinear contributions
    solver.beginAssembly(matrixSize);
    assembler.stampLinear(elements);
    assembler.stampNonlinear(elements);
    solver.finalize();

    // 2. Factor — if singular, record and report non-convergence
    const factorResult = solver.factor();
    if (!factorResult.success) {
      trace.push(_makeTrace(iteration, -1, -1, false));
      diagnostics.emit(
        makeDiagnostic("singular-matrix", "error", "Singular matrix during NR iteration", {
          explanation: `The MNA matrix became singular at iteration ${iteration + 1}.`,
          suggestions: [],
        }),
      );
      return { converged: false, iterations: iteration + 1, voltages, trace };
    }

    // 3. Solve for new voltages (written into voltages in-place)
    solver.solve(voltages);

    // 4. For purely linear circuits, the first solve gives the exact answer.
    //    Return immediately — no convergence iteration needed.
    if (!hasNonlinear) {
      trace.push(_makeTrace(iteration, 0, -1, false));
      return { converged: true, iterations: iteration + 1, voltages, trace };
    }

    // 5a. Node damping (ngspice heuristic from niiter.c):
    //     If any voltage node changed by more than 10V, scale ALL updates
    //     by 10/maxDelta. Minimum scale factor 0.1.
    //     Only active after first iteration (need a reference point).
    if (iteration > 0) {
      let maxDelta = 0;
      for (let i = 0; i < matrixSize; i++) {
        const delta = Math.abs(voltages[i] - prevVoltages[i]);
        if (delta > maxDelta) maxDelta = delta;
      }
      if (maxDelta > 10) {
        const dampFactor = Math.max(10 / maxDelta, 0.1);
        for (let i = 0; i < matrixSize; i++) {
          voltages[i] = prevVoltages[i] + dampFactor * (voltages[i] - prevVoltages[i]);
        }
      }
    }

    // 5b. Backtracking line search: activates only when the NR step is GROWING
    //     (max voltage change this iteration exceeds the previous iteration).
    //     A growing step indicates divergence, not convergence. One halving
    //     is applied as a one-shot perturbation to redirect toward convergence.
    //     Only active after iteration 1 to allow the first step to be unrestricted.
    if (iteration >= 2) {
      let maxChange = 0;
      for (let i = 0; i < matrixSize; i++) {
        maxChange = Math.max(maxChange, Math.abs(voltages[i] - prevVoltages[i]));
      }
      if (maxChange > prevIterMaxChange && maxChange > abstol * 100) {
        // Step is growing: halve to break divergence
        for (let i = 0; i < matrixSize; i++) {
          voltages[i] = prevVoltages[i] + 0.5 * (voltages[i] - prevVoltages[i]);
        }
        prevIterMaxChange = maxChange * 0.5;
      } else {
        prevIterMaxChange = maxChange;
      }
    }

    // 5c. Update operating points: elements apply voltage limiting, recompute
    //     their companion model (geq/ieq) for the next stampNonlinear.
    assembler.updateOperatingPoints(elements, voltages);

    // 6. Check global node-voltage convergence criterion
    let globalConverged = true;
    let largestChangeNode = 0;
    let largestChangeMag = 0;

    for (let i = 0; i < matrixSize; i++) {
      const delta = Math.abs(voltages[i] - prevVoltages[i]);
      if (delta > largestChangeMag) {
        largestChangeMag = delta;
        largestChangeNode = i;
      }
      const tol = abstol + reltol * Math.abs(voltages[i]);
      if (delta > tol) {
        globalConverged = false;
      }
    }

    // 7. Element-specific convergence check
    const elemConverged = assembler.checkAllConverged(elements, voltages, prevVoltages);

    // 8. Find element with largest contribution to non-convergence (blame tracking)
    let largestChangeElement = -1;
    let largestElemDelta = -1;
    for (let ei = 0; ei < elements.length; ei++) {
      const el = elements[ei];
      if (!el.isNonlinear) continue;
      let elDelta = 0;
      for (const ni of el.pinNodeIds) {
        if (ni > 0 && ni - 1 < matrixSize) {
          const d = Math.abs(voltages[ni - 1] - prevVoltages[ni - 1]);
          if (d > elDelta) elDelta = d;
        }
      }
      if (elDelta > largestElemDelta) {
        largestElemDelta = elDelta;
        largestChangeElement = ei;
      }
    }

    // 9. Oscillation detection: same node shows large change in consecutive iters
    let oscillating = false;
    if (trace.length > 0) {
      const prevTrace = trace[trace.length - 1];
      if (
        prevTrace.largestChangeNode === largestChangeNode &&
        largestChangeMag > abstol * 10
      ) {
        oscillating = true;
      }
    }

    trace.push(_makeTrace(iteration, largestChangeNode, largestChangeElement, oscillating));

    // 10. Return on convergence
    if (globalConverged && elemConverged) {
      return { converged: true, iterations: iteration + 1, voltages, trace };
    }
  }

  return { converged: false, iterations: maxIterations, voltages, trace };
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

function _makeTrace(
  iteration: number,
  largestChangeNode: number,
  largestChangeElement: number,
  oscillating: boolean,
): ConvergenceTrace {
  return {
    iteration,
    largestChangeNode,
    largestChangeElement,
    oscillating,
    fallbackLevel: "none",
  };
}
