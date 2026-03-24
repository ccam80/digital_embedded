/**
 * AnalogElement interface — the sole contract that all analog circuit
 * components program against.
 *
 * Separate linear and nonlinear stamp methods allow the NR loop to stamp
 * topology-dependent contributions once per solve while re-stamping only the
 * nonlinear operating-point-dependent terms on every iteration.
 */

import type { SparseSolver } from "./sparse-solver.js";

// ---------------------------------------------------------------------------
// IntegrationMethod
// ---------------------------------------------------------------------------

/**
 * Numerical integration method used by companion-model reactive elements.
 *
 * 'trapezoidal' — second-order A-stable (Gear/SPICE default)
 * 'bdf1'        — first-order backward Euler (robust, low accuracy)
 * 'bdf2'        — second-order BDF (good stiffness handling)
 */
export type IntegrationMethod = "trapezoidal" | "bdf1" | "bdf2";

// ---------------------------------------------------------------------------
// ComplexSparseSolver — forward reference for AC stamp method
// ---------------------------------------------------------------------------

/**
 * Opaque forward reference to the ComplexSparseSolver defined in Phase 6.
 * Used only in the `stampAc` optional method signature; no implementation
 * is required in Phase 1.
 */
export interface ComplexSparseSolver {
  stamp(row: number, col: number, re: number, im: number): void;
  stampRHS(row: number, re: number, im: number): void;
}

// ---------------------------------------------------------------------------
// AnalogElement
// ---------------------------------------------------------------------------

/**
 * Contract for every analog circuit element that stamps into the MNA matrix.
 *
 * Two-terminal passive elements (resistors, capacitors, inductors) connect
 * two nodes. Three-terminal (BJT base/emitter/collector) and four-terminal
 * (MOSFET gate/drain/source/bulk) elements carry more entries in nodeIndices.
 *
 * Elements that introduce extra MNA rows (voltage sources, inductors as
 * branch currents) set `branchIndex` to their assigned row offset above the
 * node block. All other elements set `branchIndex` to -1.
 */
export interface AnalogElement {
  /**
   * Node IDs this element connects to, in pin order.
   *
   * Length 2 for two-terminal elements, 3 for BJTs, 4 for MOSFETs.
   * Each entry is a non-negative integer; 0 is ground.
   */
  readonly nodeIndices: readonly number[];

  /**
   * Assigned branch-current row index for elements that introduce extra MNA
   * rows (voltage sources, inductors). Set to -1 for elements that do not
   * add extra rows (resistors, capacitors, current sources, diodes, etc.).
   */
  readonly branchIndex: number;

  /**
   * Stamp linear (topology-dependent, operating-point-independent)
   * contributions into the MNA matrix.
   *
   * Called once at the start of each Newton-Raphson solve, after
   * `solver.beginAssembly()` and before `solver.finalize()`.
   *
   * Linear elements (resistors, ideal voltage/current sources) stamp all
   * their contributions here. Nonlinear elements stamp only the
   * topology-constant entries here (e.g. nothing for a diode).
   */
  stamp(solver: SparseSolver): void;

  /**
   * Stamp linearized nonlinear contributions at the current operating point.
   *
   * Called every NR iteration for nonlinear elements. Must not be called for
   * linear elements (enforced by the assembler via `isNonlinear`).
   *
   * Implementations read the current node voltages from their internal state
   * (set by `updateOperatingPoint`) and stamp the linearized conductance and
   * current-source equivalent into the solver.
   */
  stampNonlinear?(solver: SparseSolver): void;

  /**
   * Update internal linearization state from the latest NR solution vector.
   *
   * Called after each NR iteration for nonlinear elements, between
   * `solver.solve()` and the next `stampNonlinear()` call.
   *
   * @param voltages - Full MNA solution vector (size = nodeCount + branchCount)
   */
  updateOperatingPoint?(voltages: Float64Array): void;

  /**
   * Recompute companion model coefficients and stamp them into the solver.
   *
   * Called on reactive elements (capacitors, inductors, coupled inductors)
   * at the start of each timestep, after `beginAssembly()` and before the
   * first NR iteration.
   *
   * @param dt     - Current timestep in seconds
   * @param method - Active integration method
   * @param voltages - Solution vector from the previous accepted timestep
   */
  stampCompanion?(dt: number, method: IntegrationMethod, voltages: Float64Array): void;

  /**
   * Update non-MNA internal state variables after an accepted timestep.
   *
   * Used by elements with state that is not expressed as a companion model
   * (e.g. thermal energy in a fuse, flux linkage in a memristor). Called
   * after the timestep is accepted and `voltages` is the accepted solution.
   *
   * @param dt      - Accepted timestep in seconds
   * @param voltages - Accepted solution vector
   */
  updateState?(dt: number, voltages: Float64Array): void;

  /**
   * Element-specific convergence check beyond the global node-voltage criterion.
   *
   * Called by the assembler after every NR iteration. Return `true` if this
   * element considers the current solution converged; `false` to signal that
   * iteration must continue.
   *
   * Elements without special convergence requirements omit this method
   * (the assembler treats absent as converged).
   *
   * @param voltages     - Current NR solution vector
   * @param prevVoltages - Solution vector from the previous NR iteration
   */
  checkConvergence?(voltages: Float64Array, prevVoltages: Float64Array): boolean;

  /**
   * Compute and return the local truncation error estimate for adaptive
   * timestepping.
   *
   * Reactive elements implement this to allow the timestep controller to
   * decide whether to accept or reject the current step, and to choose the
   * next timestep via the standard LTE formula.
   *
   * @param dt - Current timestep in seconds
   * @returns Object with `truncationError` in appropriate units (charge for
   *          capacitors, flux for inductors)
   */
  getLteEstimate?(dt: number): { truncationError: number };

  /**
   * Scale independent source magnitude for source-stepping DC convergence.
   *
   * Called by the DC operating point solver during source stepping. The
   * `factor` argument ramps from 0 (sources disabled) to 1 (full magnitude).
   * Elements that are not independent sources do not implement this method.
   *
   * @param factor - Scaling factor in [0, 1]
   */
  setSourceScale?(factor: number): void;

  /**
   * Stamp the element's frequency-domain small-signal model for AC analysis.
   *
   * Called once per frequency point during an AC sweep. Resistors stamp
   * conductance (same as DC); capacitors stamp `jωC` admittance; inductors
   * stamp `1/(jωL)` admittance; nonlinear elements stamp linearized
   * small-signal conductances at the DC operating point.
   *
   * The `ComplexSparseSolver` type is fully specified in Phase 6.
   *
   * @param solver - Complex-valued solver for AC stamp accumulation
   * @param omega  - Angular frequency in rad/s (2π × Hz)
   */
  stampAc?(solver: ComplexSparseSolver, omega: number): void;

  /**
   * True if this element implements `stampNonlinear`.
   *
   * The MNA assembler reads this flag to decide whether to call
   * `stampNonlinear` and `updateOperatingPoint` during NR iteration.
   * Linear elements set this to `false`.
   */
  readonly isNonlinear: boolean;

  /**
   * True if this element implements `stampCompanion`.
   *
   * The timestep controller reads this flag to decide whether to call
   * `stampCompanion` and `getLteEstimate` for reactive element handling.
   * Non-reactive elements set this to `false`.
   */
  readonly isReactive: boolean;

  /**
   * Compute the current through this element from the MNA solution vector.
   *
   * Elements with `branchIndex >= 0` (voltage sources, inductors) have their
   * current available directly from the solution vector. Elements without a
   * branch row (resistors, capacitors, current sources) implement this method
   * to compute current from node voltages (e.g. I = G × (V_A - V_B)).
   *
   * @param voltages - Full MNA solution vector (size = nodeCount + branchCount)
   * @returns Current in amperes (positive = conventional flow from node[0] to node[1])
   */
  getCurrent?(voltages: Float64Array): number;

  /**
   * Optional display label for diagnostic attribution.
   *
   * When present, used in `SolverDiagnostic.involvedElements` descriptions
   * to identify which element triggered a convergence failure or anomaly.
   */
  label?: string;
}
