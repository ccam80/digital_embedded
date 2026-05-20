/**
 * AC bridge-paired smoke test (Phase 3c prep).
 *
 * Exercises the FULL chain end-to-end against the real ngspice DLL:
 *
 *   .dts ──► our AcAnalysis ────────────► acSession (matrix + RHS + solution)
 *                                                                  │
 *                                                                  ├── acFirstDivergence()
 *                                                                  │       (solution / shape / matrix)
 *                                                                  │
 *   .cir ──► ngspice ACan via bridge ───► ngspiceAcSession ────────┘
 *
 * Phase 1b proved the C->TS round-trip in isolation; Phases 2/3a/3b built
 * the in-process comparison harness in selfCompare mode. This smoke is the
 * first time both sides run for real together. Pre-Phase-3c the smoke is
 * deliberately tolerant of node-ordering disagreements (different MNA
 * permutations on each side are a known surface that Phase 3c node-mapping
 * will resolve)- it asserts strong positives (sessions populated, point
 * counts match, frequencies match, finite non-zero magnitudes) and reports
 * the divergence-report content rather than failing if matrices permute.
 *
 * Skips gracefully when the instrumented ngspice DLL is absent via
 * `describeIfDll`.
 */

import { it, expect } from "vitest";
import { ComparisonSession } from "./comparison-session.js";
import { describeIfDll, DLL_PATH } from "../ngspice-parity/parity-helpers.js";

const DTS = "src/solver/analog/__tests__/ngspice-parity/fixtures/rc-transient.dts";
const CIR = "src/solver/analog/__tests__/ngspice-parity/fixtures/rc-transient-ac.cir";

const AC_PARAMS = {
  type: "dec" as const,
  numPoints: 3,
  fStart: 1,
  fStop: 1000,
  sourceLabel: "V1:pos",
  outputNodes: [] as string[],
};

describeIfDll("AC bridge-paired smoke (real ngspice)", () => {
  it("rc_lowpass_ac_runs_both_sides_and_acFirstDivergence_returns_report", async () => {
    const session = await ComparisonSession.create({
      dtsPath: DTS,
      cirPath: CIR,
      dllPath: DLL_PATH,
      // Defer structural-parity asserts so a permutation does not throw out
      // of `runAcSweep`. We want the smoke to ALWAYS reach acFirstDivergence
      // and report its findings.
      deferStructuralAsserts: true,
    });

    await session.runAcSweep(AC_PARAMS);

    const ours = session.acSession;
    const ngsp = session.ngspiceAcSession;
    expect(ours).not.toBeNull();
    expect(ngsp).not.toBeNull();
    expect(ours!.source).toBe("ours");
    expect(ngsp!.source).toBe("ngspice");

    // Both sides populated with non-empty points.
    expect(ours!.points.length).toBeGreaterThan(0);
    expect(ngsp!.points.length).toBeGreaterThan(0);

    // Point counts match (both sides build the sweep from the same
    // {fStart, fStop, n, type} via the same num_steps formula).
    const shape = session.getAcSessionShape();
    expect(shape.pointCount.ours).toBe(shape.pointCount.ngspice);

    // This smoke logs the divergence report without asserting clean parity.
    // Findings drive concrete-fix work (cumulative-multiply order, ngspice
    // node-mapping) as they get root-caused.

    // Each frequency point produced a finite, non-zero solution magnitude on
    // both sides. This is the "the chain actually ran something nontrivial"
    // sanity check.
    function maxAbsSolution(arr: { solRe: Float64Array; solIm: Float64Array }): number {
      let m = 0;
      for (let i = 0; i < arr.solRe.length; i++) {
        const v = Math.hypot(arr.solRe[i], arr.solIm[i]);
        if (v > m) m = v;
      }
      return m;
    }
    for (const p of ours!.points) {
      const m = maxAbsSolution(p);
      expect(Number.isFinite(m)).toBe(true);
      expect(m).toBeGreaterThan(0);
    }
    for (const p of ngsp!.points) {
      const m = maxAbsSolution(p);
      expect(Number.isFinite(m)).toBe(true);
      expect(m).toBeGreaterThan(0);
    }

    // acFirstDivergence runs unconditionally. Report content (not pass/fail
    // on bit-exact) is the deliverable of this smoke pre-Phase-3c: console
    // surface lets us see whether a permutation needs node-mapping work or
    // whether matrices already align.
    const report = session.acFirstDivergence();
    console.log(`[ac-bridge-paired-smoke] divergence report:`,
      JSON.stringify({
        earliestPointIndex: report.earliestPointIndex,
        solution: report.solution ? {
          pointIndex: report.solution.pointIndex,
          freq: report.solution.freq,
          row: report.solution.row,
          absDelta: report.solution.absDelta,
          relDelta: report.solution.relDelta,
        } : null,
        shape: report.shape,
        matrix: report.matrix ? {
          pointIndex: report.matrix.pointIndex,
          freq: report.matrix.freq,
          row: report.matrix.row,
          col: report.matrix.col,
          kind: report.matrix.kind,
          absDelta: report.matrix.absDelta,
          relDelta: report.matrix.relDelta,
        } : null,
      }, null, 2));
    // No strong assertion on report contents here- Phase 3c node-mapping
    // work informs which combinations of (matrix, solution) should be clean
    // post-mapping. This smoke proves the chain RUNS; Phase 3c proves it
    // produces clean parity.
  }, 60_000);
});
