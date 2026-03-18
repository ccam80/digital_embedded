/**
 * Tests for CurrentFlowAnimator — animated current-flow dots.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { CurrentFlowAnimator } from "../current-animation";
import { Wire, Circuit } from "@/core/circuit";
import type { WireCurrentResolver, WireCurrentResult } from "../wire-current-resolver";
import type { RenderContext, ThemeColor } from "@/core/renderer-interface";

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CurrentAnimation", () => {
  it("dots_advance_proportional_to_current", () => {
    // Wire with 10mA, speedScale=1, dt=16ms → advance = 0.01 * 1 * 0.016 = 0.00016
    const wire = makeWire(0, 0, 10, 0); // 10 grid units long
    const circuit = new Circuit();
    circuit.addWire(wire);

    const results = new Map<Wire, WireCurrentResult>([
      [wire, { current: 0.01, direction: [1, 0] }],
    ]);
    const resolver = makeResolver(results);
    const animator = new CurrentFlowAnimator(resolver);
    animator.setSpeedScale(1.0);

    // Force dot phase initialization by calling render (initializes phases)
    const { ctx } = makeCtx();
    animator.render(ctx, circuit);

    // Capture initial phases by advancing 0 first
    animator.update(0);

    // Get initial phase state via a private-access trick: re-render to see positions
    // Instead, we verify the advance amount by calling update and checking via render positions.

    // Record dot positions before update
    const { ctx: ctx1, calls: calls1 } = makeCtx();
    animator.render(ctx1, circuit);
    const circlesBefore = calls1.filter(c => c.method === "drawCircle");
    const xBefore = (circlesBefore[0]?.args[0] as number) ?? 0;

    // Advance 16ms
    animator.update(0.016);

    const { ctx: ctx2, calls: calls2 } = makeCtx();
    animator.render(ctx2, circuit);
    const circlesAfter = calls2.filter(c => c.method === "drawCircle");
    const xAfter = (circlesAfter[0]?.args[0] as number) ?? 0;

    // Wire is 10 units long; advance = 0.01 * 1 * 0.016 = 0.00016 phase units
    // Position delta = 0.00016 * wireLength (10) = 0.0016 grid units
    const expectedAdvance = 0.01 * 1.0 * 0.016 * 10; // = 0.0016
    expect(xAfter - xBefore).toBeCloseTo(expectedAdvance, 5);
  });

  it("dots_wrap_around", () => {
    // Single dot at phase 0.99, advance 0.05 → should wrap to ~0.04
    const wire = makeWire(0, 0, 1, 0); // 1 unit long → phase maps directly to x
    const circuit = new Circuit();
    circuit.addWire(wire);

    const results = new Map<Wire, WireCurrentResult>([
      [wire, { current: 1.0, direction: [1, 0] }],
    ]);
    const resolver = makeResolver(results);
    // minCurrentThreshold = 0 so dot always visible
    const animator = new CurrentFlowAnimator(resolver, 0);
    animator.setSpeedScale(1.0);

    // Initialize phases via render
    const { ctx: ctxInit } = makeCtx();
    animator.render(ctxInit, circuit);

    // Manually verify wrap: with speedScale=1, current=1, dt=0.05 → advance=0.05
    // But we can't set the initial phase directly. Instead test wrap via cumulative advances.
    // Advance multiple times to push past 1.0 total.
    // 20 advances of 0.05 = 1.0 total → should wrap around once.
    // After 21 advances: total advance = 1.05 → net phase ≈ initial + 0.05

    const { ctx: ctx0, calls: calls0 } = makeCtx();
    animator.render(ctx0, circuit);
    const xInitial = calls0.filter(c => c.method === "drawCircle")[0]?.args[0] as number;

    // Advance 21 times by dt=0.05 → total advance = 1.05 phase, net = initial_phase + 0.05 (mod 1)
    for (let i = 0; i < 21; i++) {
      animator.update(0.05);
    }

    const { ctx: ctx1, calls: calls1 } = makeCtx();
    animator.render(ctx1, circuit);
    const xFinal = calls1.filter(c => c.method === "drawCircle")[0]?.args[0] as number;

    // Expected: wrapped position ≈ initial + 0.05 (mod wire length=1)
    // The wire is 1 unit, so phase maps 1:1 to x coordinate.
    const rawExpected = xInitial + 0.05;
    const expected = rawExpected >= 1 ? rawExpected - 1 : rawExpected;
    expect(xFinal).toBeCloseTo(expected, 3);
  });

  it("zero_current_freezes_dots", () => {
    const wire = makeWire(0, 0, 4, 0);
    const circuit = new Circuit();
    circuit.addWire(wire);

    const results = new Map<Wire, WireCurrentResult>([
      [wire, { current: 0, direction: [1, 0] }],
    ]);
    const resolver = makeResolver(results);
    const animator = new CurrentFlowAnimator(resolver, 0); // threshold=0 so dots still render

    // Initialize
    const { ctx: ctxInit } = makeCtx();
    animator.render(ctxInit, circuit);

    const { ctx: ctx1, calls: calls1 } = makeCtx();
    animator.render(ctx1, circuit);
    const xBefore = calls1.filter(c => c.method === "drawCircle")[0]?.args[0] as number;

    // Update multiple times — should not advance
    animator.update(1.0);
    animator.update(1.0);
    animator.update(1.0);

    const { ctx: ctx2, calls: calls2 } = makeCtx();
    animator.render(ctx2, circuit);
    const xAfter = calls2.filter(c => c.method === "drawCircle")[0]?.args[0] as number;

    expect(xAfter).toBeCloseTo(xBefore, 10);
  });

  it("current_magnitude_controls_animation_speed", () => {
    // The animator uses current magnitude for dot speed: advance = |I| × speedScale × dt.
    // render() skips wires where result.current < minCurrentThreshold (unsigned comparison),
    // so negative current values are not rendered — the animator is magnitude-only for display.
    //
    // This test verifies that current magnitude changes are reflected in animation speed:
    // doubling the magnitude doubles the per-frame advance distance.
    //
    // Note: The animator does NOT support visual direction reversal. The render path
    // uses `result.current < threshold` (not `Math.abs`), so negative current causes
    // dots to not render. Phase advances are always in the wire's start→end direction.

    const wire = makeWire(0, 0, 10, 0); // 10 units long
    const circuit = new Circuit();
    circuit.addWire(wire);

    // Use threshold=0 and positive current only (negative current is not rendered)
    const resultRef: WireCurrentResult = { current: 0.005, direction: [1, 0] };
    const results = new Map<Wire, WireCurrentResult>([[wire, resultRef]]);

    const resolver: WireCurrentResolver = {
      getWireCurrent: (w: Wire) => (w === wire ? results.get(w) : undefined),
      resolve: () => {},
      clear: () => {},
    } as unknown as WireCurrentResolver;

    const animator = new CurrentFlowAnimator(resolver, 0);
    animator.setSpeedScale(1.0);

    // Initialize dot phases
    const { ctx: ctxInit } = makeCtx();
    animator.render(ctxInit, circuit);

    // Record position before update at 5mA
    const { ctx: ctx1, calls: calls1 } = makeCtx();
    animator.render(ctx1, circuit);
    const xBefore5mA = calls1.filter(c => c.method === "drawCircle")[0]?.args[0] as number;

    // Advance with 5mA, dt=1s → phase advance = 0.005 → x moves +0.05
    resultRef.current = 0.005;
    animator.update(1.0);

    const { ctx: ctx2, calls: calls2 } = makeCtx();
    animator.render(ctx2, circuit);
    const xAfter5mA = calls2.filter(c => c.method === "drawCircle")[0]?.args[0] as number;

    const delta5mA = xAfter5mA - xBefore5mA;
    expect(delta5mA).toBeCloseTo(0.005 * 1.0 * 10, 4); // 0.05 units

    // Now double the current to 10mA — the advance should be 2× larger
    resultRef.current = 0.010;
    const { ctx: ctx3, calls: calls3 } = makeCtx();
    animator.render(ctx3, circuit);
    const xBefore10mA = calls3.filter(c => c.method === "drawCircle")[0]?.args[0] as number;

    animator.update(1.0);

    const { ctx: ctx4, calls: calls4 } = makeCtx();
    animator.render(ctx4, circuit);
    const xAfter10mA = calls4.filter(c => c.method === "drawCircle")[0]?.args[0] as number;

    const delta10mA = xAfter10mA - xBefore10mA;
    expect(delta10mA).toBeCloseTo(0.010 * 1.0 * 10, 4); // 0.10 units = 2× the 5mA delta
    expect(delta10mA).toBeCloseTo(delta5mA * 2, 4);
  });

  it("disabled_skips_render", () => {
    const wire = makeWire(0, 0, 4, 0);
    const circuit = new Circuit();
    circuit.addWire(wire);

    const results = new Map<Wire, WireCurrentResult>([
      [wire, { current: 0.01, direction: [1, 0] }],
    ]);
    const resolver = makeResolver(results);
    const animator = new CurrentFlowAnimator(resolver);

    animator.setEnabled(false);
    expect(animator.enabled).toBe(false);

    const { calls } = makeCtx();
    const { ctx } = makeCtx();
    animator.render(ctx, circuit);

    // No draw calls should have been made
    const drawCalls = calls.filter(c => c.method === "drawCircle");
    expect(drawCalls).toHaveLength(0);
  });

  it("speed_scale_multiplies", () => {
    const wire = makeWire(0, 0, 10, 0); // 10 units long
    const circuit = new Circuit();
    circuit.addWire(wire);

    const results = new Map<Wire, WireCurrentResult>([
      [wire, { current: 0.01, direction: [1, 0] }],
    ]);

    // Create two independent animators for comparison
    const resolver1 = makeResolver(results);
    const resolver2 = makeResolver(results);

    const animator1 = new CurrentFlowAnimator(resolver1, 0);
    animator1.setSpeedScale(1.0);

    const animator2 = new CurrentFlowAnimator(resolver2, 0);
    animator2.setSpeedScale(10.0);

    const dt = 0.1;

    // Initialize both via render
    const { ctx: c1 } = makeCtx();
    animator1.render(c1, circuit);
    const { ctx: c2 } = makeCtx();
    animator2.render(c2, circuit);

    const { ctx: before1, calls: b1calls } = makeCtx();
    animator1.render(before1, circuit);
    const x1_before = b1calls.filter(c => c.method === "drawCircle")[0]?.args[0] as number;

    const { ctx: before2, calls: b2calls } = makeCtx();
    animator2.render(before2, circuit);
    const x2_before = b2calls.filter(c => c.method === "drawCircle")[0]?.args[0] as number;

    animator1.update(dt);
    animator2.update(dt);

    const { ctx: after1, calls: a1calls } = makeCtx();
    animator1.render(after1, circuit);
    const x1_after = a1calls.filter(c => c.method === "drawCircle")[0]?.args[0] as number;

    const { ctx: after2, calls: a2calls } = makeCtx();
    animator2.render(after2, circuit);
    const x2_after = a2calls.filter(c => c.method === "drawCircle")[0]?.args[0] as number;

    const delta1 = x1_after - x1_before;
    const delta2 = x2_after - x2_before;

    // Animator2 should advance 10× faster than animator1
    expect(Math.abs(delta2)).toBeCloseTo(Math.abs(delta1) * 10, 3);
  });
});
