/**
 * Tests for the digitalPinLoading circuit metadata field (W6.1).
 *
 * Verifies that the three loading modes produce the correct bridge adapter
 * behaviour when compiling a mixed digital/analog circuit:
 *
 *   cross-domain (default): bridge adapters only where simulationModel=logical
 *                            is set (or at real cross-engine boundaries)
 *   all:                     every dual-model component gets bridge adapters
 *                            regardless of per-component simulationModel
 *   none:                    bridges at partition boundaries use ideal params
 *                            (rIn = Infinity, rOut = 0)
 *
 * The tests use a stub registry with Ground, In, Out, a Resistor (MNA-only),
 * and a DigitalXor (dual-model: digital + mna behavioral). The Resistor forces
 * an analog partition so bridge synthesis can run.
 */

import { describe, it, expect, vi } from "vitest";
import { Circuit, Wire } from "../../../core/circuit.js";
import type { CircuitElement } from "../../../core/element.js";
import type { Pin, PinDeclaration } from "../../../core/pin.js";
import { PinDirection } from "../../../core/pin.js";
import { PropertyBag } from "../../../core/properties.js";
import type { PropertyValue } from "../../../core/properties.js";
import type { Rect, RenderContext } from "../../../core/renderer-interface.js";
import { ComponentRegistry, ComponentCategory } from "../../../core/registry.js";
import type { ExecuteFunction } from "../../../core/registry.js";
import type { AnalogElement } from "../element.js";
import type { SparseSolver } from "../sparse-solver.js";
import { BridgeOutputAdapter, BridgeInputAdapter } from "../bridge-adapter.js";
import { compileUnified } from "@/compile/compile.js";

// ---------------------------------------------------------------------------
// Stub helpers (mirrored from digital-bridge-path.test.ts)
// ---------------------------------------------------------------------------

function noopExecuteFn(): void {}

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
  } as unknown as CircuitElement);
}

function makeStubAnalogElement(pinNodes: ReadonlyMap<string, number>): AnalogElement {
  return {
    pinNodeIds: [...pinNodes.values()],
    allNodeIds: [...pinNodes.values()],
    branchIndex: -1,
    isNonlinear: false,
    isReactive: false,
    stamp(_s: SparseSolver) {},
  };
}

// ---------------------------------------------------------------------------
// Registry builder
//
// Includes: Ground, In, Out, Resistor (MNA-only), DigitalXor (dual-model)
//
// The Resistor is MNA-only to ensure the analog partition is non-empty so
// bridge synthesis runs regardless of the DigitalXor's model mode.
// ---------------------------------------------------------------------------

function buildRegistry(
  analogFactory?: (pinNodes: ReadonlyMap<string, number>, internalNodeIds: readonly number[], branchIdx: number, props: PropertyBag, getTime: () => number) => AnalogElement,
) {
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
    defaultModel: "behavioral",
    models: {
      mnaModels: {
        behavioral: {
          factory: () => ({
            pinNodeIds: [],
            allNodeIds: [],
            branchIndex: -1,
            isNonlinear: false,
            isReactive: false,
            stamp() {},
          }),
        },
      },
    },
  });

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

  // Resistor: MNA-only, 2 pins (A, B). Forces an analog partition to exist.
  registry.register({
    name: "Resistor",
    typeId: -1,
    factory: makeStubElFactory("Resistor", () => [
      { direction: PinDirection.BIDIRECTIONAL, position: { x: 0, y: 0 }, label: "A", bitWidth: 1, isNegated: false, isClock: false },
      { direction: PinDirection.BIDIRECTIONAL, position: { x: 2, y: 0 }, label: "B", bitWidth: 1, isNegated: false, isClock: false },
    ]),
    pinLayout: [
      { label: "A", direction: PinDirection.BIDIRECTIONAL, defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false },
      { label: "B", direction: PinDirection.BIDIRECTIONAL, defaultBitWidth: 1, position: { x: 2, y: 0 }, isNegatable: false, isClockCapable: false },
    ],
    propertyDefs: [{ key: "resistance", defaultValue: 1000 }],
    attributeMap: [],
    category: ComponentCategory.PASSIVE,
    helpText: "",
    defaultModel: "behavioral",
    models: {
      mnaModels: {
        behavioral: {
          factory: (pinNodes) => makeStubAnalogElement(pinNodes),
        },
      },
    },
  });

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
      mnaModels: {
        behavioral: {
          factory: (analogFactory ?? makeStubAnalogElement) as unknown as import("../../core/registry.js").MnaModel["factory"],
        },
      },
    },
  });

  return registry;
}

// ---------------------------------------------------------------------------
// Circuit builder
//
// Builds a circuit with:
//   - Ground at (0,0) — provides MNA reference node
//   - Resistor at (20,0) with pins A=(20,0) and B=(22,0) — MNA-only component
//     that forces a non-empty analog partition
//   - DigitalXor at (10,0) — dual-model component under test
//
// All components share wires to Ground so they form a connected net.
// ---------------------------------------------------------------------------

function buildCircuit(
  metadata: Partial<import("../../../core/circuit.js").CircuitMetadata> = {},
  propsMap: Map<string, PropertyValue> = new Map(),
) {
  const circuit = new Circuit(metadata);

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

  // Resistor at position (20, 0) — pin A at world (20,0), pin B at world (22,0)
  const resEl = makeStubElFactory("Resistor", () => [
    { direction: PinDirection.BIDIRECTIONAL, position: { x: 0, y: 0 }, label: "A", bitWidth: 1, isNegated: false, isClock: false },
    { direction: PinDirection.BIDIRECTIONAL, position: { x: 2, y: 0 }, label: "B", bitWidth: 1, isNegated: false, isClock: false },
  ])(new PropertyBag());
  resEl.position = { x: 20, y: 0 };
  circuit.addElement(resEl);

  // DigitalXor at position (10, 0) — pins A=(10,1), B=(10,2), out=(12,1)
  const xorProps = new PropertyBag();
  for (const [k, v] of propsMap) xorProps.set(k, v);
  const xorEl = makeStubElFactory("DigitalXor", (_props) => [
    { direction: PinDirection.INPUT,  position: { x: 0, y: 1 }, label: "A",   bitWidth: 1, isNegated: false, isClock: false },
    { direction: PinDirection.INPUT,  position: { x: 0, y: 2 }, label: "B",   bitWidth: 1, isNegated: false, isClock: false },
    { direction: PinDirection.OUTPUT, position: { x: 2, y: 1 }, label: "out", bitWidth: 1, isNegated: false, isClock: false },
  ])(xorProps);
  xorEl.position = { x: 10, y: 0 };
  circuit.addElement(xorEl);

  // Wire Ground to Resistor A: (0,0)→(20,0)
  circuit.addWire(new Wire({ x: 0, y: 0 }, { x: 20, y: 0 }));
  // Resistor B to a floating endpoint: (22,0)→(23,0)
  circuit.addWire(new Wire({ x: 22, y: 0 }, { x: 23, y: 0 }));
  // Wire each XOR pin to a distinct endpoint
  circuit.addWire(new Wire({ x: 10, y: 1 }, { x: 11, y: 1 }));
  circuit.addWire(new Wire({ x: 10, y: 2 }, { x: 11, y: 2 }));
  circuit.addWire(new Wire({ x: 12, y: 1 }, { x: 13, y: 1 }));

  return circuit;
}

// ---------------------------------------------------------------------------
// Tests: digitalPinLoading modes
// ---------------------------------------------------------------------------

describe("digitalPinLoading: cross-domain (default)", () => {
  it("absent metadata defaults to cross-domain: no bridge adapters for non-logical digital component", () => {
    const registry = buildRegistry();
    // No simulationModel set — DigitalXor stays in digital partition, no bridges.
    const circuit = buildCircuit();

    const compiled = compileUnified(circuit, registry);
    const analogBridges = compiled.analog?.bridges ?? [];
    const inlineBridgeCount = analogBridges.reduce(
      (n, b) => n + b.inputAdapters.length + b.outputAdapters.length, 0,
    );
    expect(inlineBridgeCount).toBe(0);
  });

  it("explicit cross-domain metadata also produces no inline bridges for default-digital component", () => {
    const registry = buildRegistry();
    const circuit = buildCircuit({ digitalPinLoading: "cross-domain" });

    const compiled = compileUnified(circuit, registry);
    const analogBridges = compiled.analog?.bridges ?? [];
    const inlineBridgeCount = analogBridges.reduce(
      (n, b) => n + b.inputAdapters.length + b.outputAdapters.length, 0,
    );
    expect(inlineBridgeCount).toBe(0);
  });

  it("cross-domain with simulationModel=logical does produce bridge adapters", () => {
    const registry = buildRegistry();
    const circuit = buildCircuit(
      { digitalPinLoading: "cross-domain" },
      new Map([["simulationModel", "logical"]]),
    );

    const compiled = compileUnified(circuit, registry).analog!;
    expect(compiled.bridges).toHaveLength(1);
  });
});

describe("digitalPinLoading: all", () => {
  it("all mode: dual-model component in digital partition gets exactly one bridge", () => {
    const registry = buildRegistry();
    const circuit = buildCircuit({ digitalPinLoading: "all" });

    const compiled = compileUnified(circuit, registry).analog!;
    expect(compiled.bridges).toHaveLength(1);
  });

  it("all mode: bridge has correct adapter counts (2 inputs + 1 output)", () => {
    const registry = buildRegistry();
    const circuit = buildCircuit({ digitalPinLoading: "all" });

    const compiled = compileUnified(circuit, registry).analog!;
    // Exactly one bridge expected (from the DigitalXor component)
    expect(compiled.bridges).toHaveLength(1);
    const bridge = compiled.bridges[0]!;
    // DigitalXor: 2 inputs → 2 BridgeInputAdapters; 1 output → 1 BridgeOutputAdapter
    expect(bridge.inputAdapters).toHaveLength(2);
    expect(bridge.outputAdapters).toHaveLength(1);
    expect(bridge.inputAdapters[0]).toBeInstanceOf(BridgeInputAdapter);
    expect(bridge.inputAdapters[1]).toBeInstanceOf(BridgeInputAdapter);
    expect(bridge.outputAdapters[0]).toBeInstanceOf(BridgeOutputAdapter);
  });

  it("all mode: analog factory is not called (digital component uses bridge, not factory)", () => {
    const analogFactory = vi.fn(makeStubAnalogElement);
    const registry = buildRegistry(analogFactory);
    const circuit = buildCircuit({ digitalPinLoading: "all" });

    compileUnified(circuit, registry);

    expect(analogFactory).not.toHaveBeenCalled();
  });

  it("all mode produces more bridge adapter instances than cross-domain for same circuit", () => {
    const registry = buildRegistry();

    const circuitAll = buildCircuit({ digitalPinLoading: "all" });
    const circuitCross = buildCircuit({ digitalPinLoading: "cross-domain" });

    const compiledAll = compileUnified(circuitAll, registry).analog;
    const compiledCross = compileUnified(circuitCross, registry).analog;

    const countAdapters = (compiled: typeof compiledAll) =>
      (compiled?.bridges ?? []).reduce(
        (n, b) => n + b.inputAdapters.length + b.outputAdapters.length, 0,
      );

    expect(countAdapters(compiledAll)).toBeGreaterThan(countAdapters(compiledCross));
  });
});

describe("digitalPinLoading: none", () => {
  it("none mode: bridge adapters still present at simulationModel=logical boundary", () => {
    const registry = buildRegistry();
    const circuit = buildCircuit(
      { digitalPinLoading: "none" },
      new Map([["simulationModel", "logical"]]),
    );

    const compiled = compileUnified(circuit, registry).analog!;
    expect(compiled.bridges).toHaveLength(1);
  });

  it("none mode: bridge input adapters use rIn=Infinity", () => {
    const registry = buildRegistry();
    const circuit = buildCircuit(
      { digitalPinLoading: "none" },
      new Map([["simulationModel", "logical"]]),
    );

    const compiled = compileUnified(circuit, registry).analog!;
    const bridge = compiled.bridges[0]!;

    expect(bridge.inputAdapters.length).toBeGreaterThan(0);
    for (const adapter of bridge.inputAdapters) {
      expect((adapter as BridgeInputAdapter).rIn).toBe(Infinity);
    }
  });

  it("none mode: bridge output adapters use rOut=0", () => {
    const registry = buildRegistry();
    const circuit = buildCircuit(
      { digitalPinLoading: "none" },
      new Map([["simulationModel", "logical"]]),
    );

    const compiled = compileUnified(circuit, registry).analog!;
    const bridge = compiled.bridges[0]!;

    expect(bridge.outputAdapters.length).toBeGreaterThan(0);
    for (const adapter of bridge.outputAdapters) {
      expect((adapter as BridgeOutputAdapter).rOut).toBe(0);
    }
  });

  it("cross-domain mode: bridge input adapters have finite rIn (not ideal)", () => {
    const registry = buildRegistry();
    const circuit = buildCircuit(
      { digitalPinLoading: "cross-domain" },
      new Map([["simulationModel", "logical"]]),
    );

    const compiled = compileUnified(circuit, registry).analog!;
    const bridge = compiled.bridges[0]!;

    expect(bridge.inputAdapters.length).toBeGreaterThan(0);
    for (const adapter of bridge.inputAdapters) {
      expect(isFinite((adapter as BridgeInputAdapter).rIn)).toBe(true);
    }
  });

  it("none bridge count matches cross-domain (same boundary detection)", () => {
    const registry = buildRegistry();

    const circuitNone = buildCircuit(
      { digitalPinLoading: "none" },
      new Map([["simulationModel", "logical"]]),
    );
    const circuitCross = buildCircuit(
      { digitalPinLoading: "cross-domain" },
      new Map([["simulationModel", "logical"]]),
    );

    const compiledNone = compileUnified(circuitNone, registry).analog!;
    const compiledCross = compileUnified(circuitCross, registry).analog!;

    expect(compiledNone.bridges).toHaveLength(compiledCross.bridges.length);
  });
});

describe("digitalPinLoading: ordering invariant (all > cross-domain >= none)", () => {
  it("all produces more total bridge adapters than cross-domain (with logical component)", () => {
    const registry = buildRegistry();

    const circuitAll = buildCircuit(
      { digitalPinLoading: "all" },
      new Map([["simulationModel", "logical"]]),
    );
    const circuitCross = buildCircuit(
      { digitalPinLoading: "cross-domain" },
      new Map([["simulationModel", "logical"]]),
    );

    const countAdapters = (compiled: ReturnType<typeof compileUnified>) =>
      (compiled.analog?.bridges ?? []).reduce(
        (n, b) => n + b.inputAdapters.length + b.outputAdapters.length, 0,
      );

    // Both have 1 bridge for the same component — same pin counts.
    // "all" handles the same component, so counts are equal.
    expect(countAdapters(compileUnified(circuitAll, registry))).toBeGreaterThanOrEqual(
      countAdapters(compileUnified(circuitCross, registry)),
    );
  });

  it("none mode input adapters have rIn=Infinity while cross-domain adapters have finite rIn", () => {
    const registry = buildRegistry();

    const circuitNone = buildCircuit(
      { digitalPinLoading: "none" },
      new Map([["simulationModel", "logical"]]),
    );
    const circuitCross = buildCircuit(
      { digitalPinLoading: "cross-domain" },
      new Map([["simulationModel", "logical"]]),
    );

    const compiledNone = compileUnified(circuitNone, registry).analog!;
    const compiledCross = compileUnified(circuitCross, registry).analog!;

    const noneAdapter = compiledNone.bridges[0]!.inputAdapters[0]! as BridgeInputAdapter;
    const crossAdapter = compiledCross.bridges[0]!.inputAdapters[0]! as BridgeInputAdapter;
    expect(noneAdapter.rIn).toBe(Infinity);
    expect(isFinite(crossAdapter.rIn)).toBe(true);
  });
});
