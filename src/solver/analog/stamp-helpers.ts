/**
 * Shared MNA stamp helpers used by analog component elements.
 *
 * Caller-side convention is ngspice 1-based: node 0 is ground, nodes
 * 1..matrixSize are non-ground MNA rows. The solver itself routes
 * row==0 / col==0 to the TrashCan element (allocElement spbuild.c:272-273
 * + amendment A2) and drops row==0 RHS stamps; these helpers exist as a
 * thin convenience layer that mirrors the historical signature.
 */

import type { SparseSolver } from "./sparse-solver.js";

/** Stamp a conductance value into the G sub-matrix at (row, col). */
export function stampG(solver: SparseSolver, row: number, col: number, val: number): void {
  solver.stampElement(solver.allocElement(row, col), val);
}

/** Stamp a value into the RHS vector at row. */
export function stampRHS(solver: SparseSolver, row: number, val: number): void {
  solver.stampRHS(row, val);
}
