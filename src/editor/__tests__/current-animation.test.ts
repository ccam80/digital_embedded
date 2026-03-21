/**
 * Tests for CurrentFlowAnimator — animated current-flow dots.
 */

import { describe, it, expect } from "vitest";
import { CurrentFlowAnimator } from "../current-animation";
import { Wire, Circuit } from "@/core/circuit";
import type { WireCurrentResolver, WireCurrentResult } from "../wire-current-resolver";
import type { RenderContext } from "@/core/renderer-interface";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWire(x1: number, y1: number, x2: number, y2: number): Wire {
  return new Wire({ x: x1, y: y1 }, { x: x2, y: y2 });
}

/** Build a mock WireCurrentResolver that returns specified results per wire. */
function makeResolver(results: Map<Wire, WireCurrentResult>): WireCurrentResolver {
  return {
    getWireCurrent: (w: Wire) => results.get(w),
    getComponentPaths: () => [],
    resolve: () => {},
    clear: () => {},
  } as unknown as WireCurrentResolver;
}

/** Build a mock RenderContext that records draw calls. */
function makeCtx() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const ctx: RenderContext = {
    drawLine: (...args) => calls.push({ method: "drawLine", args }),
    drawRect: (...args) => calls.push({ method: "drawRect", args }),
    drawCircle: (...args) => calls.push({ method: "drawCircle", args }),
    drawArc: (...args) => calls.push({ method: "drawArc", args }),
    drawPolygon: (...args) => calls.push({ method: "drawPolygon", args }),
    drawPath: (...args) => calls.push({ method: "drawPath", args }),
    drawText: (...args) => calls.push({ method: "drawText", args }),
    save: () => calls.push({ method: "save", args: [] }),
    restore: () => calls.push({ method: "restore", args: [] }),
    translate: (...args) => calls.push({ method: "translate", args }),
    rotate: (...args) => calls.push({ method: "rotate", args }),
    scale: (...args) => calls.push({ method: "scale", args }),
    setColor: (...args) => calls.push({ method: "setColor", args }),
    setRawColor: (...args) => calls.push({ method: "setRawColor", args }),
    setLineWidth: (...args) => calls.push({ method: "setLineWidth", args }),
    setFont: (...args) => calls.push({ method: "setFont", args }),
    setLineDash: (...args) => calls.push({ method: "setLineDash", args }),
  };
  return { ctx, calls };
}

function getDotXPositions(animator: CurrentFlowAnimator, circuit: Circuit): number[] {
  const { ctx, calls } = makeCtx();
  animator.render(ctx, circuit);
  return calls.filter(c => c.method === "drawCircle").map(c => c.args[0] as number);
}

function getFirstDotX(animator: CurrentFlowAnimator, circuit: Circuit): number {
  return getDotXPositions(animator, circuit)[0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CurrentAnimation", () => {
  it("dots advance when current is nonzero", () => {
    const wire = makeWire(0, 0, 10, 0);
    const circuit = new Circuit();
    circuit.addWire(wire);

    const results = new Map<Wire, WireCurrentResult>([
      [wire, { current: 0.01, direction: [1, 0], flowSign: 1 as const }],
    ]);
    const resolver = makeResolver(results);
    const animator = new CurrentFlowAnimator(resolver);
    animator.setSpeedScale(200);

    // Initialize
    animator.update(0.016, circuit);
    const xBefore = getFirstDotX(animator, circuit);

    // Advance several frames
    for (let i = 0; i < 10; i++) animator.update(0.016, circuit);
    const xAfter = getFirstDotX(animator, circuit);

    expect(xAfter).not.toBeCloseTo(xBefore, 3);
    expect(xAfter - xBefore).toBeGreaterThan(0);
  });

  it("dots wrap around", () => {
    const wire = makeWire(0, 0, 1, 0);
    const circuit = new Circuit();
    circuit.addWire(wire);

    const results = new Map<Wire, WireCurrentResult>([
      [wire, { current: 1.0, direction: [1, 0], flowSign: 1 as const }],
    ]);
    const resolver = makeResolver(results);
    const animator = new CurrentFlowAnimator(resolver);
    animator.setSpeedScale(200);

    // Advance enough to wrap multiple times
    for (let i = 0; i < 200; i++) animator.update(0.1, circuit);

    const x = getFirstDotX(animator, circuit);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThan(1);
  });

  it("zero current does not advance dots", () => {
    const wire = makeWire(0, 0, 4, 0);
    const circuit = new Circuit();
    circuit.addWire(wire);

    const results = new Map<Wire, WireCurrentResult>([
      [wire, { current: 0, direction: [1, 0], flowSign: 0 as const }],
    ]);
    const resolver = makeResolver(results);
    const animator = new CurrentFlowAnimator(resolver);

    // Zero-current wires still render dots (offset stays at 0) but don't move
    animator.update(0.016, circuit);
    const { ctx, calls } = makeCtx();
    animator.render(ctx, circuit);
    const dots = calls.filter(c => c.method === "drawCircle");
    expect(dots.length).toBeGreaterThan(0);
  });

  it("higher current moves dots faster than lower current", () => {
    const wireFast = makeWire(0, 0, 10, 0);
    const wireSlow = makeWire(0, 2, 10, 2);
    const circuit = new Circuit();
    circuit.addWire(wireFast);
    circuit.addWire(wireSlow);

    const results = new Map<Wire, WireCurrentResult>([
      [wireFast, { current: 0.010, direction: [1, 0], flowSign: 1 as const }],
      [wireSlow, { current: 0.005, direction: [1, 0], flowSign: 1 as const }],
    ]);
    const resolver = makeResolver(results);
    const animator = new CurrentFlowAnimator(resolver);
    animator.setSpeedScale(200);

    // Snapshot before
    animator.update(0.016, circuit);
    const { ctx: ctx1, calls: c1 } = makeCtx();
    animator.render(ctx1, circuit);
    const circles1 = c1.filter(c => c.method === "drawCircle");
    const xFastBefore = circles1[0]?.args[0] as number;
    const wireSlowCircles1 = circles1.filter(c => (c.args[1] as number) > 1);
    const xSlowBefore = wireSlowCircles1[0]?.args[0] as number;

    for (let i = 0; i < 10; i++) animator.update(0.016, circuit);

    const { ctx: ctx2, calls: c2 } = makeCtx();
    animator.render(ctx2, circuit);
    const circles2 = c2.filter(c => c.method === "drawCircle");
    const xFastAfter = circles2[0]?.args[0] as number;
    const wireSlowCircles2 = circles2.filter(c => (c.args[1] as number) > 1);
    const xSlowAfter = wireSlowCircles2[0]?.args[0] as number;

    const deltaFast = xFastAfter - xFastBefore;
    const deltaSlow = xSlowAfter - xSlowBefore;

    expect(deltaFast).toBeGreaterThan(0);
    expect(deltaSlow).toBeGreaterThan(0);
    expect(deltaFast / deltaSlow).toBeCloseTo(2, 0);
  });

  it("disabled skips render", () => {
    const wire = makeWire(0, 0, 4, 0);
    const circuit = new Circuit();
    circuit.addWire(wire);

    const results = new Map<Wire, WireCurrentResult>([
      [wire, { current: 0.01, direction: [1, 0], flowSign: 1 as const }],
    ]);
    const resolver = makeResolver(results);
    const animator = new CurrentFlowAnimator(resolver);

    animator.setEnabled(false);
    expect(animator.enabled).toBe(false);

    const { ctx, calls } = makeCtx();
    animator.render(ctx, circuit);

    const drawCalls = calls.filter(c => c.method === "drawCircle");
    expect(drawCalls).toHaveLength(0);
  });

  it("logarithmic mode makes small currents visible", () => {
    const wire = makeWire(0, 0, 10, 0);
    const circuit = new Circuit();
    circuit.addWire(wire);

    const results = new Map<Wire, WireCurrentResult>([
      [wire, { current: 1e-6, direction: [1, 0], flowSign: 1 as const }], // 1 uA — very small
    ]);
    const resolver = makeResolver(results);
    const animator = new CurrentFlowAnimator(resolver);
    animator.setSpeedScale(200);
    animator.setScaleMode("logarithmic");

    animator.update(0.016, circuit);
    const xBefore = getFirstDotX(animator, circuit);

    for (let i = 0; i < 30; i++) animator.update(0.016, circuit);
    const xAfter = getFirstDotX(animator, circuit);

    // Even 1uA should produce visible movement in log mode
    expect(Math.abs(xAfter - xBefore)).toBeGreaterThan(0.001);
  });

  it("negative flowSign reverses dot movement", () => {
    const wire = makeWire(0, 0, 10, 0);
    const circuit = new Circuit();
    circuit.addWire(wire);

    const results = new Map<Wire, WireCurrentResult>([
      [wire, { current: 0.01, direction: [1, 0], flowSign: -1 as const }],
    ]);
    const resolver = makeResolver(results);
    const animator = new CurrentFlowAnimator(resolver);
    animator.setSpeedScale(200);

    animator.update(0.016, circuit);
    const xBefore = getFirstDotX(animator, circuit);

    for (let i = 0; i < 10; i++) animator.update(0.016, circuit);
    const xAfter = getFirstDotX(animator, circuit);

    // Dots should move in REVERSE (end→start = right to left = decreasing x)
    expect(xAfter - xBefore).toBeLessThan(0);
  });

  it("short and long wires with same current have equal absolute dot speed", () => {
    const shortWire = makeWire(0, 0, 2, 0);  // 2 grid units
    const longWire = makeWire(0, 2, 10, 2);  // 8 grid units
    const circuit = new Circuit();
    circuit.addWire(shortWire);
    circuit.addWire(longWire);

    const I = 0.01;
    const results = new Map<Wire, WireCurrentResult>([
      [shortWire, { current: I, direction: [1, 0], flowSign: 1 as const }],
      [longWire, { current: I, direction: [1, 0], flowSign: 1 as const }],
    ]);
    const resolver = makeResolver(results);
    const animator = new CurrentFlowAnimator(resolver);
    animator.setSpeedScale(200);

    // Snapshot before
    animator.update(0.016, circuit);
    const { ctx: ctx1, calls: c1 } = makeCtx();
    animator.render(ctx1, circuit);
    const dots1 = c1.filter(c => c.method === "drawCircle");
    const shortDots1 = dots1.filter(c => (c.args[1] as number) < 1);
    const longDots1 = dots1.filter(c => (c.args[1] as number) > 1);
    const xShortBefore = shortDots1[0]?.args[0] as number;
    const xLongBefore = longDots1[0]?.args[0] as number;

    // Advance
    for (let i = 0; i < 10; i++) animator.update(0.016, circuit);

    const { ctx: ctx2, calls: c2 } = makeCtx();
    animator.render(ctx2, circuit);
    const dots2 = c2.filter(c => c.method === "drawCircle");
    const shortDots2 = dots2.filter(c => (c.args[1] as number) < 1);
    const longDots2 = dots2.filter(c => (c.args[1] as number) > 1);
    const xShortAfter = shortDots2[0]?.args[0] as number;
    const xLongAfter = longDots2[0]?.args[0] as number;

    const deltaShort = xShortAfter - xShortBefore;
    const deltaLong = xLongAfter - xLongBefore;

    // Same current → same absolute speed → same x displacement
    expect(deltaShort).toBeCloseTo(deltaLong, 5);
  });

  it("dots are continuous across adjacent wire segments", () => {
    // Two wires meeting at (5,0): [0,0]->[5,0] and [5,0]->[8,0]
    const wire1 = makeWire(0, 0, 5, 0);
    const wire2 = makeWire(5, 0, 8, 0);
    const circuit = new Circuit();
    circuit.addWire(wire1);
    circuit.addWire(wire2);

    const I = 0.01;
    const results = new Map<Wire, WireCurrentResult>([
      [wire1, { current: I, direction: [1, 0], flowSign: 1 as const }],
      [wire2, { current: I, direction: [1, 0], flowSign: 1 as const }],
    ]);
    const resolver = makeResolver(results);
    const animator = new CurrentFlowAnimator(resolver);
    animator.setSpeedScale(200);

    // Advance a bit to get a non-trivial offset
    for (let i = 0; i < 5; i++) animator.update(0.016, circuit);

    // Collect all dot x-positions (both wires are on y=0)
    const xs = getDotXPositions(animator, circuit).sort((a, b) => a - b);

    // Verify uniform spacing: consecutive dots should be ~1.0 apart
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i] - xs[i - 1]).toBeCloseTo(1.0, 3);
    }
  });
});
