/**
 * Tests for init-sequence integration with DigitalEngine.
 *
 * Task 3.2 — Noise Mode / Init Sequence Integration
 */

import { describe, it, expect, vi } from "vitest";
import { DigitalEngine, type ConcreteCompiledCircuit, type EvaluationGroup } from "../digital-engine.js";
import type { ExecuteFunction, ComponentLayout } from "@/core/registry";

// ---------------------------------------------------------------------------
// Helpers — build minimal ConcreteCompiledCircuit instances for tests
// ---------------------------------------------------------------------------

class StaticLayout implements ComponentLayout {
  readonly wiringTable: Int32Array;
  private readonly _inputOffsets: number[];
  private readonly _outputOffsets: number[];
  private readonly _inputCounts: number[];
  private readonly _outputCounts: number[];

  constructor(
    inputNets: number[][],
    outputNets: number[][],
  ) {
    const entries: number[] = [];
    this._inputOffsets = [];
    this._outputOffsets = [];
    this._inputCounts = inputNets.map(n => n.length);
    this._outputCounts = outputNets.map(n => n.length);

    for (const nets of inputNets) {
      this._inputOffsets.push(entries.length);
      for (const netId of nets) entries.push(netId);
    }
    for (const nets of outputNets) {
      this._outputOffsets.push(entries.length);
      for (const netId of nets) entries.push(netId);
    }
    this.wiringTable = Int32Array.from(entries);
  }

  inputCount(idx: number): number {
    return this._inputCounts[idx] ?? 0;
  }

  inputOffset(idx: number): number {
    return this._inputOffsets[idx] ?? 0;
  }

  outputCount(idx: number): number {
    return this._outputCounts[idx] ?? 0;
  }

  outputOffset(idx: number): number {
    return this._outputOffsets[idx] ?? 0;
  }

  stateOffset(_idx: number): number {
    return 0;
  }

  getProperty(): undefined {
    return undefined;
  }
}

function buildCircuit(
  netCount: number,
  inputNets: number[][],
  outputNets: number[][],
  executeFns: ExecuteFunction[],
  typeIds: Uint16Array,
  evaluationOrder: EvaluationGroup[],
  options?: {
    resetComponentIndices?: Uint32Array;
  },
): ConcreteCompiledCircuit {
  const layout = new StaticLayout(inputNets, outputNets);
  const componentCount = typeIds.length;
  const netWidths = new Uint8Array(netCount).fill(1);
  const sccSnapshotBuffer = new Uint32Array(netCount);

  return {
    netCount,
    componentCount,
    totalStateSlots: 0,
    signalArraySize: netCount,
    typeIds,
    executeFns,
    sampleFns: executeFns.map(() => null),
    wiringTable: layout.wiringTable,
    layout,
    evaluationOrder,
    sequentialComponents: new Uint32Array(0),
    netWidths,
    sccSnapshotBuffer,
    delays: new Uint32Array(componentCount).fill(10),
    componentToElement: new Map(),
    labelToNetId: new Map(),
    wireToNetId: new Map(),
    pinNetMap: new Map(),
    resetComponentIndices: options?.resetComponentIndices ?? new Uint32Array(0),
    busResolver: null,
    switchComponentIndices: new Uint32Array(0),
    switchClassification: new Uint8Array(0),
    shadowNetCount: 0,
  };
}

function feedbackGroup(indices: number[]): EvaluationGroup {
  return {
    componentIndices: new Uint32Array(indices),
    isFeedback: true,
  };
}

function singleGroup(indices: number[]): EvaluationGroup {
  return {
    componentIndices: new Uint32Array(indices),
    isFeedback: false,
  };
}

// ---------------------------------------------------------------------------
// InitSequence tests
// ---------------------------------------------------------------------------

describe("InitSequence", () => {
  // -------------------------------------------------------------------------
  // engine_init_runs_noise_propagation
  // -------------------------------------------------------------------------
  it("engine_init_runs_noise_propagation", () => {
    // SR latch from 2 NOR gates (combinational feedback).
    // NOR1 (component 0): NOR(S=net0, Q_bar=net3) -> Q=net2
    // NOR2 (component 1): NOR(R=net1, Q=net2)    -> Q_bar=net3
    const netCount = 4;

    const nor1Execute: ExecuteFunction = (idx, state, _hz, layout) => {
      const wt = layout.wiringTable;
      const inBase = layout.inputOffset(idx);
      const outBase = layout.outputOffset(idx);
      const s = state[wt[inBase]!]! & 1;
      const qBar = state[wt[inBase + 1]!]! & 1;
      state[wt[outBase]!] = (s | qBar) === 0 ? 1 : 0;
    };

    const nor2Execute: ExecuteFunction = (idx, state, _hz, layout) => {
      const wt = layout.wiringTable;
      const inBase = layout.inputOffset(idx);
      const outBase = layout.outputOffset(idx);
      const r = state[wt[inBase]!]! & 1;
      const q = state[wt[inBase + 1]!]! & 1;
      state[wt[outBase]!] = (r | q) === 0 ? 1 : 0;
    };

    const executeFns: ExecuteFunction[] = [nor1Execute, nor2Execute];
    const typeIds = new Uint16Array([0, 1]);
    const inputNets = [[0, 3], [1, 2]];
    const outputNets = [[2], [3]];
    const evaluationOrder: EvaluationGroup[] = [feedbackGroup([0, 1])];

    const circuit = buildCircuit(netCount, inputNets, outputNets, executeFns, typeIds, evaluationOrder);
    const engine = new DigitalEngine("level");
    engine.init(circuit);

    // After init, noise propagation should have broken symmetry.
    // Q and Q_bar must be complementary (one is 0, other is 1).
    const q = engine.getSignalRaw(2);
    const qBar = engine.getSignalRaw(3);

    expect(q === 0 || q === 1).toBe(true);
    expect(qBar === 0 || qBar === 1).toBe(true);
    expect((q === 0 && qBar === 1) || (q === 1 && qBar === 0)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // reset_components_released_after_noise
  // -------------------------------------------------------------------------
  it("reset_components_released_after_noise", () => {
    // Circuit: Reset component (comp 2) drives net 0.
    // NOR1 (comp 0): NOR(Reset=net0, Q_bar=net3) -> Q=net2
    // NOR2 (comp 1): NOR(R_ext=net1, Q=net2) -> Q_bar=net3
    // Reset drives net0 to 1 when released, forcing Q=0 (NOR(1, anything)=0).
    const netCount = 4;

    const nor1Execute: ExecuteFunction = (idx, state, _hz, layout) => {
      const wt = layout.wiringTable;
      const inBase = layout.inputOffset(idx);
      const outBase = layout.outputOffset(idx);
      const reset = state[wt[inBase]!]! & 1;
      const qBar = state[wt[inBase + 1]!]! & 1;
      state[wt[outBase]!] = (reset | qBar) === 0 ? 1 : 0;
    };

    const nor2Execute: ExecuteFunction = (idx, state, _hz, layout) => {
      const wt = layout.wiringTable;
      const inBase = layout.inputOffset(idx);
      const outBase = layout.outputOffset(idx);
      const r = state[wt[inBase]!]! & 1;
      const q = state[wt[inBase + 1]!]! & 1;
      state[wt[outBase]!] = (r | q) === 0 ? 1 : 0;
    };

    const resetExecute: ExecuteFunction = (idx, state, _hz, layout) => {
      const wt = layout.wiringTable;
      const outBase = layout.outputOffset(idx);
      state[wt[outBase]!] = 1;
    };

    const executeFns: ExecuteFunction[] = [nor1Execute, nor2Execute, resetExecute];
    const typeIds = new Uint16Array([0, 1, 2]);
    const inputNets = [[0, 3], [1, 2], []];
    const outputNets = [[2], [3], [0]];
    const evaluationOrder: EvaluationGroup[] = [
      singleGroup([2]),
      feedbackGroup([0, 1]),
    ];

    const circuit = buildCircuit(
      netCount, inputNets, outputNets, executeFns, typeIds, evaluationOrder,
      { resetComponentIndices: new Uint32Array([2]) },
    );

    const engine = new DigitalEngine("level");
    engine.init(circuit);

    // After init: Reset released (net0 = 1), so Q = NOR(1, anything) = 0
    expect(engine.getSignalRaw(0)).toBe(1); // Reset output released
    const q = engine.getSignalRaw(2);
    const qBar = engine.getSignalRaw(3);
    expect(q).toBe(0);
    expect(qBar).toBe(1);
  });

  // -------------------------------------------------------------------------
  // deterministic_settle_after_noise
  // -------------------------------------------------------------------------
  it("deterministic_settle_after_noise", () => {
    // 3-inverter ring (oscillating feedback). Should not crash.
    // Comp 0: NOT(net2) -> net0
    // Comp 1: NOT(net0) -> net1
    // Comp 2: NOT(net1) -> net2
    const netCount = 3;

    const makeNot = (): ExecuteFunction => (idx, state, _hz, layout) => {
      const wt = layout.wiringTable;
      const inBase = layout.inputOffset(idx);
      const outBase = layout.outputOffset(idx);
      state[wt[outBase]!] = state[wt[inBase]!]! === 0 ? 1 : 0;
    };

    const executeFns: ExecuteFunction[] = [makeNot(), makeNot(), makeNot()];
    const typeIds = new Uint16Array([0, 1, 2]);
    const inputNets = [[2], [0], [1]];
    const outputNets = [[0], [1], [2]];
    const evaluationOrder: EvaluationGroup[] = [feedbackGroup([0, 1, 2])];

    const circuit = buildCircuit(netCount, inputNets, outputNets, executeFns, typeIds, evaluationOrder);
    const engine = new DigitalEngine("level");

    // Should not throw - oscillation during init is handled gracefully
    expect(() => engine.init(circuit)).not.toThrow();

    // The state is left as-is (not a crash). Values exist.
    for (let i = 0; i < 3; i++) {
      const val = engine.getSignalRaw(i);
      expect(val === 0 || val === 1).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // feedback_group_uses_preallocated_snapshot
  // -------------------------------------------------------------------------
  it("feedback_group_uses_preallocated_snapshot", () => {
    // SR latch feedback circuit. After init, stepping should use
    // the pre-allocated sccSnapshotBuffer (no new Uint32Array allocations).
    const netCount = 4;

    const nor1Execute: ExecuteFunction = (idx, state, _hz, layout) => {
      const wt = layout.wiringTable;
      const inBase = layout.inputOffset(idx);
      const outBase = layout.outputOffset(idx);
      const s = state[wt[inBase]!]! & 1;
      const qBar = state[wt[inBase + 1]!]! & 1;
      state[wt[outBase]!] = (s | qBar) === 0 ? 1 : 0;
    };

    const nor2Execute: ExecuteFunction = (idx, state, _hz, layout) => {
      const wt = layout.wiringTable;
      const inBase = layout.inputOffset(idx);
      const outBase = layout.outputOffset(idx);
      const r = state[wt[inBase]!]! & 1;
      const q = state[wt[inBase + 1]!]! & 1;
      state[wt[outBase]!] = (r | q) === 0 ? 1 : 0;
    };

    const executeFns: ExecuteFunction[] = [nor1Execute, nor2Execute];
    const typeIds = new Uint16Array([0, 1]);
    const inputNets = [[0, 3], [1, 2]];
    const outputNets = [[2], [3]];
    const evaluationOrder: EvaluationGroup[] = [feedbackGroup([0, 1])];

    const circuit = buildCircuit(netCount, inputNets, outputNets, executeFns, typeIds, evaluationOrder);
    const engine = new DigitalEngine("level");
    engine.init(circuit);

    // Spy on Uint32Array constructor to detect allocations during stepping
    const OriginalUint32Array = globalThis.Uint32Array;
    let allocCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spy = vi.spyOn(globalThis as any, "Uint32Array").mockImplementation(
      function (this: unknown, ...args: unknown[]) {
        allocCount++;
        if (args.length === 0) return new OriginalUint32Array();
        return new OriginalUint32Array(...(args as [number]));
      } as unknown as () => Uint32Array,
    );

    try {
      allocCount = 0;
      for (let i = 0; i < 100; i++) {
        engine.step();
      }
      // The feedback group should use sccSnapshotBuffer.subarray() which
      // does NOT call the Uint32Array constructor — so allocCount should be 0.
      expect(allocCount).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});
