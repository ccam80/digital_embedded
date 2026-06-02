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
import type { LoadContext } from "./load-context.js";

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

/**
 * Absolute RHS write- `CKTrhs[node->number] = value` (assignment), not
 * accumulate. cktload.c:113,117,139,145 overwrite the device load()
 * contribution at a pinned nodeset/IC row, discarding whatever the device
 * loop accumulated there. Distinct from the additive stampRHS.
 */
export function setRHS(rhs: Float64Array, node: number, value: number): void {
  rhs[node] = value;
}

/**
 * Allocate the 4 conductance matrix handles for a 2-terminal Norton port
 * at (posNode, negNode). Returns the tuple [hPP, hNN, hPN, hNP] (source
 * spec §6.8; call sites behavioral-output-driver.ts:166-212 and
 * capacitor.ts:217-220).
 */
export function allocNortonStamp(
  solver: SparseSolver,
  posNode: number,
  negNode: number,
): readonly [number, number, number, number] {
  const hPP = solver.allocElement(posNode, posNode);
  const hNN = solver.allocElement(negNode, negNode);
  const hPN = solver.allocElement(posNode, negNode);
  const hNP = solver.allocElement(negNode, posNode);
  return [hPP, hNN, hPN, hNP];
}

/**
 * Stamp a Norton-equivalent (G in parallel with current source I) at the
 * pre-allocated 4 conductance handles and add `+I` / `-I` to rhs[posNode]
 * / rhs[negNode]. Always stamps RHS — no skip (source spec §6.8; pattern
 * matches capacitor.ts:217-220).
 */
export function stampNortonAt(
  ctx: LoadContext,
  handles: readonly [number, number, number, number],
  posNode: number,
  negNode: number,
  G: number,
  I: number,
): void {
  const solver = ctx.solver;
  solver.stampElement(handles[0],  G);
  solver.stampElement(handles[1],  G);
  solver.stampElement(handles[2], -G);
  solver.stampElement(handles[3], -G);
  ctx.rhs[posNode] += I;
  ctx.rhs[negNode] -= I;
}

/**
 * Stamp a Thévenin-form Norton port: `G = 1 / rOut`, `I = G * vTarget`.
 * Stamps the four ±G conductance entries unconditionally and the two RHS
 * entries only when `I !== 0` (preserves the existing
 * behavioral-output-driver.ts:206-209 skip). Source spec §6.8.
 */
export function stampNortonValue(
  ctx: LoadContext,
  handles: readonly [number, number, number, number],
  posNode: number,
  negNode: number,
  rOut: number,
  vTarget: number,
): void {
  const G = 1 / rOut;
  const I = G * vTarget;
  const solver = ctx.solver;
  solver.stampElement(handles[0],  G);
  solver.stampElement(handles[1],  G);
  solver.stampElement(handles[2], -G);
  solver.stampElement(handles[3], -G);
  if (I !== 0) {
    ctx.rhs[posNode] += I;
    ctx.rhs[negNode] -= I;
  }
}
