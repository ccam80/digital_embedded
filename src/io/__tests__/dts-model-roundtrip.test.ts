/**
 * Round-trip tests for namedParameterSets and modelDefinitions in the DTS
 * format.
 *
 * Covers W12.3: verifies that save → load preserves SPICE model data and that
 * deserialization with options populates ModelLibrary and
 * SubcircuitModelRegistry.
 */

import { describe, it, expect } from "vitest";
import { Circuit } from "../../core/circuit.js";
import { ComponentRegistry, ComponentCategory } from "../../core/registry.js";
import { AbstractCircuitElement } from "../../core/element.js";
import { PropertyBag } from "../../core/properties.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { Pin } from "../../core/pin.js";
import { serializeCircuit } from "../dts-serializer.js";
import { deserializeDts } from "../dts-deserializer.js";
import { ModelLibrary } from "../../solver/analog/model-library.js";
import { SubcircuitModelRegistry } from "../../solver/analog/subcircuit-model-registry.js";

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
    expect(model4148!.type).toBe("D");
    expect(model4148!.params["IS"]).toBe(2.52e-9);

    const model2222 = modelLibrary.get("2N2222");
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
    const sets = parsed["namedParameterSets"] as Record<string, { deviceType: string; params: Record<string, number> }>;
    expect(typeof sets).toBe("object");
    expect(sets["TEST"].deviceType).toBe("D");
    expect(sets["TEST"].params["IS"]).toBe(1e-9);
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
      "RDIV": {
        ports: ["a", "b", "c"],
        elements: [
          { typeId: "Resistor" },
          { typeId: "Resistor" },
        ],
        internalNetCount: 0,
        netlist: [[0, 1], [1, 2]],
      },
      "OPAMP": {
        ports: ["inp", "inn", "out"],
        elements: Array.from({ length: 10 }, () => ({ typeId: "Resistor" })),
        internalNetCount: 7,
        netlist: Array.from({ length: 10 }, (_, i) => [i % 3, (i + 1) % 3]),
      },
    };

    const json = serializeCircuit(circuit);
    const { circuit: restored } = deserializeDts(json, registry);

    const defs = restored.metadata.modelDefinitions!;
    expect(defs["RDIV"].ports).toEqual(["a", "b", "c"]);
    expect(defs["RDIV"].elements).toHaveLength(2);
    expect(defs["OPAMP"].ports).toEqual(["inp", "inn", "out"]);
    expect(defs["OPAMP"].elements).toHaveLength(10);
  });

  it("absent modelDefinitions yields undefined on loaded circuit.metadata", () => {
    const registry = makeRegistry("In");
    const circuit = new Circuit({ name: "Empty" });
    const json = serializeCircuit(circuit);
    const { circuit: restored } = deserializeDts(json, registry);
    expect(restored.metadata.modelDefinitions).toBeUndefined();
  });

  it("round-trip with full netlist registers in SubcircuitModelRegistry", () => {
    const rdivNetlist = {
      ports: ["a", "b", "c"],
      elements: [
        { typeId: "Resistor", params: { resistance: 10000 } },
        { typeId: "Resistor", params: { resistance: 10000 } },
      ],
      internalNetCount: 0,
      netlist: [[0, 1], [1, 2]],
    };

    const circuit = new Circuit({ name: "WithSubckt" });
    circuit.metadata.modelDefinitions = {
      "rdiv": rdivNetlist,
    };

    const sourceRegistry = new SubcircuitModelRegistry();
    sourceRegistry.register("rdiv", rdivNetlist);
    const json = serializeCircuit(circuit, sourceRegistry);

    const componentRegistry = makeRegistry("In", "Resistor", "Capacitor");
    const destRegistry = new SubcircuitModelRegistry();
    const { circuit: restored } = deserializeDts(json, componentRegistry, {
      subcircuitModelRegistry: destRegistry,
    });

    expect(restored.metadata.modelDefinitions!["rdiv"].ports).toEqual(["a", "b", "c"]);
    expect(destRegistry.has("rdiv")).toBe(true);
    const retrievedNetlist = destRegistry.get("rdiv")!;
    expect(retrievedNetlist.elements).toHaveLength(2);
    expect(retrievedNetlist.ports).toEqual(["a", "b", "c"]);
  });

  it("modelDefinitions stub (no topology) does not register in SubcircuitModelRegistry", () => {
    const registry = makeRegistry("In");
    const circuit = new Circuit({ name: "MetadataOnly" });
    circuit.metadata.modelDefinitions = {
      "MyModel": {
        ports: ["a", "b"],
        elements: [],
        internalNetCount: 0,
        netlist: [],
      },
    };

    const json = serializeCircuit(circuit);
    const transistorRegistry = new SubcircuitModelRegistry();
    const { circuit: restored } = deserializeDts(json, registry, { subcircuitModelRegistry: transistorRegistry });

    expect(restored.metadata.modelDefinitions!["MyModel"].ports).toEqual(["a", "b"]);
    expect(restored.metadata.modelDefinitions!["MyModel"].elements).toHaveLength(0);
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
      "RDIV": {
        ports: ["a", "b", "c"],
        elements: [{ typeId: "Resistor" }, { typeId: "Resistor" }],
        internalNetCount: 0,
        netlist: [[0, 1], [1, 2]],
      },
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
      "RDIV": {
        ports: ["a", "b"],
        elements: [],
        internalNetCount: 0,
        netlist: [],
      },
    };

    const json = serializeCircuit(circuit);
    const modelLibrary = new ModelLibrary();
    const transistorRegistry = new SubcircuitModelRegistry();
    deserializeDts(json, registry, { modelLibrary, subcircuitModelRegistry: transistorRegistry });

    expect(modelLibrary.get("1N4148")!.type).toBe("D");
    expect(transistorRegistry.has("RDIV")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// serializeCircuit with subcircuitModels parameter
// ---------------------------------------------------------------------------

describe("dts-model-roundtrip: serializeCircuit with subcircuitModels", () => {
  it("serializes netlist directly from registry when matching model exists", () => {
    const myfiltNetlist = {
      ports: ["vin", "vout"],
      elements: [{ typeId: "Resistor", params: { resistance: 1000 } }],
      internalNetCount: 0,
      netlist: [[0, 1]],
    };

    const circuit = new Circuit({ name: "Main" });
    circuit.metadata.modelDefinitions = {
      "myfilt": {
        ports: ["vin", "vout"],
        elements: [{ typeId: "Resistor" }],
        internalNetCount: 0,
        netlist: [[0, 1]],
      },
    };

    const subcircuitModels = new SubcircuitModelRegistry();
    subcircuitModels.register("myfilt", myfiltNetlist);

    const json = serializeCircuit(circuit, subcircuitModels);
    const parsed2 = JSON.parse(json) as Record<string, unknown>;
    const modelDefs = parsed2["modelDefinitions"] as Record<string, unknown>;
    expect(typeof modelDefs).toBe("object");
    const myfiltDef = modelDefs["myfilt"] as Record<string, unknown>;
    expect((myfiltDef["ports"] as string[]).length).toBe(2);
    expect((myfiltDef["elements"] as unknown[]).length).toBe(1);
    expect(typeof myfiltDef["internalNetCount"]).toBe("number");
    expect(Array.isArray(myfiltDef["netlist"])).toBe(true);
  });

  it("falls back to metadata stub when registry does not have matching model", () => {
    const circuit = new Circuit({ name: "Main" });
    circuit.metadata.modelDefinitions = {
      "orphan": {
        ports: ["a", "b"],
        elements: [],
        internalNetCount: 0,
        netlist: [],
      },
    };

    const emptyRegistry = new SubcircuitModelRegistry();
    const json = serializeCircuit(circuit, emptyRegistry);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const modelDefs = parsed["modelDefinitions"] as Record<string, unknown>;
    const orphan = modelDefs["orphan"] as Record<string, unknown>;
    expect((orphan["ports"] as string[])).toEqual(["a", "b"]);
    expect((orphan["elements"] as unknown[])).toHaveLength(0);
    expect(orphan["internalNetCount"]).toBe(0);
    expect((orphan["netlist"] as unknown[])).toHaveLength(0);
  });
});
