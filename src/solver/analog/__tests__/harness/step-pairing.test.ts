/**
 * Regression test for Fix 1 (step-pairing collapse).
 *
 * Symptom (pre-fix):
 *   runTransient() drove _coordinator.step() in a loop, then emitted an
 *   endStep() on the capture hook only when `_engine.simTime > prevSimTime`.
 *   Because the harness used `this._engine.simTime ?? 0` without accounting
 *   for pre-advance vs post-advance snapshots, the guard collapsed and a
 *   single synthetic step at t≈0 was published- every later harness_get_step
 *   query mapped back to that same DCOP/dcopInitFloat iteration.
 *
 * Fix:
 *   Derive post-step time from `prevSimTime + _engine.lastDt` (the accepted
 *   dt for the step just executed). This keeps a monotone, non-zero progression
 *   independent of any mid-retry simTime rollback.
 *
 * Assertion: runTransient on tmp-hang-circuits/rc-step.dts (selfCompare
 * avoids the ngspice DLL dependency for CI) emits at least 3 steps on our
 * side with distinct, strictly increasing stepEndTime values.
 */

import { describe, it, expect } from "vitest";
import { existsSync } from "fs";
import { resolve } from "path";
import { ComparisonSession } from "./comparison-session.js";

const DTS_PATH = resolve(process.cwd(), "tmp-hang-circuits/rc-step.dts");
const HAS_FIXTURE = existsSync(DTS_PATH);
const describeGate = HAS_FIXTURE ? describe : describe.skip;

describeGate("step-pairing: runTransient emits distinct per-step endTimes", () => {
  it("rc-step.dts yields >= 3 distinct stepEndTime values", async () => {
    const session = await ComparisonSession.createSelfCompare({
      dtsPath: DTS_PATH,
      analysis: "tran",
      tStop: 1e-5,
      maxStep: 1e-7,
    });

    const steps = session.ourSession!.steps;
    expect(steps.length).toBeGreaterThan(0);

    // Each step's stepEndTime must differ from the previous (strictly
    // increasing). Prior to the fix all emitted steps shared t=0, so
    // the set of distinct values was 1.
    const distinctEndTimes = new Set(steps.map(s => s.stepEndTime));
    expect(
      distinctEndTimes.size,
      `steps=${steps.length}, endTimes=${steps.slice(0, 10).map(s => s.stepEndTime).join(",")}`,
    ).toBeGreaterThanOrEqual(3);

    // Sanity: stepEndTime should be monotonically non-decreasing.
    for (let i = 1; i < steps.length; i++) {
      expect(
        steps[i].stepEndTime,
        `step ${i}: endTime regressed (${steps[i - 1].stepEndTime} → ${steps[i].stepEndTime})`,
      ).toBeGreaterThanOrEqual(steps[i - 1].stepEndTime);
    }

    // The first post-DCOP transient step should carry a non-zero stepEndTime
    // once the boot step (stepEndTime=0) has been published.
    const nonZeroEndTimes = steps.filter(s => s.stepEndTime > 0);
    expect(nonZeroEndTimes.length).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it("rc-step.dts exposes at least steps 0, 1, 2, 3 with distinct endTimes", async () => {
    const session = await ComparisonSession.createSelfCompare({
      dtsPath: DTS_PATH,
      analysis: "tran",
      tStop: 1e-5,
      maxStep: 1e-7,
    });

    const steps = session.ourSession!.steps;
    expect(steps.length).toBeGreaterThanOrEqual(4);

    const t0 = steps[0].stepEndTime;
    const t1 = steps[1].stepEndTime;
    const t2 = steps[2].stepEndTime;
    const t3 = steps[3].stepEndTime;

    // Evidence line for reviewers.
    // eslint-disable-next-line no-console
    console.log(`step endTimes: 0=${t0}, 1=${t1}, 2=${t2}, 3=${t3}`);

    // Post-DCOP steps must each advance time strictly.
    expect(t1).toBeGreaterThan(t0);
    expect(t2).toBeGreaterThan(t1);
    expect(t3).toBeGreaterThan(t2);
  }, 30_000);
});
