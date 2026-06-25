/**
 * Tests for SimulationCoordinator.prepareSetup()- the structural setup pass the
 * editor runs after compile in place of a standalone DC operating point.
 *
 * prepareSetup() triggers MNAEngine._setup() (matrix allocation + post-setup
 * topology detectors) and nothing else: no Newton-Raphson solve, no operating
 * point, no transient step. The post-setup topology diagnostics it emits must
 * match what dcOperatingPoint() surfaces, and a later step()/dcOperatingPoint()
 * must still run the warm-start operating point over the same allocation.
 */

import { describe, it, expect } from "vitest";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../../components/register-all.js";
import type { CircuitSpec } from "../../../headless/netlist-types.js";

function compile(spec: CircuitSpec) {
  const facade = new DefaultSimulatorFacade(createDefaultRegistry());
  const circuit = facade.build(spec);
  const coordinator = facade.compile(circuit);
  return { facade, coordinator };
}

const COMPETING_SOURCES: CircuitSpec = {
  components: [
    { id: "vs1", type: "DcVoltageSource", props: { label: "vs1", voltage: 5 } },
    { id: "vs2", type: "DcVoltageSource", props: { label: "vs2", voltage: 3 } },
    { id: "r1", type: "Resistor", props: { label: "r1", resistance: 1000 } },
    { id: "gnd", type: "Ground" },
  ],
  connections: [
    ["vs1:pos", "vs2:pos"],
    ["vs2:pos", "r1:pos"],
    ["vs1:neg", "vs2:neg"],
    ["vs2:neg", "r1:neg"],
    ["r1:neg", "gnd:out"],
  ],
};

const CLEAN_RC: CircuitSpec = {
  components: [
    { id: "vs", type: "DcVoltageSource", props: { label: "vs", voltage: 5 } },
    { id: "r1", type: "Resistor", props: { label: "r1", resistance: 1000 } },
    { id: "c1", type: "Capacitor", props: { label: "c1", capacitance: 1e-6 } },
    { id: "gnd", type: "Ground" },
  ],
  connections: [
    ["vs:pos", "r1:pos"],
    ["r1:neg", "c1:pos"],
    ["c1:neg", "gnd:out"],
    ["vs:neg", "gnd:out"],
  ],
};

describe("prepareSetup", () => {
  it("surfaces post-setup topology diagnostics without an operating point", () => {
    const { coordinator } = compile(COMPETING_SOURCES);

    // No analysis has run yet- no diagnostics emitted.
    expect(coordinator.getRuntimeDiagnostics().length).toBe(0);

    coordinator.prepareSetup();

    const competing = coordinator
      .getRuntimeDiagnostics()
      .filter((d) => d.code === "competing-voltage-constraints");
    expect(competing.length).toBeGreaterThanOrEqual(1);
    expect(competing[0].severity).toBe("error");
  });

  it("emits no error diagnostics for a well-formed circuit", () => {
    const { coordinator } = compile(CLEAN_RC);
    coordinator.prepareSetup();
    const errors = coordinator
      .getRuntimeDiagnostics()
      .filter((d) => d.severity === "error");
    expect(errors.length).toBe(0);
  });

  it("does not advance the transient timeline", () => {
    const { coordinator } = compile(CLEAN_RC);
    const before = coordinator.simTime;
    coordinator.prepareSetup();
    // No step ran: simTime is unchanged (still the pre-step bias-time value).
    expect(coordinator.simTime).toBe(before);
  });

  it("is idempotent and leaves the engine ready for a subsequent step", () => {
    const { facade, coordinator } = compile(CLEAN_RC);
    coordinator.prepareSetup();
    coordinator.prepareSetup();

    // The warm-start operating point + first transient step still run cleanly
    // over the setup-allocated matrix.
    expect(() => facade.step(coordinator)).not.toThrow();
    expect(coordinator.simTime).not.toBeNull();
    expect(coordinator.simTime!).toBeGreaterThan(0);
  });

  it("matches the topology diagnostics dcOperatingPoint() would surface", () => {
    const viaSetup = compile(COMPETING_SOURCES).coordinator;
    viaSetup.prepareSetup();
    const setupCodes = new Set(viaSetup.getRuntimeDiagnostics().map((d) => d.code));

    const viaDcOp = compile(COMPETING_SOURCES).coordinator;
    try {
      viaDcOp.dcOperatingPoint();
    } catch {
      /* singular matrix from the competing sources is expected */
    }
    const dcOpCodes = new Set(viaDcOp.getRuntimeDiagnostics().map((d) => d.code));

    expect(setupCodes.has("competing-voltage-constraints")).toBe(true);
    expect(dcOpCodes.has("competing-voltage-constraints")).toBe(true);
  });

  it("is a no-op for a digital-only circuit (no analog backend)", () => {
    const { coordinator } = compile({
      components: [
        { id: "in1", type: "In", props: { label: "in1" } },
        { id: "g1", type: "And", props: { label: "g1" } },
        { id: "in2", type: "In", props: { label: "in2" } },
        { id: "out1", type: "Out", props: { label: "out1" } },
      ],
      connections: [
        ["in1:out", "g1:In_1"],
        ["in2:out", "g1:In_2"],
        ["g1:out", "out1:in"],
      ],
    });
    expect(() => coordinator.prepareSetup()).not.toThrow();
    expect(coordinator.getRuntimeDiagnostics().length).toBe(0);
  });
});
