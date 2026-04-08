/**
 * Query API over a CaptureSession.
 *
 * Provides filtering, projection, and aggregation over captured
 * iteration snapshots for interactive debugging.
 */

import type {
  CaptureSession,
  StepSnapshot,
  IterationSnapshot,
  SnapshotQuery,
} from "./types.js";

/**
 * Filter steps from a capture session matching the query predicates.
 */
export function querySteps(
  session: CaptureSession,
  query: SnapshotQuery,
): StepSnapshot[] {
  let steps = session.steps;

  if (query.stepRange) {
    const { from, to } = query.stepRange;
    steps = steps.filter((_, i) => i >= from && i <= to);
  }

  if (query.timeRange) {
    const { from, to } = query.timeRange;
    steps = steps.filter(s => s.simTime >= from && s.simTime <= to);
  }

  if (query.converged !== undefined) {
    steps = steps.filter(s => s.converged === query.converged);
  }

  if (query.minIterations !== undefined) {
    steps = steps.filter(s => s.iterationCount >= query.minIterations!);
  }

  return steps;
}

/**
 * Extract the voltage trajectory for a specific node across all
 * captured iterations. Returns an array of {simTime, iteration, voltage}.
 */
export function nodeVoltageTrajectory(
  session: CaptureSession,
  nodeIndex: number,
): Array<{ simTime: number; iteration: number; voltage: number }> {
  const result: Array<{ simTime: number; iteration: number; voltage: number }> = [];
  for (const step of session.steps) {
    for (const iter of step.iterations) {
      if (nodeIndex < iter.voltages.length) {
        result.push({
          simTime: step.simTime,
          iteration: iter.iteration,
          voltage: iter.voltages[nodeIndex],
        });
      }
    }
  }
  return result;
}

/**
 * Extract a specific element's state slot values across all iterations.
 * Returns an array of {simTime, iteration, value}.
 */
export function elementStateTrajectory(
  session: CaptureSession,
  elementLabel: string,
  slotName: string,
): Array<{ simTime: number; iteration: number; value: number }> {
  const result: Array<{ simTime: number; iteration: number; value: number }> = [];
  for (const step of session.steps) {
    for (const iter of step.iterations) {
      const es = iter.elementStates.find(e => e.label === elementLabel);
      if (es && slotName in es.slots) {
        result.push({
          simTime: step.simTime,
          iteration: iter.iteration,
          value: es.slots[slotName],
        });
      }
    }
  }
  return result;
}

/**
 * Summarize convergence behavior: total steps, NR failure count,
 * average iterations, worst-case iteration count.
 */
export function convergenceSummary(session: CaptureSession): {
  totalSteps: number;
  convergedSteps: number;
  failedSteps: number;
  avgIterations: number;
  maxIterations: number;
  worstStep: number;
} {
  let converged = 0, failed = 0, totalIter = 0, maxIter = 0, worstStep = -1;
  for (let i = 0; i < session.steps.length; i++) {
    const s = session.steps[i];
    if (s.converged) converged++; else failed++;
    totalIter += s.iterationCount;
    if (s.iterationCount > maxIter) {
      maxIter = s.iterationCount;
      worstStep = i;
    }
  }
  return {
    totalSteps: session.steps.length,
    convergedSteps: converged,
    failedSteps: failed,
    avgIterations: session.steps.length > 0 ? totalIter / session.steps.length : 0,
    maxIterations: maxIter,
    worstStep,
  };
}

/**
 * Find the iteration with the largest voltage delta for a given node.
 * Useful for identifying where convergence is struggling.
 */
export function findLargestDelta(
  session: CaptureSession,
  nodeIndex: number,
): { stepIndex: number; iterationIndex: number; delta: number } | null {
  let best: { stepIndex: number; iterationIndex: number; delta: number } | null = null;
  for (let si = 0; si < session.steps.length; si++) {
    const step = session.steps[si];
    for (let ii = 0; ii < step.iterations.length; ii++) {
      const iter = step.iterations[ii];
      if (nodeIndex < iter.voltages.length && nodeIndex < iter.prevVoltages.length) {
        const delta = Math.abs(iter.voltages[nodeIndex] - iter.prevVoltages[nodeIndex]);
        if (!best || delta > best.delta) {
          best = { stepIndex: si, iterationIndex: ii, delta };
        }
      }
    }
  }
  return best;
}
