/**
 * Sparse-solver instrumentation wrapper.
 *
 * Production code MUST NOT import this file. It exists to wrap a
 * `SparseSolver` instance for test-only / harness-only inspection of
 * internal state: read-only white-box accessors (Markowitz pivot
 * bookkeeping, dimension, singletons, element counts) plus
 * post-factor reads (`getCSCNonZeros`).
 *
 * The in-class pre-factor / pre-solve capture API was deleted in
 * Phase 0 (architect B.30); harness consumers that need a pre-factor
 * snapshot must call `getCSCNonZeros()` BEFORE invoking `factor()`.
 *
 * ngspice mapping: this wrapper has no ngspice analogue. ngspice exposes
 * white-box state via `spDeviceCount`, `spFillinCount`, `spOriginalCount`
 * (`spalloc.c:855-895`) and via direct struct reads from the harness
 * compiled against `spdefs.h`. Our wrapper plays the same role: a
 * controlled side channel separate from the production ABI.
 */

import type { SparseSolver } from "./sparse-solver.js";

export interface PreFactorEntry {
  row: number;
  col: number;
  value: number;
}

export class SparseSolverInstrumentation {
  constructor(private readonly _solver: SparseSolver) {}

  /** Underlying solver — for tests that need to drive the production API. */
  get solver(): SparseSolver {
    return this._solver;
  }

  // -------------------------------------------------------------------------
  // White-box accessors (digiTS-only — no ngspice analogue beyond the field
  // names; see SparseSolver class comments for `MatrixFrame.*` mappings).
  // -------------------------------------------------------------------------

  get dimension(): number {
    return this._solver.dimension;
  }

  get markowitzRow(): Int32Array {
    return this._solver.markowitzRow;
  }

  get markowitzCol(): Int32Array {
    return this._solver.markowitzCol;
  }

  get markowitzProd(): Int32Array {
    return this._solver.markowitzProd;
  }

  get singletons(): number {
    return this._solver.singletons;
  }

  /** Mirrors ngspice spOriginalCount (spalloc.c:879). */
  get elementCount(): number {
    return this._solver.elementCount;
  }

  /** Mirrors ngspice spFillinCount (spalloc.c:885). */
  get fillinCount(): number {
    return this._solver.fillinCount;
  }

  /** Mirrors ngspice spElementCount (spalloc.c:859). */
  get totalElementCount(): number {
    return this._solver.totalElementCount;
  }

  // -------------------------------------------------------------------------
  // Read-only accessors — the in-class capture API (B.30) was deleted in
  // Phase 0; pre-factor snapshots must be taken externally by the harness
  // via getCSCNonZeros() at the appropriate boundary. RHS snapshotting
  // moved to the caller per B.16 / Phase 6 (RHS lives on `ctx.rhs`).
  // -------------------------------------------------------------------------

  /**
   * Assembled-matrix non-zero entries in original ordering. Post-factor
   * this reflects LU-overwritten data, not the pre-factor A matrix —
   * harness consumers must call this BEFORE invoking factor() if they
   * want the pre-factor A.
   */
  getCSCNonZeros(): Array<PreFactorEntry> {
    return this._solver.getCSCNonZeros();
  }
}

/**
 * Convenience constructor — `attach(solver)` → `SparseSolverInstrumentation`.
 * Mirrors the wrap-once idiom used by the harness.
 */
export function attach(solver: SparseSolver): SparseSolverInstrumentation {
  return new SparseSolverInstrumentation(solver);
}
