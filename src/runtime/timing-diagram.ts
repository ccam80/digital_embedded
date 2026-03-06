/**
 * TimingDiagramPanel — waveform view of signals over time.
 *
 * Implements MeasurementObserver to receive step notifications and records
 * one sample per channel per step. Renders to a <canvas> element.
 *
 * Interactive features:
 *   - Time cursor: vertical crosshair at mouse position with tooltip.
 *   - Click-to-jump: click a time point → engine.restoreSnapshot() with the
 *     closest stored snapshot.
 *   - Zoom: mouse wheel scales the time axis.
 *   - Pan: click-drag scrolls through time.
 *
 * Snapshot integration: the panel calls engine.saveSnapshot() at a
 * configurable interval (default: every step). Each snapshot is tagged with
 * the current simulation step count so click-to-jump can locate the nearest
 * one.
 *
 * Java reference: de.neemann.digital.gui.components.data.DataSet
 */

import type { MeasurementObserver, SimulationEngine, SnapshotId } from "@/core/engine-interface";
import { WaveformChannel } from "./waveform-data.js";
import type { WaveformSample } from "./waveform-data.js";
import type { WaveformViewport, CursorTooltipRow } from "./waveform-renderer.js";
import {
  drawDigitalWaveform,
  drawBusWaveform,
  drawTimeAxis,
  drawChannelLabel,
  drawTimeCursor,
} from "./waveform-renderer.js";

// ---------------------------------------------------------------------------
// SnapshotTag — associates a snapshot ID with a simulation time
// ---------------------------------------------------------------------------

interface SnapshotTag {
  snapshotId: SnapshotId;
  /** Simulation step count when this snapshot was taken. */
  time: number;
}

// ---------------------------------------------------------------------------
// CanvasRenderContext — adapts Canvas2D to WaveformRenderContext
// ---------------------------------------------------------------------------

import type { WaveformRenderContext } from "./waveform-renderer.js";

class CanvasRenderContext implements WaveformRenderContext {
  private readonly _ctx: CanvasRenderingContext2D;
  readonly width: number;
  readonly height: number;

  constructor(ctx: CanvasRenderingContext2D, width: number, height: number) {
    this._ctx = ctx;
    this.width = width;
    this.height = height;
  }

  beginPath(): void { this._ctx.beginPath(); }
  moveTo(x: number, y: number): void { this._ctx.moveTo(x, y); }
  lineTo(x: number, y: number): void { this._ctx.lineTo(x, y); }
  stroke(): void { this._ctx.stroke(); }
  fillRect(x: number, y: number, w: number, h: number): void { this._ctx.fillRect(x, y, w, h); }
  fillText(text: string, x: number, y: number): void { this._ctx.fillText(text, x, y); }
  fill(): void { this._ctx.fill(); }
  setStrokeStyle(style: string): void { this._ctx.strokeStyle = style; }
  setFillStyle(style: string): void { this._ctx.fillStyle = style; }
  clearRect(x: number, y: number, w: number, h: number): void { this._ctx.clearRect(x, y, w, h); }
}

// ---------------------------------------------------------------------------
// TimingDiagramPanel
// ---------------------------------------------------------------------------

/** Options for TimingDiagramPanel construction. */
export interface TimingDiagramOptions {
  /**
   * Save a snapshot every N steps. 0 = never save snapshots automatically.
   * Default: 1 (every step).
   */
  snapshotInterval?: number;
  /** Per-channel ring buffer capacity (number of samples). Default: 1024. */
  channelCapacity?: number;
  /** Pixel height of each waveform lane. Default: 60. */
  laneHeight?: number;
  /** Pixel width of the left label margin. Default: 80. */
  leftMargin?: number;
}

/**
 * Waveform timing diagram panel.
 *
 * Usage:
 *   const panel = new TimingDiagramPanel(canvasEl, engine, channels, opts);
 *   engine.addMeasurementObserver(panel);
 *   // Later:
 *   engine.removeMeasurementObserver(panel);
 *   panel.dispose();
 */
export class TimingDiagramPanel implements MeasurementObserver {
  private readonly _engine: SimulationEngine;
  private readonly _channels: WaveformChannel[];
  private readonly _canvas: HTMLCanvasElement | null;
  private readonly _snapshotInterval: number;
  private readonly _laneHeight: number;
  private readonly _leftMargin: number;

  /** All snapshot tags in order of recording. */
  private readonly _snapshots: SnapshotTag[] = [];

  /** Current simulation step count (updated on each onStep call). */
  private _currentTime = 0;

  /** Viewport state for rendering. */
  private _viewStartTime = 0;
  private _viewEndTime = 100;

  /** Zoom scale: pixels per time unit. Derived from viewport. */
  private _isDragging = false;
  private _dragStartX = 0;
  private _dragStartViewStart = 0;

  /**
   * Current mouse X position in canvas coordinates, or null when the cursor
   * is outside the canvas. Used to draw the time cursor crosshair.
   */
  private _cursorX: number | null = null;

  constructor(
    canvas: HTMLCanvasElement | null,
    engine: SimulationEngine,
    channels: readonly { name: string; netId: number; width: number }[],
    options: TimingDiagramOptions = {},
  ) {
    this._canvas = canvas;
    this._engine = engine;
    this._snapshotInterval = options.snapshotInterval ?? 1;
    this._laneHeight = options.laneHeight ?? 60;
    this._leftMargin = options.leftMargin ?? 80;

    const capacity = options.channelCapacity ?? 1024;
    this._channels = channels.map(
      (c) => new WaveformChannel(c.name, c.netId, c.width, capacity),
    );

    if (canvas !== null) {
      this._attachEvents(canvas);
    }
  }

  // -------------------------------------------------------------------------
  // MeasurementObserver
  // -------------------------------------------------------------------------

  onStep(stepCount: number): void {
    this._currentTime = stepCount;

    // Record one sample per channel
    for (const ch of this._channels) {
      const raw = this._engine.getSignalRaw(ch.netId);
      ch.append(stepCount, raw);
    }

    // Save snapshot at configured interval
    if (this._snapshotInterval > 0 && stepCount % this._snapshotInterval === 0) {
      const id = this._engine.saveSnapshot();
      this._snapshots.push({ snapshotId: id, time: stepCount });
    }

    // Expand viewport to show new data
    if (stepCount > this._viewEndTime) {
      this._viewEndTime = stepCount + 10;
    }

    this._render();
  }

  onReset(): void {
    this._currentTime = 0;
    this._viewStartTime = 0;
    this._viewEndTime = 100;
    for (const ch of this._channels) {
      ch.clear();
    }
    this._snapshots.length = 0;
    this._render();
  }

  // -------------------------------------------------------------------------
  // Query — used by tests and UI code
  // -------------------------------------------------------------------------

  /** Return the WaveformChannel for a signal by name. */
  getChannel(name: string): WaveformChannel | undefined {
    return this._channels.find((c) => c.name === name);
  }

  /** Return all channels. */
  getChannels(): readonly WaveformChannel[] {
    return this._channels;
  }

  /** Return all snapshot tags in recording order. */
  getSnapshotTags(): readonly SnapshotTag[] {
    return this._snapshots;
  }

  /** Return the current simulation step count. */
  getCurrentTime(): number {
    return this._currentTime;
  }

  // -------------------------------------------------------------------------
  // Time cursor query
  // -------------------------------------------------------------------------

  /**
   * Return the simulation time currently under the mouse cursor, or null
   * when the cursor is outside the canvas.
   */
  getCursorTime(): number | null {
    if (this._cursorX === null) return null;
    return this._xToTime(this._cursorX);
  }

  /**
   * Return the signal value for each channel at the given simulation time.
   * Each entry holds the channel name, the value of the closest recorded
   * sample at or before `time`, and the channel bit width.
   *
   * Channels with no recorded samples are omitted from the result.
   */
  getValuesAtTime(time: number): CursorTooltipRow[] {
    const result: CursorTooltipRow[] = [];
    for (const ch of this._channels) {
      const idx = ch.findClosestIndex(time);
      if (idx === -1) continue;
      const sample = ch.getSample(idx);
      result.push({ name: ch.name, value: sample.value, width: ch.width });
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Click-to-jump
  // -------------------------------------------------------------------------

  /**
   * Find the snapshot whose time is closest to `targetTime` and restore it.
   * No-op if no snapshots have been recorded.
   */
  jumpToTime(targetTime: number): void {
    if (this._snapshots.length === 0) return;

    let best = this._snapshots[0]!;
    let bestDist = Math.abs(best.time - targetTime);

    for (let i = 1; i < this._snapshots.length; i++) {
      const tag = this._snapshots[i]!;
      const dist = Math.abs(tag.time - targetTime);
      if (dist < bestDist) {
        bestDist = dist;
        best = tag;
      }
    }

    this._engine.restoreSnapshot(best.snapshotId);
  }

  // -------------------------------------------------------------------------
  // Zoom & pan
  // -------------------------------------------------------------------------

  /**
   * Zoom the time axis around the given pivot time (in simulation steps).
   * `factor` > 1 zooms in (shows less time), < 1 zooms out (shows more time).
   */
  zoom(factor: number, pivotTime: number): void {
    const range = this._viewEndTime - this._viewStartTime;
    const pivotFrac = (pivotTime - this._viewStartTime) / range;

    const newRange = Math.max(2, range / factor);
    this._viewStartTime = pivotTime - pivotFrac * newRange;
    this._viewEndTime = this._viewStartTime + newRange;

    this._render();
  }

  /**
   * Pan the time axis by `deltaTime` simulation steps.
   * Positive delta moves the view forward in time.
   */
  pan(deltaTime: number): void {
    this._viewStartTime += deltaTime;
    this._viewEndTime += deltaTime;
    this._render();
  }

  // -------------------------------------------------------------------------
  // Dispose
  // -------------------------------------------------------------------------

  dispose(): void {
    if (this._canvas !== null) {
      this._detachEvents(this._canvas);
    }
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private _render(): void {
    if (this._canvas === null) return;

    const ctx2d = this._canvas.getContext("2d");
    if (ctx2d === null) return;

    const w = this._canvas.width;
    const h = this._canvas.height;

    const ctx = new CanvasRenderContext(ctx2d, w, h);
    ctx.clearRect(0, 0, w, h);

    const vp: WaveformViewport = {
      startTime: this._viewStartTime,
      endTime: this._viewEndTime,
      laneHeight: this._laneHeight,
      leftMargin: this._leftMargin,
    };

    for (let i = 0; i < this._channels.length; i++) {
      const ch = this._channels[i]!;
      const laneY = i * this._laneHeight;
      const samples: WaveformSample[] = ch.getSamples();

      drawChannelLabel(ctx, ch.name, laneY, vp);

      if (ch.width === 1) {
        drawDigitalWaveform(ctx, samples, laneY, vp);
      } else {
        drawBusWaveform(ctx, samples, ch.width, laneY, vp);
      }
    }

    drawTimeAxis(ctx, vp);

    // Time cursor overlay — drawn last so it appears on top of all waveforms
    if (this._cursorX !== null) {
      const cursorTime = this._xToTime(this._cursorX);
      const rows = this.getValuesAtTime(cursorTime);
      drawTimeCursor(ctx, this._cursorX, cursorTime, rows, vp, this._channels.length);
    }
  }

  // -------------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------------

  private _onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
    const pivotTime = this._xToTime(e.offsetX);
    this.zoom(factor, pivotTime);
  };

  private _onMouseDown = (e: MouseEvent): void => {
    this._isDragging = true;
    this._dragStartX = e.offsetX;
    this._dragStartViewStart = this._viewStartTime;
  };

  private _onMouseMove = (e: MouseEvent): void => {
    this._cursorX = e.offsetX;

    if (this._isDragging) {
      const dx = e.offsetX - this._dragStartX;
      const range = this._viewEndTime - this._viewStartTime;
      const drawWidth = (this._canvas?.width ?? 800) - this._leftMargin;
      const deltaTime = -(dx / drawWidth) * range;
      this._viewStartTime = this._dragStartViewStart + deltaTime;
      this._viewEndTime = this._viewStartTime + range;
    }

    this._render();
  };

  private _onMouseLeave = (_e: MouseEvent): void => {
    this._cursorX = null;
    this._render();
  };

  private _onMouseUp = (_e: MouseEvent): void => {
    this._isDragging = false;
  };

  private _onClick = (e: MouseEvent): void => {
    if (!this._isDragging) {
      const time = this._xToTime(e.offsetX);
      this.jumpToTime(time);
    }
  };

  private _xToTime(x: number): number {
    const drawWidth = (this._canvas?.width ?? 800) - this._leftMargin;
    const range = this._viewEndTime - this._viewStartTime;
    return this._viewStartTime + ((x - this._leftMargin) / drawWidth) * range;
  }

  private _attachEvents(canvas: HTMLCanvasElement): void {
    canvas.addEventListener("wheel", this._onWheel, { passive: false });
    canvas.addEventListener("mousedown", this._onMouseDown);
    canvas.addEventListener("mousemove", this._onMouseMove);
    canvas.addEventListener("mouseleave", this._onMouseLeave);
    canvas.addEventListener("mouseup", this._onMouseUp);
    canvas.addEventListener("click", this._onClick);
  }

  private _detachEvents(canvas: HTMLCanvasElement): void {
    canvas.removeEventListener("wheel", this._onWheel);
    canvas.removeEventListener("mousedown", this._onMouseDown);
    canvas.removeEventListener("mousemove", this._onMouseMove);
    canvas.removeEventListener("mouseleave", this._onMouseLeave);
    canvas.removeEventListener("mouseup", this._onMouseUp);
    canvas.removeEventListener("click", this._onClick);
  }
}
