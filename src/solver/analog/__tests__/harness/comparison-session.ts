/**
 * ComparisonSession  pairs an "our engine" CaptureSession against an
 * ngspice reference CaptureSession by step index and exposes shape,
 * divergence, and trace queries over the paired result. In self-compare
 * mode the ngspice side is a deep clone of the our side for zero-drift
 * unit-testing of the query surface.
 *
 * Use `createSelfCompare({ buildCircuit, analysis })` for unit tests and
 * `new ComparisonSession({ dtsPath, cirPath, ... })` for real ngspice runs.
 * See `docs/harness-redesign-spec.md` for the design (not a historical log).
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { resolveNgspiceDllPath } from "./ngspice-dll-path.js";
import { DefaultSimulatorFacade } from "../../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../../../components/register-all.js";
import { ComponentRegistry } from "../../../../core/registry.js";
import { DefaultSimulationCoordinator } from "../../../../solver/coordinator.js";
import type { Circuit } from "../../../../core/circuit.js";
import type { MNAEngine } from "../../analog-engine.js";
import type { SimulationParams, TfResult } from "../../../../core/analog-engine-interface.js";
import type { ConcreteCompiledAnalogCircuit } from "../../compiled-analog-circuit.js";
import {
  captureTopology,
  createStepCaptureHook,
  buildElementLabelMap,
} from "./capture.js";
import { compareSnapshots, findFirstDivergence } from "./compare.js";
import { convergenceSummary } from "./query.js";
import { buildAcCaptureSession } from "./ngspice-bridge.js";
import type { NgspiceJobSpec } from "./ngspice-bridge.js";
import { runNgspiceGuarded } from "./ngspice-guarded.js";
import type {
  AcCaptureSession, AcCapturePoint, AcSessionShape, AcPointShape,
  AcDivergenceReport, AcSolutionDivergenceEntry, AcShapeDivergenceEntry,
  AcMatrixDivergenceEntry,
} from "./types.js";
import type { AcParams } from "../../ac-analysis.js";
import { buildDirectNodeMapping, reindexNgspiceSession, reindexNgspiceAcSession } from "./node-mapping.js";
import { generateSpiceNetlist } from "./netlist-generator.js";
import { matchSlotPattern } from "./glob.js";
import { installUcrtLibmShim, uninstallUcrtLibmShim } from "./ucrt-libm-shim.js";
import type {
  CaptureSession,
  TopologySnapshot,
  NodeMapping,
  ComparedValue,
  StepEndReport,
  StepEndComponentEntry,
  IterationReport,
  ComponentTrace,
  NodeTrace,
  SessionSummary,
  ComparisonResult,
  IntegrationCoefficients,
  NRPhase,
  NRAttemptOutcome,
  NRAttempt,
  StepSnapshot,
  IterationSnapshot,
  ComponentInfo,
  NodeInfo,
  ComponentSlotsSnapshot,
  ComponentSlotsTrace,
  ComponentSlotsResult,
  DivergenceCategory,
  DivergenceEntry,
  DivergenceReport,
  SlotTrace,
  StateHistoryReport,
  LabeledMatrix,
  LabeledMatrixEntry,
  PaginationOpts,
  SidePresence,
  Side,
  StepShape,
  SessionShape,
  AttemptShapeSummary,
  AttemptSummary,
  AttemptCounts,
  PhaseAwareCaptureHook,
  SessionMap,
  StepShapeRow,
  AttemptShapeRow,
  StepDetail,
  StepQuery,
  PairedAttempt,
  PairedIteration,
  IterationSideData,
  AttemptDetail,
  AttemptQuery,
  MatrixDiffReport,
  MatrixDiffCell,
  MatrixDiffClassification,
  TopologyDiffReport,
  TopologyElementDiff,
  TopologyOrderingDiff,
  FirstDivergenceReport,
  FirstDivergenceSignal,
  DivergenceSignalClass,
} from "./types.js";
import { computeNIcomCof } from "../../integration.js";
import type { IntegrationMethod } from "../../integration.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _zeroDcopCoefficients(): IntegrationCoefficients {
  return {
    ours: { ag0: 0, ag1: 0, method: "trapezoidal", order: 1 },
    ngspice: { ag0: 0, ag1: 0, method: "trapezoidal", order: 1 },
  };
}

// ---------------------------------------------------------------------------
// Matrix/residual helpers
// ---------------------------------------------------------------------------

/**
 * Compute rhs, residual, residualInfinityNorm, and the full dense matrix
 * from an IterationSnapshot's sparse matrix entries, input voltages, and preSolveRhs.
 *
 * The input voltages are `iter.prevVoltages`  the iterate fed INTO this NR iteration
 * (post-solve of iter-1, or the initial guess for iter 0). Using `iter.voltages` (the
 * POST-solve result of this iteration) would make the residual identically zero to LU
 * precision, defeating its diagnostic value.
 * preSolveRhs is the captured b vector before the linear solve.
 * residual[i] = sum_j(A[i][j] * v_input[j]) - b[i].
 *
 * matrix is null only when sparse capture was empty (no matrix entries recorded).
 */
function _computeLinearSystemData(
  iter: import("./types.js").IterationSnapshot,
  matrixSize: number,
): {
  rhs: number[];
  residual: number[];
  residualInfinityNorm: number;
  matrix: number[] | null;
} {
  // `matrixSize` is the snapshot's equation-count metric (ngspice
  // CKTmaxEqNum+1, our engine reports voltages.length+1; see types.ts:971-976
  // for the contract). By that convention it is always one larger than the
  // actual rhs/prevVoltages allocation (rhsBufSize), so iterating rows up to
  // matrixSize unconditionally reads one past the end and writes NaN at the
  // trailing slot. Earlier consumers happened to ignore that slot; the harness
  // null-audit surfaces it. Clamp n to the real buffer length.
  const n = Math.min(matrixSize, iter.preSolveRhs.length, iter.prevVoltages.length);
  const rhs = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) rhs[i] = iter.preSolveRhs[i] ?? 0;

  // Build full dense matrix (row-major) from sparse entries
  let denseA: number[] | null = null;
  if (iter.matrix.length > 0) {
    denseA = new Array<number>(n * n).fill(0);
    for (const { row, col, value } of iter.matrix) {
      if (row < n && col < n) denseA[row * n + col] += value;
    }
  }

  const residual = new Array<number>(n).fill(0);
  let residualInfinityNorm = 0;
  if (denseA !== null) {
    const v = iter.prevVoltages;
    for (let r = 0; r < n; r++) {
      let sum = 0;
      for (let c = 0; c < n; c++) sum += denseA[r * n + c] * (v[c] ?? 0);
      residual[r] = sum - rhs[r];
      const abs = Math.abs(residual[r]);
      if (abs > residualInfinityNorm) residualInfinityNorm = abs;
    }
  }

  return { rhs, residual, residualInfinityNorm, matrix: denseA };
}

/**
 * Build a ComparedValue under strict bit-exact equality. `withinTol` means
 * `ours === ngspice` (IEEE-754 identity). Both-NaN means data is unavailable
 * and is treated as matching with zero delta.
 */
function makeComparedValue(ours: number, ngspice: number): ComparedValue {
  if (isNaN(ours) && isNaN(ngspice)) {
    return { ours, ngspice, delta: 0, absDelta: 0, relDelta: 0, withinTol: true };
  }
  const delta = ours - ngspice;
  const absDelta = Math.abs(delta);
  const refMag = Math.max(Math.abs(ours), Math.abs(ngspice));
  const relDelta = refMag > 0 ? absDelta / refMag : absDelta;
  return { ours, ngspice, delta, absDelta, relDelta, withinTol: ours === ngspice };
}

function applyPagination<T>(arr: T[], opts?: PaginationOpts): T[] {
  const offset = opts?.offset ?? 0;
  const limit = opts?.limit ?? arr.length;
  return arr.slice(offset, offset + limit);
}

function prettyPrintNgspiceNodeName(name: string): string {
  const lower = name.toLowerCase();
  const suffixMap: Array<[string, string]> = [
    ["#base", ":B'"],
    ["#collector", ":C'"],
    ["#emitter", ":E'"],
    ["#source", ":S'"],
    ["#drain", ":D'"],
    ["#internal", ":int"],
  ];
  for (const [suffix, rep] of suffixMap) {
    if (lower.endsWith(suffix)) {
      const dev = name.slice(0, name.length - suffix.length).toUpperCase();
      return `${dev}${rep}`;
    }
  }
  return name;
}

function stripControlBlock(cir: string): string {
  let inControl = false;
  return cir
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim().toLowerCase();
      if (trimmed.startsWith(".control")) { inControl = true; return false; }
      if (trimmed.startsWith(".endc"))    { inControl = false; return false; }
      if (inControl) return false;
      if (trimmed.startsWith("meas ") || trimmed === "quit" || trimmed.startsWith("tran "))
        return false;
      return true;
    })
    .join("\n");
}

const ROOT = process.cwd();
function resolvePath(p: string): string { return resolve(ROOT, p); }
function getDllPath(opts: ComparisonSessionOptions): string {
  return resolveNgspiceDllPath(opts.dllPath);
}

function emptyTopology(): TopologySnapshot {
  return {
    matrixSize: 0, nodeCount: 0, elementCount: 0,
    elements: [],
    nodeLabels: new Map(),
    matrixRowLabels: new Map(),
    matrixColLabels: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ComparisonSessionOptions {
  /** Path to .dts circuit file (our engine format). Optional when selfCompare + buildCircuit is used. */
  dtsPath?: string;
  /** Path to .cir SPICE netlist (ngspice format). Optional for headless-only use. */
  cirPath?: string;
  /** Path to ngspice DLL. Defaults to NGSPICE_DLL_PATH env or standard build location. */
  dllPath?: string;
  /** Max timestep steps to run on our engine per run. Default: 5000. */
  maxOurSteps?: number;
  /** When true, skip ngspice and compare our engine against a deep clone of itself. */
  selfCompare?: boolean;
  /**
   * When true, structural-parity assertions
   * (`_assertMatrixStructuralParity` / `_assertFirstIterationMatrixEntriesMatch`)
   * record their findings on the session rather than throwing. Used by the MCP
   * investigation tools (`harness_topology_diff`, `harness_matrix_diff`,
   * `harness_first_divergence`) so an agent can inspect what diverged even
   * when matrixSize or coord-set parity is broken — the whole point of the
   * investigation surface. Default `false` preserves the fail-fast behaviour
   * for in-repo tests that depend on it.
   *
   * Intra-side drift (matrixSize changing within one engine during one run)
   * is unaffected: that is a hard internal invariant and continues to throw.
   */
  deferStructuralAsserts?: boolean;
  /**
   * ngspice-only DC operating-point guesses, keyed by net/pin NAME (e.g.
   * "Q1:C") mapped to volts. Resolved to digiTS node IDs at init time and
   * emitted as a `.nodeset` card on the auto-generated deck (cktload.c:107-120).
   * digiTS never populates its own nodesets, so a nodeset on a bistable circuit
   * steers ONLY the ngspice side into one DC state while digiTS lands wherever
   * its own NR settles — surfacing digiTS's lack of nodeset support as a genuine
   * ours-vs-ngspice divergence. Ignored when `cirPath` is supplied (the author
   * owns the deck) or when `selfCompare` is true (no ngspice side).
   */
  nodesets?: ReadonlyMap<string, number>;
  /**
   * Initial-condition constraints, keyed by net/pin NAME (e.g. "C1:pos")
   * mapped to volts. Resolved to digiTS node IDs at init time and emitted as a
   * `.ic` card on the auto-generated deck (cktload.c:131-158: icGiven nodes get
   * CKTrhs[number] = 1e10 * ic * CKTsrcFact and *(node->ptr) += 1e10 during the
   * MODETRANOP transient-boot DCOP, no MODEUIC). Unlike nodesets, the resolved
   * ICs are ALSO seeded into the digiTS compiled circuit's `ics` Map so both
   * engines receive the same transient-boot IC stimulus. Ignored when `cirPath`
   * is supplied (the author owns the deck) or when `selfCompare` is true (no
   * ngspice side).
   */
  ics?: ReadonlyMap<string, number>;
}

// ---------------------------------------------------------------------------
// Supplemental report types (not yet in types.ts)
// ---------------------------------------------------------------------------

interface IntegrationCoefficientsReport {
  stepIndex: number;
  ours: { ag0: number; ag1: number; method: string; order: number };
  ngspice: { ag0: number; ag1: number; method: string; order: number };
  methodMatch: boolean;
  ag0Compared: ComparedValue;
  ag1Compared: ComparedValue;
}

interface LimitingComparisonReport {
  label: string;
  noEvents: boolean;
  junctions: Array<{
    junction: string;
    ourPreLimit: number;
    ourPostLimit: number;
    ourWasLimited: boolean;
    ourDelta: number;
    ngspicePreLimit: number;
    ngspicePostLimit: number;
    ngspiceWasLimited: boolean;
    ngspiceDelta: number;
    limitingDiff: number;
  }>;
}

interface ConvergenceDetailReport {
  stepIndex: number;
  iteration: number;
  ourNoncon: number;
  ngspiceNoncon: number;
  ourGlobalConverged: boolean;
  ngspiceGlobalConverged: boolean;
  elements: Array<{
    label: string;
    deviceType: string;
    ourConverged: boolean;
    ngspiceConverged: boolean;
    worstDelta: number;
    agree: boolean;
  }>;
  disagreementCount: number;
}

interface CompareMatrixResult {
  stepIndex: number;
  iteration: number;
  filter: "all" | "mismatches";
  totalEntries: number;
  entries: LabeledMatrixEntry[];
}

interface RhsLabeledResult {
  stepIndex: number;
  iteration: number;
  entries: Array<{ index: number; rowLabel: string; ours: number; ngspice: number; absDelta: number; withinTol: boolean }>;
}

interface ToJSONOpts { includeAllSteps?: boolean }

// ---------------------------------------------------------------------------
// Norm helpers (file-scoped)
//
// `divergenceNorm` uses absolute L1 (Σ|a[i]-b[i]|), not L2: 1-ULP deltas
// squared land at ~1e-38, sqrt at ~1e-19, which is indistinguishable from 0
// in any human-facing display. L1 preserves the per-row absolute deltas
// so a single 1-ULP slot still surfaces a non-zero norm.
//
// `_vectorL2` is unchanged- callers (endNodeNorm/endBranchNorm) want the
// Euclidean magnitude of one side's solution vector, not a delta.
// ---------------------------------------------------------------------------

/** Absolute L1 norm of (a[start..end) - b[start..end)). NaN if either undefined. */
function _l1NormDiff(a: Float64Array | undefined, b: Float64Array | undefined, start: number, end: number): number {
  if (!a || !b) return NaN;
  const n = Math.min(a.length, b.length, end);
  if (n <= start) return NaN;
  let s = 0;
  for (let i = start; i < n; i++) {
    s += Math.abs(a[i] - b[i]);
  }
  return s;
}

/** L2 norm of v[start..end). NaN if undefined or empty range. */
function _vectorL2(v: Float64Array | undefined, start: number, end: number): number {
  if (!v) return NaN;
  const n = Math.min(v.length, end);
  if (n <= start) return NaN;
  let s = 0;
  for (let i = start; i < n; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}

// ---------------------------------------------------------------------------
// First-divergence causal ordering
// ---------------------------------------------------------------------------

/**
 * Causal order of first-divergence signal classes within a single
 * (stepIndex, iterationIndex). Lower rank = more upstream in the per-iteration
 * pipeline: structural shape, then the integration coefficients that govern the
 * load, then history state read by the load, then the load-pass products
 * (limiting -> rhs -> matrix), then the solve output (voltage), then the
 * post-solve convergence test. Used only to break (step, iter) ties.
 */
export const FIRST_DIVERGENCE_CAUSAL_RANK: Record<DivergenceSignalClass, number> = {
  shape: 0,
  integration: 1,
  state: 2,
  limiting: 3,
  rhs: 4,
  matrix: 5,
  voltage: 6,
  convergence: 7,
};

/**
 * Select the earliest divergence from a set of per-class signals: lowest
 * `stepIndex`, then lowest `iterationIndex`, then most-upstream causal rank.
 * The rank tie-break is what makes the router point at the cause rather than a
 * downstream symptom- a divergent `rhs` and the `voltage` it produces share the
 * same (step, iter), and `rhs` (rank 4) must win over `voltage` (rank 6).
 */
export function pickEarliestDivergence(
  signals: ReadonlyArray<FirstDivergenceSignal>,
): FirstDivergenceSignal | null {
  if (signals.length === 0) return null;
  return signals.reduce((best, cur) => {
    if (cur.stepIndex !== best.stepIndex) return cur.stepIndex < best.stepIndex ? cur : best;
    if (cur.iterationIndex !== best.iterationIndex) return cur.iterationIndex < best.iterationIndex ? cur : best;
    return FIRST_DIVERGENCE_CAUSAL_RANK[cur.signalClass] < FIRST_DIVERGENCE_CAUSAL_RANK[best.signalClass] ? cur : best;
  });
}

// ---------------------------------------------------------------------------
// ComparisonSession
// ---------------------------------------------------------------------------

export class ComparisonSession {
  protected _opts: ComparisonSessionOptions;
  protected _dllPath: string;

  // Our engine state (set in init())
  protected _facade!: DefaultSimulatorFacade;
  protected _coordinator!: DefaultSimulationCoordinator;
  protected _engine!: MNAEngine;
  protected _ourTopology!: TopologySnapshot;
  protected _elementLabels!: Map<number, string>;

  // Step capture hook (one instance per session, cleared per run)
  protected _stepCapture!: ReturnType<typeof createStepCaptureHook>;

  // ngspice bridge artifacts.
  // _cirClean is the base netlist (cirPath-stripped or auto-generated at init).
  // The deck actually loaded into ngspice is _materializeCir(), which injects
  // a `.options TEMP=<celsius>` line reflecting the engine's current circuitTemp
  // for auto-generated decks- this keeps the ngspice side in lock-step with
  // setCircuitTemp() calls made after init.
  protected _cirClean: string = "";

  // Capture sessions
  protected _ourSession: CaptureSession | null = null;
  protected _ngSession: CaptureSession | null = null;
  protected _ngSessionReindexed: CaptureSession | null = null;
  // AC parity (Phase 2). Populated by runAcSweep; null otherwise.
  protected _acSession: AcCaptureSession | null = null;
  protected _ngAcSession: AcCaptureSession | null = null;
  protected _ngAcSessionReindexed: AcCaptureSession | null = null;
  // TF parity (.tf). Populated by runTf; null otherwise.
  protected _tfOurs: TfResult | null = null;
  protected _tfNgspice: [number, number, number] | null = null;

  // Node mapping
  protected _nodeMap: NodeMapping[] = [];
  protected _ngTopology: import("./types.js").NgspiceTopology | null = null;

  // Matrix row/col mapping (for semantic joins of BJT internal nodes)
  protected _ngMatrixRowMap: Map<number, number> = new Map();
  protected _ngMatrixColMap: Map<number, number> = new Map();
  protected _ngspiceOnlyRows: number[] = [];
  protected _ngspiceOnlyRowLabels: Map<number, string> = new Map();

  /**
   * Findings deferred from `_assertMatrixStructuralParity` /
   * `_assertFirstIterationMatrixEntriesMatch` when
   * `deferStructuralAsserts: true`. Reset at the start of every `runDcOp` /
   * `runTransient` call and surfaced through `topologyDiff()`.
   */
  protected _structuralFindings: Array<{ kind: string; message: string }> = [];

  // Comparison results (lazily cached)
  protected _comparisons: ComparisonResult[] | null = null;

  // Analysis type
  protected _analysis: "dcop" | "tran" | "ac" | "tf" | null = null;

  // ComponentRegistry for netlist generation
  private _registry!: ComponentRegistry;

  // Whether init() has completed
  protected _inited: boolean = false;

  // Whether this session installed the ucrt libm override — dispose() uses
  // this to balance the install with a matching uninstall (refcounted
  // inside the installer).
  protected _libmShimInstalled: boolean = false;

  // Whether runDcOp()/runTransient() has completed
  protected _hasRun: boolean = false;

  // Errors accumulated during run
  readonly errors: string[] = [];

  constructor(opts: ComparisonSessionOptions) {
    this._opts = opts;
    this._dllPath = getDllPath(opts);
  }

  // ---------------------------------------------------------------------------
  // Static factory
  // ---------------------------------------------------------------------------

  static async create(opts: ComparisonSessionOptions): Promise<ComparisonSession> {
    const s = new ComparisonSession(opts);
    await s.init();
    return s;
  }

  static async createSelfCompare(opts: {
    dtsPath?: string;
    buildCircuit?: (registry: ComponentRegistry) => Circuit;
    analysis: "dcop" | "tran" | "ac";
    tStop?: number;
    maxStep?: number;
    acParams?: AcParams;
    params?: Partial<SimulationParams>;
  }): Promise<ComparisonSession> {
    const session = new ComparisonSession({
      dtsPath: opts.dtsPath ?? "<inline>",
      selfCompare: true,
    });
    await session.initSelfCompare(opts.buildCircuit);

    if (opts.params !== undefined) {
      session._engine.configure(opts.params);
    }

    if (opts.analysis === "dcop") {
      await session.runDcOp();
    } else if (opts.analysis === "tran") {
      if (opts.tStop === undefined) {
        throw new Error("createSelfCompare: tStop required for transient analysis");
      }
      await session.runTransient(0, opts.tStop, opts.maxStep);
    } else {
      // ac
      if (opts.acParams === undefined) {
        throw new Error("createSelfCompare: acParams required for AC analysis");
      }
      await session.runAcSweep(opts.acParams);
    }
    return session;
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  /**
   * Load circuit, compile engine without running DCOP, capture topology,
   * install the master-switch PhaseAwareCaptureHook, run DCOP via initialize(),
   * and close the boot step directly into _stepCapture.
   */
  async init(): Promise<void> {
    // Install the ucrt libm override so digiTS uses the same `exp`/`log`
    // implementations ngspice.dll statically embeds. Eliminates the V8 vs
    // ucrt 1-ULP transcendental disagreement across the dcop_paired_*
    // cluster (see memory/reference_libm_log_one_ulp.md). selfCompare
    // sessions deliberately skip this — they compare ours-vs-ours, so
    // ucrt-flavoured Math would skew them away from the JS baseline.
    this._libmShimInstalled = installUcrtLibmShim();

    this._registry = createDefaultRegistry();
    this._facade = new DefaultSimulatorFacade(this._registry);

    const dtsJson = readFileSync(resolvePath(this._opts.dtsPath!), "utf-8");
    const circuit = this._facade.deserialize(dtsJson);

    await this._initWithCircuit(circuit);
  }

  private async initSelfCompare(buildCircuit?: (registry: ComponentRegistry) => Circuit): Promise<void> {
    this._registry = createDefaultRegistry();
    this._facade = new DefaultSimulatorFacade(this._registry);

    const circuit = buildCircuit
      ? buildCircuit(this._registry)
      : this._facade.deserialize(readFileSync(resolvePath(this._opts.dtsPath!), "utf-8"));

    await this._initWithCircuit(circuit);
  }

  private async _initWithCircuit(circuit: Circuit): Promise<void> {
    this._coordinator = this._facade.compile(circuit) as DefaultSimulationCoordinator;
    this._engine = this._coordinator.getAnalogEngine() as MNAEngine;

    if (!this._engine) {
      this._elementLabels = new Map();
      this._ourTopology = emptyTopology();
      this._inited = true;
      return;
    }

    const compiled = this._engine.compiled! as ConcreteCompiledAnalogCircuit;
    this._elementLabels = buildElementLabelMap(compiled);
    this._ourTopology = captureTopology(
      compiled,
      this._engine.matrixSize,
      this._elementLabels,
      this._engine.getNodeTable(),
    );

    // Seed the digiTS compiled circuit with the author-supplied ICs so the
    // transient-boot DCOP (MODETRANOP) honours them on the digiTS side too.
    // _ourTopology.nodeLabels was captured above, so the NAME->id resolution
    // can run here. Nodesets stay ngspice-only (the digiTS nodeset apply is the
    // recon's target), but ICs are seeded into BOTH engines so the harness
    // drives the same transient-boot stimulus on each side. The compiled
    // circuit's `ics` field is declared readonly but is a mutable Map written
    // via cast in its constructor; ckt-load reads it through ctx.ics at setup.
    const resolvedIcsForOurs = this._resolveIcNames();
    if (resolvedIcsForOurs && resolvedIcsForOurs.size > 0) {
      const icMap =
        compiled.ics ??
        ((compiled as { ics?: Map<number, number> }).ics = new Map<number, number>());
      for (const [nodeId, value] of resolvedIcsForOurs) icMap.set(nodeId, value);
    }

    // elementIndex → canonical device type, used by captureElementStates to
    // project per-pin terminal currents from the slot data via DEVICE_MAPPINGS.
    // Type IDs do not change between init and post-setup, so building this
    // once at hook-creation time is correct.
    const elementTypes = new Map<number, string>();
    for (const el of this._ourTopology.elements) elementTypes.set(el.index, el.type);

    this._stepCapture = createStepCaptureHook(
      this._engine.solver!,
      this._engine.elements,
      // Pass a getter, NOT the value. MNAEngine allocates its statePool inside
      // _setup()- called from the first dcOperatingPoint() / step(), which
      // runs AFTER this hook is wired up. A by-value capture would freeze
      // statePool at null and silently no-op captureElementStates() forever
      // (the bug that hid all per-iteration MOSFET/BJT/diode device-state
      // divergences from every parity test).
      () => this._engine.statePool,
      this._elementLabels,
      elementTypes,
    );

    // captureTopology(...) above ran BEFORE engine._setup()- engine.matrixSize
    // is 0 at init time and only becomes meaningful once the first
    // dcOperatingPoint()/step() lazily runs the setup pass. The topology gets
    // refreshed after each run completes (see _refreshOurTopologyAfterSetup);
    // the initial capture exists so consumers querying before any run still
    // see element labels and node connectivity.

    const sc = this._stepCapture;
    const bundle: PhaseAwareCaptureHook = {
      iterationHook: sc.iterationHook,
      preFactorHook: sc.preFactorHook,
      phaseHook: {
        onAttemptBegin(phase: string, dt: number, phaseParameter?: number): void {
          sc.beginAttempt(phase as NRPhase, dt, phaseParameter);
        },
        onAttemptEnd(outcome: string, converged: boolean): void {
          sc.endAttempt(outcome as NRAttemptOutcome, converged);
        },
      },
    };

    this._facade.setCaptureHook(bundle);

    sc.setStepStartTime(0);
    // No analysis runs here. runDcOp() invokes coordinator.dcOperatingPoint()
    // (standalone .op, MODEDCOP). runTransient() invokes coordinator.step(),
    // whose first call lazily runs the transient-boot DCOP (MODETRANOP) and
    // captures it into step 0 alongside the first tranInit attempt.

    if (this._opts.cirPath) {
      const cirRaw = readFileSync(resolvePath(this._opts.cirPath), "utf-8");
      this._cirClean = stripControlBlock(cirRaw);
    } else if (!this._opts.selfCompare) {
      this._assertAllComponentsPairedSpiceEquivalent(compiled);
      // Resolve author-supplied nodeset NAMES to the digiTS node IDs the deck
      // uses. The author knows net/pin names ("Q1:C"); the generator keys on
      // numeric IDs because the emitted deck writes stringified IDs as node
      // names (buildDirectNodeMapping correlates them back). _ourTopology was
      // captured above, so its nodeLabels map carries the same name->id pairing
      // the deck emits.
      const resolvedNodesets = this._resolveNodesetNames();
      // Resolve author-supplied IC NAMES to digiTS node IDs and emit them as a
      // `.ic` card on the deck, parallel to the `.nodeset` path above. The
      // digiTS side was already seeded with the same resolved IDs above, so
      // both engines receive the transient-boot IC stimulus.
      const resolvedIcs = this._resolveIcNames();
      this._cirClean = generateSpiceNetlist(
        compiled, this._registry, this._elementLabels, undefined, resolvedNodesets, resolvedIcs,
      );
    }

    this._inited = true;
  }

  /**
   * Reject paired comparison when any component in the compiled circuit has
   * declared `pairedSpiceEquivalent: false`. The flag means the digiTS model
   * is not yet emittable as a SPICE-faithful subcircuit (behavioural
   * macromodel held in TS, or expression-driven controlled source the
   * netlist generator cannot translate bit-exact). The real device class
   * always has a SPICE reference (Boyle for op-amps, Koren for triodes,
   * Joglekar for memristor, vendor .lib for the 555, etc.) — the model
   * needs updating to compose canonical primitives that the generator can
   * round-trip, not skipping. Until then, tests for these components must
   * use `ComparisonSession.createSelfCompare`. Throws an aggregated error
   * listing every offender so the author can address them all at once.
   */
  /**
   * Materialize the netlist deck to load into ngspice. For auto-generated decks,
   * injects `.options TEMP=<celsius>` after the title so the engine's current
   * circuitTemp drives ngspice CKTtemp. For cirPath-loaded decks, returns the
   * deck verbatim — the author owns TEMP.
   */
  private _materializeCir(): string {
    if (!this._cirClean) return "";
    if (this._opts.cirPath) return this._cirClean;
    const K = this._engine.circuitTemp;
    // ngspice's default operating temperature is 27 degC = 300.15 K (CKTtemp
    // initialisation in CKTinit.c). At the default, injecting an explicit
    // .options TEMP=27 card perturbs ngspice's setup ordering by ~1 ULP
    // versus no card at all; skip injection at default to preserve bit-exact
    // parity for fixtures running at the default temperature.
    if (Math.abs(K - 300.15) < 1e-12) return this._cirClean;
    const celsius = K - 273.15;
    // generateSpiceNetlist puts the title on line 0; inject the options card
    // immediately after so it precedes every device card.
    const lines = this._cirClean.split("\n");
    lines.splice(1, 0, `.options TEMP=${celsius}`);
    return lines.join("\n");
  }

  private _assertAllComponentsPairedSpiceEquivalent(
    compiled: ConcreteCompiledAnalogCircuit,
  ): void {
    const offenders: Array<{ label: string; typeId: string }> = [];
    const seen = new Set<unknown>();
    for (const ce of compiled.elementToCircuitElement.values()) {
      if (seen.has(ce)) continue;
      seen.add(ce);
      const def = this._registry.get(ce.typeId);
      if (def && (def as { pairedSpiceEquivalent?: boolean }).pairedSpiceEquivalent === false) {
        const label = ce.getProperties().getOrDefault<string>("label", "") || ce.typeId;
        offenders.push({ label, typeId: ce.typeId });
      }
    }
    if (offenders.length === 0) return;
    const list = offenders
      .map((o) => `  - ${o.typeId} (label='${o.label}')`)
      .join("\n");
    throw new Error(
      `ComparisonSession: cannot run paired-with-ngspice comparison- the ` +
      `following component(s) have declared pairedSpiceEquivalent: false:\n` +
      `${list}\n` +
      `The underlying device classes all have established SPICE references ` +
      `(Boyle for op-amps, Koren for triodes, Joglekar for memristor, vendor ` +
      `.lib subcircuits for the 555, etc.). The flag means the digiTS model ` +
      `is currently held as a behavioural macromodel or expression-driven ` +
      `source that the netlist generator cannot emit bit-exact, not that no ` +
      `SPICE equivalent exists. The model needs updating to compose canonical ` +
      `primitives the generator can round-trip. Until then, use ` +
      `ComparisonSession.createSelfCompare for tests of these components.`
    );
  }

  // ---------------------------------------------------------------------------
  // Run methods
  // ---------------------------------------------------------------------------

  /**
   * Run DC operating point comparison.
   *
   * Invokes coordinator.dcOperatingPoint()  standalone `.op` (MODEDCOP),
   * matching ngspice `dcop.c::DCop`. The capture hook collects per-NR-iter
   * snapshots into _stepCapture; this method then closes step 0 and snapshots
   * the result as _ourSession before running the ngspice side (or deep-cloning
   * for self-compare mode).
   */
  async runDcOp(opTran?: {
    opstepsize: number;
    opfinaltime: number;
    opramptime?: number;
  }): Promise<void> {
    this._ensureInited();
    if (this._hasRun) return;

    this._analysis = "dcop";
    this._comparisons = null;
    this._structuralFindings = [];

    // OPtran fall-through enable (ngspice optran.c / cktop.c:101-108). When the
    // caller requests it, configure the digiTS engine so solveDcOperatingPoint
    // runs the OPtran pseudo-transient after the static ladder fails, and the
    // ngspice side issues `optran <step> <final> <ramp>` before `op` (see the
    // analysis spec below). Both sides take their default DC-OP path when
    // opTran is omitted.
    if (opTran && this._engine) {
      this._engine.configure({
        optran: true,
        opstepsize: opTran.opstepsize,
        opfinaltime: opTran.opfinaltime,
        opramptime: opTran.opramptime ?? 0,
      });
    }

    // Run standalone .op on our engine. Capture hook accumulates iterations
    // into the pending step buffer; endStep() closes them as step 0.
    if (this._coordinator) {
      this._coordinator.dcOperatingPoint();
    }
    if (this._stepCapture) {
      this._stepCapture.endStep({
        stepEndTime: 0,
        integrationCoefficients: _zeroDcopCoefficients(),
        analysisPhase: "dcop",
        acceptedAttemptIndex: -1,
        order: this._engine.integrationOrder,
        // cktdojob.c:117  the dispatcher zeroes CKTdelta at job entry, and
        // dcop.c::DCop never writes it. The harness IS the dispatcher
        // equivalent here, so the captured CKTdelta during a standalone .op
        // step is 0. Do not read _engine.currentDt: that field belongs to
        // the transient flow and reflects whatever configure() seeded.
        delta: 0,
      });
    }

    this._refreshOurTopologyAfterSetup();
    this._ourSession = {
      source: "ours",
      topology: this._ourTopology,
      steps: this._stepCapture.getSteps(),
    };

    if (!this._opts.selfCompare && this._cirClean) {
      try {
        const analysis: NgspiceJobSpec["analysis"] = opTran
          ? {
              kind: "optran",
              opstepsize: this._formatSpiceTime(opTran.opstepsize),
              opfinaltime: this._formatSpiceTime(opTran.opfinaltime),
              opramptime: this._formatSpiceTime(opTran.opramptime ?? 0),
            }
          : { kind: "dcop" };
        const spec: NgspiceJobSpec = {
          dllPath: this._dllPath,
          netlist: this._materializeCir(),
          analysis,
        };
        const runResult = await runNgspiceGuarded(spec);
        this._ngSession = runResult.session ?? { source: "ngspice", topology: emptyTopology(), steps: [] };
        this._buildNodeMapping(runResult.ngspiceTopology);
      } catch (e: any) {
        this.errors.push(`ngspice DC OP failed: ${e.message}`);
        this._ngSession = { source: "ngspice", topology: emptyTopology(), steps: [] };
      }
    } else if (this._opts.selfCompare) {
      this._ngSession = deepCloneSession(this._ourSession, "ngspice");
      this._ngSessionReindexed = this._ngSession;
      this._nodeMap = buildIdentityNodeMap(this._ourSession);
    } else {
      this._ngSession = { source: "ngspice", topology: emptyTopology(), steps: [] };
    }

    if (!this._opts.selfCompare) {
      this._reindexNgSession();
    }

    this._hasRun = true;
    this._assertMatrixStructuralParity();
  }

  /**
   * Run a DC small-signal transfer function (`.tf`) on both engines and capture
   * the three scalars for a paired comparison.
   *
   *   - ours: `coordinator.transferFunction({ inputSource, output })`
   *     (MNAEngine.transferFunction → runTransferFunction, the tfanal.c port).
   *   - ngspice: `tf <ngOutput> <inputSource>` via the guarded worker, captured
   *     bit-exact through the tf_register hook at tfanal.c `done:`.
   *
   * `output` is the digiTS output label (a node label resolved via labelToNodeId,
   * or an `I(<src>)` source current); `ngOutput` is the matching ngspice
   * expression. The deck names nodes by stringified digiTS node id
   * (netlist-generator.ts), so a digiTS output on node id N maps to `v(N)`.
   */
  async runTf(params: { inputSource: string; output: string; ngOutput: string }): Promise<void> {
    this._ensureInited();
    if (this._hasRun) return;

    this._analysis = "tf";
    this._comparisons = null;
    this._structuralFindings = [];

    // Our side: the .tf driver re-solves the factored DC-OP Jacobian (tfanal.c).
    if (this._coordinator) {
      this._tfOurs = this._coordinator.transferFunction({
        inputSource: params.inputSource,
        output: params.output,
      });
    }

    if (!this._opts.selfCompare && this._cirClean) {
      try {
        const spec: NgspiceJobSpec = {
          dllPath: this._dllPath,
          netlist: this._materializeCir(),
          analysis: { kind: "tf", output: params.ngOutput, insrc: params.inputSource },
        };
        const runResult = await runNgspiceGuarded(spec);
        this._tfNgspice = runResult.tfOutputs;
        if (runResult.ngspiceTopology) this._buildNodeMapping(runResult.ngspiceTopology);
      } catch (e: any) {
        this.errors.push(`ngspice .tf failed: ${e.message}`);
        this._tfNgspice = null;
      }
    } else if (this._opts.selfCompare && this._tfOurs) {
      this._tfNgspice = [
        this._tfOurs.transferFunction,
        this._tfOurs.inputResistance,
        this._tfOurs.outputResistance,
      ];
    }

    this._hasRun = true;
  }

  /** The digiTS `.tf` result from the last `runTf`, or null. */
  tfOurs(): TfResult | null { return this._tfOurs; }

  /** The ngspice `.tf` [transferFunction, inputResistance, outputResistance], or null. */
  tfNgspice(): [number, number, number] | null { return this._tfNgspice; }

  /**
   * Paired `.tf` comparison: per-scalar (ours, ngspice, absDelta) plus the max
   * abs delta across all three. Null if either side is missing.
   */
  tfCompare(): {
    transferFunction: { ours: number; ngspice: number; absDelta: number };
    inputResistance: { ours: number; ngspice: number; absDelta: number };
    outputResistance: { ours: number; ngspice: number; absDelta: number };
    maxAbsDelta: number;
  } | null {
    if (!this._tfOurs || !this._tfNgspice) return null;
    const o = this._tfOurs;
    const [ntf, nrin, nrout] = this._tfNgspice;
    const tf = { ours: o.transferFunction, ngspice: ntf, absDelta: Math.abs(o.transferFunction - ntf) };
    const rin = { ours: o.inputResistance, ngspice: nrin, absDelta: Math.abs(o.inputResistance - nrin) };
    const rout = { ours: o.outputResistance, ngspice: nrout, absDelta: Math.abs(o.outputResistance - nrout) };
    return {
      transferFunction: tf,
      inputResistance: rin,
      outputResistance: rout,
      maxAbsDelta: Math.max(tf.absDelta, rin.absDelta, rout.absDelta),
    };
  }

  /**
   * Run AC small-signal analysis on both engines.
   *
   * Phase 2 deliverable. Our side drives `engine.acAnalysis(params, deps)`
   * with a snapshot sink that captures each per-frequency complex solution
   * into `_acSession`. The ngspice side runs the same sweep via the bridge's
   * `ni_ac_*` instrumentation and lands in `_ngAcSession`.
   *
   * Pairing semantics: `_acSession.points[i]` pairs with `_ngAcSession.points[i]`
   * by frequency index. Phase 3 layers per-frequency divergence/diff tooling
   * (complex-cell matrix diff, solution-magnitude comparison) on top of these
   * two sessions.
   *
   * Notes on the netlist contract:
   *   - The .dts (ours) must include an AcVoltageSource (or AcCurrentSource)
   *     element; its acMagnitude / acPhase properties drive the .ac sweep
   *     stimulus via stampAc (vsrcacld.c:175-180, isrcacld.c:43-50).
   *   - The .cir (ngspice) must contain a real AC source line carrying the
   *     same `AC <mag> <phase>` token, which the netlist generator emits
   *     directly from those properties (netlist-generator.ts).
   * Fixtures must keep both sides aligned; mismatch yields trivially divergent
   * solutions and is a fixture bug, not an engine bug.
   */
  async runAcSweep(params: AcParams): Promise<void> {
    this._ensureInited();
    if (this._hasRun) return;

    this._analysis = "ac";
    this._comparisons = null;
    this._structuralFindings = [];

    // Our side: drive AcAnalysis through the engine with a snapshot sink.
    // The sink fires once per frequency point after the complex solve;
    // arrays are already defensive copies (sink owns them).
    const ourPoints: AcCapturePoint[] = [];
    this._engine.acAnalysis(params, {
      // Pre-factor complex-matrix capture. The white-box read of the assembled
      // Jacobian belongs to the harness, not production ac-analysis: walk the
      // solver's instrumentation wrapper and build the external-coords CSC
      // (sort by col asc then row asc; colPtr by prefix-sum), matching ngspice's
      // pre-LU CSC layout in niiter.c.
      captureAcMatrix: () => {
        const solver = this._engine.solver;
        if (!solver) return null;
        const cells = solver.createInstrumentation().getComplexCSCNonZeros();
        const N = this._engine.matrixSize;
        const nnz = cells.length;
        const colPtr = new Int32Array(N + 1);
        const rowIdx = new Int32Array(nnz);
        const valsRe = new Float64Array(nnz);
        const valsIm = new Float64Array(nnz);
        cells.sort((a, b) => (a.col !== b.col ? a.col - b.col : a.row - b.row));
        let cursor = 0;
        for (let c = 1; c <= N; c++) {
          while (cursor < nnz && cells[cursor].col === c) {
            rowIdx[cursor] = cells[cursor].row;
            valsRe[cursor] = cells[cursor].valueRe;
            valsIm[cursor] = cells[cursor].valueIm;
            cursor++;
          }
          colPtr[c] = cursor;
        }
        return { nnz, colPtr, rowIdx, valsRe, valsIm };
      },
      acSnapshotSink: (snap) => {
        ourPoints.push({
          freq: snap.freq,
          omega: snap.omega,
          matrixSize: snap.matrixSize,
          solRe: snap.solRe,
          solIm: snap.solIm,
          matrix: snap.matrix,
          rhsRe: snap.rhsRe,
          rhsIm: snap.rhsIm,
        });
      },
    });

    this._refreshOurTopologyAfterSetup();
    this._acSession = {
      source: "ours",
      topology: this._ourTopology,
      points: ourPoints,
    };

    if (!this._opts.selfCompare && this._cirClean) {
      try {
        const spec: NgspiceJobSpec = {
          dllPath: this._dllPath,
          netlist: this._materializeCir(),
          analysis: {
            kind: "ac",
            type: params.type,
            n: params.numPoints,
            fStart: params.fStart,
            fStop: params.fStop,
          },
        };
        const runResult = await runNgspiceGuarded(spec);
        const raw = runResult.acPoints ?? [];
        this._ngAcSession = buildAcCaptureSession(raw, emptyTopology());
        // Populate _nodeMap + _ngMatrixRowMap/_ngMatrixColMap so
        // acFirstDivergence's matrix walk can translate ngspice's external
        // (row, col) indices into our coordinate space. Without this the
        // matrix-class diff compares raw ngspice indices (which include the
        // CKTmaxEqNum-style +1 offset and ngspice-specific permutation)
        // against our raw indices, producing meaningless false positives.
        // Mirrors what runDcOp + runTransient do via the same helper.
        this._buildNodeMapping(runResult.ngspiceTopology);
        this._buildMatrixMaps();
        this._reindexNgAcSession();
      } catch (e: any) {
        this.errors.push(`ngspice AC sweep failed: ${e.message}`);
        this._ngAcSession = { source: "ngspice", topology: emptyTopology(), points: [] };
        this._ngAcSessionReindexed = this._ngAcSession;
      }
    } else if (this._opts.selfCompare) {
      // Self-compare: deep-clone our points as the ngspice side for zero-drift
      // unit-testing of the AC query surface (no DLL required). Matrix CSC
      // and RHS are also deep-cloned so the matrix-class divergence walk in
      // acFirstDivergence sees genuinely independent buffers- mutating one
      // side's matrix in a test must not leak into the other.
      this._ngAcSession = {
        source: "ngspice",
        topology: this._acSession.topology,
        points: this._acSession.points.map((p) => ({
          freq: p.freq,
          omega: p.omega,
          matrixSize: p.matrixSize,
          solRe: new Float64Array(p.solRe),
          solIm: new Float64Array(p.solIm),
          // Conditional spread: omit optional fields entirely when absent
          // (TS strict-optional distinguishes `T?` from `T | undefined`).
          ...(p.matrix && {
            matrix: {
              nnz: p.matrix.nnz,
              colPtr: new Int32Array(p.matrix.colPtr),
              rowIdx: new Int32Array(p.matrix.rowIdx),
              valsRe: new Float64Array(p.matrix.valsRe),
              valsIm: new Float64Array(p.matrix.valsIm),
            },
          }),
          ...(p.rhsRe && { rhsRe: new Float64Array(p.rhsRe) }),
          ...(p.rhsIm && { rhsIm: new Float64Array(p.rhsIm) }),
        })),
      };
      // selfCompare has no node-mapping (identity by construction). Solution
      // arrays are already in our coord space- the reindex would be a no-op,
      // so just point Reindexed at the raw session for downstream uniformity.
      this._ngAcSessionReindexed = this._ngAcSession;
    } else {
      this._ngAcSession = { source: "ngspice", topology: emptyTopology(), points: [] };
      this._ngAcSessionReindexed = this._ngAcSession;
    }

    this._hasRun = true;
  }

  /**
   * Run transient analysis on both engines.
   *
   * The boot step (stepStartTime=0) is already in _stepCapture from init().
   * The master-switch hook bundle was installed in init(), so the per-step loop
   * needs no hook rewiring. At the end, the master switch is released.
   */
  async runTransient(tStart: number, tStop: number, maxStep?: number): Promise<void> {
    this._ensureInited();
    if (this._hasRun) return;

    this._analysis = "tran";
    this._comparisons = null;
    this._structuralFindings = [];

    // ngspice CKTstep â†" our outputStep, ngspice CKTmaxStep â†" our maxTimeStep.
    // The two are independent ngspice .tran fields (TSTEP and TMAX) and govern
    // different things  see ngspice-bridge.ts runTran() for the cite. Earlier
    // versions of this harness sent `maxStep` as TSTEP and `tStop/100` as the
    // engine's outputStep, which silently desynced ngspice's `CKTstep`-driven
    // `delta = MIN(CKTfinalTime/100, CKTstep)/10` (dctran.c:118) from our
    // `firstStep = computeFirstStep(tStop, outputStep)`. The bug is invisible
    // when `tStop/100 == maxStep` (the MIN picks the same value either way)
    // and visible otherwise  most starkly on RLC where tStop/100=4e-5 but
    // maxStep=1e-6.
    const tstep = tStop / 100;
    const cfg: Partial<SimulationParams> = { tStop, outputStep: tstep, initTime: tStart };
    if (maxStep != null) cfg.maxTimeStep = maxStep;
    this._engine.configure(cfg);

    const stopStr = this._formatSpiceTime(tStop);
    const stepStr = this._formatSpiceTime(tstep);
    const tMaxStr = maxStep != null ? this._formatSpiceTime(maxStep) : undefined;

    const sc = this._stepCapture;
    let prevSimTime = 0;

    const maxSteps = this._opts.maxOurSteps ?? 5000;
    for (let s = 0; s < maxSteps; s++) {
      try {
        this._coordinator.step();
      } catch (e: any) {
        sc.endAttempt("finalFailure", false);
        sc.endStep({
          stepEndTime: this._engine.simTime ?? prevSimTime,
          integrationCoefficients: this._captureIntegCoeff(),
          analysisPhase: this._curAnalysisPhase(),
          acceptedAttemptIndex: -1,
          order: this._engine.integrationOrder,
          // Capture the dt USED for the failed step, not the next-dt.
          // _engine.currentDt was advanced to next-dt by computeNewDt
          // (analog-engine.ts:668); _engine.lastDt is the just-used value
          // (line 665). ngspice captures CKTdelta at the iteration moment,
          // which is the used-dt  match that.
          delta: this._engine.lastDt,
        });
        this.errors.push(`Our engine failed at step ${s}: ${e.message}`);
        break;
      }

      // Derive post-step time from the engine's accepted dt rather than
      // snapshotting simTime directly. `_engine.lastDt` is the dt that was
      // actually accepted by this step() call (see MNAEngine.step()  set
      // via `this._lastDt = dt` immediately before _timestep.accept()),
      // and `_engine.simTime` is updated at the end of step() to reflect
      // post-step committed time. Using `prevSimTime + lastDt` keeps this
      // robust to any pre/post-advance snapshot quirks in simTime and to
      // the engine entering an ERROR state where simTime does not advance.
      const acceptedDt = this._engine.lastDt;
      const nowTime = isFinite(acceptedDt) && acceptedDt > 0
        ? prevSimTime + acceptedDt
        : (this._engine.simTime ?? prevSimTime);
      if (nowTime > prevSimTime) {
        const lteDtValue = this._engine.getLteNextDt();
        const hasLte = isFinite(lteDtValue) && lteDtValue > 0;
        sc.endStep({
          stepEndTime: nowTime,
          integrationCoefficients: this._captureIntegCoeff(),
          analysisPhase: this._curAnalysisPhase(),
          acceptedAttemptIndex: -1,
          order: this._engine.integrationOrder,
          // Capture the dt USED for this step, not the next-dt.
          // _engine.currentDt was advanced to next-dt by computeNewDt
          // (analog-engine.ts:668); _engine.lastDt is the just-used value
          // (line 665). ngspice captures CKTdelta at the iteration moment,
          // which is the used-dt  match that. lteDt below carries the
          // next-step proposal separately.
          delta: this._engine.lastDt,
          ...(hasLte ? { lteDt: lteDtValue } : {}),
        });
        prevSimTime = nowTime;
      } else {
        // Engine did not advance (ERROR state or stalled). Commit whatever
        // the capture hook accumulated during this step() — a failed DC-OP
        // runs a full NR attempt ladder (direct → gmin → src stepping), and
        // those attempts sit in the pending buffer until endStep() closes
        // them. The catch-branch above already does this; without the same
        // call here the buffer is silently dropped and the comparison shows
        // `ours: []` even though the engine ran (and failed) identically to
        // ngspice. Break afterwards to avoid spinning the outer loop.
        sc.endStep({
          stepEndTime: this._engine.simTime ?? prevSimTime,
          integrationCoefficients: this._captureIntegCoeff(),
          analysisPhase: this._curAnalysisPhase(),
          acceptedAttemptIndex: -1,
          order: this._engine.integrationOrder,
          delta: this._engine.lastDt,
        });
        this.errors.push(
          `Our engine did not advance at step ${s} (simTime=${this._engine.simTime ?? "?"}, lastDt=${acceptedDt}).`,
        );
        break;
      }

      // ngspice dctran.c (v41) transient-loop termination: the run ends when
      // `CKTfinalTime - CKTtime < CKTminBreak`. v26 used the wider
      // `fabs(time - finalTime) < minBreak || AlmostEqualUlps(time, finalTime, 100)`.
      // The breakpoint clamp lands the final step exactly on tStop, so in the
      // common case both forms fire on the same step; the v41 form additionally
      // stops a step that lands just short of tStop (within minBreak).
      if (tStop - nowTime < this._engine.minBreak) break;
    }

    this._refreshOurTopologyAfterSetup();
    this._ourSession = {
      source: "ours",
      topology: this._ourTopology,
      steps: sc.getSteps(),
    };

    if (!this._opts.selfCompare && this._cirClean) {
      try {
        const spec: NgspiceJobSpec = {
          dllPath: this._dllPath,
          netlist: this._materializeCir(),
          analysis: {
            kind: "tran",
            tStop: stopStr,
            tStep: stepStr,
            ...(tMaxStr !== undefined ? { tMax: tMaxStr } : {}),
          },
        };
        const runResult = await runNgspiceGuarded(spec);
        this._ngSession = runResult.session ?? { source: "ngspice", topology: emptyTopology(), steps: [] };
        this._buildNodeMapping(runResult.ngspiceTopology);
      } catch (e: any) {
        this.errors.push(`ngspice transient failed: ${e.message}`);
        this._ngSession = { source: "ngspice", topology: emptyTopology(), steps: [] };
      }
    } else if (this._opts.selfCompare) {
      this._ngSession = deepCloneSession(this._ourSession, "ngspice");
      this._ngSessionReindexed = this._ngSession;
      this._nodeMap = buildIdentityNodeMap(this._ourSession);
    } else {
      this._ngSession = { source: "ngspice", topology: emptyTopology(), steps: [] };
    }

    if (!this._opts.selfCompare) {
      this._reindexNgSession();
    }

    this._facade.setCaptureHook(null);

    this._hasRun = true;
    this._assertMatrixStructuralParity();
  }

  // ---------------------------------------------------------------------------
  // Core query API
  // ---------------------------------------------------------------------------

  /**
   * Step-end values from both engines at the accepted attempt's final iteration.
   * Reports stepStartTime/stepEndTime; presence reflects which sides are present.
   *
   * When timeAlign=true (default for transient), treats stepIndex as our-side index,
   * computes t=ourStep.stepEndTime, and finds the nearest ngspice step by time.
   * When timeAlign=false (default for DC op), uses positional indexing (index=index).
   */
  getStepEnd(stepIndex: number, opts?: { timeAlign?: boolean }): StepEndReport {
    this._ensureRun();
    const timeAlign = opts?.timeAlign ?? (this._analysis === "tran");
    const ourStep = this._ourSession!.steps[stepIndex];

    let ngStepIndex = stepIndex;
    const ngAligned = this._ngSessionAligned();
    let ngStep = ngAligned?.steps[stepIndex];

    if (timeAlign && ourStep && ngAligned && ngAligned.steps.length > 0) {
      const t = ourStep.stepEndTime;
      const ngSteps = ngAligned.steps;
      let bestIdx = 0;
      let bestDelta = Math.abs(ngSteps[0].stepEndTime - t);
      for (let i = 1; i < ngSteps.length; i++) {
        const d = Math.abs(ngSteps[i].stepEndTime - t);
        if (d < bestDelta) {
          bestDelta = d;
          bestIdx = i;
        }
      }
      ngStepIndex = bestIdx;
      ngStep = ngSteps[bestIdx];
    }

    if (!ourStep && !ngStep) {
      throw new Error(`Step out of range: ${stepIndex}`);
    }

    // ngspice-only step: ours is absent, return ngspice data with null ours values
    if (!ourStep && ngStep) {
      const presence = this._stepPresence(stepIndex);
      const nodes: Record<string, ComparedValue> = {};
      const branches: Record<string, ComparedValue> = {};
      const components: Record<string, StepEndComponentEntry> = {};

      const ngAccIdx = ngStep.acceptedAttemptIndex >= 0 ? ngStep.acceptedAttemptIndex : ngStep.attempts.length - 1;
      const ngAccepted = ngStep.attempts[ngAccIdx];
      const ngFinal = ngAccepted
        ? ngAccepted.iterations[ngAccepted.iterations.length - 1]
        : ngStep.iterations[ngStep.iterations.length - 1];

      if (ngFinal) {
        this._ourTopology.nodeLabels.forEach((label, nodeId) => {
          const ngV = nodeId > 0 && nodeId < ngFinal.voltages.length
            ? ngFinal.voltages[nodeId] : NaN;
          nodes[label] = makeComparedValue(NaN, ngV);
        });

        this._ourTopology.matrixRowLabels.forEach((label, row) => {
          if (row < this._ourTopology.nodeCount) return;
          const ourV = NaN;
          const ngV = row < ngFinal.voltages.length ? ngFinal.voltages[row] : NaN;
          branches[label] = makeComparedValue(ourV, ngV);
        });
      }

      return {
        stepIndex,
        ourStepIndex: -1,
        ngspiceStepIndex: ngStepIndex,
        presence,
        stepStartTime: makeComparedValue(NaN, ngStep.stepStartTime),
        stepEndTime: makeComparedValue(NaN, ngStep.stepEndTime),
        dt: makeComparedValue(NaN, ngStep.dt),
        converged: { ours: false, ngspice: ngStep.converged },
        iterationCount: makeComparedValue(NaN, ngStep.iterationCount),
        nodes,
        branches,
        components,
      };
    }
    const presence = this._stepPresence(stepIndex);

    // Accepted attempt final iteration (spec Âss9.3)
    const ourAccIdx = ourStep.acceptedAttemptIndex >= 0 && ourStep.acceptedAttemptIndex < ourStep.attempts.length
      ? ourStep.acceptedAttemptIndex
      : ourStep.attempts.length - 1;
    const ourAccepted = ourStep.attempts[ourAccIdx];
    const ourFinal = ourAccepted
      ? ourAccepted.iterations[ourAccepted.iterations.length - 1]
      : ourStep.iterations[ourStep.iterations.length - 1];

    const ngAccIdx = ngStep
      ? (ngStep.acceptedAttemptIndex >= 0 ? ngStep.acceptedAttemptIndex : ngStep.attempts.length - 1)
      : -1;
    const ngAccepted = ngStep?.attempts[ngAccIdx];
    const ngFinal = ngAccepted
      ? ngAccepted.iterations[ngAccepted.iterations.length - 1]
      : ngStep?.iterations[ngStep.iterations.length - 1];

    const nodes: Record<string, ComparedValue> = {};
    const branches: Record<string, ComparedValue> = {};
    const components: Record<string, StepEndComponentEntry> = {};

    if (ourFinal) {
      this._ourTopology.nodeLabels.forEach((label, nodeId) => {
        const ourV = nodeId > 0 && nodeId - 1 < ourFinal.voltages.length
          ? ourFinal.voltages[nodeId] : 0;
        const ngV = ngFinal && nodeId > 0 && nodeId - 1 < ngFinal.voltages.length
          ? ngFinal.voltages[nodeId] : NaN;
        nodes[label] = makeComparedValue(ourV, ngV);
      });

      this._ourTopology.matrixRowLabels.forEach((label, row) => {
        if (row < this._ourTopology.nodeCount) return;
        const ourV = ourFinal && row < ourFinal.voltages.length ? ourFinal.voltages[row] : NaN;
        const ngV = ngFinal && row < ngFinal.voltages.length ? ngFinal.voltages[row] : NaN;
        branches[label] = makeComparedValue(ourV, ngV);
      });

      for (const es of ourFinal.elementStates) {
        const ngEs = ngFinal?.elementStates.find(
          e => e.label.toUpperCase() === es.label.toUpperCase());
        const slots: Record<string, ComparedValue> = {};
        for (const [slot, value] of Object.entries(es.slots)) {
          const ngValue = ngEs?.slots[slot] ?? NaN;
          slots[slot] = makeComparedValue(value, ngValue);
        }
        const pinCurrents: Record<string, ComparedValue> = {};
        for (const [pin, value] of Object.entries(es.pinCurrents)) {
          const ngValue = ngEs?.pinCurrents[pin] ?? NaN;
          pinCurrents[pin] = makeComparedValue(value, ngValue);
        }
        const topoEl = this._ourTopology.elements.find(
          el => el.label.toUpperCase() === es.label.toUpperCase());
        components[es.label] = { deviceType: topoEl?.type ?? "unknown", slots, pinCurrents };
      }
    }

    const ourSST = ourStep.stepStartTime;
    const ourSET = ourStep.stepEndTime;
    const ngSST = ngStep?.stepStartTime ?? NaN;
    const ngSET = ngStep?.stepEndTime ?? NaN;

    return {
      stepIndex,
      ourStepIndex: stepIndex,
      ngspiceStepIndex: ngStepIndex,
      presence,
      stepStartTime: makeComparedValue(ourSST, ngSST),
      stepEndTime: makeComparedValue(ourSET, ngSET),
      dt: makeComparedValue(ourStep.dt, ngStep?.dt ?? NaN),
      converged: { ours: ourStep.converged, ngspice: ngStep?.converged ?? false },
      iterationCount: makeComparedValue(ourStep.iterationCount, ngStep?.iterationCount ?? NaN),
      nodes,
      branches,
      components,
    };
  }

  /**
   * Per-iteration data for a step  uses accepted attempt iterations (spec Âss9.2).
   */
  getIterations(stepIndex: number): IterationReport[] {
    this._ensureRun();
    const ourStep = this._ourSession!.steps[stepIndex] ?? null;

    const ngStep = this._ngSessionAligned()?.steps[stepIndex];

    if (!ourStep && !ngStep) return [];

    // Accepted attempt iterations
    const ourAccIdx = ourStep
      ? (ourStep.acceptedAttemptIndex >= 0 ? ourStep.acceptedAttemptIndex : ourStep.attempts.length - 1)
      : -1;
    const ourIters = ourStep
      ? (ourStep.attempts[ourAccIdx]?.iterations ?? ourStep.iterations)
      : [];

    const ngAccIdx = ngStep
      ? (ngStep.acceptedAttemptIndex >= 0 ? ngStep.acceptedAttemptIndex : ngStep.attempts.length - 1)
      : -1;
    const ngIters = ngStep?.attempts[ngAccIdx]?.iterations ?? ngStep?.iterations ?? [];

    const reports: IterationReport[] = [];
    const compResults = this._getComparisons();

    for (let ii = 0; ii < Math.max(ourIters.length, ngIters.length); ii++) {
      const ourIter = ourIters[ii];
      const ngIter = ngIters[ii];

      const nodes: Record<string, ComparedValue> = {};
      const rhs: Record<string, ComparedValue> = {};
      const comps: Record<string, Record<string, ComparedValue>> = {};

      if (ourIter) {
        this._ourTopology.nodeLabels.forEach((label, nodeId) => {
          const ourV = nodeId > 0 && nodeId < ourIter.voltages.length
            ? ourIter.voltages[nodeId] : 0;
          const ngV = ngIter && nodeId > 0 && nodeId < ngIter.voltages.length
            ? ngIter.voltages[nodeId] : NaN;
          nodes[label] = makeComparedValue(ourV, ngV);
        });

        this._ourTopology.matrixRowLabels.forEach((label, row) => {
          if (row < this._ourTopology.nodeCount) return;
          const ourV = row < ourIter.voltages.length ? ourIter.voltages[row] : NaN;
          const ngV = ngIter && row < ngIter.voltages.length ? ngIter.voltages[row] : NaN;
          rhs[label] = makeComparedValue(ourV, ngV);
        });

        if (ourIter.preSolveRhs.length > 0) {
          this._ourTopology.nodeLabels.forEach((label, nodeId) => {
            const ourR = nodeId > 0 && nodeId < ourIter.preSolveRhs.length
              ? ourIter.preSolveRhs[nodeId] : 0;
            const ngR = ngIter?.preSolveRhs && nodeId > 0 && nodeId < ngIter.preSolveRhs.length
              ? ngIter.preSolveRhs[nodeId] : NaN;
            rhs[label] = makeComparedValue(ourR, ngR);
          });
        }

        for (const es of ourIter.elementStates) {
          const ngEs = ngIter?.elementStates.find(
            e => e.label.toUpperCase() === es.label.toUpperCase());
          const comp: Record<string, ComparedValue> = {};
          for (const [slot, value] of Object.entries(es.slots)) {
            const ngValue = ngEs?.slots[slot] ?? NaN;
            comp[slot] = makeComparedValue(value, ngValue);
          }
          comps[es.label] = comp;
        }
      }

      const compResult = compResults.find(
        c => c.stepIndex === stepIndex && c.iterationIndex === ii);
      const matrixDiffs = (compResult?.matrixDiffs ?? []).map(d => ({
        row: d.row, col: d.col, ours: d.ours, ngspice: d.theirs, absDelta: d.absDelta,
      }));

      // per-element convergence
      const perElementConvergence: IterationReport["perElementConvergence"] = [];
      if (ourIter) {
        for (const es of ourIter.elementStates) {
          const topoEl = this._ourTopology.elements.find(
            el => el.label.toUpperCase() === es.label.toUpperCase());
          const isFailed = ourIter.convergenceFailedElements.includes(es.label);
          perElementConvergence.push({
            label: es.label,
            deviceType: topoEl?.type ?? "unknown",
            converged: !isFailed,
            worstDelta: 0,
          });
        }
      }

      reports.push({
        stepIndex,
        iteration: ii,
        stepStartTime: ourStep?.stepStartTime ?? ngStep?.stepStartTime ?? 0,
        noncon: makeComparedValue(ourIter?.noncon ?? 0, ngIter?.noncon ?? NaN),
        nodes,
        rhs,
        matrixDiffs,
        components: comps,
        perElementConvergence,
      });
    }

    return reports;
  }

  // ---------------------------------------------------------------------------
  // Discovery methods
  // ---------------------------------------------------------------------------

  listComponents(opts?: PaginationOpts): ComponentInfo[] {
    const result: ComponentInfo[] = this._ourTopology.elements.map(el => {
      // Slot names from first available step's last accepted iteration
      let slotNames: string[] = [];
      let pinLabels: string[] = [];
      if (this._ourSession && this._ourSession.steps.length > 0) {
        const step = this._ourSession.steps[0];
        const accIdx = step.acceptedAttemptIndex >= 0 ? step.acceptedAttemptIndex : step.attempts.length - 1;
        const iters = step.attempts[accIdx]?.iterations ?? step.iterations;
        const lastIter = iters[iters.length - 1];
        const es = lastIter?.elementStates.find(
          e => e.label.toUpperCase() === el.label.toUpperCase());
        if (es) slotNames = Object.keys(es.slots);
      }
      // Pin labels from topology
      this._ourTopology.nodeLabels.forEach((nodeLabel, nodeId) => {
        if (el.pinNodeIds.includes(nodeId)) pinLabels.push(nodeLabel);
      });
      return {
        label: el.label,
        deviceType: el.type,
        slotNames,
        pinLabels,
      };
    });
    return applyPagination(result, opts);
  }

  listNodes(opts?: PaginationOpts): NodeInfo[] {
    const result: NodeInfo[] = [];
    this._ourTopology.nodeLabels.forEach((label, nodeId) => {
      const mapping = this._nodeMap.find(m => m.ourIndex === nodeId);
      // connected components: elements that have this nodeId in their pinNodeIds
      const connected = this._ourTopology.elements
        .filter(el => el.pinNodeIds.includes(nodeId))
        .map(el => el.label);
      result.push({
        label,
        ourIndex: nodeId,
        ngspiceIndex: mapping?.ngspiceIndex ?? -1,
        connectedComponents: connected,
      });
    });
    return applyPagination(result, opts);
  }

  getComponentsByType(type: string): ComponentInfo[] {
    const lType = type.toLowerCase();
    return this._ourTopology.elements
      .filter(el => el.type.toLowerCase() === lType)
      .map(el => ({ label: el.label, deviceType: el.type, slotNames: [], pinLabels: [] }));
  }

  // ---------------------------------------------------------------------------
  // Divergence report
  // ---------------------------------------------------------------------------

  getDivergences(opts?: { step?: number; limit?: number }): DivergenceReport {
    this._ensureRun();
    const comparisons = this._getComparisons();
    const maxEntries = opts?.limit ?? 100;
    const filterStep = opts?.step;

    const allEntries: DivergenceEntry[] = [];

    for (const comp of comparisons) {
      if (filterStep !== undefined && comp.stepIndex !== filterStep) continue;

      const step = this._ourSession!.steps[comp.stepIndex];
      const stepStartTime = step?.stepStartTime ?? 0;
      const presence = comp.presence;

      for (const diff of comp.voltageDiffs) {
        if (diff.withinTol) continue;
        allEntries.push({
          stepIndex: comp.stepIndex,
          iteration: comp.iterationIndex,
          stepStartTime,
          category: "voltage",
          label: diff.label,
          ours: diff.ours,
          ngspice: diff.theirs,
          absDelta: diff.absDelta,
          relDelta: diff.relDelta,
          withinTol: diff.withinTol,
          componentLabel: null,
          slotName: null,
          presence,
        });
      }

      for (const diff of comp.stateDiffs) {
        if (diff.withinTol) continue;
        allEntries.push({
          stepIndex: comp.stepIndex,
          iteration: comp.iterationIndex,
          stepStartTime,
          category: "state",
          label: diff.slotName,
          ours: diff.ours,
          ngspice: diff.theirs,
          absDelta: diff.absDelta,
          relDelta: Math.abs(diff.ours - diff.theirs) / Math.max(Math.abs(diff.ours), Math.abs(diff.theirs), 1e-30),
          withinTol: diff.withinTol,
          componentLabel: diff.elementLabel,
          slotName: diff.slotName,
          presence,
        });
      }

      for (const diff of comp.rhsDiffs) {
        if (diff.withinTol) continue;
        allEntries.push({
          stepIndex: comp.stepIndex,
          iteration: comp.iterationIndex,
          stepStartTime,
          category: "rhs",
          label: `rhs[${diff.index}]`,
          ours: diff.ours,
          ngspice: diff.theirs,
          absDelta: diff.absDelta,
          relDelta: Math.abs(diff.ours - diff.theirs) / Math.max(Math.abs(diff.ours), Math.abs(diff.theirs), 1e-30),
          withinTol: diff.withinTol,
          componentLabel: null,
          slotName: null,
          presence,
        });
      }

      for (const diff of comp.matrixDiffs) {
        if (diff.withinTol) continue;
        allEntries.push({
          stepIndex: comp.stepIndex,
          iteration: comp.iterationIndex,
          stepStartTime,
          category: "matrix",
          label: `M[${diff.row},${diff.col}]`,
          ours: diff.ours,
          ngspice: diff.theirs,
          absDelta: diff.absDelta,
          relDelta: Math.abs(diff.ours - diff.theirs) / Math.max(Math.abs(diff.ours), Math.abs(diff.theirs), 1e-30),
          withinTol: diff.withinTol,
          componentLabel: null,
          slotName: null,
          presence,
        });
      }
    }

    // Shape divergences (appear after value entries)
    const sessionShape = this.getSessionShape();
    for (const shape of sessionShape.steps) {
      if (filterStep !== undefined && shape.stepIndex !== filterStep) continue;
      const isShapeDivergence =
        shape.presence !== "both"
        || (shape.attemptCounts.ours?.total ?? 0) !== (shape.attemptCounts.ngspice?.total ?? 0);
      if (!isShapeDivergence) continue;

      const ourStep = this._ourSession?.steps[shape.stepIndex];
      const ngStep = this._ngSessionAligned()?.steps[shape.stepIndex];
      const stepStartTime = ourStep?.stepStartTime ?? ngStep?.stepStartTime ?? 0;
      const ourTotal = shape.attemptCounts.ours?.total ?? 0;
      const ngTotal = shape.attemptCounts.ngspice?.total ?? 0;
      const absDelta = Math.abs(ourTotal - ngTotal);

      allEntries.push({
        stepIndex: shape.stepIndex,
        iteration: -1,
        stepStartTime,
        category: "shape",
        label: `step_shape[${shape.stepIndex}]`,
        ours: ourTotal,
        ngspice: ngTotal,
        absDelta,
        relDelta: 0,
        withinTol: false,
        componentLabel: null,
        slotName: null,
        presence: shape.presence,
      });
    }

    const totalCount = allEntries.length;

    const categories: DivergenceCategory[] = ["voltage", "state", "rhs", "matrix", "shape"];
    const worstByCategory: DivergenceReport["worstByCategory"] = {
      voltage: null, state: null, rhs: null, matrix: null, shape: null,
    };
    for (const cat of categories) {
      const inCat = allEntries.filter(e => e.category === cat);
      if (inCat.length > 0) {
        worstByCategory[cat] = inCat.reduce((best, e) =>
          e.absDelta > best.absDelta ? e : best, inCat[0]);
      }
    }

    return {
      totalCount,
      worstByCategory,
      entries: allEntries.slice(0, maxEntries),
    };
  }

  // ---------------------------------------------------------------------------
  // Shape API
  // ---------------------------------------------------------------------------

  getSessionShape(): SessionShape {
    this._ensureRun();
    const oursLen = this._ourSession!.steps.length;
    const ngLen   = this._ngSessionAligned()?.steps.length ?? 0;
    const max     = Math.max(oursLen, ngLen);

    const steps: StepShape[] = [];
    const presenceCounts = { both: 0, oursOnly: 0, ngspiceOnly: 0 };
    const largeTimeDeltas: Array<{ stepIndex: number; delta: number }> = [];

    for (let i = 0; i < max; i++) {
      const shape = this.getStepShape(i);
      steps.push(shape);
      presenceCounts[shape.presence]++;
      if (shape.stepStartTimeDelta !== null && shape.stepStartTimeDelta !== 0) {
        largeTimeDeltas.push({ stepIndex: i, delta: shape.stepStartTimeDelta });
      }
    }

    return {
      analysis: this._analysis === "tran" ? "tran" : "dcop",
      stepCount: { ours: oursLen, ngspice: ngLen, max },
      presenceCounts,
      steps,
      largeTimeDeltas,
    };
  }

  getStepShape(stepIndex: number): StepShape {
    this._ensureRun();
    const ours = this._ourSession!.steps[stepIndex];
    const ng   = this._ngSessionAligned()?.steps[stepIndex];
    if (!ours && !ng) {
      throw new Error(`getStepShape: step ${stepIndex} out of range on both sides`);
    }
    const presence: SidePresence =
      ours && ng ? "both" : ours ? "oursOnly" : "ngspiceOnly";

    const summarize = (s: typeof ours | undefined): AttemptShapeSummary[] | null =>
      s ? s.attempts.map(a => ({
        phase: a.phase,
        outcome: a.outcome,
        dt: a.dt,
        iterationCount: a.iterationCount,
        converged: a.converged,
      })) : null;

    const counts = (s: typeof ours | undefined): AttemptCounts | null => {
      if (!s) return null;
      const byPhase: Partial<Record<NRPhase, number>> = {};
      const byOutcome: Partial<Record<NRAttemptOutcome, number>> = {};
      for (const a of s.attempts) {
        byPhase[a.phase] = (byPhase[a.phase] ?? 0) + 1;
        byOutcome[a.outcome] = (byOutcome[a.outcome] ?? 0) + 1;
      }
      return { byPhase, byOutcome, total: s.attempts.length };
    };

    return {
      stepIndex,
      presence,
      stepStartTime: { ours: ours?.stepStartTime ?? null, ngspice: ng?.stepStartTime ?? null },
      stepEndTime:   { ours: ours?.stepEndTime   ?? null, ngspice: ng?.stepEndTime   ?? null },
      stepStartTimeDelta: this._stepStartTimeDelta(stepIndex),
      attemptCounts: { ours: counts(ours), ngspice: counts(ng) },
      attempts: { ours: summarize(ours), ngspice: summarize(ng) },
      integrationMethod: {
        ours: ours?.integrationCoefficients.ours.method ?? null,
        ngspice: (ng?.integrationCoefficients.ngspice.method ?? null) as IntegrationMethod | null,
      },
    };
  }

  getStepAtTime(t: number, side: Side = "ours"): number | null {
    this._ensureRun();
    const steps = (side === "ours"
      ? this._ourSession!.steps
      : this._ngSessionAligned()?.steps) ?? [];
    if (steps.length === 0) return null;

    if (t === 0) {
      for (let i = 0; i < steps.length; i++) {
        if (steps[i].stepStartTime === 0 && steps[i].stepEndTime === 0) return i;
      }
    }

    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (s.stepStartTime <= t && t < s.stepEndTime) return i;
    }
    const last = steps[steps.length - 1];
    if (t === last.stepEndTime) return steps.length - 1;
    return null;
  }

  // ---------------------------------------------------------------------------
  // Paired session-shape API (sessionMap / getStep / getAttempt)
  // ---------------------------------------------------------------------------

  sessionMap(): SessionMap {
    this._ensureRun();
    const shape = (session: CaptureSession | null): { stepCount: number; steps: StepShapeRow[] } => {
      if (!session) return { stepCount: 0, steps: [] };
      const steps: StepShapeRow[] = session.steps.map((step, i) => ({
        index: i,
        stepStartTime: step.stepStartTime,
        stepEndTime: step.stepEndTime,
        converged: step.converged,
        iterationCount: step.iterationCount,
        totalIterationCount: step.totalIterationCount ?? step.iterationCount,
        analysisPhase: step.analysisPhase,
        attempts: step.attempts.map((a, ai): AttemptShapeRow => ({
          index: ai,
          phase: a.phase,
          outcome: a.outcome,
          iterationCount: a.iterationCount,
          ...(a.phaseParameter !== undefined ? { phaseParameter: a.phaseParameter } : {}),
          accepted: ai === step.acceptedAttemptIndex,
        })),
      }));
      return { stepCount: steps.length, steps };
    };
    return {
      analysis: this._analysis === "tran" ? "tran" : "dcop",
      ours: shape(this._ourSession),
      ngspice: shape(this._ngSessionAligned()),
    };
  }

  getStep(query: StepQuery): StepDetail {
    this._ensureRun();

    let ourStepIndex: number;
    let ngStepIndex: number;

    const ngAligned = this._ngSessionAligned();

    if ("index" in query) {
      ourStepIndex = query.index;
      ngStepIndex = query.index;
      if (ngAligned && ngAligned.steps.length > 0) {
        const ourStep = this._ourSession?.steps[query.index];
        if (ourStep && this._analysis === "tran") {
          const t = ourStep.stepEndTime;
          const ngSteps = ngAligned.steps;
          let bestIdx = 0;
          let bestDelta = Math.abs(ngSteps[0].stepEndTime - t);
          for (let i = 1; i < ngSteps.length; i++) {
            const d = Math.abs(ngSteps[i].stepEndTime - t);
            if (d < bestDelta) { bestDelta = d; bestIdx = i; }
          }
          ngStepIndex = bestIdx;
        }
      }
    } else {
      const side = query.side ?? "ours";
      const steps = side === "ours"
        ? this._ourSession?.steps ?? []
        : ngAligned?.steps ?? [];
      let bestIdx = 0;
      let bestDelta = Infinity;
      for (let i = 0; i < steps.length; i++) {
        const d = Math.abs(steps[i].stepEndTime - query.time);
        if (d < bestDelta) { bestDelta = d; bestIdx = i; }
      }
      if (side === "ours") {
        ourStepIndex = bestIdx;
        ngStepIndex = bestIdx;
        if (ngAligned && ngAligned.steps.length > 0) {
          const ourStep = this._ourSession?.steps[bestIdx];
          if (ourStep) {
            const t = ourStep.stepEndTime;
            const ngSteps = ngAligned.steps;
            let ni = 0; let nd = Infinity;
            for (let i = 0; i < ngSteps.length; i++) {
              const d = Math.abs(ngSteps[i].stepEndTime - t);
              if (d < nd) { nd = d; ni = i; }
            }
            ngStepIndex = ni;
          }
        }
      } else {
        ngStepIndex = bestIdx;
        ourStepIndex = bestIdx;
      }
    }

    const ourStep = this._ourSession?.steps[ourStepIndex] ?? null;
    const ngStep = ngAligned?.steps[ngStepIndex] ?? null;

    if (!ourStep && !ngStep) {
      throw new Error(`getStep: step index out of range`);
    }

    const matrixSize = this._ourTopology.matrixSize;
    const nodeCount = this._ourTopology.nodeCount;

    const ourAttempts: AttemptSummary[] = ourStep
      ? ourStep.attempts.map((_, ai) => this._summariseAttempt(ourStep, ai, matrixSize, nodeCount))
      : [];
    const ngAttempts: AttemptSummary[] = ngStep
      ? ngStep.attempts.map((_, ai) => this._summariseAttempt(ngStep, ai, matrixSize, nodeCount))
      : [];

    const pairing = this._pairAttemptsByPhase(
      ourStep?.attempts ?? [],
      ngStep?.attempts ?? [],
      nodeCount,
    );

    const ourSST = ourStep?.stepStartTime ?? NaN;
    const ourSET = ourStep?.stepEndTime ?? NaN;
    const ngSST = ngStep?.stepStartTime ?? NaN;
    const ngSET = ngStep?.stepEndTime ?? NaN;

    return {
      stepIndex: "index" in query ? query.index : ourStepIndex,
      ourStepIndex,
      ngspiceStepIndex: ngStepIndex,
      stepStartTime: makeComparedValue(ourSST, ngSST),
      stepEndTime: makeComparedValue(ourSET, ngSET),
      dt: makeComparedValue(ourStep?.dt ?? NaN, ngStep?.dt ?? NaN),
      ours: ourAttempts,
      ngspice: ngAttempts,
      pairing,
    };
  }

  getAttempt(query: AttemptQuery): AttemptDetail {
    this._ensureRun();

    const ngAligned = this._ngSessionAligned();
    const ourStep = this._ourSession?.steps[query.stepIndex] ?? null;

    let ngStepIndex = query.stepIndex;
    if (ngAligned && ngAligned.steps.length > 0 && ourStep && this._analysis === "tran") {
      const t = ourStep.stepEndTime;
      const ngSteps = ngAligned.steps;
      let bestIdx = 0;
      let bestDelta = Math.abs(ngSteps[0].stepEndTime - t);
      for (let i = 1; i < ngSteps.length; i++) {
        const d = Math.abs(ngSteps[i].stepEndTime - t);
        if (d < bestDelta) { bestDelta = d; bestIdx = i; }
      }
      ngStepIndex = bestIdx;
    }
    const ngStep = ngAligned?.steps[ngStepIndex] ?? null;

    const matrixSize = this._ourTopology.matrixSize;
    const nodeCount = this._ourTopology.nodeCount;

    // Filter attempts by phase on each side, then pick by phaseAttemptIndex
    const ourPhaseAtts = (ourStep?.attempts ?? []).filter(a => a.phase === query.phase);
    const ngPhaseAtts  = (ngStep?.attempts ?? []).filter(a => a.phase === query.phase);

    const ourAtt = ourPhaseAtts[query.phaseAttemptIndex] ?? null;
    const ngAtt  = ngPhaseAtts[query.phaseAttemptIndex] ?? null;

    // Find absolute indices in the step.attempts array
    const ourAbsIdx = ourAtt ? (ourStep?.attempts ?? []).indexOf(ourAtt) : -1;
    const ngAbsIdx  = ngAtt  ? (ngStep?.attempts ?? []).indexOf(ngAtt) : -1;

    const ourAttSummary = ourAtt && ourStep
      ? this._summariseAttempt(ourStep, ourAbsIdx, matrixSize, nodeCount)
      : null;
    const ngAttSummary = ngAtt && ngStep
      ? this._summariseAttempt(ngStep, ngAbsIdx, matrixSize, nodeCount)
      : null;

    const ourIters = ourAtt?.iterations ?? [];
    const ngIters  = ngAtt?.iterations ?? [];

    const totalIters = Math.max(ourIters.length, ngIters.length);
    let iterRange: [number, number] = [0, totalIters - 1];
    if (query.iterationRange) {
      iterRange = [query.iterationRange[0], Math.min(query.iterationRange[1], totalIters - 1)];
    }

    const allPaired: PairedIteration[] = [];
    for (let ii = iterRange[0]; ii <= iterRange[1]; ii++) {
      const ourIter = ourIters[ii] ?? null;
      const ngIter  = ngIters[ii] ?? null;

      // Per-side densification. The session-level
      // structural-parity gate (_assertMatrixStructuralParity, called at the
      // end of runDcOp/runTransient) hard-fails on any matrixSize divergence,
      // so by the time this code runs in a non-failing session, both sides
      // already match. When the gate has fired, the per-side dimensions here
      // let post-mortem callers (error logs, harness_get_attempt diagnostics)
      // see what each engine actually built- not a forced common slice.
      const ourLinSys = ourIter ? _computeLinearSystemData(ourIter, ourIter.matrixSize) : null;
      const ourData: IterationSideData | null = ourIter ? {
        rawIteration: ourIter.iteration,
        globalConverged: ourIter.globalConverged,
        elemConverged: ourIter.elemConverged,
        noncon: ourIter.noncon,
        convergenceFailedElements: [...ourIter.convergenceFailedElements],
        nodeVoltages: this._buildNodeVoltages(ourIter.voltages),
        nodeVoltagesBefore: this._buildNodeVoltages(ourIter.prevVoltages),
        branchValues: this._buildBranchValues(ourIter.voltages, nodeCount),
        elementStates: Object.fromEntries(
          ourIter.elementStates.map(es => [es.label, es.slots]),
        ),
        elementStates1Slots: Object.fromEntries(
          ourIter.elementStates.map(es => [es.label, es.state1Slots]),
        ),
        elementStates2Slots: Object.fromEntries(
          ourIter.elementStates.map(es => [es.label, es.state2Slots]),
        ),
        elementStates3Slots: Object.fromEntries(
          ourIter.elementStates.map(es => [es.label, es.state3Slots]),
        ),
        pinCurrents: Object.fromEntries(
          ourIter.elementStates.map(es => [es.label, es.pinCurrents]),
        ),
        limitingEvents: ourIter.limitingEvents,
        rhs: ourLinSys!.rhs,
        residual: ourLinSys!.residual,
        residualInfinityNorm: ourLinSys!.residualInfinityNorm,
        matrix: ourLinSys!.matrix,
        // Per-iteration integration state (length-7 ag[] snapshot + method/order)
        // lets consumers discriminate H1 vs H2 vs H3 capacitor integration across
        // the same NR attempt. See IterationSnapshot.ag for the copy-on-write rule.
        ag: Array.from(ourIter.ag),
        method: ourIter.method,
        order: ourIter.order,
        matrixSize: ourIter.matrixSize,
        rhsBufSize: ourIter.rhsBufSize,
        initMode: ourIter.initMode,
        delta: ourIter.delta,
        diagGmin: ourIter.diagGmin,
        srcFact: ourIter.srcFact,
        ...(ourIter.lteDt !== undefined ? { lteDt: ourIter.lteDt } : {}),
      } : null;

      const ngLinSys = ngIter ? _computeLinearSystemData(ngIter, ngIter.matrixSize) : null;
      const ngData: IterationSideData | null = ngIter ? {
        rawIteration: ngIter.iteration,
        globalConverged: ngIter.globalConverged,
        elemConverged: ngIter.elemConverged,
        noncon: ngIter.noncon,
        convergenceFailedElements: [...ngIter.convergenceFailedElements],
        ngspiceConvergenceFailedDevices: [...ngIter.ngspiceConvergenceFailedDevices],
        nodeVoltages: this._buildNodeVoltages(ngIter.voltages),
        nodeVoltagesBefore: this._buildNodeVoltages(ngIter.prevVoltages),
        branchValues: this._buildBranchValues(ngIter.voltages, nodeCount),
        elementStates: Object.fromEntries(
          ngIter.elementStates.map(es => [es.label, es.slots]),
        ),
        elementStates1Slots: Object.fromEntries(
          ngIter.elementStates.map(es => [es.label, es.state1Slots]),
        ),
        elementStates2Slots: Object.fromEntries(
          ngIter.elementStates.map(es => [es.label, es.state2Slots]),
        ),
        elementStates3Slots: Object.fromEntries(
          ngIter.elementStates.map(es => [es.label, es.state3Slots]),
        ),
        pinCurrents: Object.fromEntries(
          ngIter.elementStates.map(es => [es.label, es.pinCurrents]),
        ),
        limitingEvents: ngIter.limitingEvents,
        rhs: ngLinSys!.rhs,
        residual: ngLinSys!.residual,
        residualInfinityNorm: ngLinSys!.residualInfinityNorm,
        matrix: ngLinSys!.matrix,
        // Only slots 0/1 carry ngspice's ag0/ag1 (FFI marshals two doubles);
        // remaining slots are 0. See ngspice-bridge.ts for the widening code.
        ag: Array.from(ngIter.ag),
        method: ngIter.method,
        order: ngIter.order,
        matrixSize: ngIter.matrixSize,
        rhsBufSize: ngIter.rhsBufSize,
        initMode: ngIter.initMode,
        delta: ngIter.delta,
        diagGmin: ngIter.diagGmin,
        srcFact: ngIter.srcFact,
        ...(ngIter.lteDt !== undefined ? { lteDt: ngIter.lteDt } : {}),
      } : null;

      const divergenceNorm = _l1NormDiff(
        ourIter?.voltages, ngIter?.voltages, 0, nodeCount,
      );

      allPaired.push({ iterationIndex: ii - iterRange[0], ours: ourData, ngspice: ngData, divergenceNorm });
    }

    // Apply offset/limit pagination
    const offset = query.offset ?? 0;
    const limit  = query.limit ?? allPaired.length;
    const iterations = allPaired.slice(offset, offset + limit);

    return {
      stepIndex: query.stepIndex,
      phase: query.phase,
      phaseAttemptIndex: query.phaseAttemptIndex,
      ourAttempt: ourAttSummary,
      ngspiceAttempt: ngAttSummary,
      iterations,
    };
  }

  private _buildNodeVoltages(rhs: Float64Array): Record<string, number> {
    const result: Record<string, number> = {};
    this._ourTopology.nodeLabels.forEach((label, nodeId) => {
      if (nodeId > 0 && nodeId - 1 < rhs.length) {
        result[label] = rhs[nodeId];
      }
    });
    return result;
  }

  private _buildBranchValues(rhs: Float64Array, nodeCount: number): Record<string, number> {
    const result: Record<string, number> = {};
    // matrixRowLabels uses 0-based matrix-row indexing (node N occupies row N-1);
    // the voltages buffer is sized matrixSize+1 with a ground sentinel at slot 0,
    // so matrix row R corresponds to voltages slot R+1. _buildNodeVoltages reads
    // rhs[nodeId] which already happens to equal rhs[row+1] for nodes; mirror
    // that here so branch rows index the right voltages slot.
    this._ourTopology.matrixRowLabels.forEach((label, row) => {
      const slot = row + 1;
      if (row >= nodeCount && slot < rhs.length) {
        result[label] = rhs[slot];
      }
    });
    return result;
  }

  private _summariseAttempt(
    step: StepSnapshot,
    attemptIndex: number,
    matrixSize: number,
    nodeCount: number,
  ): AttemptSummary {
    const att = step.attempts[attemptIndex];
    const lastIter = att.iterations[att.iterations.length - 1];
    return {
      index: attemptIndex,
      phase: att.phase,
      ...(att.role !== undefined ? { role: att.role } : {}),
      outcome: att.outcome,
      iterationCount: att.iterationCount,
      ...(att.phaseParameter !== undefined ? { phaseParameter: att.phaseParameter } : {}),
      accepted: attemptIndex === step.acceptedAttemptIndex,
      endNodeNorm: _vectorL2(lastIter?.voltages, 0, nodeCount),
      endBranchNorm: _vectorL2(lastIter?.voltages, nodeCount, matrixSize),
    };
  }

  private _pairAttemptsByPhase(
    ourAtts: NRAttempt[],
    ngAtts: NRAttempt[],
    nodeCount: number,
  ): PairedAttempt[] {
    // Pair attempts by (phase, role) composite key, then emit rows in
    // chronological order by interleaving both sequences by their absolute index.
    type Entry = { a: NRAttempt; i: number; key: string };
    // Use role as the sole pairing key when present  this allows cross-phase pairing
    // (e.g. our tranInit::tranSolve matches ngspice's tranNR::tranSolve). Fall back to
    // phase-only for untagged attempts to preserve existing DC OP pairing behaviour.
    const makeKey = (a: NRAttempt): string =>
      a.role !== undefined
        ? `role::${a.role}`
        : `phase::${a.phase}`;

    const ourEntries: Entry[] = ourAtts.map((a, i) => ({ a, i, key: makeKey(a) }));
    const ngEntries:  Entry[] = ngAtts.map((a, i)  => ({ a, i, key: makeKey(a) }));

    // Build a map from key  list of ngspice entries (in order) for O(1) lookup
    const ngByKey = new Map<string, Entry[]>();
    for (const e of ngEntries) {
      let list = ngByKey.get(e.key);
      if (!list) { list = []; ngByKey.set(e.key, list); }
      list.push(e);
    }

    // Walk both sequences chronologically: at each step take the side with
    // the lower absolute index. When the ours-side entry pairs with the
    // next unconsumed ng entry of the same key, emit paired and advance both.
    // Otherwise emit a side-only row and advance only that side.
    const ngConsumed = new Set<number>(); // ngspice absolute indices already paired
    const ourConsumed = new Set<number>();

    // We'll build rows by iterating over a merged sequence of (side, entry).
    // Merge: pick whichever unconsumed head has the lower index; if tied, ours first.
    const result: PairedAttempt[] = [];
    let oi = 0; // pointer into ourEntries
    let ni = 0; // pointer into ngEntries

    while (oi < ourEntries.length || ni < ngEntries.length) {
      // Skip already-consumed entries
      while (oi < ourEntries.length && ourConsumed.has(oi)) oi++;
      while (ni < ngEntries.length && ngConsumed.has(ni)) ni++;

      const ourHead = oi < ourEntries.length ? ourEntries[oi]! : null;
      const ngHead  = ni < ngEntries.length  ? ngEntries[ni]!  : null;

      // Determine which side to process next
      const takeOurs = ourHead !== null && (ngHead === null || ourHead.i <= ngHead.i);

      if (takeOurs && ourHead) {
        // Try to find a matching ng entry by key
        const keyList = ngByKey.get(ourHead.key);
        const matchNg = keyList?.find(e => !ngConsumed.has(e.i)) ?? null;

        if (matchNg) {
          // Before emitting the paired row, flush any unconsumed ng entries whose
          // absolute index is less than the match  preserves chronological order.
          while (ni < matchNg.i) {
            if (!ngConsumed.has(ni)) {
              const skipped = ngEntries[ni]!;
              result.push({
                phase: skipped.a.phase,
                ...(skipped.a.role !== undefined ? { role: skipped.a.role } : {}),
                ourIndex: null,
                ngspiceIndex: skipped.i,
                divergenceNorm: NaN,
              });
              ngConsumed.add(ni);
            }
            ni++;
          }
          // Paired row
          const ourLast = ourHead.a.iterations[ourHead.a.iterations.length - 1];
          const ngLast  = matchNg.a.iterations[matchNg.a.iterations.length - 1];
          const divergenceNorm = _l1NormDiff(ourLast?.voltages, ngLast?.voltages, 0, nodeCount);
          result.push({
            phase: ourHead.a.phase,
            ...(ourHead.a.role !== undefined ? { role: ourHead.a.role } : {}),
            ourIndex: ourHead.i,
            ngspiceIndex: matchNg.i,
            divergenceNorm,
          });
          ourConsumed.add(oi);
          ngConsumed.add(matchNg.i);
          oi++;
          if (ni === matchNg.i) ni++;
        } else {
          // Ours-only row
          result.push({
            phase: ourHead.a.phase,
            ...(ourHead.a.role !== undefined ? { role: ourHead.a.role } : {}),
            ourIndex: ourHead.i,
            ngspiceIndex: null,
            divergenceNorm: NaN,
          });
          ourConsumed.add(oi);
          oi++;
        }
      } else if (ngHead) {
        // Try to find a matching ours entry by key
        const ourKeyList = ourEntries.filter(e => e.key === ngHead.key && !ourConsumed.has(e.i));
        const matchOurs = ourKeyList[0] ?? null;

        if (matchOurs) {
          // Before emitting the paired row, flush any unconsumed ours entries whose
          // absolute index is less than the match  preserves chronological order.
          while (oi < matchOurs.i) {
            if (!ourConsumed.has(oi)) {
              const skipped = ourEntries[oi]!;
              result.push({
                phase: skipped.a.phase,
                ...(skipped.a.role !== undefined ? { role: skipped.a.role } : {}),
                ourIndex: skipped.i,
                ngspiceIndex: null,
                divergenceNorm: NaN,
              });
              ourConsumed.add(oi);
            }
            oi++;
          }
          // Paired row
          const ourLast = matchOurs.a.iterations[matchOurs.a.iterations.length - 1];
          const ngLast  = ngHead.a.iterations[ngHead.a.iterations.length - 1];
          const divergenceNorm = _l1NormDiff(ourLast?.voltages, ngLast?.voltages, 0, nodeCount);
          result.push({
            phase: ngHead.a.phase,
            ...(ngHead.a.role !== undefined ? { role: ngHead.a.role } : {}),
            ourIndex: matchOurs.i,
            ngspiceIndex: ngHead.i,
            divergenceNorm,
          });
          ngConsumed.add(ni);
          ourConsumed.add(matchOurs.i);
          ni++;
          if (oi === matchOurs.i) oi++;
        } else {
          // Ngspice-only row (no matching ours entry for this key)
          result.push({
            phase: ngHead.a.phase,
            ...(ngHead.a.role !== undefined ? { role: ngHead.a.role } : {}),
            ourIndex: null,
            ngspiceIndex: ngHead.i,
            divergenceNorm: NaN,
          });
          ngConsumed.add(ni);
          ni++;
        }
      }
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Range and slot helpers
  // ---------------------------------------------------------------------------

  getStepEndRange(startIndex: number, endIndex: number): StepEndReport[] {
    this._ensureRun();
    const result: StepEndReport[] = [];
    const steps = this._ourSession!.steps;
    for (let i = startIndex; i <= endIndex && i < steps.length; i++) {
      result.push(this.getStepEnd(i));
    }
    return result;
  }

  traceComponentSlot(label: string, slotName: string): SlotTrace {
    this._ensureRun();
    const upperLabel = label.toUpperCase();
    const steps = this._ourSession!.steps;
    const ngSteps = this._ngSessionAligned()?.steps ?? [];

    // Verify component exists
    const exists = this._ourTopology.elements.some(
      el => el.label.toUpperCase() === upperLabel);
    if (!exists) throw new Error(`Component not found: ${upperLabel}`);

    const traceSteps: SlotTrace["steps"] = [];

    for (let si = 0; si < steps.length; si++) {
      const step = steps[si];
      const accIdx = step.acceptedAttemptIndex >= 0 ? step.acceptedAttemptIndex : step.attempts.length - 1;
      const iters = step.attempts[accIdx]?.iterations ?? step.iterations;
      const lastIter = iters[iters.length - 1];

      const ngStep = ngSteps[si];
      const ngAccIdx = ngStep
        ? (ngStep.acceptedAttemptIndex >= 0 ? ngStep.acceptedAttemptIndex : ngStep.attempts.length - 1)
        : -1;
      const ngLastIter = ngStep?.attempts[ngAccIdx]?.iterations.at(-1) ?? ngStep?.iterations.at(-1);

      const ourEs = lastIter?.elementStates.find(e => e.label.toUpperCase() === upperLabel);
      const ngEs = ngLastIter?.elementStates.find(e => e.label.toUpperCase() === upperLabel);

      const ourVal = ourEs?.slots[slotName] ?? NaN;
      const ngVal = ngEs?.slots[slotName] ?? NaN;

      traceSteps.push({
        stepIndex: si,
        stepStartTime: step.stepStartTime,
        value: makeComparedValue(ourVal, ngVal),
      });
    }

    return {
      label: upperLabel,
      slotName,
      totalSteps: steps.length,
      steps: traceSteps,
    };
  }

  getStateHistory(label: string, stepIndex: number): StateHistoryReport {
    this._ensureRun();
    const steps = this._ourSession!.steps;
    const ngSteps = this._ngSessionAligned()?.steps;
    const maxSteps = Math.max(steps.length, ngSteps?.length ?? 0);
    if (stepIndex < 0 || stepIndex >= maxSteps) {
      throw new Error(`Step out of range: ${stepIndex}`);
    }

    const upperLabel = label.toUpperCase();
    const step = steps[stepIndex];
    const accIdx = step
      ? (step.acceptedAttemptIndex >= 0 ? step.acceptedAttemptIndex : step.attempts.length - 1)
      : -1;
    const iters = step?.attempts[accIdx]?.iterations ?? step?.iterations ?? [];
    const lastIter = iters[iters.length - 1];
    const iterIdx = Math.max(iters.length - 1, 0);

    const ourEs = lastIter?.elementStates.find(e => e.label.toUpperCase() === upperLabel);

    const ngStep = this._ngSessionAligned()?.steps[stepIndex];
    const ngAccIdx = ngStep
      ? (ngStep.acceptedAttemptIndex >= 0 ? ngStep.acceptedAttemptIndex : ngStep.attempts.length - 1)
      : -1;
    const ngLastIter = ngStep?.attempts[ngAccIdx]?.iterations.at(-1) ?? ngStep?.iterations.at(-1);
    const ngEs = ngLastIter?.elementStates.find(e => e.label.toUpperCase() === upperLabel);

    return {
      label: upperLabel,
      stepIndex,
      iteration: iterIdx,
      state0: ourEs?.slots ?? {},
      state1: ourEs?.state1Slots ?? {},
      state2: ourEs?.state2Slots ?? {},
      ngspiceState0: ngEs?.slots ?? {},
      ngspiceState1: ngEs?.state1Slots ?? {},
      ngspiceState2: ngEs?.state2Slots ?? {},
    };
  }

  getComponentSlots(label: string, patterns: string[], opts?: { step?: number }): ComponentSlotsResult {
    this._ensureRun();
    const upperLabel = label.toUpperCase();
    const exists = this._ourTopology.elements.some(
      el => el.label.toUpperCase() === upperLabel);
    if (!exists) throw new Error(`Component not found: ${upperLabel}`);

    const ngSteps = this._ngSessionAligned()?.steps ?? [];
    const ourSteps = this._ourSession!.steps;

    const filterSlots = (es: { slots: Record<string, number> }) =>
      Object.entries(es.slots).filter(([k]) => matchSlotPattern(k, patterns));

    if (opts?.step !== undefined) {
      // Snapshot mode
      const si = opts.step;
      const step = ourSteps[si];
      const accIdx = step?.acceptedAttemptIndex >= 0 ? step.acceptedAttemptIndex : (step?.attempts.length ?? 1) - 1;
      const iters = step?.attempts[accIdx]?.iterations ?? step?.iterations ?? [];
      const lastIter = iters[iters.length - 1];
      const ourEs = lastIter?.elementStates.find(e => e.label.toUpperCase() === upperLabel);

      const ngStep = ngSteps[si];
      const ngAccIdx = ngStep
        ? (ngStep.acceptedAttemptIndex >= 0 ? ngStep.acceptedAttemptIndex : ngStep.attempts.length - 1)
        : -1;
      const ngLastIter = ngStep?.attempts[ngAccIdx]?.iterations.at(-1) ?? ngStep?.iterations.at(-1);
      const ngEs = ngLastIter?.elementStates.find(e => e.label.toUpperCase() === upperLabel);

      const slots: Record<string, ComparedValue> = {};
      const matched = filterSlots(ourEs ?? { slots: {} });
      const matchedNames: string[] = [];
      for (const [k, v] of matched) {
        const ngV = ngEs?.slots[k] ?? NaN;
        slots[k] = makeComparedValue(v, ngV);
        matchedNames.push(k);
      }

      return {
        mode: "snapshot",
        label: upperLabel,
        stepIndex: si,
        stepStartTime: step?.stepStartTime ?? 0,
        slots,
        matchedSlots: matchedNames,
        totalSlots: ourEs ? Object.keys(ourEs.slots).length : 0,
      } as ComponentSlotsSnapshot;
    } else {
      // Trace mode
      const traceSteps: ComponentSlotsTrace["steps"] = [];
      let matchedNames: string[] = [];

      for (let si = 0; si < ourSteps.length; si++) {
        const step = ourSteps[si];
        const accIdx = step.acceptedAttemptIndex >= 0 ? step.acceptedAttemptIndex : step.attempts.length - 1;
        const iters = step.attempts[accIdx]?.iterations ?? step.iterations;
        const lastIter = iters[iters.length - 1];
        const ourEs = lastIter?.elementStates.find(e => e.label.toUpperCase() === upperLabel);

        const ngStep = ngSteps[si];
        const ngAccIdx = ngStep
          ? (ngStep.acceptedAttemptIndex >= 0 ? ngStep.acceptedAttemptIndex : ngStep.attempts.length - 1)
          : -1;
        const ngLastIter = ngStep?.attempts[ngAccIdx]?.iterations.at(-1) ?? ngStep?.iterations.at(-1);
        const ngEs = ngLastIter?.elementStates.find(e => e.label.toUpperCase() === upperLabel);

        const slots: Record<string, ComparedValue> = {};
        const matched = filterSlots(ourEs ?? { slots: {} });
        if (si === 0) matchedNames = matched.map(([k]) => k);
        for (const [k, v] of matched) {
          const ngV = ngEs?.slots[k] ?? NaN;
          slots[k] = makeComparedValue(v, ngV);
        }

        traceSteps.push({ stepIndex: si, stepStartTime: step.stepStartTime, slots });
      }

      return {
        mode: "trace",
        label: upperLabel,
        totalSteps: ourSteps.length,
        matchedSlots: matchedNames,
        steps: traceSteps,
      } as ComponentSlotsTrace;
    }
  }

  // ---------------------------------------------------------------------------
  // Trace methods
  // ---------------------------------------------------------------------------

  traceComponent(label: string, opts?: { slots?: string[] }): ComponentTrace {
    this._ensureRun();
    const upperLabel = label.toUpperCase();
    const elInfo = this._ourTopology.elements.find(
      e => e.label.toUpperCase() === upperLabel);
    const deviceType = elInfo?.type ?? "unknown";

    const ourSteps = this._ourSession!.steps;
    const ngSteps = this._ngSessionAligned()?.steps ?? [];

    const steps: ComponentTrace["steps"] = [];
    for (let si = 0; si < ourSteps.length; si++) {
      const ourStep = ourSteps[si];
      const ngStep = ngSteps[si];

      const ourAccIdx = ourStep.acceptedAttemptIndex >= 0 ? ourStep.acceptedAttemptIndex : ourStep.attempts.length - 1;
      const ourIters = ourStep.attempts[ourAccIdx]?.iterations ?? ourStep.iterations;
      const ngAccIdx = ngStep
        ? (ngStep.acceptedAttemptIndex >= 0 ? ngStep.acceptedAttemptIndex : ngStep.attempts.length - 1)
        : -1;
      const ngIters = ngStep?.attempts[ngAccIdx]?.iterations ?? ngStep?.iterations ?? [];

      const iters: ComponentTrace["steps"][number]["iterations"] = [];
      for (let ii = 0; ii < Math.max(ourIters.length, ngIters.length); ii++) {
        const ourIter = ourIters[ii];
        const ngIter = ngIters[ii];
        const ourEs = ourIter?.elementStates.find(e => e.label.toUpperCase() === upperLabel);
        const ngEs = ngIter?.elementStates.find(e => e.label.toUpperCase() === upperLabel);

        const states: Record<string, ComparedValue> = {};
        if (ourEs) {
          for (const [slot, value] of Object.entries(ourEs.slots)) {
            // Apply slot filter if provided
            if (opts?.slots && !opts.slots.includes(slot)) continue;
            const ngValue = ngEs?.slots[slot] ?? NaN;
            states[slot] = makeComparedValue(value, ngValue);
          }
        }

        const pinVoltages: Record<string, ComparedValue> = {};
        if (elInfo && ourIter) {
          for (let p = 0; p < elInfo.pinNodeIds.length; p++) {
            const nodeId = elInfo.pinNodeIds[p];
            if (nodeId === 0) continue;
            const pinLabel = this._ourTopology.nodeLabels.get(nodeId) ?? `pin${p}`;
            const ourV = nodeId - 1 < ourIter.voltages.length ? ourIter.voltages[nodeId] : 0;
            const ngV = ngIter && nodeId - 1 < ngIter.voltages.length
              ? ngIter.voltages[nodeId] : NaN;
            pinVoltages[pinLabel] = makeComparedValue(ourV, ngV);
          }
        }

        iters.push({ iteration: ii, states, pinVoltages });
      }
      steps.push({ stepIndex: si, stepStartTime: ourStep.stepStartTime, iterations: iters });
    }

    return { label: upperLabel, deviceType, steps };
  }

  traceNode(label: string, opts?: { onlyDivergences?: boolean }): NodeTrace {
    this._ensureRun();
    const upperLabel = label.toUpperCase();

    const foundId = this._findNodeIdByLabel(label, this._ourTopology.nodeLabels);
    const ourIndex = foundId ?? -1;

    const mapping = this._nodeMap.find(m => m.label.toUpperCase() === upperLabel);
    const ngIndex = mapping?.ngspiceIndex ?? -1;

    const ourSteps = this._ourSession!.steps;
    const ngSteps = this._ngSessionAligned()?.steps ?? [];

    const steps: NodeTrace["steps"] = [];
    const totalStepCount = Math.max(ourSteps.length, ngSteps.length);
    for (let si = 0; si < totalStepCount; si++) {
      const ourStep = ourSteps[si] ?? null;
      const ngStep = ngSteps[si] ?? null;

      const ourAccIdx = ourStep
        ? (ourStep.acceptedAttemptIndex >= 0 ? ourStep.acceptedAttemptIndex : ourStep.attempts.length - 1)
        : -1;
      const ourIters = ourStep
        ? (ourStep.attempts[ourAccIdx]?.iterations ?? ourStep.iterations)
        : [];
      const ngAccIdx = ngStep
        ? (ngStep.acceptedAttemptIndex >= 0 ? ngStep.acceptedAttemptIndex : ngStep.attempts.length - 1)
        : -1;
      const ngIters = ngStep?.attempts[ngAccIdx]?.iterations ?? ngStep?.iterations ?? [];

      const iters: NodeTrace["steps"][number]["iterations"] = [];
      for (let ii = 0; ii < Math.max(ourIters.length, ngIters.length); ii++) {
        const ourIter = ourIters[ii];
        const ngIter = ngIters[ii];
        const ourV = ourIter && ourIndex > 0 && ourIndex - 1 < ourIter.voltages.length
          ? ourIter.voltages[ourIndex] : NaN;
        const ngV = ngIter && ourIndex > 0 && ourIndex - 1 < ngIter.voltages.length
          ? ngIter.voltages[ourIndex] : NaN;
        const cv = makeComparedValue(ourV, ngV);
        if (opts?.onlyDivergences && cv.withinTol) continue;
        iters.push({ iteration: ii, voltage: cv });
      }

      steps.push({ stepIndex: si, stepStartTime: ourStep?.stepStartTime ?? ngStep?.stepStartTime ?? 0, iterations: iters });
    }

    return { label: upperLabel, ourIndex, ngspiceIndex: ngIndex, steps };
  }

  // ---------------------------------------------------------------------------
  // Session summary
  // ---------------------------------------------------------------------------

  getSummary(): SessionSummary {
    this._ensureRun();
    const comparisons = this._getComparisons();
    const ourConv = this._ourSession!.steps.length > 0
      ? convergenceSummary(this._ourSession!)
      : { totalSteps: 0, convergedSteps: 0, failedSteps: 0, avgIterations: 0, maxIterations: 0, worstStep: -1 };
    const ngAligned = this._ngSessionAligned();
    const ngConv = ngAligned?.steps.length
      ? convergenceSummary(ngAligned)
      : { totalSteps: 0, convergedSteps: 0, failedSteps: 0, avgIterations: 0, maxIterations: 0, worstStep: -1 };

    const divergence = findFirstDivergence(comparisons);
    let firstDiv: SessionSummary["firstDivergence"] = null;
    if (divergence) {
      const worstV = divergence.voltageDiffs.reduce(
        (best, d) => d.absDelta > best.absDelta ? d : best,
        { label: "", absDelta: 0 } as { label: string; absDelta: number });
      firstDiv = {
        stepIndex: divergence.stepIndex,
        iterationIndex: divergence.iterationIndex,
        stepStartTime: divergence.stepStartTime,
        worstLabel: worstV.label,
        absDelta: worstV.absDelta,
      };
    }

    const passed = comparisons.filter(c => c.allWithinTol).length;
    const failed = comparisons.length - passed;

    // Per-device-type divergence counts
    const perDeviceType: SessionSummary["perDeviceType"] = {};
    for (const comp of comparisons) {
      if (comp.allWithinTol) continue;
      const step = this._ourSession!.steps[comp.stepIndex];
      if (!step) continue;
      const accIdx = step.acceptedAttemptIndex >= 0 ? step.acceptedAttemptIndex : step.attempts.length - 1;
      const iters = step.attempts[accIdx]?.iterations ?? step.iterations;
      const iter = iters[comp.iterationIndex];
      if (!iter) continue;
      for (const diff of comp.stateDiffs) {
        const es = iter.elementStates.find(e => e.label === diff.elementLabel);
        if (!es) continue;
        const topoEl = this._ourTopology.elements.find(el => el.label.toUpperCase() === es.label.toUpperCase());
        const dt = topoEl?.type ?? "unknown";
        if (!perDeviceType[dt]) perDeviceType[dt] = { divergenceCount: 0, worstAbsDelta: 0 };
        perDeviceType[dt].divergenceCount++;
        if (diff.absDelta > perDeviceType[dt].worstAbsDelta)
          perDeviceType[dt].worstAbsDelta = diff.absDelta;
      }
    }

    // Integration method
    const ourSteps = this._ourSession!.steps;
    const methods = new Set(ourSteps.map(s => s.integrationCoefficients.ours.method));
    const integrationMethod: IntegrationMethod | null = methods.size === 1
      ? [...methods][0]
      : null;

    // State history issues (state1/state2 mismatches)
    let state1Mismatches = 0;
    let state2Mismatches = 0;
    for (const comp of comparisons) {
      for (const d of comp.stateDiffs) {
        if (!d.withinTol) {
          // simplistic: count all state diffs as state1
          state1Mismatches++;
        }
      }
    }

    const sessionShape = this.getSessionShape();

    let worstStepStartTimeDelta = 0;
    for (const shape of sessionShape.steps) {
      if (shape.stepStartTimeDelta !== null && Math.abs(shape.stepStartTimeDelta) > worstStepStartTimeDelta) {
        worstStepStartTimeDelta = Math.abs(shape.stepStartTimeDelta);
      }
    }

    return {
      analysis: this._analysis === "tran" ? "tran" : "dcop",
      stepCount: makeComparedValue(
        this._ourSession!.steps.length,
        ngAligned?.steps.length ?? 0,
      ),
      presenceCounts: sessionShape.presenceCounts,
      worstStepStartTimeDelta,
      convergence: { ours: ourConv, ngspice: ngConv },
      firstDivergence: firstDiv,
      totals: { compared: comparisons.length, passed, failed },
      perDeviceType,
      integrationMethod,
      stateHistoryIssues: { state1Mismatches, state2Mismatches },
    };
  }

  // ---------------------------------------------------------------------------
  // Matrix and coefficient helpers
  // ---------------------------------------------------------------------------

  getMatrixLabeled(stepIndex: number, iterationIndex: number): LabeledMatrix {
    this._ensureRun();
    const ourStep = this._ourSession!.steps[stepIndex];
    const ngStepCheck = this._ngSessionAligned()?.steps[stepIndex];
    if (!ourStep && !ngStepCheck) throw new Error(`Step out of range: ${stepIndex}`);

    const ourAccIdx = ourStep.acceptedAttemptIndex >= 0 ? ourStep.acceptedAttemptIndex : ourStep.attempts.length - 1;
    const ourIters = ourStep.attempts[ourAccIdx]?.iterations ?? ourStep.iterations;
    const ourIter = ourIters[iterationIndex];

    const ngStep = this._ngSessionAligned()?.steps[stepIndex];
    const ngAccIdx = ngStep
      ? (ngStep.acceptedAttemptIndex >= 0 ? ngStep.acceptedAttemptIndex : ngStep.attempts.length - 1)
      : -1;
    const ngIter = ngStep?.attempts[ngAccIdx]?.iterations[iterationIndex]
      ?? ngStep?.iterations[iterationIndex];

    const entries: LabeledMatrixEntry[] = [];
    const seenNgEntries = new Set<string>();

    const identityMode = this._opts.selfCompare || this._ngMatrixRowMap.size === 0;
    const ourToNgRow = new Map<number, number>();
    const ourToNgCol = new Map<number, number>();
    if (identityMode) {
      if (ourIter) {
        for (const e of ourIter.matrix) {
          ourToNgRow.set(e.row, e.row);
          ourToNgCol.set(e.col, e.col);
        }
      }
    } else {
      this._ngMatrixRowMap.forEach((ourIdx, ngIdx) => ourToNgRow.set(ourIdx, ngIdx));
      this._ngMatrixColMap.forEach((ourIdx, ngIdx) => ourToNgCol.set(ourIdx, ngIdx));
    }

    const ngEntryByRowCol = new Map<string, number>();
    if (ngIter) {
      for (const ne of ngIter.matrix) {
        ngEntryByRowCol.set(`${ne.row},${ne.col}`, ne.value);
      }
    }

    if (ourIter) {
      for (const e of ourIter.matrix) {
        const rowLabel = this._ourTopology.matrixRowLabels.get(e.row) ?? `row${e.row}`;
        const colLabel = this._ourTopology.matrixColLabels.get(e.col) ?? `col${e.col}`;

        const ngRow = ourToNgRow.get(e.row);
        const ngCol = ourToNgCol.get(e.col);
        let ngVal: number = NaN;
        if (ngRow !== undefined && ngCol !== undefined) {
          const key = `${ngRow},${ngCol}`;
          const v = ngEntryByRowCol.get(key);
          if (v !== undefined) {
            ngVal = v;
            seenNgEntries.add(key);
          }
        }

        const hasMapping = ngRow !== undefined && ngCol !== undefined;
        const absDelta = hasMapping && !isNaN(ngVal) ? Math.abs(e.value - ngVal) : NaN;
        const withinTol = hasMapping && !isNaN(ngVal) ? e.value === ngVal : false;

        if (hasMapping && !isNaN(ngVal)) {
          entries.push({
            row: e.row, col: e.col, rowLabel, colLabel,
            entryKind: "both",
            ours: e.value, ngspice: ngVal, absDelta, withinTol,
          });
        } else {
          entries.push({
            row: e.row, col: e.col, rowLabel, colLabel,
            entryKind: "captureMissing",
            ours: e.value,
            ngspice: { kind: "captureMissing", side: "ngspice" },
            absDelta: NaN, withinTol: false,
          });
        }
      }
    }

    if (ngIter) {
      for (const ngEntry of ngIter.matrix) {
        const key = `${ngEntry.row},${ngEntry.col}`;
        if (seenNgEntries.has(key)) continue;

        const isNgspiceOnly = this._ngspiceOnlyRows.includes(ngEntry.row) ||
                              this._ngspiceOnlyRows.includes(ngEntry.col);
        if (!isNgspiceOnly) continue;

        const rowLabel = this._ngspiceOnlyRowLabels.get(ngEntry.row)
          ?? (this._ngMatrixRowMap.has(ngEntry.row)
            ? (this._ourTopology.matrixRowLabels.get(this._ngMatrixRowMap.get(ngEntry.row)!) ?? `row${ngEntry.row}`)
            : `ngspice_row${ngEntry.row}`);
        const colLabel = this._ngspiceOnlyRowLabels.get(ngEntry.col)
          ?? (this._ngMatrixColMap.has(ngEntry.col)
            ? (this._ourTopology.matrixColLabels.get(this._ngMatrixColMap.get(ngEntry.col)!) ?? `col${ngEntry.col}`)
            : `ngspice_col${ngEntry.col}`);

        entries.push({
          row: ngEntry.row, col: ngEntry.col, rowLabel, colLabel,
          entryKind: "engineSpecific",
          ours: { kind: "engineSpecific", presentSide: "ngspice" },
          ngspice: ngEntry.value, absDelta: NaN, withinTol: true,
        });
      }
    }

    return { stepIndex, iteration: iterationIndex, matrixSize: this._ourTopology.matrixSize, entries };
  }

  compareMatrixAt(stepIndex: number, iterationIndex: number, filter: "all" | "mismatches"): CompareMatrixResult {
    const labeled = this.getMatrixLabeled(stepIndex, iterationIndex);
    const filtered = filter === "mismatches"
      ? labeled.entries.filter(e => e.entryKind !== "engineSpecific" && !e.withinTol)
      : labeled.entries;
    return {
      stepIndex,
      iteration: iterationIndex,
      filter,
      totalEntries: labeled.entries.length,
      entries: filtered,
    };
  }

  getRhsLabeled(stepIndex: number, iterationIndex: number): RhsLabeledResult {
    this._ensureRun();
    const ourStep = this._ourSession!.steps[stepIndex];
    const ngStepCheck = this._ngSessionAligned()?.steps[stepIndex];
    if (!ourStep && !ngStepCheck) throw new Error(`Step out of range: ${stepIndex}`);

    const ourAccIdx = ourStep.acceptedAttemptIndex >= 0 ? ourStep.acceptedAttemptIndex : ourStep.attempts.length - 1;
    const ourIters = ourStep.attempts[ourAccIdx]?.iterations ?? ourStep.iterations;
    const ourIter = ourIters[iterationIndex];

    const ngStep = this._ngSessionAligned()?.steps[stepIndex];
    const ngAccIdx = ngStep
      ? (ngStep.acceptedAttemptIndex >= 0 ? ngStep.acceptedAttemptIndex : ngStep.attempts.length - 1)
      : -1;
    const ngIter = ngStep?.attempts[ngAccIdx]?.iterations[iterationIndex]
      ?? ngStep?.iterations[iterationIndex];

    const n = this._ourTopology.matrixSize;
    const entries: RhsLabeledResult["entries"] = [];
    for (let i = 0; i < n; i++) {
      // preSolveRhs is the 1-based solution-vector layout (index 0 = ground),
      // so row i maps to node id i (nodeLabels) or to matrixRowLabels keyed
      // 0-based at i-1 (matrixRowLabels.set(nodeId-1, ...) in capture.ts) —
      // the same convention the voltage/rhs first-divergence walks use.
      const rowLabel = this._ourTopology.nodeLabels.get(i)
        ?? this._ourTopology.matrixRowLabels.get(i - 1)
        ?? `row${i}`;
      const ourV = ourIter?.preSolveRhs[i] ?? 0;
      const ngV = ngIter?.preSolveRhs[i] ?? NaN;
      const absDelta = Math.abs(ourV - ngV);
      const withinTol = isNaN(ngV) ? false : ourV === ngV;
      entries.push({ index: i, rowLabel, ours: ourV, ngspice: ngV, absDelta, withinTol });
    }

    return { stepIndex, iteration: iterationIndex, entries };
  }

  getIntegrationCoefficients(stepIndex: number): IntegrationCoefficientsReport {
    this._ensureRun();
    const step = this._ourSession!.steps[stepIndex];
    const ngStep = this._ngSessionAligned()?.steps[stepIndex];
    if (!step && !ngStep) throw new Error(`Step out of range: ${stepIndex}`);

    const ours = step?.integrationCoefficients.ours
      ?? { ag0: 0, ag1: 0, method: "trapezoidal" as const, order: 1 };
    const ngspice = ngStep?.integrationCoefficients.ngspice
      ?? { ag0: 0, ag1: 0, method: "trapezoidal", order: 1 };

    return {
      stepIndex,
      ours,
      ngspice,
      methodMatch: ours.method === ngspice.method,
      ag0Compared: makeComparedValue(ours.ag0, ngspice.ag0),
      ag1Compared: makeComparedValue(ours.ag1, ngspice.ag1),
    };
  }

  getLimitingComparison(label: string, stepIndex: number, iterationIndex: number): LimitingComparisonReport {
    this._ensureRun();
    const upperLabel = label.toUpperCase();

    const ourStep = this._ourSession?.steps[stepIndex];
    const ourAccIdx = ourStep
      ? (ourStep.acceptedAttemptIndex >= 0 ? ourStep.acceptedAttemptIndex : ourStep.attempts.length - 1)
      : -1;
    const ourIters = ourStep?.attempts[ourAccIdx]?.iterations ?? ourStep?.iterations ?? [];
    const ourIter = ourIters[iterationIndex];

    const ngStep = this._ngSessionAligned()?.steps[stepIndex ?? 0];
    const ngAccIdx = ngStep
      ? (ngStep.acceptedAttemptIndex >= 0 ? ngStep.acceptedAttemptIndex : ngStep.attempts.length - 1)
      : -1;
    const ngIter = ngStep?.attempts[ngAccIdx]?.iterations[iterationIndex]
      ?? ngStep?.iterations[iterationIndex];

    const ourEvents = (ourIter?.limitingEvents ?? []).filter(
      e => e.label.toUpperCase() === upperLabel);
    const ngEvents = (ngIter?.limitingEvents ?? []).filter(
      e => (e as any).label?.toUpperCase() === upperLabel || (e as any).deviceName?.toUpperCase() === upperLabel);

    if (ourEvents.length === 0 && ngEvents.length === 0) {
      return { label: upperLabel, noEvents: true, junctions: [] };
    }

    const allJunctions = new Set([
      ...ourEvents.map(e => e.junction),
      ...ngEvents.map(e => (e as any).junction ?? ""),
    ]);

    const junctions = [...allJunctions].map(junction => {
      const ourEv = ourEvents.find(e => e.junction === junction);
      const ngEv = ngEvents.find(e => (e as any).junction === junction) as any;

      const ourPreLimit = ourEv ? ourEv.vBefore : NaN;
      const ourPostLimit = ourEv ? ourEv.vAfter : NaN;
      const ourWasLimited = ourEv ? ourEv.wasLimited : false;
      const ourDelta = ourPostLimit - ourPreLimit;

      const ngspicePreLimit = ngEv ? ngEv.vBefore : NaN;
      const ngspicePostLimit = ngEv ? ngEv.vAfter : NaN;
      const ngspiceWasLimited = ngEv ? ngEv.wasLimited : false;
      const ngspiceDelta = ngspicePostLimit - ngspicePreLimit;

      const limitingDiff = ourDelta - ngspiceDelta;

      return {
        junction,
        ourPreLimit,
        ourPostLimit,
        ourWasLimited,
        ourDelta,
        ngspicePreLimit,
        ngspicePostLimit,
        ngspiceWasLimited,
        ngspiceDelta,
        limitingDiff,
      };
    });

    return { label: upperLabel, noEvents: false, junctions };
  }

  getConvergenceDetail(stepIndex: number, iterationIndex: number): ConvergenceDetailReport {
    this._ensureRun();
    const ourStep = this._ourSession!.steps[stepIndex];
    const ourAccIdx = ourStep
      ? (ourStep.acceptedAttemptIndex >= 0 ? ourStep.acceptedAttemptIndex : ourStep.attempts.length - 1)
      : -1;
    const ourIters = ourStep?.attempts[ourAccIdx]?.iterations ?? ourStep?.iterations ?? [];
    const ourIter = ourIters[iterationIndex];

    const ngStep = this._ngSessionAligned()?.steps[stepIndex];
    const ngAccIdx = ngStep
      ? (ngStep.acceptedAttemptIndex >= 0 ? ngStep.acceptedAttemptIndex : ngStep.attempts.length - 1)
      : -1;
    const ngIter = ngStep?.attempts[ngAccIdx]?.iterations[iterationIndex]
      ?? ngStep?.iterations[iterationIndex];

    const elements: ConvergenceDetailReport["elements"] = [];
    if (ourIter) {
      for (const es of ourIter.elementStates) {
        const topoEl = this._ourTopology.elements.find(
          el => el.label.toUpperCase() === es.label.toUpperCase());
        const ourConverged = !ourIter.convergenceFailedElements.includes(es.label);
        const ngspiceConverged = ngIter
          ? !(ngIter.ngspiceConvergenceFailedDevices ?? []).some(
              d => d.toUpperCase() === es.label.toUpperCase())
          : true;
        const ngEs = ngIter?.elementStates.find(
          e => e.label.toUpperCase() === es.label.toUpperCase());
        let worstDelta = 0;
        if (ngEs) {
          for (const [slot, value] of Object.entries(es.slots)) {
            const ngValue = ngEs.slots[slot];
            if (ngValue !== undefined) {
              const delta = Math.abs(value - ngValue);
              if (delta > worstDelta) worstDelta = delta;
            }
          }
        }
        elements.push({
          label: es.label,
          deviceType: topoEl?.type ?? "unknown",
          ourConverged,
          ngspiceConverged,
          worstDelta,
          agree: ourConverged === ngspiceConverged,
        });
      }
    }

    const ourNoncon = elements.filter(e => !e.ourConverged).length;
    const ngspiceNoncon = elements.filter(e => !e.ngspiceConverged).length;
    const disagreementCount = elements.filter(e => !e.agree).length;
    return {
      stepIndex,
      iteration: iterationIndex,
      ourNoncon,
      ngspiceNoncon,
      ourGlobalConverged: ourNoncon === 0,
      ngspiceGlobalConverged: ngspiceNoncon === 0,
      elements,
      disagreementCount,
    };
  }

  toJSON(opts?: ToJSONOpts): {
    analysis: string;
    stepCount: { ours: number; ngspice: number };
    steps: Array<{ stepIndex: number; stepStartTime: number; presence: SidePresence }>;
  } {
    this._ensureRun();
    const comparisons = this._getComparisons();
    const divergentStepIndices = new Set(
      comparisons.filter(c => !c.allWithinTol).map(c => c.stepIndex));

    const ourSteps = this._ourSession!.steps;
    const includeAll = opts?.includeAllSteps ?? false;

    const steps = ourSteps
      .map((step, i) => ({
        stepIndex: i,
        stepStartTime: step.stepStartTime,
        presence: this._stepPresence(i),
      }))
      .filter(s => includeAll || divergentStepIndices.has(s.stepIndex));

    return {
      analysis: this._analysis === "tran" ? "tran" : "dcop",
      stepCount: {
        ours: ourSteps.length,
        ngspice: this._ngSessionAligned()?.steps.length ?? 0,
      },
      steps,
    };
  }

  // ---------------------------------------------------------------------------
  // Dispose
  // ---------------------------------------------------------------------------

  dispose(): void {
    this._ourSession = null;
    this._ngSession = null;
    this._ngSessionReindexed = null;
    this._ngAcSessionReindexed = null;
    this._comparisons = null;
    this._nodeMap = [];
    if (this._libmShimInstalled) {
      uninstallUcrtLibmShim();
      this._libmShimInstalled = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Raw access
  // ---------------------------------------------------------------------------

  get ourSession(): CaptureSession | null { return this._ourSession; }
  get ngspiceSession(): CaptureSession | null { return this._ngSession; }
  get ngspiceSessionAligned(): CaptureSession | null { return this._ngSessionReindexed; }
  /** Our-side AC capture session (populated by runAcSweep). */
  get acSession(): AcCaptureSession | null { return this._acSession; }
  /** ngspice-side AC capture session (populated by runAcSweep). */
  get ngspiceAcSession(): AcCaptureSession | null { return this._ngAcSession; }

  /**
   * Whole-session shape descriptor for an AC sweep. Sibling of
   * `getSessionShape()` for the DC/TRAN path.
   *
   * Returns the frequency-axis sanity surface: point counts per side,
   * per-index presence + frequency parity (|ng-ours|/max), and a list of
   * indices where `freqRelDelta` exceeds 1e-9 (essentially "frequencies
   * disagree at all"- the threshold is tight because both sides build the
   * sweep from the same {fStart, fStop, n, type} so any deviation past
   * floating-point noise is a fixture or sweep-config bug, not engine
   * disagreement).
   *
   * Reported, not gated- mirrors the DC/TRAN `SessionShape.largeTimeDeltas`
   * pattern. `acFirstDivergence()` and the upcoming matrix-diff tool still
   * run when freqRelDeltas exist; consumers cross-reference both reports.
   * A non-empty largeFreqDeltas alongside per-point solution divergence is
   * diagnostic ("fixture/sweep-config mismatch") rather than grounds to
   * refuse the diff.
   */
  getAcSessionShape(): AcSessionShape {
    if (!this._acSession) {
      throw new Error(
        `getAcSessionShape() requires an AC sweep run; current analysis is ${this._analysis ?? "null"}. ` +
        "Call runAcSweep(params) first.",
      );
    }
    const ours = this._acSession.points;
    const ngsp = this._ngAcSession?.points ?? [];
    const oursLen = ours.length;
    const ngLen   = ngsp.length;
    const max     = Math.max(oursLen, ngLen);

    const points: AcPointShape[] = [];
    const presenceCounts = { both: 0, oursOnly: 0, ngspiceOnly: 0 };
    const largeFreqDeltas: Array<{ pointIndex: number; freqRelDelta: number }> = [];

    // Reported, not gated- mirrors the DC/TRAN largeTimeDeltas surface.
    // Consumers cross-reference freqRelDelta and decide how to investigate.
    for (let i = 0; i < max; i++) {
      const o = i < oursLen ? ours[i] : null;
      const n = i < ngLen ? ngsp[i] : null;
      const presence: "both" | "oursOnly" | "ngspiceOnly" =
        o && n ? "both" : o ? "oursOnly" : "ngspiceOnly";
      presenceCounts[presence]++;

      let freqRelDelta: number | null = null;
      if (o && n) {
        const denom = Math.max(Math.abs(o.freq), Math.abs(n.freq), Number.MIN_VALUE);
        freqRelDelta = Math.abs(n.freq - o.freq) / denom;
        if (freqRelDelta > 0) {
          largeFreqDeltas.push({ pointIndex: i, freqRelDelta });
        }
      }

      points.push({
        pointIndex: i,
        presence,
        freq:  { ours: o ? o.freq  : null, ngspice: n ? n.freq  : null },
        omega: { ours: o ? o.omega : null, ngspice: n ? n.omega : null },
        freqRelDelta,
        matrixSize: { ours: o ? o.matrixSize : null, ngspice: n ? n.matrixSize : null },
      });
    }

    return {
      analysis: "ac",
      pointCount: { ours: oursLen, ngspice: ngLen, max },
      presenceCounts,
      points,
      largeFreqDeltas,
    };
  }

  /**
   * First per-class divergence between the paired AC sessions.
   *
   * Phase 3a: surfaces the earliest `solution` (per-MNA-row complex value
   * mismatch) and `shape` (presence / frequency / matrix-size mismatch)
   * divergences across the frequency sweep. Matrix-class divergence is
   * deferred to Phase 3b (requires the SparseSolver complex CSC export on
   * the our side; ngspice already provides it via the bridge).
   *
   * Walks point indices in order. For each:
   *   - Records the first `shape` mismatch if any (presence, freq, matrixSize).
   *   - Records the first `solution` mismatch by scanning all MNA rows for
   *     a non-zero `|ours - ngspice|` in the complex plane.
   *   - Stops when both classes have been recorded (subsequent iterations
   *     cannot land earlier than what's already been captured).
   *
   * Bit-exact is the project bar (CLAUDE.md), so `absDelta > 0` is the
   * solution threshold; magnitudes are surfaced via `absDelta` / `relDelta`
   * for diagnostic classification rather than as a filter. Reports
   * unconditionally- consult `getAcSessionShape().largeFreqDeltas` for the
   * orthogonal frequency-axis-parity context.
   */
  acFirstDivergence(): AcDivergenceReport {
    if (!this._acSession || !this._ngAcSession || !this._ngAcSessionReindexed) {
      throw new Error(
        `acFirstDivergence() requires an AC sweep run; current analysis is ${this._analysis ?? "null"}. ` +
        "Call runAcSweep(params) first.",
      );
    }
    const ours = this._acSession.points;
    const ngsp = this._ngAcSession.points;
    // Solution walk uses the per-frequency reindexed ngspice points
    // (solRe/solIm/rhsRe/rhsIm reindexed into our coord space by
    // `_reindexNgAcSession`, which runAcSweep always runs). The matrix walk
    // stays on raw `ngsp` and translates (row, col) at compare time so
    // allocation-order divergence remains visible. Mirrors the DC/TRAN split:
    // `_ngSessionReindexed` for solution-space comparison, raw `_ngSession`
    // matrix walked via `_ngMatrixRowMap`.
    const ngspRe = this._ngAcSessionReindexed.points;
    const max = Math.max(ours.length, ngsp.length);

    let solution: AcSolutionDivergenceEntry | null = null;
    let shape: AcShapeDivergenceEntry | null = null;
    let matrix: AcMatrixDivergenceEntry | null = null;
    let rhs: AcSolutionDivergenceEntry | null = null;

    for (let i = 0; i < max; i++) {
      const o = i < ours.length ? ours[i] : null;
      const n = i < ngsp.length ? ngsp[i] : null;
      const nRe = i < ngspRe.length ? ngspRe[i] : null;

      // Shape: presence (one side has no point at this index).
      if (!o || !n) {
        if (shape === null) {
          shape = {
            pointIndex: i,
            kind: !o ? "ours-missing" : "ngspice-missing",
            freq: { ours: o ? o.freq : null, ngspice: n ? n.freq : null },
            matrixSize: { ours: o ? o.matrixSize : null, ngspice: n ? n.matrixSize : null },
          };
        }
        if (solution !== null && shape !== null && matrix !== null && rhs !== null) break;
        continue;
      }

      // matrixSize is NOT flagged here: ngspice's CKTmaxEqNum+1 = N+2 while
      // ours = N, so the raw values always differ by 2 even on identical
      // topologies. The matrix dimension is carried in AcPointShape for
      // inspection (matching DC/TRAN's `topologyDiff` at line 3886 which
      // surfaces both sides separately). Structural matrix divergence
      // surfaces in the matrix-class walk below via ours-only / ngspice-only
      // cells after `_ngMatrixRowMap` translation.
      if (shape === null && o.freq !== n.freq) {
        shape = {
          pointIndex: i,
          kind: "frequency-mismatch",
          freq: { ours: o.freq, ngspice: n.freq },
          matrixSize: { ours: o.matrixSize, ngspice: n.matrixSize },
        };
      }

      // Solution: per-MNA-row complex comparison in OUR coord space (nRe is
      // the reindexed ngspice point). Unmapped rows land as NaN in the
      // reindexed arrays (surfaces as a divergence rather than silently
      // aligning unrelated voltages).
      if (solution === null && nRe) {
        const rowLimit = Math.min(o.solRe.length, nRe.solRe.length);
        for (let k = 0; k < rowLimit; k++) {
          const dRe = o.solRe[k] - nRe.solRe[k];
          const dIm = o.solIm[k] - nRe.solIm[k];
          const absDelta = Math.hypot(dRe, dIm);
          if (absDelta > 0 || Number.isNaN(dRe) || Number.isNaN(dIm)) {
            const oMag = Math.hypot(o.solRe[k], o.solIm[k]);
            const nMag = Math.hypot(nRe.solRe[k], nRe.solIm[k]);
            const denom = Math.max(oMag, nMag, Number.MIN_VALUE);
            solution = {
              pointIndex: i,
              freq: o.freq,
              row: k,
              ours: { re: o.solRe[k], im: o.solIm[k] },
              ngspice: { re: nRe.solRe[k], im: nRe.solIm[k] },
              absDelta,
              relDelta: absDelta / denom,
            };
            break;
          }
        }
      }

      // RHS: per-MNA-row complex comparison of the loaded excitation vector,
      // in OUR coord space (nRe is the reindexed ngspice point; _reindexNgAcSession
      // reindexes rhsRe/rhsIm alongside solRe/solIm). An identical complex
      // Jacobian with a divergent RHS surfaces only as a divergent `solution`,
      // so this is the upstream class that isolates the excitation/source-load
      // path. rhsRe/rhsIm are optional on AcCapturePoint; guard like the matrix
      // walk so a side that has not exported the complex RHS yields no false
      // positive rather than a spurious divergence.
      if (rhs === null && nRe && o.rhsRe && o.rhsIm && nRe.rhsRe && nRe.rhsIm) {
        const rowLimit = Math.min(o.rhsRe.length, nRe.rhsRe.length);
        for (let k = 0; k < rowLimit; k++) {
          const dRe = o.rhsRe[k] - nRe.rhsRe[k];
          const dIm = o.rhsIm[k] - nRe.rhsIm[k];
          const absDelta = Math.hypot(dRe, dIm);
          if (absDelta > 0 || Number.isNaN(dRe) || Number.isNaN(dIm)) {
            const oMag = Math.hypot(o.rhsRe[k], o.rhsIm[k]);
            const nMag = Math.hypot(nRe.rhsRe[k], nRe.rhsIm[k]);
            const denom = Math.max(oMag, nMag, Number.MIN_VALUE);
            rhs = {
              pointIndex: i,
              freq: o.freq,
              row: k,
              ours: { re: o.rhsRe[k], im: o.rhsIm[k] },
              ngspice: { re: nRe.rhsRe[k], im: nRe.rhsIm[k] },
              absDelta,
              relDelta: absDelta / denom,
            };
            break;
          }
        }
      }

      // Matrix: per-cell complex Jacobian comparison.
      // Build (row,col) -> {re,im} maps in OUR coordinate space and walk for
      // first mismatch in order (col asc, row asc). ngspice's external indices
      // are translated through _ngMatrixRowMap / _ngMatrixColMap (populated
      // by _buildNodeMapping in runAcSweep) so both sides' cells land in a
      // common keyspace- without this translation the raw ngspice indices
      // (CKTmaxEqNum-style +1 offset and ngspice-specific permutation) would
      // never overlap with ours and every cell would falsely report as
      // ours-only / ngspice-only. ngspice cells whose row OR col has no map
      // entry surface as "ngspice-only" using the raw ngspice coordinates;
      // ours cells are always in our space (no translation needed).
      if (matrix === null && o.matrix && n.matrix) {
        const cellKey = (row: number, col: number) => (col << 20) | row;
        type CellInfo = { row: number; col: number; re: number; im: number };
        const oMap = new Map<number, CellInfo>();
        const nMap = new Map<number, CellInfo>();
        // ngspice cells whose ng-coords don't map (no translation) get keyed
        // by their ngspice coords directly and reported as "ngspice-only".
        const nUnmapped = new Map<number, CellInfo>();
        const oM = o.matrix;
        const nM = n.matrix;
        // Ours: standard CSC convention, colPtr[c] = end of col c.
        for (let c = 1; c < oM.colPtr.length; c++) {
          const start = oM.colPtr[c - 1];
          const end   = oM.colPtr[c];
          for (let idx = start; idx < end; idx++) {
            const row = oM.rowIdx[idx];
            oMap.set(cellKey(row, c), { row, col: c, re: oM.valsRe[idx], im: oM.valsIm[idx] });
          }
        }
        // ngspice: canonical END-of-column CSC convention (colPtr[c] = end of
        // col c), identical to the `oMap` loop above. The raw C-side AC matrix
        // capture (ni_ac_capture_matrix, niiter.c:432) emits a START-of-column
        // offset array, but `buildAcCaptureSession` (ngspice-bridge.ts)
        // normalizes that to the END-of-column convention at the FFI boundary -
        // mirroring how the DC/TRAN bridge decoder dissolves the same START
        // layout into flat {row,col} triples (ngspice-bridge.ts:932-934). Both
        // matrix sources reaching this walk (real-ngspice via the normalized
        // bridge, selfCompare via the deep clone of our END-convention export)
        // therefore share one convention; reading them identically keeps the
        // ngspice Jacobian column-aligned with ours before row/col translation.
        const ngRowMap = this._ngMatrixRowMap;
        const ngColMap = this._ngMatrixColMap;
        const haveMaps = ngRowMap.size > 0 && ngColMap.size > 0;
        for (let c = 1; c < nM.colPtr.length; c++) {
          const start = nM.colPtr[c - 1];
          const end   = nM.colPtr[c];
          for (let idx = start; idx < end; idx++) {
            const ngRow = nM.rowIdx[idx];
            const ngCol = c;
            const cellRe = nM.valsRe[idx];
            const cellIm = nM.valsIm[idx];
            if (!haveMaps) {
              // selfCompare or no mapping built; keys match ours' space already.
              nMap.set(cellKey(ngRow, ngCol), { row: ngRow, col: ngCol, re: cellRe, im: cellIm });
              continue;
            }
            const ourRow = ngRowMap.get(ngRow);
            const ourCol = ngColMap.get(ngCol);
            if (ourRow === undefined || ourCol === undefined) {
              nUnmapped.set(cellKey(ngRow, ngCol),
                { row: ngRow, col: ngCol, re: cellRe, im: cellIm });
            } else {
              nMap.set(cellKey(ourRow, ourCol),
                { row: ourRow, col: ourCol, re: cellRe, im: cellIm });
            }
          }
        }
        // Surface any ngspice-only structural cells first (they're a
        // permanent topology issue, not transient per-point disagreement).
        if (nUnmapped.size > 0 && matrix === null) {
          const ngOnly = Array.from(nUnmapped.values())
            .sort((a, b) => a.col !== b.col ? a.col - b.col : a.row - b.row)[0]!;
          matrix = {
            pointIndex: i, freq: o.freq, row: ngOnly.row, col: ngOnly.col,
            kind: "ngspice-only",
            ours: null,
            ngspice: { re: ngOnly.re, im: ngOnly.im },
            absDelta: 0, relDelta: 0,
          };
        }
        // Iterate union of keys, ordered by (col asc, row asc) to be
        // deterministic. Build a sorted list of all cells from both sides.
        const allKeys = new Set<number>();
        for (const k of oMap.keys()) allKeys.add(k);
        for (const k of nMap.keys()) allKeys.add(k);
        const sortedCells: Array<{ row: number; col: number; key: number }> = [];
        for (const k of allKeys) {
          const fromO = oMap.get(k);
          const fromN = nMap.get(k);
          const ref = fromO ?? fromN!;
          sortedCells.push({ row: ref.row, col: ref.col, key: k });
        }
        sortedCells.sort((a, b) => a.col !== b.col ? a.col - b.col : a.row - b.row);

        for (const c of sortedCells) {
          const oc = oMap.get(c.key);
          const nc = nMap.get(c.key);
          if (oc && !nc) {
            matrix = {
              pointIndex: i, freq: o.freq, row: c.row, col: c.col,
              kind: "ours-only",
              ours: { re: oc.re, im: oc.im },
              ngspice: null,
              absDelta: 0, relDelta: 0,
            };
            break;
          }
          if (nc && !oc) {
            matrix = {
              pointIndex: i, freq: o.freq, row: c.row, col: c.col,
              kind: "ngspice-only",
              ours: null,
              ngspice: { re: nc.re, im: nc.im },
              absDelta: 0, relDelta: 0,
            };
            break;
          }
          if (oc && nc) {
            const dRe = oc.re - nc.re;
            const dIm = oc.im - nc.im;
            const absDelta = Math.hypot(dRe, dIm);
            if (absDelta > 0) {
              const oMag = Math.hypot(oc.re, oc.im);
              const nMag = Math.hypot(nc.re, nc.im);
              const denom = Math.max(oMag, nMag, Number.MIN_VALUE);
              matrix = {
                pointIndex: i, freq: o.freq, row: c.row, col: c.col,
                kind: "value-mismatch",
                ours: { re: oc.re, im: oc.im },
                ngspice: { re: nc.re, im: nc.im },
                absDelta,
                relDelta: absDelta / denom,
              };
              break;
            }
          }
        }
      }

      if (solution !== null && shape !== null && matrix !== null && rhs !== null) break;
    }

    const earliestCandidates: number[] = [];
    if (solution) earliestCandidates.push(solution.pointIndex);
    if (shape)    earliestCandidates.push(shape.pointIndex);
    if (matrix)   earliestCandidates.push(matrix.pointIndex);
    if (rhs)      earliestCandidates.push(rhs.pointIndex);
    const earliestPointIndex = earliestCandidates.length === 0
      ? null
      : Math.min(...earliestCandidates);

    return { earliestPointIndex, solution, shape, matrix, rhs };
  }
  get nodeMap(): NodeMapping[] { return this._nodeMap; }
  get ourTopology(): TopologySnapshot { return this._ourTopology; }
  get engine(): MNAEngine { return this._engine; }

  /**
   * Return the SPICE deck as actually loaded into ngspice by NgspiceBridge.
   *
   * - For cirPath-supplied sessions: the .cir contents with the `.control`
   *   block stripped (verbatim otherwise — author owns TEMP).
   * - For auto-generated decks (no cirPath): the output of
   *   `generateSpiceNetlist(compiled, registry, elementLabels)` with a
   *   `.options TEMP=<celsius>` card injected after the title line when the
   *   engine's `circuitTemp` differs from ngspice's 300.15 K default.
   * - For `selfCompare` sessions: empty string (no ngspice side).
   *
   * Call after `init()`. The deck is what `NgspiceBridge.loadNetlist` consumes
   * during `runDcOp()` / `runTransient()`, so this is the exact text fed to
   * ngspice for the current run. The `cirPath` form omits the `.control`
   * block (the harness drives ngspice imperatively, not via netlist commands).
   *
   * @param opts.raw - When `true`, return the pre-materialised `_cirClean`
   *   (no TEMP injection). Use to inspect the auto-generated emitter output
   *   without the temperature card noise. Default `false`.
   */
  getNgspiceDeck(opts?: { raw?: boolean }): string {
    this._ensureInited();
    if (opts?.raw) return this._cirClean;
    return this._materializeCir();
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  protected _ensureInited(): void {
    if (!this._inited) {
      throw new Error("ComparisonSession: call init() first");
    }
  }

  protected _ensureRun(): void {
    if (!this._ourSession) {
      throw new Error("ComparisonSession: call runDcOp() or runTransient() first");
    }
  }

  /**
   * Hard structural-parity gate fired at the end of runDcOp / runTransient.
   *
   * Walks every captured iteration on both sides and asserts
   * `ours.matrixSize === ngspice.matrixSize`. Any divergence is an A1-class
   * MNA-layout error: the engines have different equation counts and any
   * subsequent value comparison would require silently dropping or padding
   * one side's data- see comparison-session.ts:_computeLinearSystemData
   * which now densifies per-side rather than papering over with our size.
   *
   * Throws on the first mismatch found, with a structural error message
   * naming the divergence (sizes, step/iter/attempt locator, and which
   * column indices the larger side has that the smaller lacks). The fix
   * direction is always "modify our engine to match ngspice's MNA layout"
   *- this is not a tolerance or display setting.
   *
   * Skipped when `selfCompare` is set (both sides come from the same
   * engine, so sizes are identical by construction) or when ngspice has
   * no captured steps (e.g. ngspice failed during init/load- there's
   * nothing to compare and the existing `errors[]` already records that).
   */
  /**
   * Refresh the cached `_ourTopology` after the engine's `_setup()` has run.
   *
   * `captureTopology(compiled, engine.matrixSize, ...)` in `_initWithCircuit`
   * ran BEFORE the engine had a chance to discover its own equation count-
   * `engine.matrixSize` is 0 at init time and only becomes meaningful after
   * the first `dcOperatingPoint()`/`step()` has lazily invoked `_setup()`.
   *
   * Calling this method after a run completes re-captures the topology with
   * the now-correct `matrixSize`, so consumers like `harness_describe` see
   * the real value instead of the init-time 0. Cheap to call; the function
   * just rebuilds a few maps from `compiled` + the live engine state.
   */
  protected _refreshOurTopologyAfterSetup(): void {
    if (!this._engine || !this._engine.compiled) return;
    const compiled = this._engine.compiled as ConcreteCompiledAnalogCircuit;
    this._ourTopology = captureTopology(
      compiled,
      this._engine.matrixSize,
      this._elementLabels,
      this._engine.getNodeTable(),
    );
  }

  private _assertMatrixStructuralParity(): void {
    if (this._opts.selfCompare) return;
    const ours = this._ourSession;
    const ng = this._ngSession;
    if (!ours || !ng) return;
    if (ours.steps.length === 0 || ng.steps.length === 0) return;

    type IterCoord = { stepIndex: number; attemptIndex: number; iterIndex: number; size: number };
    const collect = (sess: CaptureSession): IterCoord[] => {
      const out: IterCoord[] = [];
      for (let si = 0; si < sess.steps.length; si++) {
        const step = sess.steps[si]!;
        for (let ai = 0; ai < step.attempts.length; ai++) {
          const att = step.attempts[ai]!;
          for (let ii = 0; ii < att.iterations.length; ii++) {
            out.push({
              stepIndex: si, attemptIndex: ai, iterIndex: ii,
              size: att.iterations[ii]!.matrixSize,
            });
          }
        }
      }
      return out;
    };

    const ourIters = collect(ours);
    const ngIters = collect(ng);

    // Constant-size invariant within each side: ngspice's matrixSize is
    // CKTmaxEqNum + 1 set at setup time; ours is voltages.length set when
    // ckt-context allocates its rhs buffers. Either side drifting mid-run
    // is itself an architectural bug.
    const checkConstant = (iters: IterCoord[], side: "ours" | "ngspice"): void => {
      if (iters.length === 0) return;
      const first = iters[0]!.size;
      for (const it of iters) {
        if (it.size !== first) {
          throw new Error(
            `Matrix structural divergence (${side}, intra-side drift): ` +
            `matrixSize changed from ${first} (step=0 iter=0) to ${it.size} ` +
            `(step=${it.stepIndex} attempt=${it.attemptIndex} iter=${it.iterIndex}). ` +
            `${side === "ours" ? "Our" : "ngspice"} engine equation count must be ` +
            `constant for the lifetime of a session- investigate whether a ` +
            `device added or removed an equation mid-run, which is itself an ` +
            `A1-class MNA-layout bug.`
          );
        }
      }
    };
    checkConstant(ourIters, "ours");
    checkConstant(ngIters, "ngspice");

    const ourSize = ourIters[0]?.size ?? 0;
    const ngSize = ngIters[0]?.size ?? 0;

    if (ourSize === ngSize) {
      // Dimensions match. Cross-check matrix-entry positions on the first
      // iteration to catch internal-index divergence (A1's row/col-ordering
      // sub-issue). After the cktLoad-order sort, our engine's lazy
      // sparse-solver Translate (sparse-solver.ts:399) should assign internal
      // indices in the same order ngspice does, so every (row, col) pair
      // present on one side must be present on the other with the same value.
      this._assertFirstIterationMatrixEntriesMatch(ours, ng);
      return;
    }

    // Cross-side divergence- collect detail for the first iteration where
    // both sides exist, so the error message can point at concrete CSC
    // entries the smaller side is missing.
    const firstShared = (() => {
      const ourMap = new Map<string, IterCoord>();
      for (const it of ourIters) ourMap.set(`${it.stepIndex}/${it.attemptIndex}/${it.iterIndex}`, it);
      for (const it of ngIters) {
        const k = `${it.stepIndex}/${it.attemptIndex}/${it.iterIndex}`;
        if (ourMap.has(k)) return { ours: ourMap.get(k)!, ng: it };
      }
      return null;
    })();

    let detail = "";
    if (firstShared) {
      const { stepIndex, attemptIndex, iterIndex } = firstShared.ng;
      const ourIt = ours.steps[stepIndex]!.attempts[attemptIndex]!.iterations[iterIndex]!;
      const ngIt = ng.steps[stepIndex]!.attempts[attemptIndex]!.iterations[iterIndex]!;
      const minSize = Math.min(ourSize, ngSize);
      const ourBeyond = ourIt.matrix.filter(e => e.row >= minSize || e.col >= minSize);
      const ngBeyond = ngIt.matrix.filter(e => e.row >= minSize || e.col >= minSize);
      const fmt = (e: { row: number; col: number; value: number }) =>
        `(row=${e.row}, col=${e.col}, val=${e.value})`;
      detail =
        `\nFirst paired iteration (step=${stepIndex} attempt=${attemptIndex} iter=${iterIndex}):` +
        (ourBeyond.length > 0 ? `\n  ours has ${ourBeyond.length} entries beyond shared range [0..${minSize - 1}]: ` +
          ourBeyond.slice(0, 8).map(fmt).join(", ") + (ourBeyond.length > 8 ? ", ..." : "") : "") +
        (ngBeyond.length > 0 ? `\n  ngspice has ${ngBeyond.length} entries beyond shared range [0..${minSize - 1}]: ` +
          ngBeyond.slice(0, 8).map(fmt).join(", ") + (ngBeyond.length > 8 ? ", ..." : "") : "");
    }

    const lacking = ourSize < ngSize ? "ours" : "ngspice";
    const message =
      `Matrix structural divergence (A1): equation counts differ between engines.\n` +
      `  ours.matrixSize = ${ourSize}\n` +
      `  ngspice.matrixSize = ${ngSize}\n` +
      `  delta = ${Math.abs(ourSize - ngSize)} equation(s)- ${lacking} side is short.\n` +
      `This is an MNA-layout architectural error. Per project rules ngspice is the ` +
      `golden reference; the fix direction is to modify our engine's equation ` +
      `allocation (likely CKTmkVolt/CKTmkCur equivalents in our setup path) so the ` +
      `equation count matches. Do NOT attempt to densify, pad, or otherwise reconcile ` +
      `at the harness level.${detail}`;
    this._structuralFindings.push({ kind: "matrix-size-divergence", message });
    if (!this._opts.deferStructuralAsserts) {
      throw new Error(message);
    }
  }

  /**
   * Compare the (row, col, value) multiset of the first-iteration MNA matrix
   * on both sides. Throws on any divergence- extra entries on either side,
   * missing entries, or value mismatches at the same position.
   *
   * Matrix entries reflect each engine's INTERNAL sparse-matrix indices
   * (assigned by ngspice's `Translate` / our `_translate` on first sight of
   * each external row/col during the first NR iteration's load loop). For
   * the indices to line up, both engines must call `cktLoad` in the same
   * per-device-type order- that's the A1 sort applied in compileAnalogPartition.
   *
   * Skipped when self-compare is set or either side has no captured iteration.
   */
  private _assertFirstIterationMatrixEntriesMatch(
    ours: CaptureSession,
    ng: CaptureSession,
  ): void {
    const ourIt = ours.steps[0]?.attempts[0]?.iterations[0];
    const ngIt = ng.steps[0]?.attempts[0]?.iterations[0];
    if (!ourIt || !ngIt) return;

    type Entry = { row: number; col: number; value: number };
    const key = (e: Entry) => `${e.row},${e.col}`;
    const ourMap = new Map<string, Entry>();
    const ngMap = new Map<string, Entry>();
    for (const e of ourIt.matrix) ourMap.set(key(e), e);
    for (const e of ngIt.matrix) ngMap.set(key(e), e);

    const oursOnly: Entry[] = [];
    const ngOnly: Entry[] = [];
    const valueMismatches: Array<{ pos: string; ours: number; ng: number }> = [];

    for (const [k, e] of ourMap) {
      const n = ngMap.get(k);
      if (n === undefined) {
        oursOnly.push(e);
      } else if (e.value !== n.value) {
        valueMismatches.push({ pos: k, ours: e.value, ng: n.value });
      }
    }
    for (const [k, e] of ngMap) {
      if (!ourMap.has(k)) ngOnly.push(e);
    }

    if (oursOnly.length === 0 && ngOnly.length === 0 && valueMismatches.length === 0) {
      return;
    }

    const fmt = (e: Entry) => `(row=${e.row}, col=${e.col}, val=${e.value})`;

    // Classification:
    //   coordSetDiffers  = (row, col) coordinate sets differ across sides.
    //                      Implies node-swap or MNA-layout drift.
    //   valuePermutation = coordinate sets identical AND value multisets
    //                      identical AND ≥1 cell holds a different value.
    //                      Same numbers landed at different cells: load-order
    //                      drift inside cktTranslate or a single device's
    //                      setup()/makeVolt order (e.g. BJT B'/C'/E' rotated).
    //                      Catches 2-swaps, 3-cycles, and longer permutations.
    //   valueOnly        = coordinate sets identical AND value multisets
    //                      DIFFER. Real arithmetic divergence at genuinely-
    //                      aligned cells: operand order in a multi-term stamp,
    //                      transcendental LSB, or a parameter mismatch.
    //
    // Permutation is a STRUCTURAL deficit, not a numerical drift- it points
    // at a porting bug in load order or internal-node allocation. Bit-exact
    // multiset equality keeps the project's no-tolerance bar: a single LSB
    // drift breaks the multiset match and falls through to valueOnly where
    // it belongs.
    const coordSetDiffers = oursOnly.length > 0 || ngOnly.length > 0;

    let valuePermutation = false;
    if (!coordSetDiffers && valueMismatches.length > 0) {
      const ourValues = ourIt.matrix.map(e => e.value).sort((a, b) => a - b);
      const ngValues = ngIt.matrix.map(e => e.value).sort((a, b) => a - b);
      if (ourValues.length === ngValues.length) {
        let multisetMatches = true;
        for (let i = 0; i < ourValues.length; i++) {
          if (ourValues[i] !== ngValues[i]) { multisetMatches = false; break; }
        }
        valuePermutation = multisetMatches;
      }
    }

    const isStructural = coordSetDiffers || valuePermutation;
    const isValueOnly = !isStructural && valueMismatches.length > 0;

    const lines: string[] = [];

    if (coordSetDiffers) {
      lines.push("Matrix-entry structural divergence at step=0 attempt=0 iter=0:");
      lines.push(`  ours has ${ourMap.size} entries; ngspice has ${ngMap.size} entries.`);
      if (oursOnly.length > 0) {
        lines.push(
          `  ${oursOnly.length} entries present in ours but missing in ngspice: ` +
            oursOnly.slice(0, 8).map(fmt).join(", ") +
            (oursOnly.length > 8 ? ", ..." : ""),
        );
      }
      if (ngOnly.length > 0) {
        lines.push(
          `  ${ngOnly.length} entries present in ngspice but missing in ours: ` +
            ngOnly.slice(0, 8).map(fmt).join(", ") +
            (ngOnly.length > 8 ? ", ..." : ""),
        );
      }
      if (valueMismatches.length > 0) {
        lines.push(
          `  Plus ${valueMismatches.length} same-coord value mismatch(es): ` +
            valueMismatches
              .slice(0, 8)
              .map((m) => `${m.pos} ours=${m.ours} ngspice=${m.ng}`)
              .join(", ") +
            (valueMismatches.length > 8 ? ", ..." : ""),
        );
      }
      lines.push(
        "(row, col) coordinate sets differ- node-swap, internal-node " +
          "allocation drift, or per-device-type load order out of sync with " +
          "ngspice's DEVices[] iteration order (see compileAnalogPartition's " +
          "ngspiceLoadOrder sort and core/analog-types.ts NGSPICE_LOAD_ORDER). " +
          "Do NOT reconcile at the harness level.",
      );
    } else if (valuePermutation) {
      lines.push("Matrix-entry value-permutation at step=0 attempt=0 iter=0:");
      lines.push(`  ours and ngspice have identical (row, col) layout (${ourMap.size} entries each)`);
      lines.push(`  AND identical value multisets, but ${valueMismatches.length} cell(s) hold different values:`);
      lines.push(
        `  ` +
          valueMismatches
            .slice(0, 8)
            .map((m) => `${m.pos} ours=${m.ours} ngspice=${m.ng}`)
            .join(", ") +
          (valueMismatches.length > 8 ? ", ..." : ""),
      );
      lines.push(
        "Same numbers landed at different cells- a permutation, not a numerical " +
          "drift. The line-by-line ngspice port has shifted either across " +
          "devices (NGSPICE_LOAD_ORDER) or within a single device's internal-" +
          "node allocation (e.g. a BJT with non-zero RB/RC/RE that calls " +
          "makeVolt for B'/C'/E' in a different order than ngspice's BJTsetup). " +
          "Permutation is structural, not numerical- do NOT close as 'arithmetic " +
          "drift'.",
      );
    } else if (isValueOnly) {
      lines.push("Matrix-entry value divergence at step=0 attempt=0 iter=0:");
      lines.push(`  ours and ngspice have identical (row, col) layout (${ourMap.size} entries each).`);
      lines.push(
        `  ${valueMismatches.length} entries with same (row,col) and different values, AND value multisets DIFFER (so this is NOT a permutation): ` +
          valueMismatches
            .slice(0, 8)
            .map((m) => `${m.pos} ours=${m.ours} ngspice=${m.ng}`)
            .join(", ") +
          (valueMismatches.length > 8 ? ", ..." : ""),
      );
      lines.push(
        "Layout matches and value multisets differ, so this is genuine " +
          "arithmetic divergence at aligned cells- NOT a load-order or " +
          "permutation bug. Likely causes: (a) operand order differs in a " +
          "multi-term stamp, (b) a model parameter is computed differently " +
          "between engines, (c) a transcendental call (exp/log/sqrt/pow) " +
          "returned a different LSB. Inspect the per-element stamps that " +
          "contribute to the listed cells.",
      );
    }
    void isStructural;  // tracked above; retained for future logging hooks
    const message = lines.join("\n");
    const kind = coordSetDiffers
      ? "first-iter-coord-set-differs"
      : valuePermutation
        ? "first-iter-value-permutation"
        : "first-iter-value-only";
    this._structuralFindings.push({ kind, message });
    if (!this._opts.deferStructuralAsserts) {
      throw new Error(message);
    }
  }

  private _stepPresence(stepIndex: number): SidePresence {
    const ours = this._ourSession?.steps[stepIndex];
    const ng   = this._ngSessionAligned()?.steps[stepIndex];
    if (ours && ng) return "both";
    if (ours)       return "oursOnly";
    return "ngspiceOnly";
  }

  private _stepStartTimeDelta(stepIndex: number): number | null {
    const ours = this._ourSession?.steps[stepIndex];
    const ng   = this._ngSessionAligned()?.steps[stepIndex];
    if (!ours || !ng) return null;
    return ours.stepStartTime - ng.stepStartTime;
  }

  private _buildNodeMapping(ngTopo: import("./types.js").NgspiceTopology | null): void {
    if (ngTopo) {
      this._ngTopology = ngTopo;
      this._nodeMap = buildDirectNodeMapping(
        this._ourTopology, ngTopo, this._engine.elements, this._elementLabels,
        this._engine.getNodeTable(),
      );
    }
  }

  private _reindexNgSession(): void {
    if (this._ngSession && this._nodeMap.length > 0) {
      // ourSize = matrixSize + 1 to match the snapshot dimension. Snapshots
      // store ctx.rhs/rhsOld via voltages.slice(); those buffers are sized
      // matrixSize+1 (ckt-context.ts:543-548) with slot 0 = ground sentinel,
      // matching the 1-based slot indexing used by node mappings and
      // el.branchIndex (compiler.ts:1189-1193). Using matrixSize alone leaves
      // the highest-numbered branch slot OOB and silently dropped, producing
      // NaN in the reindexed array.
      this._ngSessionReindexed = reindexNgspiceSession(
        this._ngSession, this._nodeMap, this._ourTopology.matrixSize + 1);
    } else {
      this._ngSessionReindexed = this._ngSession;
    }
    this._buildMatrixMaps();
    this._backfillNgspiceIntegCoeff();
  }

  /**
   * AC sibling of `_reindexNgSession`. Reindexes per-frequency solRe/solIm/
   * rhsRe/rhsIm; matrix entries pass through raw (translation happens at
   * comparison time in `acFirstDivergence` via `_ngMatrixRowMap`/
   * `_ngMatrixColMap` so allocation-order divergence stays visible).
   */
  private _reindexNgAcSession(): void {
    if (this._ngAcSession && this._nodeMap.length > 0) {
      this._ngAcSessionReindexed = reindexNgspiceAcSession(
        this._ngAcSession, this._nodeMap, this._ourTopology.matrixSize + 1);
    } else {
      this._ngAcSessionReindexed = this._ngAcSession;
    }
  }

  private _buildMatrixMaps(): void {
    this._ngMatrixRowMap.clear();
    this._ngMatrixColMap.clear();
    this._ngspiceOnlyRows = [];
    this._ngspiceOnlyRowLabels.clear();

    if (this._nodeMap.length === 0) return;

    const rowMapEntries = new Map<number, number>();
    for (const nm of this._nodeMap) {
      rowMapEntries.set(nm.ngspiceIndex, nm.ourIndex);
    }

    this._ngMatrixRowMap = new Map(rowMapEntries);
    this._ngMatrixColMap = new Map(rowMapEntries);

    const ngIndexToName = new Map<number, string>();
    if (this._ngTopology) {
      this._ngTopology.nodeNames.forEach((ngIdx, name) => {
        ngIndexToName.set(ngIdx, name);
      });
    }

    if (this._ngSession && this._ngSession.steps.length > 0) {
      const seenRows = new Set<number>();
      for (const step of this._ngSession.steps) {
        for (const iter of step.iterations) {
          for (const entry of iter.matrix) {
            const rows = [entry.row, entry.col];
            for (const r of rows) {
              if (this._ngMatrixRowMap.has(r)) continue;
              if (seenRows.has(r)) continue;
              seenRows.add(r);
              this._ngspiceOnlyRows.push(r);
              const rawName = ngIndexToName.get(r) ?? `ngspice_row${r}`;
              this._ngspiceOnlyRowLabels.set(r, prettyPrintNgspiceNodeName(rawName));
            }
          }
        }
        if (seenRows.size > 0) break;
      }
    }
  }

  /**
   * After the ngspice session is indexed, copy the ngspice half of
   * integrationCoefficients into the aligned our-session steps so that
   * step.integrationCoefficients.ngspice reflects real ngspice data.
   * The ours half is already filled by _captureIntegCoeff() during the run.
   */
  private _backfillNgspiceIntegCoeff(): void {
    const ourSteps = this._ourSession?.steps;
    const ngSteps = this._ngSessionAligned()?.steps;
    if (!ourSteps || !ngSteps) return;
    const count = Math.min(ourSteps.length, ngSteps.length);
    for (let i = 0; i < count; i++) {
      const ngCoeff = ngSteps[i]!.integrationCoefficients.ngspice;
      ourSteps[i]!.integrationCoefficients.ngspice = ngCoeff;
    }
  }

  protected _ngSessionAligned(): CaptureSession | null {
    return this._ngSessionReindexed ?? this._ngSession;
  }

  protected _getComparisons(): ComparisonResult[] {
    if (!this._comparisons) {
      const ng = this._ngSessionAligned();
      const matrixMaps = (this._ngMatrixRowMap.size > 0 && !this._opts.selfCompare)
        ? {
            ngRowToOurRow: this._ngMatrixRowMap,
            ngColToOurCol: this._ngMatrixColMap,
            ngspiceOnlyRows: new Set(this._ngspiceOnlyRows),
          }
        : undefined;
      this._comparisons = (this._ourSession && ng)
        ? compareSnapshots(this._ourSession, ng, matrixMaps)
        : [];
    }
    return this._comparisons;
  }

  /**
   * Resolve the author-supplied `nodesets` map (net/pin NAME -> volts) into the
   * id-keyed map `generateSpiceNetlist` consumes (digiTS node id -> volts).
   * Returns undefined when no nodesets were supplied. Throws naming any
   * unresolved name rather than silently dropping it — a nodeset that targets
   * no node would steer nothing and quietly defeat the test's purpose.
   */
  private _resolveNodesetNames(): ReadonlyMap<number, number> | undefined {
    const authored = this._opts.nodesets;
    if (!authored || authored.size === 0) return undefined;
    const resolved = new Map<number, number>();
    for (const [name, value] of authored) {
      const nodeId = this._findNodeIdByLabel(name, this._ourTopology.nodeLabels);
      if (nodeId === null) {
        const known = [...this._ourTopology.nodeLabels.values()].join(", ");
        throw new Error(
          `ComparisonSession: nodeset name '${name}' did not resolve to any ` +
          `compiled node. Known node labels: [${known}].`
        );
      }
      resolved.set(nodeId, value);
    }
    return resolved;
  }

  /**
   * Resolve the author-supplied `ics` map (net/pin NAME -> volts) into the
   * id-keyed map `generateSpiceNetlist` consumes (digiTS node id -> volts).
   * Returns undefined when no ICs were supplied. Throws naming any unresolved
   * name rather than silently dropping it — an IC that targets no node would
   * constrain nothing and quietly defeat the test's purpose. Mirrors
   * `_resolveNodesetNames`.
   */
  private _resolveIcNames(): ReadonlyMap<number, number> | undefined {
    const authored = this._opts.ics;
    if (!authored || authored.size === 0) return undefined;
    const resolved = new Map<number, number>();
    for (const [name, value] of authored) {
      const nodeId = this._findNodeIdByLabel(name, this._ourTopology.nodeLabels);
      if (nodeId === null) {
        const known = [...this._ourTopology.nodeLabels.values()].join(", ");
        throw new Error(
          `ComparisonSession: ic name '${name}' did not resolve to any ` +
          `compiled node. Known node labels: [${known}].`
        );
      }
      resolved.set(nodeId, value);
    }
    return resolved;
  }

  private _findNodeIdByLabel(label: string, nodeLabels: Map<number, string>): number | null {
    const target = label.trim().toUpperCase();
    let exactMatch: number | null = null;
    const segmentMatches: number[] = [];
    nodeLabels.forEach((stored, nodeId) => {
      if (nodeId <= 0) return;
      const storedUpper = stored.toUpperCase();
      if (storedUpper === target) { exactMatch = nodeId; return; }
      const segments = storedUpper.split("/");
      if (segments.some(s => s === target)) segmentMatches.push(nodeId);
    });
    if (exactMatch !== null) return exactMatch;
    if (segmentMatches.length === 0) return null;
    if (segmentMatches.length > 1) {
      const matchedLabels = segmentMatches.map(id => nodeLabels.get(id));
      throw new Error(`Ambiguous node label: '${label}' matches stored labels [${matchedLabels.join(", ")}]`);
    }
    return segmentMatches[0];
  }

  private _formatSpiceTime(seconds: number): string {
    // Use the JS number's own string form so SPICE's strtod parses the same
    // IEEE-754 double we hold here. Engineering suffixes ("10u", "1m") trigger
    // SPICE-side `magnitude * 1e-N` multiplications that introduce 1-ULP
    // mismatches against the JS literal  e.g. SPICE "10u"  10 * 1e-6 =
    // 0x3ee4f8b588e368f0, while JS `10e-6` === `1e-5` = 0x3ee4f8b588e368f1
    // (1 ULP higher). Plain decimal / scientific text round-trips exactly.
    return seconds.toString();
  }

  private _captureIntegCoeff(): IntegrationCoefficients {
    if (!this._engine) return _zeroDcopCoefficients();
    const order = this._engine.integrationOrder;
    const method: IntegrationMethod = this._engine.integrationMethod;
    // After a step completes: deltaOld[0] = dt used in this step (set by setDeltaOldCurrent),
    // deltaOld[1] = dt of the previous step (h1), deltaOld[2] = h_{n-2}.
    const deltaOld = this._engine.timestepDeltaOld;
    const dt = deltaOld[0] > 0 ? deltaOld[0] : this._engine.currentDt;
    const agBuf = new Float64Array(7);
    const scratchBuf = new Float64Array(49);
    computeNIcomCof(dt, deltaOld as number[], order, method, this._engine.integrationXmu, agBuf, scratchBuf);
    const ag0 = agBuf[0];
    const ag1 = agBuf[1];
    return {
      ours: { ag0, ag1, method, order },
      ngspice: { ag0: 0, ag1: 0, method: "trapezoidal", order: 1 },
    };
  }

  private _curAnalysisPhase(): "dcop" | "tranInit" | "tranFloat" {
    const phase = (this._coordinator as any)?._analysisPhase;
    if (phase === "tranInit") return "tranInit";
    if (phase === "tranFloat") return "tranFloat";
    return "dcop";
  }

  // ---------------------------------------------------------------------------
  // Diff / investigation API (consumed by harness_topology_diff,
  // harness_matrix_diff, harness_first_divergence)
  // ---------------------------------------------------------------------------

  /** Findings deferred from the structural-parity asserts. Read-only snapshot. */
  get structuralFindings(): ReadonlyArray<{ kind: string; message: string }> {
    return this._structuralFindings;
  }

  /**
   * Compare element-and-node topology between our compiled circuit and
   * ngspice's deck. Does NOT require `runDcOp` / `runTransient` (but ngspice
   * topology is only populated after a run, so element / ordering diffs are
   * empty before that). Surfaces:
   *
   * - elementDiffs: components present on one side but not the other (matched
   *   by lowercased label, with SPICE-prefix canonicalisation that mirrors
   *   `generateSpiceNetlist` / `buildDirectNodeMapping`);
   * - orderingDiffs: matched nodes/branches whose 1-based slot index differs
   *   between sides — every entry is one element "allocated in a different
   *   order";
   * - unmappedNgspiceNodes: ngspice nodes that the node-mapping pass could not
   *   resolve to one of our slots (typically composite-internal nodes whose
   *   names didn't follow the conventions exhaustively in node-mapping.ts);
   * - structuralFindings: deferred copies of the messages
   *   `_assertMatrixStructuralParity` would have thrown.
   */
  topologyDiff(): TopologyDiffReport {
    this._ensureInited();
    const ourTopo = this._ourTopology;
    const ngTopo = this._ngTopology;
    const findings = this._structuralFindings.map(f => ({ kind: f.kind, message: f.message }));

    if (!ngTopo) {
      return {
        ourElementCount: ourTopo.elementCount,
        ngspiceElementCount: 0,
        ourNodeCount: ourTopo.nodeCount,
        ngspiceNodeCount: 0,
        ourMatrixSize: ourTopo.matrixSize,
        ngspiceMatrixSize: 0,
        elementDiffs: [],
        orderingDiffs: [],
        unmappedNgspiceNodes: [],
        structuralFindings: findings,
      };
    }

    // Element correspondence by lowercased label, with prefix-augmented
    // variants to cover the canonicalSpiceLabel transform applied by
    // generateSpiceNetlist (a Capacitor labelled "Vc" gets emitted as "CVc").
    // We compute candidate ngspice deck names per our element and check
    // membership against the ngTopo.devices map.
    const ngByName = new Map<string, typeof ngTopo.devices[number]>();
    for (const d of ngTopo.devices) ngByName.set(d.name.toLowerCase(), d);

    const matchedNgNames = new Set<string>();
    const elementDiffs: TopologyElementDiff[] = [];

    const prefixCandidates = ["v", "l", "e", "f", "h", "r", "c", "d", "q", "m", "j", "i", "g", "s", "w", "t"];
    const candidatesFor = (label: string): string[] => {
      const lower = label.toLowerCase();
      const underscored = lower.replace(/:/g, "_");
      const seen = new Set<string>();
      const out: string[] = [];
      const push = (s: string) => { if (!seen.has(s)) { seen.add(s); out.push(s); } };
      push(lower);
      push(underscored);
      for (const p of prefixCandidates) {
        push(`${p}${lower}`);
        push(`${p}${underscored}`);
      }
      return out;
    };

    for (const el of ourTopo.elements) {
      let matched: typeof ngTopo.devices[number] | null = null;
      for (const cand of candidatesFor(el.label)) {
        const d = ngByName.get(cand);
        if (d) { matched = d; matchedNgNames.add(cand); break; }
      }
      if (!matched) {
        elementDiffs.push({
          ourLabel: el.label,
          ngspiceLabel: null,
          ourType: el.type,
          ngspiceType: null,
          reason: "ours-only",
        });
      }
    }

    for (const [name, dev] of ngByName) {
      if (matchedNgNames.has(name)) continue;
      // Already covered as ngspice-only? Track by ngspice name to dedupe across
      // the multiple candidate-form lookups above.
      elementDiffs.push({
        ourLabel: null,
        ngspiceLabel: dev.name,
        ourType: null,
        ngspiceType: dev.typeName,
        reason: "ngspice-only",
      });
    }

    // Ordering diffs: matched mappings where ourIndex !== ngspiceIndex.
    // Skip ground (ourIndex === 0) — both sides reserve slot 0 unconditionally.
    const orderingDiffs: TopologyOrderingDiff[] = [];
    for (const m of this._nodeMap) {
      if (m.ourIndex === 0) continue;
      if (m.ourIndex !== m.ngspiceIndex) {
        const isBranch = m.ourIndex > ourTopo.nodeCount;
        orderingDiffs.push({
          label: m.label,
          ourSlotIndex: m.ourIndex,
          ngspiceSlotIndex: m.ngspiceIndex,
          kind: isBranch ? "branch" : "node",
        });
      }
    }
    orderingDiffs.sort((a, b) => a.ourSlotIndex - b.ourSlotIndex);

    const mappedNg = new Set<number>(this._nodeMap.map(m => m.ngspiceIndex));
    const unmappedNgspiceNodes: Array<{ ngspiceName: string; ngspiceIndex: number }> = [];
    ngTopo.nodeNames.forEach((idx, name) => {
      if (idx > 0 && !mappedNg.has(idx)) {
        unmappedNgspiceNodes.push({ ngspiceName: name, ngspiceIndex: idx });
      }
    });
    unmappedNgspiceNodes.sort((a, b) => a.ngspiceIndex - b.ngspiceIndex);

    // ngTopo.nodeNames contains both voltage-node entries and branch-row
    // entries (ngspice's `<elem>#branch` pseudonames created via CKTmkCur for
    // vsources, inductors, etc.). Our convention's `nodeCount` is voltage
    // nodes ONLY (branches live in the matrix past `nodeCount`). Filter the
    // branch rows here so `ngspiceNodeCount` is comparable to `ourNodeCount`
    // when the physical topologies match.
    let ngVoltageNodeCount = 0;
    ngTopo.nodeNames.forEach((_, name) => {
      if (!name.endsWith("#branch")) ngVoltageNodeCount++;
    });

    return {
      ourElementCount: ourTopo.elementCount,
      ngspiceElementCount: ngTopo.devices.length,
      ourNodeCount: ourTopo.nodeCount,
      ngspiceNodeCount: ngVoltageNodeCount,
      ourMatrixSize: ourTopo.matrixSize,
      ngspiceMatrixSize: ngTopo.matrixSize,
      elementDiffs,
      orderingDiffs,
      unmappedNgspiceNodes,
      structuralFindings: findings,
    };
  }

  /**
   * Compute a matrix diff at one reference iteration AND scan the whole
   * session to attribute each divergent cell to the (step, iter) where it
   * first diverged. Reference defaults to (step 0, iter 0) — the same site
   * `_assertFirstIterationMatrixEntriesMatch` classifies.
   *
   * Classification logic mirrors `_assertFirstIterationMatrixEntriesMatch`
   * (coord-set-differs / value-permutation / value-only / match) so MCP
   * consumers get the same verdict the assertion would have produced.
   *
   * ngspice cells are reindexed into our matrix coordinate space via
   * `_ngMatrixRowMap` / `_ngMatrixColMap` so labels line up. Cells whose
   * ngspice indices have no mapping are dropped from the comparison and
   * surfaced via `harness_topology_diff` (`unmappedNgspiceNodes`) instead.
   */
  matrixDiff(opts?: { stepIndex?: number; iterationIndex?: number }): MatrixDiffReport {
    this._ensureRun();
    const stepIndex = opts?.stepIndex ?? 0;
    const iterationIndex = opts?.iterationIndex ?? 0;

    const ourSess = this._ourSession;
    const ngSess = this._ngSessionAligned();
    if (!ourSess || !ngSess) {
      throw new Error("matrixDiff: no captured sessions");
    }

    const ourStep = ourSess.steps[stepIndex];
    const ngStep = ngSess.steps[stepIndex];
    if (!ourStep || !ngStep) {
      throw new Error(`matrixDiff: step ${stepIndex} out of range`);
    }

    const pickIter = (step: StepSnapshot) => {
      const accIdx = step.acceptedAttemptIndex >= 0 ? step.acceptedAttemptIndex : 0;
      const iters = step.attempts[accIdx]?.iterations ?? step.iterations;
      return iters[iterationIndex] ?? null;
    };
    const ourIt = pickIter(ourStep);
    const ngIt = pickIter(ngStep);
    if (!ourIt || !ngIt) {
      throw new Error(`matrixDiff: iteration ${iterationIndex} out of range at step ${stepIndex}`);
    }

    const identityMode = this._opts.selfCompare || this._ngMatrixRowMap.size === 0;
    const buildOurMap = (iter: import("./types.js").IterationSnapshot): Map<string, number> => {
      const m = new Map<string, number>();
      for (const e of iter.matrix) m.set(`${e.row},${e.col}`, e.value);
      return m;
    };
    const buildNgMap = (iter: import("./types.js").IterationSnapshot): Map<string, number> => {
      const m = new Map<string, number>();
      for (const e of iter.matrix) {
        let r = e.row, c = e.col;
        if (!identityMode) {
          const mr = this._ngMatrixRowMap.get(e.row);
          const mc = this._ngMatrixColMap.get(e.col);
          if (mr === undefined || mc === undefined) continue;
          r = mr; c = mc;
        }
        m.set(`${r},${c}`, e.value);
      }
      return m;
    };

    const ourMap = buildOurMap(ourIt);
    const ngMap = buildNgMap(ngIt);

    const labelFor = (r: number, c: number) => ({
      rowLabel: this._ourTopology.matrixRowLabels.get(r) ?? `row${r}`,
      colLabel: this._ourTopology.matrixColLabels.get(c) ?? `col${c}`,
    });

    const oursOnly: MatrixDiffCell[] = [];
    const ngspiceOnly: MatrixDiffCell[] = [];
    const valueMismatches: MatrixDiffCell[] = [];

    const parseKey = (k: string): [number, number] => {
      const idx = k.indexOf(",");
      return [Number(k.slice(0, idx)), Number(k.slice(idx + 1))];
    };

    for (const [k, ours] of ourMap) {
      const ng = ngMap.get(k);
      const [r, c] = parseKey(k);
      const { rowLabel, colLabel } = labelFor(r, c);
      if (ng === undefined) {
        oursOnly.push({
          row: r, col: c, rowLabel, colLabel,
          ours, ngspice: null,
          absDelta: NaN,
          firstDivergentStep: null, firstDivergentIteration: null,
        });
      } else if (ours !== ng) {
        valueMismatches.push({
          row: r, col: c, rowLabel, colLabel,
          ours, ngspice: ng,
          absDelta: Math.abs(ours - ng),
          firstDivergentStep: null, firstDivergentIteration: null,
        });
      }
    }
    for (const [k, ng] of ngMap) {
      if (ourMap.has(k)) continue;
      const [r, c] = parseKey(k);
      const { rowLabel, colLabel } = labelFor(r, c);
      ngspiceOnly.push({
        row: r, col: c, rowLabel, colLabel,
        ours: null, ngspice: ng,
        absDelta: NaN,
        firstDivergentStep: null, firstDivergentIteration: null,
      });
    }

    const coordSetDiffers = oursOnly.length > 0 || ngspiceOnly.length > 0;
    let classification: MatrixDiffClassification;
    if (coordSetDiffers) {
      classification = "coord-set-differs";
    } else if (valueMismatches.length === 0) {
      classification = "match";
    } else {
      const ourVals = [...ourMap.values()].sort((a, b) => a - b);
      const ngVals = [...ngMap.values()].sort((a, b) => a - b);
      let multisetMatches = ourVals.length === ngVals.length;
      if (multisetMatches) {
        for (let i = 0; i < ourVals.length; i++) {
          if (ourVals[i] !== ngVals[i]) { multisetMatches = false; break; }
        }
      }
      classification = multisetMatches ? "value-permutation" : "value-only";
    }

    // First-divergent-step scan: only for cells already flagged divergent at
    // the reference iteration. Single forward pass over paired accepted-attempt
    // iterations; each cell key is removed from the remaining set as soon as
    // it's resolved, so the cost is O((nSteps × nIters) × nNonzeros) only
    // until every cell has been attributed.
    const allDivergent: MatrixDiffCell[] = [...valueMismatches, ...oursOnly, ...ngspiceOnly];
    if (allDivergent.length > 0) {
      const byKey = new Map<string, MatrixDiffCell[]>();
      for (const cell of allDivergent) {
        const k = `${cell.row},${cell.col}`;
        let bucket = byKey.get(k);
        if (!bucket) { bucket = []; byKey.set(k, bucket); }
        bucket.push(cell);
      }
      const remaining = new Set<string>(byKey.keys());
      const stepCount = Math.min(ourSess.steps.length, ngSess.steps.length);
      outer:
      for (let si = 0; si < stepCount; si++) {
        if (remaining.size === 0) break outer;
        const ourStepN = ourSess.steps[si]!;
        const ngStepN = ngSess.steps[si]!;
        const ourAcc = ourStepN.acceptedAttemptIndex >= 0 ? ourStepN.acceptedAttemptIndex : 0;
        const ngAcc = ngStepN.acceptedAttemptIndex >= 0 ? ngStepN.acceptedAttemptIndex : 0;
        const ourIters = ourStepN.attempts[ourAcc]?.iterations ?? ourStepN.iterations;
        const ngIters = ngStepN.attempts[ngAcc]?.iterations ?? ngStepN.iterations;
        const iterCount = Math.min(ourIters.length, ngIters.length);
        for (let ii = 0; ii < iterCount; ii++) {
          if (remaining.size === 0) break outer;
          const our = ourIters[ii]!;
          const ng = ngIters[ii]!;
          const oM = buildOurMap(our);
          const nM = buildNgMap(ng);
          for (const k of [...remaining]) {
            const ov = oM.get(k);
            const nv = nM.get(k);
            const ovPresent = ov !== undefined;
            const nvPresent = nv !== undefined;
            const divergent = (ovPresent !== nvPresent) || (ovPresent && nvPresent && ov !== nv);
            if (divergent) {
              const bucket = byKey.get(k)!;
              for (const cell of bucket) {
                cell.firstDivergentStep = si;
                cell.firstDivergentIteration = ii;
              }
              remaining.delete(k);
            }
          }
        }
      }
    }

    valueMismatches.sort((a, b) => b.absDelta - a.absDelta);
    oursOnly.sort((a, b) => (a.row - b.row) || (a.col - b.col));
    ngspiceOnly.sort((a, b) => (a.row - b.row) || (a.col - b.col));

    return {
      stepIndex,
      iterationIndex,
      classification,
      ourCellCount: ourMap.size,
      ngspiceCellCount: ngMap.size,
      oursOnly,
      ngspiceOnly,
      valueMismatches,
    };
  }

  // ---------------------------------------------------------------------------
  // firstDivergence per-class walks
  //
  // Each returns the first FirstDivergenceSignal in its class at (si, ii), or
  // null. `ourIt` is raw (our coords); `ngIt` is the node-mapping-aligned
  // ngspice iteration, so `voltages` / `preSolveRhs` are already reindexed into
  // our coordinate space (node-mapping.ts reindexArray) and compare
  // index-by-index. The matrix is intentionally NOT pre-reindexed; its walk
  // translates (row, col) via _ngMatrixRowMap/_ngMatrixColMap at compare time so
  // allocation-order drift stays visible. Strict bit-exact: any `!==` diverges.
  // ---------------------------------------------------------------------------

  private _fdVoltage(si: number, ii: number, ourIt: IterationSnapshot, ngIt: IterationSnapshot): FirstDivergenceSignal | null {
    const n = Math.min(ourIt.voltages.length, ngIt.voltages.length);
    for (let nodeIdx = 1; nodeIdx < n; nodeIdx++) {
      const ov = ourIt.voltages[nodeIdx];
      const nv = ngIt.voltages[nodeIdx];
      if (ov !== nv) {
        const label = this._ourTopology.nodeLabels.get(nodeIdx)
          ?? this._ourTopology.matrixRowLabels.get(nodeIdx - 1)
          ?? `slot${nodeIdx}`;
        return { signalClass: "voltage", stepIndex: si, iterationIndex: ii, attribute: label, ours: ov, ngspice: nv, absDelta: Math.abs(ov - nv) };
      }
    }
    return null;
  }

  private _fdRhs(si: number, ii: number, ourIt: IterationSnapshot, ngIt: IterationSnapshot): FirstDivergenceSignal | null {
    // preSolveRhs shares the solution-vector index space (index 0 = ground),
    // and the aligned ngspice side is reindexed by the same reindexArray as
    // voltages, so this walk is the exact sibling of _fdVoltage.
    const m = Math.min(ourIt.preSolveRhs.length, ngIt.preSolveRhs.length);
    for (let r = 1; r < m; r++) {
      const orhs = ourIt.preSolveRhs[r];
      const nrhs = ngIt.preSolveRhs[r];
      if (orhs !== nrhs) {
        const label = this._ourTopology.nodeLabels.get(r)
          ?? this._ourTopology.matrixRowLabels.get(r - 1)
          ?? `row${r}`;
        return { signalClass: "rhs", stepIndex: si, iterationIndex: ii, attribute: label, ours: orhs, ngspice: nrhs, absDelta: Math.abs(orhs - nrhs) };
      }
    }
    return null;
  }

  private _fdMatrix(si: number, ii: number, ourIt: IterationSnapshot, ngIt: IterationSnapshot, identityMode: boolean): FirstDivergenceSignal | null {
    const ourMap = new Map<string, number>();
    for (const e of ourIt.matrix) ourMap.set(`${e.row},${e.col}`, e.value);
    const ngMap = new Map<string, number>();
    for (const e of ngIt.matrix) {
      let r = e.row, c = e.col;
      if (!identityMode) {
        const mr = this._ngMatrixRowMap.get(e.row);
        const mc = this._ngMatrixColMap.get(e.col);
        if (mr === undefined || mc === undefined) continue;
        r = mr; c = mc;
      }
      ngMap.set(`${r},${c}`, e.value);
    }
    const labelKey = (r: number, c: number) =>
      `(${this._ourTopology.matrixRowLabels.get(r) ?? `row${r}`},${this._ourTopology.matrixColLabels.get(c) ?? `col${c}`})`;
    for (const [k, ov] of ourMap) {
      const nv = ngMap.get(k);
      if (nv === undefined || nv !== ov) {
        const idx = k.indexOf(",");
        const r = Number(k.slice(0, idx));
        const c = Number(k.slice(idx + 1));
        return { signalClass: "matrix", stepIndex: si, iterationIndex: ii, attribute: labelKey(r, c), ours: ov, ngspice: nv ?? "(missing)", absDelta: nv !== undefined ? Math.abs(ov - nv) : Infinity };
      }
    }
    for (const [k, nv] of ngMap) {
      if (!ourMap.has(k)) {
        const idx = k.indexOf(",");
        const r = Number(k.slice(0, idx));
        const c = Number(k.slice(idx + 1));
        return { signalClass: "matrix", stepIndex: si, iterationIndex: ii, attribute: labelKey(r, c), ours: "(missing)", ngspice: nv, absDelta: Infinity };
      }
    }
    return null;
  }

  /**
   * state0 (current step) is always compared; state1/2/3 (history read by
   * companion models and LTE) are compared only on tran steps, where the
   * accepted-step rotation makes them meaningful- on DCOP steps ngspice's
   * history slots carry no defined relationship to ours.
   */
  private _fdState(si: number, ii: number, ourIt: IterationSnapshot, ngIt: IterationSnapshot, includeHistory: boolean): FirstDivergenceSignal | null {
    const slotPair = (label: string, ourSlots: Record<string, number>, ngSlots: Record<string, number>, suffix: string): FirstDivergenceSignal | null => {
      for (const [slot, value] of Object.entries(ourSlots ?? {})) {
        const ngValue = (ngSlots ?? {})[slot];
        if (ngValue === undefined) continue;
        if (value !== ngValue) {
          return { signalClass: "state", stepIndex: si, iterationIndex: ii, attribute: `${label}.${slot}${suffix}`, ours: value, ngspice: ngValue, absDelta: Math.abs(value - ngValue) };
        }
      }
      return null;
    };
    for (const ourEs of ourIt.elementStates) {
      const ngEs = ngIt.elementStates.find(e => e.label.toUpperCase() === ourEs.label.toUpperCase());
      if (!ngEs) continue;
      const s0 = slotPair(ourEs.label, ourEs.slots, ngEs.slots, "");
      if (s0) return s0;
      if (includeHistory) {
        const s1 = slotPair(ourEs.label, ourEs.state1Slots, ngEs.state1Slots, " (state1)");
        if (s1) return s1;
        const s2 = slotPair(ourEs.label, ourEs.state2Slots, ngEs.state2Slots, " (state2)");
        if (s2) return s2;
        const s3 = slotPair(ourEs.label, ourEs.state3Slots, ngEs.state3Slots, " (state3)");
        if (s3) return s3;
      }
    }
    return null;
  }

  /**
   * Per-iteration timestep / integration-coefficient comparison. Only ag0/ag1
   * are compared (ngspice's FFI marshals two doubles; higher ag slots are 0 on
   * the ngspice side). `lteDt` (next-step proposal) is compared only on the
   * final paired iteration where both sides populate it. Caller gates this to
   * tran steps- DCOP has no active integration.
   */
  private _fdIntegration(si: number, ii: number, ourIt: IterationSnapshot, ngIt: IterationSnapshot, isFinalIter: boolean): FirstDivergenceSignal | null {
    const num = (attr: string, o: number, n: number): FirstDivergenceSignal =>
      ({ signalClass: "integration", stepIndex: si, iterationIndex: ii, attribute: attr, ours: o, ngspice: n, absDelta: Math.abs(o - n) });
    if (ourIt.delta !== ngIt.delta) return num("delta", ourIt.delta, ngIt.delta);
    if (ourIt.order !== ngIt.order) return num("order", ourIt.order, ngIt.order);
    if (ourIt.method !== ngIt.method) return { signalClass: "integration", stepIndex: si, iterationIndex: ii, attribute: "method", ours: ourIt.method, ngspice: ngIt.method, absDelta: 1 };
    if (ourIt.ag[0] !== ngIt.ag[0]) return num("ag0", ourIt.ag[0], ngIt.ag[0]);
    if (ourIt.ag[1] !== ngIt.ag[1]) return num("ag1", ourIt.ag[1], ngIt.ag[1]);
    if (isFinalIter && ourIt.lteDt !== undefined && ngIt.lteDt !== undefined && ourIt.lteDt !== ngIt.lteDt) return num("lteDt", ourIt.lteDt, ngIt.lteDt);
    return null;
  }

  /**
   * Junction-limiting comparison. Events are paired by (label, junction)- the
   * ngspice bridge already maps each raw `deviceName` onto `LimitingEvent.label`
   * (ngspice-bridge.ts), so both sides expose the same typed shape. Only matched
   * events are compared- an event present on one side only is not flagged here
   * (its downstream effect on the stamp surfaces in rhs/matrix/voltage), which
   * keeps this class free of capture-shape false positives.
   */
  private _fdLimiting(si: number, ii: number, ourIt: IterationSnapshot, ngIt: IterationSnapshot): FirstDivergenceSignal | null {
    const ngEvents = ngIt.limitingEvents ?? [];
    for (const oe of ourIt.limitingEvents ?? []) {
      const oLabel = oe.label.toUpperCase();
      const ne = ngEvents.find(e => e.label.toUpperCase() === oLabel && e.junction === oe.junction);
      if (!ne) continue;
      if (oe.wasLimited !== ne.wasLimited) {
        return { signalClass: "limiting", stepIndex: si, iterationIndex: ii, attribute: `${oe.label}:${oe.junction}.wasLimited`, ours: oe.wasLimited ? 1 : 0, ngspice: ne.wasLimited ? 1 : 0, absDelta: 1 };
      }
      if (oe.vAfter !== ne.vAfter) {
        return { signalClass: "limiting", stepIndex: si, iterationIndex: ii, attribute: `${oe.label}:${oe.junction}.vAfter`, ours: oe.vAfter, ngspice: ne.vAfter, absDelta: Math.abs(oe.vAfter - ne.vAfter) };
      }
    }
    return null;
  }

  /**
   * Per-element convergence-flag disagreement (NR blame). Only elements matched
   * on both sides are compared. When the iterate values match bit-exact this
   * isolates a convergence-predicate difference; when they do not, a value
   * class fires at a lower causal rank and this is reported as the additional
   * (downstream) axis rather than `earliest`.
   */
  private _fdConvergence(si: number, ii: number, ourIt: IterationSnapshot, ngIt: IterationSnapshot): FirstDivergenceSignal | null {
    const ourFailed = new Set((ourIt.convergenceFailedElements ?? []).map(d => d.toUpperCase()));
    const ngFailed = new Set((ngIt.ngspiceConvergenceFailedDevices ?? []).map(d => d.toUpperCase()));
    for (const ourEs of ourIt.elementStates) {
      const ngEs = ngIt.elementStates.find(e => e.label.toUpperCase() === ourEs.label.toUpperCase());
      if (!ngEs) continue;
      const ourConv = !ourFailed.has(ourEs.label.toUpperCase());
      const ngConv = !ngFailed.has(ngEs.label.toUpperCase());
      if (ourConv !== ngConv) {
        return { signalClass: "convergence", stepIndex: si, iterationIndex: ii, attribute: ourEs.label, ours: ourConv ? "converged" : "failed", ngspice: ngConv ? "converged" : "failed", absDelta: 1 };
      }
    }
    return null;
  }

  /**
   * Structural / algorithmic-phase divergence, reported at iterationIndex 0.
   * Step-level: attempt count, accepted-attempt index, accepted-attempt phase.
   * Phase-desync at the accepted attempt's first iteration: matrixSize, NR mode
   * (cktMode), gmin-stepping factor, source-stepping factor- a mismatch means
   * the two engines are in different NR sub-phases and every per-cell compare
   * downstream would be apples-to-oranges.
   */
  private _fdShape(si: number, ourStep: StepSnapshot, ngStep: StepSnapshot, ourIt0: IterationSnapshot | null, ngIt0: IterationSnapshot | null): FirstDivergenceSignal | null {
    const sig = (attr: string, o: number | string, n: number | string, d: number): FirstDivergenceSignal =>
      ({ signalClass: "shape", stepIndex: si, iterationIndex: 0, attribute: attr, ours: o, ngspice: n, absDelta: d });
    if (ourStep.attempts.length !== ngStep.attempts.length) {
      return sig("attemptCount", ourStep.attempts.length, ngStep.attempts.length, Math.abs(ourStep.attempts.length - ngStep.attempts.length));
    }
    const ourAcc = ourStep.acceptedAttemptIndex;
    const ngAcc = ngStep.acceptedAttemptIndex;
    if (ourAcc !== ngAcc) return sig("acceptedAttemptIndex", ourAcc, ngAcc, Math.abs(ourAcc - ngAcc));
    const ourPhase = ourStep.attempts[Math.max(0, ourAcc)]?.phase ?? "(none)";
    const ngPhase = ngStep.attempts[Math.max(0, ngAcc)]?.phase ?? "(none)";
    if (ourPhase !== ngPhase) return sig("acceptedPhase", ourPhase, ngPhase, 1);
    if (ourIt0 && ngIt0) {
      if (ourIt0.matrixSize !== ngIt0.matrixSize) return sig("matrixSize", ourIt0.matrixSize, ngIt0.matrixSize, Math.abs(ourIt0.matrixSize - ngIt0.matrixSize));
      if (ourIt0.initMode !== ngIt0.initMode) return sig("initMode", ourIt0.initMode, ngIt0.initMode, 1);
      if (ourIt0.diagGmin !== ngIt0.diagGmin) return sig("diagGmin", ourIt0.diagGmin, ngIt0.diagGmin, Math.abs(ourIt0.diagGmin - ngIt0.diagGmin));
      if (ourIt0.srcFact !== ngIt0.srcFact) return sig("srcFact", ourIt0.srcFact, ngIt0.srcFact, Math.abs(ourIt0.srcFact - ngIt0.srcFact));
    }
    return null;
  }

  /**
   * Walk paired iterations in chronological order and return the first
   * divergence in each signal class:
   *  - shape:       structural / phase divergence (attempt count, accepted
   *                 phase, NR mode, matrixSize, gmin/source-stepping);
   *  - integration: timestep / integration coefficients (delta, order, method,
   *                 ag0, ag1, lteDt)- tran steps only;
   *  - state:       any element-state slot, at any vintage (state0 + state1/2/3);
   *  - limiting:    a junction-limiting event (applied flag or post-limit V);
   *  - rhs:         any preSolveRhs cell (companion-current / excitation vector);
   *  - matrix:      any (row, col) Jacobian cell (presence or value);
   *  - voltage:     any post-solve node-voltage cell;
   *  - convergence: a matched element's converged-flag disagreement.
   *
   * `earliest` picks the lowest `(stepIndex, iterationIndex)`; ties are broken
   * by causal upstream-ness (CAUSAL_RANK) so the router points at the cause, not
   * a downstream symptom- a divergent rhs over an identical matrix shows up as a
   * divergent post-solve voltage at the SAME iteration, and voltage must lose
   * that tie to rhs. Agents start here to choose which axis to drill into before
   * calling `harness_get_attempt`; the pre-solve guess, residual, and
   * pinCurrents are reachable there per-side (they are functions of the classes
   * above).
   */
  firstDivergence(): FirstDivergenceReport {
    this._ensureRun();
    const ourSess = this._ourSession;
    const ngSess = this._ngSessionAligned();

    let voltage: FirstDivergenceSignal | null = null;
    let rhs: FirstDivergenceSignal | null = null;
    let matrix: FirstDivergenceSignal | null = null;
    let state: FirstDivergenceSignal | null = null;
    let integration: FirstDivergenceSignal | null = null;
    let limiting: FirstDivergenceSignal | null = null;
    let convergence: FirstDivergenceSignal | null = null;
    let shape: FirstDivergenceSignal | null = null;

    if (ourSess && ngSess) {
      const stepCount = Math.min(ourSess.steps.length, ngSess.steps.length);
      const identityMode = this._opts.selfCompare || this._ngMatrixRowMap.size === 0;
      const allFound = (): boolean =>
        !!(voltage && rhs && matrix && state && integration && limiting && convergence && shape);

      for (let si = 0; si < stepCount; si++) {
        if (allFound()) break;
        const ourStep = ourSess.steps[si]!;
        const ngStep = ngSess.steps[si]!;

        const ourAccIdx = ourStep.acceptedAttemptIndex >= 0 ? ourStep.acceptedAttemptIndex : 0;
        const ngAccIdx = ngStep.acceptedAttemptIndex >= 0 ? ngStep.acceptedAttemptIndex : 0;
        const ourIters = ourStep.attempts[ourAccIdx]?.iterations ?? ourStep.iterations;
        const ngIters = ngStep.attempts[ngAccIdx]?.iterations ?? ngStep.iterations;
        const iterCount = Math.min(ourIters.length, ngIters.length);
        const isTran = ourStep.analysisPhase !== "dcop" && ngStep.analysisPhase !== "dcop";

        if (!shape) shape = this._fdShape(si, ourStep, ngStep, ourIters[0] ?? null, ngIters[0] ?? null);

        for (let ii = 0; ii < iterCount; ii++) {
          if (voltage && rhs && matrix && state && integration && limiting && convergence) break;
          const ourIt = ourIters[ii]!;
          const ngIt = ngIters[ii]!;
          const isFinalIter = ii === iterCount - 1;

          // Probe upstream-to-downstream so a class that short-circuits does not
          // mask the cheaper upstream checks; `earliest` re-derives causal order.
          if (!integration && isTran) integration = this._fdIntegration(si, ii, ourIt, ngIt, isFinalIter);
          if (!state) state = this._fdState(si, ii, ourIt, ngIt, isTran);
          if (!limiting) limiting = this._fdLimiting(si, ii, ourIt, ngIt);
          if (!rhs) rhs = this._fdRhs(si, ii, ourIt, ngIt);
          if (!matrix) matrix = this._fdMatrix(si, ii, ourIt, ngIt, identityMode);
          if (!voltage) voltage = this._fdVoltage(si, ii, ourIt, ngIt);
          if (!convergence) convergence = this._fdConvergence(si, ii, ourIt, ngIt);
        }
      }
    }

    const all = [voltage, rhs, matrix, state, integration, limiting, convergence, shape].filter(
      (x): x is FirstDivergenceSignal => x !== null,
    );
    const earliest = pickEarliestDivergence(all);

    return { voltage, rhs, matrix, state, integration, limiting, convergence, shape, earliest };
  }
}

// ---------------------------------------------------------------------------
// Self-compare helpers
// ---------------------------------------------------------------------------

function deepCloneSession(src: CaptureSession, newSource: "ours" | "ngspice"): CaptureSession {
  const cloned = structuredClone(src);
  cloned.source = newSource;
  return cloned;
}

function buildIdentityNodeMap(session: CaptureSession): NodeMapping[] {
  const result: NodeMapping[] = [];
  session.topology.nodeLabels.forEach((label, nodeId) => {
    result.push({
      ourIndex: nodeId,
      ngspiceIndex: nodeId,
      label,
      ngspiceName: label,
    });
  });
  return result;
}
