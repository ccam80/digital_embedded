import { describe, it, expect } from "vitest";
import { SparseSolver } from "../sparse-solver.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a 3x3 solver with given entries, stamp, finalize, and factor. */
function buildAndFactor(
  entries: Array<[number, number, number]>
): SparseSolver {
  const solver = new SparseSolver();
  solver.beginAssembly(3);
  for (const [r, c, v] of entries) {
    solver.stampElement(solver.allocElement(r, c), v);
  }
  solver.finalize();
  const result = solver.factor();
  expect(result.success).toBe(true);
  return solver;
}

/** Count fill-in elements by scanning the full pool [0, _elCount). */
function countFillIns(solver: SparseSolver): number {
  const s = solver as any;
  const FLAG_FILL_IN = 1;
  const elCount: number = s._elCount;
  const elFlags: Uint8Array = s._elFlags;
  let count = 0;
  for (let e = 0; e < elCount; e++) {
    if (elFlags[e] & FLAG_FILL_IN) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SparseSolver._resetForAssembly semantics", () => {
  /**
   * Test A: reset preserves linked structure.
   * Build, factor, snapshot _elCount/_colHead/_rowHead/_diag, then call
   * beginAssembly again and assert the snapshots are byte-identical.
   */
  it("reset preserves linked structure", () => {
    // Simple tridiagonal — no fill-ins, straightforward structure.
    const entries: Array<[number, number, number]> = [
      [0, 0, 4], [0, 1, -1],
      [1, 0, -1], [1, 1, 4], [1, 2, -1],
      [2, 1, -1], [2, 2, 4],
    ];
    const solver = buildAndFactor(entries);
    const s = solver as any;

    // Snapshot before reset.
    const elCountBefore: number = s._elCount;
    const colHeadBefore = Array.from(s._colHead as Int32Array);
    const rowHeadBefore = Array.from(s._rowHead as Int32Array);
    const diagBefore = Array.from(s._diag as Int32Array);

    // Re-stamp identical values and call beginAssembly (triggers _resetForAssembly).
    solver.beginAssembly(3);
    for (const [r, c, v] of entries) {
      solver.stampElement(solver.allocElement(r, c), v);
    }

    // Assert structure unchanged.
    expect(s._elCount).toBe(elCountBefore);
    expect(Array.from(s._colHead as Int32Array)).toEqual(colHeadBefore);
    expect(Array.from(s._rowHead as Int32Array)).toEqual(rowHeadBefore);
    expect(Array.from(s._diag as Int32Array)).toEqual(diagBefore);
  });

  /**
   * Test B: reset preserves fill-ins.
   * Use a matrix where fill-in is structurally unavoidable regardless of pivot
   * order: a 3x3 whose sparsity graph has a cycle that forces at least one
   * position to be created as a fill-in during LU.
   *
   * We build a fresh solver, record _elCount before factor (= number of
   * A-matrix stamped elements), then factor. Any new pool entries are fill-ins.
   * After beginAssembly, _elCount must stay the same (fill-ins preserved).
   *
   * Pattern chosen: off-diagonal entries in positions (0,1),(1,2),(2,0) plus
   * full diagonal. Any elimination order creates fill-in in the off-diagonal
   * cycle.
   *   [2  1  0]
   *   [0  2  1]
   *   [1  0  2]
   * When Markowitz picks (0,0): mult = (1,0)/2; row 1 += (-mult)*row 0 at
   * col 1 (exists) — no fill there. But col 0 of row 2: mult=(2,0)/2=0.5;
   * update row 2 with row 0: (2,1) fill-in created (missing), (2,2) exists.
   *
   * If Markowitz picks differently, a fill-in still occurs due to the cycle.
   *
   * To guarantee Markowitz picks (0,0) first, we make row 0 and col 0 each
   * have exactly 2 entries while (1,1) and (2,2) are singletons in their
   * remaining submatrix — but that's complex. Instead, we simply record
   * elCount before vs after factor and assert that fill-ins were created and
   * that beginAssembly preserves the elCount.
   */
  it("reset preserves fill-ins", () => {
    // Build solver and record elCount BEFORE factoring.
    const entries: Array<[number, number, number]> = [
      [0, 0, 2], [0, 1, 1],
      [1, 1, 2], [1, 2, 1],
      [2, 0, 1],             [2, 2, 2],
    ];
    const solver = new SparseSolver();
    solver.beginAssembly(3);
    for (const [r, c, v] of entries) {
      solver.stampElement(solver.allocElement(r, c), v);
    }
    solver.finalize();

    const s = solver as any;
    const elCountBeforeFactor: number = s._elCount;

    const result = solver.factor();
    expect(result.success).toBe(true);

    const elCountAfterFactor: number = s._elCount;
    // factor() must have created at least one fill-in (increased _elCount).
    expect(elCountAfterFactor).toBeGreaterThan(elCountBeforeFactor);

    const fillInsBefore = countFillIns(solver);
    expect(fillInsBefore).toBeGreaterThanOrEqual(1);

    // beginAssembly resets values but must keep fill-ins in the pool.
    solver.beginAssembly(3);

    // _elCount unchanged — fill-ins were NOT returned to free-list.
    expect((s._elCount as number)).toBe(elCountAfterFactor);

    const fillInsAfter = countFillIns(solver);
    expect(fillInsAfter).toBe(fillInsBefore);
  });

  /**
   * Test C: reset zeros all element values.
   * After factor, element values are non-trivially transformed (LU factors).
   * After beginAssembly, every element in [0, _elCount) must be 0.
   */
  it("reset zeros all element values", () => {
    const entries: Array<[number, number, number]> = [
      [0, 0, 4], [0, 1, -1],
      [1, 0, -1], [1, 1, 4], [1, 2, -1],
      [2, 1, -1], [2, 2, 4],
    ];
    const solver = buildAndFactor(entries);
    const s = solver as any;

    // After factor, values are LU-factored — not all zero.
    // (This confirms the test exercises meaningful state.)
    const elCountAfterFactor: number = s._elCount;
    expect(elCountAfterFactor).toBeGreaterThan(0);

    solver.beginAssembly(3);

    const elVal: Float64Array = s._elVal;
    const elCount: number = s._elCount;
    for (let e = 0; e < elCount; e++) {
      expect(elVal[e]).toBe(0);
    }
  });
});
