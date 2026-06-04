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
// LimitingEvent- records a single voltage-limiting call per junction per NR iteration
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
  limitType: "pnjlim" | "fetlim" | "limvds" | "railLim";
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
 * Includes the Gillespie negative-bias branch (devsup.c:67-82)- D4 in
 * spec/architectural-alignment.md. When vnew is not above the forward
 * critical-voltage threshold but is negative, the reverse clamp engages:
 *   vold > 0:  arg = -vold - 1
 *   vold <= 0: arg = 2*vold - 1
 *   if vnew < arg, clamp vnew = arg and flag limited
 *
 * Variable mapping (ngspice â†’ ours):
 *   vnew   â†’ vnew   (proposed new junction voltage)
 *   vold   â†’ vold   (previous junction voltage)
 *   vt     â†’ vt     (thermal voltage, kT/q â‰ˆ 0.02585 V at 300 K)
 *   vcrit  â†’ vcrit  (critical voltage, â‰ˆ0.6 V for silicon)
 *   *icheck â†’ limited (true when ngspice sets *icheck = 1)
 *   log    â†’ Math.log (natural logarithm)
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
 *   Zone 1- Deep ON (vold >= vto + 3.5):
 *     Decreasing: clamp to max(-delta, vtstlo); floor at vto + 2
 *     Increasing: clamp to +vtsthi
 *
 *   Zone 2- Near threshold (vto <= vold < vto + 3.5):
 *     Decreasing: floor at vto - 0.5
 *     Increasing: cap at vto + 4
 *
 *   Zone 3- OFF (vold < vto):
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

/**
 * Result of a limitlog call. `value` is the damped deltemp; `check` mirrors
 * ngspice DEVlimitlog's `*check` output (1 when damping or the NaN guard
 * engaged, else 0).
 */
export interface LimitlogResult {
  value: number;
  check: number;
}

/**
 * Module-level reusable result object for limitlog(). Mutated and returned on
 * every call -- callers MUST extract .value and .check before the next
 * limitlog() call, as the object is shared. Single-threaded, safe.
 */
const _limitlogResult: LimitlogResult = { value: 0, check: 0 };

/**
 * Module-level one-shot latch for the NaN warning. Mirrors the C
 * `static bool shown` in DEVlimitlog: persists across calls so the warning
 * prints at most once per process.
 */
let _limitlogShown = false;

/**
 * Logarithmic temperature-step limiter (limitlog).
 *
 * Logarithmically damps the per-iteration change of deltemp once it moves
 * beyond limTol from deltempOld, and guards against a NaN deltemp by zeroing
 * it and warning once.
 *
 * cite: devsup.c:153-184 (DEVlimitlog). deltemp/deltempOld are this and the
 * previous iteration's temperature delta; limTol is the per-step bound; the
 * `*check` output is the `check` field here.
 */
export function limitlog(
  deltemp: number,
  deltempOld: number,
  limTol: number,
): LimitlogResult {
  let check = 0;
  if (!_limitlogShown && (Number.isNaN(deltemp) || Number.isNaN(deltempOld))) {
    console.error("\n\nThe temperature limiting function received NaN.\n");
    console.error("Please check your power dissipation and improve your heat sink Rth!\n");
    console.error("    This message will be shown only once.\n\n");
    deltemp = 0.0;
    check = 1;
    _limitlogShown = true;
  }
  /* Logarithmic damping of deltemp beyond limTol */
  if (deltemp > deltempOld + limTol) {
    deltemp = deltempOld + limTol + Math.log10((deltemp - deltempOld) / limTol);
    check = 1;
  } else if (deltemp < deltempOld - limTol) {
    deltemp = deltempOld - limTol - Math.log10((deltempOld - deltemp) / limTol);
    check = 1;
  }
  _limitlogResult.value = deltemp;
  _limitlogResult.check = check;
  return _limitlogResult;
}

export interface RailLimResult { value: number; limited: boolean; }

const _railLimResult: RailLimResult = { value: 0, limited: false };

/**
 * Voltage limiter for behavioral amplifier output rails. NOT a
 * literal port of any single ngspice device-support function- there
 * is no rail-clamp device in the ngspice tree. Shaped using the
 * algorithmic discipline of DEVpnjlim
 * (ref/ngspice/src/spicelib/devices/devsup.c:49-84) and DEVlimvds
 * (ref/ngspice/src/spicelib/devices/devsup.c:20-40): detect overshoot
 * direction, damp by midpoint between vold and the rail, return
 * limited so caller can ctx.noncon.value++ and push a LimitingEvent.
 */
export function railLim(
  vnew: number,
  vold: number,
  vRailPos: number,
  vRailNeg: number,
): RailLimResult {
  let limited = false;
  if (vnew > vRailPos && vold < vRailPos) {
    vnew = (vRailPos + vold) / 2;
    limited = true;
  } else if (vnew < vRailNeg && vold > vRailNeg) {
    vnew = (vRailNeg + vold) / 2;
    limited = true;
  }
  _railLimResult.value = vnew;
  _railLimResult.limited = limited;
  return _railLimResult;
}

// ---------------------------------------------------------------------------
// devCapVdmos  LTspice VDMOS nonlinear gate capacitances (devsup.c:653-665)
// ---------------------------------------------------------------------------

/**
 * Evaluate the LTspice VDMOS nonlinear gate capacitances. Sibling of devQmeyer
 * (mosfet.ts) and the limiters above. Returns HALF the gate-source/gate-drain
 * capacitances; the caller doubles (MODETRANOP / MODEINITSMSIG) or adds the
 * previous-step half (normal MODETRAN), exactly as DevCapVDMOS's callers do.
 *
 * cite: devsup.c:653-665 — DevCapVDMOS. Operand order and the tanh/atan branch
 * (vgd > 0) are line-for-line v41:
 *   s = (cgdmax - cgdmin) / (1 + M_PI / 2);
 *   y = cgdmax - s;
 *   if (vgd > 0) *capgd = 0.5 * (s * tanh(a * vgd) + y);
 *   else         *capgd = 0.5 * (s * atan(a * vgd) + y);
 *   *capgs = 0.5 * cgs;
 */
export function devCapVdmos(
  vgd: number, cgdmin: number, cgdmax: number, a: number, cgs: number,
): { capgs: number; capgd: number } {
  const s = (cgdmax - cgdmin) / (1 + Math.PI / 2);
  const y = cgdmax - s;
  const capgd = vgd > 0
    ? 0.5 * (s * Math.tanh(a * vgd) + y)
    : 0.5 * (s * Math.atan(a * vgd) + y);
  const capgs = 0.5 * cgs;
  return { capgs, capgd };
}

// ---------------------------------------------------------------------------
// niConvTest- node-level convergence test (rebuild of ngspice NIconvTest)
// ---------------------------------------------------------------------------

/**
 * Node-level convergence test, mirroring ngspice NIconvTest (niconv.c:20-83).
 *
 * Walks every solved row; the first NaN solution row (niconv.c:43-47) or the
 * first row whose |new-old| exceeds reltol*max(|old|,|new|)+absTol
 * (niconv.c:51,63) is non-convergence, recorded as the trouble node with the
 * trouble element cleared (niconv.c:56-57,68-69). Returns 1 (non-converged) or
 * 0 (converged).
 *
 * ngspice → digiTS map:
 *   ckt                       → ctx
 *   size = SMPmatSize(...)    → ctx.solver.matrixSize
 *   node->type == SP_VOLTAGE  → ctx.nodeType(i) === "voltage" (cktload.c:178
 *                               reads n->type; branch/current rows are
 *                               nodeType "current" and use CKTabstol)
 *   CKTrhs[i] / CKTrhsOld[i]  → ctx.rhs[i] / ctx.rhsOld[i]
 *   CKTreltol                 → ctx.reltol
 *   CKTvoltTol                → ctx.voltTol
 *   CKTabstol                 → ctx.iabstol
 *   CKTtroubleNode = i        → ctx.troubleNode = i
 *   CKTtroubleElt  = NULL     → ctx.troubleElt = null
 *
 * Row indexing: tests rows i = 1 .. size inclusive (size = ctx.solver.matrixSize),
 * mirroring niconv.c:39 `for (i=1;i<=size;i++)`. Row 0 is the ground equation
 * (ctx.rhs[0] held at 0) and is not tested; the loop runs through the highest
 * row — the last branch/current equation (e.g. a voltage-source branch).
 */
function niConvTest(ctx: CKTCircuitContext): number {
  const { rhs, rhsOld, reltol, voltTol, iabstol } = ctx;
  const size = ctx.solver.matrixSize;
  for (let i = 1; i <= size; i++) {
    const newV = rhs[i];
    const oldV = rhsOld[i];
    // niconv.c:43-47 — a NaN solution row is non-convergence; the tol test below
    // cannot catch it (NaN > tol is false).
    if (Number.isNaN(newV)) {
      return 1;
    }
    // niconv.c:48-50,60-62 — SP_VOLTAGE rows use CKTvoltTol; branch rows use
    // CKTabstol.
    const tol = ctx.nodeType(i) === "voltage"
      ? reltol * Math.max(Math.abs(oldV), Math.abs(newV)) + voltTol
      : reltol * Math.max(Math.abs(oldV), Math.abs(newV)) + iabstol;
    // niconv.c:51,56-57,63,68-69 — the first row over tolerance blames the node
    // and clears the element.
    if (Math.abs(newV - oldV) > tol) {
      ctx.troubleNode = i;
      ctx.troubleElt = null;
      return 1;
    }
  }
  // niconv.c:80-82 — NEWCONV is off in the default build; no extra CKTconvTest
  // pass, so the function returns 0 (converged) after the row loop.
  return 0;
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
  } = ctx;

  const diagnostics = ctx.diagnostics;

  // ngspice niiter.c:622- unconditional floor: if (maxIter < 100) maxIter = 100;
  // Bypassed when exactMaxIterations is set (INITJCT/INITFIX need exactly 1 iteration).
  const rawMaxIter = ctx.maxIterations;
  const maxIterations = ctx.exactMaxIterations ? rawMaxIter : Math.max(rawMaxIter, 100);

  ctx.nrResult.reset();
  // Re-alias nrResult.voltages to the current ctx.rhs in case a previous
  // newtonRaphson() call left ctx.rhs pointing at the OTHER buffer (the
  // pointer swap mirrors ngspice niiter.c:1087-1090, see ctx.swapRhsBuffers).
  ctx.nrResult.voltages = ctx.rhs;

  // Pointer-swap model- ctx.rhs and ctx.rhsOld are the live ping-pong
  // pointers, mirroring ngspice's CKTrhs/CKTrhsOld pair on the CKTcircuit
  // struct. Each NR iteration:
  //   - cktLoad reads ctx.rhsOld (= iter K input) and stamps into ctx.rhs.
  //   - solver.solve(ctx.rhs) writes iter K output into ctx.rhs.
  //   - On non-convergence, ctx.swapRhsBuffers() rotates the pointers, so
  //     iter K's output becomes iter K+1's input.
  // On exit, ctx.rhsOld holds the converging iter's input and ctx.rhs holds
  // its output- bit-exactly matching ngspice's NIiter exit invariant
  // regardless of the converging-iter parity.

  const statePool = ctx.statePool ?? null;
  let oldState0: Float64Array | null = null;
  let ipass = 0;

  // ngspice CKTniState NISHOULDREORDER bit (cktdefs.h:144). This is NI-layer
  // state, not matrix state: niiter.c:1093-1142 routes each factor to SMPreorder
  // (solver.orderAndFactor) when the bit is set and SMPluFac (solver.factor)
  // otherwise, clearing it at the dispatch (niiter.c:1119). Set on
  // MODEINITJCT/MODEINITTRAN (niiter.c:1087-1091), the MODEINITJCT→FIX
  // transition, and the E_SINGULAR retry (niiter.c:1128). Whether the chosen
  // routine actually re-derives the pivot order is a separate matrix concern
  // (SparseSolver._needsReorder / NeedsOrdering).
  let shouldReorder = false;

  // Step D state: preorder runs at most once per CKT lifetime. ngspice
  // NIDIDPREORDER (cktdefs.h:143) is a CKT-state bit cleared only by
  // NIreinit (nireinit.c:42); our equivalent is solver._didPreorder, set
  // inside solver.preorder() and cleared by solver.invalidateTopology().
  // A per-NR-call local flag would be per-invocation scope- the wrong
  // scope- so we drop it entirely and rely on solver.preorder() being
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
  // ngspice niiter.c:628-637- pointer swap of CKTrhsOld/CKTrhs, then a single
  // CKTload, then return OK. ngspice dctran.c:117-189 confirms UIC early-exit
  // exists only in DCtran, not DCop. Gate on isTranOp(cktMode) && isUic(cktMode):
  // standalone .OP with UIC=true must NOT take this path- it must run the full
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

    // ---- STEP B: CKTload- single-pass device evaluation (niiter.c:891-896) ----
    // niiter.c:891-896 wraps the load/factor/solve body in `#ifdef NEWPRED if
    // (!(CKTmode & MODEINITPRED))`. The default ngspice build does NOT define
    // NEWPRED, so the guard is compiled out and the body runs unconditionally
    // every iteration. digiTS tracks the default (NEWPRED-off) build: the load
    // runs every iteration with no MODEINITPRED predictor-skip guard.
    // ctx.rhsOld already holds iter K's input voltages: at iter 0 it is whatever
    // the caller seeded (predictor / DC-OP carryover); at iter K>0 the previous
    // ctx.swapRhsBuffers() rotated iter K-1's solve output into ctx.rhsOld.
    cktLoad(ctx);

    // ---- STEP B+: Pre-factor instrumentation hook (ngspice niiter.c:704-842) ----
    // Mirrors ngspice's `if (ni_instrument_cb)` block sitting between CKTload
    // (niiter.c:667) and SMPpreOrder (niiter.c:844). The unique window where
    // the assembled MNA holds post-load, pre-LU values- solver.preorder() may
    // exchange columns and solver.factor() overwrites _elVal[] with LU. Harness
    // consumers register a hook that reads the assembled matrix via the
    // solver's instrumentation wrapper (createInstrumentation().getCSCNonZeros())
    // here.
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
    // Set the NISHOULDREORDER routing bit so STEP E dispatches this factor to
    // solver.orderAndFactor() (ngspice SMPreorder). That routine re-derives the
    // pivot order only when NeedsOrdering is set; at MODEINITTRAN NeedsOrdering
    // is already NO from the operating-point factor, so the first transient
    // factor re-factors against the existing order via the reuse loop
    // (spfactor.c:223) instead of re-deriving it- the operating-point ordering
    // carries into the transient, matching ngspice.
    const curInitfNow = initf(ctx.cktMode);
    if (curInitfNow === MODEINITJCT ||
        (curInitfNow === MODEINITTRAN && iteration === 0)) {
      shouldReorder = true;
    }

    // ---- STEP E: Factorize (gmin stamped atomically inside factor()) ----
    // B3 (Phase 2.5 W2.1): ngspice SMPluFac/SMPreorder call LoadGmin
    // internally, immediately before spFactor/spOrderAndFactor (spsmp.c:173,
    // 197). The gmin stamp lives inside factor(); there is no external
    // addDiagonalGmin API- the stamp + factor pair is atomic, matching
    // ngspice's invariant that no caller observes a post-gmin, pre-factor
    // matrix.
    //
    // H2 (Phase 2.5 W2.2)- NR owns the diagonal-Gmin decision points
    // mirroring niiter.c::NIiter:
    //   (a) NISHOULDREORDER routing- niiter.c:856-859 sets the bit on
    //       INITJCT/INITTRAN; STEP E then dispatches to orderAndFactor().
    //   (b) diagGmin forwarded every factor call- niiter.c:863-864 and
    //       :883-884 pass ckt->CKTdiagGmin into SMPreorder/SMPluFac every
    //       iteration. Our factor(ctx.diagonalGmin) below mirrors that.
    //   (c) E_SINGULAR retry loop- niiter.c:888-891 sets NISHOULDREORDER
    //       and `continue`s; we mirror with `shouldReorder = true` + continue
    //       below.
    // The gmin-stepping ladder (setting ctx.diagonalGmin across multiple
    // NR invocations) lives in dc-operating-point.ts::dynamicGmin /
    // spice3Gmin / gillespieSrc, matching ngspice's cktop.c::dynamicgmin
    // / spice3gmin / gillespie_src. NR owns per-iteration decisions; the
    // DC-OP ladder owns cross-solve gmin ramping. No stand-alone
    // addDiagonalGmin API exists.
    //
    // ngspice niiter.c:863-864, 883-884- CKTpivotAbsTol/CKTpivotRelTol are
    // forwarded into SMPreorder/SMPluFac every iteration. setPivotTolerances
    // is a cheap scalar store; doing it here (not just once at ctx
    // construction) matches ngspice's per-call semantic and lets hot-loaded
    // params propagate without an engine rebuild.
    solver.setPivotTolerances(ctx.pivotRelTol, ctx.pivotAbsTol);
    // ngspice niiter.c:1093-1142 dispatch- when NISHOULDREORDER is set, call
    // SMPreorder (orderAndFactor) and clear the bit (niiter.c:1119); otherwise
    // call SMPluFac (factor). Both forward CKTpivotAbsTol / CKTdiagGmin
    // (niiter.c:863-864, 883-884).
    let errorCode: number;
    if (shouldReorder) {
      shouldReorder = false;
      errorCode = solver.orderAndFactor(ctx.pivotAbsTol, ctx.diagonalGmin);
    } else {
      errorCode = solver.factor(ctx.pivotAbsTol, ctx.diagonalGmin);
    }
    if (errorCode !== spOKAY) {
      // H2 (Phase 2.5 W2.2)- mirror niiter.c:881-902 in full.
      //
      // The else arm of `if (NISHOULDREORDER)` ran SMPluFac (factor, the reuse
      // path); on `error == E_SINGULAR` ngspice sets NISHOULDREORDER and
      // `continue`s so the next pass takes SMPreorder (orderAndFactor). The if
      // arm (orderAndFactor) surfaces every error verbatim. The per-call
      // `lastFactorWalkedReorder` flag tells us which arm just ran. The retry
      // gate combines both halves of ngspice's condition- error code AND
      // structural arm- so non-singular reuse failures (spZERO_DIAG,
      // spNO_MEMORY) and any reorder failure surface as a singular-matrix
      // diagnostic instead of looping.
      // niiter.c:888-891: on E_SINGULAR in the reuse (SMPluFac) arm, set
      // NISHOULDREORDER and continue to retry through orderAndFactor.
      if (errorCode === spSINGULAR && !solver.lastFactorWalkedReorder) {
        shouldReorder = true;
        continue;
      }
      // niiter.c:1104-1111 — emit at most six singular-matrix warnings per
      // analysis: `if (ft_ngdebug || msgcount < 6) { … msgcount += 1; }`.
      // ft_ngdebug is the ngspice frontend verbose-debug global; digiTS has no
      // `set ngdebug` control, so the `ft_ngdebug ||` short-circuit is NO-
      // COUNTERPART and only the `msgcount < 6` half is mirrored. The counter is
      // reset per analysis by ctx.resetWarnMsg() (niiter.c:1341-1343).
      if (ctx.msgcount < 6) {
        diagnostics.emit(
          makeDiagnostic("singular-matrix", "error", "Singular matrix during NR iteration", {
            explanation: `The MNA matrix became singular at iteration ${iteration + 1} (sparse error ${errorCode}).`,
            suggestions: [],
          }),
        );
        ctx.msgcount += 1;
      }
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
    // back into ctx.rhs (in-place- spsolve.c:90-91 RHS and Solution may
    // alias). ctx.rhsOld is preserved (still holds iter K's input
    // voltages). Mirrors ngspice niiter.c:927:
    //   SMPsolve(ckt->CKTmatrix, ckt->CKTrhs, ckt->CKTrhsSpare).
    solver.solve(ctx.rhs, ctx.rhs);

    // niiter.c:946-948 - clear the ground sentinel slots after every
    // solve. ngspice device load() writes to CKTrhs[0] unconditionally
    // (no ground guard), and spsolve never consumes RHS[0]; the post-
    // solve clear restores the rhs[0]==0 invariant for any downstream
    // consumer (getPinCurrents, NIconvTest, diagnostic readouts).
    ctx.rhs[0] = 0;
    ctx.rhsOld[0] = 0;
    ctx.rhsSpare[0] = 0;

    // ---- STEP G: Check iteration limit BEFORE convergence (ngspice niiter.c:944) ----
    // Pre-swap return mirrors niiter.c:944-955- at exit, ctx.rhsOld = iter K's
    // input, ctx.rhs = iter K's output.
    if (iteration + 1 > maxIterations) {
      ctx.nrResult.converged = false;
      ctx.nrResult.iterations = iteration + 1;
      ctx.nrResult.largestChangeElement = -1;
      ctx.nrResult.largestChangeNode = -1;
      ctx.nrResult.voltages = ctx.rhs;
      return;
    }

    // ---- STEP H: Convergence test (niiter.c:1202-1205) ----
    //
    // Device-level convergence (the DIOconvTest/BJTconvTest counterpart) runs
    // FIRST. In ngspice each device's convTest runs inside CKTload and bumps
    // CKTnoncon + sets CKTtroubleElt (dioconv.c:55-62), so by the time NIiter
    // reads CKTnoncon at niiter.c:1202 the device-side flags are already folded
    // in. digiTS runs el.checkConvergence here, before the node-level niConvTest,
    // so the `ctx.noncon === 0` guard at the niConvTest call means "no device
    // flagged itself", matching niiter.c:1202.
    //
    // The convergenceFailedElements collector is reset every iteration; in
    // detailedConvergence mode it collects every failing element label
    // (harness blame surface), and in non-detailed mode it short-circuits on
    // the first failing device.
    const convergenceFailedElements = ctx.convergenceFailures;
    convergenceFailedElements.length = 0;
    let elemConverged = true;
    // Device-level convTest runs EVERY iteration, mirroring ngspice's per-device
    // convTest embedded in CKTload (dioconv.c:55-62), which is not gated on
    // iterno. Only the node-level NIconvTest below carries the iterno!=1 guard
    // (niiter.c:1202). Gating this sweep on the iteration would suppress the
    // device blame list (CKTtroubleElt / the devConvFailed counterpart) on the
    // first iteration, where ngspice already reports it.
    for (let k = 0; k < ctx.elementsWithConvergence.length; k++) {
      const el = ctx.elementsWithConvergence[k];
      if (!el.checkConvergence!(ctx.loadCtx)) {
        ctx.noncon = 1;
        elemConverged = false;
        ctx.troubleElt = el;                         // dioconv.c:61 — CKTtroubleElt = here
        if (ctx.detailedConvergence) {
          convergenceFailedElements.push(el.label ?? `element_${elements.indexOf(el)}`);
        } else {
          break;                                     // first blamed device is enough
        }
      }
    }

    // niiter.c:1202-1205 —
    //   if ((CKTnoncon == 0) && (iterno != 1)) CKTnoncon = NIconvTest(ckt);
    //   else CKTnoncon = 1;
    // iterno is 1-based and pre-incremented in ngspice; our `iteration` is
    // 0-based, so ngspice's `iterno != 1` is our `iteration > 0`. The else
    // branch (CKTnoncon != 0 || first iteration) collapses any multi-junction
    // limiter increments to a single 1, so the INITF dispatcher and the harness
    // read only 0 or 1.
    if (ctx.noncon === 0 && iteration > 0) {
      ctx.noncon = niConvTest(ctx);
    } else {
      ctx.noncon = 1;
    }
    // globalConverged reported to the harness hook mirrors the node-level
    // niConvTest verdict folded with the device sweep: ctx.noncon is now the
    // single convergence indicator (= CKTnoncon), so a converged iteration has
    // ctx.noncon === 0.
    const globalConverged = ctx.noncon === 0;
    // ngspice's NI capture exposes a single converged flag = (CKTnoncon==0 &&
    // iterno!=1) (niiter.c:1231); the bridge copies it into both globalConverged
    // and elemConverged. Mirror that for the reported flag so the harness
    // compares like with like — the device-level blame survives in
    // convergenceFailedElements, matched against ngspice's devConvFailed list.
    elemConverged = globalConverged;

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
        // niiter.c:1040-1044- damp CKTstate0[0..numStates) unconditionally
        // inside the maxdiff>10 block. ngspice's loop trivially runs zero
        // iterations when CKTnumStates == 0; digiTS mirrors that by gating
        // only on statePool- when statePool is non-null, oldState0 is
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

    // Blame tracking. niConvTest early-returns and so cannot compute a
    // full-vector node argmax; the node argmax joins the element argmax here,
    // gated on ctx.enableBlameTracking. When blame tracking is off,
    // largestChangeNode falls back to the row niConvTest blamed
    // (ctx.troubleNode, the CKTtroubleNode counterpart), which is strictly more
    // faithful to ngspice than a full-vector argmax.
    let largestChangeElement = -1;
    let largestChangeNode = ctx.troubleNode ?? -1;
    if (ctx.enableBlameTracking) {
      let largestElemDelta = -1;
      let largestNodeMag = 0;
      largestChangeNode = 0;
      for (let i = 0; i < solver.matrixSize; i++) {
        const d = Math.abs(ctx.rhs[i] - ctx.rhsOld[i]);
        if (d > largestNodeMag) {
          largestNodeMag = d;
          largestChangeNode = i;
        }
      }
      for (let ei = 0; ei < elements.length; ei++) {
        const el = elements[ei];
        let elDelta = 0;
        for (const ni of el.pinNodes.values()) {
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
      // niiter.c:1051-1057- DC + nodeset gate. ipass is only ever 0 or 1
      // (sole writer is the MODEINITFIX branch below). When ipass==1 we
      // raise noncon to defer the terminating return by one iteration; the
      // unconditional `ipass = 0` matches ngspice exactly. STEP H has already
      // folded the device sweep and the node-level niConvTest into ctx.noncon
      // (the single CKTnoncon indicator), so reading ctx.noncon alone here
      // mirrors niiter.c:1058 verbatim.
      if (isDcop(ctx.cktMode) && ctx.hadNodeset) {
        if (ipass) {
          ctx.noncon = ipass;
        }
        ipass = 0;
      }
      // niiter.c:1058-1062- MODEINITFLOAT converged exit. NIiter returns
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
      shouldReorder = true;
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
      // only mirror niiter.c:1073-1075- clear MODEINITTRAN and set MODEINITFLOAT
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
      // niiter.c:1077-1085- unrecognised INITF bit returns E_INTERN. The
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

  // Unreachable- the for(;;) loop returns via the iterlim, singular-matrix,
  // and converged exits above. Kept as a defensive fallthrough so the
  // compiler can prove the function returns void.
}
