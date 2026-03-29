/**
 * Headless tests for the circuit-level SPICE model library (W11.3).
 *
 * Tests the metadata storage layer — no DOM required.
 *
 * Verifies:
 * 1. namedParameterSets field on CircuitMetadata stores parsed .MODEL entries
 * 2. modelDefinitions field stores .SUBCKT metadata (ports, elementCount)
 * 3. Add/remove operations on both collections work correctly
 * 4. Multiple models can coexist in the library
 * 5. Removing a model does not affect other entries
 */

import { describe, it, expect } from "vitest";
import { Circuit } from "../../../core/circuit.js";
import type { MnaSubcircuitNetlist, SubcircuitElement } from "../../../core/mna-subcircuit-netlist.js";
import { parseModelCard, parseSubcircuit } from "../model-parser.js";
import { SubcircuitModelRegistry } from "../subcircuit-model-registry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addNamedParameterSet(
  circuit: Circuit,
  modelCard: string,
): { name: string } | { error: string } {
  const parsed = parseModelCard(modelCard);
  if ("message" in parsed) return { error: parsed.message };
  if (!circuit.metadata.namedParameterSets) circuit.metadata.namedParameterSets = {};
  circuit.metadata.namedParameterSets[parsed.name] = {
    deviceType: parsed.deviceType,
    params: parsed.params,
  };
  return { name: parsed.name };
}

function addSubcktDefinition(
  circuit: Circuit,
  registry: SubcircuitModelRegistry,
  subcktText: string,
): { name: string } | { error: string } {
  let parsed;
  try {
    parsed = parseSubcircuit(subcktText);
  } catch (e: unknown) {
    const err = e as { message?: string };
    return { error: err.message ?? String(e) };
  }
  const typeMap: Record<string, string> = {
    R: 'Resistor', C: 'Capacitor', L: 'Inductor',
    D: 'Diode', Q: 'NpnBJT', M: 'NMOS',
  };
  const nlDef: MnaSubcircuitNetlist = {
    ports: parsed.ports,
    elements: parsed.elements.map((e): SubcircuitElement => {
      const el: SubcircuitElement = { typeId: typeMap[e.type] ?? e.type };
      if (e.modelName !== undefined) el.modelRef = e.modelName;
      return el;
    }),
    internalNetCount: 0,
    netlist: parsed.elements.map(() => []),
  };
  registry.register(parsed.name, nlDef);
  if (!circuit.metadata.modelDefinitions) circuit.metadata.modelDefinitions = {};
  circuit.metadata.modelDefinitions[parsed.name] = nlDef;
  return { name: parsed.name };
}

// ---------------------------------------------------------------------------
// Tests: namedParameterSets
// ---------------------------------------------------------------------------

describe("spice-model-library: namedParameterSets", () => {
  it("adds a parsed .MODEL entry to circuit.metadata.namedParameterSets", () => {
    const circuit = new Circuit();
    const result = addNamedParameterSet(circuit, ".MODEL 2N2222 NPN(IS=1e-14 BF=200)");

    expect("error" in result).toBe(false);
    const sets = circuit.metadata.namedParameterSets;
    expect(sets!["2N2222"].deviceType).toBe("NPN");
    expect(sets!["2N2222"].params["IS"]).toBe(1e-14);
    expect(sets!["2N2222"].params["BF"]).toBe(200);
  });

  it("multiple .MODEL entries coexist under different names", () => {
    const circuit = new Circuit();
    addNamedParameterSet(circuit, ".MODEL 2N2222 NPN(IS=1e-14 BF=200)");
    addNamedParameterSet(circuit, ".MODEL BC547 NPN(IS=6e-15 BF=110)");
    addNamedParameterSet(circuit, ".MODEL 1N4148 D(IS=2.52e-9 N=1.752)");

    const sets = circuit.metadata.namedParameterSets!;
    expect(Object.keys(sets).length).toBe(3);
    expect(sets["2N2222"].deviceType).toBe("NPN");
    expect(sets["BC547"].deviceType).toBe("NPN");
    expect(sets["1N4148"].deviceType).toBe("D");
  });

  it("removing a .MODEL entry does not affect other entries", () => {
    const circuit = new Circuit();
    addNamedParameterSet(circuit, ".MODEL 2N2222 NPN(IS=1e-14 BF=200)");
    addNamedParameterSet(circuit, ".MODEL BC547 NPN(IS=6e-15 BF=110)");

    delete circuit.metadata.namedParameterSets!["2N2222"];

    const sets = circuit.metadata.namedParameterSets!;
    expect(sets["2N2222"]).toBeUndefined();
    expect(sets["BC547"].params["BF"]).toBe(110);
  });

  it("overwriting an existing entry replaces it", () => {
    const circuit = new Circuit();
    addNamedParameterSet(circuit, ".MODEL MYMOD NPN(IS=1e-14 BF=200)");
    addNamedParameterSet(circuit, ".MODEL MYMOD NPN(IS=5e-15 BF=300)");

    const sets = circuit.metadata.namedParameterSets!;
    expect(Object.keys(sets).length).toBe(1);
    expect(sets["MYMOD"].params["IS"]).toBe(5e-15);
    expect(sets["MYMOD"].params["BF"]).toBe(300);
  });

  it("returns error for invalid .MODEL text without storing anything", () => {
    const circuit = new Circuit();
    const result = addNamedParameterSet(circuit, "not a model statement");

    expect("error" in result).toBe(true);
    const sets = circuit.metadata.namedParameterSets;
    expect(sets === undefined || Object.keys(sets).length === 0).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: modelDefinitions
// ---------------------------------------------------------------------------

describe("spice-model-library: modelDefinitions", () => {
  it("adds a parsed .SUBCKT definition to circuit.metadata.modelDefinitions", () => {
    const circuit = new Circuit();
    const registry = new SubcircuitModelRegistry();
    const result = addSubcktDefinition(circuit, registry, `
.SUBCKT MYBJT C B E
Q1 C B E QMOD
.MODEL QMOD NPN(IS=1e-14)
.ENDS MYBJT
    `.trim());

    expect("error" in result).toBe(false);
    const defs = circuit.metadata.modelDefinitions;
    expect(defs!["MYBJT"].ports).toEqual(["C", "B", "E"]);
    expect(defs!["MYBJT"].elements).toHaveLength(1);
  });

  it("registers the circuit in SubcircuitModelRegistry when adding a subcircuit", () => {
    const circuit = new Circuit();
    const registry = new SubcircuitModelRegistry();
    addSubcktDefinition(circuit, registry, `
.SUBCKT RDIV IN OUT GND
R1 IN OUT 1K
R2 OUT GND 1K
.ENDS RDIV
    `.trim());

    expect(registry.get("RDIV")).toMatchObject({ ports: ["IN", "OUT", "GND"] });
  });

  it("multiple .SUBCKT definitions coexist", () => {
    const circuit = new Circuit();
    const registry = new SubcircuitModelRegistry();

    addSubcktDefinition(circuit, registry, `
.SUBCKT BJT1 C B E
Q1 C B E QMOD
.MODEL QMOD NPN(IS=1e-14)
.ENDS BJT1
    `.trim());

    addSubcktDefinition(circuit, registry, `
.SUBCKT RDIV IN OUT GND
R1 IN OUT 1K
R2 OUT GND 1K
.ENDS RDIV
    `.trim());

    const defs = circuit.metadata.modelDefinitions!;
    expect(Object.keys(defs).length).toBe(2);
    expect(defs["BJT1"].ports).toEqual(["C", "B", "E"]);
    expect(defs["RDIV"].ports).toEqual(["IN", "OUT", "GND"]);
  });

  it("removing a subcircuit definition does not affect other entries", () => {
    const circuit = new Circuit();
    const registry = new SubcircuitModelRegistry();

    addSubcktDefinition(circuit, registry, `
.SUBCKT BJT1 C B E
Q1 C B E QMOD
.MODEL QMOD NPN(IS=1e-14)
.ENDS BJT1
    `.trim());

    addSubcktDefinition(circuit, registry, `
.SUBCKT RDIV IN OUT GND
R1 IN OUT 1K
R2 OUT GND 1K
.ENDS RDIV
    `.trim());

    delete circuit.metadata.modelDefinitions!["BJT1"];

    const defs = circuit.metadata.modelDefinitions!;
    expect(defs["BJT1"]).toBeUndefined();
    expect(defs["RDIV"].ports).toEqual(["IN", "OUT", "GND"]);
    expect(defs["RDIV"].elements).toHaveLength(2);
  });

  it("returns error for invalid .SUBCKT text without storing anything", () => {
    const circuit = new Circuit();
    const registry = new SubcircuitModelRegistry();
    const result = addSubcktDefinition(circuit, registry, ".MODEL 2N2222 NPN(IS=1e-14)");

    expect("error" in result).toBe(true);
    const defs = circuit.metadata.modelDefinitions;
    expect(defs === undefined || Object.keys(defs).length === 0).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: combined library with both .MODEL and .SUBCKT
// ---------------------------------------------------------------------------

describe("spice-model-library: combined", () => {
  it("circuit can hold both namedParameterSets and modelDefinitions simultaneously", () => {
    const circuit = new Circuit();
    const registry = new SubcircuitModelRegistry();

    addNamedParameterSet(circuit, ".MODEL 2N2222 NPN(IS=1e-14 BF=200)");
    addSubcktDefinition(circuit, registry, `
.SUBCKT RDIV IN OUT GND
R1 IN OUT 1K
R2 OUT GND 1K
.ENDS RDIV
    `.trim());

    expect(circuit.metadata.namedParameterSets!["2N2222"].deviceType).toBe("NPN");
    expect(circuit.metadata.modelDefinitions!["RDIV"].ports).toEqual(["IN", "OUT", "GND"]);
  });

  it("new Circuit() has no model library fields by default", () => {
    const circuit = new Circuit();
    expect(circuit.metadata.namedParameterSets).toBeUndefined();
    expect(circuit.metadata.modelDefinitions).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: subcircuit bindings (W6.3)
// ---------------------------------------------------------------------------

describe("spice-model-library: subcircuitBindings", () => {
  it("assigns a subcircuit definition to a component type via subcircuitBindings", () => {
    const circuit = new Circuit();
    const registry = new SubcircuitModelRegistry();
    addSubcktDefinition(circuit, registry, `
.SUBCKT MYGATE A B Y
R1 A Y 1K
R2 B Y 1K
.ENDS MYGATE
    `.trim());

    if (!circuit.metadata.subcircuitBindings) circuit.metadata.subcircuitBindings = {};
    circuit.metadata.subcircuitBindings["And:custom"] = "MYGATE";

    expect(circuit.metadata.subcircuitBindings["And:custom"]).toBe("MYGATE");
  });

  it("multiple bindings can coexist for different component type:modelKey pairs", () => {
    const circuit = new Circuit();
    if (!circuit.metadata.subcircuitBindings) circuit.metadata.subcircuitBindings = {};
    circuit.metadata.subcircuitBindings["And:cmos74hc"] = "74HC08";
    circuit.metadata.subcircuitBindings["Or:cmos74hc"] = "74HC32";
    circuit.metadata.subcircuitBindings["And:cd4000"] = "CD4081";

    expect(Object.keys(circuit.metadata.subcircuitBindings).length).toBe(3);
    expect(circuit.metadata.subcircuitBindings["And:cmos74hc"]).toBe("74HC08");
    expect(circuit.metadata.subcircuitBindings["Or:cmos74hc"]).toBe("74HC32");
    expect(circuit.metadata.subcircuitBindings["And:cd4000"]).toBe("CD4081");
  });

  it("removing a binding does not affect other bindings", () => {
    const circuit = new Circuit();
    circuit.metadata.subcircuitBindings = {
      "And:cmos74hc": "74HC08",
      "Or:cmos74hc": "74HC32",
    };

    delete circuit.metadata.subcircuitBindings["And:cmos74hc"];

    expect(circuit.metadata.subcircuitBindings["And:cmos74hc"]).toBeUndefined();
    expect(circuit.metadata.subcircuitBindings["Or:cmos74hc"]).toBe("74HC32");
  });
});

// ---------------------------------------------------------------------------
// Tests: unresolved model refs (W6.3)
// ---------------------------------------------------------------------------

describe("spice-model-library: unresolved model refs", () => {
  it("modelRef in subcircuit that is not in namedParameterSets is detectable as unresolved", () => {
    const circuit = new Circuit();
    const registry = new SubcircuitModelRegistry();
    addSubcktDefinition(circuit, registry, `
.SUBCKT MYBJT C B E
Q1 C B E UNRESOLVED_MODEL
.ENDS MYBJT
    `.trim());

    const defs = circuit.metadata.modelDefinitions!;
    const netlist = defs["MYBJT"];
    expect(netlist.ports).toEqual(["C", "B", "E"]);

    const refs = netlist.elements
      .filter(e => e.modelRef !== undefined)
      .map(e => e.modelRef!);
    expect(refs).toContain("UNRESOLVED_MODEL");

    const sets = circuit.metadata.namedParameterSets ?? {};
    const unresolved = refs.filter(r => !(r in sets));
    expect(unresolved).toEqual(["UNRESOLVED_MODEL"]);
  });

  it("modelRef resolved when matching entry exists in namedParameterSets", () => {
    const circuit = new Circuit();
    const registry = new SubcircuitModelRegistry();
    addNamedParameterSet(circuit, ".MODEL QMOD NPN(IS=1e-14 BF=200)");
    addSubcktDefinition(circuit, registry, `
.SUBCKT MYBJT C B E
Q1 C B E QMOD
.ENDS MYBJT
    `.trim());

    const defs = circuit.metadata.modelDefinitions!;
    const netlist = defs["MYBJT"];
    const refs = netlist.elements
      .filter(e => e.modelRef !== undefined)
      .map(e => e.modelRef!);
    expect(refs).toContain("QMOD");

    const sets = circuit.metadata.namedParameterSets!;
    const unresolved = refs.filter(r => !(r in sets));
    expect(unresolved).toHaveLength(0);
  });

  it("subcircuit with no model refs has empty unresolved set", () => {
    const circuit = new Circuit();
    const registry = new SubcircuitModelRegistry();
    addSubcktDefinition(circuit, registry, `
.SUBCKT RDIV IN OUT GND
R1 IN OUT 1K
R2 OUT GND 1K
.ENDS RDIV
    `.trim());

    const netlist = circuit.metadata.modelDefinitions!["RDIV"];
    const refs = netlist.elements
      .filter(e => e.modelRef !== undefined)
      .map(e => e.modelRef!);
    expect(refs).toHaveLength(0);
  });
});
