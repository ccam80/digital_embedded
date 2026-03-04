/**
 * Grid renderer — draws minor and major grid lines on the circuit canvas.
 *
 * Minor lines appear every grid unit. Major lines appear every 5 grid units
 * and are drawn with a slightly thicker line width. Minor lines are hidden
 * when zoomed out below a threshold to avoid visual clutter.
 */

import type { RenderContext, Rect } from "@/core/renderer-interface";
import type { Point } from "@/core/renderer-interface";
import { GRID_SPACING, screenToWorld } from "./coordinates.js";

/** Grid units between major lines. */
const MAJOR_GRID_INTERVAL = 5;

/** Zoom level below which minor grid lines are hidden. */
const MINOR_GRID_MIN_ZOOM = 0.5;

/** Line width for minor grid lines. */
const MINOR_LINE_WIDTH = 0.5;

/** Line width for major grid lines. */
const MAJOR_LINE_WIDTH = 1;

export class GridRenderer {
  /**
   * Draw grid lines within the visible viewport.
   *
   * @param ctx       Render context to draw into.
   * @param viewport  Visible screen-space rectangle (pixels).
   * @param zoom      Current zoom level.
   * @param pan       Current pan offset (pixels).
   */
  render(ctx: RenderContext, viewport: Rect, zoom: number, pan: Point): void {
    const topLeft = screenToWorld({ x: viewport.x, y: viewport.y }, zoom, pan);
    const bottomRight = screenToWorld(
      { x: viewport.x + viewport.width, y: viewport.y + viewport.height },
      zoom,
      pan,
    );

    const startX = Math.floor(topLeft.x);
    const endX = Math.ceil(bottomRight.x);
    const startY = Math.floor(topLeft.y);
    const endY = Math.ceil(bottomRight.y);

    const pixelWidth = viewport.width;
    const pixelHeight = viewport.height;

    const drawMinor = zoom >= MINOR_GRID_MIN_ZOOM;

    if (drawMinor) {
      ctx.setColor("GRID");
      ctx.setLineWidth(MINOR_LINE_WIDTH);

      for (let gx = startX; gx <= endX; gx++) {
        if (gx % MAJOR_GRID_INTERVAL === 0) continue;
        const sx = gx * zoom * GRID_SPACING + pan.x;
        ctx.drawLine(sx, viewport.y, sx, viewport.y + pixelHeight);
      }

      for (let gy = startY; gy <= endY; gy++) {
        if (gy % MAJOR_GRID_INTERVAL === 0) continue;
        const sy = gy * zoom * GRID_SPACING + pan.y;
        ctx.drawLine(viewport.x, sy, viewport.x + pixelWidth, sy);
      }
    }

    ctx.setColor("GRID");
    ctx.setLineWidth(MAJOR_LINE_WIDTH);

    for (let gx = startX; gx <= endX; gx++) {
      if (gx % MAJOR_GRID_INTERVAL !== 0) continue;
      const sx = gx * zoom * GRID_SPACING + pan.x;
      ctx.drawLine(sx, viewport.y, sx, viewport.y + pixelHeight);
    }

    for (let gy = startY; gy <= endY; gy++) {
      if (gy % MAJOR_GRID_INTERVAL !== 0) continue;
      const sy = gy * zoom * GRID_SPACING + pan.y;
      ctx.drawLine(viewport.x, sy, viewport.x + pixelWidth, sy);
    }
  }
}
