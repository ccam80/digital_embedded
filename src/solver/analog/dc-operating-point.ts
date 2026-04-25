/**
 * DC operating point solver — ngspice CKTop three-level fallback.
 *
 * Implements the three-level convergence stack from ngspice cktop.c:20-79:
 *
 *   Level 0 — Direct NR: standard Newton-Raphson with params.maxIterations
 *   Level 1 — dynamicGmin: adaptive diagonal conductance stepping
 *              (cktop.c:127-258), analogous to ngspice's CKTdcOp gmin path
 *   Level 2 — gillespieSrc: adaptive source stepping
 *              (cktop.c:369-569), Gillespie source-stepping algorithm
 *   Level 3 — Failure: emit blame diagnostics
 *
 * Variable mapping (ngspice → ours):
 *   CKTdiagGmin      → ctx.diagonalGmin (set before each NR call)
 *   CKTgmin          → ctx.params.gmin
 *   CKTgminFactor    → ctx.params.gminFactor (default 10, cktntask.c:103)
 *   CKTdcTrcvMaxIter → ctx.dcTrcvMaxIter
 *   CKTdcMaxIter     → ctx.maxIterations
 *   CKTrhsOld        → ctx.dcopVoltages
 *   CKTstate0        → ctx.statePool.state0
 *   OldRhsOld        → ctx.dcopSavedVoltages
 *   OldCKTstate0     → ctx.dcopSavedState0
 */

import type { DiagnosticCollector } from "./diagnostics.js";
import { makeDiagnostic } from "./diagnostics.js";
import { newtonRaphson } from "./newton-raphson.js";
import { cktLoad } from "./ckt-load.js";
import type { CKTCircuitContext } from "./ckt-context.js";
import {
  setInitf,
  isTranOp,
  MODEINITJCT, MODEINITFLOAT, MODEINITSMSIG,
} from "./ckt-mode.js";

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
// Helpers
// ---------------------------------------------------------------------------

/**
 * Scale all independent sources by factor.
 *
 * Sets `ctx.srcFact` (ngspice CKTsrcFact), the single source of truth for
 * DC source stepping. Every source-device `load()` reads `ctx.srcFact`
 * directly and multiplies its stamped value by it.
 *
 * ngspice reference: cktop.c:385 (gillespie_src start — `ckt->CKTsrcFact = 0;`)
 * and cktop.c:475,514 (increment during ramp). vsrcload.c:54 and isrcload.c
 * read `ckt->CKTsrcFact` directly in each device's load() — no per-element
 * setter dispatch.
 */
function scaleAllSources(ctx: CKTCircuitContext, factor: number): void {
  ctx.srcFact = factor;
}

/**
 * Zero both the voltage vector and the state pool's state0 array.
 */
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
 */
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
 */
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
// StepResult — internal return type for stepping sub-solvers
// ---------------------------------------------------------------------------

interface StepResult {
  converged: boolean;
  iterations: number;
  voltages: Float64Array;
}

type PhaseBeginFn = ((phase: DcOpNRPhase, phaseParameter?: number) => void) | undefined;
type PhaseEndFn = ((outcome: DcOpNRAttemptOutcome, converged: boolean) => void) | undefined;

// ---------------------------------------------------------------------------
// runNR — configure ctx for a sub-solve and call newtonRaphson
// ---------------------------------------------------------------------------

/**
 * Configure ctx for a DC-OP sub-solve and run newtonRaphson.
 *
 * Sets isDcOp=true, maxIterations, initialGuess, diagonalGmin, and
 * dcopModeLadder on ctx, then calls newtonRaphson(ctx).
 *
 * Returns a StepResult pointing to ctx.rhs (the solved voltage vector).
 * Callers must copy ctx.rhs before the next runNR call if they want to
 * preserve intermediate results.
 */
function runNR(
  ctx: CKTCircuitContext,
  maxIterations: number,
  diagonalGmin: number,
  ladder: CKTCircuitContext["dcopModeLadder"],
): StepResult {
  // The caller (dcOperatingPoint / _transientDcop in analog-engine.ts) owns
  // the cktMode write — standalone .OP sets MODEDCOP | MODEINITJCT (dcop.c:82)
  // and transient-boot DCOP sets MODETRANOP | MODEINITJCT (dctran.c:231).
  // Sub-solves (gmin/src stepping ladders) inherit those bits and only flip
  // the INITF sub-field via ladder.onModeBegin. The cktMode bitfield already
  // encodes the correct analysis mode and sub-solves must not clobber it
  // (MODETRANOP has MODETRAN set, and zeroing it here would break srcFact
  // scaling inside the transient-boot ladder).

  ctx.maxIterations = maxIterations;
  ctx.diagonalGmin = diagonalGmin;
  ctx.dcopModeLadder = ladder;
  ctx.exactMaxIterations = false;
  ctx.noncon = 1;
  newtonRaphson(ctx);
  return {
    converged: ctx.nrResult.converged,
    iterations: ctx.nrResult.iterations,
    voltages: ctx.nrResult.voltages,
  };
}

// ---------------------------------------------------------------------------
// cktop — ngspice cktop.c:20-79 direct NR level
// ---------------------------------------------------------------------------

/**
 * Run the direct-NR level of the DC-OP ladder (cktop.c:20-79).
 *
 * When params.noOpIter is true, returns immediately with converged=true
 * and zero iterations — returning the pre-existing voltage vector unchanged,
 * matching the ngspice noOpIter fast-path.
 */
function cktop(
  ctx: CKTCircuitContext,
  firstInitf: number,
  maxIter: number,
  preExistingVoltages: Float64Array,
  ladder: CKTCircuitContext["dcopModeLadder"],
): StepResult {
  ctx.cktMode = setInitf(ctx.cktMode, firstInitf);
  if (ctx.params.noOpIter) {
    return {
      converged: true,
      iterations: 0,
      voltages: preExistingVoltages,
    };
  }
  ctx.rhsOld.set(preExistingVoltages);
  return runNR(ctx, maxIter, ctx.diagonalGmin, ladder);
}

// ---------------------------------------------------------------------------
// dcopFinalize — ngspice DCop initSmsig final CKTload (dcop.c:127,153)
// ---------------------------------------------------------------------------

/**
 * Finalize the standalone .OP DC operating point after convergence.
 *
 * C1 (Phase 2.5 W2.2): single CKTload mirrors ngspice `DCop`
 * (dcop.c:127 mode write, dcop.c:153 CKTload call) exactly:
 *   ckt->CKTmode = (ckt->CKTmode & MODEUIC) | MODEDCOP | MODEINITSMSIG;
 *   converged = CKTload(ckt);
 *
 * That is: one CKTmode reassignment to flip the INITF bits to MODEINITSMSIG,
 * followed by one CKTload call. No factor, no solve, no iteration, no NR.
 * The converged CKTrhsOld from the previous cktop() call is already in the
 * MNA solution vector; CKTload re-evaluates every device's small-signal
 * quantities (e.g. geqcb for capacitors) into state0 using those voltages.
 *
 * After the load, ngspice does NOT reset CKTmode — the next consumer owns
 * it. For our engine, no consumer reads the INITF bits after standalone .OP
 * finalize (the next user call either resets, reconfigures, or transitions
 * to transient via _seedFromDcop which writes its own mode). We still clear
 * the INITF bits to MODEINITFLOAT on return so cktMode never leaks
 * MODEINITSMSIG across analysis boundaries — matches niiter.c:1070-1071's
 * post-converge INITF dispatcher landing mode (MODEINITSMSIG → MODEINITFLOAT).
 *
 * Runs ONLY on the standalone .OP path (!isTranOp(ctx.cktMode)). The
 * transient-boot DCOP path (dctran.c:230-346) has no smsig load and callers
 * must skip this function — gate on !isTranOp(ctx.cktMode) at each call site.
 */
function dcopFinalize(
  ctx: CKTCircuitContext,
  voltages: Float64Array,
): void {
  // dcop.c:127 — flip INITF bits to MODEINITSMSIG; analysis bits stay as set
  // by the caller (MODEDCOP for standalone .OP).
  ctx.cktMode = setInitf(ctx.cktMode, MODEINITSMSIG);
  // Elements read prior-iterate voltages via loadCtx.rhsOld. Seed with the
  // converged solution so the final CKTload call sees the correct node voltages.
  ctx.rhsOld.set(voltages);
  // dcop.c:153 — one CKTload call. No factor, no solve, no iteration.
  cktLoad(ctx);
  // Clear INITF bit to MODEINITFLOAT so callers never observe the smsig mode
  // leaking across. ngspice leaves CKTmode at MODEINITSMSIG but ngspice also
  // has no code path that reads CKTmode between the smsig CKTload and the
  // next analysis starting. _seedFromDcop overwrites the mode unconditionally,
  // so this is a belt-and-suspenders landing.
  ctx.cktMode = setInitf(ctx.cktMode, MODEINITFLOAT);
}

// ---------------------------------------------------------------------------
// cktncDump — per-node non-convergence diagnostics (cktncdump.c)
// ---------------------------------------------------------------------------

/**
 * Compute per-node non-convergence diagnostics when the DC-OP fails.
 *
 * Zero-allocation: writes results into the caller-supplied `scratch` array,
 * drawing mutable entry objects from `pool`. The returned array is the
 * same reference as `scratch`, so its identity is stable across calls.
 * `pool` must contain at least `matrixSize` pre-allocated entries.
 */
export function cktncDump(
  scratch: Array<{ node: number; delta: number; tol: number }>,
  pool: Array<{ node: number; delta: number; tol: number }>,
  voltages: Float64Array,
  prevVoltages: Float64Array,
  reltol: number,
  voltTol: number,
  abstol: number,
  nodeCount: number,
  matrixSize: number,
): Array<{ node: number; delta: number; tol: number }> {
  scratch.length = 0;
  for (let i = 0; i < matrixSize; i++) {
    const delta = Math.abs(voltages[i] - prevVoltages[i]);
    const tol =
      reltol * Math.max(Math.abs(voltages[i]), Math.abs(prevVoltages[i])) +
      (i < nodeCount ? voltTol : abstol);
    if (delta > tol) {
      const entry = pool[scratch.length];
      entry.node = i;
      entry.delta = delta;
      entry.tol = tol;
      scratch.push(entry);
    }
  }
  return scratch;
}

// ---------------------------------------------------------------------------
// solveDcOperatingPoint
// ---------------------------------------------------------------------------

/**
 * Find the DC operating point of the circuit using the ngspice CKTop
 * three-level fallback stack (cktop.c:20-79).
 *
 * Writes results into ctx.dcopResult. Returns void.
 *
 * @param ctx - Circuit context holding all solver state, buffers, and options
 */
export function solveDcOperatingPoint(ctx: CKTCircuitContext): void {
  const { elements, matrixSize, statePool, params } = ctx;
  const diagnostics = ctx.diagnostics;

  ctx.dcopResult.reset();

  const onPhaseBegin = ctx._onPhaseBegin as PhaseBeginFn;
  const onPhaseEnd = ctx._onPhaseEnd as PhaseEndFn;

  // -------------------------------------------------------------------------
  // Build the mode ladder. Always emits the correct phase sequence:
  //   dcopInitJct begin → (per iter: initJct→initFix→initFloat) → end
  // -------------------------------------------------------------------------

  onPhaseBegin?.("dcopInitJct");

  const ladder = {
    onModeBegin(phase: "dcopInitJct" | "dcopInitFix" | "dcopInitFloat", _iteration: number): void {
      onPhaseBegin?.(phase);
    },
    onModeEnd(phase: "dcopInitJct" | "dcopInitFix" | "dcopInitFloat", _iteration: number, converged: boolean): void {
      const isTerminal = phase === "dcopInitFloat" && converged;
      onPhaseEnd?.(isTerminal ? "dcopSubSolveConverged" : "dcopPhaseHandoff", converged);
    },
  };

  // Use dcopVoltages as the working buffer for this solve (zero it first)
  const voltages = ctx.dcopVoltages;
  voltages.fill(0);

  const directResult = cktop(
    ctx,
    MODEINITJCT,
    params.maxIterations,
    voltages,
    ladder,
  );
  if (!directResult.converged) {
    onPhaseEnd?.("nrFailedRetry", false);
  }

  if (directResult.converged) {
    voltages.set(directResult.voltages);
    // ngspice DCtran (dctran.c:230-346) performs NO CKTload after the
    // transient-boot CKTop returns. The initSmsig load fires only from DCop
    // (dcop.c:127,153) on the standalone .OP path. Gate on !isTranOp(ctx.cktMode)
    // so transient-boot DCOP skips the smsig pass entirely.
    if (!isTranOp(ctx.cktMode)) {
      dcopFinalize(ctx, voltages);
    }
    diagnostics.emit(
      makeDiagnostic(
        "dc-op-converged",
        "info",
        `DC operating point converged directly in ${directResult.iterations} iteration(s).`,
        { explanation: "Newton-Raphson converged without any convergence aids." },
      ),
    );
    ctx.dcopResult.converged = true;
    ctx.dcopResult.method = "direct";
    ctx.dcopResult.iterations = directResult.iterations;
    ctx.dcopResult.nodeVoltages.set(voltages);
    ctx.dcopResult.diagnostics = diagnostics.getDiagnostics();
    return;
  }

  let totalIterations = directResult.iterations;

  // -------------------------------------------------------------------------
  // Level 1 — gmin stepping (cktop.c:57-60: select ONE gmin method)
  // -------------------------------------------------------------------------
  const numGminSteps = params.numGminSteps ?? 1;
  let gminResult: StepResult;
  if (numGminSteps <= 1) {
    gminResult = dynamicGmin(ctx, onPhaseBegin, onPhaseEnd);
  } else {
    gminResult = spice3Gmin(ctx, onPhaseBegin, onPhaseEnd);
  }
  totalIterations += gminResult.iterations;

  if (gminResult.converged) {
    voltages.set(gminResult.voltages);
    // smsig load is .OP-only — skip on transient-boot DCOP (dctran.c:230-346).
    if (!isTranOp(ctx.cktMode)) {
      dcopFinalize(ctx, voltages);
    }
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
    ctx.dcopResult.converged = true;
    ctx.dcopResult.method = gminMethod;
    ctx.dcopResult.iterations = totalIterations;
    ctx.dcopResult.nodeVoltages.set(voltages);
    ctx.dcopResult.diagnostics = diagnostics.getDiagnostics();
    return;
  }

  // -------------------------------------------------------------------------
  // Level 2 — source stepping (cktop.c:66-75: select ONE source-stepping method)
  // -------------------------------------------------------------------------
  const numSrcSteps = params.numSrcSteps ?? 1;
  let srcResult: StepResult;
  if (numSrcSteps <= 1) {
    srcResult = gillespieSrc(ctx, onPhaseBegin, onPhaseEnd);
  } else {
    srcResult = spice3Src(ctx, onPhaseBegin, onPhaseEnd);
  }
  totalIterations += srcResult.iterations;

  if (srcResult.converged) {
    voltages.set(srcResult.voltages);
    // smsig load is .OP-only — skip on transient-boot DCOP (dctran.c:230-346).
    if (!isTranOp(ctx.cktMode)) {
      dcopFinalize(ctx, voltages);
    }
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
    ctx.dcopResult.converged = true;
    ctx.dcopResult.method = srcMethod;
    ctx.dcopResult.iterations = totalIterations;
    ctx.dcopResult.nodeVoltages.set(voltages);
    ctx.dcopResult.diagnostics = diagnostics.getDiagnostics();
    return;
  }

  // -------------------------------------------------------------------------
  // Level 5 — Failure with blame attribution (cktncdump.c)
  // -------------------------------------------------------------------------
  const ncNodes = cktncDump(
    ctx.ncDumpScratch,
    ctx._ncDumpPool,
    srcResult.voltages,
    directResult.voltages,
    params.reltol,
    params.voltTol,
    params.abstol,
    ctx.nodeCount,
    matrixSize,
  );
  const ncSummary = ncNodes.length > 0
    ? ` Non-converged nodes: ${ncNodes.map(n => `node[${n.node}] delta=${n.delta.toExponential(2)} tol=${n.tol.toExponential(2)}`).join(", ")}.`
    : "";
  diagnostics.emit(
    makeDiagnostic(
      "dc-op-failed",
      "error",
      "DC operating point failed to converge after all fallback strategies.",
      {
        explanation:
          "All three convergence strategies (direct NR, dynamic Gmin stepping, Gillespie " +
          "source stepping) failed. Check for floating nodes, voltage source loops, or " +
          `ambiguous operating points.${ncSummary}`,
      },
    ),
  );

  ctx.dcopResult.converged = false;
  ctx.dcopResult.method = numSrcSteps <= 1 ? "gillespie-src" : "spice3-src";
  ctx.dcopResult.iterations = totalIterations;
  ctx.dcopResult.nodeVoltages.fill(0);
  ctx.dcopResult.diagnostics = diagnostics.getDiagnostics();
}

// ---------------------------------------------------------------------------
// dynamicGmin — cktop.c:127-258
// ---------------------------------------------------------------------------

/**
 * Dynamic Gmin stepping (cktop.c:127-258).
 *
 * Adds a diagonal conductance (diagGmin) to all MNA nodes, converges,
 * then adaptively reduces diagGmin toward params.gmin.
 */
function dynamicGmin(
  ctx: CKTCircuitContext,
  onPhaseBegin?: PhaseBeginFn,
  onPhaseEnd?: PhaseEndFn,
): StepResult {
  const { statePool, params } = ctx;

  // Use ctx.dcopVoltages as the working buffer
  const voltages = ctx.dcopVoltages;
  zeroState(voltages, statePool);
  ctx.cktMode = setInitf(ctx.cktMode, MODEINITJCT);  // cktop.c:35 firstmode=MODEINITJCT

  // Use ctx.dcopSavedVoltages and ctx.dcopSavedState0 for snapshots
  const savedVoltages = ctx.dcopSavedVoltages;
  const savedState0 = ctx.dcopSavedState0;

  let factor = params.gminFactor ?? 10;
  let oldGmin = 1e-2;
  let diagGmin = oldGmin;
  const gtarget = Math.max(params.gmin, params.gshunt ?? 0);
  let totalIter = 0;

  while (true) {
    onPhaseBegin?.("dcopGminDynamic", diagGmin);
    ctx.rhsOld.set(voltages);
    const result = runNR(ctx, params.dcTrcvMaxIter, diagGmin, null);
    totalIter += result.iterations;
    voltages.set(result.voltages);

    if (result.converged) {
      onPhaseEnd?.("dcopSubSolveConverged", true);
      ctx.cktMode = setInitf(ctx.cktMode, MODEINITFLOAT);  // cktop.c:179 continuemode=MODEINITFLOAT
      if (diagGmin <= gtarget) {
        break;
      }

      saveSnapshot(voltages, savedVoltages, statePool, savedState0);

      const iterLo = (params.dcTrcvMaxIter / 4) | 0;
      const iterHi = ((3 * params.dcTrcvMaxIter / 4) | 0);

      if (result.iterations <= iterLo) {
        factor = Math.min(factor * Math.sqrt(factor), params.gminFactor ?? 10);
      } else if (result.iterations > iterHi) {
        factor = Math.sqrt(factor);
      }

      oldGmin = diagGmin;

      if (diagGmin < factor * gtarget) {
        factor = diagGmin / gtarget;
        diagGmin = gtarget;
      } else {
        diagGmin /= factor;
      }
    } else {
      onPhaseEnd?.("nrFailedRetry", false);
      if (factor < 1.00005) {
        return { converged: false, iterations: totalIter, voltages: ctx.dcopVoltages };
      }
      factor = Math.sqrt(Math.sqrt(factor));
      diagGmin = oldGmin / factor;
      restoreSnapshot(voltages, savedVoltages, statePool, savedState0);
    }
  }

  // Final clean solve with gshunt diagonal (ngspice cktop.c:253 uses CKTdcMaxIter = maxIterations)
  onPhaseBegin?.("dcopGminDynamic", 0);
  ctx.rhsOld.set(voltages);
  const cleanResult = runNR(ctx, params.maxIterations, params.gshunt ?? 0, null);
  totalIter += cleanResult.iterations;
  onPhaseEnd?.(cleanResult.converged ? "accepted" : "finalFailure", cleanResult.converged);

  if (cleanResult.converged) {
    voltages.set(cleanResult.voltages);
    return { converged: true, iterations: totalIter, voltages };
  }
  return { converged: false, iterations: totalIter, voltages: ctx.dcopVoltages };
}

// ---------------------------------------------------------------------------
// spice3Gmin — cktop.c:273-341
// ---------------------------------------------------------------------------

/**
 * spice3 Gmin stepping (cktop.c:273-341).
 *
 * Starts with diagGmin = params.gmin * gminFactor^numGminSteps, then ramps
 * it down by gminFactor per step, for numGminSteps+1 steps. No backtracking.
 */
function spice3Gmin(
  ctx: CKTCircuitContext,
  onPhaseBegin?: PhaseBeginFn,
  onPhaseEnd?: PhaseEndFn,
): StepResult {
  const { statePool, params } = ctx;

  const voltages = ctx.dcopVoltages;
  zeroState(voltages, statePool);
  ctx.cktMode = setInitf(ctx.cktMode, MODEINITJCT);  // cktop.c:291 firstmode=MODEINITJCT

  let totalIter = 0;

  const numGminSteps = params.numGminSteps ?? 10;
  const gminFactor = params.gminFactor ?? 10;
  const gs = params.gshunt ?? 0;
  let diagGmin = gs === 0 ? params.gmin : gs;
  for (let k = 0; k < numGminSteps; k++) {
    diagGmin *= gminFactor;
  }

  for (let i = 0; i <= numGminSteps; i++) {
    onPhaseBegin?.("dcopGminSpice3", diagGmin);
    ctx.rhsOld.set(voltages);
    const result = runNR(ctx, params.dcTrcvMaxIter, diagGmin, null);
    totalIter += result.iterations;

    if (!result.converged) {
      onPhaseEnd?.("nrFailedRetry", false);
      return { converged: false, iterations: totalIter, voltages: ctx.dcopVoltages };
    }

    onPhaseEnd?.("dcopSubSolveConverged", true);
    ctx.cktMode = setInitf(ctx.cktMode, MODEINITFLOAT);  // cktop.c:319 continuemode=MODEINITFLOAT
    voltages.set(result.voltages);
    diagGmin /= gminFactor;
  }

  // Final clean solve with gshunt diagonal
  onPhaseBegin?.("dcopGminSpice3", 0);
  ctx.rhsOld.set(voltages);
  const cleanResult = runNR(ctx, params.dcTrcvMaxIter, params.gshunt ?? 0, null);
  totalIter += cleanResult.iterations;
  onPhaseEnd?.(cleanResult.converged ? "accepted" : "finalFailure", cleanResult.converged);

  if (cleanResult.converged) {
    voltages.set(cleanResult.voltages);
    return { converged: true, iterations: totalIter, voltages };
  }
  return { converged: false, iterations: totalIter, voltages: ctx.dcopVoltages };
}

// ---------------------------------------------------------------------------
// spice3Src — cktop.c:583-628
// ---------------------------------------------------------------------------

/**
 * spice3 source stepping (cktop.c:583-628).
 * Uniform linear source ramp with no backtracking.
 */
function spice3Src(
  ctx: CKTCircuitContext,
  onPhaseBegin?: PhaseBeginFn,
  onPhaseEnd?: PhaseEndFn,
): StepResult {
  const { statePool, params } = ctx;

  const voltages = ctx.dcopVoltages;
  zeroState(voltages, statePool);
  ctx.cktMode = setInitf(ctx.cktMode, MODEINITJCT);  // cktop.c:591 firstmode=MODEINITJCT
  let totalIter = 0;
  const numSrcSteps = params.numSrcSteps ?? 1;

  for (let i = 0; i <= numSrcSteps; i++) {
    const srcFact = i / numSrcSteps;
    scaleAllSources(ctx, srcFact);
    onPhaseBegin?.("dcopSrcSweep", srcFact);
    ctx.rhsOld.set(voltages);
    const result = runNR(ctx, params.dcTrcvMaxIter, 0, null);
    totalIter += result.iterations;
    if (!result.converged) {
      onPhaseEnd?.("nrFailedRetry", false);
      scaleAllSources(ctx, 1);
      return { converged: false, iterations: totalIter, voltages: ctx.dcopVoltages };
    }
    onPhaseEnd?.("dcopSubSolveConverged", true);
    ctx.cktMode = setInitf(ctx.cktMode, MODEINITFLOAT);  // cktop.c:603 continuemode=MODEINITFLOAT
    voltages.set(result.voltages);
  }

  scaleAllSources(ctx, 1);
  return { converged: true, iterations: totalIter, voltages };
}

// ---------------------------------------------------------------------------
// gillespieSrc — cktop.c:369-569
// ---------------------------------------------------------------------------

/**
 * Gillespie source stepping (cktop.c:369-569).
 *
 * Scales independent sources from 0 to 1 adaptively, using each converged
 * solution as the initial guess for the next step.
 */
function gillespieSrc(
  ctx: CKTCircuitContext,
  onPhaseBegin?: PhaseBeginFn,
  onPhaseEnd?: PhaseEndFn,
): StepResult {
  const { statePool, params } = ctx;

  const voltages = ctx.dcopVoltages;
  zeroState(voltages, statePool);
  ctx.cktMode = setInitf(ctx.cktMode, MODEINITJCT);  // cktop.c:381 firstmode=MODEINITJCT
  scaleAllSources(ctx, 0);

  const savedVoltages = ctx.dcopSavedVoltages;
  const savedState0 = ctx.dcopSavedState0;

  let totalIter = 0;

  // cktop.c:406-409: zero-source NR solve
  onPhaseBegin?.("dcopSrcSweep", 0);
  ctx.rhsOld.set(voltages);
  const zeroResult = runNR(ctx, params.dcTrcvMaxIter, 0, null);
  totalIter += zeroResult.iterations;
  voltages.set(zeroResult.voltages);

  if (!zeroResult.converged) {
    onPhaseEnd?.("nrFailedRetry", false);
    // cktop.c:413-458: gmin bootstrap for zero-source circuit
    let diagGmin = params.gmin * 1e10;
    let bootstrapConverged = false;
    for (let decade = 0; decade <= 10; decade++) {
      onPhaseBegin?.("dcopSrcSweep", 0);
      ctx.rhsOld.set(voltages);
      const bResult = runNR(ctx, params.dcTrcvMaxIter, diagGmin, null);
      totalIter += bResult.iterations;
      voltages.set(bResult.voltages);
      if (!bResult.converged) {
        onPhaseEnd?.("nrFailedRetry", false);
        break;
      }
      onPhaseEnd?.("dcopSubSolveConverged", true);
      ctx.cktMode = setInitf(ctx.cktMode, MODEINITFLOAT);  // cktop.c:453 continuemode=MODEINITFLOAT
      diagGmin /= 10;
      if (decade === 10) {
        bootstrapConverged = true;
      }
    }
    if (!bootstrapConverged) {
      scaleAllSources(ctx, 1);
      return { converged: false, iterations: totalIter, voltages: ctx.dcopVoltages };
    }
  } else {
    onPhaseEnd?.("dcopSubSolveConverged", true);
    ctx.cktMode = setInitf(ctx.cktMode, MODEINITFLOAT);  // cktop.c:453-497 continuemode=MODEINITFLOAT
  }

  // cktop.c:385-387: initialise stepping parameters
  let raise = 0.001;
  let convFact = 0;
  let srcFact = raise;

  const srcIterLo = (params.dcTrcvMaxIter / 4) | 0;
  const srcIterHi = ((3 * params.dcTrcvMaxIter / 4) | 0);

  // cktop.c:428-538: main source stepping loop
  while (raise >= 1e-7 && convFact < 1) {
    scaleAllSources(ctx, srcFact);
    onPhaseBegin?.("dcopSrcSweep", srcFact);
    ctx.rhsOld.set(voltages);
    const stepResult = runNR(ctx, params.dcTrcvMaxIter, params.gshunt ?? 0, null);
    totalIter += stepResult.iterations;

    if (stepResult.converged) {
      onPhaseEnd?.("dcopSubSolveConverged", true);
      ctx.cktMode = setInitf(ctx.cktMode, MODEINITFLOAT);  // cktop.c:497 continuemode=MODEINITFLOAT
      voltages.set(stepResult.voltages);
      saveSnapshot(voltages, savedVoltages, statePool, savedState0);
      convFact = srcFact;

      srcFact = convFact + raise;

      if (stepResult.iterations <= srcIterLo) {
        raise *= 1.5;
      } else if (stepResult.iterations > srcIterHi) {
        raise *= 0.5;
      }
    } else {
      onPhaseEnd?.("nrFailedRetry", false);
      if ((srcFact - convFact) < 1e-8) {
        break;
      }
      raise /= 10;
      if (raise > 0.01) {
        raise = 0.01;
      }
      restoreSnapshot(voltages, savedVoltages, statePool, savedState0);
      srcFact = convFact + raise;
    }

    if (srcFact > 1) {
      srcFact = 1;
    }
  }

  scaleAllSources(ctx, 1);

  if (convFact >= 1) {
    return { converged: true, iterations: totalIter, voltages };
  }

  return { converged: false, iterations: totalIter, voltages: ctx.dcopVoltages };
}
