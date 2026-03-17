/**
 * ScopeCursors — measurement cursors for the analog oscilloscope.
 *
 * Two vertical cursors (A and B) can be placed on the time axis. When both
 * are set, getMeasurements() computes ΔT, ΔV, frequency, RMS, peak-to-peak,
 * and mean for the samples between the cursor positions.
 */

import type { AnalogScopeBuffer } from "./analog-scope-buffer.js";

// ---------------------------------------------------------------------------
// ScopeMeasurements — computed values between cursors A and B
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
// formatSI — local implementation (used until src/editor/si-format.ts exists)
// ---------------------------------------------------------------------------

/**
 * Formats a number with an appropriate SI prefix and 3 significant figures.
 *
 * Examples:
 *   formatSI(0.001, "A")   → "1.00 mA"
 *   formatSI(0.0047, "A")  → "4.70 mA"
 *   formatSI(2200, "Ω")    → "2.20 kΩ"
 *   formatSI(1e-6, "F")    → "1.00 µF"
 *   formatSI(1e-14, "A")   → "10.0 fA"
 */
export function formatSI(value: number, unit: string, precision?: number): string {
  if (value === 0) {
    return `0.00 ${unit}`;
  }

  const sigFigs = precision ?? 3;
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);

  // SI prefix table: [exponent, symbol]
  const prefixes: [number, string][] = [
    [-15, "f"],
    [-12, "p"],
    [-9, "n"],
    [-6, "µ"],
    [-3, "m"],
    [0, ""],
    [3, "k"],
    [6, "M"],
    [9, "G"],
    [12, "T"],
  ];

  // Find the appropriate prefix
  let chosenExp = 0;
  let chosenSymbol = "";

  for (let i = prefixes.length - 1; i >= 0; i--) {
    const [exp, sym] = prefixes[i]!;
    if (abs >= Math.pow(10, exp) * 0.9999999) {
      chosenExp = exp;
      chosenSymbol = sym;
      break;
    }
  }

  // If value is smaller than all prefixes (sub-femto), use femto
  if (abs < Math.pow(10, -15) * 0.9999999) {
    chosenExp = -15;
    chosenSymbol = "f";
  }

  const scaled = abs / Math.pow(10, chosenExp);

  // Format to `sigFigs` significant figures
  const formatted = scaled.toPrecision(sigFigs);

  const prefix = chosenSymbol ? `${chosenSymbol}${unit}` : unit;
  return `${sign}${formatted} ${prefix}`;
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
    const { time, value } = buffer.getSamplesInRange(tMin, tMax);

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
