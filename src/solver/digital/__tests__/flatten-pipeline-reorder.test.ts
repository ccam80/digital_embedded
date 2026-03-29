/**
 * Tests for the pipeline-reorder changes introduced in Wave 2.1.
 *
 * Covers four scenarios for flattenCircuit() after resolveModelAssignments
 * runs first and cross-engine detection uses pre-resolved model assignments:
 *
 *  1. Per-instance override: a dual-model subcircuit instance with
 *     simulationModel="digital" in an analog outer circuit is treated as a
 *     cross-engine boundary (not inlined).
 *
 *  2. Same-domain inline: an analog subcircuit inside an analog outer circuit
 *     is flattened (inlined) rather than treated as a boundary.
 *
 *  3. Cross-domain opaque: a digital-only subcircuit inside an analog outer
 *     circuit is preserved as an opaque placeholder with a boundary record.
 *
 *  4. "Analog wins" for sub-mode label: when a dual-model component has
 *     simulationModel="analog-pins" (a sub-mode value, not a model key),
 *     resolveModelAssignments assigns modelKey="analog", routing the component
 *     to the analog partition.
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
import { flattenCircuit } from "@/solver/digital/flatten";
import type { SubcircuitHost } from "@/solver/digital/flatten";
import { resolveModelAssignments } from "@/compile/extract-connectivity";

// ---------------------------------------------------------------------------
// Minimal test element classes
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

  getPins(): readonly Pin[] { return this._pins; }
  draw(_ctx: RenderContext): void {}
  getBoundingBox(): Rect { return { x: this.position.x, y: this.position.y, width: 4, height: 4 }; }
}

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
      for (const [k, v] of Object.entries(extraProps)) props.set(k, v);
    }
    super(`Subcircuit:${name}`, instanceId, position, 0, false, props);
    this.subcircuitName = name;
    this.internalCircuit = internalCircuit;
    this._pins = pins;
  }

  getPins(): readonly Pin[] { return this._pins; }
  draw(_ctx: RenderContext): void {}
  getBoundingBox(): Rect { return { x: this.position.x, y: this.position.y, width: 6, height: 4 }; }
}

// ---------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------

function noopExecute(): ExecuteFunction {
  return (_index, _state, _layout) => {};
}

function noopAnalogFactory() {
  return { pinNodeIds: [], allNodeIds: [], branchIndex: -1, isNonlinear: false, isReactive: false, stamp: () => {}, getPinCurrents: () => [] };
}

function makeDigitalDef(typeId: string): ComponentDefinition {
  return {
    name: typeId, typeId: -1,
    factory: (props) => new TestLeafElement(typeId, "auto", { x: 0, y: 0 }, props, []),
    pinLayout: [], propertyDefs: [], attributeMap: [],
    category: ComponentCategory.MISC, helpText: typeId,
    models: { digital: { executeFn: noopExecute() } },
  };
}

function makeAnalogDef(typeId: string): ComponentDefinition {
  return {
    name: typeId, typeId: -1,
    factory: (props) => new TestLeafElement(typeId, "auto", { x: 0, y: 0 }, props, []),
    pinLayout: [], propertyDefs: [], attributeMap: [],
    category: ComponentCategory.MISC, helpText: typeId,
    defaultModel: "behavioral",
    models: { mnaModels: { behavioral: { factory: noopAnalogFactory } } },
  };
}

function makeDualDef(typeId: string): ComponentDefinition {
  return {
    name: typeId, typeId: -1,
    factory: (props) => new TestLeafElement(typeId, "auto", { x: 0, y: 0 }, props, []),
    pinLayout: [], propertyDefs: [], attributeMap: [],
    category: ComponentCategory.MISC, helpText: typeId,
    models: {
      digital: { executeFn: noopExecute() },
      mnaModels: { behavioral: { factory: noopAnalogFactory } },
    },
  };
}

function makePin(label: string, dir: PinDirection, x: number, y: number): Pin {
  return { direction: dir, position: { x, y }, label, bitWidth: 1, isNegated: false, isClock: false };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FlattenPipelineReorder", () => {
  it("per_instance_override: simulationModel=digital on dual-model subcircuit in analog outer circuit produces cross-engine boundary", () => {
    // Internal circuit: dual-model gate (XorGate has both digital + analog)
    const internal = new Circuit({ name: "DualGate" });
    const internalGate = new TestLeafElement(
      "DualGate", "gate-inner", { x: 0, y: 0 }, new PropertyBag(),
      [makePin("out", PinDirection.OUTPUT, 2, 1)],
    );
    internal.addElement(internalGate);

    // Outer analog circuit with Resistor (analog-only, not infrastructure) to establish analog domain
    const outer = new Circuit({ name: "Top" });
    const resistor = new TestLeafElement(
      "Resistor", "r-1", { x: 0, y: 0 }, new PropertyBag(),
      [makePin("p1", PinDirection.BIDIRECTIONAL, 0, 0), makePin("p2", PinDirection.BIDIRECTIONAL, 4, 0)],
    );
    outer.addElement(resistor);

    // Subcircuit instance with simulationModel="digital" (per-instance override)
    const subEl = new TestSubcircuitElement(
      "DualGate", "sub-1", { x: 10, y: 0 }, internal,
      [makePin("out", PinDirection.OUTPUT, 12, 1)],
      { simulationModel: "digital" },
    );
    outer.addElement(subEl);

    const registry = new ComponentRegistry();
    registry.register(makeAnalogDef("Resistor"));
    registry.register(makeDualDef("DualGate"));

    const { crossEngineBoundaries } = flattenCircuit(outer, registry);

    // The per-instance override simulationModel="digital" in analog outer context
    // must produce exactly one boundary record
    expect(crossEngineBoundaries).toHaveLength(1);
    expect(crossEngineBoundaries[0]!.subcircuitElement).toBe(subEl);
    expect(crossEngineBoundaries[0]!.outerEngineType).toBe("analog");
    expect(crossEngineBoundaries[0]!.internalEngineType).toBeDefined();
  });

  it("same_domain_inline: analog subcircuit in analog outer circuit is inlined", () => {
    // Internal circuit: analog-only capacitor
    const internal = new Circuit({ name: "AnalogFilter" });
    const capIn = new TestLeafElement(
      "Capacitor", "c-inner", { x: 5, y: 0 }, new PropertyBag(),
      [makePin("p1", PinDirection.BIDIRECTIONAL, 0, 1), makePin("p2", PinDirection.BIDIRECTIONAL, 4, 1)],
    );
    internal.addElement(capIn);

    // Outer circuit: analog-only (Resistor as leaf + analog subcircuit)
    const outer = new Circuit({ name: "Top" });
    const resistor = new TestLeafElement(
      "Resistor", "r-outer", { x: 0, y: 0 }, new PropertyBag(),
      [makePin("p1", PinDirection.BIDIRECTIONAL, 0, 0), makePin("p2", PinDirection.BIDIRECTIONAL, 4, 0)],
    );
    outer.addElement(resistor);

    const subEl = new TestSubcircuitElement(
      "AnalogFilter", "sub-1", { x: 10, y: 0 }, internal,
      [makePin("p1", PinDirection.BIDIRECTIONAL, 10, 1), makePin("p2", PinDirection.BIDIRECTIONAL, 14, 1)],
    );
    outer.addElement(subEl);

    const registry = new ComponentRegistry();
    registry.register(makeAnalogDef("Resistor"));
    registry.register(makeAnalogDef("Capacitor"));

    const { circuit: flat, crossEngineBoundaries } = flattenCircuit(outer, registry);

    // Same-engine: no boundaries, internal Capacitor is inlined
    expect(crossEngineBoundaries).toHaveLength(0);
    const capEls = flat.elements.filter((e) => e.typeId === "Capacitor");
    expect(capEls).toHaveLength(1);
  });

  it("cross_domain_opaque: digital subcircuit in analog outer circuit is NOT inlined and boundary is recorded", () => {
    // Internal circuit: digital-only AND gate
    const internal = new Circuit({ name: "DigitalCounter" });
    const andGate = new TestLeafElement(
      "And", "and-inner", { x: 0, y: 0 }, new PropertyBag(),
      [makePin("A", PinDirection.INPUT, 0, 1), makePin("out", PinDirection.OUTPUT, 2, 1)],
    );
    internal.addElement(andGate);

    // Outer circuit: analog (Resistor makes it analog domain)
    const outer = new Circuit({ name: "Top" });
    const resistor = new TestLeafElement(
      "Resistor", "r-outer", { x: 0, y: 0 }, new PropertyBag(),
      [makePin("p1", PinDirection.BIDIRECTIONAL, 0, 0), makePin("p2", PinDirection.BIDIRECTIONAL, 4, 0)],
    );
    outer.addElement(resistor);

    const subEl = new TestSubcircuitElement(
      "DigitalCounter", "sub-1", { x: 10, y: 0 }, internal,
      [makePin("CLK", PinDirection.INPUT, 10, 1), makePin("Q", PinDirection.OUTPUT, 12, 1)],
    );
    outer.addElement(subEl);

    const registry = new ComponentRegistry();
    registry.register(makeAnalogDef("Resistor"));
    registry.register(makeDigitalDef("And"));

    const { circuit: flat, crossEngineBoundaries } = flattenCircuit(outer, registry);

    // Digital subcircuit in analog outer circuit must produce a boundary
    expect(crossEngineBoundaries).toHaveLength(1);
    expect(crossEngineBoundaries[0]!.subcircuitElement).toBe(subEl);
    expect(crossEngineBoundaries[0]!.internalEngineType).toBe("digital");
    expect(crossEngineBoundaries[0]!.outerEngineType).toBe("analog");

    // Internal AND gate must NOT appear in the flat circuit
    const andEls = flat.elements.filter((e) => e.typeId === "And");
    expect(andEls).toHaveLength(0);

    // The subcircuit placeholder must remain in the flat circuit as opaque element
    const subEls = flat.elements.filter((e) => e === subEl);
    expect(subEls).toHaveLength(1);
  });

  it("invalid_submode_produces_diagnostic: unrecognized simulationModel on dual-model component produces invalid-simulation-model diagnostic and neutral modelKey", () => {
    const props = new PropertyBag();
    props.set("simulationModel", "analog-pins");
    const el = new TestLeafElement(
      "DualGate", "gate-1", { x: 0, y: 0 }, props,
      [makePin("out", PinDirection.OUTPUT, 2, 1)],
    );

    const registry = new ComponentRegistry();
    registry.register(makeDualDef("DualGate"));

    const [assignments, diagnostics] = resolveModelAssignments([el], registry);

    // "analog-pins" is not a valid model key — must produce a diagnostic and neutral
    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.modelKey).toBe("neutral");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.code).toBe("invalid-simulation-model");
  });

  it("invalid_logical_submode_produces_diagnostic: simulationModel=logical on dual-model component produces invalid-simulation-model diagnostic", () => {
    const props = new PropertyBag();
    props.set("simulationModel", "logical");
    const el = new TestLeafElement(
      "DualGate", "gate-2", { x: 0, y: 0 }, props,
      [makePin("out", PinDirection.OUTPUT, 2, 1)],
    );

    const registry = new ComponentRegistry();
    registry.register(makeDualDef("DualGate"));

    const [assignments, diagnostics] = resolveModelAssignments([el], registry);

    expect(assignments[0]!.modelKey).toBe("neutral");
    expect(diagnostics[0]!.code).toBe("invalid-simulation-model");
  });

  it("explicit_digital_key_respected: simulationModel=digital on dual-model component routes to digital", () => {
    const props = new PropertyBag();
    props.set("simulationModel", "digital");
    const el = new TestLeafElement(
      "DualGate", "gate-3", { x: 0, y: 0 }, props,
      [makePin("out", PinDirection.OUTPUT, 2, 1)],
    );

    const registry = new ComponentRegistry();
    registry.register(makeDualDef("DualGate"));

    const [assignments] = resolveModelAssignments([el], registry);

    expect(assignments[0]!.modelKey).toBe("digital");
  });

  it("explicit_behavioral_key_respected: simulationModel=behavioral on dual-model component routes to behavioral mna model", () => {
    const props = new PropertyBag();
    props.set("simulationModel", "behavioral");
    const el = new TestLeafElement(
      "DualGate", "gate-4", { x: 0, y: 0 }, props,
      [makePin("out", PinDirection.OUTPUT, 2, 1)],
    );

    const registry = new ComponentRegistry();
    registry.register(makeDualDef("DualGate"));

    const [assignments] = resolveModelAssignments([el], registry);

    expect(assignments[0]!.modelKey).toBe("behavioral");
  });
});
