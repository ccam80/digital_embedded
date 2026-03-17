/**
 * Scope cursor renderer — draws cursor lines and measurement readout panel.
 */

import type { ScopeCursors } from "./scope-cursors.js";
import { formatSI } from "./scope-cursors.js";
import type { ScopeViewport } from "./analog-scope-renderer.js";

// ---------------------------------------------------------------------------
// drawCursors
// ---------------------------------------------------------------------------

/**
 * Draws cursor vertical lines and a semi-transparent measurement readout panel.
 *
 * @param ctx Canvas 2D context
 * @param cursors ScopeCursors instance (may have 0, 1, or 2 cursors set)
 * @param viewport Scope viewport for coordinate mapping
 */
export function drawCursors(
  ctx: CanvasRenderingContext2D,
  cursors: ScopeCursors,
  viewport: ScopeViewport,
): void {
  const { x, y, width, height, tStart, tEnd } = viewport;

  const drawLine = (t: number, label: string, color: string): void => {
    if (t < tStart || t > tEnd) return;
    const px = x + ((t - tStart) / (tEnd - tStart)) * width;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(px, y);
    ctx.lineTo(px, y + height);
    ctx.stroke();
    ctx.setLineDash([]);

    // Label at top
    ctx.fillStyle = color;
    ctx.font = "bold 11px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(label, px, y + 2);

    // Time label
    ctx.font = "10px monospace";
    ctx.textBaseline = "top";
    ctx.fillText(formatSI(t, "s"), px, y + 4);
    ctx.restore();
  };

  const { cursorA, cursorB } = cursors;

  if (cursorA !== null) drawLine(cursorA, "A", "#ffcc44");
  if (cursorB !== null) drawLine(cursorB, "B", "#44ccff");
}

// ---------------------------------------------------------------------------
// drawMeasurementPanel
// ---------------------------------------------------------------------------

/**
 * Draws the semi-transparent measurement readout panel showing ΔT, ΔV,
 * frequency, RMS, Vpp, and mean with SI unit formatting.
 *
 * Call this after drawCursors() when both cursors are set and measurements
 * are available.
 *
 * @param ctx Canvas 2D context
 * @param measurements Measurement values (from ScopeCursors.getMeasurements)
 * @param viewport Scope viewport (used to position the panel)
 * @param valueUnit Unit string for voltage/current values (e.g. "V" or "A")
 */
export function drawMeasurementPanel(
  ctx: CanvasRenderingContext2D,
  measurements: {
    deltaT: number;
    frequency: number;
    deltaV: number;
    rms: number;
    peakToPeak: number;
    mean: number;
  },
  viewport: ScopeViewport,
  valueUnit: string = "V",
): void {
  const lines: string[] = [
    `ΔT: ${formatSI(measurements.deltaT, "s")}`,
    `f:  ${formatSI(measurements.frequency, "Hz")}`,
    `ΔV: ${formatSI(measurements.deltaV, valueUnit)}`,
    `RMS: ${formatSI(measurements.rms, valueUnit)}`,
    `Vpp: ${formatSI(measurements.peakToPeak, valueUnit)}`,
    `avg: ${formatSI(measurements.mean, valueUnit)}`,
  ];

  const lineH = 16;
  const padding = 8;
  const panelW = 160;
  const panelH = lines.length * lineH + padding * 2;

  // Position: top-right of viewport
  const panelX = viewport.x + viewport.width - panelW - 8;
  const panelY = viewport.y + 8;

  ctx.save();

  // Semi-transparent background
  ctx.fillStyle = "rgba(0, 0, 0, 0.72)";
  ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
  ctx.lineWidth = 1;

  roundRect(ctx, panelX, panelY, panelW, panelH, 4);
  ctx.fill();
  ctx.stroke();

  // Text
  ctx.fillStyle = "#dddddd";
  ctx.font = "11px monospace";
  ctx.textBaseline = "top";
  ctx.textAlign = "left";

  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i]!, panelX + padding, panelY + padding + i * lineH);
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}
