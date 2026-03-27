/**
 * Core analog type definitions shared across the registry and solver layers.
 *
 * These types are placed in core/ so that the registry (a foundational module)
 * does not need to import from solver/analog internals.
 *
 * The solver/analog layer re-exports these types for backward compatibility
 * with existing consumers that import from those paths.
 */

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
// Minimal SparseSolver interface — structural duck-type for stamp methods
// ---------------------------------------------------------------------------

/**
 * Minimal structural interface for the MNA sparse solver, containing only
 * the methods that AnalogElementCore implementations call during stamping.
 *
 * The full SparseSolver class (with factorization, solve, etc.) lives in
 * solver/analog/sparse-solver.ts and satisfies this interface structurally.
 */
export interface SparseSolverStamp {
  stamp(row: number, col: number, value: number): void;
  stampRHS(row: number, value: number): void;
}

// ---------------------------------------------------------------------------
// ComplexSparseSolver — forward reference for AC stamp method
// ---------------------------------------------------------------------------

/**
 * Opaque forward reference to the ComplexSparseSolver used in AC analysis.
 * Used only in the stampAc optional method signature.
 */
export interface ComplexSparseSolver {
  stamp(row: number, col: number, re: number, im: number): void;
  stampRHS(row: number, re: number, im: number): void;
}

// ---------------------------------------------------------------------------
// AnalogElementCore
// ---------------------------------------------------------------------------

/**
 * The return type of analog factory functions — the contract that all analog
 * circuit component implementations must satisfy. Excludes pinNodeIds and
 * allNodeIds which are set by the compiler after factory construction.
 *
 * Standalone definition equivalent to:
 *   Omit<AnalogElement, 'pinNodeIds' | 'allNodeIds'>
 *
 * where AnalogElement is defined in solver/analog/element.ts.
 */
export interface AnalogElementCore {
  /**
   * Assigned branch-current row index for elements that introduce extra MNA
   * rows (voltage sources, inductors). Set to -1 for elements that do not
   * add extra rows (resistors, capacitors, current sources, diodes, etc.).
   */
  readonly branchIndex: number;

  /**
   * Stamp linear (topology-dependent, operating-point-independent)
   * contributions into the MNA matrix.
   */
  stamp(solver: SparseSolverStamp): void;

  /**
   * Stamp linearized nonlinear contributions at the current operating point.
   */
  stampNonlinear?(solver: SparseSolverStamp): void;

  /**
   * Update internal linearization state from the latest NR solution vector.
   */
  updateOperatingPoint?(voltages: Float64Array): void;

  /**
   * Recompute companion model coefficients and stamp them into the solver.
   */
  stampCompanion?(dt: number, method: IntegrationMethod, voltages: Float64Array): void;

  /**
   * Update non-MNA internal state variables after an accepted timestep.
   */
  updateState?(dt: number, voltages: Float64Array): void;

  /**
   * Element-specific convergence check beyond the global node-voltage criterion.
   */
  checkConvergence?(voltages: Float64Array, prevVoltages: Float64Array): boolean;

  /**
   * Compute and return the local truncation error estimate for adaptive timestepping.
   */
  getLteEstimate?(dt: number): { truncationError: number };

  /**
   * Scale independent source magnitude for source-stepping DC convergence.
   */
  setSourceScale?(factor: number): void;

  /**
   * Stamp the element's frequency-domain small-signal model for AC analysis.
   */
  stampAc?(solver: ComplexSparseSolver, omega: number): void;

  /**
   * True if this element implements stampNonlinear.
   */
  readonly isNonlinear: boolean;

  /**
   * True if this element implements stampCompanion.
   */
  readonly isReactive: boolean;

  /**
   * Compute per-pin currents for this element.
   */
  getPinCurrents(voltages: Float64Array): number[];

  /**
   * Optional display label for diagnostic attribution.
   */
  label?: string;
}

// ---------------------------------------------------------------------------
// DeviceType
// ---------------------------------------------------------------------------

/** Device type codes recognized in SPICE .MODEL statements. */
export type DeviceType = "NPN" | "PNP" | "NMOS" | "PMOS" | "NJFET" | "PJFET" | "D";
