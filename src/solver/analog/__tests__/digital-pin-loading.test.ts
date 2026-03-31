/**
 * Tests for the digitalPinLoading circuit metadata field.
 *
 * Verifies that the three loading modes produce the correct bridge adapter
 * behaviour when compiling a mixed digital/analog circuit:
 *
 *   cross-domain (default): bridge adapters only at real cross-engine
 *                            boundaries (groups that have both digital and
 *                            analog pins from real boundary components).
 *   all:                     bridge adapters on EVERY digital net — digital-
 *                            only groups receive an injected "analog" domain
 *                            entry so each net gets a per-net bridge.
 *   none:                    bridges at real boundaries only, with zero
 *                            loading (BridgeInputAdapter stamps nothing,
 *                            cIn=0, cOut=0).
 *
 * Bridge count is measured per-net (one BridgeAdapter per boundary group),
 * not per-component. Components never change partition based on loading mode.
 *
 * The tests use a stub registry with Ground, In, Out, a Resistor (MNA-only),
 * and a DigitalXor (digital + mna behavioral models). The Resistor forces
 * an analog partition so bridge synthesis can run.
 */

import { describe, it, expect, vi } from "vitest";
import { Circuit, Wire } from "../../../core/circuit.js";
import type { CircuitElement } from "../../../core/element.js";
import type { Pin, PinDeclaration } from "../../../core/pin.js";
import { PinDirection } from "../../../core/pin.js";
import { PropertyBag, PropertyType } from "../../../core/properties.js";
import type { PropertyValue } from "../../../core/properties.js";
import type { Rect, RenderContext } from "../../../core/renderer-interface.js";
import { ComponentRegistry, ComponentCategory } from "../../../core/registry.js";
import type { ExecuteFunction } from "../../../core/registry.js";
import type { AnalogElement } from "../element.js";
import type { SparseSolver } from "../sparse-solver.js";
import { BridgeOutputAdapter, BridgeInputAdapter } from "../bridge-adapter.js";
import { compileUnified } from "@/compile/compile.js";
import type { ConcreteCompiledAnalogCircuit } from "../compiled-analog-circuit.js";

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
      return { typeId, instanceId: (this as unknown as { instanceId: string }).instanceId ?? '', position: { x: 0, y: 0 }, rotation: 0, mirror: false, properties: {} };
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
    setParam(_key: string, _value: number): void {},
    getPinCurrents(_v: Float64Array): number[] { return []; },
  };
}

// ---------------------------------------------------------------------------
// Registry builder
//
// Includes: Ground, In, Out, Resistor (MNA-only), DigitalXor (digital + behavioral)
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
    models: {},
    modelRegistry: {
      behavioral: { kind: 'inline' as const, factory: () => ({
        pinNodeIds: [],
        allNodeIds: [],
        branchIndex: -1,
        isNonlinear: false,
        isReactive: false,
        stamp() {},
        setParam(_k: string, _v: number): void {},
        getPinCurrents(_v: Float64Array): number[] { return []; },
      }), paramDefs: [], params: {} },
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
      kind: "signal",
    }]),
    pinLayout: [{
      label: "out",
      direction: PinDirection.OUTPUT,
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    }],
    propertyDefs: [{ key: "label", type: PropertyType.STRING, label: "Label", defaultValue: "" }, { key: "bitWidth", type: PropertyType.INT, label: "Bit Width", defaultValue: 1 }],
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
      kind: "signal",
    }]),
    pinLayout: [{
      label: "in",
      direction: PinDirection.INPUT,
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    }],
    propertyDefs: [{ key: "label", type: PropertyType.STRING, label: "Label", defaultValue: "" }, { key: "bitWidth", type: PropertyType.INT, label: "Bit Width", defaultValue: 1 }],
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
      { direction: PinDirection.BIDIRECTIONAL, position: { x: 0, y: 0 }, label: "A", bitWidth: 1, isNegated: false, isClock: false, kind: "signal" },
      { direction: PinDirection.BIDIRECTIONAL, position: { x: 2, y: 0 }, label: "B", bitWidth: 1, isNegated: false, isClock: false, kind: "signal" },
    ]),
    pinLayout: [
      { label: "A", direction: PinDirection.BIDIRECTIONAL, defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
      { label: "B", direction: PinDirection.BIDIRECTIONAL, defaultBitWidth: 1, position: { x: 2, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    ],
    propertyDefs: [{ key: "resistance", type: PropertyType.FLOAT, label: "Resistance", defaultValue: 1000 }],
    attributeMap: [],
    category: ComponentCategory.PASSIVES,
    helpText: "",
    defaultModel: "behavioral",
    models: {},
    modelRegistry: {
      behavioral: { kind: 'inline' as const, factory: (pinNodes) => makeStubAnalogElement(pinNodes), paramDefs: [], params: {} },
    },
  });

  const xorPinLayout: PinDeclaration[] = [
    { label: "A",   direction: PinDirection.INPUT,  defaultBitWidth: 1, position: { x: 0, y: 1 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { label: "B",   direction: PinDirection.INPUT,  defaultBitWidth: 1, position: { x: 0, y: 2 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { label: "out", direction: PinDirection.OUTPUT, defaultBitWidth: 1, position: { x: 2, y: 1 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  ];
  registry.register({
    name: "DigitalXor",
    typeId: -1,
    factory: makeStubElFactory("DigitalXor", (_props) => [
      { direction: PinDirection.INPUT,  position: { x: 0, y: 1 }, label: "A",   bitWidth: 1, isNegated: false, isClock: false, kind: "signal" },
      { direction: PinDirection.INPUT,  position: { x: 0, y: 2 }, label: "B",   bitWidth: 1, isNegated: false, isClock: false, kind: "signal" },
      { direction: PinDirection.OUTPUT, position: { x: 2, y: 1 }, label: "out", bitWidth: 1, isNegated: false, isClock: false, kind: "signal" },
    ]),
    pinLayout: xorPinLayout,
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.LOGIC,
    helpText: "",
    models: {
      digital: { executeFn: noopExecuteFn as unknown as ExecuteFunction },
    },
    modelRegistry: {
      behavioral: { kind: 'inline' as const, factory: (analogFactory ?? makeStubAnalogElement) as import("../../../core/registry.js").AnalogFactory, paramDefs: [], params: {} },
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
//   - DigitalXor at (10,0) — component under test (digital + behavioral)
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
    kind: "signal",
  }])(new PropertyBag());
  gndEl.position = { x: 0, y: 0 };
  circuit.addElement(gndEl);

  // Resistor at position (20, 0) — pin A at world (20,0), pin B at world (22,0)
  const resEl = makeStubElFactory("Resistor", () => [
    { direction: PinDirection.BIDIRECTIONAL, position: { x: 0, y: 0 }, label: "A", bitWidth: 1, isNegated: false, isClock: false, kind: "signal" },
    { direction: PinDirection.BIDIRECTIONAL, position: { x: 2, y: 0 }, label: "B", bitWidth: 1, isNegated: false, isClock: false, kind: "signal" },
  ])(new PropertyBag());
  resEl.position = { x: 20, y: 0 };
  circuit.addElement(resEl);

  // DigitalXor at position (10, 0) — pins A=(10,1), B=(10,2), out=(12,1)
  const xorProps = new PropertyBag();
  for (const [k, v] of propsMap) xorProps.set(k, v);
  const xorEl = makeStubElFactory("DigitalXor", (_props) => [
    { direction: PinDirection.INPUT,  position: { x: 0, y: 1 }, label: "A",   bitWidth: 1, isNegated: false, isClock: false, kind: "signal" },
    { direction: PinDirection.INPUT,  position: { x: 0, y: 2 }, label: "B",   bitWidth: 1, isNegated: false, isClock: false, kind: "signal" },
    { direction: PinDirection.OUTPUT, position: { x: 2, y: 1 }, label: "out", bitWidth: 1, isNegated: false, isClock: false, kind: "signal" },
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
// Helper: count total bridge adapters across all boundary groups in the
// analog domain's bridgeAdaptersByGroupId map.
// ---------------------------------------------------------------------------

function countBridgeAdapters(analogDomain: ConcreteCompiledAnalogCircuit | null): number {
  if (analogDomain === null) return 0;
  let count = 0;
  for (const adapters of analogDomain.bridgeAdaptersByGroupId.values()) {
    count += adapters.length;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Tests: digitalPinLoading modes
// ---------------------------------------------------------------------------

describe("digitalPinLoading: cross-domain (default)", () => {
  it("absent metadata defaults to cross-domain: no per-net bridges for isolated digital nets", () => {
    const registry = buildRegistry();
    // No model set — DigitalXor stays digital-only, no analog boundary.
    // "cross-domain" only bridges real cross-domain boundaries, so zero bridges.
    const circuit = buildCircuit();

    const compiled = compileUnified(circuit, registry);
    expect(compiled.bridges).toHaveLength(0);
  });

  it("explicit cross-domain metadata produces no bridges for isolated digital-only nets", () => {
    const registry = buildRegistry();
    const circuit = buildCircuit({ digitalPinLoading: "cross-domain" });

    const compiled = compileUnified(circuit, registry);
    expect(compiled.bridges).toHaveLength(0);
  });

});

describe("digitalPinLoading: all", () => {
  it("all mode: produces per-net bridges on digital nets (more bridges than cross-domain)", () => {
    // "all" injects "analog" into every digital-only net, so isolated digital
    // nets also get bridge entries. "cross-domain" has none for this circuit.
    const registry = buildRegistry();
    const circuitAll   = buildCircuit({ digitalPinLoading: "all" });
    const circuitCross = buildCircuit({ digitalPinLoading: "cross-domain" });

    const compiledAll   = compileUnified(circuitAll, registry);
    const compiledCross = compileUnified(circuitCross, registry);

    expect(compiledAll.bridges.length).toBeGreaterThan(compiledCross.bridges.length);
  });

  it("all mode: bridge adapters are stored in bridgeAdaptersByGroupId (per-net, not per-component)", () => {
    const registry = buildRegistry();
    const circuit = buildCircuit({ digitalPinLoading: "all" });

    const compiled = compileUnified(circuit, registry);
    const analogDomain = compiled.analog as ConcreteCompiledAnalogCircuit | null;

    expect(analogDomain).not.toBeNull();
    // One boundary group per digital net — DigitalXor has 3 pins → 3 nets.
    expect(analogDomain!.bridgeAdaptersByGroupId.size).toBeGreaterThan(0);
  });

  it("all mode: each bridge group contains BridgeInputAdapter or BridgeOutputAdapter instances", () => {
    const registry = buildRegistry();
    const circuit = buildCircuit({ digitalPinLoading: "all" });

    const compiled = compileUnified(circuit, registry);
    const analogDomain = compiled.analog as ConcreteCompiledAnalogCircuit | null;

    expect(analogDomain).not.toBeNull();
    for (const adapters of analogDomain!.bridgeAdaptersByGroupId.values()) {
      expect(adapters.length).toBeGreaterThan(0);
      for (const adapter of adapters) {
        const isBridge = adapter instanceof BridgeInputAdapter || adapter instanceof BridgeOutputAdapter;
        expect(isBridge).toBe(true);
      }
    }
  });

  it("all mode produces more bridge adapter instances than cross-domain for same circuit", () => {
    const registry = buildRegistry();

    const circuitAll   = buildCircuit({ digitalPinLoading: "all" });
    const circuitCross = buildCircuit({ digitalPinLoading: "cross-domain" });

    const compiledAll   = compileUnified(circuitAll, registry);
    const compiledCross = compileUnified(circuitCross, registry);

    expect(countBridgeAdapters(compiledAll.analog as ConcreteCompiledAnalogCircuit | null)).toBeGreaterThan(
      countBridgeAdapters(compiledCross.analog as ConcreteCompiledAnalogCircuit | null),
    );
  });

  it("all mode: analog factory is not called when component has bridge adapters", () => {
    const analogFactory = vi.fn(makeStubAnalogElement);
    const registry = buildRegistry(analogFactory);
    const circuit = buildCircuit({ digitalPinLoading: "all" });

    compileUnified(circuit, registry);

    // The DigitalXor component is handled by bridge adapters, not analog factory.
    expect(analogFactory).not.toHaveBeenCalled();
  });
});

describe("digitalPinLoading: none", () => {
  it("none mode: no per-net bridges on isolated digital-only nets (same count as cross-domain)", () => {
    // "none" does not inject "analog" into digital-only nets. Only real
    // cross-domain boundaries get bridges — with zero loading applied.
    const registry = buildRegistry();
    const circuitNone  = buildCircuit({ digitalPinLoading: "none" });
    const circuitCross = buildCircuit({ digitalPinLoading: "cross-domain" });

    const compiledNone  = compileUnified(circuitNone, registry);
    const compiledCross = compileUnified(circuitCross, registry);

    expect(compiledNone.bridges).toHaveLength(compiledCross.bridges.length);
  });

  it("none mode bridge count equals cross-domain bridge count (same boundary detection)", () => {
    const registry = buildRegistry();

    const circuitNone  = buildCircuit(
      { digitalPinLoading: "none" },
      new Map([["model", "digital"]]),
    );
    const circuitCross = buildCircuit(
      { digitalPinLoading: "cross-domain" },
      new Map([["model", "digital"]]),
    );

    const compiledNone  = compileUnified(circuitNone, registry);
    const compiledCross = compileUnified(circuitCross, registry);

    expect(compiledNone.bridges).toHaveLength(compiledCross.bridges.length);
  });
});

describe("digitalPinLoading: ordering invariant (all > cross-domain >= none)", () => {
  it("all produces more bridges than cross-domain for circuit with only isolated digital nets", () => {
    const registry = buildRegistry();

    const circuitAll   = buildCircuit({ digitalPinLoading: "all" });
    const circuitCross = buildCircuit({ digitalPinLoading: "cross-domain" });

    const compiledAll   = compileUnified(circuitAll, registry);
    const compiledCross = compileUnified(circuitCross, registry);

    expect(compiledAll.bridges.length).toBeGreaterThan(compiledCross.bridges.length);
  });

  it("cross-domain and none produce the same bridge count for the same circuit", () => {
    const registry = buildRegistry();

    const circuitNone  = buildCircuit({ digitalPinLoading: "none" });
    const circuitCross = buildCircuit({ digitalPinLoading: "cross-domain" });

    const compiledNone  = compileUnified(circuitNone, registry);
    const compiledCross = compileUnified(circuitCross, registry);

    expect(compiledNone.bridges.length).toBe(compiledCross.bridges.length);
  });

  it("all mode: BridgeInputAdapter and BridgeOutputAdapter both appear in bridgeAdaptersByGroupId", () => {
    // DigitalXor has 2 inputs and 1 output; both adapter types must be present.
    const registry = buildRegistry();
    const circuit = buildCircuit({ digitalPinLoading: "all" });

    const compiled = compileUnified(circuit, registry);
    const analogDomain = compiled.analog as ConcreteCompiledAnalogCircuit | null;

    expect(analogDomain).not.toBeNull();

    let hasInput = false;
    let hasOutput = false;
    for (const adapters of analogDomain!.bridgeAdaptersByGroupId.values()) {
      for (const adapter of adapters) {
        if (adapter instanceof BridgeInputAdapter) hasInput = true;
        if (adapter instanceof BridgeOutputAdapter) hasOutput = true;
      }
    }
    expect(hasInput).toBe(true);
    expect(hasOutput).toBe(true);
  });
});
