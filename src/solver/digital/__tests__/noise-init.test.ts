/**
 * Tests for noise-mode evaluation and circuit initialization.
 *
 * Ported from the deleted noise-mode.test.ts (Wave 3 cleanup).
 * Tests evaluateSynchronized and initializeCircuit with low-level
 * InitializableEngine setups.
 *
 * Note: shuffleArray is not exported from noise-mode.ts so the
 * shuffleProducesPermutation test is not included here.
 */

import { describe, it, expect } from "vitest";
import { evaluateSynchronized } from "../noise-mode.js";
import { initializeCircuit } from "../init-sequence.js";
import type { EvaluationGroup, InitializableEngine } from "../init-sequence.js";
import type { ExecuteFunction, ComponentLayout } from "../../../core/registry.js";

// ---------------------------------------------------------------------------
// Helper -- minimal ComponentLayout for tests
// ---------------------------------------------------------------------------

function makeLayout(
  inputOffsets: number[],
  inputCounts: number[],
  outputOffsets: number[],
  outputCounts: number[],
): ComponentLayout {
  let maxSlot = 0;
  for (let i = 0; i < inputOffsets.length; i++) {
    maxSlot = Math.max(maxSlot, inputOffsets[i]! + inputCounts[i]!);
  }
  for (let i = 0; i < outputOffsets.length; i++) {
    maxSlot = Math.max(maxSlot, outputOffsets[i]! + outputCounts[i]!);
  }
  const wiringTable = new Int32Array(maxSlot);
  for (let i = 0; i < maxSlot; i++) wiringTable[i] = i;

  return {
    wiringTable,
    inputCount: (i: number) => inputCounts[i],
    inputOffset: (i: number) => inputOffsets[i],
    outputCount: (i: number) => outputCounts[i],
    outputOffset: (i: number) => outputOffsets[i],
    stateOffset: (_i: number) => 0,
    getProperty: () => undefined,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NoiseInit", () => {

  // C10: initializeCircuit -- SR latch settles to valid complementary state
  it("initializeCircuit -- SR latch settles to a valid complementary state", () => {
    // SR latch from 2 NOR gates: Q = NOR(R, QB), QB = NOR(S, Q)
    // State layout:
    //   Slots 0,1 = comp0 inputs (R=slot0, Qbar=slot1)   inputOffset(0)=0
    //   Slot  2   = comp0 output (Q)                      outputOffset(0)=2
    //   Slots 3,4 = comp1 inputs (S=slot3, Q=slot4)      inputOffset(1)=3
    //   Slot  5   = comp1 output (Qbar)                   outputOffset(1)=5

    const STATE_SIZE = 6;
    const state = new Uint32Array(STATE_SIZE);
    const snapshotBuffer = new Uint32Array(STATE_SIZE);
    const typeIds = new Uint16Array([0, 1]);

    const executeFns: ExecuteFunction[] = [
      // comp0: NOR_Q -- Q = NOR(R, Qbar)
      (index, st, _hz, layout) => {
        const inOff = layout.inputOffset(index);
        const outOff = layout.outputOffset(index);
        const q = ((st[inOff] | st[inOff + 1]) === 0) ? 1 : 0;
        st[outOff] = q;
        st[4] = q; // propagate Q to comp1 input slot
      },
      // comp1: NOR_Qbar -- Qbar = NOR(S, Q)
      (index, st, _hz, layout) => {
        const inOff = layout.inputOffset(index);
        const outOff = layout.outputOffset(index);
        const qbar = ((st[inOff] | st[inOff + 1]) === 0) ? 1 : 0;
        st[outOff] = qbar;
        st[1] = qbar; // propagate Qbar to comp0 input slot
      },
    ];

    const layout = makeLayout([0, 3], [2, 2], [2, 5], [1, 1]);

    const engine: InitializableEngine = {
      state,
      highZs: new Uint32Array(STATE_SIZE),
      snapshotBuffer,
      typeIds,
      executeFns,
      layout,
      evaluationOrder: [{ componentIndices: new Uint32Array([0, 1]), isFeedback: true }],
      resetComponentIndices: new Uint32Array(0),
    };

    initializeCircuit(engine);

    const q = state[2];
    const qbar = state[5];
    // Q and QB must be complementary
    expect(q === 0 || q === 1).toBe(true);
    expect(qbar === 0 || qbar === 1).toBe(true);
    expect(q + qbar).toBe(1);
  });

  // C11: initializeCircuit -- Reset component forces deterministic Q=0 QB=1
  it("initializeCircuit -- Reset component drives Q=0 QB=1 after release", () => {
    const STATE_SIZE = 6;
    const state = new Uint32Array(STATE_SIZE);
    const snapshotBuffer = new Uint32Array(STATE_SIZE);
    const typeIds = new Uint16Array([0, 1, 2]);

    const executeFns: ExecuteFunction[] = [
      // comp0: NOR_Q -- Q = NOR(R, Qbar); inputOffset(0)=0, outputOffset(0)=2
      (index, st, _hz, layout) => {
        const inOff = layout.inputOffset(index);
        const outOff = layout.outputOffset(index);
        const q = ((st[inOff] | st[inOff + 1]) === 0) ? 1 : 0;
        st[outOff] = q;
        st[4] = q;
      },
      // comp1: NOR_Qbar -- Qbar = NOR(S, Q); inputOffset(1)=3, outputOffset(1)=5
      (index, st, _hz, layout) => {
        const inOff = layout.inputOffset(index);
        const outOff = layout.outputOffset(index);
        const qbar = ((st[inOff] | st[inOff + 1]) === 0) ? 1 : 0;
        st[outOff] = qbar;
        st[1] = qbar;
      },
      // comp2: Reset -- drives R (slot 0) to 1; outputOffset(2)=0
      (index, st, _hz, layout) => {
        st[layout.outputOffset(index)] = 1;
      },
    ];

    const layout = makeLayout([0, 3, 0], [2, 2, 0], [2, 5, 0], [1, 1, 1]);

    const engine: InitializableEngine = {
      state,
      highZs: new Uint32Array(STATE_SIZE),
      snapshotBuffer,
      typeIds,
      executeFns,
      layout,
      evaluationOrder: [
        { componentIndices: new Uint32Array([2]), isFeedback: false },
        { componentIndices: new Uint32Array([0, 1]), isFeedback: true },
      ],
      resetComponentIndices: new Uint32Array([2]),
    };

    initializeCircuit(engine);

    // After Reset releases (R=1): Q must = 0, QB must = 1
    expect(state[2]).toBe(0);
    expect(state[5]).toBe(1);
  });

  // C12: evaluateSynchronized -- order-independent evaluation
  it("evaluateSynchronized produces identical results regardless of component order", () => {
    // comp0: reads slot 0, writes slot 1
    // comp1: reads slot 1, writes slot 3
    // In synchronized mode both read from a snapshot so order does not matter.

    const STATE_SIZE = 4;
    const typeIds = new Uint16Array([0, 1]);

    const executeFns: ExecuteFunction[] = [
      (index, st, _hz, layout) => {
        st[layout.outputOffset(index)] = st[layout.inputOffset(index)];
      },
      (index, st, _hz, layout) => {
        st[layout.outputOffset(index)] = st[layout.inputOffset(index)];
      },
    ];

    const layout = makeLayout([0, 1], [1, 1], [1, 3], [1, 1]);

    function makeState(): Uint32Array {
      const st = new Uint32Array(STATE_SIZE);
      st[0] = 42;
      st[1] = 99;
      return st;
    }

    // Run with order [comp0, comp1]
    const state1 = makeState();
    evaluateSynchronized(
      new Uint32Array([0, 1]), 0, 2,
      state1, new Uint32Array(STATE_SIZE), new Uint32Array(STATE_SIZE),
      executeFns, typeIds, layout,
    );

    // Run with order [comp1, comp0]
    const state2 = makeState();
    evaluateSynchronized(
      new Uint32Array([1, 0]), 0, 2,
      state2, new Uint32Array(STATE_SIZE), new Uint32Array(STATE_SIZE),
      executeFns, typeIds, layout,
    );

    // Both orderings must produce identical state
    expect(state1[1]).toBe(state2[1]);
    expect(state1[3]).toBe(state2[3]);

    // comp0 reads slot0 snapshot (42) -> slot1=42
    // comp1 reads slot1 snapshot (99) -> slot3=99
    expect(state1[1]).toBe(42);
    expect(state1[3]).toBe(99);
    expect(state2[1]).toBe(42);
    expect(state2[3]).toBe(99);
  });
});
