/**
 * VoltageRangeTracker — maintains [min, max] voltage range for wire color mapping.
 *
 * Scans all node voltages once per render frame. Auto-scales by default with
 * exponential smoothing: expands instantly to accommodate new extremes, contracts
 * slowly to avoid jitter. The user can override with a fixed range.
 *
 * Ground (0V) is always included in the range.
 */

import type { AnalogEngine } from "@/core/analog-engine-interface";

/** Smoothing factor for slow contraction (applied when range shrinks). */
const CONTRACTION_ALPHA = 0.05;

/** Default range when no nodes are present. */
const DEFAULT_MIN = -5;
const DEFAULT_MAX = 5;

/** Padding applied when all nodes are at the same voltage. */
const UNIFORM_PADDING = 0.1;

export class VoltageRangeTracker {
  private _autoMin: number = DEFAULT_MIN;
  private _autoMax: number = DEFAULT_MAX;
  private _fixedMin: number | null = null;
  private _fixedMax: number | null = null;

  /**
   * Scan all MNA node voltages and update the tracked [min, max] range.
   *
   * Uses exponential smoothing with instant expansion: the range expands
   * immediately to accommodate new extremes but contracts slowly toward the
   * observed range to prevent visual jitter.
   *
   * @param engine - The active analog engine.
   * @param nodeCount - Number of non-ground MNA nodes.
   */
  update(engine: AnalogEngine, nodeCount: number): void {
    if (nodeCount <= 0) {
      // No nodes — keep defaults, always include ground
      this._autoMin = DEFAULT_MIN;
      this._autoMax = DEFAULT_MAX;
      return;
    }

    // Scan all node voltages to find raw min/max
    let rawMin = 0; // ground always included
    let rawMax = 0;

    for (let i = 0; i < nodeCount; i++) {
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

    // Instant expansion, slow contraction
    if (rawMax > this._autoMax) {
      this._autoMax = rawMax;
    } else {
      this._autoMax = (1 - CONTRACTION_ALPHA) * this._autoMax + CONTRACTION_ALPHA * rawMax;
    }

    if (rawMin < this._autoMin) {
      this._autoMin = rawMin;
    } else {
      this._autoMin = (1 - CONTRACTION_ALPHA) * this._autoMin + CONTRACTION_ALPHA * rawMin;
    }
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
   * 0V (ground) maps to 0.5 when the range is symmetric about ground.
   * For asymmetric ranges, ground maps proportionally within the range.
   *
   * Returns 0.5 when min === max to avoid division by zero.
   */
  normalize(voltage: number): number {
    const lo = this.min;
    const hi = this.max;
    if (hi === lo) return 0.5;
    return (voltage - lo) / (hi - lo);
  }
}
