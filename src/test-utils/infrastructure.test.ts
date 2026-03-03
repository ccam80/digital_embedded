/**
 * Smoke tests for test infrastructure.
 *
 * Verifies that MockRenderContext and MockEngine work correctly before any
 * real components are implemented. If these tests pass, `npm test` succeeds
 * and the test infrastructure is ready for Phase 1 tasks.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MockRenderContext } from "./mock-render-context";
import { MockEngine } from "./mock-engine";
import type { CompiledCircuit } from "@/core/engine-interface";

// ---------------------------------------------------------------------------
// MockRenderContext tests
// ---------------------------------------------------------------------------

describe("MockRenderContext", () => {
  let ctx: MockRenderContext;

  beforeEach(() => {
    ctx = new MockRenderContext();
  });

  it("records drawLine calls", () => {
    ctx.drawLine(0, 0, 10, 10);
    const lines = ctx.callsOfKind("line");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({ kind: "line", x1: 0, y1: 0, x2: 10, y2: 10 });
  });

  it("records drawRect calls", () => {
    ctx.drawRect(5, 5, 20, 30, true);
    const rects = ctx.callsOfKind("rect");
    expect(rects).toHaveLength(1);
    expect(rects[0]).toEqual({ kind: "rect", x: 5, y: 5, width: 20, height: 30, filled: true });
  });

  it("records drawCircle calls", () => {
    ctx.drawCircle(10, 10, 5, false);
    const circles = ctx.callsOfKind("circle");
    expect(circles).toHaveLength(1);
    expect(circles[0]).toEqual({ kind: "circle", cx: 10, cy: 10, radius: 5, filled: false });
  });

  it("records drawArc calls", () => {
    ctx.drawArc(0, 0, 10, 0, Math.PI);
    const arcs = ctx.callsOfKind("arc");
    expect(arcs).toHaveLength(1);
    expect(arcs[0]).toEqual({ kind: "arc", cx: 0, cy: 0, radius: 10, startAngle: 0, endAngle: Math.PI });
  });

  it("records drawPolygon calls", () => {
    const points = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 10 }];
    ctx.drawPolygon(points, true);
    const polys = ctx.callsOfKind("polygon");
    expect(polys).toHaveLength(1);
    expect(polys[0]?.points).toBe(points);
    expect(polys[0]?.filled).toBe(true);
  });

  it("records drawPath calls", () => {
    const path = { operations: [{ op: "moveTo" as const, x: 0, y: 0 }] };
    ctx.drawPath(path);
    const paths = ctx.callsOfKind("path");
    expect(paths).toHaveLength(1);
    expect(paths[0]?.path).toBe(path);
  });

  it("records drawText calls", () => {
    const anchor = { horizontal: "center" as const, vertical: "middle" as const };
    ctx.drawText("Hello", 10, 20, anchor);
    const texts = ctx.callsOfKind("text");
    expect(texts).toHaveLength(1);
    expect(texts[0]).toEqual({ kind: "text", text: "Hello", x: 10, y: 20, anchor });
  });

  it("tracks style state: setColor", () => {
    ctx.setColor("WIRE_HIGH");
    expect(ctx.style.color).toBe("WIRE_HIGH");
    const colorCalls = ctx.callsOfKind("setColor");
    expect(colorCalls).toHaveLength(1);
    expect(colorCalls[0]?.color).toBe("WIRE_HIGH");
  });

  it("tracks style state: setLineWidth", () => {
    ctx.setLineWidth(3);
    expect(ctx.style.lineWidth).toBe(3);
  });

  it("tracks style state: setFont", () => {
    const font = { family: "monospace", size: 14, weight: "bold" as const };
    ctx.setFont(font);
    expect(ctx.style.font).toEqual(font);
  });

  it("tracks style state: setLineDash", () => {
    ctx.setLineDash([4, 2]);
    expect(ctx.style.lineDash).toEqual([4, 2]);
  });

  it("save/restore preserves style stack", () => {
    ctx.setColor("WIRE_HIGH");
    ctx.save();
    ctx.setColor("WIRE_LOW");
    expect(ctx.style.color).toBe("WIRE_LOW");
    ctx.restore();
    expect(ctx.style.color).toBe("WIRE_HIGH");
  });

  it("records transform calls", () => {
    ctx.translate(5, 10);
    ctx.rotate(Math.PI / 2);
    ctx.scale(2, 2);
    expect(ctx.callsOfKind("translate")).toHaveLength(1);
    expect(ctx.callsOfKind("rotate")).toHaveLength(1);
    expect(ctx.callsOfKind("scale")).toHaveLength(1);
    expect(ctx.callsOfKind("translate")[0]).toEqual({ kind: "translate", dx: 5, dy: 10 });
  });

  it("reset clears calls and style", () => {
    ctx.drawLine(0, 0, 1, 1);
    ctx.setColor("WIRE_HIGH");
    ctx.reset();
    expect(ctx.calls).toHaveLength(0);
    expect(ctx.style.color).toBe("COMPONENT");
  });

  it("accumulates multiple draw calls in order", () => {
    ctx.drawLine(0, 0, 1, 1);
    ctx.drawRect(0, 0, 10, 10, false);
    ctx.drawText("A", 5, 5, { horizontal: "left", vertical: "top" });
    expect(ctx.calls).toHaveLength(3);
    expect(ctx.calls[0]?.kind).toBe("line");
    expect(ctx.calls[1]?.kind).toBe("rect");
    expect(ctx.calls[2]?.kind).toBe("text");
  });
});

// ---------------------------------------------------------------------------
// MockEngine tests
// ---------------------------------------------------------------------------

describe("MockEngine", () => {
  let engine: MockEngine;

  const circuit: CompiledCircuit = {
    netCount: 8,
    componentCount: 4,
  };

  beforeEach(() => {
    engine = new MockEngine();
  });

  it("starts in STOPPED state", () => {
    expect(engine.getState()).toBe("STOPPED");
  });

  it("init allocates signal array matching circuit.netCount", () => {
    engine.init(circuit);
    expect(engine.signals).toHaveLength(8);
  });

  it("init records method call", () => {
    engine.init(circuit);
    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0]).toEqual({ method: "init", circuit });
  });

  it("getSignalRaw returns 0 for freshly initialised nets", () => {
    engine.init(circuit);
    expect(engine.getSignalRaw(0)).toBe(0);
    expect(engine.getSignalRaw(7)).toBe(0);
  });

  it("setSignalRaw injects a value readable via getSignalRaw", () => {
    engine.init(circuit);
    engine.setSignalRaw(3, 0xdeadbeef);
    // getSignalRaw records a call and returns the value
    const val = engine.getSignalRaw(3);
    expect(val >>> 0).toBe(0xdeadbeef >>> 0);
  });

  it("getSignalValue returns a BitVector for the stored raw value", () => {
    engine.init(circuit);
    engine.setSignalRaw(2, 42);
    const bv = engine.getSignalValue(2);
    expect(bv.toNumber()).toBe(42);
    expect(bv.toBigInt()).toBe(42n);
    expect(bv.toString(16)).toBe("2a");
  });

  it("setSignalValue stores the value and is readable via getSignalRaw", () => {
    engine.init(circuit);
    engine.getSignalValue(0); // verify it doesn't throw
    engine.setSignalRaw(0, 7);
    const bvSeven = engine.getSignalValue(0);
    engine.setSignalValue(1, bvSeven);
    // The raw value at net 1 should now be 7
    engine.resetCalls();
    expect(engine.getSignalRaw(1)).toBe(7);
  });

  it("start transitions state to RUNNING and notifies listeners", () => {
    engine.init(circuit);
    let notified: string | null = null;
    engine.addChangeListener((s) => { notified = s; });
    engine.start();
    expect(engine.getState()).toBe("RUNNING");
    expect(notified).toBe("RUNNING");
  });

  it("stop transitions state to PAUSED and notifies listeners", () => {
    engine.init(circuit);
    engine.start();
    let notified: string | null = null;
    engine.addChangeListener((s) => { notified = s; });
    engine.stop();
    expect(engine.getState()).toBe("PAUSED");
    expect(notified).toBe("PAUSED");
  });

  it("reset zeroes all signals and transitions to STOPPED", () => {
    engine.init(circuit);
    engine.setSignalRaw(0, 255);
    engine.start();
    engine.reset();
    expect(engine.getState()).toBe("STOPPED");
    engine.resetCalls();
    expect(engine.getSignalRaw(0)).toBe(0);
  });

  it("removeChangeListener stops notifications", () => {
    engine.init(circuit);
    let count = 0;
    const listener = () => { count++; };
    engine.addChangeListener(listener);
    engine.start();
    engine.removeChangeListener(listener);
    engine.stop();
    expect(count).toBe(1);
  });

  it("records step, microStep, runToBreak calls", () => {
    engine.init(circuit);
    engine.resetCalls();
    engine.step();
    engine.microStep();
    engine.runToBreak();
    const methods = engine.calls.map((c) => c.method);
    expect(methods).toEqual(["step", "microStep", "runToBreak"]);
  });

  it("dispose clears circuit and listeners", () => {
    engine.init(circuit);
    let notified = false;
    engine.addChangeListener(() => { notified = true; });
    engine.dispose();
    expect(engine.getState()).toBe("STOPPED");
    // after dispose, start() would not notify former listeners
    engine.start();
    expect(notified).toBe(false);
  });

  it("resetCalls empties the call log", () => {
    engine.init(circuit);
    engine.step();
    engine.resetCalls();
    expect(engine.calls).toHaveLength(0);
  });

  it("getSignalRaw returns 0 for out-of-bounds netId", () => {
    engine.init(circuit);
    expect(engine.getSignalRaw(999)).toBe(0);
  });
});
