/**
 * DC operating point solver with three-level convergence fallback stack.
 *
 * Attempts to find the DC operating point of a circuit using progressively
 * more aggressive convergence aids:
 *
 *   Level 0 — Direct NR: standard Newton-Raphson with configured tolerances
 *   Level 1 — Gmin stepping: shunt conductance from every node to ground,
 *              ramped down from 1e-2 S to params.gmin in decade steps
 *   Level 2 — Source stepping: scale independent sources from 0% to 100%
 *              in 10% increments, using each converged solution as the next guess
 *   Level 3 — Failure: emit blame diagnostics with node attribution
 *
 * Each level emits a diagnostic via DiagnosticCollector before proceeding
 * to the next level or returning.
 */

import type { SparseSolver } from "./sparse-solver.js";
import type { AnalogElement } from "./element.js";
import type { DiagnosticCollector } from "./diagnostics.js";
import type { SimulationParams, DcOpResult } from "../../core/analog-engine-interface.js";
import { makeDiagnostic } from "./diagnostics.js";
import { newtonRaphson } from "./newton-raphson.js";

// ---------------------------------------------------------------------------
// DcOpOptions
// ---------------------------------------------------------------------------

/**
 * Options for the DC operating point solver.
 */
export interface DcOpOptions {
  /** Shared sparse solver instance (pre-allocated). */
  solver: SparseSolver;
  /** All analog elements in the circuit. */
  elements: readonly AnalogElement[];
  /** Total MNA matrix size: nodeCount + branchCount. */
  matrixSize: number;
  /** Solver configuration (tolerances, gmin, maxIterations). */
  params: SimulationParams;
  /** Diagnostic collector for emitting convergence events. */
  diagnostics: DiagnosticCollector;
}

// ---------------------------------------------------------------------------
// Gmin shunt element factory
// ---------------------------------------------------------------------------

/**
 * Create a temporary conductance shunt from a single non-ground node to ground.
 *
 * Used during Gmin stepping to improve convergence by tying every node to
 * ground through a shunt conductance that is ramped down to params.gmin.
 *
 * @param nodeId - The non-ground node index (1-based; solver uses 0-based via nodeId-1)
 * @param gmin   - Conductance in siemens
 */
function makeGminShunt(nodeId: number, gmin: number): AnalogElement {
  return {
    pinNodeIds: [nodeId, 0],
    allNodeIds: [nodeId, 0],
    branchIndex: -1,
    isNonlinear: false,
    isReactive: false,
    stamp(solver: SparseSolver): void {
      // Stamp conductance from nodeId to ground (node 0).
      // Solver uses 0-based indices; node IDs are 1-based (0 = ground).
      solver.stamp(nodeId - 1, nodeId - 1, gmin);
    },
    getPinCurrents(voltages: Float64Array): number[] {
      const v = nodeId > 0 ? voltages[nodeId - 1] : 0;
      const I = gmin * v;
      return [I, -I];
    },
  };
}

// ---------------------------------------------------------------------------
// Source-scale helpers
// ---------------------------------------------------------------------------

/**
 * Set the source scale factor on all elements that support it.
 *
 * Elements that implement `setSourceScale` are independent voltage or current
 * sources. All others are silently skipped.
 *
 * @param elements - Full element list
 * @param factor   - Scale factor in [0, 1]
 */
function scaleAllSources(elements: readonly AnalogElement[], factor: number): void {
  for (const el of elements) {
    if (el.setSourceScale) {
      el.setSourceScale(factor);
    }
  }
}

// ---------------------------------------------------------------------------
// solveDcOperatingPoint
// ---------------------------------------------------------------------------

/**
 * Find the DC operating point of the circuit using the three-level fallback stack.
 *
 * Returns a `DcOpResult` whose `method` field identifies which convergence
 * strategy succeeded (or `'direct'` on the first try).
 *
 * @param opts - Solver configuration and circuit description
 * @returns DC operating point result with node voltages and convergence metadata
 */
export function solveDcOperatingPoint(opts: DcOpOptions): DcOpResult {
  const { solver, elements, matrixSize, params, diagnostics } = opts;

  const nrBase = {
    solver,
    matrixSize,
    maxIterations: params.maxIterations,
    reltol: params.reltol,
    abstol: params.abstol,
    diagnostics,
  };

  // -------------------------------------------------------------------------
  // Level 0 — Direct NR
  // -------------------------------------------------------------------------
  const directResult = newtonRaphson({ ...nrBase, elements });

  if (directResult.converged) {
    diagnostics.emit(
      makeDiagnostic(
        "dc-op-converged",
        "info",
        `DC operating point converged directly in ${directResult.iterations} iteration(s).`,
        { explanation: "Newton-Raphson converged without any convergence aids." },
      ),
    );
    return {
      converged: true,
      method: "direct",
      iterations: directResult.iterations,
      nodeVoltages: directResult.voltages,
      diagnostics: diagnostics.getDiagnostics(),
    };
  }

  let totalIterations = directResult.iterations;
  let lastTrace = directResult.trace;

  // -------------------------------------------------------------------------
  // Level 1 — Gmin stepping
  // -------------------------------------------------------------------------
  // Build Gmin shunt elements for every non-ground node (nodes 1..nodeCount).
  // nodeCount = matrixSize - branchCount; but we don't have branchCount directly.
  // Instead, we shunt every position 1..matrixSize (harmless if it covers branches,
  // because branch rows don't correspond to node voltages in MNA).
  // Actually per MNA structure: first nodeCount rows are node voltages,
  // remaining rows are branch currents. Gmin shunts should only go to node rows.
  // We infer nodeCount as the number of non-branch nodes from elements.
  const nodeCount = _inferNodeCount(elements, matrixSize);

  // Gmin shunt elements: one per non-ground node
  const gminShunts: AnalogElement[] = [];
  for (let n = 1; n <= nodeCount; n++) {
    gminShunts.push(makeGminShunt(n, 1e-2)); // placeholder gmin; updated each step
  }

  // Steps: 1e-2, 1e-3, ..., down to params.gmin (inclusive)
  const gminSteps = _buildGminSteps(params.gmin);

  let gminConverged = false;
  let gminVoltages = new Float64Array(matrixSize);

  for (const gminVal of gminSteps) {
    // Update all shunt elements to the current gmin value
    for (let i = 0; i < gminShunts.length; i++) {
      const nodeId = i + 1;
      gminShunts[i] = makeGminShunt(nodeId, gminVal);
    }

    const augmented = [...gminShunts, ...elements];
    const result = newtonRaphson({
      ...nrBase,
      elements: augmented,
      initialGuess: gminConverged ? gminVoltages : undefined,
    });

    totalIterations += result.iterations;
    lastTrace = result.trace;

    if (result.converged) {
      gminConverged = true;
      gminVoltages = result.voltages;
    } else {
      gminConverged = false;
      break;
    }
  }

  if (gminConverged) {
    diagnostics.emit(
      makeDiagnostic(
        "dc-op-gmin",
        "info",
        `DC operating point converged via Gmin stepping (final gmin = ${params.gmin}).`,
        {
          explanation:
            "Direct Newton-Raphson failed. Gmin stepping succeeded: conductance shunts were added " +
            "to every node and ramped down to the configured gmin value.",
        },
      ),
    );
    return {
      converged: true,
      method: "gmin-stepping",
      iterations: totalIterations,
      nodeVoltages: gminVoltages,
      diagnostics: diagnostics.getDiagnostics(),
    };
  }

  // -------------------------------------------------------------------------
  // Level 2 — Source stepping
  // -------------------------------------------------------------------------
  // Scale all independent sources to 0, solve (zero-source circuit is trivial),
  // then ramp from 10% to 100% in 10% increments.
  scaleAllSources(elements, 0);

  let sourceVoltages = new Float64Array(matrixSize);
  let sourceConverged = false;

  // Solve zero-source circuit (should converge trivially)
  const zeroResult = newtonRaphson({
    ...nrBase,
    elements,
    initialGuess: sourceVoltages,
  });
  totalIterations += zeroResult.iterations;
  lastTrace = zeroResult.trace;

  if (zeroResult.converged) {
    sourceVoltages = zeroResult.voltages;
    sourceConverged = true;

    // Ramp sources in 10% increments: 10%, 20%, ..., 100%
    for (let step = 1; step <= 10 && sourceConverged; step++) {
      const factor = step / 10;
      scaleAllSources(elements, factor);

      const stepResult = newtonRaphson({
        ...nrBase,
        elements,
        initialGuess: sourceVoltages,
      });
      totalIterations += stepResult.iterations;
      lastTrace = stepResult.trace;

      if (stepResult.converged) {
        sourceVoltages = stepResult.voltages;
      } else {
        sourceConverged = false;
      }
    }
  }

  // Restore sources to full scale regardless of outcome
  scaleAllSources(elements, 1);

  if (sourceConverged) {
    diagnostics.emit(
      makeDiagnostic(
        "dc-op-source-step",
        "warning",
        "DC operating point converged via source stepping.",
        {
          explanation:
            "Direct NR and Gmin stepping both failed. Source stepping succeeded: independent " +
            "sources were scaled from 0% to 100% in 10% increments.",
        },
      ),
    );
    return {
      converged: true,
      method: "source-stepping",
      iterations: totalIterations,
      nodeVoltages: sourceVoltages,
      diagnostics: diagnostics.getDiagnostics(),
    };
  }

  // -------------------------------------------------------------------------
  // Level 3 — Failure with blame attribution
  // -------------------------------------------------------------------------
  // Extract blame from the last NR trace: which node had the largest change.
  const blameNode =
    lastTrace.length > 0 ? lastTrace[lastTrace.length - 1].largestChangeNode : -1;
  const involvedNodes = blameNode >= 0 ? [blameNode] : [];

  diagnostics.emit(
    makeDiagnostic(
      "dc-op-failed",
      "error",
      "DC operating point failed to converge after all fallback strategies.",
      {
        explanation:
          "All three convergence strategies (direct NR, Gmin stepping, source stepping) failed. " +
          "Check the circuit for floating nodes, voltage source loops, or ambiguous operating points.",
        involvedNodes,
      },
    ),
  );

  return {
    converged: false,
    method: "direct",
    iterations: totalIterations,
    nodeVoltages: new Float64Array(matrixSize),
    diagnostics: diagnostics.getDiagnostics(),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Infer the number of non-ground voltage nodes from the element list.
 *
 * Scans all node indices across all elements and returns the maximum
 * non-ground node ID encountered. This gives the count of voltage nodes
 * without requiring the caller to pass nodeCount separately.
 *
 * @param elements   - The element list
 * @param matrixSize - Upper bound (used as fallback if no nodes found)
 */
function _inferNodeCount(elements: readonly AnalogElement[], matrixSize: number): number {
  let maxNode = 0;
  for (const el of elements) {
    for (const n of el.allNodeIds) {
      if (n > maxNode) maxNode = n;
    }
  }
  // If no node information found, conservatively use matrixSize
  // (Gmin shunts on branch rows are no-ops since they stamp nothing for row 0).
  return maxNode > 0 ? maxNode : matrixSize;
}

/**
 * Build the sequence of Gmin values for Gmin stepping.
 *
 * Steps logarithmically by decade from 1e-2 down to `targetGmin` (inclusive).
 * If `targetGmin >= 1e-2`, returns just `[targetGmin]`.
 *
 * @param targetGmin - The final configured gmin (params.gmin)
 * @returns Array of gmin values in descending order
 */
function _buildGminSteps(targetGmin: number): number[] {
  const steps: number[] = [];
  let g = 1e-2;
  while (g > targetGmin * 1.001) {
    steps.push(g);
    g /= 10;
  }
  steps.push(targetGmin);
  return steps;
}
