/**
 * MNA matrix assembler.
 *
 * Orchestrates the two-phase stamp protocol used by the Newton-Raphson loop:
 *
 *   1. `stampLinear`   — called once per NR solve to stamp topology-constant
 *                        contributions from all elements.
 *   2. `stampNonlinear` — called every NR iteration to re-stamp linearized
 *                         nonlinear contributions at the current operating point.
 *
 * The assembler does not own the solver or the element list — it is a thin
 * coordinator that enforces the correct call sequence and filtering rules.
 */

import type { SparseSolver } from "./sparse-solver.js";
import type { AnalogElement } from "./element.js";

// ---------------------------------------------------------------------------
// MNAAssembler
// ---------------------------------------------------------------------------

/**
 * Coordinates linear and nonlinear MNA stamp passes over a list of
 * `AnalogElement` objects using a shared `SparseSolver` reference.
 *
 * The assembler does not call `solver.beginAssembly()`, `finalize()`, or
 * `factor()` — those are the caller's responsibility. This keeps the
 * assembler's contract minimal and testable in isolation.
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
   * Stamp linear (topology-dependent, operating-point-independent)
   * contributions from every element.
   *
   * Calls `element.stamp(solver)` for every element in the list, including
   * nonlinear elements (which stamp their topology-constant MNA entries here,
   * e.g. nothing for a pure diode).
   *
   * Called once at the start of each Newton-Raphson solve after
   * `solver.beginAssembly()`.
   *
   * @param elements - The full element list for this circuit.
   */
  stampLinear(elements: readonly AnalogElement[]): void {
    for (const el of elements) {
      el.stamp(this._solver);
    }
  }

  /**
   * Stamp nonlinear (operating-point-dependent) contributions from all
   * nonlinear elements.
   *
   * Calls `element.stampNonlinear!(solver)` only for elements where
   * `isNonlinear === true`. Linear elements are silently skipped.
   *
   * Called every NR iteration after `stampLinear`, at the current operating
   * point established by the most recent `updateOperatingPoints` call.
   *
   * @param elements - The full element list for this circuit.
   */
  stampNonlinear(elements: readonly AnalogElement[]): void {
    for (const el of elements) {
      if (el.isNonlinear && el.stampNonlinear) {
        el.stampNonlinear(this._solver);
      }
    }
  }

  /**
   * Update internal linearization state for all nonlinear elements from the
   * latest NR solution vector.
   *
   * Calls `element.updateOperatingPoint!(voltages)` for each element where
   * `isNonlinear === true` and `updateOperatingPoint` is implemented.
   *
   * Called after `solver.solve()` and before the next `stampNonlinear`.
   *
   * @param elements - The full element list for this circuit.
   * @param voltages - The current MNA solution vector.
   */
  updateOperatingPoints(
    elements: readonly AnalogElement[],
    voltages: Float64Array,
  ): void {
    this.noncon = 0;
    for (const el of elements) {
      if (el.isNonlinear && el.updateOperatingPoint) {
        const limited = el.updateOperatingPoint(voltages);
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
}
