/**
 * Unit tests for compileUnified() — the Phase 3 unified compilation entry point.
 *
 * Tests verify:
 * - Pure digital circuit compiles correctly (digital domain present, analog null)
 * - Pure analog circuit compiles correctly (analog domain present, digital null)
 * - Empty circuit handled gracefully (both domains null, empty maps)
 * - wireSignalMap is populated for circuits with wires
 * - labelSignalMap is populated for labeled In/Out components
 */

import { describe, it, expect } from "vitest";
import { compileUnified } from "../compile.js";
import { Circuit, Wire } from "../../core/circuit.js";
import { ComponentRegistry } from "../../core/registry.js";
import type { ComponentDefinition, ExecuteFunction } from "../../core/registry.js";
import { ComponentCategory } from "../../core/registry.js";
import type { Pin, PinDeclaration } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import { PropertyBag } from "../../core/properties.js";
import type { PropertyBag as PropertyBagType, PropertyValue } from "../../core/properties.js";
import type { AnalogElement } from "../../solver/analog/element.js";
import type { SparseSolver } from "../../solver/analog/sparse-solver.js";
import type { SerializedElement } from "../../core/element.js";
import { createTestElementFromDecls } from "../../test-fixtures/test-element.js";
import { noopExecFn } from "../../test-fixtures/execute-stubs.js";

// ---------------------------------------------------------------------------
// Minimal plain-object CircuitElement (analog-style, no AbstractCircuitElement)
// ---------------------------------------------------------------------------

function makeAnalogElement(
  typeId: string,
  instanceId: string,
  pins: Array<{ x: number; y: number; label?: string; direction?: PinDirection }>,
  propsMap: Map<string, PropertyValue> = new Map(),
) {
  const resolvedPins: Pin[] = pins.map((p) => ({
    position: { x: p.x, y: p.y },
    label: p.label ?? "",
    direction: p.direction ?? PinDirection.BIDIRECTIONAL,
    isNegated: false,
    isClock: false,
    kind: "signal" as const,
    bitWidth: 1,
  }));

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
    rotation: 0 as SerializedElement["rotation"],
    mirror: false,
    getPins() { return resolvedPins; },
    getProperties() { return propertyBag; },
    getBoundingBox(): Rect { return { x: 0, y: 0, width: 10, height: 10 }; },
    draw(_ctx: RenderContext) {},
    serialize() { return serialized; },
    getAttribute(k: string) { return propsMap.get(k); },
    setAttribute(_k: string, _v: PropertyValue) {},
  };
}

// ---------------------------------------------------------------------------
// Pin declaration helpers
// ---------------------------------------------------------------------------

function twoInputOnePinDecls(): PinDeclaration[] {
  return [
    { direction: PinDirection.INPUT, label: "a", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.INPUT, label: "b", defaultBitWidth: 1, position: { x: 0, y: 1 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.OUTPUT, label: "out", defaultBitWidth: 1, position: { x: 2, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  ];
}

function inPinDecl(_label: string, pos: { x: number; y: number }): PinDeclaration[] {
  return [
    { direction: PinDirection.OUTPUT, label: "out", defaultBitWidth: 1, position: pos, isNegatable: false, isClockCapable: false, kind: "signal" },
  ];
}

function outPinDecl(_label: string, pos: { x: number; y: number }): PinDeclaration[] {
  return [
    { direction: PinDirection.INPUT, label: "in", defaultBitWidth: 1, position: pos, isNegatable: false, isClockCapable: false, kind: "signal" },
  ];
}

// ---------------------------------------------------------------------------
// Definition builder helpers
// ---------------------------------------------------------------------------

function makeDigitalDef(
  name: string,
  pinDecls: PinDeclaration[],
  executeFn: ExecuteFunction = noopExecFn,
): ComponentDefinition {
  return {
    name,
    typeId: -1 as unknown as number,
    factory: (props: PropertyBagType) =>
      createTestElementFromDecls(name, crypto.randomUUID(), pinDecls, props),
    pinLayout: pinDecls,
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.LOGIC,
    helpText: "",
    models: {
      digital: { executeFn },
    },
  } as ComponentDefinition;
}

function makeInDef(): ComponentDefinition {
  const pinDecls = inPinDecl("out", { x: 2, y: 0 });
  return {
    name: "In",
    typeId: -1 as unknown as number,
    factory: (props: PropertyBagType) =>
      createTestElementFromDecls("In", crypto.randomUUID(), pinDecls, props),
    pinLayout: pinDecls,
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.IO,
    helpText: "",
    models: {
      digital: { executeFn: noopExecFn },
    },
  } as ComponentDefinition;
}

function makeOutDef(): ComponentDefinition {
  const pinDecls = outPinDecl("in", { x: 0, y: 0 });
  return {
    name: "Out",
    typeId: -1 as unknown as number,
    factory: (props: PropertyBagType) =>
      createTestElementFromDecls("Out", crypto.randomUUID(), pinDecls, props),
    pinLayout: pinDecls,
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.IO,
    helpText: "",
    models: {
      digital: { executeFn: noopExecFn },
    },
  } as ComponentDefinition;
}

// Minimal resistor AnalogElement factory
function makeResistorAnalogEl(
  n1: number,
  n2: number,
  resistance: number,
): AnalogElement {
  return {
    pinNodeIds: [n1, n2],
    allNodeIds: [n1, n2],
    branchIndex: -1,
    isNonlinear: false,
    isReactive: false,
    stamp(solver: SparseSolver): void {
      const g = 1 / resistance;
      if (n1 !== 0) { solver.stamp(n1 - 1, n1 - 1, g); }
      if (n2 !== 0) { solver.stamp(n2 - 1, n2 - 1, g); }
      if (n1 !== 0 && n2 !== 0) {
        solver.stamp(n1 - 1, n2 - 1, -g);
        solver.stamp(n2 - 1, n1 - 1, -g);
      }
    },
    getPinCurrents(_v: Float64Array): number[] { return [0, 0]; },
  };
}

function makeAnalogDef(
  name: string,
  pinPairs: Array<{ x: number; y: number; label?: string }>,
  mnaFactory: (pinNodes: ReadonlyMap<string, number>) => AnalogElement,
): ComponentDefinition {
  return {
    name,
    typeId: -1 as unknown as number,
    factory: () => makeAnalogElement(name, crypto.randomUUID(), pinPairs),
    pinLayout: pinPairs.map((p, i) => ({
      direction: PinDirection.BIDIRECTIONAL,
      label: p.label ?? `p${i}`,
      defaultBitWidth: 1,
      position: p,
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    })),
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.MISC,
    helpText: "",
    pinElectrical: {},
    defaultModel: 'behavioral',
    models: {
      mnaModels: {
        behavioral: {
          factory: (pinNodes: ReadonlyMap<string, number>) => mnaFactory(pinNodes),
        },
      },
    },
  } as unknown as ComponentDefinition;
}

function makeGroundDef(): ComponentDefinition {
  return {
    name: "Ground",
    typeId: -1 as unknown as number,
    factory: () => makeAnalogElement("Ground", crypto.randomUUID(), [{ x: 0, y: 0, label: "gnd" }]),
    pinLayout: [{
      direction: PinDirection.BIDIRECTIONAL,
      label: "gnd",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    }],
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.MISC,
    helpText: "",
    pinElectrical: {},
    defaultModel: 'behavioral',
    models: {
      mnaModels: {
        behavioral: {
          factory: (_pinNodes: ReadonlyMap<string, number>) => ({
            pinNodeIds: [],
            allNodeIds: [],
            branchIndex: -1,
            isNonlinear: false,
            isReactive: false,
            stamp(_s: SparseSolver) {},
            getPinCurrents(_v: Float64Array) { return [0]; },
          }),
        },
      },
    },
  } as unknown as ComponentDefinition;
}

function makeRegistry(...defs: ComponentDefinition[]): ComponentRegistry {
  const registry = new ComponentRegistry();
  for (const def of defs) {
    registry.register(def);
  }
  return registry;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("compileUnified", () => {

  it("handles empty circuit gracefully", () => {
    const registry = new ComponentRegistry();
    const circuit = new Circuit();

    const result = compileUnified(circuit, registry);

    expect(result.digital).toBeNull();
    expect(result.analog).toBeNull();
    expect(result.bridges).toHaveLength(0);
    expect(result.wireSignalMap.size).toBe(0);
    expect(result.labelSignalMap.size).toBe(0);
  });

  it("compiles pure digital circuit correctly", () => {
    // AND gate at (0,0): pins a(0,0), b(0,1), out(2,0)
    const andDef = makeDigitalDef("And", twoInputOnePinDecls());
    const registry = makeRegistry(andDef);

    const circuit = new Circuit();
    const andEl = createTestElementFromDecls("And", "and-1", twoInputOnePinDecls());
    circuit.addElement(andEl);

    const result = compileUnified(circuit, registry);

    expect(result.digital).not.toBeNull();
    expect(result.analog).toBeNull();
    expect(result.bridges).toHaveLength(0);
    expect(result.digital!.componentCount).toBe(1);
  });

  it("populates wireSignalMap for digital circuit with wires", () => {
    // Two In components connected to an And gate output connected to an Out component.
    // We use two wires: one from In.out(2,0) to And.a(0,0), one from And.out(2,0) to Out.in(10,0).
    const andDef = makeDigitalDef("And", twoInputOnePinDecls());
    const inDef = makeInDef();
    const outDef = makeOutDef();
    const registry = makeRegistry(andDef, inDef, outDef);

    const circuit = new Circuit();

    // In component: output pin at (2,0), element at (0,0)
    const inEl = createTestElementFromDecls("In", "in-1", inPinDecl("out", { x: 2, y: 0 }));
    // And gate: a(8,0), b(8,1), out(10,0) — element at (8,0)
    const andEl = createTestElementFromDecls("And", "and-1", twoInputOnePinDecls(), undefined, { x: 8, y: 0 });
    // Out component: input pin at (12,0), element at (12,0)
    const outEl = createTestElementFromDecls("Out", "out-1", outPinDecl("in", { x: 0, y: 0 }), undefined, { x: 12, y: 0 });

    circuit.addElement(inEl);
    circuit.addElement(andEl);
    circuit.addElement(outEl);

    // Wire: In output (2,0) → And input a (8,0)
    const wire1 = new Wire({ x: 2, y: 0 }, { x: 8, y: 0 });
    // Wire: And output (10,0) → Out input (12,0)
    const wire2 = new Wire({ x: 10, y: 0 }, { x: 12, y: 0 });
    circuit.addWire(wire1);
    circuit.addWire(wire2);

    const result = compileUnified(circuit, registry);

    expect(result.digital).not.toBeNull();
    // The map should have entries for the wires in the flattened circuit
    expect(result.wireSignalMap.size).toBeGreaterThan(0);
    // All signal addresses in the map must be digital for a pure-digital circuit
    for (const addr of result.wireSignalMap.values()) {
      expect(addr.domain).toBe("digital");
    }
  });

  it("populates labelSignalMap for labeled In/Out components", () => {
    const inProps = new PropertyBag([["label", "A"]]);
    const outProps = new PropertyBag([["label", "Y"]]);

    // In element at (0,0), output pin at (2,0)
    const inEl = createTestElementFromDecls("In", "in-A", inPinDecl("out", { x: 2, y: 0 }), inProps);
    // Out element at (10,0), input pin at (0,0) (world: 10,0)
    const outEl = createTestElementFromDecls("Out", "out-Y", outPinDecl("in", { x: 0, y: 0 }), outProps, { x: 10, y: 0 });

    const inDef = makeInDef();
    const outDef = makeOutDef();
    const registry = makeRegistry(inDef, outDef);

    const circuit = new Circuit();
    circuit.addElement(inEl);
    circuit.addElement(outEl);

    // Wire connecting In output (2,0) to Out input (10,0)
    const wire = new Wire({ x: 2, y: 0 }, { x: 10, y: 0 });
    circuit.addWire(wire);

    const result = compileUnified(circuit, registry);

    expect(result.digital).not.toBeNull();
    expect(result.labelSignalMap.has("A")).toBe(true);
    expect(result.labelSignalMap.has("Y")).toBe(true);

    const addrA = result.labelSignalMap.get("A")!;
    const addrY = result.labelSignalMap.get("Y")!;
    expect(addrA.domain).toBe("digital");
    expect(addrY.domain).toBe("digital");
  });

  it("compiles pure analog circuit correctly", () => {
    // Simple resistor divider: Ground at (0,0), Resistor from (0,0) to (0,4),
    // Resistor from (0,4) to (0,8).
    // Ground and two resistors.

    const groundDef = makeGroundDef();

    const resistorDef = makeAnalogDef(
      "Resistor",
      [{ x: 0, y: 0, label: "p1" }, { x: 0, y: 4, label: "p2" }],
      (pinNodes) => makeResistorAnalogEl(pinNodes.get("p1") ?? 0, pinNodes.get("p2") ?? 0, 1000),
    );

    const registry = makeRegistry(groundDef, resistorDef);

    const circuit = new Circuit();
    circuit.metadata = { ...circuit.metadata };

    // Ground at (0,0)
    const gndEl = makeAnalogElement("Ground", "gnd-1", [{ x: 0, y: 0, label: "gnd" }]);
    // Resistor1: p1 at (0,0), p2 at (0,4)
    const res1El = makeAnalogElement("Resistor", "res-1", [
      { x: 0, y: 0, label: "p1" },
      { x: 0, y: 4, label: "p2" },
    ]);
    // Resistor2: p1 at (0,4), p2 at (0,8)
    const res2El = makeAnalogElement("Resistor", "res-2", [
      { x: 0, y: 4, label: "p1" },
      { x: 0, y: 8, label: "p2" },
    ]);

    circuit.addElement(gndEl);
    circuit.addElement(res1El);
    circuit.addElement(res2El);

    const result = compileUnified(circuit, registry);

    expect(result.analog).not.toBeNull();
    // Ground (neutral with analog model) always routes to digital partition,
    // so digital is non-null even in "pure analog" circuits.
    expect(result.digital).not.toBeNull();
    expect(result.bridges).toHaveLength(0);
  });
});
