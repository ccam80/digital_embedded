/**
 * Task 7.2.3- BJT common-emitter DC-OP parity
 *
 * NPN BJT with biasing resistors. Tests multi-junction limiting and
 * (if required for convergence) gmin stepping.
 *
 * Circuit: V_CC=5V at vcc, R_C=1kΩ vcc→collector, R_B=100kΩ vcc→base,
 * Q1 NPN BJT (Is=1e-14, Bf=100, Br=1) collector→base→emitter=gnd.
 */
import { it, expect } from "vitest";
import { resolve } from "path";
import { ComparisonSession } from "../harness/comparison-session.js";
import {
  describeIfDll,
  DLL_PATH,
  assertIterationMatch,
  assertModeTransitionMatch,
  assertConvergenceFlowMatch,
} from "./parity-helpers.js";

const DTS_PATH = resolve(
  process.cwd(),
  "src/solver/analog/__tests__/ngspice-parity/fixtures/bjt-common-emitter.dts",
);

describeIfDll("bjt-common-emitter DC-OP parity", () => {
  it("dc_op_match", async () => {
    const session = new ComparisonSession({
      dtsPath: DTS_PATH,
      dllPath: DLL_PATH,
    });

    await session.init();
    await session.runDcOp();

    const ours = session.ourSession!;
    const ngspice = session.ngspiceSessionAligned ?? session.ngspiceSession!;

    // Per-iteration comparison across all steps and attempts
    for (let si = 0; si < ours.steps.length; si++) {
      const ourStep = ours.steps[si]!;
      const ngStep = ngspice.steps[si];
      if (!ngStep) continue;

      for (let ai = 0; ai < ourStep.attempts.length; ai++) {
        const ourAttempt = ourStep.attempts[ai]!;
        const ngAttempt = ngStep.attempts[ai];
        if (!ngAttempt) continue;

        for (let ii = 0; ii < ourAttempt.iterations.length; ii++) {
          const ourIter = ourAttempt.iterations[ii]!;
          const ngIter = ngAttempt.iterations[ii];
          if (!ngIter) continue;

          assertIterationMatch(ourIter, ngIter, { stepIndex: si, iterIndex: ii });
        }
      }
    }

    assertModeTransitionMatch(ours, ngspice);
    assertConvergenceFlowMatch(ours, ngspice);

    // NR iteration count must match between engines
    const ourTotalIters = ours.steps.reduce(
      (sum, step) =>
        sum +
        step.attempts.reduce((s, a) => s + a.iterations.length, 0),
      0,
    );
    const ngTotalIters = ngspice.steps.reduce(
      (sum, step) =>
        sum +
        step.attempts.reduce((s, a) => s + a.iterations.length, 0),
      0,
    );
    expect(
      ourTotalIters,
      `NR iteration count mismatch: ours=${ourTotalIters} ngspice=${ngTotalIters}`,
    ).toBe(ngTotalIters);
  }, 60_000);
});
