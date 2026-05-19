import { describe, it, expect } from "vitest";
import { SparseSolver } from "../sparse-solver.js";

// ---------------------------------------------------------------------------
// Complex-mode SparseSolver tests.
//
// Exercises the unified solver's complex path: setComplex(true), the
// stampElement / stampElementImag pair, the FactorComplexMatrix /
// ComplexRowColElimination factorization, and SolveComplexMatrix.
// ---------------------------------------------------------------------------

interface ComplexEntry {
  r: number;
  c: number;
  re: number;
  im: number;
}

/**
 * Assemble and solve a complex system. Solver uses 1-based indices (0 = ground);
 * entries and RHS are 1-based. Returns { re, im } solution arrays of length n+1.
 */
function assembleSolveComplex(
  n: number,
  entries: ComplexEntry[],
  rhsRe: number[],
  rhsIm: number[],
): { re: Float64Array; im: Float64Array } {
  const solver = new SparseSolver();
  solver._initStructure();
  solver.setComplex(true);
  for (const { r, c, re, im } of entries) {
    const h = solver.allocElement(r, c);
    solver.stampElement(h, re);
    solver.stampElementImag(h, im);
  }
  const bRe = new Float64Array(n + 1);
  const bIm = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    bRe[i + 1] += rhsRe[i];
    bIm[i + 1] += rhsIm[i];
  }
  const result = solver.factor();
  expect(result).toBe(0);
  const xRe = new Float64Array(n + 1);
  const xIm = new Float64Array(n + 1);
  // ngspice spSolve(Matrix, RHS, Solution, iRHS, iSolution): the real and
  // imaginary halves are NOT adjacent- order is realRHS, realSol, imagRHS, imagSol.
  solver.solve(bRe, xRe, bIm, xIm);
  return { re: xRe, im: xIm };
}

describe("SparseSolver complex", () => {
  it("solves_diagonal_complex", () => {
    // A = diag(1+0j, 0+1j), b = [1+0j, 1+0j].
    // x0 = 1 / 1 = 1+0j;  x1 = 1 / j = -j.
    const { re, im } = assembleSolveComplex(
      2,
      [
        { r: 1, c: 1, re: 1, im: 0 },
        { r: 2, c: 2, re: 0, im: 1 },
      ],
      [1, 1],
      [0, 0],
    );
    expect(re[1]).toBeCloseTo(1, 12);
    expect(im[1]).toBeCloseTo(0, 12);
    expect(re[2]).toBeCloseTo(0, 12);
    expect(im[2]).toBeCloseTo(-1, 12);
  });

  it("solves_2x2_dense_complex", () => {
    // A = [[2+0j, 1+0j], [1+0j, 2+1j]],  b = [1+0j, 0+0j].
    // det = 2*(2+j) - 1*1 = 3+2j.
    // x0 = (2+j)/(3+2j) = (8 - j)/13.
    // x1 = -1/(3+2j)    = (-3 + 2j)/13.
    const { re, im } = assembleSolveComplex(
      2,
      [
        { r: 1, c: 1, re: 2, im: 0 },
        { r: 1, c: 2, re: 1, im: 0 },
        { r: 2, c: 1, re: 1, im: 0 },
        { r: 2, c: 2, re: 2, im: 1 },
      ],
      [1, 0],
      [0, 0],
    );
    expect(re[1]).toBeCloseTo(8 / 13, 12);
    expect(im[1]).toBeCloseTo(-1 / 13, 12);
    expect(re[2]).toBeCloseTo(-3 / 13, 12);
    expect(im[2]).toBeCloseTo(2 / 13, 12);
  });

  it("complex_mode_with_zero_imag_matches_real_solve", () => {
    // A = [[4,1],[1,3]] (all imaginary parts zero), b = [1+0j, 2+0j].
    // A real matrix solved through the complex path must give the real
    // answer x = [1/11, 7/11] with identically zero imaginary part.
    const { re, im } = assembleSolveComplex(
      2,
      [
        { r: 1, c: 1, re: 4, im: 0 },
        { r: 1, c: 2, re: 1, im: 0 },
        { r: 2, c: 1, re: 1, im: 0 },
        { r: 2, c: 2, re: 3, im: 0 },
      ],
      [1, 2],
      [0, 0],
    );
    expect(re[1]).toBeCloseTo(1 / 11, 12);
    expect(re[2]).toBeCloseTo(7 / 11, 12);
    expect(im[1]).toBe(0);
    expect(im[2]).toBe(0);
  });

  it("solves_3x3_tridiagonal_complex", () => {
    // A = [[2+0j, 1j, 0], [1j, 2+0j, 1j], [0, 1j, 2+0j]], b = [1, 1, 1] (real).
    // Verified by substituting the returned solution back into A·x.
    const A: ComplexEntry[] = [
      { r: 1, c: 1, re: 2, im: 0 },
      { r: 1, c: 2, re: 0, im: 1 },
      { r: 2, c: 1, re: 0, im: 1 },
      { r: 2, c: 2, re: 2, im: 0 },
      { r: 2, c: 3, re: 0, im: 1 },
      { r: 3, c: 2, re: 0, im: 1 },
      { r: 3, c: 3, re: 2, im: 0 },
    ];
    const { re, im } = assembleSolveComplex(3, A, [1, 1, 1], [0, 0, 0]);

    // Residual check: A·x must equal b.
    for (let row = 1; row <= 3; row++) {
      let accRe = 0;
      let accIm = 0;
      for (const e of A) {
        if (e.r !== row) continue;
        const xr = re[e.c];
        const xi = im[e.c];
        accRe += e.re * xr - e.im * xi;
        accIm += e.re * xi + e.im * xr;
      }
      expect(accRe).toBeCloseTo(1, 10);
      expect(accIm).toBeCloseTo(0, 10);
    }
  });
});
