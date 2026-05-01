/**
 * Tests for spice-model-apply.ts- unified model system.
 *
 * Verifies:
 * 1. applySpiceImportResult populates circuit.metadata.models with kind:"inline"
 * 2. applySpiceImportResult sets element "model" property and model params
 * 3. applySpiceSubcktImportResult populates circuit.metadata.models with kind:"netlist"
 * 4. applySpiceSubcktImportResult sets element "model" property
 * 5. Overwriting an existing entry replaces it entirely
 * 6. Missing behavioral entry throws a descriptive error
 */

import { describe, it, expect } from "vitest";
import {
  applySpiceImportResult,
  applySpiceSubcktImportResult,
} from "../../../app/spice-model-apply.js";
import type {
  SpiceImportResult,
  SpiceSubcktImportResult,
} from "../../../app/spice-model-apply.js";
import { Circuit } from "../../../core/circuit.js";
import { PropertyBag } from "../../../core/properties.js";
import type { PropertyValue } from "../../../core/properties.js";
import type { CircuitElement } from "../../../core/element.js";
import type { Rect, RenderContext } from "../../../core/renderer-interface.js";
import type { Pin } from "../../../core/pin.js";
import { PinDirection } from "../../../core/pin.js";
import type { SerializedElement } from "../../../core/element.js";
import { ComponentRegistry, ComponentCategory } from "../../../core/registry.js";
import type { AnalogFactory, ModelEntry } from "../../../core/registry.js";
import type { MnaSubcircuitNetlist } from "../../../core/mna-subcircuit-netlist.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePin(x: number, y: number, label: string): Pin {
  return {
    position: { x, y },
    label,
    direction: PinDirection.BIDIRECTIONAL,
    isNegated: false,
    isClock: false,
    bitWidth: 1,
    kind: "signal",
  };
}

function makeElement(
  typeId: string,
  instanceId: string,
  pinLabels: string[],
  initialProps: Map<string, PropertyValue> = new Map(),
  model: string = "behavioral",
): CircuitElement {
  const pins = pinLabels.map((label, i) => makePin(i, 0, label));
  const propsMap = new Map(initialProps.entries());
  if (!propsMap.has("model")) propsMap.set("model", model);
  const bag = new PropertyBag(propsMap.entries());
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
    getPins: () => pins,
    getProperties: () => bag,
    getBoundingBox: (): Rect => ({ x: 0, y: 0, width: 10, height: 10 }),
    draw: (_ctx: RenderContext) => {},
    serialize: () => serialized,
    getAttribute: (k: string) => initialProps.get(k),
    setAttribute: (k: string, v: PropertyValue) => { bag.set(k, v); },
  };
}

const stubFactory: AnalogFactory = () => {
  throw new Error("stub factory- not for execution");
};

const STUB_PARAM_DEFS = [
  { key: "IS", type: "FLOAT" as import('../../../core/properties.js').PropertyType, label: "IS", rank: "primary" as const },
  { key: "BF", type: "FLOAT" as import('../../../core/properties.js').PropertyType, label: "BF", rank: "primary" as const },
];

function buildRegistryWithBehavioral(typeId: string): ComponentRegistry {
  const reg = new ComponentRegistry();
  reg.register({
    name: typeId,
    typeId: -1,
    factory: (props) => makeElement(typeId, "inst", ["C", "B", "E"], new Map(props.entries())),
    pinLayout: [
      { label: "C", position: { x: 0, y: 0 }, direction: PinDirection.BIDIRECTIONAL, defaultBitWidth: 1, isNegatable: false, isClockCapable: false, kind: "signal" as const },
      { label: "B", position: { x: 1, y: 0 }, direction: PinDirection.BIDIRECTIONAL, defaultBitWidth: 1, isNegatable: false, isClockCapable: false, kind: "signal" as const },
      { label: "E", position: { x: 2, y: 0 }, direction: PinDirection.BIDIRECTIONAL, defaultBitWidth: 1, isNegatable: false, isClockCapable: false, kind: "signal" as const },
    ],
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.SEMICONDUCTORS,
    helpText: "stub",
    models: {},
    modelRegistry: {
      behavioral: {
        kind: "inline",
        factory: stubFactory,
        paramDefs: STUB_PARAM_DEFS,
        params: { IS: 1e-16, BF: 100 },
      },
    },
    defaultModel: "behavioral",
  });
  return reg;
}

// ---------------------------------------------------------------------------
// Tests: applySpiceImportResult
// ---------------------------------------------------------------------------

describe("applySpiceImportResult", () => {
  it("populates circuit.metadata.models with a kind:inline entry", () => {
    const element = makeElement("NpnStub", "q1", ["C", "B", "E"]);
    const circuit = new Circuit();
    const registry = buildRegistryWithBehavioral("NpnStub");

    const result: SpiceImportResult = {
      overrides: { IS: 1e-14, BF: 200 },
      modelName: "2N2222",
      deviceType: "NPN",
    };

    applySpiceImportResult(element, result, circuit, registry);

    expect(circuit.metadata.models).toBeDefined();
    expect(circuit.metadata.models!["NpnStub"]).toBeDefined();
    const entry = circuit.metadata.models!["NpnStub"]!["2N2222"];
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe("inline");
  });

  it("inline entry carries factory from behavioral model", () => {
    const element = makeElement("NpnStub", "q1", ["C", "B", "E"]);
    const circuit = new Circuit();
    const registry = buildRegistryWithBehavioral("NpnStub");

    applySpiceImportResult(element, { overrides: { IS: 1e-14 }, modelName: "M1", deviceType: "NPN" }, circuit, registry);

    const entry = circuit.metadata.models!["NpnStub"]!["M1"]!;
    expect(entry.kind).toBe("inline");
    if (entry.kind === "inline") {
      expect(entry.factory).toBe(stubFactory);
      expect(entry.paramDefs).toBe(STUB_PARAM_DEFS);
    }
  });

  it("inline entry params match the supplied overrides exactly", () => {
    const element = makeElement("NpnStub", "q1", ["C", "B", "E"]);
    const circuit = new Circuit();
    const registry = buildRegistryWithBehavioral("NpnStub");

    applySpiceImportResult(
      element,
      { overrides: { IS: 5e-15, BF: 300, NF: 1.02 }, modelName: "BC547", deviceType: "NPN" },
      circuit,
      registry,
    );

    const entry = circuit.metadata.models!["NpnStub"]!["BC547"]! as Extract<ModelEntry, { kind: "inline" }>;
    expect(entry.params["IS"]).toBe(5e-15);
    expect(entry.params["BF"]).toBe(300);
    expect(entry.params["NF"]).toBe(1.02);
  });

  it("sets model property on the element", () => {
    const element = makeElement("NpnStub", "q1", ["C", "B", "E"]);
    const circuit = new Circuit();
    const registry = buildRegistryWithBehavioral("NpnStub");

    applySpiceImportResult(element, { overrides: { IS: 1e-14 }, modelName: "2N3904", deviceType: "NPN" }, circuit, registry);

    expect(element.getProperties().get("model")).toBe("2N3904");
  });

  it("sets model params on the element PropertyBag", () => {
    const element = makeElement("NpnStub", "q1", ["C", "B", "E"]);
    const circuit = new Circuit();
    const registry = buildRegistryWithBehavioral("NpnStub");

    applySpiceImportResult(
      element,
      { overrides: { IS: 1e-13, BF: 150 }, modelName: "2N2222", deviceType: "NPN" },
      circuit,
      registry,
    );

    expect(element.getProperties().getModelParam<number>("IS")).toBe(1e-13);
    expect(element.getProperties().getModelParam<number>("BF")).toBe(150);
  });

  it("overwrites an existing entry with the same model name", () => {
    const element = makeElement("NpnStub", "q1", ["C", "B", "E"]);
    const circuit = new Circuit();
    const registry = buildRegistryWithBehavioral("NpnStub");

    applySpiceImportResult(element, { overrides: { IS: 1e-14 }, modelName: "MY_BJT", deviceType: "NPN" }, circuit, registry);
    applySpiceImportResult(element, { overrides: { IS: 2e-14, BF: 250 }, modelName: "MY_BJT", deviceType: "NPN" }, circuit, registry);

    const entry = circuit.metadata.models!["NpnStub"]!["MY_BJT"]! as Extract<ModelEntry, { kind: "inline" }>;
    expect(entry.params["IS"]).toBe(2e-14);
    expect(entry.params["BF"]).toBe(250);
  });

  it("creates metadata.models map when it does not exist", () => {
    const element = makeElement("NpnStub", "q1", ["C", "B", "E"]);
    const circuit = new Circuit();
    expect(circuit.metadata.models).toBeUndefined();

    const registry = buildRegistryWithBehavioral("NpnStub");
    applySpiceImportResult(element, { overrides: { IS: 1e-14 }, modelName: "M1", deviceType: "NPN" }, circuit, registry);

    expect(circuit.metadata.models).toBeDefined();
  });

  it("throws when the component has no inline model entry", () => {
    const element = makeElement("NoModelComp", "x1", ["A", "B"]);
    const circuit = new Circuit();

    const reg = new ComponentRegistry();
    reg.register({
      name: "NoModelComp",
      typeId: -1,
      factory: (props) => makeElement("NoModelComp", "x1", ["A", "B"], new Map(props.entries())),
      pinLayout: [],
      propertyDefs: [],
      attributeMap: [],
      category: ComponentCategory.PASSIVES,
      helpText: "stub",
      models: {},
    });

    expect(() =>
      applySpiceImportResult(element, { overrides: {}, modelName: "M1", deviceType: "X" }, circuit, reg),
    ).toThrow(/no inline model entry/);
  });

  it("stores multiple models for different component types independently", () => {
    const elem1 = makeElement("TypeA", "a1", ["P", "N"]);
    const elem2 = makeElement("TypeB", "b1", ["P", "N"]);
    const circuit = new Circuit();

    const reg = new ComponentRegistry();
    for (const name of ["TypeA", "TypeB"]) {
      reg.register({
        name,
        typeId: -1,
        factory: (props) => makeElement(name, "inst", ["P", "N"], new Map(props.entries())),
        pinLayout: [],
        propertyDefs: [],
        attributeMap: [],
        category: ComponentCategory.SEMICONDUCTORS,
        helpText: "stub",
        models: {},
        modelRegistry: {
          behavioral: {
            kind: "inline",
            factory: stubFactory,
            paramDefs: STUB_PARAM_DEFS,
            params: { IS: 1e-16, BF: 100 },
          },
        },
      });
    }

    applySpiceImportResult(elem1, { overrides: { IS: 1e-14 }, modelName: "ModelA", deviceType: "X" }, circuit, reg);
    applySpiceImportResult(elem2, { overrides: { IS: 2e-14 }, modelName: "ModelB", deviceType: "X" }, circuit, reg);

    expect(circuit.metadata.models!["TypeA"]!["ModelA"]).toBeDefined();
    expect(circuit.metadata.models!["TypeB"]!["ModelB"]).toBeDefined();
    expect(circuit.metadata.models!["TypeA"]!["ModelB"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: applySpiceSubcktImportResult
// ---------------------------------------------------------------------------

describe("applySpiceSubcktImportResult", () => {
  function makeNetlist(params?: Record<string, number>): MnaSubcircuitNetlist {
    const netlist: MnaSubcircuitNetlist = {
      ports: ["C", "B", "E"],
      elements: [],
      internalNetCount: 0,
      netlist: [],
    };
    if (params !== undefined) {
      netlist.params = params;
    }
    return netlist;
  }

  it("populates circuit.metadata.models with a kind:netlist entry", () => {
    const element = makeElement("NpnStub", "q1", ["C", "B", "E"]);
    const circuit = new Circuit();

    const result: SpiceSubcktImportResult = {
      subcktName: "MY_BJT_SUBCKT",
      netlist: makeNetlist(),
    };

    applySpiceSubcktImportResult(element, result, circuit);

    expect(circuit.metadata.models).toBeDefined();
    const entry = circuit.metadata.models!["NpnStub"]!["MY_BJT_SUBCKT"];
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe("netlist");
  });

  it("netlist entry carries the supplied netlist", () => {
    const element = makeElement("NpnStub", "q1", ["C", "B", "E"]);
    const circuit = new Circuit();
    const netlist = makeNetlist({ VT: 0.026, IS: 1e-14 });

    applySpiceSubcktImportResult(element, { subcktName: "Q_SUBCKT", netlist }, circuit);

    const entry = circuit.metadata.models!["NpnStub"]!["Q_SUBCKT"]! as Extract<ModelEntry, { kind: "netlist" }>;
    expect(entry.netlist).toBe(netlist);
  });

  it("netlist entry params match the subcircuit exposed params", () => {
    const element = makeElement("NpnStub", "q1", ["C", "B", "E"]);
    const circuit = new Circuit();
    const netlist = makeNetlist({ VT: 0.026, IS: 1e-14 });

    applySpiceSubcktImportResult(element, { subcktName: "Q2", netlist }, circuit);

    const entry = circuit.metadata.models!["NpnStub"]!["Q2"]! as Extract<ModelEntry, { kind: "netlist" }>;
    expect(entry.params["VT"]).toBe(0.026);
    expect(entry.params["IS"]).toBe(1e-14);
  });

  it("generates paramDefs from subcircuit params keys", () => {
    const element = makeElement("NpnStub", "q1", ["C", "B", "E"]);
    const circuit = new Circuit();
    const netlist = makeNetlist({ VT: 0.026, IS: 1e-14 });

    applySpiceSubcktImportResult(element, { subcktName: "Q3", netlist }, circuit);

    const entry = circuit.metadata.models!["NpnStub"]!["Q3"]! as Extract<ModelEntry, { kind: "netlist" }>;
    const keys = entry.paramDefs.map(d => d.key);
    expect(keys).toContain("VT");
    expect(keys).toContain("IS");
  });

  it("sets model property on the element", () => {
    const element = makeElement("NpnStub", "q1", ["C", "B", "E"]);
    const circuit = new Circuit();

    applySpiceSubcktImportResult(element, { subcktName: "MY_SUBCKT", netlist: makeNetlist() }, circuit);

    expect(element.getProperties().get("model")).toBe("MY_SUBCKT");
  });

  it("creates metadata.models map when it does not exist", () => {
    const element = makeElement("NpnStub", "q1", ["C", "B", "E"]);
    const circuit = new Circuit();
    expect(circuit.metadata.models).toBeUndefined();

    applySpiceSubcktImportResult(element, { subcktName: "S1", netlist: makeNetlist() }, circuit);

    expect(circuit.metadata.models).toBeDefined();
  });

  it("handles subcircuit with no exposed params", () => {
    const element = makeElement("NpnStub", "q1", ["C", "B", "E"]);
    const circuit = new Circuit();
    const netlist = makeNetlist();

    applySpiceSubcktImportResult(element, { subcktName: "NOPARAMS", netlist }, circuit);

    const entry = circuit.metadata.models!["NpnStub"]!["NOPARAMS"]!;
    expect(entry.kind).toBe("netlist");
    expect(entry.params).toEqual({});
    expect(entry.paramDefs).toHaveLength(0);
  });
});
