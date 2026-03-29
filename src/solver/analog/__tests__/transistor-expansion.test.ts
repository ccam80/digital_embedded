/**
 * Tests for the composite factory path (compileSubcircuitToMnaModel).
 *
 * Verifies that subcircuit-backed models compile through the standard
 * analog compiler pipeline: resolveSubcircuitModels -> compileSubcircuitToMnaModel
 * -> single composite AnalogElement.
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
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import type { MnaModel } from "../../../core/registry.js";
import type { AnalogElement } from "../element.js";
import type { SparseSolver } from "../sparse-solver.js";
import type { MnaSubcircuitNetlist } from "../../../core/mna-subcircuit-netlist.js";
import { SubcircuitModelRegistry } from "../subcircuit-model-registry.js";
import { registerAnalogFactory } from "../transistor-expansion.js";
import { compileAnalogPartition } from "../compiler.js";
import type { SolverPartition, PartitionedComponent, ConnectivityGroup } from "../../../compile/types.js";

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
  propsEntries: Array<[string, string | number | boolean]> | Map<string, string | number | boolean> = [],
): CircuitElement {
  const resolvedPins = pins.map((p) => makePin(p.x, p.y, p.label));
  const propsMap = propsEntries instanceof Map
    ? propsEntries
    : new Map<string, import("../../core/properties.js").PropertyValue>(
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
// Partition builder helper
// ---------------------------------------------------------------------------

function buildPartitionForCompositeTest(
  subcircuitName: string,
  modelRegistry: SubcircuitModelRegistry,
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

// ---------------------------------------------------------------------------
// Composite factory tests — the compileSubcircuitToMnaModel path
// ---------------------------------------------------------------------------

describe("CompositeFactory", () => {
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
