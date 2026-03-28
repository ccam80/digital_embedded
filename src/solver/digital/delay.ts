/**
 * Delay resolution for timed simulation mode.
 *
 * Per-component propagation delays are resolved in a three-level priority:
 *   1. Instance property "delay" (set on the component in the circuit editor)
 *   2. ComponentDefinition.defaultDelay (set when the type is registered)
 *   3. DEFAULT_GATE_DELAY (10ns global fallback)
 *
 * The resulting flat Uint32Array is indexed by component slot index and
 * consumed by the engine's timed-mode scheduling logic.
 *
 */

/** Global fallback gate delay in nanoseconds. */
export const DEFAULT_GATE_DELAY = 10;
