/**
 * Sparse-solver instrumentation wrapper (Stage 8 — direct port plan).
 *
 * Production code MUST NOT import this file. It exists to wrap a
 * `SparseSolver` instance for test-only / harness-only inspection of
 * internal state: white-box accessors (Markowitz pivot bookkeeping,
 * dimension, singletons) plus the pre-factor / pre-solve capture API
 * the ngspice-comparison harness consumes.
 *
 * Per spec §8.3, the long-term goal is for every test-side white-box
 * read to go through this wrapper, leaving `SparseSolver`'s public
 * surface limited to the production API (`beginAssembly`, `allocElement`,
 * `stampElement`, `stampRHS`, `finalize`, `factor`, `solve`,
 * `forceReorder`, `invalidateTopology`, `setPivotTolerances`,
 * `getError`, `whereSingular`).
 *
 * Per spec §8.3 fallback note ("If the file split is judged too
 * disruptive, the alternative is a prefix marker (`__instrumentation_*`)
 * on every test-only field/method and a lint rule ensuring production
 * code never reads them."), the equivalent methods currently remain on
 * `SparseSolver` carrying an `@instrumentation` JSDoc tag. The 20+ test
 * files importing them are not migrated by this stage; this wrapper
 * exists so that any new test-side white-box read is written against it
 * and so the eventual mechanical migration has a target.
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
  // Pre-factor / pre-solve / post-assembly capture API.
  // Used by the ngspice-comparison harness to snapshot the matrix and RHS
  // at the same observation points ngspice does (LoadGmin + spFactor
  // boundary; pre-spSolve boundary).
  // -------------------------------------------------------------------------

  enablePreSolveRhsCapture(enabled: boolean): void {
    this._solver.enablePreSolveRhsCapture(enabled);
  }

  getPreSolveRhsSnapshot(): Float64Array {
    return this._solver.getPreSolveRhsSnapshot();
  }

  enablePreFactorMatrixCapture(enabled: boolean): void {
    this._solver.enablePreFactorMatrixCapture(enabled);
  }

  getPreFactorMatrixSnapshot(): ReadonlyArray<PreFactorEntry> {
    return this._solver.getPreFactorMatrixSnapshot();
  }

  /** Live RHS slice (post-stamp, pre-solve). */
  getRhsSnapshot(): Float64Array {
    return this._solver.getRhsSnapshot();
  }

  /**
   * Assembled-matrix non-zero entries in original ordering. Post-factor this
   * reflects LU-overwritten data, not the pre-factor A matrix — use
   * `getPreFactorMatrixSnapshot()` for the pre-factor view.
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
