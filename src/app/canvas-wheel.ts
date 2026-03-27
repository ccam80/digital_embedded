/**
 * Wheel zoom handler for the canvas interaction layer.
 *
 * Zooms the viewport centered on the cursor position.
 */

import type { AppContext } from './app-context.js';
import type { RenderPipeline } from './render-pipeline.js';

export function registerWheelHandler(
  ctx: AppContext,
  renderPipeline: RenderPipeline,
): void {
  const canvas = ctx.canvas;

  // passive: true lets the browser compositor run without waiting for JS.
  canvas.addEventListener('wheel', (e: WheelEvent) => {
    const screenPt = renderPipeline.canvasToScreen(e);
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    ctx.viewport.zoomAt(screenPt, factor);
    renderPipeline.scheduleRender();
  }, { passive: true });
}
