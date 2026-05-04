/** Tests for the AnalogResistor component and voltage divider integration. */

import { describe, it, expect } from "vitest";
import { ResistorDefinition } from "../resistor.js";
import { PropertyBag } from "../../../core/properties.js";
import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";

import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";
function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}


describe("Resistor", () => {
  it("branch_index_is_minus_one", () => {
    const props = new PropertyBag(); props.replaceModelParams({ resistance: 1000 });
    const element = getFactory(ResistorDefinition.modelRegistry!.behavioral!)(new Map([["pos", 1], ["neg", 2]]), props, () => 0);

    expect(element.branchIndex).toBe(-1);
  });
});

describe("Integration", () => {
  it("voltage_divider_dc_op", () => {
    // Circuit:  Vs=10V → R1=1k → junction → R2=2k → GND.
    // V(junction) = 10 * 2000/(1000+2000) = 6.6666... V (analytical divider).
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: 10 } },
          { id: "r1",  type: "Resistor",        props: { label: "r1",  resistance: 1000 } },
          { id: "r2",  type: "Resistor",        props: { label: "r2",  resistance: 2000 } },
          { id: "gnd", type: "Ground" },
        ],
        connections: [
          ["vs:pos", "r1:pos"],
          ["r1:neg", "r2:pos"],
          ["r2:neg", "gnd:out"],
          ["vs:neg", "gnd:out"],
        ],
      }),
    });

    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);

    // Junction node = r1:neg = r2:pos. Either label resolves to the same MNA node.
    const junctionNode = fix.circuit.labelToNodeId.get("r1:neg");
    expect(junctionNode).not.toBeUndefined();
    const vJunction = fix.engine.getNodeVoltage(junctionNode!);
    expect(vJunction).toBeCloseTo(10 * 2000 / 3000, 6);

    // Top of the divider is held to 10V by the voltage source.
    const topNode = fix.circuit.labelToNodeId.get("vs:pos");
    expect(topNode).not.toBeUndefined();
    const vTop = fix.engine.getNodeVoltage(topNode!);
    expect(vTop).toBeCloseTo(10, 6);
  });
});
