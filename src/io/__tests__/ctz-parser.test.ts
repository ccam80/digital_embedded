/**
 * Tests for the CTZ text parser (CircuitJS import).
 */

import { describe, it, expect } from "vitest";
import { parseCtzCircuitFromText } from "../ctz-parser.js";
import { CTZ_TYPE_MAP } from "../ctz-format.js";
import { ComponentRegistry, ComponentCategory } from "../../core/registry.js";
import type { StandaloneComponentDefinition } from "../../core/registry.js";
import { PropertyBag } from "../../core/properties.js";
import type { Diagnostic } from "../../compile/types.js";
import { TestElement } from "../../test-fixtures/test-element.js";
import { noopExecFn } from "../../test-fixtures/execute-stubs.js";

function makeDefinition(name: string): StandaloneComponentDefinition {
  return {
    name,
    typeId: -1,
    factory: (props: PropertyBag) =>
      new TestElement(name, crypto.randomUUID(), { x: 0, y: 0 }, [], props),
    pinLayout: [],
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.PASSIVES,
    helpText: name,
    models: {
      digital: { executeFn: noopExecFn },
    },
  };
}

function makeRegistry(...names: string[]): ComponentRegistry {
  const registry = new ComponentRegistry();
  for (const name of names) {
    registry.register(makeDefinition(name));
  }
  return registry;
}

describe("CTZ", () => {
  it("maps_component_types", () => {
    expect(CTZ_TYPE_MAP["r"]).toBe("Resistor");
    expect(CTZ_TYPE_MAP["c"]).toBe("Capacitor");
    expect(CTZ_TYPE_MAP["l"]).toBe("Inductor");
    expect(CTZ_TYPE_MAP["d"]).toBe("Diode");
  });

  it("handles_unknown_type", () => {
    const ctzText = [
      "$ 1 0.000005 10.20027730826997 50 5 43 5e-11",
      "r 192 192 384 192 0 1000",
      "xyz_unknown 100 100 200 100 0",
    ].join("\n");

    const registry = makeRegistry("Resistor");
    const diagnostics: Diagnostic[] = [];
    const circuit = parseCtzCircuitFromText(ctzText, registry, diagnostics);

    // Unknown type produces an info diagnostic with code 'unsupported-ctz-component'
    const unsupported = diagnostics.filter(
      (d) => d.code === "unsupported-ctz-component",
    );
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0].severity).toBe("info");
    expect(unsupported[0].message).toContain("xyz_unknown");

    // A placeholder element is created for the unknown type (1 resistor + 1 placeholder)
    expect(circuit.elements).toHaveLength(2);
  });
});
