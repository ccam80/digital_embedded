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
 *     cirPath: 'e2e/spice-ref/buckbjt.cir',
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
import { captureTopology, createStepCaptureHook, buildElementLabelMap } from "./capture.js";
import { compareSnapshots, findFirstDivergence } from "./compare.js";
import { convergenceSummary } from "./query.js";
import { NgspiceBridge } from "./ngspice-bridge.js";
import { buildNodeMapping, reindexNgspiceSession } from "./node-mapping.js";
import { DEVICE_MAPPINGS } from "./device-mappings.js";
import type {
  CaptureSession,
  TopologySnapshot,
  NodeMapping,
  ComparedValue,
  StepEndReport,
  IterationReport,
  ComponentTrace,
  NodeTrace,
  SessionSummary,
  Tolerance,
  ComparisonResult,
  IntegrationCoefficients,
} from "./types.js";
import { DEFAULT_TOLERANCE } from "./types.js";

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
  /** Path to .cir SPICE netlist (ngspice format). */
  cirPath: string;
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

function stripControlBlock(cir: string): string {
  let inControl = false;
  return cir
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim().toLowerCase();
      if (trimmed.startsWith(".control")) { inControl = true; return false; }
      if (trimmed.startsWith(".endc")) { inControl = false; return false; }
      if (inControl) return false;
      if (trimmed.startsWith("meas ") || trimmed === "quit" || trimmed.startsWith("tran "))
        return false;
      return true;
    })
    .join("\n");
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
    this._ourTopology = captureTopology(compiled, this._elementLabels);

    const cirRaw = readFileSync(resolvePath(this._opts.cirPath), "utf-8");
    this._cirClean = stripControlBlock(cirRaw);
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

    const maxSteps = this._opts.maxOurSteps ?? 5000;
    for (let s = 0; s < maxSteps; s++) {
      try {
        this._coordinator.step();
        stepCapture.finalizeStep(this._engine.simTime, this._engine.lastDt, true, _zeroDcopCoefficients(), "tranFloat");
        if (this._engine.simTime >= tStop) break;
      } catch (e: any) {
        stepCapture.finalizeStep(this._engine.simTime, this._engine.lastDt, false, _zeroDcopCoefficients(), "tranFloat");
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
    const components: Record<string, Record<string, ComparedValue>> = {};

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
        const comp: Record<string, ComparedValue> = {};
        for (const [slot, value] of Object.entries(es.slots)) {
          const ngValue = ngEs?.slots[slot] ?? NaN;
          const tol = this._slotTolerance(slot);
          comp[slot] = makeComparedValue(value, ngValue, tol, this._tol.relTol);
        }
        components[es.label] = comp;
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
      });
    }

    return reports;
  }

  /**
   * Trace a single component across all steps and iterations.
   */
  traceComponent(label: string): ComponentTrace {
    this._ensureRun();
    const upperLabel = label.toUpperCase();

    // Determine device type from our topology
    const elInfo = this._ourTopology.elements.find(
      e => (e.label ?? "").toUpperCase() === upperLabel);
    const deviceType = elInfo?.type ?? "unknown";

    const steps: ComponentTrace["steps"] = [];
    const ourSteps = this._ourSession!.steps;
    const ngSteps = this._ngSessionAligned()?.steps ?? [];

    for (let si = 0; si < ourSteps.length; si++) {
      const ourStep = ourSteps[si];
      const ngStep = ngSteps[this._alignedNgIndex.get(si) ?? si];
      const iters: ComponentTrace["steps"][number]["iterations"] = [];

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

        const states: Record<string, ComparedValue> = {};
        if (ourEs) {
          for (const [slot, value] of Object.entries(ourEs.slots)) {
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

        iters.push({ iteration: ii, states, pinVoltages });
      }

      steps.push({ stepIndex: si, simTime: ourStep.simTime, iterations: iters });
    }

    return { label: upperLabel, deviceType, steps };
  }

  /**
   * Trace a single node across all steps and iterations.
   */
  traceNode(label: string): NodeTrace {
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

    const steps: NodeTrace["steps"] = [];
    const ourSteps = this._ourSession!.steps;
    const ngSteps = this._ngSessionAligned()?.steps ?? [];

    for (let si = 0; si < ourSteps.length; si++) {
      const ourStep = ourSteps[si];
      const ngStep = ngSteps[this._alignedNgIndex.get(si) ?? si];
      const iters: NodeTrace["steps"][number]["iterations"] = [];

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

        iters.push({
          iteration: ii,
          voltage: makeComparedValue(ourV, ngV, this._tol.vAbsTol, this._tol.relTol),
        });
      }

      steps.push({ stepIndex: si, simTime: ourStep.simTime, iterations: iters });
    }

    return { label: upperLabel, ourIndex, ngspiceIndex: ngIndex, steps };
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

    return {
      analysis: this._analysis ?? "dcop",
      stepCount: simpleCompared(
        this._ourSession!.steps.length,
        this._ngSessionAligned()?.steps.length ?? 0,
      ),
      convergence: { ours: ourConv, ngspice: ngConv },
      firstDivergence: firstDiv,
      totals: { compared: comparisons.length, passed, failed },
    };
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
      this._nodeMap = buildNodeMapping(this._ourTopology, ngTopo);
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
