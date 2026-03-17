/**
 * Tests for ClockManager — task 3.3.3.
 *
 * Tests build minimal ConcreteCompiledCircuit objects that include the
 * componentToElement map needed by ClockManager.findClocks(). The circuit
 * elements are minimal stubs that satisfy the CircuitElement interface just
 * enough for the clock manager to read typeId and Frequency.
 */

import { describe, it, expect } from "vitest";
import { ClockManager } from "../clock.js";
import type { ConcreteCompiledCircuit, EvaluationGroup } from "../digital-engine.js";
import type { CircuitElement, SerializedElement } from "@/core/element";
import type { ComponentLayout } from "@/core/registry";
import type { Pin } from "@/core/pin";
import type { Rotation } from "@/core/pin";
import type { RenderContext, Rect } from "@/core/renderer-interface";
import type { PropertyBag, PropertyValue } from "@/core/properties";
import type { Wire } from "@/core/circuit";

// ---------------------------------------------------------------------------
// Minimal CircuitElement stub for tests
// ---------------------------------------------------------------------------

/**
 * Minimal CircuitElement stub.
 * Exposes typeId and a map of attributes readable via getAttribute().
 */
class StubElement implements CircuitElement {
  readonly typeId: string;
  readonly instanceId: string = "stub-0";
  position: { x: number; y: number } = { x: 0, y: 0 };
  rotation: Rotation = 0;
  mirror: boolean = false;
  private readonly _attrs: Record<string, PropertyValue>;

  constructor(typeId: string, attrs: Record<string, PropertyValue> = {}) {
    this.typeId = typeId;
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
  getHelpText(): string { return ""; }

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
}

// ---------------------------------------------------------------------------
// Minimal ComponentLayout stub
// ---------------------------------------------------------------------------

/**
 * ComponentLayout where each component has an explicit output net ID.
 * Builds a wiringTable so outputOffset(i) returns an index into the table,
 * and wiringTable[outputOffset(i)] returns the actual net ID.
 */
class StubLayout implements ComponentLayout {
  readonly wiringTable: Int32Array;
  private readonly _outputOffsets: number[];

  constructor(outputNetIds: number[]) {
    this._outputOffsets = outputNetIds.map((_, i) => i);
    this.wiringTable = Int32Array.from(outputNetIds);
  }

  inputCount(_i: number): number { return 0; }
  inputOffset(_i: number): number { return 0; }
  outputCount(_i: number): number { return 1; }
  outputOffset(i: number): number { return this._outputOffsets[i] ?? 0; }
  stateOffset(_i: number): number { return 0; }
  getProperty(): undefined { return undefined; }
}

// ---------------------------------------------------------------------------
// Helper: build a minimal ConcreteCompiledCircuit with Clock components
// ---------------------------------------------------------------------------

/**
 * Build a ConcreteCompiledCircuit with the given clock components.
 *
 * clocks: array of { componentIndex, netId, frequency }
 * netCount: total number of nets in the circuit
 * sequentialComponents: indices of sequential elements (default empty)
 */
function buildClockCircuit(
  clocks: Array<{ componentIndex: number; netId: number; frequency: number }>,
  netCount: number,
  sequentialComponents: number[] = [],
): ConcreteCompiledCircuit {
  const componentCount = clocks.length === 0
    ? 0
    : Math.max(...clocks.map((c) => c.componentIndex)) + 1;

  const componentToElement = new Map<number, CircuitElement>();
  for (const c of clocks) {
    componentToElement.set(
      c.componentIndex,
      new StubElement("Clock", { Frequency: c.frequency }),
    );
  }

  const outputOffsets: number[] = new Array(componentCount).fill(0);
  for (const c of clocks) {
    outputOffsets[c.componentIndex] = c.netId;
  }

  const layout = new StubLayout(outputOffsets);

  const group: EvaluationGroup = {
    componentIndices: new Uint32Array(clocks.map((c) => c.componentIndex)),
    isFeedback: false,
  };

  return {
    netCount,
    componentCount,
    typeIds: new Uint16Array(componentCount),
    executeFns: [],
    sampleFns: [],
    wiringTable: layout.wiringTable,
    layout,
    evaluationOrder: componentCount > 0 ? [group] : [],
    sequentialComponents: new Uint32Array(sequentialComponents),
    netWidths: new Uint8Array(netCount).fill(1),
    sccSnapshotBuffer: new Uint32Array(1),
    delays: new Uint32Array(componentCount).fill(10),
    componentToElement,
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

describe("ClockManager", () => {
  // -------------------------------------------------------------------------
  // findsClockComponents
  // -------------------------------------------------------------------------

  it("findsClockComponents — circuit with 2 Clock elements, findClocks returns 2 entries with correct frequencies", () => {
    const compiled = buildClockCircuit(
      [
        { componentIndex: 0, netId: 0, frequency: 1 },
        { componentIndex: 1, netId: 1, frequency: 4 },
      ],
      2,
    );

    const mgr = new ClockManager(compiled);
    const clocks = mgr.findClocks();

    expect(clocks).toHaveLength(2);

    const sorted = [...clocks].sort((a, b) => a.componentIndex - b.componentIndex);

    expect(sorted[0]!.componentIndex).toBe(0);
    expect(sorted[0]!.netId).toBe(0);
    expect(sorted[0]!.frequency).toBe(1);

    expect(sorted[1]!.componentIndex).toBe(1);
    expect(sorted[1]!.netId).toBe(1);
    expect(sorted[1]!.frequency).toBe(4);
  });

  it("findsClockComponents — no Clock elements returns empty list", () => {
    const compiled = buildClockCircuit([], 0);
    const mgr = new ClockManager(compiled);
    expect(mgr.findClocks()).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // togglesClockOnAdvance
  // -------------------------------------------------------------------------

  it("togglesClockOnAdvance — initial value 0, advanceClocks once → value 1, again → value 0", () => {
    const compiled = buildClockCircuit(
      [{ componentIndex: 0, netId: 0, frequency: 1 }],
      1,
    );

    const mgr = new ClockManager(compiled);
    const state = new Uint32Array(1); // starts at 0

    // First advance: 0 → 1 (rising edge)
    const edges1 = mgr.advanceClocks(state);
    expect(state[0]).toBe(1);
    expect(edges1).toHaveLength(1);
    expect(edges1[0]!.edge).toBe("rising");

    // Second advance: 1 → 0 (falling edge)
    const edges2 = mgr.advanceClocks(state);
    expect(state[0]).toBe(0);
    expect(edges2).toHaveLength(1);
    expect(edges2[0]!.edge).toBe("falling");
  });

  it("togglesClockOnAdvance — clock with frequency=2 only toggles every 2 steps", () => {
    const compiled = buildClockCircuit(
      [{ componentIndex: 0, netId: 0, frequency: 2 }],
      1,
    );

    const mgr = new ClockManager(compiled);
    const state = new Uint32Array(1);

    // Step 1: counter reaches 1, not yet at half-period (2)
    const edges1 = mgr.advanceClocks(state);
    expect(state[0]).toBe(0);
    expect(edges1).toHaveLength(0);

    // Step 2: counter reaches 2 >= frequency=2, toggle fires
    const edges2 = mgr.advanceClocks(state);
    expect(state[0]).toBe(1);
    expect(edges2).toHaveLength(1);

    // Step 3: counter=1, no toggle
    const edges3 = mgr.advanceClocks(state);
    expect(state[0]).toBe(1);
    expect(edges3).toHaveLength(0);

    // Step 4: toggle again
    const edges4 = mgr.advanceClocks(state);
    expect(state[0]).toBe(0);
    expect(edges4).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // identifiesEdgeType
  // -------------------------------------------------------------------------

  it("identifiesEdgeType — verify rising edge detected on 0→1 transition", () => {
    const compiled = buildClockCircuit(
      [{ componentIndex: 0, netId: 0, frequency: 1 }],
      1,
    );

    const mgr = new ClockManager(compiled);
    const state = new Uint32Array(1);

    // Start at phase=false (0). First toggle: 0 → 1 = rising
    const edges = mgr.advanceClocks(state);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.edge).toBe("rising");
    expect(state[0]).toBe(1);
  });

  it("identifiesEdgeType — verify falling edge detected on 1→0 transition", () => {
    const compiled = buildClockCircuit(
      [{ componentIndex: 0, netId: 0, frequency: 1 }],
      1,
    );

    const mgr = new ClockManager(compiled);
    const state = new Uint32Array(1);

    // First toggle: rising
    mgr.advanceClocks(state);
    expect(state[0]).toBe(1);

    // Second toggle: falling
    const edges = mgr.advanceClocks(state);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.edge).toBe("falling");
    expect(state[0]).toBe(0);
  });

  // -------------------------------------------------------------------------
  // multiClockIndependent
  // -------------------------------------------------------------------------

  it("multiClockIndependent — 2 clocks at different frequencies, verify they toggle at their own rate", () => {
    // Clock A: frequency=1 (toggles every step), net ID 0
    // Clock B: frequency=3 (toggles every 3 steps), net ID 1
    const compiled = buildClockCircuit(
      [
        { componentIndex: 0, netId: 0, frequency: 1 },
        { componentIndex: 1, netId: 1, frequency: 3 },
      ],
      2,
    );

    const mgr = new ClockManager(compiled);
    const state = new Uint32Array(2);

    // Step 1: A toggles (0→1), B counter=1 (no toggle)
    mgr.advanceClocks(state);
    expect(state[0]).toBe(1);
    expect(state[1]).toBe(0);

    // Step 2: A toggles (1→0), B counter=2 (no toggle)
    mgr.advanceClocks(state);
    expect(state[0]).toBe(0);
    expect(state[1]).toBe(0);

    // Step 3: A toggles (0→1), B counter=3 >= 3, B toggles (0→1)
    mgr.advanceClocks(state);
    expect(state[0]).toBe(1);
    expect(state[1]).toBe(1);

    // Step 4: A toggles (1→0), B counter=1 (no toggle)
    mgr.advanceClocks(state);
    expect(state[0]).toBe(0);
    expect(state[1]).toBe(1);

    // Step 5: A toggles (0→1), B counter=2 (no toggle)
    mgr.advanceClocks(state);
    expect(state[0]).toBe(1);
    expect(state[1]).toBe(1);

    // Step 6: A toggles (1→0), B counter=3 >= 3, B toggles (1→0)
    mgr.advanceClocks(state);
    expect(state[0]).toBe(0);
    expect(state[1]).toBe(0);
  });

  // -------------------------------------------------------------------------
  // getSequentialComponentsForEdge
  // -------------------------------------------------------------------------

  it("getSequentialComponentsForEdge — rising edge returns sequential components", () => {
    const compiled = buildClockCircuit(
      [{ componentIndex: 0, netId: 0, frequency: 1 }],
      2,
      [2, 3],
    );

    const mgr = new ClockManager(compiled);
    const seqOnRising = mgr.getSequentialComponentsForEdge("rising");
    expect(seqOnRising).toEqual([2, 3]);
  });

  it("getSequentialComponentsForEdge — falling edge returns empty list", () => {
    const compiled = buildClockCircuit(
      [{ componentIndex: 0, netId: 0, frequency: 1 }],
      2,
      [2, 3],
    );

    const mgr = new ClockManager(compiled);
    const seqOnFalling = mgr.getSequentialComponentsForEdge("falling");
    expect(seqOnFalling).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // FiredEdge includes correct clockInfo
  // -------------------------------------------------------------------------

  it("advanceClocks — fired edge includes correct clockInfo reference", () => {
    const compiled = buildClockCircuit(
      [{ componentIndex: 0, netId: 5, frequency: 1 }],
      6,
    );

    const mgr = new ClockManager(compiled);
    const clocks = mgr.findClocks();
    const state = new Uint32Array(6);

    const edges = mgr.advanceClocks(state);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.clockInfo).toBe(clocks[0]);
    expect(edges[0]!.clockInfo.netId).toBe(5);
  });

  // -------------------------------------------------------------------------
  // Opaque CompiledCircuit (no componentToElement) returns empty clock list
  // -------------------------------------------------------------------------

  it("findClocks — opaque CompiledCircuit without componentToElement returns empty list", () => {
    const opaque = { netCount: 2, componentCount: 1 };
    const mgr = new ClockManager(opaque as unknown as ConcreteCompiledCircuit);
    expect(mgr.findClocks()).toHaveLength(0);
  });
});
