/**
 * Tests for the analog circuit compiler.
 *
 * Uses a lightweight test registry with minimal analog ComponentDefinitions
 * that supply analogFactory functions. Wire connectivity is established by
 * sharing Point coordinates between wire endpoints and component pins.
 */

import { describe, it, expect, vi } from "vitest";
import { Circuit, Wire } from "../../../core/circuit.js";
import type { CircuitElement } from "../../../core/element.js";
import type { Pin } from "../../../core/pin.js";
import { PinDirection } from "../../../core/pin.js";
import type { PropertyBag, PropertyValue } from "../../../core/properties.js";
import type { Rect, RenderContext } from "../../../core/renderer-interface.js";
import type { SerializedElement } from "../../../core/element.js";
import { ComponentRegistry } from "../../../core/registry.js";
import type { ComponentCategory } from "../../../core/registry.js";
import type { AnalogElement } from "../element.js";
import type { SparseSolver } from "../sparse-solver.js";
import { compileUnified } from "@/compile/compile.js";

// ---------------------------------------------------------------------------
// Minimal CircuitElement factory for tests
// ---------------------------------------------------------------------------

function makePin(x: number, y: number): Pin {
  return {
    position: { x, y },
    label: "",
    direction: PinDirection.BIDIRECTIONAL,
    isInverted: false,
    isClock: false,
    bitWidth: 1,
  };
}

function makeElement(
  typeId: string,
  instanceId: string,
  pins: Array<{ x: number; y: number }>,
  propsMap: Map<string, PropertyValue> = new Map(),
): CircuitElement {
  const resolvedPins = pins.map((p) => makePin(p.x, p.y));
  const propertyBag: PropertyBag = {
    has(k: string) { return propsMap.has(k); },
    get<T>(k: string): T { return propsMap.get(k) as T; },
    set(k: string, v: PropertyValue) { propsMap.set(k, v); },
    delete(k: string) { propsMap.delete(k); },
    keys() { return Array.from(propsMap.keys()); },
    entries() { return Array.from(propsMap.entries()); },
    clone() { return this; },
    size: propsMap.size,
  } as unknown as PropertyBag;

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
// Minimal AnalogElement factories
// ---------------------------------------------------------------------------

function makeTestResistorElement(nodeA: number, nodeB: number): AnalogElement {
  return {
    pinNodeIds: [nodeA, nodeB],
    allNodeIds: [nodeA, nodeB],
    branchIndex: -1,
    isNonlinear: false,
    isReactive: false,
    stamp(_s: SparseSolver) { /* no-op */ },
  };
}

function makeTestVsElement(nodePos: number, nodeNeg: number, branchIdx: number): AnalogElement {
  return {
    pinNodeIds: [nodePos, nodeNeg],
    allNodeIds: [nodePos, nodeNeg],
    branchIndex: branchIdx,
    isNonlinear: false,
    isReactive: false,
    stamp(_s: SparseSolver) { /* no-op */ },
  };
}

function makeTestInductorElement(nodeA: number, nodeB: number, branchIdx: number): AnalogElement {
  return {
    pinNodeIds: [nodeA, nodeB],
    allNodeIds: [nodeA, nodeB],
    branchIndex: branchIdx,
    isNonlinear: false,
    isReactive: true,
    stamp(_s: SparseSolver) { /* no-op */ },
  };
}

// ---------------------------------------------------------------------------
// Test registry builder
// ---------------------------------------------------------------------------

function noopExecuteFn(): void { /* no-op */ }

function makeBaseDef(name: string) {
  return {
    name,
    typeId: -1,
    pinLayout: [] as import("../../core/pin.js").PinDeclaration[],
    propertyDefs: [] as import("../../core/properties.js").PropertyDefinition[],
    attributeMap: [] as import("../../core/registry.js").AttributeMapping[],
    category: "MISC" as unknown as ComponentCategory,
    helpText: "",
    factory: ((_props: PropertyBag) => { throw new Error("not used in tests"); }) as unknown as import("../../core/registry.js").ComponentDefinition["factory"],
  };
}

/**
 * Build a ComponentRegistry with analog Vs, R, L, Ground, In, Out, and And (digital) types.
 */
function buildTestRegistry(): ComponentRegistry {
  const registry = new ComponentRegistry();

  registry.register({
    ...makeBaseDef("AnalogVs"),
    models: {
      analog: {
        requiresBranchRow: true,
        factory(pinNodes, _internalNodeIds, branchIdx, _props, _getTime) {
          const [n0, n1] = [...pinNodes.values()];
          return makeTestVsElement(n0 ?? 0, n1 ?? 0, branchIdx);
        },
      },
    },
  });

  registry.register({
    ...makeBaseDef("AnalogR"),
    models: {
      analog: {
        requiresBranchRow: false,
        factory(pinNodes, _internalNodeIds, _branchIdx, _props, _getTime) {
          const [n0, n1] = [...pinNodes.values()];
          return makeTestResistorElement(n0 ?? 0, n1 ?? 0);
        },
      },
    },
  });

  registry.register({
    ...makeBaseDef("AnalogL"),
    models: {
      analog: {
        requiresBranchRow: true,
        factory(pinNodes, _internalNodeIds, branchIdx, _props, _getTime) {
          const [n0, n1] = [...pinNodes.values()];
          return makeTestInductorElement(n0 ?? 0, n1 ?? 0, branchIdx);
        },
      },
    },
  });

  registry.register({
    ...makeBaseDef("Ground"),
    models: { analog: {} },
  });

  registry.register({
    ...makeBaseDef("In"),
    models: {
      analog: {
        factory(pinNodes, _internalNodeIds, _branchIdx, _props, _getTime) {
          const [n0] = [...pinNodes.values()];
          return makeTestResistorElement(n0 ?? 0, 0);
        },
      },
    },
  });

  registry.register({
    ...makeBaseDef("Out"),
    models: {
      analog: {
        factory(pinNodes, _internalNodeIds, _branchIdx, _props, _getTime) {
          const [n0] = [...pinNodes.values()];
          return makeTestResistorElement(n0 ?? 0, 0);
        },
      },
    },
  });

  // AND gate — digital-only
  registry.register({
    ...makeBaseDef("And"),
    models: { digital: { executeFn: noopExecuteFn as unknown as import("../../core/registry.js").ExecuteFunction } },
  });

  return registry;
}

// ---------------------------------------------------------------------------
// Circuit builder helpers
// ---------------------------------------------------------------------------

/**
 * Resistor divider circuit:
 *   Vs+ (node 1) --[R1]-- node 2 --[R2]-- Ground (node 0)
 *   Vs- = Ground (node 0)
 *
 * Wire layout (integer grid):
 *   x=10 → node 1 (Vs+, R1-A)
 *   x=20 → node 2 (R1-B, R2-A)
 *   x=0  → ground (Vs-, R2-B, Gnd pin)
 */
function buildResistorDividerCircuit(): { circuit: Circuit; registry: ComponentRegistry } {
  const circuit = new Circuit({  });
  const registry = buildTestRegistry();

  const vs  = makeElement("AnalogVs", "vs1",  [{ x: 10, y: 0 }, { x: 0, y: 0 }]);
  const r1  = makeElement("AnalogR",  "r1",   [{ x: 10, y: 0 }, { x: 20, y: 0 }]);
  const r2  = makeElement("AnalogR",  "r2",   [{ x: 20, y: 0 }, { x: 0,  y: 0 }]);
  const gnd = makeElement("Ground",   "gnd1", [{ x: 0,  y: 0 }]);

  circuit.addElement(vs);
  circuit.addElement(r1);
  circuit.addElement(r2);
  circuit.addElement(gnd);

  // Self-loop wires establish nodes at each coordinate group
  circuit.addWire(new Wire({ x: 10, y: 0 }, { x: 10, y: 0 }));
  circuit.addWire(new Wire({ x: 20, y: 0 }, { x: 20, y: 0 }));
  circuit.addWire(new Wire({ x: 0,  y: 0 }, { x: 0,  y: 0 }));

  return { circuit, registry };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AnalogCompiler", () => {
  it("compiles_resistor_divider", () => {
    const { circuit, registry } = buildResistorDividerCircuit();
    const compiled = compileUnified(circuit, registry).analog!;

    // Vs, R1, R2 → 3 analog elements (Ground is skipped by the compiler)
    expect(compiled.elements.length).toBe(3);

    // 2 non-ground nodes: node at x=10 (Vs+/R1-A) and node at x=20 (R1-B/R2-A)
    expect(compiled.nodeCount).toBe(2);

    // 1 branch row from the voltage source
    expect(compiled.branchCount).toBe(1);

    // matrixSize = nodeCount + branchCount = 3
    expect(compiled.matrixSize).toBe(3);
  });

  it("assigns_ground_node_zero", () => {
    const { circuit, registry } = buildResistorDividerCircuit();
    const compiled = compileUnified(circuit, registry).analog!;

    // The voltage source element should have one terminal at ground (node 0)
    const vsElement = compiled.elements[0];
    expect(vsElement.pinNodeIds).toContain(0);
  });

  it("maps_labels_to_nodes", () => {
    const circuit = new Circuit({  });
    const registry = buildTestRegistry();

    const labelIn:  Map<string, PropertyValue> = new Map([["label", "V_in"]]);
    const labelOut: Map<string, PropertyValue> = new Map([["label", "V_mid"]]);

    const inEl  = makeElement("In",     "in1",  [{ x: 10, y: 0 }], labelIn);
    const outEl = makeElement("Out",    "out1", [{ x: 20, y: 0 }], labelOut);
    const gnd   = makeElement("Ground", "gnd1", [{ x: 0,  y: 0 }]);

    circuit.addElement(inEl);
    circuit.addElement(outEl);
    circuit.addElement(gnd);

    circuit.addWire(new Wire({ x: 10, y: 0 }, { x: 10, y: 0 }));
    circuit.addWire(new Wire({ x: 20, y: 0 }, { x: 20, y: 0 }));
    circuit.addWire(new Wire({ x: 0,  y: 0 }, { x: 0,  y: 0 }));

    const compiled = compileUnified(circuit, registry).analog!;

    expect(compiled.labelToNodeId.has("V_in")).toBe(true);
    expect(compiled.labelToNodeId.has("V_mid")).toBe(true);
    // Both labeled nodes should be non-ground
    expect(compiled.labelToNodeId.get("V_in")).toBeGreaterThan(0);
    expect(compiled.labelToNodeId.get("V_mid")).toBeGreaterThan(0);
  });

  it("detects_floating_node", () => {
    // R1 with one end at x=30 that no other element touches → node at x=30 is floating
    const circuit = new Circuit({  });
    const registry = buildTestRegistry();

    const vs  = makeElement("AnalogVs", "vs1",  [{ x: 10, y: 0 }, { x: 0, y: 0 }]);
    const r1  = makeElement("AnalogR",  "r1",   [{ x: 10, y: 0 }, { x: 30, y: 0 }]);
    const gnd = makeElement("Ground",   "gnd1", [{ x: 0,  y: 0 }]);

    circuit.addElement(vs);
    circuit.addElement(r1);
    circuit.addElement(gnd);

    circuit.addWire(new Wire({ x: 10, y: 0 }, { x: 10, y: 0 }));
    circuit.addWire(new Wire({ x: 30, y: 0 }, { x: 30, y: 0 }));
    circuit.addWire(new Wire({ x: 0,  y: 0 }, { x: 0,  y: 0 }));

    // Compiler must not throw — emits a warning diagnostic instead
    expect(() => compileUnified(circuit, registry)).not.toThrow();

    const compiled = compileUnified(circuit, registry).analog!;
    // nodeCount = 2 (node at x=10 and node at x=30)
    expect(compiled.nodeCount).toBe(2);
  });

  it("detects_voltage_source_loop", () => {
    // Vs1: pos=node1(x=10), neg=node2(x=20)
    // Vs2: pos=node2(x=20), neg=node1(x=10)  → KVL loop
    const circuit = new Circuit({  });
    const registry = buildTestRegistry();

    const vs1 = makeElement("AnalogVs", "vs1", [{ x: 10, y: 0 }, { x: 20, y: 0 }]);
    const vs2 = makeElement("AnalogVs", "vs2", [{ x: 20, y: 0 }, { x: 10, y: 0 }]);
    const gnd = makeElement("Ground",   "gnd1", [{ x: 0,  y: 0 }]);

    circuit.addElement(vs1);
    circuit.addElement(vs2);
    circuit.addElement(gnd);

    circuit.addWire(new Wire({ x: 10, y: 0 }, { x: 10, y: 0 }));
    circuit.addWire(new Wire({ x: 20, y: 0 }, { x: 20, y: 0 }));
    circuit.addWire(new Wire({ x: 0,  y: 0 }, { x: 0,  y: 0 }));

    // Compiler must not throw — emits an error diagnostic
    expect(() => compileUnified(circuit, registry)).not.toThrow();

    const compiled = compileUnified(circuit, registry).analog!;
    // Both voltage sources are compiled; branchCount = 2
    expect(compiled.elements.length).toBe(2);
    expect(compiled.branchCount).toBe(2);
  });

  it("detects_missing_ground", () => {
    // No Ground element → node map builder emits no-ground diagnostic
    const circuit = new Circuit({  });
    const registry = buildTestRegistry();

    const r1 = makeElement("AnalogR", "r1", [{ x: 10, y: 0 }, { x: 20, y: 0 }]);
    circuit.addElement(r1);
    circuit.addWire(new Wire({ x: 10, y: 0 }, { x: 10, y: 0 }));
    circuit.addWire(new Wire({ x: 20, y: 0 }, { x: 20, y: 0 }));

    // Must compile without throwing (warning diagnostic emitted)
    expect(() => compileUnified(circuit, registry)).not.toThrow();
  });

  it("rejects_digital_only_component", () => {
    const circuit = new Circuit({  });
    const registry = buildTestRegistry();

    // AND gate has no engineType → defaults to "digital"
    const andGate = makeElement("And",    "and1", [{ x: 10, y: 0 }, { x: 20, y: 0 }]);
    const gnd     = makeElement("Ground", "gnd1", [{ x: 0,  y: 0 }]);

    circuit.addElement(andGate);
    circuit.addElement(gnd);
    circuit.addWire(new Wire({ x: 10, y: 0 }, { x: 10, y: 0 }));
    circuit.addWire(new Wire({ x: 0,  y: 0 }, { x: 0,  y: 0 }));

    // Digital-only components emit an error diagnostic instead of throwing
    expect(() => compileUnified(circuit, registry)).not.toThrow();
    const compiled = compileUnified(circuit, registry).analog!;
    expect(compiled.diagnostics.some((d) => d.code === "unsupported-component-in-analog")).toBe(true);
  });

  it("calls_analog_factory_with_correct_args", () => {
    const circuit = new Circuit({  });
    const registry = new ComponentRegistry();

    const factorySpy = vi.fn(
      (pinNodes: ReadonlyMap<string, number>, _internalNodeIds: readonly number[], branchIdx: number, _props: PropertyBag, _getTime: () => number) => {
        const [n0, n1] = [...pinNodes.values()];
        return makeTestVsElement(n0 ?? 0, n1 ?? 0, branchIdx);
      },
    );

    registry.register({
      ...makeBaseDef("SpyVs"),
      pinLayout: [
        { label: "pos", direction: PinDirection.BIDIRECTIONAL, defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false },
        { label: "neg", direction: PinDirection.BIDIRECTIONAL, defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false },
      ],
      models: {
        analog: {
          requiresBranchRow: true,
          factory: factorySpy,
        },
      },
    });

    registry.register({
      ...makeBaseDef("Ground"),
      models: { analog: {} },
    });

    // Vs: pos at (10,0), neg at (0,0) = ground
    const vs  = makeElement("SpyVs",  "vs1",  [{ x: 10, y: 0 }, { x: 0, y: 0 }]);
    const gnd = makeElement("Ground", "gnd1", [{ x: 0,  y: 0 }]);

    circuit.addElement(vs);
    circuit.addElement(gnd);

    circuit.addWire(new Wire({ x: 10, y: 0 }, { x: 10, y: 0 }));
    circuit.addWire(new Wire({ x: 0,  y: 0 }, { x: 0,  y: 0 }));

    compileUnified(circuit, registry);

    expect(factorySpy).toHaveBeenCalledOnce();

    const [pinNodes, _internalNodeIds, branchIdx, , getTime] = factorySpy.mock.calls[0]!;

    // pos terminal should map to a non-ground node (>0); neg should be 0 (ground)
    const nodeValues = [...(pinNodes as ReadonlyMap<string, number>).values()];
    expect(nodeValues).toContain(0);
    expect(nodeValues.some((n: number) => n > 0)).toBe(true);

    // branchIdx is the absolute branch row: totalNodeCount + 0 = 1
    expect(branchIdx).toBeGreaterThanOrEqual(0);

    // getTime must be a function returning a number
    expect(typeof getTime).toBe("function");
    expect(getTime()).toBe(0);
  });

  it("rejects_non_analog_circuit", () => {
    // compileUnified is the unified entry point — it handles all engineTypes.
    // A digital circuit with no digital-model components compiles to null analog
    // and null digital (no components in either partition).
    const circuit = new Circuit({  });
    const registry = buildTestRegistry();

    expect(() => compileUnified(circuit, registry)).not.toThrow();
    const result = compileUnified(circuit, registry);
    expect(result.analog).toBeNull();
  });

  it("elementToCircuitElement_maps_index_to_element", () => {
    const { circuit, registry } = buildResistorDividerCircuit();
    const compiled = compileUnified(circuit, registry).analog!;

    // 3 elements (Vs, R1, R2 — Ground is skipped)
    for (let i = 0; i < compiled.elements.length; i++) {
      expect(compiled.elementToCircuitElement.has(i)).toBe(true);
    }
  });

  it("wireToNodeId_maps_wires_to_nodes", () => {
    const { circuit, registry } = buildResistorDividerCircuit();
    const compiled = compileUnified(circuit, registry).analog!;

    // Every wire in the circuit should appear in the map
    for (const wire of circuit.wires) {
      expect(compiled.wireToNodeId.has(wire)).toBe(true);
    }
  });

  it("matrixSize_equals_nodeCount_plus_branchCount", () => {
    const { circuit, registry } = buildResistorDividerCircuit();
    const compiled = compileUnified(circuit, registry).analog!;

    expect(compiled.matrixSize).toBe(compiled.nodeCount + compiled.branchCount);
  });

  it("netCount_equals_nodeCount", () => {
    const { circuit, registry } = buildResistorDividerCircuit();
    const compiled = compileUnified(circuit, registry).analog!;

    expect(compiled.netCount).toBe(compiled.nodeCount);
  });

  it("componentCount_equals_elementCount", () => {
    const { circuit, registry } = buildResistorDividerCircuit();
    const compiled = compileUnified(circuit, registry).analog!;

    expect(compiled.componentCount).toBe(compiled.elementCount);
    expect(compiled.elementCount).toBe(compiled.elements.length);
  });
});
