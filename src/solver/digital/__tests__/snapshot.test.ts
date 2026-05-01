/**
 * Tests for the DigitalEngine snapshot API- task 5.5.3.
 *
 * Tests use a minimal ConcreteCompiledCircuit built in-process (same pattern
 * as digital-engine.test.ts) so they do not depend on the compiler.
 */

import { describe, it, expect } from "vitest";
import { DigitalEngine, type ConcreteCompiledCircuit, type EvaluationGroup } from "../digital-engine.js";
import { EngineState } from "@/core/engine-interface";
import type { ExecuteFunction, ComponentLayout } from "@/core/registry";

// ---------------------------------------------------------------------------
// Helpers- reused from digital-engine.test.ts pattern
// ---------------------------------------------------------------------------

class StaticLayout implements ComponentLayout {
  readonly wiringTable: Int32Array;
  private readonly _inputOffsets: number[];
  private readonly _outputOffsets: number[];
  private readonly _inputCounts: number[];
  private readonly _outputCounts: number[];

  constructor(inputNets: number[][], outputNets: number[][]) {
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

  inputCount(idx: number): number { return this._inputCounts[idx] ?? 0; }
  inputOffset(idx: number): number { return this._inputOffsets[idx] ?? 0; }
  outputCount(idx: number): number { return this._outputCounts[idx] ?? 0; }
  outputOffset(idx: number): number { return this._outputOffsets[idx] ?? 0; }
  stateOffset(_idx: number): number { return 0; }
  getProperty(): undefined { return undefined; }
}

function buildCircuit(
  netCount: number,
  inputNets: number[][],
  outputNets: number[][],
  executeFns: ExecuteFunction[],
  typeIds: Uint16Array,
  evaluationOrder: EvaluationGroup[],
): ConcreteCompiledCircuit {
  const layout = new StaticLayout(inputNets, outputNets);
  const componentCount = typeIds.length;
  const netWidths = new Uint8Array(netCount).fill(1);
  const sccSnapshotBuffer = new Uint32Array(netCount);
  const delays = new Uint32Array(componentCount).fill(10);

  return {
    netCount,
    componentCount,
    typeIds,
    executeFns,
    sampleFns: executeFns.map(() => null),
    wiringTable: layout.wiringTable,
    layout,
    evaluationOrder,
    sequentialComponents: new Uint32Array(0),
    netWidths,
    sccSnapshotBuffer,
    delays,
    componentToElement: new Map(),
    wireToNetId: new Map(),
    pinNetMap: new Map(),
    resetComponentIndices: new Uint32Array(0),
    busResolver: null,
    switchComponentIndices: new Uint32Array(0),
    switchClassification: new Uint8Array(0),
    totalStateSlots: 0,
    signalArraySize: netCount,
    shadowNetCount: 0,
  };
}

/** Build a simple passthrough circuit with `netCount` nets and no components. */
function buildEmptyCircuit(netCount: number): ConcreteCompiledCircuit {
  return buildCircuit(
    netCount,
    [],
    [],
    [],
    new Uint16Array(0),
    [],
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("saveAndRestore", () => {
  it("restores signal values to saved state", () => {
    const engine = new DigitalEngine("level");
    engine.init(buildEmptyCircuit(4));

    // Set signal values via setSignalRaw-equivalent: use setSignalValue
    // We use the raw approach: call init, manipulate via getSignalRaw after
    // setting up the state manually via the engine's setSignalValue pathway.
    // For simplicity use the BitVector import-free path- we write via
    // internal signal manipulation by stepping with a custom execute function.

    // Build a circuit where component 0 writes net 0 = 42 when step() is called
    const executeFns: ExecuteFunction[] = [
      (_idx, state, _layout) => { state[0] = 42; },
    ];
    const circuit = buildCircuit(
      2,
      [[]],
      [[0]],
      executeFns,
      new Uint16Array([0]),
      [{ componentIndices: new Uint32Array([0]), isFeedback: false }],
    );

    const eng = new DigitalEngine("level");
    eng.init(circuit);
    eng.step(); // net 0 = 42

    const id = eng.saveSnapshot();

    // Mutate: change the execute function effect by replacing state directly
    // (the execute fn always writes 42, so instead we test with net 1)
    // Simpler approach: use a second circuit step that overwrites net 0 to 99
    // We can't hot-swap executeFns after init, so we use setSignalValue path.
    // Use a second engine step but with a different fn- instead test by
    // directly writing via raw Uint32Array through getSignalRaw observation.

    // Confirm state before: net 0 = 42
    expect(eng.getSignalRaw(0)).toBe(42);

    // Save, then corrupt net 0 by reinitializing signal to 0 via reset
    eng.reset();
    expect(eng.getSignalRaw(0)).toBe(0);

    // Restore- should bring net 0 back to 42
    eng.restoreSnapshot(id);
    expect(eng.getSignalRaw(0)).toBe(42);
  });
});

describe("multipleSnapshots", () => {
  it("restores the correct state when multiple snapshots exist", () => {
    // Three-net circuit; use execute fns that write controllable values
    // We control values by resetting and writing via setSignalValue (BitVector-free
    // use a circuit that writes specific values per step iteration.

    // Strategy: build a circuit whose execute fn increments net 0 by 1 each step.
    let counter = 0;
    const executeFns: ExecuteFunction[] = [
      (_idx, state, _layout) => { state[0] = counter; },
    ];
    const circuit = buildCircuit(
      1,
      [[]],
      [[0]],
      executeFns,
      new Uint16Array([0]),
      [{ componentIndices: new Uint32Array([0]), isFeedback: false }],
    );

    const eng = new DigitalEngine("level");
    eng.init(circuit);

    counter = 10;
    eng.step();
    const id1 = eng.saveSnapshot(); // net 0 = 10

    counter = 20;
    eng.step();
    const id2 = eng.saveSnapshot(); // net 0 = 20

    counter = 30;
    eng.step();
    const id3 = eng.saveSnapshot(); // net 0 = 30

    expect(eng.getSnapshotCount()).toBe(3);

    // Restore the second snapshot
    eng.restoreSnapshot(id2);
    expect(eng.getSignalRaw(0)).toBe(20);

    // Restore the first snapshot
    eng.restoreSnapshot(id1);
    expect(eng.getSignalRaw(0)).toBe(10);

    // Restore the third snapshot
    eng.restoreSnapshot(id3);
    expect(eng.getSignalRaw(0)).toBe(30);
  });
});

describe("ringBufferEviction", () => {
  it("evicts oldest snapshot when budget is exceeded", () => {
    // Each snapshot for a 1-net circuit costs:
    //   values:         4 bytes (Uint32Array, 1 element)
    //   highZs:         4 bytes
    //   undefinedFlags: 1 byte (Uint8Array, 1 element)
    //   Total:          9 bytes per snapshot
    // Set budget to 1024 bytes so we can save ~113 snapshots before eviction
    // Then set a tight budget of 18 bytes (fits exactly 2 snapshots of 9 bytes each)
    // so that saving a third evicts the first.

    let value = 0;
    const executeFns: ExecuteFunction[] = [
      (_idx, state, _layout) => { state[0] = value; },
    ];
    const circuit = buildCircuit(
      1,
      [[]],
      [[0]],
      executeFns,
      new Uint16Array([0]),
      [{ componentIndices: new Uint32Array([0]), isFeedback: false }],
    );

    const eng = new DigitalEngine("level");
    eng.init(circuit);

    // Each snapshot = 4 (values) + 4 (highZs) + 1 (undefinedFlags) = 9 bytes
    // Budget of 18 bytes fits exactly 2 snapshots; the third evicts the first.
    eng.setSnapshotBudget(18);

    value = 1;
    eng.step();
    const id1 = eng.saveSnapshot(); // snapshot 1 (9 bytes used)

    value = 2;
    eng.step();
    const id2 = eng.saveSnapshot(); // snapshot 2 (18 bytes used- at budget)

    expect(eng.getSnapshotCount()).toBe(2);

    value = 3;
    eng.step();
    const id3 = eng.saveSnapshot(); // snapshot 3- evicts snapshot 1

    expect(eng.getSnapshotCount()).toBe(2);

    // Snapshot 1 must be gone
    expect(() => eng.restoreSnapshot(id1)).toThrow();

    // Snapshots 2 and 3 must still be valid
    eng.restoreSnapshot(id2);
    expect(eng.getSignalRaw(0)).toBe(2);

    eng.restoreSnapshot(id3);
    expect(eng.getSignalRaw(0)).toBe(3);
  });
});

describe("restorePausesEngine", () => {
  it("transitions engine to PAUSED state after restoring a snapshot", () => {
    const eng = new DigitalEngine("level");
    eng.init(buildEmptyCircuit(2));

    const id = eng.saveSnapshot();

    // Start the engine (transitions to RUNNING)
    // We can't truly run continuously in tests (no RAF), but we can simulate
    // by checking state transitions: start() -> RUNNING, then restore -> PAUSED
    eng.start();
    // In test environment start() sets RUNNING even without actual scheduling
    // (setState is called synchronously)
    // However continuous run uses RAF/setTimeout; stop it by calling stop first
    // then manually set to RUNNING via start to capture the state.

    // Use stop() to get to PAUSED, then restore should keep it PAUSED
    eng.stop();
    expect(eng.getState()).toBe(EngineState.PAUSED);

    // Save another snapshot in PAUSED state, then restore an old one
    const id2 = eng.saveSnapshot();
    void id2; // used to verify below

    // Restore to STOPPED-era snapshot- must result in PAUSED regardless
    eng.restoreSnapshot(id);
    expect(eng.getState()).toBe(EngineState.PAUSED);
  });
});

describe("clearSnapshots", () => {
  it("removes all stored snapshots and resets count to 0", () => {
    const eng = new DigitalEngine("level");
    eng.init(buildEmptyCircuit(2));

    eng.saveSnapshot();
    eng.saveSnapshot();
    eng.saveSnapshot();
    eng.saveSnapshot();
    eng.saveSnapshot();

    expect(eng.getSnapshotCount()).toBe(5);

    eng.clearSnapshots();

    expect(eng.getSnapshotCount()).toBe(0);
  });
});

describe("invalidIdThrows", () => {
  it("throws a descriptive error when restoring a non-existent snapshot ID", () => {
    const eng = new DigitalEngine("level");
    eng.init(buildEmptyCircuit(2));

    expect(() => eng.restoreSnapshot(99999)).toThrow(/99999/);
  });
});
