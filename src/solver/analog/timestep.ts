/**
 * Adaptive timestep controller for the MNA transient solver.
 *
 * Implements local truncation error (LTE) based timestep control with:
 *  - Safety factor 0.9 applied to all computed dt predictions
 *  - Clamping to [dt/4, 4*dt] per step, then to [minTimeStep, maxTimeStep]
 *  - Breakpoint support for exact landing at registered simulation times
 */

import type { AnalogElement } from "./element.js";
import type { IntegrationMethod } from "./integration.js";
import type { ResolvedSimulationParams } from "../../core/analog-engine-interface.js";
import type { HistoryStore } from "./integration.js";
import type { LteParams } from "./ckt-terr.js";

// ---------------------------------------------------------------------------
// almostEqualUlps- module-level singleton buffer (allocation-free after init)
// ngspice reference: dctran.c:553-554 AlmostEqualUlps(time, bkpt, 100)
// ---------------------------------------------------------------------------

const _ulpBuf = new ArrayBuffer(8);
const _ulpF64 = new Float64Array(_ulpBuf);
const _ulpI64 = new BigInt64Array(_ulpBuf);

/**
 * Returns true when a and b are within maxUlps IEEE-754 ULPs of each other.
 * Uses a module-level singleton ArrayBuffer- allocation-free after module load.
 * Matches ngspice dctran.c:553-554 and vsrcacct.c AlmostEqualUlps usage.
 *
 * Exported for source-element acceptStep gating (TRNOISE/TRRANDOM/PWL pattern
 * in vsrcacct.c uses `AlmostEqualUlps(nearest, CKTtime, 3)` to detect that
 * CKTtime sits at a sample boundary).
 */
export function almostEqualUlps(a: number, b: number, maxUlps: number): boolean {
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
 *   2. shouldReject(worstRatio)- rejects when worstRatio > 1
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

  /** Total accepted step count- drives the startup state machine. */
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
   * from CKTdelmin- see dctran.c:554 vs dctran.c:629).
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
   * XSPICE temporary breakpoint (g_mif_info.breakpoint.current).
   *
   * Default +Infinity- no temp bp pending. XSPICE-style event devices push
   * their next analog handoff time here via setTempBreakpoint(); the temp-bp
   * clamp at dctran.c:609-618 then truncates the working dt so the next step
   * lands exactly on this time. digiTS has no XSPICE event lane today, so
   * this stays at +Infinity in practice- but the slot exists so the dctran
   * port has a consistent place to read from when an event device is added.
   */
  private _tempBreakpoint: number = Number.POSITIVE_INFINITY;

  /**
   * XSPICE last-temp-breakpoint marker (g_mif_info.breakpoint.last).
   *
   * Updated by the temp-bp clamp at dctran.c:609-618: set to the post-clamp
   * CKTtime when the clamp fires, set to 1e30 (the ngspice sentinel) when
   * it doesn't. Read by the order-cut at dctran.c:542-548 to detect the
   * first step after a temp-bp landing and force CKTorder = 1.
   */
  private _lastTempBreakpoint: number = 1.0e30;

  /**
   * Timestep history for CKTterr divided differences.
   * [0] = current trial dt (set by setDeltaOldCurrent), [1] = h_{n-1} (previous accepted dt), [2] = h_{n-2}, [3] = h_{n-3}.
   * Pre-allocated once; shifted in rotateDeltaOld(). ngspice: CKTdeltaOld[].
   *
   * UNIFIED STORAGE- when the controller is wired into a CKTCircuitContext
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
   * LTE gate passes- see tryOrderPromotion() and the firsttime branch at
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
    // (unit tests, pre-init field defaults). Length MUST be 7- matches
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
    // ref/ngspice/src/spicelib/analysis/cktsetup.c- paired with
    // dctran.c:315 `ckt->CKTorder = 1` so the first step runs order-1
    // backward-Euler semantics via the order-1 coefficients even though
    // the configured method is trapezoidal).
    this.currentMethod = "trapezoidal";

    // Mirror ngspice dctran.c:140-145 (queue) + line 188 (CKTbreak=1):
    // every transient run starts with breaks=[0, finalTime] and CKTbreak
    // pre-seeded so the first arrival at `nextTime:` (the head of the
    // transient loop) dispatches CKTaccept with breakFlag=true. The seed
    // lives in the constructor- not in a separate method- because
    // ngspice's dctran does it inline and there's no lifecycle reason for
    // a fresh controller to be in any other state. The configure() path
    // that re-seeds without re-constructing has its own restart method.
    this._finalTime = params.tStop ?? Number.POSITIVE_INFINITY;
    this._breakpoints = [0, this._finalTime];
    this._breakFlag = true;

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

    // ngspice traninit.c:34- CKTdelmin = 1e-11 * CKTmaxStep. Gates the
    // at-breakpoint proximity test (`breaks[0] - simTime <= delmin`) in
    // getClampedDt() / dctran.c:554. Streaming-mode safe: maxTimeStep is
    // always meaningful, no tStop dependence.
    this._delmin = params.maxTimeStep * 1e-11;

    // ngspice dctran.c:154 (XSPICE init, runs first)- CKTminBreak = 10 *
    // CKTdelmin. Under XSPICE this resolves to ~1e-15 for typical runs;
    // small enough that the loose `<=` pop predicate at dctran.c:629
    // behaves like the strict `>` pop at dctran.c:412 in practice. The
    // non-XSPICE fallback (maxStep * 5e-5, dctran.c:157) is ~500× larger
    // and would pop breakpoints prematurely. digiTS targets the XSPICE
    // lane (mixed digital/analog), so the XSPICE init is the correct one.
    this._minBreak = 10 * this._delmin;
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
   *   - _lteParams (trtol, reltol, abstol, chgtol)- cast past readonly
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

    // LTE params- readonly at the interface level; this is the one legal
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

    // Re-derive _minBreak from delmin (dctran.c:154 XSPICE init: CKTminBreak = 10 * CKTdelmin).
    this._minBreak = 10 * this._delmin;

    if (this._isFirstGetClampedDt) {
      // No step has been taken yet. Re-apply firstStep exactly as the
      // constructor does- this lets callers (e.g. the ngspice comparison
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
    _simTime: number = 0,
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
      if (typeof el.getLteTimestep === "function") {
        const proposed = el.getLteTimestep(dt, deltaOld, order, method, lteParams);
        if (proposed < minProposedDt) {
          minProposedDt = proposed;
          minProposedIdx = i;
        }
      }
    }

    this._largestErrorElement = minProposedIdx >= 0 ? minProposedIdx : undefined;

    let newDt: number;
    let worstRatio: number;

    if (minProposedDt < Infinity) {
      // CKTterr path: use the proposed dt directly (already incorporates
      // tolerance, safety factors, and order-dependent root extraction).
      newDt = minProposedDt;
      // Clamp step growth to 2*dt (ngspice ckttrunc.c:53).
      // No lower clamp- ngspice allows arbitrary shrinkage per LTE.
      newDt = Math.min(2 * dt, newDt);
      // worstRatio: >1 means step should be rejected (proposed < current dt)
      worstRatio = minProposedDt < dt ? dt / minProposedDt : 0;
    } else {
      // ngspice ckttrunc.c:53 with timetemp=HUGE (no devices have DEVtrunc):
      // *timeStep = MIN(2 * *timeStep, HUGE) = 2 * *timeStep. No maxStep
      // clamp here- that is applied at top-of-next-step in dctran.c:540
      // (mirrored by getClampedDt). Clamping here would publish a maxStep-
      // capped value as the LTE proposal and break parity capture of the
      // unclamped CKTdelta that ngspice reports out of CKTtrunc.
      newDt = dt * 2;
      worstRatio = 0;
    }

    // Do NOT clamp to [minTimeStep, maxTimeStep] here. ngspice CKTtrunc
    // returns the raw LTE proposal; top-of-step (dctran.c:540) handles the
    // maxStep clamp via getClampedDt, and the delmin two-strike check
    // (dctran.c:766, mirrored at analog-engine.ts:614) handles below-delmin.
    // Mirror that exact split- clamping here would diverge bit-for-bit
    // from ngspice's published CKTdelta between steps.
    //
    // Likewise, do NOT clamp to the next breakpoint here. ngspice CKTtrunc
    // does not consult CKTbreaks; the XSPICE late-clamp lives at
    // dctran.c:640-644 (mirrored by getClampedDt at the top of the next
    // step). Clamping here was emitting a bp-truncated value as the LTE
    // proposal whenever simTime advanced past (bp - 2*dt), which is one
    // step earlier than the ngspice proposal sees the constraint.

    // Return via pre-allocated result object (zero allocation).
    this._lteResult.newDt = newDt;
    this._lteResult.worstRatio = worstRatio;
    return this._lteResult;
  }

  /**
   * Mirrors ngspice dctran.c:540-644 top-of-step flow- pure XSPICE port.
   *
   *   540        : dt = MIN(dt, maxStep)
   *   542-548    : XSPICE order-cut on _lastTempBreakpoint
   *   551-591    : at-breakpoint clamp on permanent CKTbreaks queue
   *                (order=1, 0.1*MIN(saveDelta, gap), /=10 firsttime;
   *                 the #ifndef XSPICE delmin floor at 586-589 is omitted)
   *   606-620    : XSPICE temp-bp clamp on _tempBreakpoint
   *                (saveDelta capture, dt = tempBp - simTime,
   *                 _lastTempBreakpoint update or 1e30 sentinel)
   *   624-638    : XSPICE pop loop on permanent queue using minBreak
   *   640-644    : XSPICE late-clamp on permanent queue, predicate `>`
   *                (saveDelta capture, dt = breaks[0] - simTime,
   *                 sets breakFlag = true)
   *
   * The non-XSPICE approaching-bp clamp at dctran.c:594-602 (`else if` with
   * `>=`) is intentionally NOT ported- the XSPICE late-clamp at 640-644 is
   * the equivalent gate in the XSPICE build, and it runs after the pop loop
   * has discarded the breakpoint we just landed on. Mixing the two would
   * splice incompatible build configurations.
   *
   * Does NOT mutate this.currentDt- the clamp applies only to this step's
   * working dt. Persisting it would prevent NR retries from halving from the
   * pre-clamp value (stagnation at t=0).
   */
  getClampedDt(simTime: number): number {
    // dctran.c:540- CKTdelta = MIN(CKTdelta, CKTmaxStep)
    let dt = Math.min(this.currentDt, this._params.maxTimeStep);

    // dctran.c:542-548 (XSPICE)- first timepoint after a temp breakpoint
    // cuts integration order. _lastTempBreakpoint is updated by the temp-bp
    // clamp below (set to post-clamp CKTtime when it fires, 1e30 otherwise),
    // so this only triggers on the call AFTER a temp-bp landing.
    if (almostEqualUlps(simTime, this._lastTempBreakpoint, 100)) {
      this.currentOrder = 1;
    }

    this._breakFlag = false;

    // dctran.c:551-591- at-breakpoint clamp on permanent CKTbreaks queue.
    const len = this._breakpoints.length;
    if (len > 0) {
      const bp0 = this._breakpoints[0]!;
      const atBreak =
        almostEqualUlps(simTime, bp0, 100) || bp0 - simTime <= this._delmin;

      if (atBreak) {
        // dctran.c:559- CKTorder = 1 on at-breakpoint
        this.currentOrder = 1;

        // dctran.c:572-573- CKTdelta = MIN(CKTdelta, 0.1 * MIN(saveDelta,
        //   breaks[1] - breaks[0])). Sentinel guarantees length >= 2 after
        //   the constructor seed; breaks[1] is always the next bp or finalTime.
        const gap = this._breakpoints[1]! - bp0;
        dt = Math.min(dt, 0.1 * Math.min(this._savedDelta, gap));

        // dctran.c:580- firsttime: CKTdelta /= 10. The proximity clamp above
        // fires on every at-breakpoint step; the /=10 cut is firsttime-only.
        if (this._isFirstGetClampedDt) {
          dt /= 10;
        }

        // dctran.c:586-589- `MAX(CKTdelta, CKTdelmin * 2.0)` is wrapped in
        // `#ifndef XSPICE`. Pure-XSPICE port: floor intentionally absent.
      }
    }

    // dctran.c:606-620 (XSPICE)- temp-bp clamp on g_mif_info.breakpoint.current.
    // _tempBreakpoint defaults to +Infinity (no event device pushed) and stays
    // there until setTempBreakpoint() is called. With +Infinity the if-condition
    // is unconditionally false, mirroring ngspice when no XSPICE event device
    // is active. This clamp does NOT set breakFlag- only the late-clamp at
    // 640-644 sets CKTbreak.
    if (simTime + dt >= this._tempBreakpoint) {
      this._savedDelta = dt;
      dt = this._tempBreakpoint - simTime;
      this._lastTempBreakpoint = simTime + dt;
    } else {
      this._lastTempBreakpoint = 1.0e30;
    }

    // dctran.c:624-638 (XSPICE)- pop loop on permanent CKTbreaks queue using
    // CKTminBreak. ngspice's pop is shift-only; sources register their next
    // edge via DEVaccept → CKTsetBreak after the step is accepted. We mirror
    // that via element.acceptStep(simTime, addBP) in MNAEngine.step()-
    // refilling from `popped.source` here would re-insert the same edge inside
    // the loop and spin (next > simTime is true when next sits within minBreak
    // of simTime, which the next pop iteration then re-pops).
    //
    // Order matters: this pop runs BEFORE the late-clamp below, so the
    // late-clamp sees the NEXT permanent breakpoint, not the one we just
    // landed on.
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

    // dctran.c:640-644 (XSPICE)- late-clamp on permanent CKTbreaks queue.
    // Predicate is strict `>` (NOT `>=`): when CKTtime + CKTdelta lands
    // exactly on breaks[0], no clamp fires and breakFlag stays false. The
    // next step will satisfy the at-breakpoint test above and cut order/dt
    // there. Sets breakFlag = true (CKTbreak in ngspice).
    if (this._breakpoints.length > 0 && simTime + dt > this._breakpoints[0]!) {
      this._breakFlag = true;
      this._savedDelta = dt;
      dt = this._breakpoints[0]! - simTime;
    }

    this._isFirstGetClampedDt = false;

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
    // ngspice dctran.c:880- reject when newdelta <= .9 * CKTdelta
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
  markAccepted(simTime: number): void {
    if (simTime <= this._lastAcceptedSimTime) {
      throw new Error(
        `TimestepController.markAccepted() invariant violated: simTime ${simTime} <= _lastAcceptedSimTime ${this._lastAcceptedSimTime}`,
      );
    }
    this._lastAcceptedSimTime = simTime;

    // ngspice CKTaccept does NOT write CKTorder. Order stays at 1 during
    // step 0 because dctran.c:849-866's firsttime branch does
    // `goto nextTime` and skips the LTE/promotion code entirely; our
    // _stepCount === 0 early-break in MNAEngine.step() (around line 568)
    // mirrors that skip- computeNewDt and tryOrderPromotion never run on
    // step 0, so order cannot be promoted. No defensive pin needed here.
    this._acceptedSteps++;

    // deltaOld rotation removed- now performed by the engine before/inside
    // the for(;;) loop to match ngspice dctran.c:704-706, 735.
    //
    // Breakpoint pop and at-breakpoint clamp live in getClampedDt()- see
    // ngspice dctran.c:540-644 (top-of-next-step, not at-acceptance).
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
    // Skip only on step 0 (ngspice firsttime branch at dctran.c:849-866 does
    // `firsttime=0; goto nextTime;` and bypasses CKTtrunc entirely). From
    // step 1 onward ngspice runs the order-1 CKTtrunc and then the order-2
    // promotion trial at dctran.c:881-892. _acceptedSteps reflects steps
    // already accepted at step()-time, so _acceptedSteps===0 ⇔ processing
    // step 0; _acceptedSteps===1 ⇔ processing step 1, eligible for promotion.
    if (this._acceptedSteps === 0) return;

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
      // Promotion does not help- keep order 1.
      // Still update currentDt to the (clamped) trial result, matching
      // ngspice dctran.c:876 which always writes newdelta.
      this.currentDt = Math.max(
        this._params.minTimeStep,
        Math.min(this._params.maxTimeStep, rawTrialDt),
      );
      return;
    }

    // Promotion succeeds- switch to trapezoidal order 2.
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
   * Restart the transient loop with a new finalTime, preserving accepted-step
   * history (currentDt, deltaOld, currentOrder, currentMethod, _stepCount).
   *
   * **No ngspice analogue.** dctran is a one-shot function- it never
   * re-runs its prologue without re-entering the whole routine. This method
   * exists for the digiTS-specific configure() path where tStop changes
   * mid-run and the engine must reset the queue+breakFlag without
   * re-constructing the controller (which would lose step history).
   *
   * The seed itself is the same as the constructor's: queue=[0, finalTime],
   * breakFlag=true (mirrors dctran.c:140-145 + line 188 CKTbreak=1).
   */
  restartTransientLoop(finalTime: number): void {
    this._finalTime = finalTime;
    this._breakpoints = [0, finalTime];
    this._breakFlag = true;
  }

  /** ngspice cktclrbk.c- shift breakpoint array, maintaining finalTime sentinel when length collapses to 2. */
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
   * Also resets breakFlag=true so the next acceptStep dispatch sees the same
   * "we're starting fresh" CKTbreak pre-seed that the constructor establishes.
   * Public AnalogEngine API; called when the engine is asked to restart its
   * breakpoint state mid-run.
   */
  clearBreakpoints(): void {
    this._breakpoints = [0, this._finalTime];
    this._breakFlag = true;
  }

  /**
   * Push an XSPICE-style temporary breakpoint (g_mif_info.breakpoint.current).
   *
   * The next getClampedDt() call truncates dt so the step lands exactly on
   * `time` and sets _lastTempBreakpoint = simTime + dt. The call after that
   * sees AlmostEqualUlps(simTime, _lastTempBreakpoint, 100) and forces
   * CKTorder = 1 (dctran.c:542-548).
   *
   * Pass +Infinity to clear (no temp bp pending). digiTS does not yet have
   * an XSPICE event lane that drives this; the entry point exists so the
   * dctran port at getClampedDt has a real source to consult once one is
   * added. Mirrors mif_inp2.c which initializes the slot to 1e30.
   */
  setTempBreakpoint(time: number): void {
    this._tempBreakpoint = time;
  }

}
