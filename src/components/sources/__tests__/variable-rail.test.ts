/** Tests for the Variable Rail source component. */

import { describe, it, expect } from "vitest";
import { VariableRailDefinition } from "../variable-rail.js";
import { PropertyBag } from "../../../core/properties.js";
import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";

import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";
function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}

interface VRailCircuitParams {
  voltage: number;
  rBleed?: number;
}

function buildVRailCircuit(facade: DefaultSimulatorFacade, p: VRailCircuitParams): Circuit {
  return facade.build({
    components: [
      { id: "vrail", type: "VariableRail", props: { label: "vrail", voltage: p.voltage } },
      { id: "rb",    type: "Resistor",     props: { label: "rb", resistance: p.rBleed ?? 1e6 } },
      { id: "gnd",   type: "Ground" },
    ],
    connections: [
      ["vrail:pos", "rb:pos"],
      ["rb:neg",    "gnd:out"],
    ],
  });
}

function nodeOf(fix: ReturnType<typeof buildFixture>, label: string): number {
  const n = fix.circuit.labelToNodeId.get(label);
  if (n === undefined) throw new Error(`label '${label}' not in labelToNodeId`);
  return n;
}

describe("VariableRail", () => {
  it("dc_node_voltage_matches_set_voltage -- 12V rail settles to 12V at the pos node", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildVRailCircuit(facade, { voltage: 12 }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "vrail:pos"))).toBeCloseTo(12, 6);
  });

  it("zero_voltage_settles_to_zero -- 0V rail settles to 0V", () => {
    // Source stepping at srcFact=0 would kill an ordinary DC voltage source's
    // RHS during the inner DCOP sweep, but variable-rail.ts load() ignores
    // srcFact (vsrcload.c:416 path is replaced by an unconditional
    // `rhs[branch] += voltage`). Driving voltage=0 is the strongest external
    // proof of that contract: the converged solution is bit-exact 0V.
    const fix = buildFixture({
      build: (_r, facade) => buildVRailCircuit(facade, { voltage: 0 }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "vrail:pos"))).toBeCloseTo(0, 6);
  });

  it("voltage_change_via_setComponentProperty_takes_effect -- 5V then 10V", () => {
    // Hot-loadable param contract: the rail's `voltage` model param must be
    // mutable through coordinator.setComponentProperty (production slider
    // path) without recompiling. After the patch + a fresh DCOP, the rail
    // node must read the new voltage.
    const fix = buildFixture({
      build: (_r, facade) => buildVRailCircuit(facade, { voltage: 5 }),
    });
    const dc1 = fix.coordinator.dcOperatingPoint()!;
    expect(dc1.converged).toBe(true);
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "vrail:pos"))).toBeCloseTo(5, 6);

    const railEl = fix.circuit.elements.find((el) => el.label === "vrail")!;
    expect(railEl).toBeDefined();
    const rce = fix.circuit.elementToCircuitElement.get(
      fix.circuit.elements.indexOf(railEl),
    )!;
    fix.coordinator.setComponentProperty(rce, "voltage", 10);

    const dc2 = fix.coordinator.dcOperatingPoint()!;
    expect(dc2.converged).toBe(true);
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "vrail:pos"))).toBeCloseTo(10, 6);
  });

  it("definition_engine_type_analog -- behavioral model is registered", () => {
    expect(VariableRailDefinition.modelRegistry?.behavioral).toBeDefined();
  });

  it("analogFactory_creates_element -- factory returns a non-null element", () => {
    const props = new PropertyBag();
    props.replaceModelParams({ voltage: 7 });
    const el = getFactory(VariableRailDefinition.modelRegistry!.behavioral!)(
      new Map([["pos", 1]]),
      props,
      () => 0,
    );
    expect(el).toBeDefined();
  });

  it("element_allocates_branch_row_after_compile -- branchIndex > 0 in compiled circuit", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildVRailCircuit(facade, { voltage: 5 }),
    });
    const railEl = fix.circuit.elements.find((el) => el.label === "vrail")!;
    expect(railEl).toBeDefined();
    expect(railEl.branchIndex).toBeGreaterThan(0);
  });
});
