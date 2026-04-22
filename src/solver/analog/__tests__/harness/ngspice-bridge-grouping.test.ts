/**
 * Unit tests for the §6.1 ngspice grouping state machine.
 *
 * No FFI, no DLL. Injects synthetic RawNgspiceIterationEx[] directly into
 * NgspiceBridge._iterations and calls getCaptureSession() to exercise the
 * grouping logic (stepStartTime keying, attempt boundaries, outcome assignment).
 */

import { describe, it, expect } from "vitest";
import { NgspiceBridge } from "./ngspice-bridge.js";
import type { RawNgspiceIterationEx, RawNgspiceOuterEvent } from "./types.js";

// CKTmode constants (mirror of ngspice-bridge.ts internal constants)
// Values from ref/ngspice/src/include/ngspice/cktdefs.h:166-182
const MODETRAN      = 0x0001;
const MODEDCOP      = 0x0010;
const MODETRANOP    = 0x0020;
// Real ngspice sets MODEINITFLOAT alongside MODEDCOP / MODETRANOP during the
// dcopDirect / transient-OP iterations (cktop.c transitions through
// INITJCT → INITFIX → INITFLOAT and leaves INITFLOAT set for subsequent
// sub-solves). Synthetic fixtures below must mirror that bit pattern so
// `bitsToName()` (ckt-mode.ts) produces the expected decoded cktMode label.

function makeRaw(overrides: Partial<RawNgspiceIterationEx> = {}): RawNgspiceIterationEx {
  return {
    iteration: 0,
    matrixSize: 1,
    rhs: new Float64Array([0]),
    rhsOld: new Float64Array([0]),
    preSolveRhs: new Float64Array([0]),
    state0: new Float64Array(0),
    state1: new Float64Array(0),
    state2: new Float64Array(0),
    numStates: 0,
    noncon: 0,
    converged: true,
    simTime: 0,
    simTimeStart: 0,
    dt: 0,
    cktMode: MODEDCOP,
    ag0: 0,
    ag1: 0,
    integrateMethod: 0,
    order: 1,
    phaseFlags: 0,
    phaseGmin: 0,
    phaseSrcFact: 1,
    matrix: [],
    ngspiceConvergenceFailedDevices: [],
    limitingEvents: [],
    ...overrides,
  };
}

function makeBridge(iters: RawNgspiceIterationEx[], outerEvents: RawNgspiceOuterEvent[] = []): NgspiceBridge {
  // NgspiceBridge requires a DLL path but we never call init() — we inject directly.
  const bridge = new NgspiceBridge("__fake__");
  (bridge as any)._iterations = iters;
  (bridge as any)._outerEvents = outerEvents;
  (bridge as any)._topology = null;
  return bridge;
}

describe("ngspice-bridge grouping — §6.1 state machine", () => {

  it("single DCOP iteration → one step, one attempt, stepStartTime=0", () => {
    const iters = [makeRaw({ simTimeStart: 0, cktMode: MODEDCOP, iteration: 0, converged: true })];
    const bridge = makeBridge(iters);
    const session = bridge.getCaptureSession();
    expect(session.steps.length).toBe(1);
    expect(session.steps[0].stepStartTime).toBe(0);
    expect(session.steps[0].attempts.length).toBe(1);
    expect(session.steps[0].attempts[0].phase).toBe("dcopDirect");
    expect(session.steps[0].attempts[0].converged).toBe(true);
  });

  it("two DCOP iterations (same simTimeStart) → one step, one attempt with 2 iters", () => {
    const iters = [
      makeRaw({ simTimeStart: 0, cktMode: MODEDCOP, iteration: 0, converged: false }),
      makeRaw({ simTimeStart: 0, cktMode: MODEDCOP, iteration: 1, converged: true }),
    ];
    const bridge = makeBridge(iters);
    const session = bridge.getCaptureSession();
    expect(session.steps.length).toBe(1);
    expect(session.steps[0].attempts.length).toBe(1);
    expect(session.steps[0].attempts[0].iterations.length).toBe(2);
  });

  it("two distinct simTimeStart values → two steps", () => {
    const iters = [
      makeRaw({ simTimeStart: 0,    cktMode: MODEDCOP,  iteration: 0, converged: true, dt: 0 }),
      makeRaw({ simTimeStart: 1e-9, cktMode: MODETRAN,  iteration: 0, converged: true, dt: 1e-9 }),
    ];
    const bridge = makeBridge(iters);
    const session = bridge.getCaptureSession();
    expect(session.steps.length).toBe(2);
    expect(session.steps[0].stepStartTime).toBe(0);
    expect(session.steps[1].stepStartTime).toBe(1e-9);
  });

  it("iteration counter reset → new attempt within same step", () => {
    // Two NR attempts at same stepStartTime: iter 0,1,2 then reset to 0,1
    const t = 1e-9;
    const iters = [
      makeRaw({ simTimeStart: t, cktMode: MODETRAN, iteration: 0, converged: false, dt: 1e-9 }),
      makeRaw({ simTimeStart: t, cktMode: MODETRAN, iteration: 1, converged: false, dt: 1e-9 }),
      // NR failed — iteration resets to 0 for retry
      makeRaw({ simTimeStart: t, cktMode: MODETRAN, iteration: 0, converged: false, dt: 5e-10 }),
      makeRaw({ simTimeStart: t, cktMode: MODETRAN, iteration: 1, converged: true,  dt: 5e-10 }),
    ];
    const bridge = makeBridge(iters);
    const session = bridge.getCaptureSession();
    expect(session.steps.length).toBe(1);
    // Two attempts: first failed (iter reset boundary), second accepted
    expect(session.steps[0].attempts.length).toBe(2);
    expect(session.steps[0].attempts[0].iterations.length).toBe(2);
    expect(session.steps[0].attempts[1].iterations.length).toBe(2);
  });

  it("phase change → new attempt boundary within same step", () => {
    // DCOP direct → gmin dynamic within same step (simTimeStart=0)
    const iters = [
      makeRaw({ simTimeStart: 0, cktMode: MODEDCOP, phaseFlags: 0,   iteration: 0, converged: false }),
      makeRaw({ simTimeStart: 0, cktMode: MODEDCOP, phaseFlags: 0x1, iteration: 0, converged: true  }),
    ];
    const bridge = makeBridge(iters);
    const session = bridge.getCaptureSession();
    expect(session.steps.length).toBe(1);
    // Phase change from dcopDirect → dcopGminDynamic creates a new attempt
    expect(session.steps[0].attempts.length).toBe(2);
    expect(session.steps[0].attempts[0].phase).toBe("dcopDirect");
    expect(session.steps[0].attempts[1].phase).toBe("dcopGminDynamic");
  });

  it("outer event lteRejected sets outcome on the attempt", () => {
    const t = 1e-9;
    const iters = [
      makeRaw({ simTimeStart: t, cktMode: MODETRAN, iteration: 0, converged: true, dt: 1e-9 }),
    ];
    const outerEvents: RawNgspiceOuterEvent[] = [
      { simTimeStart: t, delta: 1e-9, lteRejected: 1, nrFailed: 0, accepted: 0, finalFailure: 0, nextDelta: 5e-10 },
    ];
    const bridge = makeBridge(iters, outerEvents);
    const session = bridge.getCaptureSession();
    expect(session.steps.length).toBe(1);
    expect(session.steps[0].attempts[0].outcome).toBe("lteRejectedRetry");
  });

  it("outer event accepted sets outcome=accepted on final attempt", () => {
    const t = 2e-9;
    const iters = [
      makeRaw({ simTimeStart: t, cktMode: MODETRAN, iteration: 0, converged: true, dt: 1e-9 }),
    ];
    const outerEvents: RawNgspiceOuterEvent[] = [
      { simTimeStart: t, delta: 1e-9, lteRejected: 0, nrFailed: 0, accepted: 1, finalFailure: 0, nextDelta: 1e-9 },
    ];
    const bridge = makeBridge(iters, outerEvents);
    const session = bridge.getCaptureSession();
    expect(session.steps[0].attempts[0].outcome).toBe("accepted");
  });

  it("three transient steps → three steps with correct stepStartTimes", () => {
    const iters = [
      makeRaw({ simTimeStart: 0,    cktMode: MODETRANOP, iteration: 0, converged: true, dt: 1e-9 }),
      makeRaw({ simTimeStart: 1e-9, cktMode: MODETRAN,   iteration: 0, converged: true, dt: 1e-9 }),
      makeRaw({ simTimeStart: 2e-9, cktMode: MODETRAN,   iteration: 0, converged: true, dt: 1e-9 }),
    ];
    const bridge = makeBridge(iters);
    const session = bridge.getCaptureSession();
    expect(session.steps.length).toBe(3);
    expect(session.steps[0].stepStartTime).toBe(0);
    expect(session.steps[1].stepStartTime).toBe(1e-9);
    expect(session.steps[2].stepStartTime).toBe(2e-9);
  });

  it("empty iteration stream → zero steps", () => {
    const bridge = makeBridge([]);
    const session = bridge.getCaptureSession();
    expect(session.steps.length).toBe(0);
  });

  it("DCOP multi-sub-solve (gmin stepping) → single step, multiple attempts", () => {
    // Gmin stepping: each sub-solve has phaseFlags bit0 set, iteration resets
    const iters = [
      makeRaw({ simTimeStart: 0, cktMode: MODEDCOP, phaseFlags: 0x1, phaseGmin: 1e-3, iteration: 0, converged: true }),
      makeRaw({ simTimeStart: 0, cktMode: MODEDCOP, phaseFlags: 0x1, phaseGmin: 1e-4, iteration: 0, converged: true }),
      makeRaw({ simTimeStart: 0, cktMode: MODEDCOP, phaseFlags: 0x1, phaseGmin: 0,    iteration: 0, converged: true }),
    ];
    const bridge = makeBridge(iters);
    const session = bridge.getCaptureSession();
    expect(session.steps.length).toBe(1);
    expect(session.steps[0].stepStartTime).toBe(0);
    // All three sub-solves are in the gminDynamic phase — each iteration reset creates a new attempt
    expect(session.steps[0].attempts.length).toBe(3);
  });

  it("DCOP multi-attempt step: totalIterationCount > iterationCount", () => {
    const iters = [
      makeRaw({ simTimeStart: 0, cktMode: MODEDCOP, phaseFlags: 0x1, phaseGmin: 1e-3, iteration: 0, converged: false }),
      makeRaw({ simTimeStart: 0, cktMode: MODEDCOP, phaseFlags: 0x1, phaseGmin: 1e-3, iteration: 1, converged: false }),
      makeRaw({ simTimeStart: 0, cktMode: MODEDCOP, phaseFlags: 0x1, phaseGmin: 1e-3, iteration: 2, converged: true }),
      makeRaw({ simTimeStart: 0, cktMode: MODEDCOP, phaseFlags: 0x2, phaseSrcFact: 0.5, iteration: 0, converged: false }),
      makeRaw({ simTimeStart: 0, cktMode: MODEDCOP, phaseFlags: 0x2, phaseSrcFact: 0.5, iteration: 1, converged: true }),
      makeRaw({ simTimeStart: 0, cktMode: MODEDCOP, phaseFlags: 0,   iteration: 0, converged: true }),
    ];
    const bridge = makeBridge(iters);
    const session = bridge.getCaptureSession();
    expect(session.steps.length).toBe(1);
    const step = session.steps[0];
    expect(step.attempts.length).toBeGreaterThanOrEqual(2);
    const sumOfAttempts = step.attempts.reduce((s, a) => s + a.iterationCount, 0);
    expect(step.totalIterationCount).toBe(sumOfAttempts);
    expect(step.totalIterationCount).toBeGreaterThan(step.iterationCount);
  });

  it("single-attempt step: totalIterationCount === iterationCount", () => {
    const iters = [
      makeRaw({ simTimeStart: 0, cktMode: MODEDCOP, iteration: 0, converged: false }),
      makeRaw({ simTimeStart: 0, cktMode: MODEDCOP, iteration: 1, converged: false }),
      makeRaw({ simTimeStart: 0, cktMode: MODEDCOP, iteration: 2, converged: true }),
    ];
    const bridge = makeBridge(iters);
    const session = bridge.getCaptureSession();
    expect(session.steps.length).toBe(1);
    const step = session.steps[0];
    expect(step.attempts.length).toBe(1);
    expect(step.totalIterationCount).toBe(step.iterationCount);
  });
});
