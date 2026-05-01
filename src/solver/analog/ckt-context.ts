/**
 * CKTCircuitContext- the single god-object holding all pre-allocated buffers,
 * solver state, and compiled circuit references for the analog engine.
 *
 * Matches ngspice's `CKTcircuit *ckt`- the one struct every function receives.
 * Allocated once in MNAEngine.init(), mutated in place, never re-created.
 *
 * All buffers are allocated in the constructor. No buffer is allocated during
 * NR iteration, DC-OP, integration, or LTE hot paths.
 */

import { SparseSolver } from "./sparse-solver.js";
import type { AnalogElement } from "./element.js";
import { isPoolBacked } from "./element.js";
import { StatePool } from "./state-pool.js";
import { DiagnosticCollector } from "./diagnostics.js";
import type { ResolvedSimulationParams } from "../../core/analog-engine-interface.js";
import type { LimitingEvent } from "./newton-raphson.js";
import { NodeVoltageHistory } from "./integration.js";
export type { LoadContext } from "./load-context.js";
import type { LoadContext, ConvergenceEvent } from "./load-context.js";
import type { IntegrationMethod } from "../../core/analog-types.js";
import { MODEDCOP, MODEINITFLOAT } from "./ckt-mode.js";

// ---------------------------------------------------------------------------
// LoadCtxImpl- concrete LoadContext with live state-ring access
// ---------------------------------------------------------------------------

/**
 * Implementation of the LoadContext interface used at runtime.
 *
 * Holds a private reference to the backing StatePool. The state0..state3
 * properties are getters that resolve `_statePool.states[i]` on every access,
 * exactly mirroring ngspice's `#define CKTstate0 CKTstates[0]` macro
 * indirection (cktdefs.h:82-85). After StatePool.rotateStateVectors() swaps
 * the ring, the next read of `loadCtx.state0` returns the post-rotation
 * array without any explicit refresh step- there is no snapshot to
 * invalidate.
 *
 * Other LoadContext fields (cktMode, solver, rhs, dt, etc.) are plain
 * mutable fields. They are mutated in place by the engine each NR iteration
 * and have no ring rotation, so a snapshot would be correct- and is what
 * the engine writes to.
 */
export class LoadCtxImpl implements LoadContext {
  cktMode!: number;
  solver!: SparseSolver;
  matrix!: SparseSolver;
  rhs!: Float64Array;
  rhsOld!: Float64Array;
  time!: number;
  dt!: number;
  method!: IntegrationMethod;
  order!: number;
  deltaOld!: readonly number[];
  ag!: Float64Array;
  srcFact!: number;
  noncon!: { value: number };
  limitingCollector!: LimitingEvent[] | null;
  convergenceCollector!: ConvergenceEvent[] | null;
  xfact!: number;
  gmin!: number;
  reltol!: number;
  iabstol!: number;
  temp!: number;
  vt!: number;
  cktFixLimit!: boolean;
  bypass!: boolean;
  voltTol!: number;

  /**
   * Live ring reference. Identity is stable for the lifetime of the engine
   * (replaced once via `setStatePool` after deferred allocation in
   * CKTCircuitContext.allocateStateBuffers). Rotation in
   * StatePool.rotateStateVectors() permutes `_statePool.states[i]` in place
   *- the getters below see post-rotation arrays automatically.
   */
  private _statePool: StatePool;

  constructor(statePool: StatePool, init: Omit<LoadContext, "state0" | "state1" | "state2" | "state3">) {
    this._statePool = statePool;
    Object.assign(this, init);
  }

  /**
   * Late-bind the backing StatePool. Used once by
   * CKTCircuitContext.allocateStateBuffers after the real pool is sized
   * from the post-setup state count.
   */
  setStatePool(pool: StatePool): void {
    this._statePool = pool;
  }

  // cite cktdefs.h:82-85- `#define CKTstate0 CKTstates[0]` (macro, live).
  get state0(): Float64Array { return this._statePool.states[0]; }
  get state1(): Float64Array { return this._statePool.states[1]; }
  get state2(): Float64Array { return this._statePool.states[2]; }
  get state3(): Float64Array { return this._statePool.states[3]; }
}

// ---------------------------------------------------------------------------
// NRResult- mutable result class for Newton-Raphson iterations
// ---------------------------------------------------------------------------

/**
 * Mutable result for a Newton-Raphson solve.
 *
 * Written in place by newtonRaphson(ctx). Callers read fields directly.
 * Never re-allocated between solves- the same instance lives on ctx.nrResult
 * for the lifetime of the engine.
 */
export class NRResult {
  /** Whether the iteration converged within maxIterations. */
  converged: boolean = false;
  /** Number of iterations performed. */
  iterations: number = 0;
  /**
   * Final solution vector (node voltages + branch currents).
   * Points into ctx.rhs- no additional allocation.
   */
  voltages: Float64Array;
  /** Index of the element with the largest voltage change; -1 when unknown. */
  largestChangeElement: number = -1;
  /** Index of the node with the largest voltage change; -1 when unknown. */
  largestChangeNode: number = -1;

  constructor(rhs: Float64Array) {
    this.voltages = rhs;
  }

  /** Reset to default state before a new NR solve. */
  reset(): void {
    this.converged = false;
    this.iterations = 0;
    this.largestChangeElement = -1;
    this.largestChangeNode = -1;
  }
}

// ---------------------------------------------------------------------------
// DcOpResult- mutable result class for DC operating point
// ---------------------------------------------------------------------------

/**
 * Mutable result for a DC operating-point solve.
 *
 * Written in place by solveDcOperatingPoint(ctx). The voltages buffer is
 * a view into ctx.dcopVoltages- no additional allocation.
 */
export class DcOpResult {
  /** Whether the DC operating point converged. */
  converged: boolean = false;
  /** Which convergence method was used. */
  method: "direct" | "dynamic-gmin" | "spice3-gmin" | "gillespie-src" | "spice3-src" = "direct";
  /** Total NR iterations across all convergence levels. */
  iterations: number = 0;
  /**
   * Final node voltages after convergence.
   * Points into ctx.dcopVoltages- no additional allocation.
   */
  nodeVoltages: Float64Array;
  /** Diagnostic messages emitted during DC-OP. */
  diagnostics: import("../../compile/types.js").Diagnostic[] = [];

  constructor(nodeVoltages: Float64Array) {
    this.nodeVoltages = nodeVoltages;
  }

  /** Reset to default state before a new DC-OP solve. */
  reset(): void {
    this.converged = false;
    this.method = "direct";
    this.iterations = 0;
    this.diagnostics.length = 0;
  }
}

// ---------------------------------------------------------------------------
// CKTCircuitContext
// ---------------------------------------------------------------------------

/**
 * Input types needed to construct a CKTCircuitContext.
 * Matches what the analog compiler produces for a compiled analog circuit.
 */
export interface CKTCircuitInput {
  readonly nodeCount: number;
  readonly elements: readonly AnalogElement[];
  readonly statePool?: StatePool | null;
}

/**
 * CKTCircuitContext- god-object holding all pre-allocated simulation state.
 *
 * Matches ngspice CKTcircuit. Every hot-path function (newtonRaphson,
 * solveDcOperatingPoint, integration, LTE) takes a CKTCircuitContext and
 * reads/writes through it without allocating.
 *
 * Allocation strategy:
 *   - All Float64Array buffers allocated in constructor.
 *   - Pre-computed element lists built once in constructor.
 *   - NRResult and DcOpResult are mutable classes on ctx, not fresh object literals.
 */
export class CKTCircuitContext {
  // -------------------------------------------------------------------------
  // Matrix / solver
  // -------------------------------------------------------------------------

  /** Shared sparse solver- the same instance used for every NR factorization. */
  private _solver: SparseSolver = null!;

  /** Setting this also updates loadCtx.solver to the new instance. */
  get solver(): SparseSolver {
    return this._solver;
  }
  set solver(s: SparseSolver) {
    this._solver = s;
    if (this.loadCtx !== undefined) {
      this.loadCtx.solver = s;
      this.loadCtx.matrix = s;
    }
  };

  // -------------------------------------------------------------------------
  // Node voltages (ngspice CKTrhsOld, CKTrhs, CKTrhsSpare)
  // -------------------------------------------------------------------------

  /** Previous NR iteration voltages (ngspice CKTrhsOld). Length = matrixSize. */
  rhsOld: Float64Array;
  /** Current NR iteration voltages (ngspice CKTrhs). Length = matrixSize. */
  rhs: Float64Array;
  /** Spare voltage buffer for swap operations. Length = matrixSize. */
  rhsSpare: Float64Array;

  // -------------------------------------------------------------------------
  // Accepted solution (ngspice CKTrhsOld after acceptance)
  // -------------------------------------------------------------------------

  /** Accepted solution from previous timestep. Length = matrixSize. */
  acceptedVoltages: Float64Array;
  /** Accepted solution from the timestep before that. Length = matrixSize. */
  prevAcceptedVoltages: Float64Array;

  // -------------------------------------------------------------------------
  // DC-OP scratch buffers (ngspice OldRhsOld, OldCKTstate0)
  // -------------------------------------------------------------------------

  /** Working voltage buffer for DC-OP main solve. Length = matrixSize. */
  dcopVoltages: Float64Array;
  /** Saved voltage snapshot for DC-OP rollback. Length = matrixSize. */
  dcopSavedVoltages: Float64Array;
  /** Saved state0 snapshot for DC-OP rollback. Length = statePool.totalSlots or 1. */
  dcopSavedState0: Float64Array;
  /** Old state0 snapshot for nested DC-OP saves. Length = statePool.totalSlots or 1. */
  dcopOldState0: Float64Array;

  // -------------------------------------------------------------------------
  // Integration coefficients (ngspice CKTag[], CKTagp[], CKTsols[])
  // -------------------------------------------------------------------------

  /** Integration coefficients computed by computeNIcomCof (CKTag[]). Length 7. */
  ag: Float64Array;
  /** Predictor coefficients (CKTagp[]). Length 7. */
  agp: Float64Array;
  /** Per-node voltage history for NIpred predictor (CKTsols[]). */
  nodeVoltageHistory: NodeVoltageHistory;
  /**
   * Previous timestep history (ngspice CKTdeltaOld[7], cktdefs.h).
   *
   * Unified storage- the TimestepController references this SAME array by
   * identity (no duplicate buffer, no explicit copies). Elements read via
   * loadCtx.deltaOld / ctx.deltaOld inside load(); the timestep controller
   * writes via rotateDeltaOld()/setDeltaOldCurrent(). Guaranteed invariant:
   * `ctx.deltaOld === ctx.timestep._deltaOld` after the engine wires the
   * two together in MNAEngine.init().
   *
   * Seeded in the constructor to `params.maxTimeStep` across all 7 slots,
   * matching ngspice dctran.c:316-317 at transient init.
   */
  deltaOld: number[];

  // -------------------------------------------------------------------------
  // Gear scratch (flat 7×7 matrix for solveGearVandermonde)
  // -------------------------------------------------------------------------

  /** Flat 7×7 scratch buffer for Gear Vandermonde solve. Length 49. */
  gearMatScratch: Float64Array;

  // -------------------------------------------------------------------------
  // Results (mutable classes, not interfaces)
  // -------------------------------------------------------------------------

  /** Mutable NR result- written by newtonRaphson(ctx). */
  nrResult: NRResult;
  /** Mutable DC-OP result- written by solveDcOperatingPoint(ctx). */
  dcopResult: DcOpResult;

  // -------------------------------------------------------------------------
  // Load context (Phase 6 Wave 6.1 populates fields; Phase 1 allocates shell)
  // -------------------------------------------------------------------------

  /**
   * Per-iteration context passed to element.load() calls.
   * Typed as the concrete LoadCtxImpl so allocateStateBuffers can rebind
   * the live state-ring reference without a cast. Public consumers see it
   * through the LoadContext interface (LoadCtxImpl implements LoadContext).
   */
  loadCtx: LoadCtxImpl;

  // -------------------------------------------------------------------------
  // Assembler state
  // -------------------------------------------------------------------------

  /**
   * Non-convergence counter (ngspice CKTnoncon). Accessor through loadCtx.noncon
   * so there is exactly one storage location across the ckt / loadCtx boundary
   * (C3 fix- ngspice has a single CKTnoncon field on CKTcircuit).
   */
  get noncon(): number { return this.loadCtx.noncon.value; }
  set noncon(v: number) { this.loadCtx.noncon.value = v; }

  // -------------------------------------------------------------------------
  // Mode flags- single CKTmode bitfield (ngspice cktdefs.h:163-209)
  // -------------------------------------------------------------------------

  /**
   * ngspice CKTmode- single bitfield holding analysis bits (MODEDCOP,
   * MODETRAN, MODEAC, MODEUIC) and INITF bits (MODEINITJCT, MODEINITFIX,
   * MODEINITFLOAT, MODEINITTRAN, MODEINITPRED, MODEINITSMSIG). See
   * ./ckt-mode.ts for constants and helpers.
   *
   * `cktMode` is the single source of truth; LoadContext exposes
   * it to devices via `loadCtx.cktMode`.
   *
   * Defaults to MODEDCOP | MODEINITFLOAT- ngspice's post-reset analysis-
   * idle state.
   */
  cktMode: number = MODEDCOP | MODEINITFLOAT;

  /** Source stepping scale factor (ngspice srcFact). */
  srcFact: number = 1;
  /** True when nodesets are present (derived from nodesets.size > 0). */
  hadNodeset: boolean = false;

  // -------------------------------------------------------------------------
  // Circuit refs
  // -------------------------------------------------------------------------

  /** All analog elements in the circuit. */
  elements: readonly AnalogElement[];
  /** Number of non-ground MNA node rows. */
  nodeCount: number;
  /** Shared state pool for per-element state. Null until allocateStateBuffers() is called. */
  statePool: StatePool | null;
  /** Subset of elements that are pool-backed. Populated at construction. */
  readonly _poolBackedElements: readonly AnalogElement[];
  /** Pre-allocated nodeset matrix handles (node → solver handle). Populated in _setup(). */
  nodesetHandles: Map<number, number>;
  /** Pre-allocated IC matrix handles (node → solver handle). Populated in _setup(). */
  icHandles: Map<number, number>;

  // -------------------------------------------------------------------------
  // Pre-computed element lists (eliminate .filter() calls in hot paths)
  // -------------------------------------------------------------------------

  /** Elements that implement checkConvergence() for element-level convergence. */
  elementsWithConvergence: readonly AnalogElement[];

  // -------------------------------------------------------------------------
  // Tolerances
  // -------------------------------------------------------------------------

  /** Relative convergence tolerance (ngspice reltol). */
  reltol: number;
  /** Absolute voltage convergence tolerance in volts (ngspice voltTol). */
  abstol: number;
  /** Absolute voltage tolerance used for node rows (ngspice CKTvoltTol). */
  voltTol: number;
  /** Absolute current tolerance (ngspice CKTabstol). */
  iabstol: number;
  // cite: cktinit.c:53-55- CKTbypass default false
  /** Bypass gate flag (ngspice CKTbypass). When true, device load() may skip
   * recompute if voltage deltas are within tolerance. Default false. */
  bypass: boolean;
  /** Maximum NR iterations for DC-OP. */
  maxIterations: number;
  /** Maximum NR iterations per transient step (ngspice ITL4). */
  transientMaxIterations: number;
  /** Maximum NR iterations for gmin/source stepping sub-solves (ngspice ITL3). */
  dcTrcvMaxIter: number;

  // -------------------------------------------------------------------------
  // Damping
  // -------------------------------------------------------------------------

  /** Node damping factor (ngspice niiter.c). 0 = disabled, non-zero = enabled. */
  nodeDamping: number;
  /** Diagonal gmin conductance for stepping (ngspice CKTdiagGmin). */
  diagonalGmin: number;
  /**
   * Pivot absolute threshold (ngspice CKTpivotAbsTol). Forwarded into the
   * SparseSolver via setPivotTolerances before every factor() call, mirroring
   * niiter.c:863, 883 where SMPreorder/SMPluFac receive ckt->CKTpivotAbsTol.
   */
  pivotAbsTol: number;
  /**
   * Pivot relative threshold (ngspice CKTpivotRelTol). See pivotAbsTol.
   */
  pivotRelTol: number;

  // -------------------------------------------------------------------------
  // Nodesets / ICs
  // -------------------------------------------------------------------------

  /** Nodeset constraints: nodeId → target voltage. */
  nodesets: Map<number, number>;
  /** Initial condition constraints: nodeId → target voltage. */
  ics: Map<number, number>;

  // -------------------------------------------------------------------------
  // Instrumentation
  // -------------------------------------------------------------------------

  /** Diagnostic collector. Always non-null; default-constructed in the ctor. */
  diagnostics: DiagnosticCollector;
  /** When non-null, elements push LimitingEvent objects here during NR. */
  limitingCollector: LimitingEvent[] | null;
  /** When true, collect all failing element indices (not just first). */
  enableBlameTracking: boolean;
  /**
   * ngspice CKTtroubleNode mirror (cktload.c:64-65). The most recent
   * device-load that incremented noncon zeros this out. Owning consumers
   * (diagnostic emitters, convergence log) may populate it with the blamed
   * node id after the device loop to identify the element whose non-
   * convergence tripped the NR retry. Null when no blame has been assigned.
   */
  troubleNode: number | null;
  /**
   * Post-iteration hook for harness instrumentation.
   * Called after each NR iteration's convergence check.
   */
  postIterationHook: ((
    iteration: number,
    rhs: Float64Array,
    prevVoltages: Float64Array,
    noncon: number,
    globalConverged: boolean,
    elemConverged: boolean,
    limitingEvents: LimitingEvent[],
    convergenceFailedElements: string[],
    ctx: CKTCircuitContext,
  ) => void) | null;
  /**
   * Pre-factor hook for harness instrumentation. Mirrors ngspice's
   * `ni_instrument_cb` gate at niiter.c:704- fires AFTER cktLoad refreshes
   * stamps and BEFORE solver.preorder()/factor() overwrite the matrix with
   * LU values. The unique window where the assembled MNA holds post-load,
   * pre-LU values; harness consumers read it via solver.getCSCNonZeros().
   */
  preFactorHook: ((ctx: CKTCircuitContext) => void) | null;
  /** When true, checkAllConvergedDetailed is called instead of checkAllConverged. */
  detailedConvergence: boolean;

  // -------------------------------------------------------------------------
  // Bound closures (zero-alloc replacements for per-step arrow functions)
  // -------------------------------------------------------------------------

  /**
   * Bound version of timestep.addBreakpoint, stored once at init time.
   * Used in acceptStep loops to avoid creating a new closure per element per step.
   */
  addBreakpointBound: (t: number) => void;

  /**
   * Pre-iteration hook bound once at init time.
   * Called before each NR iteration to re-stamp reactive nonlinear companions.
   * Null when no hook is needed.
   */
  preIterationHook: ((iteration: number, iterVoltages: Float64Array, ctx: CKTCircuitContext) => void) | null;

  /**
   * Pre-allocated array for convergence-failed element labels.
   * Reset to length 0 at the start of each NR iteration check instead of
   * allocating a new string[] per iteration.
   */
  convergenceFailures: string[];

  // -------------------------------------------------------------------------
  // NR call-specific parameters (set by caller before each newtonRaphson call)
  // -------------------------------------------------------------------------

  /**
   * NR mode ladder for INITF transitions inside a single newtonRaphson call.
   * Fires on JCT→FIX and FIX→FLOAT (DC-OP), and on INITTRAN→FLOAT and
   * INITPRED→FLOAT (transient). Null during production runs; the harness
   * sets it to receive intra-NR-call mode boundaries as attempt boundaries,
   * matching the ngspice bridge's split-on-cktMode-change rule.
   */
  nrModeLadder: {
    onModeBegin(
      phase: "dcopInitJct" | "dcopInitFix" | "dcopInitFloat" | "tranInit" | "tranPredictor" | "tranNR",
      iteration: number,
    ): void;
    onModeEnd(
      phase: "dcopInitJct" | "dcopInitFix" | "dcopInitFloat" | "tranInit" | "tranPredictor" | "tranNR",
      iteration: number,
      converged: boolean,
    ): void;
  } | null;

  /**
   * When true, use maxIterations as-is without the ngspice floor of 100.
   * Required for INITJCT/INITFIX DC op phases that need exactly 1 iteration.
   */
  exactMaxIterations: boolean;

  /**
   * Hook fired once after iteration 0 completes (before iteration 1 begins).
   * Lets the harness observe the cold linearization as a distinct sub-attempt.
   */
  onIteration0Complete: (() => void) | null;

  // -------------------------------------------------------------------------
  // DC-OP phase callbacks (set by engine before solveDcOperatingPoint call)
  // -------------------------------------------------------------------------

  /**
   * Called before each NR solve attempt during the DC OP ladder.
   * Harness uses this to begin a new NRAttempt with correct phase annotation.
   */
  _onPhaseBegin: ((phase: string, phaseParameter?: number) => void) | null;

  /**
   * Called after each NR solve attempt during the DC OP ladder.
   * Harness uses this to finalize the NRAttempt with outcome.
   */
  _onPhaseEnd: ((outcome: string, converged: boolean) => void) | null;

  // -------------------------------------------------------------------------
  // Full simulation params reference (read by solveDcOperatingPoint)
  // -------------------------------------------------------------------------

  /**
   * The full resolved simulation parameters passed at construction time.
   * solveDcOperatingPoint reads gmin, gshunt, gminFactor, numGminSteps,
   * numSrcSteps from here rather than maintaining duplicate scalar fields.
   */
  params: ResolvedSimulationParams;

  // -------------------------------------------------------------------------
  // LTE scratch buffer
  // -------------------------------------------------------------------------

  /**
   * Scratch buffer for LTE computations in cktTerr/cktTerrVoltage.
   * Sized generously to accommodate Phase 3's formula corrections.
   * Length = max(matrixSize * 4, 64)- large enough for all intermediate vectors.
   */
  lteScratch: Float64Array;

  /**
   * Reusable scratch array returned by `cktncDump`. Stable identity across
   * calls- consumers must not retain references beyond the current call.
   * Populated by pushing pre-mutated pool entries from `_ncDumpPool`.
   */
  ncDumpScratch: { node: number; delta: number; tol: number }[];
  /**
   * Pool of pre-allocated mutable entry objects consumed by `cktncDump`.
   * Length = matrixSize. `cktncDump` mutates fields in place and pushes the
   * entry onto `ncDumpScratch`, so the failure path allocates nothing.
   */
  _ncDumpPool: { node: number; delta: number; tol: number }[];

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  /**
   * Construct and allocate all buffers for the given circuit.
   *
   * @param circuit  - The compiled analog circuit supplying element list and matrix size.
   * @param params   - Resolved simulation parameters supplying tolerances.
   * @param addBreakpoint - The timestep controller's addBreakpoint method, bound once here.
   * @param solver   - Shared sparse solver instance. The context and the owning
   *                   engine use the same instance; it is never re-allocated
   *                   post-construction.
   */
  constructor(
    circuit: CKTCircuitInput,
    params: ResolvedSimulationParams,
    addBreakpoint: (t: number) => void,
    solver: SparseSolver,
  ) {
    const { nodeCount, elements } = circuit;

    this.nodeCount = nodeCount;
    this.elements = elements;
    this.statePool = null;

    // Pre-computed element lists (zero-alloc invariant per spec phase-1).
    // Populated once at construction; mirrors ngspice's per-device-type
    // CKThead[] linked lists assembled at parse time, never rebuilt.
    this.elementsWithConvergence = elements.filter(el => el.checkConvergence !== undefined);
    this._poolBackedElements = elements.filter(isPoolBacked);

    // Nodeset / IC handles (populated by _allocateNodesetIcHandles in _setup())
    this.nodesetHandles = new Map();
    this.icHandles = new Map();

    // Matrix / solver- shared instance owned by the engine.
    // ngspice SMPnewMatrix → spCreate is called once at circuit setup.
    this.solver = solver;
    solver._initStructure();

    // Per-row buffers allocated with zero length at construction.
    // allocateRowBuffers(matrixSize) is called from MNAEngine._setup() after
    // setup() calls have run and solver._size is final (A5.1).
    this.rhsOld = new Float64Array(0);
    this.rhs = new Float64Array(0);
    this.rhsSpare = new Float64Array(0);
    this.acceptedVoltages = new Float64Array(0);
    this.prevAcceptedVoltages = new Float64Array(0);
    this.dcopVoltages = new Float64Array(0);
    this.dcopSavedVoltages = new Float64Array(0);
    this.dcopSavedState0 = new Float64Array(0);
    this.dcopOldState0 = new Float64Array(0);
    this.lteScratch = new Float64Array(64);
    this._ncDumpPool = [];

    // Integration
    this.ag = new Float64Array(7);
    this.agp = new Float64Array(7);
    // ngspice dctran.c:316-317: CKTdeltaOld[i] = CKTmaxStep for all 7 slots at
    // transient init. Seeded here so every CKTCircuitContext is born with
    // ngspice-faithful deltaOld contents, and the TimestepController wired in
    // MNAEngine.init() inherits them (shared-reference invariant).
    this.deltaOld = new Array<number>(7).fill(params.maxTimeStep);
    this.nodeVoltageHistory = new NodeVoltageHistory();

    // Gear scratch (7×7 flat)
    this.gearMatScratch = new Float64Array(49);

    // Results- point at zero-length rhs/dcopVoltages; re-pointed by allocateRowBuffers
    this.nrResult = new NRResult(this.rhs);
    this.dcopResult = new DcOpResult(this.dcopVoltages);

    // Load context- pre-allocated once, mutated in place each NR iteration
    const nonconRef = { value: 0 };
    // CKTtemp default (300.15 K = REFTEMP) matches ngspice CONSTreftemp.
    const ctxTemp = 300.15;
    // vt = k*T/q where k=1.380649e-23, q=1.602176634e-19
    const ctxVt = (1.380649e-23 * ctxTemp) / 1.602176634e-19;
    // LoadCtxImpl gets a placeholder empty StatePool here; the real pool is
    // bound in allocateStateBuffers via setStatePool(). The state0..state3
    // getters resolve through whichever pool is currently bound, so post-
    // rotation reads always see the live ring (cktdefs.h:82-85 macro
    // semantics). cite: cktinit.c:53-55- CKTbypass default false;
    // CKTvoltTol default 1e-6.
    this.loadCtx = new LoadCtxImpl(new StatePool(0), {
      cktMode: MODEDCOP | MODEINITFLOAT,
      solver: this._solver,
      matrix: this._solver,
      rhs: this.rhs,
      rhsOld: this.rhsOld,
      time: 0,
      dt: 0,
      method: "trapezoidal",
      order: 1,
      deltaOld: this.deltaOld,
      ag: this.ag,
      srcFact: 1,
      noncon: nonconRef,
      limitingCollector: null,
      convergenceCollector: null,
      xfact: 0,
      gmin: params.gmin ?? 1e-12,
      reltol: params.reltol,
      iabstol: params.abstol,
      temp: ctxTemp,
      vt: ctxVt,
      cktFixLimit: false,
      bypass: false,
      voltTol: 1e-6,
    });

    // Tolerances
    this.reltol = params.reltol;
    this.abstol = params.voltTol;
    this.voltTol = params.voltTol;
    this.iabstol = params.abstol;
    // cite: cktinit.c:53-55- CKTbypass default false
    this.bypass = false;
    this.maxIterations = params.maxIterations;
    this.transientMaxIterations = params.transientMaxIterations;
    this.dcTrcvMaxIter = params.dcTrcvMaxIter;

    // Damping
    this.nodeDamping = params.nodeDamping ? 1 : 0;
    this.diagonalGmin = params.diagGmin ?? 0;
    this.pivotAbsTol = params.pivotAbsTol ?? 0;
    this.pivotRelTol = params.pivotRelTol ?? 1e-3;

    // Nodesets / ICs (populated by engine after construction)
    this.nodesets = new Map();
    this.ics = new Map();

    // Instrumentation (defaults- engine sets these after construction)
    this.diagnostics = new DiagnosticCollector();
    this.limitingCollector = null;
    this.enableBlameTracking = false;
    this.troubleNode = null;
    this.postIterationHook = null;
    this.preFactorHook = null;
    this.detailedConvergence = false;

    // Bound closures
    this.addBreakpointBound = addBreakpoint;
    this.preIterationHook = null;
    this.convergenceFailures = [];

    // NR call-specific parameters (set by caller before each newtonRaphson call)
    this.nrModeLadder = null;
    this.exactMaxIterations = false;
    this.onIteration0Complete = null;

    // DC-OP phase callbacks (set by engine before solveDcOperatingPoint call)
    this._onPhaseBegin = null;
    this._onPhaseEnd = null;

    // Full params reference
    this.params = params;

    // Per-node non-convergence diagnostic scratch- rebuilt in allocateRowBuffers
    this.ncDumpScratch = [];
  }

  /**
   * Allocate all per-row buffers now that solver._size is known post-setup.
   *
   * Port of ngspice cktsetup.c:82-84 where memory for CKTrhs/CKTrhsOld is
   * allocated after the DEVsetup loop completes and the matrix size is final.
   * Called from MNAEngine._setup() after all element setup() calls have run.
   */
  allocateRowBuffers(matrixSize: number): void {
    const sizePlusOne = matrixSize + 1;
    this.rhsOld               = new Float64Array(sizePlusOne);
    this.rhs                  = new Float64Array(sizePlusOne);
    this.rhsSpare             = new Float64Array(sizePlusOne);
    this.acceptedVoltages     = new Float64Array(sizePlusOne);
    this.prevAcceptedVoltages = new Float64Array(sizePlusOne);
    this.dcopVoltages         = new Float64Array(sizePlusOne);
    this.dcopSavedVoltages    = new Float64Array(sizePlusOne);
    this.lteScratch           = new Float64Array(Math.max(matrixSize * 4, 64));
    this._ncDumpPool = new Array(matrixSize);
    for (let i = 0; i < matrixSize; i++) {
      this._ncDumpPool[i] = { node: 0, delta: 0, tol: 0 };
    }
    this.nrResult.voltages         = this.rhs;
    this.dcopResult.nodeVoltages   = this.dcopVoltages;
    this.loadCtx.rhs               = this.rhs;
    this.loadCtx.rhsOld            = this.rhsOld;
    this.nodeVoltageHistory.initNodeVoltages(sizePlusOne);
  }

  /**
   * Construct the shared state pool after all element setup() calls have run.
   *
   * Port of ngspice cktsetup.c:82-84 where CKTstate0/CKTstate1 are allocated
   * after the DEVsetup loop, so state counts from all elements are known.
   * Called from MNAEngine._setup() before allocateRowBuffers().
   *
   * If `existingPool` is provided and matches numStates, it is adopted as the
   * authoritative pool- single-ownership invariant: cac.statePool and
   * ctx.statePool always reference the same object. Otherwise a fresh pool is
   * allocated.
   */
  allocateStateBuffers(numStates: number, existingPool: StatePool | null = null): void {
    this.statePool = (existingPool && existingPool.totalSlots === numStates)
      ? existingPool
      : new StatePool(numStates);
    this.dcopSavedState0       = new Float64Array(numStates);
    this.dcopOldState0         = new Float64Array(numStates);
    // Bind the live ring reference. From this call onward, ctx.loadCtx.stateN
    // resolves to this.statePool.states[N] on every access- no snapshot,
    // matches ngspice CKTstateN macro semantics (cktdefs.h:82-85).
    this.loadCtx.setStatePool(this.statePool);
    for (const el of this._poolBackedElements) {
      if (isPoolBacked(el)) {
        el.initState(this.statePool);
      }
    }
  }

  /**
   * Refresh tolerance fields and loadCtx scalars from a new set of resolved
   * simulation parameters. Used by MNAEngine.configure() to hot-load tolerances
   * after the constructor has captured them by value. Mirrors the tolerance
   * block of the constructor; does NOT reallocate any buffers.
   */
  refreshTolerances(params: ResolvedSimulationParams): void {
    // Tolerances (matches constructor order/semantics above).
    this.reltol = params.reltol;
    this.abstol = params.voltTol;
    this.voltTol = params.voltTol;
    this.iabstol = params.abstol;
    this.maxIterations = params.maxIterations;
    this.transientMaxIterations = params.transientMaxIterations;
    this.dcTrcvMaxIter = params.dcTrcvMaxIter;

    // Damping
    this.nodeDamping = params.nodeDamping ? 1 : 0;
    this.diagonalGmin = params.diagGmin ?? 0;
    this.pivotAbsTol = params.pivotAbsTol ?? 0;
    this.pivotRelTol = params.pivotRelTol ?? 1e-3;

    // Load-context scalars derived from params
    this.loadCtx.reltol = params.reltol;
    this.loadCtx.iabstol = params.abstol;
    this.loadCtx.gmin = params.gmin ?? 1e-12;

    // Keep the full params reference in sync so downstream readers
    // (e.g. solveDcOperatingPoint) see the new values.
    this.params = params;
  }

  /**
   * Update hadNodeset after nodesets Map is populated.
   * Called by MNAEngine after setting ctx.nodesets.
   */
  updateHadNodeset(): void {
    this.hadNodeset = this.nodesets.size > 0;
  }

  /**
   * Atomically swap the rhs / rhsOld buffer pointers, mirroring ngspice
   * niiter.c:1087-1090:
   *
   *   temp = ckt->CKTrhsOld;
   *   ckt->CKTrhsOld = ckt->CKTrhs;
   *   ckt->CKTrhs = temp;
   *
   * All aliases that cache these references (loadCtx.rhs/rhsOld, nrResult.voltages)
   * are re-pointed in the same call so devices, the post-iter hook, and
   * downstream consumers always see a consistent (rhs, rhsOld) pair.
   */
  swapRhsBuffers(): void {
    const tmp = this.rhsOld;
    this.rhsOld = this.rhs;
    this.rhs = tmp;
    this.loadCtx.rhsOld = this.rhsOld;
    this.loadCtx.rhs = this.rhs;
    this.nrResult.voltages = this.rhs;
  }
}
