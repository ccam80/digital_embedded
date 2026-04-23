/**
 * Coupled inductor pair — mutual inductance coupling parameters.
 *
 * Two inductors L₁ and L₂ with coupling coefficient k produce mutual
 * inductance M = k·√(L₁·L₂). Used by transformer.ts to derive L1, L2, M
 * for the MNA stamp. Integration state is managed by the state-pool schema
 * in transformer.ts (SLOT_PHI1/PHI2/CCAP1/CCAP2) — no separate state object.
 *
 * Note: CoupledInductorState and createState() have been deleted (dead code
 * per post-a1-parity.md §1.6 extra observation — never called by transformer.ts).
 */

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
}
