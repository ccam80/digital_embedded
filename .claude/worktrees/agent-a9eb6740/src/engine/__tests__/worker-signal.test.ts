/**
 * Tests for Worker Signal Synchronization (Task 5.2).
 *
 * Validates that WorkerEngine reads signal values from the SharedArrayBuffer
 * via Atomics.load(), and that setSignalValue() writes to both the shared
 * buffer and posts a message to the worker.
 *
 * These tests simulate the worker-side writes by directly writing to the
 * SharedArrayBuffer, since real Web Workers are not available in Node.js.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WorkerEngine } from "../worker-engine.js";
import { FlatComponentLayout, CompiledCircuitImpl } from "../compiled-circuit.js";
import { BitVector } from "@/core/signal";
import type { ExecuteFunction, ComponentLayout } from "@/core/registry";
import type { EvaluationGroup } from "../digital-engine.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makePassthroughFn(): ExecuteFunction {
  return (index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout) => {
    const wt = layout.wiringTable;
    const inBase = layout.inputOffset(index);
    const outBase = layout.outputOffset(index);
    state[wt[outBase]!] = state[wt[inBase]!]!;
  };
}

function makeCompiledCircuit(): CompiledCircuitImpl {
  const netCount = 4;
  const componentCount = 1;

  const inputOffsets = new Int32Array([0]);
  const outputOffsets = new Int32Array([1]);
  const inputCounts = new Uint8Array([1]);
  const outputCounts = new Uint8Array([1]);
  const wiringTable = Int32Array.from([0, 1, 2, 3]);
  const stateOffsets = new Int32Array([4]);

  const layout = new FlatComponentLayout(
    inputOffsets,
    outputOffsets,
    inputCounts,
    outputCounts,
    wiringTable,
    [],
    stateOffsets,
  );

  const executeFn = makePassthroughFn();

  const evaluationOrder: EvaluationGroup[] = [
    { componentIndices: new Uint32Array([0]), isFeedback: false },
  ];

  return new CompiledCircuitImpl({
    netCount,
    componentCount,
    totalStateSlots: 1,
    typeIds: new Uint16Array([0]),
    executeFns: [executeFn],
    sampleFns: [null],
    wiringTable,
    layout,
    evaluationOrder,
    sequentialComponents: new Uint32Array(0),
    netWidths: new Uint8Array([1, 8, 1, 1]),
    sccSnapshotBuffer: new Uint32Array(netCount),
    delays: new Uint32Array([10]),
    componentToElement: new Map(),
    labelToNetId: new Map(),
    wireToNetId: new Map(),
    pinNetMap: new Map(),
    resetComponentIndices: new Uint32Array(0),
    switchComponentIndices: new Uint32Array(0),
    switchClassification: new Uint8Array(componentCount),
    typeNames: ["And"],
  });
}

// ---------------------------------------------------------------------------
// Mock Worker that captures messages
// ---------------------------------------------------------------------------

interface CapturedMessage {
  type: string;
  [key: string]: unknown;
}

let capturedMessages: CapturedMessage[] = [];
let mockSharedBuffer: SharedArrayBuffer | null = null;

class TestMockWorker {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  postMessage(msg: unknown, _transfer?: unknown[]): void {
    const message = msg as CapturedMessage;
    capturedMessages.push(message);

    if (message.type === "init") {
      mockSharedBuffer = message["sharedBuffer"] as SharedArrayBuffer;
    }
  }

  terminate(): void { /* no-op */ }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WorkerSignal", () => {
  let originalWorker: unknown;

  beforeEach(() => {
    originalWorker = (globalThis as Record<string, unknown>)["Worker"];
    capturedMessages = [];
    mockSharedBuffer = null;

    (globalThis as Record<string, unknown>)["Worker"] = class extends TestMockWorker {
      constructor() {
        super();
      }
    };
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>)["Worker"] = originalWorker;
  });

  it("main_thread_reads_signal_after_step", () => {
    const compiled = makeCompiledCircuit();
    const engine = new WorkerEngine(compiled.netCount, "level");
    engine.init(compiled);

    // Verify the init message was sent
    const initMsg = capturedMessages.find((m) => m.type === "init");
    expect(initMsg).not.toBeUndefined();
    expect(mockSharedBuffer).toBeInstanceOf(SharedArrayBuffer);

    // Simulate what the worker does after a step: write values to the
    // shared buffer using Atomics.store()
    const sharedValues = new Int32Array(mockSharedBuffer!, 0, compiled.netCount);
    const sharedHighZs = new Int32Array(
      mockSharedBuffer!,
      compiled.netCount * Int32Array.BYTES_PER_ELEMENT,
      compiled.netCount,
    );

    // Worker writes output net 1 = 0xFF after stepping
    Atomics.store(sharedValues, 1, 0xFF);
    Atomics.store(sharedHighZs, 1, 0);

    // Main thread reads the value via WorkerEngine
    const rawValue = engine.getSignalRaw(1);
    expect(rawValue).toBe(0xFF);

    // Read as BitVector (net 1 has width 8 from netWidths)
    const bv = engine.getSignalValue(1);
    expect(Number(bv.valueBits)).toBe(0xFF);

    // Out-of-range netId returns 0
    expect(engine.getSignalRaw(999)).toBe(0);

    engine.dispose();
  });

  it("setSignalValue_propagates_to_worker", () => {
    const compiled = makeCompiledCircuit();
    const engine = new WorkerEngine(compiled.netCount, "level");
    engine.init(compiled);

    expect(mockSharedBuffer).toBeInstanceOf(SharedArrayBuffer);

    // Set input value via WorkerEngine
    const inputBv = BitVector.fromNumber(1, 1);
    engine.setSignalValue(0, inputBv);

    // The shared buffer should be updated immediately (main thread side)
    const sharedValues = new Int32Array(mockSharedBuffer!, 0, compiled.netCount);
    expect(Atomics.load(sharedValues, 0)).toBe(1);

    // A setSignal message should have been posted to the worker
    const setMsg = capturedMessages.find((m) => m.type === "setSignal");
    expect(setMsg).not.toBeUndefined();
    expect(setMsg!["netId"]).toBe(0);
    expect(setMsg!["valueLo"]).toBe(1);

    // Step message is also sent when step() is called
    engine.step();
    const stepMsg = capturedMessages.find((m) => m.type === "step");
    expect(stepMsg).not.toBeUndefined();

    engine.dispose();
  });
});
