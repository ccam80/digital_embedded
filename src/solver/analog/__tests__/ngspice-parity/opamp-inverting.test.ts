/**
 * Task 7.2.4 — Op-amp inverting amplifier DC-OP parity
 *
 * Op-amp with feedback resistors. Tests source stepping.
 *
 * Circuit: V_IN=1V at in, R_IN=10kΩ from in to inverting node,
 * R_F=100kΩ feedback from out to inverting, op-amp with +in=gnd,
 * -in=inverting, out=out (real-opamp with gain=1e5, ±15V rails).
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
  "src/solver/analog/__tests__/ngspice-parity/fixtures/opamp-inverting.dts",
);

describeIfDll("opamp-inverting DC-OP parity", () => {
  it("dc_op_source_stepping_match", async () => {
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
    // Verifies srcFact sequence bit-exact across all source-stepping sub-solves
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
