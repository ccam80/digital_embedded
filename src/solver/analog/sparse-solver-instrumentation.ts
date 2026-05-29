/**
 * Sparse-solver instrumentation wrapper.
 *
 * The single white-box access path to a `SparseSolver`'s internal state for
 * test and harness inspection: Markowitz pivot bookkeeping, dimension,
 * singletons, element counts, insertion order, and pre-factor CSC exports.
 * Production code does not import this file; obtain a wrapper via
 * `solver.createInstrumentation()`.
 *
 * The wrapper reads internals through a closure view handed to it by
 * `SparseSolver.createInstrumentation()` (the factory has private-field access
 * inside the class body), so no field is exposed on the production ABI and no
 * cast is needed at the call site.
 *
 * Pre-factor CSC reads (`getCSCNonZeros` / `getComplexCSCNonZeros`) report the
 * assembled matrix BEFORE `factor()` overwrites per-element values with L/U;
 * the harness must call them at the post-load / pre-factor boundary.
 *
 * ngspice mapping: this wrapper has no ngspice analogue. ngspice exposes
 * white-box state via `spDeviceCount`, `spFillinCount`, `spOriginalCount`
 * (`spalloc.c:855-895`) and via direct struct reads from the harness compiled
 * against `spdefs.h`. The wrapper plays the same role: a controlled side
 * channel separate from the production ABI.
 */

import type { SparseSolver } from "./sparse-solver.js";

export interface PreFactorEntry {
  row: number;
  col: number;
  value: number;
}

export interface ComplexPreFactorEntry {
  row: number;
  col: number;
  valueRe: number;
  valueIm: number;
}

export interface InsertionOrderEntry {
  extRow: number;
  extCol: number;
}

/**
 * Closure view over a `SparseSolver`'s private state. Built by
 * `SparseSolver.createInstrumentation()`; consumed only by the wrapper. Each
 * member returns a live read of the corresponding internal quantity.
 */
export interface SparseSolverInternalView {
  dimension(): number;
  markowitzRow(): Int32Array;
  markowitzCol(): Int32Array;
  markowitzProd(): Int32Array;
  singletons(): number;
  /** Mirrors ngspice spOriginalCount (spalloc.c:879). */
  elementCount(): number;
  /** Mirrors ngspice spFillinCount (spalloc.c:885). */
  fillinCount(): number;
  /** Mirrors ngspice spElementCount (spalloc.c:859). */
  totalElementCount(): number;
  insertionOrder(): ReadonlyArray<InsertionOrderEntry>;
  cscNonZeros(): Array<PreFactorEntry>;
  complexCscNonZeros(): Array<ComplexPreFactorEntry>;
}

export class SparseSolverInstrumentation {
  constructor(
    private readonly _solver: SparseSolver,
    private readonly _view: SparseSolverInternalView,
  ) {}

  /** Underlying solver- for tests that drive the production API (factor/solve). */
  get solver(): SparseSolver {
    return this._solver;
  }

  // -------------------------------------------------------------------------
  // White-box accessors. See SparseSolver class comments for `MatrixFrame.*`
  // ngspice field-name mappings.
  // -------------------------------------------------------------------------

  get dimension(): number {
    return this._view.dimension();
  }

  get markowitzRow(): Int32Array {
    return this._view.markowitzRow();
  }

  get markowitzCol(): Int32Array {
    return this._view.markowitzCol();
  }

  get markowitzProd(): Int32Array {
    return this._view.markowitzProd();
  }

  get singletons(): number {
    return this._view.singletons();
  }

  /** Mirrors ngspice spOriginalCount (spalloc.c:879). */
  get elementCount(): number {
    return this._view.elementCount();
  }

  /** Mirrors ngspice spFillinCount (spalloc.c:885). */
  get fillinCount(): number {
    return this._view.fillinCount();
  }

  /** Mirrors ngspice spElementCount (spalloc.c:859). */
  get totalElementCount(): number {
    return this._view.totalElementCount();
  }

  /**
   * (extRow, extCol) pairs in the order Translate first encountered them.
   * Used by setup-stamp-order invariant tests to verify TSTALLOC ordering
   * against ngspice's *setup.c line ordering.
   */
  getInsertionOrder(): ReadonlyArray<InsertionOrderEntry> {
    return this._view.insertionOrder();
  }

  /**
   * Assembled-matrix non-zero entries in external (MNA) ordering. Post-factor
   * this reflects LU-overwritten data, not the pre-factor A matrix- call this
   * BEFORE invoking `factor()` to read the pre-factor A.
   */
  getCSCNonZeros(): Array<PreFactorEntry> {
    return this._view.cscNonZeros();
  }

  /**
   * Complex sibling of `getCSCNonZeros()`. Same lifecycle constraint- must be
   * called BEFORE `factor()` in complex mode; factorisation overwrites
   * per-element `.Real`/`.Imag` with L/U. Mirrors ngspice's pre-LU CSC capture
   * in niiter.c (AC bridge instrumentation block).
   */
  getComplexCSCNonZeros(): Array<ComplexPreFactorEntry> {
    return this._view.complexCscNonZeros();
  }
}
