/**
 * Two-phase flip-flop tests (Task 2.3a).
 *
 * Verifies that edge-triggered flip-flops correctly split into sampleFn + executeFn,
 * and that async flip-flops have no sampleFn.
 */

import { describe, it, expect } from "vitest";
import { sampleD, executeD, DDefinition } from "../d.js";
import { DAsyncDefinition } from "../d-async.js";
import { sampleJK, executeJK as _executeJK, JKDefinition } from "../jk.js";
import { JKAsyncDefinition } from "../jk-async.js";
import { sampleRS, executeRS as _executeRS, RSDefinition } from "../rs.js";
import { RSAsyncDefinition } from "../rs-async.js";
import { sampleT, executeT as _executeT, TDefinition } from "../t.js";
import { sampleMonoflop, executeMonoflop as _executeMonoflop, MonoflopDefinition } from "../monoflop.js";
import type { ComponentLayout } from "../../../core/registry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface LayoutWithState extends ComponentLayout {
  stateOffset(componentIndex: number): number;
}

function makeLayout(
  inputCount: number,
  outputCount: number,
  stateCount: number,
  timerDelay?: number,
): LayoutWithState {
  const outputStart = inputCount;
  const stateStart = inputCount + outputCount;
  const totalSlots = inputCount + outputCount + stateCount;
  const wiringTable = new Int32Array(totalSlots).map((_, i) => i);

  return {
    inputCount: () => inputCount,
    inputOffset: () => 0,
    outputCount: () => outputCount,
    outputOffset: () => outputStart,
    stateOffset: () => stateStart,
    wiringTable,
    getProperty: (_i: number, key: string) => (key === "timerDelay" && timerDelay !== undefined ? timerDelay : 0),
  };
}

function makeState(totalSlots: number, initial?: Partial<Record<number, number>>): Uint32Array {
  const arr = new Uint32Array(totalSlots);
  if (initial) {
    for (const [idx, val] of Object.entries(initial)) {
      arr[parseInt(idx, 10)] = val as number;
    }
  }
  return arr;
}

// ---------------------------------------------------------------------------
// D Flip-Flop two-phase tests
// ---------------------------------------------------------------------------

describe("DFlipFlop", () => {
  // Layout: [D=0, C=1, Q=2, ~Q=3, storedQ=4, prevClock=5]
  const layout = makeLayout(2, 2, 2);

  it("sampleD_latches_on_rising_edge", () => {
    const state = makeState(6, { 0: 1, 1: 0, 4: 0, 5: 0 });
    const highZs = new Uint32Array(6);
    state[1] = 1;
    sampleD(0, state, highZs, layout);
    expect(state[4]).toBe(1);
    executeD(0, state, highZs, layout);
    expect(state[2]).toBe(1);
    expect(state[3]).toBe(0);
  });

  it("sampleD_ignores_falling_edge", () => {
    const state = makeState(6, { 0: 1, 1: 0, 4: 0, 5: 1 });
    const highZs = new Uint32Array(6);
    sampleD(0, state, highZs, layout);
    expect(state[4]).toBe(0);
  });

  it("executeD_outputs_from_state_not_inputs", () => {
    const state = makeState(6, { 0: 1, 1: 1, 4: 0, 5: 1 });
    const highZs = new Uint32Array(6);
    executeD(0, state, highZs, layout);
    expect(state[2]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Async D Flip-Flop — no sampleFn
// ---------------------------------------------------------------------------

describe("AsyncDFlipFlop", () => {
  it("has_no_sampleFn", () => {
    expect(DAsyncDefinition.sampleFn).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// JK Flip-Flop two-phase tests
// ---------------------------------------------------------------------------

describe("JKFlipFlop", () => {
  // Layout: [J=0, C=1, K=2, Q=3, ~Q=4, storedQ=5, prevClock=6]
  const layout = makeLayout(3, 2, 2);

  it("sampleJK_computes_next_state", () => {
    const state = makeState(7, { 0: 1, 1: 0, 2: 0, 5: 0, 6: 0 });
    const highZs = new Uint32Array(7);
    state[1] = 1;
    sampleJK(0, state, highZs, layout);
    expect(state[5]).toBe(1);

    state[0] = 1;
    state[2] = 1;
    state[6] = 0;
    state[1] = 1;
    sampleJK(0, state, highZs, layout);
    expect(state[5]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T Flip-Flop two-phase tests
// ---------------------------------------------------------------------------

describe("TFlipFlop", () => {
  // withEnable=true: [T=0, C=1, Q=2, ~Q=3, storedQ=4, prevClock=5]
  const layout = makeLayout(2, 2, 2);

  it("sampleT_toggles_on_edge_when_T_high", () => {
    const state = makeState(6, { 0: 1, 1: 0, 4: 0, 5: 0 });
    const highZs = new Uint32Array(6);
    state[1] = 1;
    sampleT(0, state, highZs, layout);
    expect(state[4]).toBe(1);

    state[5] = 0;
    state[1] = 1;
    sampleT(0, state, highZs, layout);
    expect(state[4]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// RS Flip-Flop two-phase tests
// ---------------------------------------------------------------------------

describe("RSFlipFlop", () => {
  // Layout: [S=0, C=1, R=2, Q=3, ~Q=4, storedQ=5, prevClock=6]
  const layout = makeLayout(3, 2, 2);

  it("sampleRS_sets_on_rising_edge", () => {
    const state = makeState(7, { 0: 1, 1: 0, 2: 0, 5: 0, 6: 0 });
    const highZs = new Uint32Array(7);
    state[1] = 1;
    sampleRS(0, state, highZs, layout);
    expect(state[5]).toBe(1);
  });

  it("sampleRS_resets_on_rising_edge", () => {
    const state = makeState(7, { 0: 0, 1: 0, 2: 1, 5: 1, 6: 0 });
    const highZs = new Uint32Array(7);
    state[1] = 1;
    sampleRS(0, state, highZs, layout);
    expect(state[5]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Async flip-flops — no sampleFn
// ---------------------------------------------------------------------------

describe("AsyncFlipFlops", () => {
  it("JKAsyncDefinition has no sampleFn", () => {
    expect(JKAsyncDefinition.sampleFn).toBeUndefined();
  });

  it("RSAsyncDefinition has no sampleFn", () => {
    expect(RSAsyncDefinition.sampleFn).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Monoflop two-phase tests
// ---------------------------------------------------------------------------

describe("Monoflop", () => {
  // Layout: [C=0, R=1, Q=2, ~Q=3, storedQ=4, prevClock=5, counter=6]
  const layout = makeLayout(2, 2, 3, 5);

  it("sampleMonoflop_starts_timing_on_trigger_edge", () => {
    const state = makeState(7, { 0: 0, 1: 0, 4: 0, 5: 0, 6: 0 });
    const highZs = new Uint32Array(7);
    state[0] = 1;
    sampleMonoflop(0, state, highZs, layout);
    expect(state[4]).toBe(1);
    expect(state[6]).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Definitions have sampleFn set
// ---------------------------------------------------------------------------

describe("Definitions", () => {
  it("DDefinition has sampleFn", () => {
    expect(DDefinition.sampleFn).toBe(sampleD);
  });

  it("JKDefinition has sampleFn", () => {
    expect(JKDefinition.sampleFn).toBe(sampleJK);
  });

  it("TDefinition has sampleFn", () => {
    expect(TDefinition.sampleFn).toBe(sampleT);
  });

  it("RSDefinition has sampleFn", () => {
    expect(RSDefinition.sampleFn).toBe(sampleRS);
  });

  it("MonoflopDefinition has sampleFn", () => {
    expect(MonoflopDefinition.sampleFn).toBe(sampleMonoflop);
  });
});
