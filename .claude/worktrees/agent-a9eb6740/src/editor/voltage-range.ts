/**
 * VoltageRangeTracker — maintains [min, max] voltage range for wire color mapping.
 *
 * Scans all node voltages once per render frame. The range latches to the
 * per-simulation-run min/max — it expands instantly to accommodate new extremes
 * but never contracts until the simulation is reset/restarted.
 *
 * Ground (0V) is always included in the range.
 *
 * Normalization uses a logarithmic curve so that small voltages are still
 * visually distinguishable when the range spans large values.
 */

import type { AnalogEngine } from "@/core/analog-engine-interface";

/** Default range when no nodes are present. */
const DEFAULT_MIN = -5;
const DEFAULT_MAX = 5;

/** Padding applied when all nodes are at the same voltage. */
const UNIFORM_PADDING = 0.1;

/**
 * Log-curve shaping exponent. Values < 1 compress the upper end of the scale
 * so that smaller voltages get more color differentiation. 0.4 gives roughly
 * a square-root-like curve — 10% of the range maps to ~25% of the color span.
 */
const LOG_GAMMA = 0.4;

export class VoltageRangeTracker {
  private _autoMin: number = DEFAULT_MIN;
  private _autoMax: number = DEFAULT_MAX;
  private _fixedMin: number | null = null;
  private _fixedMax: number | null = null;

  /**
   * Scan all MNA node voltages and update the tracked [min, max] range.
   *
   * The range is latched: it only expands to accommodate new extremes and
   * never contracts. Call `reset()` when the simulation restarts.
   *
   * @param engine - The active analog engine.
   * @param nodeCount - Number of non-ground MNA nodes.
   */
  update(engine: AnalogEngine, nodeCount: number): void {
    if (nodeCount <= 0) {
      return;
    }

    // Scan all node voltages to find raw min/max
    let rawMin = 0; // ground always included
    let rawMax = 0;

    for (let i = 1; i <= nodeCount; i++) {
      const v = engine.getNodeVoltage(i);
      if (v < rawMin) rawMin = v;
      if (v > rawMax) rawMax = v;
    }

    // Handle uniform voltage: expand to avoid zero-width range
    if (rawMax - rawMin < UNIFORM_PADDING * 2) {
      const mid = (rawMin + rawMax) / 2;
      rawMin = mid - UNIFORM_PADDING;
      rawMax = mid + UNIFORM_PADDING;
    }

    // Latching: only expand, never contract
    if (rawMax > this._autoMax) {
      this._autoMax = rawMax;
    }
    if (rawMin < this._autoMin) {
      this._autoMin = rawMin;
    }
  }

  /**
   * Reset the auto-scaled range to defaults. Call when the simulation
   * is started or restarted so the range re-latches from scratch.
   */
  reset(): void {
    this._autoMin = DEFAULT_MIN;
    this._autoMax = DEFAULT_MAX;
  }

  /**
   * Current lower bound of the voltage range.
   * Returns the user-set fixed min when a fixed range is active.
   */
  get min(): number {
    return this._fixedMin !== null ? this._fixedMin : this._autoMin;
  }

  /**
   * Current upper bound of the voltage range.
   * Returns the user-set fixed max when a fixed range is active.
   */
  get max(): number {
    return this._fixedMax !== null ? this._fixedMax : this._autoMax;
  }

  /**
   * Override auto-scaling with a user-set fixed range.
   *
   * @param min - Lower voltage bound.
   * @param max - Upper voltage bound.
   */
  setFixedRange(min: number, max: number): void {
    this._fixedMin = min;
    this._fixedMax = max;
  }

  /** Return to auto-scaling. Clears any previously set fixed range. */
  clearFixedRange(): void {
    this._fixedMin = null;
    this._fixedMax = null;
  }

  /** True when auto-scaling is active (no fixed range has been set). */
  get isAutoRange(): boolean {
    return this._fixedMin === null && this._fixedMax === null;
  }

  /**
   * Map a voltage to a normalized [0, 1] value for color interpolation.
   *
   * 0V (ground) always maps to 0.5 by using a symmetric range about ground:
   * the effective range is [-absMax, +absMax] where absMax = max(|min|, |max|).
   *
   * The mapping uses a power curve (gamma) so that small voltages are visually
   * distinguishable even when the range spans large values. The curve is
   * applied symmetrically about 0.5 (ground).
   *
   * Returns 0.5 when the range is zero-width.
   */
  normalize(voltage: number): number {
    const lo = this.min;
    const hi = this.max;
    // Use symmetric range about ground so 0V always maps to 0.5
    const absMax = Math.max(Math.abs(lo), Math.abs(hi));
    if (absMax === 0) return 0.5;

    // Linear fraction: [-absMax, +absMax] → [-1, +1]
    const linear = voltage / absMax;
    // Clamp to [-1, 1]
    const clamped = Math.max(-1, Math.min(1, linear));
    // Apply gamma curve symmetrically about 0: sign * |x|^gamma
    const shaped = Math.sign(clamped) * Math.pow(Math.abs(clamped), LOG_GAMMA);
    // Map [-1, +1] → [0, 1]
    return (shaped + 1) / 2;
  }
}
