/**
 * Tests for fft.ts — Cooley-Tukey FFT, Hann windowing, and spectrum utilities.
 */

import { describe, it, expect } from "vitest";
import { fft, hannWindow, magnitudeSpectrum, magnitudeToDb, nextPow2, floorPow2 } from "../fft.js";

describe("FFT", () => {
  // -------------------------------------------------------------------------
  // Utility tests
  // -------------------------------------------------------------------------

  it("next_pow2", () => {
    expect(nextPow2(1000)).toBe(1024);
    expect(nextPow2(1024)).toBe(1024);
    expect(nextPow2(1)).toBe(1);
    expect(nextPow2(2)).toBe(2);
    expect(nextPow2(3)).toBe(4);
    expect(nextPow2(513)).toBe(1024);
  });

  it("floor_pow2", () => {
    expect(floorPow2(1024)).toBe(1024);
    expect(floorPow2(1000)).toBe(512);
    expect(floorPow2(1)).toBe(1);
    expect(floorPow2(8193)).toBe(8192);
  });

  it("magnitude_to_db", () => {
    // Reference = max = 1.0, so:
    // magnitude[0]=1.0 → 0 dB
    // magnitude[1]=0.1 → -20 dB
    // magnitude[2]=0.01 → -40 dB
    const mag = new Float64Array([1, 0.1, 0.01]);
    const db = magnitudeToDb(mag);

    expect(db[0]).toBeCloseTo(0, 1);
    expect(db[1]).toBeCloseTo(-20, 1);
    expect(db[2]).toBeCloseTo(-40, 1);
  });

  // -------------------------------------------------------------------------
  // FFT correctness tests
  // -------------------------------------------------------------------------

  it("dc_offset_appears_at_bin_zero", () => {
    const N = 1024;
    const re = new Float64Array(N).fill(3.0);
    const im = new Float64Array(N);
    fft(re, im);

    // DC bin magnitude should be N * amplitude = 1024 * 3
    const dcMag = Math.sqrt(re[0] * re[0] + im[0] * im[0]);
    expect(dcMag).toBeCloseTo(N * 3.0, 0);

    // All other bins should be near zero
    for (let k = 1; k < N; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      expect(mag).toBeLessThan(1e-6);
    }
  });

  it("single_sine_peak", () => {
    const N = 1024;
    const sampleRate = 44100;
    // Use bin 23 as an exact bin-centre to eliminate spectral leakage.
    // Frequency = 23 * 44100 / 1024 ≈ 991.5 Hz (close to 1 kHz).
    const binTarget = 23;
    const freq = binTarget * sampleRate / N;

    const re = new Float64Array(N);
    const im = new Float64Array(N);

    for (let n = 0; n < N; n++) {
      re[n] = Math.sin(2 * Math.PI * freq * n / sampleRate);
    }

    fft(re, im);

    const { frequency, magnitude } = magnitudeSpectrum(re, im, sampleRate);
    const db = magnitudeToDb(magnitude);

    // Find peak bin
    let peakBin = 0;
    let peakDb = -Infinity;
    for (let k = 0; k < db.length; k++) {
      if (db[k] > peakDb) {
        peakDb = db[k];
        peakBin = k;
      }
    }

    // Peak should be at bin 23 (≈ 1 kHz)
    expect(peakBin).toBe(binTarget);
    expect(frequency[peakBin]).toBeCloseTo(freq, 0);

    // All other bins should be ≥ 40 dB below peak (exact bin-centre → near-zero leakage)
    for (let k = 0; k < db.length; k++) {
      if (Math.abs(k - peakBin) > 2) {
        expect(db[k]).toBeLessThan(peakDb - 40);
      }
    }
  });

  it("two_sines_two_peaks", () => {
    const N = 1024;
    const sampleRate = 44100;

    // Align both frequencies to exact bin centers to minimize spectral leakage
    // bin k corresponds to frequency k * sampleRate / N
    // bin 23 ≈ 990 Hz, bin 70 ≈ 3013 Hz (approximately 1kHz and 3kHz)
    const binA = 23;
    const binB = 70;
    const freqA = binA * sampleRate / N; // exact bin center
    const freqB = binB * sampleRate / N;
    const ampA = 1.0;
    const ampB = 0.5;

    const re = new Float64Array(N);
    const im = new Float64Array(N);

    for (let n = 0; n < N; n++) {
      re[n] = ampA * Math.sin(2 * Math.PI * freqA * n / sampleRate)
            + ampB * Math.sin(2 * Math.PI * freqB * n / sampleRate);
    }

    fft(re, im);

    const { frequency, magnitude } = magnitudeSpectrum(re, im, sampleRate);

    // Find the two largest peaks
    const peaks: { bin: number; mag: number }[] = [];
    for (let k = 1; k < magnitude.length - 1; k++) {
      if (magnitude[k] > magnitude[k - 1] && magnitude[k] > magnitude[k + 1]) {
        peaks.push({ bin: k, mag: magnitude[k] });
      }
    }
    peaks.sort((a, b) => b.mag - a.mag);

    expect(peaks.length).toBeGreaterThanOrEqual(2);

    const peak1 = peaks[0]!;
    const peak2 = peaks[1]!;

    // Check frequencies are near freqA and freqB (within 2 bins = ~86 Hz)
    const binWidth = sampleRate / N;
    const freq1 = frequency[peak1.bin];
    const freq2 = frequency[peak2.bin];

    const foundA = Math.abs(freq1 - freqA) < binWidth * 2 || Math.abs(freq2 - freqA) < binWidth * 2;
    const foundB = Math.abs(freq1 - freqB) < binWidth * 2 || Math.abs(freq2 - freqB) < binWidth * 2;
    expect(foundA).toBe(true);
    expect(foundB).toBe(true);

    // Relative magnitudes: peak at freqA should be ~2× peak at freqB (3 dB within)
    const db = magnitudeToDb(magnitude);
    const dbDiff = Math.abs(db[peak1.bin] - db[peak2.bin]);
    // 20*log10(1.0/0.5) = 6.02 dB; allow 3 dB tolerance
    expect(dbDiff).toBeCloseTo(6.02, 0);
  });

  it("hann_window_reduces_leakage", () => {
    // Sine at a non-bin-center frequency to induce leakage.
    const N = 1024;
    const sampleRate = 44100;
    // Use a non-integer number of cycles so the frequency doesn't align to a bin
    const freq = 1234; // Hz — not a bin center for N=1024, sr=44100

    const rawSamples = new Float64Array(N);
    for (let n = 0; n < N; n++) {
      rawSamples[n] = Math.sin(2 * Math.PI * freq * n / sampleRate);
    }

    // Unwindowed FFT
    const reRaw = Float64Array.from(rawSamples);
    const imRaw = new Float64Array(N);
    fft(reRaw, imRaw);
    const specRaw = magnitudeSpectrum(reRaw, imRaw, sampleRate);
    const dbRaw = magnitudeToDb(specRaw.magnitude);

    // Windowed FFT
    const windowed = hannWindow(rawSamples);
    const reWin = Float64Array.from(windowed);
    const imWin = new Float64Array(N);
    fft(reWin, imWin);
    const specWin = magnitudeSpectrum(reWin, imWin, sampleRate);
    const dbWin = magnitudeToDb(specWin.magnitude);

    // Find peak bin for each
    const peakBinRaw = maxBin(dbRaw);
    const peakBinWin = maxBin(dbWin);

    // Compute max sidelobe level (max dB more than 5 bins from peak)
    const sidelobeRaw = maxSidelobe(dbRaw, peakBinRaw, 5);
    const sidelobeWin = maxSidelobe(dbWin, peakBinWin, 5);

    // Windowed sidelobes should be ≥ 20 dB below peak (Hann gives ~31 dB)
    expect(sidelobeWin).toBeLessThan(-20);
    // Unwindowed sidelobes are typically only ~13 dB below (sinc rolloff)
    // so the windowed should be at least 7 dB better
    expect(sidelobeWin).toBeLessThan(sidelobeRaw - 7);
  });

  // -------------------------------------------------------------------------
  // magnitudeToDb edge cases
  // -------------------------------------------------------------------------

  it("magnitude_to_db_explicit_reference", () => {
    const mag = new Float64Array([2.0, 1.0, 0.5]);
    const db = magnitudeToDb(mag, 2.0);
    expect(db[0]).toBeCloseTo(0, 1);
    expect(db[1]).toBeCloseTo(-6.02, 0);
    expect(db[2]).toBeCloseTo(-12.04, 0);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function maxBin(db: Float64Array): number {
  let best = 0;
  for (let k = 1; k < db.length; k++) {
    if (db[k] > db[best]) best = k;
  }
  return best;
}

function maxSidelobe(db: Float64Array, peakBin: number, guardBins: number): number {
  let max = -Infinity;
  for (let k = 0; k < db.length; k++) {
    if (Math.abs(k - peakBin) > guardBins && isFinite(db[k])) {
      if (db[k] > max) max = db[k];
    }
  }
  return max;
}
