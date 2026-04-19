/**
 * Adaptive timestep controller for the MNA transient solver.
 *
 * Implements local truncation error (LTE) based timestep control with:
 *  - Safety factor 0.9 applied to all computed dt predictions
 *  - Clamping to [dt/4, 4*dt] per step, then to [minTimeStep, maxTimeStep]
 *  - Breakpoint support for exact landing at registered simulation times
 */

import type { AnalogElement, IntegrationMethod } from "./element.js";
import type { ResolvedSimulationParams } from "../../core/analog-engine-interface.js";
import type { HistoryStore } from "./integration.js";
import type { LteParams } from "./ckt-terr.js";

// ---------------------------------------------------------------------------
// almostEqualUlps — module-level singleton buffer (allocation-free after init)
// ngspice reference: dctran.c:553-554 AlmostEqualUlps(time, bkpt, 100)
// ---------------------------------------------------------------------------

const _ulpBuf = new ArrayBuffer(8);
const _ulpF64 = new Float64Array(_ulpBuf);
const _ulpI64 = new BigInt64Array(_ulpBuf);

/**
 * Returns true when a and b are within maxUlps IEEE-754 ULPs of each other.
 * Uses a module-level singleton ArrayBuffer — allocation-free after module load.
 * Matches ngspice dctran.c:553-554 AlmostEqualUlps(time, bkpt, 100).
 */
function almostEqualUlps(a: number, b: number, maxUlps: number): boolean {
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  if (Math.sign(a) !== Math.sign(b) && a !== 0 && b !== 0) return a === b;
  _ulpF64[0] = a; const ai = _ulpI64[0];
  _ulpF64[0] = b; const bi = _ulpI64[0];
  const diff = ai > bi ? ai - bi : bi - ai;
  return diff <= BigInt(maxUlps);
}

// ---------------------------------------------------------------------------
// BreakpointEntry — file-private
// ---------------------------------------------------------------------------

interface BreakpointEntry {
  /** Absolute simulation time in seconds. */
  time: number;
  /**
   * Element that produced this breakpoint, or null for external one-shots
   * registered via the public addBreakpoint(time) API. On pop, if source
   * is non-null and implements nextBreakpoint, the controller refills the
   * queue with the element's next edge.
   */
  source: AnalogElement | null;
}

// ---------------------------------------------------------------------------
// TimestepController
// ---------------------------------------------------------------------------

/**
 * Controls adaptive timestepping for the MNA transient solver.
 *
 * Call sequence per accepted timestep:
 *   1. computeNewDt(elements, history) → { newDt, worstRatio }
 *   2. shouldReject(worstRatio) — rejects when worstRatio > 1
 *   3. If accepted: accept(simTime)
 */
export class TimestepController {
  /** Current timestep in seconds. */
  currentDt: number;

  /** Current integration method. */
  currentMethod: IntegrationMethod;

  private _params: ResolvedSimulationParams;

  /** Sorted ascending list of registered breakpoint entries. */
  private _breakpoints: BreakpointEntry[];

  /** Simulation time of the last accepted step. Used for accept() invariant check. */
  private _lastAcceptedSimTime: number;

  /** Total accepted step count — drives the startup state machine. */
  private _acceptedSteps: number;

  /** Backing field for largestErrorElement. */
  private _largestErrorElement: number | undefined;

  /**
   * Minimum timestep used for breakpoint proximity detection.
   * ngspice: CKTminStep = CKTfinalTime / 1e11 (set at transient init).
   * When tStop is unavailable, falls back to minTimeStep.
   */
  private _delmin: number = 0;

  /**
   * Unclamped dt saved before breakpoint clamping in getClampedDt().
   * Used by accept() to compute post-breakpoint delta reduction
   * (ngspice dctran.c:506 saveDelta).
   */
  private _savedDelta: number = 0;

  /**
   * CKTbreak flag: true when getClampedDt() clamped dt to a breakpoint.
   * ngspice: CKTbreak. Devices can read this via the breakFlag getter.
   */
  private _breakFlag: boolean = false;

  /**
   * True until getClampedDt() is called for the first time.
   * Used to apply ngspice's t=0 breakpoint proximity clamp and firsttime /= 10
   * (dctran.c:572-573, 580) before the very first transient step.
   */
  private _isFirstGetClampedDt: boolean = true;

  /**
   * Timestep history for CKTterr divided differences.
   * [0] = current trial dt (set by setDeltaOldCurrent), [1] = h_{n-1} (previous accepted dt), [2] = h_{n-2}, [3] = h_{n-3}.
   * Pre-allocated once; shifted in rotateDeltaOld(). ngspice: CKTdeltaOld[].
   *
   * UNIFIED STORAGE — when the controller is wired into a CKTCircuitContext
   * (via the optional `sharedDeltaOld` ctor argument), this field holds the
   * SAME `number[]` reference as `ctx.deltaOld`. Matches ngspice where
   * CKTdeltaOld[7] lives on CKTcircuit, not on a separate timestep struct.
   * Standalone TimestepController instances (unit tests, pre-init
   * defaults) allocate their own length-7 array.
   */
  private _deltaOld: number[];

  /**
   * Integration order derived from currentMethod.
   * 1 for bdf1, 2 for trapezoidal and bdf2. ngspice: CKTorder.
   *
   * Initialized to 1 to match ngspice dctran.c:315 (`ckt->CKTorder = 1;` at
   * transient entry). Order is promoted to 2 only after the first order-1
   * LTE gate passes — see tryOrderPromotion() and the firsttime branch at
   * dctran.c:849-872 that skips CKTtrunc on step 0.
   */
  currentOrder: number = 1;

  /**
   * Shift the deltaOld history ring. Called by the engine BEFORE the for(;;)
   * retry loop (ngspice dctran.c:704-706).
   */
  rotateDeltaOld(): void {
    // ngspice dctran.c:715-717: shift all 7 slots
    for (let i = 5; i >= 0; i--) {
      this._deltaOld[i + 1] = this._deltaOld[i];
    }
    this._deltaOld[0] = this.currentDt;
  }

  /**
   * Update deltaOld[0] to the current trial delta without shifting history.
   * Called at the top of each for(;;) iteration (ngspice dctran.c:735).
   */
  setDeltaOldCurrent(dt: number): void {
    this._deltaOld[0] = dt;
  }

  /**
   * Pre-allocated LteParams object passed to element getLteTimestep calls.
   * Updated once per computeNewDt from SimulationParams.
   */
  private _lteParams: LteParams;

  /**
   * Pre-allocated result object for computeNewDt to avoid per-call allocation.
   * Callers destructure immediately so aliasing is safe.
   */
  private _lteResult = { newDt: 0, worstRatio: 0 };

  constructor(params: ResolvedSimulationParams, sharedDeltaOld?: number[]) {
    this._params = params;
    // Unified CKTdeltaOld storage: reference the context's buffer when one is
    // provided (MNAEngine.init path), else self-allocate for standalone usage
    // (unit tests, pre-init field defaults). Length MUST be 7 — matches
    // ngspice CKTdeltaOld[7] (cktdefs.h).
    if (sharedDeltaOld !== undefined) {
      if (sharedDeltaOld.length !== 7) {
        throw new Error(
          `TimestepController: sharedDeltaOld must have length 7 ` +
          `(matches ngspice CKTdeltaOld[7]), got ${sharedDeltaOld.length}.`,
        );
      }
      this._deltaOld = sharedDeltaOld;
    } else {
      this._deltaOld = [0, 0, 0, 0, 0, 0, 0];
    }
    // Use the explicit firstStep parameter. Clamp to [minTimeStep, maxTimeStep].
    this.currentDt = Math.max(
      params.minTimeStep,
      Math.min(params.maxTimeStep, params.firstStep),
    );
    // ngspice default CKTintegrateMethod = TRAPEZOIDAL (set in
    // ref/ngspice/src/spicelib/analysis/cktsetup.c — paired with
    // dctran.c:315 `ckt->CKTorder = 1` so the first step runs BDF-1
    // semantics via the order-1 coefficients even though the configured
    // method is trapezoidal).
    this.currentMethod = "trapezoidal";
    this._breakpoints = [];
    this._lastAcceptedSimTime = -Infinity;
    this._acceptedSteps = 0;
    this._largestErrorElement = undefined;
    this._lteParams = {
      trtol: params.trtol,
      reltol: params.reltol,
      // ngspice CKTterr uses CKTabstol (current tolerance, 1e-12), not
      // CKTvoltTol (voltage tolerance, 1e-6). The LTE operates on charge
      // and companion-model currents, so the current tolerance applies.
      abstol: params.abstol,
      chgtol: params.chargeTol,
    };

    // ngspice dctran.c:316-317: CKTdeltaOld[i] = CKTmaxStep for all 7 slots
    for (let i = 0; i < 7; i++) {
      this._deltaOld[i] = params.maxTimeStep;
    }

    // dctran.c:323: CKTsaveDelta = CKTfinalTime / 50.
    // When tStop is available (harness/batch), derive saveDelta. Otherwise
    // fall back to maxTimeStep (closest streaming-mode analogue).
    this._savedDelta = params.tStop != null
      ? params.tStop / 50
      : params.maxTimeStep;

    // ngspice CKTminStep = CKTfinalTime / 1e11 (set at transient init, dctran.c).
    // Used for breakpoint proximity detection in accept().
    this._delmin = params.tStop != null
      ? params.tStop * 1e-11
      : params.minTimeStep;
  }

  /**
   * Non-destructive in-place update of parameter-derived fields.
   *
   * Used by MNAEngine.configure() to hot-load a new tolerance / maxTimeStep
   * without rebuilding the controller, so `currentDt`, `_acceptedSteps`,
   * `_deltaOld`, `currentOrder`, `currentMethod`, `_stepCount`, and the
   * breakpoint queue are all preserved across the call.
   *
   * Only fields that originate from `params` are refreshed:
   *   - maxTimeStep / minTimeStep / _delmin (derived from tStop when set)
   *   - _lteParams (trtol, reltol, abstol, chgtol) — cast past readonly
   *     because the struct is logically immutable per computeNewDt call but
   *     we deliberately refresh it once on configure().
   *   - currentDt is clamped down to the new maxTimeStep only if it exceeds
   *     it (never raised). firstStep is NOT re-applied.
   */
  updateParams(params: ResolvedSimulationParams): void {
    this._params = params;

    // LTE params — readonly at the interface level; this is the one legal
    // refresh point, mirroring the constructor's _lteParams allocation.
    const lte = this._lteParams as {
      trtol: number;
      reltol: number;
      abstol: number;
      chgtol: number;
    };
    lte.trtol = params.trtol;
    lte.reltol = params.reltol;
    lte.abstol = params.abstol;
    lte.chgtol = params.chargeTol;

    // Re-derive _delmin from tStop like the constructor does.
    this._delmin = params.tStop != null
      ? params.tStop * 1e-11
      : params.minTimeStep;

    // Clamp currentDt down to the new ceiling; never raise it.
    if (this.currentDt > params.maxTimeStep) {
      this.currentDt = params.maxTimeStep;
    }
  }

  /**
   * Index of the reactive element with the largest LTE in the last
   * `computeNewDt` call. `undefined` when no reactive elements are present.
   */
  get largestErrorElement(): number | undefined {
    return this._largestErrorElement;
  }

  /** Timestep history for CKTterr. Read-only reference to the pre-allocated array. */
  get deltaOld(): readonly number[] {
    return this._deltaOld;
  }

  /** CKTbreak: true when the last getClampedDt() call clamped to a breakpoint. */
  get breakFlag(): boolean {
    return this._breakFlag;
  }

  /** Pre-allocated LteParams for element getLteTimestep calls. */
  get lteParams(): LteParams {
    return this._lteParams;
  }

  // -------------------------------------------------------------------------
  // LTE-based timestep computation
  // -------------------------------------------------------------------------

  /**
   * Compute the proposed next timestep based on local truncation error estimates.
   *
   * Iterates all reactive elements that implement `getLteTimestep`, takes the
   * maximum truncation error, and derives the new dt using:
   *
   *   newDt = 0.9 * dt * (chargeTol / maxError)^(1/3)
   *
   * clamped to [dt/4, 4*dt], then to [minTimeStep, maxTimeStep], then
   * shortened to land exactly on the next registered breakpoint if needed.
   *
   * @param elements  - All circuit elements (non-reactive ones are skipped)
   * @param history   - HistoryStore (unused here; present for caller symmetry)
   * @param simTime   - Current simulation time in seconds (for breakpoint clamping)
   * @param stepDt    - The actual dt used for this step (defaults to `currentDt`).
   *   Pass this when the step dt may differ from `currentDt` (e.g. breakpoint clamping).
   * @returns Object with `newDt` (proposed next dt in seconds) and `worstRatio`
   *   (largest per-element LTE/tolerance ratio; 0 means no reactive errors reported).
   *   Pass `worstRatio` to `shouldReject` to decide whether to accept the step.
   */
  computeNewDt(
    elements: readonly AnalogElement[],
    _history: HistoryStore,
    simTime: number = 0,
    stepDt?: number,
  ): { newDt: number; worstRatio: number } {
    const dt = stepDt ?? this.currentDt;
    const order = this.currentOrder;
    const method = this.currentMethod;
    const lteParams = this._lteParams;
    const deltaOld = this._deltaOld;

    // Collect minimum proposed timestep from CKTterr-based elements.
    // If an element is reactive but doesn't implement getLteTimestep, it
    // contributes no LTE constraint (skip it).
    let minProposedDt = Infinity;
    let minProposedIdx = -1;

    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      if (!el.isReactive) continue;

      if (typeof el.getLteTimestep === "function") {
        const proposed = el.getLteTimestep(dt, deltaOld, order, method, lteParams);
        if (proposed < minProposedDt) {
          minProposedDt = proposed;
          minProposedIdx = i;
        }
      }
      // Elements without getLteTimestep contribute no LTE constraint.
    }

    this._largestErrorElement = minProposedIdx >= 0 ? minProposedIdx : undefined;

    let newDt: number;
    let worstRatio: number;

    if (minProposedDt < Infinity) {
      // CKTterr path: use the proposed dt directly (already incorporates
      // tolerance, safety factors, and order-dependent root extraction).
      newDt = minProposedDt;
      // Clamp step growth to 2*dt (ngspice ckttrunc.c:53).
      // No lower clamp — ngspice allows arbitrary shrinkage per LTE.
      newDt = Math.min(2 * dt, newDt);
      // worstRatio: >1 means step should be rejected (proposed < current dt)
      worstRatio = minProposedDt < dt ? dt / minProposedDt : 0;
    } else {
      // No reactive elements with getLteTimestep -- grow step toward maxTimeStep.
      newDt = Math.min(dt * 2, this._params.maxTimeStep);
      worstRatio = 0;
    }

    // Clamp to solver bounds.
    newDt = Math.max(this._params.minTimeStep, Math.min(this._params.maxTimeStep, newDt));

    // Clamp to next breakpoint.
    if (this._breakpoints.length > 0) {
      const nextBp = this._breakpoints[0]!.time;
      const remaining = nextBp - simTime;
      if (remaining > 0 && newDt > remaining) {
        newDt = remaining;
      }
    }

    // Return via pre-allocated result object (zero allocation).
    this._lteResult.newDt = newDt;
    this._lteResult.worstRatio = worstRatio;
    return this._lteResult;
  }

  /**
   * Return currentDt clamped to the next breakpoint so the current step
   * cannot overshoot a registered target time.  Called at the top of
   * AnalogEngine.step() instead of reading `currentDt` directly.
   */
  getClampedDt(simTime: number): number {
    let dt = this.currentDt;

    // ngspice dctran.c:572-580: at t=0 (firsttime), apply proximity clamp
    // (when breakpoints exist) then divide by 10 unconditionally.
    if (this._isFirstGetClampedDt) {
      this._isFirstGetClampedDt = false;
      if (this._breakpoints.length > 1) {
        // ngspice dctran.c:572-573: gap is between the first two breakpoints,
        // not from simTime to breaks[0]. Matches ngspice CKTbreaks[1]-CKTbreaks[0].
        const nextBreakGap = this._breakpoints[1]!.time - this._breakpoints[0]!.time;
        if (nextBreakGap > 0) {
          // dctran.c:572-573: delta = MIN(delta, 0.1 * MIN(savedDelta, nextBreakGap)).
          dt = Math.min(dt, 0.1 * Math.min(dt, nextBreakGap));
        }
      }
      // dctran.c:580: CKTdelta /= 10 — unconditional firsttime safety factor.
      dt /= 10;
      // Keep within [minTimeStep, maxTimeStep]
      dt = Math.max(dt, this._params.minTimeStep * 2);
      // Do NOT update this.currentDt — the clamp applies only to this step's
      // working dt.  Persisting it would prevent NR retries from halving from
      // the pre-clamp value, causing stagnation at t=0.
    }

    this._breakFlag = false;
    if (this._breakpoints.length > 0) {
      const nextBp = this._breakpoints[0]!.time;
      const remaining = nextBp - simTime;
      if (remaining > 0 && dt >= remaining) {
        // ngspice dctran.c:583-585: simple clamp to the breakpoint.
        // ngspice dctran.c:595: saveDelta captured only at breakpoint hit.
        this._savedDelta = dt;
        dt = remaining;
        this._breakFlag = true;
      }
    }
    return dt;
  }

  // -------------------------------------------------------------------------
  // Rejection
  // -------------------------------------------------------------------------

  /**
   * Returns true when the proposed timestep is too small relative to the
   * current step, meaning the step must be rejected and retried.
   *
   * ngspice dctran.c:880: `if(newdelta > .9 * ckt->CKTdelta)` → accept.
   * Reject when `proposedDt <= 0.9 * dt`, i.e., `worstRatio >= 1/0.9`.
   *
   * The 0.9 hysteresis band prevents cascading rejections when the proposed
   * timestep is only marginally smaller than the current one.
   *
   * Semantics:
   *   - worstRatio == 0        → accept (no reactive errors reported)
   *   - worstRatio < 1/0.9     → accept (within hysteresis band)
   *   - worstRatio >= 1/0.9    → reject (proposed dt ≤ 90% of current dt)
   *
   * @param worstRatio - dt / proposedDt from computeNewDt (0 when no constraint)
   */
  shouldReject(worstRatio: number): boolean {
    // ngspice dctran.c:880 — reject when newdelta <= .9 * CKTdelta
    return worstRatio >= 1 / 0.9;
  }

  // -------------------------------------------------------------------------
  // Acceptance
  // -------------------------------------------------------------------------

  /**
   * Record an accepted timestep at the given simulation time.
   *
   * Advances the accepted-step counter (driving the auto-switch state machine)
   * and pops any breakpoints that have been reached.
   *
   * @param simTime - Simulation time after the accepted step, in seconds
   */
  accept(simTime: number): void {
    if (simTime <= this._lastAcceptedSimTime) {
      throw new Error(
        `TimestepController.accept() invariant violated: simTime ${simTime} <= _lastAcceptedSimTime ${this._lastAcceptedSimTime}`,
      );
    }
    this._lastAcceptedSimTime = simTime;

    // ngspice spec map rows 302-306 (spec/state-machines/ngspice-timestep-vs-timestep.md):
    // pin order=1 during the firsttime startup window (steps 0 and 1) so
    // the order-2 divided-difference LTE cannot fire on step 1 with
    // deltaOld[1..] = maxTimeStep seeds (dctran.c:316-318), which would
    // divide rounding noise by h0·h1·(h0+h1) ≈ 1e-20 s³ and cause dt
    // collapse. ngspice's firsttime branch (dctran.c:849-872) does the
    // same by goto nextTime, skipping CKTtrunc entirely on step 0; on
    // step 1 order is still 1 until the order-1 LTE gate passes
    // (dctran.c:881-892).
    this._updateMethodForStartup();

    this._acceptedSteps++;

    // deltaOld rotation removed — now performed by the engine before/inside
    // the for(;;) loop to match ngspice dctran.c:704-706, 735.

    // Pop breakpoints that have been reached and refill from source if any.
    // ngspice dctran.c:553-554,628: consume a breakpoint when simTime is
    // within 100 ULPs of the breakpoint time, or within the delmin band.
    // Guard: nextBreakpoint() can return a value <= simTime due to
    // floating-point rounding (e.g. clock halfPeriod not exactly
    // representable). Without the strict-future check, the loop would
    // pop, re-insert at the front, and spin forever.
    let breakpointConsumed = false;
    while (this._breakpoints.length > 0) {
      const bp = this._breakpoints[0]!.time;
      if (!(almostEqualUlps(simTime, bp, 100) || bp - simTime <= this._delmin)) break;
      breakpointConsumed = true;
      const popped = this._breakpoints.shift()!;
      if (typeof popped.source?.nextBreakpoint === "function") {
        const next = popped.source.nextBreakpoint(simTime);
        if (next !== null && next > simTime) {
          this.insertForSource(next, popped.source);
        }
      }
    }

    // ngspice dctran.c:493 — reset integration order after a breakpoint
    // so the first step past the discontinuity uses the robust BDF-1.
    if (breakpointConsumed) {
      this.currentMethod = "bdf1";
      this.currentOrder = 1;

      // ngspice dctran.c:506-507 — reduce delta after breakpoint:
      //   delta = MAX(0.1 * MIN(saveDelta, nextBreakDelta), 2 * delmin)
      const nextBreakGap = this._breakpoints.length > 0
        ? this._breakpoints[0]!.time - simTime
        : Infinity;
      this.currentDt = Math.max(
        0.1 * Math.min(this._savedDelta, nextBreakGap),
        2 * this._params.minTimeStep,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Startup order pin (ngspice firsttime replacement)
  // -------------------------------------------------------------------------

  /**
   * Pin `currentOrder = 1` during the startup window so order-2 LTE cannot
   * fire on step 0 or step 1. Matches the ngspice firsttime state machine:
   *  - dctran.c:315 sets `ckt->CKTorder = 1` at transient entry.
   *  - dctran.c:849-872 does `firsttime=0; goto nextTime;` on step 0,
   *    skipping CKTtrunc entirely.
   *  - dctran.c:881-892 only promotes to order 2 AFTER order-1 LTE passes
   *    (gated on `newdelta > .9 * CKTdelta` at line 880).
   *
   * Called by accept() BEFORE `_acceptedSteps++`, so step 0 (_acceptedSteps=0
   * pre-increment) and step 1 (_acceptedSteps=1 pre-increment) are both
   * pinned at order=1. tryOrderPromotion()'s `_acceptedSteps <= 1` gate
   * then allows promotion from step 2 onward (dctran.c:864-866 equivalent).
   *
   * Spec map: spec/state-machines/ngspice-timestep-vs-timestep.md rows 302-306.
   */
  private _updateMethodForStartup(): void {
    if (this._acceptedSteps <= 1) {
      this.currentOrder = 1;
    }
  }

  // -------------------------------------------------------------------------
  // Order promotion trial  (ngspice dctran.c:820-829)
  // -------------------------------------------------------------------------

  /**
   * Speculatively re-run LTE at a higher integration order to see if
   * promoting would allow a larger timestep.
   *
   * Called by the engine after an accepted step when the order-1 LTE
   * already passed the `.9 * delta` gate (caller checks).
   *
   * ngspice dctran.c:862-876.
   *
   * @param executedDt  - The step delta that was actually executed (CKTdelta
   *   at accept time). Used to re-seed CKTtrunc at order 2, matching
   *   ngspice dctran.c:864 where newdelta = ckt->CKTdelta before the
   *   order-2 CKTtrunc call.
   */
  tryOrderPromotion(
    elements: readonly AnalogElement[],
    _history: HistoryStore,
    _simTime: number,
    executedDt: number,
  ): void {
    // Only promote when still at order 1, and only after the first accepted
    // step (ngspice clears firsttime after step 0, then skips LTE via goto
    // nextTime on that step — promotion trial first runs from step 2 onward,
    // matching dctran.c:864-866).
    if (this._acceptedSteps <= 1) return;

    // ngspice dctran.c:864-866: re-seed and re-truncate at order 2.
    // Compute the raw LTE-proposed dt at order 2 WITHOUT maxTimeStep clamping.
    // ngspice's CKTtrunc (ckttrunc.c:50) only applies the 2× growth cap;
    // the maxStep clamp is applied later by the calling code.  Using
    // computeNewDt() here would clamp to maxTimeStep, causing the trial to
    // always fail when dt is already at maxTimeStep (trialDt = maxTimeStep
    // <= 1.05 * currentDt).
    let rawTrialDt = Infinity;
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      if (!el.isReactive) continue;
      if (typeof el.getLteTimestep === "function") {
        const proposed = el.getLteTimestep(
          executedDt, this._deltaOld, 2, "trapezoidal", this._lteParams,
        );
        if (proposed < rawTrialDt) rawTrialDt = proposed;
      }
    }
    // Apply only the 2× growth cap (ngspice ckttrunc.c:50).
    if (rawTrialDt > 2 * executedDt) rawTrialDt = 2 * executedDt;

    if (rawTrialDt <= 1.05 * executedDt) {
      // Promotion does not help — keep order 1.
      // Still update currentDt to the (clamped) trial result, matching
      // ngspice dctran.c:876 which always writes newdelta.
      this.currentDt = Math.max(
        this._params.minTimeStep,
        Math.min(this._params.maxTimeStep, rawTrialDt),
      );
      return;
    }

    // Promotion succeeds — switch to trapezoidal order 2.
    this.currentMethod = "trapezoidal";
    this.currentOrder = 2;
    // Clamp for actual stepping.
    this.currentDt = Math.max(
      this._params.minTimeStep,
      Math.min(this._params.maxTimeStep, rawTrialDt),
    );
  }

  // -------------------------------------------------------------------------
  // Breakpoints
  // -------------------------------------------------------------------------

  /**
   * Register a simulation time at which the timestep controller must land a
   * step exactly. Inserted into the sorted breakpoint list. Duplicate
   * registrations within half a minTimeStep of an existing breakpoint are
   * silently dropped so that callers which re-query the same lookahead
   * window on every step() do not unboundedly grow the list.
   *
   * @param time - Breakpoint time in seconds
   */
  addBreakpoint(time: number): void {
    // Binary-search insertion point.
    let lo = 0;
    let hi = this._breakpoints.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this._breakpoints[mid]!.time < time) lo = mid + 1;
      else hi = mid;
    }
    // Dedup: if an existing entry at lo or lo-1 is within eps of `time`,
    // treat as already registered. ngspice: CKTminBreak = CKTmaxStep * 5e-5.
    const eps = this._params.maxTimeStep * 5e-5;
    if (lo < this._breakpoints.length && this._breakpoints[lo]!.time - time < eps) {
      return;
    }
    if (lo > 0 && time - this._breakpoints[lo - 1]!.time < eps) {
      return;
    }
    this._breakpoints.splice(lo, 0, { time, source: null });
  }

  /**
   * Register the next outstanding breakpoint for an element source. The
   * controller holds at most one entry per source; when this entry is
   * consumed in accept(), the controller calls source.nextBreakpoint to
   * refill.
   *
   * Seeded at compile time for every element with nextBreakpoint, and
   * re-seeded automatically during accept(). Never called from the hot
   * path per step.
   */
  insertForSource(time: number, source: AnalogElement): void {
    let lo = 0;
    let hi = this._breakpoints.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this._breakpoints[mid]!.time < time) lo = mid + 1;
      else hi = mid;
    }
    const eps = this._params.maxTimeStep * 5e-5;
    if (lo < this._breakpoints.length && this._breakpoints[lo]!.time - time < eps) {
      return;
    }
    if (lo > 0 && time - this._breakpoints[lo - 1]!.time < eps) {
      return;
    }
    this._breakpoints.splice(lo, 0, { time, source });
  }

  /**
   * Find the existing queue entry for source (by identity), remove it, and
   * reinsert at newNextTime if non-null. Used by the engine to refresh a
   * stale breakpoint after a setParam change (e.g. frequency/phase change).
   */
  refreshForSource(source: AnalogElement, newNextTime: number | null): void {
    const idx = this._breakpoints.findIndex((e) => e.source === source);
    if (idx >= 0) {
      this._breakpoints.splice(idx, 1);
    }
    if (newNextTime !== null) {
      this.insertForSource(newNextTime, source);
    }
  }

  /**
   * Remove all registered breakpoints.
   */
  clearBreakpoints(): void {
    this._breakpoints = [];
  }

}
