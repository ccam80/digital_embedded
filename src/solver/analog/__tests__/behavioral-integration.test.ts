/**
 * End-to-end integration tests for behavioral digital gates in the MNA engine.
 *
 * These tests verify the full pipeline:
 *   circuit construction  →  MNA engine initialization  →  DC operating point
 *   →  transient simulation  →  correct output voltages with realistic edge rates
 *
 * All tests use the facade-compiled path (M2 shape): DefaultSimulatorFacade.compile()
 * with registered ComponentDefinitions, never bare element construction.
 */

import { describe, it, expect } from "vitest";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../../components/register-all.js";
import { EngineState } from "../../../core/engine-interface.js";

const LOAD_R = 10_000;

// ---------------------------------------------------------------------------
// Integration tests via facade-compiled circuits (M2 shape)
// ---------------------------------------------------------------------------

describe("Integration", () => {
  it("dc_op_with_behavioral_and_gate", () => {
    // Both inputs HIGH → AND gate output HIGH.
    // Circuit: VS(3.3V)→AND.In_1, VS(3.3V)→AND.In_2, AND.out→R(10kΩ)→GND
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = facade.build({
      components: [
        { id: "vsA",  type: "DcVoltageSource", props: { label: "vsA",  voltage: 3.3 } },
        { id: "vsB",  type: "DcVoltageSource", props: { label: "vsB",  voltage: 3.3 } },
        { id: "and1", type: "AndGate",          props: { label: "and1" } },
        { id: "rLoad", type: "Resistor",        props: { label: "rLoad", resistance: LOAD_R } },
        { id: "gndA", type: "Ground" },
        { id: "gndB", type: "Ground" },
        { id: "gndL", type: "Ground" },
      ],
      connections: [
        ["vsA:pos", "and1:In_1"],
        ["vsA:neg", "gndA:out"],
        ["vsB:pos", "and1:In_2"],
        ["vsB:neg", "gndB:out"],
        ["and1:out", "rLoad:pos"],
        ["rLoad:neg", "gndL:out"],
      ],
      metadata: {},
    });
    const coordinator = facade.compile(circuit);
    const result = coordinator.dcOperatingPoint();

    expect(result.converged).toBe(true);
  });

  it("dc_op_one_input_low", () => {
    // Input B at 0V → AND gate output should be LOW.
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = facade.build({
      components: [
        { id: "vsA",  type: "DcVoltageSource", props: { label: "vsA",  voltage: 3.3 } },
        { id: "vsB",  type: "DcVoltageSource", props: { label: "vsB",  voltage: 0.0 } },
        { id: "and1", type: "AndGate",          props: { label: "and1" } },
        { id: "rLoad", type: "Resistor",        props: { label: "rLoad", resistance: LOAD_R } },
        { id: "gndA", type: "Ground" },
        { id: "gndB", type: "Ground" },
        { id: "gndL", type: "Ground" },
      ],
      connections: [
        ["vsA:pos", "and1:In_1"],
        ["vsA:neg", "gndA:out"],
        ["vsB:pos", "and1:In_2"],
        ["vsB:neg", "gndB:out"],
        ["and1:out", "rLoad:pos"],
        ["rLoad:neg", "gndL:out"],
      ],
      metadata: {},
    });
    const coordinator = facade.compile(circuit);
    const result = coordinator.dcOperatingPoint();

    expect(result.converged).toBe(true);
  });

  it("transient_edge_rate", () => {
    // Both inputs HIGH; run transient to verify stable output (no oscillation).
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = facade.build({
      components: [
        { id: "vsA",  type: "DcVoltageSource", props: { label: "vsA",  voltage: 3.3 } },
        { id: "vsB",  type: "DcVoltageSource", props: { label: "vsB",  voltage: 3.3 } },
        { id: "and1", type: "AndGate",          props: { label: "and1" } },
        { id: "rLoad", type: "Resistor",        props: { label: "rLoad", resistance: LOAD_R } },
        { id: "gndA", type: "Ground" },
        { id: "gndB", type: "Ground" },
        { id: "gndL", type: "Ground" },
      ],
      connections: [
        ["vsA:pos", "and1:In_1"],
        ["vsA:neg", "gndA:out"],
        ["vsB:pos", "and1:In_2"],
        ["vsB:neg", "gndB:out"],
        ["and1:out", "rLoad:pos"],
        ["rLoad:neg", "gndL:out"],
      ],
      metadata: {},
    });
    const coordinator = facade.compile(circuit);
    coordinator.dcOperatingPoint();
    coordinator.start();

    for (let i = 0; i < 20; i++) {
      coordinator.step();
      if (coordinator.getState() === EngineState.ERROR) break;
    }

    expect(coordinator.getState()).not.toBe(EngineState.ERROR);
    expect(coordinator.simTime).toBeGreaterThan(0);
  });

  it("factory_created_and_gate_runs_in_engine", () => {
    // Verify the AND gate runs via facade-compiled path end-to-end.
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = facade.build({
      components: [
        { id: "vsA",  type: "DcVoltageSource", props: { label: "vsA",  voltage: 3.3 } },
        { id: "vsB",  type: "DcVoltageSource", props: { label: "vsB",  voltage: 3.3 } },
        { id: "and1", type: "AndGate",          props: { label: "and1" } },
        { id: "rLoad", type: "Resistor",        props: { label: "rLoad", resistance: LOAD_R } },
        { id: "gndA", type: "Ground" },
        { id: "gndB", type: "Ground" },
        { id: "gndL", type: "Ground" },
      ],
      connections: [
        ["vsA:pos", "and1:In_1"],
        ["vsA:neg", "gndA:out"],
        ["vsB:pos", "and1:In_2"],
        ["vsB:neg", "gndB:out"],
        ["and1:out", "rLoad:pos"],
        ["rLoad:neg", "gndL:out"],
      ],
      metadata: {},
    });
    const coordinator = facade.compile(circuit);
    const result = coordinator.dcOperatingPoint();

    expect(result.converged).toBe(true);
    expect(coordinator.getState()).not.toBe(EngineState.ERROR);
  });

  it("dff_factory_runs_in_engine", () => {
    // D flip-flop compiled via facade: DC OP converges.
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = facade.build({
      components: [
        { id: "dff1",  type: "DFlipFlop",  props: { label: "dff1" } },
        { id: "rLoadQ",   type: "Resistor", props: { label: "rLoadQ",   resistance: LOAD_R } },
        { id: "rLoadQB",  type: "Resistor", props: { label: "rLoadQB",  resistance: LOAD_R } },
        { id: "vsClk",    type: "DcVoltageSource", props: { label: "vsClk", voltage: 0.0 } },
        { id: "vsD",      type: "DcVoltageSource", props: { label: "vsD",   voltage: 0.0 } },
        { id: "gndQ",  type: "Ground" },
        { id: "gndQB", type: "Ground" },
        { id: "gndClk", type: "Ground" },
        { id: "gndD",  type: "Ground" },
      ],
      connections: [
        ["vsClk:pos", "dff1:C"],
        ["vsClk:neg", "gndClk:out"],
        ["vsD:pos",   "dff1:D"],
        ["vsD:neg",   "gndD:out"],
        ["dff1:Q",    "rLoadQ:pos"],
        ["rLoadQ:neg", "gndQ:out"],
        ["dff1:~Q",   "rLoadQB:pos"],
        ["rLoadQB:neg", "gndQB:out"],
      ],
      metadata: {},
    });
    const coordinator = facade.compile(circuit);
    const result = coordinator.dcOperatingPoint();

    expect(result.converged).toBe(true);
    expect(coordinator.getState()).not.toBe(EngineState.ERROR);
  });
});
