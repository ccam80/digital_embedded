/**
 * Tests for the CTZ URL parser (CircuitJS import).
 */

// Install the Node.js DecompressionStream polyfill before any CTZ code runs.
import "../../test-utils/decompress-polyfill.js";

import { describe, it, expect } from "vitest";
import { parseCtzUrl, parseCtzCircuitFromText } from "../ctz-parser.js";
import { CTZ_TYPE_MAP } from "../ctz-format.js";
import { ComponentRegistry, ComponentCategory } from "../../core/registry.js";
import type { ComponentDefinition } from "../../core/registry.js";
import { PropertyBag } from "../../core/properties.js";
import type { Diagnostic } from "../../compile/types.js";
import { TestElement } from "../../test-fixtures/test-element.js";
import { noopExecFn } from "../../test-fixtures/execute-stubs.js";

function makeDefinition(name: string): ComponentDefinition {
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

// ---------------------------------------------------------------------------
// Known base64-encoded CTZ fragments (generated with zlib.deflateRawSync)
// ---------------------------------------------------------------------------

/**
 * RC circuit: resistor (1000Ω) + capacitor (10µF) + DC voltage source (5V)
 * + ground. Compressed from:
 *   $ 1 0.000005 10.20027730826997 50 5 43 5e-11
 *   r 192 192 384 192 0 1000
 *   c 384 192 384 320 0 1e-05 0
 *   v 192 320 192 192 0 0 40 5 0 0 0.5
 *   g 192 320 192 352 0 0
 */
const RC_CIRCUIT_B64 =
  "VUzLCoAwDLvvK3LwupG2q3PfI8O7B79fOmFgoKTktUHAwoBDWJTU1oyH7r03OOGoBh9ZJN2QrvPsqJMJIZnOJQSbMoyR6WB6Pl25yuHWGI6HxdP1i5jPyAs=";

/**
 * Single resistor with value 4700Ω. Compressed from:
 *   $ 1 0.000005 10.20027730826997 50 5 43 5e-11
 *   r 192 192 384 192 0 4700
 */
const R4700_B64 =
  "HcW7DcAwDAPRPlOwSGuD1MeyBsoC2b8I4gMe7obAyb+EOI20Kue21V1IIhGOfIZ0vVDb4TvOiSjyAw==";

// ---------------------------------------------------------------------------
// CTZ::parses_simple_rc_circuit
// ---------------------------------------------------------------------------

describe("CTZ", () => {
  it("parses_simple_rc_circuit", async () => {
    const registry = makeRegistry(
      "Resistor",
      "Capacitor",
      "DcVoltageSource",
      "Ground",
    );
    const diagnostics: Diagnostic[] = [];
    const url = `https://www.falstad.com/circuit/circuitjs.html#${RC_CIRCUIT_B64}`;
    const circuit = await parseCtzUrl(url, registry, diagnostics);

    // Should have 4 elements: resistor, capacitor, voltage source, ground
    expect(circuit.elements).toHaveLength(4);

    const typeIds = circuit.elements.map((e) => e.typeId);
    expect(typeIds).toContain("Resistor");
    expect(typeIds).toContain("Capacitor");
    expect(typeIds).toContain("DcVoltageSource");
    expect(typeIds).toContain("Ground");

    // No unsupported-component diagnostics
    const unsupported = diagnostics.filter(
      (d) => d.code === "unsupported-ctz-component",
    );
    expect(unsupported).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // CTZ::maps_component_types
  // -------------------------------------------------------------------------

  it("maps_component_types", () => {
    expect(CTZ_TYPE_MAP["r"]).toBe("Resistor");
    expect(CTZ_TYPE_MAP["c"]).toBe("Capacitor");
    expect(CTZ_TYPE_MAP["l"]).toBe("Inductor");
    expect(CTZ_TYPE_MAP["d"]).toBe("Diode");
  });

  // -------------------------------------------------------------------------
  // CTZ::handles_unknown_type
  // -------------------------------------------------------------------------

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
    // Message must include the unknown type label
    expect(unsupported[0].message).toContain("xyz_unknown");

    // A placeholder element should be created for the unknown type
    // (total = 1 resistor + 1 placeholder)
    expect(circuit.elements).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // CTZ::decompresses_url
  // -------------------------------------------------------------------------

  it("decompresses_url", async () => {
    const registry = makeRegistry(
      "Resistor",
      "Capacitor",
      "DcVoltageSource",
      "Ground",
    );
    const url = `https://www.falstad.com/circuit/circuitjs.html#${RC_CIRCUIT_B64}`;
    // parseCtzUrl must succeed and return a Circuit with elements — this
    // confirms that decompression produced valid CTZ text.
    const circuit = await parseCtzUrl(url, registry);
    expect(circuit.elements.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // CTZ::preserves_component_values
  // -------------------------------------------------------------------------

  it("preserves_component_values", async () => {
    const registry = makeRegistry("Resistor");
    const diagnostics: Diagnostic[] = [];
    const url = `https://www.falstad.com/circuit/circuitjs.html#${R4700_B64}`;
    const circuit = await parseCtzUrl(url, registry, diagnostics);

    expect(circuit.elements).toHaveLength(1);
    const el = circuit.elements[0];
    expect(el.typeId).toBe("Resistor");

    // The resistor value 4700 must be preserved as the 'resistance' property
    const resistance = el.getProperties().getOrDefault<number>("resistance", -1);
    expect(resistance).toBe(4700);
  });
});
