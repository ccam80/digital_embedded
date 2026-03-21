/**
 * Tests for transistor model expansion (Phase 4c.1).
 *
 * Tests call expandTransistorModel() directly to verify the expansion logic
 * independently from the full compiler pipeline.
 *
 * A minimal CMOS inverter model is used:
 *   - PMOS: source→VDD, gate→in, drain→out
 *   - NMOS: source→GND, gate→in, drain→out
 *   - In "in" (interface pin, maps to outer input node)
 *   - In "VDD" (VDD rail, maps to vddNodeId)
 *   - In "GND" (GND rail, maps to gndNodeId = 0)
 *   - Out "out" (interface pin, maps to outer output node)
 *
 * The subcircuit Circuit uses wires to connect pins; wire positions encode connectivity.
 */

import { describe, it, expect } from "vitest";
import { Circuit, Wire } from "../../core/circuit.js";
import { PropertyBag } from "../../core/properties.js";
import { PinDirection } from "../../core/pin.js";
import type { Pin } from "../../core/pin.js";
import type { CircuitElement } from "../../core/element.js";
import type { Rect, RenderContext } from "../../core/renderer-interface.js";
import type { SerializedElement } from "../../core/element.js";
import type { ComponentDefinition } from "../../core/registry.js";
import { ComponentCategory, noOpAnalogExecuteFn } from "../../core/registry.js";
import type { AnalogElement } from "../element.js";
import type { SparseSolver } from "../sparse-solver.js";
import { TransistorModelRegistry } from "../transistor-model-registry.js";
import {
  expandTransistorModel,
  registerAnalogFactory,
  getAnalogFactory,
} from "../transistor-expansion.js";

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
    getHelpText() { return ""; },
    getAttribute(k: string) { return propsMap.get(k); },
  };
}

// ---------------------------------------------------------------------------
// Minimal AnalogElement factory for test MOSFETs
// ---------------------------------------------------------------------------

function makeMosfetAnalogElement(nodeIds: number[]): AnalogElement {
  return {
    nodeIndices: [...nodeIds],
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
    engineType: "both" as const,
    transistorModel,
    simulationModes: ["logical", "analog-pins", "analog-internals"],
    factory: (_props) => makeElement(name, crypto.randomUUID(), []),
    executeFn: noOpAnalogExecuteFn,
    pinLayout,
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.LOGIC,
    helpText: "",
  };
}

// ---------------------------------------------------------------------------
// CMOS inverter subcircuit builder
//
// Connectivity (all positions encode wire endpoints):
//   in node  — x=10: wire group for "in" input + PMOS gate + NMOS gate
//   out node — x=20: wire group for PMOS drain + NMOS drain + "out" output
//   VDD node — x=30: wire group for VDD In + PMOS source
//   GND node — x=40: wire group for GND In + NMOS source
//
// Wire protocol: connect pin to wire if pin.x == wire.start.x
// (We place components at unique X positions so their pins sit at wire endpoints.)
// ---------------------------------------------------------------------------

function buildCmosInverterSubcircuit(): Circuit {
  const circuit = new Circuit({ engineType: "analog" });

  // Interface elements
  // In "in": has pin at x=10
  const inEl = makeElement("In", "in-el", [{ x: 10, y: 0, label: "out" }], [["label", "in"]]);
  // In "VDD": has pin at x=30
  const vddEl = makeElement("In", "vdd-el", [{ x: 30, y: 0, label: "out" }], [["label", "VDD"]]);
  // In "GND": has pin at x=40
  const gndEl = makeElement("In", "gnd-el", [{ x: 40, y: 0, label: "out" }], [["label", "GND"]]);
  // Out "out": has pin at x=20
  const outEl = makeElement("Out", "out-el", [{ x: 20, y: 0, label: "in" }], [["label", "out"]]);

  // PMOS: D=x=20, G=x=10, S=x=30
  const pmosEl = makeElement("PMOS", "pmos-el", [
    { x: 20, y: 2, label: "D" },
    { x: 10, y: 2, label: "G" },
    { x: 30, y: 2, label: "S" },
  ]);

  // NMOS: D=x=20, G=x=10, S=x=40
  const nmosEl = makeElement("NMOS", "nmos-el", [
    { x: 20, y: 4, label: "D" },
    { x: 10, y: 4, label: "G" },
    { x: 40, y: 4, label: "S" },
  ]);

  circuit.addElement(inEl);
  circuit.addElement(vddEl);
  circuit.addElement(gndEl);
  circuit.addElement(outEl);
  circuit.addElement(pmosEl);
  circuit.addElement(nmosEl);

  // Wires connecting components on the same net by shared X coordinate
  // Net: x=10 (in) — connects In "in" and both gates
  circuit.addWire(new Wire({ x: 10, y: 0 }, { x: 10, y: 2 }));
  circuit.addWire(new Wire({ x: 10, y: 2 }, { x: 10, y: 4 }));

  // Net: x=20 (out) — connects PMOS drain, NMOS drain, Out "out"
  circuit.addWire(new Wire({ x: 20, y: 0 }, { x: 20, y: 2 }));
  circuit.addWire(new Wire({ x: 20, y: 2 }, { x: 20, y: 4 }));

  // Net: x=30 (VDD) — connects VDD In and PMOS source
  circuit.addWire(new Wire({ x: 30, y: 0 }, { x: 30, y: 2 }));

  // Net: x=40 (GND) — connects GND In and NMOS source
  circuit.addWire(new Wire({ x: 40, y: 0 }, { x: 40, y: 4 }));

  return circuit;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Expansion", () => {
  it("expands_inverter_to_two_mosfets", () => {
    const modelRegistry = new TransistorModelRegistry();
    const subcircuit = buildCmosInverterSubcircuit();
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
    const modelRegistry = new TransistorModelRegistry();
    const subcircuit = buildCmosInverterSubcircuit();
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

    // Every element's nodeIndices must reference only known nodes:
    // - outerInNode (gate)
    // - outerOutNode (drain)
    // - vddNodeId (PMOS source)
    // - gndNodeId / 0 (NMOS source)
    const knownNodes = new Set([outerInNode, outerOutNode, vddNodeId, gndNodeId]);
    for (const el of result.elements) {
      for (const nodeId of el.nodeIndices) {
        expect(knownNodes).toContain(nodeId);
      }
    }

    // PMOS gate and NMOS gate must both connect to the outer input node
    const gateNodes = result.elements.map((el) => el.nodeIndices[1]); // G is index 1 (D,G,S)
    for (const gNode of gateNodes) {
      expect(gNode).toBe(outerInNode);
    }

    // PMOS drain and NMOS drain must both connect to the outer output node
    const drainNodes = result.elements.map((el) => el.nodeIndices[0]); // D is index 0
    for (const dNode of drainNodes) {
      expect(dNode).toBe(outerOutNode);
    }

    // PMOS source must be VDD
    const pmosSource = result.elements[0].nodeIndices[2]; // S is index 2
    expect(pmosSource).toBe(vddNodeId);

    // NMOS source must be GND
    const nmosSource = result.elements[1].nodeIndices[2];
    expect(nmosSource).toBe(gndNodeId);
  });

  it("internal_nodes_get_unique_ids", () => {
    // For the CMOS inverter, there are no internal nodes — all nodes are interface.
    // Use a version with an internal node (simulate by checking nextNode increments).
    const modelRegistry = new TransistorModelRegistry();
    const subcircuit = buildCmosInverterSubcircuit();
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

    // All element nodeIndices must not collide with outer nodes (other than the mapped interface ones)
    // Interface nodes (1, 2, 5, 0) are expected — no new internal nodes for basic inverter
    expect(result.internalNodeCount).toBe(0); // CMOS inverter has no internal nodes
  });

  it("missing_transistor_model_emits_diagnostic", () => {
    const modelRegistry = new TransistorModelRegistry();

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
    const modelRegistry = new TransistorModelRegistry();

    // Subcircuit containing a digital-only component (FlipflopD has no analogFactory)
    const subcircuit = new Circuit({ engineType: "analog" });
    // In "in" interface element
    const inEl = makeElement("In", "in-el", [{ x: 10, y: 0, label: "out" }], [["label", "in"]]);
    // FlipflopD — digital-only (no analogFactory registered)
    const flipflop = makeElement("FlipflopD", "ff-el", [
      { x: 10, y: 2, label: "D" },
      { x: 20, y: 2, label: "Q" },
    ]);
    subcircuit.addElement(inEl);
    subcircuit.addElement(flipflop);
    subcircuit.addWire(new Wire({ x: 10, y: 0 }, { x: 10, y: 2 }));

    modelRegistry.register("BadModel", subcircuit);

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
    const modelRegistry = new TransistorModelRegistry();
    const subcircuit = buildCmosInverterSubcircuit();
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
      for (const nodeId of el.nodeIndices) {
        expect([1, 2, vddNodeId, 0]).toContain(nodeId);
        // Must NOT contain gate 2's exclusive nodes (4, 5)
        expect(nodeId).not.toBe(4);
        expect(nodeId).not.toBe(5);
      }
    }

    // Gate 2 must use outer nodes 4, 5, vddNodeId, 0 — not gate 1's nodes
    for (const el of result2.elements) {
      for (const nodeId of el.nodeIndices) {
        expect([4, 5, vddNodeId, 0]).toContain(nodeId);
        // Must NOT contain gate 1's exclusive nodes (1, 2)
        expect(nodeId).not.toBe(1);
        expect(nodeId).not.toBe(2);
      }
    }
  });
});
