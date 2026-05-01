/**
 * Tests for src/headless/loader.ts- SimulationLoader.
 */

import { describe, it, expect } from "vitest";
import { join } from "path";
import { readFileSync } from "fs";
import { SimulationLoader } from "../loader.js";
import { serializeCircuit } from "../../io/dts-serializer.js";
import { ComponentRegistry, ComponentCategory } from "../../core/registry.js";
import type { StandaloneComponentDefinition } from "../../core/registry.js";
import { PropertyBag } from "../../core/properties.js";
import { Circuit, Wire } from "../../core/circuit.js";
import { TestElement } from "../../test-fixtures/test-element.js";
import { noopExecFn } from "../../test-fixtures/execute-stubs.js";

// ---------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------

function makeDefinition(name: string): StandaloneComponentDefinition {
  return {
    name,
    typeId: -1,
    factory: (props: PropertyBag) =>
      new TestElement(name, crypto.randomUUID(), { x: 0, y: 0 }, [], props),
    pinLayout: [],
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.LOGIC,
    helpText: name,
    models: {
      digital: { executeFn: noopExecFn },
    },
  };
}

function buildAndGateRegistry(): ComponentRegistry {
  const registry = new ComponentRegistry();
  for (const name of ["In", "And", "Out", "Testcase"]) {
    registry.register(makeDefinition(name));
  }
  return registry;
}

function buildJsonRegistry(): ComponentRegistry {
  const registry = new ComponentRegistry();
  for (const name of ["In", "And", "Out"]) {
    registry.register(makeDefinition(name));
  }
  return registry;
}

// ---------------------------------------------------------------------------
// Loader::loadsDigFromXml
// ---------------------------------------------------------------------------

describe("Loader", () => {
  it("loadsDigFromXml", async () => {
    const xml = readFileSync(
      join(process.cwd(), "circuits", "and-gate.dig"),
      "utf-8",
    );

    const registry = buildAndGateRegistry();
    const loader = new SimulationLoader(registry);

    const circuit = await loader.loadDig(xml);

    // and-gate.dig has 5 elements (2 In, 1 And, 1 Out, 1 Testcase) and 5 wires
    expect(circuit.elements.length).toBe(5);
    expect(circuit.wires.length).toBe(5);

    const inElements = circuit.elements.filter((el) => el.typeId === "In");
    expect(inElements.length).toBe(2);

    const andElements = circuit.elements.filter((el) => el.typeId === "And");
    expect(andElements.length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Loader::loadsDigFromFile
  // -------------------------------------------------------------------------

  it("loadsDigFromFile", async () => {
    const filePath = join(process.cwd(), "circuits", "and-gate.dig");

    const registry = buildAndGateRegistry();
    const loader = new SimulationLoader(registry);

    const circuit = await loader.loadDig(filePath);

    // Same verification as loadsDigFromXml- file path code path
    expect(circuit.elements.length).toBe(5);
    expect(circuit.wires.length).toBe(5);

    const outElements = circuit.elements.filter((el) => el.typeId === "Out");
    expect(outElements.length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Loader::detectsXmlVsPath
  // -------------------------------------------------------------------------

  it("detectsXmlVsPath", async () => {
    const registry = buildAndGateRegistry();
    const loader = new SimulationLoader(registry);

    // XML string starts with "<"- should parse directly without filesystem access
    const xml = readFileSync(
      join(process.cwd(), "circuits", "and-gate.dig"),
      "utf-8",
    );
    expect(xml.trimStart().startsWith("<")).toBe(true);

    // Loading via XML string should succeed
    const circuitFromXml = await loader.loadDig(xml);
    expect(circuitFromXml.elements.length).toBe(5);

    // Loading via file path (does not start with "<") should also succeed
    const filePath = join(process.cwd(), "circuits", "and-gate.dig");
    expect(filePath.trimStart().startsWith("<")).toBe(false);

    const circuitFromFile = await loader.loadDig(filePath);
    expect(circuitFromFile.elements.length).toBe(5);
  });

  // -------------------------------------------------------------------------
  // Loader::loadsJsonRoundTrip
  // -------------------------------------------------------------------------

  it("loadsJsonRoundTrip", () => {
    const registry = buildJsonRegistry();

    // Build a simple circuit
    const original = new Circuit({ name: "RoundTrip", description: "Test" });
    const el1 = new TestElement(
      "In",
      crypto.randomUUID(),
      { x: 100, y: 200 },
      [],
      new PropertyBag([["label", "A"]]),
    );
    const el2 = new TestElement(
      "And",
      crypto.randomUUID(),
      { x: 300, y: 200 },
      [],
      new PropertyBag([["inputCount", 2]]),
    );
    const el3 = new TestElement(
      "Out",
      crypto.randomUUID(),
      { x: 500, y: 200 },
      [],
      new PropertyBag([["label", "Y"]]),
    );
    original.addElement(el1);
    original.addElement(el2);
    original.addElement(el3);
    original.addWire(new Wire({ x: 120, y: 200 }, { x: 280, y: 200 }));

    const json = serializeCircuit(original);

    const loader = new SimulationLoader(registry);
    const loaded = loader.loadJson(json);

    // Same structure
    expect(loaded.elements.length).toBe(3);
    expect(loaded.wires.length).toBe(1);

    // Type names preserved
    expect(loaded.elements[0].typeId).toBe("In");
    expect(loaded.elements[1].typeId).toBe("And");
    expect(loaded.elements[2].typeId).toBe("Out");

    // Positions preserved
    expect(loaded.elements[0].position).toEqual({ x: 100, y: 200 });
    expect(loaded.elements[1].position).toEqual({ x: 300, y: 200 });

    // Properties preserved
    expect(loaded.elements[0].getProperties().get("label")).toBe("A");
    expect(loaded.elements[1].getProperties().get("inputCount")).toBe(2);

    // Wire preserved
    expect(loaded.wires[0].start).toEqual({ x: 120, y: 200 });
    expect(loaded.wires[0].end).toEqual({ x: 280, y: 200 });

    // Metadata preserved
    expect(loaded.metadata.name).toBe("RoundTrip");
    expect(loaded.metadata.description).toBe("Test");
  });
});
