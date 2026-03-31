/**
 * Adaptive timestep controller for the MNA transient solver.
 *
 * Implements local truncation error (LTE) based timestep control with:
 *  - Safety factor 0.9 applied to all computed dt predictions
 *  - Clamping to [dt/4, 4*dt] per step, then to [minTimeStep, maxTimeStep]
 *  - Breakpoint support for exact landing at registered simulation times
 *  - Timestep rejection with halving when LTE ratio r < 1
 *  - Automatic integration method switching: BDF-1 → trapezoidal → BDF-2 (on
 *    ringing) → trapezoidal (after 5 stable BDF-2 steps)
 */

import type { AnalogElement, IntegrationMethod } from "./element.js";
import type { SimulationParams } from "../../core/analog-engine-interface.js";
import type { HistoryStore } from "./integration.js";

// ---------------------------------------------------------------------------
// TimestepController
// ---------------------------------------------------------------------------

/**
 * Controls adaptive timestepping for the MNA transient solver.
 *
 * Call sequence per accepted timestep:
 *   1. computeNewDt(elements, history) → proposed next dt
 *   2. shouldReject(r) — r is tolerance / maxError from computeNewDt
 *   3. If rejected: reject() → halved dt, retry
 *   4. If accepted: accept(simTime), checkMethodSwitch(elements, history)
 */
export class TimestepController {
  /** Current timestep in seconds. */
  currentDt: number;

  /** Current integration method. */
  currentMethod: IntegrationMethod;

  private _params: SimulationParams;

  /** Sorted ascending list of registered breakpoint times. */
  private _breakpoints: number[];

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

  constructor(params: SimulationParams) {
    this._params = params;
    this.currentDt = params.maxTimeStep;
    this.currentMethod = "bdf1";
    this._breakpoints = [];
    this._acceptedSteps = 0;
    this._signHistory = [];
    this._stableOnBdf2 = 0;
    this._largestErrorElement = undefined;
  }

  /**
   * Index of the reactive element with the largest LTE in the last
   * `computeNewDt` call. `undefined` when no reactive elements are present.
   */
  get largestErrorElement(): number | undefined {
    return this._largestErrorElement;
  }

  // -------------------------------------------------------------------------
  // LTE-based timestep computation
  // -------------------------------------------------------------------------

  /**
   * Compute the proposed next timestep based on local truncation error estimates.
   *
   * Iterates all reactive elements that implement `getLteEstimate`, takes the
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
   * @returns Proposed next dt in seconds
   */
  computeNewDt(
    elements: readonly AnalogElement[],
    _history: HistoryStore,
    simTime: number = 0,
  ): number {
    const dt = this.currentDt;
    const tol = this._params.chargeTol;

    let maxError = 0;
    let maxErrorIdx = -1;

    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      if (!el.isReactive || typeof el.getLteEstimate !== "function") continue;
      const { truncationError } = el.getLteEstimate(dt);
      if (truncationError > maxError) {
        maxError = truncationError;
        maxErrorIdx = i;
      }
    }

    this._largestErrorElement = maxErrorIdx >= 0 ? maxErrorIdx : undefined;

    let newDt: number;
    if (maxError <= 0) {
      // No reactive elements or all errors are zero — hold current dt.
      newDt = dt;
    } else {
      // LTE control formula with 0.9 safety factor.
      const ratio = tol / maxError;
      const scale = 0.9 * Math.pow(ratio, 1 / 3);
      newDt = dt * scale;

      // Clamp step change to [1/4, 4] of current dt.
      newDt = Math.max(dt / 4, Math.min(4 * dt, newDt));
    }

    // Clamp to solver bounds.
    newDt = Math.max(this._params.minTimeStep, Math.min(this._params.maxTimeStep, newDt));

    // Clamp to next breakpoint.
    if (this._breakpoints.length > 0) {
      const nextBp = this._breakpoints[0];
      const remaining = nextBp - simTime;
      if (remaining > 0 && newDt > remaining) {
        newDt = remaining;
      }
    }

    return newDt;
  }

  // -------------------------------------------------------------------------
  // Rejection
  // -------------------------------------------------------------------------

  /**
   * Returns true when the LTE ratio `r = tolerance / maxError` is less than 1,
   * meaning the current step must be rejected.
   *
   * @param r - LTE ratio (tolerance / error)
   */
  shouldReject(r: number): boolean {
    return r < 1;
  }

  /**
   * Reject the current timestep: halve dt, clamp to minTimeStep.
   *
   * @returns The new (halved) dt in seconds
   */
  reject(): number {
    this.currentDt = Math.max(this._params.minTimeStep, this.currentDt / 2);
    return this.currentDt;
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
    this._acceptedSteps++;
    this._updateMethodForStartup();

    // Pop breakpoints that have been reached.
    while (this._breakpoints.length > 0 && simTime >= this._breakpoints[0]) {
      this._breakpoints.shift();
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
    // Startup BDF-1 phase: no ringing detection — method set by _updateMethodForStartup.
    if (this._acceptedSteps <= 2) return;

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
        this._stableOnBdf2 = 0;
      }
    } else if (this.currentMethod === "bdf2") {
      this._stableOnBdf2++;
      if (this._stableOnBdf2 >= 5) {
        this.currentMethod = "trapezoidal";
        this._stableOnBdf2 = 0;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Breakpoints
  // -------------------------------------------------------------------------

  /**
   * Register a simulation time at which the timestep controller must land a
   * step exactly. Inserted into the sorted breakpoint list.
   *
   * @param time - Breakpoint time in seconds
   */
  addBreakpoint(time: number): void {
    // Insert in sorted order.
    let lo = 0;
    let hi = this._breakpoints.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this._breakpoints[mid] < time) lo = mid + 1;
      else hi = mid;
    }
    this._breakpoints.splice(lo, 0, time);
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
   * Apply the startup state machine for the first 2 accepted steps.
   *
   * Steps 1-2: BDF-1 (suppress startup transients).
   * Step 3+:   trapezoidal (unless ringing detection upgrades to BDF-2).
   */
  private _updateMethodForStartup(): void {
    if (this._acceptedSteps <= 2) {
      this.currentMethod = "bdf1";
    } else if (this.currentMethod === "bdf1") {
      // First transition out of startup.
      this.currentMethod = "trapezoidal";
    }
    // Subsequent method changes are handled by checkMethodSwitch.
  }
}
