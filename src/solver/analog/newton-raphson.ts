/**
 * Newton-Raphson nonlinear iteration loop for MNA circuit simulation.
 *
 * Implements the core NR loop with cktLoad single-pass device loading,
 * voltage limiting (pnjlim for PN junctions, fetlim for MOSFETs), global and
 * element-specific convergence checking, and blame tracking.
 */

import { makeDiagnostic } from "./diagnostics.js";
import type { CKTCircuitContext } from "./ckt-context.js";
import { cktLoad } from "./ckt-load.js";
import {
  isTranOp, isUic, isDcop, initf, setInitf,
  MODEINITFLOAT, MODEINITJCT, MODEINITFIX,
  MODEINITTRAN, MODEINITPRED, MODEINITSMSIG,
} from "./ckt-mode.js";
import { spOKAY, spSINGULAR } from "./sparse-solver.js";
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
 * Matches ngspice DEVpnjlim (devsup.c:50-82) exactly, including the
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
 * Direct JavaScript port of ngspice DEVpnjlim (devsup.c:50-82).
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
  const vtstlo = _computeVtstlo(vold, vto);
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
    solver, elements, nodeCount,
    reltol, abstol, iabstol,
  } = ctx;

  const diagnostics = ctx.diagnostics;

  // ngspice niiter.c:622 — unconditional floor: if (maxIter < 100) maxIter = 100;
  // Bypassed when exactMaxIterations is set (INITJCT/INITFIX need exactly 1 iteration).
  const rawMaxIter = ctx.maxIterations;
  const maxIterations = ctx.exactMaxIterations ? rawMaxIter : Math.max(rawMaxIter, 100);

  ctx.nrResult.reset();
  // Re-alias nrResult.voltages to the current ctx.rhs in case a previous
  // newtonRaphson() call left ctx.rhs pointing at the OTHER buffer (the
  // pointer swap mirrors ngspice niiter.c:1087-1090, see ctx.swapRhsBuffers).
  ctx.nrResult.voltages = ctx.rhs;

  // Pointer-swap model — ctx.rhs and ctx.rhsOld are the live ping-pong
  // pointers, mirroring ngspice's CKTrhs/CKTrhsOld pair on the CKTcircuit
  // struct. Each NR iteration:
  //   - cktLoad reads ctx.rhsOld (= iter K input) and stamps into ctx.rhs.
  //   - solver.solve(ctx.rhs) writes iter K output into ctx.rhs.
  //   - On non-convergence, ctx.swapRhsBuffers() rotates the pointers, so
  //     iter K's output becomes iter K+1's input.
  // On exit, ctx.rhsOld holds the converging iter's input and ctx.rhs holds
  // its output — bit-exactly matching ngspice's NIiter exit invariant
  // regardless of the converging-iter parity.

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

  // nrModeLadder: set initial INITF bit (MODEINITJCT) before iter 0 IF this is
  // a DC-OP ladder entry. For transient NR calls the caller has already set
  // MODEINITTRAN or MODEINITPRED on cktMode; we must not stomp it back to JCT.
  const ladder = ctx.nrModeLadder ?? null;
  if (ladder && isDcop(ctx.cktMode)) {
    ctx.cktMode = setInitf(ctx.cktMode, MODEINITJCT);
  }

  // MODETRANOP && MODEUIC: single CKTload, no iteration (ngspice dctran.c UIC path).
  // ngspice niiter.c:628-637 — pointer swap of CKTrhsOld/CKTrhs, then a single
  // CKTload, then return OK. ngspice dctran.c:117-189 confirms UIC early-exit
  // exists only in DCtran, not DCop. Gate on isTranOp(cktMode) && isUic(cktMode):
  // standalone .OP with UIC=true must NOT take this path — it must run the full
  // CKTop ladder.
  if (isTranOp(ctx.cktMode) && isUic(ctx.cktMode)) {
    ctx.swapRhsBuffers();
    cktLoad(ctx);
    ctx.nrResult.converged = true;
    ctx.nrResult.iterations = 0;
    ctx.nrResult.voltages = ctx.rhs;
    return;
  }

  for (let iteration = 0; ; iteration++) {
    // ---- STEP A: Clear noncon + reset limit collector (ngspice CKTnoncon=0) ----
    ctx.noncon = 0;
    if (ctx.limitingCollector != null) {
      ctx.limitingCollector.length = 0;
    }

    // ---- STEP B: CKTload — single-pass device evaluation ----
    // ctx.rhsOld already holds iter K's input voltages: at iter 0 it is whatever
    // the caller seeded (predictor / DC-OP carryover); at iter K>0 the previous
    // ctx.swapRhsBuffers() rotated iter K-1's solve output into ctx.rhsOld.
    cktLoad(ctx);

    // ---- STEP B+: Pre-factor instrumentation hook (ngspice niiter.c:704-842) ----
    // Mirrors ngspice's `if (ni_instrument_cb)` block sitting between CKTload
    // (niiter.c:667) and SMPpreOrder (niiter.c:844). The unique window where
    // the assembled MNA holds post-load, pre-LU values — solver.preorder() may
    // exchange columns and solver.factor() overwrites _elVal[] with LU. Harness
    // consumers register a hook that calls solver.getCSCNonZeros() here.
    // No-op when null; same optional-chain shape as the postIterationHook
    // gate below.
    ctx.preFactorHook?.(ctx);

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
    // ngspice niiter.c:883-884 — SMPluFac(Matrix, CKTpivotAbsTol, CKTdiagGmin).
    const errorCode = solver.factor(ctx.pivotAbsTol, ctx.diagonalGmin);
    if (errorCode !== spOKAY) {
      // H2 (Phase 2.5 W2.2) — mirror niiter.c:881-902 in full.
      //
      // The else arm of `if (NISHOULDREORDER)` calls SMPluFac (the reuse
      // path) and on `error == E_SINGULAR` sets NISHOULDREORDER and
      // `continue`s. The if arm calls SMPreorder (the full reorder path)
      // and surfaces every error verbatim. digiTS folds the dispatch into
      // factor(); the per-call `lastFactorWalkedReorder` flag tells us
      // which arm ran. The retry gate combines both halves of ngspice's
      // condition — error code AND structural arm — so non-singular reuse
      // failures (spZERO_DIAG, spNO_MEMORY) and any reorder failure
      // surface as a singular-matrix diagnostic instead of looping.
      if (errorCode === spSINGULAR && !solver.lastFactorWalkedReorder) {
        solver.forceReorder();
        continue;
      }
      diagnostics.emit(
        makeDiagnostic("singular-matrix", "error", "Singular matrix during NR iteration", {
          explanation: `The MNA matrix became singular at iteration ${iteration + 1} (sparse error ${errorCode}).`,
          suggestions: [],
        }),
      );
      ctx.nrResult.converged = false;
      ctx.nrResult.iterations = iteration + 1;
      ctx.nrResult.largestChangeElement = -1;
      ctx.nrResult.largestChangeNode = -1;
      ctx.nrResult.voltages = ctx.rhs;
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
    // Solver reads RHS from ctx.rhs and writes the iter K solve output
    // back into ctx.rhs (in-place — spsolve.c:90-91 RHS and Solution may
    // alias). ctx.rhsOld is preserved (still holds iter K's input
    // voltages). Mirrors ngspice niiter.c:927:
    //   SMPsolve(ckt->CKTmatrix, ckt->CKTrhs, ckt->CKTrhsSpare).
    solver.solve(ctx.rhs, ctx.rhs);

    // ---- STEP G: Check iteration limit BEFORE convergence (ngspice niiter.c:944) ----
    // Pre-swap return mirrors niiter.c:944-955 — at exit, ctx.rhsOld = iter K's
    // input, ctx.rhs = iter K's output.
    if (iteration + 1 > maxIterations) {
      ctx.nrResult.converged = false;
      ctx.nrResult.iterations = iteration + 1;
      ctx.nrResult.largestChangeElement = -1;
      ctx.nrResult.largestChangeNode = -1;
      ctx.nrResult.voltages = ctx.rhs;
      return;
    }

    // ---- STEP H: Convergence check (ngspice NIconvTest) ----
    //
    // Mirror niiter.c:957-961 in full:
    //
    //   if (CKTnoncon == 0 && iterno != 1) {
    //       CKTnoncon = NIconvTest(ckt);   // 0 if converged, else 1
    //   } else {
    //       CKTnoncon = 1;                  // ASSIGNMENT, not increment
    //   }
    //
    // The else branch fires for both first-iteration AND device-limited cases.
    // The assignment normalizes any multi-junction limiter increments (BJT,
    // MOSFET, multi-diode) so the INITF dispatcher and the harness only ever
    // read 0 or 1. Devices use `ctx.noncon.value++`, so without this collapse
    // we leak counts > 1 to the harness comparison.
    if (iteration === 0 || ctx.noncon !== 0) {
      // niiter.c:960 — `CKTnoncon = 1` for the entire else branch
      // `(CKTnoncon != 0 || iterno == 1)`. Assignment, not increment, so any
      // multi-junction limiter increments collapse to 1.
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
      for (let i = 0; i < solver.matrixSize; i++) {
        const delta = Math.abs(ctx.rhs[i] - ctx.rhsOld[i]);
        if (delta > largestChangeMag) {
          largestChangeMag = delta;
          largestChangeNode = i;
        }
        const absTol = i < nodeCount ? abstol : iabstol;
        const tol = reltol * Math.max(Math.abs(ctx.rhs[i]), Math.abs(ctx.rhsOld[i])) + absTol;
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

      // niiter.c:957-961 — write the NIconvTest result back into CKTnoncon so
      // the INITF dispatcher (and MODEINITFLOAT return gate) sees a unified
      // convergence indicator. Without this, INITFIX→INITFLOAT transitions
      // fire after a single iteration whenever no device limited, regardless
      // of whether the global convergence test actually passed.
      if (!globalConverged || !elemConverged) {
        ctx.noncon = 1;
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

    // ---- STEP I: Newton damping (ngspice niiter.c:1020-1046) ----
    if (ctx.nodeDamping && ctx.noncon !== 0 && isDcop(ctx.cktMode) && iteration > 0) {
      let maxDelta = 0;
      for (let i = 0; i < nodeCount; i++) {
        const delta = Math.abs(ctx.rhs[i] - ctx.rhsOld[i]);
        if (delta > maxDelta) maxDelta = delta;
      }
      if (maxDelta > 10) {
        const dampFactor = Math.max(10 / maxDelta, 0.1);
        for (let i = 0; i < nodeCount; i++) {
          ctx.rhs[i] = ctx.rhsOld[i] + dampFactor * (ctx.rhs[i] - ctx.rhsOld[i]);
        }
        // niiter.c:1040-1044 — damp CKTstate0[0..numStates) unconditionally
        // inside the maxdiff>10 block. ngspice's loop trivially runs zero
        // iterations when CKTnumStates == 0; digiTS mirrors that by gating
        // only on statePool — when statePool is non-null, oldState0 is
        // always populated above the solve (the prior `&& oldState0` was
        // redundant defensive over-checking).
        if (statePool) {
          const s0 = statePool.state0;
          for (let i = 0; i < s0.length; i++) {
            s0[i] = oldState0![i] + dampFactor * (s0[i] - oldState0![i]);
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
        let elDelta = 0;
        for (const ni of el._pinNodes.values()) {
          if (ni > 0 && ni <= solver.matrixSize) {
            const d = Math.abs(ctx.rhs[ni] - ctx.rhsOld[ni]);
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
    ctx.postIterationHook?.(iteration, ctx.rhs, ctx.rhsOld, ctx.noncon, globalConverged, elemConverged, limitingEvents, convergenceFailedElements, ctx);

    // ---- STEP J: Unified INITF dispatcher (ngspice niiter.c:1050-1085) ----
    // Read current INITF bits from cktMode (single source of truth).
    const curInitf = initf(ctx.cktMode);

    if (curInitf === MODEINITFLOAT) {
      // niiter.c:1051-1057 — DC + nodeset gate. ipass is only ever 0 or 1
      // (sole writer is the MODEINITFIX branch below). When ipass==1 we
      // raise noncon to defer the terminating return by one iteration; the
      // unconditional `ipass = 0` matches ngspice exactly. The outer
      // globalConverged/elemConverged checks are folded into ctx.noncon at
      // the convergence step (lines 545-547), so reading noncon alone
      // mirrors niiter.c:1058 verbatim.
      if (isDcop(ctx.cktMode) && ctx.hadNodeset) {
        if (ipass) {
          ctx.noncon = ipass;
        }
        ipass = 0;
      }
      // niiter.c:1058-1062 — MODEINITFLOAT converged exit. NIiter returns
      // OK without executing the trailing CKTrhsOld/CKTrhs swap. ctx.rhsOld
      // holds the converging-iter input; ctx.rhs holds the converging-iter
      // output.
      if (ctx.noncon === 0) {
        if (ladder) {
          // The terminal-mode label depends on whether this NR call is a
          // DC-OP solve (terminal mode = dcopInitFloat) or a transient
          // solve (terminal mode = tranNR). In a transient call, the
          // dispatcher below has already promoted MODEINITTRAN or
          // MODEINITPRED to MODEINITFLOAT and emitted the corresponding
          // ladder.onModeBegin("tranNR", ...).
          const terminalPhase = isDcop(ctx.cktMode) ? "dcopInitFloat" : "tranNR";
          ladder.onModeEnd(terminalPhase, iteration, true);
        }
        ctx.nrResult.converged = true;
        ctx.nrResult.iterations = iteration + 1;
        ctx.nrResult.largestChangeElement = largestChangeElement;
        ctx.nrResult.largestChangeNode = largestChangeNode;
        ctx.nrResult.voltages = ctx.rhs;
        return;
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
        if (ladder) {
          ladder.onModeEnd("dcopInitFix", iteration, false);
          ladder.onModeBegin("dcopInitFloat", iteration + 1);
        }
      }
      // ngspice niiter.c:1069 sets ipass=1 unconditionally inside the
      // MODEINITFIX branch, regardless of CKTnoncon. Keeping it inside the
      // converged-only block diverged from ngspice on circuits where INITFIX
      // does not converge in a single iteration.
      ipass = 1;
    } else if (curInitf === MODEINITTRAN) {
      // B5 (Phase 2.5 W2.1): the NISHOULDREORDER trigger moved to the top of
      // the loop (before factor), matching ngspice niiter.c:856-859. Here we
      // only mirror niiter.c:1073-1075 — clear MODEINITTRAN and set MODEINITFLOAT
      // for subsequent iterations:
      //     ckt->CKTmode = (ckt->CKTmode&(~INITF))|MODEINITFLOAT;
      ctx.cktMode = setInitf(ctx.cktMode, MODEINITFLOAT);
      if (ladder) {
        ladder.onModeEnd("tranInit", iteration, false);
        ladder.onModeBegin("tranNR", iteration + 1);
      }
    } else if (curInitf === MODEINITPRED) {
      ctx.cktMode = setInitf(ctx.cktMode, MODEINITFLOAT);
      if (ladder) {
        ladder.onModeEnd("tranPredictor", iteration, false);
        ladder.onModeBegin("tranNR", iteration + 1);
      }
    } else if (curInitf === MODEINITSMSIG) {
      ctx.cktMode = setInitf(ctx.cktMode, MODEINITFLOAT);
      // Small-signal AC bias has no transient/DC-OP attempt-grouping equivalent
      // in the harness; no ladder callback fires.
    } else {
      // niiter.c:1077-1085 — unrecognised INITF bit returns E_INTERN. The
      // NR layer is the sole writer of INITF, so this fires only when an
      // upstream caller has corrupted cktMode. Surface it loudly rather
      // than silently falling through to the rhs/rhsOld swap.
      diagnostics.emit(
        makeDiagnostic("internal-error", "error",
          `NR loop saw unrecognised INITF bit 0x${curInitf.toString(16)}`,
          {
            explanation: "INITF must be one of MODEINITFLOAT/JCT/FIX/SMSIG/TRAN/PRED.",
            suggestions: [],
          }),
      );
      ctx.nrResult.converged = false;
      ctx.nrResult.iterations = iteration + 1;
      ctx.nrResult.largestChangeElement = largestChangeElement;
      ctx.nrResult.largestChangeNode = largestChangeNode;
      ctx.nrResult.voltages = ctx.rhs;
      return;
    }

    // Split marker: after iteration 0, let the harness observe cold linearization
    if (onIter0Complete && iteration === 0) {
      onIter0Complete();
    }

    // ---- STEP K: Swap rhs / rhsOld pointers (mirrors niiter.c:1087-1090) ----
    // Rotates iter K's solve output (held in ctx.rhs) into ctx.rhsOld so it
    // becomes iter K+1's input; ctx.rhs becomes the scratch buffer that
    // cktLoad and solver.solve will overwrite next iteration.
    ctx.swapRhsBuffers();
  }

  // Unreachable — the for(;;) loop returns via the iterlim, singular-matrix,
  // and converged exits above. Kept as a defensive fallthrough so the
  // compiler can prove the function returns void.
}
