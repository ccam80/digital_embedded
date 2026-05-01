/**
 * Tests for lteDt capture from our engine (task 7.1.2).
 */
import { describe, it, expect } from "vitest";
import { ComparisonSession } from "./comparison-session.js";

describe("lteDt capture- our engine", () => {
  it("lteDt_captured_from_ours: lteDt is finite positive on every accepted transient step", async () => {
    const session = await ComparisonSession.createSelfCompare({
      dtsPath: "fixtures/rlc-transient.dts",
      analysis: "tran",
      tStop: 2e-6,
      maxStep: 1e-7,
    });

    const ourSteps = session.ourSession!.steps;
    expect(ourSteps.length).toBeGreaterThan(0);

    const tranSteps = ourSteps.filter(
      (s) => s.analysisPhase === "tranFloat" || s.analysisPhase === "tranInit",
    );
    expect(tranSteps.length).toBeGreaterThan(0);

    for (const step of tranSteps) {
      const accepted = step.attempts[step.acceptedAttemptIndex];
      if (!accepted || accepted.iterations.length === 0) continue;
      const lastIter = accepted.iterations[accepted.iterations.length - 1]!;
      expect(
        lastIter.lteDt,
        `step at t=${step.stepStartTime}: expected lteDt to be set on last iteration`,
      ).toBeDefined();
      expect(
        Number.isFinite(lastIter.lteDt!),
        `step at t=${step.stepStartTime}: lteDt=${lastIter.lteDt} should be finite`,
      ).toBe(true);
      expect(
        lastIter.lteDt! > 0,
        `step at t=${step.stepStartTime}: lteDt=${lastIter.lteDt} should be positive`,
      ).toBe(true);
    }
  }, 30_000);
});
