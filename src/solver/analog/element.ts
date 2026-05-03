/**
 * Analog element interfaces.
 *
 * `AnalogElement` is the single contract every analog circuit element
 * satisfies. `PoolBackedAnalogElement` extends it for elements that store
 * decoupled state in the shared `StatePool`.
 *
 * Reactivity is method-presence: an element is "reactive" iff
 *   typeof el.getLteTimestep === "function"
 * There is no Core / non-Core split, no boolean device-class flags, and no
 * post-compile type promotion.
 */

import type { IntegrationMethod } from "./integration.js";
import type { StatePoolRef } from "./state-pool.js";
import type { StateSchema } from "./state-schema.js";
import type { ComplexSparseSolverStamp } from "./complex-sparse-solver.js";
import type { LteParams } from "./ckt-terr.js";
import type { LoadContext } from "./load-context.js";
import type { SetupContext } from "./setup-context.js";
import type { Diagnostic } from "../../compile/types.js";

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
   * determines internal numbering- and the only way to match ngspice's
   * internal layout bit-exact is to load devices in the same per-type bucket
   * order ngspice uses.
   *
   * Set this on every `make*` analog factory return value via the
   * `NGSPICE_LOAD_ORDER` enum in `ngspice-load-order.ts`. Required, not
   * defaulted- forgetting it is a type error so new components surface the
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
   * `=== -1`, not `=== 0` or falsy checks- branch row 0 is a valid index
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
   *  It MUST mirror the corresponding ngspice DEVsetup line-for-line-
   *  including stamps that ngspice allocates unconditionally even when
   *  their value will be zero in some operating mode.
   */
  setup(ctx: SetupContext): void;

  /**
   * Primary hot-path method. Called every NR iteration.
   *
   * Reads terminal voltages from ctx.rhsOld, evaluates device equations,
   * and stamps conductance and RHS contributions into ctx.solver. For reactive
   * elements, also integrates charge/flux inline using ctx.ag[]. Matches
   * ngspice DEVload.
   */
  load(ctx: LoadContext): void;

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
  checkConvergence?(ctx: LoadContext): boolean;

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
    lteParams: LteParams,
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
    solver: ComplexSparseSolverStamp,
    omega: number,
    ctx: LoadContext,
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
  findBranchFor?(name: string, ctx: SetupContext): number;

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
   *- elements that allocate no internal nodes do not implement it.
   */
  getInternalNodeLabels?(): readonly string[];
}

// ---------------------------------------------------------------------------
// AbstractAnalogElement - shared base class for class-based implementations
// ---------------------------------------------------------------------------

/**
 * Optional abstract base class that centralises the boilerplate every
 * class-based AnalogElement needs:
 *
 *   - the four identity / topology fields (`label`, `_pinNodes`,
 *     `_stateBase`, `branchIndex`) with their canonical defaults,
 *   - a single, audited assignment of `_pinNodes` from the constructor
 *     argument that does NOT defensive-copy.
 *
 * The "do not defensive-copy" rule is load-bearing. The composite
 * compiler builds one mutable `pinNodes: Map<string, number>` per child
 * sub-element and pushes a `patchWork` entry that points at that exact
 * Map. Between the allocator leaf's `setup()` (which calls
 * `ctx.makeVolt(...)` to allocate internal-net node IDs) and this
 * element's `setup()`, the patcher leaf walks `patchWork` and writes the
 * resolved IDs back into the Map. If a leaf constructor freezes a copy
 * via `this._pinNodes = new Map(pinNodes)`, the patcher's writes never
 * reach the leaf — the leaf's `setup()` reads `pos`/`neg` as `-1`,
 * `solver.allocElement(-1, b)` returns garbage handles, `rhsOld[b]` is
 * `undefined` past the matrix bound, `L * undefined === NaN` lands in
 * the state pool, and NR loops forever (the `noncon` check passes NaN
 * deltas as "not yet converged"). This was the transmission-line
 * 6-hour-hang root cause; see the §4c/§4e fix-list entry for full
 * narrative.
 *
 * Standalone-element callers (registry factory path, single CircuitElement
 * placed by the user) pass an already-resolved Map, so storing by
 * reference is identical-behaviour to the old defensive copy for them.
 *
 * Inline AnalogElement object literals (the allocator, patcher, and
 * SubcircuitWrapperElement no-op leaves built inside `compiler.ts`) do
 * not extend this class — they remain plain object literals satisfying
 * the structural `AnalogElement` interface. Inheritance is opt-in.
 *
 * Subclass contract:
 *   - declare `readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.<DEV>;`
 *   - call `super(pinNodes)` first thing in the constructor,
 *   - implement `setup`, `load`, `getPinCurrents`, `setParam`,
 *   - do NOT redeclare `label`, `_pinNodes`, `_stateBase`, `branchIndex`
 *     (the base owns them; redeclaration shadows the base field and
 *     re-introduces the defensive-copy footgun this class exists to
 *     prevent).
 */
export abstract class AbstractAnalogElement implements AnalogElement {
  abstract readonly ngspiceLoadOrder: number;

  label = "";
  _pinNodes: Map<string, number>;
  _stateBase = -1;
  branchIndex = -1;
  elementIndex?: number;

  constructor(pinNodes: ReadonlyMap<string, number>) {
    // Store by reference — see class docstring for the load-bearing
    // rationale. The compiler always passes a mutable `Map<string, number>`;
    // the `ReadonlyMap` parameter type is the structural-typing convention
    // shared with object-literal AnalogElement implementers.
    this._pinNodes = pinNodes as Map<string, number>;
  }

  abstract setup(ctx: SetupContext): void;
  abstract load(ctx: LoadContext): void;
  abstract getPinCurrents(rhs: Float64Array): number[];
  abstract setParam(key: string, value: number): void;
}

// ---------------------------------------------------------------------------
// PoolBackedAnalogElement
// ---------------------------------------------------------------------------

/**
 * AnalogElement extended with state-pool-backed fields. For components that
 * use the shared state pool- capacitors, diodes, BJTs, MOSFETs, JFETs,
 * transformers, behavioral composites, etc.
 */
export interface PoolBackedAnalogElement extends AnalogElement {
  readonly poolBacked: true;
  readonly stateSize: number;
  readonly stateSchema: StateSchema;
  initState(pool: StatePoolRef): void;
}

// ---------------------------------------------------------------------------
// AbstractPoolBackedAnalogElement - base for pool-backed class implementations
// ---------------------------------------------------------------------------

/**
 * Optional abstract base for pool-backed leaves. Centralises the
 * `poolBacked` flag, the `_pool` ref slot, and the trivial `initState`
 * body that every pool-backed leaf otherwise duplicates verbatim.
 *
 * Subclass contract: declare `readonly stateSchema` and `readonly
 * stateSize` (eager `SCHEMA.size` keeps the existing semantics), call
 * `super(pinNodes)` first thing, and access the pool via `this._pool`.
 * Do NOT redeclare `_pool` or override `initState` unless you genuinely
 * need to extend pool wiring.
 */
export abstract class AbstractPoolBackedAnalogElement
  extends AbstractAnalogElement
  implements PoolBackedAnalogElement
{
  readonly poolBacked = true as const;
  abstract readonly stateSchema: StateSchema;
  abstract readonly stateSize: number;

  protected _pool!: StatePoolRef;

  initState(pool: StatePoolRef): void {
    this._pool = pool;
  }
}

// ---------------------------------------------------------------------------
// isPoolBacked- runtime type-guard
// ---------------------------------------------------------------------------

/**
 * Runtime type-guard discriminating pool-backed elements from leaf
 * AnalogElements. The single `poolBacked: true` literal is the only flag
 * that survives the cleanup.
 */
export function isPoolBacked(el: AnalogElement): el is PoolBackedAnalogElement {
  return (el as Partial<PoolBackedAnalogElement>).poolBacked === true;
}

// ---------------------------------------------------------------------------
// RuntimeDiagnosticAware
// ---------------------------------------------------------------------------

/**
 * Optional capability for elements that emit runtime diagnostics
 * (`fuse-blown`, `reverse-biased-cap`, etc.) during load() / acceptStep().
 *
 * Wired by `MNAEngine.init()`: after the engine's DiagnosticCollector is
 * constructed, the engine walks the element list and installs an emit
 * callback on every element implementing this interface. The callback
 * forwards into the engine collector, which the coordinator surfaces via
 * `getRuntimeDiagnostics()`.
 *
 * Method-presence opt-in: an element opts in by exposing
 * `setDiagnosticEmitter`. Elements that emit no runtime diagnostics omit
 * the method and are skipped by the engine wiring loop.
 */
export interface RuntimeDiagnosticAware {
  setDiagnosticEmitter(emit: (diag: Diagnostic) => void): void;
}

/** Runtime type-guard for elements that opt into runtime-diagnostic wiring. */
export function isRuntimeDiagnosticAware(el: AnalogElement): el is AnalogElement & RuntimeDiagnosticAware {
  return typeof (el as Partial<RuntimeDiagnosticAware>).setDiagnosticEmitter === "function";
}
