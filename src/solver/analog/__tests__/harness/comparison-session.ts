/**
 * ComparisonSession — pairs an "our engine" CaptureSession against an
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
import { DefaultSimulatorFacade } from "../../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../../../components/register-all.js";
import { ComponentRegistry } from "../../../../core/registry.js";
import { DefaultSimulationCoordinator } from "../../../../solver/coordinator.js";
import type { Circuit } from "../../../../core/circuit.js";
import type { MNAEngine } from "../../analog-engine.js";
import type { ConcreteCompiledAnalogCircuit } from "../../compiled-analog-circuit.js";
import {
  captureTopology,
  createStepCaptureHook,
  buildElementLabelMap,
} from "./capture.js";
import { compareSnapshots, findFirstDivergence } from "./compare.js";
import { convergenceSummary } from "./query.js";
import { NgspiceBridge } from "./ngspice-bridge.js";
import { buildDirectNodeMapping, reindexNgspiceSession } from "./node-mapping.js";
import { generateSpiceNetlist } from "./netlist-generator.js";
import { matchSlotPattern } from "./glob.js";
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
} from "./types.js";
import { computeNIcomCof } from "../../integration.js";
import type { IntegrationMethod } from "../../../../core/analog-types.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _zeroDcopCoefficients(): IntegrationCoefficients {
  return {
    ours: { ag0: 0, ag1: 0, method: "backwardEuler", order: 1 },
    ngspice: { ag0: 0, ag1: 0, method: "backwardEuler", order: 1 },
  };
}

// ---------------------------------------------------------------------------
// Matrix/residual helpers
// ---------------------------------------------------------------------------

/**
 * Compute rhs, residual, residualInfinityNorm, and the full dense matrix
 * from an IterationSnapshot's sparse matrix entries, input voltages, and preSolveRhs.
 *
 * The input voltages are `iter.prevVoltages` — the iterate fed INTO this NR iteration
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
  const n = matrixSize;
  const rhs = Array.from(iter.preSolveRhs.subarray(0, n));

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
  return (
    opts.dllPath ??
    process.env.NGSPICE_DLL_PATH ??
    resolve(ROOT, "ref/ngspice/visualc-shared/x64/Release/bin/spice.dll")
  );
}

function emptyTopology(): TopologySnapshot {
  return {
    matrixSize: 0, nodeCount: 0, branchCount: 0, elementCount: 0,
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
// L2 norm helpers (file-scoped)
// ---------------------------------------------------------------------------

/** L2 norm of (a[start..end) - b[start..end)). NaN if either undefined. */
function _l2Norm(a: Float64Array | undefined, b: Float64Array | undefined, start: number, end: number): number {
  if (!a || !b) return NaN;
  const n = Math.min(a.length, b.length, end);
  if (n <= start) return NaN;
  let s = 0;
  for (let i = start; i < n; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
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

  // ngspice bridge artifacts
  protected _cirClean: string = "";

  // Capture sessions
  protected _ourSession: CaptureSession | null = null;
  protected _ngSession: CaptureSession | null = null;
  protected _ngSessionReindexed: CaptureSession | null = null;

  // Node mapping
  protected _nodeMap: NodeMapping[] = [];
  protected _ngTopology: import("./types.js").NgspiceTopology | null = null;

  // Matrix row/col mapping (for semantic joins of BJT internal nodes)
  protected _ngMatrixRowMap: Map<number, number> = new Map();
  protected _ngMatrixColMap: Map<number, number> = new Map();
  protected _ngspiceOnlyRows: number[] = [];
  protected _ngspiceOnlyRowLabels: Map<number, string> = new Map();

  // Comparison results (lazily cached)
  protected _comparisons: ComparisonResult[] | null = null;

  // Analysis type
  protected _analysis: "dcop" | "tran" | null = null;

  // Whether init() has completed
  protected _inited: boolean = false;

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
    analysis: "dcop" | "tran";
    tStop?: number;
    maxStep?: number;
  }): Promise<ComparisonSession> {
    const session = new ComparisonSession({
      dtsPath: opts.dtsPath ?? "<inline>",
      selfCompare: true,
    });
    await session.initSelfCompare(opts.buildCircuit);

    if (opts.analysis === "dcop") {
      await session.runDcOp();
    } else {
      if (opts.tStop === undefined) {
        throw new Error("createSelfCompare: tStop required for transient analysis");
      }
      await session.runTransient(0, opts.tStop, opts.maxStep);
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
    const registry = createDefaultRegistry();
    this._facade = new DefaultSimulatorFacade(registry);

    const dtsJson = readFileSync(resolvePath(this._opts.dtsPath!), "utf-8");
    const circuit = this._facade.deserialize(dtsJson);

    await this._initWithCircuit(circuit);
  }

  private async initSelfCompare(buildCircuit?: (registry: ComponentRegistry) => Circuit): Promise<void> {
    const registry = createDefaultRegistry();
    this._facade = new DefaultSimulatorFacade(registry);

    const circuit = buildCircuit
      ? buildCircuit(registry)
      : this._facade.deserialize(readFileSync(resolvePath(this._opts.dtsPath!), "utf-8"));

    await this._initWithCircuit(circuit);
  }

  private async _initWithCircuit(circuit: Circuit): Promise<void> {
    this._coordinator = this._facade.compile(
      circuit, { deferInitialize: true }
    ) as DefaultSimulationCoordinator;
    this._engine = this._coordinator.getAnalogEngine() as MNAEngine;

    if (!this._engine) {
      this._elementLabels = new Map();
      this._ourTopology = emptyTopology();
      this._inited = true;
      return;
    }

    const compiled = this._engine.compiled! as ConcreteCompiledAnalogCircuit;
    this._elementLabels = buildElementLabelMap(compiled);
    this._ourTopology = captureTopology(compiled, this._elementLabels);

    this._stepCapture = createStepCaptureHook(
      this._engine.solver!,
      this._engine.elements,
      this._engine.statePool,
      this._elementLabels,
    );

    const sc = this._stepCapture;
    const bundle: PhaseAwareCaptureHook = {
      iterationHook: sc.iterationHook,
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
    this._coordinator.initialize();
    // NOTE: do NOT call endStep() here. DCOP attempts must remain pending so
    // runTransient() can merge them with the first tranInit attempt into a
    // single boot step (stepStartTime=0). Standalone DCOP users go through
    // runDcOp(), which flushes the pending attempts itself.

    if (this._opts.cirPath) {
      const cirRaw = readFileSync(resolvePath(this._opts.cirPath), "utf-8");
      this._cirClean = stripControlBlock(cirRaw);
    } else if (!this._opts.selfCompare) {
      this._cirClean = generateSpiceNetlist(compiled, this._elementLabels);
    }

    this._inited = true;
  }

  // ---------------------------------------------------------------------------
  // Run methods
  // ---------------------------------------------------------------------------

  /**
   * Run DC operating point comparison.
   *
   * The boot step was already built into _stepCapture during init(). This method
   * snapshots it as _ourSession, then runs the ngspice side (or deep-clones for
   * self-compare mode).
   */
  async runDcOp(): Promise<void> {
    this._ensureInited();
    if (this._hasRun) return;

    this._analysis = "dcop";
    this._comparisons = null;

    // Flush the pending DCOP attempts captured during init() into step 0.
    // _initWithCircuit() deliberately leaves them in the buffer so that
    // runTransient() can merge them with the first tranInit attempt; for
    // standalone DCOP runs we close the step ourselves here.
    if (this._stepCapture) {
      this._stepCapture.endStep({
        stepEndTime: 0,
        integrationCoefficients: _zeroDcopCoefficients(),
        analysisPhase: "dcop",
        acceptedAttemptIndex: -1,
        order: this._engine.integrationOrder,
        delta: this._engine.currentDt,
      });
    }

    this._ourSession = {
      source: "ours",
      topology: this._ourTopology,
      steps: this._stepCapture.getSteps(),
    };

    if (!this._opts.selfCompare && this._cirClean) {
      const bridge = new NgspiceBridge(this._dllPath);
      try {
        await bridge.init();
        bridge.loadNetlist(this._cirClean);
        bridge.runDcOp();
        this._ngSession = bridge.getCaptureSession();
        this._buildNodeMapping(bridge);
      } catch (e: any) {
        this.errors.push(`ngspice DC OP failed: ${e.message}`);
        this._ngSession = { source: "ngspice", topology: emptyTopology(), steps: [] };
      } finally {
        bridge.dispose();
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
  }

  /**
   * Run transient analysis on both engines.
   *
   * The boot step (stepStartTime=0) is already in _stepCapture from init().
   * The master-switch hook bundle was installed in init(), so the per-step loop
   * needs no hook rewiring. At the end, the master switch is released.
   */
  async runTransient(_tStart: number, tStop: number, maxStep?: number): Promise<void> {
    this._ensureInited();
    if (this._hasRun) return;

    this._analysis = "tran";
    this._comparisons = null;

    // Derive ngspice-matching transient parameters for harness comparison.
    // CKTstep = tstep sent to ngspice .tran command.
    const tstep = tStop / 100;
    const tStart = _tStart;

    // traninit.c:27-31: auto-compute maxStep when user omits it.
    const resolvedMaxStep = maxStep != null
      ? maxStep
      : Math.min(tstep, (tStop - tStart) / 50);

    // traninit.c:34: CKTdelmin = 1e-11 * CKTmaxStep
    const resolvedMinStep = 1e-11 * resolvedMaxStep;

    // dctran.c:118: delta = MIN(CKTfinalTime/100, CKTstep) / 10
    const resolvedFirstStep = Math.min(tStop / 100, tstep) / 10;

    this._engine.configure({
      tStop,
      maxTimeStep: resolvedMaxStep,
      minTimeStep: resolvedMinStep,
      firstStep: resolvedFirstStep,
    });

    const stopStr = this._formatSpiceTime(tStop);
    const stepStr = maxStep
      ? this._formatSpiceTime(maxStep)
      : this._formatSpiceTime(tStop / 100);

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
          delta: this._engine.currentDt,
        });
        this.errors.push(`Our engine failed at step ${s}: ${e.message}`);
        break;
      }

      // Derive post-step time from the engine's accepted dt rather than
      // snapshotting simTime directly. `_engine.lastDt` is the dt that was
      // actually accepted by this step() call (see MNAEngine.step() — set
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
          delta: this._engine.currentDt,
          ...(hasLte ? { lteDt: lteDtValue } : {}),
        });
        prevSimTime = nowTime;
      } else {
        // Engine did not advance (ERROR state or stalled). Avoid spinning
        // forever in the outer for-loop.
        this.errors.push(
          `Our engine did not advance at step ${s} (simTime=${this._engine.simTime ?? "?"}, lastDt=${acceptedDt}).`,
        );
        break;
      }

      if (nowTime >= tStop) break;
    }

    this._ourSession = {
      source: "ours",
      topology: this._ourTopology,
      steps: sc.getSteps(),
    };

    if (!this._opts.selfCompare && this._cirClean) {
      const bridge = new NgspiceBridge(this._dllPath);
      try {
        await bridge.init();
        bridge.loadNetlist(this._cirClean);
        bridge.runTran(stopStr, stepStr);
        this._ngSession = bridge.getCaptureSession();
        this._buildNodeMapping(bridge);
      } catch (e: any) {
        this.errors.push(`ngspice transient failed: ${e.message}`);
        this._ngSession = { source: "ngspice", topology: emptyTopology(), steps: [] };
      } finally {
        bridge.dispose();
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
          const ngV = nodeId > 0 && nodeId - 1 < ngFinal.voltages.length
            ? ngFinal.voltages[nodeId - 1] : NaN;
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

    // Accepted attempt final iteration (spec §9.3)
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
          ? ourFinal.voltages[nodeId - 1] : 0;
        const ngV = ngFinal && nodeId > 0 && nodeId - 1 < ngFinal.voltages.length
          ? ngFinal.voltages[nodeId - 1] : NaN;
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
        const topoEl = this._ourTopology.elements.find(
          el => el.label.toUpperCase() === es.label.toUpperCase());
        components[es.label] = { deviceType: topoEl?.type ?? "unknown", slots };
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
   * Per-iteration data for a step — uses accepted attempt iterations (spec §9.2).
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
          const ourV = nodeId > 0 && nodeId - 1 < ourIter.voltages.length
            ? ourIter.voltages[nodeId - 1] : 0;
          const ngV = ngIter && nodeId > 0 && nodeId - 1 < ngIter.voltages.length
            ? ngIter.voltages[nodeId - 1] : NaN;
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
            const ourR = nodeId > 0 && nodeId - 1 < ourIter.preSolveRhs.length
              ? ourIter.preSolveRhs[nodeId - 1] : 0;
            const ngR = ngIter?.preSolveRhs && nodeId > 0 && nodeId - 1 < ngIter.preSolveRhs.length
              ? ngIter.preSolveRhs[nodeId - 1] : NaN;
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
      analysis: this._analysis ?? "dcop",
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
        ngspice: ng?.integrationCoefficients.ngspice.method ?? null,
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
      analysis: this._analysis ?? "dcop",
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

      const ourLinSys = ourIter ? _computeLinearSystemData(ourIter, matrixSize) : null;
      const ourData: IterationSideData | null = ourIter ? {
        rawIteration: ourIter.iteration,
        globalConverged: ourIter.globalConverged,
        noncon: ourIter.noncon,
        nodeVoltages: this._buildNodeVoltages(ourIter.voltages),
        nodeVoltagesBefore: this._buildNodeVoltages(ourIter.prevVoltages),
        branchValues: this._buildBranchValues(ourIter.voltages, nodeCount),
        elementStates: Object.fromEntries(
          ourIter.elementStates.map(es => [es.label, es.slots]),
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
      } : null;

      const ngLinSys = ngIter ? _computeLinearSystemData(ngIter, matrixSize) : null;
      const ngData: IterationSideData | null = ngIter ? {
        rawIteration: ngIter.iteration,
        globalConverged: ngIter.globalConverged,
        noncon: ngIter.noncon,
        nodeVoltages: this._buildNodeVoltages(ngIter.voltages),
        nodeVoltagesBefore: this._buildNodeVoltages(ngIter.prevVoltages),
        branchValues: this._buildBranchValues(ngIter.voltages, nodeCount),
        elementStates: Object.fromEntries(
          ngIter.elementStates.map(es => [es.label, es.slots]),
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
      } : null;

      const divergenceNorm = _l2Norm(
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

  private _buildNodeVoltages(voltages: Float64Array): Record<string, number> {
    const result: Record<string, number> = {};
    this._ourTopology.nodeLabels.forEach((label, nodeId) => {
      if (nodeId > 0 && nodeId - 1 < voltages.length) {
        result[label] = voltages[nodeId - 1];
      }
    });
    return result;
  }

  private _buildBranchValues(voltages: Float64Array, nodeCount: number): Record<string, number> {
    const result: Record<string, number> = {};
    this._ourTopology.matrixRowLabels.forEach((label, row) => {
      if (row >= nodeCount && row < voltages.length) {
        result[label] = voltages[row];
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
    // Use role as the sole pairing key when present — this allows cross-phase pairing
    // (e.g. our tranInit::tranSolve matches ngspice's tranNR::tranSolve). Fall back to
    // phase-only for untagged attempts to preserve existing DC OP pairing behaviour.
    const makeKey = (a: NRAttempt): string =>
      a.role !== undefined
        ? `role::${a.role}`
        : `phase::${a.phase}`;

    const ourEntries: Entry[] = ourAtts.map((a, i) => ({ a, i, key: makeKey(a) }));
    const ngEntries:  Entry[] = ngAtts.map((a, i)  => ({ a, i, key: makeKey(a) }));

    // Build a map from key → list of ngspice entries (in order) for O(1) lookup
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
          // absolute index is less than the match — preserves chronological order.
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
          const divergenceNorm = _l2Norm(ourLast?.voltages, ngLast?.voltages, 0, nodeCount);
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
          // absolute index is less than the match — preserves chronological order.
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
          const divergenceNorm = _l2Norm(ourLast?.voltages, ngLast?.voltages, 0, nodeCount);
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
            const ourV = nodeId - 1 < ourIter.voltages.length ? ourIter.voltages[nodeId - 1] : 0;
            const ngV = ngIter && nodeId - 1 < ngIter.voltages.length
              ? ngIter.voltages[nodeId - 1] : NaN;
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
          ? ourIter.voltages[ourIndex - 1] : NaN;
        const ngV = ngIter && ourIndex > 0 && ourIndex - 1 < ngIter.voltages.length
          ? ngIter.voltages[ourIndex - 1] : NaN;
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
    const integrationMethod = methods.size === 1
      ? [...methods][0]
      : (methods.size > 1 ? [...methods].join(",") : null);

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
      analysis: this._analysis ?? "dcop",
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
      const rowLabel = this._ourTopology.matrixRowLabels.get(i) ?? `row${i}`;
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
      ?? { ag0: 0, ag1: 0, method: "backwardEuler" as const, order: 1 };
    const ngspice = ngStep?.integrationCoefficients.ngspice
      ?? { ag0: 0, ag1: 0, method: "backwardEuler", order: 1 };

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
      analysis: this._analysis ?? "dcop",
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
    this._comparisons = null;
    this._nodeMap = [];
  }

  // ---------------------------------------------------------------------------
  // Raw access
  // ---------------------------------------------------------------------------

  get ourSession(): CaptureSession | null { return this._ourSession; }
  get ngspiceSession(): CaptureSession | null { return this._ngSession; }
  get ngspiceSessionAligned(): CaptureSession | null { return this._ngSessionReindexed; }
  get nodeMap(): NodeMapping[] { return this._nodeMap; }

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

  private _buildNodeMapping(bridge: NgspiceBridge): void {
    const ngTopo = bridge.getTopology();
    if (ngTopo) {
      this._ngTopology = ngTopo;
      this._nodeMap = buildDirectNodeMapping(this._ourTopology, ngTopo, this._engine.elements, this._elementLabels);
    }
  }

  private _reindexNgSession(): void {
    if (this._ngSession && this._nodeMap.length > 0) {
      this._ngSessionReindexed = reindexNgspiceSession(
        this._ngSession, this._nodeMap, this._ourTopology.matrixSize);
    } else {
      this._ngSessionReindexed = this._ngSession;
    }
    this._buildMatrixMaps();
    this._backfillNgspiceIntegCoeff();
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
    if (seconds >= 1) return `${seconds}`;
    if (seconds >= 1e-3) return `${seconds * 1e3}m`;
    if (seconds >= 1e-6) return `${seconds * 1e6}u`;
    if (seconds >= 1e-9) return `${seconds * 1e9}n`;
    return `${seconds * 1e12}p`;
  }

  private _captureIntegCoeff(): IntegrationCoefficients {
    if (!this._engine) return _zeroDcopCoefficients();
    const order = this._engine.integrationOrder;
    const rawMethod: IntegrationMethod = this._engine.integrationMethod;
    const method: "backwardEuler" | "trapezoidal" | "gear2" =
      rawMethod === "trapezoidal" ? "trapezoidal"
      : rawMethod === "bdf2" ? "gear2"
      : "backwardEuler";
    // After a step completes: deltaOld[0] = dt used in this step (set by setDeltaOldCurrent),
    // deltaOld[1] = dt of the previous step (h1), deltaOld[2] = h_{n-2}.
    const deltaOld = this._engine.timestepDeltaOld;
    const dt = deltaOld[0] > 0 ? deltaOld[0] : this._engine.currentDt;
    const agBuf = new Float64Array(7);
    const scratchBuf = new Float64Array(49);
    computeNIcomCof(dt, deltaOld as number[], order, rawMethod, agBuf, scratchBuf);
    const ag0 = agBuf[0];
    const ag1 = agBuf[1];
    return {
      ours: { ag0, ag1, method, order },
      ngspice: { ag0: 0, ag1: 0, method: "backwardEuler", order: 1 },
    };
  }

  private _curAnalysisPhase(): "dcop" | "tranInit" | "tranFloat" {
    const phase = (this._coordinator as any)?._analysisPhase;
    if (phase === "tranInit") return "tranInit";
    if (phase === "tranFloat") return "tranFloat";
    return "dcop";
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
