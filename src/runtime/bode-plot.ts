/**
 * Bode plot renderer — draws magnitude and phase frequency-response plots.
 *
 * Renders AC analysis results (AcResult from ac-analysis.ts) onto a
 * CanvasRenderingContext2D. The plot is divided into two panels sharing a
 * common log-frequency axis:
 *
 *   Top panel:    magnitude in dB vs log frequency
 *   Bottom panel: phase in degrees vs log frequency
 *
 * Grid lines at standard engineering intervals, multiple output-node traces
 * with distinct colors, and automatic detection and labeling of the -3dB
 * point, unity-gain crossing, and phase margin.
 */

import type { AcResult } from "../analog/ac-analysis.js";

// ---------------------------------------------------------------------------
// BodeViewport — layout parameters for the Bode plot canvas region
// ---------------------------------------------------------------------------

/**
 * Describes the canvas region and data range for a Bode plot.
 */
export interface BodeViewport {
  /** Left edge of the plot area in canvas pixels. */
  x: number;
  /** Top edge of the plot area in canvas pixels. */
  y: number;
  /** Total width of the plot area in canvas pixels. */
  width: number;
  /** Total height of the plot area in canvas pixels. */
  height: number;
  /** Minimum frequency for the horizontal axis (Hz). */
  fMin: number;
  /** Maximum frequency for the horizontal axis (Hz). */
  fMax: number;
  /** Minimum magnitude for the top panel y-axis (dB). */
  magMin: number;
  /** Maximum magnitude for the top panel y-axis (dB). */
  magMax: number;
  /** Minimum phase for the bottom panel y-axis (degrees). */
  phaseMin: number;
  /** Maximum phase for the bottom panel y-axis (degrees). */
  phaseMax: number;
}

// ---------------------------------------------------------------------------
// BodeCursor — cursor state for interactive frequency readout
// ---------------------------------------------------------------------------

/**
 * Optional cursor state. When set, a vertical line is drawn at the cursor
 * frequency and exact dB / phase values are displayed.
 */
export interface BodeCursor {
  /** Cursor frequency in Hz. */
  frequency: number;
}

// ---------------------------------------------------------------------------
// BodeMarker — auto-detected frequency-domain features
// ---------------------------------------------------------------------------

export interface BodeMarker {
  type: "-3dB" | "unity-gain" | "phase-margin";
  frequency: number;
  /** Trace label this marker belongs to. */
  traceLabel: string;
  /** Value at the marker (dB for magnitude markers, degrees for phase margin). */
  value: number;
}

// ---------------------------------------------------------------------------
// Trace colors
// ---------------------------------------------------------------------------

const TRACE_COLORS = [
  "#4a9eff",  // blue
  "#ff6b6b",  // red
  "#51cf66",  // green
  "#ffd43b",  // yellow
  "#cc5de8",  // purple
  "#ff922b",  // orange
  "#20c997",  // teal
  "#f06595",  // pink
];

// ---------------------------------------------------------------------------
// Standard grid intervals
// ---------------------------------------------------------------------------

/** Standard dB grid lines. */
const DB_GRID_LINES = [60, 40, 20, 0, -3, -20, -40, -60, -80, -100, -120];

/** Standard phase grid lines in degrees. */
const PHASE_GRID_LINES = [180, 135, 90, 45, 0, -45, -90, -135, -180, -225, -270];

// ---------------------------------------------------------------------------
// BodePlotRenderer
// ---------------------------------------------------------------------------

/**
 * Renders Bode magnitude and phase plots from an AcResult onto a canvas.
 */
export class BodePlotRenderer {
  // Axis margin for labels (pixels)
  private static readonly MARGIN_LEFT = 60;
  private static readonly MARGIN_RIGHT = 20;
  private static readonly MARGIN_TOP = 10;
  private static readonly MARGIN_BOTTOM = 30;
  private static readonly GAP = 10; // gap between mag and phase panels

  /**
   * Render a complete Bode plot (magnitude + phase) onto the canvas context.
   *
   * @param ctx      - Canvas 2D rendering context
   * @param result   - AC analysis result from AcAnalysis.run()
   * @param viewport - Layout and axis range parameters
   * @param cursor   - Optional cursor for frequency readout
   */
  render(
    ctx: CanvasRenderingContext2D,
    result: AcResult,
    viewport: BodeViewport,
    cursor?: BodeCursor,
  ): void {
    const M = BodePlotRenderer.MARGIN_LEFT;
    const MR = BodePlotRenderer.MARGIN_RIGHT;
    const MT = BodePlotRenderer.MARGIN_TOP;
    const MB = BodePlotRenderer.MARGIN_BOTTOM;
    const GAP = BodePlotRenderer.GAP;

    // Split height equally between magnitude and phase panels
    const totalInner = viewport.height - MT - MB;
    const panelH = (totalInner - GAP) / 2;
    const panelW = viewport.width - M - MR;

    const magPanel = {
      x: viewport.x + M,
      y: viewport.y + MT,
      w: panelW,
      h: panelH,
    };

    const phasePanel = {
      x: viewport.x + M,
      y: viewport.y + MT + panelH + GAP,
      w: panelW,
      h: panelH,
    };

    // Save context state
    ctx.save();

    // Draw panel backgrounds
    ctx.fillStyle = "#1a1a2e";
    ctx.fillRect(magPanel.x, magPanel.y, magPanel.w, magPanel.h);
    ctx.fillRect(phasePanel.x, phasePanel.y, phasePanel.w, phasePanel.h);

    // Draw grid
    this._drawMagnitudeGrid(ctx, magPanel, viewport);
    this._drawPhaseGrid(ctx, phasePanel, viewport);

    // Draw frequency axis labels (bottom of phase panel)
    this._drawFrequencyAxis(ctx, phasePanel, viewport);

    // Draw traces for each output node
    const labels = Array.from(result.magnitude.keys());
    labels.forEach((label, i) => {
      const color = TRACE_COLORS[i % TRACE_COLORS.length];
      this._drawMagnitudeTrace(ctx, result, label, color, magPanel, viewport);
      this._drawPhaseTrace(ctx, result, label, color, phasePanel, viewport);
    });

    // Draw cursor
    if (cursor !== undefined) {
      this._drawCursor(ctx, cursor, result, magPanel, phasePanel, viewport);
    }

    // Draw axis labels
    this._drawAxisLabels(ctx, magPanel, phasePanel, viewport);

    // Panel borders
    ctx.strokeStyle = "#444";
    ctx.lineWidth = 1;
    ctx.strokeRect(magPanel.x, magPanel.y, magPanel.w, magPanel.h);
    ctx.strokeRect(phasePanel.x, phasePanel.y, phasePanel.w, phasePanel.h);

    ctx.restore();
  }

  /**
   * Detect frequency-domain markers: -3dB point, unity-gain crossing, phase margin.
   *
   * @param result - AC analysis result
   * @returns Array of detected markers
   */
  detectMarkers(result: AcResult): BodeMarker[] {
    const markers: BodeMarker[] = [];
    const freqs = result.frequencies;

    for (const [label, magArray] of result.magnitude) {
      const phaseArray = result.phase.get(label);

      // -3dB point: first frequency where magnitude drops below (mag[0] - 3)
      const dcGain = magArray[0];
      const threshold3db = dcGain - 3.01;
      for (let i = 1; i < freqs.length; i++) {
        if (magArray[i] <= threshold3db && magArray[i - 1] > threshold3db) {
          // Interpolate
          const f = this._interpolateFreq(
            freqs[i - 1], freqs[i],
            magArray[i - 1], magArray[i],
            threshold3db,
          );
          markers.push({
            type: "-3dB",
            frequency: f,
            traceLabel: label,
            value: threshold3db,
          });
          break;
        }
      }

      // Unity-gain crossing: first frequency where magnitude crosses 0 dB
      for (let i = 1; i < freqs.length; i++) {
        if (magArray[i] <= 0 && magArray[i - 1] > 0) {
          const f = this._interpolateFreq(
            freqs[i - 1], freqs[i],
            magArray[i - 1], magArray[i],
            0,
          );
          markers.push({
            type: "unity-gain",
            frequency: f,
            traceLabel: label,
            value: 0,
          });

          // Phase margin: phase at unity-gain crossing + 180
          if (phaseArray) {
            const phaseAtCrossing = this._interpolatePhase(
              freqs[i - 1], freqs[i],
              phaseArray[i - 1], phaseArray[i],
              f,
            );
            const phaseMargin = phaseAtCrossing + 180;
            markers.push({
              type: "phase-margin",
              frequency: f,
              traceLabel: label,
              value: phaseMargin,
            });
          }
          break;
        }
      }
    }

    return markers;
  }

  // ---------------------------------------------------------------------------
  // Private drawing helpers
  // ---------------------------------------------------------------------------

  private _drawMagnitudeGrid(
    ctx: CanvasRenderingContext2D,
    panel: { x: number; y: number; w: number; h: number },
    vp: BodeViewport,
  ): void {
    ctx.strokeStyle = "#333";
    ctx.lineWidth = 0.5;
    ctx.fillStyle = "#888";
    ctx.font = "10px monospace";
    ctx.textAlign = "right";

    for (const db of DB_GRID_LINES) {
      if (db < vp.magMin || db > vp.magMax) continue;
      const py = this._magToPixel(db, panel, vp);

      ctx.beginPath();
      ctx.moveTo(panel.x, py);
      ctx.lineTo(panel.x + panel.w, py);
      ctx.stroke();

      ctx.fillText(`${db}`, panel.x - 4, py + 4);
    }

    // Vertical frequency grid lines
    this._drawFrequencyGridLines(ctx, panel, vp);
  }

  private _drawPhaseGrid(
    ctx: CanvasRenderingContext2D,
    panel: { x: number; y: number; w: number; h: number },
    vp: BodeViewport,
  ): void {
    ctx.strokeStyle = "#333";
    ctx.lineWidth = 0.5;
    ctx.fillStyle = "#888";
    ctx.font = "10px monospace";
    ctx.textAlign = "right";

    for (const deg of PHASE_GRID_LINES) {
      if (deg < vp.phaseMin || deg > vp.phaseMax) continue;
      const py = this._phaseToPixel(deg, panel, vp);

      ctx.beginPath();
      ctx.moveTo(panel.x, py);
      ctx.lineTo(panel.x + panel.w, py);
      ctx.stroke();

      ctx.fillText(`${deg}°`, panel.x - 4, py + 4);
    }

    // Vertical frequency grid lines
    this._drawFrequencyGridLines(ctx, panel, vp);
  }

  private _drawFrequencyGridLines(
    ctx: CanvasRenderingContext2D,
    panel: { x: number; y: number; w: number; h: number },
    vp: BodeViewport,
  ): void {
    ctx.strokeStyle = "#2a2a3e";
    ctx.lineWidth = 0.5;

    const logMin = Math.log10(vp.fMin);
    const logMax = Math.log10(vp.fMax);
    const startDecade = Math.floor(logMin);
    const endDecade = Math.ceil(logMax);

    for (let d = startDecade; d <= endDecade; d++) {
      for (let m = 1; m <= 9; m++) {
        const f = m * Math.pow(10, d);
        if (f < vp.fMin || f > vp.fMax) continue;
        const px = this._freqToPixel(f, panel, vp);

        ctx.beginPath();
        ctx.moveTo(px, panel.y);
        ctx.lineTo(px, panel.y + panel.h);
        ctx.stroke();
      }
    }
  }

  private _drawFrequencyAxis(
    ctx: CanvasRenderingContext2D,
    panel: { x: number; y: number; w: number; h: number },
    vp: BodeViewport,
  ): void {
    ctx.fillStyle = "#aaa";
    ctx.font = "10px monospace";
    ctx.textAlign = "center";

    const logMin = Math.log10(vp.fMin);
    const logMax = Math.log10(vp.fMax);
    const startDecade = Math.floor(logMin);
    const endDecade = Math.ceil(logMax);

    for (let d = startDecade; d <= endDecade; d++) {
      const f = Math.pow(10, d);
      if (f < vp.fMin || f > vp.fMax) continue;
      const px = this._freqToPixel(f, panel, vp);
      const label = this._formatFrequency(f);

      ctx.fillText(label, px, panel.y + panel.h + 18);
    }
  }

  private _drawMagnitudeTrace(
    ctx: CanvasRenderingContext2D,
    result: AcResult,
    label: string,
    color: string,
    panel: { x: number; y: number; w: number; h: number },
    vp: BodeViewport,
  ): void {
    const freqs = result.frequencies;
    const mag = result.magnitude.get(label);
    if (!mag || freqs.length === 0) return;

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    let started = false;
    for (let i = 0; i < freqs.length; i++) {
      const f = freqs[i];
      if (f < vp.fMin || f > vp.fMax) continue;
      const px = this._freqToPixel(f, panel, vp);
      const py = this._magToPixel(mag[i], panel, vp);

      if (!started) {
        ctx.moveTo(px, py);
        started = true;
      } else {
        ctx.lineTo(px, py);
      }
    }
    ctx.stroke();
  }

  private _drawPhaseTrace(
    ctx: CanvasRenderingContext2D,
    result: AcResult,
    label: string,
    color: string,
    panel: { x: number; y: number; w: number; h: number },
    vp: BodeViewport,
  ): void {
    const freqs = result.frequencies;
    const phase = result.phase.get(label);
    if (!phase || freqs.length === 0) return;

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    let started = false;
    for (let i = 0; i < freqs.length; i++) {
      const f = freqs[i];
      if (f < vp.fMin || f > vp.fMax) continue;
      const px = this._freqToPixel(f, panel, vp);
      const py = this._phaseToPixel(phase[i], panel, vp);

      if (!started) {
        ctx.moveTo(px, py);
        started = true;
      } else {
        ctx.lineTo(px, py);
      }
    }
    ctx.stroke();
  }

  private _drawCursor(
    ctx: CanvasRenderingContext2D,
    cursor: BodeCursor,
    result: AcResult,
    magPanel: { x: number; y: number; w: number; h: number },
    phasePanel: { x: number; y: number; w: number; h: number },
    vp: BodeViewport,
  ): void {
    if (cursor.frequency < vp.fMin || cursor.frequency > vp.fMax) return;

    const pxMag = this._freqToPixel(cursor.frequency, magPanel, vp);
    const pxPhase = this._freqToPixel(cursor.frequency, phasePanel, vp);

    // Draw vertical cursor lines
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);

    ctx.beginPath();
    ctx.moveTo(pxMag, magPanel.y);
    ctx.lineTo(pxMag, magPanel.y + magPanel.h);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(pxPhase, phasePanel.y);
    ctx.lineTo(pxPhase, phasePanel.y + phasePanel.h);
    ctx.stroke();

    ctx.setLineDash([]);

    // Find interpolated values at cursor frequency
    const freqs = result.frequencies;
    const idx = this._findClosestIndex(freqs, cursor.frequency);

    const labels = Array.from(result.magnitude.keys());
    labels.forEach((label, i) => {
      const color = TRACE_COLORS[i % TRACE_COLORS.length];
      const magArr = result.magnitude.get(label)!;
      const phaseArr = result.phase.get(label)!;

      const magVal = magArr[idx];
      const phaseVal = phaseArr[idx];

      // Draw readout labels
      ctx.fillStyle = color;
      ctx.font = "10px monospace";
      ctx.textAlign = "left";
      const yTextMag = magPanel.y + 12 + i * 14;
      const yTextPhase = phasePanel.y + 12 + i * 14;
      ctx.fillText(`${label}: ${magVal.toFixed(1)}dB`, pxMag + 4, yTextMag);
      ctx.fillText(`${label}: ${phaseVal.toFixed(1)}°`, pxPhase + 4, yTextPhase);
    });
  }

  private _drawAxisLabels(
    ctx: CanvasRenderingContext2D,
    magPanel: { x: number; y: number; w: number; h: number },
    phasePanel: { x: number; y: number; w: number; h: number },
    _vp: BodeViewport,
  ): void {
    ctx.fillStyle = "#ccc";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";

    // Y-axis label for magnitude panel (rotated)
    ctx.save();
    ctx.translate(magPanel.x - 45, magPanel.y + magPanel.h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("Magnitude (dB)", 0, 0);
    ctx.restore();

    // Y-axis label for phase panel (rotated)
    ctx.save();
    ctx.translate(phasePanel.x - 45, phasePanel.y + phasePanel.h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("Phase (°)", 0, 0);
    ctx.restore();

    // X-axis label
    ctx.fillText(
      "Frequency (Hz)",
      phasePanel.x + phasePanel.w / 2,
      phasePanel.y + phasePanel.h + 28,
    );
  }

  // ---------------------------------------------------------------------------
  // Coordinate mapping
  // ---------------------------------------------------------------------------

  private _freqToPixel(
    f: number,
    panel: { x: number; y: number; w: number; h: number },
    vp: BodeViewport,
  ): number {
    const logF = Math.log10(Math.max(f, 1e-10));
    const logMin = Math.log10(vp.fMin);
    const logMax = Math.log10(vp.fMax);
    return panel.x + ((logF - logMin) / (logMax - logMin)) * panel.w;
  }

  private _magToPixel(
    db: number,
    panel: { x: number; y: number; w: number; h: number },
    vp: BodeViewport,
  ): number {
    return panel.y + panel.h - ((db - vp.magMin) / (vp.magMax - vp.magMin)) * panel.h;
  }

  private _phaseToPixel(
    deg: number,
    panel: { x: number; y: number; w: number; h: number },
    vp: BodeViewport,
  ): number {
    return panel.y + panel.h - ((deg - vp.phaseMin) / (vp.phaseMax - vp.phaseMin)) * panel.h;
  }

  // ---------------------------------------------------------------------------
  // Marker helpers
  // ---------------------------------------------------------------------------

  private _interpolateFreq(
    f1: number, f2: number,
    v1: number, v2: number,
    target: number,
  ): number {
    if (v1 === v2) return f1;
    const t = (target - v1) / (v2 - v1);
    // Log-interpolate frequencies
    const lf1 = Math.log10(f1);
    const lf2 = Math.log10(f2);
    return Math.pow(10, lf1 + t * (lf2 - lf1));
  }

  private _interpolatePhase(
    f1: number, f2: number,
    p1: number, p2: number,
    targetF: number,
  ): number {
    if (f1 === f2) return p1;
    const lf1 = Math.log10(f1);
    const lf2 = Math.log10(f2);
    const lft = Math.log10(targetF);
    const t = (lft - lf1) / (lf2 - lf1);
    return p1 + t * (p2 - p1);
  }

  private _findClosestIndex(freqs: Float64Array, target: number): number {
    let minDiff = Infinity;
    let idx = 0;
    for (let i = 0; i < freqs.length; i++) {
      const diff = Math.abs(freqs[i] - target);
      if (diff < minDiff) {
        minDiff = diff;
        idx = i;
      }
    }
    return idx;
  }

  private _formatFrequency(f: number): string {
    if (f >= 1e6) return `${f / 1e6}M`;
    if (f >= 1e3) return `${f / 1e3}k`;
    return `${f}`;
  }
}
