/**
 * AnalogScopePanel — analog oscilloscope panel.
 *
 * Captures voltage and current waveforms at every accepted timestep from the
 * analog engine and renders them on a dedicated HTMLCanvasElement. Supports
 * multiple channels, Y-axis auto-ranging, zoom/pan, and an optional FFT
 * spectrum view (Task 3.3.3).
 *
 * The panel renders to its own canvas using CanvasRenderingContext2D directly,
 * consistent with TimingDiagramPanel. It does not use the engine-agnostic
 * RenderContext abstraction (which is for the circuit editor canvas only).
 */

import type { MeasurementObserver } from "@/core/engine-interface.js";
import type { AnalogEngine } from "@/core/analog-engine-interface.js";
import { AnalogScopeBuffer } from "./analog-scope-buffer.js";
import {
  drawPolylineTrace,
  drawEnvelopeTrace,
  drawYAxis,
  chooseGridInterval,
} from "./analog-scope-renderer.js";
import type { ScopeViewport } from "./analog-scope-renderer.js";
import { fft, hannWindow, magnitudeSpectrum, floorPow2 } from "./fft.js";
import { drawSpectrum, drawFrequencyAxis } from "./fft-renderer.js";

// ---------------------------------------------------------------------------
// Channel descriptors
// ---------------------------------------------------------------------------

type ChannelKind = "voltage" | "current" | "elementCurrent";

/** Which statistical overlays to draw for a channel. */
export type OverlayKind = "min" | "max" | "mean" | "rms";

interface ScopeChannel {
  label: string;
  kind: ChannelKind;
  nodeOrBranchId: number;
  color: string;
  buffer: AnalogScopeBuffer;
  /** Auto Y-range: track min/max of visible samples. */
  autoRange: boolean;
  yMin: number;
  yMax: number;
  /** Active stat overlays. */
  overlays: Set<OverlayKind>;
}

// ---------------------------------------------------------------------------
// Default channel color palette
// ---------------------------------------------------------------------------

const CHANNEL_COLORS = [
  "#4488ff",
  "#ff4444",
  "#44cc44",
  "#ff8800",
  "#aa44ff",
  "#44cccc",
  "#ff44aa",
  "#aaaa44",
];

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const LEFT_MARGIN = 70;
const RIGHT_MARGIN = 50;
const TOP_MARGIN = 20;
const BOTTOM_MARGIN = 30;
const ENVELOPE_THRESHOLD = 1000;

// ---------------------------------------------------------------------------
// AnalogScopePanel
// ---------------------------------------------------------------------------

/**
 * Analog oscilloscope panel.
 *
 * Auto-registers itself as a `MeasurementObserver` on construction by calling
 * `engine.addMeasurementObserver(this)`. Call `dispose()` to deregister when
 * the panel is no longer needed.
 *
 * Usage:
 *   const panel = new AnalogScopePanel(canvas, engine);
 *   panel.addVoltageChannel(1, "Vout", "#4488ff");
 *   // ... later ...
 *   panel.dispose();
 */
export class AnalogScopePanel implements MeasurementObserver {
  private readonly _canvas: HTMLCanvasElement | null;
  private readonly _engine: AnalogEngine;
  private readonly _channels: ScopeChannel[] = [];

  // Time-axis viewport
  private _viewDuration: number = 0.01; // 10 ms default
  private _viewEnd: number = 0.01;
  private _hasData = false;

  // FFT state (Task 3.3.3)
  private _fftEnabled = false;
  private _fftChannelLabel: string | null = null;

  private _wheelHandler: ((e: WheelEvent) => void) | null = null;

  constructor(canvas: HTMLCanvasElement | null, engine: AnalogEngine) {
    this._canvas = canvas;
    this._engine = engine;
    engine.addMeasurementObserver(this);

    // Wire up scroll-to-zoom on the scope canvas
    if (canvas) {
      this._wheelHandler = (e: WheelEvent) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.3 : 1 / 1.3;
        this.zoom(factor);
      };
      canvas.addEventListener("wheel", this._wheelHandler, { passive: false });
    }
  }

  /** Deregister from the engine. Call when the panel is no longer needed. */
  dispose(): void {
    this._engine.removeMeasurementObserver(this);
    if (this._canvas && this._wheelHandler) {
      this._canvas.removeEventListener("wheel", this._wheelHandler);
      this._wheelHandler = null;
    }
  }

  // -------------------------------------------------------------------------
  // Channel management
  // -------------------------------------------------------------------------

  /** Read-only channel info for UI (e.g. context menus). */
  getChannelDescriptors(): Array<{ label: string; kind: ChannelKind; autoRange: boolean; yMin: number; yMax: number; overlays: ReadonlySet<OverlayKind> }> {
    return this._channels.map(c => ({
      label: c.label, kind: c.kind, autoRange: c.autoRange, yMin: c.yMin, yMax: c.yMax, overlays: c.overlays,
    }));
  }

  isFftEnabled(): boolean { return this._fftEnabled; }
  getFftChannelLabel(): string | null { return this._fftChannelLabel; }

  addVoltageChannel(nodeId: number, label: string, color?: string): void {
    const ch = this._makeChannel(label, "voltage", nodeId, color);
    this._channels.push(ch);
  }

  addCurrentChannel(branchId: number, label: string, color?: string): void {
    const ch = this._makeChannel(label, "current", branchId, color);
    this._channels.push(ch);
  }

  addElementCurrentChannel(elementId: number, label: string, color?: string): void {
    const ch = this._makeChannel(label, "elementCurrent", elementId, color);
    this._channels.push(ch);
  }

  removeChannel(label: string): void {
    const idx = this._channels.findIndex((c) => c.label === label);
    if (idx !== -1) this._channels.splice(idx, 1);
  }

  private _makeChannel(
    label: string,
    kind: ChannelKind,
    id: number,
    color?: string,
  ): ScopeChannel {
    const resolvedColor =
      color ?? CHANNEL_COLORS[this._channels.length % CHANNEL_COLORS.length] ?? "#4488ff";
    return {
      label,
      kind,
      nodeOrBranchId: id,
      color: resolvedColor,
      buffer: new AnalogScopeBuffer(65536),
      autoRange: true,
      yMin: -1,
      yMax: 1,
      overlays: new Set<OverlayKind>(),
    };
  }

  // -------------------------------------------------------------------------
  // MeasurementObserver
  // -------------------------------------------------------------------------

  onStep(_stepCount: number): void {
    const t = this._engine.simTime;

    for (const ch of this._channels) {
      let value: number;
      if (ch.kind === "voltage") {
        value = this._engine.getNodeVoltage(ch.nodeOrBranchId);
      } else if (ch.kind === "elementCurrent") {
        value = this._engine.getElementCurrent(ch.nodeOrBranchId);
      } else {
        value = this._engine.getBranchCurrent(ch.nodeOrBranchId);
      }
      ch.buffer.push(t, value);
    }

    if (!this._hasData) {
      this._hasData = true;
    }

    // Auto-scroll: smoothly track latest sim time, keeping the view window
    // ending at the current time so traces paint right-to-left continuously.
    this._viewEnd = t;
  }

  onReset(): void {
    for (const ch of this._channels) {
      ch.buffer.clear();
    }
    this._hasData = false;
    this._viewEnd = this._viewDuration;
    this._render();
  }

  // -------------------------------------------------------------------------
  // Viewport controls
  // -------------------------------------------------------------------------

  setTimeRange(duration: number): void {
    this._viewDuration = duration;
    this._viewEnd = Math.max(this._viewEnd, duration);
  }

  setYRange(channelLabel: string, min: number, max: number): void {
    const ch = this._channels.find((c) => c.label === channelLabel);
    if (!ch) return;
    ch.autoRange = false;
    ch.yMin = min;
    ch.yMax = max;
  }

  setAutoYRange(channelLabel: string): void {
    const ch = this._channels.find((c) => c.label === channelLabel);
    if (!ch) return;
    ch.autoRange = true;
  }

  toggleOverlay(channelLabel: string, overlay: OverlayKind): void {
    const ch = this._channels.find((c) => c.label === channelLabel);
    if (!ch) return;
    if (ch.overlays.has(overlay)) ch.overlays.delete(overlay);
    else ch.overlays.add(overlay);
  }

  zoom(factor: number): void {
    this._viewDuration = Math.max(1e-9, this._viewDuration / factor);
  }

  pan(deltaSeconds: number): void {
    this._viewEnd += deltaSeconds;
  }

  // -------------------------------------------------------------------------
  // FFT controls (Task 3.3.3)
  // -------------------------------------------------------------------------

  setFftEnabled(enabled: boolean): void {
    this._fftEnabled = enabled;
  }

  setFftChannel(label: string): void {
    this._fftChannelLabel = label;
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  render(): void {
    this._render();
  }

  private _render(): void {
    if (this._canvas === null) return;
    const ctx = this._canvas.getContext("2d");
    if (ctx === null) return;

    const W = this._canvas.width;
    const H = this._canvas.height;

    ctx.clearRect(0, 0, W, H);

    // Background
    ctx.fillStyle = "#1a1a1a";
    ctx.fillRect(0, 0, W, H);

    if (this._fftEnabled) {
      // Split: time-domain top half, frequency-domain bottom half
      const halfH = Math.floor(H / 2);
      this._renderTimeDomain(ctx, W, halfH, 0);
      this._renderFft(ctx, W, H - halfH, halfH);
    } else {
      this._renderTimeDomain(ctx, W, H, 0);
    }
  }

  private _renderTimeDomain(
    ctx: CanvasRenderingContext2D,
    W: number,
    H: number,
    offsetY: number,
  ): void {
    const drawW = W - LEFT_MARGIN - RIGHT_MARGIN;
    const drawH = H - TOP_MARGIN - BOTTOM_MARGIN;
    if (drawW <= 0 || drawH <= 0) return;

    const tEnd = this._viewEnd;
    const tStart = tEnd - this._viewDuration;

    // Draw grid and time axis
    this._drawTimeGrid(ctx, tStart, tEnd, LEFT_MARGIN, offsetY + TOP_MARGIN, drawW, drawH);

    // Compute shared Y range across all channels so traces are comparable
    const sharedRange = this._computeSharedYRange(tStart, tEnd);

    // Draw each channel using the shared viewport
    const sharedVp: ScopeViewport = {
      x: LEFT_MARGIN,
      y: offsetY + TOP_MARGIN,
      width: drawW,
      height: drawH,
      tStart,
      tEnd,
      yMin: sharedRange.yMin,
      yMax: sharedRange.yMax,
    };

    for (const ch of this._channels) {
      const samples = ch.buffer.getSamplesInRange(tStart, tEnd);

      if (samples.time.length >= ENVELOPE_THRESHOLD) {
        const env = ch.buffer.getEnvelope(tStart, tEnd, Math.min(drawW, 512));
        drawEnvelopeTrace(ctx, env, sharedVp, ch.color);
      } else {
        drawPolylineTrace(ctx, samples, sharedVp, ch.color);
      }

      // Draw stat overlay lines
      if (ch.overlays.size > 0 && samples.value.length > 0) {
        this._drawOverlays(ctx, ch, samples.value, sharedVp);
      }
    }

    // Single shared Y-axis
    const hasCurrent = this._channels.some(c => c.kind === "current" || c.kind === "elementCurrent");
    const unit = hasCurrent ? "V/A" : "V";
    drawYAxis(ctx, [sharedRange.yMin, sharedRange.yMax], sharedVp, unit, "left");

    // Channel legend
    this._drawLegend(ctx, W, offsetY + TOP_MARGIN);

    // Time axis labels
    this._drawTimeAxisLabels(
      ctx,
      tStart,
      tEnd,
      LEFT_MARGIN,
      offsetY + TOP_MARGIN + drawH,
      drawW,
    );
  }

  private _drawOverlays(
    ctx: CanvasRenderingContext2D,
    ch: ScopeChannel,
    values: Float64Array,
    vp: ScopeViewport,
  ): void {
    const n = values.length;
    if (n === 0) return;

    // Compute requested stats
    let min = Infinity, max = -Infinity, sum = 0, sumSq = 0;
    for (let i = 0; i < n; i++) {
      const v = values[i];
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
      sumSq += v * v;
    }
    const mean = sum / n;
    const rms = Math.sqrt(sumSq / n);

    const stats: Array<{ kind: OverlayKind; value: number; dash: number[] }> = [];
    if (ch.overlays.has("min"))  stats.push({ kind: "min",  value: min,  dash: [4, 4] });
    if (ch.overlays.has("max"))  stats.push({ kind: "max",  value: max,  dash: [4, 4] });
    if (ch.overlays.has("mean")) stats.push({ kind: "mean", value: mean, dash: [8, 4] });
    if (ch.overlays.has("rms"))  stats.push({ kind: "rms",  value: rms,  dash: [2, 2] });

    const yRange = vp.yMax - vp.yMin;
    if (yRange === 0) return;

    ctx.save();
    ctx.globalAlpha = 0.6;
    ctx.font = "10px monospace";
    for (const stat of stats) {
      const yFrac = 1 - (stat.value - vp.yMin) / yRange;
      const yPx = vp.y + yFrac * vp.height;
      if (yPx < vp.y || yPx > vp.y + vp.height) continue;

      ctx.strokeStyle = ch.color;
      ctx.setLineDash(stat.dash);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(vp.x, yPx);
      ctx.lineTo(vp.x + vp.width, yPx);
      ctx.stroke();

      // Label
      ctx.fillStyle = ch.color;
      ctx.fillText(`${stat.kind}: ${stat.value.toPrecision(4)}`, vp.x + vp.width - 120, yPx - 3);
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  private _renderFft(
    ctx: CanvasRenderingContext2D,
    W: number,
    H: number,
    offsetY: number,
  ): void {
    const drawW = W - LEFT_MARGIN - RIGHT_MARGIN;
    const drawH = H - TOP_MARGIN - BOTTOM_MARGIN;
    if (drawW <= 0 || drawH <= 0) return;

    // Find the channel to analyze
    const label = this._fftChannelLabel ?? (this._channels[0]?.label ?? null);
    if (label === null) return;
    const ch = this._channels.find((c) => c.label === label);
    if (!ch) return;

    const n = ch.buffer.sampleCount;
    if (n < 4) return;

    // N = largest power of 2 <= sampleCount, max 8192
    const N = Math.min(floorPow2(n), 8192);

    // Get the most recent N samples and resample to uniform spacing
    const tEnd = ch.buffer.timeEnd;
    const tStart = ch.buffer.timeStart;
    const span = tEnd - tStart;
    if (span <= 0) return;

    const rawSamples = ch.buffer.getSamplesInRange(tStart, tEnd);
    const uniformSamples = resampleUniform(rawSamples.time, rawSamples.value, N);
    const sampleRate = (N - 1) / span;

    // Apply Hann window
    const windowed = hannWindow(uniformSamples);

    // Compute FFT
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = windowed[i];
    fft(re, im);

    const spectrum = magnitudeSpectrum(re, im, sampleRate);

    // dB Y-axis range: -80 to 0 dB
    const vp: ScopeViewport = {
      x: LEFT_MARGIN,
      y: offsetY + TOP_MARGIN,
      width: drawW,
      height: drawH,
      tStart: spectrum.frequency[0] ?? 0,
      tEnd: spectrum.frequency[spectrum.frequency.length - 1] ?? sampleRate / 2,
      yMin: -80,
      yMax: 0,
    };

    // Background grid
    ctx.fillStyle = "#1a1a1a";
    ctx.fillRect(LEFT_MARGIN, offsetY + TOP_MARGIN, drawW, drawH);

    drawSpectrum(ctx, spectrum, vp, ch.color, false);

    const freqRange: [number, number] = [
      spectrum.frequency[0] ?? 0,
      spectrum.frequency[spectrum.frequency.length - 1] ?? sampleRate / 2,
    ];
    drawFrequencyAxis(ctx, freqRange, vp, false);

    // dB Y-axis label
    ctx.save();
    ctx.fillStyle = "#aaaaaa";
    ctx.font = "10px monospace";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let db = -80; db <= 0; db += 20) {
      const py = vp.y + vp.height - ((db - vp.yMin) / (vp.yMax - vp.yMin)) * vp.height;
      ctx.fillText(`${db} dB`, LEFT_MARGIN - 4, py);
    }
    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Compute a shared Y range that encompasses all channels' visible samples.
   * Adds 10% padding so traces don't touch the edges.
   */
  private _computeSharedYRange(
    tStart: number,
    tEnd: number,
  ): { yMin: number; yMax: number } {
    let globalMin = Infinity;
    let globalMax = -Infinity;

    for (const ch of this._channels) {
      const samples = ch.buffer.getSamplesInRange(tStart, tEnd);
      for (let i = 0; i < samples.value.length; i++) {
        const v = samples.value[i];
        if (v < globalMin) globalMin = v;
        if (v > globalMax) globalMax = v;
      }
    }

    if (!isFinite(globalMin) || !isFinite(globalMax)) {
      return { yMin: -1, yMax: 1 };
    }

    const span = globalMax - globalMin;
    const padding = span > 0 ? span * 0.1 : 0.5;
    return { yMin: globalMin - padding, yMax: globalMax + padding };
  }

  private _drawTimeGrid(
    ctx: CanvasRenderingContext2D,
    tStart: number,
    tEnd: number,
    x: number,
    y: number,
    w: number,
    h: number,
  ): void {
    const span = tEnd - tStart;
    const interval = chooseGridInterval(span, 8);
    if (interval <= 0) return;

    ctx.save();
    ctx.strokeStyle = "#333333";
    ctx.lineWidth = 1;

    const start = Math.ceil(tStart / interval) * interval;
    for (let t = start; t <= tEnd + interval * 0.5; t += interval) {
      const px = x + ((t - tStart) / span) * w;
      ctx.beginPath();
      ctx.moveTo(px, y);
      ctx.lineTo(px, y + h);
      ctx.stroke();
    }
    ctx.restore();
  }

  private _drawTimeAxisLabels(
    ctx: CanvasRenderingContext2D,
    tStart: number,
    tEnd: number,
    x: number,
    y: number,
    w: number,
  ): void {
    const span = tEnd - tStart;
    const interval = chooseGridInterval(span, 8);
    if (interval <= 0) return;

    ctx.save();
    ctx.fillStyle = "#aaaaaa";
    ctx.font = "10px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    const start = Math.ceil(tStart / interval) * interval;
    for (let t = start; t <= tEnd + interval * 0.5; t += interval) {
      const px = x + ((t - tStart) / span) * w;
      ctx.fillText(formatTime(t), px, y + 4);
    }
    ctx.restore();
  }

  private _drawLegend(
    ctx: CanvasRenderingContext2D,
    W: number,
    offsetY: number,
  ): void {
    if (this._channels.length === 0) return;
    ctx.save();
    ctx.font = "11px monospace";
    ctx.textBaseline = "top";

    let legendX = W - RIGHT_MARGIN - 10;
    const legendY = offsetY + 4;
    const lineH = 16;

    for (let i = this._channels.length - 1; i >= 0; i--) {
      const ch = this._channels[i];
      if (!ch) continue;
      ctx.fillStyle = ch.color;
      const textW = ctx.measureText(ch.label).width;
      ctx.fillText(ch.label, legendX - textW, legendY + i * lineH);
    }
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// resampleUniform — linear interpolation of non-uniform samples
// ---------------------------------------------------------------------------

/**
 * Resamples non-uniformly-spaced (time, value) pairs onto a uniform grid of
 * N points spanning [time[0], time[last]].
 *
 * Uses piecewise linear interpolation. Returns a new Float64Array of length N.
 */
function resampleUniform(
  time: Float64Array,
  value: Float64Array,
  N: number,
): Float64Array {
  const out = new Float64Array(N);
  if (time.length === 0) return out;
  if (time.length === 1) {
    out.fill(value[0]);
    return out;
  }

  const tStart = time[0];
  const tEnd = time[time.length - 1];
  const span = tEnd - tStart;

  let j = 0; // source index
  for (let i = 0; i < N; i++) {
    const t = tStart + (i / (N - 1)) * span;

    // Advance j to find the interval [time[j], time[j+1]] containing t
    while (j < time.length - 2 && time[j + 1] < t) {
      j++;
    }

    const t0 = time[j];
    const t1 = time[j + 1] ?? t0;
    const dt = t1 - t0;

    if (dt <= 0) {
      out[i] = value[j];
    } else {
      const alpha = (t - t0) / dt;
      out[i] = value[j] * (1 - alpha) + (value[j + 1] ?? value[j]) * alpha;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// formatTime — compact SI time label
// ---------------------------------------------------------------------------

function formatTime(t: number): string {
  const abs = Math.abs(t);
  if (abs >= 1) return `${t.toPrecision(3)} s`;
  if (abs >= 1e-3) return `${(t * 1e3).toPrecision(3)} ms`;
  if (abs >= 1e-6) return `${(t * 1e6).toPrecision(3)} µs`;
  return `${(t * 1e9).toPrecision(3)} ns`;
}
