/**
 * AC analysis tests.
 *
 * Tier 1 (`buildFixture` from a `.dts` fixture): every circuit is the real
 * production topology authored via the circuit MCP tools and read from disk-
 * the same `.dts` source-of-truth a T3 ngspice-paired run would consume. The
 * sweep runs through `coordinator.acAnalysis(...)`, the engine path the app
 * and MCP use; the AC stimulus comes from each AcVoltageSource's `stampAc`
 * (default acMagnitude 1, acPhase 0). Transfer functions are checked against
 * their closed-form magnitude/phase, the T1 analogue of a category-2
 * analytical DC operating point.
 *
 * `buildFrequencyArray` is an exported pure function (sweep point generation)
 * and is unit-tested directly- it constructs no engine state.
 */

import { describe, it, expect } from "vitest";
import * as path from "path";
import { buildFixture } from "./fixtures/build-fixture.js";
import { buildFrequencyArray } from "../ac-analysis.js";

const FIXTURES = "src/solver/analog/__tests__/ngspice-parity/fixtures";
// RC lowpass: V1(ac 1) -> R1=1k -> OUT -> C1=1uF -> GND. Junction = R1:neg.
const DTS_RC_LOWPASS = path.resolve(FIXTURES, "rc-lowpass-ac.dts");
// Series RLC: V1(ac 1) -> L1=1mH -> C1=1uF -> R1=100 -> GND. Output = R1:pos.
const DTS_RLC_BANDPASS = path.resolve(FIXTURES, "rlc-bandpass-ac.dts");
// Divider lowpass: V1(ac 1) -> R1=9k -> OUT -> {R2=1k, C1=1uF} -> GND. Out = R1:neg.
const DTS_DIVIDER_LOWPASS = path.resolve(FIXTURES, "divider-lowpass-ac.dts");

function findClosestIndex(arr: Float64Array, target: number): number {
  let bestIdx = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < arr.length; i++) {
    const d = Math.abs(arr[i] - target);
    if (d < bestDiff) { bestDiff = d; bestIdx = i; }
  }
  return bestIdx;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AC analysis- RC lowpass", () => {
  const R = 1000;
  const C = 1e-6;
  const fC = 1 / (2 * Math.PI * R * C); // ≈ 159.15 Hz

  it("minus_3db_at_corner_frequency", () => {
    const fix = buildFixture({ dtsPath: DTS_RC_LOWPASS });
    const result = fix.coordinator.acAnalysis({
      type: "dec", numPoints: 50, fStart: 1, fStop: 100000, outputNodes: ["R1:neg"],
    })!;
    expect(result).not.toBeNull();

    const freqs = result.frequencies;
    const mag = result.magnitude.get("R1:neg")!;
    let minDiff = Infinity;
    let actualF3db = 0;
    for (let i = 0; i < freqs.length; i++) {
      const diff = Math.abs(mag[i] - (-3.01));
      if (diff < minDiff) { minDiff = diff; actualF3db = freqs[i]; }
    }
    expect(actualF3db).toBeGreaterThan(fC * 0.95);
    expect(actualF3db).toBeLessThan(fC * 1.05);
  });

  it("rolls_off_at_minus_20db_per_decade_above_corner", () => {
    const fix = buildFixture({ dtsPath: DTS_RC_LOWPASS });
    const result = fix.coordinator.acAnalysis({
      type: "dec", numPoints: 20, fStart: 1, fStop: 100000, outputNodes: ["R1:neg"],
    })!;
    const freqs = result.frequencies;
    const mag = result.magnitude.get("R1:neg")!;
    const idx1 = findClosestIndex(freqs, fC * 10);
    const idx2 = findClosestIndex(freqs, fC * 100);
    const slope = (mag[idx2] - mag[idx1]) / Math.log10(freqs[idx2] / freqs[idx1]);
    expect(slope).toBeGreaterThan(-22);
    expect(slope).toBeLessThan(-18);
  });

  it("phase_is_minus_45_degrees_at_corner", () => {
    const fix = buildFixture({ dtsPath: DTS_RC_LOWPASS });
    const result = fix.coordinator.acAnalysis({
      type: "dec", numPoints: 50, fStart: 1, fStop: 100000, outputNodes: ["R1:neg"],
    })!;
    const idx = findClosestIndex(result.frequencies, fC);
    const phaseAtFc = result.phase.get("R1:neg")![idx];
    expect(phaseAtFc).toBeGreaterThan(-50);
    expect(phaseAtFc).toBeLessThan(-40);
  });
});

describe("AC analysis- series RLC bandpass", () => {
  it("peaks_at_resonant_frequency", () => {
    // L1=1mH, C1=1uF in the fixture; R1 sets bandwidth, not centre frequency.
    const L = 1e-3;
    const C = 1e-6;
    const f0 = 1 / (2 * Math.PI * Math.sqrt(L * C)); // ≈ 5033 Hz

    const fix = buildFixture({ dtsPath: DTS_RLC_BANDPASS });
    const result = fix.coordinator.acAnalysis({
      type: "dec", numPoints: 50, fStart: 100, fStop: 200000, outputNodes: ["R1:pos"],
    })!;
    const freqs = result.frequencies;
    const mag = result.magnitude.get("R1:pos")!;

    let peakIdx = 0;
    let peakMag = -Infinity;
    for (let i = 0; i < freqs.length; i++) {
      if (mag[i] > peakMag) { peakMag = mag[i]; peakIdx = i; }
    }
    const peakFreq = freqs[peakIdx];
    expect(peakFreq).toBeGreaterThan(f0 * 0.90);
    expect(peakFreq).toBeLessThan(f0 * 1.10);
  });
});

describe("AC analysis- single-pole divider", () => {
  it("dc_gain_and_pole_match_closed_form", () => {
    const R1 = 9000;
    const R2 = 1000;
    const C = 1e-6;
    const gainDc = R2 / (R1 + R2);
    const rParallel = (R1 * R2) / (R1 + R2);
    const fPole = 1 / (2 * Math.PI * C * rParallel);

    const fix = buildFixture({ dtsPath: DTS_DIVIDER_LOWPASS });
    const result = fix.coordinator.acAnalysis({
      type: "dec", numPoints: 30, fStart: 1, fStop: 1e6, outputNodes: ["R1:neg"],
    })!;
    const freqs = result.frequencies;
    const mag = result.magnitude.get("R1:neg")!;
    const expectedDcGainDb = 20 * Math.log10(gainDc); // ≈ -20 dB

    const lowFreqIdx = findClosestIndex(freqs, 1);
    expect(mag[lowFreqIdx]).toBeGreaterThan(expectedDcGainDb - 1);
    expect(mag[lowFreqIdx]).toBeLessThan(expectedDcGainDb + 1);

    const highFreqIdx = findClosestIndex(freqs, fPole * 10);
    expect(mag[highFreqIdx]).toBeLessThan(expectedDcGainDb - 17);

    const poleIdx = findClosestIndex(freqs, fPole);
    const expected3dbGain = expectedDcGainDb - 3.01;
    expect(mag[poleIdx]).toBeGreaterThan(expected3dbGain - 2);
    expect(mag[poleIdx]).toBeLessThan(expected3dbGain + 2);
  });
});

describe("buildFrequencyArray- sweep point generation", () => {
  it("decade_sweep_emits_num_steps_plus_one_points", () => {
    const result = buildFrequencyArray({
      type: "dec", numPoints: 10, fStart: 1, fStop: 1e6, outputNodes: [],
    });
    // num_steps = floor(log10(1e6/1) * 10) = 60; the sweep emits num_steps + 1
    // = 61 frequencies, last point at fStop (modulo float rounding).
    expect(result.length).toBe(61);
    expect(result[0]).toBeCloseTo(1, 10);
    expect(result[result.length - 1]).toBeCloseTo(1e6, 5);
    const ratio0 = result[1] / result[0];
    const ratio1 = result[2] / result[1];
    expect(ratio0).toBeCloseTo(ratio1, 10);
    expect(ratio0).toBeCloseTo(Math.pow(10, 1 / 10), 10);
  });

  it("linear_sweep_is_endpoint_inclusive", () => {
    const result = buildFrequencyArray({
      type: "lin", numPoints: 100, fStart: 0, fStop: 1000, outputNodes: [],
    });
    expect(result.length).toBe(100);
    expect(result[0]).toBeCloseTo(0, 10);
    expect(result[result.length - 1]).toBeCloseTo(1000, 10);
    const step0 = result[1] - result[0];
    const step1 = result[2] - result[1];
    expect(step0).toBeCloseTo(step1, 10);
    expect(step0).toBeCloseTo((1000 - 0) / (result.length - 1), 10);
  });
});
