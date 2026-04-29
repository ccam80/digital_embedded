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
import { ComponentRegistry } from "../../../core/registry.js";
import type { ComponentCategory } from "../../../core/registry.js";
import type { AnalogElement } from "../element.js";
import type { ComplexSparseSolver } from "../complex-sparse-solver.js";
import type { LoadContext } from "../load-context.js";
import { compileAnalogPartition } from "../compiler.js";
import type { SolverPartition, PartitionedComponent, ConnectivityGroup } from "../../../compile/types.js";
import { pinWorldPosition } from "../../../core/pin.js";
import { StatePool } from "../state-pool.js";
import { SparseSolver } from "../sparse-solver.js";
import { makeTestSetupContext, setupAll } from "./test-helpers.js";

// ---------------------------------------------------------------------------
// Test helpers — mirror the helpers from analog-compiler.test.ts
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
  const resolvedPins = pins.map((p, i) => makePin(p.x, p.y, p.label || def?.pinLayout[i]?.label || "", p.direction ?? PinDirection.BIDIRECTIONAL));
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
  return {
    label: "",
    _pinNodes: new Map(pinEntries),
    _stateBase: -1,
    branchIndex: -1,
    ngspiceLoadOrder: 0,
    setup(_ctx): void { /* no-op */ },
    load(_ctx: LoadContext): void { /* no-op */ },
    stampAc(_solver: ComplexSparseSolver, _omega: number, _ctx: LoadContext): void { /* no-op */ },
    setParam(_key: string, _value: number): void {},
    getPinCurrents(_v: Float64Array) { return nodeIds.map(() => 0); },
  };
}

function makeBaseDef(name: string) {
  return {
    name,
    typeId: -1,
    pinLayout: [] as PinDeclaration[],
    propertyDefs: [] as import("../../../core/properties.js").PropertyDefinition[],
    attributeMap: [] as import("../../../core/registry.js").AttributeMapping[],
    category: "MISC" as unknown as ComponentCategory,
    helpText: "",
    factory: ((_props: PropertyBag) => makeElement(name, crypto.randomUUID(), [])) as unknown as import("../../../core/registry.js").ComponentDefinition["factory"],
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

  const andFactory = factorySpy ?? vi.fn((pinNodes: ReadonlyMap<string, number>) => makeStubElement([...pinNodes.values()]));

  registry.register({
    ...makeBaseDef("BehavioralAnd"),
    pinLayout: makeGatePinLayout(2),
    models: {},
    modelRegistry: {
      behavioral: {
        kind: "inline" as const,
        factory: andFactory as unknown as import("../../../core/registry.js").AnalogFactory,
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
 * Ground connects at (0,0) → node 0.
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

  const andDef = registry.get("BehavioralAnd")!;
  const gndDef = registry.get("Ground")!;

  // Build 4 wires: one per node (degenerate zero-length wires as in the test circuit)
  const wireGnd = new Wire({ x: 0,  y: 0 }, { x: 0,  y: 0 });
  const wire1   = new Wire({ x: 10, y: 0 }, { x: 10, y: 0 });
  const wire2   = new Wire({ x: 20, y: 0 }, { x: 20, y: 0 });
  const wire3   = new Wire({ x: 30, y: 0 }, { x: 30, y: 0 });

  // Build ConnectivityGroups — one group per distinct position
  // Group 0 (gnd): position (0,0) — Ground element connects here
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

    // Should not throw; no elements → no analog elements compiled
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

    const andDef = registry.get("BehavioralAnd")!;
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

    // Ground group → node 0; the 3 other groups → nodes 1, 2, 3
    // AND pin positions: In_1=(10,0), In_2=(20,0), out=(30,0) → nodes 1, 2, 3
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

  it("setup() assigns contiguous _stateBase values via ctx.allocStates", () => {
    // Build a registry with an element that declares stateSize
    const registry = new ComponentRegistry();
    registry.register({
      ...makeBaseDef("Ground"),
      models: {},
    });

    const elementWithState = {
      poolBacked: true as const,
      stateSize: 7,
      label: "",
      _pinNodes: new Map<string, number>(),
      _stateBase: -1,
      branchIndex: -1,
      ngspiceLoadOrder: 0,
      setup(ctx: import("../setup-context.js").SetupContext): void {
        this._stateBase = ctx.allocStates(this.stateSize);
      },
      load(_ctx: LoadContext): void { /* no-op */ },
      setParam(_key: string, _value: number): void {},
      getPinCurrents(_v: Float64Array) { return []; },
      initState(pool: StatePool): void {
        pool.state0[this._stateBase] = 99.0;
      },
    };

    const factoryReturningStateElement = vi.fn((_pinNodes: ReadonlyMap<string, number>) => {
      return elementWithState;
    });

    registry.register({
      ...makeBaseDef("StatefulComp"),
      pinLayout: [
        {
          label: "A",
          direction: PinDirection.BIDIRECTIONAL,
          defaultBitWidth: 1,
          position: { x: 10, y: 0 },
          isNegatable: false,
          isClockCapable: false,
          kind: "signal" as const,
        },
      ],
      models: {},
      modelRegistry: {
        behavioral: {
          kind: "inline" as const,
          factory: factoryReturningStateElement as unknown as import("../../../core/registry.js").AnalogFactory,
          paramDefs: [],
          params: {},
        },
      },
      defaultModel: "behavioral",
    });

    const comp = makeElement("StatefulComp", "sc1", [
      { x: 10, y: 0, label: "A", direction: PinDirection.BIDIRECTIONAL },
    ], new Map([["model", "behavioral"]]));
    const gnd = makeElement("Ground", "gnd1", [
      { x: 0, y: 0, label: "in", direction: PinDirection.INPUT },
    ]);

    const compDef = registry.get("StatefulComp")!;
    const gndDef = registry.get("Ground")!;

    const wireGnd = new Wire({ x: 0, y: 0 }, { x: 0, y: 0 });
    const wireA = new Wire({ x: 10, y: 0 }, { x: 10, y: 0 });

    const groupGnd: ConnectivityGroup = {
      groupId: 0,
      pins: [{ elementIndex: 1, pinIndex: 0, pinLabel: "in", direction: PinDirection.INPUT, bitWidth: 1, worldPosition: { x: 0, y: 0 }, wireVertex: { x: 0, y: 0 }, domain: "analog", kind: "signal" }],
      wires: [wireGnd],
      domains: new Set(["analog"]),
      bitWidth: 1,
    };
    const groupA: ConnectivityGroup = {
      groupId: 1,
      pins: [{ elementIndex: 0, pinIndex: 0, pinLabel: "A", direction: PinDirection.BIDIRECTIONAL, bitWidth: 1, worldPosition: { x: 10, y: 0 }, wireVertex: { x: 10, y: 0 }, domain: "analog", kind: "signal" }],
      wires: [wireA],
      domains: new Set(["analog"]),
      bitWidth: 1,
    };

    const partition: SolverPartition = {
      components: [
        {
          element: comp,
          definition: compDef,
          modelKey: "behavioral",
          model: null,
          resolvedPins: [{ elementIndex: 0, pinIndex: 0, pinLabel: "A", direction: PinDirection.BIDIRECTIONAL, worldPosition: { x: 10, y: 0 }, wireVertex: { x: 10, y: 0 }, domain: "analog", kind: "signal", bitWidth: 1 }],
        },
        {
          element: gnd,
          definition: gndDef,
          modelKey: "",
          model: null,
          resolvedPins: [{ elementIndex: 1, pinIndex: 0, pinLabel: "in", direction: PinDirection.INPUT, worldPosition: { x: 0, y: 0 }, wireVertex: { x: 0, y: 0 }, domain: "analog", kind: "signal", bitWidth: 1 }],
        },
      ],
      groups: [groupGnd, groupA],
      bridgeStubs: [],
    };

    const compiled = compileAnalogPartition(partition, registry);

    // Pool deferred to setup; compiler does not assign _stateBase or
    // allocate a pool. Run the engine boot path via setupAll + initState
    // to verify the stateful element gets its slot.
    const solver = new SparseSolver();
    solver._initStructure();
    const setupCtx = makeTestSetupContext({
      solver,
      startBranch: 1,
      startNode: 100,
      elements: compiled.elements,
    });
    setupAll(compiled.elements, setupCtx);

    const stateful = compiled.elements.find(
      (e): e is typeof elementWithState => (e as any).poolBacked === true
    )!;
    expect(stateful._stateBase).toBe(0);

    const pool = new StatePool(stateful.stateSize);
    stateful.initState(pool);
    expect(pool.state0[0]).toBe(99.0);
  });
});
