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
} from "./types.js";

// ---------------------------------------------------------------------------
// Topology capture (once per compile)
// ---------------------------------------------------------------------------

/**
 * Capture the circuit topology from a compiled circuit.
 * Called once after compile, before simulation starts.
 */
export function captureTopology(
  compiled: ConcreteCompiledAnalogCircuit,
): TopologySnapshot {
  const nodeLabels = new Map<number, string>();
  for (const [label, nodeId] of compiled.labelToNodeId) {
    nodeLabels.set(nodeId, label);
  }

  return {
    matrixSize: compiled.matrixSize,
    nodeCount: compiled.nodeCount,
    branchCount: compiled.branchCount,
    elementCount: compiled.elements.length,
    elements: compiled.elements.map((el, i) => ({
      index: i,
      label: el.label ?? `element_${i}`,
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
 */
export function captureElementStates(
  elements: readonly AnalogElement[],
  statePool: StatePool | null,
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
      label: el.label ?? `element_${i}`,
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
 */
export function createIterationCaptureHook(
  solver: SparseSolver,
  elements: readonly AnalogElement[],
  statePool: StatePool | null,
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
      elementStates: captureElementStates(elements, statePool),
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
 * Usage:
 *   const capture = createStepCaptureHook(solver, elements, statePool);
 *   engine.postIterationHook = capture.hook;
 *   // ... run simulation steps ...
 *   capture.finalizeStep(simTime, dt, converged);
 *   const steps = capture.getSteps();
 */
export function createStepCaptureHook(
  solver: SparseSolver,
  elements: readonly AnalogElement[],
  statePool: StatePool | null,
): {
  hook: PostIterationHook;
  finalizeStep: (simTime: number, dt: number, converged: boolean) => void;
  getSteps: () => StepSnapshot[];
  clear: () => void;
} {
  const iterCapture = createIterationCaptureHook(solver, elements, statePool);
  const steps: StepSnapshot[] = [];

  return {
    hook: iterCapture.hook,
    finalizeStep: (simTime: number, dt: number, converged: boolean) => {
      const iterations = iterCapture.getSnapshots();
      if (iterations.length > 0) {
        steps.push({
          simTime,
          dt,
          iterations: [...iterations],
          converged,
          iterationCount: iterations.length,
        });
      }
      iterCapture.clear();
    },
    getSteps: () => steps,
    clear: () => {
      steps.length = 0;
      iterCapture.clear();
    },
  };
}
