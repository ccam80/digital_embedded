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

  /** Sorted ascending list of registered breakpoint times. ngspice CKTbreaks. */
  private _breakpoints: number[];

  /** Final simulation time used as the perpetual sentinel at breaks[length-1]. ngspice CKTfinalTime. */
  private _finalTime: number = Infinity;

  /** Simulation time of the last accepted step. Used for accept() invariant check. */
  private _lastAcceptedSimTime: number;

  /** Total accepted step count — drives the startup state machine. */
  private _acceptedSteps: number;

  /** Backing field for largestErrorElement. */
  private _largestErrorElement: number | undefined;

  /**
   * Minimum timestep used for breakpoint proximity detection.
   * ngspice traninit.c:34: `CKTdelmin = 1e-11 * CKTmaxStep`.
   * Gates the `breaks[0] - simTime <= delmin` test in dctran.c:554.
   */
  private _delmin: number = 0;

  /**
   * Minimum-break threshold used by the breakpoint pop loop and queue dedup.
   * ngspice dctran.c:157: CKTminBreak = CKTmaxStep * 5e-5 (different threshold
   * from CKTdelmin — see dctran.c:554 vs dctran.c:629).
   */
  private _minBreak: number = 0;

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
   * 1 for order-1 trapezoidal; 2 for order-2 trapezoidal or gear. ngspice: CKTorder.
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
    // dctran.c:315 `ckt->CKTorder = 1` so the first step runs order-1
    // backward-Euler semantics via the order-1 coefficients even though
    // the configured method is trapezoidal).
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

    // ngspice traninit.c:34 — CKTdelmin = 1e-11 * CKTmaxStep. Gates the
    // at-breakpoint proximity test (`breaks[0] - simTime <= delmin`) in
    // getClampedDt() / dctran.c:554. Streaming-mode safe: maxTimeStep is
    // always meaningful, no tStop dependence.
    this._delmin = params.maxTimeStep * 1e-11;

    // ngspice dctran.c:157 — CKTminBreak = CKTmaxStep * 5e-5. Distinct from
    // CKTdelmin: minBreak gates the breakpoint pop loop and queue dedup,
    // delmin gates the at-breakpoint proximity test.
    this._minBreak = params.maxTimeStep * 5e-5;
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
   *   - _delmin / _minBreak (both derived from maxTimeStep, traninit.c:34 / dctran.c:157)
   *   - _lteParams (trtol, reltol, abstol, chgtol) — cast past readonly
   *     because the struct is logically immutable per computeNewDt call but
   *     we deliberately refresh it once on configure().
   *   - currentDt: while no step has been taken (_isFirstGetClampedDt),
   *     firstStep is re-applied exactly as the constructor does. Once the
   *     first getClampedDt has run, currentDt reflects accepted-step history
   *     and is only clamped DOWN to the new maxTimeStep (never raised), so
   *     hot-loading tolerances mid-run cannot restart the step history.
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

    // Re-derive _delmin from maxStep (traninit.c:34: CKTdelmin = 1e-11 * CKTmaxStep).
    this._delmin = params.maxTimeStep * 1e-11;

    // Re-derive _minBreak from maxStep (dctran.c:157: CKTminBreak = CKTmaxStep * 5e-5).
    this._minBreak = params.maxTimeStep * 5e-5;

    if (this._isFirstGetClampedDt) {
      // No step has been taken yet. Re-apply firstStep exactly as the
      // constructor does — this lets callers (e.g. the ngspice comparison
      // harness) legitimately reconfigure firstStep after engine
      // construction but before runTransient. Without this branch the
      // engine silently ignores a harness-supplied firstStep and runs
      // with the DEFAULT_SIMULATION_PARAMS value baked in at field init.
      this.currentDt = Math.max(
        params.minTimeStep,
        Math.min(params.maxTimeStep, params.firstStep),
      );
    } else if (this.currentDt > params.maxTimeStep) {
      // Mid-run: only clamp currentDt down to the new ceiling; never raise.
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
      const nextBp = this._breakpoints[0]!;
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
   * Mirrors ngspice dctran.c:540-644 top-of-step flow (XSPICE build, default).
   *
   *   540: dt = MIN(dt, maxStep)
   *   553: at-breakpoint clamp (order=1, 0.1*MIN(saveDelta, gap), /=10 firsttime, 2*delmin floor)
   *   594: else-if approaching-breakpoint clamp (saveDelta capture, dt = bp - simTime)
   *   624: pop loop using minBreak
   *
   * Does NOT mutate this.currentDt — the clamp applies only to this step's
   * working dt. Persisting it would prevent NR retries from halving from the
   * pre-clamp value (stagnation at t=0).
   */
  getClampedDt(simTime: number): number {
    // dctran.c:540 — CKTdelta = MIN(CKTdelta, CKTmaxStep)
    let dt = Math.min(this.currentDt, this._params.maxTimeStep);

    this._breakFlag = false;

    const len = this._breakpoints.length;
    if (len > 0) {
      const bp0 = this._breakpoints[0]!;
      const atBreak =
        almostEqualUlps(simTime, bp0, 100) || bp0 - simTime <= this._delmin;

      if (atBreak) {
        // dctran.c:559 — CKTorder = 1 on at-breakpoint
        this.currentOrder = 1;

        // dctran.c:572-573 — CKTdelta = MIN(CKTdelta, 0.1 * MIN(saveDelta,
        //   breaks[1] - breaks[0])). Sentinel guarantees length >= 2 after
        //   seedSentinel; breaks[1] is always the next bp or finalTime.
        const gap = this._breakpoints[1]! - bp0;
        dt = Math.min(dt, 0.1 * Math.min(this._savedDelta, gap));

        // dctran.c:580 — firsttime: CKTdelta /= 10. The proximity clamp above
        // fires on every at-breakpoint step; the /=10 cut is firsttime-only.
        if (this._isFirstGetClampedDt) {
          dt /= 10;
        }

        // dctran.c:586-589 — `MAX(CKTdelta, CKTdelmin * 2.0)` is wrapped
        // in `#ifndef XSPICE`. The function-level comment above states we
        // port the XSPICE branch, so this floor is intentionally absent.
        // Applying any floor here (whether using CKTdelmin or minTimeStep)
        // would diverge from ngspice's actual XSPICE-build behaviour.
      } else if (simTime + dt >= bp0) {
        // dctran.c:594-602 (non-XSPICE branch — also semantically equivalent
        // to the XSPICE late-clamp at line 640-644). Save the unclamped dt
        // before truncating; on the next step the at-breakpoint branch above
        // will read saveDelta to size the post-bp dt.
        this._savedDelta = dt;
        dt = bp0 - simTime;
        this._breakFlag = true;
      }
    }

    this._isFirstGetClampedDt = false;

    // dctran.c:624-638 — XSPICE pop loop using CKTminBreak. ngspice's pop is
    // shift-only; sources register their next edge via DEVaccept → CKTsetBreak
    // after the step is accepted. We mirror that via element.acceptStep(simTime,
    // addBP) in MNAEngine.step() — refilling from `popped.source` here would
    // re-insert the same edge inside the loop and spin (next > simTime is true
    // when next sits within minBreak of simTime, which the next pop iteration
    // then re-pops).
    while (this._breakpoints.length > 2) {
      const bp = this._breakpoints[0]!;
      if (!(almostEqualUlps(bp, simTime, 100) || bp <= simTime + this._minBreak)) break;
      this._clrBreak();
    }
    if (this._breakpoints.length === 2) {
      const bp = this._breakpoints[0]!;
      if ((almostEqualUlps(bp, simTime, 100) || bp <= simTime + this._minBreak) && bp < this._finalTime) {
        this._clrBreak();
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
    //
    // Breakpoint pop and at-breakpoint clamp live in getClampedDt() — see
    // ngspice dctran.c:540-644 (top-of-next-step, not at-acceptance).
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

  /** ngspice dctran.c:140-145 — seed [0, finalTime] at transient init. */
  seedSentinel(finalTime: number): void {
    this._finalTime = finalTime;
    this._breakpoints = [0, finalTime];
  }

  /** ngspice cktclrbk.c — shift breakpoint array, maintaining finalTime sentinel when length collapses to 2. */
  private _clrBreak(): void {
    if (this._breakpoints.length > 2) {
      this._breakpoints.shift();
    } else {
      this._breakpoints[0] = this._breakpoints[1]!;
      this._breakpoints[1] = this._finalTime;
    }
  }

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
    let lo = 0, hi = this._breakpoints.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this._breakpoints[mid]! < time) lo = mid + 1; else hi = mid;
    }
    const eps = this._params.maxTimeStep * 5e-5;
    if (lo < this._breakpoints.length && this._breakpoints[lo]! - time < eps) return;
    if (lo > 0 && time - this._breakpoints[lo - 1]! < eps) return;
    this._breakpoints.splice(lo, 0, time);
  }

  /**
   * Remove all registered breakpoints and reseed the [0, finalTime] sentinel.
   */
  clearBreakpoints(): void {
    this._breakpoints = [0, this._finalTime];
  }

}
