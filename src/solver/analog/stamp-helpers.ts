/**
 * Shared MNA stamp helpers used by analog component elements.
 *
 * Caller-side convention is ngspice 1-based: node 0 is ground, nodes
 * 1..matrixSize are non-ground MNA rows. The solver itself routes
 * row==0 / col==0 to the TrashCan element (allocElement spbuild.c:272-273
 * + amendment A2). The RHS buffer is caller-owned (`ctx.rhs`, ngspice
 * CKTrhs); ground-row writes land in `rhs[0]`, which is consumed by no
 * one (spsolve reads only RHS[1..Size], spsolve.c:149-151) and is then
 * cleared post-solve in newton-raphson.ts (mirrors niiter.c:946-948).
 * Callers MUST NOT guard ground rows — match ngspice's unconditional
 * `*(ckt->CKTrhs+XxxNode) += val` (e.g., capload.c:78-79).
 */

import type { SparseSolver } from "./sparse-solver.js";

/** Stamp a conductance value into the G sub-matrix at (row, col). */
export function stampG(solver: SparseSolver, row: number, col: number, val: number): void {
  solver.stampElement(solver.allocElement(row, col), val);
}

/**
 * Additive RHS stamp- `*pCKTrhsPtr += val` analogue. ngspice device
 * code does `*(here->XxxNode) += val` directly into ckt->CKTrhs without
 * a ground guard (capload.c:78-79); we mirror that exactly. row == 0
 * lands in the ground sentinel rhs[0], which the post-SMPsolve clear in
 * newton-raphson.ts zeroes (niiter.c:946-948).
 */
export function stampRHS(rhs: Float64Array, row: number, val: number): void {
  rhs[row] += val;
}
