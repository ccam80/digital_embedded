/**
 * Shared simulation constants used across multiple modules.
 */

/** Maximum propagation steps before aborting a run-to-break loop. */
export const MAX_STEPS = 100_000;

/** Maximum total input bit count for truth-table analysis (2^20 ≈ 1M rows). */
export const MAX_INPUT_BITS = 20;

/** Maximum subcircuit nesting depth (matching Digital's limit). */
export const MAX_DEPTH = 30;

// ---------------------------------------------------------------------------
// Physical constants (ngspice CONSTroot / const.h values)
// ---------------------------------------------------------------------------

/**
 * Thermal voltage at REFTEMP (300.15 K): REFTEMP * CONSTKoverQ.
 *
 * Uses ngspice's exact Boltzmann and electron-charge values from const.h:
 *   CONSTboltz  = 1.3806226e-23  J/K
 *   CHARGE      = 1.6021918e-19  C
 *   REFTEMP     = 300.15         K   (27 °C)
 */
export const VT = 300.15 * 1.3806226e-23 / 1.6021918e-19;
