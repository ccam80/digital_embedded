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
 * Clamps the change in Vgs per NR iteration to 0.5 V when both the old and
 * new voltages are above threshold (Vto), preventing oscillation in the
 * saturation-region transconductance equation.
 *
 * @param vnew - Proposed new Vgs
 * @param vold - Previous Vgs
 * @param vto  - Threshold voltage
 * @returns    - Voltage-limited new Vgs
 */
export function fetlim(vnew: number, vold: number, vto: number): number {
  const MAX_STEP = 0.5;
  if (vnew > vto && vold > vto) {
    const delta = vnew - vold;
    if (delta > MAX_STEP) {
      return vold + MAX_STEP;
    }
    if (delta < -MAX_STEP) {
      return vold - MAX_STEP;
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
 *  6. Updates operating points — elements apply voltage limiting and write
 *     limited voltages back into the solution vector, and update their
 *     linearized companion model (geq/ieq) for the next iteration
 *  7. Checks global node-voltage convergence and element-specific checks
 *  8. Records a ConvergenceTrace entry
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

    // 5. Update operating points: elements apply voltage limiting and write
    //    limited junction voltages back into voltages[], then recompute
    //    their companion model (geq/ieq) for the next stampNonlinear.
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
      for (const ni of (el.pinNodeIds ?? [])) {
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
