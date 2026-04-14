/**
 * Adaptive timestep controller for the MNA transient solver.
 *
 * Implements local truncation error (LTE) based timestep control with:
 *  - Safety factor 0.9 applied to all computed dt predictions
 *  - Clamping to [dt/4, 4*dt] per step, then to [minTimeStep, maxTimeStep]
 *  - Breakpoint support for exact landing at registered simulation times
 *  - Automatic integration method switching: BDF-1 → trapezoidal → BDF-2 (on
 *    ringing) → trapezoidal (after 5 stable BDF-2 steps)
 */

import type { AnalogElement, IntegrationMethod } from "./element.js";
import type { ResolvedSimulationParams } from "../../core/analog-engine-interface.js";
import type { HistoryStore } from "./integration.js";
import type { LteParams } from "./ckt-terr.js";

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
 *   3. If accepted: accept(simTime), checkMethodSwitch(elements, history)
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

  /**
   * Sign history per reactive element index for ringing detection.
   *
   * Each entry is a circular buffer of the last 3 sign values (+1 / -1 / 0).
   * Index in the outer array matches the position of the reactive element
   * in the elements array passed to checkMethodSwitch.
   */
  private _signHistory: Array<number[]>;

  /** Number of consecutive non-oscillating steps completed while on BDF-2. */
  private _stableOnBdf2: number;

  /** Backing field for largestErrorElement. */
  private _largestErrorElement: number | undefined;

  /**
   * Unclamped dt saved before breakpoint clamping in getClampedDt().
   * Used by accept() to compute post-breakpoint delta reduction
   * (ngspice dctran.c:506 saveDelta).
   */
  private _savedDelta: number = 0;

  /**
   * Timestep history for CKTterr divided differences.
   * [0] = current trial dt (set by setDeltaOldCurrent), [1] = h_{n-1} (previous accepted dt), [2] = h_{n-2}, [3] = h_{n-3}.
   * Pre-allocated once; shifted in rotateDeltaOld(). ngspice: CKTdeltaOld[].
   */
  private _deltaOld: number[] = [0, 0, 0, 0, 0, 0, 0];

  /**
   * Integration order derived from currentMethod.
   * 1 for bdf1, 2 for trapezoidal and bdf2. ngspice: CKTorder.
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

  constructor(params: ResolvedSimulationParams) {
    this._params = params;
    // Use the explicit firstStep parameter. Clamp to [minTimeStep, maxTimeStep].
    this.currentDt = Math.max(
      params.minTimeStep,
      Math.min(params.maxTimeStep, params.firstStep),
    );
    this.currentMethod = "bdf1";
    this._breakpoints = [];
    this._lastAcceptedSimTime = -Infinity;
    this._acceptedSteps = 0;
    this._signHistory = [];
    this._stableOnBdf2 = 0;
    this._largestErrorElement = undefined;
    this._lteParams = {
      trtol: params.trtol,
      reltol: params.reltol,
      // ngspice CKTterr uses CKTabstol (current tolerance, 1e-12), not
      // CKTvoltTol (voltage tolerance, 1e-6). The LTE operates on charge
      // and companion-model currents, so the current tolerance applies.
      abstol: params.iabstol,
      chgtol: params.chargeTol,
    };

    // ngspice dctran.c:316-317: CKTdeltaOld[i] = CKTmaxStep for all 7 slots
    for (let i = 0; i < 7; i++) {
      this._deltaOld[i] = params.maxTimeStep;
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
    // Save unclamped delta before breakpoint clamping (ngspice saveDelta,
    // dctran.c:506). Used in accept() for post-breakpoint delta reduction.
    this._savedDelta = dt;
    if (this._breakpoints.length > 0) {
      const nextBp = this._breakpoints[0]!.time;
      const remaining = nextBp - simTime;
      if (remaining > 0 && dt >= remaining) {
        // ngspice dctran.c:583-585: simple clamp to the breakpoint.
        // saveDelta is already captured above; accept() uses it for
        // post-breakpoint delta reduction (dctran.c:561).
        dt = remaining;
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

    this._acceptedSteps++;
    this._updateMethodForStartup();

    // deltaOld rotation removed — now performed by the engine before/inside
    // the for(;;) loop to match ngspice dctran.c:704-706, 735.

    // Pop breakpoints that have been reached and refill from source if any.
    // Guard: nextBreakpoint() can return a value <= simTime due to
    // floating-point rounding (e.g. clock halfPeriod not exactly
    // representable). Without the strict-future check, the loop would
    // pop, re-insert at the front, and spin forever.
    let breakpointConsumed = false;
    while (this._breakpoints.length > 0 && simTime >= this._breakpoints[0]!.time) {
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
  // Method auto-switching
  // -------------------------------------------------------------------------

  /**
   * Check for ringing on reactive element terminal voltages and switch
   * integration method accordingly.
   *
   * Ringing is detected when a reactive element's terminal voltage alternates
   * sign across 3 consecutive accepted timesteps. On detection: switch to BDF-2.
   * After 5 consecutive non-oscillating accepted steps on BDF-2: switch back
   * to trapezoidal.
   *
   * This method is called once per accepted timestep after `accept()`.
   *
   * @param elements - All circuit elements (non-reactive ones are skipped)
   * @param history  - HistoryStore providing v(n) and v(n-1) per element
   */
  checkMethodSwitch(elements: readonly AnalogElement[], history: HistoryStore): void {
    // Startup BDF-1 phase: no ringing detection until promotion has had a
    // chance to run (step 2+).  Method transitions handled by tryOrderPromotion.
    if (this._acceptedSteps <= 1) return;

    // Collect reactive element indices.
    const reactiveIndices: number[] = [];
    for (let i = 0; i < elements.length; i++) {
      if (elements[i].isReactive) reactiveIndices.push(i);
    }

    // Ensure sign-history buffers are allocated.
    if (this._signHistory.length !== reactiveIndices.length) {
      this._signHistory = reactiveIndices.map(() => []);
    }

    let ringing = false;

    for (let ri = 0; ri < reactiveIndices.length; ri++) {
      const elIdx = reactiveIndices[ri];
      const vNow = history.get(elIdx, 0);
      const sign = vNow > 0 ? 1 : vNow < 0 ? -1 : 0;

      const buf = this._signHistory[ri];
      buf.push(sign);
      if (buf.length > 3) buf.shift();

      if (buf.length === 3) {
        // Alternating sign: [+, -, +] or [-, +, -]
        if (
          buf[0] !== 0 &&
          buf[1] !== 0 &&
          buf[2] !== 0 &&
          buf[0] !== buf[1] &&
          buf[1] !== buf[2] &&
          buf[0] === buf[2]
        ) {
          ringing = true;
        }
      }
    }

    if (ringing) {
      if (this.currentMethod !== "bdf2") {
        this.currentMethod = "bdf2";
        this.currentOrder = 2;
        this._stableOnBdf2 = 0;
      }
    } else if (this.currentMethod === "bdf2") {
      this._stableOnBdf2++;
      if (this._stableOnBdf2 >= 5) {
        this.currentMethod = "trapezoidal";
        this.currentOrder = 2;
        this._stableOnBdf2 = 0;
      }
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
    // Only promote from order 1 (BDF-1), and only after the first accepted
    // step (ngspice clears firsttime after step 0, then skips LTE via goto
    // nextTime on that step — promotion trial first runs from step 2 onward,
    // matching dctran.c:864-866).
    if (this.currentMethod !== "bdf1" || this._acceptedSteps <= 1) return;

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
    // treat as already registered. eps = 0.5 * minTimeStep collapses re-adds
    // from overlapping lookahead windows without merging genuinely distinct
    // breakpoints (which cannot be closer than minTimeStep without the
    // solver being unable to separate them anyway).
    const eps = 0.5 * this._params.minTimeStep;
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
    const eps = 0.5 * this._params.minTimeStep;
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

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Apply the startup state machine for the first accepted step.
   *
   * Step 1: BDF-1 (suppress startup transients; ngspice dctran.c firsttime
   *   flag skips LTE/promotion entirely on the very first accepted point).
   * Step 2+: remain BDF-1 — promotion to trapezoidal is handled exclusively
   *   by tryOrderPromotion() via the 1.05× trial gate, matching ngspice
   *   dctran.c:881-891 which runs the trial on every accepted step where
   *   CKTorder==1.  The previous unconditional step-3 promotion bypassed
   *   this trial, causing our LTE to be ~2.45× more permissive than ngspice
   *   (order-2 trap factor 1/12 vs order-1 BE factor 0.5).
   */
  private _updateMethodForStartup(): void {
    // Keep BDF-1 during the startup phase.  Do NOT auto-promote to
    // trapezoidal — let tryOrderPromotion() handle the transition via the
    // ngspice-compatible 1.05× gate on every post-startup accepted step.
    if (this._acceptedSteps <= 1) {
      this.currentMethod = "bdf1";
      this.currentOrder = 1;
    }
    // After step 1, currentMethod stays at whatever tryOrderPromotion()
    // or checkMethodSwitch() set it to.  currentOrder is kept in sync by
    // those methods directly.
  }
}
