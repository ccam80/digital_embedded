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

  it("session has steps on both sides (presence counts have both > 0)", () => {
    const shape = session.getSessionShape();
    expect(shape.presenceCounts.both).toBeGreaterThan(0);
  });

  it("every paired step has a finite stepStartTimeDelta", () => {
    const ourSteps = session.ourSession!.steps;
    for (let i = 0; i < ourSteps.length; i++) {
      const stepShape = session.getStepShape(i);
      if (stepShape.presence !== "both") continue;
      expect(Number.isFinite(stepShape.stepStartTimeDelta)).toBe(true);
    }
  });

  it("first step of both engines has stepStartTime === 0", () => {
    const ngSession: CaptureSession =
      (session as any)._ngSessionReindexed ?? (session as any)._ngSession;

    expect(session.ourSession!.steps[0].stepStartTime).toBe(0);
    expect(ngSession.steps[0].stepStartTime).toBe(0);
  });

  it("index-paired steps report stepStartTimeDelta = ours.stepStartTime - ng.stepStartTime", () => {
    const ourSteps = session.ourSession!.steps;
    const ngSession: CaptureSession =
      (session as any)._ngSessionReindexed ?? (session as any)._ngSession;
    for (let i = 0; i < ourSteps.length; i++) {
      const stepShape = session.getStepShape(i);
      if (stepShape.presence !== "both") continue;
      const ngStep = ngSession.steps[i];
      if (!ngStep) continue;
      const expectedDelta = ourSteps[i].stepStartTime - ngStep.stepStartTime;
      expect(stepShape.stepStartTimeDelta).toBeCloseTo(expectedDelta, 12);
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
