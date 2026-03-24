/**
 * AnalogEngine interface — MNA simulation contract.
 *
 * Defines the contract for analog simulation backends. `AnalogEngine` extends
 * the `Engine` base interface so that any code holding an `Engine` reference
 * can accept an `AnalogEngine`. The concrete implementation `MNAEngine`
 * (Phase 1) implements this interface.
 *
 * All associated types (`SimulationParams`, `DcOpResult`, `SolverDiagnostic`,
 * `CompiledAnalogCircuit`) are defined and exported here.
 */

import type { Engine, CompiledCircuit, MeasurementObserver } from "./engine-interface.js";
import type { Wire } from "../core/circuit.js";
import type { AcParams, AcResult } from "../analog/ac-analysis.js";

// ---------------------------------------------------------------------------
// SimulationParams — transient solver configuration
// ---------------------------------------------------------------------------

/**
 * Simulation parameter set for the MNA transient solver.
 *
 * All fields have defaults matching SPICE conventions. Pass a `Partial` to
 * `configure()` to override individual fields.
 */
export interface SimulationParams {
  /** Maximum allowed timestep in seconds. Default: 5e-6 */
  maxTimeStep: number;
  /** Minimum allowed timestep in seconds. Default: 1e-14 */
  minTimeStep: number;
  /** Relative convergence tolerance. Default: 1e-3 */
  reltol: number;
  /** Absolute voltage tolerance in volts. Default: 1e-6 */
  abstol: number;
  /** Charge tolerance for LTE control. Default: 1e-14 */
  chargeTol: number;
  /** Maximum Newton-Raphson iterations before declaring failure. Default: 100 */
  maxIterations: number;
  /** Integration method. Default: 'auto' */
  integrationMethod: "auto" | "trapezoidal" | "bdf1" | "bdf2";
  /** Minimum conductance added to all nodes for numerical stability. Default: 1e-12 */
  gmin: number;
}

/**
 * Default values for all SimulationParams fields, matching circuits-engine-spec.md section 2.
 */
export const DEFAULT_SIMULATION_PARAMS: SimulationParams = {
  maxTimeStep: 5e-6,
  minTimeStep: 1e-14,
  reltol: 1e-3,
  abstol: 1e-6,
  chargeTol: 1e-14,
  maxIterations: 100,
  integrationMethod: "auto",
  gmin: 1e-12,
};

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
// DcOpResult — result of a DC operating-point analysis
// ---------------------------------------------------------------------------

/**
 * Result returned by `AnalogEngine.dcOperatingPoint()`.
 */
export interface DcOpResult {
  /** Whether the DC operating point converged. */
  converged: boolean;
  /** Which convergence method was used. */
  method: "direct" | "gmin-stepping" | "source-stepping";
  /** Total Newton-Raphson iterations performed across all attempts. */
  iterations: number;
  /** Node voltages at the operating point (indexed by MNA node ID). */
  nodeVoltages: Float64Array;
  /** Any diagnostics emitted during the DC analysis. */
  diagnostics: SolverDiagnostic[];
}

// ---------------------------------------------------------------------------
// CompiledAnalogCircuit — executable analog circuit representation
// ---------------------------------------------------------------------------

/**
 * The executable representation of an analog circuit, produced by the analog
 * compiler (Phase 1) from a visual Circuit model.
 *
 * Extends `CompiledCircuit` so that the runner's label resolution and
 * compilation infrastructure work uniformly across engine types.
 */
export interface CompiledAnalogCircuit extends CompiledCircuit {
  /** Number of non-ground MNA nodes (matrix size = nodeCount). */
  readonly nodeCount: number;
  /** Number of analog elements (components with MNA stamps). */
  readonly elementCount: number;
  /** Maps component label strings to MNA node IDs for runner label resolution. */
  readonly labelToNodeId: Map<string, number>;
  /** Maps Wire objects to MNA node IDs for wire renderer signal access. */
  readonly wireToNodeId: Map<Wire, number>;
}

// ---------------------------------------------------------------------------
// AnalogEngine — MNA simulation interface
// ---------------------------------------------------------------------------

/**
 * Analog simulation engine interface.
 *
 * Extends `Engine` so any code holding an `Engine` reference can accept an
 * `AnalogEngine`. The concrete implementation `MNAEngine` is delivered in
 * Phase 1.
 */
export interface AnalogEngine extends Engine {
  // -------------------------------------------------------------------------
  // DC Analysis
  // -------------------------------------------------------------------------

  /**
   * Find the DC operating point of the circuit.
   *
   * Attempts direct Newton-Raphson first; falls back to Gmin stepping, then
   * source stepping. Emits `SolverDiagnostic` records for every fallback or
   * failure via the `onDiagnostic` callback.
   */
  dcOperatingPoint(): DcOpResult;

  /**
   * Run an AC small-signal frequency sweep analysis.
   *
   * Solves the DC operating point to linearize nonlinear elements, then sweeps
   * frequency and returns complex transfer function data at the requested output
   * nodes. The engine must be initialised (`init()` called) before invoking this.
   */
  acAnalysis(params: AcParams): AcResult;

  // -------------------------------------------------------------------------
  // Simulation time
  // -------------------------------------------------------------------------

  /** Current simulation time in seconds. Advances after each accepted step. */
  readonly simTime: number;

  /** Last accepted timestep in seconds. Updated after each `step()` call. */
  readonly lastDt: number;

  // -------------------------------------------------------------------------
  // State access
  // -------------------------------------------------------------------------

  /**
   * Return the voltage at MNA node `nodeId` (referenced to ground).
   * Valid after `dcOperatingPoint()` or after one or more `step()` calls.
   */
  getNodeVoltage(nodeId: number): number;

  /**
   * Return the current through the branch-current row `branchId` in the MNA
   * matrix. Used for voltage sources and inductors which introduce extra rows.
   */
  getBranchCurrent(branchId: number): number;

  /**
   * Return the instantaneous current through analog element `elementId`.
   * Computed from node voltages and element conductance / branch row.
   */
  getElementCurrent(elementId: number): number;

  /**
   * Return per-pin currents for analog element `elementId`.
   *
   * Returns an array of currents (one per pin in `pinNodeIds` order) where
   * positive means current flowing **into** the element at that pin.
   * The array satisfies KCL: the sum of all entries is zero.
   */
  getElementPinCurrents(elementId: number): number[];

  /**
   * Return the instantaneous power dissipated by analog element `elementId`
   * in watts. Computed as V * I at the element terminals.
   */
  getElementPower(elementId: number): number;

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  /**
   * Update solver parameters. Merges the given partial set into the active
   * `SimulationParams`. Takes effect from the next `step()` or
   * `dcOperatingPoint()` call.
   */
  configure(params: Partial<SimulationParams>): void;

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  /**
   * Register a callback to receive `SolverDiagnostic` records as they are
   * emitted. Multiple callbacks can be registered; each is called in
   * registration order.
   */
  onDiagnostic(callback: (diag: SolverDiagnostic) => void): void;

  // -------------------------------------------------------------------------
  // Breakpoints — timestep landing targets
  // -------------------------------------------------------------------------

  /**
   * Register a simulation time (in seconds) at which the adaptive timestep
   * controller must land a step exactly.
   *
   * Used by the mixed-signal coordinator (Phase 4) to synchronise digital
   * clock edges with the analog timeline, and by source components (square
   * waves, PWM) with known discontinuity times.
   */
  addBreakpoint(time: number): void;

  /**
   * Remove all registered breakpoints.
   *
   * Called by the mixed-signal coordinator when restarting a simulation or
   * when all registered source components have been removed.
   */
  clearBreakpoints(): void;

  // -------------------------------------------------------------------------
  // Measurement observers
  // -------------------------------------------------------------------------

  /**
   * Register an observer to receive step/reset notifications.
   * The observer's `onStep()` is called after each accepted timestep.
   * The observer's `onReset()` is called when the engine is reset.
   */
  addMeasurementObserver(observer: MeasurementObserver): void;

  /**
   * Remove a previously registered measurement observer.
   */
  removeMeasurementObserver(observer: MeasurementObserver): void;
}
