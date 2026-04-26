/**
 * Shared MNA stamp helpers used by analog component elements.
 *
 * Caller-side convention is ngspice 1-based: node 0 is ground, nodes
 * 1..matrixSize are non-ground MNA rows. The solver itself routes
 * row==0 / col==0 to the TrashCan element (allocElement spbuild.c:272-273
 * + amendment A2). The RHS buffer is caller-owned (`ctx.rhs`, ngspice
 * CKTrhs); stamps with row == 0 hit the ground sentinel and are dropped.
 */

import type { SparseSolver } from "./sparse-solver.js";

/** Stamp a conductance value into the G sub-matrix at (row, col). */
export function stampG(solver: SparseSolver, row: number, col: number, val: number): void {
  solver.stampElement(solver.allocElement(row, col), val);
}

/**
 * Additive RHS stamp — `*pCKTrhsPtr += val` analogue. ngspice device
 * code does `*(here->XxxNode) += val` directly into ckt->CKTrhs;
 * digiTS callers pass `ctx.rhs` as the buffer. Drops stamps targeting
 * the ground row (row == 0) so callers don't need to guard.
 */
export function stampRHS(rhs: Float64Array, row: number, val: number): void {
  if (row !== 0) rhs[row] += val;
}
