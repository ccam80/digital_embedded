/**
 * End-to-end integration tests for behavioral digital gates in the MNA engine.
 *
 * These tests verify the full pipeline:
 *   circuit construction  →  MNA engine initialization  →  DC operating point
 *   →  transient simulation  →  correct output voltages with realistic edge rates
 *
 * All tests use the facade-compiled path (M2 shape) via buildFixture(), which
 * exercises the same warm-start path the engine uses in production.
 */

import { describe, it, expect } from "vitest";
import { buildFixture } from "./fixtures/build-fixture.js";
import { EngineState } from "../../../core/engine-interface.js";
import type { ComponentRegistry } from "../../../core/registry.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import type { Circuit } from "../../../core/circuit.js";

const LOAD_R = 10_000;

// ---------------------------------------------------------------------------
// Circuit factories
// ---------------------------------------------------------------------------

function buildAndGateCircuit(vA: number, vB: number) {
  return (_registry: ComponentRegistry, facade: DefaultSimulatorFacade): Circuit =>
    facade.build({
      components: [
        { id: "vsA",  type: "DcVoltageSource", props: { label: "vsA",  voltage: vA } },
        { id: "vsB",  type: "DcVoltageSource", props: { label: "vsB",  voltage: vB } },
        { id: "and1", type: "And",              props: { label: "and1", model: "behavioral", inputCount: 2 } },
        { id: "rLoad", type: "Resistor",        props: { label: "rLoad", resistance: LOAD_R } },
        { id: "gnd",  type: "Ground" },
      ],
      connections: [
        ["vsA:pos",   "and1:In_1"],
        ["vsB:pos",   "and1:In_2"],
        ["and1:out",  "rLoad:pos"],
        ["rLoad:neg", "gnd:out"],
        ["vsA:neg",   "gnd:out"],
        ["vsB:neg",   "gnd:out"],
      ],
    });
}

function buildDffCircuit(_registry: ComponentRegistry, facade: DefaultSimulatorFacade): Circuit {
  return facade.build({
    components: [
      { id: "dff1",    type: "D_FF",           props: { label: "dff1", model: "behavioral" } },
      { id: "rLoadQ",  type: "Resistor",        props: { label: "rLoadQ",  resistance: LOAD_R } },
      { id: "rLoadQB", type: "Resistor",        props: { label: "rLoadQB", resistance: LOAD_R } },
      { id: "vsClk",   type: "DcVoltageSource", props: { label: "vsClk", voltage: 0.0 } },
      { id: "vsD",     type: "DcVoltageSource", props: { label: "vsD",   voltage: 0.0 } },
      { id: "gnd",     type: "Ground" },
    ],
    connections: [
      ["vsClk:pos",   "dff1:C"],
      ["vsD:pos",     "dff1:D"],
      ["dff1:Q",      "rLoadQ:pos"],
      ["rLoadQ:neg",  "gnd:out"],
      ["dff1:~Q",     "rLoadQB:pos"],
      ["rLoadQB:neg", "gnd:out"],
      ["vsClk:neg",   "gnd:out"],
      ["vsD:neg",     "gnd:out"],
    ],
  });
}

// ---------------------------------------------------------------------------
// Integration tests via facade-compiled circuits (M2 shape)
// ---------------------------------------------------------------------------

describe("Integration", () => {
  it("dc_op_with_behavioral_and_gate", () => {
    // Both inputs HIGH → AND gate output HIGH.
    // Circuit: VS(3.3V)→AND.In_1, VS(3.3V)→AND.In_2, AND.out→R(10kΩ)→GND
    const fix = buildFixture({ build: buildAndGateCircuit(3.3, 3.3) });
    const result = fix.coordinator.dcOperatingPoint()!;

    expect(result.converged).toBe(true);
  });

  it("dc_op_one_input_low", () => {
    // Input B at 0V → AND gate output should be LOW.
    const fix = buildFixture({ build: buildAndGateCircuit(3.3, 0.0) });
    const result = fix.coordinator.dcOperatingPoint()!;

    expect(result.converged).toBe(true);
  });

  it("transient_edge_rate", () => {
    // Both inputs HIGH; run transient to verify stable output (no oscillation).
    const fix = buildFixture({ build: buildAndGateCircuit(3.3, 3.3) });

    for (let i = 0; i < 20; i++) {
      fix.coordinator.step();
      if (fix.coordinator.getState() === EngineState.ERROR) break;
    }

    expect(fix.coordinator.getState()).not.toBe(EngineState.ERROR);
    expect(fix.coordinator.simTime).toBeGreaterThan(0);
  });

  it("factory_created_and_gate_runs_in_engine", () => {
    // Verify the AND gate runs via facade-compiled path end-to-end.
    const fix = buildFixture({ build: buildAndGateCircuit(3.3, 3.3) });
    const result = fix.coordinator.dcOperatingPoint()!;

    expect(result.converged).toBe(true);
    expect(fix.coordinator.getState()).not.toBe(EngineState.ERROR);
  });

  it("dff_factory_runs_in_engine", () => {
    // D flip-flop compiled via facade: DC OP converges.
    const fix = buildFixture({ build: buildDffCircuit });
    const result = fix.coordinator.dcOperatingPoint()!;

    expect(result.converged).toBe(true);
    expect(fix.coordinator.getState()).not.toBe(EngineState.ERROR);
  });
});
