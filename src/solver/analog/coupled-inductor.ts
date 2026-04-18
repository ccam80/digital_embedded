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
// CoupledInductorPair
// ---------------------------------------------------------------------------

/**
 * Mutual inductance coupling model for a pair of inductors.
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
