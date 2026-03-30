/**
 * Tests for analog gate registration on ComponentDefinitions.
 *
 * Verifies:
 *   - Each gate type has analogFactory defined
 *   - Each gate type has both digital and analog models
 *   - getWithModel("analog") includes all gate types
 *   - getWithModel("digital") still includes all gate types
 *   - Each gate has both digital and analog models
 */

import { describe, it, expect } from "vitest";
import { ComponentRegistry } from "../../../core/registry.js";
import { AndDefinition } from "../and.js";
import { NAndDefinition } from "../nand.js";
import { OrDefinition } from "../or.js";
import { NOrDefinition } from "../nor.js";
import { XOrDefinition } from "../xor.js";
import { XNOrDefinition } from "../xnor.js";
import { NotDefinition } from "../not.js";

// ---------------------------------------------------------------------------
// Test registry with all gate types registered
// ---------------------------------------------------------------------------

function makeGateRegistry(): ComponentRegistry {
  const registry = new ComponentRegistry();
  registry.register(AndDefinition);
  registry.register(NAndDefinition);
  registry.register(OrDefinition);
  registry.register(NOrDefinition);
  registry.register(XOrDefinition);
  registry.register(XNOrDefinition);
  registry.register(NotDefinition);
  return registry;
}

const GATE_NAMES = ["And", "NAnd", "Or", "NOr", "XOr", "XNOr", "Not"];

// ---------------------------------------------------------------------------
// Registration tests
// ---------------------------------------------------------------------------

describe("Registration", () => {
  it("and_has_analog_factory", () => {
    const registry = makeGateRegistry();
    expect(registry.get("And")!.modelRegistry?.cmos).toBeDefined();
  });

  it("and_has_both_digital_and_analog_models", () => {
    const registry = makeGateRegistry();
    const def = registry.get("And")!;
    expect(def.models?.digital).toBeDefined();
    expect(def.modelRegistry?.cmos).toBeDefined();
  });

  it("all_gates_have_analog_factory", () => {
    const registry = makeGateRegistry();
    for (const name of GATE_NAMES) {
      const def = registry.get(name);
      expect(def, `Expected ${name} to be registered`).toBeDefined();
      expect(
        def!.modelRegistry?.cmos,
        `Expected ${name} to have analog model`,
      ).toBeDefined();
    }
  });

  it("all_gates_have_both_digital_and_analog_models", () => {
    const registry = makeGateRegistry();
    for (const name of GATE_NAMES) {
      const def = registry.get(name)!;
      expect(def.models?.digital, `${name} should have digital model`).toBeDefined();
      expect(def.modelRegistry?.cmos, `${name} should have analog model`).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Palette tests
// ---------------------------------------------------------------------------

describe("Palette", () => {
  it("analog_palette_includes_gates", () => {
    const registry = makeGateRegistry();
    const analogDefs = registry.getWithModel("analog");
    const analogNames = analogDefs.map((d) => d.name);

    expect(analogNames).toContain("And");
    expect(analogNames).toContain("Or");
    expect(analogNames).toContain("Not");
    expect(analogNames).toContain("NAnd");
    expect(analogNames).toContain("NOr");
    expect(analogNames).toContain("XOr");
    expect(analogNames).toContain("XNOr");
  });

  it("digital_palette_still_includes_gates", () => {
    const registry = makeGateRegistry();
    const digitalDefs = registry.getWithModel("digital");
    const digitalNames = digitalDefs.map((d) => d.name);

    expect(digitalNames).toContain("And");
    expect(digitalNames).toContain("Or");
    expect(digitalNames).toContain("Not");
    expect(digitalNames).toContain("NAnd");
    expect(digitalNames).toContain("NOr");
    expect(digitalNames).toContain("XOr");
    expect(digitalNames).toContain("XNOr");
  });
});

// ---------------------------------------------------------------------------
// SimulationModes tests
// ---------------------------------------------------------------------------

describe("SimulationModes", () => {
  it("and_supports_digital_and_cmos", () => {
    const registry = makeGateRegistry();
    const def = registry.get("And")!;
    expect(def.models?.digital).toBeDefined();
    expect(def.modelRegistry?.cmos).toBeDefined();
  });

  it("all_gates_support_digital_and_cmos", () => {
    const registry = makeGateRegistry();
    for (const name of GATE_NAMES) {
      const def = registry.get(name)!;
      expect(def.models?.digital, `${name} should have digital model`).toBeDefined();
      expect(def.modelRegistry?.cmos, `${name} should have analog model`).toBeDefined();
    }
  });
});
