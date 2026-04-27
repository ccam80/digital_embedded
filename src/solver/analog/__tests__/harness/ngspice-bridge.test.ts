/**
 * Tests for lteDt capture from ngspice (task 7.1.2).
 *
 * The DLL-dependent test uses describeIfDll from parity-helpers so the
 * test skips gracefully when the ngspice DLL is absent.
 *
 * The synthetic test injects RawNgspiceOuterEvent.nextDelta directly into
 * NgspiceBridge and verifies it is mapped to lteDt on the accepted iteration.
 */
import { describe, it, expect } from "vitest";
import { NgspiceBridge } from "./ngspice-bridge.js";
import { describeIfDll, DLL_PATH } from "../ngspice-parity/parity-helpers.js";
import type { RawNgspiceIterationEx, RawNgspiceOuterEvent } from "./types.js";
import { ComparisonSession } from "./comparison-session.js";

// CKTmode constants
const MODETRAN = 0x0001;
const MODEDCOP = 0x0010;

function makeRaw(overrides: Partial<RawNgspiceIterationEx> = {}): RawNgspiceIterationEx {
  return {
    iteration: 0,
    matrixSize: 1,
    rhsBufSize: 1,
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

function makeBridge(
  iters: RawNgspiceIterationEx[],
  outerEvents: RawNgspiceOuterEvent[] = [],
): NgspiceBridge {
  const bridge = new NgspiceBridge("__fake__");
  (bridge as any)._iterations = iters;
  (bridge as any)._outerEvents = outerEvents;
  (bridge as any)._topology = null;
  return bridge;
}

describe("ngspice-bridge lteDt mapping — synthetic", () => {
  it("nextDelta from accepted outer event maps to lteDt on last iteration", () => {
    const t = 1e-9;
    const expectedLteDt = 2.5e-9;
    const iters = [
      makeRaw({ simTimeStart: t, cktMode: MODETRAN, iteration: 0, converged: false, dt: 1e-9 }),
      makeRaw({ simTimeStart: t, cktMode: MODETRAN, iteration: 1, converged: true, dt: 1e-9 }),
    ];
    const outerEvents: RawNgspiceOuterEvent[] = [
      {
        simTimeStart: t,
        delta: 1e-9,
        lteRejected: 0,
        nrFailed: 0,
        accepted: 1,
        finalFailure: 0,
        nextDelta: expectedLteDt,
      },
    ];
    const bridge = makeBridge(iters, outerEvents);
    const session = bridge.getCaptureSession();

    expect(session.steps.length).toBe(1);
    const step = session.steps[0]!;
    const acceptedAttempt = step.attempts[step.acceptedAttemptIndex]!;
    expect(acceptedAttempt.iterations.length).toBeGreaterThan(0);
    const lastIter = acceptedAttempt.iterations[acceptedAttempt.iterations.length - 1]!;
    expect(lastIter.lteDt).toBe(expectedLteDt);
  });

  it("lteRejected outer event does NOT set lteDt (non-positive nextDelta excluded)", () => {
    const t = 1e-9;
    const iters = [
      makeRaw({ simTimeStart: t, cktMode: MODETRAN, iteration: 0, converged: true, dt: 1e-9 }),
    ];
    const outerEvents: RawNgspiceOuterEvent[] = [
      {
        simTimeStart: t,
        delta: 1e-9,
        lteRejected: 1,
        nrFailed: 0,
        accepted: 0,
        finalFailure: 0,
        nextDelta: 0,
      },
    ];
    const bridge = makeBridge(iters, outerEvents);
    const session = bridge.getCaptureSession();

    expect(session.steps.length).toBe(1);
    const step = session.steps[0]!;
    const acceptedAttempt = step.attempts[step.acceptedAttemptIndex]!;
    const lastIter = acceptedAttempt.iterations[acceptedAttempt.iterations.length - 1]!;
    expect(lastIter.lteDt).toBeUndefined();
  });

  it("no outer event → lteDt is undefined on last iteration", () => {
    const t = 3e-9;
    const iters = [
      makeRaw({ simTimeStart: t, cktMode: MODETRAN, iteration: 0, converged: true, dt: 1e-9 }),
    ];
    const bridge = makeBridge(iters, []);
    const session = bridge.getCaptureSession();

    const step = session.steps[0]!;
    const acceptedAttempt = step.attempts[step.acceptedAttemptIndex]!;
    const lastIter = acceptedAttempt.iterations[acceptedAttempt.iterations.length - 1]!;
    expect(lastIter.lteDt).toBeUndefined();
  });
});

describeIfDll("lteDt_captured_from_ngspice — DLL required", () => {
  it("lteDt present on every accepted outer step from real ngspice run", async () => {
    const session = new ComparisonSession({
      dtsPath: "fixtures/rlc-transient.dts",
      dllPath: DLL_PATH,
      maxOurSteps: 50,
    });
    await session.init();
    await session.runTransient(0, 2e-6, 1e-7);

    const ngSteps = session.ngspiceSession!.steps;
    expect(ngSteps.length).toBeGreaterThan(0);

    const tranSteps = ngSteps.filter(
      (s) => s.analysisPhase === "tranFloat" || s.analysisPhase === "tranInit",
    );
    expect(tranSteps.length).toBeGreaterThan(0);

    for (const step of tranSteps) {
      const accepted = step.attempts[step.acceptedAttemptIndex];
      if (!accepted || accepted.iterations.length === 0) continue;
      const lastIter = accepted.iterations[accepted.iterations.length - 1]!;
      expect(
        lastIter.lteDt,
        `ngspice step at t=${step.stepStartTime}: expected lteDt to be set`,
      ).toBeDefined();
      expect(
        Number.isFinite(lastIter.lteDt!),
        `ngspice step at t=${step.stepStartTime}: lteDt=${lastIter.lteDt} should be finite`,
      ).toBe(true);
      expect(
        lastIter.lteDt! > 0,
        `ngspice step at t=${step.stepStartTime}: lteDt=${lastIter.lteDt} should be positive`,
      ).toBe(true);
    }
  }, 60_000);
});
