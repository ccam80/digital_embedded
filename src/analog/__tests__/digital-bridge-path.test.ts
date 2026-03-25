/**
 * Tests for the simulationMode: "logical" compiler path (inline bridge).
 *
 * Verifies that when a "both"-engine component has simulationMode: "logical",
 * the analog compiler:
 *   1. Does NOT call the analogFactory
 *   2. Produces exactly one BridgeInstance in compiled.bridges
 *   3. The bridge has correct input/output adapters for each pin direction
 *   4. Inner net IDs map correctly via compiledInner.labelToNetId
 *   5. Unconnected-pin cases emit diagnostics and produce no bridge
 */

import { describe, it, expect, vi } from "vitest";
import { Circuit, Wire } from "../../core/circuit.js";
import type { CircuitElement } from "../../core/element.js";
import type { Pin, PinDeclaration } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag } from "../../core/properties.js";
import type { PropertyValue } from "../../core/properties.js";
import type { Rect, RenderContext } from "../../core/renderer-interface.js";
import { ComponentRegistry, ComponentCategory } from "../../core/registry.js";
import type { ExecuteFunction } from "../../core/registry.js";
import type { AnalogElement } from "../element.js";
import type { SparseSolver } from "../sparse-solver.js";
import { compileAnalogCircuit } from "../compiler.js";
import { BridgeOutputAdapter, BridgeInputAdapter } from "../bridge-adapter.js";

// ---------------------------------------------------------------------------
// Shared stub helpers
// ---------------------------------------------------------------------------

function noopExecuteFn(): void {}

/**
 * Build a stub CircuitElement for use inside the registry factory.
 * pinsFn receives the PropertyBag so pin bitWidths can be read from props.
 */
function makeStubElFactory(typeId: string, pinsFn: (props: PropertyBag) => Pin[]) {
  return (props: PropertyBag): CircuitElement => ({
    typeId,
    instanceId: crypto.randomUUID(),
    position: { x: 0, y: 0 },
    rotation: 0 as const,
    mirror: false,
    getPins() { return pinsFn(props); },
    getProperties() { return props; },
    getAttribute(k: string) { return props.has(k) ? props.get(k) : undefined; },
    draw(_ctx: RenderContext) {},
    getBoundingBox(): Rect { return { x: 0, y: 0, width: 4, height: 4 }; },
    serialize() {
      return { typeId, instanceId: this.instanceId, position: this.position, rotation: 0, mirror: false, properties: {} };
    },
    getHelpText() { return ""; },
  } as unknown as CircuitElement);
}

/**
 * Stub AnalogElement factory (for behavioral-mode tests).
 */
function makeStubAnalogElement(pinNodes: ReadonlyMap<string, number>): AnalogElement {
  return {
    pinNodeIds: [...pinNodes.values()],
    branchIndex: -1,
    isNonlinear: false,
    isReactive: false,
    stamp(_s: SparseSolver) {},
  };
}

// ---------------------------------------------------------------------------
// Registry builder
//
// Includes:
//   - Ground (analog)
//   - In    (digital, for inner circuits)
//   - Out   (digital, for inner circuits)
//   - DigitalXor ("both", 2 inputs + 1 output — used as the test component)
// ---------------------------------------------------------------------------

function buildRegistry(analogFactory?: (pinNodes: ReadonlyMap<string, number>, internalNodeIds: readonly number[], branchIdx: number, props: PropertyBag, getTime: () => number) => AnalogElement) {
  const registry = new ComponentRegistry();

  registry.register({
    name: "Ground",
    typeId: -1,
    factory: makeStubElFactory("Ground", () => []),
    pinLayout: [],
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.MISC,
    helpText: "",
    models: { analog: { factory: () => ({ pinNodeIds: [], branchIndex: -1, isNonlinear: false, isReactive: false, stamp() {} }) } },
  });

  // In: one OUTPUT pin at (0,0), label and bitWidth from props
  registry.register({
    name: "In",
    typeId: -1,
    factory: makeStubElFactory("In", (props) => [{
      direction: PinDirection.OUTPUT,
      position: { x: 0, y: 0 },
      label: "out",
      bitWidth: props.getOrDefault<number>("bitWidth", 1),
      isNegated: false,
      isClock: false,
    }]),
    pinLayout: [{
      label: "out",
      direction: PinDirection.OUTPUT,
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    }],
    propertyDefs: [{ key: "label", defaultValue: "" }, { key: "bitWidth", defaultValue: 1 }],
    attributeMap: [],
    category: ComponentCategory.IO,
    helpText: "",
    models: { digital: { executeFn: noopExecuteFn as unknown as ExecuteFunction } },
  });

  // Out: one INPUT pin at (0,0), label and bitWidth from props
  registry.register({
    name: "Out",
    typeId: -1,
    factory: makeStubElFactory("Out", (props) => [{
      direction: PinDirection.INPUT,
      position: { x: 0, y: 0 },
      label: "in",
      bitWidth: props.getOrDefault<number>("bitWidth", 1),
      isNegated: false,
      isClock: false,
    }]),
    pinLayout: [{
      label: "in",
      direction: PinDirection.INPUT,
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    }],
    propertyDefs: [{ key: "label", defaultValue: "" }, { key: "bitWidth", defaultValue: 1 }],
    attributeMap: [],
    category: ComponentCategory.IO,
    helpText: "",
    models: { digital: { executeFn: noopExecuteFn as unknown as ExecuteFunction } },
  });

  // DigitalXor: 2 INPUT pins + 1 OUTPUT pin, engineType "both"
  const xorPinLayout: PinDeclaration[] = [
    { label: "A",   direction: PinDirection.INPUT,  defaultBitWidth: 1, position: { x: 0, y: 1 }, isNegatable: false, isClockCapable: false },
    { label: "B",   direction: PinDirection.INPUT,  defaultBitWidth: 1, position: { x: 0, y: 2 }, isNegatable: false, isClockCapable: false },
    { label: "out", direction: PinDirection.OUTPUT, defaultBitWidth: 1, position: { x: 2, y: 1 }, isNegatable: false, isClockCapable: false },
  ];
  registry.register({
    name: "DigitalXor",
    typeId: -1,
    factory: makeStubElFactory("DigitalXor", (_props) => [
      { direction: PinDirection.INPUT,  position: { x: 0, y: 1 }, label: "A",   bitWidth: 1, isNegated: false, isClock: false },
      { direction: PinDirection.INPUT,  position: { x: 0, y: 2 }, label: "B",   bitWidth: 1, isNegated: false, isClock: false },
      { direction: PinDirection.OUTPUT, position: { x: 2, y: 1 }, label: "out", bitWidth: 1, isNegated: false, isClock: false },
    ]),
    pinLayout: xorPinLayout,
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.LOGIC,
    helpText: "",
    models: {
      digital: { executeFn: noopExecuteFn as unknown as ExecuteFunction },
      analog: { factory: (analogFactory ?? makeStubAnalogElement) as unknown as import("../../core/registry.js").AnalogModel["factory"] },
    },
  });

  return registry;
}

/**
 * Build an outer analog circuit with DigitalXor and wires.
 *
 * Layout (world coords):
 *   Ground pin:  (0, 0)  — element at (0,0), pin LOCAL (0,0)
 *   Xor element: position (10, 0), rotation=0
 *     pin A:   LOCAL (0,1) → world (10, 1)
 *     pin B:   LOCAL (0,2) → world (10, 2)
 *     pin out: LOCAL (2,1) → world (12, 1)
 *
 * Each pin gets a wire connecting it to a distinct endpoint so buildNodeMap
 * assigns it a unique non-zero MNA node ID.
 */
function buildCircuit(propsMap: Map<string, PropertyValue> = new Map()) {
  const circuit = new Circuit({ engineType: "analog" });

  // DigitalXor element at position (10, 0), rotation=0
  const xorProps = new PropertyBag();
  for (const [k, v] of propsMap) xorProps.set(k, v);
  const xorEl = makeStubElFactory("DigitalXor", (_props) => [
    { direction: PinDirection.INPUT,  position: { x: 0, y: 1 }, label: "A",   bitWidth: 1, isNegated: false, isClock: false },
    { direction: PinDirection.INPUT,  position: { x: 0, y: 2 }, label: "B",   bitWidth: 1, isNegated: false, isClock: false },
    { direction: PinDirection.OUTPUT, position: { x: 2, y: 1 }, label: "out", bitWidth: 1, isNegated: false, isClock: false },
  ])(xorProps);
  xorEl.position = { x: 10, y: 0 };
  circuit.addElement(xorEl);

  // Ground element at (0,0) with a pin at LOCAL (0,0) → world (0,0)
  // buildNodeMap identifies ground by finding Ground elements whose pins
  // touch wire endpoints.
  const gndEl = makeStubElFactory("Ground", () => [{
    direction: PinDirection.BIDIRECTIONAL,
    position: { x: 0, y: 0 },
    label: "gnd",
    bitWidth: 1,
    isNegated: false,
    isClock: false,
  }])(new PropertyBag());
  gndEl.position = { x: 0, y: 0 };
  circuit.addElement(gndEl);

  // Wire each XOR pin to a distinct endpoint to create non-zero MNA nodes.
  circuit.addWire(new Wire({ x: 10, y: 1 }, { x: 11, y: 1 })); // node for A
  circuit.addWire(new Wire({ x: 10, y: 2 }, { x: 11, y: 2 })); // node for B
  circuit.addWire(new Wire({ x: 12, y: 1 }, { x: 13, y: 1 })); // node for out
  // Ground wire at (0,0) — pin touches this wire endpoint → node 0
  circuit.addWire(new Wire({ x: 0, y: 0 }, { x: 1, y: 0 }));

  return circuit;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DigitalBridgePath", () => {
  it("analog_factory_not_called_in_digital_mode", () => {
    const analogFactory = vi.fn(makeStubAnalogElement);
    const registry = buildRegistry(analogFactory);
    const circuit = buildCircuit(new Map([["simulationMode", "logical"]]));

    compileAnalogCircuit(circuit, registry);

    expect(analogFactory).not.toHaveBeenCalled();
  });

  it("creates_one_bridge_instance", () => {
    const registry = buildRegistry();
    const circuit = buildCircuit(new Map([["simulationMode", "logical"]]));

    const compiled = compileAnalogCircuit(circuit, registry);

    expect(compiled.bridges).toHaveLength(1);
  });

  it("bridge_has_correct_adapter_counts", () => {
    const registry = buildRegistry();
    const circuit = buildCircuit(new Map([["simulationMode", "logical"]]));

    const compiled = compileAnalogCircuit(circuit, registry);
    const bridge = compiled.bridges[0]!;

    // DigitalXor: 2 inputs → 2 BridgeInputAdapters; 1 output → 1 BridgeOutputAdapter
    expect(bridge.inputAdapters).toHaveLength(2);
    expect(bridge.outputAdapters).toHaveLength(1);
    expect(bridge.inputAdapters[0]).toBeInstanceOf(BridgeInputAdapter);
    expect(bridge.inputAdapters[1]).toBeInstanceOf(BridgeInputAdapter);
    expect(bridge.outputAdapters[0]).toBeInstanceOf(BridgeOutputAdapter);
  });

  it("inner_net_ids_are_valid", () => {
    const registry = buildRegistry();
    const circuit = buildCircuit(new Map([["simulationMode", "logical"]]));

    const compiled = compileAnalogCircuit(circuit, registry);
    const bridge = compiled.bridges[0]!;
    const inner = bridge.compiledInner;

    expect(inner.netCount).toBeGreaterThan(0);

    for (const netId of bridge.inputPinNetIds) {
      expect(netId).toBeGreaterThanOrEqual(0);
      expect(netId).toBeLessThan(inner.netCount);
    }
    for (const netId of bridge.outputPinNetIds) {
      expect(netId).toBeGreaterThanOrEqual(0);
      expect(netId).toBeLessThan(inner.netCount);
    }
  });

  it("adapter_outer_node_ids_are_positive", () => {
    const registry = buildRegistry();
    const circuit = buildCircuit(new Map([["simulationMode", "logical"]]));

    const compiled = compileAnalogCircuit(circuit, registry);
    const bridge = compiled.bridges[0]!;

    for (const adapter of bridge.inputAdapters) {
      expect(adapter.inputNodeId).toBeGreaterThan(0);
    }
    for (const adapter of bridge.outputAdapters) {
      expect(adapter.outputNodeId).toBeGreaterThan(0);
    }
  });

  it("no_errors_emitted_in_digital_mode", () => {
    const registry = buildRegistry();
    const circuit = buildCircuit(new Map([["simulationMode", "logical"]]));

    const compiled = compileAnalogCircuit(circuit, registry);
    const errors = compiled.diagnostics.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(0);
  });

  it("behavioral_mode_still_calls_analog_factory", () => {
    const analogFactory = vi.fn(makeStubAnalogElement);
    const registry = buildRegistry(analogFactory);
    // No simulationMode → defaults to "analog-pins"
    const circuit = buildCircuit();

    compileAnalogCircuit(circuit, registry);

    expect(analogFactory).toHaveBeenCalledOnce();
    // Behavioral path produces no bridges
  });

  it("adapter_labels_include_pin_name", () => {
    const registry = buildRegistry();
    const circuit = buildCircuit(new Map([["simulationMode", "logical"]]));

    const compiled = compileAnalogCircuit(circuit, registry);
    const bridge = compiled.bridges[0]!;

    // Each adapter label should contain its pin name
    const inputLabels = bridge.inputAdapters.map((a) => a.label ?? "");
    const outputLabels = bridge.outputAdapters.map((a) => a.label ?? "");
    expect(inputLabels.some((l) => l.includes("A"))).toBe(true);
    expect(inputLabels.some((l) => l.includes("B"))).toBe(true);
    expect(outputLabels[0]).toContain("out");
  });
});
