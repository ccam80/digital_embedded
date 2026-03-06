/**
 * Tests for FSM auto-layout (task 10.1.2).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { autoLayoutCircle } from "@/fsm/auto-layout";
import { createFSM, addState, resetIdCounter } from "@/fsm/model";
import type { FSM } from "@/fsm/model";

describe("AutoLayout", () => {
  let fsm: FSM;

  beforeEach(() => {
    resetIdCounter();
    fsm = createFSM("test");
  });

  it("circleLayout", () => {
    addState(fsm, "S0", { x: 0, y: 0 }, true);
    addState(fsm, "S1", { x: 0, y: 0 }, false);
    addState(fsm, "S2", { x: 0, y: 0 }, false);
    addState(fsm, "S3", { x: 0, y: 0 }, false);

    const cx = 200;
    const cy = 200;
    autoLayoutCircle(fsm, cx, cy);

    for (const state of fsm.states) {
      const dx = state.position.x - cx;
      const dy = state.position.y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      expect(dist).toBeGreaterThan(0);
    }

    const positions = fsm.states.map((s) => ({ x: s.position.x, y: s.position.y }));
    const uniquePositions = new Set(positions.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`));
    expect(uniquePositions.size).toBe(4);

    const distances = fsm.states.map((s) => {
      const dx = s.position.x - cx;
      const dy = s.position.y - cy;
      return Math.sqrt(dx * dx + dy * dy);
    });
    const firstDist = distances[0]!;
    for (const d of distances) {
      expect(Math.abs(d - firstDist)).toBeLessThan(0.001);
    }
  });
});
