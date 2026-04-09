/**
 * Unit tests for boot-step merge (spec §10.2 test 3 / spec §5).
 *
 * When runTransient() runs, step 0 (stepStartTime=0) must contain both the
 * DCOP attempts AND the first tranInit attempt. The acceptedAttemptIndex must
 * point at a tranInit (or tranNR) attempt, not at a DCOP sub-solve.
 *
 * Verified using ComparisonSession.runTransient() on a simple RC circuit
 * loaded from fixtures/rlc-transient.dts (no DLL required — ngspice side
 * is skipped when DLL is not present, and the test only checks ourSession).
 */

import { describe, it, expect } from "vitest";
import { resolve } from "path";
import { existsSync } from "fs";
import { ComparisonSession } from "./comparison-session.js";
import type { NRPhase } from "./types.js";

const DTS_PATH = resolve(process.cwd(), "fixtures/rlc-transient.dts");
const hasDts = existsSync(DTS_PATH);
const describeIfDts = hasDts ? describe : describe.skip;

describeIfDts("boot-step-merge: runTransient() step 0 contains DCOP + tranInit", () => {

  async function runSession() {
    const session = new ComparisonSession({
      dtsPath: DTS_PATH,
      // No dllPath — ngspice side will be empty, which is fine for these assertions
    });
    await session.init();
    await session.runTransient(0, 1e-6, 1e-7);
    return session;
  }

  it("ourSession has at least 2 steps (boot + at least one transient step)", async () => {
    const session = await runSession();
    expect(session.ourSession).toBeTruthy();
    expect(session.ourSession!.steps.length).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it("step 0 has stepStartTime === 0", async () => {
    const session = await runSession();
    const step0 = session.ourSession!.steps[0];
    expect(step0.stepStartTime).toBe(0);
  }, 30_000);

  it("step 0 has at least 2 attempts (DCOP attempt + tranInit attempt)", async () => {
    const session = await runSession();
    const step0 = session.ourSession!.steps[0];
    // The boot step must contain the DCOP sub-solve AND the first transient attempt
    expect(step0.attempts.length).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it("step 0 contains a DCOP-phase attempt", async () => {
    const session = await runSession();
    const step0 = session.ourSession!.steps[0];
    const dcopPhases: NRPhase[] = ["dcopDirect", "dcopGminDynamic", "dcopGminSpice3", "dcopSrcSweep"];
    const hasDcop = step0.attempts.some((a) => dcopPhases.includes(a.phase));
    expect(hasDcop).toBe(true);
  }, 30_000);

  it("step 0 contains a transient-phase attempt (tranInit or tranNR)", async () => {
    const session = await runSession();
    const step0 = session.ourSession!.steps[0];
    const tranPhases: NRPhase[] = ["tranInit", "tranNR", "tranPredictor"];
    const hasTran = step0.attempts.some((a) => tranPhases.includes(a.phase));
    expect(hasTran).toBe(true);
  }, 30_000);

  it("acceptedAttemptIndex points at a transient-phase attempt (not a DCOP sub-solve)", async () => {
    const session = await runSession();
    const step0 = session.ourSession!.steps[0];
    const acceptedIdx = step0.acceptedAttemptIndex;
    expect(acceptedIdx).toBeGreaterThanOrEqual(0);

    const acceptedAttempt = step0.attempts[acceptedIdx];
    const dcopPhases: NRPhase[] = ["dcopDirect", "dcopGminDynamic", "dcopGminSpice3", "dcopSrcSweep"];
    // The accepted attempt must NOT be a pure DCOP sub-solve
    expect(dcopPhases.includes(acceptedAttempt.phase)).toBe(false);
  }, 30_000);

  it("step 0 accepted === true", async () => {
    const session = await runSession();
    const step0 = session.ourSession!.steps[0];
    expect(step0.accepted).toBe(true);
  }, 30_000);

  it("subsequent steps have stepStartTime > 0", async () => {
    const session = await runSession();
    const steps = session.ourSession!.steps;
    expect(steps.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i].stepStartTime).toBeGreaterThan(0);
    }
  }, 30_000);
});
