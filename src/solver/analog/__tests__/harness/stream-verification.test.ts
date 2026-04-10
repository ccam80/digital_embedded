/**
 * Stream Verification -- 17 tests verifying the full harness data pipeline
 * using a REAL HWR square-wave circuit with REAL ngspice. No mocks.
 *
 * All tests share a single ComparisonSession created in the first test.
 * Skips the entire suite when the ngspice DLL is not available.
 */
import { describe, it, expect, afterAll } from "vitest";
import { existsSync } from "fs";
import { resolve } from "path";
import { ComparisonSession } from "./comparison-session.js";
import type {
  CaptureSession,
  DivergenceCategory,
} from "./types.js";

const DLL_PATH = process.env.NGSPICE_DLL_PATH ?? "";
const HAS_DLL = DLL_PATH !== "" && existsSync(DLL_PATH);
const describeGate = HAS_DLL ? describe : describe.skip;

const DTS_PATH = resolve(process.cwd(), "fixtures/hwr-square.dts");


describeGate("Stream Verification -- full pipeline (HWR square wave)", () => {
  let session: ComparisonSession;

  afterAll(() => {
    if (session) session.dispose();
  });

  it("creates session and runs transient", async () => {
    session = await ComparisonSession.create({
      dtsPath: DTS_PATH,

      dllPath: DLL_PATH,
    });
    await session.runTransient(0, 10e-6, 100e-9);

    expect(session.ourSession).toBeTruthy();
    expect(session.ourSession!.steps.length).toBeGreaterThan(0);
  }, 60_000);

  it("1. topology: node mapping populated", () => {
    const nodeMap: Array<{
      ourIndex: number;
      ngspiceIndex: number;
      label: string;
      ngspiceName: string;
    }> = (session as any)._nodeMap;

    expect(nodeMap.length).toBeGreaterThan(0);

    for (const entry of nodeMap) {
      expect(entry.ourIndex).toBeGreaterThanOrEqual(0);
      expect(entry.ngspiceIndex).toBeGreaterThanOrEqual(0);
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.ngspiceName.length).toBeGreaterThan(0);
    }

    const hasD = nodeMap.some((e) => e.label.toUpperCase().includes("D"));
    expect(hasD).toBe(true);
  });

  it("2. topology: element type is always a non-empty string", () => {
    const elements: Array<{ type: string }> = (session as any)._ourTopology
      .elements;

    for (const el of elements) {
      expect(typeof el.type).toBe("string");
      expect(el.type.length).toBeGreaterThan(0);
    }

    const hasDiode = elements.some((el) => el.type === "diode");
    expect(hasDiode).toBe(true);
  });

  it("3. topology: matrixRowLabels and matrixColLabels populated", () => {
    const topo = (session as any)._ourTopology;
    const rowLabels: Map<number, string> = topo.matrixRowLabels;
    const colLabels: Map<number, string> = topo.matrixColLabels;

    expect(rowLabels.size).toBeGreaterThan(0);
    expect(colLabels.size).toBeGreaterThan(0);
    expect(rowLabels.size).toBeGreaterThanOrEqual(topo.nodeCount);
  });

  it("4. integration coefficients: ag0 non-zero for transient steps", () => {
    // Spec §9.5: target tranFloat steps only. Step 0 (merged boot, analysisPhase="tranInit")
    // uses backward-Euler (ag1=0), so it must be excluded. Trapezoidal coefficients with
    // both ag0 and ag1 non-zero appear from the first tranFloat step onward.
    const ourSteps = session.ourSession!.steps;
    const tranFloatSteps = ourSteps.filter(
      (s) => s.analysisPhase === "tranFloat",
    );

    expect(
      tranFloatSteps.length,
      "must have at least one tranFloat step to verify trapezoidal coefficients",
    ).toBeGreaterThan(0);

    let foundOurNonZero = false;
    let foundNgNonZero = false;

    for (const step of tranFloatSteps) {
      const ic = step.integrationCoefficients;
      if (ic.ours.ag0 !== 0 && ic.ours.ag1 !== 0) foundOurNonZero = true;
      if (ic.ngspice.ag0 !== 0 && ic.ngspice.ag1 !== 0) foundNgNonZero = true;
      if (foundOurNonZero && foundNgNonZero) break;
    }

    expect(foundOurNonZero, "ours must have ag0 AND ag1 non-zero on at least one tranFloat step").toBe(true);
    expect(foundNgNonZero, "ngspice must have ag0 AND ag1 non-zero on at least one tranFloat step").toBe(true);
  });

  it("5. integration coefficients: method transitions to trapezoidal", () => {
    // Spec §9.5: scan tranFloat steps only. Step 0 (analysisPhase="tranInit") uses
    // backward-Euler regardless; trapezoidal appears from tranFloat steps onward.
    const ourSteps = session.ourSession!.steps;
    const tranFloatSteps = ourSteps.filter(
      (s) => s.analysisPhase === "tranFloat",
    );

    expect(
      tranFloatSteps.length,
      "must have at least one tranFloat step to verify trapezoidal transition",
    ).toBeGreaterThan(0);

    const tranFloatMethods = new Set(
      tranFloatSteps.map((s) => s.integrationCoefficients.ours.method),
    );

    expect(tranFloatMethods.has("trapezoidal"), "trapezoidal method must appear in tranFloat steps").toBe(true);

    for (const step of tranFloatSteps) {
      const ic = step.integrationCoefficients.ours;
      if (ic.method === "trapezoidal" && step.dt > 0) {
        const expected = 2 / step.dt;
        const relErr = Math.abs(ic.ag0 - expected) / expected;
        expect(relErr).toBeLessThan(0.001);
      }
    }
  });

  it("6. analysis phase: not all steps are tranFloat", () => {
    const ourSteps = session.ourSession!.steps;
    const phases = new Set(ourSteps.map((s) => s.analysisPhase));

    expect(phases.size).toBeGreaterThan(1);

    const firstPhase = ourSteps[0].analysisPhase;
    expect(firstPhase === "dcop" || firstPhase === "tranInit").toBe(true);
  });

  it("7. analysis phase: tranInit precedes tranFloat", () => {
    const ourSteps = session.ourSession!.steps;
    const phases = ourSteps.map((s) => s.analysisPhase);

    const initIdx = phases.indexOf("tranInit");
    const floatIdx = phases.indexOf("tranFloat");

    expect(initIdx).toBeGreaterThanOrEqual(0);
    expect(floatIdx).toBeGreaterThanOrEqual(0);
    expect(initIdx).toBeLessThan(floatIdx);
  });

  // Tests 8-9 use buckbjt which has convergence failures at step 1.
  // A separate session is created because the HWR circuit converges cleanly.
  let bjtSession: ComparisonSession | null = null;

  it("8. per-element convergence: our engine reports failures", async () => {
    bjtSession = await ComparisonSession.create({
      dtsPath: resolve(process.cwd(), "fixtures/buckbjt.dts"),
      dllPath: DLL_PATH,
    });
    await bjtSession.runTransient(0, 10e-6, 100e-9);

    const ourSteps = bjtSession.ourSession!.steps;
    expect(ourSteps.length).toBeGreaterThan(0);

    // buckbjt has convergence failures — find any step/iteration with
    // non-empty convergenceFailedElements (requires detailedConvergence=true)
    let foundFailure = false;
    for (const step of ourSteps) {
      for (const iter of step.iterations) {
        if (iter.convergenceFailedElements?.length > 0) {
          for (const el of iter.convergenceFailedElements) {
            expect(typeof el).toBe("string");
          }
          foundFailure = true;
          break;
        }
      }
      if (foundFailure) break;
    }
    expect(foundFailure, "buckbjt must have at least one iteration with convergenceFailedElements populated").toBe(true);

    for (const step of ourSteps) {
      if (step.converged) {
        const lastIter = step.iterations[step.iterations.length - 1];
        expect(lastIter.convergenceFailedElements.length).toBe(0);
      }
    }

    bjtSession.dispose();
    bjtSession = null;
  }, 60_000);

  it("10. limiting events: our engine captures events (Item 9)", () => {
    const ourSteps = session.ourSession!.steps;

    let foundLimiting = false;
    let foundWasLimited = false;
    for (const step of ourSteps) {
      for (const iter of step.iterations) {
        if (iter.limitingEvents.length > 0) {
          foundLimiting = true;
          for (const ev of iter.limitingEvents) {
            expect(ev.elementIndex).toBeGreaterThanOrEqual(0);
            expect(ev.label.length).toBeGreaterThan(0);
            expect(ev.junction.length).toBeGreaterThan(0);
            expect(["pnjlim", "fetlim", "limvds"]).toContain(ev.limitType);
            expect(Number.isFinite(ev.vBefore)).toBe(true);
            expect(Number.isFinite(ev.vAfter)).toBe(true);
            expect(typeof ev.wasLimited).toBe("boolean");
            if (ev.wasLimited) foundWasLimited = true;
          }
        }
      }
    }
    expect(foundLimiting).toBe(true);
    expect(foundWasLimited).toBe(true);
  });

  it("11. limiting events: ngspice captures events (C-side Item 9)", () => {
    const ngSession: CaptureSession =
      (session as any)._ngSessionReindexed ?? (session as any)._ngSession;

    let foundNgLimiting = false;
    for (const step of ngSession.steps) {
      for (const iter of step.iterations) {
        if (iter.limitingEvents.length > 0) {
          foundNgLimiting = true;
          break;
        }
      }
      if (foundNgLimiting) break;
    }
    expect(foundNgLimiting).toBe(true);
  });

  it("12. state history: state1Slots and state2Slots populated", () => {
    const ourSteps = session.ourSession!.steps;
    const ngSession: CaptureSession =
      (session as any)._ngSessionReindexed ?? (session as any)._ngSession;

    for (const steps of [ourSteps, ngSession.steps]) {
      let foundState1 = false;
      let foundState2 = false;
      for (let i = 2; i < steps.length; i++) {
        const step = steps[i];
        const lastIter = step.iterations[step.iterations.length - 1];
        for (const es of lastIter.elementStates) {
          const s1Keys = Object.keys(es.state1Slots);
          const s2Keys = Object.keys(es.state2Slots);
          if (s1Keys.length > 0) {
            foundState1 = true;
            for (const val of Object.values(es.state1Slots)) {
              expect(Number.isFinite(val)).toBe(true);
            }
          }
          if (s2Keys.length > 0) {
            foundState2 = true;
            for (const val of Object.values(es.state2Slots)) {
              expect(Number.isFinite(val)).toBe(true);
            }
          }
        }
        if (foundState1 && foundState2) break;
      }
      expect(foundState1).toBe(true);
      expect(foundState2).toBe(true);
    }
  });

  it("13. pre-solve RHS: populated and not all zero", () => {
    const ourSteps = session.ourSession!.steps;
    const ngSession: CaptureSession =
      (session as any)._ngSessionReindexed ?? (session as any)._ngSession;

    for (const steps of [ourSteps, ngSession.steps]) {
      let foundNonZero = false;
      for (const step of steps) {
        for (const iter of step.iterations) {
          expect(iter.preSolveRhs).toBeInstanceOf(Float64Array);
          expect(iter.preSolveRhs.length).toBeGreaterThan(0);
          for (let i = 0; i < iter.preSolveRhs.length; i++) {
            if (iter.preSolveRhs[i] !== 0) {
              foundNonZero = true;
              break;
            }
          }
          if (foundNonZero) break;
        }
        if (foundNonZero) break;
      }
      expect(foundNonZero).toBe(true);
    }
  });

  it("14. limiting comparison: sign is postLimit - preLimit", () => {
    const ourSteps = session.ourSession!.steps;

    let targetLabel = "";
    let targetStep = -1;
    let targetIter = -1;

    outer: for (let si = 0; si < ourSteps.length; si++) {
      const step = ourSteps[si];
      for (let ii = 0; ii < step.iterations.length; ii++) {
        const iter = step.iterations[ii];
        const limited = iter.limitingEvents.find((e) => e.wasLimited);
        if (limited) {
          targetLabel = limited.label;
          targetStep = si;
          targetIter = ii;
          break outer;
        }
      }
    }

    expect(targetStep).toBeGreaterThanOrEqual(0);

    const report = session.getLimitingComparison(
      targetLabel,
      targetStep,
      targetIter,
    );
    expect(report.junctions.length).toBeGreaterThan(0);

    for (const j of report.junctions) {
      if (Number.isFinite(j.ourPreLimit) && Number.isFinite(j.ourPostLimit)) {
        const expectedOurDelta = j.ourPostLimit - j.ourPreLimit;
        expect(j.ourDelta).toBeCloseTo(expectedOurDelta, 12);
        if (j.ourPostLimit > j.ourPreLimit) {
          expect(j.ourDelta).toBeGreaterThan(0);
        }
      }
      if (
        Number.isFinite(j.ngspicePreLimit) &&
        Number.isFinite(j.ngspicePostLimit)
      ) {
        const expectedNgDelta = j.ngspicePostLimit - j.ngspicePreLimit;
        expect(j.ngspiceDelta).toBeCloseTo(expectedNgDelta, 12);
      }
      if (
        Number.isFinite(j.ourDelta) &&
        Number.isFinite(j.ngspiceDelta)
      ) {
        const expectedDiff = j.ourDelta - j.ngspiceDelta;
        expect(j.limitingDiff).toBeCloseTo(expectedDiff, 12);
      }
    }
  });

  it("15. step shape: getSessionShape reports both-sided presence for a real run", () => {
    const shape = session.getSessionShape();
    expect(shape.presenceCounts.both).toBeGreaterThan(0);

    const ourSteps = session.ourSession!.steps;
    for (let i = 0; i < ourSteps.length; i++) {
      const stepShape = session.getStepShape(i);
      expect(["both", "oursOnly", "ngspiceOnly"]).toContain(stepShape.presence);
    }
  });

  it("16. step alignment: first step at time 0", () => {
    const ourSteps = session.ourSession!.steps;
    expect(ourSteps[0].stepStartTime).toBeCloseTo(0, 6);
  });
});
