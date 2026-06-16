/**
 * Analog element abstract base classes.
 *
 * `AnalogElement` is the nominal abstract base every analog circuit element
 * extends. `PoolBackedAnalogElement` extends it for elements that store
 * decoupled state in the shared `StatePool`.
 *
 * **Reactivity discriminant**: an element is reactive iff
 *   `typeof el.getLteTimestep === "function"`.
 * There is no boolean device-class flag and no post-compile type promotion.
 *
 * **`pinNodes` store-by-reference invariant**: the constructor stores the
 * incoming `Map` by reference without copying. The composite compiler captures
 * that exact `Map` ref in a `patchWork` entry and writes resolved internal-net
 * IDs back through it between the allocator leaf's `setup()` and this
 * element's `setup()`. A defensive `new Map(pinNodes)` copy severs that write
 * path, causing NR to diverge. This was the transmission-line 6-hour-hang
 * root cause (see §4c/§4e fix-list entry).
 *
 * **Subclass contract**:
 *   - declare `readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.<DEV>;`
 *   - call `super(pinNodes)` first in the constructor
 *   - implement `setup`, `load`, `getPinCurrents`, `setParam`
 *   - do NOT redeclare `label`, `pinNodes`, `_stateBase`, `branchIndex`
 *   - do NOT override the `pinNodes` getter
 */

import type { IntegrationMethod } from "./integration.js";
import type { StatePoolRef } from "./state-pool.js";
import type { StateSchema } from "./state-schema.js";
import type { SparseSolverStamp } from "./sparse-solver.js";
import type { LteParams } from "./ckt-terr.js";
import type { LoadContext } from "./load-context.js";
import type { SetupContext } from "./setup-context.js";
import type { Diagnostic } from "../../compile/types.js";
import type { DeviceFamily } from "./ngspice-load-order.js";
import type { TempContext } from "./temp-context.js";

// ---------------------------------------------------------------------------
// AnalogElement
// ---------------------------------------------------------------------------

export abstract class AnalogElement {
  /** Nominal brand — prevents structural duck-typing from satisfying this class. */
  protected readonly __analogElementBrand!: never;

  /** Position in ngspice's CKTload iteration order (see `ngspice-load-order.ts`). */
  abstract readonly ngspiceLoadOrder: number;

  /** Device family bucket for per-type orchestration (see `ngspice-load-order.ts`). */
  abstract readonly deviceFamily: DeviceFamily;

  /** Display label for diagnostic attribution; overwritten by compiler before setup(). */
  label = "";

  readonly #pinNodes: Map<string, number>;

  /** Index of this element's first state-pool slot; -1 if no state slots. */
  _stateBase = -1;

  /**
   * Branch-current row index for elements that introduce extra MNA rows.
   * -1 = not yet allocated. Compare with `=== -1`, not falsy — row 0 is valid.
   */
  branchIndex = -1;

  /** Element index in the compiled circuit's element array; set by compiler. */
  elementIndex?: number;

  constructor(pinNodes: ReadonlyMap<string, number>) {
    // Store by reference — see class docstring for the load-bearing rationale.
    this.#pinNodes = pinNodes as Map<string, number>;
  }

  /** `ReadonlyMap` view of the pin-label-to-MNA-node map; backed by ES private `#pinNodes`. */
  get pinNodes(): ReadonlyMap<string, number> {
    return this.#pinNodes;
  }

  /** Allocate internal nodes, branch rows, state slots, and sparse-matrix entries.
   *  Called once per MNAEngine._setup(), before any load(). Mirror ngspice DEVsetup
   *  line-for-line including unconditional allocElement calls. */
  abstract setup(ctx: SetupContext): void;

  /** Primary hot-path: read terminal voltages, evaluate device equations, stamp
   *  conductance and RHS. Matches ngspice DEVload. Called every NR iteration. */
  abstract load(ctx: LoadContext): void;

  /** Compute per-pin currents in pinLayout order. Sum must be zero (KCL). */
  abstract getPinCurrents(rhs: Float64Array): number[];

  /** Update a mutable parameter on a live element without recompilation. */
  abstract setParam(key: string, value: number): void;

  /** Called once per accepted timestep to register the next waveform edge as a breakpoint.
   *  Gate on `atBreakpoint` (CKTbreak) to avoid stale registrations.
   *
   *  `addBreakpoint` registers a permanent breakpoint (CKTsetBreak) for a known
   *  future edge time. `setTempBreakpoint` registers an XSPICE-style temporary
   *  breakpoint (cm_analog_set_temp_bkpt) that lives only for the next step- event
   *  devices re-post it each step while their transition is pending (square
   *  cfunc.mod), so the engine clears it before every acceptStep dispatch. */
  acceptStep?(
    simTime: number,
    addBreakpoint: (t: number) => void,
    atBreakpoint: boolean,
    setTempBreakpoint: (t: number) => void,
  ): void;

  /** Element-specific convergence check. Return true = converged; false = keep iterating. */
  checkConvergence?(ctx: LoadContext): boolean;

  /** ngspice DEVsetic / CKTic (cktic.c:43-49): under UIC, derive any un-given
   *  device initial condition from the seeded rhs node voltages. The engine
   *  calls this once after IC/nodeset rhs seeding and before the transient-boot
   *  DCOP, mirroring ngspice's per-device *getic.c. Only devices ngspice gives a
   *  DEVsetic (cap, dio, bjt, …) implement it; devices without one (ind, jfet,
   *  mos) use their hardcoded default and must NOT define this. Method-presence
   *  opt-in. */
  getInitialConditions?(rhs: Float64Array): void;

  /**
   * CKTterr-based LTE timestep proposal. Method-presence IS the reactivity
   * discriminant: `typeof el.getLteTimestep === "function"` is the sole gate.
   */
  getLteTimestep?(
    dt: number,
    deltaOld: readonly number[],
    order: number,
    method: IntegrationMethod,
    lteParams: LteParams,
  ): number;

  /** Stamp frequency-domain small-signal model for AC analysis. Matches ngspice ACload.
   *  `rhsRe` / `rhsIm` are 1-based (slot 0 = ground sentinel), parallel to ngspice's
   *  CKTrhs / CKTirhs (vsrcacld.c:179-180, isrcacld.c:43-50). V and I sources
   *  stamp their `AC <mag> [<phase>]` contributions directly into these arrays
   *  during `stampAc`; passive devices leave them alone. */
  stampAc?(
    solver: SparseSolverStamp,
    omega: number,
    ctx: LoadContext,
    rhsRe: Float64Array,
    rhsIm: Float64Array,
  ): void;

  /** Return the next breakpoint strictly after `afterTime`, or null if exhausted. */
  nextBreakpoint?(afterTime: number): number | null;

  /** Lazy branch-row allocation for controlling-source lookups (VSRC, IND, etc.). */
  findBranchFor?(name: string, ctx: SetupContext): number;

  /** Labels for internal nodes allocated in setup(), in allocation order. */
  getInternalNodeLabels?(): readonly string[];

  /** Per-temperature-sweep callback. Concrete subclasses opt in. */
  computeTemperature?(ctx: TempContext): void;

  /** Flux initialisation pass for inductive elements. Consumed by IND_FAMILY. */
  loadFluxInit?(ctx: LoadContext): void;
}

// ---------------------------------------------------------------------------
// PoolBackedAnalogElement
// ---------------------------------------------------------------------------

/**
 * Abstract base for pool-backed analog elements. Centralises the `poolBacked`
 * flag, the `_pool` ref slot, and the trivial `initState` body.
 *
 * Subclass contract: declare `readonly stateSchema` and `readonly stateSize`,
 * call `super(pinNodes)` first, access the pool via `this._pool`. Do NOT
 * redeclare `_pool` or override `initState` unless genuinely extending pool wiring.
 */
export abstract class PoolBackedAnalogElement extends AnalogElement {
  readonly poolBacked = true as const;
  abstract readonly stateSchema: StateSchema;
  abstract readonly stateSize: number;

  protected _pool!: StatePoolRef;

  initState(pool: StatePoolRef): void {
    if (this.stateSize !== this.stateSchema.size) {
      throw new Error(
        `PoolBackedAnalogElement ${this.label || "?"} (${this.stateSchema.owner}): ` +
        `stateSize=${this.stateSize} drifted from stateSchema.size=${this.stateSchema.size}. ` +
        `These must match; declare 'readonly stateSize = <SCHEMA>.size'.`,
      );
    }
    this._pool = pool;
  }
}

// ---------------------------------------------------------------------------
// isPoolBacked — runtime type-guard
// ---------------------------------------------------------------------------

/** Runtime type-guard discriminating pool-backed elements from leaf AnalogElements. */
export function isPoolBacked(el: AnalogElement): el is PoolBackedAnalogElement {
  return (el as Partial<PoolBackedAnalogElement>).poolBacked === true;
}

// ---------------------------------------------------------------------------
// RuntimeDiagnosticAware
// ---------------------------------------------------------------------------

/**
 * Optional capability for elements that emit runtime diagnostics during
 * load() / acceptStep(). Wired by MNAEngine.init() after the DiagnosticCollector
 * is constructed. Method-presence opt-in via `setDiagnosticEmitter`.
 */
export interface RuntimeDiagnosticAware {
  setDiagnosticEmitter(emit: (diag: Diagnostic) => void): void;
}

/** Runtime type-guard for elements that opt into runtime-diagnostic wiring. */
export function isRuntimeDiagnosticAware(el: AnalogElement): el is AnalogElement & RuntimeDiagnosticAware {
  return typeof (el as Partial<RuntimeDiagnosticAware>).setDiagnosticEmitter === "function";
}
