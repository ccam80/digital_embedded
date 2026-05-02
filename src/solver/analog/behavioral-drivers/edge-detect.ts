/**
 * Pure helpers for behavioral-driver leaves that observe a node voltage and
 * classify it against per-instance CMOS thresholds.
 *
 * Every sequential / latching driver carries its own `LAST_CLOCK` (or analog)
 * slot in its state schema and applies its own vIH / vIL, because different
 * logic families on the same physical net legitimately disagree on edge
 * timing and steady-state level. These functions are the math, lifted out so
 * the per-driver `load()` body stays small and the semantics stay uniform.
 *
 * No state, no allocation. Hot-path safe.
 */

/**
 * Did `curr` cross `vIH` from below (strict prev < vIH, inclusive curr >= vIH)?
 *
 * NaN-prev guard: returns false. Drivers initialise their LAST_CLOCK slot to
 * Number.NaN so the first observed step does not register as a spurious edge
 * if the circuit boots with the clock already high.
 */
export function detectRisingEdge(prev: number, curr: number, vIH: number): boolean {
  return !Number.isNaN(prev) && prev < vIH && curr >= vIH;
}

/**
 * Did `curr` cross `vIL` from above (strict prev > vIL, inclusive curr <= vIL)?
 *
 * NaN-prev guard mirrors detectRisingEdge.
 */
export function detectFallingEdge(prev: number, curr: number, vIL: number): boolean {
  return !Number.isNaN(prev) && prev > vIL && curr <= vIL;
}

/**
 * Hysteresis-classify a voltage against (vIH, vIL):
 *   v >= vIH      → 1
 *   v <  vIL      → 0
 *   otherwise     → prev (hold)
 *
 * `prev` MUST be 0 or 1; passing anything else returns it unchanged. The
 * caller owns the meaning of the held value (typically the held latch bit).
 * D-FF semantics: out-of-band v holds the latch (no update to q).
 */
export function logicLevel(v: number, vIH: number, vIL: number, prev: 0 | 1): 0 | 1 {
  if (v >= vIH) return 1;
  if (v < vIL) return 0;
  return prev;
}
