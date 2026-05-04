/**
 * Tests for the AnalogResistor component and voltage divider integration.
 *
 * §4c migration: the previous `voltage_divider_dc_op` test built a hand-rolled
 * `runDcOp` invocation with inline `makeResistor` / `makeInlineVoltageSource`
 * helpers (poison §3 pattern + deleted §4a `runDcOp`). It is replaced by a
 * `buildFixture`-based observable assertion using the registered
 * `DcVoltageSource`/`Resistor`/`Ground` components and the public engine
 * surface (`engine.getNodeVoltage`).
 *
 * Removed (category-1 deletion- engine-impersonator-via-comparison-harness):
 *   - `Resistor > stamp_places_four_conductance_entries`
 *   - `Resistor > resistance_from_props`
 *   - `Resistor > minimum_resistance_clamped`
 *   - `resistor_load_dcop_parity > 3-resistor divider Vs=5V R=1k/1k/1k matches ngspice bit-exact`
 *   - `resistor_load_interface > load(ctx) stamps G=1/R bit-exact for R=1kΩ`
 *
 * All five tests reached into per-NR-iteration matrix entries via
 * `ComparisonSession.getAttempt({ phase: "dcopDirect" })
 *  .iterations[N].ours.matrix[...]`. That call now returns `undefined`
 * because of comparison-harness phase-enum drift, but more importantly the
 * pattern itself is the engine-impersonator-via-comparison-harness path
 * (§4-equivalent violation- a finer-grained reach-around than `.load()` /
 * `.setup()` direct calls). Bit-exact `G = 1/R` resistor stamping is covered
 * by the ngspice harness parity tests in
 * `src/solver/analog/__tests__/ngspice-parity/resistive-divider.test.ts`,
 * which compare against the instrumented ngspice DLL via the harness MCP
 * tools rather than reaching into our own MNA matrix mid-iteration.
 */

import { describe, it, expect } from "vitest";
import { ResistorDefinition } from "../resistor.js";
import { PropertyBag } from "../../../core/properties.js";
import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";

// ---------------------------------------------------------------------------
// Helper: narrow ModelEntry to inline factory (throws if netlist kind)
// ---------------------------------------------------------------------------
import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";
function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}


// ---------------------------------------------------------------------------
// Resistor unit tests
// ---------------------------------------------------------------------------

describe("Resistor", () => {
  it("branch_index_is_minus_one", () => {
    const props = new PropertyBag(); props.replaceModelParams({ resistance: 1000 });
    const element = getFactory(ResistorDefinition.modelRegistry!.behavioral!)(new Map([["A", 1], ["B", 2]]), props, () => 0);

    expect(element.branchIndex).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// Integration: Voltage divider DC operating point
//
// §4c migration: previously hand-built three inline `AnalogElement` stubs and
// drove them through the deleted `runDcOp(...)` helper. Migrated to the
// canonical `buildFixture` path: registered `DcVoltageSource`/`Resistor`/
// `Ground` components, observed at the public `engine.getNodeVoltage(...)`
// surface. Asserts the analytical voltage-divider result V(node1)=Vs*R2/(R1+R2)
// rather than internal solver state.
// ---------------------------------------------------------------------------

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
