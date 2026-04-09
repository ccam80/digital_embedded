/**
 * DC operating point solver — ngspice CKTop three-level fallback.
 *
 * Implements the three-level convergence stack from ngspice cktop.c:20-79:
 *
 *   Level 0 — Direct NR: standard Newton-Raphson with params.maxIterations
 *   Level 1 — dynamicGmin: adaptive diagonal conductance stepping
 *              (cktop.c:127-258), analogous to ngspice's CKTdcOp gmin path
 *   Level 2 — gillespieSrc: adaptive source stepping
 *              (cktop.c:354-546), Gillespie source-stepping algorithm
 *   Level 3 — Failure: emit blame diagnostics
 *
 * Variable mapping (ngspice → ours):
 *   CKTdiagGmin      → diagonalGmin (NR option)
 *   CKTgmin          → params.gmin
 *   CKTgminFactor    → 10 (local, cktntask.c:103)
 *   CKTdcTrcvMaxIter → params.dcTrcvMaxIter (50)
 *   CKTdcMaxIter     → params.maxIterations (100)
 *   CKTrhsOld        → voltages
 *   CKTstate0        → statePool.state0
 *   OldRhsOld        → savedVoltages
 *   OldCKTstate0     → savedState0
 */

import type { SparseSolver } from "./sparse-solver.js";
import type { AnalogElement } from "./element.js";
import type { DiagnosticCollector } from "./diagnostics.js";
import type { SimulationParams, DcOpResult } from "../../core/analog-engine-interface.js";
import { makeDiagnostic } from "./diagnostics.js";
import { newtonRaphson } from "./newton-raphson.js";
import type { LimitingEvent } from "./newton-raphson.js";

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
  /** Solver configuration (tolerances, gmin, maxIterations, dcTrcvMaxIter). */
  params: SimulationParams;
  /** Diagnostic collector for emitting convergence events. */
  diagnostics: DiagnosticCollector;
  /** Number of node-voltage rows (0..nodeCount-1) in the MNA solution vector. */
  nodeCount: number;
  /** Optional shared state pool for per-element operating-point state. */
  statePool?: { state0: Float64Array; reset(): void } | null;
  /** Optional post-NR-iteration hook for harness instrumentation. */
  postIterationHook?: (
    iteration: number,
    voltages: Float64Array,
    prevVoltages: Float64Array,
    noncon: number,
    globalConverged: boolean,
    elemConverged: boolean,
    limitingEvents: LimitingEvent[],
    convergenceFailedElements: string[],
  ) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Scale all independent sources by factor.
 * Elements without setSourceScale are silently skipped.
 *
 * @param elements - Full element list
 * @param factor   - Scale factor in [0, 1]
 */
// cktop.c:354 (source scaling helper)
function scaleAllSources(elements: readonly AnalogElement[], factor: number): void {
  for (const el of elements) {
    if (el.setSourceScale) {
      el.setSourceScale(factor);
    }
  }
}

/**
 * Zero both the voltage vector and the state pool's state0 array.
 *
 * @param voltages   - MNA solution vector to zero
 * @param statePool  - Optional state pool (state0 zeroed when present)
 */
// cktop.c:140-141 (CKTrhsOld zeroing before gmin stepping)
function zeroState(
  voltages: Float64Array,
  statePool: { state0: Float64Array } | null | undefined,
): void {
  voltages.fill(0);
  if (statePool) {
    statePool.state0.fill(0);
  }
}

/**
 * Copy current voltages and state0 into saved buffers.
 *
 * @param voltages    - Current MNA solution vector (source)
 * @param saved       - Destination buffer for voltages
 * @param statePool   - Optional state pool (state0 saved when present)
 * @param savedState  - Destination buffer for state0
 */
// cktop.c:224-225 (OldRhsOld / OldCKTstate0 save)
function saveSnapshot(
  voltages: Float64Array,
  saved: Float64Array,
  statePool: { state0: Float64Array } | null | undefined,
  savedState: Float64Array,
): void {
  saved.set(voltages);
  if (statePool) {
    savedState.set(statePool.state0);
  }
}

/**
 * Restore voltages and state0 from saved buffers.
 *
 * @param voltages    - Destination MNA solution vector
 * @param saved       - Source buffer for voltages
 * @param statePool   - Optional state pool (state0 restored when present)
 * @param savedState  - Source buffer for state0
 */
// cktop.c:240-241 (OldRhsOld / OldCKTstate0 restore)
function restoreSnapshot(
  voltages: Float64Array,
  saved: Float64Array,
  statePool: { state0: Float64Array } | null | undefined,
  savedState: Float64Array,
): void {
  voltages.set(saved);
  if (statePool) {
    statePool.state0.set(savedState);
  }
}

// ---------------------------------------------------------------------------
// solveDcOperatingPoint
// ---------------------------------------------------------------------------

/**
 * Find the DC operating point of the circuit using the ngspice CKTop
 * three-level fallback stack (cktop.c:20-79).
 *
 * Returns a `DcOpResult` whose `method` field identifies which convergence
 * strategy succeeded (or 'direct' on failure).
 *
 * @param opts - Solver configuration and circuit description
 * @returns DC operating point result with node voltages and convergence metadata
 */
export function solveDcOperatingPoint(opts: DcOpOptions): DcOpResult {
  const { solver, elements, matrixSize, params, diagnostics, nodeCount, statePool, postIterationHook } = opts;

  const nrBase = {
    solver,
    matrixSize,
    nodeCount,
    reltol: params.reltol,
    abstol: params.abstol,
    iabstol: params.iabstol,
    isDcOp: true,
    diagnostics,
    nodeDamping: params.nodeDamping ?? false,
    statePool: statePool ?? null,
    postIterationHook,
  };

  // -------------------------------------------------------------------------
  // Level 0 — Direct NR (cktop.c:56-79)
  // -------------------------------------------------------------------------
  const directResult = newtonRaphson({
    ...nrBase,
    maxIterations: params.maxIterations,
    elements,
  });

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

  // -------------------------------------------------------------------------
  // Level 1 — dynamicGmin (cktop.c:127-258)
  // -------------------------------------------------------------------------
  const gminResult = dynamicGmin(nrBase, elements, params, diagnostics, statePool, matrixSize);
  totalIterations += gminResult.iterations;

  if (gminResult.converged) {
    diagnostics.emit(
      makeDiagnostic(
        "dc-op-gmin",
        "info",
        `DC operating point converged via dynamic Gmin stepping (final gmin = ${params.gmin}).`,
        {
          explanation:
            "Direct Newton-Raphson failed. Dynamic Gmin stepping succeeded: adaptive diagonal " +
            "conductance was stepped from 1e-2 S down to params.gmin.",
        },
      ),
    );
    return {
      converged: true,
      method: "dynamic-gmin",
      iterations: totalIterations,
      nodeVoltages: gminResult.voltages,
      diagnostics: diagnostics.getDiagnostics(),
    };
  }

  // -------------------------------------------------------------------------
  // Level 2 — spice3Gmin (cktop.c:273-341)
  // -------------------------------------------------------------------------
  const spice3Result = spice3Gmin(nrBase, elements, params, diagnostics, statePool, matrixSize);
  totalIterations += spice3Result.iterations;

  if (spice3Result.converged) {
    diagnostics.emit(
      makeDiagnostic(
        "dc-op-gmin",
        "info",
        `DC operating point converged via spice3 Gmin stepping (final gmin = ${params.gmin}).`,
        {
          explanation:
            "Direct Newton-Raphson and dynamic Gmin stepping both failed. spice3 Gmin stepping " +
            "succeeded: diagonal conductance was stepped from gmin*1e10 down by factor 10 over " +
            "11 decades.",
        },
      ),
    );
    return {
      converged: true,
      method: "spice3-gmin",
      iterations: totalIterations,
      nodeVoltages: spice3Result.voltages,
      diagnostics: diagnostics.getDiagnostics(),
    };
  }

  // -------------------------------------------------------------------------
  // Level 4 — gillespieSrc (cktop.c:354-546)
  // -------------------------------------------------------------------------
  const srcResult = gillespieSrc(nrBase, elements, params, diagnostics, statePool, matrixSize);
  totalIterations += srcResult.iterations;

  if (srcResult.converged) {
    diagnostics.emit(
      makeDiagnostic(
        "dc-op-source-step",
        "warning",
        "DC operating point converged via Gillespie source stepping.",
        {
          explanation:
            "Direct NR, dynamic Gmin stepping, and spice3 Gmin stepping all failed. Gillespie " +
            "source stepping succeeded: independent sources were adaptively ramped from 0% to 100%.",
        },
      ),
    );
    return {
      converged: true,
      method: "gillespie-src",
      iterations: totalIterations,
      nodeVoltages: srcResult.voltages,
      diagnostics: diagnostics.getDiagnostics(),
    };
  }

  // -------------------------------------------------------------------------
  // Level 5 — Failure with blame attribution (cktop.c:546+)
  // -------------------------------------------------------------------------
  diagnostics.emit(
    makeDiagnostic(
      "dc-op-failed",
      "error",
      "DC operating point failed to converge after all fallback strategies.",
      {
        explanation:
          "All three convergence strategies (direct NR, dynamic Gmin stepping, Gillespie " +
          "source stepping) failed. Check for floating nodes, voltage source loops, or " +
          "ambiguous operating points.",
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
// Internal types
// ---------------------------------------------------------------------------

interface StepResult {
  converged: boolean;
  iterations: number;
  voltages: Float64Array;
}

/** Shared NR base options (without maxIterations or elements). */
interface NrBase {
  solver: SparseSolver;
  matrixSize: number;
  nodeCount: number;
  reltol: number;
  abstol: number;
  iabstol: number;
  isDcOp: boolean;
  diagnostics: DiagnosticCollector;
}

// ---------------------------------------------------------------------------
// dynamicGmin — cktop.c:127-258
// ---------------------------------------------------------------------------

/**
 * Dynamic Gmin stepping (cktop.c:127-258).
 *
 * Adds a diagonal conductance (diagGmin) to all MNA nodes, converges,
 * then adaptively reduces diagGmin toward params.gmin. Factor adapts based
 * on how many NR iterations the previous sub-solve needed.
 */
function dynamicGmin(
  nrBase: NrBase,
  elements: readonly AnalogElement[],
  params: SimulationParams,
  _diagnostics: DiagnosticCollector,
  statePool: { state0: Float64Array; reset(): void } | null | undefined,
  matrixSize: number,
): StepResult {
  // cktop.c:140-141: zero CKTrhsOld and CKTstate0 before stepping
  const voltages = new Float64Array(matrixSize);
  zeroState(voltages, statePool);

  const savedVoltages = new Float64Array(matrixSize);
  const savedState0 = statePool ? new Float64Array(statePool.state0.length) : new Float64Array(0);

  // cktop.c:148-151: initial parameters
  // CKTgminFactor = 10 (cktntask.c:103)
  let factor = 10;
  // cktop.c:155-157: OldGmin = 1e-2, CKTdiagGmin = OldGmin / factor
  let oldGmin = 1e-2;
  let diagGmin = oldGmin / factor; // 1e-3 on first entry
  const gtarget = params.gmin; // cktop.c:149
  let totalIter = 0;

  // cktop.c:154-258: main gmin stepping loop
  while (true) {
    // cktop.c:161: solve with current diagGmin
    const result = newtonRaphson({
      ...nrBase,
      maxIterations: params.dcTrcvMaxIter,
      elements,
      initialGuess: voltages,
      diagonalGmin: diagGmin,
    });
    totalIter += result.iterations;
    voltages.set(result.voltages);

    if (result.converged) {
      // cktop.c:168-169: check if we've reached target
      if (diagGmin <= gtarget) {
        // cktop.c:170: success — do final clean solve
        break;
      }

      // cktop.c:172-196: save state, adapt factor based on iteration count
      saveSnapshot(voltages, savedVoltages, statePool, savedState0);

      const iterLo = (params.dcTrcvMaxIter / 4) | 0;
      const iterHi = ((3 * params.dcTrcvMaxIter / 4) | 0);

      // cktop.c:177-188: factor adaptation
      if (result.iterations <= iterLo) {
        // Easy convergence — accelerate stepping
        // cktop.c:179: factor = factor * sqrt(factor), cap at 10
        factor = Math.min(factor * Math.sqrt(factor), 10);
      } else if (result.iterations > iterHi) {
        // Hard convergence — slow down
        // cktop.c:185: factor = sqrt(factor)
        factor = Math.sqrt(factor);
      }
      // iterLo < iters <= iterHi: keep factor unchanged

      // cktop.c:224-225: track OldGmin before stepping
      oldGmin = diagGmin;

      // cktop.c:190-196: step diagGmin down
      // Overshoot check: if diagGmin/factor < gtarget, land exactly on gtarget
      if (diagGmin < factor * gtarget) {
        // cktop.c:192: landing on target gmin, adjust factor
        factor = diagGmin / gtarget;
        diagGmin = gtarget;
      } else {
        diagGmin /= factor;
      }
    } else {
      // cktop.c:206-240: NR failed
      // cktop.c:208: factor < 1.00005 → give up
      if (factor < 1.00005) {
        return { converged: false, iterations: totalIter, voltages: new Float64Array(matrixSize) };
      }
      // cktop.c:214: reduce factor, backtrack from oldGmin
      factor = Math.sqrt(Math.sqrt(factor));
      diagGmin = oldGmin / factor;
      // cktop.c:240: restore saved state
      restoreSnapshot(voltages, savedVoltages, statePool, savedState0);
    }
  }

  // cktop.c:253-258: final clean solve with no diagonal gmin
  const cleanResult = newtonRaphson({
    ...nrBase,
    maxIterations: params.maxIterations,
    elements,
    initialGuess: voltages,
  });
  totalIter += cleanResult.iterations;

  if (cleanResult.converged) {
    return { converged: true, iterations: totalIter, voltages: cleanResult.voltages };
  }
  // cktop.c:258: if clean solve fails, gmin stepping failed
  return { converged: false, iterations: totalIter, voltages: new Float64Array(matrixSize) };
}

// ---------------------------------------------------------------------------
// spice3Gmin — cktop.c:273-341
// ---------------------------------------------------------------------------

/**
 * spice3 Gmin stepping (cktop.c:273-341).
 *
 * Starts with diagGmin = params.gmin * 1e10, then ramps it down by a factor
 * of 10 per step, for 11 steps (i = 0..10). Unlike dynamicGmin, there is no
 * backtracking: a single NR failure at any step aborts the whole algorithm.
 * After all ramp steps succeed, a final clean solve with no diagonal gmin is
 * attempted.
 *
 * Variable mapping (ngspice → ours):
 *   CKTgmin        → params.gmin
 *   diagGmin       → diagGmin (local)
 *   CKTdiagGmin    → diagonalGmin (NR option)
 *   CKTdcTrcvMaxIter → params.dcTrcvMaxIter
 *   CKTdcMaxIter   → params.maxIterations
 */
function spice3Gmin(
  nrBase: NrBase,
  elements: readonly AnalogElement[],
  params: SimulationParams,
  _diagnostics: DiagnosticCollector,
  statePool: { state0: Float64Array; reset(): void } | null | undefined,
  matrixSize: number,
): StepResult {
  // cktop.c:281: zero state before stepping
  const voltages = new Float64Array(matrixSize);
  zeroState(voltages, statePool);

  let totalIter = 0;

  // cktop.c:284-290: documented deviation — we use numGminSteps=10 (ngspice default=1)
  const numGminSteps = 10;
  const gminFactor = 10;
  let diagGmin = params.gmin;
  for (let k = 0; k < numGminSteps; k++) {
    diagGmin *= gminFactor;
  }

  // cktop.c:285-319: ramp loop — numGminSteps+1 steps (i = 0..numGminSteps)
  for (let i = 0; i <= numGminSteps; i++) {
    const result = newtonRaphson({
      ...nrBase,
      maxIterations: params.dcTrcvMaxIter,
      elements,
      initialGuess: voltages,
      diagonalGmin: diagGmin,
    });
    totalIter += result.iterations;

    if (!result.converged) {
      // cktop.c:301: no backtracking — abort immediately
      return { converged: false, iterations: totalIter, voltages: new Float64Array(matrixSize) };
    }

    voltages.set(result.voltages);
    // cktop.c:313: step down by gminFactor
    diagGmin /= gminFactor;
  }

  // cktop.c:323-341: final clean solve with no diagonal gmin
  const cleanResult = newtonRaphson({
    ...nrBase,
    maxIterations: params.maxIterations,
    elements,
    initialGuess: voltages,
  });
  totalIter += cleanResult.iterations;

  if (cleanResult.converged) {
    return { converged: true, iterations: totalIter, voltages: cleanResult.voltages };
  }
  return { converged: false, iterations: totalIter, voltages: new Float64Array(matrixSize) };
}

// ---------------------------------------------------------------------------
// gillespieSrc — cktop.c:354-546
// ---------------------------------------------------------------------------

/**
 * Gillespie source stepping (cktop.c:354-546).
 *
 * Scales independent sources from 0 to 1 adaptively, using each converged
 * solution as the initial guess for the next step.
 */
function gillespieSrc(
  nrBase: NrBase,
  elements: readonly AnalogElement[],
  params: SimulationParams,
  _diagnostics: DiagnosticCollector,
  statePool: { state0: Float64Array; reset(): void } | null | undefined,
  matrixSize: number,
): StepResult {
  // cktop.c:362-363: zero state and scale sources to 0
  const voltages = new Float64Array(matrixSize);
  zeroState(voltages, statePool);
  scaleAllSources(elements, 0);

  const savedVoltages = new Float64Array(matrixSize);
  const savedState0 = statePool ? new Float64Array(statePool.state0.length) : new Float64Array(0);

  let totalIter = 0;

  // cktop.c:370-385: zero-source NR solve
  const zeroResult = newtonRaphson({
    ...nrBase,
    maxIterations: params.dcTrcvMaxIter,
    elements,
    initialGuess: voltages,
  });
  totalIter += zeroResult.iterations;
  voltages.set(zeroResult.voltages);

  if (!zeroResult.converged) {
    // cktop.c:386-418: gmin bootstrap for zero-source circuit
    // Apply gmin bootstrap: diagGmin = gmin * 1e10, step down 10 decades
    let diagGmin = params.gmin * 1e10;
    let bootstrapConverged = false;
    for (let decade = 0; decade < 10; decade++) {
      const bResult = newtonRaphson({
        ...nrBase,
        maxIterations: params.dcTrcvMaxIter,
        elements,
        initialGuess: voltages,
        diagonalGmin: diagGmin,
      });
      totalIter += bResult.iterations;
      voltages.set(bResult.voltages);
      if (!bResult.converged) {
        break;
      }
      diagGmin /= 10;
      if (decade === 9) {
        bootstrapConverged = true;
      }
    }
    if (!bootstrapConverged) {
      scaleAllSources(elements, 1);
      return { converged: false, iterations: totalIter, voltages: new Float64Array(matrixSize) };
    }
  }

  // cktop.c:420-424: initialise stepping parameters
  // raise = 0.001 (initial step size)
  let raise = 0.001;
  let convFact = 0; // last converged source factor
  let srcFact = raise; // current source factor to attempt

  // cktop.c:428-538: main source stepping loop
  const srcIterLo = (params.dcTrcvMaxIter / 4) | 0;
  const srcIterHi = ((3 * params.dcTrcvMaxIter / 4) | 0);

  while (raise >= 1e-7 && convFact < 1) {
    // cktop.c:436: scale sources and solve
    scaleAllSources(elements, srcFact);
    const stepResult = newtonRaphson({
      ...nrBase,
      maxIterations: params.dcTrcvMaxIter,
      elements,
      initialGuess: voltages,
    });
    totalIter += stepResult.iterations;

    if (stepResult.converged) {
      // cktop.c:446-481: save state, adapt raise
      voltages.set(stepResult.voltages);
      saveSnapshot(voltages, savedVoltages, statePool, savedState0);
      convFact = srcFact;

      // cktop.c:472: advance srcFact BEFORE raise adaptation
      srcFact = convFact + raise;

      // cktop.c:456-469: factor adaptation based on iteration count
      if (stepResult.iterations <= srcIterLo) {
        // Easy: accelerate
        // cktop.c:458: raise *= 1.5
        raise *= 1.5;
      } else if (stepResult.iterations > srcIterHi) {
        // Hard: slow down
        // cktop.c:466: raise *= 0.5
        raise *= 0.5;
      }
      // srcIterLo < iters <= srcIterHi: keep raise unchanged
    } else {
      // cktop.c:483-530: NR failed
      // cktop.c:485: if gap too small, give up
      if ((srcFact - convFact) < 1e-8) {
        break;
      }
      // cktop.c:490: reduce raise, cap raise
      raise /= 10;
      if (raise > 0.01) {
        raise = 0.01;
      }
      // cktop.c:525: restore last converged state
      restoreSnapshot(voltages, savedVoltages, statePool, savedState0);
      // cktop.c:527: retry from convFact + raise
      srcFact = convFact + raise;
    }

    // cktop.c:434: clamp srcFact to 1 at END of loop body
    if (srcFact > 1) {
      srcFact = 1;
    }
  }

  // cktop.c:540: restore sources to full scale
  scaleAllSources(elements, 1);

  // cktop.c:541-546: report result
  if (convFact >= 1) {
    return { converged: true, iterations: totalIter, voltages };
  }

  return { converged: false, iterations: totalIter, voltages: new Float64Array(matrixSize) };
}
