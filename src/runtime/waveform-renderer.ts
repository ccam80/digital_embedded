/**
 * WaveformRenderer — canvas drawing logic for digital and bus waveforms.
 *
 * Responsible solely for drawing. It receives a list of WaveformChannel objects
 * and a viewport descriptor, then paints onto a CanvasRenderingContext2D.
 *
 * Digital signals (1-bit): square wave with high/low steps.
 * Multi-bit signals (bus): hatched band with hex value annotated at each
 * transition.
 */

import type { WaveformSample } from "./waveform-data.js";

// ---------------------------------------------------------------------------
// DrawCommand — testable output of the renderer
// ---------------------------------------------------------------------------

/**
 * A record of a single draw operation produced by the renderer.
 * Tests inspect DrawCommand[] rather than pixel data to verify correctness.
 */
export type DrawCommand =
  | { kind: "moveTo"; x: number; y: number }
  | { kind: "lineTo"; x: number; y: number }
  | { kind: "fillRect"; x: number; y: number; w: number; h: number }
  | { kind: "text"; value: string; x: number; y: number }
  | { kind: "stroke" }
  | { kind: "fill" }
  | { kind: "beginPath" }
  | { kind: "setStrokeStyle"; style: string }
  | { kind: "setFillStyle"; style: string };

// ---------------------------------------------------------------------------
// RenderContext — thin abstraction over Canvas2D
// ---------------------------------------------------------------------------

/**
 * Abstraction over CanvasRenderingContext2D used by the renderer.
 * Tests supply a RecordingContext that captures DrawCommands.
 */
export interface WaveformRenderContext {
  readonly width: number;
  readonly height: number;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  fill(): void;
  setStrokeStyle(style: string): void;
  setFillStyle(style: string): void;
  clearRect(x: number, y: number, w: number, h: number): void;
}

// ---------------------------------------------------------------------------
// RecordingContext — test double that records DrawCommands
// ---------------------------------------------------------------------------

/**
 * Test implementation of WaveformRenderContext.
 * Records every draw call as a DrawCommand for assertion.
 */
export class RecordingContext implements WaveformRenderContext {
  readonly commands: DrawCommand[] = [];
  readonly width: number;
  readonly height: number;

  constructor(width = 800, height = 400) {
    this.width = width;
    this.height = height;
  }

  beginPath(): void {
    this.commands.push({ kind: "beginPath" });
  }

  moveTo(x: number, y: number): void {
    this.commands.push({ kind: "moveTo", x, y });
  }

  lineTo(x: number, y: number): void {
    this.commands.push({ kind: "lineTo", x, y });
  }

  stroke(): void {
    this.commands.push({ kind: "stroke" });
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    this.commands.push({ kind: "fillRect", x, y, w, h });
  }

  fillText(text: string, x: number, y: number): void {
    this.commands.push({ kind: "text", value: text, x, y });
  }

  fill(): void {
    this.commands.push({ kind: "fill" });
  }

  setStrokeStyle(style: string): void {
    this.commands.push({ kind: "setStrokeStyle", style });
  }

  setFillStyle(style: string): void {
    this.commands.push({ kind: "setFillStyle", style });
  }

  clearRect(_x: number, _y: number, _w: number, _h: number): void {
    // no-op in recording context — clears are not tracked as draw commands
  }
}

// ---------------------------------------------------------------------------
// Viewport — describes which time range is visible
// ---------------------------------------------------------------------------

export interface WaveformViewport {
  /** Leftmost simulation step visible. */
  startTime: number;
  /** Rightmost simulation step visible (exclusive). */
  endTime: number;
  /** Pixel height allocated to each waveform lane. */
  laneHeight: number;
  /** Pixel offset from the left edge of the canvas to the waveform drawing area. */
  leftMargin: number;
}

// ---------------------------------------------------------------------------
// WaveformRenderer — stateless drawing functions
// ---------------------------------------------------------------------------

/** Colour constants for waveform drawing. */
const COLOR_DIGITAL_HIGH = "#00CC00";
const COLOR_DIGITAL_LOW = "#005500";
const COLOR_BUS = "#3399FF";
const COLOR_BUS_HATCH = "#AACCFF";
const COLOR_LABEL = "#CCCCCC";
const COLOR_AXIS = "#555555";

/**
 * Draw a single 1-bit (digital) waveform lane.
 *
 * Produces a square wave: horizontal line at HIGH level or LOW level, with
 * vertical transitions between consecutive differing samples.
 *
 * @param ctx      Render context
 * @param samples  Chronological samples for this channel
 * @param laneY    Top Y pixel of this lane
 * @param vp       Current viewport
 */
export function drawDigitalWaveform(
  ctx: WaveformRenderContext,
  samples: WaveformSample[],
  laneY: number,
  vp: WaveformViewport,
): void {
  if (samples.length === 0) return;

  const highY = laneY + vp.laneHeight * 0.15;
  const lowY = laneY + vp.laneHeight * 0.85;
  const { leftMargin, startTime, endTime } = vp;

  const timeRange = endTime - startTime;
  const drawWidth = ctx.width - leftMargin;

  function timeToX(t: number): number {
    return leftMargin + ((t - startTime) / timeRange) * drawWidth;
  }

  ctx.beginPath();
  ctx.setStrokeStyle(COLOR_DIGITAL_HIGH);

  let prevX = timeToX(samples[0]!.time);
  let prevY = samples[0]!.value !== 0 ? highY : lowY;

  ctx.moveTo(prevX, prevY);

  for (let i = 1; i < samples.length; i++) {
    const s = samples[i]!;
    const x = timeToX(s.time);
    const y = s.value !== 0 ? highY : lowY;

    // Horizontal line to transition point
    ctx.lineTo(x, prevY);
    // Vertical transition
    if (y !== prevY) {
      ctx.lineTo(x, y);
    }

    prevX = x;
    prevY = y;
  }

  // Extend to right edge
  ctx.lineTo(ctx.width, prevY);
  ctx.stroke();
}

/**
 * Draw a single multi-bit (bus) waveform lane.
 *
 * Renders a hatched band between highY and lowY. At each value transition,
 * draws crossing diagonal lines and annotates the new hex value.
 *
 * @param ctx      Render context
 * @param samples  Chronological samples for this channel
 * @param width    Bit width of the signal
 * @param laneY    Top Y pixel of this lane
 * @param vp       Current viewport
 */
export function drawBusWaveform(
  ctx: WaveformRenderContext,
  samples: WaveformSample[],
  width: number,
  laneY: number,
  vp: WaveformViewport,
): void {
  if (samples.length === 0) return;

  const bandTop = laneY + vp.laneHeight * 0.15;
  const bandBot = laneY + vp.laneHeight * 0.85;
  const midY = (bandTop + bandBot) / 2;
  const { leftMargin, startTime, endTime } = vp;

  const timeRange = endTime - startTime;
  const drawWidth = ctx.width - leftMargin;

  function timeToX(t: number): number {
    return leftMargin + ((t - startTime) / timeRange) * drawWidth;
  }

  function hexLabel(val: number): string {
    const digits = Math.ceil(width / 4);
    return "0x" + (val >>> 0).toString(16).toUpperCase().padStart(digits, "0");
  }

  // Draw top and bottom rails
  ctx.beginPath();
  ctx.setStrokeStyle(COLOR_BUS);

  const firstX = timeToX(samples[0]!.time);
  ctx.moveTo(firstX, bandTop);
  ctx.lineTo(ctx.width, bandTop);
  ctx.moveTo(firstX, bandBot);
  ctx.lineTo(ctx.width, bandBot);
  ctx.stroke();

  // Draw transition markers (crossing diagonals) and value annotations
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    const x = timeToX(s.time);

    const isTransition = i === 0 || samples[i - 1]!.value !== s.value;

    if (isTransition && i > 0) {
      // Crossing diagonal at transition
      ctx.beginPath();
      ctx.setStrokeStyle(COLOR_BUS);
      ctx.moveTo(x - 3, bandTop);
      ctx.lineTo(x + 3, bandBot);
      ctx.moveTo(x - 3, bandBot);
      ctx.lineTo(x + 3, bandTop);
      ctx.stroke();
    }

    // Annotate hex value in the middle of the segment
    const nextX = i + 1 < samples.length ? timeToX(samples[i + 1]!.time) : ctx.width;
    const segMidX = (x + nextX) / 2;

    ctx.setFillStyle(COLOR_BUS_HATCH);
    ctx.fillText(hexLabel(s.value), segMidX, midY);
  }
}

/**
 * Draw the time axis at the bottom of the diagram.
 *
 * @param ctx  Render context
 * @param vp   Current viewport
 */
export function drawTimeAxis(
  ctx: WaveformRenderContext,
  vp: WaveformViewport,
): void {
  const axisY = ctx.height - 20;
  const { leftMargin, startTime, endTime } = vp;
  const timeRange = endTime - startTime;
  const drawWidth = ctx.width - leftMargin;

  function timeToX(t: number): number {
    return leftMargin + ((t - startTime) / timeRange) * drawWidth;
  }

  ctx.beginPath();
  ctx.setStrokeStyle(COLOR_AXIS);
  ctx.moveTo(leftMargin, axisY);
  ctx.lineTo(ctx.width, axisY);
  ctx.stroke();

  // Tick marks — approximately every 50 pixels
  const tickCount = Math.max(2, Math.floor(drawWidth / 50));
  const tickInterval = Math.ceil(timeRange / tickCount);

  ctx.setFillStyle(COLOR_LABEL);
  for (let t = startTime; t <= endTime; t += tickInterval) {
    const x = timeToX(t);
    ctx.beginPath();
    ctx.setStrokeStyle(COLOR_AXIS);
    ctx.moveTo(x, axisY - 4);
    ctx.lineTo(x, axisY + 4);
    ctx.stroke();
    ctx.fillText(String(t), x, axisY + 14);
  }
}

/**
 * Draw the channel label in the left margin.
 *
 * @param ctx    Render context
 * @param label  Signal name
 * @param laneY  Top Y pixel of the lane
 * @param vp     Viewport (used for laneHeight and leftMargin)
 */
export function drawChannelLabel(
  ctx: WaveformRenderContext,
  label: string,
  laneY: number,
  vp: WaveformViewport,
): void {
  const midY = laneY + vp.laneHeight / 2;
  ctx.setFillStyle(COLOR_LABEL);
  ctx.fillText(label, 4, midY);
}
