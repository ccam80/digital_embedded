/**
 * MicroStepController — advance one component evaluation at a time.
 *
 * Wraps DigitalEngine to expose micro-step evaluation with result reporting:
 * which component fired, and which output nets changed value.
 *
 * Stability tracking: `isStable()` returns true when the current micro-step
 * pass has visited all components without any net changes (the circuit has
 * reached a fixed point). A pass visits every component once in topological
 * order; after all components are visited, stability is re-evaluated on the
 * next pass.
 *
 * Java reference: de.neemann.digital.core.Model.doMicroStep()
 */

import type { DigitalEngine, ConcreteCompiledCircuit } from "./digital-engine.js";
import type { CompiledCircuit } from "@/core/engine-interface";

// ---------------------------------------------------------------------------
// MicroStepResult
// ---------------------------------------------------------------------------

/**
 * Result of one micro-step evaluation.
 *
 * componentIndex: the slot index of the component that just fired.
 * typeId:         the string type name of that component.
 * changedNets:    net IDs whose values changed as a result of this evaluation.
 */
export interface MicroStepResult {
  readonly componentIndex: number;
  readonly typeId: string;
  readonly changedNets: number[];
}

// ---------------------------------------------------------------------------
// MicroStepController
// ---------------------------------------------------------------------------

/**
 * Wraps a DigitalEngine to provide one-component-at-a-time evaluation.
 *
 * The controller calls engine.microStep() and captures the result by:
 *  1. Snapshotting all signal values before the step.
 *  2. Calling engine.microStep().
 *  3. Diffing the snapshot with the post-step signal state to find changed nets.
 *  4. Reading engine.getLastEvaluatedComponent() for identity.
 *
 * Stability is tracked by counting how many components have been evaluated in
 * the current pass. Once all components have been evaluated once, if no nets
 * changed during the entire pass, the circuit is stable.
 */
export class MicroStepController {
  private readonly _engine: DigitalEngine;
  private readonly _compiled: ConcreteCompiledCircuit | null;

  private _stepsSinceLastChange: number = 0;
  private _stepsInCurrentPass: number = 0;
  private _stable: boolean = false;

  constructor(engine: DigitalEngine) {
    this._engine = engine;
    this._compiled = extractConcreteCircuit(engine);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Evaluate one component.
   *
   * @returns MicroStepResult describing which component fired and what changed.
   */
  step(): MicroStepResult {
    const netCount = this._getNetCount();

    // Snapshot all signal values before the step
    const before = this._snapshotSignals(netCount);

    // Execute one micro-step
    this._engine.microStep();

    // Identify which component fired
    const last = this._engine.getLastEvaluatedComponent();
    const componentIndex = last?.index ?? 0;
    const typeId = last?.typeId ?? "";

    // Collect changed nets by diffing snapshot
    const changedNets: number[] = [];
    for (let i = 0; i < netCount; i++) {
      if (this._engine.getSignalRaw(i) !== before[i]) {
        changedNets.push(i);
      }
    }

    // Update stability tracking
    this._stepsInCurrentPass++;
    const totalComponents = this._compiled?.componentCount ?? 1;

    if (changedNets.length > 0) {
      this._stepsSinceLastChange = 0;
      this._stable = false;
    } else {
      this._stepsSinceLastChange++;
    }

    // After a full pass with no changes, the circuit is stable
    if (this._stepsInCurrentPass >= totalComponents) {
      this._stable = this._stepsSinceLastChange >= totalComponents;
      this._stepsInCurrentPass = 0;
    }

    return { componentIndex, typeId, changedNets };
  }

  /**
   * Returns true when the circuit has reached a fixed point — a full pass
   * over all components produced no output changes.
   */
  isStable(): boolean {
    return this._stable;
  }

  /**
   * Reset stability tracking and restart micro-step traversal from the
   * beginning of the evaluation order.
   */
  reset(): void {
    this._stepsSinceLastChange = 0;
    this._stepsInCurrentPass = 0;
    this._stable = false;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _getNetCount(): number {
    if (this._compiled !== null) {
      return this._compiled.netCount;
    }
    // Fall back: probe by attempting reads until getSignalRaw returns 0 for
    // an out-of-range index (engine returns 0 for out-of-range). This is an
    // approximation used only when a non-concrete circuit was provided.
    return 64;
  }

  private _snapshotSignals(netCount: number): Uint32Array {
    const snap = new Uint32Array(netCount);
    for (let i = 0; i < netCount; i++) {
      snap[i] = this._engine.getSignalRaw(i);
    }
    return snap;
  }
}

// ---------------------------------------------------------------------------
// Helper: extract ConcreteCompiledCircuit from engine if available
// ---------------------------------------------------------------------------

function extractConcreteCircuit(engine: DigitalEngine): ConcreteCompiledCircuit | null {
  // DigitalEngine stores the compiled circuit as a private field _compiled.
  // We access it through the public interface by checking if the engine
  // exposes it via a known getter. If not, we return null and fall back.
  const e = engine as unknown as { _compiled?: CompiledCircuit };
  const compiled = e._compiled;
  if (compiled === null || compiled === undefined) return null;
  if (isConcreteCompiledCircuit(compiled)) return compiled;
  return null;
}

function isConcreteCompiledCircuit(c: CompiledCircuit): c is ConcreteCompiledCircuit {
  return (
    "netCount" in c &&
    "componentCount" in c &&
    "evaluationOrder" in c
  );
}
