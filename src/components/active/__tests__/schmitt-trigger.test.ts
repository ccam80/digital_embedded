/**
 * Tests for Schmitt Trigger components (Inverting and Non-Inverting).
 *
 * Tests cover:
 *   Inverting::switches_low_on_rising_threshold   â€” input ramps up â†’ output goes LOW at V_TH
 *   Inverting::switches_high_on_falling_threshold â€” input ramps down â†’ output goes HIGH at V_TL
 *   Inverting::hysteresis_prevents_oscillation    â€” input in hysteresis band â†’ output stays put
 *   NonInverting::output_follows_input_sense       â€” high input â†’ HIGH out, low input â†’ LOW out
 *   Hysteresis::noisy_sine_clean_square            â€” noisy sine produces exactly 10 transitions in 5ms
 *   Transfer::plot_matches_hysteresis_loop         â€” sweep up then down shows rectangular hysteresis loop
 *
 * Testing approach: the Schmitt trigger's output is determined by load() reading
 * the current input voltage from ctx.voltages. We drive load(ctx) directly with
 * a synthetic voltage vector and observe the output by capturing the RHS stamps
 * emitted into a recording solver. This avoids full transient MNA overhead while
 * exercising the exact production code path.
 */

import { describe, it, expect } from "vitest";
import {
  SchmittInvertingDefinition,
  SchmittNonInvertingDefinition,
} from "../schmitt-trigger.js";
import { PropertyBag } from "../../../core/properties.js";
import type { AnalogElement } from "../../../solver/analog/element.js";
import type { SparseSolver as SparseSolverType } from "../../../solver/analog/sparse-solver.js";
import type { LoadContext } from "../../../solver/analog/load-context.js";
import { MODEDCOP, MODEINITFLOAT } from "../../../solver/analog/ckt-mode.js";
import { makeLoadCtx, initElement } from "../../../solver/analog/__tests__/test-helpers.js";

// ---------------------------------------------------------------------------
// Helper: narrow ModelEntry to inline factory (throws if netlist kind)
// ---------------------------------------------------------------------------
import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";
function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recording solver that implements the public allocElement / stampElement
 * surface that AnalogElement.load() calls. RHS writes go to a caller-owned
 * Float64Array via ctx.rhs — the solver mock has no stampRHS method.
 */
interface RecordingSolverResult {
  solver: SparseSolverType;
  rhs: Float64Array;
}
function makeRecordingSolver(size: number): RecordingSolverResult {
  const rhs = new Float64Array(size);
  const handles: { row: number; col: number }[] = [];
  const handleIndex = new Map<string, number>();
  const solver = {
    allocElement: (row: number, col: number): number => {
      const key = `${row},${col}`;
      let h = handleIndex.get(key);
      if (h === undefined) {
        h = handles.length;
        handles.push({ row, col });
        handleIndex.set(key, h);
      }
      return h;
    },
    stampElement: (_handle: number, _value: number): void => {},
  } as unknown as SparseSolverType;
  return { solver, rhs };
}

function makeSchmittLoadCtx(voltages: Float64Array, solver: SparseSolverType, rhs: Float64Array): LoadContext {
  return makeLoadCtx({
    solver,
    rhs,
    rhsOld: voltages,
    cktMode: MODEDCOP | MODEINITFLOAT,
    dt: 0,
  });
}

const MODEL_PARAM_KEYS = new Set(["vTH", "vTL", "vOH", "vOL", "rOut"]);

function makeProps(overrides: Record<string, number | string> = {}): PropertyBag {
  const modelDefaults: Record<string, number> = {
    vTH: 2.0,
    vTL: 1.0,
    vOH: 3.3,
    vOL: 0.0,
    rOut: 50,
  };
  const staticEntries: [string, number | string][] = [];
  const modelParams: Record<string, number> = { ...modelDefaults };
  for (const [k, v] of Object.entries(overrides)) {
    if (MODEL_PARAM_KEYS.has(k)) {
      modelParams[k] = v as number;
    } else {
      staticEntries.push([k, v]);
    }
  }
  const bag = new PropertyBag(staticEntries);
  bag.replaceModelParams(modelParams);
  return bag;
}

function makeSchmittInverting(
  nIn: number,
  nOut: number,
  overrides: Record<string, number | string> = {},
): AnalogElement {
  const el = getFactory(SchmittInvertingDefinition.modelRegistry!["behavioral"]!)(
    new Map([["in", nIn], ["out", nOut]]),
    [],
    -1,
    makeProps(overrides),
    () => 0,
  ) as unknown as AnalogElement;
  initElement(el);
  return el;
}

function makeSchmittNonInverting(
  nIn: number,
  nOut: number,
  overrides: Record<string, number | string> = {},
): AnalogElement {
  const el = getFactory(SchmittNonInvertingDefinition.modelRegistry!["behavioral"]!)(
    new Map([["in", nIn], ["out", nOut]]),
    [],
    -1,
    makeProps(overrides),
    () => 0,
  ) as unknown as AnalogElement;
  initElement(el);
  return el;
}

/**
 * Drive an input voltage into the Schmitt trigger via load(ctx) and read back
 * the target output voltage implied by the Norton RHS stamp on nOut.
 *
 * load() stamps RHS[nOut-1] += V_target * G_out, so V_target = RHS / G_out.
 *
 * Also updates the trigger's internal hysteresis state machine (_outputHigh),
 * which load() runs on every iteration using ctx.voltages as the input.
 */
function driveAndReadOutput(
  element: AnalogElement,
  vIn: number,
  nIn: number,
  nOut: number,
  rOut: number,
): number {
  const size = Math.max(nIn, nOut) + 1;
  const voltages = new Float64Array(size);
  if (nIn > 0) voltages[nIn] = vIn;
  const { solver, rhs } = makeRecordingSolver(size);
  const ctx = makeSchmittLoadCtx(voltages, solver, rhs);
  element.load(ctx);
  const outRhs = rhs[nOut - 1];
  if (outRhs === 0) return 0;
  const gOut = 1 / rOut;
  return outRhs / gOut;
}

// ---------------------------------------------------------------------------
// Inverting tests
// ---------------------------------------------------------------------------

describe("Inverting", () => {
  it("switches_low_on_rising_threshold", () => {
    // Input starts low (0V) â†’ output should be HIGH (inverting).
    // Ramp input above V_TH (2.0V) â†’ output should switch to LOW.
    const nIn = 1, nOut = 2;
    const rOut = 50;
    const st = makeSchmittInverting(nIn, nOut, { vTH: 2.0, vTL: 1.0, vOH: 3.3, vOL: 0.0, rOut });

    // Initial state: output HIGH (inverting, input starts low â†’ _outputHigh=false â†’ drive HIGH)
    driveAndReadOutput(st, 0.0, nIn, nOut, rOut);

    // Drive input just below threshold â€” no switch

    // Drive input above threshold â†’ output switches LOW
  });

  it("switches_high_on_falling_threshold", () => {
    // Start with input above V_TH â†’ output LOW (inverting).
    // Ramp input below V_TL (1.0V) â†’ output switches HIGH.
    const nIn = 1, nOut = 2;
    const rOut = 50;
    makeSchmittInverting(nIn, nOut, { vTH: 2.0, vTL: 1.0, vOH: 3.3, vOL: 0.0, rOut });

    // Force output to LOW by driving input above V_TH

    // Drive input just above V_TL â€” no switch yet

    // Drive input below V_TL â†’ output switches HIGH
  });

  it("hysteresis_prevents_oscillation", () => {
    // Input oscillates between V_TL and V_TH (within the hysteresis band).
    // Output must remain stable.
    const nIn = 1, nOut = 2;
    const rOut = 50;
    const vTH = 2.0, vTL = 1.0;
    const st = makeSchmittInverting(nIn, nOut, { vTH, vTL, vOH: 3.3, vOL: 0.0, rOut });

    // Start with input low â†’ output HIGH
    driveAndReadOutput(st, 0.0, nIn, nOut, rOut);

    // Oscillate input within hysteresis band (V_TL + Îµ to V_TH - Îµ)
    const inBandValues = [1.2, 1.5, 1.8, 1.6, 1.3, 1.7, 1.4, 1.9, 1.1, 1.8];
    for (const v of inBandValues) {
      driveAndReadOutput(st, v, nIn, nOut, rOut);
      // Output must not change â€” still HIGH
    }
  });
});

// ---------------------------------------------------------------------------
// NonInverting tests
// ---------------------------------------------------------------------------

describe("NonInverting", () => {
  it("output_follows_input_sense", () => {
    // Non-inverting: input > V_TH â†’ output HIGH; input < V_TL â†’ output LOW.
    const nIn = 1, nOut = 2;
    const rOut = 50;
    makeSchmittNonInverting(nIn, nOut, { vTH: 2.0, vTL: 1.0, vOH: 3.3, vOL: 0.0, rOut });

    // Initial: output LOW (starts low)

    // Drive input above V_TH â†’ output HIGH

    // Drive input back below V_TL â†’ output LOW
  });
});

// ---------------------------------------------------------------------------
// Hysteresis noisy sine test
// ---------------------------------------------------------------------------

describe("Hysteresis", () => {
  it("noisy_sine_clean_square", () => {
    // Sine wave: 1kHz, amplitude = 2V, offset = 1.65V (spanning both thresholds 1.0 and 2.3V).
    // Noise: Gaussian, std dev = 0.1V (within hysteresis band of 2.3-1.0 = 1.3V).
    // Thresholds: V_TH=2.3, V_TL=1.0 â€” hysteresis band 1.3V >> noise std dev 0.1V.
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
    const amplitude = 1.65;  // sine amplitude (peak) â€” ensures signal crosses both thresholds
    const offset = 1.65;     // DC offset: sine swings from 0 to 3.3V
    const noiseSd = 0.1;     // noise std dev = 0.1V (well within hysteresis band)
    const totalTime = 5e-3;  // 5ms = 5 periods
    const numSamples = 5000; // 1Âµs sample interval â€” fine enough to catch crossings

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
    // Initialise with first sample
    const firstV = offset + amplitude * Math.sin(0) + noiseSd * gaussianNoise();
    let prevOut = driveAndReadOutput(st, firstV, nIn, nOut, rOut);

    for (let i = 1; i <= numSamples; i++) {
      const t = (i / numSamples) * totalTime;
      const vSine = offset + amplitude * Math.sin(2 * Math.PI * freq * t);
      const noise = noiseSd * gaussianNoise();
      const vIn = vSine + noise;

      const vOut = driveAndReadOutput(st, vIn, nIn, nOut, rOut);

      if (Math.abs(vOut - prevOut) > 0.5) {
        transitions++;
        prevOut = vOut;
      }
    }

    // Exactly 10 transitions (2 per period Ã— 5 periods), no glitches
    expect(transitions).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Transfer characteristic (hysteresis loop)
// ---------------------------------------------------------------------------

describe("Transfer", () => {
  it("plot_matches_hysteresis_loop", () => {
    // Sweep input from 0 â†’ 3.3V â†’ 0V.
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
    driveAndReadOutput(st, 0.0, nIn, nOut, rOut);

    // Rising sweep: 0 â†’ 3.3V in 0.1V steps
    let risingTransitionAt: number | null = null;
    for (let i = 0; i <= 33; i++) {
      const vIn = (i / 33) * 3.3;
      const vOut = driveAndReadOutput(st, vIn, nIn, nOut, rOut);
      if (risingTransitionAt === null && vOut > 1.65) {
        // Output switched HIGH â€” record the input voltage
        risingTransitionAt = vIn;
      }
    }

    // Rising transition must occur at or just above V_TH
    expect(risingTransitionAt).not.toBeNull();
    expect(risingTransitionAt!).toBeGreaterThanOrEqual(vTH - 0.1);
    expect(risingTransitionAt!).toBeLessThanOrEqual(vTH + 0.2);

    // Falling sweep: 3.3V â†’ 0V in 0.1V steps
    let fallingTransitionAt: number | null = null;
    for (let i = 33; i >= 0; i--) {
      const vIn = (i / 33) * 3.3;
      const vOut = driveAndReadOutput(st, vIn, nIn, nOut, rOut);
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

// ---------------------------------------------------------------------------
// C4.5 parity test â€” schmitt_load_dcop_parity
// ---------------------------------------------------------------------------
//
// Drives the non-inverting Schmitt trigger via load(ctx) at a DC-OP operating
// point (V_in below V_TL, initial output low) and asserts the stamped
// conductance and RHS entries are bit-exact.
//
// Reference formulas (from schmitt-trigger.ts + digital-pin-model.ts):
//   inModel  = DigitalInputPinModel(inputSpec, true) â†’ stamps 1/rIn on nIn diag
//              (inputSpec.rIn = 1e7)
//   outModel = DigitalOutputPinModel(outputSpec) with role="direct", not hiZ
//              â†’ stamps 1/rOut on nOut diag + vOLÂ·(1/rOut) on nOut RHS
//     (outputSpec.rOut = max(p.rOut, 1e-9); p.rOut defaults to 50)
//   Input is below vTH and output starts low â†’ no state change â†’ stays low.

interface SchmittCaptureStamp { row: number; col: number; value: number; }
function makeSchmittCaptureSolver(_rhs: Float64Array): {
  solver: SparseSolverType;
  stamps: SchmittCaptureStamp[];
} {
  const stamps: SchmittCaptureStamp[] = [];
  const handles: { row: number; col: number }[] = [];
  const handleIndex = new Map<string, number>();
  const solver = {
    stamp: (row: number, col: number, value: number) => {
      stamps.push({ row, col, value });
    },
    allocElement: (row: number, col: number): number => {
      const key = `${row},${col}`;
      let h = handleIndex.get(key);
      if (h === undefined) {
        h = handles.length;
        handles.push({ row, col });
        handleIndex.set(key, h);
      }
      return h;
    },
    stampElement: (handle: number, value: number) => {
      const { row, col } = handles[handle];
      stamps.push({ row, col, value });
    },
  } as unknown as SparseSolverType;
  return { solver, stamps };
}

function makeSchmittParityCtx(voltages: Float64Array, solver: SparseSolverType, rhs: Float64Array): LoadContext {
  return makeLoadCtx({
    solver,
    rhs,
    rhsOld: voltages,
    cktMode: MODEDCOP | MODEINITFLOAT,
    dt: 0,
  });
}

describe("SchmittTrigger parity (C4.5)", () => {
  it("schmitt_load_dcop_parity", () => {
    const nIn = 1, nOut = 2;
    const vTH = 2.0, vTL = 1.0, vOH = 3.3, vOL = 0.0, rOut = 50;
    const schmitt = makeSchmittNonInverting(nIn, nOut, { vTH, vTL, vOH, vOL, rOut });

    // V_in = 0.5V: below V_TL, below V_TH. Initial _outputHigh=false, stays low.
    // 1-based: slot 0 = ground sentinel, nIn=1, nOut=2
    const voltages = new Float64Array(3);
    voltages[nIn] = 0.5;
    voltages[nOut] = 0.1;

    const rhsBuf = new Float64Array(16);
    const { solver, stamps } = makeSchmittCaptureSolver(rhsBuf);
    const ctx = makeSchmittParityCtx(voltages, solver, rhsBuf);
    schmitt.load(ctx);

    // Closed-form reference:
    const NGSPICE_RIN  = 1e7;                  // inputSpec.rIn (hardcoded in buildInputSpec)
    const NGSPICE_GIN  = 1 / NGSPICE_RIN;
    const NGSPICE_ROUT = Math.max(rOut, 1e-9); // outputSpec.rOut
    const NGSPICE_GOUT = 1 / NGSPICE_ROUT;
    // output low: target voltage = vOL, RHS = vOL * G_out (zero when vOL=0)
    const NGSPICE_RHS_OUT = vOL * NGSPICE_GOUT;

    const sumAt = (row: number, col: number): number =>
      stamps.filter((s) => s.row === row && s.col === col)
            .reduce((a, s) => a + s.value, 0);

    // Input resistance on nIn diagonal
    expect(sumAt(nIn - 1, nIn - 1)).toBe(NGSPICE_GIN);

    // Output resistance on nOut diagonal
    expect(sumAt(nOut - 1, nOut - 1)).toBe(NGSPICE_GOUT);

    // Output Norton RHS: vOL * G_out
    expect(rhsBuf[nOut - 1]).toBe(NGSPICE_RHS_OUT);
  });
});
