/**
 * ComplexSparseSolver — complex-valued sparse linear solver for AC analysis.
 *
 * Implements the same COO→CSC→AMD→symbolic→numeric LU pipeline as SparseSolver,
 * but with complex arithmetic. The matrix is stored as two real matrices
 * (real part and imaginary part), and the solve uses complex LU factorization.
 *
 * Implementation: the complex N×N system Ax=b is solved by expanding to a
 * real 2N×2N system using the standard block representation:
 *
 *   [ A_re  -A_im ] [ x_re ]   [ b_re ]
 *   [ A_im   A_re ] [ x_im ] = [ b_im ]
 *
 * This reuses the existing real SparseSolver without requiring a complex LU
 * factorization from scratch. The symbolic phase (AMD, elimination tree) is
 * built once for the 2N×2N system; numeric factorization runs each frequency.
 *
 * The 2N×2N layout maps index i to real part and index i+N to imaginary part:
 *   row/col i       → real component of original row/col i
 *   row/col i+N     → imaginary component of original row/col i
 */

import { SparseSolver } from "./sparse-solver.js";
import type { ComplexSparseSolver as IComplexSparseSolver } from "./element.js";

export class ComplexSparseSolver implements IComplexSparseSolver {
  private _solver: SparseSolver = new SparseSolver();
  private _n: number = 0;

  /** Begin assembly for an N×N complex system (expands to 2N×2N real). */
  beginAssembly(n: number): void {
    this._n = n;
    this._solver.beginAssembly(2 * n);
  }

  /**
   * Add a complex value (re + j·im) to position (row, col) of the N×N complex matrix.
   *
   * Block expansion:
   *   A_re[row, col] += re  →  real[row,   col  ]
   *   A_im[row, col] += im  →  real[row+N, col  ]
   *  -A_im[row, col] → real[row,   col+N]
   *   A_re[row, col] → real[row+N, col+N]
   */
  stamp(row: number, col: number, re: number, im: number): void {
    const n = this._n;
    // Top-left block: A_re
    if (re !== 0) {
      this._solver.stamp(row, col, re);
      this._solver.stamp(row + n, col + n, re);
    }
    // Off-diagonal blocks: -A_im (top-right) and +A_im (bottom-left)
    if (im !== 0) {
      this._solver.stamp(row, col + n, -im);
      this._solver.stamp(row + n, col, im);
    }
  }

  /**
   * Add a complex value to position (row) of the RHS vector.
   */
  stampRHS(row: number, re: number, im: number): void {
    const n = this._n;
    if (re !== 0) this._solver.stampRHS(row, re);
    if (im !== 0) this._solver.stampRHS(row + n, im);
  }

  /**
   * Finalize assembly (build CSC, compute AMD ordering, symbolic LU).
   * Must be called after all stamp() / stampRHS() calls and before solve().
   */
  finalize(): void {
    this._solver.finalize();
  }

  /**
   * Factor the assembled matrix.
   * Returns true on success, false if singular.
   */
  factor(): boolean {
    const result = this._solver.factor();
    return result.success;
  }

  /**
   * Solve the assembled complex system.
   *
   * On return, xRe[i] and xIm[i] contain the real and imaginary parts of
   * the solution vector at index i, for i in 0..N-1.
   */
  solve(xRe: Float64Array, xIm: Float64Array): void {
    const n = this._n;
    const x = new Float64Array(2 * n);
    this._solver.solve(x);
    for (let i = 0; i < n; i++) {
      xRe[i] = x[i];
      xIm[i] = x[i + n];
    }
  }
}
