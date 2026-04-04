/**
 * Integration tests for ClockManager as an external utility.
 *
 * Verifies that advanceClocks() is called externally before engine.step(),
 * that step() alone does not toggle clocks, and that multi-frequency clocks
 * toggle at the correct rates.
 */

import { describe, it, expect } from "vitest";
import { DigitalEngine, type ConcreteCompiledCircuit, type EvaluationGroup } from "../digital-engine.js";
import { ClockManager } from "../clock.js";
import type { CircuitElement, SerializedElement } from "@/core/element";
import type { ExecuteFunction, ComponentLayout } from "@/core/registry";
import type { Pin, Rotation } from "@/core/pin";
import type { RenderContext, Rect } from "@/core/renderer-interface";
import type { PropertyBag, PropertyValue } from "@/core/properties";
import type { Wire } from "@/core/circuit";

// ---------------------------------------------------------------------------
// Minimal CircuitElement stub
// ---------------------------------------------------------------------------

class StubElement implements CircuitElement {
  readonly typeId: string;
  readonly instanceId: string;
  position: { x: number; y: number } = { x: 0, y: 0 };
  rotation: Rotation = 0;
  mirror: boolean = false;
  private readonly _attrs: Record<string, PropertyValue>;

  constructor(typeId: string, instanceId: string, attrs: Record<string, PropertyValue> = {}) {
    this.typeId = typeId;
    this.instanceId = instanceId;
    this._attrs = attrs;
  }

  getAttribute(key: string): PropertyValue | undefined {
    return this._attrs[key];
  }

  getProperties(): PropertyBag {
    throw new Error("not used in stub");
  }

  getPins(): readonly Pin[] { return []; }
  getBoundingBox(): Rect { return { x: 0, y: 0, width: 1, height: 1 }; }
  draw(_ctx: RenderContext): void {}

  serialize(): SerializedElement {
    return {
      typeId: this.typeId,
      instanceId: this.instanceId,
      position: this.position,
      rotation: this.rotation,
      mirror: this.mirror,
      properties: {},
    };
  }
  setAttribute(_key: string, _value: PropertyValue): void {}
}

// ---------------------------------------------------------------------------
// Layout helper
// ---------------------------------------------------------------------------

class StaticLayout implements ComponentLayout {
  readonly wiringTable: Int32Array;
  private readonly _inputOffsets: number[];
  private readonly _outputOffsets: number[];
  private readonly _inputCounts: number[];
  private readonly _outputCounts: number[];
  private readonly _stateOffsets: number[];

  constructor(
    inputNets: number[][],
    outputNets: number[][],
    stateOffsets?: number[],
  ) {
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
    this._stateOffsets = stateOffsets ?? inputNets.map(() => 0);
  }

  inputCount(idx: number): number { return this._inputCounts[idx] ?? 0; }
  inputOffset(idx: number): number { return this._inputOffsets[idx] ?? 0; }
  outputCount(idx: number): number { return this._outputCounts[idx] ?? 0; }
  outputOffset(idx: number): number { return this._outputOffsets[idx] ?? 0; }
  stateOffset(idx: number): number { return this._stateOffsets[idx] ?? 0; }
  getProperty(): undefined { return undefined; }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setNet(engine: DigitalEngine, netId: number, value: number): void {
  (engine as unknown as { _values: Uint32Array })["_values"][netId] = value >>> 0;
  (engine as unknown as { _highZs: Uint32Array })["_highZs"][netId] = 0;
}

/**
 * D flip-flop sampleFn: on rising clock edge (prevClock=0, clock=1),
 * latch D input to storedQ state slot.
 */
function sampleDFF(
  index: number,
  state: Uint32Array,
  _highZs: Uint32Array,
  layout: ComponentLayout,
): void {
  const wt = layout.wiringTable;
  const inOff = layout.inputOffset(index);
  const stBase = layout.stateOffset(index);
  const clockVal = state[wt[inOff]!]!;
  const dVal = state[wt[inOff + 1]!]!;
  const prevClock = state[stBase + 1]!;
  if (prevClock === 0 && clockVal === 1) {
    state[stBase] = dVal;
  }
  state[stBase + 1] = clockVal;
}

/**
 * D flip-flop executeFn: reads storedQ from state slot, writes to Q output.
 */
function executeDFF(
  index: number,
  state: Uint32Array,
  _highZs: Uint32Array,
  layout: ComponentLayout,
): void {
  const wt = layout.wiringTable;
  const outOff = layout.outputOffset(index);
  const stBase = layout.stateOffset(index);
  state[wt[outOff]!] = state[stBase]!;
}

/**
 * No-op executeFn for Clock components (clock toggling is external).
 */
function executeClock(
  _index: number,
  _state: Uint32Array,
  _highZs: Uint32Array,
  _layout: ComponentLayout,
): void {}

/**
 * Build a circuit with clock(s) driving D flip-flop(s).
 *
 * Layout:
 *   Clock0 -> net0 (clock output)
 *   DFF0: inputs [net0 (clock), net1 (D)], outputs [net2 (Q)], state at stateBase
 */
function buildClockDFFCircuit(
  clockFrequencies: number[],
): {
  circuit: ConcreteCompiledCircuit;
  clockNetIds: number[];
  dffQNetIds: number[];
  dffDNetIds: number[];
} {
  const numClocks = clockFrequencies.length;
  const numDFFs = numClocks;
  const componentCount = numClocks + numDFFs;

  // Net layout: for each clock/DFF pair:
  //   clockNet[i], dNet[i], qNet[i]
  const netCount = numClocks * 3;
  const stateBase = netCount;
  const totalStateSlots = numDFFs * 2;
  const signalArraySize = netCount + totalStateSlots;

  const clockNetIds: number[] = [];
  const dffDNetIds: number[] = [];
  const dffQNetIds: number[] = [];

  const inputNets: number[][] = [];
  const outputNets: number[][] = [];
  const stateOffsets: number[] = [];

  const componentToElement = new Map<number, CircuitElement>();

  // Clock components: indices 0..numClocks-1
  for (let i = 0; i < numClocks; i++) {
    const clockNet = i * 3;
    clockNetIds.push(clockNet);
    dffDNetIds.push(clockNet + 1);
    dffQNetIds.push(clockNet + 2);

    inputNets.push([]);
    outputNets.push([clockNet]);
    stateOffsets.push(0);

    componentToElement.set(i, new StubElement("Clock", `clock-${i}`, { Frequency: clockFrequencies[i]! }));
  }

  // DFF components: indices numClocks..componentCount-1
  for (let i = 0; i < numDFFs; i++) {
    const clockNet = i * 3;
    const dNet = clockNet + 1;
    const qNet = clockNet + 2;

    inputNets.push([clockNet, dNet]);
    outputNets.push([qNet]);
    stateOffsets.push(stateBase + i * 2);

    componentToElement.set(numClocks + i, new StubElement("DFF", `dff-${i}`));
  }

  const layout = new StaticLayout(inputNets, outputNets, stateOffsets);

  // Type IDs: 0 = Clock executeFn, 1 = DFF executeFn
  const typeIds = new Uint16Array(componentCount);
  for (let i = 0; i < numClocks; i++) typeIds[i] = 0;
  for (let i = 0; i < numDFFs; i++) typeIds[numClocks + i] = 1;

  const executeFns: ExecuteFunction[] = [executeClock, executeDFF];
  const sampleFns: (ExecuteFunction | null)[] = [null, sampleDFF];

  const dffIndices = Array.from({ length: numDFFs }, (_, i) => numClocks + i);

  const group: EvaluationGroup = {
    componentIndices: new Uint32Array(Array.from({ length: componentCount }, (_, i) => i)),
    isFeedback: false,
  };

  const circuit: ConcreteCompiledCircuit = {
    netCount,
    componentCount,
    totalStateSlots,
    signalArraySize,
    typeIds,
    executeFns,
    sampleFns,
    wiringTable: layout.wiringTable,
    layout,
    evaluationOrder: [group],
    sequentialComponents: new Uint32Array(dffIndices),
    netWidths: new Uint8Array(netCount).fill(1),
    sccSnapshotBuffer: new Uint32Array(netCount),
    delays: new Uint32Array(componentCount).fill(10),
    componentToElement,
    wireToNetId: new Map<Wire, number>(),
    pinNetMap: new Map(),
    resetComponentIndices: new Uint32Array(0),
    busResolver: null,
    switchComponentIndices: new Uint32Array(0),
    switchClassification: new Uint8Array(0),
    shadowNetCount: 0,
  };

  return { circuit, clockNetIds, dffQNetIds, dffDNetIds };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ClockExternal", () => {
  it("clock_advances_before_step", () => {
    const { circuit, clockNetIds, dffQNetIds, dffDNetIds } = buildClockDFFCircuit([1]);
    const engine = new DigitalEngine("level");
    engine.init(circuit);
    const clockMgr = new ClockManager(circuit);
    const state = engine.getSignalArray();

    // Set D input high
    setNet(engine, dffDNetIds[0]!, 1);

    // First advance+step: clock goes low→high (rising edge), DFF latches D=1
    clockMgr.advanceClocks(state);
    expect(state[clockNetIds[0]!]).toBe(1);
    engine.step();
    expect(engine.getSignalRaw(dffQNetIds[0]!)).toBe(1);

    // Second advance+step: clock goes high→low (falling edge), DFF holds
    setNet(engine, dffDNetIds[0]!, 0);
    clockMgr.advanceClocks(state);
    expect(state[clockNetIds[0]!]).toBe(0);
    engine.step();
    expect(engine.getSignalRaw(dffQNetIds[0]!)).toBe(1);

    // Third advance+step: clock goes low→high (rising edge), DFF latches D=0
    clockMgr.advanceClocks(state);
    expect(state[clockNetIds[0]!]).toBe(1);
    engine.step();
    expect(engine.getSignalRaw(dffQNetIds[0]!)).toBe(0);
  });

  it("step_without_clock_advance_does_not_toggle", () => {
    const { circuit, clockNetIds, dffQNetIds, dffDNetIds } = buildClockDFFCircuit([1]);
    const engine = new DigitalEngine("level");
    engine.init(circuit);
    const state = engine.getSignalArray();

    // Set D=1, clock=0
    setNet(engine, dffDNetIds[0]!, 1);
    setNet(engine, clockNetIds[0]!, 0);

    // Step WITHOUT advancing clocks -- clock stays at 0
    engine.step();
    expect(state[clockNetIds[0]!]).toBe(0);
    expect(engine.getSignalRaw(dffQNetIds[0]!)).toBe(0);

    // Step again -- still no clock edge
    engine.step();
    expect(state[clockNetIds[0]!]).toBe(0);
    expect(engine.getSignalRaw(dffQNetIds[0]!)).toBe(0);
  });

  it("multi_frequency_clocks", () => {
    // Two clocks: freq=1 (toggle every step) and freq=2 (toggle every 2 steps)
    const { circuit, clockNetIds } = buildClockDFFCircuit([1, 2]);
    const engine = new DigitalEngine("level");
    engine.init(circuit);
    const clockMgr = new ClockManager(circuit);
    const state = engine.getSignalArray();

    const fastToggles: number[] = [];
    const slowToggles: number[] = [];

    let prevFast = state[clockNetIds[0]!]!;
    let prevSlow = state[clockNetIds[1]!]!;

    for (let i = 0; i < 4; i++) {
      clockMgr.advanceClocks(state);
      engine.step();

      const curFast = state[clockNetIds[0]!]!;
      const curSlow = state[clockNetIds[1]!]!;
      if (curFast !== prevFast) fastToggles.push(i);
      if (curSlow !== prevSlow) slowToggles.push(i);
      prevFast = curFast;
      prevSlow = curSlow;
    }

    // Fast clock (freq=1) toggles every step: 4 toggles in 4 steps
    expect(fastToggles.length).toBe(4);

    // Slow clock (freq=2) toggles every 2 steps: 2 toggles in 4 steps
    expect(slowToggles.length).toBe(2);
  });
});
