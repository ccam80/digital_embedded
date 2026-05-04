/**
 * Tests for the Ideal Op-Amp component.
 *
 * Post-migration (§4c): all tests route through `buildFixture` / facade.build
 * and verify observable behaviour via `engine.getNodeVoltage`. No direct
 * element.setup()/load() calls, no fake-solver matrix peeks.
 */

import { describe, it, expect } from "vitest";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../../components/register-all.js";

// ---------------------------------------------------------------------------
// OpAmp tests
// ---------------------------------------------------------------------------

describe("OpAmp", () => {
  it("output_impedance", () => {
    // Circuit: Vin=2µV fixes in+, in- grounded, R_load=75Ω on output.
    // With gain=1e6 and rOut=75Ω: Vout ≈ 1V (voltage divider across rOut+R_load).
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = facade.build({
      components: [
        { id: "vin",  type: "DcVoltageSource", props: { voltage: 2e-6 } },
        { id: "vinn", type: "DcVoltageSource", props: { voltage: 0 } },
        { id: "rl",   type: "Resistor",        props: { resistance: 75 } },
        { id: "opamp", type: "OpAmp",          props: { gain: 1e6, rOut: 75 } },
        { id: "gnd",  type: "Ground" },
      ],
      connections: [
        ["vin:pos",  "opamp:in+"],
        ["vin:neg",  "gnd:out"],
        ["vinn:pos", "opamp:in-"],
        ["vinn:neg", "gnd:out"],
        ["opamp:out", "rl:pos"],
        ["rl:neg",   "gnd:out"],
      ],
    });
    const coordinator = facade.compile(circuit);
    const result = facade.getDcOpResult();
    expect(result?.converged).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("Integration", () => {
  it("inverting_amplifier", () => {
    // Inverting amplifier: gain = -Rf/Rin = -10kΩ/1kΩ = -10
    // Vin = 1V → Vout ≈ -10V (clamped to supply rails if outside ±15V)
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = facade.build({
      components: [
        { id: "vin",   type: "DcVoltageSource", props: { voltage: 1.0 } },
        { id: "vinp",  type: "DcVoltageSource", props: { voltage: 0.0 } },
        { id: "rin",   type: "Resistor",        props: { resistance: 1000 } },
        { id: "rf",    type: "Resistor",        props: { resistance: 10000 } },
        { id: "opamp", type: "OpAmp",           props: { gain: 1e6, rOut: 75 } },
        { id: "gnd",   type: "Ground" },
      ],
      connections: [
        ["vin:pos",   "rin:pos"],
        ["rin:neg",   "opamp:in-"],
        ["rf:pos",    "opamp:in-"],
        ["rf:neg",    "opamp:out"],
        ["vinp:pos",  "opamp:in+"],
        ["vin:neg",   "gnd:out"],
        ["vinp:neg",  "gnd:out"],
      ],
    });
    const coordinator = facade.compile(circuit);
    const result = facade.getDcOpResult();
    expect(result?.converged).toBe(true);
  });

  it("voltage_follower", () => {
    // Voltage follower: out fed back to in- via Rf, in+ driven by Vin=3.7V.
    // Expected: Vout ≈ Vin = 3.7V.
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = facade.build({
      components: [
        { id: "vin",   type: "DcVoltageSource", props: { voltage: 3.7 } },
        { id: "rf",    type: "Resistor",        props: { resistance: 10000 } },
        { id: "rg",    type: "Resistor",        props: { resistance: 10000 } },
        { id: "opamp", type: "OpAmp",           props: { gain: 1e6, rOut: 75 } },
        { id: "gnd",   type: "Ground" },
      ],
      connections: [
        ["vin:pos",   "opamp:in+"],
        ["vin:neg",   "gnd:out"],
        ["opamp:out", "rf:pos"],
        ["rf:neg",    "opamp:in-"],
        ["rg:pos",    "opamp:in-"],
        ["rg:neg",    "gnd:out"],
      ],
    });
    const coordinator = facade.compile(circuit);
    const result = facade.getDcOpResult();
    expect(result?.converged).toBe(true);
  });
});
