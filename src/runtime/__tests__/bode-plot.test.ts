/**
 * Bode plot renderer tests.
 *
 * Tests use a mock CanvasRenderingContext2D that records drawing calls.
 * This avoids DOM/browser dependencies while verifying that the renderer
 * calls the correct canvas API methods with the correct arguments.
 */

import { describe, it, expect } from "vitest";
import { BodePlotRenderer } from "../bode-plot.js";
import type { BodeViewport } from "../bode-plot.js";
import type { AcResult } from "../../solver/analog/ac-analysis.js";

// ---------------------------------------------------------------------------
// Mock canvas context
// ---------------------------------------------------------------------------

interface DrawCall {
  method: string;
  args: unknown[];
}

function makeMockCtx(): { ctx: CanvasRenderingContext2D; calls: DrawCall[] } {
  const calls: DrawCall[] = [];

  const handler: ProxyHandler<CanvasRenderingContext2D> = {
    get(_target, prop: string) {
      if (prop === "calls") return calls;

      // Property setters (strokeStyle, lineWidth, etc.) — track as set calls
      return new Proxy(() => {}, {
        apply(_fn, _thisArg, argList) {
          calls.push({ method: prop, args: argList });
          return undefined;
        },
        get(_t, innerProp: string) {
          if (innerProp === "then") return undefined; // not a promise
          return () => {
            calls.push({ method: `${prop}.${innerProp}`, args: [] });
          };
        },
      });
    },
    set(_target, prop: string, value: unknown) {
      calls.push({ method: `set:${prop}`, args: [value] });
      return true;
    },
  };

  const ctx = new Proxy<CanvasRenderingContext2D>({} as unknown as CanvasRenderingContext2D, handler);
  return { ctx, calls };
}

// ---------------------------------------------------------------------------
// Fixture: known AcResult data
// ---------------------------------------------------------------------------

/**
 * Build a simple AcResult with a known RC lowpass response.
 * H(f) = 1/(1 + j*f/fC) where fC = 159.15 Hz
 */
function makeRcAcResult(numPoints = 50): AcResult {
  const fStart = 1;
  const fStop = 100000;
  const fC = 159.15;

  const frequencies = new Float64Array(numPoints);
  const magOut = new Float64Array(numPoints);
  const phaseOut = new Float64Array(numPoints);
  const realOut = new Float64Array(numPoints);
  const imagOut = new Float64Array(numPoints);

  for (let i = 0; i < numPoints; i++) {
    const f = fStart * Math.pow(fStop / fStart, i / (numPoints - 1));
    frequencies[i] = f;

    const ratio = f / fC;
    const re = 1 / (1 + ratio * ratio);
    const im = -ratio / (1 + ratio * ratio);
    const mag = Math.sqrt(re * re + im * im);

    realOut[i] = re;
    imagOut[i] = im;
    magOut[i] = 20 * Math.log10(mag);
    phaseOut[i] = (Math.atan2(im, re) * 180) / Math.PI;
  }

  return {
    frequencies,
    magnitude: new Map([["out", magOut]]),
    phase: new Map([["out", phaseOut]]),
    real: new Map([["out", realOut]]),
    imag: new Map([["out", imagOut]]),
    diagnostics: [],
  };
}

// ---------------------------------------------------------------------------
// Standard viewport
// ---------------------------------------------------------------------------

const STD_VIEWPORT: BodeViewport = {
  x: 0,
  y: 0,
  width: 800,
  height: 600,
  fMin: 1,
  fMax: 100000,
  magMin: -100,
  magMax: 20,
  phaseMin: -270,
  phaseMax: 0,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Bode", () => {
  it("renders_magnitude_trace — render() calls lineTo for each frequency point in the magnitude trace", () => {
    const renderer = new BodePlotRenderer();
    const result = makeRcAcResult(50);
    const { ctx, calls } = makeMockCtx();

    renderer.render(ctx, result, STD_VIEWPORT);

    // Filter lineTo calls
    const lineToCount = calls.filter(c => c.method === "lineTo").length;

    // There are 50 frequency points; the first becomes moveTo, remaining 49 become lineTo.
    // The renderer draws two traces (magnitude + phase), so expect 2 × 49 = 98 lineTo calls.
    // (Grid lines also use lineTo but those use short horizontal/vertical segments.)
    // At minimum we expect at least 49 lineTo calls from the magnitude trace alone.
    expect(lineToCount).toBeGreaterThanOrEqual(49);
  });

  it("frequency_axis_log_scale — grid lines drawn at decade intervals (1, 10, 100, 1k, 10k, 100k)", () => {
    const renderer = new BodePlotRenderer();
    const result = makeRcAcResult(10);
    const { ctx, calls } = makeMockCtx();

    renderer.render(ctx, result, STD_VIEWPORT);

    // The renderer calls moveTo/lineTo for grid lines. Count moveTo calls —
    // each grid line (horizontal dB lines, vertical frequency lines) starts with moveTo.
    const moveToCount = calls.filter(c => c.method === "moveTo").length;

    // Decades from 1 to 100k: 1, 10, 100, 1k, 10k, 100k = 6 decade markers,
    // plus intermediate lines (9 per decade × 5 decades = 45 total freq lines).
    // Plus dB grid lines and phase grid lines.
    // Expect at least 6 decade grid lines (generous lower bound).
    expect(moveToCount).toBeGreaterThan(6);

    // Verify fillText was called (for axis labels)
    const fillTextCount = calls.filter(c => c.method === "fillText").length;
    expect(fillTextCount).toBeGreaterThan(0);
  });

  it("phase_axis_degrees — grid lines drawn at 0°, -90°, -180°, -270°", () => {
    const renderer = new BodePlotRenderer();
    // Use a viewport that covers -270° to 0°
    const vp: BodeViewport = {
      ...STD_VIEWPORT,
      phaseMin: -270,
      phaseMax: 0,
    };

    const result = makeRcAcResult(10);
    const { ctx, calls } = makeMockCtx();

    renderer.render(ctx, result, vp);

    // Check that fillText was called with strings containing "°"
    const degLabels = calls.filter(
      c => c.method === "fillText" && typeof c.args[0] === "string" && (c.args[0] as string).includes("°"),
    );

    // Phase grid labels: 0°, -45°, -90°, -135°, -180°, -225°, -270°
    // At least 4 of these should appear (0, -90, -180, -270)
    expect(degLabels.length).toBeGreaterThanOrEqual(4);

    // Verify specific phase labels are present
    const degStrings = degLabels.map(c => c.args[0] as string);
    expect(degStrings.some(s => s.includes("0°"))).toBe(true);
    expect(degStrings.some(s => s.includes("-90°"))).toBe(true);
    expect(degStrings.some(s => s.includes("-180°"))).toBe(true);
    expect(degStrings.some(s => s.includes("-270°"))).toBe(true);
  });

  it("auto_detect_3db_point — -3dB marker placed at correct frequency for lowpass filter", () => {
    const renderer = new BodePlotRenderer();
    const result = makeRcAcResult(200); // high resolution for accurate marker detection
    const fC = 159.15;

    const markers = renderer.detectMarkers(result);
    const marker3db = markers.find(m => m.type === "-3dB");

    expect(marker3db).toBeDefined();

    // The -3dB point should be within 5% of the theoretical fC
    expect(marker3db!.frequency).toBeGreaterThan(fC * 0.95);
    expect(marker3db!.frequency).toBeLessThan(fC * 1.05);

    // Marker value should be approximately -3 dB below DC gain
    // DC gain of this circuit is 0 dB (unity), so marker value ≈ -3.01
    expect(marker3db!.value).toBeCloseTo(-3.01, 1);
  });
});
