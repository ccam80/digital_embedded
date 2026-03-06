/**
 * Tests for FSM renderer (task 10.1.2).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MockRenderContext } from "@/test-utils/mock-render-context";
import { renderState, renderTransition, renderSelfLoop } from "@/fsm/fsm-renderer";
import type { FSM, FSMState, FSMTransition } from "@/fsm/model";
import { createFSM, addState, addTransition, resetIdCounter } from "@/fsm/model";

describe("FSMRenderer", () => {
  let ctx: MockRenderContext;

  beforeEach(() => {
    ctx = new MockRenderContext();
    resetIdCounter();
  });

  it("drawState", () => {
    const state: FSMState = {
      id: "s1",
      name: "IDLE",
      position: { x: 100, y: 100 },
      outputs: {},
      isInitial: false,
      radius: 30,
    };

    renderState(ctx, state, false);

    const circles = ctx.callsOfKind("circle");
    expect(circles).toHaveLength(1);
    expect(circles[0]!.cx).toBe(100);
    expect(circles[0]!.cy).toBe(100);
    expect(circles[0]!.radius).toBe(30);
    expect(circles[0]!.filled).toBe(false);

    const texts = ctx.callsOfKind("text");
    expect(texts.length).toBeGreaterThanOrEqual(1);
    const nameText = texts.find((t) => t.text === "IDLE");
    expect(nameText).toBeDefined();
    expect(nameText!.x).toBe(100);
    expect(nameText!.y).toBe(100);
  });

  it("drawInitialState", () => {
    const state: FSMState = {
      id: "s1",
      name: "S0",
      position: { x: 150, y: 150 },
      outputs: {},
      isInitial: true,
      radius: 30,
    };

    renderState(ctx, state, false);

    const circles = ctx.callsOfKind("circle");
    expect(circles).toHaveLength(2);
    expect(circles[0]!.radius).toBe(30);
    expect(circles[1]!.radius).toBe(26);
  });

  it("drawTransition", () => {
    const fsm = createFSM("test");
    const s1 = addState(fsm, "A", { x: 50, y: 100 }, { isInitial: true });
    const s2 = addState(fsm, "B", { x: 250, y: 100 }, { isInitial: false });
    const t = addTransition(fsm, s1.id, s2.id, "X & Y");

    renderTransition(ctx, fsm, t, false);

    const lines = ctx.callsOfKind("line");
    const paths = ctx.callsOfKind("path");
    expect(lines.length + paths.length).toBeGreaterThanOrEqual(1);

    const polygons = ctx.callsOfKind("polygon");
    expect(polygons.length).toBeGreaterThanOrEqual(1);

    const texts = ctx.callsOfKind("text");
    const conditionText = texts.find((t) => t.text === "X & Y");
    expect(conditionText).toBeDefined();
  });

  it("drawSelfLoop", () => {
    const state: FSMState = {
      id: "s1",
      name: "WAIT",
      position: { x: 200, y: 200 },
      outputs: {},
      isInitial: false,
      radius: 30,
    };

    const transition: FSMTransition = {
      id: "t1",
      sourceStateId: "s1",
      targetStateId: "s1",
      condition: "CLK",
      controlPoints: [],
    };

    renderSelfLoop(ctx, state, transition, false);

    const arcs = ctx.callsOfKind("arc");
    expect(arcs).toHaveLength(1);

    const polygons = ctx.callsOfKind("polygon");
    expect(polygons.length).toBeGreaterThanOrEqual(1);

    const texts = ctx.callsOfKind("text");
    const condText = texts.find((t) => t.text === "CLK");
    expect(condText).toBeDefined();
  });
});
