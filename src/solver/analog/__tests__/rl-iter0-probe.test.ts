import { describe, it, expect } from "vitest";
import { SparseSolver } from "../sparse-solver.js";

/**
 * Regression probe for the harness matrix-snapshot bug.
 *
 * SparseSolver factorization mutates the element pool (`_elVal[e]`) in place
 * so that post-factor reads via getCSCNonZeros() reflect the combined L/U
 * values, not the A matrix that was factored (see sparse-solver.ts
 * _numericLUMarkowitz lines 1055/1067/1084 and _numericLUReusePivots lines
 * 1183/1192). createIterationCaptureHook in __tests__/harness/capture.ts
 * used to capture matrix via getCSCNonZeros() from the postIterationHook —
 * which fires AFTER factor — so harness_get_attempt reported LU values as
 * the solved system.
 *
 * The fix: a parallel snapshot path (enablePreFactorMatrixCapture /
 * getPreFactorMatrixSnapshot) that captures _elVal at factor() entry. These
 * tests pin the invariants:
 *   - getCSCNonZeros() post-factor is the mutated pool (LU values).
 *   - getPreFactorMatrixSnapshot() is the A matrix that factor() consumed,
 *     so it satisfies A·x = b for the solution the engine computed.
 */
describe("SparseSolver pre-factor matrix snapshot", () => {
  function stampRL(solver: SparseSolver) {
    // 4x4 MNA system from an RL step at t=0, ag[0]=1e7, L=1e-3, R=10Ω, Vs=1V.
    // Indices: 0=V(Vs/R:A), 1=V(R:B/L:A), 2=I(Vs:branch), 3=I(L:branch)
    const entries: Array<[number, number, number]> = [
      [0, 0,  0.1], [0, 1, -0.1], [0, 2,  1],
      [1, 0, -0.1], [1, 1,  0.1], [1, 3,  1],
      [2, 0,  1],
      [3, 1,  1], [3, 3, -10000],
    ];
    solver.beginAssembly(4);
    for (const [r, c, v] of entries) {
      const h = solver.allocElement(r, c);
      solver.stampElement(h, v);
    }
    solver.stampRHS(2, 1);
    solver.stampRHS(3, -1000);
    solver.finalize();
  }

  it("solves the RL iter-0 system correctly", () => {
    const solver = new SparseSolver();
    stampRL(solver);
    const ok = solver.factor();
    expect(ok.success).toBe(true);
    const x = new Float64Array(4);
    solver.solve(x);
    expect(x[0]).toBeCloseTo(1, 10);
    expect(x[1]).toBeCloseTo(0, 6);
    expect(x[2]).toBeCloseTo(-0.1, 10);
    expect(x[3]).toBeCloseTo(0.1, 10);
  });

  it("getCSCNonZeros() after factor() returns LU values, not the A matrix", () => {
    const solver = new SparseSolver();
    stampRL(solver);

    // Snapshot pool values BEFORE factor — ground truth for the A matrix.
    const beforeFactor = solver.getCSCNonZeros();
    solver.factor();
    const afterFactor = solver.getCSCNonZeros();

    // Same shape: factor() does not add/remove non-FILL-IN entries.
    expect(afterFactor.length).toBe(beforeFactor.length);

    // Values must differ somewhere — if they didn't, the mutation thesis
    // would be wrong and the capture bug wouldn't exist.
    const key = (e: { row: number; col: number }) => `${e.row},${e.col}`;
    const beforeMap = new Map(beforeFactor.map(e => [key(e), e.value]));
    let diffs = 0;
    for (const e of afterFactor) {
      const b = beforeMap.get(key(e))!;
      if (Math.abs(b - e.value) > 1e-12) diffs++;
    }
    expect(diffs).toBeGreaterThan(0);
  });

  it("getPreFactorMatrixSnapshot() returns the A matrix consumed by factor()", () => {
    const solver = new SparseSolver();
    solver.enablePreFactorMatrixCapture(true);
    solver.enablePreSolveRhsCapture(true);
    stampRL(solver);

    // Before factor, snapshot is empty — factor() has not run yet.
    expect(solver.getPreFactorMatrixSnapshot().length).toBe(0);

    solver.factor();
    const x = new Float64Array(4);
    solver.solve(x);

    // Snapshot is populated with the A matrix (NOT the post-factor LU values).
    const snap = solver.getPreFactorMatrixSnapshot();
    expect(snap.length).toBeGreaterThan(0);

    // A·x = b must hold for the snapshot + preSolveRhs + solution the solver
    // produced. This is what the harness consumer actually verifies.
    const rhs = solver.getPreSolveRhsSnapshot();
    const residual = new Float64Array(4);
    for (let i = 0; i < 4; i++) residual[i] = -rhs[i];
    for (const { row, col, value } of snap) {
      residual[row] += value * x[col];
    }
    for (let i = 0; i < 4; i++) {
      expect(Math.abs(residual[i])).toBeLessThan(1e-9);
    }
  });

  it("pre-factor snapshot refreshes on subsequent factor() calls", () => {
    const solver = new SparseSolver();
    solver.enablePreFactorMatrixCapture(true);
    stampRL(solver);
    solver.factor();
    const firstSnap = solver.getPreFactorMatrixSnapshot().map(e => ({ ...e }));

    // Restamp with different values and refactor.
    solver.beginAssembly(4);
    const entries: Array<[number, number, number]> = [
      [0, 0,  0.2], [0, 1, -0.2], [0, 2,  1],
      [1, 0, -0.2], [1, 1,  0.2], [1, 3,  1],
      [2, 0,  1],
      [3, 1,  1], [3, 3, -5000],
    ];
    for (const [r, c, v] of entries) {
      const h = solver.allocElement(r, c);
      solver.stampElement(h, v);
    }
    solver.finalize();
    solver.factor();
    const secondSnap = solver.getPreFactorMatrixSnapshot();

    // (1,1) was 0.1 first time, 0.2 second time — the snapshot must track.
    const v11_first = firstSnap.find(e => e.row === 1 && e.col === 1)!.value;
    const v11_second = secondSnap.find(e => e.row === 1 && e.col === 1)!.value;
    expect(v11_first).toBeCloseTo(0.1, 12);
    expect(v11_second).toBeCloseTo(0.2, 12);
  });
});
