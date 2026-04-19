/**
 * Parity test: Diode bridge rectifier transient.
 *
 * Verifies per-NR-iteration bit-exact match against ngspice for a full-wave
 * bridge rectifier with capacitor filter. Tests multi-junction limiting,
 * breakpoint handling, and convergence flow.
 *
 * Circuit: V1=1V peak sine @60Hz differential across ac_p/ac_n.
 * Four diodes (Is=1e-14, N=1) in full-wave bridge. R_load=1kΩ, C_filter=100µF.
 * Transient: stopTime=33.3ms, maxStep=100µs.
 */

import { it, expect } from "vitest";
import { resolve } from "path";
import { ComparisonSession } from "../harness/comparison-session.js";
import {
  DLL_PATH,
  describeIfDll,
  assertIterationMatch,
  assertModeTransitionMatch,
  assertConvergenceFlowMatch,
} from "./parity-helpers.js";

const FIXTURE_PATH = resolve(
  process.cwd(),
  "src/solver/analog/__tests__/ngspice-parity/fixtures/diode-bridge.dts",
);

const STOP_TIME = 33.3e-3;
const MAX_STEP = 100e-6;

describeIfDll("Diode bridge rectifier — ngspice transient parity", () => {
  it("transient_rectification_match", async () => {
    const session = new ComparisonSession({
      dtsPath: FIXTURE_PATH,
      dllPath: DLL_PATH,
    });

    await session.init();
    await session.runTransient(0, STOP_TIME, MAX_STEP);

    const ours = session.ourSession!;
    const ngspice = session.ngspiceSession!;

    // Per-step, per-iteration bit-exact match
    const maxSteps = Math.max(ours.steps.length, ngspice.steps.length);
    for (let si = 0; si < maxSteps; si++) {
      const ourStep = ours.steps[si];
      const ngStep = ngspice.steps[si];

      if (!ourStep || !ngStep) continue;

      const ourIters = ourStep.attempts.flatMap((a) => a.iterations);
      const ngIters = ngStep.attempts.flatMap((a) => a.iterations);

      const iterCount = Math.min(ourIters.length, ngIters.length);
      for (let ii = 0; ii < iterCount; ii++) {
        assertIterationMatch(ourIters[ii]!, ngIters[ii]!, {
          stepIndex: si,
          iterIndex: ii,
        });
      }
    }

    // Mode transition sequence matches ngspice exactly
    assertModeTransitionMatch(ours, ngspice);

    // Convergence flow (noncon, diagGmin, srcFact) matches exactly
    assertConvergenceFlowMatch(ours, ngspice);

    // Breakpoint consumption times: every accepted step's end time must match bit-exact
    const ourBreakTimes = ours.steps
      .filter((s) => s.accepted)
      .map((s) => s.stepEndTime);
    const ngBreakTimes = ngspice.steps
      .filter((s) => s.accepted)
      .map((s) => s.stepEndTime);

    expect(
      ourBreakTimes.length,
      `Breakpoint sequence length mismatch: ours=${ourBreakTimes.length} ngspice=${ngBreakTimes.length}`,
    ).toBe(ngBreakTimes.length);

    for (let i = 0; i < ourBreakTimes.length; i++) {
      const o = ourBreakTimes[i]!;
      const n = ngBreakTimes[i]!;
      const absDelta = Math.abs(o - n);
      expect(
        absDelta,
        `breakpoint time [${i}]: ours=${o} ngspice=${n} absDelta=${absDelta}`,
      ).toBe(0);
    }

    // Sanity: simulation must have produced steps
    expect(ours.steps.length).toBeGreaterThan(0);
    expect(ngspice.steps.length).toBeGreaterThan(0);
  }, 120_000);
});
