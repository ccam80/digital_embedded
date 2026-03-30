/**
 * Tests for the pipeline-reorder changes introduced in Wave 2.1.
 *
 * Covers flattenCircuit() unconditional inlining and resolveModelAssignments
 * model key validation:
 *
 *  1. Subcircuit inlining: all subcircuits are unconditionally inlined.
 *
 *  2. Invalid simulationModel values produce diagnostics.
 *
 *  3. Valid simulationModel keys (digital, behavioral) are respected.
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
  return { direction: dir, position: { x, y }, label, bitWidth: 1, isNegated: false, isClock: false, kind: "signal" };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FlattenPipelineReorder", () => {
  it("same_domain_inline: subcircuit in outer circuit is always inlined", () => {
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

    const { circuit: flat } = flattenCircuit(outer, registry);

    // Subcircuit is unconditionally inlined — internal Capacitor appears in flat result
    const capEls = flat.elements.filter((e) => e.typeId === "Capacitor");
    expect(capEls).toHaveLength(1);
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
