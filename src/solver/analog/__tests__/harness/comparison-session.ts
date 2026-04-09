/**
 * ComparisonSession — unified ergonomic API for side-by-side
 * comparison of our engine against ngspice.
 *
 * Replaces the older compare-circuits.ts orchestration layer.
 * All query results return ours/ngspice/delta triples keyed by
 * component:pin labels.
 *
 * Usage:
 *   const session = new ComparisonSession({
 *     dtsPath: 'fixtures/buckbjt.dts',
 *   });
 *   await session.init();
 *   await session.runTransient(0, 5e-3);
 *
 *   const step0 = session.getStepEnd(0);
 *   const iters = session.getIterations(0);
 *   const q1 = session.traceComponent('Q1');
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { DefaultSimulatorFacade } from "../../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../../../components/register-all.js";
import { DefaultSimulationCoordinator } from "../../../../solver/coordinator.js";
import type { MNAEngine } from "../../analog-engine.js";
import type { ConcreteCompiledAnalogCircuit } from "../../compiled-analog-circuit.js";
import { isPoolBacked } from "../../element.js";
import { computeIntegrationCoefficients } from "../../integration.js";
import { captureTopology, createStepCaptureHook, buildElementLabelMap } from "./capture.js";
import { generateSpiceNetlist } from "./netlist-generator.js";
import { compareSnapshots, findFirstDivergence } from "./compare.js";
import { convergenceSummary } from "./query.js";
import { NgspiceBridge } from "./ngspice-bridge.js";
import { buildDirectNodeMapping, reindexNgspiceSession } from "./node-mapping.js";
import { DEVICE_MAPPINGS } from "./device-mappings.js";
import { compileSlotMatcher } from "./glob.js";
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
  SessionReport,
  Tolerance,
  ComparisonResult,
  IntegrationCoefficients,
  PaginationOpts,
  ComponentInfo,
  NodeInfo,
  ComponentSlotsResult,
  DivergenceReport,
  DivergenceEntry,
  SlotTrace,
  StateHistoryReport,
  LabeledMatrix,
  LabeledRhs,
  MatrixComparison,
  IntegrationCoefficientsReport,
  LimitingComparisonReport,
  ConvergenceDetailReport,
} from "./types.js";
import { DEFAULT_TOLERANCE } from "./types.js";
import { float64ToArray, mapToRecord } from "./format.js";

function _applyPagination<T>(items: T[], opts?: PaginationOpts): T[] {
  const offset = opts?.offset ?? 0;
  const limit = opts?.limit;
  if (limit !== undefined) {
    return items.slice(offset, offset + limit);
  }
  return offset > 0 ? items.slice(offset) : items;
}

function _zeroDcopCoefficients(): IntegrationCoefficients {
  return {
    ours: { ag0: 0, ag1: 0, method: "backwardEuler", order: 1 },
    ngspice: { ag0: 0, ag1: 0, method: "backwardEuler", order: 1 },
  };
}

// ============================================================================
// Options
// ============================================================================

export interface ComparisonSessionOptions {
  /** Path to .dts circuit file (our engine format). */
  dtsPath: string;
  /** Path to ngspice DLL. Defaults to NGSPICE_DLL_PATH env or standard build location. */
  dllPath?: string;
  /** Tolerance overrides. */
  tolerance?: Partial<Tolerance>;
  /** Max timestep attempts to capture from our engine per run. Default: 5000. */
  maxOurSteps?: number;
}

// ============================================================================
// Helpers
// ============================================================================

const ROOT = process.cwd();

function resolvePath(p: string): string {
  return resolve(ROOT, p);
}

function getDllPath(opts: ComparisonSessionOptions): string {
  return (
    opts.dllPath ??
    process.env.NGSPICE_DLL_PATH ??
    resolve(ROOT, "ref/ngspice/visualc-shared/x64/Release/bin/spice.dll")
  );
}

function makeComparedValue(
  ours: number,
  ngspice: number,
  absTol: number,
  relTol: number,
): ComparedValue {
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

// ============================================================================
// ComparisonSession
// ============================================================================

export class ComparisonSession {
  private _opts: ComparisonSessionOptions;
  private _tol: Tolerance;
  private _dllPath: string;

  // Our engine state
  private _facade!: DefaultSimulatorFacade;
  private _coordinator!: DefaultSimulationCoordinator;
  private _engine!: MNAEngine;
  private _ourTopology!: TopologySnapshot;
  private _elementLabels!: Map<number, string>;

  // ngspice bridge
  private _cirClean!: string;

  // Capture sessions
  private _ourSession: CaptureSession | null = null;
  private _ngSession: CaptureSession | null = null;
  private _ngSessionReindexed: CaptureSession | null = null;

  // Time-alignment index: maps our step index → aligned ngspice step index
  private _alignedNgIndex: Map<number, number> = new Map();

  // Node mapping
  private _nodeMap: NodeMapping[] = [];

  // Comparison results (cached)
  private _comparisons: ComparisonResult[] | null = null;

  // Analysis type
  private _analysis: "dcop" | "tran" | null = null;

  // Disposed flag
  private _disposed = false;

  // Errors
  readonly errors: string[] = [];

  constructor(opts: ComparisonSessionOptions) {
    this._opts = opts;
    this._tol = { ...DEFAULT_TOLERANCE, ...opts.tolerance };
    this._dllPath = getDllPath(opts);
  }

  /**
   * Initialize: load our circuit, compile, capture topology.
   * Must be called before runDcOp/runTransient.
   */
  async init(): Promise<void> {
    const registry = createDefaultRegistry();
    this._facade = new DefaultSimulatorFacade(registry);
    const dtsJson = readFileSync(resolvePath(this._opts.dtsPath), "utf-8");
    const circuit = this._facade.deserialize(dtsJson);
    this._coordinator = this._facade.compile(circuit) as DefaultSimulationCoordinator;
    this._engine = this._coordinator.getAnalogEngine() as MNAEngine;
    const compiled = this._engine.compiled! as ConcreteCompiledAnalogCircuit;
    this._elementLabels = buildElementLabelMap(compiled);
    // Assign labels to engine elements so NR's convergenceFailedElements
    // uses the same names as captureElementStates (which reads elementLabels)
    for (const [idx, lbl] of this._elementLabels) {
      if (idx < this._engine.elements.length) {
        (this._engine.elements[idx] as any).label = lbl;
      }
    }
    this._ourTopology = captureTopology(compiled, this._elementLabels);

    this._cirClean = generateSpiceNetlist(compiled, this._elementLabels, "Auto-generated from " + this._opts.dtsPath);
  }

  /**
   * Run DC operating point analysis on both engines.
   *
   * NOTE: DC OP runs twice on our engine:
   *   1. During compile() — this sets the operating point but has no capture hook.
   *   2. Here — the capture hook is wired before the second run, so all
   *      per-iteration data is captured from this second run.
   * The second run starts from the DC OP solution, so it typically converges
   * in 1-2 iterations. This is the intended behavior — see CLAUDE.md §DC OP.
   */
  async runDcOp(): Promise<void> {
    this._analysis = "dcop";
    this._comparisons = null;

    // --- Our engine: DC OP already ran during compile() ---
    // Wire up capture hook and re-run DC OP to get per-iteration data
    const stepCapture = createStepCaptureHook(
      this._engine.solver!,
      this._engine.elements,
      this._engine.statePool,
      this._elementLabels,
    );
    this._engine.postIterationHook = stepCapture.hook;
    this._engine.detailedConvergence = true;
    this._engine.limitingCollector = [];
    this._engine.dcOperatingPoint();
    stepCapture.finalizeStep(0, 0, true, _zeroDcopCoefficients(), "dcop");

    this._ourSession = {
      source: "ours",
      topology: this._ourTopology,
      steps: stepCapture.getSteps(),
    };

    // --- ngspice ---
    const bridge = new NgspiceBridge(this._dllPath);
    try {
      await bridge.init();
      bridge.loadNetlist(this._cirClean);
      bridge.runDcOp();
      this._ngSession = bridge.getCaptureSession();
      this._buildNodeMapping(bridge);
    } catch (e: any) {
      this.errors.push(`ngspice DC OP failed: ${e.message}`);
      this._ngSession = this._emptyNgSession();
    } finally {
      bridge.dispose();
    }

    this._reindexNgSession();
    this._buildTimeAlignment();
  }

  /**
   * Run transient analysis on both engines.
   * @param tStart - Start time in seconds (typically 0)
   * @param tStop  - Stop time in seconds
   * @param maxStep - Optional max timestep in seconds
   */
  async runTransient(tStart: number, tStop: number, maxStep?: number): Promise<void> {
    this._analysis = "tran";
    this._comparisons = null;

    const stopStr = this._formatSpiceTime(tStop);
    const stepStr = maxStep ? this._formatSpiceTime(maxStep) : this._formatSpiceTime(tStop / 100);

    // --- Our engine ---
    const stepCapture = createStepCaptureHook(
      this._engine.solver!,
      this._engine.elements,
      this._engine.statePool,
      this._elementLabels,
    );
    this._engine.postIterationHook = stepCapture.hook;
    this._engine.detailedConvergence = true;
    this._engine.limitingCollector = [];

    const maxSteps = this._opts.maxOurSteps ?? 5000;
    for (let s = 0; s < maxSteps; s++) {
      try {
        this._coordinator.step();
        const dt = this._engine.lastDt;
        const engineAny = this._engine as any;
        const deltaOld: readonly number[] = engineAny._timestep?.deltaOld ?? [dt, dt, dt, dt];
        const h1 = deltaOld[1] ?? dt;
        const h2 = deltaOld[2] ?? h1;
        const order = this._engine.integrationOrder;
        const rawMethod: string = engineAny._timestep?.currentMethod ?? "bdf1";
        const ourMethod: "backwardEuler" | "trapezoidal" | "gear2" =
          rawMethod === "trapezoidal" ? "trapezoidal"
          : rawMethod === "bdf2" ? "gear2"
          : "backwardEuler";
        const { ag0, ag1 } = computeIntegrationCoefficients(dt, h1, h2, order, rawMethod as any);
        const coefficients: IntegrationCoefficients = {
          ours: { ag0, ag1, method: ourMethod, order },
          ngspice: { ag0: 0, ag1: 0, method: "backwardEuler", order: 1 },
        };
        const phase = this._coordinator.analysisPhase;
        // Derive converged from the last captured iteration's NR flags
        // rather than hardcoding true — coordinator.step() not throwing
        // doesn't guarantee NR convergence.
        const lastSnaps = stepCapture.peekIterations();
        const lastSnap = lastSnaps.length > 0 ? lastSnaps[lastSnaps.length - 1] : null;
        const stepConverged = lastSnap ? (lastSnap.globalConverged && lastSnap.elemConverged) : true;
        stepCapture.finalizeStep(this._engine.simTime, dt, stepConverged, coefficients, phase);
        if (this._engine.simTime >= tStop) break;
      } catch (e: any) {
        const dt = this._engine.lastDt;
        const phase = this._coordinator.analysisPhase;
        stepCapture.finalizeStep(this._engine.simTime, dt, false, _zeroDcopCoefficients(), phase);
        this.errors.push(`Our engine failed at step ${s}: ${e.message}`);
        break;
      }
    }

    this._ourSession = {
      source: "ours",
      topology: this._ourTopology,
      steps: stepCapture.getSteps(),
    };

    // --- ngspice ---
    const bridge = new NgspiceBridge(this._dllPath);
    try {
      await bridge.init();
      bridge.loadNetlist(this._cirClean);
      bridge.runTran(stopStr, stepStr);
      this._ngSession = bridge.getCaptureSession();
      this._buildNodeMapping(bridge);
    } catch (e: any) {
      this.errors.push(`ngspice transient failed: ${e.message}`);
      this._ngSession = this._emptyNgSession();
    } finally {
      bridge.dispose();
    }

    this._reindexNgSession();
    this._buildTimeAlignment();
    this._mergeNgspiceCoefficients();
  }

  /**
   * After both runs complete, copy ngspice integration coefficients into
   * ourSession steps using time alignment so getIntegrationCoefficients()
   * returns both sides.
   */
  private _mergeNgspiceCoefficients(): void {
    if (!this._ourSession || !this._ngSessionReindexed) return;
    const ngSteps = this._ngSessionReindexed.steps;
    for (const [ourIdx, ngIdx] of this._alignedNgIndex) {
      const ourStep = this._ourSession.steps[ourIdx];
      const ngStep = ngSteps[ngIdx];
      if (ourStep && ngStep) {
        ourStep.integrationCoefficients.ngspice = ngStep.integrationCoefficients.ngspice;
      }
    }
  }

  // --------------------------------------------------------------------------
  // Query API
  // --------------------------------------------------------------------------

  /**
   * Get converged values at step end from both engines.
   */
  getStepEnd(stepIndex: number): StepEndReport {
    this._ensureRun();
    const ourStep = this._ourSession!.steps[stepIndex];
    const ngStep = this._ngSessionAligned()?.steps[this._alignedNgIndex.get(stepIndex) ?? stepIndex];

    const ourFinal = ourStep?.iterations[ourStep.iterations.length - 1];
    const ngFinal = ngStep?.iterations[ngStep.iterations.length - 1];

    const nodes: Record<string, ComparedValue> = {};
    const branches: Record<string, ComparedValue> = {};
    const components: Record<string, StepEndComponentEntry> = {};

    // Node voltages
    if (ourFinal) {
      this._ourTopology.nodeLabels.forEach((label, nodeId) => {
        const ourV = nodeId > 0 && nodeId - 1 < ourFinal.voltages.length
          ? ourFinal.voltages[nodeId - 1] : 0;
        const ngV = ngFinal && nodeId > 0 && nodeId - 1 < ngFinal.voltages.length
          ? ngFinal.voltages[nodeId - 1] : NaN;
        nodes[label] = makeComparedValue(ourV, ngV, this._tol.vAbsTol, this._tol.relTol);
      });
    }

    // Device states
    if (ourFinal) {
      for (const es of ourFinal.elementStates) {
        const ngEs = ngFinal?.elementStates.find(e =>
          e.label.toUpperCase() === es.label.toUpperCase());
        const slots: Record<string, ComparedValue> = {};
        for (const [slot, value] of Object.entries(es.slots)) {
          const ngValue = ngEs?.slots[slot] ?? NaN;
          const tol = this._slotTolerance(slot);
          slots[slot] = makeComparedValue(value, ngValue, tol, this._tol.relTol);
        }
        const topoEl = this._ourTopology.elements.find(
          el => el.label.toUpperCase() === es.label.toUpperCase());
        components[es.label] = { deviceType: topoEl?.type ?? "unknown", slots };
      }
    }

    return {
      stepIndex,
      simTime: simpleCompared(ourStep?.simTime ?? 0, ngStep?.simTime ?? NaN),
      dt: simpleCompared(ourStep?.dt ?? 0, ngStep?.dt ?? NaN),
      converged: { ours: ourStep?.converged ?? false, ngspice: ngStep?.converged ?? false },
      iterationCount: simpleCompared(
        ourStep?.iterationCount ?? 0, ngStep?.iterationCount ?? NaN),
      nodes,
      branches,
      components,
    };
  }

  /**
   * Get per-iteration data for a step from both engines.
   */
  getIterations(stepIndex: number): IterationReport[] {
    this._ensureRun();
    const ourStep = this._ourSession!.steps[stepIndex];
    const ngStep = this._ngSessionAligned()?.steps[this._alignedNgIndex.get(stepIndex) ?? stepIndex];
    if (!ourStep) return [];

    const reports: IterationReport[] = [];
    const iterCount = Math.max(
      ourStep.iterations.length,
      ngStep?.iterations.length ?? 0,
    );

    for (let ii = 0; ii < iterCount; ii++) {
      const ourIter = ourStep.iterations[ii];
      const ngIter = ngStep?.iterations[ii];

      const nodes: Record<string, ComparedValue> = {};
      const rhs: Record<string, ComparedValue> = {};
      const comps: Record<string, Record<string, ComparedValue>> = {};

      // Voltages
      if (ourIter) {
        this._ourTopology.nodeLabels.forEach((label, nodeId) => {
          const ourV = nodeId > 0 && nodeId - 1 < ourIter.voltages.length
            ? ourIter.voltages[nodeId - 1] : 0;
          const ngV = ngIter && nodeId > 0 && nodeId - 1 < ngIter.voltages.length
            ? ngIter.voltages[nodeId - 1] : NaN;
          nodes[label] = makeComparedValue(ourV, ngV, this._tol.vAbsTol, this._tol.relTol);
        });
      }

      // RHS
      if (ourIter && ourIter.preSolveRhs.length > 0) {
        this._ourTopology.nodeLabels.forEach((label, nodeId) => {
          const ourR = nodeId > 0 && nodeId - 1 < ourIter.preSolveRhs.length
            ? ourIter.preSolveRhs[nodeId - 1] : 0;
          const ngR = ngIter?.preSolveRhs && nodeId > 0 && nodeId - 1 < ngIter.preSolveRhs.length
            ? ngIter.preSolveRhs[nodeId - 1] : NaN;
          rhs[label] = makeComparedValue(ourR, ngR, this._tol.iAbsTol, this._tol.relTol);
        });
      }

      // Element states
      if (ourIter) {
        for (const es of ourIter.elementStates) {
          const ngEs = ngIter?.elementStates.find(e =>
            e.label.toUpperCase() === es.label.toUpperCase());
          const comp: Record<string, ComparedValue> = {};
          for (const [slot, value] of Object.entries(es.slots)) {
            const ngValue = ngEs?.slots[slot] ?? NaN;
            const tol = this._slotTolerance(slot);
            comp[slot] = makeComparedValue(value, ngValue, tol, this._tol.relTol);
          }
          comps[es.label] = comp;
        }
      }

      // Matrix diffs from compareSnapshots (remap "theirs" → "ngspice")
      const compResult = this._getComparisons().find(
        c => c.stepIndex === stepIndex && c.iterationIndex === ii);
      const matrixDiffs = (compResult?.matrixDiffs ?? []).map(d => ({
        row: d.row,
        col: d.col,
        ours: d.ours,
        ngspice: d.theirs,
        absDelta: d.absDelta,
      }));

      // Per-element convergence
      const perElementConvergence: IterationReport["perElementConvergence"] = [];
      if (ourIter) {
        for (const es of ourIter.elementStates) {
          const topoEl = this._ourTopology.elements.find(
            e => e.label.toUpperCase() === es.label.toUpperCase());
          const deviceType = topoEl?.type ?? "unknown";
          const converged = !(ourIter.convergenceFailedElements ?? []).includes(es.label);
          const ngEs = ngIter?.elementStates.find(
            e => e.label.toUpperCase() === es.label.toUpperCase());
          let worstDelta = 0;
          for (const [slot, value] of Object.entries(es.slots)) {
            const ngValue = ngEs?.slots[slot] ?? NaN;
            const tol = this._slotTolerance(slot);
            const cv = makeComparedValue(value, ngValue, tol, this._tol.relTol);
            if (cv.absDelta > worstDelta) worstDelta = cv.absDelta;
          }
          perElementConvergence.push({ label: es.label, deviceType, converged, worstDelta });
        }
      }

      reports.push({
        stepIndex,
        iteration: ii,
        simTime: ourStep.simTime,
        noncon: makeComparedValue(
          ourIter?.noncon ?? 0, ngIter?.noncon ?? NaN, 0, 0),
        nodes,
        rhs,
        matrixDiffs,
        components: comps,
        perElementConvergence,
      });
    }

    return reports;
  }

  /**
   * Trace a single component across all steps and iterations.
   */
  traceComponent(
    label: string,
    opts?: {
      slots?: string[];
      stepsRange?: { from: number; to: number };
      onlyDivergences?: boolean;
      offset?: number;
      limit?: number;
    },
  ): ComponentTrace {
    this._ensureRun();
    const upperLabel = label.toUpperCase();

    // Determine device type from our topology
    const elInfo = this._ourTopology.elements.find(
      e => (e.label ?? "").toUpperCase() === upperLabel);
    const deviceType = elInfo?.type ?? "unknown";

    const slotMatcher = opts?.slots ? compileSlotMatcher(opts.slots) : null;

    const allSteps: ComponentTrace["steps"] = [];
    const ourSteps = this._ourSession!.steps;
    const ngSteps = this._ngSessionAligned()?.steps ?? [];

    for (let si = 0; si < ourSteps.length; si++) {
      if (opts?.stepsRange && (si < opts.stepsRange.from || si > opts.stepsRange.to)) continue;

      const ourStep = ourSteps[si];
      const ngStep = ngSteps[this._alignedNgIndex.get(si) ?? si];
      let iters: ComponentTrace["steps"][number]["iterations"] = [];

      const maxIter = Math.max(
        ourStep.iterations.length,
        ngStep?.iterations.length ?? 0,
      );

      for (let ii = 0; ii < maxIter; ii++) {
        const ourIter = ourStep.iterations[ii];
        const ngIter = ngStep?.iterations[ii];

        // States
        const ourEs = ourIter?.elementStates.find(
          e => e.label.toUpperCase() === upperLabel);
        const ngEs = ngIter?.elementStates.find(
          e => e.label.toUpperCase() === upperLabel);

        let states: Record<string, ComparedValue> = {};
        if (ourEs) {
          for (const [slot, value] of Object.entries(ourEs.slots)) {
            if (slotMatcher && !slotMatcher(slot)) continue;
            const ngValue = ngEs?.slots[slot] ?? NaN;
            const tol = this._slotTolerance(slot);
            states[slot] = makeComparedValue(value, ngValue, tol, this._tol.relTol);
          }
        }

        // Pin voltages
        const pinVoltages: Record<string, ComparedValue> = {};
        if (elInfo && ourIter) {
          for (let p = 0; p < elInfo.pinNodeIds.length; p++) {
            const nodeId = elInfo.pinNodeIds[p];
            if (nodeId === 0) continue;
            const pinLabel = this._ourTopology.nodeLabels.get(nodeId) ?? `pin${p}`;
            const ourV = nodeId - 1 < ourIter.voltages.length
              ? ourIter.voltages[nodeId - 1] : 0;
            const ngV = ngIter && nodeId - 1 < ngIter.voltages.length
              ? ngIter.voltages[nodeId - 1] : NaN;
            pinVoltages[pinLabel] = makeComparedValue(
              ourV, ngV, this._tol.vAbsTol, this._tol.relTol);
          }
        }

        if (opts?.onlyDivergences && !Object.values(states).some(cv => !cv.withinTol)) continue;

        iters.push({ iteration: ii, states, pinVoltages });
      }

      allSteps.push({ stepIndex: si, simTime: ourStep.simTime, iterations: iters });
    }

    const paginatedSteps = _applyPagination(allSteps, { offset: opts?.offset, limit: opts?.limit });

    return { label: upperLabel, deviceType, steps: paginatedSteps };
  }

  /**
   * Trace a single node across all steps and iterations.
   */
  traceNode(
    label: string,
    opts?: {
      stepsRange?: { from: number; to: number };
      onlyDivergences?: boolean;
      offset?: number;
      limit?: number;
    },
  ): NodeTrace {
    this._ensureRun();
    const upperLabel = label.toUpperCase();

    // Find our node index
    let ourIndex = -1;
    this._ourTopology.nodeLabels.forEach((l, id) => {
      if (l.toUpperCase() === upperLabel || l.toUpperCase().includes(upperLabel)) {
        ourIndex = id;
      }
    });

    // Find ngspice index from node mapping
    const mapping = this._nodeMap.find(
      m => m.label.toUpperCase() === upperLabel);
    const ngIndex = mapping?.ngspiceIndex ?? -1;

    const allSteps: NodeTrace["steps"] = [];
    const ourSteps = this._ourSession!.steps;
    const ngSteps = this._ngSessionAligned()?.steps ?? [];

    for (let si = 0; si < ourSteps.length; si++) {
      if (opts?.stepsRange && (si < opts.stepsRange.from || si > opts.stepsRange.to)) continue;

      const ourStep = ourSteps[si];
      const ngStep = ngSteps[this._alignedNgIndex.get(si) ?? si];
      let iters: NodeTrace["steps"][number]["iterations"] = [];

      const maxIter = Math.max(
        ourStep.iterations.length,
        ngStep?.iterations.length ?? 0,
      );

      for (let ii = 0; ii < maxIter; ii++) {
        const ourIter = ourStep.iterations[ii];
        const ngIter = ngStep?.iterations[ii];

        const ourV = ourIter && ourIndex > 0 && ourIndex - 1 < ourIter.voltages.length
          ? ourIter.voltages[ourIndex - 1] : NaN;
        const ngV = ngIter && ourIndex > 0 && ourIndex - 1 < ngIter.voltages.length
          ? ngIter.voltages[ourIndex - 1] : NaN;

        const voltage = makeComparedValue(ourV, ngV, this._tol.vAbsTol, this._tol.relTol);

        if (opts?.onlyDivergences && voltage.withinTol) continue;

        iters.push({ iteration: ii, voltage });
      }

      allSteps.push({ stepIndex: si, simTime: ourStep.simTime, iterations: iters });
    }

    const paginatedSteps = _applyPagination(allSteps, { offset: opts?.offset, limit: opts?.limit });

    return { label: upperLabel, ourIndex, ngspiceIndex: ngIndex, steps: paginatedSteps };
  }

  /**
   * Get aggregate session summary.
   */
  getSummary(): SessionSummary {
    this._ensureRun();
    const comparisons = this._getComparisons();
    const ourConv = this._ourSession!.steps.length > 0
      ? convergenceSummary(this._ourSession!)
      : { totalSteps: 0, convergedSteps: 0, failedSteps: 0, avgIterations: 0, maxIterations: 0, worstStep: -1 };
    const ngConv = this._ngSessionAligned()?.steps.length
      ? convergenceSummary(this._ngSessionAligned()!)
      : { totalSteps: 0, convergedSteps: 0, failedSteps: 0, avgIterations: 0, maxIterations: 0, worstStep: -1 };

    const divergence = findFirstDivergence(comparisons);
    let firstDiv: SessionSummary["firstDivergence"] = null;
    if (divergence) {
      const worstV = divergence.voltageDiffs.reduce(
        (best, d) => d.absDelta > best.absDelta ? d : best,
        { label: "", absDelta: 0 } as { label: string; absDelta: number },
      );
      firstDiv = {
        stepIndex: divergence.stepIndex,
        iterationIndex: divergence.iterationIndex,
        simTime: divergence.simTime,
        worstLabel: worstV.label,
        absDelta: worstV.absDelta,
      };
    }

    const passed = comparisons.filter(c => c.allWithinTol).length;
    const failed = comparisons.length - passed;

    // perDeviceType: accumulate state divergences by device type
    const perDeviceType: Record<string, { divergenceCount: number; worstAbsDelta: number }> = {};
    for (const c of comparisons) {
      for (const sd of c.stateDiffs) {
        if (!sd.withinTol) {
          const topoEl = this._ourTopology.elements.find(
            e => e.label.toUpperCase() === sd.elementLabel.toUpperCase());
          const deviceType = topoEl?.type ?? "unknown";
          if (!perDeviceType[deviceType]) {
            perDeviceType[deviceType] = { divergenceCount: 0, worstAbsDelta: 0 };
          }
          perDeviceType[deviceType].divergenceCount++;
          if (sd.absDelta > perDeviceType[deviceType].worstAbsDelta) {
            perDeviceType[deviceType].worstAbsDelta = sd.absDelta;
          }
        }
      }
    }

    // integrationMethod: first transient step's method
    let integrationMethod: string | null = null;
    for (const step of this._ourSession!.steps) {
      const method = step.integrationCoefficients?.ours?.method;
      if (method && method !== "backwardEuler" || step.analysisPhase === "tranFloat") {
        integrationMethod = step.integrationCoefficients?.ours?.method ?? null;
        break;
      }
      if (step.analysisPhase === "tranFloat" || step.analysisPhase === "tranInit") {
        integrationMethod = step.integrationCoefficients?.ours?.method ?? null;
        break;
      }
    }

    // stateHistoryIssues: count steps where any state1/state2 slot diverges
    let state1Mismatches = 0;
    let state2Mismatches = 0;
    const ngSteps = this._ngSessionAligned()?.steps ?? [];
    for (let si = 0; si < this._ourSession!.steps.length; si++) {
      const ourStep = this._ourSession!.steps[si];
      const ngStep = ngSteps[this._alignedNgIndex.get(si) ?? si];
      if (!ourStep || !ngStep) continue;
      const ourFinal = ourStep.iterations[ourStep.iterations.length - 1];
      const ngFinal = ngStep.iterations[ngStep.iterations.length - 1];
      if (!ourFinal || !ngFinal) continue;

      let s1Mismatch = false;
      let s2Mismatch = false;
      for (const es of ourFinal.elementStates) {
        const ngEs = ngFinal.elementStates.find(
          e => e.label.toUpperCase() === es.label.toUpperCase());
        for (const [slot, value] of Object.entries(es.state1Slots ?? {})) {
          const ngValue = ngEs?.state1Slots?.[slot] ?? NaN;
          const tol = this._slotTolerance(slot);
          const cv = makeComparedValue(value, ngValue, tol, this._tol.relTol);
          if (!cv.withinTol) { s1Mismatch = true; break; }
        }
        for (const [slot, value] of Object.entries(es.state2Slots ?? {})) {
          const ngValue = ngEs?.state2Slots?.[slot] ?? NaN;
          const tol = this._slotTolerance(slot);
          const cv = makeComparedValue(value, ngValue, tol, this._tol.relTol);
          if (!cv.withinTol) { s2Mismatch = true; break; }
        }
      }
      if (s1Mismatch) state1Mismatches++;
      if (s2Mismatch) state2Mismatches++;
    }

    return {
      analysis: this._analysis ?? "dcop",
      stepCount: simpleCompared(
        this._ourSession!.steps.length,
        this._ngSessionAligned()?.steps.length ?? 0,
      ),
      convergence: { ours: ourConv, ngspice: ngConv },
      firstDivergence: firstDiv,
      totals: { compared: comparisons.length, passed, failed },
      perDeviceType,
      integrationMethod,
      stateHistoryIssues: { state1Mismatches, state2Mismatches },
    };
  }

  // --------------------------------------------------------------------------
  // Discovery methods (available after init(), no _ensureRun needed)
  // --------------------------------------------------------------------------

  /**
   * Returns one ComponentInfo per element in topology, ordered by element index.
   */
  listComponents(opts?: PaginationOpts): ComponentInfo[] {
    const results: ComponentInfo[] = [];
    for (const el of this._ourTopology.elements) {
      const engineEl = (this._engine?.elements ?? [])[el.index];
      let slotNames: string[] = [];
      if (engineEl && isPoolBacked(engineEl)) {
        slotNames = engineEl.stateSchema.slots.map((s) => s.name);
      }
      const pinLabels: string[] = [];
      for (const nodeId of el.pinNodeIds) {
        const lbl = this._ourTopology.nodeLabels.get(nodeId as number) ?? "";
        if (lbl) pinLabels.push(lbl);
      }
      results.push({
        label: el.label,
        deviceType: el.type ?? "unknown",
        slotNames,
        pinLabels,
      });
    }
    return _applyPagination(results, opts);
  }

  /**
   * Returns one NodeInfo per entry in nodeLabels, sorted by node index ascending.
   */
  listNodes(opts?: PaginationOpts): NodeInfo[] {
    const results: NodeInfo[] = [];
    this._ourTopology.nodeLabels.forEach((label, nodeId) => {
      const mapping = this._nodeMap.find((m) => m.ourIndex === nodeId);
      const ngspiceIndex = mapping?.ngspiceIndex ?? -1;
      const connectedComponents: string[] = [];
      for (const el of this._ourTopology.elements) {
        if ((el.pinNodeIds as readonly number[]).includes(nodeId)) {
          connectedComponents.push(el.label);
        }
      }
      results.push({ label, ourIndex: nodeId, ngspiceIndex, connectedComponents });
    });
    results.sort((a, b) => a.ourIndex - b.ourIndex);
    return _applyPagination(results, opts);
  }

  /**
   * Returns component labels whose deviceType matches type (case-insensitive).
   */
  getComponentsByType(type: string): string[] {
    const lower = type.toLowerCase();
    return this._ourTopology.elements
      .filter((el) => (el.type ?? "").toLowerCase() === lower)
      .map((el) => el.label);
  }

  // --------------------------------------------------------------------------
  // Slot query methods
  // --------------------------------------------------------------------------

  /**
   * Returns state slot values for one component, filtered by glob patterns.
   * Snapshot mode when opts.step is provided; trace mode otherwise.
   */
  getComponentSlots(
    label: string,
    patterns: string[],
    opts?: { step?: number } & PaginationOpts,
  ): ComponentSlotsResult {
    this._ensureRun();
    const upperLabel = label.toUpperCase();
    const el = this._ourTopology.elements.find(
      (e) => e.label.toUpperCase() === upperLabel,
    );
    if (!el) throw new Error(`Component not found: ${label}`);

    const matches = compileSlotMatcher(patterns);

    if (opts?.step !== undefined) {
      const stepIdx = opts.step;
      const ourStep = this._ourSession!.steps[stepIdx];
      if (!ourStep) throw new Error(`Step out of range: ${stepIdx}`);

      const ngStep = this._ngSessionAligned()?.steps[
        this._alignedNgIndex.get(stepIdx) ?? stepIdx
      ];

      const ourFinal = ourStep.iterations[ourStep.iterations.length - 1];
      const ngFinal = ngStep?.iterations[ngStep.iterations.length - 1];

      const ourEs = ourFinal?.elementStates.find(
        (e) => e.label.toUpperCase() === upperLabel,
      );
      const ngEs = ngFinal?.elementStates.find(
        (e) => e.label.toUpperCase() === upperLabel,
      );

      const allSlotNames = Object.keys(ourEs?.slots ?? {});
      const matchedSlots = allSlotNames.filter(matches);

      const slotsObj: Record<string, ComparedValue> = {};
      const paginatedSlots = _applyPagination(matchedSlots, opts);
      for (const slot of paginatedSlots) {
        const ourV = ourEs?.slots[slot] ?? NaN;
        const ngV = ngEs?.slots[slot] ?? NaN;
        slotsObj[slot] = makeComparedValue(
          ourV, ngV, this._slotTolerance(slot), this._tol.relTol,
        );
      }

      return {
        mode: "snapshot",
        label: upperLabel,
        stepIndex: stepIdx,
        simTime: ourStep.simTime,
        slots: slotsObj,
        matchedSlots: paginatedSlots,
        totalSlots: allSlotNames.length,
      };
    }

    // Trace mode
    const allSteps = this._ourSession!.steps;
    const traceSteps: Array<{
      stepIndex: number;
      simTime: number;
      slots: Record<string, ComparedValue>;
    }> = [];

    let matchedSlots: string[] | null = null;

    for (let si = 0; si < allSteps.length; si++) {
      const ourStep = allSteps[si];
      const ngStep = this._ngSessionAligned()?.steps[
        this._alignedNgIndex.get(si) ?? si
      ];

      const ourFinal = ourStep.iterations[ourStep.iterations.length - 1];
      const ngFinal = ngStep?.iterations[ngStep.iterations.length - 1];

      const ourEs = ourFinal?.elementStates.find(
        (e) => e.label.toUpperCase() === upperLabel,
      );
      const ngEs = ngFinal?.elementStates.find(
        (e) => e.label.toUpperCase() === upperLabel,
      );

      const allSlotNames = Object.keys(ourEs?.slots ?? {});
      if (!matchedSlots) {
        matchedSlots = allSlotNames.filter(matches);
      }

      const slotsObj: Record<string, ComparedValue> = {};
      for (const slot of matchedSlots) {
        const ourV = ourEs?.slots[slot] ?? NaN;
        const ngV = ngEs?.slots[slot] ?? NaN;
        slotsObj[slot] = makeComparedValue(
          ourV, ngV, this._slotTolerance(slot), this._tol.relTol,
        );
      }

      traceSteps.push({ stepIndex: si, simTime: ourStep.simTime, slots: slotsObj });
    }

    const totalSteps = traceSteps.length;
    const paginatedSteps = _applyPagination(traceSteps, opts);

    return {
      mode: "trace",
      label: upperLabel,
      totalSteps,
      matchedSlots: matchedSlots ?? [],
      steps: paginatedSteps,
    };
  }

  // --------------------------------------------------------------------------
  // Divergence methods
  // --------------------------------------------------------------------------

  /**
   * Returns out-of-tolerance entries from all comparisons, sorted by absDelta desc.
   */
  getDivergences(
    opts?: { step?: number; component?: string; threshold?: number } & PaginationOpts,
  ): DivergenceReport {
    this._ensureRun();
    const comparisons = this._getComparisons();

    const allEntries: DivergenceEntry[] = [];

    for (const c of comparisons) {
      if (opts?.step !== undefined && c.stepIndex !== opts.step) continue;

      // Voltage divergences
      for (const vd of c.voltageDiffs) {
        if (!vd.withinTol) {
          allEntries.push({
            stepIndex: c.stepIndex,
            iteration: c.iterationIndex,
            simTime: c.simTime,
            category: "voltage",
            label: vd.label,
            ours: vd.ours,
            ngspice: vd.theirs,
            absDelta: vd.absDelta,
            relDelta: vd.relDelta,
            withinTol: false,
            componentLabel: null,
            slotName: null,
          });
        }
      }

      // RHS divergences
      for (const rd of c.rhsDiffs) {
        if (!rd.withinTol) {
          const label = (() => {
            const lbl = this._ourTopology.matrixRowLabels.get(rd.index);
            return lbl ?? String(rd.index);
          })();
          allEntries.push({
            stepIndex: c.stepIndex,
            iteration: c.iterationIndex,
            simTime: c.simTime,
            category: "rhs",
            label,
            ours: rd.ours,
            ngspice: rd.theirs,
            absDelta: rd.absDelta,
            relDelta: 0,
            withinTol: false,
            componentLabel: null,
            slotName: null,
          });
        }
      }

      // Matrix divergences (all matrixDiffs are already out-of-tol)
      for (const md of c.matrixDiffs) {
        allEntries.push({
          stepIndex: c.stepIndex,
          iteration: c.iterationIndex,
          simTime: c.simTime,
          category: "matrix",
          label: `${md.row},${md.col}`,
          ours: md.ours,
          ngspice: md.theirs,
          absDelta: md.absDelta,
          relDelta: 0,
          withinTol: false,
          componentLabel: null,
          slotName: null,
        });
      }

      // State divergences
      for (const sd of c.stateDiffs) {
        if (!sd.withinTol) {
          if (opts?.component && sd.elementLabel.toUpperCase() !== opts.component.toUpperCase()) {
            continue;
          }
          allEntries.push({
            stepIndex: c.stepIndex,
            iteration: c.iterationIndex,
            simTime: c.simTime,
            category: "state",
            label: `${sd.elementLabel}:${sd.slotName}`,
            ours: sd.ours,
            ngspice: sd.theirs,
            absDelta: sd.absDelta,
            relDelta: 0,
            withinTol: false,
            componentLabel: sd.elementLabel,
            slotName: sd.slotName,
          });
        }
      }
    }

    // Apply threshold filter and discard non-finite deltas (NaN/Infinity from
    // missing ngspice data on one side of the comparison)
    const filtered = allEntries.filter((e) =>
      Number.isFinite(e.absDelta) &&
      (opts?.threshold === undefined || e.absDelta > opts.threshold!));

    // Sort by absDelta descending
    filtered.sort((a, b) => b.absDelta - a.absDelta);

    // Build worstByCategory
    const categories: Array<DivergenceEntry["category"]> = ["voltage", "state", "rhs", "matrix"];
    const worstByCategory: DivergenceReport["worstByCategory"] = {
      voltage: null,
      state: null,
      rhs: null,
      matrix: null,
    };
    for (const cat of categories) {
      const catEntries = filtered.filter((e) => e.category === cat);
      if (catEntries.length > 0) {
        worstByCategory[cat] = catEntries.reduce(
          (best, e) => e.absDelta > best.absDelta ? e : best,
        );
      }
    }

    const limit = opts?.limit ?? 100;
    const offset = opts?.offset ?? 0;
    const entries = filtered.slice(offset, offset + limit);

    return {
      totalCount: filtered.length,
      worstByCategory,
      entries,
    };
  }

  // --------------------------------------------------------------------------
  // Batch and range methods
  // --------------------------------------------------------------------------

  /**
   * Batch version of getStepEnd over inclusive range [fromStep, toStep].
   */
  getStepEndRange(fromStep: number, toStep: number): StepEndReport[] {
    this._ensureRun();
    const maxIdx = this._ourSession!.steps.length - 1;
    const lo = Math.max(0, fromStep);
    const hi = Math.min(maxIdx, toStep);
    const results: StepEndReport[] = [];
    for (let i = lo; i <= hi; i++) {
      results.push(this.getStepEnd(i));
    }
    return results;
  }

  // --------------------------------------------------------------------------
  // Slot trace
  // --------------------------------------------------------------------------

  /**
   * Single slot timeseries across all steps (converged values only).
   */
  traceComponentSlot(label: string, slotName: string, opts?: PaginationOpts): SlotTrace {
    this._ensureRun();
    const upperLabel = label.toUpperCase();
    const el = this._ourTopology.elements.find(
      (e) => e.label.toUpperCase() === upperLabel,
    );
    if (!el) throw new Error(`Component not found: ${label}`);

    const allSteps = this._ourSession!.steps;
    const traceSteps: SlotTrace["steps"] = [];

    for (let si = 0; si < allSteps.length; si++) {
      const ourStep = allSteps[si];
      const ngStep = this._ngSessionAligned()?.steps[
        this._alignedNgIndex.get(si) ?? si
      ];

      const ourFinal = ourStep.iterations[ourStep.iterations.length - 1];
      const ngFinal = ngStep?.iterations[ngStep.iterations.length - 1];

      const ourEs = ourFinal?.elementStates.find(
        (e) => e.label.toUpperCase() === upperLabel,
      );
      const ngEs = ngFinal?.elementStates.find(
        (e) => e.label.toUpperCase() === upperLabel,
      );

      if (ourEs && slotName in ourEs.slots) {
        const ourV = ourEs.slots[slotName];
        const ngV = ngEs?.slots[slotName] ?? NaN;
        traceSteps.push({
          stepIndex: si,
          simTime: ourStep.simTime,
          value: makeComparedValue(ourV, ngV, this._slotTolerance(slotName), this._tol.relTol),
        });
      }
    }

    const totalSteps = traceSteps.length;
    const paginatedSteps = _applyPagination(traceSteps, opts);

    return {
      label: upperLabel,
      slotName,
      totalSteps,
      steps: paginatedSteps,
    };
  }

  // --------------------------------------------------------------------------
  // State history
  // --------------------------------------------------------------------------

  /**
   * Returns state0, state1, state2 for a component at a given step/iteration.
   */
  getStateHistory(label: string, step: number, iteration?: number): StateHistoryReport {
    this._ensureRun();
    const upperLabel = label.toUpperCase();

    const ourStep = this._ourSession!.steps[step];
    if (!ourStep) throw new Error(`Step out of range: ${step}`);

    const iterIdx = iteration !== undefined
      ? iteration
      : ourStep.iterations.length - 1;

    const ourIter = ourStep.iterations[iterIdx];
    if (!ourIter) throw new Error("Iteration out of range");

    const ngStep = this._ngSessionAligned()?.steps[
      this._alignedNgIndex.get(step) ?? step
    ];
    const ngIter = ngStep?.iterations[iterIdx];

    const findEs = (iters: typeof ourIter | undefined, lbl: string) =>
      iters?.elementStates.find((e) => e.label.toUpperCase() === lbl);

    const ourEs = findEs(ourIter, upperLabel);
    const ngEs = findEs(ngIter, upperLabel);

    return {
      label: upperLabel,
      stepIndex: step,
      iteration: iterIdx,
      state0: { ...(ourEs?.slots ?? {}) },
      state1: { ...(ourEs?.state1Slots ?? {}) },
      state2: { ...(ourEs?.state2Slots ?? {}) },
      ngspiceState0: { ...(ngEs?.slots ?? {}) },
      ngspiceState1: { ...(ngEs?.state1Slots ?? {}) },
      ngspiceState2: { ...(ngEs?.state2Slots ?? {}) },
    };
  }

  // --------------------------------------------------------------------------
  // Methods 9-17
  // --------------------------------------------------------------------------

  /**
   * Matrix entries with row/col labels from topology.
   */
  getMatrixLabeled(step: number, iteration: number): LabeledMatrix {
    this._ensureRun();
    const ourStep = this._ourSession!.steps[step];
    if (!ourStep) throw new Error(`Step out of range: ${step}`);
    const ourIter = ourStep.iterations[iteration];
    if (!ourIter) throw new Error(`Iteration out of range: ${iteration}`);
    const ngStep = this._ngSessionAligned()?.steps[this._alignedNgIndex.get(step) ?? step];
    const ngIter = ngStep?.iterations[iteration];

    // Build union of (row, col) keys
    const keySet = new Map<string, { row: number; col: number }>();
    for (const e of ourIter.matrix) {
      keySet.set(`${e.row},${e.col}`, { row: e.row, col: e.col });
    }
    if (ngIter) {
      for (const e of ngIter.matrix) {
        keySet.set(`${e.row},${e.col}`, { row: e.row, col: e.col });
      }
    }

    const entries = Array.from(keySet.values()).map(({ row, col }) => {
      const rowLabel = this._ourTopology.matrixRowLabels.get(row) ?? String(row);
      const colLabel = this._ourTopology.matrixColLabels.get(col) ?? String(col);
      const ourVal = ourIter.matrix.find(e => e.row === row && e.col === col)?.value ?? 0;
      const ngVal = ngIter?.matrix.find(e => e.row === row && e.col === col)?.value ?? 0;
      const absDelta = Math.abs(ourVal - ngVal);
      const refMag = Math.max(Math.abs(ourVal), Math.abs(ngVal));
      const withinTol = absDelta <= this._tol.iAbsTol + this._tol.relTol * refMag;
      return { row, col, rowLabel, colLabel, ours: ourVal, ngspice: ngVal, absDelta, withinTol };
    });

    entries.sort((a, b) => a.row !== b.row ? a.row - b.row : a.col - b.col);

    return { stepIndex: step, iteration, matrixSize: this._ourTopology.matrixSize, entries };
  }

  /**
   * RHS vector entries with node labels (uses preSolveRhs).
   */
  getRhsLabeled(step: number, iteration: number): LabeledRhs {
    this._ensureRun();
    const ourStep = this._ourSession!.steps[step];
    if (!ourStep) throw new Error(`Step out of range: ${step}`);
    const ourIter = ourStep.iterations[iteration];
    if (!ourIter) throw new Error(`Iteration out of range: ${iteration}`);
    const ngStep = this._ngSessionAligned()?.steps[this._alignedNgIndex.get(step) ?? step];
    const ngIter = ngStep?.iterations[iteration];

    const size = this._ourTopology.matrixSize;
    const entries = [];
    for (let i = 0; i < size; i++) {
      const lbl = this._ourTopology.matrixRowLabels.get(i) ?? String(i);
      const ourVal = i < ourIter.preSolveRhs.length ? ourIter.preSolveRhs[i] : 0;
      const ngVal = ngIter?.preSolveRhs && i < ngIter.preSolveRhs.length
        ? ngIter.preSolveRhs[i] : NaN;
      const absDelta = isNaN(ngVal) ? NaN : Math.abs(ourVal - ngVal);
      const refMag = Math.max(Math.abs(ourVal), Math.abs(ngVal));
      const withinTol = isNaN(absDelta) ? false
        : absDelta <= this._tol.iAbsTol + this._tol.relTol * refMag;
      entries.push({ index: i, label: lbl, ours: ourVal, ngspice: ngVal, absDelta, withinTol });
    }

    return { stepIndex: step, iteration, entries };
  }

  /**
   * Side-by-side matrix comparison with summary stats.
   */
  compareMatrixAt(
    step: number,
    iteration: number,
    filter: "all" | "mismatches" = "mismatches",
  ): MatrixComparison {
    const labeled = this.getMatrixLabeled(step, iteration);
    const mismatchCount = labeled.entries.filter(e => !e.withinTol).length;
    const maxAbsDelta = labeled.entries.reduce((m, e) => Math.max(m, e.absDelta), 0);

    const filteredEntries = filter === "mismatches"
      ? labeled.entries.filter(e => !e.withinTol)
      : labeled.entries;

    const entries = filteredEntries.map(e => ({
      row: e.row,
      col: e.col,
      rowLabel: e.rowLabel,
      colLabel: e.colLabel,
      ours: e.ours,
      ngspice: e.ngspice,
      delta: e.ours - e.ngspice,
      absDelta: e.absDelta,
      withinTol: e.withinTol,
    }));

    return {
      stepIndex: step,
      iteration,
      filter,
      totalEntries: labeled.entries.length,
      mismatchCount,
      maxAbsDelta,
      entries,
    };
  }

  /**
   * Integration coefficients from both engines at a step.
   */
  getIntegrationCoefficients(step: number): IntegrationCoefficientsReport {
    this._ensureRun();
    const ourStep = this._ourSession!.steps[step];
    if (!ourStep) throw new Error(`Step out of range: ${step}`);
    const coeffs = ourStep.integrationCoefficients;
    const ag0Compared = simpleCompared(coeffs.ours.ag0, coeffs.ngspice.ag0);
    const ag1Compared = simpleCompared(coeffs.ours.ag1, coeffs.ngspice.ag1);
    const methodMatch = coeffs.ours.method === coeffs.ngspice.method
      && coeffs.ours.order === coeffs.ngspice.order;
    return {
      stepIndex: step,
      ours: { ...coeffs.ours },
      ngspice: { ...coeffs.ngspice },
      methodMatch,
      ag0Compared,
      ag1Compared,
    };
  }

  /**
   * Pre/post limit junction voltages from both engines.
   */
  getLimitingComparison(label: string, step: number, iteration: number): LimitingComparisonReport {
    this._ensureRun();
    const ourStep = this._ourSession!.steps[step];
    if (!ourStep) throw new Error(`Step out of range: ${step}`);
    const ourIter = ourStep.iterations[iteration];
    if (!ourIter) throw new Error(`Iteration out of range: ${iteration}`);
    const ngStep = this._ngSessionAligned()?.steps[this._alignedNgIndex.get(step) ?? step];
    const ngIter = ngStep?.iterations[iteration];

    const upperLabel = label.toUpperCase();
    const ourEvents = (ourIter.limitingEvents ?? []).filter(
      e => e.label.toUpperCase() === upperLabel);
    const ngEvents = (ngIter?.limitingEvents ?? []).filter(
      e => e.label.toUpperCase() === upperLabel);

    // Build union of junction names
    const junctionSet = new Set<string>();
    for (const e of ourEvents) junctionSet.add(e.junction);
    for (const e of ngEvents) junctionSet.add(e.junction);

    const junctions = Array.from(junctionSet).map(junction => {
      const ourEv = ourEvents.find(e => e.junction === junction);
      const ngEv = ngEvents.find(e => e.junction === junction);
      const ourPreLimit = ourEv?.vBefore ?? NaN;
      const ourPostLimit = ourEv?.vAfter ?? NaN;
      const ourDelta = ourPostLimit - ourPreLimit;
      const ngspicePreLimit = ngEv?.vBefore ?? NaN;
      const ngspicePostLimit = ngEv?.vAfter ?? NaN;
      const ngspiceDelta = ngspicePostLimit - ngspicePreLimit;
      const limitingDiff = ourDelta - ngspiceDelta;
      return {
        junction,
        ourPreLimit,
        ourPostLimit,
        ourDelta,
        ngspicePreLimit,
        ngspicePostLimit,
        ngspiceDelta,
        limitingDiff,
      };
    });

    return {
      label: upperLabel,
      stepIndex: step,
      iteration,
      junctions,
      noEvents: junctions.length === 0,
    };
  }

  /**
   * Per-element convergence pass/fail from both engines.
   */
  getConvergenceDetail(step: number, iteration: number): ConvergenceDetailReport {
    this._ensureRun();
    const ourStep = this._ourSession!.steps[step];
    if (!ourStep) throw new Error(`Step out of range: ${step}`);
    const ourIter = ourStep.iterations[iteration];
    if (!ourIter) throw new Error(`Iteration out of range: ${iteration}`);
    const ngStep = this._ngSessionAligned()?.steps[this._alignedNgIndex.get(step) ?? step];
    const ngIter = ngStep?.iterations[iteration];

    const comparisons = this._getComparisons();
    const compResult = comparisons.find(
      c => c.stepIndex === step && c.iterationIndex === iteration);

    const elements = ourIter.elementStates.map(es => {
      const topoEl = this._ourTopology.elements.find(
        e => e.label.toUpperCase() === es.label.toUpperCase());
      const deviceType = topoEl?.type ?? "unknown";
      const ourConverged = !(ourIter.convergenceFailedElements ?? []).includes(es.label);
      const ngspiceDevices = ngIter?.ngspiceConvergenceFailedDevices ?? [];
      const ngspiceConverged = !ngspiceDevices.includes(es.label.toLowerCase());
      const stateDiffsForEl = (compResult?.stateDiffs ?? []).filter(
        d => d.elementLabel.toUpperCase() === es.label.toUpperCase());
      const worstDelta = stateDiffsForEl.reduce((m, d) => Math.max(m, d.absDelta), 0);
      const agree = ourConverged === ngspiceConverged;
      return { label: es.label, deviceType, ourConverged, ngspiceConverged, worstDelta, agree };
    });

    const disagreementCount = elements.filter(e => !e.agree).length;
    const ourNoncon = ourIter.convergenceFailedElements?.length ?? 0;
    const ngspiceNoncon = ngIter?.ngspiceConvergenceFailedDevices?.length ?? 0;
    const ourGlobalConverged = ourIter.globalConverged;
    const ngspiceGlobalConverged = ngIter?.globalConverged ?? true;

    return {
      stepIndex: step,
      iteration,
      ourNoncon,
      ngspiceNoncon,
      ourGlobalConverged,
      ngspiceGlobalConverged,
      elements,
      disagreementCount,
    };
  }

  /**
   * Serialize session to JSON. All non-JSON-safe values converted.
   */
  toJSON(opts?: { includeAllSteps?: boolean; onlyDivergences?: boolean }): SessionReport {
    this._ensureRun();
    const summary = this.getSummary();
    const comparisons = this._getComparisons();

    const includeAllSteps = opts?.includeAllSteps === true;
    const onlyDivergences = opts?.onlyDivergences === true;

    const shouldIncludeStep = (stepIndex: number): boolean => {
      if (includeAllSteps && !onlyDivergences) return true;
      return comparisons.some(c => c.stepIndex === stepIndex && !c.allWithinTol);
    };

    const safeNum = (v: number): number | null => isFinite(v) ? v : null;

    const steps: SessionReport["steps"] = [];
    const ourSteps = this._ourSession!.steps;
    for (let si = 0; si < ourSteps.length; si++) {
      if (!shouldIncludeStep(si)) continue;
      const stepEnd = this.getStepEnd(si);
      const ourStep = ourSteps[si];
      const ngStep = this._ngSessionAligned()?.steps[this._alignedNgIndex.get(si) ?? si];

      const nodes: SessionReport["steps"][number]["nodes"] = {};
      for (const [lbl, cv] of Object.entries(stepEnd.nodes)) {
        nodes[lbl] = {
          ours: safeNum(cv.ours),
          ngspice: safeNum(cv.ngspice),
          absDelta: safeNum(cv.absDelta),
          withinTol: cv.withinTol,
        };
      }

      const components: SessionReport["steps"][number]["components"] = {};
      for (const [lbl, entry] of Object.entries(stepEnd.components)) {
        const slots: Record<string, { ours: number | null; ngspice: number | null; absDelta: number | null; withinTol: boolean }> = {};
        for (const [slot, cv] of Object.entries(entry.slots)) {
          slots[slot] = {
            ours: safeNum(cv.ours),
            ngspice: safeNum(cv.ngspice),
            absDelta: safeNum(cv.absDelta),
            withinTol: cv.withinTol,
          };
        }
        components[lbl] = { deviceType: entry.deviceType, slots };
      }

      steps.push({
        stepIndex: si,
        simTime: ourStep.simTime,
        dt: ourStep.dt,
        converged: { ours: ourStep.converged, ngspice: ngStep?.converged ?? false },
        iterationCount: { ours: ourStep.iterationCount, ngspice: ngStep?.iterationCount ?? 0 },
        nodes,
        components,
      });
    }

    return {
      analysis: (this._analysis ?? "dcop") as "dcop" | "tran",
      stepCount: {
        ours: ourSteps.length,
        ngspice: this._ngSessionAligned()?.steps.length ?? 0,
      },
      nodeCount: this._ourTopology.nodeCount,
      elementCount: this._ourTopology.elementCount,
      summary: {
        totalCompared: summary.totals.compared,
        passed: summary.totals.passed,
        failed: summary.totals.failed,
        firstDivergence: summary.firstDivergence,
        perDeviceType: summary.perDeviceType,
        integrationMethod: summary.integrationMethod,
        stateHistoryIssues: summary.stateHistoryIssues,
      },
      steps,
    };
  }

  /**
   * Factory replacing the two-step new + init pattern.
   */
  static async create(opts: ComparisonSessionOptions): Promise<ComparisonSession> {
    const session = new ComparisonSession(opts);
    await session.init();
    return session;
  }

  /**
   * Clean up all held resources.
   */
  dispose(): void {
    this._ourSession = null;
    this._ngSession = null;
    this._ngSessionReindexed = null;
    this._comparisons = null;
    this._nodeMap = [];
    if (this._facade && typeof (this._facade as any).dispose === "function") {
      (this._facade as any).dispose();
    }
    if (this._coordinator && typeof (this._coordinator as any).dispose === "function") {
      (this._coordinator as any).dispose();
    }
    this._disposed = true;
  }

  // --------------------------------------------------------------------------
  // Raw access
  // --------------------------------------------------------------------------

  get ourSession(): CaptureSession | null { return this._ourSession; }
  get ngspiceSession(): CaptureSession | null { return this._ngSession; }
  get ngspiceSessionAligned(): CaptureSession | null { return this._ngSessionReindexed; }
  get nodeMap(): NodeMapping[] { return this._nodeMap; }
  get tolerance(): Tolerance { return this._tol; }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  private _ensureRun(): void {
    if (this._disposed) {
      throw new Error("ComparisonSession: session has been disposed");
    }
    if (!this._ourSession) {
      throw new Error("ComparisonSession: call runDcOp() or runTransient() first");
    }
  }

  private _emptyNgSession(): CaptureSession {
    return {
      source: "ngspice",
      topology: { matrixSize: 0, nodeCount: 0, branchCount: 0, elementCount: 0, elements: [], nodeLabels: new Map(), matrixRowLabels: new Map(), matrixColLabels: new Map() },
      steps: [],
    };
  }

  private _buildNodeMapping(bridge: NgspiceBridge): void {
    const ngTopo = bridge.getTopology();
    if (ngTopo) {
      this._nodeMap = buildDirectNodeMapping(
        this._ourTopology, ngTopo, this._engine.elements, this._elementLabels);
    }
  }

  private _reindexNgSession(): void {
    if (this._ngSession && this._nodeMap.length > 0) {
      this._ngSessionReindexed = reindexNgspiceSession(
        this._ngSession, this._nodeMap, this._ourTopology.matrixSize);
    } else {
      this._ngSessionReindexed = this._ngSession;
    }
  }

  private _buildTimeAlignment(): void {
    this._alignedNgIndex.clear();
    const ngSteps = this._ngSessionAligned()?.steps ?? [];
    if (ngSteps.length === 0) return;

    const ourSteps = this._ourSession?.steps ?? [];
    for (let i = 0; i < ourSteps.length; i++) {
      const tOurs = ourSteps[i].simTime;
      const dtOurs = ourSteps[i].dt;

      // Binary search ngspice steps by simTime for nearest match
      let lo = 0;
      let hi = ngSteps.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (ngSteps[mid].simTime < tOurs) lo = mid + 1;
        else hi = mid;
      }

      // Check lo and lo-1 for the nearest
      const candidates = [lo - 1, lo, lo + 1].filter(j => j >= 0 && j < ngSteps.length);
      let bestJ = candidates[0];
      let bestDelta = Infinity;
      for (const j of candidates) {
        const delta = Math.abs(ngSteps[j].simTime - tOurs);
        if (delta < bestDelta) { bestDelta = delta; bestJ = j; }
      }

      // Accept match only within tolerance: |t_ours - t_ng| < 0.5 * min(dt_ours, dt_ng)
      const dtNg = ngSteps[bestJ].dt;
      const halfMinDt = 0.5 * Math.min(dtOurs > 0 ? dtOurs : Infinity, dtNg > 0 ? dtNg : Infinity);
      if (bestDelta <= halfMinDt || halfMinDt <= 0) {
        this._alignedNgIndex.set(i, bestJ);
      }
    }
  }

  private _ngSessionAligned(): CaptureSession | null {
    return this._ngSessionReindexed ?? this._ngSession;
  }

  private _getComparisons(): ComparisonResult[] {
    if (!this._comparisons) {
      const ng = this._ngSessionAligned();
      if (this._ourSession && ng) {
        this._comparisons = compareSnapshots(this._ourSession, ng, this._tol, this._alignedNgIndex);
      } else {
        this._comparisons = [];
      }
    }
    return this._comparisons;
  }

  private _slotTolerance(slotName: string): number {
    const isCharge = slotName.startsWith("Q_") || slotName.startsWith("CCAP");
    const isVoltage = slotName.startsWith("V") && !slotName.startsWith("VON");
    return isCharge ? this._tol.qAbsTol
      : isVoltage ? this._tol.vAbsTol
      : this._tol.iAbsTol;
  }

  private _formatSpiceTime(seconds: number): string {
    if (seconds >= 1) return `${seconds}`;
    if (seconds >= 1e-3) return `${seconds * 1e3}m`;
    if (seconds >= 1e-6) return `${seconds * 1e6}u`;
    if (seconds >= 1e-9) return `${seconds * 1e9}n`;
    return `${seconds * 1e12}p`;
  }
}
