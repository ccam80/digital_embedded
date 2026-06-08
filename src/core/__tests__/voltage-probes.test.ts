/**
 * Integrity tests for component-declared voltageProbes.
 *
 * Every ComponentDefinition.voltageProbes entry must address pin labels that
 * actually exist in that component's resolved pinLayout, so the editor's
 * "Trace Voltage" differential action can always resolve both terminals.
 * Guards against typos like a probe naming a pin the component does not have.
 */

import { describe, it, expect } from "vitest";
import { createDefaultRegistry } from "../../components/register-all.js";
import { resolvePinLayout } from "../registry.js";
import { PropertyBag } from "../properties.js";

describe("voltageProbes integrity", () => {
  const registry = createDefaultRegistry();
  const defs = registry.getAllStandalone().filter(d => d.voltageProbes && d.voltageProbes.length > 0);

  it("at_least_the_core_passives_declare_probes", () => {
    const named = new Set(defs.map(d => d.name));
    for (const expected of ["Resistor", "Capacitor", "Inductor"]) {
      expect(named.has(expected)).toBe(true);
    }
  });

  for (const def of registry.getAllStandalone()) {
    const probes = def.voltageProbes;
    if (!probes || probes.length === 0) continue;

    it(`${def.name}_probes_reference_existing_pins`, () => {
      const pinLabels = new Set(resolvePinLayout(def, new PropertyBag()).map(p => p.label));
      for (const probe of probes) {
        expect(pinLabels.has(probe.pos), `${def.name} probe "${probe.name}" pos pin "${probe.pos}"`).toBe(true);
        expect(pinLabels.has(probe.neg), `${def.name} probe "${probe.name}" neg pin "${probe.neg}"`).toBe(true);
        expect(probe.pos).not.toBe(probe.neg);
      }
    });

    it(`${def.name}_probe_names_are_unique`, () => {
      const names = probes.map(p => p.name);
      expect(new Set(names).size).toBe(names.length);
    });
  }
});
