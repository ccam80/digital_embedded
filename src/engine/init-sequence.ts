/**
 * Circuit initialization sequence.
 *
 * Port of Digital's Model initialization: noise-based symmetry breaking for
 * feedback SCCs, followed by reset component release, followed by a
 * deterministic settle pass.
 *
 * Sequence:
 *   1. Set all signals to UNDEFINED.
 *   2. For each feedback SCC: run evaluateWithNoise repeatedly until stable
 *      or oscillation limit reached. Non-feedback components are swept in
 *      topological order using evaluateSynchronized.
 *   3. Release Reset components (drive their output from 0 → 1).
 *   4. Run one deterministic settle pass (evaluateSynchronized for all groups)
 *      to propagate Reset effects.
 */

import { evaluateWithNoise, evaluateSynchronized } from "./noise-mode.js";
import type { ExecuteFunction, ComponentLayout } from "../core/registry.js";

// ---------------------------------------------------------------------------
// EvaluationGroup — one SCC or singleton in topological order
// ---------------------------------------------------------------------------

/**
 * One group in the compiled circuit's evaluation order.
 * A single-node group (isFeedback=false) is evaluated once per step.
 * A multi-node group (isFeedback=true) is iterated until stable.
 */
export interface EvaluationGroup {
  /** Component indices in this group. */
  readonly componentIndices: Uint32Array;
  /** True when this group contains a combinational feedback loop (SCC size > 1). */
  readonly isFeedback: boolean;
}

// ---------------------------------------------------------------------------
// InitializableEngine — subset of DigitalEngine needed by the init sequence
// ---------------------------------------------------------------------------

/**
 * The subset of the engine's internals that initializeCircuit needs.
 *
 * DigitalEngine passes itself as this interface. Defined separately so that
 * the init sequence does not import the concrete DigitalEngine class (avoiding
 * circular dependencies).
 */
export interface InitializableEngine {
  /** The signal value array (all nets). */
  readonly state: Uint32Array;
  /** High-impedance flags array, parallel to state. */
  readonly highZs: Uint32Array;
  /** Pre-allocated snapshot buffer, same length as state. */
  readonly snapshotBuffer: Uint32Array;
  /** Type ID per component index. */
  readonly typeIds: Uint8Array;
  /** Function table indexed by type ID. */
  readonly executeFns: ExecuteFunction[];
  /** Wiring descriptor. */
  readonly layout: ComponentLayout;
  /** Evaluation groups in topological order. */
  readonly evaluationOrder: EvaluationGroup[];
  /** Indices of Reset components (if any). Their output net is driven to 1 after noise init. */
  readonly resetComponentIndices: Uint32Array;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * UNDEFINED encoding in the flat signal array: value=0, highZ=0xFFFFFFFF.
 * The flat signal array stores only value words; UNDEFINED is represented by
 * value word = 0 (the parallel highZ array is not tracked here — initialization
 * sets all value words to 0, which matches the UNDEFINED convention).
 */
const UNDEFINED_VALUE = 0;

/** Maximum iterations per feedback SCC per init pass before declaring oscillation. */
const MAX_NOISE_ITERATIONS = 100;

/** Maximum iterations per feedback SCC in the deterministic settle pass. */
const MAX_SETTLE_ITERATIONS = 100;

// ---------------------------------------------------------------------------
// initializeCircuit — full init sequence
// ---------------------------------------------------------------------------

/**
 * Run the full circuit initialization sequence on an engine.
 *
 * Mutates engine.state in-place. The engine must have already allocated
 * state and snapshotBuffer (sized to netCount).
 *
 * @param engine  The engine internals to initialize.
 */
export function initializeCircuit(engine: InitializableEngine): void {
  const { state, highZs, snapshotBuffer, typeIds, executeFns, layout, evaluationOrder } = engine;

  // Step 1: Set all signals to UNDEFINED (value = 0)
  state.fill(UNDEFINED_VALUE);

  // Step 2: Noise propagation — run multiple passes to let circuit settle
  // For feedback SCCs: use noise (shuffled, interleaved). For non-feedback: synchronized.
  runNoisePropagation(state, highZs, snapshotBuffer, typeIds, executeFns, layout, evaluationOrder);

  // Step 3: Release Reset components (drive output to 1)
  releaseResetComponents(engine);

  // Step 4: Deterministic settle — one full sweep in topological order, no noise
  runDeterministicSettle(state, highZs, snapshotBuffer, typeIds, executeFns, layout, evaluationOrder);
}

// ---------------------------------------------------------------------------
// runNoisePropagation
// ---------------------------------------------------------------------------

function runNoisePropagation(
  state: Uint32Array,
  highZs: Uint32Array,
  snapshotBuffer: Uint32Array,
  typeIds: Uint8Array,
  executeFns: ExecuteFunction[],
  layout: ComponentLayout,
  evaluationOrder: EvaluationGroup[],
): void {
  for (let pass = 0; pass < MAX_NOISE_ITERATIONS; pass++) {
    let anyChanged = false;

    for (const group of evaluationOrder) {
      const { componentIndices, isFeedback } = group;
      const count = componentIndices.length;

      if (count === 0) continue;

      // Capture outputs before evaluation to detect changes
      const outputsBefore = captureOutputs(componentIndices, count, state, layout);

      if (isFeedback) {
        evaluateWithNoise(componentIndices, 0, count, state, highZs, executeFns, typeIds, layout);
      } else {
        evaluateSynchronized(componentIndices, 0, count, state, highZs, snapshotBuffer, executeFns, typeIds, layout);
      }

      if (outputsChanged(componentIndices, count, state, layout, outputsBefore)) {
        anyChanged = true;
      }
    }

    if (!anyChanged) break;
  }
}

// ---------------------------------------------------------------------------
// runDeterministicSettle
// ---------------------------------------------------------------------------

function runDeterministicSettle(
  state: Uint32Array,
  highZs: Uint32Array,
  snapshotBuffer: Uint32Array,
  typeIds: Uint8Array,
  executeFns: ExecuteFunction[],
  layout: ComponentLayout,
  evaluationOrder: EvaluationGroup[],
): void {
  for (let pass = 0; pass < MAX_SETTLE_ITERATIONS; pass++) {
    let anyChanged = false;

    for (const group of evaluationOrder) {
      const { componentIndices } = group;
      const count = componentIndices.length;

      if (count === 0) continue;

      const outputsBefore = captureOutputs(componentIndices, count, state, layout);
      evaluateSynchronized(componentIndices, 0, count, state, highZs, snapshotBuffer, executeFns, typeIds, layout);

      if (outputsChanged(componentIndices, count, state, layout, outputsBefore)) {
        anyChanged = true;
      }
    }

    if (!anyChanged) break;
  }
}

// ---------------------------------------------------------------------------
// releaseResetComponents
// ---------------------------------------------------------------------------

/**
 * Reset components hold their output low (0) during initialization to force
 * downstream flip-flops to a known state after noise settles. After noise init,
 * Reset components release: their output transitions to 1 (inactive).
 *
 * The Reset component's executeFn handles normal operation. During init,
 * the engine drives the Reset component's output net directly to 0, then after
 * noise init releases it by calling the executeFn normally (which will output 1
 * when not actively resetting).
 *
 * Here we simply call each Reset component's executeFn so it can write its
 * post-init output value to state.
 */
function releaseResetComponents(engine: InitializableEngine): void {
  const { state, typeIds, executeFns, layout, resetComponentIndices } = engine;
  for (let i = 0; i < resetComponentIndices.length; i++) {
    const compIdx = resetComponentIndices[i];
    executeFns[typeIds[compIdx]](compIdx, state, engine.highZs, layout);
  }
}

// ---------------------------------------------------------------------------
// Output capture helpers
// ---------------------------------------------------------------------------

/**
 * Capture output net values for all components in a group before evaluation.
 * Returns a flat array of [netId, value] pairs for all output nets.
 */
function captureOutputs(
  componentIndices: Uint32Array,
  count: number,
  state: Uint32Array,
  layout: ComponentLayout,
): Uint32Array {
  // Count total output slots
  let totalOutputs = 0;
  for (let i = 0; i < count; i++) {
    totalOutputs += layout.outputCount(componentIndices[i]);
  }

  const captured = new Uint32Array(totalOutputs);
  let pos = 0;
  for (let i = 0; i < count; i++) {
    const compIdx = componentIndices[i];
    const outOffset = layout.outputOffset(compIdx);
    const outCount = layout.outputCount(compIdx);
    for (let j = 0; j < outCount; j++) {
      captured[pos++] = state[outOffset + j];
    }
  }
  return captured;
}

/**
 * Compare current output net values against pre-evaluation snapshot.
 * Returns true if any output changed.
 */
function outputsChanged(
  componentIndices: Uint32Array,
  count: number,
  state: Uint32Array,
  layout: ComponentLayout,
  before: Uint32Array,
): boolean {
  let pos = 0;
  for (let i = 0; i < count; i++) {
    const compIdx = componentIndices[i];
    const outOffset = layout.outputOffset(compIdx);
    const outCount = layout.outputCount(compIdx);
    for (let j = 0; j < outCount; j++) {
      if (state[outOffset + j] !== before[pos]) return true;
      pos++;
    }
  }
  return false;
}
