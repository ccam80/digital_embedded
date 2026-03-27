/**
 * Tests for cross-engine boundary detection in flattenCircuit (Task 4b.2.1).
 *
 * Verifies that subcircuits with a different engineType from the outer circuit
 * are preserved as boundary records rather than being inlined, while same-engine
 * subcircuits continue to flatten normally.
 */

import { describe, it, expect } from "vitest";
import { Circuit, Wire } from "@/core/circuit";
import { AbstractCircuitElement } from "@/core/element";
import type { Pin } from "@/core/pin";
import { PinDirection } from "@/core/pin";
import type { RenderContext, Rect } from "@/core/renderer-interface";
import { PropertyBag } from "@/core/properties";
import { ComponentRegistry, ComponentCategory } from "@/core/registry";
import type { ComponentDefinition, ExecuteFunction } from "@/core/registry";
import { flattenCircuit, isSubcircuitHost } from "@/solver/digital/flatten";
import type { SubcircuitHost } from "@/solver/digital/flatten";

// ---------------------------------------------------------------------------
// Test helpers (mirrors flatten.test.ts)
// ---------------------------------------------------------------------------

class TestLeafElement extends AbstractCircuitElement {
  private readonly _pins: readonly Pin[];

  constructor(
    typeId: string,
    instanceId: string,
    position: { x: number; y: number },
    props: PropertyBag,
    pins: Pin[],
  ) {
    super(typeId, instanceId, position, 0, false, props);
    this._pins = pins;
  }

  getPins(): readonly Pin[] {
    return this._pins;
  }

  draw(_ctx: RenderContext): void {}

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y, width: 4, height: 4 };
  }

  getHelpText(): string {
    return "test leaf";
  }
}

function makeLeaf(
  typeId: string,
  instanceId: string,
  position: { x: number; y: number } = { x: 0, y: 0 },
): TestLeafElement {
  const props = new PropertyBag();
  const pins: Pin[] = [
    {
      direction: PinDirection.OUTPUT,
      position: { x: position.x + 2, y: position.y + 1 },
      label: "out",
      bitWidth: 1,
      isNegated: false,
      isClock: false,
    },
  ];
  return new TestLeafElement(typeId, instanceId, position, props, pins);
}

function makeInElement(
  instanceId: string,
  label: string,
  position: { x: number; y: number } = { x: 0, y: 0 },
): TestLeafElement {
  const props = new PropertyBag();
  props.set("label", label);
  const pins: Pin[] = [
    {
      direction: PinDirection.OUTPUT,
      position: { x: position.x + 2, y: position.y + 1 },
      label: "out",
      bitWidth: 1,
      isNegated: false,
      isClock: false,
    },
  ];
  return new TestLeafElement("In", instanceId, position, props, pins);
}

function makePortElement(
  instanceId: string,
  label: string,
  position: { x: number; y: number } = { x: 5, y: 0 },
  bitWidth: number = 1,
): TestLeafElement {
  const props = new PropertyBag();
  props.set("label", label);
  props.set("bitWidth", String(bitWidth));
  props.set("face", "left");
  props.set("sortOrder", "0");
  const pins: Pin[] = [
    {
      direction: PinDirection.BIDIRECTIONAL,
      position: { x: position.x, y: position.y + 1 },
      label: "port",
      bitWidth,
      isNegated: false,
      isClock: false,
    },
  ];
  return new TestLeafElement("Port", instanceId, position, props, pins);
}

function makeOutElement(
  instanceId: string,
  label: string,
  position: { x: number; y: number } = { x: 10, y: 0 },
): TestLeafElement {
  const props = new PropertyBag();
  props.set("label", label);
  const pins: Pin[] = [
    {
      direction: PinDirection.INPUT,
      position: { x: position.x, y: position.y + 1 },
      label: "in",
      bitWidth: 1,
      isNegated: false,
      isClock: false,
    },
  ];
  return new TestLeafElement("Out", instanceId, position, props, pins);
}

// ---------------------------------------------------------------------------
// TestSubcircuitElement — supports optional simulationMode property
// ---------------------------------------------------------------------------

class TestSubcircuitElement extends AbstractCircuitElement implements SubcircuitHost {
  readonly internalCircuit: Circuit;
  readonly subcircuitName: string;
  private readonly _pins: readonly Pin[];

  constructor(
    name: string,
    instanceId: string,
    position: { x: number; y: number },
    internalCircuit: Circuit,
    pins: Pin[],
    extraProps?: Record<string, string>,
  ) {
    const props = new PropertyBag();
    if (extraProps) {
      for (const [k, v] of Object.entries(extraProps)) {
        props.set(k, v);
      }
    }
    super(`Subcircuit:${name}`, instanceId, position, 0, false, props);
    this.subcircuitName = name;
    this.internalCircuit = internalCircuit;
    this._pins = pins;
  }

  getPins(): readonly Pin[] {
    return this._pins;
  }

  draw(_ctx: RenderContext): void {}

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y, width: 6, height: 4 };
  }

  getHelpText(): string {
    return "subcircuit";
  }
}

function makeSubcircuitElement(
  name: string,
  instanceId: string,
  position: { x: number; y: number },
  internalCircuit: Circuit,
  interfacePins: Pin[],
  extraProps?: Record<string, string>,
): TestSubcircuitElement {
  return new TestSubcircuitElement(name, instanceId, position, internalCircuit, interfacePins, extraProps);
}

// ---------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------

function makeNoOpExecute(): ExecuteFunction {
  return (_index, _state, _layout) => {};
}

function makeRegistry(...typeIds: string[]): ComponentRegistry {
  const reg = new ComponentRegistry();
  for (const typeId of typeIds) {
    const def: ComponentDefinition = {
      name: typeId,
      typeId: -1,
      factory: (_props) => makeLeaf(typeId, "auto", { x: 0, y: 0 }),
      pinLayout: [],
      propertyDefs: [],
      attributeMap: [],
      category: ComponentCategory.MISC,
      helpText: typeId,
      models: {
        digital: { executeFn: makeNoOpExecute() },
      },
    };
    reg.register(def);
  }
  return reg;
}

function makeRegistryWithAnalog(digitalIds: string[], analogIds: string[]): ComponentRegistry {
  const reg = makeRegistry(...digitalIds);
  for (const typeId of analogIds) {
    const def: ComponentDefinition = {
      name: typeId,
      typeId: -1,
      factory: (_props) => makeLeaf(typeId, "auto", { x: 0, y: 0 }),
      pinLayout: [],
      propertyDefs: [],
      attributeMap: [],
      category: ComponentCategory.MISC,
      helpText: typeId,
      models: {
        analog: { factory: () => ({ pinNodeIds: [], allNodeIds: [], branchIndex: -1, isNonlinear: false, isReactive: false, stamp: () => {}, getPinCurrents: () => [] }) },
      },
    };
    reg.register(def);
  }
  return reg;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CrossEngine", () => {
  it("analog_subcircuit_in_digital_not_flattened — analog-engine subcircuit inside digital outer circuit produces boundary", () => {
    // Internal circuit is analog — contains Resistor (analog-only)
    const internal = new Circuit({ name: "AnalogFilter" });
    const inEl = makeInElement("in-1", "A", { x: 0, y: 0 });
    const resistor = makeLeaf("Resistor", "r-1", { x: 5, y: 0 });
    const outEl = makeOutElement("out-1", "Y", { x: 10, y: 0 });
    internal.addElement(inEl);
    internal.addElement(resistor);
    internal.addElement(outEl);

    // Outer circuit is digital — contains And (digital-only)
    const outer = new Circuit({ name: "Top" });
    const andEl = makeLeaf("And", "and-outer", { x: 0, y: 10 });
    outer.addElement(andEl);
    const pins: Pin[] = [
      { direction: PinDirection.INPUT, position: { x: 20, y: 1 }, label: "A", bitWidth: 1, isNegated: false, isClock: false },
      { direction: PinDirection.OUTPUT, position: { x: 26, y: 1 }, label: "Y", bitWidth: 1, isNegated: false, isClock: false },
    ];
    const subEl = makeSubcircuitElement("AnalogFilter", "sub-1", { x: 20, y: 0 }, internal, pins);
    outer.addElement(subEl);

    // Registry: And/In/Out are digital-model; Resistor is analog-only.
    // In and Out inside the internal circuit are also registered as analog-only
    // so the internal circuit resolves to "analog" (not "auto").
    const registry = makeRegistryWithAnalog(["And"], ["In", "Out", "Resistor"]);
    const { circuit: flat, crossEngineBoundaries } = flattenCircuit(outer, registry);

    // Boundary must be recorded
    expect(crossEngineBoundaries.length).toBe(1);
    expect(crossEngineBoundaries[0]!.internalEngineType).toBe("analog");
    expect(crossEngineBoundaries[0]!.outerEngineType).toBe("digital");
    expect(crossEngineBoundaries[0]!.subcircuitElement).toBe(subEl);

    // Analog subcircuit elements must NOT appear in the flat circuit's element list
    // (the internal Resistor should not be inlined)
    const resistorEls = flat.elements.filter((e) => e.typeId === "Resistor");
    expect(resistorEls.length).toBe(0);
  });

  it("digital_subcircuit_in_analog_not_flattened — digital-engine subcircuit inside analog outer circuit produces boundary", () => {
    // Internal circuit is digital
    const internal = new Circuit({ name: "Counter" });
    const inEl = makeInElement("in-1", "CLK", { x: 0, y: 0 });
    const andEl = makeLeaf("And", "and-1", { x: 5, y: 0 });
    const outEl = makeOutElement("out-1", "Q", { x: 10, y: 0 });
    internal.addElement(inEl);
    internal.addElement(andEl);
    internal.addElement(outEl);

    // Outer circuit is analog — contains Resistor (analog-only) to make domain detectable
    const outer = new Circuit({ name: "Top" });
    const resistor = makeLeaf("Resistor", "r-outer", { x: 0, y: 10 });
    outer.addElement(resistor);
    const pins: Pin[] = [
      { direction: PinDirection.INPUT, position: { x: 0, y: 1 }, label: "CLK", bitWidth: 1, isNegated: false, isClock: false },
      { direction: PinDirection.OUTPUT, position: { x: 6, y: 1 }, label: "Q", bitWidth: 1, isNegated: false, isClock: false },
    ];
    const subEl = makeSubcircuitElement("Counter", "sub-1", { x: 0, y: 0 }, internal, pins);
    outer.addElement(subEl);

    const registry = makeRegistryWithAnalog(["And", "In", "Out"], ["Resistor"]);
    const { circuit: flat, crossEngineBoundaries } = flattenCircuit(outer, registry);

    // Boundary must be recorded
    expect(crossEngineBoundaries.length).toBe(1);
    expect(crossEngineBoundaries[0]!.internalEngineType).toBe("digital");
    expect(crossEngineBoundaries[0]!.outerEngineType).toBe("analog");
    expect(crossEngineBoundaries[0]!.subcircuitElement).toBe(subEl);

    // Digital gate must NOT be inlined into the analog flat circuit
    const andEls = flat.elements.filter((e) => e.typeId === "And");
    expect(andEls.length).toBe(0);
  });

  it("same_engine_subcircuit_still_flattened — digital subcircuit in digital outer circuit flattens normally with no boundaries", () => {
    const internal = new Circuit({ name: "AndWrapper" });
    const inEl = makeInElement("in-1", "A", { x: 0, y: 0 });
    const andEl = makeLeaf("And", "and-1", { x: 5, y: 0 });
    const outEl = makeOutElement("out-1", "Y", { x: 10, y: 0 });
    internal.addElement(inEl);
    internal.addElement(andEl);
    internal.addElement(outEl);

    const outer = new Circuit({ name: "Top" });
    const pins: Pin[] = [
      { direction: PinDirection.INPUT, position: { x: 20, y: 1 }, label: "A", bitWidth: 1, isNegated: false, isClock: false },
      { direction: PinDirection.OUTPUT, position: { x: 26, y: 1 }, label: "Y", bitWidth: 1, isNegated: false, isClock: false },
    ];
    const subEl = makeSubcircuitElement("AndWrapper", "sub-1", { x: 20, y: 0 }, internal, pins);
    outer.addElement(subEl);

    const registry = makeRegistry("And", "In", "Out");
    const { circuit: flat, crossEngineBoundaries } = flattenCircuit(outer, registry);

    // No boundaries — same engine
    expect(crossEngineBoundaries.length).toBe(0);

    // Internal elements must be inlined
    expect(flat.elements.filter((e) => e.typeId === "And").length).toBe(1);
    expect(flat.elements.filter((e) => e.typeId === "In").length).toBe(1);
    expect(flat.elements.filter((e) => e.typeId === "Out").length).toBe(1);
    // No subcircuit placeholder
    expect(flat.elements.filter((e) => e.typeId.startsWith("Subcircuit:")).length).toBe(0);
  });

  it("simulation_mode_digital_overrides — analog-engine subcircuit with simulationMode=digital in analog outer circuit produces boundary", () => {
    // Internal circuit is analog but instance has simulationMode='digital'
    const internal = new Circuit({ name: "Gate" });
    const inEl = makeInElement("in-1", "A", { x: 0, y: 0 });
    const outEl = makeOutElement("out-1", "Y", { x: 10, y: 0 });
    internal.addElement(inEl);
    internal.addElement(outEl);

    // Outer circuit is analog — contains Resistor (analog-only) to make domain detectable
    // Instance has simulationMode='digital' which overrides internal circuit domain
    const outer = new Circuit({ name: "Top" });
    const resistor = makeLeaf("Resistor", "r-outer", { x: 0, y: 10 });
    outer.addElement(resistor);
    const pins: Pin[] = [
      { direction: PinDirection.INPUT, position: { x: 0, y: 1 }, label: "A", bitWidth: 1, isNegated: false, isClock: false },
      { direction: PinDirection.OUTPUT, position: { x: 6, y: 1 }, label: "Y", bitWidth: 1, isNegated: false, isClock: false },
    ];
    const subEl = makeSubcircuitElement("Gate", "sub-1", { x: 0, y: 0 }, internal, pins, { simulationMode: "digital" });
    outer.addElement(subEl);

    const registry = makeRegistryWithAnalog(["In", "Out"], ["Resistor"]);
    const { crossEngineBoundaries } = flattenCircuit(outer, registry);

    // simulationMode='digital' on instance overrides, producing a boundary
    expect(crossEngineBoundaries.length).toBe(1);
    expect(crossEngineBoundaries[0]!.subcircuitElement).toBe(subEl);
  });

  it("pin_mappings_correct — subcircuit with 2 inputs + 1 output produces 3 BoundaryPinMapping entries with correct labels and directions", () => {
    const internal = new Circuit({ name: "ALU" });
    const inA = makeInElement("in-a", "A", { x: 0, y: 0 });
    const inB = makeInElement("in-b", "B", { x: 0, y: 5 });
    const outEl = makeOutElement("out-1", "S", { x: 10, y: 0 });
    internal.addElement(inA);
    internal.addElement(inB);
    internal.addElement(outEl);

    // Outer is analog — contains Resistor (analog-only) to make domain detectable
    const outer = new Circuit({ name: "Top" });
    const resistor = makeLeaf("Resistor", "r-outer", { x: 0, y: 10 });
    outer.addElement(resistor);
    const pins: Pin[] = [
      { direction: PinDirection.INPUT,  position: { x: 0, y: 1 }, label: "A", bitWidth: 1, isNegated: false, isClock: false },
      { direction: PinDirection.INPUT,  position: { x: 0, y: 3 }, label: "B", bitWidth: 1, isNegated: false, isClock: false },
      { direction: PinDirection.OUTPUT, position: { x: 6, y: 1 }, label: "S", bitWidth: 1, isNegated: false, isClock: false },
    ];
    const subEl = makeSubcircuitElement("ALU", "sub-1", { x: 0, y: 0 }, internal, pins);
    outer.addElement(subEl);

    const registry = makeRegistryWithAnalog(["In", "Out"], ["Resistor"]);
    const { crossEngineBoundaries } = flattenCircuit(outer, registry);

    expect(crossEngineBoundaries.length).toBe(1);
    const mappings = crossEngineBoundaries[0]!.pinMappings;
    expect(mappings.length).toBe(3);

    const mapA = mappings.find((m) => m.pinLabel === "A");
    const mapB = mappings.find((m) => m.pinLabel === "B");
    const mapS = mappings.find((m) => m.pinLabel === "S");

    expect(mapA).toBeDefined();
    expect(mapA!.direction).toBe("in");
    expect(mapA!.innerLabel).toBe("A");

    expect(mapB).toBeDefined();
    expect(mapB!.direction).toBe("in");
    expect(mapB!.innerLabel).toBe("B");

    expect(mapS).toBeDefined();
    expect(mapS!.direction).toBe("out");
    expect(mapS!.innerLabel).toBe("S");
  });

  it("existing_flatten_tests_unchanged — same-engine flattening produces identical results as before the cross-engine change", () => {
    // Reproduce the singleSubcircuit test from flatten.test.ts to confirm no regression
    const internal = new Circuit({ name: "AndWrapper" });
    const inEl = makeInElement("in-1", "A", { x: 0, y: 0 });
    const andEl = makeLeaf("And", "and-1", { x: 5, y: 0 });
    const outEl = makeOutElement("out-1", "Y", { x: 10, y: 0 });
    internal.addElement(inEl);
    internal.addElement(andEl);
    internal.addElement(outEl);

    const parent = new Circuit({ name: "Top" });
    const subcircuitPins: Pin[] = [
      { direction: PinDirection.INPUT, position: { x: 20, y: 1 }, label: "A", bitWidth: 1, isNegated: false, isClock: false },
      { direction: PinDirection.OUTPUT, position: { x: 26, y: 1 }, label: "Y", bitWidth: 1, isNegated: false, isClock: false },
    ];
    const subcircuitInstance = makeSubcircuitElement("AndWrapper", "sub-1", { x: 20, y: 0 }, internal, subcircuitPins);
    parent.addElement(subcircuitInstance);

    const registry = makeRegistry("And", "In", "Out");
    const { circuit: flat, crossEngineBoundaries } = flattenCircuit(parent, registry);

    // No boundaries (same-engine digital)
    expect(crossEngineBoundaries.length).toBe(0);

    // Subcircuit inlined — no Subcircuit: elements
    expect(flat.elements.filter((e) => e.typeId.startsWith("Subcircuit:")).length).toBe(0);

    // Internal elements present
    const typeIds = flat.elements.map((e) => e.typeId).sort();
    expect(typeIds).toContain("In");
    expect(typeIds).toContain("And");
    expect(typeIds).toContain("Out");
    expect(flat.elements.length).toBe(3);

    // Reproduce the twoInstances distinct-scoped-names check
    const internal2 = new Circuit({ name: "HalfAdder" });
    internal2.addElement(makeInElement("in-1", "A", { x: 0, y: 0 }));
    internal2.addElement(makeLeaf("And", "and-1", { x: 5, y: 0 }));
    internal2.addElement(makeOutElement("out-1", "S", { x: 10, y: 0 }));

    const parent2 = new Circuit({ name: "Top2" });
    const pinsA: Pin[] = [
      { direction: PinDirection.INPUT, position: { x: 0, y: 1 }, label: "A", bitWidth: 1, isNegated: false, isClock: false },
      { direction: PinDirection.OUTPUT, position: { x: 6, y: 1 }, label: "S", bitWidth: 1, isNegated: false, isClock: false },
    ];
    const pinsB: Pin[] = [
      { direction: PinDirection.INPUT, position: { x: 20, y: 1 }, label: "A", bitWidth: 1, isNegated: false, isClock: false },
      { direction: PinDirection.OUTPUT, position: { x: 26, y: 1 }, label: "S", bitWidth: 1, isNegated: false, isClock: false },
    ];
    parent2.addElement(makeSubcircuitElement("HalfAdder", "sub-0", { x: 0, y: 0 }, internal2, pinsA));
    parent2.addElement(makeSubcircuitElement("HalfAdder", "sub-1", { x: 20, y: 0 }, internal2, pinsB));

    const { circuit: flat2, crossEngineBoundaries: b2 } = flattenCircuit(parent2, registry);
    expect(b2.length).toBe(0);
    expect(flat2.elements.length).toBe(6);
    const instanceIds = flat2.elements.map((e) => e.instanceId);
    expect(new Set(instanceIds).size).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Port-based cross-engine boundary tests
// ---------------------------------------------------------------------------

describe("cross-engine boundary — Port-based subcircuits", () => {
  it("same_engine_port_subcircuit_inlines — digital subcircuit with Port interfaces in digital outer circuit flattens normally", () => {
    // Internal circuit is digital with Port interface elements
    const internal = new Circuit({ name: "PortWrapper" });
    const portIn = makePortElement("port-in", "A", { x: 0, y: 0 });
    const andEl = makeLeaf("And", "and-1", { x: 5, y: 0 });
    const portOut = makePortElement("port-out", "Y", { x: 10, y: 0 });
    internal.addElement(portIn);
    internal.addElement(andEl);
    internal.addElement(portOut);

    const outer = new Circuit({ name: "Top" });
    const pins: Pin[] = [
      { direction: PinDirection.BIDIRECTIONAL, position: { x: 20, y: 1 }, label: "A", bitWidth: 1, isNegated: false, isClock: false },
      { direction: PinDirection.BIDIRECTIONAL, position: { x: 26, y: 1 }, label: "Y", bitWidth: 1, isNegated: false, isClock: false },
    ];
    const subEl = makeSubcircuitElement("PortWrapper", "sub-1", { x: 20, y: 0 }, internal, pins);
    outer.addElement(subEl);

    // All types are digital — Port is registered as digital-only here
    const registry = makeRegistry("And", "Port");
    const { circuit: flat, crossEngineBoundaries } = flattenCircuit(outer, registry);

    // No boundaries — same engine
    expect(crossEngineBoundaries.length).toBe(0);

    // Internal elements must be inlined
    expect(flat.elements.filter((e) => e.typeId === "And").length).toBe(1);
    expect(flat.elements.filter((e) => e.typeId === "Port").length).toBe(2);
    // No subcircuit placeholder remains
    expect(flat.elements.filter((e) => e.typeId.startsWith("Subcircuit:")).length).toBe(0);
  });

  it("cross_engine_port_subcircuit_preserved — analog subcircuit with Port interfaces in digital outer circuit produces boundary", () => {
    // Internal circuit is analog — contains Resistor (analog-only) and Port interfaces
    const internal = new Circuit({ name: "AnalogPortFilter" });
    const portIn = makePortElement("port-in", "A", { x: 0, y: 0 });
    const resistor = makeLeaf("Resistor", "r-1", { x: 5, y: 0 });
    const portOut = makePortElement("port-out", "Y", { x: 10, y: 0 });
    internal.addElement(portIn);
    internal.addElement(resistor);
    internal.addElement(portOut);

    // Outer circuit is digital — contains And (digital-only)
    const outer = new Circuit({ name: "Top" });
    const andEl = makeLeaf("And", "and-outer", { x: 0, y: 10 });
    outer.addElement(andEl);
    const pins: Pin[] = [
      { direction: PinDirection.BIDIRECTIONAL, position: { x: 20, y: 1 }, label: "A", bitWidth: 1, isNegated: false, isClock: false },
      { direction: PinDirection.BIDIRECTIONAL, position: { x: 26, y: 1 }, label: "Y", bitWidth: 1, isNegated: false, isClock: false },
    ];
    const subEl = makeSubcircuitElement("AnalogPortFilter", "sub-1", { x: 20, y: 0 }, internal, pins);
    outer.addElement(subEl);

    // Port and Resistor are analog-only; And is digital-only
    const registry = makeRegistryWithAnalog(["And"], ["Port", "Resistor"]);
    const { circuit: flat, crossEngineBoundaries } = flattenCircuit(outer, registry);

    // Boundary must be recorded
    expect(crossEngineBoundaries.length).toBe(1);
    expect(crossEngineBoundaries[0]!.internalEngineType).toBe("analog");
    expect(crossEngineBoundaries[0]!.outerEngineType).toBe("digital");
    expect(crossEngineBoundaries[0]!.subcircuitElement).toBe(subEl);

    // Analog subcircuit elements must NOT appear in the flat circuit
    expect(flat.elements.filter((e) => e.typeId === "Resistor").length).toBe(0);
    expect(flat.elements.filter((e) => e.typeId === "Port").length).toBe(0);
  });

  it("port_pin_mappings_in_boundary — Port pins produce correct BoundaryPinMapping entries", () => {
    // Internal circuit is analog with two Port interfaces
    const internal = new Circuit({ name: "AnalogBlock" });
    const portA = makePortElement("port-a", "A", { x: 0, y: 0 });
    const portB = makePortElement("port-b", "B", { x: 0, y: 5 });
    const resistor = makeLeaf("Resistor", "r-1", { x: 5, y: 0 });
    internal.addElement(portA);
    internal.addElement(portB);
    internal.addElement(resistor);

    // Outer circuit is digital — contains And (digital-only)
    const outer = new Circuit({ name: "Top" });
    const andEl = makeLeaf("And", "and-outer", { x: 0, y: 10 });
    outer.addElement(andEl);
    const pins: Pin[] = [
      { direction: PinDirection.BIDIRECTIONAL, position: { x: 20, y: 1 }, label: "A", bitWidth: 1, isNegated: false, isClock: false },
      { direction: PinDirection.BIDIRECTIONAL, position: { x: 20, y: 3 }, label: "B", bitWidth: 1, isNegated: false, isClock: false },
    ];
    const subEl = makeSubcircuitElement("AnalogBlock", "sub-1", { x: 20, y: 0 }, internal, pins);
    outer.addElement(subEl);

    const registry = makeRegistryWithAnalog(["And"], ["Port", "Resistor"]);
    const { crossEngineBoundaries } = flattenCircuit(outer, registry);

    expect(crossEngineBoundaries.length).toBe(1);
    const mappings = crossEngineBoundaries[0]!.pinMappings;
    expect(mappings.length).toBe(2);

    const mapA = mappings.find((m) => m.pinLabel === "A");
    const mapB = mappings.find((m) => m.pinLabel === "B");

    // BIDIRECTIONAL pins map to "out" per buildPinMappings (not INPUT → not "in")
    expect(mapA).toBeDefined();
    expect(mapA!.direction).toBe("out");
    expect(mapA!.innerLabel).toBe("A");
    expect(mapA!.bitWidth).toBe(1);

    expect(mapB).toBeDefined();
    expect(mapB!.direction).toBe("out");
    expect(mapB!.innerLabel).toBe("B");
    expect(mapB!.bitWidth).toBe(1);
  });

  it("mixed_port_and_inout_subcircuits — Port subcircuit and In/Out subcircuit both cross-engine are both recorded as boundaries", () => {
    // First internal circuit: analog with Port interfaces
    const internalPort = new Circuit({ name: "PortFilter" });
    const portEl = makePortElement("port-in", "SIG", { x: 0, y: 0 });
    const resistor = makeLeaf("Resistor", "r-1", { x: 5, y: 0 });
    internalPort.addElement(portEl);
    internalPort.addElement(resistor);

    // Second internal circuit: analog with In/Out interfaces
    const internalIO = new Circuit({ name: "IOFilter" });
    const inEl = makeInElement("in-1", "CLK", { x: 0, y: 0 });
    const resistor2 = makeLeaf("Resistor", "r-2", { x: 5, y: 0 });
    const outEl = makeOutElement("out-1", "Q", { x: 10, y: 0 });
    internalIO.addElement(inEl);
    internalIO.addElement(resistor2);
    internalIO.addElement(outEl);

    // Outer circuit is digital — contains And (digital-only)
    const outer = new Circuit({ name: "Top" });
    const andEl = makeLeaf("And", "and-outer", { x: 0, y: 20 });
    outer.addElement(andEl);

    // Port-based subcircuit instance
    const portPins: Pin[] = [
      { direction: PinDirection.BIDIRECTIONAL, position: { x: 20, y: 1 }, label: "SIG", bitWidth: 1, isNegated: false, isClock: false },
    ];
    const subPort = makeSubcircuitElement("PortFilter", "sub-port", { x: 20, y: 0 }, internalPort, portPins);
    outer.addElement(subPort);

    // In/Out-based subcircuit instance
    const ioPins: Pin[] = [
      { direction: PinDirection.INPUT,  position: { x: 40, y: 1 }, label: "CLK", bitWidth: 1, isNegated: false, isClock: false },
      { direction: PinDirection.OUTPUT, position: { x: 46, y: 1 }, label: "Q",   bitWidth: 1, isNegated: false, isClock: false },
    ];
    const subIO = makeSubcircuitElement("IOFilter", "sub-io", { x: 40, y: 0 }, internalIO, ioPins);
    outer.addElement(subIO);

    // Port, In, Out, Resistor are analog-only; And is digital-only
    const registry = makeRegistryWithAnalog(["And"], ["Port", "In", "Out", "Resistor"]);
    const { crossEngineBoundaries } = flattenCircuit(outer, registry);

    // Both subcircuits are cross-engine — two boundaries
    expect(crossEngineBoundaries.length).toBe(2);

    const portBoundary = crossEngineBoundaries.find((b) => b.subcircuitElement === subPort);
    const ioBoundary = crossEngineBoundaries.find((b) => b.subcircuitElement === subIO);

    expect(portBoundary).toBeDefined();
    expect(portBoundary!.internalEngineType).toBe("analog");
    expect(portBoundary!.outerEngineType).toBe("digital");
    expect(portBoundary!.pinMappings.length).toBe(1);
    expect(portBoundary!.pinMappings[0]!.pinLabel).toBe("SIG");

    expect(ioBoundary).toBeDefined();
    expect(ioBoundary!.internalEngineType).toBe("analog");
    expect(ioBoundary!.outerEngineType).toBe("digital");
    expect(ioBoundary!.pinMappings.length).toBe(2);
  });
});
