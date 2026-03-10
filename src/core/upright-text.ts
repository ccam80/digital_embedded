/**
 * Shared upright text helper — counter-rotates text when component is at 180°.
 *
 * Java Digital's GraphicSwing.drawText() automatically detects when the text
 * baseline is flipped (p1.x > p2.x in 180° rotation) and counter-rotates the
 * text orientation. Since our RenderContext.drawText() has no directional
 * information, components must explicitly call this helper to achieve the
 * same behavior.
 */

import type { RenderContext } from "./renderer-interface.js";
import type { Rotation } from "./pin.js";

/**
 * Draw text that stays upright regardless of component rotation.
 *
 * When rotation is 2 (180°), counter-rotates the text 180° around its anchor
 * and flips alignment so labels extend in the correct direction. At all other
 * rotations, draws text normally.
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
