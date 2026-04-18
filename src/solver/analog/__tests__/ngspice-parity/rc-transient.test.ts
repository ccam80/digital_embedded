/**
 * RC circuit transient parity — Task 7.3.1
 *
 * Circuit: V1 pulse source (0V→1V, 1ns rise/fall, 1ms width, 2ms period),
 *          R1=1kΩ from V1 to cap_top, C1=1µF from cap_top to gnd.
 *
 * Validates NIintegrate for capacitor, LTE timestep estimation, order promotion.
 * Runs both our engine and ngspice; every NR iteration must match bit-exact.
 */

import { it } from "vitest";
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
  "src/solver/analog/__tests__/ngspice-parity/fixtures/rc-transient.dts",
);

describeIfDll("RC transient parity — Task 7.3.1", () => {
  it("transient_per_step_match", async () => {
    const session = new ComparisonSession({
      dtsPath: DTS_PATH,
      dllPath: DLL_PATH,
    });
    await session.init();
    await session.runTransient(0, 2e-3, 10e-6);

    const ourSession = session.ourSession!;
    const ngSession = session.ngspiceSessionAligned!;

    const ourSteps = ourSession.steps;
    const ngSteps = ngSession.steps;

    const stepCount = Math.min(ourSteps.length, ngSteps.length);

    for (let si = 0; si < stepCount; si++) {
      const ourStep = ourSteps[si]!;
      const ngStep = ngSteps[si]!;

      for (const ourAttempt of ourStep.attempts) {
        const ngAttempt = ngStep.attempts[ourStep.attempts.indexOf(ourAttempt)];
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
        }
      }
    }

    assertModeTransitionMatch(ourSession, ngSession);
    assertConvergenceFlowMatch(ourSession, ngSession);
  }, 120_000);
});
