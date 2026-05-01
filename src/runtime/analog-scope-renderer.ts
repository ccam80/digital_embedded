/**
 * Scope renderer- drawing utilities for the ScopePanel.
 *
 * All functions draw onto a CanvasRenderingContext2D directly. The scope
 * panel is a standalone runtime panel (not an editor-canvas overlay), so
 * the engine-agnostic RenderContext abstraction does not apply here.
 */

// ---------------------------------------------------------------------------
// ScopeViewport- maps simulation time/value to canvas pixels
// ---------------------------------------------------------------------------

/**
 * Describes the visible region of the scope and how to map it to pixels.
 *
 * Fields `x, y, width, height` are canvas-pixel coordinates of the drawable
 * area (excluding axis margins). `tStart/tEnd` are the visible simulation
 * time range (seconds). `yMin/yMax` are the visible value range.
 */
export interface ScopeViewport {
  /** Left edge of the drawable area in canvas pixels. */
  x: number;
  /** Top edge of the drawable area in canvas pixels. */
  y: number;
  /** Width of the drawable area in canvas pixels. */
  width: number;
  /** Height of the drawable area in canvas pixels. */
  height: number;
  /** Simulation time at the left edge (seconds). */
  tStart: number;
  /** Simulation time at the right edge (seconds). */
  tEnd: number;
  /** Minimum value (bottom of visible area). */
  yMin: number;
  /** Maximum value (top of visible area). */
  yMax: number;
}

// ---------------------------------------------------------------------------
// Coordinate helpers
// ---------------------------------------------------------------------------

function timeToPixel(t: number, vp: ScopeViewport): number {
  return vp.x + ((t - vp.tStart) / (vp.tEnd - vp.tStart)) * vp.width;
}

function valueToPixel(v: number, vp: ScopeViewport): number {
  return vp.y + vp.height - ((v - vp.yMin) / (vp.yMax - vp.yMin)) * vp.height;
}

// ---------------------------------------------------------------------------
// drawPolylineTrace
// ---------------------------------------------------------------------------

/**
 * Draws a point-to-point polyline trace for zoomed-in views (< 1000 samples).
 */
export function drawPolylineTrace(
  ctx: CanvasRenderingContext2D,
  samples: { time: Float64Array; value: Float64Array },
  viewport: ScopeViewport,
  color: string,
): void {
  const { time, value } = samples;
  if (time.length === 0) return;

  ctx.save();
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;

  for (let i = 0; i < time.length; i++) {
    const px = timeToPixel(time[i], viewport);
    const py = valueToPixel(value[i], viewport);
    if (i === 0) {
      ctx.moveTo(px, py);
    } else {
      ctx.lineTo(px, py);
    }
  }

  ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// drawEnvelopeTrace
// ---------------------------------------------------------------------------

/**
 * Draws a min/max envelope band for zoomed-out views (>= 1000 visible samples).
 */
export function drawEnvelopeTrace(
  ctx: CanvasRenderingContext2D,
  envelope: { time: Float64Array; min: Float64Array; max: Float64Array },
  viewport: ScopeViewport,
  color: string,
): void {
  const { time, min, max } = envelope;
  if (time.length === 0) return;

  ctx.save();

  // Draw the filled band (max path forward, min path backward)
  ctx.beginPath();
  for (let i = 0; i < time.length; i++) {
    const px = timeToPixel(time[i], viewport);
    const py = valueToPixel(max[i], viewport);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  for (let i = time.length - 1; i >= 0; i--) {
    const px = timeToPixel(time[i], viewport);
    const py = valueToPixel(min[i], viewport);
    ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = color + "40";
  ctx.fill();

  // Draw max line on top
  ctx.beginPath();
  for (let i = 0; i < time.length; i++) {
    const px = timeToPixel(time[i], viewport);
    const py = valueToPixel(max[i], viewport);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.restore();
}

// ---------------------------------------------------------------------------
// drawYAxis
// ---------------------------------------------------------------------------

/**
 * Draws a Y axis with labels and horizontal grid lines.
 *
 * @param ctx Canvas 2D context
 * @param range [min, max] value range
 * @param viewport Scope viewport
 * @param unit Unit label string (e.g. "V" or "A")
 * @param side 'left' or 'right'
 */
export function drawYAxis(
  ctx: CanvasRenderingContext2D,
  range: [number, number],
  viewport: ScopeViewport,
  unit: string,
  side: "left" | "right",
): void {
  const [yMin, yMax] = range;
  if (yMax <= yMin) return;

  const span = yMax - yMin;
  const interval = chooseGridInterval(span, 6);
  if (interval <= 0) return;

  ctx.save();
  ctx.font = "10px monospace";
  ctx.fillStyle = "#aaaaaa";
  ctx.strokeStyle = "#333333";
  ctx.lineWidth = 1;
  ctx.textBaseline = "middle";
  ctx.textAlign = side === "left" ? "right" : "left";

  const axisX = side === "left" ? viewport.x : viewport.x + viewport.width;
  const labelXOffset = side === "left" ? -4 : 4;

  const start = Math.ceil(yMin / interval) * interval;

  for (let v = start; v <= yMax + interval * 0.5; v += interval) {
    const py = valueToPixel(v, viewport);

    // Horizontal grid line
    ctx.beginPath();
    ctx.moveTo(viewport.x, py);
    ctx.lineTo(viewport.x + viewport.width, py);
    ctx.strokeStyle = "#333333";
    ctx.stroke();

    // Tick
    ctx.beginPath();
    ctx.moveTo(axisX, py);
    ctx.lineTo(axisX + (side === "left" ? -4 : 4), py);
    ctx.strokeStyle = "#aaaaaa";
    ctx.stroke();

    // Label
    const label = `${v.toPrecision(3)} ${unit}`;
    ctx.fillText(label, axisX + labelXOffset, py);
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// chooseGridInterval- picks a nice grid spacing using the 1-2-5 sequence
// ---------------------------------------------------------------------------

/**
 * Chooses a grid interval targeting approximately `targetLines` lines for
 * a given value `span`. Uses the 1-2-5 × 10^n sequence.
 */
export function chooseGridInterval(span: number, targetLines: number): number {
  if (span <= 0 || targetLines <= 0) return 0;
  const raw = span / targetLines;
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const factor of [1, 2, 5, 10]) {
    const candidate = magnitude * factor;
    if (span / candidate <= targetLines) {
      return candidate;
    }
  }
  return magnitude * 10;
}
