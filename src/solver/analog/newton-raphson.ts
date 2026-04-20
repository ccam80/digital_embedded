/**
 * Newton-Raphson nonlinear iteration loop for MNA circuit simulation.
 *
 * Implements the core NR loop with cktLoad single-pass device loading,
 * voltage limiting (pnjlim for PN junctions, fetlim for MOSFETs), global and
 * element-specific convergence checking, and blame tracking.
 */

import type { DiagnosticCollector } from "./diagnostics.js";
import { makeDiagnostic } from "./diagnostics.js";
import type { CKTCircuitContext } from "./ckt-context.js";
import { cktLoad } from "./ckt-load.js";
import {
  isTranOp, isUic, initf, setInitf,
  MODEINITFLOAT, MODEINITJCT, MODEINITFIX,
  MODEINITTRAN, MODEINITPRED, MODEINITSMSIG,
} from "./ckt-mode.js";

// ---------------------------------------------------------------------------
// LimitingEvent — records a single voltage-limiting call per junction per NR iteration
// ---------------------------------------------------------------------------

/**
 * Records one voltage-limiting function application (pnjlim, fetlim, or limvds)
 * on a specific junction of a specific element during one NR iteration.
 *
 * Elements push events into the ctx.limitingCollector array after each
 * limiting function call. The NR loop resets the collector at the start
 * of each iteration.
 */
export interface LimitingEvent {
  /** Element index in compiled.elements[]. */
  elementIndex: number;
  /** Element label. */
  label: string;
  /** Junction name: "BE", "BC", "GS", "DS", "AK", etc. */
  junction: string;
  /** Limiting function applied. */
  limitType: "pnjlim" | "fetlim" | "limvds";
  /** Input voltage before limiting. */
  vBefore: number;
  /** Output voltage after limiting. */
  vAfter: number;
  /** Whether limiting was actually applied (vAfter differs from vBefore). */
  wasLimited: boolean;
}

// ---------------------------------------------------------------------------
// Voltage limiting functions
// ---------------------------------------------------------------------------

/**
 * Result of a pnjlim call, matching ngspice DEVpnjlim output parameters.
 */
export interface PnjlimResult {
  value: number;
  limited: boolean;
}

/**
 * PN-junction voltage limiting (pnjlim).
 *
 * Prevents exponential runaway in diode/BJT junction voltage updates by
 * compressing large forward-bias steps logarithmically, and clamping
 * large reverse-bias steps.
 *
 * Matches ngspice DEVpnjlim (devsup.c:50-58) exactly, including the
 * `*icheck` output parameter exposed here as the `limited` field.
 *
 * @param vnew  - Proposed new junction voltage
 * @param vold  - Previous junction voltage
 * @param vt    - Thermal voltage (kT/q, ~0.02585 V at 300 K)
 * @param vcrit - Critical voltage above which limiting engages
 * @returns     - { value: limited voltage, limited: true if clipping was applied }
 */
/**
 * Module-level reusable result object for pnjlim(). Mutated and returned on
 * every call -- callers MUST extract .value and .limited before the next
 * pnjlim() call, as the object is shared. Single-threaded, safe.
 */
const _pnjlimResult: PnjlimResult = { value: 0, limited: false };

/**
 * Direct JavaScript port of ngspice DEVpnjlim (devsup.c:50-58).
 *
 * Variable mapping (ngspice → ours):
 *   vnew   → vnew   (proposed new junction voltage)
 *   vold   → vold   (previous junction voltage)
 *   vt     → vt     (thermal voltage, kT/q ≈ 0.02585 V at 300 K)
 *   vcrit  → vcrit  (critical voltage, ≈0.6 V for silicon)
 *   *icheck → limited (true when ngspice sets *icheck = 1)
 *   log    → Math.log (natural logarithm)
 */
export function pnjlim(vnew: number, vold: number, vt: number, vcrit: number): PnjlimResult {
  let limited: boolean;
  if ((vnew > vcrit) && (Math.abs(vnew - vold) > (vt + vt))) {
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
    limited = true;
  } else {
    limited = false;
  }
  _pnjlimResult.value = vnew;
  _pnjlimResult.limited = limited;
  return _pnjlimResult;
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
  const vtstlo = vtsthi / 2 + 2;
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
 * Loop body follows ngspice NIiter ordering:
 *   A. Clear noncon + reset limit collector
 *   B. CKTload via cktLoad (single-pass device load)
 *   E. Factorize
 *   F. Solve
 *   H. Convergence check (global + element)
 *   I. Node damping (DCOP only)
 *   J. INITF dispatcher (mode transitions)
 *
 * Non-convergence is written into ctx.nrResult, never thrown. The caller
 * (DC operating point solver) decides the appropriate next strategy.
 *
 * @param ctx - Circuit context holding all solver state, buffers, and options
 */
export function newtonRaphson(ctx: CKTCircuitContext): void {
  const {
    solver, elements, matrixSize, nodeCount,
    reltol, abstol, iabstol,
  } = ctx;

  const diagnostics = ctx.diagnostics;

  // ngspice niiter.c:37-38 — unconditional floor: if (maxIter < 100) maxIter = 100;
  // Bypassed when exactMaxIterations is set (INITJCT/INITFIX need exactly 1 iteration).
  const rawMaxIter = ctx.maxIterations;
  const maxIterations = ctx.exactMaxIterations ? rawMaxIter : Math.max(rawMaxIter, 100);

  ctx.nrResult.reset();

  // Use ctx.rhs and ctx.rhsOld as the voltage ping-pong buffers.
  // nrResult.voltages already points to ctx.rhs.
  let voltages = ctx.rhs;
  let prevVoltages = ctx.rhsOld;

  const statePool = ctx.statePool ?? null;
  let oldState0: Float64Array | null = null;
  let ipass = 0;

  // Step D state: preorder runs at most once per CKT lifetime. ngspice
  // NIDIDPREORDER (cktdefs.h:143) is a CKT-state bit cleared only by
  // NIreinit (nireinit.c:42); our equivalent is solver._didPreorder, set
  // inside solver.preorder() and cleared by solver.invalidateTopology().
  // A per-NR-call local flag would be per-invocation scope — the wrong
  // scope — so we drop it entirely and rely on solver.preorder() being
  // idempotent.

  // Hoist the iter-0 split hook to avoid per-iteration property lookup.
  const onIter0Complete = ctx.onIteration0Complete;

  // dcopModeLadder: set initial initMode and prime junctions before iter 0.
  const ladder = ctx.dcopModeLadder ?? null;
  if (ladder) {
    ctx.cktMode = setInitf(ctx.cktMode, MODEINITJCT);
    ctx.initMode = "initJct";  // legacy mirror
    ladder.runPrimeJunctions();
  }

  // MODETRANOP && MODEUIC: single CKTload, no iteration (ngspice dctran.c UIC path).
  // ngspice dctran.c:117-189 — UIC early-exit exists only in DCtran, not DCop.
  // Gate on isTranOp(cktMode) && isUic(cktMode): standalone .OP with UIC=true
  // must NOT take this path — it must run the full CKTop ladder.
  if (isTranOp(ctx.cktMode) && isUic(ctx.cktMode)) {
    [voltages, prevVoltages] = [prevVoltages, voltages];
    ctx.rhsOld.set(prevVoltages);
    cktLoad(ctx);
    ctx.nrResult.converged = true;
    ctx.nrResult.iterations = 0;
    ctx.rhs.set(prevVoltages);
    return;
  }

  for (let iteration = 0; ; iteration++) {
    // ---- STEP A: Clear noncon + reset limit collector (ngspice CKTnoncon=0) ----
    ctx.noncon = 0;
    if (ctx.limitingCollector != null) {
      ctx.limitingCollector.length = 0;
    }

    // ---- STEP B: CKTload — single-pass device evaluation ----
    ctx.rhsOld.set(prevVoltages);
    cktLoad(ctx);

    // ---- STEP D: Preorder (ngspice niiter.c:844-855, NIDIDPREORDER gate) ----
    // solver.preorder() is idempotent via solver._didPreorder; calling
    // every iteration is harmless and matches ngspice's own behaviour of
    // gating every iteration on the bit.
    solver.preorder();

    // ---- STEP E: Factorize (gmin stamped atomically inside factor()) ----
    // ngspice SMPluFac/SMPreorder call LoadGmin internally, immediately
    // before spFactor/spOrderAndFactor (spsmp.c:173, 197). We mirror that by
    // passing diagGmin into factor() rather than calling addDiagonalGmin
    // separately — this keeps the gmin stamp and the factorization atomic
    // and aligned with ngspice's invariant that no caller observes a
    // post-gmin, pre-factor matrix.
    //
    // ngspice niiter.c:888-891: E_SINGULAR on the numerical-only path sets
    // NISHOULDREORDER and does `continue` (back to CKTload). factor() itself
    // now handles the partial-pivot-guard-driven fallthrough (spfactor.c:225)
    // by dispatching back through factorWithReorder internally, so a
    // `success: false` return here is a genuine singular-matrix failure.
    // ngspice niiter.c:863-864, 883-884 — CKTpivotAbsTol/CKTpivotRelTol are
    // forwarded into SMPreorder/SMPluFac every iteration. setPivotTolerances
    // is a cheap scalar store; doing it here (not just once at ctx
    // construction) matches ngspice's per-call semantic and lets hot-loaded
    // params propagate without an engine rebuild.
    solver.setPivotTolerances(ctx.pivotRelTol, ctx.pivotAbsTol);
    const factorResult = solver.factor(ctx.diagonalGmin);
    if (!factorResult.success) {
      if (!solver.lastFactorUsedReorder) {
        solver.forceReorder();
        continue;
      }
      diagnostics.emit(
        makeDiagnostic("singular-matrix", "error", "Singular matrix during NR iteration", {
          explanation: `The MNA matrix became singular at iteration ${iteration + 1}.`,
          suggestions: [],
        }),
      );
      ctx.nrResult.converged = false;
      ctx.nrResult.iterations = iteration + 1;
      ctx.nrResult.largestChangeElement = -1;
      ctx.nrResult.largestChangeNode = -1;
      return;
    }

    // Save state0 before solve for state0 damping (DO10)
    if (statePool) {
      if (!oldState0) {
        oldState0 = ctx.dcopOldState0;
      }
      oldState0.set(statePool.state0);
    }

    // ---- STEP F: Solve ----
    solver.solve(voltages);

    // ---- STEP G: Check iteration limit BEFORE convergence (ngspice niiter.c:944) ----
    if (iteration + 1 > maxIterations) {
      ctx.nrResult.converged = false;
      ctx.nrResult.iterations = iteration + 1;
      ctx.nrResult.largestChangeElement = -1;
      ctx.nrResult.largestChangeNode = -1;
      ctx.rhs.set(voltages);
      return;
    }

    // ---- STEP H: Convergence check (ngspice NIconvTest) ----
    // ngspice niiter.c:957-961: iterno==1 forces noncon=1 (guarantees >= 2 iterations).
    if (iteration === 0) {
      ctx.noncon = 1;
    }

    let globalConverged = false;
    let elemConverged = false;
    let largestChangeNode = 0;
    let largestChangeMag = 0;
    const convergenceFailedElements = ctx.convergenceFailures;
    convergenceFailedElements.length = 0;

    if (ctx.noncon === 0 && iteration > 0) {
      globalConverged = true;
      for (let i = 0; i < matrixSize; i++) {
        const delta = Math.abs(voltages[i] - prevVoltages[i]);
        if (delta > largestChangeMag) {
          largestChangeMag = delta;
          largestChangeNode = i;
        }
        const absTol = i < nodeCount ? abstol : iabstol;
        const tol = reltol * Math.max(Math.abs(voltages[i]), Math.abs(prevVoltages[i])) + absTol;
        if (delta > tol) {
          globalConverged = false;
        }
      }

      if (ctx.detailedConvergence) {
        const failedIndices: number[] = [];
        for (let i = 0; i < ctx.elementsWithConvergence.length; i++) {
          const el = ctx.elementsWithConvergence[i];
          if (!el.checkConvergence!(ctx.loadCtx)) {
            failedIndices.push(elements.indexOf(el));
          }
        }
        elemConverged = failedIndices.length === 0;
        convergenceFailedElements.length = 0;
        for (const i of failedIndices) {
          convergenceFailedElements.push(elements[i].label ?? `element_${i}`);
        }
      } else {
        elemConverged = true;
        for (const el of ctx.elementsWithConvergence) {
          if (!el.checkConvergence!(ctx.loadCtx)) {
            elemConverged = false;
            break;
          }
        }
      }
    } else if (ctx.noncon > 0 && iteration > 0 && ctx.detailedConvergence) {
      const failedIndices: number[] = [];
      for (let i = 0; i < ctx.elementsWithConvergence.length; i++) {
        const el = ctx.elementsWithConvergence[i];
        if (!el.checkConvergence!(ctx.loadCtx)) {
          failedIndices.push(elements.indexOf(el));
        }
      }
      elemConverged = false;
      convergenceFailedElements.length = 0;
      for (const i of failedIndices) {
        convergenceFailedElements.push(elements[i].label ?? `element_${i}`);
      }
    }

    // ---- STEP I: Newton damping (ngspice niiter.c:204-229) ----
    if (ctx.nodeDamping && ctx.noncon !== 0 && ctx.isDcOp && iteration > 0) {
      let maxDelta = 0;
      for (let i = 0; i < nodeCount; i++) {
        const delta = Math.abs(voltages[i] - prevVoltages[i]);
        if (delta > maxDelta) maxDelta = delta;
      }
      if (maxDelta > 10) {
        const dampFactor = Math.max(10 / maxDelta, 0.1);
        for (let i = 0; i < nodeCount; i++) {
          voltages[i] = prevVoltages[i] + dampFactor * (voltages[i] - prevVoltages[i]);
        }
        if (statePool && oldState0) {
          const s0 = statePool.state0;
          for (let i = 0; i < s0.length; i++) {
            s0[i] = oldState0[i] + dampFactor * (s0[i] - oldState0[i]);
          }
        }
      }
    }

    // Blame tracking
    let largestChangeElement = -1;
    if (ctx.enableBlameTracking) {
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
    }

    // Post-iteration hook for external instrumentation
    const limitingEvents = ctx.limitingCollector ?? [];
    ctx.postIterationHook?.(iteration, voltages, prevVoltages, ctx.noncon, globalConverged, elemConverged, limitingEvents, convergenceFailedElements, ctx);

    // ---- STEP J: Unified INITF dispatcher (ngspice niiter.c:1050-1085) ----
    // Read current INITF bits from cktMode (single source of truth).
    const curInitf = initf(ctx.cktMode);

    if (curInitf === MODEINITFLOAT) {
      if (ctx.noncon === 0 && globalConverged && elemConverged) {
        if (ctx.isDcOp && ctx.hadNodeset && ipass > 0) {
          ipass--;
          ctx.noncon = 1;
        } else {
          if (ladder) {
            ladder.onModeEnd("dcopInitFloat", iteration, true);
          }
          ctx.nrResult.converged = true;
          ctx.nrResult.iterations = iteration + 1;
          ctx.nrResult.largestChangeElement = largestChangeElement;
          ctx.nrResult.largestChangeNode = largestChangeNode;
          ctx.rhs.set(voltages);
          return;
        }
      }
    } else if (curInitf === MODEINITJCT) {
      ctx.cktMode = setInitf(ctx.cktMode, MODEINITFIX);
      ctx.initMode = "initFix";  // legacy mirror
      solver.forceReorder();
      if (ladder) {
        ladder.onModeEnd("dcopInitJct", iteration, false);
        ladder.onModeBegin("dcopInitFix", iteration + 1);
      }
    } else if (curInitf === MODEINITFIX) {
      if (ctx.noncon === 0) {
        ctx.cktMode = setInitf(ctx.cktMode, MODEINITFLOAT);
        ctx.initMode = "initFloat";  // legacy mirror
        ipass = 1;
        if (ladder) {
          ladder.onModeEnd("dcopInitFix", iteration, false);
          ladder.onModeBegin("dcopInitFloat", iteration + 1);
        }
      }
    } else if (curInitf === MODEINITTRAN) {
      ctx.cktMode = setInitf(ctx.cktMode, MODEINITFLOAT);
      ctx.initMode = "initFloat";  // legacy mirror
      if (iteration <= 0) {
        solver.forceReorder();
      }
    } else if (curInitf === MODEINITPRED) {
      ctx.cktMode = setInitf(ctx.cktMode, MODEINITFLOAT);
      ctx.initMode = "initFloat";  // legacy mirror
    } else if (curInitf === MODEINITSMSIG) {
      ctx.cktMode = setInitf(ctx.cktMode, MODEINITFLOAT);
      ctx.initMode = "initFloat";  // legacy mirror
    }

    // Split marker: after iteration 0, let the harness observe cold linearization
    if (onIter0Complete && iteration === 0) {
      onIter0Complete();
    }

    // ---- STEP K: Swap RHS vectors (O(1) pointer swap) ----
    const tmp = voltages;
    voltages = prevVoltages;
    prevVoltages = tmp;
  }

  // After the final Step K swap, prevVoltages holds the last solution.
  ctx.nrResult.converged = false;
  ctx.nrResult.iterations = maxIterations;
  ctx.nrResult.largestChangeElement = -1;
  ctx.nrResult.largestChangeNode = -1;
  ctx.rhs.set(prevVoltages);
}
