/**
 * Tests for FSM hit testing (task 10.1.2).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { hitTestFSM } from "@/fsm/fsm-hit-test";
import { createFSM, addState, resetIdCounter } from "@/fsm/model";
import type { FSM } from "@/fsm/model";

describe("FSMHitTest", () => {
  let fsm: FSM;

  beforeEach(() => {
    resetIdCounter();
    fsm = createFSM("test");
  });

  it("hitState", () => {
    const state = addState(fsm, "S0", { x: 100, y: 100 }, true);

    const result = hitTestFSM(fsm, 105, 105);
    expect(result.type).toBe("state");
    if (result.type === "state") {
      expect(result.state.id).toBe(state.id);
    }
  });

  it("missState", () => {
    addState(fsm, "S0", { x: 100, y: 100 }, true);

    const result = hitTestFSM(fsm, 500, 500);
    expect(result.type).toBe("none");
  });
});
