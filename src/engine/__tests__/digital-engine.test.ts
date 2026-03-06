/**
 * Tests for DigitalEngine — task 3.1.1.
 *
 * Tests use a minimal ConcreteCompiledCircuit built in-process so they
 * do not depend on the compiler (task 3.2.1).
 */

import { describe, it, expect } from "vitest";
import { DigitalEngine, type ConcreteCompiledCircuit, type EvaluationGroup } from "../digital-engine.js";
import { EngineState } from "@/core/engine-interface";
import type { ExecuteFunction, ComponentLayout } from "@/core/registry";

// ---------------------------------------------------------------------------
// Helpers — build minimal ConcreteCompiledCircuit instances for tests
// ---------------------------------------------------------------------------

/**
 * A ComponentLayout implementation backed by static per-component wiring.
 *
 * inputNets[i]  = array of net IDs that are inputs to component i
 * outputNets[i] = array of net IDs that are outputs of component i
 *
 * inputOffset(i)  returns the first input net ID for component i.
 * outputOffset(i) returns the first output net ID for component i.
 *
 * Execute functions in tests address nets by their direct net IDs
 * (reading state[netId]) so they do not rely on inputOffset arithmetic.
 */
class StaticLayout implements ComponentLayout {
  constructor(
    private readonly _inputNets: number[][],
    private readonly _outputNets: number[][],
  ) {}

  inputCount(idx: number): number {
    return this._inputNets[idx]?.length ?? 0;
  }

  inputOffset(idx: number): number {
    return this._inputNets[idx]?.[0] ?? 0;
  }

  outputCount(idx: number): number {
    return this._outputNets[idx]?.length ?? 0;
  }

  outputOffset(idx: number): number {
    return this._outputNets[idx]?.[0] ?? 0;
  }

  stateOffset(_idx: number): number {
    return 0;
  }
}

/**
 * Build a ConcreteCompiledCircuit from explicit wiring and function table.
 */
function buildCircuit(
  netCount: number,
  inputNets: number[][],
  outputNets: number[][],
  executeFns: ExecuteFunction[],
  typeIds: Uint8Array,
  evaluationOrder: EvaluationGroup[],
  delays?: Uint32Array,
): ConcreteCompiledCircuit {
  const layout = new StaticLayout(inputNets, outputNets);
  const componentCount = typeIds.length;
  const netWidths = new Uint8Array(netCount).fill(1);
  const sccSnapshotBuffer = new Uint32Array(netCount);
  const defaultDelays = delays ?? new Uint32Array(componentCount).fill(10);

  return {
    netCount,
    componentCount,
    typeIds,
    executeFns,
    layout,
    evaluationOrder,
    sequentialComponents: new Uint32Array(0),
    netWidths,
    sccSnapshotBuffer,
    delays: defaultDelays,
    componentToElement: new Map(),
    labelToNetId: new Map(),
    wireToNetId: new Map(),
    pinNetMap: new Map(),
  };
}

/** Make a single non-feedback group containing the provided component indices. */
function singleGroup(indices: number[]): EvaluationGroup {
  return {
    componentIndices: new Uint32Array(indices),
    isFeedback: false,
  };
}

/** Make a feedback group containing the provided component indices. */
function feedbackGroup(indices: number[]): EvaluationGroup {
  return {
    componentIndices: new Uint32Array(indices),
    isFeedback: true,
  };
}

/**
 * Directly set a net's signal value in the engine's private arrays.
 * Bypasses setSignalValue() to avoid allocation in setup code.
 */
function setNet(engine: DigitalEngine, netId: number, value: number): void {
  (engine as unknown as { _values: Uint32Array })["_values"][netId] = value >>> 0;
  (engine as unknown as { _highZs: Uint32Array })["_highZs"][netId] = 0;
}

// ---------------------------------------------------------------------------
// DigitalEngine tests
// ---------------------------------------------------------------------------

describe("DigitalEngine", () => {
  // -------------------------------------------------------------------------
  // initSetsAllSignalsUndefined
  // -------------------------------------------------------------------------
  it("initSetsAllSignalsUndefined", () => {
    const engine = new DigitalEngine("level");

    const circuit = buildCircuit(
      5,
      [],
      [],
      [],
      new Uint8Array(0),
      [],
    );

    engine.init(circuit);

    // getSignalRaw returns the value word — UNDEFINED encoding has value=0
    for (let i = 0; i < 5; i++) {
      expect(engine.getSignalRaw(i)).toBe(0);
    }

    // getSignalValue should report isUndefined for all nets
    for (let i = 0; i < 5; i++) {
      const bv = engine.getSignalValue(i);
      expect(bv.isUndefined).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // stepEvaluatesAllComponents
  // -------------------------------------------------------------------------
  it("stepEvaluatesAllComponents", () => {
    // Circuit: AND gate (component 0) feeding OR gate (component 1).
    // Nets: 0=A, 1=B, 2=AND_out, 3=C, 4=OR_out
    const netCount = 5;

    const andExecute: ExecuteFunction = (_idx, state, _layout) => {
      state[2] = (state[0]! & state[1]!) >>> 0;
    };

    const orExecute: ExecuteFunction = (_idx, state, _layout) => {
      state[4] = (state[2]! | state[3]!) >>> 0;
    };

    const executeFns: ExecuteFunction[] = [andExecute, orExecute];
    const typeIds = new Uint8Array([0, 1]);
    const inputNets = [[0, 1], [2, 3]];
    const outputNets = [[2], [4]];
    const evaluationOrder: EvaluationGroup[] = [singleGroup([0, 1])];

    const circuit = buildCircuit(netCount, inputNets, outputNets, executeFns, typeIds, evaluationOrder);
    const engine = new DigitalEngine("level");
    engine.init(circuit);

    // Set inputs: A=1, B=1, C=0
    setNet(engine, 0, 1); // A
    setNet(engine, 1, 1); // B
    setNet(engine, 3, 0); // C

    engine.step();

    // AND(1,1) = 1, OR(1,0) = 1
    expect(engine.getSignalRaw(2)).toBe(1); // AND output
    expect(engine.getSignalRaw(4)).toBe(1); // OR output
  });

  // -------------------------------------------------------------------------
  // levelModeOnePassForCombinational
  // -------------------------------------------------------------------------
  it("levelModeOnePassForCombinational", () => {
    // Pure combinational NOT gate. Net 0 = input, net 1 = output.
    let callCount = 0;

    const notExecute: ExecuteFunction = (_idx, state, _layout) => {
      callCount++;
      state[1] = state[0]! === 0 ? 1 : 0;
    };

    const executeFns: ExecuteFunction[] = [notExecute];
    const typeIds = new Uint8Array([0]);
    const inputNets = [[0]];
    const outputNets = [[1]];
    const evaluationOrder: EvaluationGroup[] = [singleGroup([0])];

    const circuit = buildCircuit(2, inputNets, outputNets, executeFns, typeIds, evaluationOrder);
    const engine = new DigitalEngine("level");
    engine.init(circuit);

    setNet(engine, 0, 0); // input = 0

    engine.step();

    // Should be called exactly once (one-pass for non-feedback)
    expect(callCount).toBe(1);
    expect(engine.getSignalRaw(1)).toBe(1);
  });

  // -------------------------------------------------------------------------
  // feedbackSCCIteratesUntilStable
  // -------------------------------------------------------------------------
  it("feedbackSCCIteratesUntilStable", () => {
    // SR latch from 2 NOR gates (S=0, R=0 — hold state).
    // NOR1 (component 0): NOR(S=net0, Q_bar=net3) → Q=net2
    // NOR2 (component 1): NOR(R=net1, Q=net2)    → Q_bar=net3

    const nor1Execute: ExecuteFunction = (_idx, state, _layout) => {
      const s = state[0]! & 1;
      const qBar = state[3]! & 1;
      state[2] = (s | qBar) === 0 ? 1 : 0;
    };

    const nor2Execute: ExecuteFunction = (_idx, state, _layout) => {
      const r = state[1]! & 1;
      const q = state[2]! & 1;
      state[3] = (r | q) === 0 ? 1 : 0;
    };

    const executeFns: ExecuteFunction[] = [nor1Execute, nor2Execute];
    const typeIds = new Uint8Array([0, 1]);
    const inputNets = [[0, 3], [1, 2]];
    const outputNets = [[2], [3]];
    const evaluationOrder: EvaluationGroup[] = [feedbackGroup([0, 1])];

    const circuit = buildCircuit(4, inputNets, outputNets, executeFns, typeIds, evaluationOrder);
    const engine = new DigitalEngine("level");
    engine.init(circuit);

    // S=0, R=0 (hold state)
    setNet(engine, 0, 0); // S
    setNet(engine, 1, 0); // R

    // Seed Q=1, Q_bar=0 to break symmetry (simulating noise init)
    setNet(engine, 2, 1); // Q
    setNet(engine, 3, 0); // Q_bar

    engine.step();

    const q = engine.getSignalRaw(2);
    const qBar = engine.getSignalRaw(3);

    // Valid SR latch state: Q and Q_bar must be complementary
    expect((q === 0 && qBar === 1) || (q === 1 && qBar === 0)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // microStepAdvancesOneGate
  // -------------------------------------------------------------------------
  it("microStepAdvancesOneGate", () => {
    // Two buffer gates in sequence.
    const evaluated: number[] = [];

    const gate0Execute: ExecuteFunction = (_idx, state, _layout) => {
      evaluated.push(0);
      state[1] = state[0]!;
    };

    const gate1Execute: ExecuteFunction = (_idx, state, _layout) => {
      evaluated.push(1);
      state[2] = state[1]!;
    };

    const executeFns: ExecuteFunction[] = [gate0Execute, gate1Execute];
    const typeIds = new Uint8Array([0, 1]);
    const inputNets = [[0], [1]];
    const outputNets = [[1], [2]];
    const evaluationOrder: EvaluationGroup[] = [singleGroup([0, 1])];

    const circuit = buildCircuit(3, inputNets, outputNets, executeFns, typeIds, evaluationOrder);
    const engine = new DigitalEngine("microstep");
    engine.init(circuit);

    // First step: evaluate component 0 only
    engine.step();
    expect(evaluated).toEqual([0]);
    expect(engine.getLastEvaluatedComponent()?.index).toBe(0);

    // Second step: evaluate component 1 only
    engine.step();
    expect(evaluated).toEqual([0, 1]);
    expect(engine.getLastEvaluatedComponent()?.index).toBe(1);
  });

  // -------------------------------------------------------------------------
  // stateTransitions
  // -------------------------------------------------------------------------
  it("stateTransitions", () => {
    const engine = new DigitalEngine("level");

    // Initial state before init
    expect(engine.getState()).toBe(EngineState.STOPPED);

    const circuit = buildCircuit(1, [], [], [], new Uint8Array(0), []);
    engine.init(circuit);

    // After init, still STOPPED
    expect(engine.getState()).toBe(EngineState.STOPPED);

    // start() → RUNNING
    engine.start();
    expect(engine.getState()).toBe(EngineState.RUNNING);

    // stop() → PAUSED
    engine.stop();
    expect(engine.getState()).toBe(EngineState.PAUSED);

    // reset() → STOPPED
    engine.reset();
    expect(engine.getState()).toBe(EngineState.STOPPED);
  });

  // -------------------------------------------------------------------------
  // changeListenerFires
  // -------------------------------------------------------------------------
  it("changeListenerFires", () => {
    const engine = new DigitalEngine("level");

    const circuit = buildCircuit(2, [], [], [], new Uint8Array(0), []);
    engine.init(circuit);

    const receivedStates: EngineState[] = [];
    const listener = (state: EngineState): void => {
      receivedStates.push(state);
    };

    engine.addChangeListener(listener);

    engine.start();
    expect(receivedStates).toContain(EngineState.RUNNING);

    engine.stop();
    expect(receivedStates).toContain(EngineState.PAUSED);

    engine.reset();
    expect(receivedStates).toContain(EngineState.STOPPED);
  });

  // -------------------------------------------------------------------------
  // setSignalValuePropagates
  // -------------------------------------------------------------------------
  it("setSignalValuePropagates", () => {
    // NOT gate: net 0 = input, net 1 = output.
    const notExecute: ExecuteFunction = (_idx, state, _layout) => {
      state[1] = state[0]! === 0 ? 1 : 0;
    };

    const executeFns: ExecuteFunction[] = [notExecute];
    const typeIds = new Uint8Array([0]);
    const inputNets = [[0]];
    const outputNets = [[1]];
    const evaluationOrder: EvaluationGroup[] = [singleGroup([0])];

    const circuit = buildCircuit(2, inputNets, outputNets, executeFns, typeIds, evaluationOrder);
    const engine = new DigitalEngine("level");
    engine.init(circuit);

    // Input = 0 → NOT output should be 1
    setNet(engine, 0, 0);
    engine.step();
    expect(engine.getSignalRaw(1)).toBe(1);

    // Change input to 1 → NOT output should be 0
    setNet(engine, 0, 1);
    engine.step();
    expect(engine.getSignalRaw(1)).toBe(0);
  });
});
