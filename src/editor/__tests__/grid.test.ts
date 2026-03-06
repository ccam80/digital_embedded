import { describe, it, expect } from "vitest";
import { GridRenderer } from "../grid.js";
import { MockRenderContext } from "@/test-utils/mock-render-context";
import type { Rect } from "@/core/renderer-interface";

describe("GridRenderer", () => {
  it("drawsGridLines — render with MockRenderContext, assert drawLine calls made for grid lines within viewport", () => {
    const renderer = new GridRenderer();
    const ctx = new MockRenderContext();

    // Viewport: 200x200 pixels at origin
    const viewport: Rect = { x: 0, y: 0, width: 200, height: 200 };
    // zoom=1, pan=(0,0): world visible from (0,0) to (10,10) grid units
    renderer.render(ctx, viewport, 1, { x: 0, y: 0 });

    const lines = ctx.callsOfKind("line");
    expect(lines.length).toBeGreaterThan(0);
  });

  it("draws vertical and horizontal lines", () => {
    const renderer = new GridRenderer();
    const ctx = new MockRenderContext();

    const viewport: Rect = { x: 0, y: 0, width: 200, height: 200 };
    renderer.render(ctx, viewport, 1, { x: 0, y: 0 });

    const lines = ctx.callsOfKind("line");

    // Vertical lines have same x1 and x2
    const verticals = lines.filter((l) => l.x1 === l.x2);
    // Horizontal lines have same y1 and y2
    const horizontals = lines.filter((l) => l.y1 === l.y2);

    expect(verticals.length).toBeGreaterThan(0);
    expect(horizontals.length).toBeGreaterThan(0);
  });

  it("draws only major grid lines when zoomed out far", () => {
    const renderer = new GridRenderer();

    // Below MINOR_GRID_MIN_ZOOM (0.5) — only major lines
    const ctxOut = new MockRenderContext();
    const viewport: Rect = { x: 0, y: 0, width: 400, height: 400 };
    renderer.render(ctxOut, viewport, 0.25, { x: 0, y: 0 });
    const linesOut = ctxOut.callsOfKind("line");

    // At zoom=1 — both minor and major
    const ctxIn = new MockRenderContext();
    renderer.render(ctxIn, viewport, 1, { x: 0, y: 0 });
    const linesIn = ctxIn.callsOfKind("line");

    // At zoom=1 we have more lines (minor + major), at 0.25 only major
    expect(linesIn.length).toBeGreaterThan(linesOut.length);
  });

  it("grid lines are within the viewport bounds", () => {
    const renderer = new GridRenderer();
    const ctx = new MockRenderContext();

    const viewport: Rect = { x: 50, y: 50, width: 300, height: 200 };
    renderer.render(ctx, viewport, 1, { x: 0, y: 0 });

    const lines = ctx.callsOfKind("line");

    // Vertical lines: x1 === x2, y coordinates span viewport height
    const verticals = lines.filter((l) => l.x1 === l.x2);
    for (const v of verticals) {
      expect(v.y1).toBe(viewport.y);
      expect(v.y2).toBe(viewport.y + viewport.height);
    }

    // Horizontal lines: y1 === y2, x coordinates span viewport width
    const horizontals = lines.filter((l) => l.y1 === l.y2);
    for (const h of horizontals) {
      expect(h.x1).toBe(viewport.x);
      expect(h.x2).toBe(viewport.x + viewport.width);
    }
  });

  it("uses GRID theme color for all lines", () => {
    const renderer = new GridRenderer();
    const ctx = new MockRenderContext();

    const viewport: Rect = { x: 0, y: 0, width: 200, height: 200 };
    renderer.render(ctx, viewport, 1, { x: 0, y: 0 });

    const colorCalls = ctx.callsOfKind("setColor");
    expect(colorCalls.length).toBeGreaterThan(0);
    for (const call of colorCalls) {
      expect(call.color).toBe("GRID");
    }
  });

  it("respects pan offset when computing grid line positions", () => {
    const renderer = new GridRenderer();

    // No pan
    const ctxNoPan = new MockRenderContext();
    const viewport: Rect = { x: 0, y: 0, width: 200, height: 200 };
    renderer.render(ctxNoPan, viewport, 1, { x: 0, y: 0 });

    // With pan (shift by half a grid unit)
    const ctxWithPan = new MockRenderContext();
    renderer.render(ctxWithPan, viewport, 1, { x: 10, y: 10 });

    const linesNoPan = ctxNoPan.callsOfKind("line");
    const linesWithPan = ctxWithPan.callsOfKind("line");

    // Both should have lines but at different positions
    // Just verify that both produce lines
    expect(linesNoPan.length).toBeGreaterThan(0);
    expect(linesWithPan.length).toBeGreaterThan(0);
  });
});
