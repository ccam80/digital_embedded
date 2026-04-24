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
  isTranOp, isUic, isDcop, initf, setInitf,
  MODEINITFLOAT, MODEINITJCT, MODEINITFIX,
  MODEINITTRAN, MODEINITPRED, MODEINITSMSIG,
} from "./ckt-mode.js";
// Self-namespace import: lets intra-module calls (e.g. `fetlim` → `_computeVtstlo`)
// route through the exports object rather than the lexical binding, so that
// `vi.spyOn(NewtonRaphsonModule, "_computeVtstlo")` can intercept the call
// from test code and guard against future inline re-expansion of the helper.
import * as self from "./newton-raphson.js";

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
 * Matches ngspice DEVpnjlim (devsup.c:49-84) exactly, including the
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
 * Direct JavaScript port of ngspice DEVpnjlim (devsup.c:49-84).
 *
 * Includes the Gillespie negative-bias branch (devsup.c:67-82) — D4 in
 * spec/architectural-alignment.md. When vnew is not above the forward
 * critical-voltage threshold but is negative, the reverse clamp engages:
 *   vold > 0:  arg = -vold - 1
 *   vold <= 0: arg = 2*vold - 1
 *   if vnew < arg, clamp vnew = arg and flag limited
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
  // devsup.c:54: forward limiting branch
  if ((vnew > vcrit) && (Math.abs(vnew - vold) > (vt + vt))) {
    if (vold > 0) {
      // devsup.c:56-61
      const arg = (vnew - vold) / vt;
      if (arg > 0) {
        vnew = vold + vt * (2 + Math.log(arg - 2));
      } else {
        vnew = vold - vt * (2 + Math.log(2 - arg));
      }
    } else {
      // devsup.c:62-64: vold <= 0 forward limit
      vnew = vt * Math.log(vnew / vt);
    }
    limited = true;
  } else {
    // devsup.c:66-82: Gillespie negative-bias branch (D4).
    // Engages when the forward limit does not apply but vnew is negative.
    if (vnew < 0) {
      let arg: number;
      if (vold > 0) {
        // devsup.c:68-69
        arg = -1 * vold - 1;
      } else {
        // devsup.c:70-72
        arg = 2 * vold - 1;
      }
      // devsup.c:73-78: clamp vnew when it overshoots the reverse bound
      if (vnew < arg) {
        vnew = arg;
        limited = true;
      } else {
        limited = false;
      }
    } else {
      // devsup.c:79-81
      limited = false;
    }
  }
  _pnjlimResult.value = vnew;
  _pnjlimResult.limited = limited;
  return _pnjlimResult;
}

/**
 * Alan Gillespie's `vtstlo` coefficient for `fetlim`.
 *
 * ngspice redefined this coefficient from the spice3f5 formula
 * `vtsthi/2 + 2` to `fabs(vold - vto) + 1` (devsup.c:102, see the
 * "new definition for vtstlo" note at devsup.c:88-90 and ngspice.texi:12002-12008).
 *
 * Exported so the test suite can exercise the Gillespie formula directly:
 * the outer `fetlim` clamps (`vtemp = vto + 0.5`, `vtox = vto + 3.5`) dominate
 * every end-to-end input that would straddle the old/new `vtstlo` thresholds,
 * so no `fetlim(vnew, vold, vto)` triple exposes the `vtstlo` coefficient to a
 * round-trip assertion.
 */
export function _computeVtstlo(vold: number, vto: number): number {
  return Math.abs(vold - vto) + 1;
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
  // cite: devsup.c:101-102
  const vtsthi = Math.abs(2 * (vold - vto)) + 2;
  const vtstlo = self._computeVtstlo(vold, vto);
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
 * Algorithm from SPICE3f5/ngspice DEVlimvds (devsup.c:17-40).
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

  // dcopModeLadder: set initial INITF bit (MODEINITJCT) before iter 0.
  const ladder = ctx.dcopModeLadder ?? null;
  if (ladder) {
    ctx.cktMode = setInitf(ctx.cktMode, MODEINITJCT);
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

    // ---- B5 (Phase 2.5 W2.1): NISHOULDREORDER trigger before factor ----
    // Mechanical port of ngspice niiter.c:856-859, which sits BETWEEN
    // SMPpreOrder (matching our solver.preorder() above) and the
    // SMPreorder/SMPluFac dispatch:
    //
    //     if( (ckt->CKTmode & MODEINITJCT) ||
    //             ( (ckt->CKTmode & MODEINITTRAN) && (iterno==1))) {
    //         ckt->CKTniState |= NISHOULDREORDER;
    //     }
    //
    // Our `iteration` counter is 0-based; ngspice's `iterno` is 1-based and
    // has already been incremented at this point in niiter.c (niiter.c:670),
    // so ngspice's `iterno == 1` corresponds to our `iteration === 0`.
    //
    // forceReorder() sets _needsReorder = true, which factor() below then
    // routes through factorWithReorder (ngspice SMPreorder path).
    const curInitfNow = initf(ctx.cktMode);
    if (curInitfNow === MODEINITJCT ||
        (curInitfNow === MODEINITTRAN && iteration === 0)) {
      solver.forceReorder();
    }

    // ---- STEP E: Factorize (gmin stamped atomically inside factor()) ----
    // B3 (Phase 2.5 W2.1): ngspice SMPluFac/SMPreorder call LoadGmin
    // internally, immediately before spFactor/spOrderAndFactor (spsmp.c:173,
    // 197). The gmin stamp lives inside factor(); there is no external
    // addDiagonalGmin API — the stamp + factor pair is atomic, matching
    // ngspice's invariant that no caller observes a post-gmin, pre-factor
    // matrix.
    //
    // H2 (Phase 2.5 W2.2) — NR owns the diagonal-Gmin decision points
    // mirroring niiter.c::NIiter:
    //   (a) forceReorder() dispatch — niiter.c:856-859 NISHOULDREORDER
    //       trigger on INITJCT/INITTRAN (see lines 353-357 above).
    //   (b) diagGmin forwarded every factor call — niiter.c:863-864 and
    //       :883-884 pass ckt->CKTdiagGmin into SMPreorder/SMPluFac every
    //       iteration. Our factor(ctx.diagonalGmin) below mirrors that.
    //   (c) E_SINGULAR retry loop — niiter.c:888-891 sets NISHOULDREORDER
    //       and `continue`s; we mirror with forceReorder() + continue
    //       below (lines ~380-383).
    // The gmin-stepping ladder (setting ctx.diagonalGmin across multiple
    // NR invocations) lives in dc-operating-point.ts::dynamicGmin /
    // spice3Gmin / gillespieSrc, matching ngspice's cktop.c::dynamicgmin
    // / spice3gmin / gillespie_src. NR owns per-iteration decisions; the
    // DC-OP ladder owns cross-solve gmin ramping. No stand-alone
    // addDiagonalGmin API exists.
    //
    // ngspice niiter.c:863-864, 883-884 — CKTpivotAbsTol/CKTpivotRelTol are
    // forwarded into SMPreorder/SMPluFac every iteration. setPivotTolerances
    // is a cheap scalar store; doing it here (not just once at ctx
    // construction) matches ngspice's per-call semantic and lets hot-loaded
    // params propagate without an engine rebuild.
    solver.setPivotTolerances(ctx.pivotRelTol, ctx.pivotAbsTol);
    const factorResult = solver.factor(ctx.diagonalGmin);
    if (!factorResult.success) {
      // H2 (Phase 2.5 W2.2) — mirror niiter.c:888-891: on SMPluFac E_SINGULAR
      // NR sets NISHOULDREORDER and does `continue` back to CKTload. We
      // invoke solver.forceReorder() and `continue` for the same effect.
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
    if (ctx.nodeDamping && ctx.noncon !== 0 && isDcop(ctx.cktMode) && iteration > 0) {
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
        if (isDcop(ctx.cktMode) && ctx.hadNodeset && ipass > 0) {
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
      solver.forceReorder();
      if (ladder) {
        ladder.onModeEnd("dcopInitJct", iteration, false);
        ladder.onModeBegin("dcopInitFix", iteration + 1);
      }
    } else if (curInitf === MODEINITFIX) {
      if (ctx.noncon === 0) {
        ctx.cktMode = setInitf(ctx.cktMode, MODEINITFLOAT);
        ipass = 1;
        if (ladder) {
          ladder.onModeEnd("dcopInitFix", iteration, false);
          ladder.onModeBegin("dcopInitFloat", iteration + 1);
        }
      }
    } else if (curInitf === MODEINITTRAN) {
      // B5 (Phase 2.5 W2.1): the NISHOULDREORDER trigger moved to the top of
      // the loop (before factor), matching ngspice niiter.c:856-859. Here we
      // only mirror niiter.c:1074 — clear MODEINITTRAN and set MODEINITFLOAT
      // for subsequent iterations:
      //     ckt->CKTmode = (ckt->CKTmode&(~INITF))|MODEINITFLOAT;
      ctx.cktMode = setInitf(ctx.cktMode, MODEINITFLOAT);
    } else if (curInitf === MODEINITPRED) {
      ctx.cktMode = setInitf(ctx.cktMode, MODEINITFLOAT);
    } else if (curInitf === MODEINITSMSIG) {
      ctx.cktMode = setInitf(ctx.cktMode, MODEINITFLOAT);
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
