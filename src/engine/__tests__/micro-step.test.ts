/**
 * Tests for MicroStepController — task 3.4.2.
 *
 * Uses DigitalEngine with minimal compiled circuits to verify that
 * MicroStepController correctly advances one component at a time and
 * reports which component fired and which nets changed.
 */

import { describe, it, expect } from "vitest";
import { MicroStepController } from "../micro-step.js";
import { DigitalEngine } from "../digital-engine.js";
import type { ConcreteCompiledCircuit, EvaluationGroup } from "../digital-engine.js";
import type { ComponentLayout } from "@/core/registry";
import type { Wire } from "@/core/circuit";
import { BitVector } from "@/core/signal";

// ---------------------------------------------------------------------------
// StaticLayout helper — same pattern as digital-engine.test.ts
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
 * Build a minimal ConcreteCompiledCircuit. executeFns are indexed by
 * typeId (Uint8Array value for each component).
 */
function buildCircuit(
  netCount: number,
  inputNets: number[][],
  outputNets: number[][],
  executeFns: Array<(i: number, s: Uint32Array, _hz: Uint32Array, l: ComponentLayout) => void>,
  typeIds: Uint16Array,
  evaluationOrder: EvaluationGroup[],
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
    componentToElement: new Map(),
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

describe("MicroStep", () => {
  // -------------------------------------------------------------------------
  // advancesOneComponent
  // -------------------------------------------------------------------------

  it("advancesOneComponent — step, verify only one component evaluated per call", () => {
    // Circuit: 2 independent gates, each reads input net and copies to output.
    // Net 0: input for gate 0
    // Net 1: output for gate 0
    // Net 2: input for gate 1
    // Net 3: output for gate 1
    const executeFn0 = (i: number, s: Uint32Array, _hz: Uint32Array, l: ComponentLayout): void => {
      s[l.wiringTable[l.outputOffset(i)]!] = s[l.wiringTable[l.inputOffset(i)]!];
    };
    const executeFn1 = (i: number, s: Uint32Array, _hz: Uint32Array, l: ComponentLayout): void => {
      s[l.wiringTable[l.outputOffset(i)]!] = s[l.wiringTable[l.inputOffset(i)]!];
    };

    const compiled = buildCircuit(
      4,
      [[0], [2]],  // input nets per component
      [[1], [3]],  // output nets per component
      [executeFn0, executeFn1],
      new Uint16Array([0, 1]),
      [singleGroup([0, 1])],
    );

    const engine = new DigitalEngine("microstep");
    engine.init(compiled);

    // Set net 0 to 1, net 2 to 1
    engine.setSignalValue(0, BitVector.fromNumber(1, 1));
    engine.setSignalValue(2, BitVector.fromNumber(1, 1));

    const ctrl = new MicroStepController(engine);

    // First micro-step: only component 0 should fire
    const result1 = ctrl.step();
    expect(result1.componentIndex).toBe(0);
    // Net 1 (output of component 0) should have changed from 0 (UNDEFINED) to 1
    expect(result1.changedNets).toContain(1);
    // Net 3 (output of component 1) should NOT have changed yet
    expect(result1.changedNets).not.toContain(3);
  });

  // -------------------------------------------------------------------------
  // reportsWhichComponentFired
  // -------------------------------------------------------------------------

  it("reportsWhichComponentFired — step, verify componentIndex and typeId are correct", () => {
    // Single component: typeId=0, component index 0
    const executeFn = (_i: number, _s: Uint32Array, _hz: Uint32Array, _l: ComponentLayout): void => {};

    const compiled = buildCircuit(
      2,
      [[0]],
      [[1]],
      [executeFn],
      new Uint16Array([0]),
      [singleGroup([0])],
    );

    const engine = new DigitalEngine("microstep");
    engine.init(compiled);

    const ctrl = new MicroStepController(engine);
    const result = ctrl.step();

    expect(result.componentIndex).toBe(0);
    expect(result.typeId).toBe("0");
  });

  // -------------------------------------------------------------------------
  // eventuallyStabilizes
  // -------------------------------------------------------------------------

  it("eventuallyStabilizes — step repeatedly, verify isStable() eventually returns true", () => {
    // Simple 2-gate circuit with no feedback
    const executeFn = (_i: number, _s: Uint32Array, _hz: Uint32Array, _l: ComponentLayout): void => {};

    const compiled = buildCircuit(
      3,
      [[0], [1]],
      [[1], [2]],
      [executeFn, executeFn],
      new Uint16Array([0, 0]),
      [singleGroup([0, 1])],
    );

    const engine = new DigitalEngine("microstep");
    engine.init(compiled);

    const ctrl = new MicroStepController(engine);

    // Step enough times to complete multiple passes
    let stable = false;
    for (let i = 0; i < 20; i++) {
      ctrl.step();
      if (ctrl.isStable()) {
        stable = true;
        break;
      }
    }

    expect(stable).toBe(true);
  });

  // -------------------------------------------------------------------------
  // propagationOrderVisible
  // -------------------------------------------------------------------------

  it("propagationOrderVisible — chain of 3 gates (A→B→C), micro-step 3 times, verify order is A, B, C", () => {
    // Chain: A writes net1, B reads net1 writes net2, C reads net2 writes net3
    // Net 0: input to A
    // Net 1: A→B
    // Net 2: B→C
    // Net 3: C output
    //
    // Components: 0=A, 1=B, 2=C in a single non-feedback group in that order.
    const executeFn = (i: number, s: Uint32Array, _hz: Uint32Array, l: ComponentLayout): void => {
      s[l.wiringTable[l.outputOffset(i)]!] = s[l.wiringTable[l.inputOffset(i)]!];
    };

    const compiled = buildCircuit(
      4,
      [[0], [1], [2]],
      [[1], [2], [3]],
      [executeFn, executeFn, executeFn],
      new Uint16Array([0, 0, 0]),
      [singleGroup([0, 1, 2])],
    );

    const engine = new DigitalEngine("microstep");
    engine.init(compiled);

    const ctrl = new MicroStepController(engine);

    const result0 = ctrl.step();
    const result1 = ctrl.step();
    const result2 = ctrl.step();

    // The evaluation order must respect the group order: component 0, 1, 2
    expect(result0.componentIndex).toBe(0);
    expect(result1.componentIndex).toBe(1);
    expect(result2.componentIndex).toBe(2);
  });

  // -------------------------------------------------------------------------
  // reset clears stability state
  // -------------------------------------------------------------------------

  it("reset clears stability state — after stabilizing, reset makes isStable() false again", () => {
    const executeFn = (_i: number, _s: Uint32Array, _hz: Uint32Array, _l: ComponentLayout): void => {};

    const compiled = buildCircuit(
      2,
      [[0]],
      [[1]],
      [executeFn],
      new Uint16Array([0]),
      [singleGroup([0])],
    );

    const engine = new DigitalEngine("microstep");
    engine.init(compiled);

    const ctrl = new MicroStepController(engine);

    // Step until stable
    for (let i = 0; i < 10; i++) {
      ctrl.step();
      if (ctrl.isStable()) break;
    }

    expect(ctrl.isStable()).toBe(true);

    ctrl.reset();
    expect(ctrl.isStable()).toBe(false);
  });
});
