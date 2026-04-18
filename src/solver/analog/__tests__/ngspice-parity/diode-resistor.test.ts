/**
 * Parity test: Diode + resistor DC-OP
 *
 * Circuit: V1=1V at node "in", R1=1kΩ from "in" to "anode", D1 (Is=1e-14, N=1) from "anode" to gnd.
 * Tests pnjlim correctness, mode transitions, and noncon tracking at every NR iteration.
 * Tolerance contract: absDelta === 0 (exact IEEE-754 bit equality) on all fields.
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
  "src/solver/analog/__tests__/ngspice-parity/fixtures/diode-resistor.dts",
);

describeIfDll("Diode + resistor DC-OP parity", () => {
  it("dc_op_pnjlim_match", async () => {
    const session = new ComparisonSession({
      dtsPath: DTS_PATH,
      dllPath: DLL_PATH,
    });

    await session.init();
    await session.runDcOp();

    const ourSession = session.ourSession!;
    const ngSession = session.ngspiceSessionAligned!;

    // Assert NR iteration count equal between engines
    const ourTotalIters = ourSession.steps.reduce(
      (sum, step) =>
        sum + step.attempts.reduce((s, a) => s + a.iterations.length, 0),
      0,
    );
    const ngTotalIters = ngSession.steps.reduce(
      (sum, step) =>
        sum + step.attempts.reduce((s, a) => s + a.iterations.length, 0),
      0,
    );
    expect(
      ourTotalIters,
      `NR iteration count mismatch: ours=${ourTotalIters} ngspice=${ngTotalIters}`,
    ).toBe(ngTotalIters);

    // Per-step/iteration comparison (covers pnjlim bit-exact voltage limiting)
    const maxSteps = Math.min(ourSession.steps.length, ngSession.steps.length);
    for (let stepIndex = 0; stepIndex < maxSteps; stepIndex++) {
      const ourStep = ourSession.steps[stepIndex]!;
      const ngStep = ngSession.steps[stepIndex]!;

      const maxAttempts = Math.min(ourStep.attempts.length, ngStep.attempts.length);
      for (let ai = 0; ai < maxAttempts; ai++) {
        const ourAttempt = ourStep.attempts[ai]!;
        const ngAttempt = ngStep.attempts[ai]!;

        const maxIters = Math.min(
          ourAttempt.iterations.length,
          ngAttempt.iterations.length,
        );
        for (let iterIndex = 0; iterIndex < maxIters; iterIndex++) {
          assertIterationMatch(
            ourAttempt.iterations[iterIndex]!,
            ngAttempt.iterations[iterIndex]!,
            { stepIndex, iterIndex },
          );
        }
      }
    }

    // Mode transition sequence comparison (verifies initJct→initFix→initFloat sequence)
    assertModeTransitionMatch(ourSession, ngSession);

    // Convergence flow comparison (verifies noncon sequence, diagGmin, srcFact)
    assertConvergenceFlowMatch(ourSession, ngSession);
  }, 60_000);
});
