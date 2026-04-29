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
 * Each `make*` analog factory must set its returned `AnalogElement.ngspiceLoadOrder`
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

/**
 * Per-`typeId` ngspice load-order lookup, mirroring `DEVices[]` indexing.
 *
 * In ngspice, load order is a property of the device TYPE (its position in the
 * global `DEVices[]` array — see dev.c). It is not a per-instance or per-model
 * field. To match ngspice's parser-time node-numbering walk order without
 * instantiating element factories, the analog compiler queries this table
 * before constructing `AnalogElement`s.
 *
 * Composite components (Optocoupler, ADC, DAC, opamp, timer-555, etc.) decompose
 * into multiple sub-element stamps at runtime, but to ngspice they look like
 * one or more independent device lines on the deck. The value here is the
 * load-order bucket the composite's outer wrapper occupies (matching the
 * `readonly ngspiceLoadOrder` field on its AnalogElement subclass). Circuits
 * that mix composites with primitives in a single bucket are not currently
 * parity-tested against ngspice; primitives in fixtures (R, C, L, V, I, Q, M,
 * D, J) all have unambiguous entries here.
 */
export const TYPE_ID_TO_NGSPICE_LOAD_ORDER: Readonly<Record<string, number>> = {
  // Primitives
  Resistor:        NGSPICE_LOAD_ORDER.RES,
  Capacitor:       NGSPICE_LOAD_ORDER.CAP,
  PolarizedCap:    NGSPICE_LOAD_ORDER.CAP,
  Inductor:        NGSPICE_LOAD_ORDER.IND,
  Transformer:     NGSPICE_LOAD_ORDER.IND,
  TappedTransformer: NGSPICE_LOAD_ORDER.IND,
  TransmissionLine: NGSPICE_LOAD_ORDER.TRA,
  DcVoltageSource: NGSPICE_LOAD_ORDER.VSRC,
  AcVoltageSource: NGSPICE_LOAD_ORDER.VSRC,
  CurrentSource:   NGSPICE_LOAD_ORDER.ISRC,
  Diode:           NGSPICE_LOAD_ORDER.DIO,
  ZenerDiode:      NGSPICE_LOAD_ORDER.DIO,
  VaractorDiode:   NGSPICE_LOAD_ORDER.DIO,
  Schottky:        NGSPICE_LOAD_ORDER.DIO,
  NpnBJT:          NGSPICE_LOAD_ORDER.BJT,
  PnpBJT:          NGSPICE_LOAD_ORDER.BJT,
  NMOS:            NGSPICE_LOAD_ORDER.MOS,
  PMOS:            NGSPICE_LOAD_ORDER.MOS,
  NJFET:           NGSPICE_LOAD_ORDER.JFET,
  PJFET:           NGSPICE_LOAD_ORDER.JFET,
  // Behavioral / controlled sources
  VCCS:            NGSPICE_LOAD_ORDER.VCCS,
  VCVS:            NGSPICE_LOAD_ORDER.VCVS,
  CCCS:            NGSPICE_LOAD_ORDER.CCCS,
  CCVS:            NGSPICE_LOAD_ORDER.CCVS,
};

/**
 * Look up ngspice load order by typeId. Falls back to a high sentinel for
 * unknown / composite typeIds so they sort to the end of the deck walk used
 * for node numbering. Composite components in fixtures mix into their own
 * bucket via this fallback; ngspice-parity for composites is not currently
 * established.
 */
export function getNgspiceLoadOrderByTypeId(typeId: string): number {
  return TYPE_ID_TO_NGSPICE_LOAD_ORDER[typeId] ?? 1000;
}

/**
 * Per-`typeId` SPICE deck pin-emission order.
 *
 * Each entry lists the digiTS pin labels in the order their corresponding
 * node IDs appear on the element's SPICE deck line — i.e. the order ngspice's
 * parser visits each node name. This MUST match exactly what
 * `__tests__/harness/netlist-generator.ts` emits, because ngspice numbers MNA
 * nodes during deck PARSE (cktnewn.c via INPtermInsert from the per-type
 * `INP2*` parsers). Pin labels not listed here, or pin labels that the deck
 * line repeats (e.g. NMOS body pin tied to source), do not contribute new
 * node IDs and are omitted from the entry.
 *
 * Identity entries are listed explicitly rather than omitted so a
 * registry-startup audit can assert every analog typeId in `pinLayout` is
 * accounted for here.
 */
export const TYPE_ID_TO_DECK_PIN_LABEL_ORDER: Readonly<Record<string, readonly string[]>> = {
  // Two-terminal passives (deck: name n+ n- value) — pinLayout matches
  Resistor:        ["A", "B"],
  Capacitor:       ["pos", "neg"],
  PolarizedCap:    ["pos", "neg"],
  Inductor:        ["A", "B"],
  // Vname pos neg <spec>
  DcVoltageSource: ["pos", "neg"],
  AcVoltageSource: ["pos", "neg"],
  // Iname pos neg <spec>
  CurrentSource:   ["pos", "neg"],
  // D name A K model
  Diode:           ["A", "K"],
  ZenerDiode:      ["A", "K"],
  VaractorDiode:   ["A", "K"],
  Schottky:        ["A", "K"],
  // Q name C B E model
  NpnBJT:          ["C", "B", "E"],
  PnpBJT:          ["C", "B", "E"],
  // M name D G S B model — body tied to source by netlist-generator, so
  // numbering only sees three distinct nodes
  NMOS:            ["D", "G", "S"],
  PMOS:            ["D", "G", "S"],
  // J name D G S model
  NJFET:           ["D", "G", "S"],
  PJFET:           ["D", "G", "S"],
};

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
// AnalogElement
// ---------------------------------------------------------------------------

/**
 * The single contract every analog circuit element satisfies.
 *
 * Reactivity is method-presence: an element is "reactive" iff
 * `typeof el.getLteTimestep === "function"`. There are no boolean
 * device-class flags, no Core / non-Core split, no post-compile type
 * promotion. Pin topology is carried entirely by `_pinNodes`; allocation of
 * internal nodes / branch rows / state slots / TSTALLOC handles all happens
 * inside `setup(ctx)`, never at construction time.
 */
export interface AnalogElement {
  // -------------------------------------------------------------------------
  // Identity
  // -------------------------------------------------------------------------

  /**
   * Optional display label for diagnostic attribution. Initialized to "" by
   * every factory; overwritten by the compiler with the instance label via
   * Object.assign before setup() runs. Required (not optional) so setup-body
   * sites that read `this.label` / `el.label` type-check cleanly.
   */
  label: string;

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
   * order ngspice uses.
   *
   * Set this on every `make*` analog factory return value via the
   * `NGSPICE_LOAD_ORDER` enum in this file. Required, not defaulted —
   * forgetting it is a type error so new components surface the
   * "what device is this in ngspice terms?" question at registration.
   */
  readonly ngspiceLoadOrder: number;

  /**
   * Element index in the compiled circuit's element array.
   *
   * Set by the compiler after factory construction via Object.assign.
   * Used by elements when pushing LimitingEvent records so the harness
   * can correlate events back to specific circuit elements.
   */
  elementIndex?: number;

  // -------------------------------------------------------------------------
  // Topology
  // -------------------------------------------------------------------------

  /**
   * Pin-label-to-MNA-node map. The single source of truth for pin topology.
   * Populated by the factory at construction; treated as frozen thereafter.
   * `setup()` and `load()` bodies access pin nodes by label:
   *   `this._pinNodes.get("pos")!`
   * Insertion order matches the component's pinLayout order; iterate
   * `_pinNodes.values()` to get pinLayout-ordered node IDs.
   */
  _pinNodes: Map<string, number>;

  /**
   * Assigned branch-current row index for elements that introduce extra MNA
   * rows (voltage sources, inductors, etc.). -1 means "no branch row";
   * setup() / findBranchFor lazily allocate via ctx.makeCur and assign here.
   *
   * The "not-yet-allocated" sentinel is -1, not ngspice's 0. Compare with
   * `=== -1`, not `=== 0` or falsy checks — branch row 0 is a valid index
   * in our signed Float64Array layout.
   */
  branchIndex: number;

  /**
   * Index of this element's first state-pool slot, set during setup() via
   * `ctx.allocStates(N)`. -1 if the element has no state slots.
   */
  _stateBase: number;

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Allocate every internal node, branch row, state slot, and
   *  sparse-matrix entry this element will ever need, in the same
   *  order as the corresponding ngspice DEVsetup. Called once per
   *  MNAEngine._setup() invocation, before any load() call.
   *
   *  Implementations:
   *   - call ctx.makeVolt() for each internal node ngspice creates with
   *     CKTmkVolt;
   *   - call ctx.makeCur() for each branch row ngspice creates with
   *     CKTmkCur, storing the result in branchIndex (idempotent on -1);
   *   - call ctx.allocStates(N) where ngspice's *setup.c does
   *     `*states += N`;
   *   - call solver.allocElement(row, col) for every TSTALLOC line in
   *     line-for-line order, storing handles in closure-locals or
   *     `private` class fields (never on the returned object literal);
   *   - never call solver.allocElement from load().
   *
   *  Order of allocElement calls determines internal-index assignment.
   *  It MUST mirror the corresponding ngspice DEVsetup line-for-line —
   *  including stamps that ngspice allocates unconditionally even when
   *  their value will be zero in some operating mode.
   */
  setup(ctx: import("../solver/analog/setup-context.js").SetupContext): void;

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
  accept?(
    ctx: import("../solver/analog/load-context.js").LoadContext,
    simTime: number,
    addBreakpoint: (t: number) => void,
  ): void;

  /**
   * Called once per accepted timestep so the element can schedule its next
   * waveform edge as a timestep breakpoint. Mirrors ngspice's per-device
   * DEVaccept dispatch (vsrcacct.c VSRCaccept).
   *
   * `atBreakpoint` is the engine's CKTbreak flag: true when the just-accepted
   * step landed via a breakpoint clamp. ngspice gates every CKTsetBreak inside
   * VSRCaccept on this flag so non-boundary acceptances register nothing.
   * Sources that ignore this flag will register stale breakpoints on every
   * step, diverging from ngspice queue contents.
   */
  acceptStep?(
    simTime: number,
    addBreakpoint: (t: number) => void,
    atBreakpoint: boolean,
  ): void;

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
   * Method-presence on this method IS the reactivity discriminant. The engine's
   * timestep controller calls `getLteTimestep` only on elements that implement
   * it; the conditional guard form
   *   `if (typeof el.getLteTimestep === "function") ...`
   * is the sole reactivity gate.
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
    lteParams: import("../solver/analog/ckt-terr.js").LteParams,
  ): number;

  /**
   * Stamp the element's frequency-domain small-signal model for AC analysis.
   *
   * Receives the shared LoadContext (ngspice re-uses CKTcircuit in ACload()).
   * The MODEUIC bit is preserved across the AC-mode mask (acan.c:285) and
   * may be tested via `(ctx.cktMode & MODEUIC) !== 0`. Element sites that do
   * not need the context should simply ignore the third parameter.
   */
  stampAc?(
    solver: ComplexSparseSolver,
    omega: number,
    ctx: import("../solver/analog/load-context.js").LoadContext,
  ): void;

  /**
   * Return the strictly-next breakpoint strictly greater than afterTime, or
   * null if the source has no more breakpoints. Called once per accepted
   * step on which this source's breakpoint was consumed.
   */
  nextBreakpoint?(afterTime: number): number | null;

  // -------------------------------------------------------------------------
  // Engine queries
  // -------------------------------------------------------------------------

  /** Optional callback used by VSRC, VCVS, CCVS, IND, CRYSTAL, RELAY, and
   *  tapped-transformer winding elements that own branch rows. Called by the
   *  engine when a controlling source needs lazy branch-row allocation.
   *  Returns the branch row index (allocates if missing). The body uses the
   *  same idempotent makeCur as setup():
   *    if (el.branchIndex === -1) el.branchIndex = ctx.makeCur(...);
   *    return el.branchIndex;
   */
  findBranchFor?(
    name: string,
    ctx: import("../solver/analog/setup-context.js").SetupContext,
  ): number;

  /**
   * Compute per-pin currents for this element.
   *
   * Returns an array of currents in pinLayout order (same as
   * `_pinNodes.values()` insertion order), one per visible pin. Positive
   * means current flowing into the element. The array must satisfy KCL:
   * the sum of all entries is zero.
   */
  getPinCurrents(rhs: Float64Array): number[];

  /**
   * Update a mutable parameter on a live compiled element without
   * recompilation. Called by the coordinator for slider/property-panel
   * hot-patching. All compiled elements must implement this method.
   */
  setParam(key: string, value: number): void;

  /**
   * Diagnostic introspection. Returns labels for internal nodes allocated
   * during this element's setup(), in allocation order. Harness consumers
   * call this post-setup to label diagnostic nodes (e.g. `Q1:B'`). Optional
   * — elements that allocate no internal nodes do not implement it.
   */
  getInternalNodeLabels?(): readonly string[];
}

// ---------------------------------------------------------------------------
// PoolBackedAnalogElement
// ---------------------------------------------------------------------------

import type { StateSchema } from "../solver/analog/state-schema.js";

/**
 * AnalogElement extended with state-pool-backed fields. For components that
 * use the shared state pool — capacitors, diodes, BJTs, MOSFETs, JFETs,
 * transformers, behavioral composites, etc.
 */
export interface PoolBackedAnalogElement extends AnalogElement {
  readonly poolBacked: true;
  readonly stateSize: number;
  readonly stateSchema: StateSchema;
  initState(pool: StatePoolRef): void;

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
