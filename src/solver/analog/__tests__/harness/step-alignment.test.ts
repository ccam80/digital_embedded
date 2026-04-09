/**
 * Step-alignment tests (spec §10.2 test 1 / spec §7).
 *
 * Alignment is by exact stepStartTime equality (EPS = 1e-15).
 * Every aligned pair must satisfy |ours.stepStartTime - ng.stepStartTime| <= 1e-15.
 * Unaligned steps are allowed but every aligned pair must be strictly correct.
 *
 * Requires the ngspice DLL (skipped otherwise).
 */

import { describe, it, expect, afterAll } from "vitest";
import { resolve } from "path";
import { existsSync } from "fs";
import { ComparisonSession } from "./comparison-session.js";
import type { CaptureSession } from "./types.js";

const DLL_PATH = process.env.NGSPICE_DLL_PATH ?? "";
const HAS_DLL = DLL_PATH !== "" && existsSync(DLL_PATH);
const describeGate = HAS_DLL ? describe : describe.skip;

const DTS_PATH = resolve(process.cwd(), "fixtures/rlc-transient.dts");

describeGate("step-alignment: exact stepStartTime equality between engines", () => {
  let session: ComparisonSession;

  afterAll(() => {
    if (session) session.dispose();
  });

  it("creates session and runs transient", async () => {
    session = new ComparisonSession({
      dtsPath: DTS_PATH,
      dllPath: DLL_PATH,
    });
    await session.init();
    await session.runTransient(0, 1e-6, 1e-7);

    expect(session.ourSession).toBeTruthy();
    expect(session.ourSession!.steps.length).toBeGreaterThan(0);
    // If ngspice errors (e.g. extended DLL not yet built), skip remaining tests
    if (session.errors.length > 0) {
      console.log("ngspice errors (extended DLL may not be built yet):", session.errors);
    }
  }, 60_000);

  it("both engines produce steps", () => {
    const ngSession: CaptureSession =
      (session as any)._ngSessionReindexed ?? (session as any)._ngSession;

    expect(session.ourSession!.steps.length).toBeGreaterThan(0);
    expect(ngSession.steps.length).toBeGreaterThan(0);
  });

  it("alignment map is non-empty", () => {
    const alignedNgIndex: Map<number, number> = (session as any)._alignedNgIndex;
    expect(alignedNgIndex.size).toBeGreaterThan(0);
  });

  it("every aligned pair has |stepStartTime delta| <= 1e-15", () => {
    const alignedNgIndex: Map<number, number> = (session as any)._alignedNgIndex;
    const ourSteps = session.ourSession!.steps;
    const ngSession: CaptureSession =
      (session as any)._ngSessionReindexed ?? (session as any)._ngSession;

    for (const [ourIdx, ngIdx] of alignedNgIndex) {
      const ourStep = ourSteps[ourIdx];
      const ngStep = ngSession.steps[ngIdx];
      if (!ourStep || !ngStep) continue;

      const delta = Math.abs(ourStep.stepStartTime - ngStep.stepStartTime);
      expect(delta).toBeLessThanOrEqual(1e-15);
    }
  });

  it("first step of both engines has stepStartTime === 0", () => {
    const ngSession: CaptureSession =
      (session as any)._ngSessionReindexed ?? (session as any)._ngSession;

    expect(session.ourSession!.steps[0].stepStartTime).toBe(0);
    expect(ngSession.steps[0].stepStartTime).toBe(0);
  });

  it("no raw-index fallback: aligned pairs use exact time equality only", () => {
    // Verify that the alignment map never maps our step i to ng step i unless
    // the times actually match. Any pair where times differ by more than 1e-15
    // must NOT appear in the alignment map.
    const alignedNgIndex: Map<number, number> = (session as any)._alignedNgIndex;
    const ourSteps = session.ourSession!.steps;
    const ngSession: CaptureSession =
      (session as any)._ngSessionReindexed ?? (session as any)._ngSession;

    for (const [ourIdx, ngIdx] of alignedNgIndex) {
      const ourStep = ourSteps[ourIdx];
      const ngStep = ngSession.steps[ngIdx];
      if (!ourStep || !ngStep) continue;

      // Every entry in the map must have matching times
      const delta = Math.abs(ourStep.stepStartTime - ngStep.stepStartTime);
      expect(delta).toBeLessThanOrEqual(1e-15);
    }

    // All non-aligned our steps must not have a matching ngspice step by time
    const alignedOurIndices = new Set(alignedNgIndex.keys());
    for (let i = 0; i < ourSteps.length; i++) {
      if (alignedOurIndices.has(i)) continue;
      // This our step has no aligned ngspice step — verify no ng step has the same time
      const ourTime = ourSteps[i].stepStartTime;
      const matchingNg = ngSession.steps.findIndex(
        (s) => Math.abs(s.stepStartTime - ourTime) <= 1e-15,
      );
      // If there IS a matching ng step, the alignment map should have caught it
      // (this would indicate a bug). We only soft-check here — the strict
      // assertion is that aligned pairs are correct, not that all pairs are found.
      if (matchingNg >= 0) {
        // The alignment map missed a valid pair — flag it
        expect(alignedNgIndex.has(i)).toBe(true);
      }
    }
  });

  it("stepStartTime values are monotonically non-decreasing in both engines", () => {
    const ngSession: CaptureSession =
      (session as any)._ngSessionReindexed ?? (session as any)._ngSession;

    const ourSteps = session.ourSession!.steps;
    for (let i = 1; i < ourSteps.length; i++) {
      expect(ourSteps[i].stepStartTime).toBeGreaterThanOrEqual(ourSteps[i - 1].stepStartTime);
    }
    for (let i = 1; i < ngSession.steps.length; i++) {
      expect(ngSession.steps[i].stepStartTime).toBeGreaterThanOrEqual(ngSession.steps[i - 1].stepStartTime);
    }
  });
});
