/**
 * Unit tests for TimestepController.
 *
 * Tests cover:
 *  - LTE-based adaptive timestep computation (safety factor, clamping, element tracking)
 *  - Timestep rejection logic (shouldReject)
 *  - Integration method auto-switching state machine
 *  - Breakpoint clamping and removal
 */

import { describe, it, expect } from "vitest";
import { TimestepController } from "../timestep.js";
import { HistoryStore } from "../integration.js";
import type { AnalogElement, IntegrationMethod } from "../element.js";
import type { SimulationParams } from "../../../core/analog-engine-interface.js";
import type { SparseSolver } from "../sparse-solver.js";
import type { LteParams } from "../ckt-terr.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default simulation params matching SimulationParams defaults. */
const DEFAULT_PARAMS: SimulationParams = {
  maxTimeStep: 5e-6,
  minTimeStep: 1e-14,
  reltol: 1e-3,
  abstol: 1e-6,
  iabstol: 1e-12,
  chargeTol: 1e-14,
  trtol: 7.0,
  maxIterations: 100,
  transientMaxIterations: 10,
  integrationMethod: "auto",
  dcTrcvMaxIter: 50,
  gmin: 1e-12,
  nodeDamping: false,
};

/**
 * Create a minimal reactive element that returns a fixed LTE estimate.
 *
 * isReactive = true, getLteTimestep computes a new dt from the given truncationError
 * using the ngspice composite `local_tol = trtol · chgtol` (toleranceReference=0
 * so the reltol term vanishes) — this keeps the rejection/ratio math easy to
 * reason about in tests.
 */
function makeReactiveElement(truncationError: number): AnalogElement {
  return {
    pinNodeIds: [1, 0],
    allNodeIds: [1, 0],
    branchIndex: -1,
    isNonlinear: false,
    isReactive: true,
    stamp(_solver: SparseSolver): void {},
    getLteTimestep(
      dt: number,
      _deltaOld: readonly number[],
      _order: number,
      _method: IntegrationMethod,
      lteParams: LteParams,
    ): number {
      const localTol = lteParams.trtol * lteParams.chgtol;
      const ratio = truncationError / localTol;
      if (ratio <= 0) return Infinity;
      return 0.9 * dt * Math.pow(1 / ratio, 1 / 3);
    },
    setParam(_key: string, _value: number): void {},
    getPinCurrents(_v: Float64Array): number[] { return [0, 0]; },
  };
}

// ---------------------------------------------------------------------------
// LTE tests
// ---------------------------------------------------------------------------

describe("LTE", () => {
  it("reduces_dt_for_large_error", () => {
    const params: SimulationParams = { ...DEFAULT_PARAMS, chargeTol: 1e-14 };
    const ctrl = new TimestepController(params);
    const dt = ctrl.currentDt; // 5e-6

    // LTE error much larger than tolerance → r < 1 → dt should shrink
    const bigError = 1e-10; // 10000× larger than chargeTol
    const elements = [makeReactiveElement(bigError)];
    const history = new HistoryStore(1);

    const { newDt } = ctrl.computeNewDt(elements, history, 0);

    expect(newDt).toBeLessThan(dt);
  });

  it("increases_dt_for_small_error", () => {
    // Use maxTimeStep large enough that clamping to maxTimeStep does not interfere.
    const params: SimulationParams = { ...DEFAULT_PARAMS, maxTimeStep: 1e-3, chargeTol: 1e-14 };
    const ctrl = new TimestepController(params);
    // Start at a small dt so there is room to grow.
    ctrl.currentDt = 1e-6;
    const dt = ctrl.currentDt;

    // LTE error much smaller than tolerance → worstRatio << 1 → dt should grow
    // But capped at 4× current dt.
    const tinyError = 1e-20;
    const elements = [makeReactiveElement(tinyError)];
    const history = new HistoryStore(1);

    const { newDt } = ctrl.computeNewDt(elements, history, 0);

    // Should be larger than current dt, capped at 4× (4us < maxTimeStep=1ms)
    expect(newDt).toBeGreaterThan(dt);
    expect(newDt).toBeLessThanOrEqual(4 * dt);
  });

  it("clamps_to_bounds", () => {
    const params: SimulationParams = {
      ...DEFAULT_PARAMS,
      minTimeStep: 1e-14,
      maxTimeStep: 5e-6,
      chargeTol: 1e-14,
    };
    const ctrl = new TimestepController(params);

    // Extremely large error — would push dt far below minTimeStep
    const hugeError = 1e10;
    const elements = [makeReactiveElement(hugeError)];
    const history = new HistoryStore(1);

    const { newDt: newDtSmall } = ctrl.computeNewDt(elements, history, 0);
    expect(newDtSmall).toBeGreaterThanOrEqual(params.minTimeStep);

    // Extremely small error — would push dt far above maxTimeStep
    const tinyError = 1e-30;
    const elements2 = [makeReactiveElement(tinyError)];
    const { newDt: newDtLarge } = ctrl.computeNewDt(elements2, history, 0);
    expect(newDtLarge).toBeLessThanOrEqual(params.maxTimeStep);
  });

  it("safety_factor_0_9", () => {
    const chargeTol = 1e-14;
    const trtol = 7.0;
    const params: SimulationParams = { ...DEFAULT_PARAMS, chargeTol, trtol };
    const ctrl = new TimestepController(params);
    const dt = ctrl.currentDt; // 5e-6

    // With toleranceReference=0 in the test element, the ngspice composite
    // tolerance collapses to localTol = trtol · chargeTol. Choose an error
    // such that ratio = error/localTol stays within the [dt/4, 4*dt] clamp.
    // error = 8 · localTol  →  ratio = 8  →  scale = 0.9 · (1/8)^(1/3) = 0.45
    // newDt ≈ 2.25e-6 (within bounds).
    const localTol = trtol * chargeTol;
    const error = localTol * 8;
    const elements = [makeReactiveElement(error)];
    const history = new HistoryStore(1);

    const { newDt } = ctrl.computeNewDt(elements, history, 0);

    const expected = 0.9 * dt * Math.pow(localTol / error, 1 / 3);
    expect(newDt).toBeCloseTo(expected, 12);
  });

  it("largest_error_element_tracked", () => {
    const params: SimulationParams = { ...DEFAULT_PARAMS };
    const ctrl = new TimestepController(params);

    // Two reactive elements: element 0 has small error, element 1 has large error
    const el0 = makeReactiveElement(1e-20);
    const el1 = makeReactiveElement(1e-10);
    const elements = [el0, el1];
    const history = new HistoryStore(2);

    ctrl.computeNewDt(elements, history, 0);

    // Element at index 1 has the largest LTE
    expect(ctrl.largestErrorElement).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Rejection tests
// ---------------------------------------------------------------------------

describe("Rejection", () => {
  it("shouldReject_true_when_worstRatio_gt_1", () => {
    // Threshold is 1/0.9 ≈ 1.111 — values at or above this are rejected.
    const ctrl = new TimestepController(DEFAULT_PARAMS);
    expect(ctrl.shouldReject(1.2)).toBe(true);
    expect(ctrl.shouldReject(2.0)).toBe(true);
    expect(ctrl.shouldReject(100)).toBe(true);
  });

  it("shouldReject_false_within_hysteresis_band", () => {
    // Values below threshold (1/0.9 ≈ 1.111) are accepted — hysteresis band.
    const ctrl = new TimestepController(DEFAULT_PARAMS);
    // worstRatio == 1.05: below threshold → accept (within hysteresis band)
    expect(ctrl.shouldReject(1.05)).toBe(false);
    // worstRatio == 1.0: tolerance exactly met → accept
    expect(ctrl.shouldReject(1.0)).toBe(false);
  });

  it("shouldReject_false_when_worstRatio_le_1", () => {
    const ctrl = new TimestepController(DEFAULT_PARAMS);
    // worstRatio == 0: no reactive errors → accept
    expect(ctrl.shouldReject(0)).toBe(false);
    // worstRatio == 1: tolerance exactly met → accept
    expect(ctrl.shouldReject(1.0)).toBe(false);
    // worstRatio slightly below 1 → accept
    expect(ctrl.shouldReject(0.99)).toBe(false);
  });

});

// ---------------------------------------------------------------------------
// Auto-switch tests
// ---------------------------------------------------------------------------

describe("AutoSwitch", () => {
  it("starts_with_bdf1", () => {
    const ctrl = new TimestepController(DEFAULT_PARAMS);
    expect(ctrl.currentMethod).toBe("bdf1");
  });

  it("switches_to_trapezoidal_after_2_steps", () => {
    const ctrl = new TimestepController(DEFAULT_PARAMS);
    const history = new HistoryStore(0);
    const elements: AnalogElement[] = [];

    // Two accepted steps — still BDF-1 during these
    ctrl.accept(1e-6);
    ctrl.checkMethodSwitch(elements, history);
    expect(ctrl.currentMethod).toBe("bdf1");

    ctrl.accept(2e-6);
    ctrl.checkMethodSwitch(elements, history);
    expect(ctrl.currentMethod).toBe("bdf1");

    // Third accepted step — transitions to trapezoidal
    ctrl.accept(3e-6);
    ctrl.checkMethodSwitch(elements, history);
    expect(ctrl.currentMethod).toBe("trapezoidal");
  });

  it("detects_ringing_switches_to_bdf2", () => {
    const ctrl = new TimestepController(DEFAULT_PARAMS);

    // Advance past startup BDF-1 phase (2 accepted steps)
    const emptyHistory = new HistoryStore(0);
    ctrl.accept(1e-6);
    ctrl.checkMethodSwitch([], emptyHistory);
    ctrl.accept(2e-6);
    ctrl.checkMethodSwitch([], emptyHistory);
    expect(ctrl.currentMethod).toBe("bdf1");
    ctrl.accept(3e-6);
    ctrl.checkMethodSwitch([], emptyHistory);
    expect(ctrl.currentMethod).toBe("trapezoidal");

    // Now feed alternating-sign voltages across 3 steps to trigger ringing.
    // The reactive element is at index 0; HistoryStore.get(0,0) reads v(n).
    // We push alternating signs: +1, -1, +1 over 3 accepted steps.
    const reactiveEl = makeReactiveElement(0); // LTE not used here
    const elements = [reactiveEl];

    // Step 4: push +1
    const h1 = new HistoryStore(1);
    h1.push(0, 1.0);
    ctrl.accept(4e-6);
    ctrl.checkMethodSwitch(elements, h1);

    // Step 5: push -1
    const h2 = new HistoryStore(1);
    h2.push(0, -1.0);
    ctrl.accept(5e-6);
    ctrl.checkMethodSwitch(elements, h2);

    // Step 6: push +1 — 3rd sign: [+,-,+] → ringing detected
    const h3 = new HistoryStore(1);
    h3.push(0, 1.0);
    ctrl.accept(6e-6);
    ctrl.checkMethodSwitch(elements, h3);

    expect(ctrl.currentMethod).toBe("bdf2");
  });

  it("returns_to_trapezoidal_after_5_stable", () => {
    const ctrl = new TimestepController(DEFAULT_PARAMS);

    // Fast-forward past startup and trigger BDF-2 via ringing.
    const emptyHistory = new HistoryStore(0);
    ctrl.accept(1e-6); ctrl.checkMethodSwitch([], emptyHistory);
    ctrl.accept(2e-6); ctrl.checkMethodSwitch([], emptyHistory);
    ctrl.accept(3e-6); ctrl.checkMethodSwitch([], emptyHistory);

    const reactiveEl = makeReactiveElement(0);
    const elements = [reactiveEl];

    const hPos = new HistoryStore(1);
    hPos.push(0, 1.0);
    const hNeg = new HistoryStore(1);
    hNeg.push(0, -1.0);

    // Trigger ringing: +, -, + over steps 4-6
    ctrl.accept(4e-6); ctrl.checkMethodSwitch(elements, hPos);
    ctrl.accept(5e-6); ctrl.checkMethodSwitch(elements, hNeg);

    // Third sign: + → [+,-,+] triggers ringing switch to BDF-2
    const hPos2 = new HistoryStore(1);
    hPos2.push(0, 1.0);
    ctrl.accept(6e-6); ctrl.checkMethodSwitch(elements, hPos2);
    expect(ctrl.currentMethod).toBe("bdf2");

    // Now feed 5 consecutive non-oscillating steps (all positive = no alternation)
    for (let i = 7; i <= 11; i++) {
      const hStable = new HistoryStore(1);
      hStable.push(0, 1.0);
      ctrl.accept(i * 1e-6);
      ctrl.checkMethodSwitch(elements, hStable);
    }

    expect(ctrl.currentMethod).toBe("trapezoidal");
  });
});

// ---------------------------------------------------------------------------
// Breakpoint tests
// ---------------------------------------------------------------------------

describe("Breakpoints", () => {
  it("clamps_dt_to_breakpoint", () => {
    const params: SimulationParams = { ...DEFAULT_PARAMS, maxTimeStep: 5e-6 };
    const ctrl = new TimestepController(params);

    // Add breakpoint at t = 100us
    ctrl.addBreakpoint(100e-6);

    // With simTime = 95us and an element that would suggest a large dt:
    // remaining = 100e-6 - 95e-6 = 5e-6
    // Use a tiny error so computeNewDt would suggest maxTimeStep = 5e-6...
    // but we need it to be clamped to exactly 5us remaining.
    // Set params.maxTimeStep to 20e-6 to see clamping.
    const params2: SimulationParams = { ...DEFAULT_PARAMS, maxTimeStep: 20e-6, minTimeStep: 1e-14, chargeTol: 1e-14 };
    const ctrl2 = new TimestepController(params2);
    ctrl2.currentDt = 10e-6;
    ctrl2.addBreakpoint(100e-6);

    const elements = [makeReactiveElement(0)]; // no error → dt stays at currentDt = 10us
    const history = new HistoryStore(1);

    const simTime = 95e-6;
    const { newDt } = ctrl2.computeNewDt(elements, history, simTime);

    // Remaining to breakpoint = 100e-6 - 95e-6 = 5e-6; dt should be clamped to 5us
    expect(newDt).toBeCloseTo(5e-6, 12);
  });

  it("pops_breakpoint_on_accept", () => {
    const ctrl = new TimestepController(DEFAULT_PARAMS);
    ctrl.addBreakpoint(100e-6);

    // Accept at simTime = 100us — breakpoint should be popped
    ctrl.accept(100e-6);

    // After popping, computeNewDt should not clamp to that breakpoint anymore
    const elements = [makeReactiveElement(0)];
    const history = new HistoryStore(1);
    ctrl.currentDt = 5e-6;
    const { newDt } = ctrl.computeNewDt(elements, history, 100e-6);

    // No breakpoint remaining → dt is unclamped (should equal currentDt = 5e-6, no scaling for zero error)
    expect(newDt).toBe(5e-6);
  });

  it("clear_removes_all", () => {
    const params: SimulationParams = { ...DEFAULT_PARAMS, maxTimeStep: 20e-6 };
    const ctrl = new TimestepController(params);
    ctrl.currentDt = 10e-6;

    // Add 3 breakpoints
    ctrl.addBreakpoint(2e-6);
    ctrl.addBreakpoint(5e-6);
    ctrl.addBreakpoint(8e-6);

    // Clear all breakpoints
    ctrl.clearBreakpoints();

    // With no reactive elements (zero error), dt stays at currentDt = 10us,
    // and no breakpoint clamping applies.
    const elements = [makeReactiveElement(0)];
    const history = new HistoryStore(1);
    const { newDt } = ctrl.computeNewDt(elements, history, 0);

    // With no reactive elements, step grows by 2x toward maxTimeStep
    expect(newDt).toBe(20e-6);
  });
});
