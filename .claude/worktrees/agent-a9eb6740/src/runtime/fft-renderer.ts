/**
 * FFT spectrum renderer — draws magnitude spectra on a CanvasRenderingContext2D.
 *
 * Used by AnalogScopePanel when FFT view is enabled. Draws the one-sided
 * magnitude spectrum as a filled polyline with a frequency axis.
 */

import type { ScopeViewport } from "./analog-scope-renderer.js";

// ---------------------------------------------------------------------------
// drawSpectrum
// ---------------------------------------------------------------------------

/**
 * Draws a filled magnitude spectrum.
 *
 * The spectrum is rendered as a filled area from 0 dB down to the bottom of
 * the viewport, plus a stroke line at the top edge.
 *
 * @param ctx Canvas 2D context
 * @param spectrum Frequency and magnitude arrays (linear units)
 * @param viewport Scope viewport mapping time/value → pixels
 * @param color CSS color string for stroke and fill
 * @param logFreq When true, use logarithmic frequency axis
 */
export function drawSpectrum(
  ctx: CanvasRenderingContext2D,
  spectrum: { frequency: Float64Array; magnitude: Float64Array },
  viewport: ScopeViewport,
  color: string,
  logFreq: boolean,
): void {
  const { x, y, width, height, tStart, tEnd, yMin, yMax } = viewport;
  const { frequency, magnitude } = spectrum;
  if (frequency.length === 0) return;

  // Convert magnitude to dB relative to max
  let maxMag = 0;
  for (let i = 0; i < magnitude.length; i++) {
    if (magnitude[i] > maxMag) maxMag = magnitude[i];
  }
  if (maxMag === 0) return;

  const yRange = yMax - yMin;

  ctx.save();
  ctx.beginPath();

  const bottom = y + height;

  for (let i = 0; i < frequency.length; i++) {
    const freq = frequency[i];
    const db = 20 * Math.log10(magnitude[i] / maxMag);

    const px = freqToPixel(freq, tStart, tEnd, x, width, logFreq);
    const py = y + height - ((db - yMin) / yRange) * height;

    if (i === 0) {
      ctx.moveTo(px, bottom);
      ctx.lineTo(px, py);
    } else {
      ctx.lineTo(px, py);
    }
  }

  // Close the filled area at the bottom
  const lastFreq = frequency[frequency.length - 1];
  const lastPx = freqToPixel(lastFreq, tStart, tEnd, x, width, logFreq);
  ctx.lineTo(lastPx, bottom);
  ctx.closePath();

  ctx.fillStyle = color + "40"; // semi-transparent fill
  ctx.fill();

  // Draw stroke line on top
  ctx.beginPath();
  for (let i = 0; i < frequency.length; i++) {
    const freq = frequency[i];
    const db = 20 * Math.log10(magnitude[i] / maxMag);
    const px = freqToPixel(freq, tStart, tEnd, x, width, logFreq);
    const py = y + height - ((db - yMin) / yRange) * height;
    if (i === 0) {
      ctx.moveTo(px, py);
    } else {
      ctx.lineTo(px, py);
    }
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// drawFrequencyAxis
// ---------------------------------------------------------------------------

/**
 * Draws the frequency axis with appropriate unit labels (Hz, kHz, MHz).
 *
 * @param ctx Canvas 2D context
 * @param range [minFreq, maxFreq] in Hz
 * @param viewport Scope viewport
 * @param logScale When true use logarithmic spacing
 */
export function drawFrequencyAxis(
  ctx: CanvasRenderingContext2D,
  range: [number, number],
  viewport: ScopeViewport,
  logScale: boolean,
): void {
  const [minFreq, maxFreq] = range;
  if (maxFreq <= minFreq) return;

  const { x, y, width, height } = viewport;
  const bottom = y + height;

  ctx.save();
  ctx.fillStyle = "#aaaaaa";
  ctx.strokeStyle = "#444444";
  ctx.font = "10px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  // Choose tick interval using 1-2-5 sequence
  const ticks = chooseTicks(minFreq, maxFreq, 8, logScale);

  ctx.beginPath();
  for (const tickFreq of ticks) {
    if (tickFreq < minFreq || tickFreq > maxFreq) continue;
    const px = freqToPixel(tickFreq, minFreq, maxFreq, x, width, logScale);

    // Tick line
    ctx.moveTo(px, bottom);
    ctx.lineTo(px, bottom + 4);

    // Label
    ctx.fillText(formatFrequency(tickFreq), px, bottom + 6);
  }
  ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function freqToPixel(
  freq: number,
  fMin: number,
  fMax: number,
  x: number,
  width: number,
  logScale: boolean,
): number {
  if (logScale) {
    const logMin = Math.log10(Math.max(fMin, 1e-9));
    const logMax = Math.log10(Math.max(fMax, 1e-9));
    const logF = Math.log10(Math.max(freq, 1e-9));
    return x + ((logF - logMin) / (logMax - logMin)) * width;
  }
  return x + ((freq - fMin) / (fMax - fMin)) * width;
}

function formatFrequency(hz: number): string {
  if (hz >= 1e6) return `${(hz / 1e6).toPrecision(3)} MHz`;
  if (hz >= 1e3) return `${(hz / 1e3).toPrecision(3)} kHz`;
  return `${hz.toPrecision(3)} Hz`;
}

function chooseTicks(
  min: number,
  max: number,
  targetCount: number,
  logScale: boolean,
): number[] {
  const ticks: number[] = [];
  if (logScale) {
    const logMin = Math.floor(Math.log10(Math.max(min, 1)));
    const logMax = Math.ceil(Math.log10(Math.max(max, 1)));
    for (let exp = logMin; exp <= logMax; exp++) {
      for (const mult of [1, 2, 5]) {
        const v = mult * Math.pow(10, exp);
        if (v >= min && v <= max) ticks.push(v);
      }
    }
    return ticks;
  }

  const span = max - min;
  let interval = Math.pow(10, Math.floor(Math.log10(span / targetCount)));
  for (const factor of [1, 2, 5, 10]) {
    const candidate = interval * factor;
    if (span / candidate <= targetCount) {
      interval = candidate;
      break;
    }
  }

  const start = Math.ceil(min / interval) * interval;
  for (let v = start; v <= max + interval * 0.5; v += interval) {
    ticks.push(v);
  }
  return ticks;
}
