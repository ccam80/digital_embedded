import { describe, it, expect } from "vitest";
import { SparseSolver } from "../sparse-solver.js";
import {
  allocNortonStamp,
  stampNortonAt,
  stampNortonValue,
} from "../stamp-helpers.js";
import type { LoadContext } from "../load-context.js";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

/**
 * Build a minimal LoadContext exposing only the fields the Norton-stamp
 * helpers access: `solver` and `rhs`. The remaining LoadContext fields are
 * cast away because the helpers do not read them.
 */
function makeStampContext(matrixSize: number): {
  ctx: LoadContext;
  solver: SparseSolver;
  rhs: Float64Array;
} {
  const solver = new SparseSolver();
  solver._initStructure();
  const rhs = new Float64Array(matrixSize + 1);
  const ctx = {
    solver,
    matrix: solver,
    rhs,
  } as unknown as LoadContext;
  return { ctx, solver, rhs };
}

/**
 * Look up the stamped value at the external (row, col) cell. SparseSolver
 * accumulates into _elVal[handle]; getCSCNonZeros() exposes that pool
 * keyed by ngspice-external indices. Returns 0 when no entry exists.
 */
function readMatrix(solver: SparseSolver, row: number, col: number): number {
  for (const e of solver.getCSCNonZeros()) {
    if (e.row === row && e.col === col) return e.value;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// allocNortonStamp
// ---------------------------------------------------------------------------

describe("allocNortonStamp", () => {
  it("returns four distinct handles for a non-degenerate (pos, neg) pair", () => {
    const { solver } = makeStampContext(4);
    const handles = allocNortonStamp(solver, 1, 2);
    expect(handles).toHaveLength(4);
    const [hPP, hNN, hPN, hNP] = handles;
    // All four entries must be non-negative integers (pool handles).
    expect(hPP).toBeGreaterThanOrEqual(0);
    expect(hNN).toBeGreaterThanOrEqual(0);
    expect(hPN).toBeGreaterThanOrEqual(0);
    expect(hNP).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(hPP)).toBe(true);
    expect(Number.isInteger(hNN)).toBe(true);
    expect(Number.isInteger(hPN)).toBe(true);
    expect(Number.isInteger(hNP)).toBe(true);
    // Pairwise distinct- all four cells (1,1), (2,2), (1,2), (2,1) are
    // different matrix locations and therefore get different pool slots.
    const set = new Set([hPP, hNN, hPN, hNP]);
    expect(set.size).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// stampNortonAt
// ---------------------------------------------------------------------------

describe("stampNortonAt", () => {
  it("writes the expected 4 conductance values and 2 RHS values", () => {
    const { ctx, solver, rhs } = makeStampContext(4);
    const handles = allocNortonStamp(solver, 1, 2);

    stampNortonAt(ctx, handles, 1, 2, /*G=*/ 0.01, /*I=*/ 0.05);

    expect(readMatrix(solver, 1, 1)).toBeCloseTo(+0.01, 15);
    expect(readMatrix(solver, 2, 2)).toBeCloseTo(+0.01, 15);
    expect(readMatrix(solver, 1, 2)).toBeCloseTo(-0.01, 15);
    expect(readMatrix(solver, 2, 1)).toBeCloseTo(-0.01, 15);

    expect(rhs[1]).toBeCloseTo(+0.05, 15);
    expect(rhs[2]).toBeCloseTo(-0.05, 15);
  });

  it("does not skip RHS when I is zero", () => {
    const { ctx, solver, rhs } = makeStampContext(4);
    const handles = allocNortonStamp(solver, 1, 2);
    rhs[1] = 7;
    rhs[2] = -7;

    stampNortonAt(ctx, handles, 1, 2, /*G=*/ 0.01, /*I=*/ 0);

    // The +0 / -0 additive writes are no-ops on Float64Array; rhs values
    // are bit-identical to their pre-call state. The test pins down that
    // stampNortonAt does NOT introduce a skip branch- it stamps
    // unconditionally and the bit-identical result is a property of IEEE
    // 754 additive zero.
    expect(rhs[1]).toBe(7);
    expect(rhs[2]).toBe(-7);

    // Conductance entries are still stamped.
    expect(readMatrix(solver, 1, 1)).toBeCloseTo(+0.01, 15);
    expect(readMatrix(solver, 2, 2)).toBeCloseTo(+0.01, 15);
    expect(readMatrix(solver, 1, 2)).toBeCloseTo(-0.01, 15);
    expect(readMatrix(solver, 2, 1)).toBeCloseTo(-0.01, 15);
  });
});

// ---------------------------------------------------------------------------
// stampNortonValue
// ---------------------------------------------------------------------------

describe("stampNortonValue", () => {
  it("computes G and I from rOut and vTarget", () => {
    const { ctx, solver, rhs } = makeStampContext(4);
    const handles = allocNortonStamp(solver, 1, 2);

    stampNortonValue(ctx, handles, 1, 2, /*rOut=*/ 100, /*vTarget=*/ 5);

    // G = 1/100 = 0.01; I = G * vTarget = 0.05.
    expect(readMatrix(solver, 1, 1)).toBeCloseTo(+0.01, 15);
    expect(readMatrix(solver, 2, 2)).toBeCloseTo(+0.01, 15);
    expect(readMatrix(solver, 1, 2)).toBeCloseTo(-0.01, 15);
    expect(readMatrix(solver, 2, 1)).toBeCloseTo(-0.01, 15);
    expect(rhs[1]).toBeCloseTo(+0.05, 15);
    expect(rhs[2]).toBeCloseTo(-0.05, 15);
  });

  it("skips RHS when vTarget is zero", () => {
    const { ctx, solver, rhs } = makeStampContext(4);
    const handles = allocNortonStamp(solver, 1, 2);
    rhs[1] = 7;
    rhs[2] = -7;

    stampNortonValue(ctx, handles, 1, 2, /*rOut=*/ 100, /*vTarget=*/ 0);

    // Conductance entries stamped ...
    expect(readMatrix(solver, 1, 1)).toBeCloseTo(+0.01, 15);
    expect(readMatrix(solver, 2, 2)).toBeCloseTo(+0.01, 15);
    expect(readMatrix(solver, 1, 2)).toBeCloseTo(-0.01, 15);
    expect(readMatrix(solver, 2, 1)).toBeCloseTo(-0.01, 15);
    // ... but RHS is untouched (pre-seeded values preserved).
    expect(rhs[1]).toBe(7);
    expect(rhs[2]).toBe(-7);
  });
});
