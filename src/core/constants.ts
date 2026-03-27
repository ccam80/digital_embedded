/**
 * Shared simulation constants used across multiple modules.
 */

/** Maximum propagation steps before aborting a run-to-break loop. */
export const MAX_STEPS = 100_000;

/** Maximum total input bit count for truth-table analysis (2^20 ≈ 1M rows). */
export const MAX_INPUT_BITS = 20;

/** Maximum subcircuit nesting depth (matching Digital's limit). */
export const MAX_DEPTH = 30;
