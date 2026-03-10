/**
 * Shape renderer for SubcircuitElement.
 *
 * Renders the four shape modes: DEFAULT, DIL, CUSTOM, LAYOUT.
 * All rendering is done via the engine-agnostic RenderContext.
 *
 * Chip rect has a 0.5 grid-unit border above and below the pin area,
 * matching Digital's topBottomBorder = SIZE2.
 */

import type { RenderContext } from "../../core/renderer-interface.js";
import type { PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";

// ---------------------------------------------------------------------------
// ShapeMode
// ---------------------------------------------------------------------------

export type ShapeMode = "DEFAULT" | "SIMPLE" | "DIL" | "CUSTOM" | "LAYOUT" | "MINIMIZED";

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

/** Border above/below pin area (Digital's SIZE2 = 0.5 grid units). */
const BORDER = 0.5;

/**
 * Compute the bounding box dimensions for a subcircuit chip rectangle.
 *
 * Matches Digital's GenericShape: width is fixed at 3 grid units.
 * Height is max(inputs, outputs) in grid units (one grid unit per pin row).
 *
 * @deprecated Dimensions are now computed per shape mode in SubcircuitElement.
 */
export function computeChipDimensions(
  inputCount: number,
  outputCount: number,
): { width: number; height: number } {
  const pinRows = Math.max(inputCount, outputCount, 1);
  return { width: 3, height: pinRows };
}

// ---------------------------------------------------------------------------
// Upright text helper — counter-rotates text when component is at 180°
// ---------------------------------------------------------------------------

/**
 * Draw text that stays upright regardless of component rotation.
 * When rotation is 2 (180°), counter-rotates the text 180° around its anchor
 * and flips alignment so labels extend in the correct direction.
 */
function drawUprightText(
  ctx: RenderContext,
  text: string,
  x: number,
  y: number,
  align: { horizontal: "left" | "center" | "right"; vertical: "top" | "middle" | "bottom" },
  rotation: Rotation,
): void {
  if (rotation === 2) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.PI);
    // Flip alignment: counter-rotation reverses the coordinate axes,
    // so "left" becomes "right" and "top" becomes "bottom".
    const flipped = {
      horizontal: align.horizontal === "left" ? "right" as const
        : align.horizontal === "right" ? "left" as const
        : "center" as const,
      vertical: align.vertical === "top" ? "bottom" as const
        : align.vertical === "bottom" ? "top" as const
        : "middle" as const,
    };
    ctx.drawText(text, 0, 0, flipped);
    ctx.restore();
  } else {
    ctx.drawText(text, x, y, align);
  }
}

// Bus width indicators are now drawn on wire segments by WireRenderer.renderBusWidthMarkers().

// ---------------------------------------------------------------------------
// Pin rendering helper
// ---------------------------------------------------------------------------

function drawPins(
  ctx: RenderContext,
  pins: readonly PinDeclaration[],
  _width: number,
  stubLength: number,
  showLabels: boolean,
  fontSize: number,
  rotation: Rotation = 0,
): void {
  ctx.setFont({ family: "sans-serif", size: fontSize });

  for (const pin of pins) {
    ctx.setColor("COMPONENT");
    if (pin.direction === PinDirection.INPUT) {
      ctx.drawLine(pin.position.x, pin.position.y, pin.position.x + stubLength, pin.position.y);
      if (showLabels) {
        ctx.setColor("TEXT");
        drawUprightText(ctx, pin.label, pin.position.x + stubLength + 0.1, pin.position.y, {
          horizontal: "left",
          vertical: "middle",
        }, rotation);
      }
    } else {
      ctx.drawLine(pin.position.x, pin.position.y, pin.position.x - stubLength, pin.position.y);
      if (showLabels) {
        ctx.setColor("TEXT");
        drawUprightText(ctx, pin.label, pin.position.x - stubLength - 0.1, pin.position.y, {
          horizontal: "right",
          vertical: "middle",
        }, rotation);
      }
    }
  }
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
  rotation: Rotation = 0,
): void {
  // Chip rect with border
  const rectY = -BORDER;
  const rectH = height - 1 + 2 * BORDER;

  ctx.setColor("COMPONENT_FILL");
  ctx.drawRect(0, rectY, width, rectH, true);
  ctx.setColor("COMPONENT");
  ctx.setLineWidth(1);
  ctx.drawRect(0, rectY, width, rectH, false);

  // Name label (centered in chip rect, stays upright at 180°)
  ctx.setColor("TEXT");
  ctx.setFont({ family: "sans-serif", size: 0.8, weight: "bold" });
  drawUprightText(ctx, name, width / 2, (height - 1) / 2, { horizontal: "center", vertical: "middle" }, rotation);

  // Pin stubs and labels
  drawPins(ctx, pins, width, 0.5, true, 0.55, rotation);
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
  rotation: Rotation = 0,
): void {
  const rectY = -BORDER;
  const rectH = height - 1 + 2 * BORDER;

  ctx.setColor("COMPONENT_FILL");
  ctx.drawRect(0, rectY, width, rectH, true);
  ctx.setColor("COMPONENT");
  ctx.setLineWidth(1);
  ctx.drawRect(0, rectY, width, rectH, false);

  const notchRadius = 0.4;
  ctx.drawArc(width / 2, rectY, notchRadius, Math.PI, 0);

  ctx.setColor("TEXT");
  ctx.setFont({ family: "sans-serif", size: 0.7, weight: "bold" });
  drawUprightText(ctx, name, width / 2, (height - 1) / 2, { horizontal: "center", vertical: "middle" }, rotation);

  drawPins(ctx, pins, width, 0.5, true, 0.5, rotation);
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
  rotation: Rotation = 0,
): void {
  drawDefaultShape(ctx, name, pins, width, height, rotation);
}

// ---------------------------------------------------------------------------
// LAYOUT shape — miniature rendering of subcircuit internals
// ---------------------------------------------------------------------------

/**
 * Render the LAYOUT shape mode. The chip rectangle spans the full declared
 * width × height, matching Digital's LayoutShape. Pin positions are
 * distributed across the face rather than packed sequentially.
 */
export function drawLayoutShape(
  ctx: RenderContext,
  name: string,
  pins: readonly PinDeclaration[],
  width: number,
  height: number,
  rotation: Rotation = 0,
): void {
  // LAYOUT chip rect: origin at (0,0), full width × height
  ctx.setColor("COMPONENT_FILL");
  ctx.drawRect(0, 0, width, height, true);
  ctx.setColor("COMPONENT");
  ctx.setLineWidth(1);
  ctx.drawRect(0, 0, width, height, false);

  // Determine label placement based on which faces have pins
  const hasBottom = pins.some(p => p.face === "bottom");
  const hasTop = pins.some(p => p.face === "top");

  ctx.setColor("TEXT");
  ctx.setFont({ family: "sans-serif", size: 0.6 });
  if (!hasBottom) {
    drawUprightText(ctx, name, width / 2, height + 0.2, { horizontal: "center", vertical: "top" }, rotation);
  } else if (!hasTop) {
    drawUprightText(ctx, name, width / 2, -0.2, { horizontal: "center", vertical: "bottom" }, rotation);
  } else {
    drawUprightText(ctx, name, width / 2, height / 2, { horizontal: "center", vertical: "middle" }, rotation);
  }

  // Draw pins with stubs and labels per face
  drawLayoutPins(ctx, pins, 0.5, 0.55, rotation);
}

/**
 * Draw pin stubs and labels for LAYOUT mode, handling all four faces.
 * Left/right pins have horizontal stubs; top/bottom pins have vertical stubs.
 * All text is counter-rotated at rotation=2 to stay upright.
 */
function drawLayoutPins(
  ctx: RenderContext,
  pins: readonly PinDeclaration[],
  stubLength: number,
  fontSize: number,
  rotation: Rotation = 0,
): void {
  ctx.setFont({ family: "sans-serif", size: fontSize });

  // For top/bottom labels, Digital draws them rotated 90° along the stub.
  // At component rotation=2 (180°), we need the opposite rotation direction
  // to keep the text readable.
  const verticalAngle = rotation === 2 ? Math.PI / 2 : -Math.PI / 2;

  for (const pin of pins) {
    ctx.setColor("COMPONENT");

    switch (pin.face) {
      case "top":
        // Vertical stub upward from chip edge
        ctx.drawLine(pin.position.x, pin.position.y + 1, pin.position.x, pin.position.y);
        ctx.setColor("TEXT");
        ctx.save();
        ctx.translate(pin.position.x, pin.position.y + 1 + 0.2);  // 0.2 inside chip
        ctx.rotate(verticalAngle);
        // "right" alignment: after -π/2 rotation, local -x = world +y = downward into chip
        ctx.drawText(pin.label, 0, 0, { horizontal: "right", vertical: "middle" });
        ctx.restore();
        break;

      case "bottom":
        // Vertical stub downward from chip edge
        ctx.drawLine(pin.position.x, pin.position.y - 1, pin.position.x, pin.position.y);
        ctx.setColor("TEXT");
        ctx.save();
        ctx.translate(pin.position.x, pin.position.y - 1 - 0.2);  // 0.2 inside chip
        ctx.rotate(verticalAngle);
        ctx.drawText(pin.label, 0, 0, { horizontal: "right", vertical: "middle" });
        ctx.restore();
        break;

      case "right":
        // Horizontal stub rightward
        ctx.drawLine(pin.position.x - stubLength, pin.position.y, pin.position.x, pin.position.y);
        ctx.setColor("TEXT");
        drawUprightText(ctx, pin.label, pin.position.x - stubLength - 0.1, pin.position.y, {
          horizontal: "right", vertical: "middle",
        }, rotation);
        break;

      default: // "left" or unset
        // Horizontal stub leftward
        ctx.drawLine(pin.position.x, pin.position.y, pin.position.x + stubLength, pin.position.y);
        ctx.setColor("TEXT");
        drawUprightText(ctx, pin.label, pin.position.x + stubLength + 0.1, pin.position.y, {
          horizontal: "left", vertical: "middle",
        }, rotation);
        break;
    }

  }
}
