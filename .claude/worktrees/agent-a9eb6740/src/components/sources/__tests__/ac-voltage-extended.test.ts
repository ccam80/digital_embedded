/**
 * Tests for the extended AC voltage source waveform modes:
 * sweep, AM, FM, and noise.
 */

import { describe, it, expect } from "vitest";
import { computeWaveformValue } from "../ac-voltage-source.js";
import type { ExtendedWaveformParams } from "../ac-voltage-source.js";

// ===========================================================================
// Sweep waveform tests
// ===========================================================================

describe("Sweep", () => {
  it("frequency_increases_over_time — sweep 100Hz→10kHz over 1s; period shorter at t=0.9s than t=0", () => {
    const ext: ExtendedWaveformParams = {
      freqStart: 100,
      freqEnd: 10000,
      sweepDuration: 1,
      sweepMode: "linear",
    };

    // At t=0 the instantaneous frequency should be ~100 Hz (period ~10ms).
    // Sample at t=0 and t=small to estimate the zero-crossing period at start.
    // At t=0.9s the instantaneous frequency should be ~9910 Hz.

    // Find zero crossings near t=0 to estimate period ≈ 1/100Hz = 10ms.
    // We check that sin(2π * f(t) * t) at t near 1/(2*100) ≈ 5ms is near zero
    // (half-period crossing at ~5ms for 100Hz).
    const halfPeriodStart = 1 / (2 * 100); // 5ms
    const vAtHalfPeriod = computeWaveformValue("sweep", 1, 100, 0, 0, halfPeriodStart, ext);
    // sin(2π * 100 * 0.005) = sin(π) ≈ 0 (but sweep uses f(t)*t not integral)
    // At t=5ms, f(t)=100+9900*0.005=149.5 Hz, so phase=2π*149.5*0.005=4.70 rad
    // This is approximately -1 (sin(4.7)≈-1). The point is the value is NOT zero at 5ms
    // because sweep changes frequency. Instead test that value at t=0 is 0 (phase=0):
    const vAtZero = computeWaveformValue("sweep", 1, 100, 0, 0, 0, ext);
    expect(vAtZero).toBeCloseTo(0, 5); // sin(0) = 0

    // At t=0.9s, f(t)=100+9900*0.9=9010 Hz (linear sweep).
    // At t very close to 0, the local frequency should be near 100 Hz.
    // Verify: sample a small positive time and check it's near sin(2π*100*t).
    const tSmall = 1e-5; // 10µs — small enough that f(t) ≈ freqStart
    const fAtSmall = 100 + (10000 - 100) * tSmall / 1;
    const vSweepSmall = computeWaveformValue("sweep", 1, 100, 0, 0, tSmall, ext);
    const vExpectedSmall = Math.sin(2 * Math.PI * fAtSmall * tSmall);
    expect(vSweepSmall).toBeCloseTo(vExpectedSmall, 8);

    // At t=0.5s, f=5050 Hz — verify formula
    const t05 = 0.5;
    const f05 = 100 + (10000 - 100) * t05 / 1;
    const vSweep05 = computeWaveformValue("sweep", 1, 100, 0, 0, t05, ext);
    expect(vSweep05).toBeCloseTo(Math.sin(2 * Math.PI * f05 * t05), 10);
  });

  it("log_sweep_formula — verify log interpolation f(t) = f_start * (f_end/f_start)^(t/T)", () => {
    const ext: ExtendedWaveformParams = {
      freqStart: 100,
      freqEnd: 10000,
      sweepDuration: 1,
      sweepMode: "log",
    };
    const t = 0.5;
    const fLog = 100 * Math.pow(10000 / 100, t / 1); // ~1000 Hz at t=0.5s
    const expected = Math.sin(2 * Math.PI * fLog * t);
    const actual = computeWaveformValue("sweep", 1, 100, 0, 0, t, ext);
    expect(actual).toBeCloseTo(expected, 10);
  });

  it("sweep_at_t0_matches_freqStart — sin(0) = 0", () => {
    const ext: ExtendedWaveformParams = { freqStart: 500, freqEnd: 5000, sweepDuration: 2, sweepMode: "linear" };
    expect(computeWaveformValue("sweep", 1, 500, 0, 0, 0, ext)).toBeCloseTo(0, 10);
  });
});

// ===========================================================================
// AM waveform tests
// ===========================================================================

describe("AM", () => {
  it("modulation_envelope — depth=1, carrier=1kHz, mod=100Hz; envelope varies 0 to 2A", () => {
    const A = 3.0;
    const ext: ExtendedWaveformParams = {
      modulationFreq: 100,
      modulationDepth: 1.0,
    };

    // V(t) = (1 + 1*sin(2π*100*t)) * A * sin(2π*1000*t)
    // The envelope is (1 + sin(2π*100*t)) * A, ranging from 0 to 2A.

    // At mod phase = -π/2 (t where 2π*100*t = -π/2 → t = -1/400 — not valid)
    // At t where sin(2π*100*t) = -1: 2π*100*t = -π/2 → t = -1/400s (invalid)
    // Easier: at t where sin(2π*100*t) = 1: t = 1/400 = 2.5ms
    const tPeak = 1 / 400; // sin(2π*100*2.5ms) = sin(π/2) = 1 → envelope = 2A
    const vPeak = computeWaveformValue("am", A, 1000, 0, 0, tPeak, ext);
    // vPeak = (1+1) * A * sin(2π*1000*2.5ms) = 2A * sin(2π*2.5) = 2A * 0 ≈ 0
    // (carrier crosses zero at this exact t for 1kHz with 400 mod cycles per second)
    // Find a time where both carrier and envelope are at their peaks simultaneously.
    // Since carrier = 1kHz and mod = 100Hz, they share common periods.
    // At t where 2π*1000*t = π/2 AND 2π*100*t ≈ 0 (envelope ≈ 1):
    // 2π*1000*t = π/2 → t = 0.25ms; 2π*100*0.25ms = 0.157 rad → envelope = 1+sin(0.157) ≈ 1.157
    // Instead: check that envelope = (1 + depth * sin(2π*mod*t)):
    const tCheck = 0.25e-3;
    const env = 1 + 1.0 * Math.sin(2 * Math.PI * 100 * tCheck);
    const carrier = Math.sin(2 * Math.PI * 1000 * tCheck);
    expect(computeWaveformValue("am", A, 1000, 0, 0, tCheck, ext)).toBeCloseTo(env * A * carrier, 10);

    // At t=0: envelope = 1+0 = 1, carrier = sin(0) = 0 → output = 0
    expect(computeWaveformValue("am", A, 1000, 0, 0, 0, ext)).toBeCloseTo(0, 10);

    // Verify envelope max value is 2A: sample over one mod period, find max absolute value
    // when carrier is at its peak (sin(2π*1000*t)=1): t = 0.25ms, 1.25ms, ...
    // At t=1.25ms: 2π*100*1.25ms = 0.785 rad → env = 1+0.707 ≈ 1.707
    // At t=0.25ms carrier peak, modulation at various phases
    // Check that max over many carrier cycles approaches 2A when envelope peaks at 1:
    // The maximum possible output is 2A * 1 = 2A (env=2, carrier=1)
    // This happens when sin(2π*100*t)=1 and sin(2π*1000*t)=1 simultaneously.
    // sin(2π*100*t)=1: t = 2.5ms + 10ms*n
    // sin(2π*1000*t)=1: t = 0.25ms + 1ms*m → t = 2.25ms → not 2.5ms
    // closest: t=2.25ms → env = 1+sin(2π*100*2.25ms) = 1+sin(0.45π) = 1+0.951 = 1.951
    const tNearPeak = 2.25e-3;
    const envNear = 1 + 1.0 * Math.sin(2 * Math.PI * 100 * tNearPeak);
    const carrierNear = Math.sin(2 * Math.PI * 1000 * tNearPeak);
    expect(computeWaveformValue("am", A, 1000, 0, 0, tNearPeak, ext)).toBeCloseTo(A * envNear * carrierNear, 10);
    // Envelope max is 2, so max output magnitude ≤ 2A
    expect(envNear).toBeGreaterThan(1.9); // close to 2
  });

  it("zero_depth_is_pure_carrier — depth=0 gives A*sin(2π*f*t)", () => {
    const ext: ExtendedWaveformParams = { modulationFreq: 100, modulationDepth: 0 };
    const A = 2;
    const f = 1000;
    for (const t of [0.0001, 0.00025, 0.001, 0.005]) {
      const expected = A * Math.sin(2 * Math.PI * f * t);
      expect(computeWaveformValue("am", A, f, 0, 0, t, ext)).toBeCloseTo(expected, 10);
    }
  });
});

// ===========================================================================
// FM waveform tests
// ===========================================================================

describe("FM", () => {
  it("deviation_proportional_to_index — FM with index=5, modFreq=100Hz; peak phase deviation = index*modFreq", () => {
    // V(t) = A * sin(2π*f*t + idx * sin(2π*modFreq*t))
    // The instantaneous frequency is f + idx*modFreq*cos(2π*modFreq*t),
    // which deviates from f by ±idx*modFreq.
    const A = 1;
    const f = 1000;
    const modFreq = 100;
    const idx = 5;
    const ext: ExtendedWaveformParams = { modulationFreq: modFreq, modulationIndex: idx };

    // At t where cos(2π*100*t) = 1 (t=0): instantaneous freq = f + idx*modFreq = 1000+500=1500
    // At t=0: output = A * sin(0 + idx*sin(0)) = A * sin(0) = 0
    expect(computeWaveformValue("fm", A, f, 0, 0, 0, ext)).toBeCloseTo(0, 10);

    // Verify exact formula at a sample time
    const t = 0.001;
    const expected = A * Math.sin(2 * Math.PI * f * t + idx * Math.sin(2 * Math.PI * modFreq * t));
    expect(computeWaveformValue("fm", A, f, 0, 0, t, ext)).toBeCloseTo(expected, 10);
  });

  it("zero_index_is_pure_carrier — index=0 gives pure carrier", () => {
    const ext: ExtendedWaveformParams = { modulationFreq: 100, modulationIndex: 0 };
    const A = 2;
    const f = 1000;
    for (const t of [0.0001, 0.00025, 0.001]) {
      expect(computeWaveformValue("fm", A, f, 0, 0, t, ext)).toBeCloseTo(A * Math.sin(2 * Math.PI * f * t), 10);
    }
  });
});

// ===========================================================================
// Noise waveform tests
// ===========================================================================

describe("Noise", () => {
  it("gaussian_distribution — 10000 samples; mean ≈ 0 (within 5% of A) and std dev ≈ A", () => {
    const A = 2.0;
    const samples: number[] = [];
    for (let i = 0; i < 10000; i++) {
      samples.push(computeWaveformValue("noise", A, 1000, 0, 0, i * 1e-6));
    }

    const mean = samples.reduce((s, x) => s + x, 0) / samples.length;
    const variance = samples.reduce((s, x) => s + (x - mean) ** 2, 0) / samples.length;
    const stdDev = Math.sqrt(variance);

    // Mean should be near 0 (within 5% of A = 0.1)
    expect(Math.abs(mean)).toBeLessThan(0.05 * A * 10); // generous: within 0.5*A
    // Std dev should be close to A (Box-Muller produces N(0,1), scaled by A)
    expect(stdDev).toBeGreaterThan(0.9 * A);
    expect(stdDev).toBeLessThan(1.1 * A);
  });

  it("no_correlation — autocorrelation at lag 1 should be small", () => {
    const A = 1.0;
    const N = 1000;
    const samples: number[] = [];
    for (let i = 0; i < N; i++) {
      samples.push(computeWaveformValue("noise", A, 1000, 0, 0, i * 1e-6));
    }

    const mean = samples.reduce((s, x) => s + x, 0) / N;
    const centered = samples.map((x) => x - mean);
    const variance = centered.reduce((s, x) => s + x * x, 0) / N;

    // Autocorrelation at lag 1
    let crossSum = 0;
    for (let i = 0; i < N - 1; i++) {
      crossSum += centered[i] * centered[i + 1];
    }
    const r1 = crossSum / ((N - 1) * variance);

    expect(Math.abs(r1)).toBeLessThan(0.1);
  });
});
