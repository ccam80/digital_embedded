/**
 * RunToBreak — run simulation until a Break component fires or maxSteps is reached.
 *
 * Break components monitor a condition (their input signal) and fire when the
 * condition is non-zero. The run-to-break loop advances the engine one step at
 * a time, checking all Break component inputs after each step.
 *
 * Java reference: de.neemann.digital.core.Model (runToBreak semantics)
 */

import type { DigitalEngine, ConcreteCompiledCircuit } from "./digital-engine.js";
import type { CompiledCircuit } from "@/core/engine-interface";

// ---------------------------------------------------------------------------
// BreakResult
// ---------------------------------------------------------------------------

/**
 * Result returned by run().
 *
 * reason: 'break'    — a Break component's input was asserted.
 * reason: 'maxSteps' — maxSteps was reached before any Break fired.
 * breakComponent:    — index of the Break component that fired (when reason='break').
 * stepsExecuted:     — total steps executed before halting.
 */
export interface BreakResult {
  readonly reason: "break" | "maxSteps";
  readonly breakComponent?: number;
  readonly stepsExecuted: number;
}

// ---------------------------------------------------------------------------
// RunToBreak
// ---------------------------------------------------------------------------

/**
 * Runs the engine step-by-step until a Break component fires or maxSteps
 * is exceeded.
 *
 * Break components are identified by their element type name "Break".
 * Their input net is checked after each step; if the raw value is non-zero,
 * the run halts and the Break component's index is reported.
 *
 * @param engine    The DigitalEngine to step.
 * @param compiled  The compiled circuit (needed to locate Break components).
 * @param maxSteps  Safety limit — halts with reason 'maxSteps' if reached.
 */
export function run(
  engine: DigitalEngine,
  compiled: CompiledCircuit,
  maxSteps: number,
): BreakResult {
  const concrete = toConcreteCompiledCircuit(compiled);
  const breakIndices = concrete !== null
    ? findBreakComponents(concrete)
    : [];

  for (let step = 0; step < maxSteps; step++) {
    engine.step();

    for (const componentIndex of breakIndices) {
      const inputOffset = concrete!.layout.inputOffset(componentIndex);
      const raw = engine.getSignalRaw(inputOffset);
      if (raw !== 0) {
        return { reason: "break", breakComponent: componentIndex, stepsExecuted: step + 1 };
      }
    }
  }

  return { reason: "maxSteps", stepsExecuted: maxSteps };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Collect the indices of all Break components in the compiled circuit.
 *
 * Break components are identified by their element type name "Break".
 */
function findBreakComponents(compiled: ConcreteCompiledCircuit): number[] {
  const indices: number[] = [];
  for (const [index, element] of compiled.componentToElement) {
    if (element.type === "Break") {
      indices.push(index);
    }
  }
  return indices;
}

/**
 * Narrow a CompiledCircuit to ConcreteCompiledCircuit if it has the required
 * fields, otherwise return null.
 */
function toConcreteCompiledCircuit(c: CompiledCircuit): ConcreteCompiledCircuit | null {
  if (
    "componentToElement" in c &&
    "layout" in c &&
    "evaluationOrder" in c
  ) {
    return c as ConcreteCompiledCircuit;
  }
  return null;
}
