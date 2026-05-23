/**
 * AC first-divergence smoke test (Phase 3a).
 *
 * Covers `ComparisonSession.acFirstDivergence()` across the three classes
 * Phase 3a surfaces:
 *   - happy path (selfCompare) - no divergence in any class.
 *   - forced solution divergence (mutate a single complex value post-run).
 *   - forced shape divergence (truncate the ngspice-side point list).
 *   - error path when no AC sweep has been run.
 *
 * Matrix-class divergence is Phase 3b (requires SparseSolver complex CSC
 * export on the our side); the report contract here asserts `matrix === null`.
 *
 * Selfcompare avoids the ngspice DLL dependency; bridge-paired divergence
 * lands with the Phase 3b smoke once the matrix exporter ships.
 */

import { it, expect } from "vitest";
import { ComparisonSession } from "./comparison-session.js";

const DTS = "src/solver/analog/__tests__/ngspice-parity/fixtures/rc-transient.dts";
const AC_PARAMS = {
  type: "dec" as const,
  numPoints: 5,
  fStart: 1,
  fStop: 10000,
  outputNodes: [] as string[],
};

it("ac_first_divergence_happy_path_self_compare_clean", async () => {
  const session = await ComparisonSession.createSelfCompare({
    dtsPath: DTS,
    analysis: "ac",
    acParams: AC_PARAMS,
  });

  const report = session.acFirstDivergence();
  expect(report.solution).toBeNull();
  expect(report.shape).toBeNull();
  expect(report.matrix).toBeNull(); // selfCompare clone matches bit-exact.
  expect(report.earliestPointIndex).toBeNull();
}, 30_000);

it("ac_first_divergence_detects_forced_solution_mismatch", async () => {
  const session = await ComparisonSession.createSelfCompare({
    dtsPath: DTS,
    analysis: "ac",
    acParams: AC_PARAMS,
  });

  // Forced mismatch: nudge ngspice-side solRe at point 2, row 1 by 1e-3.
  // bit-exact bar means even a sub-ULP nudge would be flagged, but 1e-3 is
  // unambiguous and easy to verify.
  const ngsp = session.ngspiceAcSession!;
  expect(ngsp.points.length).toBeGreaterThanOrEqual(3);
  const targetPoint = 2;
  const targetRow  = 1;
  const originalRe = ngsp.points[targetPoint].solRe[targetRow];
  const originalIm = ngsp.points[targetPoint].solIm[targetRow];
  ngsp.points[targetPoint].solRe[targetRow] = originalRe + 1e-3;

  const report = session.acFirstDivergence();
  expect(report.solution).not.toBeNull();
  expect(report.shape).toBeNull(); // freq/matrixSize unchanged.
  expect(report.matrix).toBeNull();
  expect(report.earliestPointIndex).toBe(targetPoint);

  const s = report.solution!;
  expect(s.pointIndex).toBe(targetPoint);
  expect(s.row).toBe(targetRow);
  expect(s.freq).toBe(session.acSession!.points[targetPoint].freq);
  // Ours side is unchanged; ngspice = ours + 1e-3 on Re.
  expect(s.ours.re).toBe(originalRe);
  expect(s.ours.im).toBe(originalIm);
  expect(s.ngspice.re).toBe(originalRe + 1e-3);
  expect(s.ngspice.im).toBe(originalIm);
  // |ours - ngspice| = |0 + 1e-3 + 0i| = 1e-3.
  expect(s.absDelta).toBeCloseTo(1e-3, 15);
  expect(s.relDelta).toBeGreaterThan(0);
  expect(Number.isFinite(s.relDelta)).toBe(true);
}, 30_000);

it("ac_first_divergence_detects_shape_mismatch_ngspice_missing", async () => {
  const session = await ComparisonSession.createSelfCompare({
    dtsPath: DTS,
    analysis: "ac",
    acParams: AC_PARAMS,
  });

  // Forced shape mismatch: pop the last point off the ngspice side.
  const ngsp = session.ngspiceAcSession!;
  const ours = session.acSession!;
  const originalLen = ngsp.points.length;
  expect(originalLen).toBe(ours.points.length);
  const removed = ngsp.points.pop()!;
  const missingIdx = originalLen - 1;

  const report = session.acFirstDivergence();
  expect(report.shape).not.toBeNull();
  expect(report.matrix).toBeNull();
  // Solution may or may not also be flagged (self-compare zeros all rows),
  // but earliest must be the shape-mismatched index.
  expect(report.earliestPointIndex).toBe(missingIdx);

  const sh = report.shape!;
  expect(sh.pointIndex).toBe(missingIdx);
  expect(sh.kind).toBe("ngspice-missing");
  expect(sh.freq.ours).toBe(removed.freq);
  expect(sh.freq.ngspice).toBeNull();
  expect(sh.matrixSize.ours).toBe(removed.matrixSize);
  expect(sh.matrixSize.ngspice).toBeNull();
}, 30_000);

it("ac_first_divergence_detects_frequency_mismatch", async () => {
  const session = await ComparisonSession.createSelfCompare({
    dtsPath: DTS,
    analysis: "ac",
    acParams: AC_PARAMS,
  });

  // Forced frequency mismatch at point 3: bump ngspice-side freq.
  const ngsp = session.ngspiceAcSession!;
  expect(ngsp.points.length).toBeGreaterThanOrEqual(4);
  const targetPoint = 3;
  const originalFreq = ngsp.points[targetPoint].freq;
  ngsp.points[targetPoint].freq = originalFreq * 1.01;

  const report = session.acFirstDivergence();
  expect(report.shape).not.toBeNull();
  const sh = report.shape!;
  expect(sh.kind).toBe("frequency-mismatch");
  expect(sh.pointIndex).toBe(targetPoint);
  expect(sh.freq.ours).toBe(originalFreq);
  expect(sh.freq.ngspice).toBe(originalFreq * 1.01);
}, 30_000);

it("ac_first_divergence_throws_when_no_ac_run", async () => {
  const session = await ComparisonSession.createSelfCompare({
    dtsPath: DTS,
    analysis: "dcop",
  });
  expect(() => session.acFirstDivergence()).toThrow(/requires an AC sweep run/);
});
