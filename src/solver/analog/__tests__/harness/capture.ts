/**
 * Capture functions that read our engine's internal state into the
 * common snapshot format defined in types.ts.
 */

import type { SparseSolver } from "../../sparse-solver.js";
import type { AnalogElement } from "../../element.js";
import { isPoolBacked } from "../../element.js";
import type { StatePool } from "../../state-pool.js";
import type { ConcreteCompiledAnalogCircuit } from "../../compiled-analog-circuit.js";
import type { NRAttemptRecord } from "../../convergence-log.js";
import type { CKTCircuitContext } from "../../ckt-context.js";
import type { InitMode } from "../../load-context.js";
import type {
  TopologySnapshot,
  IterationSnapshot,
  StepSnapshot,
  ElementStateSnapshot,
  NRAttempt,
  NRPhase,
  NRAttemptOutcome,
  LimitingEvent,
  IntegrationCoefficients,
} from "./types.js";
import { normalizeDeviceType } from "./device-mappings.js";

// ---------------------------------------------------------------------------
// Topology capture (once per compile)
// ---------------------------------------------------------------------------

/** Map typeId to SPICE prefix for auto-labelling. */
const TYPE_TO_PREFIX: Record<string, string> = {
  NpnBJT: "Q", PnpBJT: "Q",
  Diode: "D", Zener: "D",
  NMOS: "M", PMOS: "M",
  NJFET: "J", PJFET: "J",
  Resistor: "R",
  Capacitor: "C",
  Inductor: "L",
  DcVoltageSource: "V", AcVoltageSource: "V",
  DcCurrentSource: "I", AcCurrentSource: "I",
  Varactor: "D",
  TunnelDiode: "D",
  SCR: "SCR", Triac: "TR",
};

/**
 * Build a map from element index → human-readable component label.
 */
export function buildElementLabelMap(
  compiled: ConcreteCompiledAnalogCircuit,
): Map<number, string> {
  const map = new Map<number, string>();
  const e2ce = compiled.elementToCircuitElement;

  for (let i = 0; i < compiled.elements.length; i++) {
    const ce = e2ce?.get(i);
    if (ce) {
      const humanLabel = ce.getProperties().getOrDefault<string>("label", "");
      if (humanLabel) {
        map.set(i, humanLabel);
      }
    }
  }

  const prefixCounters = new Map<string, number>();
  for (let i = 0; i < compiled.elements.length; i++) {
    if (map.has(i)) continue;

    const ce = e2ce?.get(i);
    const typeId = ce?.typeId ?? "";
    const prefix = TYPE_TO_PREFIX[typeId] ?? (typeId.charAt(0).toUpperCase() || "X");

    const count = (prefixCounters.get(prefix) ?? 0) + 1;
    prefixCounters.set(prefix, count);
    map.set(i, `${prefix}${count}`);
  }

  return map;
}

/**
 * Capture the circuit topology from a compiled circuit.
 */
export function captureTopology(
  compiled: ConcreteCompiledAnalogCircuit,
  elementLabels?: Map<number, string>,
): TopologySnapshot {
  const nodeLabels = new Map<number, string>();

  const perNode = new Map<number, string[]>();
  for (let i = 0; i < compiled.elements.length; i++) {
    const el = compiled.elements[i];
    const elLabel = elementLabels?.get(i) ?? `element_${i}`;
    const resolvedPins = compiled.elementResolvedPins?.get(i);
    for (let p = 0; p < el.pinNodeIds.length; p++) {
      const nodeId = el.pinNodeIds[p];
      if (nodeId === 0) continue;
      const pinLabel = resolvedPins?.[p]?.label ?? `p${p}`;
      const tag = `${elLabel}:${pinLabel}`;
      const existing = perNode.get(nodeId);
      if (existing) {
        if (existing.length < 3) existing.push(tag);
      } else {
        perNode.set(nodeId, [tag]);
      }
    }

    // Internal (prime) nodes — label from the model's getInternalNodeLabels.
    const pinCount = el.pinNodeIds.length;
    const internalLabels = el.internalNodeLabels ?? [];
    for (let p = 0; p < internalLabels.length; p++) {
      const nodeId = el.allNodeIds[pinCount + p];
      if (nodeId === 0) continue;
      const tag = `${elLabel}:${internalLabels[p]}`;
      const existing = perNode.get(nodeId);
      if (existing) {
        if (existing.length < 3) existing.push(tag);
      } else {
        perNode.set(nodeId, [tag]);
      }
    }
  }
  for (const [nodeId, tags] of perNode) {
    nodeLabels.set(nodeId, tags.join("/"));
  }

  const matrixRowLabels = new Map<number, string>();
  const matrixColLabels = new Map<number, string>();

  nodeLabels.forEach((label, nodeId) => {
    const row = nodeId - 1;
    if (row >= 0 && row < compiled.nodeCount) {
      matrixRowLabels.set(row, label);
      matrixColLabels.set(row, label);
    }
  });

  const e2ce = compiled.elementToCircuitElement;
  let branchOffset = 0;
  for (let i = 0; i < compiled.elements.length; i++) {
    const label = elementLabels?.get(i) ?? `element_${i}`;
    const typeId = e2ce?.get(i)?.typeId ?? "";
    const isBranchElement =
      typeId === "DcVoltageSource" ||
      typeId === "AcVoltageSource" ||
      typeId === "Inductor";
    if (isBranchElement) {
      const branchRow = compiled.nodeCount + branchOffset;
      matrixRowLabels.set(branchRow, `${label}:branch`);
      matrixColLabels.set(branchRow, `${label}:branch`);
      branchOffset++;
    }
  }

  return {
    matrixSize: compiled.matrixSize,
    nodeCount: compiled.nodeCount,
    branchCount: compiled.branchCount,
    elementCount: compiled.elements.length,
    elements: compiled.elements.map((el, i) => {
      const ce = compiled.elementToCircuitElement?.get(i);
      const typeId = ce?.typeId ?? "";
      return {
        index: i,
        label: elementLabels?.get(i) ?? el.label ?? `element_${i}`,
        type: normalizeDeviceType(typeId),
        isNonlinear: el.isNonlinear,
        isReactive: el.isReactive,
        pinNodeIds: el.pinNodeIds,
      };
    }),
    nodeLabels,
    matrixRowLabels,
    matrixColLabels,
  };
}

// ---------------------------------------------------------------------------
// Element state capture
// ---------------------------------------------------------------------------

export function captureElementStates(
  elements: readonly AnalogElement[],
  statePool: StatePool | null,
  elementLabels?: Map<number, string>,
): ElementStateSnapshot[] {
  if (!statePool) return [];
  const snapshots: ElementStateSnapshot[] = [];
  const s0 = statePool.state0;
  const s1 = statePool.state1;
  const s2 = statePool.state2;

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (!isPoolBacked(el)) continue;

    const schema = el.stateSchema;
    const base = el.stateBaseOffset;
    const slots: Record<string, number> = {};
    const state1Slots: Record<string, number> = {};
    const state2Slots: Record<string, number> = {};

    for (let s = 0; s < schema.slots.length; s++) {
      const name = schema.slots[s].name;
      slots[name] = s0[base + s];
      if (s1) state1Slots[name] = s1[base + s];
      if (s2) state2Slots[name] = s2[base + s];
    }

    snapshots.push({
      elementIndex: i,
      label: elementLabels?.get(i) ?? el.label ?? `element_${i}`,
      slots,
      state1Slots,
      state2Slots,
    });
  }

  return snapshots;
}

// ---------------------------------------------------------------------------
// Per-iteration capture hook factory
// ---------------------------------------------------------------------------

/**
 * Post-iteration hook signature matching NROptions.postIterationHook.
 */
export type PostIterationHook = (
  iteration: number,
  voltages: Float64Array,
  prevVoltages: Float64Array,
  noncon: number,
  globalConverged: boolean,
  elemConverged: boolean,
  limitingEvents: LimitingEvent[],
  convergenceFailedElements: string[],
  ctx: CKTCircuitContext,
) => void;

/**
 * Create a postIterationHook that captures every NR iteration into
 * an IterationSnapshot array and maintains a drainable IterationDetail buffer.
 */
export function createIterationCaptureHook(
  solver: SparseSolver,
  elements: readonly AnalogElement[],
  statePool: StatePool | null,
  elementLabels?: Map<number, string>,
): {
  hook: PostIterationHook;
  getSnapshots: () => IterationSnapshot[];
  clear: () => void;
  drainForLog: () => NRAttemptRecord["iterationDetails"];
} {
  solver.enablePreSolveRhsCapture(true);
  let snapshots: IterationSnapshot[] = [];
  let detailBuffer: NonNullable<NRAttemptRecord["iterationDetails"]> = [];

  // Build a map from raw el.label (used by newton-raphson convergenceFailedElements)
  // to the human label (used by elementStates / elementLabels). This ensures
  // convergenceFailedElements and elementStates use the same label namespace.
  const rawLabelToHumanLabel = new Map<string, string>();
  if (elementLabels) {
    for (let i = 0; i < elements.length; i++) {
      const human = elementLabels.get(i);
      if (human === undefined) continue;
      const raw = elements[i].label ?? `element_${i}`;
      if (raw !== human) rawLabelToHumanLabel.set(raw, human);
    }
  }

  const hook: PostIterationHook = (
    iteration, voltages, prevVoltages, noncon, globalConverged, elemConverged,
    limitingEvents, convergenceFailedElements, ctx,
  ) => {
    let maxDelta = 0;
    let maxDeltaNode = -1;
    for (let i = 0; i < voltages.length; i++) {
      const d = Math.abs(voltages[i] - prevVoltages[i]);
      if (d > maxDelta) { maxDelta = d; maxDeltaNode = i; }
    }

    detailBuffer.push({ iteration, maxDelta, maxDeltaNode, noncon, converged: globalConverged });

    // Remap convergenceFailedElements from raw el.label to human labels so they
    // match the labels used in elementStates (built from elementLabels).
    const remappedFailedElements = rawLabelToHumanLabel.size > 0
      ? convergenceFailedElements.map(l => rawLabelToHumanLabel.get(l) ?? l)
      : convergenceFailedElements;

    const resolvedInitMode: InitMode = ctx.initMode;

    snapshots.push({
      iteration,
      voltages: voltages.slice(),
      prevVoltages: prevVoltages.slice(),
      preSolveRhs: solver.getPreSolveRhsSnapshot().slice(),
      matrix: solver.getCSCNonZeros(),
      elementStates: captureElementStates(elements, statePool, elementLabels),
      noncon,
      diagGmin: ctx.diagonalGmin,
      srcFact: ctx.srcFact,
      initMode: resolvedInitMode,
      // ctx.ag is a live length-7 reused buffer (see CKTCircuitContext:ctx.ag
      // allocated once in constructor at ckt-context.ts:511). A fresh copy is
      // MANDATORY here — without `new Float64Array(...)` every snapshot would
      // alias the latest step's coefficients, destroying per-iteration history.
      ag: new Float64Array(ctx.ag),
      method: ctx.loadCtx.method,
      order: ctx.loadCtx.order,
      delta: 0,
      globalConverged,
      elemConverged,
      limitingEvents: [...limitingEvents],
      convergenceFailedElements: remappedFailedElements,
      ngspiceConvergenceFailedDevices: [],
    });
  };

  return {
    hook,
    getSnapshots: () => snapshots,
    clear: () => { snapshots = []; detailBuffer = []; },
    drainForLog(): NRAttemptRecord["iterationDetails"] {
      const drained = detailBuffer.slice();
      detailBuffer = [];
      return drained;
    },
  };
}

// ---------------------------------------------------------------------------
// Phase-aware step capture hook (spec §4.2)
// ---------------------------------------------------------------------------

/**
 * Create a phase-aware step capture hook.
 *
 * API:
 *   beginAttempt(phase, dt, phaseParameter?) — opens a new NRAttempt.
 *     stepStartTime is captured from simTime on the first beginAttempt call
 *     for this step (currentStep === null).
 *   endAttempt(outcome, converged) — closes the current NRAttempt.
 *   endStep({ stepEndTime, integrationCoefficients, analysisPhase, acceptedAttemptIndex })
 *     — emits the completed StepSnapshot.
 *   peekIterations() — view current iteration snapshots without consuming.
 *   getSteps() — all completed steps.
 *   clear() — reset all state.
 *
 * Usage for DCOP (called from comparison-session.ts before compile()):
 *   beginAttempt("dcopDirect", 0)
 *   ... NR iterations fire via hook ...
 *   endAttempt("dcopSubSolveConverged" | "nrFailedRetry", converged)
 *   ... more sub-solves ...
 *   endStep({ stepEndTime: 0, integrationCoefficients: zeroDcop, analysisPhase: "dcop", acceptedAttemptIndex: N })
 *
 * Usage for transient (called from comparison-session.ts per coordinator.step()):
 *   beginAttempt("tranInit" | "tranNR" | "tranNrRetry" | "tranLteRetry", dt)
 *   ... NR iterations fire via hook ...
 *   endAttempt("accepted" | "nrFailedRetry" | "lteRejectedRetry", converged)
 *   endStep({ stepEndTime: engine.simTime, ... })
 */
export function createStepCaptureHook(
  solver: SparseSolver,
  elements: readonly AnalogElement[],
  statePool: StatePool | null,
  elementLabels?: Map<number, string>,
): {
  iterationHook: PostIterationHook & { drainForLog: () => NRAttemptRecord["iterationDetails"] };
  beginAttempt(phase: NRPhase, dt: number, phaseParameter?: number): void;
  endAttempt(outcome: NRAttemptOutcome, converged: boolean): void;
  endStep(params: {
    stepEndTime: number;
    integrationCoefficients: IntegrationCoefficients;
    analysisPhase: "dcop" | "tranInit" | "tranFloat";
    acceptedAttemptIndex: number;
    /** Integration order for the step (1 = BDF-1, 2 = trap/BDF-2). Required. */
    order: number;
    /** Timestep used for the step (seconds). Required. */
    delta: number;
    /** LTE-proposed next timestep from TimestepController.computeNewDt(). */
    lteDt?: number;
  }): void;
  /** Set the stepStartTime for the currently-open step (called before endStep). */
  setStepStartTime(t: number): void;
  peekIterations: () => readonly IterationSnapshot[];
  getSteps: () => StepSnapshot[];
  clear: () => void;
} {
  const iterCapture = createIterationCaptureHook(solver, elements, statePool, elementLabels);
  const steps: StepSnapshot[] = [];

  // Current open step state
  let currentStepStartTime: number | null = null;
  let pendingAttempts: NRAttempt[] = [];
  let currentAttemptPhase: NRPhase = "tranNR";
  let currentAttemptDt: number = 0;
  let currentAttemptPhaseParameter: number | undefined = undefined;

  const iterationHook = Object.assign(iterCapture.hook, {
    drainForLog: iterCapture.drainForLog,
  });

  return {
    iterationHook,
    peekIterations: () => iterCapture.getSnapshots(),

    /**
     * Begin a new NR attempt. If no step is currently open, opens one
     * and captures dt as stepStartTime sentinel (actual stepStartTime is
     * set from the first iteration's simTime context — but since we don't
     * have engine.simTime here, callers must pass 0 for DCOP and the
     * pre-advance simTime for transient).
     *
     * For the harness, the stepStartTime is tracked externally by
     * comparison-session.ts and passed into endStep. beginAttempt only
     * needs to open the attempt bookkeeping.
     */
    beginAttempt(phase: NRPhase, dt: number, phaseParameter?: number): void {
      currentAttemptPhase = phase;
      currentAttemptDt = dt;
      currentAttemptPhaseParameter = phaseParameter;
      iterCapture.clear();
    },

    /**
     * Close the current NR attempt. Pushes it into pendingAttempts.
     */
    endAttempt(outcome: NRAttemptOutcome, converged: boolean): void {
      const iterations = iterCapture.getSnapshots();
      if (iterations.length > 0 || pendingAttempts.length === 0) {
        // Derive role from phase and position within the step
        let role: import("./types.js").AttemptRole | undefined;
        if (currentAttemptPhase === "dcopInitFloat" && pendingAttempts.length === 0) {
          role = "coldStart";
        } else if (currentAttemptPhase === "dcopDirect") {
          role = "mainSolve";
        } else if (
          (currentAttemptPhase === "tranInit" ||
           currentAttemptPhase === "tranPredictor" ||
           currentAttemptPhase === "tranNR") &&
          converged
        ) {
          role = "tranSolve";
        }
        const attempt: NRAttempt = {
          dt: currentAttemptDt,
          iterations: [...iterations],
          converged,
          iterationCount: iterations.length,
          phase: currentAttemptPhase,
          outcome,
          ...(role !== undefined ? { role } : {}),
          ...(currentAttemptPhaseParameter !== undefined
            ? { phaseParameter: currentAttemptPhaseParameter }
            : {}),
        };
        pendingAttempts.push(attempt);
      }
      iterCapture.clear();
    },

    /**
     * Close the current step and emit a StepSnapshot.
     */
    endStep(params: {
      stepEndTime: number;
      integrationCoefficients: IntegrationCoefficients;
      analysisPhase: "dcop" | "tranInit" | "tranFloat";
      acceptedAttemptIndex: number;
      /** Integration order for the step (1 = BDF-1, 2 = trap/BDF-2). */
      order: number;
      /** Timestep used for the step (seconds). */
      delta: number;
      /** LTE-proposed next timestep from TimestepController.computeNewDt(). */
      lteDt?: number;
    }): void {
      if (pendingAttempts.length === 0) {
        // Nothing to emit — no attempts were recorded
        return;
      }

      const acceptedIdx = params.acceptedAttemptIndex < 0
        ? pendingAttempts.length - 1
        : Math.min(params.acceptedAttemptIndex, pendingAttempts.length - 1);

      const acceptedAttempt = pendingAttempts[acceptedIdx]!;
      const stepStartTime = currentStepStartTime ?? 0;

      // Determine analysisPhase from accepted attempt phase if not explicitly tranFloat
      let analysisPhase = params.analysisPhase;
      if (acceptedAttempt.phase === "tranInit") {
        analysisPhase = "tranInit";
      }

      // Paint per-step `delta` onto the last iteration of the accepted
      // attempt. `order` is now set per-iteration from ctx.loadCtx.order in
      // createIterationCaptureHook — do NOT overwrite it at step-end or the
      // per-iteration history (needed to discriminate H1 vs H2 vs H3) is lost.
      if (acceptedAttempt.iterations.length > 0) {
        const lastIter = acceptedAttempt.iterations[acceptedAttempt.iterations.length - 1]!;
        lastIter.delta = params.delta;
      }

      // Populate lteDt on the last iteration of the accepted attempt so
      // assertIterationMatch can compare it bit-exact across both engines.
      if (params.lteDt !== undefined && acceptedAttempt.iterations.length > 0) {
        const lastIter = acceptedAttempt.iterations[acceptedAttempt.iterations.length - 1]!;
        lastIter.lteDt = params.lteDt;
      }

      steps.push({
        stepStartTime,
        stepEndTime: params.stepEndTime,
        attempts: [...pendingAttempts],
        acceptedAttemptIndex: acceptedIdx,
        accepted: acceptedAttempt.outcome === "accepted" || acceptedAttempt.outcome === "dcopSubSolveConverged",
        dt: acceptedAttempt.dt,
        iterations: acceptedAttempt.iterations,
        converged: acceptedAttempt.converged,
        iterationCount: acceptedAttempt.iterationCount,
        totalIterationCount: pendingAttempts.reduce((sum, a) => sum + a.iterationCount, 0),
        integrationCoefficients: params.integrationCoefficients,
        analysisPhase,
      });

      // Reset step state
      currentStepStartTime = params.stepEndTime;
      pendingAttempts = [];
      iterCapture.clear();
    },

    setStepStartTime(t: number): void {
      currentStepStartTime = t;
    },

    getSteps: () => steps,

    clear: () => {
      steps.length = 0;
      pendingAttempts = [];
      currentStepStartTime = null;
      iterCapture.clear();
    },
  };
}
