/**
 * MNA matrix assembler.
 *
 * Orchestrates the stamp protocol used by the Newton-Raphson loop:
 *
 *   `stampAll` — called every NR iteration (unified CKTload equivalent).
 *                Clears the matrix, updates operating points, stamps all
 *                element contributions (linear + nonlinear + reactive companion)
 *                unconditionally, and finalizes the matrix for factorization.
 */

import type { SparseSolver } from "./sparse-solver.js";
import type { AnalogElement } from "./element.js";
import type { LimitingEvent } from "./newton-raphson.js";

// ---------------------------------------------------------------------------
// MNAAssembler
// ---------------------------------------------------------------------------

/**
 * Coordinates MNA stamp passes over a list of `AnalogElement` objects
 * using a shared `SparseSolver` reference.
 */
export class MNAAssembler {
  private readonly _solver: SparseSolver;

  /** Number of elements whose updateOperatingPoint reported limiting (ngspice CKTnoncon). */
  noncon = 0;

  /**
   * @param solver - The shared SparseSolver instance used for all stamp calls.
   */
  constructor(solver: SparseSolver) {
    this._solver = solver;
  }

  /**
   * Unified CKTload equivalent: clear the matrix, update operating points,
   * stamp ALL element contributions unconditionally, and finalize.
   *
   * Called every NR iteration. Replaces the old separate linear/nonlinear
   * stamp hoisting with a single unconditional pass matching ngspice CKTload.
   *
   * @param elements          - The full element list for this circuit.
   * @param matrixSize        - MNA matrix dimension (nodeCount + branchCount).
   * @param voltages          - The current NR solution vector (used by updateOperatingPoint).
   * @param limitingCollector - When non-null, passed to updateOperatingPoint for
   *   harness instrumentation. Null when harness capture is inactive.
   * @param iteration         - Current NR iteration (0-based). On iteration 0,
   *   updateOperatingPoint is skipped (no previous solution to linearize from).
   * @param prevVoltages      - Solution vector from the previous NR iteration.
   *   Used by shouldBypass() checks. When omitted, bypass is never triggered.
   */
  stampAll(
    elements: readonly AnalogElement[],
    matrixSize: number,
    voltages: Float64Array,
    limitingCollector: LimitingEvent[] | null,
    iteration: number,
    prevVoltages?: Float64Array,
  ): void {
    this._solver.beginAssembly(matrixSize);

    if (iteration > 0) {
      this.updateOperatingPoints(elements, voltages, limitingCollector);
    }

    for (const el of elements) {
      if (iteration > 0 && prevVoltages !== undefined && el.shouldBypass?.(voltages, prevVoltages)) {
        continue;
      }
      el.stamp(this._solver);
      if (el.isNonlinear && el.stampNonlinear) {
        el.stampNonlinear(this._solver);
      }
      if (el.isReactive && el.stampReactiveCompanion) {
        el.stampReactiveCompanion(this._solver);
      }
    }

    this._solver.finalize();
  }

  /**
   * Update internal linearization state for all nonlinear elements from the
   * latest NR solution vector.
   *
   * Calls `element.updateOperatingPoint!(voltages, limitingCollector)` for each
   * element where `isNonlinear === true` and `updateOperatingPoint` is implemented.
   *
   * Called after `solver.solve()` and before the next `stampNonlinear`.
   *
   * @param elements         - The full element list for this circuit.
   * @param voltages         - The current MNA solution vector.
   * @param limitingCollector - When non-null, passed to each element so it can
   *   push LimitingEvent records for harness instrumentation. Null when harness
   *   capture is inactive (zero-overhead path).
   */
  updateOperatingPoints(
    elements: readonly AnalogElement[],
    voltages: Float64Array,
    limitingCollector: LimitingEvent[] | null = null,
  ): void {
    this.noncon = 0;
    for (const el of elements) {
      if (el.isNonlinear && el.updateOperatingPoint) {
        const limited = el.updateOperatingPoint(voltages, limitingCollector);
        if (limited) this.noncon++;
      }
    }
  }

  /**
   * Check whether all elements report convergence.
   *
   * Returns `true` only if every element that implements `checkConvergence`
   * returns `true`. Elements without `checkConvergence` are assumed converged.
   *
   * @param elements     - The full element list for this circuit.
   * @param voltages     - The current NR solution vector.
   * @param prevVoltages - The solution vector from the previous NR iteration.
   * @returns `true` if all element convergence checks pass; `false` otherwise.
   */
  checkAllConverged(
    elements: readonly AnalogElement[],
    voltages: Float64Array,
    prevVoltages: Float64Array,
    reltol: number,
    iabstol: number,
  ): boolean {
    for (const el of elements) {
      if (el.checkConvergence) {
        if (!el.checkConvergence(voltages, prevVoltages, reltol, iabstol)) {
          return false;
        }
      }
    }
    return true;
  }

  /**
   * Like checkAllConverged but collects all failing element indices instead of
   * short-circuiting on the first failure.
   *
   * Only called when NROptions.detailedConvergence is true. The default path
   * (checkAllConverged) is unchanged and continues to short-circuit.
   */
  checkAllConvergedDetailed(
    elements: readonly AnalogElement[],
    voltages: Float64Array,
    prevVoltages: Float64Array,
    reltol: number,
    iabstol: number,
  ): { allConverged: boolean; failedIndices: number[] } {
    const failedIndices: number[] = [];
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      if (!el.checkConvergence) continue;
      if (!el.checkConvergence(voltages, prevVoltages, reltol, iabstol)) {
        failedIndices.push(i);
      }
    }
    return { allConverged: failedIndices.length === 0, failedIndices };
  }
}
