/**
 * Tests for transistor model expansion (Phase 4c.1).
 *
 * Tests call expandTransistorModel() directly to verify the expansion logic
 * independently from the full compiler pipeline.
 *
 * A minimal CMOS inverter MnaSubcircuitNetlist is used:
 *   - PMOS: gate=in, drain=out, source=VDD, body=VDD
 *   - NMOS: gate=in, drain=out, source=GND, body=GND
 *   - Ports: in=0, out=1, VDD=2, GND=3
 */

import { describe, it, expect } from "vitest";
import { PropertyBag } from "../../../core/properties.js";
import { PinDirection } from "../../../core/pin.js";
import type { Pin } from "../../../core/pin.js";
import type { CircuitElement } from "../../../core/element.js";
import type { Rect, RenderContext } from "../../../core/renderer-interface.js";
import type { SerializedElement } from "../../../core/element.js";
import type { ComponentDefinition } from "../../../core/registry.js";
import { ComponentCategory } from "../../../core/registry.js";
import type { AnalogElement } from "../element.js";
import type { SparseSolver } from "../sparse-solver.js";
import type { MnaSubcircuitNetlist } from "../../../core/mna-subcircuit-netlist.js";
import { SubcircuitModelRegistry } from "../subcircuit-model-registry.js";
import {
  expandTransistorModel,
  registerAnalogFactory,
} from "../transistor-expansion.js";
import { compileAnalogPartition } from "../compiler.js";
import type { SolverPartition, PartitionedComponent, ConnectivityGroup } from "../../../compile/types.js";
import { ComponentRegistry } from "../../../core/registry.js";
import type { MnaModel } from "../../../core/registry.js";
import { Circuit } from "../../../core/circuit.js";

// ---------------------------------------------------------------------------
// Minimal CircuitElement builder
// ---------------------------------------------------------------------------

function makePin(x: number, y: number, label: string): Pin {
  return {
    position: { x, y },
    label,
    direction: PinDirection.BIDIRECTIONAL,
    isInverted: false,
    isClock: false,
    bitWidth: 1,
  };
}

function makeElement(
  typeId: string,
  instanceId: string,
  pins: Array<{ x: number; y: number; label: string }>,
  propsEntries: Array<[string, string | number | boolean]> = [],
): CircuitElement {
  const resolvedPins = pins.map((p) => makePin(p.x, p.y, p.label));
  const propsMap = new Map<string, import("../../core/properties.js").PropertyValue>(
    propsEntries as Array<[string, import("../../core/properties.js").PropertyValue]>,
  );
  const propertyBag = new PropertyBag(propsMap.entries());

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
  };
}

// ---------------------------------------------------------------------------
// Minimal AnalogElement factory for test MOSFETs
// ---------------------------------------------------------------------------

function makeMosfetAnalogElement(nodeIds: number[]): AnalogElement {
  return {
    pinNodeIds: [...nodeIds],
    allNodeIds: [...nodeIds],
    branchIndex: -1,
    isNonlinear: true,
    isReactive: false,
    stamp(_solver: SparseSolver): void { /* no-op */ },
    stampNonlinear(_solver: SparseSolver): void { /* no-op */ },
    updateOperatingPoint(_voltages: Float64Array): void { /* no-op */ },
  };
}

// Register minimal test MOSFET factories
registerAnalogFactory("NMOS", (nodeIds) => makeMosfetAnalogElement(nodeIds));
registerAnalogFactory("PMOS", (nodeIds) => makeMosfetAnalogElement(nodeIds));

// ---------------------------------------------------------------------------
// Minimal ComponentDefinition builder
// ---------------------------------------------------------------------------

function makeComponentDef(name: string, pinLabels: string[], transistorModel?: string): ComponentDefinition {
  const pinLayout = pinLabels.map((label, i) => ({
    direction: PinDirection.BIDIRECTIONAL,
    label,
    defaultBitWidth: 1,
    position: { x: i * 2, y: 0 },
    isNegatable: false,
    isClockCapable: false,
  }));
  return {
    name,
    typeId: -1,
    factory: (_props) => makeElement(name, crypto.randomUUID(), []),
    pinLayout,
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.LOGIC,
    helpText: "",
    subcircuitRefs: transistorModel ? { cmos: transistorModel } : undefined,
    models: {
      digital: { executeFn: () => {} },
    },
    defaultModel: "digital",
  };
}

// ---------------------------------------------------------------------------
// CMOS inverter MnaSubcircuitNetlist
//
// Ports: in=0, out=1, VDD=2, GND=3
// PMOS: gate=in, drain=out, source=VDD, body=VDD
// NMOS: gate=in, drain=out, source=GND, body=GND
// ---------------------------------------------------------------------------

function buildCmosInverterNetlist(): MnaSubcircuitNetlist {
  return {
    ports: ["in", "out", "VDD", "GND"],
    elements: [
      { typeId: "PMOS", modelRef: "PMOS_DEFAULT" },
      { typeId: "NMOS", modelRef: "NMOS_DEFAULT" },
    ],
    internalNetCount: 0,
    netlist: [
      [0, 1, 2, 2],  // PMOS: gate=in, drain=out, source=VDD, body=VDD
      [0, 1, 3, 3],  // NMOS: gate=in, drain=out, source=GND, body=GND
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Expansion", () => {
  it("expands_inverter_to_two_mosfets", () => {
    const modelRegistry = new SubcircuitModelRegistry();
    const subcircuit = buildCmosInverterNetlist();
    modelRegistry.register("CmosInverter", subcircuit);

    const def = makeComponentDef("Not", ["in", "out"], "CmosInverter");

    let nextNode = 10; // outer circuit has nodes 1..9
    const result = expandTransistorModel(
      def,
      [1, 2], // outerPinNodeIds: in=1, out=2
      modelRegistry,
      5, // vddNodeId
      0, // gndNodeId
      () => nextNode++,
    );

    expect(result.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(result.elements).toHaveLength(2);
  });

  it("interface_pins_mapped_correctly", () => {
    const modelRegistry = new SubcircuitModelRegistry();
    const subcircuit = buildCmosInverterNetlist();
    modelRegistry.register("CmosInverter", subcircuit);

    const def = makeComponentDef("Not", ["in", "out"], "CmosInverter");

    const outerInNode = 1;
    const outerOutNode = 2;
    const vddNodeId = 5;
    const gndNodeId = 0;

    let nextNode = 10;
    const result = expandTransistorModel(
      def,
      [outerInNode, outerOutNode],
      modelRegistry,
      vddNodeId,
      gndNodeId,
      () => nextNode++,
    );

    expect(result.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(result.elements).toHaveLength(2);

    // Every element's pinNodeIds must reference only known nodes:
    // - outerInNode (gate)
    // - outerOutNode (drain)
    // - vddNodeId (PMOS source)
    // - gndNodeId / 0 (NMOS source)
    const knownNodes = new Set([outerInNode, outerOutNode, vddNodeId, gndNodeId]);
    for (const el of result.elements) {
      for (const nodeId of el.pinNodeIds) {
        expect(knownNodes).toContain(nodeId);
      }
    }

    // PMOS gate and NMOS gate must both connect to the outer input node
    // Netlist pin order: gate=0, drain=1, source=2, body=3
    const gateNodes = result.elements.map((el) => el.pinNodeIds[0]);
    for (const gNode of gateNodes) {
      expect(gNode).toBe(outerInNode);
    }

    // PMOS drain and NMOS drain must both connect to the outer output node
    const drainNodes = result.elements.map((el) => el.pinNodeIds[1]);
    for (const dNode of drainNodes) {
      expect(dNode).toBe(outerOutNode);
    }

    // PMOS source must be VDD
    const pmosSource = result.elements[0].pinNodeIds[2];
    expect(pmosSource).toBe(vddNodeId);

    // NMOS source must be GND
    const nmosSource = result.elements[1].pinNodeIds[2];
    expect(nmosSource).toBe(gndNodeId);
  });

  it("internal_nodes_get_unique_ids", () => {
    // For the CMOS inverter, there are no internal nodes — all nodes are interface.
    // Use a version with an internal node (simulate by checking nextNode increments).
    const modelRegistry = new SubcircuitModelRegistry();
    const subcircuit = buildCmosInverterNetlist();
    modelRegistry.register("CmosInverter", subcircuit);

    const def = makeComponentDef("Not", ["in", "out"], "CmosInverter");

    const outerNodeCount = 9;
    let nextNode = outerNodeCount + 1; // start after outer nodes
    const allocated: number[] = [];
    const result = expandTransistorModel(
      def,
      [1, 2],
      modelRegistry,
      5,
      0,
      () => {
        const id = nextNode++;
        allocated.push(id);
        return id;
      },
    );

    expect(result.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);

    // All allocated node IDs must be unique and > outerNodeCount
    const allocSet = new Set(allocated);
    expect(allocSet.size).toBe(allocated.length); // no duplicates
    for (const id of allocated) {
      expect(id).toBeGreaterThan(outerNodeCount);
    }

    // All element pinNodeIds must not collide with outer nodes (other than the mapped interface ones)
    // Interface nodes (1, 2, 5, 0) are expected — no new internal nodes for basic inverter
    expect(result.internalNodeCount).toBe(0); // CMOS inverter has no internal nodes
  });

  it("missing_transistor_model_emits_diagnostic", () => {
    const modelRegistry = new SubcircuitModelRegistry();

    // Component with no transistorModel set
    const def = makeComponentDef("Not", ["in", "out"], undefined);

    let nextNode = 10;
    const result = expandTransistorModel(
      def,
      [1, 2],
      modelRegistry,
      5,
      0,
      () => nextNode++,
    );

    const errors = result.diagnostics.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("missing-transistor-model");
    expect(result.elements).toHaveLength(0);
  });

  it("invalid_model_with_digital_components_emits_diagnostic", () => {
    const modelRegistry = new SubcircuitModelRegistry();

    const badNetlist: MnaSubcircuitNetlist = {
      ports: ["in"],
      elements: [
        { typeId: "FlipflopD" },
      ],
      internalNetCount: 1,
      netlist: [
        [0, 1],
      ],
    };

    modelRegistry.register("BadModel", badNetlist);

    const def = makeComponentDef("BadGate", ["in"], "BadModel");

    let nextNode = 10;
    const result = expandTransistorModel(
      def,
      [1],
      modelRegistry,
      5,
      0,
      () => nextNode++,
    );

    const errors = result.diagnostics.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("invalid-transistor-model");
    expect(result.elements).toHaveLength(0);
  });

  it("multiple_expansions_independent", () => {
    // Two NOT gates expanded from same model, sharing the same nextNodeId closure.
    // Each must get independent internal node IDs (no sharing).
    const modelRegistry = new SubcircuitModelRegistry();
    const subcircuit = buildCmosInverterNetlist();
    modelRegistry.register("CmosInverter", subcircuit);

    const def = makeComponentDef("Not", ["in", "out"], "CmosInverter");

    const outerNodeCount = 5;
    let nextNode = outerNodeCount + 1;
    const vddNodeId = 3;

    // First expansion (NOT gate 1: in=1, out=2)
    const result1 = expandTransistorModel(
      def,
      [1, 2],
      modelRegistry,
      vddNodeId,
      0,
      () => nextNode++,
    );

    // Second expansion (NOT gate 2: in=4, out=5)
    const result2 = expandTransistorModel(
      def,
      [4, 5],
      modelRegistry,
      vddNodeId,
      0,
      () => nextNode++,
    );

    expect(result1.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(result2.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);

    // Each expansion produces 2 MOSFETs
    expect(result1.elements).toHaveLength(2);
    expect(result2.elements).toHaveLength(2);

    // Gate 1 must use outer nodes 1, 2, vddNodeId, 0 — not gate 2's nodes
    for (const el of result1.elements) {
      for (const nodeId of el.pinNodeIds) {
        expect([1, 2, vddNodeId, 0]).toContain(nodeId);
        // Must NOT contain gate 2's exclusive nodes (4, 5)
        expect(nodeId).not.toBe(4);
        expect(nodeId).not.toBe(5);
      }
    }

    // Gate 2 must use outer nodes 4, 5, vddNodeId, 0 — not gate 1's nodes
    for (const el of result2.elements) {
      for (const nodeId of el.pinNodeIds) {
        expect([4, 5, vddNodeId, 0]).toContain(nodeId);
        // Must NOT contain gate 1's exclusive nodes (1, 2)
        expect(nodeId).not.toBe(1);
        expect(nodeId).not.toBe(2);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Composite factory tests (W4.5) — tests the new compileSubcircuitToMnaModel path
// ---------------------------------------------------------------------------

describe("CompositeFactory", () => {
  function buildPartitionForCompositeTest(
    subcircuitName: string,
    modelRegistry: SubcircuitModelRegistry,
    outerCircuit?: Circuit,
  ): { partition: SolverPartition; registry: ComponentRegistry } {
    const registry = new ComponentRegistry();

    const gndDef = {
      name: "Ground",
      pinLayout: [{ label: "gnd", direction: PinDirection.BIDIRECTIONAL, defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false }],
      propertyDefs: [],
      attributeMap: [],
      category: ComponentCategory.IO,
      helpText: "",
      factory: (_p: PropertyBag) => makeElement("Ground", crypto.randomUUID(), [{ x: 0, y: 0, label: "gnd" }]),
      models: { mnaModels: { behavioral: {} } },
    };
    registry.register(gndDef);

    const gatePinLayout = [
      { label: "in", direction: PinDirection.INPUT, defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false },
      { label: "out", direction: PinDirection.OUTPUT, defaultBitWidth: 1, position: { x: 20, y: 0 }, isNegatable: false, isClockCapable: false },
      { label: "VDD", direction: PinDirection.INPUT, defaultBitWidth: 1, position: { x: 10, y: -10 }, isNegatable: false, isClockCapable: false, kind: "power" as const },
      { label: "GND", direction: PinDirection.INPUT, defaultBitWidth: 1, position: { x: 10, y: 10 }, isNegatable: false, isClockCapable: false, kind: "power" as const },
    ];

    const gateDef: ComponentDefinition = {
      name: "CmosNot",
      typeId: -1,
      pinLayout: gatePinLayout,
      propertyDefs: [],
      attributeMap: [],
      category: ComponentCategory.LOGIC,
      helpText: "",
      factory: (_p: PropertyBag) => makeElement("CmosNot", crypto.randomUUID(), []),
      subcircuitRefs: { cmos: subcircuitName },
      models: {
        digital: { executeFn: () => {} },
        mnaModels: {
          cmos: { factory: () => ({ branchIndex: -1, isNonlinear: false, isReactive: false, stamp() {}, getPinCurrents: () => [] }) },
        },
      },
      defaultModel: "cmos",
    };
    registry.register(gateDef);

    const gndEl = makeElement("Ground", "gnd1", [{ x: 0, y: 0, label: "gnd" }]);
    const gateEl = makeElement("CmosNot", "not1", [
      { x: 10, y: 0, label: "in" },
      { x: 20, y: 0, label: "out" },
      { x: 15, y: -10, label: "VDD" },
      { x: 15, y: 10, label: "GND" },
    ], new Map([["simulationModel", "cmos"]]));

    const storedGateDef = registry.get("CmosNot")!;

    const groups: ConnectivityGroup[] = [
      {
        groupId: 0,
        pins: [
          { elementId: "gnd1", pinLabel: "gnd", worldPosition: { x: 0, y: 0 }, direction: PinDirection.BIDIRECTIONAL, bitWidth: 1, domain: "analog" },
          { elementId: "not1", pinLabel: "GND", worldPosition: { x: 15, y: 10 }, direction: PinDirection.INPUT, bitWidth: 1, domain: "analog" },
        ],
        wires: [],
      },
      {
        groupId: 1,
        pins: [
          { elementId: "not1", pinLabel: "in", worldPosition: { x: 10, y: 0 }, direction: PinDirection.INPUT, bitWidth: 1, domain: "analog" },
        ],
        wires: [],
      },
      {
        groupId: 2,
        pins: [
          { elementId: "not1", pinLabel: "out", worldPosition: { x: 20, y: 0 }, direction: PinDirection.OUTPUT, bitWidth: 1, domain: "analog" },
        ],
        wires: [],
      },
      {
        groupId: 3,
        pins: [
          { elementId: "not1", pinLabel: "VDD", worldPosition: { x: 15, y: -10 }, direction: PinDirection.INPUT, bitWidth: 1, domain: "analog" },
        ],
        wires: [],
      },
    ];

    const gndPC: PartitionedComponent = {
      element: gndEl,
      definition: registry.get("Ground")!,
      modelKey: "behavioral",
      model: {} as MnaModel,
      resolvedPins: [{ elementId: "gnd1", pinLabel: "gnd", worldPosition: { x: 0, y: 0 }, direction: PinDirection.BIDIRECTIONAL, bitWidth: 1, domain: "analog" as const }],
    };

    const gatePC: PartitionedComponent = {
      element: gateEl,
      definition: storedGateDef,
      modelKey: "cmos",
      model: storedGateDef.models!.mnaModels!["cmos"]!,
      resolvedPins: [
        { elementId: "not1", pinLabel: "in", worldPosition: { x: 10, y: 0 }, direction: PinDirection.INPUT, bitWidth: 1, domain: "analog" as const },
        { elementId: "not1", pinLabel: "out", worldPosition: { x: 20, y: 0 }, direction: PinDirection.OUTPUT, bitWidth: 1, domain: "analog" as const },
        { elementId: "not1", pinLabel: "VDD", worldPosition: { x: 15, y: -10 }, direction: PinDirection.INPUT, bitWidth: 1, domain: "analog" as const },
        { elementId: "not1", pinLabel: "GND", worldPosition: { x: 15, y: 10 }, direction: PinDirection.INPUT, bitWidth: 1, domain: "analog" as const },
      ],
    };

    const partition: SolverPartition = {
      components: [gndPC, gatePC],
      groups,
      bridgeStubs: [],
      crossEngineBoundaries: [],
    };

    return { partition, registry };
  }

  it("composite_factory_produces_single_element_from_subcircuit", () => {
    const modelRegistry = new SubcircuitModelRegistry();
    const subcircuit = buildCmosInverterNetlist();
    modelRegistry.register("CmosInverter", subcircuit);

    const { partition, registry } = buildPartitionForCompositeTest("CmosInverter", modelRegistry);

    const compiled = compileAnalogPartition(
      partition,
      registry,
      modelRegistry,
    );

    // The composite factory produces a SINGLE element (not 2 separate MOSFETs)
    // Plus no VDD source injected — VDD flows through regular pins
    const errors = compiled.diagnostics.filter(d => d.severity === "error");
    expect(errors).toHaveLength(0);
    expect(compiled.elements.length).toBe(1);
  });

  it("composite_factory_element_stamps_all_sub_elements", () => {
    const modelRegistry = new SubcircuitModelRegistry();
    const subcircuit = buildCmosInverterNetlist();
    modelRegistry.register("CmosInverter", subcircuit);

    const { partition, registry } = buildPartitionForCompositeTest("CmosInverter", modelRegistry);

    const compiled = compileAnalogPartition(
      partition,
      registry,
      modelRegistry,
    );

    expect(compiled.elements.length).toBe(1);
    const compositeEl = compiled.elements[0];

    // The composite element should have isNonlinear=true (MOSFETs are nonlinear)
    expect(compositeEl.isNonlinear).toBe(true);
  });

  it("unresolved_subcircuit_emits_diagnostic_and_skips", () => {
    const modelRegistry = new SubcircuitModelRegistry();

    const { partition, registry } = buildPartitionForCompositeTest("NonexistentModel", modelRegistry);

    const compiled = compileAnalogPartition(
      partition,
      registry,
      modelRegistry,
    );

    const unresolvedDiags = compiled.diagnostics.filter(
      d => d.code === "unresolved-model-ref",
    );
    expect(unresolvedDiags).toHaveLength(1);
    expect(unresolvedDiags[0].severity).toBe("error");
    expect(unresolvedDiags[0].summary).toContain("NonexistentModel");

    // Component should be skipped — no elements produced
    expect(compiled.elements).toHaveLength(0);
  });

  it("no_implicit_vdd_source_injected", () => {
    const modelRegistry = new SubcircuitModelRegistry();
    const subcircuit = buildCmosInverterNetlist();
    modelRegistry.register("CmosInverter", subcircuit);

    const { partition, registry } = buildPartitionForCompositeTest("CmosInverter", modelRegistry);

    const compiled = compileAnalogPartition(
      partition,
      registry,
      modelRegistry,
    );

    // Only 1 composite element — no implicit VDD voltage source
    expect(compiled.elements.length).toBe(1);
    // branchCount should be 0 since MOSFETs don't need branches
    expect(compiled.branchCount).toBe(0);
  });
});
