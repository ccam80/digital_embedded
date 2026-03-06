/**
 * Shape renderer for SubcircuitElement.
 *
 * Renders the four shape modes: DEFAULT, DIL, CUSTOM, LAYOUT.
 * All rendering is done via the engine-agnostic RenderContext.
 */

import type { RenderContext } from "../../core/renderer-interface.js";
import type { PinDeclaration } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";

// ---------------------------------------------------------------------------
// ShapeMode
// ---------------------------------------------------------------------------

export type ShapeMode = "DEFAULT" | "DIL" | "CUSTOM" | "LAYOUT";

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

/**
 * Compute the bounding box dimensions for a subcircuit chip rectangle.
 *
 * Width is fixed at 6 grid units. Height is determined by the maximum of
 * input and output pin counts, with at least 2 grid units per pin slot plus
 * 1 unit padding top and bottom.
 */
export function computeChipDimensions(
  inputCount: number,
  outputCount: number,
): { width: number; height: number } {
  const pinRows = Math.max(inputCount, outputCount, 1);
  const height = pinRows + 2;
  return { width: 6, height };
}

// ---------------------------------------------------------------------------
// DEFAULT shape — labeled rectangle with pin stubs and pin name labels
// ---------------------------------------------------------------------------

/**
 * Render the DEFAULT chip shape: a labeled rectangle with pin names on the
 * left (input) and right (output) faces.
 */
export function drawDefaultShape(
  ctx: RenderContext,
  name: string,
  pins: readonly PinDeclaration[],
  width: number,
  height: number,
): void {
  ctx.setColor("COMPONENT_FILL");
  ctx.drawRect(0, 0, width, height, true);
  ctx.setColor("COMPONENT");
  ctx.setLineWidth(1);
  ctx.drawRect(0, 0, width, height, false);

  ctx.setColor("TEXT");
  ctx.setFont({ family: "sans-serif", size: 1.0, weight: "bold" });
  ctx.drawText(name, width / 2, height / 2, { horizontal: "center", vertical: "middle" });

  ctx.setFont({ family: "sans-serif", size: 0.7 });

  for (const pin of pins) {
    if (pin.direction === PinDirection.INPUT) {
      ctx.drawLine(pin.position.x, pin.position.y, pin.position.x + 1, pin.position.y);
      ctx.drawText(pin.label, pin.position.x + 1.1, pin.position.y, {
        horizontal: "left",
        vertical: "middle",
      });
    } else {
      ctx.drawLine(pin.position.x, pin.position.y, pin.position.x - 1, pin.position.y);
      ctx.drawText(pin.label, pin.position.x - 1.1, pin.position.y, {
        horizontal: "right",
        vertical: "middle",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// DIL shape — DIP IC package appearance
// ---------------------------------------------------------------------------

/**
 * Render the DIL (Dual In-line) shape: a DIP IC package appearance with
 * a notch at the top center and alternating pin numbers down each side.
 */
export function drawDILShape(
  ctx: RenderContext,
  name: string,
  pins: readonly PinDeclaration[],
  width: number,
  height: number,
): void {
  ctx.setColor("COMPONENT_FILL");
  ctx.drawRect(0, 0, width, height, true);
  ctx.setColor("COMPONENT");
  ctx.setLineWidth(1);
  ctx.drawRect(0, 0, width, height, false);

  const notchRadius = 0.6;
  ctx.drawArc(width / 2, 0, notchRadius, Math.PI, 0);

  ctx.setColor("TEXT");
  ctx.setFont({ family: "sans-serif", size: 0.8, weight: "bold" });
  ctx.drawText(name, width / 2, height / 2, { horizontal: "center", vertical: "middle" });

  ctx.setFont({ family: "sans-serif", size: 0.6 });

  for (const pin of pins) {
    if (pin.direction === PinDirection.INPUT) {
      ctx.drawLine(pin.position.x, pin.position.y, pin.position.x + 0.8, pin.position.y);
      ctx.drawText(pin.label, pin.position.x + 0.9, pin.position.y, {
        horizontal: "left",
        vertical: "middle",
      });
    } else {
      ctx.drawLine(pin.position.x, pin.position.y, pin.position.x - 0.8, pin.position.y);
      ctx.drawText(pin.label, pin.position.x - 0.9, pin.position.y, {
        horizontal: "right",
        vertical: "middle",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// CUSTOM shape — SVG-based placeholder
// ---------------------------------------------------------------------------

/**
 * Render the CUSTOM shape mode. When no SVG data is available, falls back to
 * the DEFAULT chip shape with a note that custom rendering is pending.
 */
export function drawCustomShape(
  ctx: RenderContext,
  name: string,
  pins: readonly PinDeclaration[],
  width: number,
  height: number,
): void {
  drawDefaultShape(ctx, name, pins, width, height);
}

// ---------------------------------------------------------------------------
// LAYOUT shape — miniature rendering of subcircuit internals
// ---------------------------------------------------------------------------

/**
 * Render the LAYOUT shape mode. Draws a scaled-down representation of the
 * subcircuit boundary as a chip rectangle. Full internal rendering requires
 * access to the circuit's element list and is deferred to the editor layer.
 * This renderer draws the shell only.
 */
export function drawLayoutShape(
  ctx: RenderContext,
  name: string,
  pins: readonly PinDeclaration[],
  width: number,
  height: number,
): void {
  ctx.setColor("COMPONENT_FILL");
  ctx.drawRect(0, 0, width, height, true);
  ctx.setColor("COMPONENT");
  ctx.setLineWidth(1);
  ctx.setLineDash([0.5, 0.5]);
  ctx.drawRect(0, 0, width, height, false);
  ctx.setLineDash([]);

  ctx.setColor("TEXT");
  ctx.setFont({ family: "sans-serif", size: 0.8 });
  ctx.drawText(name, width / 2, 0.6, { horizontal: "center", vertical: "middle" });

  for (const pin of pins) {
    if (pin.direction === PinDirection.INPUT) {
      ctx.drawLine(pin.position.x, pin.position.y, pin.position.x + 0.5, pin.position.y);
    } else {
      ctx.drawLine(pin.position.x, pin.position.y, pin.position.x - 0.5, pin.position.y);
    }
  }
}
