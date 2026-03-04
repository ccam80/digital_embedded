/**
 * Signal trace capture — sample named signals over multiple simulation steps.
 *
 * captureTrace runs N steps on an engine via the runner, reading the value
 * of each named signal after each step. The result is a Map from label string
 * to an array of BitVector values, one entry per step.
 *
 * Useful for verifying sequential circuit behaviour (e.g. a counter advancing
 * over 8 clock cycles, or a pipeline producing outputs in order).
 */

import { BitVector } from "@/core/signal";
import type { SimulationEngine } from "@/core/engine-interface";
import type { SimulationRunner } from "./runner.js";

// ---------------------------------------------------------------------------
// captureTrace
// ---------------------------------------------------------------------------

/**
 * Run N simulation steps, sampling named signals after each step.
 *
 * @param runner  SimulationRunner used to call step() and readOutput().
 * @param engine  The compiled SimulationEngine to advance.
 * @param labels  Signal labels to sample after each step.
 * @param steps   Number of steps to execute.
 * @returns       Map from label → array of BitVector, one entry per step.
 */
export function captureTrace(
  runner: SimulationRunner,
  engine: SimulationEngine,
  labels: string[],
  steps: number,
): Map<string, BitVector[]> {
  const result = new Map<string, BitVector[]>();

  for (const label of labels) {
    result.set(label, []);
  }

  for (let step = 0; step < steps; step++) {
    runner.step(engine);

    for (const label of labels) {
      const raw = runner.readOutput(engine, label);
      result.get(label)!.push(BitVector.fromNumber(raw, 1));
    }
  }

  return result;
}
