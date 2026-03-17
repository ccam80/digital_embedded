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
import { VoltageRangeTracker } from "@/editor/voltage-range";
import { darkColorScheme } from "@/core/renderer-interface";

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

    // Verify setLineWidth(WIRE_WIDTH_BUS=3) is called BEFORE the drawLine call
    const calls = ctx.calls;
    const busWidthIdx = calls.findIndex(
      (c) => c.kind === "setLineWidth" && (c as { kind: "setLineWidth"; width: number }).width === 3,
    );
    const lineIdx = calls.findIndex((c) => c.kind === "line");
    expect(busWidthIdx).toBeGreaterThanOrEqual(0);
    expect(lineIdx).toBeGreaterThan(busWidthIdx);
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

    // Verify WIRE_HIGH color is set BEFORE the drawLine call
    const calls = ctx.calls;
    const colorIdx = calls.findIndex(
      (c) => c.kind === "setColor" && (c as { kind: "setColor"; color: string }).color === "WIRE_HIGH",
    );
    const lineIdx = calls.findIndex((c) => c.kind === "line");
    expect(colorIdx).toBeGreaterThanOrEqual(0);
    expect(lineIdx).toBeGreaterThan(colorIdx);
  });

  it("defaultColorWhenNoEngine", () => {
    const wire = makeWire(0, 0, 10, 0);
    renderer.render(ctx, [wire], new Set());

    // Verify WIRE color is set BEFORE the drawLine call
    const calls = ctx.calls;
    const colorIdx = calls.findIndex(
      (c) => c.kind === "setColor" && (c as { kind: "setColor"; color: string }).color === "WIRE",
    );
    const lineIdx = calls.findIndex((c) => c.kind === "line");
    expect(colorIdx).toBeGreaterThanOrEqual(0);
    expect(lineIdx).toBeGreaterThan(colorIdx);
  });

  it("selectedWireHighlighted", () => {
    const wire = makeWire(0, 0, 10, 0);
    const selection = new Set<Wire>([wire]);

    renderer.render(ctx, [wire], selection);

    // Verify SELECTION color is set BEFORE the drawLine call
    const calls = ctx.calls;
    const colorIdx = calls.findIndex(
      (c) => c.kind === "setColor" && (c as { kind: "setColor"; color: string }).color === "SELECTION",
    );
    const lineIdx = calls.findIndex((c) => c.kind === "line");
    expect(colorIdx).toBeGreaterThanOrEqual(0);
    expect(lineIdx).toBeGreaterThan(colorIdx);
  });
});

// ---------------------------------------------------------------------------
// Analog voltage gradient coloring tests
// ---------------------------------------------------------------------------

function makeAnalogAccess(wire: Wire, voltage: number): WireSignalAccess {
  return {
    getWireValue(w: Wire) {
      if (w === wire) return { voltage };
      return undefined;
    },
  };
}

function parseRgb(css: string): [number, number, number] {
  const m = css.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (!m) throw new Error(`Not an rgb string: ${css}`);
  return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
}

describe("AnalogVoltageColoring", () => {
  let ctx: MockRenderContext;
  let renderer: WireRenderer;
  let tracker: VoltageRangeTracker;

  beforeEach(() => {
    ctx = new MockRenderContext();
    renderer = new WireRenderer();
    tracker = new VoltageRangeTracker();
    tracker.setFixedRange(-5, 5);
    renderer.setVoltageTracker(tracker);
    renderer.setColorScheme(darkColorScheme);
  });

  it("positive_voltage_red", () => {
    // 5V in range [-5, 5] → normalized=1.0 → should be WIRE_VOLTAGE_POS (reddish)
    const wire = makeWire(0, 0, 10, 0);
    const access = makeAnalogAccess(wire, 5);

    renderer.render(ctx, [wire], new Set(), access);

    const rawCalls = ctx.callsOfKind("setRawColor");
    expect(rawCalls.length).toBeGreaterThanOrEqual(1);
    const [r, g, b] = parseRgb(rawCalls[0].css);
    // Red channel must dominate over green for positive (reddish) color
    expect(r).toBeGreaterThan(g);
    // Suppress unused variable warning
    void b;
  });

  it("negative_voltage_green", () => {
    // -5V in range [-5, 5] → normalized=0.0 → should be WIRE_VOLTAGE_NEG (greenish)
    const wire = makeWire(0, 0, 10, 0);
    const access = makeAnalogAccess(wire, -5);

    renderer.render(ctx, [wire], new Set(), access);

    const rawCalls = ctx.callsOfKind("setRawColor");
    expect(rawCalls.length).toBeGreaterThanOrEqual(1);
    const [r, g] = parseRgb(rawCalls[0].css);
    // Green channel must dominate over red for negative (greenish) color
    expect(g).toBeGreaterThan(r);
  });

  it("ground_voltage_gray", () => {
    // 0V in range [-5, 5] → normalized=0.5 → should be WIRE_VOLTAGE_GND (gray)
    const wire = makeWire(0, 0, 10, 0);
    const access = makeAnalogAccess(wire, 0);

    renderer.render(ctx, [wire], new Set(), access);

    const rawCalls = ctx.callsOfKind("setRawColor");
    expect(rawCalls.length).toBeGreaterThanOrEqual(1);
    const [r, g, b] = parseRgb(rawCalls[0].css);
    // All channels approximately equal for gray
    expect(Math.abs(r - g)).toBeLessThanOrEqual(2);
    expect(Math.abs(g - b)).toBeLessThanOrEqual(2);
    expect(Math.abs(r - b)).toBeLessThanOrEqual(2);
  });

  it("digital_wires_unchanged", () => {
    // Digital wire value { raw: 1, width: 1 } must use setColor("WIRE_HIGH"), not setRawColor
    const wire = makeWire(0, 0, 10, 0);
    const access: WireSignalAccess = {
      getWireValue(w: Wire) {
        if (w === wire) return { raw: 1, width: 1 };
        return undefined;
      },
    };

    renderer.render(ctx, [wire], new Set(), access);

    // setRawColor must NOT be called
    const rawCalls = ctx.callsOfKind("setRawColor");
    expect(rawCalls.length).toBe(0);

    // setColor("WIRE_HIGH") must be called
    const colorCalls = ctx.callsOfKind("setColor");
    const highCall = colorCalls.find((c) => c.color === "WIRE_HIGH");
    expect(highCall).toBeDefined();
  });
});
