/**
 * Round-trip tests for namedParameterSets and modelDefinitions in the DTS
 * format.
 *
 * Covers W12.3: verifies that save → load preserves SPICE model data and that
 * deserialization with options populates ModelLibrary and
 * TransistorModelRegistry.
 */

import { describe, it, expect } from "vitest";
import { Circuit } from "../../core/circuit.js";
import { ComponentRegistry, ComponentCategory } from "../../core/registry.js";
import { AbstractCircuitElement } from "../../core/element.js";
import { PropertyBag } from "../../core/properties.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { Pin } from "../../core/pin.js";
import { Wire } from "../../core/circuit.js";
import { serializeCircuit } from "../dts-serializer.js";
import { deserializeDts } from "../dts-deserializer.js";
import { ModelLibrary } from "../../solver/analog/model-library.js";
import { TransistorModelRegistry } from "../../solver/analog/transistor-model-registry.js";
import { parseSubcircuit } from "../../solver/analog/model-parser.js";
import { buildSpiceSubcircuit } from "../spice-model-builder.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

class StubElement extends AbstractCircuitElement {
  getPins(): readonly Pin[] { return []; }
  draw(_ctx: RenderContext): void {}
  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y, width: 4, height: 4 };
  }
}

function makeRegistry(...typeNames: string[]): ComponentRegistry {
  const registry = new ComponentRegistry();
  for (const name of typeNames) {
    registry.register({
      name,
      typeId: -1,
      factory: (props: PropertyBag) =>
        new StubElement(name, `inst-${name}`, { x: 0, y: 0 }, 0, false, props),
      pinLayout: [],
      propertyDefs: [],
      attributeMap: [],
      category: ComponentCategory.MISC,
      helpText: name,
      models: { digital: { executeFn: () => {} } },
    });
  }
  return registry;
}

// ---------------------------------------------------------------------------
// namedParameterSets round-trip
// ---------------------------------------------------------------------------

describe("dts-model-roundtrip: namedParameterSets", () => {
  it("round-trip preserves namedParameterSets on circuit.metadata", () => {
    const registry = makeRegistry("In");
    const circuit = new Circuit({ name: "WithModel" });
    circuit.metadata.namedParameterSets = {
      "1N4148": { deviceType: "D", params: { IS: 2.52e-9, N: 1.752 } },
      "2N2222": { deviceType: "NPN", params: { IS: 1.4e-14, BF: 300 } },
    };

    const json = serializeCircuit(circuit);
    const { circuit: restored } = deserializeDts(json, registry);

    expect(restored.metadata.namedParameterSets).toBeDefined();
    const sets = restored.metadata.namedParameterSets!;
    expect(sets["1N4148"].deviceType).toBe("D");
    expect(sets["1N4148"].params["IS"]).toBe(2.52e-9);
    expect(sets["1N4148"].params["N"]).toBe(1.752);
    expect(sets["2N2222"].deviceType).toBe("NPN");
    expect(sets["2N2222"].params["BF"]).toBe(300);
  });

  it("round-trip populates ModelLibrary when option provided", () => {
    const registry = makeRegistry("In");
    const circuit = new Circuit({ name: "WithModel" });
    circuit.metadata.namedParameterSets = {
      "1N4148": { deviceType: "D", params: { IS: 2.52e-9, N: 1.752 } },
      "2N2222": { deviceType: "NPN", params: { IS: 1.4e-14, BF: 300 } },
    };

    const json = serializeCircuit(circuit);
    const modelLibrary = new ModelLibrary();
    deserializeDts(json, registry, { modelLibrary });

    const model4148 = modelLibrary.get("1N4148");
    expect(model4148).toBeDefined();
    expect(model4148!.type).toBe("D");
    expect(model4148!.params["IS"]).toBe(2.52e-9);

    const model2222 = modelLibrary.get("2N2222");
    expect(model2222).toBeDefined();
    expect(model2222!.type).toBe("NPN");
    expect(model2222!.params["BF"]).toBe(300);
  });

  it("absent namedParameterSets yields undefined on loaded circuit.metadata", () => {
    const registry = makeRegistry("In");
    const circuit = new Circuit({ name: "Empty" });
    const json = serializeCircuit(circuit);
    const { circuit: restored } = deserializeDts(json, registry);
    expect(restored.metadata.namedParameterSets).toBeUndefined();
  });

  it("ModelLibrary not modified when namedParameterSets absent", () => {
    const registry = makeRegistry("In");
    const circuit = new Circuit({ name: "Empty" });
    const json = serializeCircuit(circuit);
    const modelLibrary = new ModelLibrary();
    deserializeDts(json, registry, { modelLibrary });
    expect(modelLibrary.getAll()).toHaveLength(0);
  });

  it("serialized JSON contains namedParameterSets key", () => {
    const circuit = new Circuit({ name: "Check" });
    circuit.metadata.namedParameterSets = {
      "TEST": { deviceType: "D", params: { IS: 1e-9 } },
    };
    const json = serializeCircuit(circuit);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed["namedParameterSets"]).toBeDefined();
    const sets = parsed["namedParameterSets"] as Record<string, unknown>;
    expect(sets["TEST"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// modelDefinitions round-trip
// ---------------------------------------------------------------------------

describe("dts-model-roundtrip: modelDefinitions", () => {
  it("round-trip preserves modelDefinitions ports and elementCount", () => {
    const registry = makeRegistry("In");
    const circuit = new Circuit({ name: "WithSubckt" });
    circuit.metadata.modelDefinitions = {
      "RDIV": { ports: ["a", "b", "c"], elementCount: 2 },
      "OPAMP": { ports: ["inp", "inn", "out"], elementCount: 10 },
    };

    const json = serializeCircuit(circuit);
    const { circuit: restored } = deserializeDts(json, registry);

    expect(restored.metadata.modelDefinitions).toBeDefined();
    const defs = restored.metadata.modelDefinitions!;
    expect(defs["RDIV"].ports).toEqual(["a", "b", "c"]);
    expect(defs["RDIV"].elementCount).toBe(2);
    expect(defs["OPAMP"].ports).toEqual(["inp", "inn", "out"]);
    expect(defs["OPAMP"].elementCount).toBe(10);
  });

  it("absent modelDefinitions yields undefined on loaded circuit.metadata", () => {
    const registry = makeRegistry("In");
    const circuit = new Circuit({ name: "Empty" });
    const json = serializeCircuit(circuit);
    const { circuit: restored } = deserializeDts(json, registry);
    expect(restored.metadata.modelDefinitions).toBeUndefined();
  });

  it("round-trip with full circuit registers in TransistorModelRegistry", () => {
    // Build a SPICE subcircuit and register it in a source registry
    const parsed = parseSubcircuit(`.SUBCKT rdiv a b c
R1 a b 10k
R2 b c 10k
.ENDS rdiv`);
    const subCircuit = buildSpiceSubcircuit(parsed);

    // Set up the circuit metadata
    const circuit = new Circuit({ name: "WithSubckt" });
    circuit.metadata.modelDefinitions = {
      "rdiv": { ports: parsed.ports, elementCount: parsed.elements.length },
    };

    // Serialize with the full circuit topology
    const sourceRegistry = new TransistorModelRegistry();
    sourceRegistry.register("rdiv", subCircuit);
    const json = serializeCircuit(circuit, sourceRegistry);

    // On load, supply a new TransistorModelRegistry — it should be populated
    const componentRegistry = makeRegistry("In", "Resistor", "Capacitor");
    const destRegistry = new TransistorModelRegistry();
    const { circuit: restored } = deserializeDts(json, componentRegistry, {
      transistorModelRegistry: destRegistry,
    });

    expect(restored.metadata.modelDefinitions).toBeDefined();
    expect(restored.metadata.modelDefinitions!["rdiv"].ports).toEqual(parsed.ports);
    expect(destRegistry.has("rdiv")).toBe(true);
    const retrievedCircuit = destRegistry.get("rdiv")!;
    expect(retrievedCircuit.elements.length).toBeGreaterThan(0);
  });

  it("modelDefinitions stub (no topology) does not register in TransistorModelRegistry", () => {
    // Store only metadata, no full circuit
    const registry = makeRegistry("In");
    const circuit = new Circuit({ name: "MetadataOnly" });
    circuit.metadata.modelDefinitions = {
      "MyModel": { ports: ["a", "b"], elementCount: 3 },
    };

    const json = serializeCircuit(circuit);
    const transistorRegistry = new TransistorModelRegistry();
    const { circuit: restored } = deserializeDts(json, registry, { transistorModelRegistry: transistorRegistry });

    // Metadata preserved
    expect(restored.metadata.modelDefinitions!["MyModel"].ports).toEqual(["a", "b"]);
    expect(restored.metadata.modelDefinitions!["MyModel"].elementCount).toBe(3);
    // Registry NOT populated (no topology was stored)
    expect(transistorRegistry.has("MyModel")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Both fields together
// ---------------------------------------------------------------------------

describe("dts-model-roundtrip: both fields together", () => {
  it("round-trip preserves both namedParameterSets and modelDefinitions", () => {
    const registry = makeRegistry("In");
    const circuit = new Circuit({ name: "BothFields" });
    circuit.metadata.namedParameterSets = {
      "2N2222": { deviceType: "NPN", params: { BF: 200, IS: 1e-14 } },
    };
    circuit.metadata.modelDefinitions = {
      "RDIV": { ports: ["a", "b", "c"], elementCount: 2 },
    };

    const json = serializeCircuit(circuit);
    const { circuit: restored } = deserializeDts(json, registry);

    expect(restored.metadata.namedParameterSets!["2N2222"].params["BF"]).toBe(200);
    expect(restored.metadata.modelDefinitions!["RDIV"].ports).toEqual(["a", "b", "c"]);
  });

  it("both registries populated together on load", () => {
    const registry = makeRegistry("In");
    const circuit = new Circuit({ name: "BothFields" });
    circuit.metadata.namedParameterSets = {
      "1N4148": { deviceType: "D", params: { IS: 2.52e-9 } },
    };
    circuit.metadata.modelDefinitions = {
      "RDIV": { ports: ["a", "b"], elementCount: 1 },
    };

    const json = serializeCircuit(circuit);
    const modelLibrary = new ModelLibrary();
    const transistorRegistry = new TransistorModelRegistry();
    deserializeDts(json, registry, { modelLibrary, transistorModelRegistry: transistorRegistry });

    expect(modelLibrary.get("1N4148")).toBeDefined();
    expect(modelLibrary.get("1N4148")!.type).toBe("D");
    // RDIV has no topology so not in transistorRegistry
    expect(transistorRegistry.has("RDIV")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// serializeCircuit with transistorModels parameter
// ---------------------------------------------------------------------------

describe("dts-model-roundtrip: serializeCircuit with transistorModels", () => {
  it("serializes full circuit topology when registry has matching model", () => {
    const parsed = parseSubcircuit(`.SUBCKT myfilt vin vout
R1 vin vout 1k
.ENDS myfilt`);
    const subCircuit = buildSpiceSubcircuit(parsed);

    const circuit = new Circuit({ name: "Main" });
    circuit.metadata.modelDefinitions = {
      "myfilt": { ports: parsed.ports, elementCount: parsed.elements.length },
    };

    const transistorModels = new TransistorModelRegistry();
    transistorModels.register("myfilt", subCircuit);

    const json = serializeCircuit(circuit, transistorModels);
    const parsed2 = JSON.parse(json) as Record<string, unknown>;
    const modelDefs = parsed2["modelDefinitions"] as Record<string, unknown>;
    expect(modelDefs).toBeDefined();
    const myfiltDef = modelDefs["myfilt"] as Record<string, unknown>;
    const elements = myfiltDef["elements"] as unknown[];
    // Full topology: In elements + Resistor element
    expect(elements.length).toBeGreaterThan(0);
  });

  it("falls back to metadata stub when registry does not have matching model", () => {
    const circuit = new Circuit({ name: "Main" });
    circuit.metadata.modelDefinitions = {
      "orphan": { ports: ["a", "b"], elementCount: 5 },
    };

    const emptyRegistry = new TransistorModelRegistry();
    const json = serializeCircuit(circuit, emptyRegistry);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const modelDefs = parsed["modelDefinitions"] as Record<string, unknown>;
    const orphan = modelDefs["orphan"] as Record<string, unknown>;
    const attrs = orphan["attributes"] as Record<string, string>;
    // Stub form: attributes contain ports and elementCount
    expect(attrs["elementCount"]).toBe("5");
    expect(JSON.parse(attrs["ports"])).toEqual(["a", "b"]);
  });
});
