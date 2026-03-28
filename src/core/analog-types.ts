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
export type DeviceType = "NPN" | "PNP" | "NMOS" | "PMOS" | "NJFET" | "PJFET" | "D" | "TUNNEL";

// ---------------------------------------------------------------------------
// SolverDiagnosticCode — exhaustive union of all diagnostic codes
// ---------------------------------------------------------------------------

/**
 * All diagnostic codes that the analog solver and circuit validator can emit.
 *
 * Codes prefixed with solver terms (`singular-matrix`, `convergence-failed`,
 * etc.) are analog-solver specific. The remaining codes are shared with the
 * digital netlist validator and appear when the analog compiler processes a
 * circuit with structural errors.
 */
export type SolverDiagnosticCode =
  | "singular-matrix"
  | "voltage-source-loop"
  | "floating-node"
  | "orphan-node"
  | "inductor-loop"
  | "no-ground"
  | "convergence-failed"
  | "timestep-too-small"
  | "dc-op-converged"
  | "dc-op-gmin"
  | "dc-op-source-step"
  | "dc-op-failed"
  | "width-mismatch"
  | "unconnected-input"
  | "unconnected-output"
  | "multi-driver-no-tristate"
  | "missing-subcircuit"
  | "label-collision"
  | "combinational-loop"
  | "missing-property"
  | "unknown-component"
  | "model-param-ignored"
  | "model-level-unsupported"
  | "unsupported-component-in-analog"
  | "bridge-inner-compile-error"
  | "bridge-unconnected-pin"
  | "bridge-missing-inner-pin"
  | "bridge-indeterminate-input"
  | "bridge-oscillating-input"
  | "bridge-impedance-mismatch"
  | "missing-transistor-model"
  | "invalid-transistor-model"
  | "transmission-line-low-segments"
  | "reverse-biased-cap"
  | "fuse-blown"
  | "ndr-convergence-assist"
  | "rs-flipflop-both-set"
  | "ac-no-source"
  | "ac-linearization-failed"
  | "unsupported-ctz-component"
  | "monte-carlo-trial-failed"
  | "unconnected-analog-pin";

// ---------------------------------------------------------------------------
// DiagnosticSuggestion — actionable fix hint
// ---------------------------------------------------------------------------

/**
 * A concrete suggestion attached to a `SolverDiagnostic`.
 *
 * When `automatable` is `true`, the editor can apply the fix automatically
 * using the `patch` field as a circuit patch operation.
 */
export interface DiagnosticSuggestion {
  /** Human-readable description of the suggested fix. */
  text: string;
  /** Whether the editor can apply this fix without user intervention. */
  automatable: boolean;
  /** Optional patch operation that implements the fix. */
  patch?: unknown;
}

// ---------------------------------------------------------------------------
// SolverDiagnostic — rich diagnostic record
// ---------------------------------------------------------------------------

/**
 * A diagnostic record emitted by the analog solver or circuit validator.
 *
 * Diagnostics are designed to be pedagogically useful: every solver fallback,
 * anomaly, or failure produces a plain-language explanation with suggestions.
 */
export interface SolverDiagnostic {
  /** Machine-readable diagnostic code. */
  code: SolverDiagnosticCode;
  /** Severity level. */
  severity: "info" | "warning" | "error";
  /** One-line summary of the issue. */
  summary: string;
  /** Detailed explanation for display in the diagnostics panel. */
  explanation: string;
  /** Ordered list of suggested fixes. */
  suggestions: DiagnosticSuggestion[];
  /** Node IDs involved in this diagnostic, if applicable. */
  involvedNodes?: number[];
  /** Element IDs involved in this diagnostic, if applicable. */
  involvedElements?: number[];
  /** Simulation time at which this diagnostic was emitted, in seconds. */
  simTime?: number;
  /** Additional detail string for extended context. */
  detail?: string;
}

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
 * types for backward compatibility.
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
  diagnostics: SolverDiagnostic[];
}
