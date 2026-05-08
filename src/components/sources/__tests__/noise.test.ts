/**
 * Box-Muller noise helper - framework-level statistical audit.
 */

import { describe, it, expect } from "vitest";
import { computeWaveformValue } from "../ac-voltage-source.js";

describe("computeWaveformValue noise (Box-Muller helper)", () => {
  it("gaussian_distribution_mean_near_zero_stddev_near_amplitude", () => {
    const A = 2.0;
    const N = 10000;
    const samples: number[] = [];
    for (let i = 0; i < N; i++) {
      samples.push(computeWaveformValue("noise", A, 1000, 0, 0, i * 1e-6));
    }

    const mean = samples.reduce((s, x) => s + x, 0) / N;
    const variance = samples.reduce((s, x) => s + (x - mean) * (x - mean), 0) / N;
    const stdDev = Math.sqrt(variance);

    // Box-Muller draws standard-normal (mean=0, std=1) samples and the helper
    // scales by amplitude. With N=10000, |mean| should sit well within 0.5*A
    // and stdDev should land in [0.9*A, 1.1*A].
    expect(Math.abs(mean)).toBeLessThan(0.5 * A);
    expect(stdDev).toBeGreaterThan(0.9 * A);
    expect(stdDev).toBeLessThan(1.1 * A);
  });

  it("lag1_autocorrelation_below_threshold", () => {
    const A = 1.0;
    const N = 1000;
    const samples: number[] = [];
    for (let i = 0; i < N; i++) {
      samples.push(computeWaveformValue("noise", A, 1000, 0, 0, i * 1e-6));
    }

    const mean = samples.reduce((s, x) => s + x, 0) / N;
    const centered = samples.map((x) => x - mean);
    const variance = centered.reduce((s, x) => s + x * x, 0) / N;

    let crossSum = 0;
    for (let i = 0; i < N - 1; i++) {
      crossSum += centered[i] * centered[i + 1];
    }
    const r1 = crossSum / ((N - 1) * variance);

    // Independent draws => lag-1 autocorrelation should be near 0. With N=1000
    // the standard error of r1 is ~1/sqrt(N) ~= 0.032; |r1| < 0.1 is a safe
    // headroom that still flags broken Box-Muller cycling (e.g. the failure
    // mode where u1/u2 are reused across calls).
    expect(Math.abs(r1)).toBeLessThan(0.1);
  });
});
