/**
 * Tests for Schmitt Trigger components (Inverting and Non-Inverting).
 *
 * Tests cover:
 *   Inverting::switches_low_on_rising_threshold   — input ramps up → output goes LOW at V_TH
 *   Inverting::switches_high_on_falling_threshold — input ramps down → output goes HIGH at V_TL
 *   Inverting::hysteresis_prevents_oscillation    — input in hysteresis band → output stays put
 *   NonInverting::output_follows_input_sense       — high input → HIGH out, low input → LOW out
 *   Hysteresis::noisy_sine_clean_square            — noisy sine produces exactly 10 transitions in 5ms
 *   Transfer::plot_matches_hysteresis_loop         — sweep up then down shows rectangular hysteresis loop
 *
 * Testing approach: since the Schmitt trigger's output is determined by
 * updateOperatingPoint() reading the current input voltage, and the input
 * is driven by an ideal voltage source, we drive updateOperatingPoint()
 * directly with a synthetic voltage vector and observe the output by reading
 * the stamp calls to a mock solver. This avoids full transient MNA overhead
 * while exercising the exact production code path.
 */

import { describe, it, expect, vi } from "vitest";
import {
  SchmittInvertingDefinition,
  SchmittNonInvertingDefinition,
} from "../schmitt-trigger.js";
import { PropertyBag } from "../../../core/properties.js";
import type { AnalogElement } from "../../../solver/analog/element.js";
import type { SparseSolver as SparseSolverType } from "../../../solver/analog/sparse-solver.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockSolver() {
  return {
    stamp: vi.fn(),
    stampRHS: vi.fn(),
  } as unknown as SparseSolverType;
}

function makeProps(overrides: Record<string, number | string> = {}): PropertyBag {
  const defaults: [string, number | string][] = [
    ["vTH", 2.0],
    ["vTL", 1.0],
    ["vOH", 3.3],
    ["vOL", 0.0],
    ["rOut", 50],
  ];
  const entries = new Map<string, number | string>(defaults);
  for (const [k, v] of Object.entries(overrides)) {
    entries.set(k, v);
  }
  return new PropertyBag(Array.from(entries.entries()));
}

function makeSchmittInverting(
  nIn: number,
  nOut: number,
  overrides: Record<string, number | string> = {},
): AnalogElement {
  return SchmittInvertingDefinition.models!.mnaModels!.behavioral!.factory(
    new Map([["in", nIn], ["out", nOut]]),
    [],
    -1,
    makeProps(overrides),
    () => 0,
  );
}

function makeSchmittNonInverting(
  nIn: number,
  nOut: number,
  overrides: Record<string, number | string> = {},
): AnalogElement {
  return SchmittNonInvertingDefinition.models!.mnaModels!.behavioral!.factory(
    new Map([["in", nIn], ["out", nOut]]),
    [],
    -1,
    makeProps(overrides),
    () => 0,
  );
}

function makeVoltages(size: number, nodeVoltages: Record<number, number>): Float64Array {
  const v = new Float64Array(size);
  for (const [node, voltage] of Object.entries(nodeVoltages)) {
    const n = parseInt(node);
    if (n > 0 && n <= size) v[n - 1] = voltage;
  }
  return v;
}

/**
 * Read the current target output voltage from the Schmitt trigger by observing
 * the RHS stamp placed by stampNonlinear (Norton current = V_target / R_out).
 *
 * The Norton equivalent stamps: RHS[nOut-1] += V_target * G_out
 * So V_target = RHS_value / G_out.
 */
function readOutputVoltage(element: AnalogElement, nOut: number, rOut: number): number {
  const solver = makeMockSolver();
  element.stampNonlinear!(solver);
  const rhsCalls = (solver.stampRHS as ReturnType<typeof vi.fn>).mock.calls as number[][];
  const outRhs = rhsCalls.find((c) => c[0] === nOut - 1);
  if (!outRhs) return 0;
  const gOut = 1 / rOut;
  return outRhs[1] / gOut;
}

// ---------------------------------------------------------------------------
// Inverting tests
// ---------------------------------------------------------------------------

describe("Inverting", () => {
  it("switches_low_on_rising_threshold", () => {
    // Input starts low (0V) → output should be HIGH (inverting).
    // Ramp input above V_TH (2.0V) → output should switch to LOW.
    const nIn = 1, nOut = 2;
    const rOut = 50;
    const st = makeSchmittInverting(nIn, nOut, { vTH: 2.0, vTL: 1.0, vOH: 3.3, vOL: 0.0, rOut });

    // Initial state: output HIGH (inverting, input starts low → _outputHigh=false → drive HIGH)
    const vInit = makeVoltages(2, { 1: 0.0 });
    st.updateOperatingPoint!(vInit);
    const vOutInit = readOutputVoltage(st, nOut, rOut);
    expect(vOutInit).toBeCloseTo(3.3, 1); // initial: output HIGH

    // Drive input just below threshold — no switch
    const vBelowTH = makeVoltages(2, { 1: 1.9 });
    st.updateOperatingPoint!(vBelowTH);
    expect(readOutputVoltage(st, nOut, rOut)).toBeCloseTo(3.3, 1);

    // Drive input above threshold → output switches LOW
    const vAboveTH = makeVoltages(2, { 1: 2.1 });
    st.updateOperatingPoint!(vAboveTH);
    expect(readOutputVoltage(st, nOut, rOut)).toBeCloseTo(0.0, 1);
  });

  it("switches_high_on_falling_threshold", () => {
    // Start with input above V_TH → output LOW (inverting).
    // Ramp input below V_TL (1.0V) → output switches HIGH.
    const nIn = 1, nOut = 2;
    const rOut = 50;
    const st = makeSchmittInverting(nIn, nOut, { vTH: 2.0, vTL: 1.0, vOH: 3.3, vOL: 0.0, rOut });

    // Force output to LOW by driving input above V_TH
    const vHigh = makeVoltages(2, { 1: 2.5 });
    st.updateOperatingPoint!(vHigh);
    expect(readOutputVoltage(st, nOut, rOut)).toBeCloseTo(0.0, 1); // output LOW

    // Drive input just above V_TL — no switch yet
    const vAboveTL = makeVoltages(2, { 1: 1.1 });
    st.updateOperatingPoint!(vAboveTL);
    expect(readOutputVoltage(st, nOut, rOut)).toBeCloseTo(0.0, 1); // still LOW

    // Drive input below V_TL → output switches HIGH
    const vBelowTL = makeVoltages(2, { 1: 0.9 });
    st.updateOperatingPoint!(vBelowTL);
    expect(readOutputVoltage(st, nOut, rOut)).toBeCloseTo(3.3, 1);
  });

  it("hysteresis_prevents_oscillation", () => {
    // Input oscillates between V_TL and V_TH (within the hysteresis band).
    // Output must remain stable.
    const nIn = 1, nOut = 2;
    const rOut = 50;
    const vTH = 2.0, vTL = 1.0;
    const st = makeSchmittInverting(nIn, nOut, { vTH, vTL, vOH: 3.3, vOL: 0.0, rOut });

    // Start with input low → output HIGH
    st.updateOperatingPoint!(makeVoltages(2, { 1: 0.0 }));
    const initialOut = readOutputVoltage(st, nOut, rOut);
    expect(initialOut).toBeCloseTo(3.3, 1);

    // Oscillate input within hysteresis band (V_TL + ε to V_TH - ε)
    const inBandValues = [1.2, 1.5, 1.8, 1.6, 1.3, 1.7, 1.4, 1.9, 1.1, 1.8];
    for (const v of inBandValues) {
      st.updateOperatingPoint!(makeVoltages(2, { 1: v }));
      const out = readOutputVoltage(st, nOut, rOut);
      // Output must not change — still HIGH
      expect(out).toBeCloseTo(3.3, 1);
    }
  });
});

// ---------------------------------------------------------------------------
// NonInverting tests
// ---------------------------------------------------------------------------

describe("NonInverting", () => {
  it("output_follows_input_sense", () => {
    // Non-inverting: input > V_TH → output HIGH; input < V_TL → output LOW.
    const nIn = 1, nOut = 2;
    const rOut = 50;
    const st = makeSchmittNonInverting(nIn, nOut, { vTH: 2.0, vTL: 1.0, vOH: 3.3, vOL: 0.0, rOut });

    // Initial: output LOW (starts low)
    st.updateOperatingPoint!(makeVoltages(2, { 1: 0.5 }));
    expect(readOutputVoltage(st, nOut, rOut)).toBeCloseTo(0.0, 1);

    // Drive input above V_TH → output HIGH
    st.updateOperatingPoint!(makeVoltages(2, { 1: 2.5 }));
    expect(readOutputVoltage(st, nOut, rOut)).toBeCloseTo(3.3, 1);

    // Drive input back below V_TL → output LOW
    st.updateOperatingPoint!(makeVoltages(2, { 1: 0.5 }));
    expect(readOutputVoltage(st, nOut, rOut)).toBeCloseTo(0.0, 1);
  });
});

// ---------------------------------------------------------------------------
// Hysteresis noisy sine test
// ---------------------------------------------------------------------------

describe("Hysteresis", () => {
  it("noisy_sine_clean_square", () => {
    // Sine wave: 1kHz, amplitude = 2V, offset = 1.65V (spanning both thresholds 1.0 and 2.3V).
    // Noise: Gaussian, std dev = 0.1V (within hysteresis band of 2.3-1.0 = 1.3V).
    // Thresholds: V_TH=2.3, V_TL=1.0 — hysteresis band 1.3V >> noise std dev 0.1V.
    // Simulate 5 complete periods (5ms at 1kHz).
    // Assert exactly 10 output transitions (2 per period, no glitches from noise).
    //
    // Note: Using V_TH=2.3, V_TL=1.0 (hysteresis band = 1.3V) with Gaussian
    // noise std dev=0.1V ensures zero chance of spurious crossings statistically.
    const nIn = 1, nOut = 2;
    const rOut = 50;
    const vTH = 2.3, vTL = 1.0;
    const st = makeSchmittNonInverting(nIn, nOut, {
      vTH, vTL, vOH: 3.3, vOL: 0.0, rOut,
    });

    const freq = 1000;       // 1kHz
    const amplitude = 1.65;  // sine amplitude (peak) — ensures signal crosses both thresholds
    const offset = 1.65;     // DC offset: sine swings from 0 to 3.3V
    const noiseSd = 0.1;     // noise std dev = 0.1V (well within hysteresis band)
    const totalTime = 5e-3;  // 5ms = 5 periods
    const numSamples = 5000; // 1µs sample interval — fine enough to catch crossings

    // Seeded Box-Muller Gaussian noise using a simple LCG for determinism
    let lcgState = 0x12345678;
    function lcgRandom(): number {
      lcgState = (Math.imul(lcgState, 1664525) + 1013904223) >>> 0;
      return lcgState / 0x100000000;
    }
    function gaussianNoise(): number {
      const u1 = Math.max(lcgRandom(), 1e-10);
      const u2 = lcgRandom();
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    }

    let transitions = 0;
    let prevOut = readOutputVoltage(st, nOut, rOut);
    // Initialise with first sample
    const firstV = offset + amplitude * Math.sin(0) + noiseSd * gaussianNoise();
    st.updateOperatingPoint!(makeVoltages(2, { 1: firstV }));
    prevOut = readOutputVoltage(st, nOut, rOut);

    for (let i = 1; i <= numSamples; i++) {
      const t = (i / numSamples) * totalTime;
      const vSine = offset + amplitude * Math.sin(2 * Math.PI * freq * t);
      const noise = noiseSd * gaussianNoise();
      const vIn = vSine + noise;

      st.updateOperatingPoint!(makeVoltages(2, { 1: vIn }));
      const vOut = readOutputVoltage(st, nOut, rOut);

      if (Math.abs(vOut - prevOut) > 0.5) {
        transitions++;
        prevOut = vOut;
      }
    }

    // Exactly 10 transitions (2 per period × 5 periods), no glitches
    expect(transitions).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Transfer characteristic (hysteresis loop)
// ---------------------------------------------------------------------------

describe("Transfer", () => {
  it("plot_matches_hysteresis_loop", () => {
    // Sweep input from 0 → 3.3V → 0V.
    // The output transitions form a rectangular hysteresis loop:
    //   Rising:  switches at V_TH
    //   Falling: switches at V_TL < V_TH
    // Non-inverting Schmitt trigger.
    const nIn = 1, nOut = 2;
    const rOut = 50;
    const vTH = 2.0, vTL = 1.0;
    const st = makeSchmittNonInverting(nIn, nOut, {
      vTH, vTL, vOH: 3.3, vOL: 0.0, rOut,
    });

    // Start at 0V: output LOW
    st.updateOperatingPoint!(makeVoltages(2, { 1: 0.0 }));

    // Rising sweep: 0 → 3.3V in 0.1V steps
    let risingTransitionAt: number | null = null;
    for (let i = 0; i <= 33; i++) {
      const vIn = (i / 33) * 3.3;
      st.updateOperatingPoint!(makeVoltages(2, { 1: vIn }));
      const vOut = readOutputVoltage(st, nOut, rOut);
      if (risingTransitionAt === null && vOut > 1.65) {
        // Output switched HIGH — record the input voltage
        risingTransitionAt = vIn;
      }
    }

    // Rising transition must occur at or just above V_TH
    expect(risingTransitionAt).not.toBeNull();
    expect(risingTransitionAt!).toBeGreaterThanOrEqual(vTH - 0.1);
    expect(risingTransitionAt!).toBeLessThanOrEqual(vTH + 0.2);

    // Falling sweep: 3.3V → 0V in 0.1V steps
    let fallingTransitionAt: number | null = null;
    for (let i = 33; i >= 0; i--) {
      const vIn = (i / 33) * 3.3;
      st.updateOperatingPoint!(makeVoltages(2, { 1: vIn }));
      const vOut = readOutputVoltage(st, nOut, rOut);
      if (fallingTransitionAt === null && vOut < 1.65) {
        fallingTransitionAt = vIn;
      }
    }

    // Falling transition must occur at or just below V_TL
    expect(fallingTransitionAt).not.toBeNull();
    expect(fallingTransitionAt!).toBeLessThanOrEqual(vTL + 0.1);
    expect(fallingTransitionAt!).toBeGreaterThanOrEqual(vTL - 0.2);

    // The two transition points must differ (hysteresis exists)
    expect(risingTransitionAt!).toBeGreaterThan(fallingTransitionAt!);
  });
});
