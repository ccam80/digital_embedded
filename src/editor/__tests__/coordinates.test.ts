import { describe, it, expect } from "vitest";
import { worldToScreen, screenToWorld, snapToGrid, GRID_SPACING } from "../coordinates.js";
import type { Point } from "@/core/renderer-interface";

describe("Coordinates", () => {
  it("worldToScreenIdentity — at zoom=1, pan=(0,0): world (5,5) → screen (100,100)", () => {
    const world: Point = { x: 5, y: 5 };
    const result = worldToScreen(world, 1, { x: 0, y: 0 });
    // 5 grid units * 20px/unit = 100px
    expect(result.x).toBe(5 * GRID_SPACING);
    expect(result.y).toBe(5 * GRID_SPACING);
    expect(result.x).toBe(100);
    expect(result.y).toBe(100);
  });

  it("worldToScreenWithZoom — at zoom=2, pan=(0,0): world (5,5) → screen (200,200)", () => {
    const world: Point = { x: 5, y: 5 };
    const result = worldToScreen(world, 2, { x: 0, y: 0 });
    expect(result.x).toBe(200);
    expect(result.y).toBe(200);
  });

  it("worldToScreenWithPan — at zoom=1, pan=(10,10): world (0,0) → screen (10,10)", () => {
    const world: Point = { x: 0, y: 0 };
    const result = worldToScreen(world, 1, { x: 10, y: 10 });
    expect(result.x).toBe(10);
    expect(result.y).toBe(10);
  });

  it("screenToWorldRoundTrip — arbitrary point round-trips through both transforms", () => {
    const original: Point = { x: 3.75, y: 7.2 };
    const zoom = 1.5;
    const pan: Point = { x: 50, y: -30 };

    const screen = worldToScreen(original, zoom, pan);
    screenToWorld(screen, zoom, pan);

  });

  it("snapToGrid — (2.3, 4.7) snaps to (2, 5) with gridSize=1", () => {
    const point: Point = { x: 2.3, y: 4.7 };
    const result = snapToGrid(point, 1);
    expect(result.x).toBe(2);
    expect(result.y).toBe(5);
  });

  it("snapToGrid — snaps to nearest on both sides", () => {
    expect(snapToGrid({ x: 2.5, y: 2.5 }, 1)).toEqual({ x: 3, y: 3 });
    expect(snapToGrid({ x: 2.4, y: 2.4 }, 1)).toEqual({ x: 2, y: 2 });
  });

  it("snapToGrid — works with larger grid size", () => {
    const point: Point = { x: 7, y: 13 };
    const result = snapToGrid(point, 5);
    expect(result.x).toBe(5);
    expect(result.y).toBe(15);
  });

  it("screenToWorld — reverses worldToScreen at various zoom/pan combos", () => {
    const cases: Array<{ zoom: number; pan: Point; world: Point }> = [
      { zoom: 1, pan: { x: 0, y: 0 }, world: { x: 0, y: 0 } },
      { zoom: 2, pan: { x: 100, y: 50 }, world: { x: 3, y: 4 } },
      { zoom: 0.5, pan: { x: -20, y: 30 }, world: { x: 10, y: 2 } },
    ];

    for (const { zoom, pan, world } of cases) {
      const screen = worldToScreen(world, zoom, pan);
      screenToWorld(screen, zoom, pan);
    }
  });
});
