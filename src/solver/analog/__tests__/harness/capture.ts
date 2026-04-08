/**
 * Capture functions that read our engine's internal state into the
 * common snapshot format defined in types.ts.
 */

import type { SparseSolver } from "../../sparse-solver.js";
import type { AnalogElement } from "../../element.js";
import { isPoolBacked } from "../../element.js";
import type { StatePool } from "../../state-pool.js";
import type { ConcreteCompiledAnalogCircuit } from "../../compiled-analog-circuit.js";
import type {
  TopologySnapshot,
  IterationSnapshot,
  StepSnapshot,
  ElementStateSnapshot,
  NRAttempt,
} from "./types.js";

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
 * Build a map from element index → human-readable component label
 * using the compiled circuit's elementToCircuitElement map.
 *
 * Priority:
 *   1. User-set "label" property on the CircuitElement
 *   2. Auto-generated SPICE-style label from typeId + counter (Q1, R2, etc.)
 *   3. el.label (UUID) as last resort
 */
export function buildElementLabelMap(
  compiled: ConcreteCompiledAnalogCircuit,
): Map<number, string> {
  const map = new Map<number, string>();
  const e2ce = compiled.elementToCircuitElement;

  // First pass: collect user-set labels
  for (let i = 0; i < compiled.elements.length; i++) {
    const ce = e2ce?.get(i);
    if (ce) {
      const humanLabel = ce.getProperties().getOrDefault<string>("label", "");
      if (humanLabel) {
        map.set(i, humanLabel);
      }
    }
  }

  // Second pass: auto-generate labels for elements without user labels
  const prefixCounters = new Map<string, number>();
  for (let i = 0; i < compiled.elements.length; i++) {
    if (map.has(i)) continue; // already has user label

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
 * Called once after compile, before simulation starts.
 *
 * Node labels are built in priority order:
 *   1. `labelPinNodes` → "Q1:B", "R1:A" (rich component:pin form)
 *   2. `labelToNodeId` → bare component labels
 *   3. Element pin reverse-map → "Q1_pin0", "R1_pin1" (from elements array)
 * Multiple labels per node are joined with "/".
 *
 * @param elementLabels - Optional map from element index → human label.
 *   If not provided, falls back to el.label (which may be a UUID).
 */
export function captureTopology(
  compiled: ConcreteCompiledAnalogCircuit,
  elementLabels?: Map<number, string>,
): TopologySnapshot {
  const nodeLabels = new Map<number, string>();

  // Strategy 1: Rich labels from labelPinNodes
  if (compiled.labelPinNodes?.size) {
    const perNode = new Map<number, string[]>();
    for (const [compLabel, pins] of compiled.labelPinNodes) {
      for (const { pinLabel, nodeId } of pins) {
        if (nodeId === 0) continue;
        const tag = `${compLabel}:${pinLabel}`;
        const existing = perNode.get(nodeId);
        if (existing) existing.push(tag);
        else perNode.set(nodeId, [tag]);
      }
    }
    for (const [nodeId, tags] of perNode) {
      nodeLabels.set(nodeId, tags.join("/"));
    }
  }

  // Strategy 2: Bare component labels from labelToNodeId
  if (nodeLabels.size === 0 && compiled.labelToNodeId.size > 0) {
    for (const [label, nodeId] of compiled.labelToNodeId) {
      nodeLabels.set(nodeId, label);
    }
  }

  // Strategy 3: Reverse-map from elements array (always works)
  if (nodeLabels.size === 0) {
    const perNode = new Map<number, string[]>();
    for (const el of compiled.elements) {
      const elLabel = el.label ?? `element`;
      for (let p = 0; p < el.pinNodeIds.length; p++) {
        const nodeId = el.pinNodeIds[p];
        if (nodeId === 0) continue;
        const tag = `${elLabel}:p${p}`;
        const existing = perNode.get(nodeId);
        if (existing) {
          if (existing.length < 3) existing.push(tag); // cap to avoid huge labels
        } else {
          perNode.set(nodeId, [tag]);
        }
      }
    }
    for (const [nodeId, tags] of perNode) {
      nodeLabels.set(nodeId, tags.join("/"));
    }
  }

  return {
    matrixSize: compiled.matrixSize,
    nodeCount: compiled.nodeCount,
    branchCount: compiled.branchCount,
    elementCount: compiled.elements.length,
    elements: compiled.elements.map((el, i) => ({
      index: i,
      label: elementLabels?.get(i) ?? el.label ?? `element_${i}`,
      isNonlinear: el.isNonlinear,
      isReactive: el.isReactive,
      pinNodeIds: el.pinNodeIds,
    })),
    nodeLabels,
  };
}

// ---------------------------------------------------------------------------
// Element state capture
// ---------------------------------------------------------------------------

/**
 * Capture the current state-pool slots for all pool-backed elements.
 *
 * @param elementLabels - Optional map from element index → human label.
 */
export function captureElementStates(
  elements: readonly AnalogElement[],
  statePool: StatePool | null,
  elementLabels?: Map<number, string>,
): ElementStateSnapshot[] {
  if (!statePool) return [];
  const snapshots: ElementStateSnapshot[] = [];
  const s0 = statePool.state0;

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (!isPoolBacked(el)) continue;

    const schema = el.stateSchema;
    const base = el.stateBaseOffset;
    const slots: Record<string, number> = {};

    for (let s = 0; s < schema.slots.length; s++) {
      slots[schema.slots[s].name] = s0[base + s];
    }

    snapshots.push({
      elementIndex: i,
      label: elementLabels?.get(i) ?? el.label ?? `element_${i}`,
      slots,
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
) => void;

/**
 * Create a postIterationHook that captures every NR iteration into
 * an IterationSnapshot array. Returns the hook function and a getter
 * for the accumulated snapshots.
 *
 * @param solver    - SparseSolver instance (for matrix/RHS snapshots)
 * @param elements  - Element array (for device state capture)
 * @param statePool - State pool (for device state capture)
 * @param elementLabels - Optional map from element index → human label
 */
export function createIterationCaptureHook(
  solver: SparseSolver,
  elements: readonly AnalogElement[],
  statePool: StatePool | null,
  elementLabels?: Map<number, string>,
): { hook: PostIterationHook; getSnapshots: () => IterationSnapshot[]; clear: () => void } {
  let snapshots: IterationSnapshot[] = [];

  const hook: PostIterationHook = (
    iteration, voltages, prevVoltages, noncon, globalConverged, elemConverged,
  ) => {
    snapshots.push({
      iteration,
      voltages: voltages.slice(),
      prevVoltages: prevVoltages.slice(),
      rhs: solver.getRhsSnapshot(),
      matrix: solver.getCSCNonZeros(),
      elementStates: captureElementStates(elements, statePool, elementLabels),
      noncon,
      globalConverged,
      elemConverged,
    });
  };

  return {
    hook,
    getSnapshots: () => snapshots,
    clear: () => { snapshots = []; },
  };
}

/**
 * Create a step-level capture wrapper that uses createIterationCaptureHook
 * internally and packages iteration snapshots into StepSnapshot objects.
 *
 * Supports retry/attempt tracking: call `finalizeAttempt()` for failed NR
 * cycles (dt cut), and `finalizeStep()` for the accepted step. Failed
 * attempts are preserved in `step.attempts[]`.
 *
 * Usage:
 *   const capture = createStepCaptureHook(solver, elements, statePool);
 *   engine.postIterationHook = capture.hook;
 *   // ... run simulation steps ...
 *   // On NR failure (dt cut): capture.finalizeAttempt(dt, false);
 *   // On accepted step:       capture.finalizeStep(simTime, dt, converged);
 *   const steps = capture.getSteps();
 */
export function createStepCaptureHook(
  solver: SparseSolver,
  elements: readonly AnalogElement[],
  statePool: StatePool | null,
  elementLabels?: Map<number, string>,
): {
  hook: PostIterationHook;
  finalizeAttempt: (dt: number, converged: boolean) => void;
  finalizeStep: (simTime: number, dt: number, converged: boolean) => void;
  getSteps: () => StepSnapshot[];
  clear: () => void;
} {
  const iterCapture = createIterationCaptureHook(solver, elements, statePool, elementLabels);
  const steps: StepSnapshot[] = [];
  let pendingAttempts: NRAttempt[] = [];

  return {
    hook: iterCapture.hook,

    /**
     * Finalize a failed NR attempt (timestep will be cut and retried).
     * Preserves the iteration data in the pending attempts list.
     */
    finalizeAttempt: (dt: number, converged: boolean) => {
      const iterations = iterCapture.getSnapshots();
      if (iterations.length > 0) {
        pendingAttempts.push({
          dt,
          iterations: [...iterations],
          converged,
          iterationCount: iterations.length,
        });
      }
      iterCapture.clear();
    },

    /**
     * Finalize the accepted step. The current iteration data becomes the
     * final attempt. All prior failed attempts are attached to the step.
     */
    finalizeStep: (simTime: number, dt: number, converged: boolean) => {
      const iterations = iterCapture.getSnapshots();
      if (iterations.length > 0) {
        const acceptedAttempt: NRAttempt = {
          dt,
          iterations: [...iterations],
          converged,
          iterationCount: iterations.length,
        };

        const allAttempts = pendingAttempts.length > 0
          ? [...pendingAttempts, acceptedAttempt]
          : undefined; // omit if no retries (backward compat)

        steps.push({
          simTime,
          dt,
          iterations: acceptedAttempt.iterations,
          converged,
          iterationCount: acceptedAttempt.iterationCount,
          attempts: allAttempts,
        });
      }
      iterCapture.clear();
      pendingAttempts = [];
    },

    getSteps: () => steps,
    clear: () => {
      steps.length = 0;
      pendingAttempts = [];
      iterCapture.clear();
    },
  };
}
