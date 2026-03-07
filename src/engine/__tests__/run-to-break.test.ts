/**
 * Tests for RunToBreak — task 3.4.3.
 *
 * Builds minimal ConcreteCompiledCircuit instances with Break components
 * (identified by element.type === "Break") to verify halt behaviour.
 */

import { describe, it, expect } from "vitest";
import { run } from "../run-to-break.js";
import { DigitalEngine, type ConcreteCompiledCircuit, type EvaluationGroup } from "../digital-engine.js";
import type { ComponentLayout } from "@/core/registry";
import type { CircuitElement } from "@/core/element";
import type { Wire } from "@/core/circuit";

// ---------------------------------------------------------------------------
// StaticLayout — same pattern as other engine tests
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

  inputCount(i: number): number { return this._inputCounts[i] ?? 0; }
  inputOffset(i: number): number { return this._inputOffsets[i] ?? 0; }
  outputCount(i: number): number { return this._outputCounts[i] ?? 0; }
  outputOffset(i: number): number { return this._outputOffsets[i] ?? 0; }
  stateOffset(_i: number): number { return 0; }
}

function singleGroup(indices: number[]): EvaluationGroup {
  return { componentIndices: new Uint32Array(indices), isFeedback: false };
}

/**
 * Build a minimal ConcreteCompiledCircuit.
 *
 * componentElements maps component index to a partial CircuitElement stub
 * containing at least { type: string }.
 */
function buildCircuit(
  netCount: number,
  inputNets: number[][],
  outputNets: number[][],
  executeFns: Array<(i: number, s: Uint32Array, _hz: Uint32Array, l: ComponentLayout) => void>,
  typeIds: Uint8Array,
  evaluationOrder: EvaluationGroup[],
  componentElements: Map<number, Partial<CircuitElement>>,
): ConcreteCompiledCircuit {
  const layout = new StaticLayout(inputNets, outputNets);
  const componentCount = typeIds.length;
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
    netWidths: new Uint8Array(netCount).fill(1),
    sccSnapshotBuffer: new Uint32Array(netCount),
    delays: new Uint32Array(componentCount).fill(10),
    componentToElement: componentElements as Map<number, CircuitElement>,
    labelToNetId: new Map(),
    wireToNetId: new Map<Wire, number>(),
    pinNetMap: new Map(),
    resetComponentIndices: new Uint32Array(0),
    busResolver: null,
    switchComponentIndices: new Uint32Array(0),
    switchClassification: new Uint8Array(0),
    totalStateSlots: 0,
    signalArraySize: netCount,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RunToBreak", () => {
  // -------------------------------------------------------------------------
  // haltsOnBreak
  // -------------------------------------------------------------------------

  it("haltsOnBreak — circuit with Break component, input goes high after 5 steps, verify stops at step 5", () => {
    // Circuit layout:
    //   Net 0: a counter-driven signal — goes to 1 on the 5th step
    //   Net 1: output of the driver component (unused)
    //   Component 0 (index 0): driver — counts calls and writes 1 to net 0 on 5th call
    //   Component 1 (index 1): Break — input is net 0
    //
    // The Break component has no execute logic (it is a monitor, not a gate).
    // run-to-break reads the Break's input net directly after each step.

    let callCount = 0;
    const driverFn = (_i: number, s: Uint32Array, _hz: Uint32Array, _l: ComponentLayout): void => {
      callCount++;
      // Assert net 0 on the 5th call
      s[0] = callCount >= 5 ? 1 : 0;
    };
    const breakFn = (_i: number, _s: Uint32Array, _hz: Uint32Array, _l: ComponentLayout): void => {
      // Break components have no side-effectful execute behaviour in this test
    };

    const compiled = buildCircuit(
      2,
      [[], [0]],        // component 0: no inputs; component 1 (Break): input net 0
      [[1], []],        // component 0: output net 1; component 1: no outputs
      [driverFn, breakFn],
      new Uint8Array([0, 1]),
      [singleGroup([0, 1])],
      new Map([[1, { typeId: "Break" } as unknown as CircuitElement]]),
    );

    const engine = new DigitalEngine("level");
    engine.init(compiled);
    callCount = 0;

    const result = run(engine, compiled, 100);

    expect(result.reason).toBe("break");
    expect(result.stepsExecuted).toBe(5);
  });

  // -------------------------------------------------------------------------
  // haltsOnMaxSteps
  // -------------------------------------------------------------------------

  it("haltsOnMaxSteps — no Break fires, verify stops at maxSteps", () => {
    // Circuit with a Break component whose input never goes high.
    const noopFn = (_i: number, _s: Uint32Array, _hz: Uint32Array, _l: ComponentLayout): void => {};

    const compiled = buildCircuit(
      2,
      [[], [0]],
      [[1], []],
      [noopFn, noopFn],
      new Uint8Array([0, 1]),
      [singleGroup([0, 1])],
      new Map([[1, { typeId: "Break" } as unknown as CircuitElement]]),
    );

    const engine = new DigitalEngine("level");
    engine.init(compiled);

    const result = run(engine, compiled, 10);

    expect(result.reason).toBe("maxSteps");
    expect(result.stepsExecuted).toBe(10);
    expect(result.breakComponent).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // reportsBreakComponent
  // -------------------------------------------------------------------------

  it("reportsBreakComponent — verify breakComponent index matches the Break element", () => {
    // Circuit with 3 components:
    //   Index 0: driver (immediately asserts net 0 = 1 on first step)
    //   Index 1: non-Break component
    //   Index 2: Break component monitoring net 0
    //
    // The Break fires on step 1. breakComponent must be 2.

    const driverFn = (_i: number, s: Uint32Array, _hz: Uint32Array, _l: ComponentLayout): void => {
      s[0] = 1;
    };
    const noopFn = (_i: number, _s: Uint32Array, _hz: Uint32Array, _l: ComponentLayout): void => {};

    const compiled = buildCircuit(
      3,
      [[], [], [0]],    // component 0: no inputs; 1: no inputs; 2 (Break): input net 0
      [[0], [1], [2]],  // each component has one output (not relevant for Break detection)
      [driverFn, noopFn, noopFn],
      new Uint8Array([0, 1, 2]),
      [singleGroup([0, 1, 2])],
      new Map([
        [1, { typeId: "NotBreak" } as unknown as CircuitElement],
        [2, { typeId: "Break" } as unknown as CircuitElement],
      ]),
    );

    const engine = new DigitalEngine("level");
    engine.init(compiled);

    const result = run(engine, compiled, 100);

    expect(result.reason).toBe("break");
    expect(result.breakComponent).toBe(2);
    expect(result.stepsExecuted).toBe(1);
  });
});
