/**
 * Shared GenericShape drawing utility — matches Java Digital's GenericShape rendering.
 *
 * Java GenericShape draws:
 *   - Body rect with 0.05 horizontal insets (1px at 20px/grid)
 *   - Input pin labels at x=0.2 (or x=0.55 after clock triangle)
 *   - Output pin labels at x=width-0.2
 *   - Clock triangles: (bodyLeft, y±0.35) → (bodyLeft+0.35, y)
 *   - Component name at (width/2, maxY-0.3) with center/top anchor
 *   - Optional user label above body at (width/2, bodyTop) with center/bottom anchor
 */

import type { RenderContext } from "../core/renderer-interface.js";

export interface GenericShapeConfig {
  /** Labels for each input pin (top-to-bottom order). */
  inputLabels: readonly string[];
  /** Labels for each output pin (top-to-bottom order). */
  outputLabels: readonly string[];
  /** Indices into inputLabels that are clock pins (get clock triangle). */
  clockInputIndices?: readonly number[];
  /** Component name drawn at bottom center. null/undefined = no name. */
  componentName?: string | null;
  /** Component width in grid units (typically 3). */
  width: number;
  /** Optional user-assigned label drawn above the body. */
  label?: string;
  /**
   * Element rotation in quarter-turns (0–3). When 2 (180°), text is
   * counter-rotated so it renders right-side-up instead of upside-down.
   */
  rotation?: 0 | 1 | 2 | 3;
}

/**
 * Compute the GenericShape layout metrics matching Java Digital.
 *
 *   symmetric = (outputCount == 1)
 *   even = symmetric && (inputCount % 2 == 0)
 *   offs = symmetric ? floor(inputCount/2) : 0
 *
 *   inputY(i) = i + (even && i >= inputCount/2 ? 1 : 0)
 *   outputY(i) = i + offs
 *   maxY = max(lastInputY+1, lastOutputY+1)
 */
export function genericShapeMetrics(inputCount: number, outputCount: number) {
  const symmetric = outputCount === 1;
  const even = symmetric && inputCount > 0 && (inputCount & 1) === 0;
  const offs = symmetric ? Math.floor(inputCount / 2) : 0;

  const lastInputY = inputCount > 0
    ? inputCount - 1 + (even ? 1 : 0)
    : 0;
  const lastOutputY = outputCount > 0
    ? offs + outputCount - 1
    : 0;
  const maxY = Math.max(
    inputCount > 0 ? lastInputY + 1 : 0,
    outputCount > 0 ? lastOutputY + 1 : 0,
    1, // minimum height
  );

  return { symmetric, even, offs, maxY };
}

/**
 * Get the Y position for an input pin in GenericShape layout.
 */
export function inputPinY(index: number, inputCount: number, symmetric: boolean, even: boolean): number {
  const correct = symmetric && even && index >= inputCount / 2 ? 1 : 0;
  return index + correct;
}

/**
 * Draw text with automatic counter-rotation when the element is at 180°.
 *
 * Java Digital corrects text orientation at the Graphic level by detecting
 * the direction vector of the text position. We replicate that by rotating
 * π around the text anchor point so the net canvas rotation for the text
 * glyphs becomes 0° (readable) instead of 180° (upside-down).
 */
export function drawTextUpright(
  ctx: RenderContext,
  text: string,
  x: number,
  y: number,
  anchor: import("../core/renderer-interface.js").TextAnchor,
  flipForRot2: boolean,
): void {
  if (!flipForRot2) {
    ctx.drawText(text, x, y, anchor);
    return;
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-Math.PI);
  ctx.drawText(text, 0, 0, anchor);
  ctx.restore();
}

/**
 * Draw a component using the Java Digital GenericShape convention.
 *
 * This produces output that pixel-matches the Java reference shapes fixture.
 */
export function drawGenericShape(ctx: RenderContext, config: GenericShapeConfig): void {
  const {
    inputLabels,
    outputLabels,
    clockInputIndices = [],
    componentName,
    width,
    label,
    rotation = 0,
  } = config;

  const flip = rotation === 2;

  const inCount = inputLabels.length;
  const outCount = outputLabels.length;
  const { symmetric, even, offs, maxY } = genericShapeMetrics(inCount, outCount);

  // Body rect with Java's 1-pixel (0.05 grid) horizontal insets.
  // Use explicit corner coordinates (not x+width) to match Java fixture's
  // exact polygon points and avoid IEEE 754 floating-point mismatch.
  const bodyLeft = 0.05;
  const bodyRight = width - 0.05; // single subtraction: exact match to Java
  const bodyTop = -0.5;
  const bodyBottom = maxY - 0.5;  // single subtraction: exact match to Java
  const bodyCorners = [
    { x: bodyLeft, y: bodyTop },
    { x: bodyRight, y: bodyTop },
    { x: bodyRight, y: bodyBottom },
    { x: bodyLeft, y: bodyBottom },
  ];

  ctx.save();

  // Filled background
  ctx.setColor("COMPONENT_FILL");
  ctx.drawPolygon(bodyCorners, true);

  // Body outline
  ctx.setColor("COMPONENT");
  ctx.setLineWidth(1);
  ctx.drawPolygon(bodyCorners, false);

  // Clock triangles (drawn in COMPONENT color, before switching to TEXT)
  const clockSet = new Set(clockInputIndices);
  for (const ci of clockInputIndices) {
    if (ci < 0 || ci >= inCount) continue;
    const y = inputPinY(ci, inCount, symmetric, even);
    ctx.drawPolygon([
      { x: bodyLeft, y: y + 0.35 },
      { x: bodyLeft + 0.35, y },
      { x: bodyLeft, y: y - 0.35 },
    ], false);
  }

  // Pin labels
  ctx.setColor("TEXT");
  ctx.setFont({ family: "sans-serif", size: 0.9, weight: "bold" });

  for (let i = 0; i < inCount; i++) {
    const y = inputPinY(i, inCount, symmetric, even);
    const isClock = clockSet.has(i);
    const labelX = isClock ? 0.55 : 0.2;
    drawTextUpright(ctx, inputLabels[i], labelX, y, { horizontal: "left", vertical: "middle" }, flip);
  }

  for (let i = 0; i < outCount; i++) {
    const y = i + offs;
    drawTextUpright(ctx, outputLabels[i], width - 0.2, y, { horizontal: "right", vertical: "middle" }, flip);
  }

  // Component name
  if (componentName != null && componentName.length > 0) {
    ctx.setFont({ family: "sans-serif", size: 0.8 });
    drawTextUpright(ctx, componentName, width / 2, maxY - 0.3, { horizontal: "center", vertical: "top" }, flip);
  }

  // User label above body
  if (label != null && label.length > 0) {
    ctx.setFont({ family: "sans-serif", size: 1.0 });
    drawTextUpright(ctx, label, width / 2, bodyTop, { horizontal: "center", vertical: "bottom" }, flip);
  }

  ctx.restore();
}

/**
 * Compute the bounding box for a GenericShape component.
 *
 * Returns local bounds (relative to position). Caller adds position offset.
 */
export function genericShapeBounds(
  inputCount: number,
  outputCount: number,
  width: number,
): { localX: number; localY: number; width: number; height: number } {
  const { maxY } = genericShapeMetrics(inputCount, outputCount);
  // Use (width - 0.05) - 0.05 to match exact polygon corner computation
  // in drawGenericShape (bodyRight - bodyLeft), avoiding IEEE 754 mismatch.
  const bodyLeft = 0.05;
  const bodyRight = width - 0.05;
  return {
    localX: bodyLeft,
    localY: -0.5,
    width: bodyRight - bodyLeft,
    height: maxY,
  };
}
