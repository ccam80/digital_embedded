/**
 * Tests for ScopeCursors and formatSI.
 */

import { describe, it, expect } from "vitest";
import { ScopeCursors, formatSI } from "../scope-cursors.js";
import { AnalogScopeBuffer } from "../analog-scope-buffer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a buffer with given (time, value) pairs. */
function bufferFromPairs(pairs: [number, number][]): AnalogScopeBuffer {
  const buf = new AnalogScopeBuffer(65536);
  for (const [t, v] of pairs) {
    buf.push(t, v);
  }
  return buf;
}

/** Generate one full period of a sine wave with given amplitude. */
function sinePairs(peakAmplitude: number, samples: number): [number, number][] {
  const pairs: [number, number][] = [];
  for (let i = 0; i < samples; i++) {
    const t = i / samples; // time 0..1 second (one period)
    const v = peakAmplitude * Math.sin(2 * Math.PI * i / samples);
    pairs.push([t, v]);
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Cursor measurement tests
// ---------------------------------------------------------------------------

describe("Cursors", () => {
  it("delta_t_correct", () => {
    const buf = bufferFromPairs([
      [0.001, 1.0],
      [0.002, 1.5],
      [0.003, 2.0],
    ]);
    const cursors = new ScopeCursors();
    cursors.setCursorA(0.001);
    cursors.setCursorB(0.003);

    const m = cursors.getMeasurements(buf);
    expect(m).toBeDefined();
    expect(m!.deltaT).toBeCloseTo(0.002, 9);
    expect(m!.frequency).toBeCloseTo(500, 0);
  });

  it("delta_v_correct", () => {
    // Buffer has V=2.0 at tA and V=4.5 at tB
    const buf = bufferFromPairs([
      [0.001, 2.0],
      [0.002, 3.0],
      [0.003, 4.5],
    ]);
    const cursors = new ScopeCursors();
    cursors.setCursorA(0.001);
    cursors.setCursorB(0.003);

    const m = cursors.getMeasurements(buf);
    expect(m).toBeDefined();
    expect(m!.deltaV).toBeCloseTo(2.5, 5);
  });

  it("rms_of_sine", () => {
    // One full period of 5V peak sine; RMS = 5/sqrt(2) ≈ 3.5355
    const N = 1024;
    const buf = bufferFromPairs(sinePairs(5, N));

    const cursors = new ScopeCursors();
    cursors.setCursorA(0);
    cursors.setCursorB(1 - 1 / N); // just before end of buffer

    const m = cursors.getMeasurements(buf);
    expect(m).toBeDefined();
    // RMS of sine: 5/√2 ≈ 3.5355, allow ±0.1V
    expect(m!.rms).toBeCloseTo(5 / Math.SQRT2, 1);
  });

  it("peak_to_peak", () => {
    const buf = bufferFromPairs([
      [0, -3],
      [1, 0],
      [2, 2],
      [3, 5],
      [4, 1],
    ]);
    const cursors = new ScopeCursors();
    cursors.setCursorA(0);
    cursors.setCursorB(4);

    const m = cursors.getMeasurements(buf);
    expect(m).toBeDefined();
    expect(m!.peakToPeak).toBeCloseTo(8, 5); // max(5) - min(-3) = 8
  });

  it("single_cursor_returns_undefined", () => {
    const buf = bufferFromPairs([[0, 1], [1, 2]]);
    const cursors = new ScopeCursors();
    cursors.setCursorA(0.5);
    // cursor B not set
    expect(cursors.getMeasurements(buf)).toBeUndefined();
  });

  it("no_cursors_returns_undefined", () => {
    const buf = bufferFromPairs([[0, 1], [1, 2]]);
    const cursors = new ScopeCursors();
    expect(cursors.getMeasurements(buf)).toBeUndefined();
  });

  it("clear_cursors_returns_undefined", () => {
    const buf = bufferFromPairs([[0, 1], [1, 2]]);
    const cursors = new ScopeCursors();
    cursors.setCursorA(0);
    cursors.setCursorB(1);
    cursors.clearCursors();
    expect(cursors.getMeasurements(buf)).toBeUndefined();
  });

  it("cursors_swapped_order_still_works", () => {
    // B before A in time — deltaT should be negative, frequency still positive
    const buf = bufferFromPairs([[0, 0], [1, 5], [2, 10]]);
    const cursors = new ScopeCursors();
    cursors.setCursorA(2);
    cursors.setCursorB(0);

    const m = cursors.getMeasurements(buf);
    expect(m).toBeDefined();
    expect(m!.deltaT).toBeCloseTo(-2, 5);
    expect(m!.frequency).toBeCloseTo(0.5, 5);
    expect(m!.deltaV).toBeCloseTo(-10, 5); // vB - vA = 0 - 10 = -10
  });
});

// ---------------------------------------------------------------------------
// SI unit formatting tests
// ---------------------------------------------------------------------------

describe("Cursors", () => {
  it("si_unit_formatting", () => {
    // 0.001 s → "1.00 ms"
    expect(formatSI(0.001, "s")).toBe("1.00 ms");
    // 1500 Hz → "1.50 kHz"
    expect(formatSI(1500, "Hz")).toBe("1.50 kHz");
    // 0.0034 V → "3.40 mV"
    expect(formatSI(0.0034, "V")).toBe("3.40 mV");
  });

  it("si_milliamps", () => {
    expect(formatSI(0.0047, "A")).toBe("4.70 mA");
  });

  it("si_kilohms", () => {
    expect(formatSI(2200, "Ω")).toBe("2.20 kΩ");
  });

  it("si_microfarads", () => {
    expect(formatSI(1e-6, "F")).toBe("1.00 µF");
  });

  it("si_zero", () => {
    expect(formatSI(0, "V")).toBe("0.00 V");
  });

  it("si_negative", () => {
    expect(formatSI(-3.3, "V")).toBe("-3.30 V");
  });

  it("si_very_small", () => {
    expect(formatSI(1e-14, "A")).toBe("10.0 fA");
  });
});
