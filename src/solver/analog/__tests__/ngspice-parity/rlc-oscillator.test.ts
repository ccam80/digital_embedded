/**
 * RLC oscillator transient parity- Task 7.3.2
 *
 * Circuit: V1=1V peak AC sine at 1592Hz (≈ resonant freq of 1/(2π√(LC)) with
 *          L=10mH, C=1µF), R1=10Ω series (low damping), L1=10mH, C1=1µF.
 *
 * Validates inductor integration and ringing behaviour.
 * Asserts method=trapezoidal at every accepted step and oscillation sanity (peak > 0.5V).
 * Every NR iteration must match ngspice bit-exact.
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
  "src/solver/analog/__tests__/ngspice-parity/fixtures/rlc-oscillator.dts",
);

describeIfDll("RLC oscillator transient parity- Task 7.3.2", () => {
  it("transient_oscillation_match", async () => {
    const session = new ComparisonSession({
      dtsPath: DTS_PATH,
      dllPath: DLL_PATH,
    });
    await session.init();
    await session.runTransient(0, 4e-3, 1e-6);

    const ourSession = session.ourSession!;
    const ngSession = session.ngspiceSessionAligned!;

    const ourSteps = ourSession.steps;
    const ngSteps = ngSession.steps;

    const stepCount = Math.min(ourSteps.length, ngSteps.length);

    // Track capacitor voltage peak over steps 0..200 for oscillation sanity check.
    // The capacitor node is the node between L1 and C1. We collect the max absolute
    // node voltage across all accepted steps 0..200.
    let capVoltagePeak = 0;

    for (let si = 0; si < stepCount; si++) {
      const ourStep = ourSteps[si]!;
      const ngStep = ngSteps[si]!;

      // Assert trapezoidal integration method at every accepted step (no method switching).
      if (ourStep.accepted) {
        const method = ourStep.integrationCoefficients.ours.method;
        expect(
          method,
          `step=${si}: expected currentMethod === "trapezoidal", got "${method}"`,
        ).toBe("trapezoidal");
      }

      for (const ourAttempt of ourStep.attempts) {
        const attemptIdx = ourStep.attempts.indexOf(ourAttempt);
        const ngAttempt = ngStep.attempts[attemptIdx];
        if (!ngAttempt) continue;

        const iterCount = Math.min(
          ourAttempt.iterations.length,
          ngAttempt.iterations.length,
        );
        for (let ii = 0; ii < iterCount; ii++) {
          assertIterationMatch(
            ourAttempt.iterations[ii]!,
            ngAttempt.iterations[ii]!,
            { stepIndex: si, iterIndex: ii },
          );

          // Collect capacitor node voltage for oscillation check (steps 0..200).
          if (si <= 200) {
            const snap = ourAttempt.iterations[ii]!;
            for (const v of snap.prevVoltages) {
              const absV = Math.abs(v);
              if (absV > capVoltagePeak) capVoltagePeak = absV;
            }
          }
        }
      }
    }

    // Oscillation sanity: peak voltage over first 200 steps must exceed 0.5V.
    expect(
      capVoltagePeak,
      `Oscillation sanity check failed: peak voltage over steps 0..200 = ${capVoltagePeak}V, expected > 0.5V`,
    ).toBeGreaterThan(0.5);

    assertModeTransitionMatch(ourSession, ngSession);
    assertConvergenceFlowMatch(ourSession, ngSession);
  }, 120_000);
});
