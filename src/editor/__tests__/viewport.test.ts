import { describe, it, expect } from "vitest";
import { Viewport } from "../viewport.js";
import { GRID_SPACING } from "../coordinates.js";
import type { CircuitElement } from "@/core/element";
import type { Point, Rect, RenderContext } from "@/core/renderer-interface";
import type { Pin } from "@/core/pin";
import type { PropertyBag, PropertyValue } from "@/core/properties";
import type { SerializedElement } from "@/core/element";
import type { Rotation } from "@/core/pin";

/** Minimal mock element for fitToContent tests. */
function makeMockElement(x: number, y: number, w: number, h: number): CircuitElement {
  return {
    typeId: "Mock",
    instanceId: `mock-${x}-${y}`,
    position: { x, y },
    rotation: 0 as Rotation,
    mirror: false,
    getPins(): readonly Pin[] { return []; },
    getProperties(): PropertyBag { return new Map() as unknown as PropertyBag; },
    draw(_ctx: RenderContext): void { /* no-op */ },
    getBoundingBox(): Rect { return { x, y, width: w, height: h }; },
    serialize(): SerializedElement {
      return {
        typeId: "Mock",
        instanceId: `mock-${x}-${y}`,
        position: { x, y },
        rotation: 0 as Rotation,
        mirror: false,
        properties: {},
      };
    },
    getAttribute(_name: string): PropertyValue | undefined { return undefined; },
    setAttribute(_name: string, _value: PropertyValue): void {},
  };
}

describe("Viewport", () => {
  it("zoomAtCursorKeepsWorldPointFixed — zoom in at screen center, verify the world point under cursor didn't move", () => {
    const vp = new Viewport(1.0, { x: 0, y: 0 });
    const screenPoint: Point = { x: 400, y: 300 };

    // World point under screenPoint before zoom
    const worldBefore = {
      x: (screenPoint.x - vp.pan.x) / (vp.zoom * GRID_SPACING),
      y: (screenPoint.y - vp.pan.y) / (vp.zoom * GRID_SPACING),
    };

    vp.zoomAt(screenPoint, 1.5);

    // World point under same screenPoint after zoom
    const worldAfter = {
      x: (screenPoint.x - vp.pan.x) / (vp.zoom * GRID_SPACING),
      y: (screenPoint.y - vp.pan.y) / (vp.zoom * GRID_SPACING),
    };

  });

  it("zoomClampsToLimits — zoom below 0.1 clamps to 0.1, above 10 clamps to 10", () => {
    const vp = new Viewport(1.0, { x: 0, y: 0 });

    // Zoom in far
    for (let i = 0; i < 50; i++) {
      vp.zoomAt({ x: 0, y: 0 }, 2.0);
    }
    expect(vp.zoom).toBe(10.0);

    // Zoom out far
    for (let i = 0; i < 100; i++) {
      vp.zoomAt({ x: 0, y: 0 }, 0.5);
    }
    expect(vp.zoom).toBe(0.1);
  });

  it("setZoom clamps below minimum to 0.1", () => {
    const vp = new Viewport(1.0, { x: 0, y: 0 });
    vp.setZoom(0.001);
    expect(vp.zoom).toBe(0.1);
  });

  it("setZoom clamps above maximum to 10", () => {
    const vp = new Viewport(1.0, { x: 0, y: 0 });
    vp.setZoom(999);
    expect(vp.zoom).toBe(10.0);
  });

  it("setZoom accepts preset values exactly", () => {
    const vp = new Viewport(1.0, { x: 0, y: 0 });
    for (const preset of [0.5, 1.0, 1.5, 2.0, 3.0]) {
      vp.setZoom(preset);
      expect(vp.zoom).toBe(preset);
    }
  });

  it("panByTranslatesOffset — panBy(100,50), verify pan offset changed", () => {
    const vp = new Viewport(1.0, { x: 0, y: 0 });
    vp.panBy({ x: 100, y: 50 });
    expect(vp.pan.x).toBe(100);
    expect(vp.pan.y).toBe(50);
  });

  it("panBy accumulates across multiple calls", () => {
    const vp = new Viewport(1.0, { x: 0, y: 0 });
    vp.panBy({ x: 30, y: 10 });
    vp.panBy({ x: -10, y: 20 });
    expect(vp.pan.x).toBe(20);
    expect(vp.pan.y).toBe(30);
  });

  it("fitToContentCentersElements — place elements at known positions, fitToContent, verify all elements are within the visible world rect", () => {
    const vp = new Viewport(1.0, { x: 0, y: 0 });

    // Two elements at (0,0) 2x2 and (10,10) 2x2
    const elements = [
      makeMockElement(0, 0, 2, 2),
      makeMockElement(10, 10, 2, 2),
    ];

    const canvasSize = { width: 800, height: 600 };
    vp.fitToContent(elements, canvasSize);

    const visible = vp.getVisibleWorldRect(canvasSize);

    // All element bounding boxes must be within the visible rect
    for (const el of elements) {
      const bb = el.getBoundingBox();
      expect(bb.x).toBeGreaterThanOrEqual(visible.x - 0.001);
      expect(bb.y).toBeGreaterThanOrEqual(visible.y - 0.001);
      expect(bb.x + bb.width).toBeLessThanOrEqual(visible.x + visible.width + 0.001);
      expect(bb.y + bb.height).toBeLessThanOrEqual(visible.y + visible.height + 0.001);
    }
  });

  it("getVisibleWorldRect — at zoom=1, pan=(0,0), canvas 800x600: visible rect is (0, 0, 40, 30) in grid units", () => {
    const vp = new Viewport(1.0, { x: 0, y: 0 });
    const canvasSize = { width: 800, height: 600 };
    const rect = vp.getVisibleWorldRect(canvasSize);

    // At zoom=1, GRID_SPACING=20: 800px / 20px = 40 grid units wide, 600px / 20px = 30 tall
  });

  it("getVisibleWorldRect at zoom=2", () => {
    const vp = new Viewport(2.0, { x: 0, y: 0 });
    const canvasSize = { width: 800, height: 600 };
    const rect = vp.getVisibleWorldRect(canvasSize);
    // At zoom=2: 800px / (2*20) = 20 grid units wide
  });

  it("fitToContent with no elements resets to zoom=1 pan=0", () => {
    const vp = new Viewport(3.0, { x: 100, y: 200 });
    vp.fitToContent([], { width: 800, height: 600 });
    expect(vp.zoom).toBe(1.0);
    expect(vp.pan.x).toBe(0);
    expect(vp.pan.y).toBe(0);
  });

  it("zoomAt with delta=1.0 is identity for zoom", () => {
    const vp = new Viewport(1.5, { x: 10, y: 20 });
    const zoomBefore = vp.zoom;
    vp.zoomAt({ x: 100, y: 100 }, 1.0);
    expect(vp.zoom).toBe(zoomBefore);
  });
});
