/**
 * Tests for WireRenderer.
 *
 * Uses MockRenderContext to record draw calls. No DOM required.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { WireRenderer } from "@/editor/wire-renderer";
import { Wire } from "@/core/circuit";
import { MockRenderContext } from "@/test-utils/mock-render-context";
import type { WireSignalAccess } from "@/editor/wire-signal-access";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWire(x1: number, y1: number, x2: number, y2: number): Wire {
  return new Wire({ x: x1, y: y1 }, { x: x2, y: y2 });
}

function makeSignalAccess(
  map: Map<Wire, { raw: number; width: number }>,
): WireSignalAccess {
  return {
    getWireValue(wire: Wire) {
      return map.get(wire);
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WireRenderer", () => {
  let ctx: MockRenderContext;
  let renderer: WireRenderer;

  beforeEach(() => {
    ctx = new MockRenderContext();
    renderer = new WireRenderer();
  });

  it("drawsWireSegment", () => {
    const wire = makeWire(0, 0, 10, 20);
    renderer.render(ctx, [wire], new Set());

    const lines = ctx.callsOfKind("line");
    expect(lines.length).toBe(1);
    expect(lines[0]).toEqual({ kind: "line", x1: 0, y1: 0, x2: 10, y2: 20 });
  });

  it("busWireIsThicker", () => {
    const wire = makeWire(0, 0, 10, 0);
    const signalMap = new Map<Wire, { raw: number; width: number }>();
    signalMap.set(wire, { raw: 3, width: 4 });
    const access = makeSignalAccess(signalMap);

    renderer.render(ctx, [wire], new Set(), access);

    const lineWidths = ctx.callsOfKind("setLineWidth");
    expect(lineWidths.some((c) => c.width === 3)).toBe(true);
  });

  it("junctionDotAtThreeWayJoin", () => {
    // Three wires all meeting at (5, 5)
    const w1 = makeWire(0, 0, 5, 5);
    const w2 = makeWire(5, 5, 10, 5);
    const w3 = makeWire(5, 5, 5, 10);

    renderer.renderJunctionDots(ctx, [w1, w2, w3]);

    const circles = ctx.callsOfKind("circle");
    // At least one filled circle at (5, 5)
    const junctionCircle = circles.find(
      (c) => c.cx === 5 && c.cy === 5 && c.filled === true,
    );
    expect(junctionCircle).toBeDefined();
  });

  it("noJunctionDotAtTwoWayJoin", () => {
    // Two wires meeting end-to-end at (5, 5) — pass-through, no dot
    const w1 = makeWire(0, 5, 5, 5);
    const w2 = makeWire(5, 5, 10, 5);

    renderer.renderJunctionDots(ctx, [w1, w2]);

    const circles = ctx.callsOfKind("circle");
    expect(circles.length).toBe(0);
  });

  it("wireColorBySignalState", () => {
    const wire = makeWire(0, 0, 10, 0);
    const signalMap = new Map<Wire, { raw: number; width: number }>();
    signalMap.set(wire, { raw: 1, width: 1 });
    const access = makeSignalAccess(signalMap);

    renderer.render(ctx, [wire], new Set(), access);

    const colorCalls = ctx.callsOfKind("setColor");
    expect(colorCalls.some((c) => c.color === "WIRE_HIGH")).toBe(true);
  });

  it("defaultColorWhenNoEngine", () => {
    const wire = makeWire(0, 0, 10, 0);
    renderer.render(ctx, [wire], new Set());

    const colorCalls = ctx.callsOfKind("setColor");
    expect(colorCalls.some((c) => c.color === "WIRE")).toBe(true);
  });

  it("selectedWireHighlighted", () => {
    const wire = makeWire(0, 0, 10, 0);
    const selection = new Set<Wire>([wire]);

    renderer.render(ctx, [wire], selection);

    const colorCalls = ctx.callsOfKind("setColor");
    expect(colorCalls.some((c) => c.color === "SELECTION")).toBe(true);
  });
});
