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

/**
 * Matrix handles for a linearized (controlled-source) Norton port: the four
 * self-conductance handles at (posNode, negNode) plus, for each control input
 * k, the pair of cross handles [(posNode, in_k), (negNode, in_k)] that carry
 * the Jacobian term ∂result/∂V(in_k). Allocate once in setup() over the full
 * set of nodes the result can depend on; load() stamps only the currently
 * active derivatives, leaving the rest structural-zero.
 */
export interface LinearizedNortonHandles {
  readonly self: readonly [number, number, number, number];
  readonly crossPos: readonly number[];
  readonly crossNeg: readonly number[];
}

export function allocLinearizedNorton(
  solver: SparseSolver,
  posNode: number,
  negNode: number,
  inputNodes: readonly number[],
): LinearizedNortonHandles {
  const self = allocNortonStamp(solver, posNode, negNode);
  const crossPos: number[] = [];
  const crossNeg: number[] = [];
  for (const inNode of inputNodes) {
    crossPos.push(solver.allocElement(posNode, inNode));
    crossNeg.push(solver.allocElement(negNode, inNode));
  }
  return { self, crossPos, crossNeg };
}

/**
 * Stamp a Norton port whose target voltage is a (piecewise-)differentiable
 * function f of its control-input voltages: it enforces V(pos)−V(neg) → f.
 * Stamps the self conductance G=1/rOut, the Jacobian cross-conductances
 * −G·dₖ at (pos,in_k) / +G·dₖ at (neg,in_k), and the Newton companion current
 * I = G·(resultOld − Σ dₖ·inputOld_k). With the derivative terms present the
 * coupled behavioral chain is a true Newton device that converges to its exact
 * fixed point in one iteration; a constant-source Norton read from rhsOld
 * instead lags one iteration per chain stage and the solver's reltol-based
 * termination accepts it ~reltol short of self-consistency.
 *
 * `derivs[k]` = ∂f/∂V(in_k); `inputsOld[k]` = the V(in_k)−V(gnd) value used to
 * evaluate f and its derivatives this iteration. dₖ===0 entries add no coupling.
 */
export function stampLinearizedNorton(
  ctx: LoadContext,
  handles: LinearizedNortonHandles,
  posNode: number,
  negNode: number,
  rOut: number,
  resultOld: number,
  derivs: readonly number[],
  inputsOld: readonly number[],
): void {
  const G = 1 / rOut;
  const solver = ctx.solver;
  solver.stampElement(handles.self[0],  G);
  solver.stampElement(handles.self[1],  G);
  solver.stampElement(handles.self[2], -G);
  solver.stampElement(handles.self[3], -G);
  let constResult = resultOld;
  for (let k = 0; k < derivs.length; k++) {
    const d = derivs[k]!;
    if (d !== 0) {
      solver.stampElement(handles.crossPos[k]!, -G * d);
      solver.stampElement(handles.crossNeg[k]!,  G * d);
      constResult -= d * inputsOld[k]!;
    }
  }
  const I = G * constResult;
  if (I !== 0) {
    ctx.rhs[posNode] += I;
    ctx.rhs[negNode] -= I;
  }
}
