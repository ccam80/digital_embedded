/**
 * Shared noop execute functions for use in tests.
 *
 * Eliminates repeated inline definitions of no-op ExecuteFunction stubs
 * across the test suite.
 */

import type { ExecuteFunction, ComponentLayout } from "../core/registry.js";

/**
 * Does nothing. Use when a component needs a digital model but the test
 * does not care about signal propagation.
 */
export const noopExecFn: ExecuteFunction = (
  _index: number,
  _state: Uint32Array,
  _highZs: Uint32Array,
  _layout: ComponentLayout,
): void => {};

/**
 * Copies each input to the corresponding output at the same index.
 * Useful for pass-through buffer components in tests.
 */
export const executePassThrough: ExecuteFunction = (
  index: number,
  state: Uint32Array,
  _highZs: Uint32Array,
  layout: ComponentLayout,
): void => {
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const count = Math.min(layout.inputCount(index), layout.outputCount(index));
  const wt = layout.wiringTable;
  for (let k = 0; k < count; k++) {
    state[wt[outBase + k]] = state[wt[inBase + k]];
  }
};

/**
 * 2-input AND gate execute function.
 * Reads inputs 0 and 1, writes AND result to output 0.
 */
export const executeAnd2: ExecuteFunction = (
  index: number,
  state: Uint32Array,
  _highZs: Uint32Array,
  layout: ComponentLayout,
): void => {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  state[wt[outBase]] = state[wt[inBase]] & state[wt[inBase + 1]];
};
