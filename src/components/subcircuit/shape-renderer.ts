/**
 * Shape renderer for SubcircuitElement.
 *
 * Renders the four shape modes: DEFAULT, DIL, CUSTOM, LAYOUT.
 * All rendering is done via the engine-agnostic RenderContext.
 *
 * Chip rect has a 0.5 grid-unit border above and below the pin area,
 * matching Digital's topBottomBorder = SIZE2.
 */

import type { RenderContext, PathData } from "../../core/renderer-interface.js";
import type { PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import type { CustomShapeData, CustomDrawable, RGBA } from "../../core/circuit.js";
import { parseSvgPath } from "./svg-path-parser.js";

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

  // Name label (below chip rect, stays upright at 180°)
  ctx.setColor("TEXT");
  ctx.setFont({ family: "sans-serif", size: 0.6 });
  drawUprightText(ctx, name, width / 2, height - 0.3, { horizontal: "center", vertical: "top" }, rotation);

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
// CUSTOM shape — renders custom drawables and pin labels
// ---------------------------------------------------------------------------

/**
 * Convert an RGBA color value to a CSS rgba() string.
 */
function rgbaToCss(color: RGBA): string {
  return `rgba(${color.r},${color.g},${color.b},${(color.a / 255).toFixed(3)})`;
}

/**
 * Set a raw RGBA color on the render context.
 * Falls back to COMPONENT theme color if setRawColor is not available.
 */
function applyRawColor(ctx: RenderContext, color: RGBA): void {
  if (ctx.setRawColor) {
    ctx.setRawColor(rgbaToCss(color));
  } else {
    ctx.setColor("COMPONENT");
  }
}

/**
 * Render the CUSTOM shape mode. When no custom shape data is available,
 * falls back to the DEFAULT chip shape.
 */
export function drawCustomShape(
  ctx: RenderContext,
  name: string,
  pins: readonly PinDeclaration[],
  width: number,
  height: number,
  rotation: Rotation = 0,
  customShape?: CustomShapeData,
): void {
  if (!customShape || customShape.drawables.length === 0) {
    drawDefaultShape(ctx, name, pins, width, height, rotation);
    return;
  }

  for (const drawable of customShape.drawables) {
    renderDrawable(ctx, drawable);
  }

  renderCustomPinLabels(ctx, pins, customShape, rotation);
}

/**
 * Render a single custom drawable element.
 */
function renderDrawable(ctx: RenderContext, drawable: CustomDrawable): void {
  switch (drawable.type) {
    case "poly": {
      const ops = parseSvgPath(drawable.path);
      const pathData: PathData = { operations: ops };
      applyRawColor(ctx, drawable.color);
      ctx.setLineWidth(drawable.thickness / 20);
      if (drawable.filled) {
        ctx.drawPath(pathData, true);
      }
      ctx.drawPath(pathData, false);
      break;
    }

    case "line": {
      applyRawColor(ctx, drawable.color);
      ctx.setLineWidth(drawable.thickness / 20);
      ctx.drawLine(drawable.p1.x, drawable.p1.y, drawable.p2.x, drawable.p2.y);
      break;
    }

    case "circle": {
      const cx = (drawable.p1.x + drawable.p2.x) / 2;
      const cy = (drawable.p1.y + drawable.p2.y) / 2;
      const rx = Math.abs(drawable.p2.x - drawable.p1.x) / 2;
      const ry = Math.abs(drawable.p2.y - drawable.p1.y) / 2;
      const radius = Math.max(rx, ry);
      applyRawColor(ctx, drawable.color);
      ctx.setLineWidth(drawable.thickness / 20);
      ctx.drawCircle(cx, cy, radius, drawable.filled);
      break;
    }

    case "text": {
      applyRawColor(ctx, drawable.color);
      const fontSize = drawable.size / 20;
      ctx.setFont({ family: "sans-serif", size: fontSize });
      const anchor = orientationToAnchor(drawable.orientation);
      ctx.drawText(drawable.text, drawable.pos.x, drawable.pos.y, anchor);
      break;
    }
  }
}

/**
 * Map Digital's text orientation names to RenderContext TextAnchor values.
 */
function orientationToAnchor(
  orientation: string,
): { horizontal: "left" | "center" | "right"; vertical: "top" | "middle" | "bottom" } {
  switch (orientation) {
    case "LEFTCENTER":
      return { horizontal: "left", vertical: "middle" };
    case "RIGHTCENTER":
      return { horizontal: "right", vertical: "middle" };
    case "CENTERCENTER":
      return { horizontal: "center", vertical: "middle" };
    case "LEFTBOTTOM":
      return { horizontal: "left", vertical: "bottom" };
    case "RIGHTBOTTOM":
      return { horizontal: "right", vertical: "bottom" };
    case "CENTERBOTTOM":
      return { horizontal: "center", vertical: "bottom" };
    case "LEFTTOP":
      return { horizontal: "left", vertical: "top" };
    case "RIGHTTOP":
      return { horizontal: "right", vertical: "top" };
    case "CENTERTOP":
      return { horizontal: "center", vertical: "top" };
    default:
      return { horizontal: "left", vertical: "middle" };
  }
}

/**
 * Render pin labels for CUSTOM shape mode. Only draws labels for pins
 * where the custom shape data has showLabel=true.
 */
function renderCustomPinLabels(
  ctx: RenderContext,
  pins: readonly PinDeclaration[],
  customShape: CustomShapeData,
  rotation: Rotation,
): void {
  ctx.setColor("TEXT");
  ctx.setFont({ family: "sans-serif", size: 0.5 });

  for (const pin of pins) {
    const customPin = customShape.pins.get(pin.label);
    if (!customPin || !customPin.showLabel) continue;

    const pos = pin.position;
    const isLeftSide = pin.face === "left";
    const labelX = isLeftSide ? pos.x + 0.2 : pos.x - 0.2;
    const align = isLeftSide ? "left" as const : "right" as const;

    drawUprightText(ctx, pin.label, labelX, pos.y, {
      horizontal: align,
      vertical: "middle",
    }, rotation);
  }
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
        // Pin at chip edge (y=0), stub inward to y+0.5.
        // Label anchored at stub end, extending downward into chip.
        ctx.drawLine(pin.position.x, pin.position.y, pin.position.x, pin.position.y + 0.5);
        ctx.setColor("TEXT");
        ctx.save();
        ctx.translate(pin.position.x, pin.position.y + 0.5);
        ctx.rotate(verticalAngle);
        ctx.drawText(pin.label, 0, 0, { horizontal: "right", vertical: "middle" });
        ctx.restore();
        break;

      case "bottom":
        // Pin at chip edge (y=height), stub inward to y-0.5.
        // Label anchored at stub end, extending upward into chip.
        ctx.drawLine(pin.position.x, pin.position.y, pin.position.x, pin.position.y - 0.5);
        ctx.setColor("TEXT");
        ctx.save();
        ctx.translate(pin.position.x, pin.position.y - 0.5);
        ctx.rotate(verticalAngle);
        ctx.drawText(pin.label, 0, 0, { horizontal: "left", vertical: "middle" });
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
