/**
 * Shared drawing helpers for analog component draw() methods.
 */

import type { RenderContext } from "../core/renderer-interface.js";
import type { PinVoltageAccess } from "../core/pin-voltage-access.js";

/**
 * Set the stroke color based on a pin voltage (if available) then draw a line.
 *
 * When `signals` is present and `voltage` is defined, the stroke is set to the
 * voltage-mapped color via `ctx.setRawColor`. Otherwise the stroke falls back
 * to the theme's COMPONENT color. The line is always drawn.
 */
export function drawColoredLead(
  ctx: RenderContext,
  signals: PinVoltageAccess | undefined,
  voltage: number | undefined,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): void {
  if (signals !== undefined && voltage !== undefined && ctx.setRawColor) {
    ctx.setRawColor(signals.voltageColor(voltage));
  } else {
    ctx.setColor("COMPONENT");
  }
  ctx.drawLine(x1, y1, x2, y2);
}
