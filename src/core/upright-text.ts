/**
 * Shared upright text helper — counter-rotates text to stay readable.
 *
 * Java Digital's GraphicSwing.drawText() automatically detects when the text
 * baseline is flipped and adjusts orientation:
 *   0°   — horizontal, normal alignment
 *   90°  — vertical (reads bottom-to-top), normal alignment
 *   180° — horizontal, FLIPPED alignment (avoids upside-down)
 *   270° — vertical (reads bottom-to-top), FLIPPED alignment
 *
 * Since our RenderContext.drawText() has no directional information,
 * components must explicitly call this helper to achieve the same behavior.
 *
 * At rotations 1 and 2 the canvas transform produces text that reads in the
 * wrong direction (top-to-bottom at 90°, upside-down at 180°). We counter-
 * rotate 180° and flip alignment to correct this. At rotations 0 and 3 the
 * text direction is already correct.
 */

import type { RenderContext } from "./renderer-interface.js";
import type { Rotation } from "./pin.js";

/** Flip horizontal and vertical alignment. */
function flipAlign(align: {
  horizontal: "left" | "center" | "right";
  vertical: "top" | "middle" | "bottom";
}): { horizontal: "left" | "center" | "right"; vertical: "top" | "middle" | "bottom" } {
  return {
    horizontal: align.horizontal === "left" ? "right" as const
      : align.horizontal === "right" ? "left" as const
      : "center" as const,
    vertical: align.vertical === "top" ? "bottom" as const
      : align.vertical === "bottom" ? "top" as const
      : "middle" as const,
  };
}

/**
 * Draw text that stays readable regardless of component rotation.
 *
 * @param ctx       The render context.
 * @param text      The string to draw.
 * @param x         X position in local component coordinates.
 * @param y         Y position in local component coordinates.
 * @param align     Text alignment anchor.
 * @param rotation  The element's rotation (0–3 quarter-turns CW).
 */
export function drawUprightText(
  ctx: RenderContext,
  text: string,
  x: number,
  y: number,
  align: { horizontal: "left" | "center" | "right"; vertical: "top" | "middle" | "bottom" },
  rotation: Rotation,
): void {
  if (rotation === 1 || rotation === 2) {
    // At 90° CW the text reads top-to-bottom (should be bottom-to-top).
    // At 180° the text is upside-down.
    // Counter-rotate 180° and flip alignment to correct both.
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.PI);
    ctx.drawText(text, 0, 0, flipAlign(align));
    ctx.restore();
  } else {
    // At 0° and 270° CW (= 90° CCW) the text direction is already correct.
    ctx.drawText(text, x, y, align);
  }
}
