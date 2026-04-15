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
 *   CKTgminFactor    → params.gminFactor (default 10, cktntask.c:103)
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

// Phase and outcome types re-exported from harness types for use in production code.
// Defined inline here (string literals) to avoid a production→test dependency.
export type DcOpNRPhase =
  | "dcopInitJct"
  | "dcopInitFix"
  | "dcopInitFloat"
  | "dcopDirect"
  | "dcopGminDynamic"
  | "dcopGminSpice3"
  | "dcopSrcSweep";

export type DcOpNRAttemptOutcome =
  | "accepted"
  | "nrFailedRetry"
  | "dcopSubSolveConverged"
  | "dcopPhaseHandoff"
  | "finalFailure";

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
  statePool?: { state0: Float64Array; reset(): void; initMode?: "initJct" | "initFix" | "initFloat" | "initTran" | "initPred" | "initSmsig" | "transient" } | null;
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
  /** When true, NR collects all failing element indices. */
  detailedConvergence?: boolean;
  /** When non-null, elements push LimitingEvent objects here during NR. */
  limitingCollector?: LimitingEvent[] | null;
  /**
   * Called before each NR solve attempt during the DC OP ladder.
   * Harness uses this to begin a new NRAttempt with correct phase annotation.
   * @param phase - Which convergence algorithm phase is starting
   * @param phaseParameter - Gmin value (gmin phases) or source factor (src sweep)
   */
  onPhaseBegin?: (phase: DcOpNRPhase, phaseParameter?: number) => void;
  /**
   * Called after each NR solve attempt during the DC OP ladder.
   * Harness uses this to finalize the NRAttempt with outcome.
   * @param outcome - How the attempt ended
   * @param converged - Whether NR converged in this attempt
   */
  onPhaseEnd?: (outcome: DcOpNRAttemptOutcome, converged: boolean) => void;
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
  const { solver, elements, matrixSize, params, diagnostics, nodeCount, statePool, postIterationHook, detailedConvergence, limitingCollector, onPhaseBegin, onPhaseEnd } = opts;

  const nrBase = {
    solver,
    matrixSize,
    nodeCount,
    reltol: params.reltol,
    abstol: params.voltTol,
    iabstol: params.abstol,
    isDcOp: true,
    diagnostics,
    nodeDamping: params.nodeDamping ?? false,
    statePool: statePool ?? null,
    postIterationHook,
    detailedConvergence,
    limitingCollector,
  };

  // -------------------------------------------------------------------------
  // Level 0 — Direct NR with mode ladder (niiter.c:609-1010)
  //
  // One NR call, one iteration budget. Mode transitions happen between
  // iterations inside the NR loop via dcopModeLadder:
  //   iter 0: initMode="initJct", runPrimeJunctions() fires before iter 0
  //   after iter 0: unconditional → "initFix"  (niiter.c:991-993)
  //   iter N in initFix: → "initFloat" only if noncon===0 (niiter.c:994-997)
  //   convergence restricted to initMode==="initFloat" (niiter.c:986-989)
  //
  // When no pool is present (pure linear or no nonlinear elements),
  // a minimal ladder is attached to still run primeJunctions, with
  // no-op phase callbacks.
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Build the mode ladder. Always emits the correct phase sequence:
  //   dcopInitJct begin → (per iter: initJct→initFix→initFloat) → end
  //
  // For linear circuits (no nonlinear elements), the ladder is still used to
  // emit the correct harness phase sequence (initJct/initFix/initFloat begin/end)
  // even though primeJunctions is a no-op. This matches ngspice which runs
  // MODEINITJCT/MODEINITFIX/MODEINITFLOAT transitions unconditionally.
  // -------------------------------------------------------------------------
  const hasNonlinear = elements.some(el => el.isNonlinear);
  const pool = statePool ?? null;

  // Emit initial dcopInitJct phase begin before the NR call (niiter.c: entry mode).
  onPhaseBegin?.("dcopInitJct");

  // Ladder drives pool.initMode transitions and emits per-iteration phase labels.
  // Always constructed (non-null) so the NR loop always runs the mode ladder.
  const ladder = {
    runPrimeJunctions(): void {
      // MODEINITJCT: prime each nonlinear element's junction voltages.
      // niiter.c:991-993 fires before iter 0. No-op for linear circuits.
      for (const el of elements) {
        if (el.isNonlinear && el.primeJunctions) {
          el.primeJunctions();
        }
      }
    },
    pool: pool ?? { initMode: "initJct" as "initJct" | "initFix" | "initFloat" | "initTran" | "initPred" | "initSmsig" | "transient" },
    onModeBegin(phase: "dcopInitJct" | "dcopInitFix" | "dcopInitFloat", _iteration: number): void {
      onPhaseBegin?.(phase);
    },
    onModeEnd(phase: "dcopInitJct" | "dcopInitFix" | "dcopInitFloat", _iteration: number, converged: boolean): void {
      // Terminal convergence on initFloat → accepted; transitions → dcopPhaseHandoff.
      const isTerminal = phase === "dcopInitFloat" && converged;
      onPhaseEnd?.(isTerminal ? "dcopSubSolveConverged" : "dcopPhaseHandoff", converged);
    },
  };

  const directResult = newtonRaphson({
    ...nrBase,
    maxIterations: params.maxIterations,
    elements,
    dcopModeLadder: ladder,
  });
  // Reset initMode to "transient" now that the DC-OP NR call is complete.
  // The ladder may have left pool.initMode = "initFloat" (or "initFix" on
  // exhaustion), which would cause BJT updateOperatingPoint to incorrectly
  // treat subsequent transient NR iterations as DC-OP context.
  if (pool) {
    pool.initMode = "transient";
  }
  // Per-iteration phase labels emitted by ladder's onModeEnd/onModeBegin.
  // When NR exhausts maxIterations without converging, the last onModeEnd
  // already fired "dcopPhaseHandoff"; emit the overall failure label.
  if (!directResult.converged) {
    onPhaseEnd?.("nrFailedRetry", false);
  }

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
  // Level 1 — gmin stepping (cktop.c:57-60: select ONE gmin method)
  // -------------------------------------------------------------------------
  const numGminSteps = params.numGminSteps ?? 1;
  let gminResult: StepResult;
  if (numGminSteps <= 1) {
    gminResult = dynamicGmin(nrBase, elements, params, diagnostics, statePool, matrixSize, onPhaseBegin, onPhaseEnd);
  } else {
    gminResult = spice3Gmin(nrBase, elements, params, diagnostics, statePool, matrixSize, onPhaseBegin, onPhaseEnd);
  }
  totalIterations += gminResult.iterations;

  if (gminResult.converged) {
    const gminMethod = numGminSteps <= 1 ? "dynamic-gmin" : "spice3-gmin";
    const gminLabel = numGminSteps <= 1 ? "dynamic Gmin stepping" : "spice3 Gmin stepping";
    const gminExplanation = numGminSteps <= 1
      ? "Direct Newton-Raphson failed. Dynamic Gmin stepping succeeded: adaptive diagonal conductance was stepped from 1e-2 S down to params.gmin."
      : "Direct Newton-Raphson failed. spice3 Gmin stepping succeeded: diagonal conductance was stepped from gmin*1e10 down by factor 10 over 11 decades.";
    diagnostics.emit(
      makeDiagnostic(
        "dc-op-gmin",
        "info",
        `DC operating point converged via ${gminLabel} (final gmin = ${params.gmin}).`,
        { explanation: gminExplanation },
      ),
    );
    return {
      converged: true,
      method: gminMethod,
      iterations: totalIterations,
      nodeVoltages: gminResult.voltages,
      diagnostics: diagnostics.getDiagnostics(),
    };
  }

  // -------------------------------------------------------------------------
  // Level 2 — source stepping (cktop.c:66-75: select ONE source-stepping method)
  // -------------------------------------------------------------------------
  const numSrcSteps = params.numSrcSteps ?? 1;
  let srcResult: StepResult;
  if (numSrcSteps <= 1) {
    srcResult = gillespieSrc(nrBase, elements, params, diagnostics, statePool, matrixSize, onPhaseBegin, onPhaseEnd);
  } else {
    srcResult = spice3Src(nrBase, elements, params, diagnostics, statePool, matrixSize, onPhaseBegin, onPhaseEnd);
  }
  totalIterations += srcResult.iterations;

  if (srcResult.converged) {
    const srcMethod = numSrcSteps <= 1 ? "gillespie-src" : "spice3-src";
    const srcLabel = numSrcSteps <= 1 ? "Gillespie source stepping" : "spice3 source stepping";
    const srcExplanation = numSrcSteps <= 1
      ? "Direct NR and gmin stepping both failed. Gillespie source stepping succeeded: independent sources were adaptively ramped from 0% to 100%."
      : "Direct NR and gmin stepping both failed. spice3 source stepping succeeded: sources were uniformly ramped from 0% to 100%.";
    diagnostics.emit(
      makeDiagnostic(
        "dc-op-source-step",
        "warning",
        `DC operating point converged via ${srcLabel}.`,
        { explanation: srcExplanation },
      ),
    );
    return {
      converged: true,
      method: srcMethod,
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

type PhaseBeginFn = ((phase: DcOpNRPhase, phaseParameter?: number) => void) | undefined;
type PhaseEndFn = ((outcome: DcOpNRAttemptOutcome, converged: boolean) => void) | undefined;

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
  onPhaseBegin?: PhaseBeginFn,
  onPhaseEnd?: PhaseEndFn,
): StepResult {
  // cktop.c:140-141: zero CKTrhsOld and CKTstate0 before stepping
  const voltages = new Float64Array(matrixSize);
  zeroState(voltages, statePool);
  if (statePool && 'initMode' in statePool) {
    (statePool as any).initMode = "initJct";
  }

  const savedVoltages = new Float64Array(matrixSize);
  const savedState0 = statePool ? new Float64Array(statePool.state0.length) : new Float64Array(0);

  // cktop.c:148-151: initial parameters
  // CKTgminFactor = 10 (cktntask.c:103)
  let factor = params.gminFactor ?? 10;
  // cktop.c:155-157: OldGmin = 1e-2, CKTdiagGmin = OldGmin (first sub-solve sees 1e-2)
  let oldGmin = 1e-2;
  let diagGmin = oldGmin; // ngspice starts first sub-solve at 1e-2, divides after success
  const gtarget = Math.max(params.gmin, params.gshunt ?? 0); // cktop.c:148-157: gtarget = MAX(CKTgmin, CKTgshunt)
  let totalIter = 0;

  // cktop.c:154-258: main gmin stepping loop
  while (true) {
    // cktop.c:161: solve with current diagGmin
    onPhaseBegin?.("dcopGminDynamic", diagGmin);
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
      onPhaseEnd?.("dcopSubSolveConverged", true);
      if (statePool && 'initMode' in statePool) {
        (statePool as any).initMode = "initFloat";
      }
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
      onPhaseEnd?.("nrFailedRetry", false);
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

  // cktop.c:253-258: final clean solve with gshunt diagonal (ngspice uses dcTrcvMaxIter here)
  onPhaseBegin?.("dcopGminDynamic", 0);
  const cleanResult = newtonRaphson({
    ...nrBase,
    maxIterations: params.dcTrcvMaxIter,
    elements,
    initialGuess: voltages,
    diagonalGmin: params.gshunt ?? 0,
  });
  totalIter += cleanResult.iterations;
  onPhaseEnd?.(cleanResult.converged ? "accepted" : "finalFailure", cleanResult.converged);

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
  onPhaseBegin?: PhaseBeginFn,
  onPhaseEnd?: PhaseEndFn,
): StepResult {
  // cktop.c:281: zero state before stepping
  const voltages = new Float64Array(matrixSize);
  zeroState(voltages, statePool);
  if (statePool && 'initMode' in statePool) {
    (statePool as any).initMode = "initJct";
  }

  let totalIter = 0;

  const numGminSteps = params.numGminSteps ?? 10;
  const gminFactor = params.gminFactor ?? 10;
  let diagGmin = params.gmin;
  for (let k = 0; k < numGminSteps; k++) {
    diagGmin *= gminFactor;
  }

  // cktop.c:285-319: ramp loop — numGminSteps+1 steps (i = 0..numGminSteps)
  for (let i = 0; i <= numGminSteps; i++) {
    onPhaseBegin?.("dcopGminSpice3", diagGmin);
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
      onPhaseEnd?.("nrFailedRetry", false);
      return { converged: false, iterations: totalIter, voltages: new Float64Array(matrixSize) };
    }

    onPhaseEnd?.("dcopSubSolveConverged", true);
    if (statePool && 'initMode' in statePool) {
      (statePool as any).initMode = "initFloat";
    }
    voltages.set(result.voltages);
    // cktop.c:313: step down by gminFactor
    diagGmin /= gminFactor;
  }

  // cktop.c:323-341: final clean solve with gshunt diagonal (ngspice uses dcTrcvMaxIter here)
  onPhaseBegin?.("dcopGminSpice3", 0);
  const cleanResult = newtonRaphson({
    ...nrBase,
    maxIterations: params.dcTrcvMaxIter,
    elements,
    initialGuess: voltages,
    diagonalGmin: params.gshunt ?? 0,
  });
  totalIter += cleanResult.iterations;
  onPhaseEnd?.(cleanResult.converged ? "accepted" : "finalFailure", cleanResult.converged);

  if (cleanResult.converged) {
    return { converged: true, iterations: totalIter, voltages: cleanResult.voltages };
  }
  return { converged: false, iterations: totalIter, voltages: new Float64Array(matrixSize) };
}

// ---------------------------------------------------------------------------
// spice3Src — cktop.c:583-628
// ---------------------------------------------------------------------------

/**
 * spice3 source stepping (cktop.c:583-628).
 * Uniform linear source ramp with no backtracking.
 */
function spice3Src(
  nrBase: NrBase,
  elements: readonly AnalogElement[],
  params: SimulationParams,
  _diagnostics: DiagnosticCollector,
  statePool: { state0: Float64Array; reset(): void } | null | undefined,
  matrixSize: number,
  onPhaseBegin?: PhaseBeginFn,
  onPhaseEnd?: PhaseEndFn,
): StepResult {
  const voltages = new Float64Array(matrixSize);
  zeroState(voltages, statePool);
  if (statePool && 'initMode' in statePool) {
    (statePool as any).initMode = "initJct";
  }
  let totalIter = 0;
  const numSrcSteps = params.numSrcSteps ?? 1;

  // cktop.c:590-620: uniform ramp i=0..numSrcSteps
  for (let i = 0; i <= numSrcSteps; i++) {
    const srcFact = i / numSrcSteps;
    scaleAllSources(elements, srcFact);
    onPhaseBegin?.("dcopSrcSweep", srcFact);
    const result = newtonRaphson({
      ...nrBase,
      maxIterations: params.dcTrcvMaxIter,
      elements,
      initialGuess: voltages,
    });
    totalIter += result.iterations;
    if (!result.converged) {
      onPhaseEnd?.("nrFailedRetry", false);
      scaleAllSources(elements, 1);
      return { converged: false, iterations: totalIter, voltages: new Float64Array(matrixSize) };
    }
    onPhaseEnd?.("dcopSubSolveConverged", true);
    if (statePool && 'initMode' in statePool) {
      (statePool as any).initMode = "initFloat";
    }
    voltages.set(result.voltages);
  }

  scaleAllSources(elements, 1);

  // Final clean solve (ngspice uses dcTrcvMaxIter, gshunt diagonal)
  onPhaseBegin?.("dcopSrcSweep", 1);
  const cleanResult = newtonRaphson({
    ...nrBase,
    maxIterations: params.dcTrcvMaxIter,
    elements,
    initialGuess: voltages,
    diagonalGmin: params.gshunt ?? 0,
  });
  totalIter += cleanResult.iterations;
  onPhaseEnd?.(cleanResult.converged ? "accepted" : "finalFailure", cleanResult.converged);

  return cleanResult.converged
    ? { converged: true, iterations: totalIter, voltages: cleanResult.voltages }
    : { converged: false, iterations: totalIter, voltages: new Float64Array(matrixSize) };
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
  onPhaseBegin?: PhaseBeginFn,
  onPhaseEnd?: PhaseEndFn,
): StepResult {
  // cktop.c:362-363: zero state and scale sources to 0
  const voltages = new Float64Array(matrixSize);
  zeroState(voltages, statePool);
  if (statePool && 'initMode' in statePool) {
    (statePool as any).initMode = "initJct";
  }
  scaleAllSources(elements, 0);

  const savedVoltages = new Float64Array(matrixSize);
  const savedState0 = statePool ? new Float64Array(statePool.state0.length) : new Float64Array(0);

  let totalIter = 0;

  // cktop.c:370-385: zero-source NR solve
  onPhaseBegin?.("dcopSrcSweep", 0);
  const zeroResult = newtonRaphson({
    ...nrBase,
    maxIterations: params.dcTrcvMaxIter,
    elements,
    initialGuess: voltages,
  });
  totalIter += zeroResult.iterations;
  voltages.set(zeroResult.voltages);

  if (!zeroResult.converged) {
    onPhaseEnd?.("nrFailedRetry", false);
    // cktop.c:386-418: gmin bootstrap for zero-source circuit
    // Apply gmin bootstrap: diagGmin = gmin * 1e10, step down 10 decades
    let diagGmin = params.gmin * 1e10;
    let bootstrapConverged = false;
    for (let decade = 0; decade <= 10; decade++) {
      onPhaseBegin?.("dcopSrcSweep", 0);
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
        onPhaseEnd?.("nrFailedRetry", false);
        break;
      }
      onPhaseEnd?.("dcopSubSolveConverged", true);
      if (statePool && 'initMode' in statePool) {
        (statePool as any).initMode = "initFloat";
      }
      diagGmin /= 10;
      if (decade === 10) {
        bootstrapConverged = true;
      }
    }
    if (!bootstrapConverged) {
      scaleAllSources(elements, 1);
      return { converged: false, iterations: totalIter, voltages: new Float64Array(matrixSize) };
    }
  } else {
    onPhaseEnd?.("dcopSubSolveConverged", true);
    if (statePool && 'initMode' in statePool) {
      (statePool as any).initMode = "initFloat";
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
    onPhaseBegin?.("dcopSrcSweep", srcFact);
    const stepResult = newtonRaphson({
      ...nrBase,
      maxIterations: params.dcTrcvMaxIter,
      elements,
      initialGuess: voltages,
    });
    totalIter += stepResult.iterations;

    if (stepResult.converged) {
      onPhaseEnd?.("dcopSubSolveConverged", true);
      if (statePool && 'initMode' in statePool) {
        (statePool as any).initMode = "initFloat";
      }
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
      onPhaseEnd?.("nrFailedRetry", false);
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
