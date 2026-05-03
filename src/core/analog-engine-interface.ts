/**
 * AnalogEngine interface- MNA simulation contract.
 *
 * Defines the contract for analog simulation backends. `AnalogEngine` extends
 * the `Engine` base interface so that any code holding an `Engine` reference
 * can accept an `AnalogEngine`. The concrete implementation `MNAEngine`
 * (Phase 1) implements this interface.
 *
 * All associated types (`SimulationParams`, `DcOpResult`, `Diagnostic`,
 * `CompiledAnalogCircuit`) are defined and exported here.
 */

import type { Engine, CompiledCircuit, MeasurementObserver } from "./engine-interface.js";
import type { Wire } from "../core/circuit.js";
import type { AcParams, AcResult } from "../solver/analog/ac-analysis.js";
import type { StatePoolRef } from "../solver/analog/state-pool.js";
import type { IntegrationMethod } from "../solver/analog/integration.js";
import type { DiagnosticSuggestion } from "../compile/types.js";
import type { ConvergenceLog } from "../solver/analog/convergence-log.js";
import type { Diagnostic, DiagnosticCode } from "../compile/types.js";
export type { AcParams, AcResult, DiagnosticSuggestion };
export type { Diagnostic, DiagnosticCode };

// ---------------------------------------------------------------------------
// SimulationParams- transient solver configuration
// ---------------------------------------------------------------------------

/**
 * Simulation parameter set for the MNA transient solver.
 *
 * All fields have defaults matching SPICE conventions. Pass a `Partial` to
 * `configure()` to override individual fields.
 */
export interface SimulationParams {
  /** Maximum allowed timestep in seconds. Default: 10e-6 */
  maxTimeStep?: number;
  /** Minimum allowed timestep in seconds. Default: 1e-15 */
  minTimeStep?: number;
  /** Initial timestep for the first transient step, in seconds. Default: 1e-9 */
  firstStep?: number;
  /** Relative convergence tolerance. Default: 1e-3 */
  reltol: number;
  /** Absolute voltage tolerance in volts (ngspice CKTvoltTol). Default: 1e-6 */
  voltTol: number;
  /** Absolute current tolerance in amperes (ngspice CKTabstol). Default: 1e-12 */
  abstol: number;
  /**
   * Absolute charge tolerance for LTE control, in coulombs. Acts as the
   * floor term in the ngspice-style relative LTE tolerance formula
   *   local_tol = trtol · (reltol · |Q_ref| + chargeTol)
   * It only dominates when the element is carrying near-zero charge; for
   * any realistic signal the relative term dominates. Default: 1e-14
   */
  chargeTol: number;
  /**
   * Truncation-error multiplier (ngspice `trtol`). Multiplies the composite
   * per-element LTE tolerance, giving the simulator a safety margin above
   * the raw absolute+relative floor. ngspice default is 7.0- same here.
   */
  trtol: number;
  /** Maximum Newton-Raphson iterations before declaring failure. Default: 100 */
  maxIterations: number;
  /** Max NR iterations per transient timestep (ngspice ITL4). Default: 10 */
  transientMaxIterations: number;
  /** Integration method. Default: 'trapezoidal' per ngspice cktntask.c:99. No auto mode exists in ngspice; GEAR is user-selectable. */
  integrationMethod: IntegrationMethod;
  /**
   * Max NR iterations per gmin/source stepping sub-solve (ngspice ITL3 / CKTdcTrcvMaxIter).
   * Default: 50.
   */
  dcTrcvMaxIter: number;
  /** Minimum conductance added to all nodes for numerical stability. Default: 1e-12 */
  gmin: number;
  /** Enable node damping in NR iteration (ngspice niiter.c). Default: false */
  nodeDamping: boolean;
  /**
   * Transient stop time in seconds (ngspice CKTfinalTime). Optional- only
   * available in batch/harness runs, not in streaming mode. When provided,
   * the initial timestep uses `MIN(tStop / 100, outputStep) / 10` matching
   * ngspice dctran.c:118. When absent, falls back to `maxTimeStep / 10`.
   */
  tStop?: number;
  /** Shunt conductance applied to all nodes (S). ngspice: CKTgshunt. Default 0. */
  gshunt?: number;
  /** Number of gmin stepping levels. 1 = dynamic (default), >1 = spice3. ngspice: CKTnumGminSteps */
  numGminSteps?: number;
  /** Number of source stepping levels. 0 or 1 = gillespie (default), >1 = spice3_src. ngspice: CKTnumSrcSteps */
  numSrcSteps?: number;
  /** Enable voltage predictor. ngspice: #ifdef PREDICTOR. Default false. */
  predictor?: boolean;
  /** Use Initial Conditions mode. ngspice: MODEUIC. Default false. */
  uic?: boolean;
  /** Active diagonal gmin during stepping (ngspice CKTdiagGmin). Persistent engine state. Default: 0 */
  diagGmin?: number;
  /**
   * Pivot absolute threshold forwarded into SparseSolver per factor call.
   * Mirrors ngspice CKTpivotAbsTol (niiter.c:863, 883; spsmp.c:169, 194).
   * Default: 0 (matches ngspice spalloc.c:193).
   */
  pivotAbsTol?: number;
  /**
   * Pivot relative threshold forwarded into SparseSolver per factor call.
   * Mirrors ngspice CKTpivotRelTol (niiter.c:864; spfactor.c:204-208).
   * Must satisfy 0 < rel <= 1; out-of-range values are ignored at the
   * SparseSolver level (see setPivotTolerances). Default: 1e-3
   * (matches ngspice spconfig.h:331 DEFAULT_THRESHOLD).
   */
  pivotRelTol?: number;
  /** Requested output timestep for initial delta formula (ngspice CKTstep). */
  outputStep?: number;
  /** Start time for data output- skip initial transient (ngspice CKTinitTime). Default: 0 */
  initTime?: number;
  /** Maximum integration order (ngspice CKTmaxOrder). Default: 2 */
  maxOrder?: number;
  /** NEWTRUNC voltage-based LTE relative tolerance (ngspice CKTlteReltol). Default: 1e-3 */
  lteReltol?: number;
  /** NEWTRUNC voltage-based LTE absolute tolerance (ngspice CKTlteAbstol). Default: 1e-6 */
  lteAbstol?: number;
  /** Gmin stepping reduction factor (ngspice CKTgminFactor, cktntask.c:103). Default: 10 */
  gminFactor?: number;
  /**
   * Current source scale factor for source stepping (ngspice srcFact).
   * Runtime state that changes during source stepping- not a user-settable constant.
   * Default: 1 (full scale).
   */
  srcFact?: number;
  /** Trapezoidal integration weighting factor (0=backward Euler, 0.5=trapezoidal). Default: 0.5 */
  xmu?: number;
  /**
   * Skip all NR iterations in the DC-OP ladder (cktop.c noOpIter path).
   * When true, solveDcOperatingPoint() returns immediately with converged=true
   * and the current voltages unchanged. Used for transient DCOP when the circuit
   * has already been initialised with UIC (ngspice: MODEUIC + MODEINITTRAN).
   */
  noOpIter?: boolean;
  /**
   * Operating temperature in Kelvin (ngspice CKTtemp). Used by element setup()
   * to compute temperature-dependent model parameters (e.g. vt = kT/q).
   * Default: 300.15 K (27 °C, matching ngspice default temperature).
   */
  temp?: number;
  /**
   * Nominal model temperature in Kelvin (ngspice CKTnomTemp). The temperature
   * at which model parameters were extracted. Used by BJT, diode, and MOSFET
   * models for temperature scaling. Default: 300.15 K.
   */
  nomTemp?: number;
  /**
   * Whether to copy nodesets into initial conditions (ngspice CKTcopyNodesets).
   * When true, nodeset constraints are promoted to IC constraints for the first
   * transient DC-OP solve. Default: false.
   */
  copyNodesets?: boolean;
}

/** SimulationParams with all optional timestep fields resolved to concrete values. */
export type ResolvedSimulationParams = SimulationParams &
  Required<Pick<SimulationParams, "maxTimeStep" | "minTimeStep" | "firstStep" | "temp" | "nomTemp" | "copyNodesets">>;

/**
 * Default values for all SimulationParams fields, matching circuits-engine-spec.md section 2.
 */
export const DEFAULT_SIMULATION_PARAMS: ResolvedSimulationParams = {
  maxTimeStep: 10e-6,
  minTimeStep: 1e-15,
  firstStep: 1e-9,
  reltol: 1e-3,
  voltTol: 1e-6,
  abstol: 1e-12,
  chargeTol: 1e-14,
  trtol: 7.0,
  maxIterations: 100,
  transientMaxIterations: 10,
  integrationMethod: "trapezoidal",
  dcTrcvMaxIter: 50,
  gmin: 1e-12,
  nodeDamping: false,
  predictor: true,
  gshunt: 0,
  diagGmin: 0,
  pivotAbsTol: 0,
  pivotRelTol: 1e-3,
  initTime: 0,
  maxOrder: 2,
  lteReltol: 1e-3,
  lteAbstol: 1e-6,
  gminFactor: 10,
  srcFact: 1,
  xmu: 0.5,
  temp: 300.15,
  nomTemp: 300.15,
  copyNodesets: false,
};

/**
 * Compute the ngspice-correct initial timestep from transient parameters.
 * Formula: MIN(tStop / 100, tStep) / 10  (ngspice dctran.c:118).
 */
export function computeFirstStep(tStop: number, tStep: number): number {
  return Math.min(tStop / 100, tStep) / 10;
}

/** Resolve optional timestep fields to defaults. */
export function resolveSimulationParams(params: SimulationParams): ResolvedSimulationParams {
  // ngspice traninit.c:23-32. CKTmaxStep is auto-derived only when the user
  // omits it (TRANmaxStep defaults to 0 in trandefs.h, and the ngspice gate
  // is `if (CKTmaxStep == 0)`- negatives/NaN pass through unchanged).
  let maxTimeStep: number;
  const userMax = params.maxTimeStep;
  if (userMax != null && userMax !== 0) {
    maxTimeStep = userMax;
  } else if (params.tStop != null && params.tStop > 0 && params.outputStep != null) {
    // CKTmaxStep = MIN(CKTstep, (CKTfinalTime - CKTinitTime) / 50)
    const tStart = params.initTime ?? 0;
    const span = (params.tStop - tStart) / 50;
    maxTimeStep = params.outputStep < span ? params.outputStep : span;
  } else {
    // Streaming mode (no tStop)- ngspice cannot run .tran without a
    // finalTime; the static default is the closest analogue.
    maxTimeStep = DEFAULT_SIMULATION_PARAMS.maxTimeStep;
  }
  // ngspice: CKTdelmin = 1e-11 * CKTmaxStep. Only compute when user hasn't set it explicitly.
  const minTimeStep = params.minTimeStep != null ? params.minTimeStep : 1e-11 * maxTimeStep;
  let firstStep = params.firstStep;
  if (firstStep == null) {
    if (params.tStop != null && params.tStop > 0) {
      // ngspice dctran.c:118: delta = MIN(CKTfinalTime/100, CKTstep) / 10.
      // Use params.outputStep (CKTstep) when provided; fall back to maxTimeStep.
      const tStep = params.outputStep ?? maxTimeStep;
      firstStep = computeFirstStep(params.tStop, tStep);
    } else {
      firstStep = DEFAULT_SIMULATION_PARAMS.firstStep;
    }
  }
  return {
    ...DEFAULT_SIMULATION_PARAMS,
    ...params,
    maxTimeStep,
    minTimeStep,
    firstStep,
  };
}

// ---------------------------------------------------------------------------
// DcOpResult- result of a DC operating-point analysis
// ---------------------------------------------------------------------------

/**
 * Result returned by `AnalogEngine.dcOperatingPoint()`.
 */
export interface DcOpResult {
  /** Whether the DC operating point converged. */
  converged: boolean;
  /** Which convergence method was used. */
  method: "direct" | "dynamic-gmin" | "spice3-gmin" | "gillespie-src" | "spice3-src";
  /** Total Newton-Raphson iterations performed across all attempts. */
  iterations: number;
  /** Node voltages at the operating point (indexed by MNA node ID). */
  nodeVoltages: Float64Array;
  /** Any diagnostics emitted during the DC analysis. */
  diagnostics: Diagnostic[];
}

// ---------------------------------------------------------------------------
// CompiledAnalogCircuit- executable analog circuit representation
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
  /** Shared state pool for per-element operating-point state.
   *
   *  Null between compile and `MNAEngine._setup()`- per-element state counts
   *  aren't known until each element's setup() runs, so the compiler leaves
   *  this field unset and `_setup()` writes back the allocated pool.
   *  Consumers reading the pool from a compiled circuit MUST null-check. */
  statePool: StatePoolRef | null;
  /**
   * Nodeset constraints: map of MNA nodeId → target voltage.
   * Passed to the NR solver to enforce voltage starting points via 1e10
   * conductance stamps during initJct/initFix phases.
   */
  readonly nodesets?: Map<number, number>;
  /**
   * Initial condition constraints: map of MNA nodeId → target voltage.
   * Passed to the NR solver to enforce IC node voltages via 1e10 conductance
   * stamps on every NR iteration.
   */
  readonly ics?: Map<number, number>;
}

// ---------------------------------------------------------------------------
// AnalogEngine- MNA simulation interface
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
   * source stepping. Emits `Diagnostic` records for every fallback or
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

  /** Restore simulation time (used by hot-recompile to carry simTime across
   *  a fresh engine instance). Implementations must also propagate the new
   *  value to any cached time reference inside the compiled circuit. */
  setSimTime(t: number): void;

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
   * Set the voltage at MNA node `nodeId`.
   * Used by hot-recompile state restoration. Sets both current and
   * previous voltage to avoid false transients.
   */
  setNodeVoltage(nodeId: number, voltage: number): void;

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
   * Register a callback to receive `Diagnostic` records as they are
   * emitted. Multiple callbacks can be registered; each is called in
   * registration order.
   */
  onDiagnostic(callback: (diag: Diagnostic) => void): void;

  // -------------------------------------------------------------------------
  // Convergence logging
  // -------------------------------------------------------------------------

  /** Convergence log for post-mortem analysis. Enable via convergenceLog.enabled = true. */
  readonly convergenceLog: ConvergenceLog;

  // -------------------------------------------------------------------------
  // Breakpoints- timestep landing targets
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

// --- Compile-time guard: public SimulationParams.integrationMethod must
// equal the internal IntegrationMethod type exactly (no drift between the
// UI / MCP / postMessage public surface and the solver-facing type).
// If this line fails to compile, the two types have diverged- realign
// before shipping. See spec/phase-3-f2-nr-reorder-xfact.md Wave 3.3.
type _AssertPublicInternalEq =
  SimulationParams["integrationMethod"] extends IntegrationMethod
    ? IntegrationMethod extends SimulationParams["integrationMethod"]
      ? true
      : never
    : never;
const _assertPublicInternalEq: _AssertPublicInternalEq = true;
void _assertPublicInternalEq;
