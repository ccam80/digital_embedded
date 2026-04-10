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
  Tolerance,
  ComparisonResult,
  IntegrationCoefficients,
  NRPhase,
  NRAttemptOutcome,
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
  AttemptSummary,
  AttemptCounts,
  PhaseAwareCaptureHook,
} from "./types.js";
import { DEFAULT_TOLERANCE } from "./types.js";
import { computeIntegrationCoefficients } from "../../integration.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _zeroDcopCoefficients(): IntegrationCoefficients {
  return {
    ours: { ag0: 0, ag1: 0, method: "backwardEuler", order: 1 },
    ngspice: { ag0: 0, ag1: 0, method: "backwardEuler", order: 1 },
  };
}

function makeComparedValue(
  ours: number,
  ngspice: number,
  absTol: number,
  relTol: number,
): ComparedValue {
  // Both NaN means data is simply unavailable — treat as matching with zero delta.
  if (isNaN(ours) && isNaN(ngspice)) {
    return { ours, ngspice, delta: 0, absDelta: 0, relDelta: 0, withinTol: true };
  }
  const delta = ours - ngspice;
  const absDelta = Math.abs(delta);
  const refMag = Math.max(Math.abs(ours), Math.abs(ngspice));
  const relDelta = refMag > 0 ? absDelta / refMag : absDelta;
  const withinTol = absDelta <= absTol + relTol * refMag;
  return { ours, ngspice, delta, absDelta, relDelta, withinTol };
}

function simpleCompared(ours: number, ngspice: number): ComparedValue {
  return makeComparedValue(ours, ngspice, 0, 0);
}

function applyPagination<T>(arr: T[], opts?: PaginationOpts): T[] {
  const offset = opts?.offset ?? 0;
  const limit = opts?.limit ?? arr.length;
  return arr.slice(offset, offset + limit);
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
  /** Tolerance overrides. */
  tolerance?: Partial<Tolerance>;
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
// ComparisonSession
// ---------------------------------------------------------------------------

export class ComparisonSession {
  protected _opts: ComparisonSessionOptions;
  protected _tol: Tolerance;
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
    this._tol = { ...DEFAULT_TOLERANCE, ...opts.tolerance };
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
    tolerance?: Partial<Tolerance>;
  }): Promise<ComparisonSession> {
    const session = new ComparisonSession({
      dtsPath: opts.dtsPath ?? "<inline>",
      ...(opts.tolerance ? { tolerance: opts.tolerance } : {}),
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
        });
        this.errors.push(`Our engine failed at step ${s}: ${e.message}`);
        break;
      }

      const nowTime = this._engine.simTime ?? 0;
      if (nowTime > prevSimTime) {
        sc.endStep({
          stepEndTime: nowTime,
          integrationCoefficients: this._captureIntegCoeff(),
          analysisPhase: this._curAnalysisPhase(),
          acceptedAttemptIndex: -1,
        });
        prevSimTime = nowTime;
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
   */
  getStepEnd(stepIndex: number): StepEndReport {
    this._ensureRun();
    const ourStep = this._ourSession!.steps[stepIndex];
    if (!ourStep) {
      throw new Error(`Step out of range: ${stepIndex}`);
    }

    const ngStep = this._ngSessionAligned()?.steps[stepIndex];
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
        nodes[label] = makeComparedValue(ourV, ngV, this._tol.vAbsTol, this._tol.relTol);
      });

      for (const es of ourFinal.elementStates) {
        const ngEs = ngFinal?.elementStates.find(
          e => e.label.toUpperCase() === es.label.toUpperCase());
        const slots: Record<string, ComparedValue> = {};
        for (const [slot, value] of Object.entries(es.slots)) {
          const ngValue = ngEs?.slots[slot] ?? NaN;
          slots[slot] = makeComparedValue(value, ngValue, this._slotTol(slot), this._tol.relTol);
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
      presence,
      stepStartTime: simpleCompared(ourSST, ngSST),
      stepEndTime: simpleCompared(ourSET, ngSET),
      dt: simpleCompared(ourStep.dt, ngStep?.dt ?? NaN),
      converged: { ours: ourStep.converged, ngspice: ngStep?.converged ?? false },
      iterationCount: simpleCompared(ourStep.iterationCount, ngStep?.iterationCount ?? NaN),
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
    const ourStep = this._ourSession!.steps[stepIndex];
    if (!ourStep) return [];

    const ngStep = this._ngSessionAligned()?.steps[stepIndex];

    // Accepted attempt iterations
    const ourAccIdx = ourStep.acceptedAttemptIndex >= 0 ? ourStep.acceptedAttemptIndex : ourStep.attempts.length - 1;
    const ourIters = ourStep.attempts[ourAccIdx]?.iterations ?? ourStep.iterations;

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
          nodes[label] = makeComparedValue(ourV, ngV, this._tol.vAbsTol, this._tol.relTol);
        });

        if (ourIter.preSolveRhs.length > 0) {
          this._ourTopology.nodeLabels.forEach((label, nodeId) => {
            const ourR = nodeId > 0 && nodeId - 1 < ourIter.preSolveRhs.length
              ? ourIter.preSolveRhs[nodeId - 1] : 0;
            const ngR = ngIter?.preSolveRhs && nodeId > 0 && nodeId - 1 < ngIter.preSolveRhs.length
              ? ngIter.preSolveRhs[nodeId - 1] : NaN;
            rhs[label] = makeComparedValue(ourR, ngR, this._tol.iAbsTol, this._tol.relTol);
          });
        }

        for (const es of ourIter.elementStates) {
          const ngEs = ngIter?.elementStates.find(
            e => e.label.toUpperCase() === es.label.toUpperCase());
          const comp: Record<string, ComparedValue> = {};
          for (const [slot, value] of Object.entries(es.slots)) {
            const ngValue = ngEs?.slots[slot] ?? NaN;
            comp[slot] = makeComparedValue(value, ngValue, this._slotTol(slot), this._tol.relTol);
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
        stepStartTime: ourStep.stepStartTime,
        noncon: makeComparedValue(ourIter?.noncon ?? 0, ngIter?.noncon ?? NaN, 0, 0),
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
      if (shape.stepStartTimeDelta !== null
          && Math.abs(shape.stepStartTimeDelta) > this._tol.timeDeltaTol) {
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

    const summarize = (s: typeof ours | undefined): AttemptSummary[] | null =>
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
        value: makeComparedValue(ourVal, ngVal, this._slotTol(slotName), this._tol.relTol),
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
    if (stepIndex < 0 || stepIndex >= steps.length) {
      throw new Error(`Step out of range: ${stepIndex}`);
    }

    const upperLabel = label.toUpperCase();
    const step = steps[stepIndex];
    const accIdx = step.acceptedAttemptIndex >= 0 ? step.acceptedAttemptIndex : step.attempts.length - 1;
    const iters = step.attempts[accIdx]?.iterations ?? step.iterations;
    const lastIter = iters[iters.length - 1];
    const iterIdx = iters.length - 1;

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
        slots[k] = makeComparedValue(v, ngV, this._slotTol(k), this._tol.relTol);
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
          slots[k] = makeComparedValue(v, ngV, this._slotTol(k), this._tol.relTol);
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
            states[slot] = makeComparedValue(value, ngValue, this._slotTol(slot), this._tol.relTol);
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
            pinVoltages[pinLabel] = makeComparedValue(ourV, ngV, this._tol.vAbsTol, this._tol.relTol);
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
    for (let si = 0; si < ourSteps.length; si++) {
      const ourStep = ourSteps[si];
      const ngStep = ngSteps[si];

      const ourAccIdx = ourStep.acceptedAttemptIndex >= 0 ? ourStep.acceptedAttemptIndex : ourStep.attempts.length - 1;
      const ourIters = ourStep.attempts[ourAccIdx]?.iterations ?? ourStep.iterations;
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
        const cv = makeComparedValue(ourV, ngV, this._tol.vAbsTol, this._tol.relTol);
        if (opts?.onlyDivergences && cv.withinTol) continue;
        iters.push({ iteration: ii, voltage: cv });
      }

      steps.push({ stepIndex: si, stepStartTime: ourStep.stepStartTime, iterations: iters });
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
      stepCount: simpleCompared(
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
    if (!ourStep) throw new Error(`Step out of range: ${stepIndex}`);

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
    if (ourIter) {
      for (const e of ourIter.matrix) {
        const rowLabel = this._ourTopology.matrixRowLabels.get(e.row) ?? `row${e.row}`;
        const colLabel = this._ourTopology.matrixColLabels.get(e.col) ?? `col${e.col}`;
        const ngEntry = ngIter?.matrix.find(ne => ne.row === e.row && ne.col === e.col);
        const ngVal = ngEntry?.value ?? NaN;
        const absDelta = Math.abs(e.value - ngVal);
        const refMag = Math.max(Math.abs(e.value), Math.abs(ngVal));
        const relTol = this._tol.relTol;
        const withinTol = isNaN(ngVal) ? false : absDelta <= 1e-6 + relTol * refMag;
        entries.push({
          row: e.row, col: e.col, rowLabel, colLabel,
          ours: e.value, ngspice: ngVal, absDelta, withinTol,
        });
      }
    }

    return { stepIndex, iteration: iterationIndex, matrixSize: this._ourTopology.matrixSize, entries };
  }

  compareMatrixAt(stepIndex: number, iterationIndex: number, filter: "all" | "mismatches"): CompareMatrixResult {
    const labeled = this.getMatrixLabeled(stepIndex, iterationIndex);
    const filtered = filter === "mismatches"
      ? labeled.entries.filter(e => !e.withinTol)
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
    if (!ourStep) throw new Error(`Step out of range: ${stepIndex}`);

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
      const withinTol = isNaN(ngV) ? false : absDelta <= this._tol.iAbsTol + this._tol.relTol * Math.max(Math.abs(ourV), Math.abs(ngV));
      entries.push({ index: i, rowLabel, ours: ourV, ngspice: ngV, absDelta, withinTol });
    }

    return { stepIndex, iteration: iterationIndex, entries };
  }

  getIntegrationCoefficients(stepIndex: number): IntegrationCoefficientsReport {
    this._ensureRun();
    const step = this._ourSession!.steps[stepIndex];
    if (!step) throw new Error(`Step out of range: ${stepIndex}`);

    const ngStep = this._ngSessionAligned()?.steps[stepIndex];

    const ours = step.integrationCoefficients.ours;
    const ngspice = ngStep?.integrationCoefficients.ngspice
      ?? { ag0: 0, ag1: 0, method: "backwardEuler", order: 1 };

    return {
      stepIndex,
      ours,
      ngspice,
      methodMatch: ours.method === ngspice.method,
      ag0Compared: simpleCompared(ours.ag0, ngspice.ag0),
      ag1Compared: simpleCompared(ours.ag1, ngspice.ag1),
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
  get tolerance(): Tolerance { return this._tol; }

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
    if (ngTopo) this._nodeMap = buildDirectNodeMapping(this._ourTopology, ngTopo, this._engine.elements, this._elementLabels);
  }

  private _reindexNgSession(): void {
    if (this._ngSession && this._nodeMap.length > 0) {
      this._ngSessionReindexed = reindexNgspiceSession(
        this._ngSession, this._nodeMap, this._ourTopology.matrixSize);
    } else {
      this._ngSessionReindexed = this._ngSession;
    }
    this._backfillNgspiceIntegCoeff();
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
      this._comparisons = (this._ourSession && ng)
        ? compareSnapshots(this._ourSession, ng, this._tol)
        : [];
    }
    return this._comparisons;
  }

  private _slotTol(slotName: string): number {
    const isCharge = slotName.startsWith("Q_") || slotName.startsWith("CCAP");
    const isVoltage = slotName.startsWith("V") && !slotName.startsWith("VON");
    return isCharge ? this._tol.qAbsTol : isVoltage ? this._tol.vAbsTol : this._tol.iAbsTol;
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
    const ts = (this._engine as any)._timestep;
    if (!ts) return _zeroDcopCoefficients();
    const order: number = ts.currentOrder ?? 1;
    const rawMethod: string = ts.currentMethod ?? "bdf1";
    const method: "backwardEuler" | "trapezoidal" | "gear2" =
      rawMethod === "trapezoidal" ? "trapezoidal"
      : rawMethod === "bdf2" ? "gear2"
      : "backwardEuler";
    // After a step completes: _deltaOld[0] = dt used in this step (set by setDeltaOldCurrent),
    // _deltaOld[1] = dt of the previous step (h1), _deltaOld[2] = h_{n-2}.
    const deltaOld: number[] = (ts as any)._deltaOld ?? [];
    const dt: number = deltaOld[0] > 0 ? deltaOld[0] : (ts.currentDt ?? 0);
    const h1: number = deltaOld[1] > 0 ? deltaOld[1] : dt;
    const h2: number = deltaOld[2] > 0 ? deltaOld[2] : h1;
    const { ag0, ag1 } = computeIntegrationCoefficients(dt, h1, h2, order, rawMethod as any);
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
