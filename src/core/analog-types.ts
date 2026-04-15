/**
 * Core analog type definitions shared across the registry and solver layers.
 *
 * These types are placed in core/ so that the registry (a foundational module)
 * does not need to import from solver/analog internals.
 *
 * The solver/analog layer re-exports these types so consumers may import
 * from either path.
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
// StatePoolRef — forward reference to avoid circular import
// ---------------------------------------------------------------------------

/**
 * Forward reference to StatePool to avoid core→solver circular import.
 * The actual StatePool class in solver/analog/state-pool.ts structurally
 * satisfies this interface, allowing core/analog-types.ts to refer to it
 * in method signatures without importing from solver/.
 */
export interface StatePoolRef {
  readonly states: readonly Float64Array[];
  readonly state0: Float64Array;
  readonly state1: Float64Array;
  readonly state2: Float64Array;
  readonly state3: Float64Array;
  readonly totalSlots: number;
  /** Number of accepted transient steps. 0 = MODEINITTRAN equivalent. */
  readonly tranStep: number;
  /** Current DC-OP mode (niiter.c:991-997). "transient" during normal transient NR. Absent → treated as "transient". */
  readonly initMode?: "initJct" | "initFix" | "initFloat" | "initTran" | "initPred" | "initSmsig" | "transient";
  /**
   * Analysis mode. "dcOp" during DC operating point, "tran" for transient NR.
   * Maps to ngspice CKTmode MODEDCOP/MODETRANOP vs MODETRAN|MODEINITTRAN.
   * Absent → treated as "dcOp" (conservative default for older callers).
   */
  readonly analysisMode?: "dcOp" | "tran";
  /** Use Initial Conditions mode. ngspice: MODEUIC. Absent → false. */
  readonly uic?: boolean;
  /**
   * Current transient integration timestep written by the engine before each
   * stamp pass. 0 during DC-OP. Used by elements to derive ag0 locally
   * (NIcomCof equivalent, nicomcof.c:33-51).
   */
  readonly dt?: number;
  /**
   * Circuit operating temperature in Kelvin. Absent → 300.15 K (REFTEMP).
   * Maps to ngspice CKTtemp. Used by passive elements (capacitor, inductor)
   * for TC1/TC2 temperature coefficient computation.
   */
  readonly temperature?: number;
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
  updateOperatingPoint?(voltages: Readonly<Float64Array>): boolean | void;

  /**
   * Recompute companion model coefficients and stamp them into the solver.
   */
  stampCompanion?(dt: number, method: IntegrationMethod, voltages: Float64Array, order: number, deltaOld: readonly number[]): void;

  /**
   * Stamp previously-computed companion model entries (geq/ieq) into the
   * MNA matrix. Called every NR iteration. Companion entries are separated
   * from stamp() so the linear base contains only topology-constant
   * contributions.
   */
  stampReactiveCompanion?(solver: SparseSolverStamp): void;

  /**
   * Rewrite the _NOW charge/flux slot(s) using converged NR voltages, and
   * recompute ccap from the converged charge so the next step's trapezoidal
   * recursion starts from the correct companion current.
   * Called after NR convergence but before LTE evaluation so that
   * getLteTimestep sees accurate charge/flux values.
   * Implementations must write ONLY the _NOW slot — never shift history.
   */
  updateChargeFlux?(voltages: Float64Array, dt: number, method: import("../solver/analog/element.js").IntegrationMethod, order: number, deltaOld: readonly number[]): void;

  /**
   * Update non-MNA internal state variables after an accepted timestep.
   */
  updateState?(dt: number, voltages: Float64Array): void;

  /**
   * Element-specific convergence check beyond the global node-voltage criterion.
   */
  checkConvergence?(voltages: Float64Array, prevVoltages: Float64Array, reltol: number, abstol: number): boolean;

  /**
   * CKTterr-based LTE timestep proposal. Returns the maximum allowable
   * timestep for this element based on charge/flux history divided differences.
   *
   * Elements implementing this method call `cktTerr()` internally for each
   * reactive junction, passing charge values as individual scalars (not arrays)
   * to avoid hot-path allocations.
   */
  getLteTimestep?(
    dt: number,
    deltaOld: readonly number[],
    order: number,
    method: import("../solver/analog/element.js").IntegrationMethod,
    lteParams: import("../solver/analog/ckt-terr.js").LteParams,
  ): number;

  /**
   * Scale independent source magnitude for source-stepping DC convergence.
   */
  setSourceScale?(factor: number): void;

  /**
   * Update a mutable parameter on a live compiled element without
   * recompilation. Called by the coordinator for slider/property-panel
   * hot-patching. All compiled elements must implement this method.
   */
  setParam(key: string, value: number): void;

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
   * Arm a one-shot per-device junction seed for cold-start NR convergence.
   * Called once by the dcopInitJct phase before the main NR runs. The device
   * stores tVcrit-derived junction voltages in internal state; the next call
   * to updateOperatingPoint consumes and clears that state, overriding the
   * values it would otherwise compute from the shared voltages array.
   *
   * Matches ngspice MODEINITJCT (bjtload.c:265-274): a per-device
   * linearization-point override, NOT a write into the shared MNA vector.
   * Optional; linear elements do not implement this.
   */
  primeJunctions?(): void;

  /**
   * Optional display label for diagnostic attribution.
   */
  label?: string;

  /**
   * Return the strictly-next breakpoint strictly greater than afterTime, or
   * null if the source has no more breakpoints. Called once per accepted
   * step on which this source's breakpoint was consumed.
   */
  nextBreakpoint?(afterTime: number): number | null;

  /**
   * Optional: register a callback invoked by the element when a setParam
   * change invalidates the outstanding breakpoint (e.g. frequency/phase).
   * The engine uses this to refresh the queue entry. Called once at seed
   * time by MNAEngine._seedBreakpoints().
   */
  registerRefreshCallback?(cb: () => void): void;
}

// ---------------------------------------------------------------------------
// Re-exports of unified diagnostic types from compile/types.ts
// ---------------------------------------------------------------------------

import type { Diagnostic, DiagnosticCode, DiagnosticSuggestion } from "../compile/types.js";
export type { Diagnostic, DiagnosticCode, DiagnosticSuggestion };

// ---------------------------------------------------------------------------
// AcParams — frequency sweep configuration
// ---------------------------------------------------------------------------

/**
 * Parameters for an AC frequency sweep.
 */
export interface AcParams {
  /** Sweep type: linear, decades, or octaves. */
  type: "lin" | "dec" | "oct";
  /** Points per sweep unit (points per decade/octave for 'dec'/'oct', total points for 'lin'). */
  numPoints: number;
  /** Start frequency in Hz. */
  fStart: number;
  /** Stop frequency in Hz. */
  fStop: number;
  /** Label of the AC voltage source providing excitation. */
  sourceLabel: string;
  /** Labels of nodes to measure (output nodes). */
  outputNodes: string[];
}

// ---------------------------------------------------------------------------
// AcResult — frequency sweep result
// ---------------------------------------------------------------------------

/**
 * Result of an AC frequency sweep analysis.
 *
 * Imported from core/ so that analog-engine-interface.ts does not depend on
 * solver/analog internals. The solver/analog/ac-analysis.ts re-exports these
 * types so consumers may import from either path.
 */
export interface AcResult {
  /** Frequency points in Hz. */
  frequencies: Float64Array;
  /** Magnitude |H(f)| per output node, in dB (20·log10|H|). */
  magnitude: Map<string, Float64Array>;
  /** Phase angle ∠H(f) per output node, in degrees. */
  phase: Map<string, Float64Array>;
  /** Real part Re{H(f)} per output node. */
  real: Map<string, Float64Array>;
  /** Imaginary part Im{H(f)} per output node. */
  imag: Map<string, Float64Array>;
  /** Diagnostics emitted during analysis. */
  diagnostics: Diagnostic[];
}
