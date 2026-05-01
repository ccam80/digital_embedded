/**
 * ScopeCursors- measurement cursors for the analog oscilloscope.
 *
 * Two vertical cursors (A and B) can be placed on the time axis. When both
 * are set, getMeasurements() computes ΔT, ΔV, frequency, RMS, peak-to-peak,
 * and mean for the samples between the cursor positions.
 */

import type { AnalogScopeBuffer } from "./analog-scope-buffer.js";
import { formatSI } from "../editor/si-format.js";
export { formatSI };

// ---------------------------------------------------------------------------
// ScopeMeasurements- computed values between cursors A and B
// ---------------------------------------------------------------------------

export interface ScopeMeasurements {
  /** Time difference B - A in seconds. */
  deltaT: number;
  /** 1/|ΔT| in Hz. */
  frequency: number;
  /** Value at B minus value at A (nearest samples). */
  deltaV: number;
  /** RMS of samples between A and B: sqrt(mean(v²)). */
  rms: number;
  /** max - min of samples between A and B. */
  peakToPeak: number;
  /** Arithmetic mean of samples between A and B. */
  mean: number;
}

// ---------------------------------------------------------------------------
// ScopeCursors
// ---------------------------------------------------------------------------

export class ScopeCursors {
  private _cursorA: number | null = null;
  private _cursorB: number | null = null;

  /** Place cursor A at the given simulation time. */
  setCursorA(time: number): void {
    this._cursorA = time;
  }

  /** Place cursor B at the given simulation time. */
  setCursorB(time: number): void {
    this._cursorB = time;
  }

  /** Remove both cursors. */
  clearCursors(): void {
    this._cursorA = null;
    this._cursorB = null;
  }

  /** Current cursor A time, or null if not set. */
  get cursorA(): number | null {
    return this._cursorA;
  }

  /** Current cursor B time, or null if not set. */
  get cursorB(): number | null {
    return this._cursorB;
  }

  /**
   * Computes measurements between cursor A and cursor B using the given buffer.
   *
   * Returns undefined when fewer than 2 cursors are set.
   */
  getMeasurements(buffer: AnalogScopeBuffer): ScopeMeasurements | undefined {
    if (this._cursorA === null || this._cursorB === null) {
      return undefined;
    }

    const tA = this._cursorA;
    const tB = this._cursorB;

    const tMin = Math.min(tA, tB);
    const tMax = Math.max(tA, tB);
    const deltaT = tB - tA;

    // Get samples between the cursors
    const { value } = buffer.getSamplesInRange(tMin, tMax);

    // deltaV: value at cursor B minus value at cursor A (nearest samples)
    const vA = this._nearestValue(buffer, tA);
    const vB = this._nearestValue(buffer, tB);
    const deltaV = vB - vA;

    if (value.length === 0) {
      return {
        deltaT,
        frequency: deltaT !== 0 ? 1 / Math.abs(deltaT) : Infinity,
        deltaV,
        rms: 0,
        peakToPeak: 0,
        mean: 0,
      };
    }

    // RMS, peak-to-peak, mean
    let sum = 0;
    let sumSq = 0;
    let mn = value[0];
    let mx = value[0];

    for (let i = 0; i < value.length; i++) {
      const v = value[i];
      sum += v;
      sumSq += v * v;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }

    const n = value.length;
    const mean = sum / n;
    const rms = Math.sqrt(sumSq / n);
    const peakToPeak = mx - mn;

    return {
      deltaT,
      frequency: deltaT !== 0 ? 1 / Math.abs(deltaT) : Infinity,
      deltaV,
      rms,
      peakToPeak,
      mean,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Find the value of the nearest sample in the buffer to the given time.
   * Returns 0 if the buffer is empty.
   */
  private _nearestValue(buffer: AnalogScopeBuffer, time: number): number {
    if (buffer.sampleCount === 0) return 0;

    // Query a tiny window around the cursor time to find the nearest sample.
    // Start with a small epsilon and expand if needed.
    const epsilon = (buffer.timeEnd - buffer.timeStart) / buffer.sampleCount;
    let window = epsilon * 2;

    for (let attempt = 0; attempt < 20; attempt++) {
      const { time: times, value } = buffer.getSamplesInRange(time - window, time + window);
      if (times.length > 0) {
        // Find the nearest sample
        let bestIdx = 0;
        let bestDist = Math.abs(times[0] - time);
        for (let i = 1; i < times.length; i++) {
          const dist = Math.abs(times[i] - time);
          if (dist < bestDist) {
            bestDist = dist;
            bestIdx = i;
          }
        }
        return value[bestIdx];
      }
      window *= 4;
    }

    return 0;
  }
}
