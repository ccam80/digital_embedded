/**
 * Viewport- manages pan and zoom state for the circuit canvas.
 *
 * Zoom is centered on a screen point so the world point under the cursor
 * stays fixed. Pan is in pixels (screen space). Zoom range is [0.1, 10.0].
 */

import type { Point, Rect } from "@/core/renderer-interface";
import type { CircuitElement } from "@/core/element";
import { GRID_SPACING, screenToWorld } from "./coordinates.js";

/** Minimum allowed zoom level. */
const ZOOM_MIN = 0.1;

/** Maximum allowed zoom level. */
const ZOOM_MAX = 10.0;

/** Margin in pixels applied when fitting content to the canvas. */
const FIT_MARGIN_PX = 40;

export class Viewport {
  zoom: number;
  pan: Point;

  constructor(zoom = 1.0, pan: Point = { x: 0, y: 0 }) {
    this.zoom = zoom;
    this.pan = { x: pan.x, y: pan.y };
  }

  /**
   * Zoom centered on a screen-space point.
   *
   * Adjusts pan so the world point under screenPoint is invariant.
   *
   * @param screenPoint  The screen point to zoom toward/away from.
   * @param delta        Zoom multiplier (e.g. 1.1 to zoom in, 0.9 to zoom out).
   */
  zoomAt(screenPoint: Point, delta: number): void {
    const worldBefore = screenToWorld(screenPoint, this.zoom, this.pan);

    const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.zoom * delta));
    this.zoom = newZoom;

    // Recalculate pan so the same world point maps back to the same screen point.
    // screenPoint = worldBefore * newZoom * GRID_SPACING + newPan
    // => newPan = screenPoint - worldBefore * newZoom * GRID_SPACING
    this.pan = {
      x: screenPoint.x - worldBefore.x * newZoom * GRID_SPACING,
      y: screenPoint.y - worldBefore.y * newZoom * GRID_SPACING,
    };
  }

  /**
   * Translate the pan offset by a screen-space delta.
   */
  panBy(screenDelta: Point): void {
    this.pan = {
      x: this.pan.x + screenDelta.x,
      y: this.pan.y + screenDelta.y,
    };
  }

  /**
   * Set zoom level, clamped to [ZOOM_MIN, ZOOM_MAX].
   */
  setZoom(level: number): void {
    this.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, level));
  }

  /**
   * Compute the world-space rectangle currently visible given a canvas size.
   *
   * Returns x, y in grid units and width, height in grid units.
   */
  getVisibleWorldRect(canvasSize: { width: number; height: number }): Rect {
    const topLeft = screenToWorld({ x: 0, y: 0 }, this.zoom, this.pan);
    const bottomRight = screenToWorld(
      { x: canvasSize.width, y: canvasSize.height },
      this.zoom,
      this.pan,
    );
    return {
      x: topLeft.x,
      y: topLeft.y,
      width: bottomRight.x - topLeft.x,
      height: bottomRight.y - topLeft.y,
    };
  }

  /**
   * Set zoom and pan to fit all elements into the canvas with a margin.
   *
   * If there are no elements, resets to zoom=1, pan=(0,0).
   */
  fitToContent(
    elements: readonly CircuitElement[],
    canvasSize: { width: number; height: number },
  ): void {
    if (elements.length === 0) {
      this.zoom = 1.0;
      this.pan = { x: 0, y: 0 };
      return;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const el of elements) {
      const bb = el.getBoundingBox();
      if (bb.x < minX) minX = bb.x;
      if (bb.y < minY) minY = bb.y;
      if (bb.x + bb.width > maxX) maxX = bb.x + bb.width;
      if (bb.y + bb.height > maxY) maxY = bb.y + bb.height;
    }

    // Width and height of the content in grid units
    const contentW = maxX - minX;
    const contentH = maxY - minY;

    // Available canvas area after margin
    const availW = canvasSize.width - 2 * FIT_MARGIN_PX;
    const availH = canvasSize.height - 2 * FIT_MARGIN_PX;

    // Scale so content fills available area; content in pixels = gridUnits * zoom * GRID_SPACING
    const zoomX = contentW > 0 ? availW / (contentW * GRID_SPACING) : 1;
    const zoomY = contentH > 0 ? availH / (contentH * GRID_SPACING) : 1;
    const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.min(zoomX, zoomY)));
    this.zoom = newZoom;

    // Center the content: pan so content midpoint maps to canvas midpoint
    const contentMidX = (minX + maxX) / 2;
    const contentMidY = (minY + maxY) / 2;
    const canvasMidX = canvasSize.width / 2;
    const canvasMidY = canvasSize.height / 2;

    // screen = world * zoom * GRID_SPACING + pan
    // canvasMid = contentMid * zoom * GRID_SPACING + pan
    // pan = canvasMid - contentMid * zoom * GRID_SPACING
    this.pan = {
      x: canvasMidX - contentMidX * newZoom * GRID_SPACING,
      y: canvasMidY - contentMidY * newZoom * GRID_SPACING,
    };
  }
}
