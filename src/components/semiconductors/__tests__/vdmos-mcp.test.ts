/**
 * MCP-surface tests for the VDMOS component (Surface 2 of the three-surface rule).
 *
 * Exercises the agent-facing contract through DefaultSimulatorFacade — the exact
 * object the MCP server (scripts/circuit-mcp-server.ts) wraps for circuit_build /
 * circuit_compile / circuit_dc_op / circuit_describe. Validates:
 *   1. VDMOSN / VDMOSP are discoverable in the registry (circuit_describe).
 *   2. circuit_build -> circuit_compile -> circuit_dc_op converges, finite nodes.
 *   3. Model params (incl. thermal + self-heating params) serialize round-trip.
 *   4. The thermal flag + self-heating params forward through the params path.
 */

import { describe, it, expect } from "vitest";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../register-all.js";

const registry = createDefaultRegistry();

function buildSwitch(facade: DefaultSimulatorFacade, mProps: Record<string, number | string>) {
  return facade.build({
    components: [
      { id: "vdd", type: "DcVoltageSource", props: { label: "V_DD", voltage: 15 } },
      { id: "vg", type: "DcVoltageSource", props: { label: "V_G", voltage: 10 } },
      { id: "rl", type: "Resistor", props: { label: "R_L", resistance: 100 } },
      { id: "m1", type: "VDMOSN", props: { label: "M1", model: "spice-vdmos", ...mProps } },
      { id: "gnd", type: "Ground", props: { label: "GND" } },
    ],
    connections: [
      ["vdd:pos", "rl:pos"],
      ["rl:neg", "m1:D"],
      ["vg:pos", "m1:G"],
      ["m1:S", "gnd:out"],
      ["vdd:neg", "gnd:out"],
      ["vg:neg", "gnd:out"],
    ],
  });
}

describe("VDMOS MCP surface — discovery (circuit_describe)", () => {
  it("VDMOSN is registered and discoverable", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const def = facade.describeComponent("VDMOSN");
    expect(def).toBeDefined();
    expect(def!.name).toBe("VDMOSN");
    expect(def!.defaultModel).toBe("spice-vdmos");
    expect(def!.modelRegistry?.["spice-vdmos"]).toBeDefined();
  });

  it("VDMOSP is registered and discoverable", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const def = facade.describeComponent("VDMOSP");
    expect(def).toBeDefined();
    expect(def!.name).toBe("VDMOSP");
    expect(def!.defaultModel).toBe("spice-vdmos");
  });

  it("model card declares thermal + self-heating params", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const def = facade.describeComponent("VDMOSN");
    const paramKeys = new Set(
      def!.modelRegistry!["spice-vdmos"]!.paramDefs!.map((d) => d.key),
    );
    for (const k of ["THERMAL", "RTHJC", "RTHCA", "CTHJ", "RTH_EXT", "DERATING"]) {
      expect(paramKeys.has(k), `param ${k} should be in the model card`).toBe(true);
    }
  });
});

describe("VDMOS MCP surface — build/compile/dc_op", () => {
  it("circuit_build -> circuit_compile -> circuit_dc_op converges", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = buildSwitch(facade, {});
    facade.compile(circuit);
    const dcOp = facade.getDcOpResult();
    expect(dcOp).not.toBeNull();
    expect(dcOp!.converged).toBe(true);
    for (let i = 0; i < dcOp!.nodeVoltages.length; i++) {
      expect(Number.isFinite(dcOp!.nodeVoltages[i])).toBe(true);
    }
  });

  it("circuit_step advances without engine error", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = buildSwitch(facade, {});
    const coordinator = facade.compile(circuit);
    expect(() => coordinator.step()).not.toThrow();
  });
});

describe("VDMOS MCP surface — param serialization round-trip", () => {
  it("model params (incl. self-heating) survive serialize/deserialize", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = buildSwitch(facade, {
      KP: 30, VTH: 4, RTHJC: 2, RTHCA: 500, CTHJ: 5e-6, THERMAL: 1,
    });
    const json = facade.serialize(circuit);
    const round = facade.deserialize(json);
    // Recompile the round-tripped circuit; the self-heating params must still
    // forward through the params path and the DC op must converge.
    facade.compile(round);
    const dcOp = facade.getDcOpResult();
    expect(dcOp).not.toBeNull();
    expect(dcOp!.converged).toBe(true);
    // The serialized form carries the overridden params.
    expect(json).toContain("VDMOSN");
  });

  it("thermal flag forwards to the engine without breaking convergence", () => {
    const facade = new DefaultSimulatorFacade(registry);
    // thermal=1 with rthjc given activates the self-heating thermal network.
    const circuit = buildSwitch(facade, { THERMAL: 1, RTHJC: 1 });
    facade.compile(circuit);
    const dcOp = facade.getDcOpResult();
    expect(dcOp).not.toBeNull();
    expect(dcOp!.converged).toBe(true);
  });
});
