/**
 * Tests for noise-mode evaluation and circuit initialization.
 *
 * Task 3.1.3 — Noise Mode and Initialization
 */

import { describe, it, expect } from "vitest";
import { shuffleArray, evaluateSynchronized } from "../noise-mode.js";
import { initializeCircuit } from "../init-sequence.js";
import type { EvaluationGroup, InitializableEngine } from "../init-sequence.js";
import type { ExecuteFunction, ComponentLayout } from "../../core/registry.js";

// ---------------------------------------------------------------------------
// Helpers — minimal ComponentLayout for tests
// ---------------------------------------------------------------------------

/**
 * Build a simple flat ComponentLayout given parallel arrays of input/output
 * net offsets and counts per component.
 *
 * The wiringTable is an identity map (wt[i] = i) since the test executeFns
 * access state slots directly. The engine's captureOutputs/outputsChanged
 * read through wiringTable, so wt[outputOffset + k] must equal the actual
 * net slot — which it does when wiringTable is identity.
 */
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
  };
}

// ---------------------------------------------------------------------------
// NoiseMode::shuffleProducesPermutation
// ---------------------------------------------------------------------------

describe("NoiseMode", () => {
  it("shuffleProducesPermutation", () => {
    const original = new Uint32Array([0, 1, 2, 3, 4]);
    let atLeastOneDiffers = false;

    for (let trial = 0; trial < 10; trial++) {
      const arr = original.slice();
      shuffleArray(arr, 0, arr.length);

      // Verify it is still a permutation (same elements)
      const sorted = arr.slice().sort();
      for (let i = 0; i < sorted.length; i++) {
        expect(sorted[i]).toBe(i);
      }

      // Check whether order differs from original
      let differs = false;
      for (let i = 0; i < arr.length; i++) {
        if (arr[i] !== original[i]) {
          differs = true;
          break;
        }
      }
      if (differs) atLeastOneDiffers = true;
    }

    // Over 10 trials with 5 elements, the probability that all trials produce
    // the identity permutation is (1/120)^10 ≈ 10^-22. Statistically certain.
    expect(atLeastOneDiffers).toBe(true);
  });

  // -------------------------------------------------------------------------
  // NoiseMode::srLatchSettlesToValidState
  // -------------------------------------------------------------------------

  it("srLatchSettlesToValidState", () => {
    // SR latch from 2 NOR gates: Q = NOR(R, Q̄), Q̄ = NOR(S, Q)
    // Net layout:
    //   net 0: S input  (driven externally, held at 0)
    //   net 1: R input  (driven externally, held at 0)
    //   net 2: Q  (output of NOR gate 0, input to NOR gate 1)
    //   net 3: Q̄ (output of NOR gate 1, input to NOR gate 0)
    //
    // Component 0 (NOR_Q):  inputs = [net 1 (R), net 3 (Q̄)], output = [net 2 (Q)]
    // Component 1 (NOR_Qbar): inputs = [net 0 (S), net 2 (Q)], output = [net 3 (Q̄)]

    // Layout: [comp0: inputs@[R,Qbar]=nets[1,3], output@[Q]=net[2]]
    //         [comp1: inputs@[S,Q]=nets[0,2], output@[Qbar]=net[3]]
    //
    // We use a flat net-index approach: inputOffset(i) returns the net index
    // of the first input. Since executeFn reads state[inputOffset + j], we
    // need the layout to give actual net IDs (not offsets into a packed array).
    // BUT: the ComponentLayout interface defines inputOffset as "starting index
    // in the signal array", meaning state[inputOffset(i) + j] is input j of
    // component i. This requires inputs to be at contiguous slots.
    //
    // To keep the test clean, we use a signal array where each net has its own
    // slot indexed by net ID. The execute functions use the layout to find input
    // net IDs.
    //
    // Since the spec's ComponentLayout only provides inputOffset (not individual
    // net IDs), and executeFns are expected to do state[inputOffset+0],
    // state[inputOffset+1], etc., we structure the state so that each component's
    // inputs are at contiguous positions.
    //
    // For this test we lay out state as:
    //   Slots 0,1 = component 0's input nets (R=slot0, Qbar=slot1)  → inputOffset(0)=0
    //   Slot  2   = component 0's output net (Q)                     → outputOffset(0)=2
    //   Slots 3,4 = component 1's input nets (S=slot3, Q=slot4)     → inputOffset(1)=3
    //   Slot  5   = component 1's output net (Qbar)                  → outputOffset(1)=5
    //
    // Q=slot2 must equal slot4 (component 1's second input).
    // Qbar=slot5 must equal slot1 (component 0's second input).
    // S=slot3 = 0 (held low), R=slot0 = 0 (held low).
    //
    // We manually propagate the cross-connections in the execute functions.

    const STATE_SIZE = 6;
    const state = new Uint32Array(STATE_SIZE);
    const snapshotBuffer = new Uint32Array(STATE_SIZE);
    const typeIds = new Uint16Array([0, 1]); // comp0=type0, comp1=type1

    // NOR gate execute: output = NOR(input0, input1) = ~(input0 | input1) & 1
    // Also propagates cross-connections: Q->slot4, Qbar->slot1
    const executeFns: ExecuteFunction[] = [
      // Component 0: NOR_Q — Q = NOR(R, Qbar)
      // inputOffset(0)=0 → state[0]=R, state[1]=Qbar
      // outputOffset(0)=2 → state[2]=Q
      (index, st, _hz, layout) => {
        const inOff = layout.inputOffset(index);
        const outOff = layout.outputOffset(index);
        const r = st[inOff];       // R input
        const qbar = st[inOff + 1]; // Qbar input
        const q = ((r | qbar) === 0) ? 1 : 0;
        st[outOff] = q;
        // Propagate Q to component 1's input slot
        st[4] = q;
      },
      // Component 1: NOR_Qbar — Qbar = NOR(S, Q)
      // inputOffset(1)=3 → state[3]=S, state[4]=Q
      // outputOffset(1)=5 → state[5]=Qbar
      (index, st, _hz, layout) => {
        const inOff = layout.inputOffset(index);
        const outOff = layout.outputOffset(index);
        const s = st[inOff];    // S input
        const q = st[inOff + 1]; // Q input
        const qbar = ((s | q) === 0) ? 1 : 0;
        st[outOff] = qbar;
        // Propagate Qbar to component 0's input slot
        st[1] = qbar;
      },
    ];

    const layout = makeLayout(
      [0, 3],   // inputOffsets: comp0 inputs start at slot 0, comp1 at slot 3
      [2, 2],   // inputCounts
      [2, 5],   // outputOffsets: comp0 output at slot 2, comp1 at slot 5
      [1, 1],   // outputCounts
    );

    // S and R held at 0 (S=slot3=0, R=slot0=0 — initial fill is 0 so this is already set)

    const componentIndices = new Uint32Array([0, 1]);
    const sccGroup: EvaluationGroup = { componentIndices, isFeedback: true };

    const engine: InitializableEngine = {
      state,
      highZs: new Uint32Array(STATE_SIZE),
      snapshotBuffer,
      typeIds,
      executeFns,
      layout,
      evaluationOrder: [sccGroup],
      resetComponentIndices: new Uint32Array(0),
    };

    initializeCircuit(engine);

    // After initialization: Q (slot 2) and Qbar (slot 5) must be complementary
    // (one is 0 and the other is 1 — not both 0 or both 1)
    const q = state[2];
    const qbar = state[5];

    expect(q === 0 || q === 1).toBe(true);
    expect(qbar === 0 || qbar === 1).toBe(true);
    expect(q + qbar).toBe(1); // exactly one is 1, the other is 0
  });

  // -------------------------------------------------------------------------
  // NoiseMode::srLatchWithResetDeterministic
  // -------------------------------------------------------------------------

  it("srLatchWithResetDeterministic", () => {
    // SR latch + Reset component.
    // Reset component drives R high (1) after noise init, forcing Q=0, Qbar=1.
    //
    // State layout (same as above but R is driven by Reset component):
    //   slot 0: R (output of Reset component, comp2)
    //   slot 1: Qbar (output of comp1, also input to comp0 slot 1)
    //   slot 2: Q  (output of comp0)
    //   slot 3: S  (held at 0)
    //   slot 4: Q  (copy of slot 2 for comp1 input)
    //   slot 5: Qbar copy (for comp0 input — same as slot 1)
    //   slot 6: Reset output = slot 0
    //
    // Simpler: Reset component (comp2) has output at slot 0 (R line).
    // During noise init, Reset output = 0 (held low — init sets all to 0).
    // After releaseResetComponents, Reset's executeFn is called, writing 1 to slot 0.
    // After deterministic settle, Q must = 0, Qbar must = 1.

    const STATE_SIZE = 6;
    const state = new Uint32Array(STATE_SIZE);
    const snapshotBuffer = new Uint32Array(STATE_SIZE);

    // 3 components: comp0=NOR_Q, comp1=NOR_Qbar, comp2=Reset
    const typeIds = new Uint16Array([0, 1, 2]);

    const executeFns: ExecuteFunction[] = [
      // comp0: NOR_Q — Q = NOR(R, Qbar)
      // inputOffset(0)=0 → state[0]=R, state[1]=Qbar
      // outputOffset(0)=2 → state[2]=Q
      (index, st, _hz, layout) => {
        const inOff = layout.inputOffset(index);
        const outOff = layout.outputOffset(index);
        const r = st[inOff];
        const qbar = st[inOff + 1];
        const q = ((r | qbar) === 0) ? 1 : 0;
        st[outOff] = q;
        st[4] = q; // propagate Q to comp1 input slot
      },
      // comp1: NOR_Qbar — Qbar = NOR(S, Q)
      // inputOffset(1)=3 → state[3]=S, state[4]=Q
      // outputOffset(1)=5 → state[5]=Qbar
      (index, st, _hz, layout) => {
        const inOff = layout.inputOffset(index);
        const outOff = layout.outputOffset(index);
        const s = st[inOff];
        const q = st[inOff + 1];
        const qbar = ((s | q) === 0) ? 1 : 0;
        st[outOff] = qbar;
        st[1] = qbar; // propagate Qbar to comp0 input slot
      },
      // comp2: Reset — drives R (slot 0) to 1
      // outputOffset(2)=0 → state[0]=R
      (index, st, _hz, layout) => {
        const outOff = layout.outputOffset(index);
        st[outOff] = 1; // Reset released: drive R high
      },
    ];

    const layout = makeLayout(
      [0, 3, 0],   // inputOffsets (Reset comp2 has no real inputs; slot 0 unused)
      [2, 2, 0],   // inputCounts  (comp2 has 0 inputs)
      [2, 5, 0],   // outputOffsets: comp0→slot2, comp1→slot5, comp2→slot0(R)
      [1, 1, 1],   // outputCounts
    );

    const sccGroup: EvaluationGroup = {
      componentIndices: new Uint32Array([0, 1]),
      isFeedback: true,
    };
    // Reset component is not in the SCC — evaluated separately in deterministic pass
    const resetGroup: EvaluationGroup = {
      componentIndices: new Uint32Array([2]),
      isFeedback: false,
    };

    const engine: InitializableEngine = {
      state,
      highZs: new Uint32Array(STATE_SIZE),
      snapshotBuffer,
      typeIds,
      executeFns,
      layout,
      evaluationOrder: [resetGroup, sccGroup],
      resetComponentIndices: new Uint32Array([2]),
    };

    initializeCircuit(engine);

    // After Reset releases (R=1): Q must = 0, Qbar must = 1
    // (NOR(1, Qbar) = 0 regardless of Qbar; then NOR(0, 0) = 1 for Qbar)
    const q = state[2];
    const qbar = state[5];

    expect(q).toBe(0);
    expect(qbar).toBe(1);
  });

  // -------------------------------------------------------------------------
  // NoiseMode::synchronizedModeSnapshotsInputs
  // -------------------------------------------------------------------------

  it("synchronizedModeSnapshotsInputs", () => {
    // 2 components in an SCC where evaluation order matters in interleaved mode.
    //
    // Setup: two "pass-through" components that swap values.
    //   comp0: reads slot 0, writes slot 2
    //   comp1: reads slot 2, writes slot 4
    //
    // But in an SCC they cross-reference each other. Let's use a counter-style
    // setup where:
    //   comp0 writes to slot 1 = value from slot 0
    //   comp1 writes to slot 3 = value from slot 1
    //
    // In noise/interleaved mode, if comp0 runs first:
    //   slot 1 = slot 0 (initial value A)
    //   slot 3 = slot 1 = A   (comp1 sees updated slot 1)
    // If comp1 runs first:
    //   slot 3 = slot 1 (initial value B)
    //   slot 1 = slot 0 = A   (comp0 runs after)
    //   → slot 3 = B (old value)
    //
    // In synchronized mode, both components read from snapshot:
    //   snapshot: slot 0=A, slot 1=B
    //   comp0 reads slot 0 → writes slot 1 = A
    //   comp1 reads slot 1 (from snapshot=B) → writes slot 3 = B
    // Result: slot 1=A, slot 3=B — regardless of evaluation order.
    //
    // Test: run evaluateSynchronized twice with reversed component order.
    // Both must produce identical output.

    const STATE_SIZE = 4;
    const typeIds = new Uint16Array([0, 1]);

    const executeFns: ExecuteFunction[] = [
      // comp0: reads inputOffset(0)=0 → slot 0; writes outputOffset(0)=1 → slot 1
      (index, st, _hz, layout) => {
        st[layout.outputOffset(index)] = st[layout.inputOffset(index)];
      },
      // comp1: reads inputOffset(1)=1 → slot 1; writes outputOffset(1)=3 → slot 3
      (index, st, _hz, layout) => {
        st[layout.outputOffset(index)] = st[layout.inputOffset(index)];
      },
    ];

    const layout = makeLayout(
      [0, 1],   // inputOffsets
      [1, 1],   // inputCounts
      [1, 3],   // outputOffsets
      [1, 1],   // outputCounts
    );

    // Initial state: slot 0 = 42, slot 1 = 99
    function makeState(): Uint32Array {
      const st = new Uint32Array(STATE_SIZE);
      st[0] = 42;
      st[1] = 99;
      return st;
    }

    // Run with order [comp0, comp1]
    const state1 = makeState();
    const snap1 = new Uint32Array(STATE_SIZE);
    const indices01 = new Uint32Array([0, 1]);
    const highZs1 = new Uint32Array(STATE_SIZE);
    evaluateSynchronized(indices01, 0, 2, state1, highZs1, snap1, executeFns, typeIds, layout);

    // Run with order [comp1, comp0]
    const state2 = makeState();
    const snap2 = new Uint32Array(STATE_SIZE);
    const indices10 = new Uint32Array([1, 0]);
    const highZs2 = new Uint32Array(STATE_SIZE);
    evaluateSynchronized(indices10, 0, 2, state2, highZs2, snap2, executeFns, typeIds, layout);

    // Both orderings must produce identical state
    expect(state1[1]).toBe(state2[1]); // comp0's output
    expect(state1[3]).toBe(state2[3]); // comp1's output

    // Specifically: comp0 reads slot 0 (=42 in snapshot), writes slot 1 = 42
    // comp1 reads slot 1 snapshot (=99), writes slot 3 = 99
    expect(state1[1]).toBe(42);
    expect(state1[3]).toBe(99);
    expect(state2[1]).toBe(42);
    expect(state2[3]).toBe(99);
  });
});
