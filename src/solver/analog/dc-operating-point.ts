/**
 * DC operating point solver- ngspice CKTop three-level fallback.
 *
 * Implements the three-level convergence stack from ngspice cktop.c:20-79:
 *
 *   Level 0- Direct NR: standard Newton-Raphson with params.maxIterations
 *   Level 1- dynamicGmin: adaptive diagonal conductance stepping
 *              (cktop.c:127-258), analogous to ngspice's CKTdcOp gmin path
 *   Level 2- gillespieSrc: adaptive source stepping
 *              (cktop.c:369-569), Gillespie source-stepping algorithm
 *   Level 3- Failure: emit blame diagnostics
 *
 * Variable mapping (ngspice → ours):
 *   CKTdiagGmin      → ctx.diagonalGmin (set before each NR call)
 *   CKTgmin          → ctx.params.gmin
 *   CKTgminFactor    → ctx.params.gminFactor (default 10, cktntask.c:103)
 *   CKTdcTrcvMaxIter → ctx.dcTrcvMaxIter
 *   CKTdcMaxIter     → ctx.maxIterations
 *   CKTrhsOld        → ctx.rhsOld
 *   CKTrhs           → ctx.rhs
 *   CKTstate0        → ctx.statePool.state0
 *   OldRhsOld        → ctx.dcopSavedVoltages
 *   OldCKTstate0     → ctx.dcopSavedState0
 *
 * `ctx.dcopVoltages` is digiTS-only- it is the destination buffer that
 * `ctx.dcopResult.nodeVoltages` aliases, populated once at success from
 * `ctx.rhs`. It plays no role inside any NR sub-solve and has no ngspice
 * analogue; ngspice consumers read `CKTrhs` directly after CKTop returns.
 */

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
 * ngspice reference: cktop.c:385 (gillespie_src start- `ckt->CKTsrcFact = 0;`)
 * and cktop.c:475,514 (increment during ramp). vsrcload.c:54 and isrcload.c
 * read `ckt->CKTsrcFact` directly in each device's load()- no per-element
 * setter dispatch.
 */
function scaleAllSources(ctx: CKTCircuitContext, factor: number): void {
  ctx.srcFact = factor;
}

/**
 * Zero CKTrhsOld and CKTstate0 once at sub-solver entry.
 *
 * Mirrors cktop.c:156-160 (dynamic_gmin) and cktop.c:398-402 (gillespie_src).
 * Called from `dynamicGmin` and `gillespieSrc` only- `spice3_gmin` and
 * `spice3_src` perform NO entry zero pass and inherit both buffers from the
 * caller's prior NIiter exit state.
 */
function zeroRhsOldAndState(
  ctx: CKTCircuitContext,
  statePool: { state0: Float64Array } | null,
): void {
  ctx.rhsOld.fill(0);
  if (statePool) {
    statePool.state0.fill(0);
  }
}

/**
 * Snapshot CKTrhsOld and CKTstate0 into the OldRhsOld / OldCKTstate0 buffers.
 *
 * Mirrors cktop.c:186-194 (dynamic_gmin) and cktop.c:463-470 / 502-509
 * (gillespie_src), which save the post-NIiter `CKTrhsOld[n->number]` (i.e.
 * the iter-K-1 output of the converging solve) for restoration on backtrack.
 */
function saveSnapshot(
  rhsOld: Float64Array,
  saved: Float64Array,
  statePool: { state0: Float64Array } | null | undefined,
  savedState: Float64Array,
): void {
  saved.set(rhsOld);
  if (statePool) {
    savedState.set(statePool.state0);
  }
}

/**
 * Restore CKTrhsOld and CKTstate0 from the OldRhsOld / OldCKTstate0 buffers.
 *
 * Mirrors cktop.c:226-233 (dynamic_gmin) and cktop.c:539-545 (gillespie_src).
 */
function restoreSnapshot(
  rhsOld: Float64Array,
  saved: Float64Array,
  statePool: { state0: Float64Array } | null | undefined,
  savedState: Float64Array,
): void {
  rhsOld.set(saved);
  if (statePool) {
    statePool.state0.set(savedState);
  }
}

// ---------------------------------------------------------------------------
// StepResult- internal return type for stepping sub-solvers
// ---------------------------------------------------------------------------

interface StepResult {
  converged: boolean;
  iterations: number;
  voltages: Float64Array;
}

type PhaseBeginFn = ((phase: DcOpNRPhase, phaseParameter?: number) => void) | undefined;
type PhaseEndFn = ((outcome: DcOpNRAttemptOutcome, converged: boolean) => void) | undefined;

// ---------------------------------------------------------------------------
// runNR- configure ctx for a sub-solve and call newtonRaphson
// ---------------------------------------------------------------------------

/**
 * Configure ctx for a DC-OP sub-solve and run newtonRaphson.
 *
 * Sets isDcOp=true, maxIterations, initialGuess, diagonalGmin, and
 * nrModeLadder on ctx, then calls newtonRaphson(ctx).
 *
 * Returns a StepResult pointing to ctx.rhs (the solved voltage vector).
 * Callers must copy ctx.rhs before the next runNR call if they want to
 * preserve intermediate results.
 */
function runNR(
  ctx: CKTCircuitContext,
  maxIterations: number,
  diagonalGmin: number,
  ladder: CKTCircuitContext["nrModeLadder"],
): StepResult {
  // The caller (dcOperatingPoint / _transientDcop in analog-engine.ts) owns
  // the cktMode write- standalone .OP sets MODEDCOP | MODEINITJCT (dcop.c:82)
  // and transient-boot DCOP sets MODETRANOP | MODEINITJCT (dctran.c:231).
  // Sub-solves (gmin/src stepping ladders) inherit those bits and only flip
  // the INITF sub-field via ladder.onModeBegin. The cktMode bitfield already
  // encodes the correct analysis mode and sub-solves must not clobber it
  // (MODETRANOP has MODETRAN set, and zeroing it here would break srcFact
  // scaling inside the transient-boot ladder).

  ctx.maxIterations = maxIterations;
  ctx.diagonalGmin = diagonalGmin;
  ctx.nrModeLadder = ladder;
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
// cktop- ngspice cktop.c:20-79 direct NR level
// ---------------------------------------------------------------------------

/**
 * Run the direct-NR level of the DC-OP ladder (cktop.c:20-79).
 *
 * Sets the firstmode INITF bits and dispatches to NIiter. Does NOT touch
 * CKTrhsOld- ngspice cktop.c:46 passes it directly to NIiter, which inherits
 * whatever the prior NIiter call (or NIreinit, on a fresh circuit) left
 * there. digiTS matches: ctx.rhsOld carries forward across solveDcOperatingPoint
 * invocations (it is a `Float64Array(sizePlusOne)` so it starts at zero on
 * engine construction; engine.reset() re-zeroes it).
 *
 * When `params.noOpIter` is true (cktop.c:47-48), the direct NR attempt is
 * skipped and the result is reported as failed (`converged=false`) so
 * `solveDcOperatingPoint` falls through to gmin stepping. ngspice models
 * this with `converged = 1` ("the 'go directly to gmin stepping' option").
 */
function cktop(
  ctx: CKTCircuitContext,
  firstInitf: number,
  maxIter: number,
  ladder: CKTCircuitContext["nrModeLadder"],
): StepResult {
  ctx.cktMode = setInitf(ctx.cktMode, firstInitf);
  if (ctx.params.noOpIter) {
    return {
      converged: false,
      iterations: 0,
      voltages: ctx.rhs,
    };
  }
  return runNR(ctx, maxIter, ctx.diagonalGmin, ladder);
}

// ---------------------------------------------------------------------------
// dcopFinalize- ngspice DCop initSmsig final CKTload (dcop.c:127,153)
// ---------------------------------------------------------------------------

/**
 * Finalize the standalone .OP DC operating point after convergence.
 *
 * Mirrors ngspice `DCop` (dcop.c:127 mode write, dcop.c:153 CKTload call):
 *   ckt->CKTmode = (ckt->CKTmode & MODEUIC) | MODEDCOP | MODEINITSMSIG;
 *   converged = CKTload(ckt);
 *
 * One CKTmode reassignment to flip INITF to MODEINITSMSIG, one CKTload call,
 * no factor, no solve, no iteration, no NR. CKTload reads `CKTrhsOld` (which
 * holds the iter-K-1 output of the prior NIiter exit per niiter.c:1066-1069)
 * for bias-point voltages and re-evaluates each device's small-signal
 * quantities (e.g. capacitor `geqcb`) into state0.
 *
 * After the load, ngspice does NOT reset CKTmode. We clear INITF back to
 * MODEINITFLOAT on return so cktMode never leaks MODEINITSMSIG across
 * analysis boundaries- matches niiter.c:1070-1071's post-converge INITF
 * landing mode.
 *
 * Runs ONLY on the standalone .OP path (!isTranOp(ctx.cktMode)). The
 * transient-boot DCOP path (dctran.c:230-346) has no smsig load and callers
 * must skip this function- gate on !isTranOp(ctx.cktMode) at each call site.
 */
function dcopFinalize(ctx: CKTCircuitContext): void {
  ctx.cktMode = setInitf(ctx.cktMode, MODEINITSMSIG);
  cktLoad(ctx);
  ctx.cktMode = setInitf(ctx.cktMode, MODEINITFLOAT);
}

// ---------------------------------------------------------------------------
// cktncDump- per-node non-convergence diagnostics (cktncdump.c)
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
  rhs: Float64Array,
  prevVoltages: Float64Array,
  reltol: number,
  voltTol: number,
  abstol: number,
  nodeCount: number,
  matrixSize: number,
): Array<{ node: number; delta: number; tol: number }> {
  scratch.length = 0;
  for (let i = 0; i < matrixSize; i++) {
    const delta = Math.abs(rhs[i] - prevVoltages[i]);
    const tol =
      reltol * Math.max(Math.abs(rhs[i]), Math.abs(prevVoltages[i])) +
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
  const { params } = ctx;
  const matrixSize = ctx.solver.matrixSize;
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

  // ngspice cktop.c:46- NIiter is invoked with whatever CKTrhsOld carried
  // from the prior call (or NIreinit's zero-fill on a fresh circuit). digiTS
  // matches: ctx.rhsOld is left untouched here.

  const directResult = cktop(
    ctx,
    MODEINITJCT,
    params.maxIterations,
    ladder,
  );
  if (!directResult.converged) {
    onPhaseEnd?.("nrFailedRetry", false);
  }

  if (directResult.converged) {
    ctx.dcopVoltages.set(ctx.rhs);
    // ngspice DCtran (dctran.c:230-346) performs NO CKTload after the
    // transient-boot CKTop returns. The initSmsig load fires only from DCop
    // (dcop.c:127,153) on the standalone .OP path. Gate on !isTranOp(ctx.cktMode)
    // so transient-boot DCOP skips the smsig pass entirely.
    if (!isTranOp(ctx.cktMode)) {
      dcopFinalize(ctx);
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
    ctx.dcopResult.diagnostics = diagnostics.getDiagnostics();
    return;
  }

  let totalIterations = directResult.iterations;

  // -------------------------------------------------------------------------
  // Level 1- gmin stepping (cktop.c:57-60: select ONE gmin method)
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
    ctx.dcopVoltages.set(ctx.rhs);
    // smsig load is .OP-only- skip on transient-boot DCOP (dctran.c:230-346).
    if (!isTranOp(ctx.cktMode)) {
      dcopFinalize(ctx);
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
    ctx.dcopResult.diagnostics = diagnostics.getDiagnostics();
    return;
  }

  // -------------------------------------------------------------------------
  // Level 2- source stepping (cktop.c:66-75: select ONE source-stepping method)
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
    ctx.dcopVoltages.set(ctx.rhs);
    // smsig load is .OP-only- skip on transient-boot DCOP (dctran.c:230-346).
    if (!isTranOp(ctx.cktMode)) {
      dcopFinalize(ctx);
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
    ctx.dcopResult.diagnostics = diagnostics.getDiagnostics();
    return;
  }

  // -------------------------------------------------------------------------
  // Level 5- Failure with blame attribution (cktncdump.c)
  //
  // ngspice CKTncDump compares the iter-K output (CKTrhs) against the
  // iter-K-1 output (CKTrhsOld) at the moment NIiter gave up. After the last
  // failed sub-solve, ctx.rhs and ctx.rhsOld hold exactly that pair.
  // -------------------------------------------------------------------------
  const ncNodes = cktncDump(
    ctx.ncDumpScratch,
    ctx._ncDumpPool,
    ctx.rhs,
    ctx.rhsOld,
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
// dynamicGmin- cktop.c:127-258
// ---------------------------------------------------------------------------

/**
 * Dynamic Gmin stepping (cktop.c:127-258).
 *
 * Adds a diagonal conductance (diagGmin) to all MNA nodes, converges,
 * then adaptively reduces diagGmin toward params.gmin.
 *
 * cktop.c:156-160 zeroes CKTrhsOld and CKTstate0 ONCE at function entry.
 * Subsequent NIiter calls inherit whatever the previous call left in
 * CKTrhsOld (the post-NIiter swap exit invariant), with explicit
 * OldRhsOld/OldCKTstate0 save+restore on backtrack (cktop.c:186-194 save,
 * cktop.c:226-233 restore).
 */
function dynamicGmin(
  ctx: CKTCircuitContext,
  onPhaseBegin?: PhaseBeginFn,
  onPhaseEnd?: PhaseEndFn,
): StepResult {
  const { statePool, params } = ctx;

  // cktop.c:156-160- single zero pass at function entry.
  zeroRhsOldAndState(ctx, statePool);

  ctx.cktMode = setInitf(ctx.cktMode, MODEINITJCT);  // cktop.c:35 firstmode=MODEINITJCT

  const savedVoltages = ctx.dcopSavedVoltages;
  const savedState0 = ctx.dcopSavedState0;

  let factor = params.gminFactor ?? 10;
  let oldGmin = 1e-2;
  let diagGmin = oldGmin;
  const gtarget = Math.max(params.gmin, params.gshunt ?? 0);
  let totalIter = 0;

  while (true) {
    onPhaseBegin?.("dcopGminDynamic", diagGmin);
    const result = runNR(ctx, params.dcTrcvMaxIter, diagGmin, null);
    totalIter += result.iterations;

    if (result.converged) {
      onPhaseEnd?.("dcopSubSolveConverged", true);
      ctx.cktMode = setInitf(ctx.cktMode, MODEINITFLOAT);  // cktop.c:179 continuemode=MODEINITFLOAT
      if (diagGmin <= gtarget) {
        break;
      }

      // cktop.c:186-194- save CKTrhsOld + CKTstate0 (the iter-K-1 output of
      // the converging NIiter call, per niiter.c:1066-1069 no-swap exit).
      saveSnapshot(ctx.rhsOld, savedVoltages, statePool, savedState0);

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
        return { converged: false, iterations: totalIter, voltages: ctx.rhs };
      }
      factor = Math.sqrt(Math.sqrt(factor));
      diagGmin = oldGmin / factor;
      // cktop.c:226-233- restore CKTrhsOld + CKTstate0 from snapshot.
      restoreSnapshot(ctx.rhsOld, savedVoltages, statePool, savedState0);
    }
  }

  // cktop.c:253- final clean solve, no rhsOld touch (carries forward from
  // the last successful NIiter exit inside the while loop).
  onPhaseBegin?.("dcopGminDynamic", 0);
  const cleanResult = runNR(ctx, params.maxIterations, params.gshunt ?? 0, null);
  totalIter += cleanResult.iterations;
  onPhaseEnd?.(cleanResult.converged ? "accepted" : "finalFailure", cleanResult.converged);

  return {
    converged: cleanResult.converged,
    iterations: totalIter,
    voltages: ctx.rhs,
  };
}

// ---------------------------------------------------------------------------
// spice3Gmin- cktop.c:273-341
// ---------------------------------------------------------------------------

/**
 * spice3 Gmin stepping (cktop.c:273-341).
 *
 * Starts with diagGmin = params.gmin * gminFactor^numGminSteps, then ramps
 * it down by gminFactor per step, for numGminSteps+1 steps. No backtracking.
 *
 * NO entry zero of CKTrhsOld or CKTstate0- both inherit from the prior
 * NIiter exit (cktop.c:285-303 only writes CKTmode and CKTdiagGmin).
 */
function spice3Gmin(
  ctx: CKTCircuitContext,
  onPhaseBegin?: PhaseBeginFn,
  onPhaseEnd?: PhaseEndFn,
): StepResult {
  const { params } = ctx;

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
    const result = runNR(ctx, params.dcTrcvMaxIter, diagGmin, null);
    totalIter += result.iterations;

    if (!result.converged) {
      onPhaseEnd?.("nrFailedRetry", false);
      return { converged: false, iterations: totalIter, voltages: ctx.rhs };
    }

    onPhaseEnd?.("dcopSubSolveConverged", true);
    ctx.cktMode = setInitf(ctx.cktMode, MODEINITFLOAT);  // cktop.c:319 continuemode=MODEINITFLOAT
    diagGmin /= gminFactor;
  }

  // cktop.c:338- final clean solve, no rhsOld touch.
  onPhaseBegin?.("dcopGminSpice3", 0);
  const cleanResult = runNR(ctx, params.dcTrcvMaxIter, params.gshunt ?? 0, null);
  totalIter += cleanResult.iterations;
  onPhaseEnd?.(cleanResult.converged ? "accepted" : "finalFailure", cleanResult.converged);

  return {
    converged: cleanResult.converged,
    iterations: totalIter,
    voltages: ctx.rhs,
  };
}

// ---------------------------------------------------------------------------
// spice3Src- cktop.c:583-628
// ---------------------------------------------------------------------------

/**
 * spice3 source stepping (cktop.c:583-628).
 * Uniform linear source ramp with no backtracking.
 *
 * NO entry zero of CKTrhsOld or CKTstate0- both inherit from the prior
 * NIiter exit (cktop.c:583-595 only writes CKTmode).
 */
function spice3Src(
  ctx: CKTCircuitContext,
  onPhaseBegin?: PhaseBeginFn,
  onPhaseEnd?: PhaseEndFn,
): StepResult {
  const { params } = ctx;

  ctx.cktMode = setInitf(ctx.cktMode, MODEINITJCT);  // cktop.c:591 firstmode=MODEINITJCT
  let totalIter = 0;
  const numSrcSteps = params.numSrcSteps ?? 1;

  for (let i = 0; i <= numSrcSteps; i++) {
    const srcFact = i / numSrcSteps;
    scaleAllSources(ctx, srcFact);
    onPhaseBegin?.("dcopSrcSweep", srcFact);
    const result = runNR(ctx, params.dcTrcvMaxIter, 0, null);
    totalIter += result.iterations;
    if (!result.converged) {
      onPhaseEnd?.("nrFailedRetry", false);
      scaleAllSources(ctx, 1);
      return { converged: false, iterations: totalIter, voltages: ctx.rhs };
    }
    onPhaseEnd?.("dcopSubSolveConverged", true);
    ctx.cktMode = setInitf(ctx.cktMode, MODEINITFLOAT);  // cktop.c:603 continuemode=MODEINITFLOAT
  }

  scaleAllSources(ctx, 1);
  return { converged: true, iterations: totalIter, voltages: ctx.rhs };
}

// ---------------------------------------------------------------------------
// gillespieSrc- cktop.c:369-569
// ---------------------------------------------------------------------------

/**
 * Gillespie source stepping (cktop.c:369-569).
 *
 * Scales independent sources from 0 to 1 adaptively, using each converged
 * solution as the initial guess for the next step.
 *
 * cktop.c:398-402 zeroes CKTrhsOld and CKTstate0 ONCE at function entry.
 * After the zero-source (or gmin bootstrap) converges, cktop.c:463-470
 * captures the converged-state snapshot. Subsequent main-loop iterations
 * save on success (cktop.c:502-509) and restore on retry (cktop.c:539-545).
 */
function gillespieSrc(
  ctx: CKTCircuitContext,
  onPhaseBegin?: PhaseBeginFn,
  onPhaseEnd?: PhaseEndFn,
): StepResult {
  const { statePool, params } = ctx;

  ctx.cktMode = setInitf(ctx.cktMode, MODEINITJCT);  // cktop.c:381 firstmode=MODEINITJCT
  scaleAllSources(ctx, 0);

  // cktop.c:398-402- single zero pass at function entry.
  zeroRhsOldAndState(ctx, statePool);

  const savedVoltages = ctx.dcopSavedVoltages;
  const savedState0 = ctx.dcopSavedState0;

  let totalIter = 0;

  // cktop.c:406-409: zero-source NR solve.
  onPhaseBegin?.("dcopSrcSweep", 0);
  const zeroResult = runNR(ctx, params.dcTrcvMaxIter, 0, null);
  totalIter += zeroResult.iterations;

  if (!zeroResult.converged) {
    onPhaseEnd?.("nrFailedRetry", false);
    // cktop.c:413-458: gmin bootstrap for zero-source circuit.
    let diagGmin = params.gmin * 1e10;
    let bootstrapConverged = false;
    for (let decade = 0; decade <= 10; decade++) {
      onPhaseBegin?.("dcopSrcSweep", 0);
      const bResult = runNR(ctx, params.dcTrcvMaxIter, diagGmin, null);
      totalIter += bResult.iterations;
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
      return { converged: false, iterations: totalIter, voltages: ctx.rhs };
    }
  } else {
    onPhaseEnd?.("dcopSubSolveConverged", true);
    ctx.cktMode = setInitf(ctx.cktMode, MODEINITFLOAT);  // cktop.c:453-497 continuemode=MODEINITFLOAT
  }

  // cktop.c:463-470- save initial converged state (after either the direct
  // zero-source solve or the gmin bootstrap path) before entering the main
  // ramp loop. Required so the first main-loop retry has a snapshot to
  // restore from.
  saveSnapshot(ctx.rhsOld, savedVoltages, statePool, savedState0);

  // cktop.c:385-387: initialise stepping parameters.
  let raise = 0.001;
  let convFact = 0;
  let srcFact = raise;

  const srcIterLo = (params.dcTrcvMaxIter / 4) | 0;
  const srcIterHi = ((3 * params.dcTrcvMaxIter / 4) | 0);

  // cktop.c:478-552: main source stepping loop.
  while (raise >= 1e-7 && convFact < 1) {
    scaleAllSources(ctx, srcFact);
    onPhaseBegin?.("dcopSrcSweep", srcFact);
    const stepResult = runNR(ctx, params.dcTrcvMaxIter, params.gshunt ?? 0, null);
    totalIter += stepResult.iterations;

    if (stepResult.converged) {
      onPhaseEnd?.("dcopSubSolveConverged", true);
      ctx.cktMode = setInitf(ctx.cktMode, MODEINITFLOAT);  // cktop.c:497 continuemode=MODEINITFLOAT
      // cktop.c:502-509- save CKTrhsOld + CKTstate0 (iter-K-1 output of
      // the just-converged NIiter call) for restoration on a future retry.
      saveSnapshot(ctx.rhsOld, savedVoltages, statePool, savedState0);
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
      // cktop.c:539-545- restore CKTrhsOld + CKTstate0 from snapshot.
      restoreSnapshot(ctx.rhsOld, savedVoltages, statePool, savedState0);
      srcFact = convFact + raise;
    }

    if (srcFact > 1) {
      srcFact = 1;
    }
  }

  scaleAllSources(ctx, 1);

  return {
    converged: convFact >= 1,
    iterations: totalIter,
    voltages: ctx.rhs,
  };
}
