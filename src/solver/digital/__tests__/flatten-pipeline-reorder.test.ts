/**
 * Tests for the pipeline-reorder changes introduced in Wave 2.1.
 *
 * Covers flattenCircuit() unconditional inlining and resolveModelAssignments
 * model key validation:
 *
 *  1. Subcircuit inlining: all subcircuits are unconditionally inlined.
 *
 *  2. Invalid model values produce diagnostics.
 *
 *  3. Valid model keys (digital, behavioral) are respected.
 */

import { describe, it, expect } from "vitest";
import { Circuit } from "@/core/circuit";
import type { Pin } from "@/core/pin";
import { PinDirection } from "@/core/pin";
import { PropertyBag } from "@/core/properties";
import { ComponentRegistry, ComponentCategory } from "@/core/registry";
import type { ComponentDefinition } from "@/core/registry";
import { flattenCircuit } from "@/solver/digital/flatten";
import { resolveModelAssignments } from "@/compile/extract-connectivity";
import {
  TestLeafElement,
  TestSubcircuitElement,
} from "@/test-fixtures/subcircuit-elements";
import { noopExecFn } from "@/test-fixtures/execute-stubs";

// ---------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------

function noopAnalogFactory() {
  return { label: "", branchIndex: -1, _stateBase: -1, _pinNodes: new Map<string, number>(), ngspiceLoadOrder: 0, load: (_ctx: unknown) => {}, setup: (_ctx: unknown) => {}, getPinCurrents: () => [] as number[], setParam: (_k: string, _v: number) => {} };
}

function makeAnalogDef(typeId: string): ComponentDefinition {
  return {
    name: typeId, typeId: -1,
    factory: (props) => new TestLeafElement(typeId, "auto", { x: 0, y: 0 }, props, []),
    pinLayout: [], propertyDefs: [], attributeMap: [],
    category: ComponentCategory.MISC, helpText: typeId,
    defaultModel: "behavioral",
    models: {},
    modelRegistry: { behavioral: { kind: "inline" as const, factory: () => noopAnalogFactory(), paramDefs: [], params: {} } },
  };
}

function makeMultiModelDef(typeId: string): ComponentDefinition {
  return {
    name: typeId, typeId: -1,
    factory: (props) => new TestLeafElement(typeId, "auto", { x: 0, y: 0 }, props, []),
    pinLayout: [], propertyDefs: [], attributeMap: [],
    category: ComponentCategory.MISC, helpText: typeId,
    models: {
      digital: { executeFn: noopExecFn },
    },
    modelRegistry: { behavioral: { kind: "inline" as const, factory: () => noopAnalogFactory(), paramDefs: [], params: {} } },
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

    // Subcircuit is unconditionally inlined- internal Capacitor appears in flat result
    const capEls = flat.elements.filter((e) => e.typeId === "Capacitor");
    expect(capEls).toHaveLength(1);
  });

  it("invalid_submode_produces_diagnostic: unrecognized model key produces invalid-simulation-model diagnostic and neutral modelKey", () => {
    const props = new PropertyBag();
    props.set("model", "nonexistent-model");
    const el = new TestLeafElement(
      "DualGate", "gate-1", { x: 0, y: 0 }, props,
      [makePin("out", PinDirection.OUTPUT, 2, 1)],
    );

    const registry = new ComponentRegistry();
    registry.register(makeMultiModelDef("DualGate"));

    const [assignments, diagnostics] = resolveModelAssignments([el], registry);

    // "nonexistent-model" is not a valid model key- must produce a diagnostic and neutral
    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.modelKey).toBe("neutral");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.code).toBe("invalid-simulation-model");
  });

  it("invalid_logical_submode_produces_diagnostic: model=logical produces invalid-simulation-model diagnostic", () => {
    const props = new PropertyBag();
    props.set("model", "logical");
    const el = new TestLeafElement(
      "DualGate", "gate-2", { x: 0, y: 0 }, props,
      [makePin("out", PinDirection.OUTPUT, 2, 1)],
    );

    const registry = new ComponentRegistry();
    registry.register(makeMultiModelDef("DualGate"));

    const [assignments, diagnostics] = resolveModelAssignments([el], registry);

    expect(assignments[0]!.modelKey).toBe("neutral");
    expect(diagnostics[0]!.code).toBe("invalid-simulation-model");
  });

  it("explicit_digital_key_respected: model=digital routes to digital", () => {
    const props = new PropertyBag();
    props.set("model", "digital");
    const el = new TestLeafElement(
      "DualGate", "gate-3", { x: 0, y: 0 }, props,
      [makePin("out", PinDirection.OUTPUT, 2, 1)],
    );

    const registry = new ComponentRegistry();
    registry.register(makeMultiModelDef("DualGate"));

    const [assignments] = resolveModelAssignments([el], registry);

    expect(assignments[0]!.modelKey).toBe("digital");
  });

  it("explicit_behavioral_key_respected: model=behavioral routes to behavioral mna model", () => {
    const props = new PropertyBag();
    props.set("model", "behavioral");
    const el = new TestLeafElement(
      "DualGate", "gate-4", { x: 0, y: 0 }, props,
      [makePin("out", PinDirection.OUTPUT, 2, 1)],
    );

    const registry = new ComponentRegistry();
    registry.register(makeMultiModelDef("DualGate"));

    const [assignments] = resolveModelAssignments([el], registry);

    expect(assignments[0]!.modelKey).toBe("behavioral");
  });
});
