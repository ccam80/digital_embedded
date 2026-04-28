import { SparseSolver } from "../sparse-solver.js";
import type { AnalogElement, PoolBackedAnalogElement } from "../element.js";
import { isPoolBacked } from "../element.js";
import type { LoadContext } from "../load-context.js";
import { MODETRAN, MODEINITFLOAT } from "../ckt-mode.js";
import type { IntegrationMethod } from "../../../core/analog-types.js";
import { newtonRaphson } from "../newton-raphson.js";
import { StatePool } from "../state-pool.js";
import { CKTCircuitContext, LoadCtxImpl, type DcOpResult, type NRResult } from "../ckt-context.js";
import { solveDcOperatingPoint } from "../dc-operating-point.js";
import { DiagnosticCollector } from "../diagnostics.js";
import { DEFAULT_SIMULATION_PARAMS, type ResolvedSimulationParams } from "../../../core/analog-engine-interface.js";
import type { SetupContext } from "../setup-context.js";

// ---------------------------------------------------------------------------
// makeTestSetupContext — produce a SetupContext driving the four allocation
// streams (internal nodes, branch rows, state slots, peer lookup) deterministically.
// ---------------------------------------------------------------------------

/**
 * Build a `SetupContext` for use by `setupAll` in unit tests. The four
 * allocation streams behave as follows:
 *
 *   - `makeVolt(label, suffix)` — returns sequential ids starting at
 *     `opts.startNode`, incrementing per call. THROWS if `startNode` is
 *     unset and any element calls `makeVolt`. The throw is intentional —
 *     tests whose elements allocate internal nodes must declare their
 *     starting node id rather than silently defaulting to 0 and propagating
 *     off-by-one errors.
 *
 *   - `makeCur(label, suffix)` — same shape as `makeVolt` but for branch
 *     row indices, gated on `opts.startBranch`. Same throw semantics.
 *
 *   - `allocStates(n)` — sequential, always available; counter starts at 0.
 *
 *   - `findBranch(label)` / `findDevice(label)` — resolve against
 *     `opts.elements` by `el.label` match. `findBranch` dispatches to the
 *     element's `findBranchFor(label, ctx)` if present; otherwise returns
 *     the element's existing `branchIndex` or 0. Mirrors the engine-side
 *     `_findBranch` composition (per spec A.6).
 */
export function makeTestSetupContext(opts: {
  solver: SparseSolver;
  /** First branch-row id; required if any element calls `ctx.makeCur`. */
  startBranch?: number;
  /** First internal-node id; required if any element calls `ctx.makeVolt`. */
  startNode?: number;
  /** Operating temperature in Kelvin. Default 300.15. */
  temp?: number;
  /** Nominal model temperature in Kelvin. Default 300.15. */
  nomTemp?: number;
  /** ngspice CKTcopyNodesets. Default false. */
  copyNodesets?: boolean;
  /** Elements registered for `findDevice` / `findBranch` dispatch. */
  elements?: AnalogElement[];
}): SetupContext {
  const elements = opts.elements ?? [];
  let nextBranch = opts.startBranch ?? -1;
  let nextNode = opts.startNode ?? -1;
  let stateCounter = 0;

  const ctx: SetupContext = {
    solver: opts.solver,
    temp: opts.temp ?? 300.15,
    nomTemp: opts.nomTemp ?? 300.15,
    copyNodesets: opts.copyNodesets ?? false,

    makeVolt(_label: string, _suffix: string): number {
      if (nextNode < 0) {
        throw new Error(
          "makeTestSetupContext: makeVolt() called but startNode is unset. " +
          "Pass startNode in opts so internal-node allocation has a deterministic origin.",
        );
      }
      return nextNode++;
    },
    makeCur(_label: string, _suffix: string): number {
      if (nextBranch < 0) {
        throw new Error(
          "makeTestSetupContext: makeCur() called but startBranch is unset. " +
          "Pass startBranch in opts so branch-row allocation has a deterministic origin.",
        );
      }
      return nextBranch++;
    },
    allocStates(slotCount: number): number {
      const off = stateCounter;
      stateCounter += slotCount;
      return off;
    },
    findBranch(label: string): number {
      const el = elements.find((e) => e.label === label);
      if (!el) return 0;
      if (typeof el.findBranchFor === "function") {
        return el.findBranchFor(label, ctx);
      }
      return el.branchIndex !== -1 ? el.branchIndex : 0;
    },
    findDevice(label: string): AnalogElement | null {
      return elements.find((e) => e.label === label) ?? null;
    },
  };

  return ctx;
}

// ---------------------------------------------------------------------------
// setupAll — sort elements by ngspiceLoadOrder, call setup() on each.
// ---------------------------------------------------------------------------

/**
 * Sort `elements` by `ngspiceLoadOrder` ascending and invoke `setup(ctx)`
 * on each. Mirrors the per-type bucket order ngspice uses (every R, then
 * every C, ..., then every V, ...) — see `core/analog-types.ts` /
 * NGSPICE_LOAD_ORDER for the rationale.
 *
 * No opt-out: tests that need to inject element-private state must do so
 * by reaching into element fields *after* this call, never by skipping it.
 */
export function setupAll(elements: AnalogElement[], ctx: SetupContext): void {
  const sorted = [...elements].sort(
    (a, b) => a.ngspiceLoadOrder - b.ngspiceLoadOrder,
  );
  for (const el of sorted) el.setup(ctx);
}

// ---------------------------------------------------------------------------
// allocateStatePool — assign _stateBase sequentially and build a sized pool
// ---------------------------------------------------------------------------

/**
 * Assign `_stateBase` sequentially to every pool-backed element, construct
 * a `StatePool` sized to the total slot count, and invoke each element's
 * `initState` hook so closure-captured pool refs and slot bases are
 * populated.
 *
 * Tests that build `ConcreteCompiledAnalogCircuit` directly (bypassing the
 * real compiler) must call this before `engine.init()` — otherwise pool-
 * backed elements arrive with `_stateBase=-1` and the engine's allocation
 * assertion throws.
 *
 * Mirrors the allocation loop in `src/compile/compiler.ts` that the real
 * compiler runs when building a production `CompiledAnalogCircuit`.
 */
export function allocateStatePool(
  elements: readonly AnalogElement[],
): StatePool {
  let offset = 0;
  for (const el of elements) {
    if (isPoolBacked(el)) {
      (el as PoolBackedAnalogElement & { _stateBase: number })._stateBase = offset;
      offset += el.stateSize;
    }
  }
  const pool = new StatePool(offset);
  for (const el of elements) {
    if (isPoolBacked(el)) {
      el.initState(pool);
    }
  }
  return pool;
}

// ---------------------------------------------------------------------------
// initElement — wire a single element to a freshly-allocated StatePool
// ---------------------------------------------------------------------------

/**
 * Allocate a `StatePool` sized to the element's `stateSize`, set the
 * element's `_stateBase` to 0, and call `initState(pool)`. Required before
 * driving `element.load()` directly in unit tests for any pool-backed
 * element (capacitor, inductor, BJT, MOSFET, comparator, behavioral
 * flip-flop, etc.) — otherwise the element's `_pool` reference is undefined
 * and `load()` throws.
 *
 * Mirrors the engine's compile path: compile.ts walks every analog element
 * with `poolBacked: true`, assigns consecutive offsets, builds a single
 * `StatePool`, then calls each element's `initState(pool)`.
 *
 * Returns the allocated pool so callers can seed slots before `load()`
 * (e.g. `pool.state1[base + SLOT_PHI] = ...` to fake prior-step state).
 */
export function initElement(element: AnalogElement): StatePool {
  if (!isPoolBacked(element)) {
    return new StatePool(0);
  }
  const size = Math.max(element.stateSize ?? 0, 1);
  const pool = new StatePool(size);
  (element as PoolBackedAnalogElement & { _stateBase: number })._stateBase = 0;
  element.initState(pool);
  return pool;
}

// ---------------------------------------------------------------------------
// makeSimpleCtx / runDcOp / runNR — minimal CKTCircuitContext wrappers
// ---------------------------------------------------------------------------

export interface SimpleCtxOptions {
  solver?: SparseSolver;
  elements: readonly AnalogElement[];
  matrixSize: number;
  nodeCount: number;
  branchCount?: number;
  /** First branch-row id seen by element setup(). When unset, defaults to
   *  `nodeCount + 1` so branch rows land just above the main-node block. */
  startBranch?: number;
  /** First internal-node id seen by element setup(). When unset, defaults
   *  to `matrixSize + 1` so internal nodes do not collide with branch rows
   *  in matrices sized `nodeCount + branchCount`. */
  startNode?: number;
  params?: Partial<ResolvedSimulationParams>;
  diagnostics?: DiagnosticCollector;
  statePool?: StatePool;
}

export function makeSimpleCtx(opts: SimpleCtxOptions): CKTCircuitContext {
  const params: ResolvedSimulationParams = { ...DEFAULT_SIMULATION_PARAMS, ...opts.params };
  const diagnostics = opts.diagnostics ?? new DiagnosticCollector();
  const solver = opts.solver ?? new SparseSolver();

  // Step 1: Construct CKTCircuitContext — this calls solver._initStructure()
  // which wipes any previously allocated sparse handles. Therefore setup()
  // MUST be called AFTER construction, not before.
  const ctx = new CKTCircuitContext(
    {
      nodeCount: opts.nodeCount,
      elements: opts.elements,
    },
    params,
    () => {},
    solver,
  );
  ctx.diagnostics = diagnostics;

  // Step 2: Run setup() via the new shared helper. The solver is now clean
  // (post-_initStructure). Handles allocated here survive until the next
  // _initStructure call (never happens in normal test use).
  if (!opts.statePool) {
    const setupCtx = makeTestSetupContext({
      solver,
      startBranch: opts.startBranch ?? opts.nodeCount + 1,
      startNode: opts.startNode ?? opts.matrixSize + 1,
      elements: [...opts.elements],
    });
    setupAll([...opts.elements], setupCtx);
  }

  // Step 3: Build state pool (assigns _stateBase, calls initState).
  const statePool = opts.statePool ?? allocateStatePool(opts.elements);
  const numStates = statePool.state0.length;
  ctx.statePool = statePool;
  // Mirror allocateStateBuffers: resize dcop snapshot buffers and bind the
  // live state-ring reference into loadCtx (no snapshot — getter-based).
  ctx.dcopSavedState0 = new Float64Array(Math.max(numStates, 1));
  ctx.dcopOldState0 = new Float64Array(Math.max(numStates, 1));
  ctx.loadCtx.setStatePool(statePool);

  // Step 4: Allocate row buffers so rhs / rhsOld have correct sizes.
  ctx.allocateRowBuffers(opts.matrixSize);

  return ctx;
}

export function runDcOp(opts: SimpleCtxOptions): DcOpResult {
  const ctx = makeSimpleCtx(opts);
  solveDcOperatingPoint(ctx);
  return ctx.dcopResult;
}

export interface SimpleNROptions {
  solver?: SparseSolver;
  elements: readonly AnalogElement[];
  matrixSize: number;
  nodeCount: number;
  branchCount?: number;
  params?: Partial<ResolvedSimulationParams>;
  diagnostics?: DiagnosticCollector;
  statePool?: StatePool;
  maxIterations?: number;
  isDcOp?: boolean;
}

export function runNR(opts: SimpleNROptions): NRResult {
  const statePool = opts.statePool ?? allocateStatePool(opts.elements);
  const params: ResolvedSimulationParams = { ...DEFAULT_SIMULATION_PARAMS, ...opts.params };
  const diagnostics = opts.diagnostics ?? new DiagnosticCollector();
  const solver = opts.solver ?? new SparseSolver();
  const ctx = new CKTCircuitContext(
    {
      nodeCount: opts.nodeCount,
      elements: opts.elements,
      statePool,
    },
    params,
    () => {},
    solver,
  );
  ctx.diagnostics = diagnostics;
  if (opts.maxIterations !== undefined) {
    ctx.maxIterations = opts.maxIterations;
  }
  newtonRaphson(ctx);
  return ctx.nrResult;
}

// ---------------------------------------------------------------------------
// loadCtxFromFields — wrap a LoadContext literal (sans state0..state3)
// ---------------------------------------------------------------------------

/**
 * Wrap a literal-shape LoadContext (every field except state0..state3) into a
 * LoadCtxImpl backed by an empty placeholder StatePool. Used by unit tests
 * whose elements drive their own state via closure-captured pool refs and
 * never read ctx.stateN. If a test does need a real state pool, pass it in
 * as the second arg.
 */
export function loadCtxFromFields(
  fields: Omit<LoadContext, "state0" | "state1" | "state2" | "state3">,
  statePool: StatePool = new StatePool(0),
): LoadContext {
  return new LoadCtxImpl(statePool, fields);
}

// ---------------------------------------------------------------------------
// makeLoadCtx — build a fully-populated LoadContext literal for unit tests
// ---------------------------------------------------------------------------

export interface MakeLoadCtxOptions {
  /** SparseSolver (or capture stub) used for stamps. */
  solver: LoadContext["solver"];
  rhs?: Float64Array;
  rhsOld?: Float64Array;
  cktMode?: number;
  dt?: number;
  method?: IntegrationMethod;
  order?: number;
  ag?: Float64Array;
  deltaOld?: readonly number[];
  srcFact?: number;
  noncon?: { value: number };
  limitingCollector?: LoadContext["limitingCollector"];
  convergenceCollector?: LoadContext["convergenceCollector"];
  xfact?: number;
  gmin?: number;
  reltol?: number;
  iabstol?: number;
  cktFixLimit?: boolean;
  bypass?: boolean;
  voltTol?: number;
  uic?: boolean;
  time?: number;
  temp?: number;
  vt?: number;
}

/**
 * Build a fully-populated `LoadContext` with sane defaults for unit tests.
 *
 * Tests that build `LoadContext` literals by hand routinely forget required
 * fields (e.g. `rhsOld`, which inductor / capacitor / comparator / behavioral
 * elements destructure on every load). When the engine adds a field the
 * literal silently becomes `undefined` and tests break with
 * `Cannot read properties of undefined (reading '0')`. Centralise here so a
 * one-line schema bump fixes every caller.
 *
 * Defaults:
 *   - cktMode  = MODETRAN | MODEINITFLOAT (a normal NR iteration during
 *     transient — produces the same bit pattern an engine drives on
 *     non-init iterations).
 *   - dt = 0, order = 1, method = "trapezoidal".
 *   - rhs / rhsOld both alias `voltages` unless overridden.
 *   - All optional fields populated with the values from
 *     `cktinit.c:53-55` defaults.
 */
export function makeLoadCtx(opts: MakeLoadCtxOptions): LoadContext {
  const rhs = opts.rhs ?? new Float64Array(0);
  const rhsOld = opts.rhsOld ?? new Float64Array(0);
  // Empty StatePool: tests built via makeLoadCtx don't exercise state-ring
  // reads. Call sites that need real state should construct via
  // makeSimpleCtx (which wires the pool through CKTCircuitContext).
  const ctx = new LoadCtxImpl(new StatePool(0), {
    cktMode: opts.cktMode ?? (MODETRAN | MODEINITFLOAT),
    solver: opts.solver,
    matrix: opts.solver,
    rhs,
    rhsOld,
    time: opts.time ?? 0,
    dt: opts.dt ?? 0,
    method: opts.method ?? "trapezoidal",
    order: opts.order ?? 1,
    deltaOld: opts.deltaOld ?? [0, 0, 0, 0, 0, 0, 0],
    ag: opts.ag ?? new Float64Array(7),
    srcFact: opts.srcFact ?? 1,
    noncon: opts.noncon ?? { value: 0 },
    limitingCollector: opts.limitingCollector ?? null,
    convergenceCollector: opts.convergenceCollector ?? null,
    xfact: opts.xfact ?? 1,
    gmin: opts.gmin ?? 1e-12,
    reltol: opts.reltol ?? 1e-3,
    iabstol: opts.iabstol ?? 1e-12,
    temp: opts.temp ?? 300.15,
    vt: opts.vt ?? 0.025852,
    cktFixLimit: opts.cktFixLimit ?? false,
    bypass: opts.bypass ?? false,
    voltTol: opts.voltTol ?? 1e-6,
  });
  if (opts.uic !== undefined) {
    (ctx as unknown as { uic: boolean }).uic = opts.uic;
  }
  return ctx;
}
