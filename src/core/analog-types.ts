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
 * 'gear'        — general Gear BDF method, orders 3-6 (nicomcof.c Vandermonde)
 */
export type IntegrationMethod = "trapezoidal" | "bdf1" | "bdf2" | "gear";

// ---------------------------------------------------------------------------
// Minimal SparseSolver interface — structural duck-type for stamp methods
// ---------------------------------------------------------------------------

/**
 * Minimal structural interface for the MNA sparse solver.
 *
 * Production elements call the full `SparseSolver` via `LoadContext.solver`
 * and use the handle-based `allocElement` / `stampElement` / `stampRHS` API.
 *
 * The full SparseSolver class (with factorization, solve, etc.) lives in
 * solver/analog/sparse-solver.ts and satisfies this interface structurally.
 */
export interface SparseSolverStamp {
  allocElement(row: number, col: number): number;
  stampElement(handle: number, value: number): void;
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
  stampRHS(row: number, re: number, im: number): void;
  allocComplexElement(row: number, col: number): number;
  stampComplexElement(handle: number, re: number, im: number): void;
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
  readonly state4: Float64Array;
  readonly state5: Float64Array;
  readonly state6: Float64Array;
  readonly state7: Float64Array;
  readonly totalSlots: number;
  /** Number of accepted transient steps. 0 = MODEINITTRAN equivalent. */
  readonly tranStep: number;
  // Phase 2.5 W2.3: `initMode` string union deleted. INITF state lives in
  // the `cktMode` bitfield (LoadContext.cktMode) — read via
  // `initf(cktMode) === MODEINIT...` and written via
  // `setInitf(cktMode, MODEINIT...)` per cktdefs.h:177-182. For diagnostic
  // labels use `bitsToName(cktMode)` from ckt-mode.ts.
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
   * Primary hot-path method. Called every NR iteration.
   *
   * Reads terminal voltages from ctx.voltages, evaluates device equations,
   * and stamps conductance and RHS contributions into ctx.solver. For reactive
   * elements, also integrates charge/flux inline using ctx.ag[]. Matches
   * ngspice DEVload.
   */
  load(ctx: import("../solver/analog/load-context.js").LoadContext): void;

  /**
   * Post-acceptance work: update companion state and schedule next breakpoint.
   *
   * Called once per accepted timestep — never on a rejected LTE retry and
   * never inside the NR convergence loop. ctx provides dt, method, and
   * voltages needed for companion/state updates.
   */
  accept?(ctx: import("../solver/analog/load-context.js").LoadContext, simTime: number, addBreakpoint: (t: number) => void): void;

  /**
   * Element-specific convergence check beyond the global node-voltage criterion.
   *
   * Called after every NR iteration. Return true if this element considers
   * the current solution converged; false to signal that iteration must
   * continue. Tolerances reltol and iabstol are available on ctx.
   */
  checkConvergence?(ctx: import("../solver/analog/load-context.js").LoadContext): boolean;

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
    method: IntegrationMethod,
    lteParams: import("../solver/analog/ckt-terr.js").LteParams,
  ): number;

  /**
   * Update a mutable parameter on a live compiled element without
   * recompilation. Called by the coordinator for slider/property-panel
   * hot-patching. All compiled elements must implement this method.
   */
  setParam(key: string, value: number): void;

  /**
   * Stamp the element's frequency-domain small-signal model for AC analysis.
   * D4: receives LoadContext; see src/solver/analog/element.ts for semantics.
   */
  stampAc?(
    solver: ComplexSparseSolver,
    omega: number,
    ctx: import("../solver/analog/load-context.js").LoadContext,
  ): void;

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
   * Compute per-pin currents for this element.
   *
   * Returns an array of currents in pinLayout order (same as pinNodeIds),
   * one per visible pin. Positive means current flowing into the element.
   * The array must satisfy KCL: the sum of all entries is zero.
   */
  getPinCurrents(voltages: Float64Array): number[];

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
