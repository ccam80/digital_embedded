/**
 * Integration tests for oscillation detection in feedback groups.
 *
 * Verifies that OscillationDetector is wired into _evaluateFeedbackGroup()
 * and that OscillationError is thrown with correct component indices.
 */

import { describe, it, expect } from "vitest";
import { DigitalEngine, type ConcreteCompiledCircuit, type EvaluationGroup } from "../digital-engine.js";
import { OscillationError } from "@/core/errors";
import type { ExecuteFunction, ComponentLayout } from "@/core/registry";

/**
 * Directly set a net's signal value in the engine's private arrays.
 */
function setNet(engine: DigitalEngine, netId: number, value: number): void {
  (engine as unknown as { _values: Uint32Array })["_values"][netId] = value >>> 0;
  (engine as unknown as { _highZs: Uint32Array })["_highZs"][netId] = 0;
}

// ---------------------------------------------------------------------------
// Helpers — build minimal ConcreteCompiledCircuit for oscillation tests
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
    this._inputCounts = inputNets.map((n) => n.length);
    this._outputCounts = outputNets.map((n) => n.length);

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

function feedbackGroup(indices: number[]): EvaluationGroup {
  return {
    componentIndices: new Uint32Array(indices),
    isFeedback: true,
  };
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
    netWidths: new Uint8Array(netCount).fill(1),
    sccSnapshotBuffer: new Uint32Array(netCount),
    delays: new Uint32Array(componentCount).fill(10),
    componentToElement: new Map(),
    labelToNetId: new Map(),
    wireToNetId: new Map(),
    pinNetMap: new Map(),
    resetComponentIndices: new Uint32Array(0),
    busResolver: null,
    switchComponentIndices: new Uint32Array(0),
    switchClassification: new Uint8Array(0),
  };
}

/**
 * NOT gate executeFn: output = ~input (bitwise).
 * Uses wiring table indirection.
 */
function executeNot(
  index: number,
  state: Uint32Array,
  _highZs: Uint32Array,
  layout: ComponentLayout,
): void {
  const wt = layout.wiringTable;
  const inOff = layout.inputOffset(index);
  const outOff = layout.outputOffset(index);
  state[wt[outOff]!] = (~state[wt[inOff]!]!) >>> 0;
}

/**
 * NOR gate executeFn: output = ~(A | B).
 * Uses wiring table indirection.
 */
function executeNor(
  index: number,
  state: Uint32Array,
  _highZs: Uint32Array,
  layout: ComponentLayout,
): void {
  const wt = layout.wiringTable;
  const inOff = layout.inputOffset(index);
  const inCount = layout.inputCount(index);
  const outOff = layout.outputOffset(index);
  let result = 0;
  for (let i = 0; i < inCount; i++) {
    result = (result | state[wt[inOff + i]!]!) >>> 0;
  }
  state[wt[outOff]!] = (~result) >>> 0;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OscillationDetection", () => {
  it("ring_oscillator_throws", () => {
    // 3-inverter ring: NOT0(net0->net1), NOT1(net1->net2), NOT2(net2->net0)
    // This forms an unstable feedback loop that never converges.
    const netCount = 3;
    const inputNets = [[0], [1], [2]];
    const outputNets = [[1], [2], [0]];
    const typeIds = new Uint16Array([0, 0, 0]);
    const executeFns: ExecuteFunction[] = [executeNot];
    const order = [feedbackGroup([0, 1, 2])];

    const circuit = buildCircuit(netCount, inputNets, outputNets, executeFns, typeIds, order);
    const engine = new DigitalEngine("level");
    engine.init(circuit);

    expect(() => engine.step()).toThrow(OscillationError);
  });

  it("stable_feedback_does_not_throw", () => {
    // SR latch using NOR gates:
    //   NOR0 inputs: net0 (S), net3 (Q~) -> output: net2 (Q)
    //   NOR1 inputs: net1 (R), net2 (Q)  -> output: net3 (Q~)
    // With S=0, R=0, Q starts undefined but converges to a stable state.
    //
    // We pre-set net0=0 (S), net1=1 (R) to force Q=0, Q~=1.
    // Then on step, the feedback converges.
    const netCount = 4;
    // NOR0: inputs [S=net0, Q~=net3], output [Q=net2]
    // NOR1: inputs [R=net1, Q=net2], output [Q~=net3]
    const inputNets = [[0, 3], [1, 2]];
    const outputNets = [[2], [3]];
    const typeIds = new Uint16Array([0, 0]);
    const executeFns: ExecuteFunction[] = [executeNor];
    const order = [feedbackGroup([0, 1])];

    const circuit = buildCircuit(netCount, inputNets, outputNets, executeFns, typeIds, order);
    const engine = new DigitalEngine("level");
    engine.init(circuit);

    // Pre-set inputs: S=0, R=1 -> forces Q=0, Q~=0 initially, converges to Q=0, Q~=1
    setNet(engine, 0, 0); // S=0
    setNet(engine, 1, 1); // R=1
    // Seed Q and Q~ to break symmetry
    setNet(engine, 2, 0); // Q=0
    setNet(engine, 3, 1); // Q~=1

    expect(() => engine.step()).not.toThrow();
  });

  it("exception_contains_oscillating_components", () => {
    // Same 3-inverter ring. Catch OscillationError and verify fields.
    const netCount = 3;
    const inputNets = [[0], [1], [2]];
    const outputNets = [[1], [2], [0]];
    const typeIds = new Uint16Array([0, 0, 0]);
    const executeFns: ExecuteFunction[] = [executeNot];
    const order = [feedbackGroup([0, 1, 2])];

    const circuit = buildCircuit(netCount, inputNets, outputNets, executeFns, typeIds, order);
    const engine = new DigitalEngine("level");
    engine.init(circuit);

    let caughtError: OscillationError | null = null;
    try {
      engine.step();
    } catch (e) {
      if (e instanceof OscillationError) {
        caughtError = e;
      } else {
        throw e;
      }
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError!.componentIndices).toEqual([0, 1, 2]);
    expect(caughtError!.iterations).toBeGreaterThan(0);
  });
});
