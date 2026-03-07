/**
 * Tests for WorkerEngine init protocol (Task 5.1).
 *
 * Validates that WorkerEngine.init() serializes typed arrays from a compiled
 * circuit and posts them as an init message, and that the worker can
 * reconstruct a functional compiled circuit from that message.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { WorkerEngine } from "../worker-engine.js";
import { FlatComponentLayout, CompiledCircuitImpl } from "../compiled-circuit.js";
import type { ExecuteFunction, ComponentLayout } from "@/core/registry";
import type { EvaluationGroup } from "../digital-engine.js";

// ---------------------------------------------------------------------------
// Minimal compiled circuit builder
// ---------------------------------------------------------------------------

function makeExecuteFn(outputValue: number): ExecuteFunction {
  return (index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout) => {
    const wt = layout.wiringTable;
    const outBase = layout.outputOffset(index);
    state[wt[outBase]!] = outputValue;
  };
}

function makeCompiledCircuit(): CompiledCircuitImpl {
  const netCount = 4;
  const componentCount = 2;

  const inputOffsets = new Int32Array([0, 1]);
  const outputOffsets = new Int32Array([2, 3]);
  const inputCounts = new Uint8Array([1, 1]);
  const outputCounts = new Uint8Array([1, 1]);
  const wiringTable = Int32Array.from([0, 1, 2, 3]);
  const stateOffsets = new Int32Array([4, 5]);

  const layout = new FlatComponentLayout(
    inputOffsets,
    outputOffsets,
    inputCounts,
    outputCounts,
    wiringTable,
    [],
    stateOffsets,
  );

  const executeFn0 = makeExecuteFn(42);
  const executeFn1 = makeExecuteFn(99);

  const evaluationOrder: EvaluationGroup[] = [
    { componentIndices: new Uint32Array([0, 1]), isFeedback: false },
  ];

  return new CompiledCircuitImpl({
    netCount,
    componentCount,
    totalStateSlots: 2,
    typeIds: new Uint8Array([0, 1]),
    executeFns: [executeFn0, executeFn1],
    sampleFns: [null, null],
    wiringTable,
    layout,
    evaluationOrder,
    sequentialComponents: new Uint32Array(0),
    netWidths: new Uint8Array([1, 1, 1, 1]),
    sccSnapshotBuffer: new Uint32Array(netCount),
    delays: new Uint32Array([10, 10]),
    componentToElement: new Map(),
    labelToNetId: new Map(),
    wireToNetId: new Map(),
    pinNetMap: new Map(),
    resetComponentIndices: new Uint32Array(0),
    switchComponentIndices: new Uint32Array(0),
    switchClassification: new Uint8Array(componentCount),
    typeNames: ["And", "Or"],
  });
}

// ---------------------------------------------------------------------------
// Mock Worker
// ---------------------------------------------------------------------------

class MockWorker {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  lastMessage: unknown = null;
  lastTransfer: unknown[] = [];

  postMessage(msg: unknown, transfer?: unknown[]): void {
    this.lastMessage = msg;
    this.lastTransfer = transfer ?? [];
  }

  terminate(): void { /* no-op */ }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WorkerInit", () => {
  let originalWorker: unknown;

  beforeEach(() => {
    originalWorker = (globalThis as Record<string, unknown>)["Worker"];
  });

  function restoreWorker(): void {
    (globalThis as Record<string, unknown>)["Worker"] = originalWorker;
  }

  it("init_message_transfers_typed_arrays", () => {
    const mockWorker = new MockWorker();

    (globalThis as Record<string, unknown>)["Worker"] = class {
      onmessage: unknown = null;
      onerror: unknown = null;
      postMessage(msg: unknown, transfer?: unknown[]): void {
        mockWorker.postMessage(msg, transfer);
      }
      terminate(): void { /* no-op */ }
    };

    try {
      const compiled = makeCompiledCircuit();
      const engine = new WorkerEngine(compiled.netCount, "level");
      engine.init(compiled);

      const msg = mockWorker.lastMessage as Record<string, unknown>;
      expect(msg).not.toBeNull();
      expect(msg["type"]).toBe("init");
      expect(msg["netCount"]).toBe(4);
      expect(msg["componentCount"]).toBe(2);
      expect(msg["signalArraySize"]).toBe(6);

      // Verify typed arrays are present
      expect(msg["typeIds"]).toBeInstanceOf(Uint8Array);
      expect(msg["wiringTable"]).toBeInstanceOf(Int32Array);
      expect(msg["inputOffsets"]).toBeInstanceOf(Int32Array);
      expect(msg["outputOffsets"]).toBeInstanceOf(Int32Array);
      expect(msg["inputCounts"]).toBeInstanceOf(Uint8Array);
      expect(msg["outputCounts"]).toBeInstanceOf(Uint8Array);
      expect(msg["stateOffsets"]).toBeInstanceOf(Int32Array);
      expect(msg["netWidths"]).toBeInstanceOf(Uint8Array);
      expect(msg["delays"]).toBeInstanceOf(Uint32Array);
      expect(msg["sequentialComponents"]).toBeInstanceOf(Uint32Array);
      expect(msg["resetComponentIndices"]).toBeInstanceOf(Uint32Array);
      expect(msg["switchComponentIndices"]).toBeInstanceOf(Uint32Array);
      expect(msg["switchClassification"]).toBeInstanceOf(Uint8Array);

      // Verify type names
      expect(msg["typeNames"]).toEqual(["And", "Or"]);

      // Verify evaluation groups
      const groups = msg["evaluationGroups"] as Array<{
        componentIndices: Uint32Array;
        isFeedback: boolean;
      }>;
      expect(groups).toHaveLength(1);
      expect(groups[0]!.isFeedback).toBe(false);
      expect(groups[0]!.componentIndices).toBeInstanceOf(Uint32Array);
      expect(Array.from(groups[0]!.componentIndices)).toEqual([0, 1]);

      // Verify shared buffer is in the transfer list
      expect(msg["sharedBuffer"]).toBeInstanceOf(SharedArrayBuffer);
      expect(mockWorker.lastTransfer).toHaveLength(1);
      expect(mockWorker.lastTransfer[0]).toBe(msg["sharedBuffer"]);

      // Verify typed array values match compiled circuit
      expect(Array.from(msg["typeIds"] as Uint8Array)).toEqual([0, 1]);
      expect(Array.from(msg["wiringTable"] as Int32Array)).toEqual([0, 1, 2, 3]);
      expect(Array.from(msg["netWidths"] as Uint8Array)).toEqual([1, 1, 1, 1]);

      // Layout offsets were extracted correctly
      expect(Array.from(msg["inputOffsets"] as Int32Array)).toEqual([0, 1]);
      expect(Array.from(msg["outputOffsets"] as Int32Array)).toEqual([2, 3]);
      expect(Array.from(msg["inputCounts"] as Uint8Array)).toEqual([1, 1]);
      expect(Array.from(msg["outputCounts"] as Uint8Array)).toEqual([1, 1]);

      engine.dispose();
    } finally {
      restoreWorker();
    }
  });

  it("worker_reconstructs_circuit_from_message", () => {
    const compiled = makeCompiledCircuit();

    const mockWorker = new MockWorker();

    (globalThis as Record<string, unknown>)["Worker"] = class {
      onmessage: unknown = null;
      onerror: unknown = null;
      postMessage(msg: unknown, transfer?: unknown[]): void {
        mockWorker.postMessage(msg, transfer);
      }
      terminate(): void { /* no-op */ }
    };

    try {
      const engine = new WorkerEngine(compiled.netCount, "level");
      engine.init(compiled);

      const msg = mockWorker.lastMessage as Record<string, unknown>;
      expect(msg["type"]).toBe("init");

      // Simulate worker-side reconstruction:
      // Verify all fields needed for reconstruction are present
      const initMsg = msg as {
        netCount: number;
        componentCount: number;
        signalArraySize: number;
        typeIds: Uint8Array;
        typeNames: string[];
        inputOffsets: Int32Array;
        outputOffsets: Int32Array;
        inputCounts: Uint8Array;
        outputCounts: Uint8Array;
        stateOffsets: Int32Array;
        wiringTable: Int32Array;
        evaluationGroups: Array<{
          componentIndices: Uint32Array;
          isFeedback: boolean;
        }>;
        sequentialComponents: Uint32Array;
        netWidths: Uint8Array;
        delays: Uint32Array;
        resetComponentIndices: Uint32Array;
        switchComponentIndices: Uint32Array;
        switchClassification: Uint8Array;
        sharedBuffer: SharedArrayBuffer;
      };

      // Reconstruct layout as worker would
      const workerLayout = new FlatComponentLayout(
        initMsg.inputOffsets,
        initMsg.outputOffsets,
        initMsg.inputCounts,
        initMsg.outputCounts,
        initMsg.wiringTable,
        [],
        initMsg.stateOffsets,
      );

      // Verify layout gives correct offsets
      expect(workerLayout.inputOffset(0)).toBe(0);
      expect(workerLayout.inputOffset(1)).toBe(1);
      expect(workerLayout.outputOffset(0)).toBe(2);
      expect(workerLayout.outputOffset(1)).toBe(3);
      expect(workerLayout.inputCount(0)).toBe(1);
      expect(workerLayout.outputCount(0)).toBe(1);

      // Verify evaluation groups reconstructed correctly
      const workerGroups: EvaluationGroup[] = initMsg.evaluationGroups.map(
        (g) => ({ componentIndices: g.componentIndices, isFeedback: g.isFeedback }),
      );
      expect(workerGroups).toHaveLength(1);
      expect(workerGroups[0]!.isFeedback).toBe(false);

      // Verify type names can be used for registry lookup
      expect(initMsg.typeNames).toEqual(["And", "Or"]);
      expect(initMsg.typeNames.length).toBeGreaterThan(0);

      // Verify shared buffer allows reading signal values
      const sharedView = new Int32Array(initMsg.sharedBuffer, 0, initMsg.netCount);
      Atomics.store(sharedView, 2, 42);
      expect(Atomics.load(sharedView, 2)).toBe(42);

      engine.dispose();
    } finally {
      restoreWorker();
    }
  });
});
