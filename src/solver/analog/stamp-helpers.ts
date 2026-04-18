/**
 * Shared MNA stamp helpers used by analog component elements.
 *
 * Node 0 is ground (reference) — stamps targeting row or column 0 are silently
 * dropped. All other indices are 1-based MNA node numbers, converted to
 * 0-based solver indices by subtracting 1 before calling into SparseSolver.
 */

import type { SparseSolver } from "./sparse-solver.js";

/**
 * Stamp a conductance value into the G sub-matrix at position (row, col).
 * Skips the entry when either row or col is 0 (ground node).
 */
export function stampG(solver: SparseSolver, row: number, col: number, val: number): void {
  if (row !== 0 && col !== 0) {
    solver.stampElement(solver.allocElement(row - 1, col - 1), val);
  }
}

/**
 * Stamp a value into the RHS vector at position row.
 * Skips the entry when row is 0 (ground node).
 */
export function stampRHS(solver: SparseSolver, row: number, val: number): void {
  if (row !== 0) {
    solver.stampRHS(row - 1, val);
  }
}
