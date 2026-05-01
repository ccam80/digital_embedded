/**
 * Parity test: MOSFET inverter DC-OP + transient.
 *
 * Verifies per-NR-iteration bit-exact match against ngspice for an NMOS
 * inverter with resistive load. Tests fetlim and FET device equations in
 * both DC operating point and transient phases.
 *
 * Circuit: V_DD=5V, R_D=10kΩ (vdd→vout), NMOS (Vto=1V, Kp=50e-6, W=10µm,
 * L=1µm, Lambda=0.02) with drain=vout, source=gnd, gate=vin.
 * V_IN: square wave 0/5V, t_rise=1ns, t_fall=1ns, period=100µs.
 * DC-OP: V_IN=0V (NMOS off). Transient: stopTime=200µs, maxStep=1µs.
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
  "src/solver/analog/__tests__/ngspice-parity/fixtures/mosfet-inverter.dts",
);

const TRAN_STOP_TIME = 200e-6;
const TRAN_MAX_STEP = 1e-6;

describeIfDll("MOSFET inverter- ngspice DC-OP + transient parity", () => {
  it("dc_op_match", async () => {
    const session = new ComparisonSession({
      dtsPath: FIXTURE_PATH,
      dllPath: DLL_PATH,
    });

    await session.init();
    await session.runDcOp();

    const ours = session.ourSession!;
    const ngspice = session.ngspiceSessionAligned ?? session.ngspiceSession!;

    // Per-step, per-iteration bit-exact match for DC-OP
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

    // Sanity: DC-OP must have produced at least one step
    expect(ours.steps.length).toBeGreaterThan(0);
  }, 60_000);

  it("transient_match", async () => {
    const session = new ComparisonSession({
      dtsPath: FIXTURE_PATH,
      dllPath: DLL_PATH,
    });

    await session.init();
    await session.runTransient(0, TRAN_STOP_TIME, TRAN_MAX_STEP);

    const ours = session.ourSession!;
    const ngspice = session.ngspiceSessionAligned ?? session.ngspiceSession!;

    // Per-step, per-iteration bit-exact match for transient
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

    // Sanity: transient must have produced steps
    expect(ours.steps.length).toBeGreaterThan(0);
    expect(ngspice.steps.length).toBeGreaterThan(0);
  }, 120_000);
});
