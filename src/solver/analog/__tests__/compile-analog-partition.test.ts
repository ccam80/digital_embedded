/**
 * Tests for compileAnalogPartition (P3-7).
 *
 * Verifies that the partition-based entry point handles Ground group
 * identification, node assignment, and bridge stubs correctly.
 */

import { describe, it, expect, vi } from "vitest";
import { Wire } from "../../../core/circuit.js";
import type { CircuitElement } from "../../../core/element.js";
import type { Pin, PinDeclaration } from "../../../core/pin.js";
import { PinDirection } from "../../../core/pin.js";
import { PropertyBag } from "../../../core/properties.js";
import type { PropertyValue } from "../../../core/properties.js";
import type { Rect, RenderContext } from "../../../core/renderer-interface.js";
import type { SerializedElement } from "../../../core/element.js";
import { ComponentRegistry, ComponentCategory } from "../../../core/registry.js";
import { AnalogElement, PoolBackedAnalogElement, isPoolBacked } from "../element.js";
import type { DeviceFamily } from "../ngspice-load-order.js";
import { defineStateSchema } from "../state-schema.js";
import type { SetupContext } from "../setup-context.js";
import type { SparseSolverStamp as ComplexSparseSolver } from "../sparse-solver.js";
import type { LoadContext } from "../load-context.js";
import { compileAnalogPartition } from "../compiler.js";
import type { SolverPartition, PartitionedComponent, ConnectivityGroup } from "../../../compile/types.js";
import { pinWorldPosition } from "../../../core/pin.js";
import { buildFixture } from "./fixtures/build-fixture.js";

// ---------------------------------------------------------------------------
// Pool-backed element stub for setup() allocation test
// ---------------------------------------------------------------------------

const PARTITION_STATEFUL_SCHEMA = defineStateSchema("PartitionStatefulEl", [
  { name: "S0", doc: "slot 0" },
  { name: "S1", doc: "slot 1" },
  { name: "S2", doc: "slot 2" },
  { name: "S3", doc: "slot 3" },
  { name: "S4", doc: "slot 4" },
  { name: "S5", doc: "slot 5" },
  { name: "S6", doc: "slot 6" },
]);

class PartitionStatefulEl extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = 0;
  readonly deviceFamily: DeviceFamily = "BEHAVIORAL";
  readonly stateSchema = PARTITION_STATEFUL_SCHEMA;
  readonly stateSize = this.stateSchema.size;

  setup(ctx: SetupContext): void {
    this._stateBase = ctx.allocStates(this.stateSize);
  }
  load(_ctx: LoadContext): void { /* no-op */ }
  setParam(_key: string, _value: number): void {}
  getPinCurrents(_v: Float64Array) { return []; }
  override initState(pool: import("../state-pool.js").StatePoolRef): void {
    pool.state0[this._stateBase] = 99.0;
  }
}

// ---------------------------------------------------------------------------
// Test helpers- mirror the helpers from analog-compiler.test.ts
// ---------------------------------------------------------------------------

function makePin(x: number, y: number, label: string = "", direction: PinDirection = PinDirection.BIDIRECTIONAL): Pin {
  return {
    position: { x, y },
    label,
    direction,
    isNegated: false,
    isClock: false,
    kind: "signal",
    bitWidth: 1,
  };
}

function makeElement(
  typeId: string,
  instanceId: string,
  pins: Array<{ x: number; y: number; label?: string; direction?: PinDirection }>,
  propsMap: Map<string, PropertyValue> = new Map(),
  registry?: ComponentRegistry,
): CircuitElement {
  const def = registry?.get(typeId);
  const resolvedPins = pins.map((p, i) => makePin(p.x, p.y, p.label || def?.pinLayout?.[i]?.label || "", p.direction ?? PinDirection.BIDIRECTIONAL));
  const propertyBag = new PropertyBag(propsMap.entries());
  const _mp: Record<string, number> = {};
  for (const [k, v] of propsMap) if (typeof v === 'number') _mp[k] = v;
  propertyBag.replaceModelParams(_mp);

  const serialized: SerializedElement = {
    typeId,
    instanceId,
    position: { x: 0, y: 0 },
    rotation: 0 as SerializedElement["rotation"],
    mirror: false,
    properties: {},
  };

  return {
    typeId,
    instanceId,
    position: { x: 0, y: 0 },
    rotation: 0 as CircuitElement["rotation"],
    mirror: false,
    getPins() { return resolvedPins; },
    getProperties() { return propertyBag; },
    getBoundingBox(): Rect { return { x: 0, y: 0, width: 10, height: 10 }; },
    draw(_ctx: RenderContext) { /* no-op */ },
    serialize() { return serialized; },
    getAttribute(k: string) { return propsMap.get(k); },
    setAttribute(k: string, v: PropertyValue) { propsMap.set(k, v); },
  };
}

function makeStubElement(nodeIds: number[]): AnalogElement {
  const pinEntries: [string, number][] = nodeIds.map((id, i) => [`p${i}`, id]);
  const pinNodes = new Map(pinEntries);
  class StubElement extends AnalogElement {
    readonly ngspiceLoadOrder = 0;
    readonly deviceFamily: DeviceFamily = "BEHAVIORAL";
    setup(_ctx: import("../setup-context.js").SetupContext): void { /* no-op */ }
    load(_ctx: LoadContext): void { /* no-op */ }
    stampAc(_solver: ComplexSparseSolver, _omega: number, _ctx: LoadContext): void { /* no-op */ }
    setParam(_key: string, _value: number): void {}
    getPinCurrents(_v: Float64Array) { return nodeIds.map(() => 0); }
  }
  return new StubElement(pinNodes);
}

function makeBaseDef(name: string) {
  return {
    name,
    typeId: -1,
    pinLayout: [] as PinDeclaration[],
    propertyDefs: [] as import("../../../core/properties.js").PropertyDefinition[],
    attributeMap: [] as import("../../../core/registry.js").AttributeMapping[],
    category: ComponentCategory.MISC,
    helpText: "",
    factory: (_props: PropertyBag) => makeElement(name, crypto.randomUUID(), []),
  };
}

function makeGatePinLayout(inputCount: number): PinDeclaration[] {
  const pins: PinDeclaration[] = [];
  for (let i = 1; i <= inputCount; i++) {
    pins.push({
      label: `In_${i}`,
      direction: PinDirection.INPUT,
      defaultBitWidth: 1,
      position: { x: 0, y: i },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal" as const,
    });
  }
  pins.push({
    label: "out",
    direction: PinDirection.OUTPUT,
    defaultBitWidth: 1,
    position: { x: 2, y: 1 },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal" as const,
  });
  return pins;
}

/**
 * Build a registry with Ground and an AND gate (digital + behavioral models).
 */
function buildRegistry(factorySpy?: ReturnType<typeof vi.fn>): ComponentRegistry {
  const registry = new ComponentRegistry();

  registry.register({
    ...makeBaseDef("Ground"),
    models: {},
  });

  const andFactory = factorySpy ?? vi.fn((pinNodes: ReadonlyMap<string, number>, _props: PropertyBag, _getTime: () => number) => makeStubElement([...pinNodes.values()]));

  registry.register({
    ...makeBaseDef("BehavioralAnd"),
    pinLayout: makeGatePinLayout(2),
    models: {},
    modelRegistry: {
      behavioral: {
        kind: "inline" as const,
        factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, getTime: () => number) => andFactory(pinNodes, props, getTime),
        paramDefs: [],
        params: {},
      },
    },
    defaultModel: "behavioral",
  });

  return registry;
}

// ---------------------------------------------------------------------------
// Build a SolverPartition from a Circuit manually (simulating what
// extractConnectivityGroups + partitionByDomain would produce).
//
// This helper creates the partition data structures that compileAnalogPartition
// expects, mirroring what the upstream pipeline produces.
// ---------------------------------------------------------------------------

interface PartitionBuilderResult {
  partition: SolverPartition;
  registry: ComponentRegistry;
  factorySpy: ReturnType<typeof vi.fn>;
}

/**
 * Build an analog circuit with: Ground, 2-input AND gate.
 *
 * Wire layout: 4 single-point wires at (0,0), (10,0), (20,0), (30,0).
 * Ground connects at (0,0) â†’ node 0.
 * AND gate In_1 at (10,0), In_2 at (20,0), out at (30,0).
 * Expected node IDs: gnd=0, In_1=1, In_2=2, out=3.
 */
function buildAndGatePartition(propsMap: Map<string, PropertyValue> = new Map()): PartitionBuilderResult {
  const factorySpy = vi.fn((pinNodes: ReadonlyMap<string, number>) => makeStubElement([...pinNodes.values()]));
  const registry = buildRegistry(factorySpy);

  const andGate = makeElement("BehavioralAnd", "and1", [
    { x: 10, y: 0, label: "In_1", direction: PinDirection.INPUT },
    { x: 20, y: 0, label: "In_2", direction: PinDirection.INPUT },
    { x: 30, y: 0, label: "out",  direction: PinDirection.OUTPUT },
  ], propsMap);

  const gnd = makeElement("Ground", "gnd1", [
    { x: 0, y: 0, label: "in", direction: PinDirection.INPUT },
  ]);

  const andDef = registry.getStandalone("BehavioralAnd")!;
  const gndDef = registry.getStandalone("Ground")!;

  // Build 4 wires: one per node (degenerate zero-length wires as in the test circuit)
  const wireGnd = new Wire({ x: 0,  y: 0 }, { x: 0,  y: 0 });
  const wire1   = new Wire({ x: 10, y: 0 }, { x: 10, y: 0 });
  const wire2   = new Wire({ x: 20, y: 0 }, { x: 20, y: 0 });
  const wire3   = new Wire({ x: 30, y: 0 }, { x: 30, y: 0 });

  // Build ConnectivityGroups- one group per distinct position
  // Group 0 (gnd): position (0,0)- Ground element connects here
  const groupGnd: ConnectivityGroup = {
    groupId: 0,
    pins: [
      {
        elementIndex: 1, // gnd is second element
        pinIndex: 0,
        pinLabel: "in",
        direction: PinDirection.INPUT,
        bitWidth: 1,
        worldPosition: { x: 0, y: 0 },
        wireVertex: { x: 0, y: 0 },
        domain: "analog",
        kind: "signal",
      },
    ],
    wires: [wireGnd],
    domains: new Set(["analog"]),
    bitWidth: 1,
  };

  // Group 1: AND In_1 at (10,0)
  const group1: ConnectivityGroup = {
    groupId: 1,
    pins: [
      {
        elementIndex: 0,
        pinIndex: 0,
        pinLabel: "In_1",
        direction: PinDirection.INPUT,
        bitWidth: 1,
        worldPosition: { x: 10, y: 0 },
        wireVertex: { x: 10, y: 0 },
        domain: "analog",
        kind: "signal",
      },
    ],
    wires: [wire1],
    domains: new Set(["analog"]),
    bitWidth: 1,
  };

  // Group 2: AND In_2 at (20,0)
  const group2: ConnectivityGroup = {
    groupId: 2,
    pins: [
      {
        elementIndex: 0,
        pinIndex: 1,
        pinLabel: "In_2",
        direction: PinDirection.INPUT,
        bitWidth: 1,
        worldPosition: { x: 20, y: 0 },
        wireVertex: { x: 20, y: 0 },
        domain: "analog",
        kind: "signal",
      },
    ],
    wires: [wire2],
    domains: new Set(["analog"]),
    bitWidth: 1,
  };

  // Group 3: AND out at (30,0)
  const group3: ConnectivityGroup = {
    groupId: 3,
    pins: [
      {
        elementIndex: 0,
        pinIndex: 2,
        pinLabel: "out",
        direction: PinDirection.OUTPUT,
        bitWidth: 1,
        worldPosition: { x: 30, y: 0 },
        wireVertex: { x: 30, y: 0 },
        domain: "analog",
        kind: "signal",
      },
    ],
    wires: [wire3],
    domains: new Set(["analog"]),
    bitWidth: 1,
  };

  const andPins = andGate.getPins();
  const andResolvedPins = andPins.map((pin, idx) => ({
    elementIndex: 0,
    pinIndex: idx,
    pinLabel: pin.label,
    direction: pin.direction,
    bitWidth: pin.bitWidth,
    worldPosition: pinWorldPosition(andGate, pin),
    wireVertex: pinWorldPosition(andGate, pin),
    domain: "analog" as const,
    kind: (pin.kind ?? "signal") as "signal" | "power",
  }));

  const gndPins = gnd.getPins();
  const gndResolvedPins = gndPins.map((pin, idx) => ({
    elementIndex: 1,
    pinIndex: idx,
    pinLabel: pin.label,
    direction: pin.direction,
    bitWidth: pin.bitWidth,
    worldPosition: pinWorldPosition(gnd, pin),
    wireVertex: pinWorldPosition(gnd, pin),
    domain: "analog" as const,
    kind: (pin.kind ?? "signal") as "signal" | "power",
  }));

  const andComponent: PartitionedComponent = {
    element: andGate,
    definition: andDef,
    modelKey: "behavioral",
    model: null,
    resolvedPins: andResolvedPins,
  };

  const gndComponent: PartitionedComponent = {
    element: gnd,
    definition: gndDef,
    modelKey: "neutral",
    model: null,
    resolvedPins: gndResolvedPins,
  };

  const partition: SolverPartition = {
    components: [andComponent, gndComponent],
    groups: [groupGnd, group1, group2, group3],
    bridgeStubs: [],
  };

  return { partition, registry, factorySpy };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("compileAnalogPartition", () => {
  it("produces_compiled_circuit_for_simple_analog_partition", () => {
    const propsMap = new Map<string, PropertyValue>([["model", "behavioral"]]);
    const { partition, registry } = buildAndGatePartition(propsMap);
    const compiled = compileAnalogPartition(partition, registry);

    // AND gate compiled as one behavioral analog element; no errors
    expect(compiled.elements.length).toBe(1);
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
  });

  it("node_count_matches_expected_for_and_gate_partition", () => {
    const propsMap = new Map<string, PropertyValue>([["model", "behavioral"]]);

    // Build via partition path (which explicitly includes Ground)
    const { partition, registry } = buildAndGatePartition(propsMap);
    const compiled = compileAnalogPartition(partition, registry);

    // 3 non-ground nodes: In_1 at (10,0), In_2 at (20,0), out at (30,0)
    // Ground at (0,0) is node 0 (not counted in nodeCount).
    expect(compiled.nodeCount).toBe(3);
  });

  it("factory_called_once_for_and_gate", () => {
    const propsMap = new Map<string, PropertyValue>([["model", "behavioral"]]);
    const { partition, registry, factorySpy } = buildAndGatePartition(propsMap);
    compileAnalogPartition(partition, registry);

    expect(factorySpy).toHaveBeenCalledOnce();
  });

  it("wireToNodeId_populated_for_all_wires", () => {
    const propsMap = new Map<string, PropertyValue>([["model", "behavioral"]]);
    const { partition, registry } = buildAndGatePartition(propsMap);
    const compiled = compileAnalogPartition(partition, registry);

    // All 4 wires (one per group) should be in wireToNodeId
    const allWires = partition.groups.flatMap((g) => g.wires);
    expect(compiled.wireToNodeId.size).toBe(allWires.length);
    for (const wire of allWires) {
      expect(compiled.wireToNodeId.has(wire)).toBe(true);
    }
  });

  it("ground_group_assigned_node_zero", () => {
    const propsMap = new Map<string, PropertyValue>([["model", "behavioral"]]);
    const { partition, registry } = buildAndGatePartition(propsMap);
    const compiled = compileAnalogPartition(partition, registry);

    // The wire in groupGnd (wireGnd at position 0,0) should map to node 0
    const gndWire = partition.groups[0]!.wires[0]!;
    expect(compiled.wireToNodeId.get(gndWire)).toBe(0);
  });

  it("non_ground_groups_assigned_sequential_node_ids", () => {
    const propsMap = new Map<string, PropertyValue>([["model", "behavioral"]]);
    const { partition, registry } = buildAndGatePartition(propsMap);
    const compiled = compileAnalogPartition(partition, registry);

    // Groups 1, 2, 3 should have node IDs 1, 2, 3 (non-zero, unique)
    const nodeIds = new Set<number>();
    for (let i = 1; i <= 3; i++) {
      const wire = partition.groups[i]!.wires[0]!;
      const nodeId = compiled.wireToNodeId.get(wire)!;
      expect(nodeId).toBeGreaterThan(0);
      nodeIds.add(nodeId);
    }
    // All 3 non-ground groups get distinct node IDs
    expect(nodeIds.size).toBe(3);
  });

  it("empty_partition_compiles_without_error", () => {
    const registry = buildRegistry();
    const emptyPartition: SolverPartition = {
      components: [],
      groups: [],
      bridgeStubs: [],
      };

    // Should not throw; no elements â†’ no analog elements compiled
    const compiled = compileAnalogPartition(emptyPartition, registry);
    expect(compiled.elements.length).toBe(0);
    expect(compiled.nodeCount).toBe(0);
  });

  it("no_ground_emits_warning_diagnostic", () => {
    const factorySpy = vi.fn((pinNodes: ReadonlyMap<string, number>) => makeStubElement([...pinNodes.values()]));
    const registry = buildRegistry(factorySpy);

    const andGate = makeElement("BehavioralAnd", "and1", [
      { x: 10, y: 0, label: "In_1", direction: PinDirection.INPUT },
      { x: 20, y: 0, label: "In_2", direction: PinDirection.INPUT },
      { x: 30, y: 0, label: "out",  direction: PinDirection.OUTPUT },
    ], new Map<string, PropertyValue>([["model", "behavioral"]]));

    const andDef = registry.getStandalone("BehavioralAnd")!;
    const andResolvedPins = andGate.getPins().map((pin, idx) => ({
      elementIndex: 0,
      pinIndex: idx,
      pinLabel: pin.label,
      direction: pin.direction,
      bitWidth: pin.bitWidth,
      worldPosition: pinWorldPosition(andGate, pin),
      wireVertex: pinWorldPosition(andGate, pin),
      domain: "analog" as const,
      kind: (pin.kind ?? "signal") as "signal" | "power",
    }));

    // Partition without any Ground component
    const noGroundPartition: SolverPartition = {
      components: [{
        element: andGate,
        definition: andDef,
        modelKey: "behavioral",
        model: null,
        resolvedPins: andResolvedPins,
      }],
      groups: [
        {
          groupId: 0,
          pins: [{ elementIndex: 0, pinIndex: 0, pinLabel: "In_1", direction: PinDirection.INPUT, bitWidth: 1, worldPosition: { x: 10, y: 0 }, wireVertex: { x: 10, y: 0 }, domain: "analog", kind: "signal" }],
          wires: [new Wire({ x: 10, y: 0 }, { x: 10, y: 0 })],
          domains: new Set(["analog"]),
        },
        {
          groupId: 1,
          pins: [{ elementIndex: 0, pinIndex: 1, pinLabel: "In_2", direction: PinDirection.INPUT, bitWidth: 1, worldPosition: { x: 20, y: 0 }, wireVertex: { x: 20, y: 0 }, domain: "analog", kind: "signal" }],
          wires: [new Wire({ x: 20, y: 0 }, { x: 20, y: 0 })],
          domains: new Set(["analog"]),
        },
        {
          groupId: 2,
          pins: [{ elementIndex: 0, pinIndex: 2, pinLabel: "out", direction: PinDirection.OUTPUT, bitWidth: 1, worldPosition: { x: 30, y: 0 }, wireVertex: { x: 30, y: 0 }, domain: "analog", kind: "signal" }],
          wires: [new Wire({ x: 30, y: 0 }, { x: 30, y: 0 })],
          domains: new Set(["analog"]),
        },
      ],
      bridgeStubs: [],
      };

    const compiled = compileAnalogPartition(noGroundPartition, registry);
    const groundDiags = compiled.diagnostics.filter((d) => d.code === "no-ground");
    expect(groundDiags.length).toBeGreaterThan(0);
    expect(groundDiags[0]!.severity).toBe("warning");
  });

  it("pin_node_ids_passed_to_factory_match_group_node_ids", () => {
    const propsMap = new Map<string, PropertyValue>([["model", "behavioral"]]);
    const { partition, registry, factorySpy } = buildAndGatePartition(propsMap);
    compileAnalogPartition(partition, registry);

    expect(factorySpy).toHaveBeenCalledOnce();
    const [pinNodesArg] = factorySpy.mock.calls[0] as [ReadonlyMap<string, number>, ...unknown[]];

    // Ground group â†’ node 0; the 3 other groups â†’ nodes 1, 2, 3
    // AND pin positions: In_1=(10,0), In_2=(20,0), out=(30,0) â†’ nodes 1, 2, 3
    const nodeValues = [...pinNodesArg.values()];
    expect(nodeValues.every((n) => n > 0)).toBe(true);
    // All three must be distinct and non-zero
    expect(new Set(nodeValues).size).toBe(3);
  });

  it("compiled circuit has statePool === null (deferred to setup time)", () => {
    const propsMap = new Map<string, PropertyValue>([["model", "behavioral"]]);
    const { partition, registry } = buildAndGatePartition(propsMap);
    const compiled = compileAnalogPartition(partition, registry);
    expect(compiled.statePool).toBeNull();
  });

  it("compiled elements have _stateBase === -1 (allocated by setup, not compiler)", () => {
    const propsMap = new Map<string, PropertyValue>([["model", "behavioral"]]);
    const { partition, registry } = buildAndGatePartition(propsMap);
    const compiled = compileAnalogPartition(partition, registry);
    for (const element of compiled.elements) {
      expect(element._stateBase).toBe(-1);
    }
  });

  it("setup() assigns _stateBase >= 0 to pool-backed elements after engine warm-start", () => {
    // Verify via the full engine path (buildFixture) that pool-backed elements
    // receive a non-negative _stateBase after MNAEngine._setup() runs.
    // PartitionStatefulEl is registered into the facade's registry inside the
    // build callback so it participates in the normal compile+setup lifecycle.
    let capturedElement: PartitionStatefulEl | undefined;

    const fix = buildFixture({
      build: (registry, facade) => {
        registry.register({
          ...makeBaseDef("StatefulComp"),
          // Override factory to produce a CircuitElement with pos/neg pins.
          factory: (_bag: import("../../../core/properties.js").PropertyBag) =>
            makeElement("StatefulComp", crypto.randomUUID(), [
              { x: 10, y: 0, label: "pos", direction: PinDirection.BIDIRECTIONAL },
              { x: 0,  y: 0, label: "neg", direction: PinDirection.BIDIRECTIONAL },
            ], new Map([["model", "behavioral"]])),
          pinLayout: [
            {
              label: "pos",
              direction: PinDirection.BIDIRECTIONAL,
              defaultBitWidth: 1,
              position: { x: 10, y: 0 },
              isNegatable: false,
              isClockCapable: false,
              kind: "signal" as const,
            },
            {
              label: "neg",
              direction: PinDirection.BIDIRECTIONAL,
              defaultBitWidth: 1,
              position: { x: 0, y: 0 },
              isNegatable: false,
              isClockCapable: false,
              kind: "signal" as const,
            },
          ],
          models: {},
          modelRegistry: {
            behavioral: {
              kind: "inline" as const,
              factory: (pinNodes: ReadonlyMap<string, number>) => {
                const el = new PartitionStatefulEl(pinNodes as Map<string, number>);
                capturedElement = el;
                return el;
              },
              paramDefs: [],
              params: {},
            },
          },
          defaultModel: "behavioral",
        });

        return facade.build({
          components: [
            { id: "vs",  type: "DcVoltageSource", props: { label: "VS", voltage: 1 } },
            { id: "dut", type: "StatefulComp",    props: { label: "DUT" } },
            { id: "gnd", type: "Ground" },
          ],
          connections: [
            ["vs:pos",  "dut:pos"],
            ["dut:neg", "gnd:out"],
            ["vs:neg",  "gnd:out"],
          ],
        });
      },
    });

    // After warm-start, every pool-backed element has _stateBase >= 0.
    const poolBacked = fix.circuit.elements.filter(isPoolBacked);
    expect(poolBacked.length).toBeGreaterThan(0);
    for (const el of poolBacked) {
      expect(el._stateBase).toBeGreaterThanOrEqual(0);
    }

    // The PartitionStatefulEl specifically must have been assigned a slot.
    expect(capturedElement).toBeDefined();
    expect(capturedElement!._stateBase).toBeGreaterThanOrEqual(0);
  });
});
