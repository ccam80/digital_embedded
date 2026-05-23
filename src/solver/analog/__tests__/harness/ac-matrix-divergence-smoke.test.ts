/**
 * AC matrix-class divergence smoke test (Phase 3b).
 *
 * Phase 3b extended `AcCapturePoint` with the loaded complex matrix CSC
 * (now captured pre-factor on our side via `SparseSolver.getComplexCSCNonZeros`
 * + the ac-analysis snapshot sink, and on the ngspice side via the bridge's
 * `ni_ac_capture_matrix` hook from Phase 1b). This smoke exercises the
 * matrix class in `acFirstDivergence`:
 *   - happy path: selfCompare clone matches bit-exact -> matrix is null.
 *   - value-mismatch: mutate a single cell's real part.
 *   - ngspice-only: structurally remove a cell from the ngspice CSC.
 *   - ours-only: structurally remove a cell from the ours CSC.
 *
 * SelfCompare is the right tier here- it tests the walk logic, the deep
 * clone path, and the type contract without a DLL dependency. Real
 * bridge-paired matrix divergence lands when Phase 3c wires the MCP
 * `harness_ac_*` tools and gets exercised against real fixtures.
 */

import { it, expect } from "vitest";
import { ComparisonSession } from "./comparison-session.js";
import type { AcCapturePoint } from "./types.js";

const DTS = "src/solver/analog/__tests__/ngspice-parity/fixtures/rc-transient.dts";
const AC_PARAMS = {
  type: "dec" as const,
  numPoints: 5,
  fStart: 1,
  fStop: 10000,
  outputNodes: [] as string[],
};

/**
 * Build a new CSC by removing the cell at `cellIdx`. Used to forge
 * structural divergence in the smoke- a real CSC produced by ngspice or
 * our solver always has consistent colPtr/rowIdx/vals*, so we synthesise
 * the structurally-different CSC here rather than trying to mutate in place.
 */
function removeMatrixCell(mat: NonNullable<AcCapturePoint["matrix"]>, cellIdx: number): NonNullable<AcCapturePoint["matrix"]> {
  const newNnz = mat.nnz - 1;
  const rowIdx = new Int32Array(newNnz);
  const valsRe = new Float64Array(newNnz);
  const valsIm = new Float64Array(newNnz);
  let dst = 0;
  for (let src = 0; src < mat.nnz; src++) {
    if (src === cellIdx) continue;
    rowIdx[dst] = mat.rowIdx[src];
    valsRe[dst] = mat.valsRe[src];
    valsIm[dst] = mat.valsIm[src];
    dst++;
  }
  // Any colPtr entry strictly greater than cellIdx shifts down by one
  // (the removal compressed the array; entries at or before cellIdx are
  // unchanged because they reference cells that did not move).
  const colPtr = new Int32Array(mat.colPtr.length);
  for (let c = 0; c < mat.colPtr.length; c++) {
    colPtr[c] = mat.colPtr[c] > cellIdx ? mat.colPtr[c] - 1 : mat.colPtr[c];
  }
  return { nnz: newNnz, colPtr, rowIdx, valsRe, valsIm };
}

it("ac_matrix_divergence_happy_path_self_compare_clean", async () => {
  const session = await ComparisonSession.createSelfCompare({
    dtsPath: DTS,
    analysis: "ac",
    acParams: AC_PARAMS,
  });

  // SelfCompare deep-clones our matrix to ngspice side, so cells match bit-exact.
  const ours = session.acSession!;
  expect(ours.points[0].matrix).toBeDefined();
  expect(ours.points[0].matrix!.nnz).toBeGreaterThan(0);

  const report = session.acFirstDivergence();
  expect(report.matrix).toBeNull();
  expect(report.solution).toBeNull();
  expect(report.shape).toBeNull();
}, 30_000);

it("ac_matrix_divergence_detects_value_mismatch", async () => {
  const session = await ComparisonSession.createSelfCompare({
    dtsPath: DTS,
    analysis: "ac",
    acParams: AC_PARAMS,
  });

  // Forced value mismatch at point 2, CSC cell 0 (after CSC sort: first cell
  // is min-col, min-row). Nudge ngspice's real value by 1e-3.
  const ngsp = session.ngspiceAcSession!;
  expect(ngsp.points.length).toBeGreaterThanOrEqual(3);
  const targetPoint = 2;
  const targetCell  = 0;
  const targetMatrix = ngsp.points[targetPoint].matrix!;
  const originalRe = targetMatrix.valsRe[targetCell];
  const originalIm = targetMatrix.valsIm[targetCell];
  const expectedRow = targetMatrix.rowIdx[targetCell];
  // Walk colPtr to derive which column the first cell lives in.
  let expectedCol = -1;
  for (let c = 1; c < targetMatrix.colPtr.length; c++) {
    if (targetMatrix.colPtr[c - 1] <= targetCell && targetCell < targetMatrix.colPtr[c]) {
      expectedCol = c - 1 + 1; // 1-based col matching the walk's emission
      break;
    }
  }
  expect(expectedCol).toBeGreaterThan(0);
  targetMatrix.valsRe[targetCell] = originalRe + 1e-3;

  const report = session.acFirstDivergence();
  expect(report.matrix).not.toBeNull();
  const m = report.matrix!;
  expect(m.pointIndex).toBe(targetPoint);
  expect(m.kind).toBe("value-mismatch");
  expect(m.row).toBe(expectedRow);
  expect(m.col).toBe(expectedCol);
  expect(m.ours).not.toBeNull();
  expect(m.ngspice).not.toBeNull();
  expect(m.ours!.re).toBe(originalRe);
  expect(m.ours!.im).toBe(originalIm);
  expect(m.ngspice!.re).toBe(originalRe + 1e-3);
  expect(m.ngspice!.im).toBe(originalIm);
  expect(m.absDelta).toBeCloseTo(1e-3, 15);
  expect(m.relDelta).toBeGreaterThan(0);
  expect(Number.isFinite(m.relDelta)).toBe(true);
  // earliestPointIndex picks the earliest across all classes; solution and
  // shape are clean here, so matrix.pointIndex wins.
  expect(report.earliestPointIndex).toBe(targetPoint);
}, 30_000);

it("ac_matrix_divergence_detects_ngspice_only_cell_removal", async () => {
  const session = await ComparisonSession.createSelfCompare({
    dtsPath: DTS,
    analysis: "ac",
    acParams: AC_PARAMS,
  });

  // Forced structural mismatch: remove the LAST CSC cell from ngspice at
  // point 2. After the walk's (col asc, row asc) iteration order, this cell
  // is the one our walk reaches at the end; first-class report surfaces an
  // earlier cell only if there's a value mismatch before then- there isn't,
  // so the walk reaches the removed cell and reports "ours-only".
  const ngsp = session.ngspiceAcSession!;
  const targetPoint = 2;
  const origNg = ngsp.points[targetPoint].matrix!;
  const lastCellIdx = origNg.nnz - 1;
  const expectedRow = origNg.rowIdx[lastCellIdx];
  let expectedCol = -1;
  for (let c = 1; c < origNg.colPtr.length; c++) {
    if (origNg.colPtr[c - 1] <= lastCellIdx && lastCellIdx < origNg.colPtr[c]) {
      expectedCol = c - 1 + 1;
      break;
    }
  }
  expect(expectedCol).toBeGreaterThan(0);

  ngsp.points[targetPoint].matrix = removeMatrixCell(origNg, lastCellIdx);

  const report = session.acFirstDivergence();
  expect(report.matrix).not.toBeNull();
  const m = report.matrix!;
  expect(m.pointIndex).toBe(targetPoint);
  expect(m.kind).toBe("ours-only");
  expect(m.row).toBe(expectedRow);
  expect(m.col).toBe(expectedCol);
  expect(m.ours).not.toBeNull();
  expect(m.ngspice).toBeNull();
  expect(m.absDelta).toBe(0);
  expect(m.relDelta).toBe(0);
}, 30_000);

it("ac_matrix_divergence_detects_ours_only_cell_removal", async () => {
  const session = await ComparisonSession.createSelfCompare({
    dtsPath: DTS,
    analysis: "ac",
    acParams: AC_PARAMS,
  });

  // Mirror of the previous- remove the last cell from OURS instead so the
  // walk reports "ngspice-only" at the same coordinate.
  const ours = session.acSession!;
  const targetPoint = 2;
  const origOurs = ours.points[targetPoint].matrix!;
  const lastCellIdx = origOurs.nnz - 1;
  const expectedRow = origOurs.rowIdx[lastCellIdx];
  let expectedCol = -1;
  for (let c = 1; c < origOurs.colPtr.length; c++) {
    if (origOurs.colPtr[c - 1] <= lastCellIdx && lastCellIdx < origOurs.colPtr[c]) {
      expectedCol = c - 1 + 1;
      break;
    }
  }
  expect(expectedCol).toBeGreaterThan(0);

  ours.points[targetPoint].matrix = removeMatrixCell(origOurs, lastCellIdx);

  const report = session.acFirstDivergence();
  expect(report.matrix).not.toBeNull();
  const m = report.matrix!;
  expect(m.pointIndex).toBe(targetPoint);
  expect(m.kind).toBe("ngspice-only");
  expect(m.row).toBe(expectedRow);
  expect(m.col).toBe(expectedCol);
  expect(m.ours).toBeNull();
  expect(m.ngspice).not.toBeNull();
  expect(m.absDelta).toBe(0);
  expect(m.relDelta).toBe(0);
}, 30_000);
