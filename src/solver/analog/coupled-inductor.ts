/**
 * Coupled inductor pair — mutual inductance companion model.
 *
 * Two inductors L₁ and L₂ with coupling coefficient k produce mutual
 * inductance M = k·√(L₁·L₂). The companion model for each inductor branch
 * includes a self-term (standard inductor) and a cross-coupling term from the
 * other inductor's branch current history.
 *
 * MNA branch equations for the coupled pair (trapezoidal):
 *   V₁ = (2L₁/h)·I₁ + (2M/h)·I₂ + hist₁
 *   V₂ = (2M/h)·I₁ + (2L₂/h)·I₂ + hist₂
 *
 * where V_k = V(n_k+) − V(n_k−) and I_k is the branch current variable.
 */

import type { SparseSolver } from "./sparse-solver.js";
import type { IntegrationMethod } from "./element.js";

// ---------------------------------------------------------------------------
// CoupledInductorState
// ---------------------------------------------------------------------------

/**
 * Integration state for a coupled inductor pair.
 *
 * BDF-2 requires two history levels for both branch currents and voltages.
 * The prevPrev fields are used only when method === 'bdf2'.
 */
export interface CoupledInductorState {
  prevI1: number;
  prevI2: number;
  prevV1: number;
  prevV2: number;
  prevPrevI1?: number;
  prevPrevI2?: number;
  prevPrevV1?: number;
  prevPrevV2?: number;
}

// ---------------------------------------------------------------------------
// Coefficient helpers
// ---------------------------------------------------------------------------

/**
 * Self-inductance companion coefficient (equivalent conductance) for a single
 * inductor in the coupled pair, using the specified integration method.
 *
 * This is the diagonal entry in the 2×2 coupled companion matrix.
 */
function selfCoefficient(L: number, dt: number, method: IntegrationMethod): number {
  switch (method) {
    case "bdf1":
      return L / dt;
    case "trapezoidal":
      return (2 * L) / dt;
    case "bdf2":
      return (3 * L) / (2 * dt);
  }
}

/**
 * Mutual inductance companion coefficient for the cross-coupling term.
 *
 * This is the off-diagonal entry in the 2×2 coupled companion matrix.
 */
function mutualCoefficient(M: number, dt: number, method: IntegrationMethod): number {
  switch (method) {
    case "bdf1":
      return M / dt;
    case "trapezoidal":
      return (2 * M) / dt;
    case "bdf2":
      return (3 * M) / (2 * dt);
  }
}

/**
 * History current contribution for inductor 1 in the coupled pair.
 *
 * For BDF-1:        hist = −(L₁/h)·i1(n) − (M/h)·i2(n)
 * For trapezoidal:  hist = −(2L₁/h)·i1(n) − (2M/h)·i2(n) − v1(n)
 * For BDF-2:        hist = −(3L₁/2h)·(4/3·i1(n) − 1/3·i1(n-1))
 *                        − (3M/2h)·(4/3·i2(n) − 1/3·i2(n-1))
 */
function historyCurrent1(
  L1: number,
  M: number,
  dt: number,
  method: IntegrationMethod,
  state: CoupledInductorState,
): number {
  const g11 = selfCoefficient(L1, dt, method);
  const g12 = mutualCoefficient(M, dt, method);
  switch (method) {
    case "bdf1":
      return -g11 * state.prevI1 - g12 * state.prevI2;
    case "trapezoidal":
      return -g11 * state.prevI1 - g12 * state.prevI2 - state.prevV1;
    case "bdf2": {
      const i1Hist = (4 / 3) * state.prevI1 - (1 / 3) * (state.prevPrevI1 ?? 0);
      const i2Hist = (4 / 3) * state.prevI2 - (1 / 3) * (state.prevPrevI2 ?? 0);
      return -g11 * i1Hist - g12 * i2Hist;
    }
  }
}

/**
 * History current contribution for inductor 2 in the coupled pair.
 *
 * Symmetric to historyCurrent1 with L2 on the diagonal.
 */
function historyCurrent2(
  L2: number,
  M: number,
  dt: number,
  method: IntegrationMethod,
  state: CoupledInductorState,
): number {
  const g22 = selfCoefficient(L2, dt, method);
  const g12 = mutualCoefficient(M, dt, method);
  switch (method) {
    case "bdf1":
      return -g22 * state.prevI2 - g12 * state.prevI1;
    case "trapezoidal":
      return -g22 * state.prevI2 - g12 * state.prevI1 - state.prevV2;
    case "bdf2": {
      const i2Hist = (4 / 3) * state.prevI2 - (1 / 3) * (state.prevPrevI2 ?? 0);
      const i1Hist = (4 / 3) * state.prevI1 - (1 / 3) * (state.prevPrevI1 ?? 0);
      return -g22 * i2Hist - g12 * i1Hist;
    }
  }
}

// ---------------------------------------------------------------------------
// CoupledInductorPair
// ---------------------------------------------------------------------------

/**
 * Mutual inductance coupling model for a pair of inductors.
 *
 * Provides the `stampCompanion` method that both inductors in the pair call
 * at each timestep to incorporate cross-coupling history terms into the MNA
 * branch equations.
 */
export class CoupledInductorPair {
  readonly l1: number;
  readonly l2: number;
  readonly k: number;
  readonly m: number;

  constructor(l1: number, l2: number, k: number) {
    if (k < 0 || k > 1) {
      throw new RangeError(`Coupling coefficient k must be in [0, 1]; got ${k}`);
    }
    this.l1 = l1;
    this.l2 = l2;
    this.k = k;
    this.m = k * Math.sqrt(l1 * l2);
  }

  /**
   * Stamp the coupled companion model for both inductor branches.
   *
   * Each inductor branch equation in the MNA system has the form:
   *   V_k = g_kk · I_k + g_km · I_other + hist_k
   *
   * which rearranges to the branch row:
   *   V(n+) − V(n−) − g_kk · I_k − g_km · I_other = hist_k
   *
   * Stamps to the solver:
   *   branch1 row: KVL incidence for nodes1, self term −g11 at (b1,b1),
   *                cross term −g12 at (b1,b2), RHS hist1
   *   branch2 row: KVL incidence for nodes2, cross term −g12 at (b2,b1),
   *                self term −g22 at (b2,b2), RHS hist2
   *
   * Callers (Transformer / TappedTransformer) pass `ctx.solver` extracted from
   * their LoadContext — the same `SparseSolver` instance they previously passed
   * directly. No signature change is required at the helper level.
   *
   * @param solver   - MNA sparse solver (callers pass ctx.solver)
   * @param branch1  - Absolute solver row for inductor 1 branch current
   * @param branch2  - Absolute solver row for inductor 2 branch current
   * @param nodes1   - [n1+, n1−] node IDs (0 = ground) for inductor 1
   * @param nodes2   - [n2+, n2−] node IDs (0 = ground) for inductor 2
   * @param dt       - Timestep in seconds
   * @param method   - Integration method
   * @param state    - History state from the previous accepted timestep
   */
  stampCompanion(
    solver: SparseSolver,
    branch1: number,
    branch2: number,
    nodes1: readonly [number, number],
    nodes2: readonly [number, number],
    dt: number,
    method: IntegrationMethod,
    state: CoupledInductorState,
  ): void {
    const g11 = selfCoefficient(this.l1, dt, method);
    const g22 = selfCoefficient(this.l2, dt, method);
    const g12 = mutualCoefficient(this.m, dt, method);

    const hist1 = historyCurrent1(this.l1, this.m, dt, method, state);
    const hist2 = historyCurrent2(this.l2, this.m, dt, method, state);

    const [n1p, n1m] = nodes1;
    const [n2p, n2m] = nodes2;

    // Branch 1 row: V(n1+) − V(n1−) − g11·I1 − g12·I2 = hist1
    if (n1p !== 0) solver.stampElement(solver.allocElement(branch1, n1p - 1), 1);
    if (n1m !== 0) solver.stampElement(solver.allocElement(branch1, n1m - 1), -1);
    solver.stampElement(solver.allocElement(branch1, branch1), -g11);
    solver.stampElement(solver.allocElement(branch1, branch2), -g12);
    solver.stampRHS(branch1, hist1);

    // Branch 2 row: V(n2+) − V(n2−) − g12·I1 − g22·I2 = hist2
    if (n2p !== 0) solver.stampElement(solver.allocElement(branch2, n2p - 1), 1);
    if (n2m !== 0) solver.stampElement(solver.allocElement(branch2, n2m - 1), -1);
    solver.stampElement(solver.allocElement(branch2, branch1), -g12);
    solver.stampElement(solver.allocElement(branch2, branch2), -g22);
    solver.stampRHS(branch2, hist2);
  }

  /**
   * Update the coupled inductor history state after an accepted timestep.
   *
   * Rotates i(n-1) ← i(n) and v(n-1) ← v(n) for both windings, preserving
   * the two history levels needed for BDF-2.
   *
   * @param dt     - Accepted timestep (unused; retained for API symmetry)
   * @param method - Integration method (unused; retained for API symmetry)
   * @param i1     - Accepted branch current for inductor 1
   * @param i2     - Accepted branch current for inductor 2
   * @param v1     - Accepted terminal voltage for inductor 1 (V(n1+) − V(n1−))
   * @param v2     - Accepted terminal voltage for inductor 2 (V(n2+) − V(n2−))
   * @param state  - State object to mutate in place
   */
  updateState(
    _dt: number,
    _method: IntegrationMethod,
    i1: number,
    i2: number,
    v1: number,
    v2: number,
    state: CoupledInductorState,
  ): void {
    state.prevPrevI1 = state.prevI1;
    state.prevPrevI2 = state.prevI2;
    state.prevPrevV1 = state.prevV1;
    state.prevPrevV2 = state.prevV2;
    state.prevI1 = i1;
    state.prevI2 = i2;
    state.prevV1 = v1;
    state.prevV2 = v2;
  }

  /**
   * Create a zero-initialised state object for this pair.
   */
  createState(): CoupledInductorState {
    return {
      prevI1: 0,
      prevI2: 0,
      prevV1: 0,
      prevV2: 0,
      prevPrevI1: 0,
      prevPrevI2: 0,
      prevPrevV1: 0,
      prevPrevV2: 0,
    };
  }
}
