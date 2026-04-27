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
 * Corresponds to ngspice cktdefs.h:107-108:
 *   #define TRAPEZOIDAL 1
 *   #define GEAR        2
 *
 * 'trapezoidal' — A-stable trapezoidal rule (ngspice TRAPEZOIDAL=1).
 *                 Order 1 uses the trap-1 coefficients per nicomcof.c:40-41.
 * 'gear'        — Gear BDF method, orders 1..6 via Vandermonde collocation
 *                 (ngspice GEAR=2, nicomcof.c:52-127). Order 1 also uses the
 *                 trap-1 coefficients per nicomcof.c:40-41.
 *
 * Default per ngspice cktntask.c:99: TRAPEZOIDAL.
 */
export type IntegrationMethod = "trapezoidal" | "gear";

// ---------------------------------------------------------------------------
// NGSPICE_LOAD_ORDER — device-type ordinals for cktLoad order parity (A1)
// ---------------------------------------------------------------------------

/**
 * Per-type cktLoad ordinals matching `ref/ngspice/src/spicelib/devices/dev.c`
 * `DEVices[]` registration order. Lower ordinal = loaded first.
 *
 * Each `make*` analog factory must set its returned `AnalogElementCore.ngspiceLoadOrder`
 * to one of these constants. The compiler sorts `analogElements` by this field
 * before handing it to the engine so that the per-iteration `cktLoad` walks
 * devices in the same per-type bucket order ngspice does (every R, every C,
 * ..., every V, ...). This is a structural prerequisite for our internal
 * sparse-matrix indices to match ngspice bit-exact, since ngspice's `Translate`
 * (spbuild.c:436-504) lazily assigns internal indices on first sight of each
 * external row/col during the first NR iteration's load loop.
 *
 * Extend this enum when a new device type is added under parity testing —
 * the existing entries reflect the subset of ngspice device types we have
 * fixtures for plus a few neighbours.
 */
export const NGSPICE_LOAD_ORDER = {
  URC:  0,   // Uniform RC line — pinned first (dev.c:141 "MUST precede both resistors and capacitors")
  BJT:  2,   // Bipolar junction transistor
  CAP:  17,  // Capacitor
  CCCS: 18,  // Current-controlled current source
  CCVS: 19,  // Current-controlled voltage source
  DIO:  22,  // Diode
  IND:  27,  // Inductor
  MUT:  28,  // Mutual inductance / transformer
  ISRC: 29,  // Independent current source
  JFET: 30,  // Junction FET
  MOS:  35,  // MOSFET (level 1; higher levels would be 36..39)
  RES:  40,  // Resistor
  SW:   42,  // Switch
  TRA:  43,  // Lossless transmission line
  VCCS: 46,  // Voltage-controlled current source
  VCVS: 47,  // Voltage-controlled voltage source
  VSRC: 48,  // Independent voltage source
} as const;

// ---------------------------------------------------------------------------
// Minimal SparseSolver interface — structural duck-type for stamp methods
// ---------------------------------------------------------------------------

/**
 * Minimal structural interface for the MNA sparse solver.
 *
 * Production elements call the full `SparseSolver` via `LoadContext.solver`
 * and use the handle-based `allocElement` / `stampElement` API. RHS stamps
 * write directly into `LoadContext.rhs` (ngspice CKTrhs) — see
 * `stamp-helpers.ts::stampRHS(rhs, row, val)` and Phase 6 / B.16.
 *
 * The full SparseSolver class (with factorization, solve, etc.) lives in
 * solver/analog/sparse-solver.ts and satisfies this interface structurally.
 */
export interface SparseSolverStamp {
  allocElement(row: number, col: number): number;
  stampElement(handle: number, value: number): void;
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
   *
   * Mutable: setup() writes it via `this.branchIndex = ctx.makeCur(...)`.
   */
  branchIndex: number;

  /**
   * Position in ngspice's CKTload iteration order. Mirrors the device-type
   * ordinal in `ref/ngspice/src/spicelib/devices/dev.c` `DEVices[]`.
   * Lower-ordinal elements load first.
   *
   * Architectural alignment item A1: ngspice's `Translate` (spbuild.c:436-504,
   * our port at sparse-solver.ts:399-423) lazily assigns internal sparse-matrix
   * indices on first sight of each external row/col during the first NR
   * iteration's `cktLoad`. The order in which devices stamp therefore
   * determines internal numbering — and the only way to match ngspice's
   * internal layout bit-exact is to load devices in the same per-type bucket
   * order ngspice uses (every R, then every C, ..., then every V, ...).
   *
   * Set this on every `make*` analog factory return value via the
   * `NGSPICE_LOAD_ORDER` enum in this file. Required, not defaulted —
   * forgetting it is a type error so new components surface the
   * "what device is this in ngspice terms?" question at registration.
   */
  readonly ngspiceLoadOrder: number;

  /** Allocate every internal node, branch row, state slot, and
   *  sparse-matrix entry this element will ever need, in the same
   *  order as the corresponding ngspice DEVsetup. Called once per
   *  MNAEngine._setup() invocation, before any load() call.
   *
   *  Implementations:
   *   - call ctx.makeVolt() for each internal node ngspice creates with
   *     CKTmkVolt;
   *   - call ctx.makeCur() for each branch row ngspice creates with
   *     CKTmkCur, storing the result in branchIndex;
   *   - call ctx.allocStates(N) where ngspice's *setup.c does
   *     `*states += N`;
   *   - call solver.allocElement(row, col) for every TSTALLOC line in
   *     line-for-line order, storing handles on `this`;
   *   - never call solver.allocElement from load().
   *
   *  Order of allocElement calls determines internal-index assignment.
   *  It MUST mirror the corresponding ngspice DEVsetup line-for-line —
   *  including stamps that ngspice allocates unconditionally even when
   *  their value will be zero in some operating mode.
   */
  setup(ctx: import("../solver/analog/setup-context.js").SetupContext): void;

  /** Optional callback used by VSRC, VCVS, CCVS, IND, CRYSTAL, and RELAY elements that own
   *  branch rows. Called by `_findBranch` when a controlling source needs lazy branch-row
   *  allocation. Returns the branch row index (allocates if missing) or 0 if this element
   *  doesn't own the requested branch. */
  findBranchFor?(name: string, ctx: import("../solver/analog/setup-context.js").SetupContext): number;

  /** Set during setup() via ctx.allocStates(N). Index of this element's first state-pool slot.
   *  -1 if element has no state slots. */
  _stateBase: number;

  /** Pin-label-to-MNA-node map. Populated by the factory at construction; read-only
   *  thereafter. setup() bodies access pin nodes by label: `this._pinNodes.get("pos")!`. */
  _pinNodes: Map<string, number>;

  /**
   * Primary hot-path method. Called every NR iteration.
   *
   * Reads terminal voltages from ctx.rhsOld, evaluates device equations,
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
  getPinCurrents(rhs: Float64Array): number[];

  /**
   * Optional display label for diagnostic attribution.
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
   * Called once per accepted timestep so the element can schedule its next
   * waveform edge as a timestep breakpoint. Mirrors ngspice's per-device
   * DEVaccept dispatch (vsrcacct.c VSRCaccept).
   *
   * `atBreakpoint` is the engine's CKTbreak flag: true when the just-accepted
   * step landed via a breakpoint clamp.
   */
  acceptStep?(
    simTime: number,
    addBreakpoint: (t: number) => void,
    atBreakpoint: boolean,
  ): void;

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
