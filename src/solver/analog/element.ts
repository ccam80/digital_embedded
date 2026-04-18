/**
 * AnalogElement interface — the sole contract that all analog circuit
 * components program against.
 *
 * A single load(ctx: LoadContext) method replaces the former split of stamp /
 * stampNonlinear / updateOperatingPoint / stampCompanion / stampReactiveCompanion.
 * This matches ngspice's DEVload dispatch: one call per element per NR iteration
 * that reads voltages, evaluates device equations, and stamps the MNA matrix.
 */

// Core analog types are defined in core/analog-types.ts to avoid solver→core
// circular dependency.
export type {
  AnalogElementCore,
  ComplexSparseSolver,
  IntegrationMethod,
  SparseSolverStamp,
  StatePoolRef,
} from "../../core/analog-types.js";

import type { AnalogElementCore, ComplexSparseSolver, IntegrationMethod, StatePoolRef } from "../../core/analog-types.js";
import type { StateSchema } from "./state-schema.js";
export type { LoadContext, InitMode } from "./load-context.js";
import type { LoadContext } from "./load-context.js";

// ---------------------------------------------------------------------------
// AnalogElement
// ---------------------------------------------------------------------------

/**
 * Contract for every analog circuit element that stamps into the MNA matrix.
 *
 * Two-terminal passive elements (resistors, capacitors, inductors) connect
 * two nodes. Three-terminal (BJT base/emitter/collector) and four-terminal
 * (MOSFET gate/drain/source/bulk) elements carry more entries in pinNodeIds.
 *
 * Elements that introduce extra MNA rows (voltage sources, inductors as
 * branch currents) set `branchIndex` to their assigned row offset above the
 * node block. All other elements set `branchIndex` to -1.
 */
export interface AnalogElement {
  /**
   * Primary hot-path method. Called every NR iteration.
   *
   * Reads terminal voltages from ctx.voltages, evaluates device equations,
   * and stamps conductance and RHS contributions into ctx.solver. For reactive
   * elements, also integrates charge/flux inline using ctx.ag[]. Matches
   * ngspice DEVload.
   */
  load(ctx: LoadContext): void;

  /**
   * Post-acceptance work: update companion state and schedule next breakpoint.
   *
   * Called once per accepted timestep — never on a rejected LTE retry and
   * never inside the NR convergence loop. Absorbs the former updateCompanion
   * and updateState responsibilities. ctx provides dt, method, and voltages
   * needed for companion/state updates.
   */
  accept?(ctx: LoadContext, simTime: number, addBreakpoint: (t: number) => void): void;

  /**
   * Element-specific convergence check beyond the global node-voltage criterion.
   *
   * Called after every NR iteration. Return true if this element considers
   * the current solution converged; false to signal that iteration must
   * continue. Tolerances reltol and iabstol are available on ctx.
   */
  checkConvergence?(ctx: LoadContext): boolean;

  /**
   * CKTterr-based LTE timestep proposal. Returns the maximum allowable
   * timestep for this element based on charge history divided differences.
   *
   * Elements implementing this method call cktTerr() internally for each
   * reactive junction, passing charge values as individual scalars (not arrays)
   * to avoid hot-path allocations.
   */
  getLteTimestep?(
    dt: number,
    deltaOld: readonly number[],
    order: number,
    method: IntegrationMethod,
    lteParams: import("./ckt-terr.js").LteParams,
  ): number;

  /**
   * Update a mutable parameter on a live compiled element without
   * recompilation. Called by the coordinator for slider/property-panel
   * hot-patching.
   */
  setParam(key: string, value: number): void;

  /**
   * Scale independent source magnitude for source-stepping DC convergence.
   *
   * Called by the DC operating point solver during source stepping. The
   * factor argument ramps from 0 (sources disabled) to 1 (full magnitude).
   * Elements that are not independent sources do not implement this method.
   */
  setSourceScale?(factor: number): void;

  /**
   * Stamp the element's frequency-domain small-signal model for AC analysis.
   *
   * Called once per frequency point during an AC sweep. Resistors stamp
   * conductance (same as DC); capacitors stamp jωC admittance; inductors
   * stamp 1/(jωL) admittance; nonlinear elements stamp linearized
   * small-signal conductances at the DC operating point.
   */
  stampAc?(solver: ComplexSparseSolver, omega: number): void;

  /**
   * Arm a one-shot per-device junction seed for cold-start NR convergence.
   * Called once by the dcopInitJct phase before the main NR runs. The device
   * stores tVcrit-derived junction voltages in internal state; the next call
   * to load() consumes and clears that state.
   *
   * Matches ngspice MODEINITJCT (bjtload.c:265-274): a per-device
   * linearization-point override, NOT a write into the shared MNA vector.
   * Optional; linear elements do not implement this.
   */
  primeJunctions?(): void;

  /**
   * Compute per-pin currents for this element.
   *
   * Returns an array of currents in pinLayout order (same as pinNodeIds),
   * one per visible pin. Positive means current flowing into the element.
   * The array must satisfy KCL: the sum of all entries is zero.
   */
  getPinCurrents(voltages: Float64Array): number[];

  /**
   * Pin node IDs in pinLayout order.
   *
   * For elements created via the analog compiler, this array is in the same
   * order as the component's pinLayout declaration. Index 0 corresponds to
   * pinLayout[0], index 1 to pinLayout[1], etc.
   *
   * Set by the compiler from resolved pins — never by factory functions.
   * Length 2 for two-terminal elements, 3 for BJTs, 4 for MOSFETs.
   * Each entry is a non-negative integer; 0 is ground.
   */
  readonly pinNodeIds: readonly number[];

  /**
   * All node IDs for this element: [...pinNodeIds, ...internalNodeIds].
   *
   * Pin nodes appear first in pinLayout order, followed by any internal
   * nodes allocated by the factory. Used by topology validators that must
   * account for all nodes an element participates in.
   *
   * Set by the compiler — never by factory functions.
   */
  readonly allNodeIds: readonly number[];

  /**
   * Labels for internal nodes allocated by this element's model, in the
   * same order as the internal portion of allNodeIds. Absent or empty when
   * the model allocates no internal nodes.
   */
  readonly internalNodeLabels?: readonly string[];

  /**
   * Assigned branch-current row index for elements that introduce extra MNA
   * rows (voltage sources, inductors). Set to -1 for elements that do not
   * add extra rows.
   */
  readonly branchIndex: number;

  /**
   * True if this element performs nonlinear stamping inside load().
   *
   * The engine reads this flag to decide whether to call load() for
   * nonlinear elements during NR iteration or only once per timestep.
   */
  readonly isNonlinear: boolean;

  /**
   * True if this element integrates reactive state (charge/flux) inside load().
   *
   * The timestep controller reads this flag to decide whether to call
   * getLteTimestep() for reactive element handling.
   */
  readonly isReactive: boolean;

  /**
   * Optional display label for diagnostic attribution.
   *
   * When present, used in Diagnostic.involvedElements descriptions
   * to identify which element triggered a convergence failure or anomaly.
   */
  label?: string;

  /**
   * Element index in the compiled circuit's element array.
   *
   * Set by the compiler after factory construction via Object.assign.
   * Used by elements when pushing LimitingEvent records so the harness
   * can correlate events back to specific circuit elements.
   */
  elementIndex?: number;

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

  /**
   * Called once per accepted timestep so the element can schedule its next
   * waveform edge as a timestep breakpoint.
   */
  acceptStep?(simTime: number, addBreakpoint: (t: number) => void): void;
}

/**
 * AnalogElementCore extended with state-pool-backed fields.
 * For components that use the shared state pool but do NOT necessarily
 * implement companion models for transient integration.
 */
export interface PoolBackedAnalogElementCore extends AnalogElementCore {
  readonly poolBacked: true;
  readonly stateSize: number;
  stateBaseOffset: number;
  readonly stateSchema: StateSchema;
  initState(pool: StatePoolRef): void;
  refreshSubElementRefs?(
    newS0: Float64Array, newS1: Float64Array, newS2: Float64Array, newS3: Float64Array,
    newS4: Float64Array, newS5: Float64Array, newS6: Float64Array, newS7: Float64Array,
  ): void;
  s0: Float64Array;
  s1: Float64Array;
  s2: Float64Array;
  s3: Float64Array;
  s4: Float64Array;
  s5: Float64Array;
  s6: Float64Array;
  s7: Float64Array;
}

/**
 * AnalogElementCore extended with state-pool-backed reactive fields.
 *
 * This is the factory return type for components that use the shared
 * state pool (capacitors, diodes, BJTs, etc.). It does NOT include
 * pinNodeIds / allNodeIds — those are set by the compiler after
 * factory construction.
 */
export interface ReactiveAnalogElementCore extends PoolBackedAnalogElementCore {
  readonly isReactive: true;
}

/**
 * Post-compilation pool-backed element with compiler-assigned node IDs.
 */
export type PoolBackedAnalogElement = PoolBackedAnalogElementCore & AnalogElement;

/**
 * Post-compilation reactive element with both compiler-assigned node IDs
 * and state-pool fields. Used by the engine and post-compilation code.
 */
export type ReactiveAnalogElement = ReactiveAnalogElementCore & AnalogElement;

export function isPoolBacked(el: AnalogElement): el is PoolBackedAnalogElement;
export function isPoolBacked(el: AnalogElementCore): el is PoolBackedAnalogElementCore;
export function isPoolBacked(el: AnalogElementCore): el is PoolBackedAnalogElementCore {
  return (el as any).poolBacked === true;
}
