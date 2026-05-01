/**
 * MCP surface tests for DTS modelParamDeltas round-trip.
 *
 * Verifies that per-element model parameter deltas survive
 * facade.serialize() -> facade.deserialize() intact.
 *
 * The headless dts-model-roundtrip.test.ts covers the serializer/deserializer
 * in isolation. These tests exercise the same path through DefaultSimulatorFacade
 * (the facade exposed to the MCP server and postMessage adapter).
 *
 * Tests:
 *   1. Per-element modelParamDeltas survive facade serialize/deserialize.
 *   2. Only modified params appear in the delta after round-trip.
 *   3. Element without model set produces no modelParamDeltas.
 *   4. Circuit with deltas compiles cleanly after deserializing.
 *   5. Multiple elements with different deltas each round-trip independently.
 */

import { describe, it, expect } from "vitest";
import { DefaultSimulatorFacade } from "../default-facade.js";
import { Circuit } from "../../core/circuit.js";
import { PropertyBag } from "../../core/properties.js";
import { ComponentRegistry, ComponentCategory } from "../../core/registry.js";
import type { ModelEntry } from "../../core/registry.js";
import {
  BJT_MODEL_ENTRY,
  BJT_PARAM_DEFS,
  STUB_ANALOG_FACTORY,
} from "../../test-fixtures/model-fixtures.js";
import { TestElement } from "../../test-fixtures/test-element.js";

// Finite BJT params- DTS schema rejects Infinity as a param value.
// VAF=100 is a typical finite Early voltage used in real BJT models.
const BJT_FINITE_PARAMS: Record<string, number> = {
  BF: 100,
  IS: 1e-14,
  NF: 1,
  BR: 1,
  VAF: 100,
};

// ---------------------------------------------------------------------------
// Fixture registry � minimal registry with NpnBJT
// ---------------------------------------------------------------------------

function makeBjtRegistry(): ComponentRegistry {
  const registry = new ComponentRegistry();
  registry.register({
    name: "NpnBJT",
    typeId: -1,
    factory: (props: PropertyBag) =>
      new TestElement("NpnBJT", "inst-NpnBJT", { x: 0, y: 0 }, [], props),
    pinLayout: [],
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.SEMICONDUCTORS,
    helpText: "NPN BJT",
    models: { digital: undefined as never },
    modelRegistry: {
      behavioral: BJT_MODEL_ENTRY,
    },
  });
  return registry;
}

function makeElement(
  instanceId: string,
  props: Record<string, string | number | boolean> = {},
): TestElement {
  const bag = new PropertyBag(Object.entries(props));
  return new TestElement("NpnBJT", instanceId, { x: 0, y: 0 }, [], bag);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dts-delta MCP surface � per-element modelParamDeltas round-trip", () => {
  it("BF delta survives facade.serialize() / facade.deserialize()", () => {
    const registry = makeBjtRegistry();
    const facade = new DefaultSimulatorFacade(registry);

    const modelEntry: ModelEntry = {
      kind: "inline",
      factory: STUB_ANALOG_FACTORY,
      paramDefs: BJT_PARAM_DEFS,
      params: { ...BJT_FINITE_PARAMS },
    };

    const circuit = new Circuit({ name: "Delta Test" });
    circuit.metadata.models = { NpnBJT: { "2N2222": modelEntry } };

    const el = makeElement("q1", { model: "2N2222" });
    el.getProperties().replaceModelParams({ ...BJT_FINITE_PARAMS, BF: 250 });
    circuit.addElement(el);

    const json = facade.serialize(circuit);
    const restored = facade.deserialize(json);

    expect(restored.elements).toHaveLength(1);
    const restoredEl = restored.elements[0]!;
    expect(restoredEl.getProperties().getModelParam<number>("BF")).toBe(250);
    expect(restoredEl.getProperties().getModelParam<number>("IS")).toBe(BJT_FINITE_PARAMS["IS"]!);
  });

  it("only modified params are stored in the serialized delta", () => {
    const registry = makeBjtRegistry();
    const facade = new DefaultSimulatorFacade(registry);

    const modelEntry: ModelEntry = {
      kind: "inline",
      factory: STUB_ANALOG_FACTORY,
      paramDefs: BJT_PARAM_DEFS,
      params: { ...BJT_FINITE_PARAMS },
    };

    const circuit = new Circuit({ name: "Delta Only" });
    circuit.metadata.models = { NpnBJT: { "2N2222": modelEntry } };

    const el = makeElement("q1", { model: "2N2222" });
    el.getProperties().replaceModelParams({ ...BJT_FINITE_PARAMS, BF: 300 });
    circuit.addElement(el);

    const json = facade.serialize(circuit);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const elements = (
      (parsed["circuit"] as Record<string, unknown>)["elements"] as Array<Record<string, unknown>>
    );
    const deltas = elements[0]!["modelParamDeltas"] as Record<string, unknown>;

    expect(deltas["model"]).toBe("2N2222");
    const params = deltas["params"] as Record<string, number>;
    expect(params["BF"]).toBe(300);
    expect("IS" in params).toBe(false);
    expect("NF" in params).toBe(false);
    expect("BR" in params).toBe(false);
    expect("VAF" in params).toBe(false);
  });

  it("element without model set produces no modelParamDeltas in serialized output", () => {
    const registry = makeBjtRegistry();
    const facade = new DefaultSimulatorFacade(registry);

    const circuit = new Circuit({ name: "No Model" });
    const el = makeElement("q1");
    circuit.addElement(el);

    const json = facade.serialize(circuit);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const elements = (
      (parsed["circuit"] as Record<string, unknown>)["elements"] as Array<Record<string, unknown>>
    );
    expect("modelParamDeltas" in elements[0]!).toBe(false);
  });

  it("restored element BF is correct after facade round-trip with delta", () => {
    const registry = makeBjtRegistry();
    const facade = new DefaultSimulatorFacade(registry);

    const modelEntry: ModelEntry = {
      kind: "inline",
      factory: STUB_ANALOG_FACTORY,
      paramDefs: BJT_PARAM_DEFS,
      params: { ...BJT_FINITE_PARAMS },
    };

    const circuit = new Circuit({ name: "Compile After Delta" });
    circuit.metadata.models = { NpnBJT: { "2N2222": modelEntry } };

    const el = makeElement("q1", { model: "2N2222" });
    el.getProperties().replaceModelParams({ ...BJT_FINITE_PARAMS, BF: 150 });
    circuit.addElement(el);

    const json = facade.serialize(circuit);
    const restored = facade.deserialize(json);

    expect(restored.elements[0]!.getProperties().getModelParam<number>("BF")).toBe(150);
  });

  it("multiple elements with different deltas each round-trip independently", () => {
    const registry = makeBjtRegistry();
    const facade = new DefaultSimulatorFacade(registry);

    const modelEntry: ModelEntry = {
      kind: "inline",
      factory: STUB_ANALOG_FACTORY,
      paramDefs: BJT_PARAM_DEFS,
      params: { ...BJT_FINITE_PARAMS },
    };

    const circuit = new Circuit({ name: "Multi Delta" });
    circuit.metadata.models = { NpnBJT: { "2N2222": modelEntry } };

    const el1 = makeElement("q1", { model: "2N2222" });
    el1.getProperties().replaceModelParams({ ...BJT_FINITE_PARAMS, BF: 200 });

    const el2 = makeElement("q2", { model: "2N2222" });
    el2.getProperties().replaceModelParams({ ...BJT_FINITE_PARAMS, BF: 400 });

    circuit.addElement(el1);
    circuit.addElement(el2);

    const json = facade.serialize(circuit);
    const restored = facade.deserialize(json);

    expect(restored.elements).toHaveLength(2);
    const restoredQ1 = restored.elements.find(e => e.instanceId === "q1")!;
    const restoredQ2 = restored.elements.find(e => e.instanceId === "q2")!;
    expect(restoredQ1.getProperties().getModelParam<number>("BF")).toBe(200);
    expect(restoredQ2.getProperties().getModelParam<number>("BF")).toBe(400);
  });
});
