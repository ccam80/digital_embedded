/**
 * Noise-mode evaluation for feedback SCC initialization.
 *
 * Digital's noise mode breaks symmetry in circuits like SR latches from gates
 * by shuffling evaluation order and interleaving reads/writes within each SCC.
 * After initialization is complete, noise mode is not used — the engine runs
 * deterministically.
 *
 */

import type { ComponentLayout, ExecuteFunction } from "../core/registry.js";

// ---------------------------------------------------------------------------
// shuffleArray — Fisher-Yates in-place shuffle of a subrange
// ---------------------------------------------------------------------------

/**
 * Fisher-Yates in-place shuffle of a subrange of a Uint32Array.
 *
 * Shuffles elements in [start, start + length) in-place.
 * Does nothing if length <= 1.
 *
 * @param arr    The array to shuffle in-place
 * @param start  Index of the first element in the subrange
 * @param length Number of elements to shuffle
 */
export function shuffleArray(arr: Uint32Array, start: number, length: number): void {
  if (length <= 1) return;
  for (let i = length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[start + i];
    arr[start + i] = arr[start + j];
    arr[start + j] = tmp;
  }
}

// ---------------------------------------------------------------------------
// evaluateWithNoise — interleaved read/write in shuffled order
// ---------------------------------------------------------------------------

/**
 * Evaluate a range of components with noise: shuffle the evaluation order,
 * then for each component call its execute function immediately (reads inputs
 * and writes outputs in one call, interleaved with other components).
 *
 * This matches Digital's noise mode semantics where reads and writes are NOT
 * separated — one component's output can immediately affect the next component's
 * input within the same micro-step. The randomized order breaks symmetry in
 * feedback loops (e.g. SR latches from NOR gates).
 *
 * @param components  Uint32Array of component indices in this SCC
 * @param start       Start index within components
 * @param count       Number of components to evaluate
 * @param state       Signal value array (read and written directly)
 * @param executeFns  Function table indexed by type ID
 * @param typeIds     Type ID per component index
 * @param layout      Wiring descriptor
 */
export function evaluateWithNoise(
  components: Uint32Array,
  start: number,
  count: number,
  state: Uint32Array,
  highZs: Uint32Array,
  executeFns: ExecuteFunction[],
  typeIds: Uint8Array,
  layout: ComponentLayout,
): void {
  // Work on a copy so the caller's ordering is not disturbed between calls
  const indices = components.slice(start, start + count);
  shuffleArray(indices, 0, count);

  for (let i = 0; i < count; i++) {
    const compIdx = indices[i];
    executeFns[typeIds[compIdx]](compIdx, state, highZs, layout);
  }
}

// ---------------------------------------------------------------------------
// evaluateSynchronized — snapshot-based, order-independent within an SCC
// ---------------------------------------------------------------------------

/**
 * Evaluate a range of components in synchronized mode: snapshot the input net
 * values for all components in the SCC before any writes, then evaluate each
 * component reading from the snapshot and writing to the real state array.
 *
 * This ensures evaluation is order-independent within the SCC — matching
 * Digital's non-noise synchronized mode. The snapshot buffer must be sized to
 * at least the number of distinct input nets referenced by components in this
 * SCC. In practice, the buffer is sized to netCount (pre-allocated by the
 * engine at compile time).
 *
 *
 * @param components     Uint32Array of component indices in this SCC
 * @param start          Start index within components
 * @param count          Number of components to evaluate
 * @param state          Signal value array (mutated to reflect post-step outputs)
 * @param snapshotBuffer Pre-allocated buffer, length >= state.length
 * @param executeFns     Function table indexed by type ID
 * @param typeIds        Type ID per component index
 * @param layout         Wiring descriptor
 */
export function evaluateSynchronized(
  components: Uint32Array,
  start: number,
  count: number,
  state: Uint32Array,
  highZs: Uint32Array,
  snapshotBuffer: Uint32Array,
  executeFns: ExecuteFunction[],
  typeIds: Uint8Array,
  layout: ComponentLayout,
): void {
  // Snapshot input values before any writes
  snapshotBuffer.set(state);

  // Each component reads inputs from the snapshot (pre-step values) and
  // writes outputs to the real state array.  We achieve this by running the
  // executeFn with the *snapshot* as the readable state, then copying only
  // the output slots from the snapshot into the real state.
  //
  // However, executeFns read *and* write the same array.  To get true
  // read-from-snapshot / write-to-state semantics we:
  //   1. Evaluate each component against the snapshot (inputs are pristine).
  //   2. After each evaluation, copy the component's *output* net values
  //      from the snapshot back into the real state array.
  //   3. Restore the snapshot slots the executeFn modified so the next
  //      component still sees pristine inputs.
  //
  // Because we don't have per-component output offset info here (layout is
  // opaque), we use a simpler equivalent approach: run all components on
  // a *copy* of the snapshot (so writes go into the copy, not the snapshot),
  // and the copy is reset from the snapshot before each component.

  // Actually the simplest correct approach: for each component, restore
  // snapshot, execute (writes go to snapshot copy), then diff and apply to
  // state.  But we can do even simpler:
  //
  // Evaluate ALL components on a temporary buffer seeded from the snapshot.
  // But we need isolation between components.  The cleanest solution:
  //   - For each component: copy snapshot → temp, execute on temp, diff
  //     temp vs snapshot, apply diffs to state.
  // This is O(count * stateSize) but SCC sizes are small (typically <10).

  for (let i = 0; i < count; i++) {
    const compIdx = components[start + i];
    // Create a working copy of the snapshot for this component
    const working = new Uint32Array(snapshotBuffer);
    // Execute: reads from snapshot values, writes to working
    executeFns[typeIds[compIdx]](compIdx, working, highZs, layout);
    // Apply only the changed slots to real state
    for (let s = 0; s < working.length; s++) {
      if (working[s] !== snapshotBuffer[s]) {
        state[s] = working[s];
      }
    }
  }
}
