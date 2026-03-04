/**
 * Coordinate system transforms and grid snapping.
 *
 * World coordinates are in grid units. Screen coordinates are in pixels.
 * GRID_SPACING defines how many pixels one grid unit occupies at zoom=1.
 */

import type { Point } from "@/core/renderer-interface";

/** Pixels per grid unit at zoom level 1.0 (matches Digital's 20px grid). */
export const GRID_SPACING = 20;

/**
 * Convert a world-space point (grid units) to screen-space (pixels).
 *
 * Screen point = world * zoom * GRID_SPACING + pan
 */
export function worldToScreen(world: Point, zoom: number, pan: Point): Point {
  return {
    x: world.x * zoom * GRID_SPACING + pan.x,
    y: world.y * zoom * GRID_SPACING + pan.y,
  };
}

/**
 * Convert a screen-space point (pixels) to world-space (grid units).
 *
 * World point = (screen - pan) / (zoom * GRID_SPACING)
 */
export function screenToWorld(screen: Point, zoom: number, pan: Point): Point {
  return {
    x: (screen.x - pan.x) / (zoom * GRID_SPACING),
    y: (screen.y - pan.y) / (zoom * GRID_SPACING),
  };
}

/**
 * Snap a world-space point to the nearest grid position.
 *
 * Rounds each coordinate to the nearest multiple of gridSize.
 */
export function snapToGrid(world: Point, gridSize: number): Point {
  return {
    x: Math.round(world.x / gridSize) * gridSize,
    y: Math.round(world.y / gridSize) * gridSize,
  };
}
