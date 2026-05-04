/**
 * Tests for Current-Controlled Current Source (CCCS) analog element.
 *
 * Test pattern (per §4c/§4d): every test routes through `buildFixture`,
 * uses the registered `DcVoltageSource` for both source and sense roles, and
 * verifies behaviour via the public coordinator surface (dcOperatingPoint /
 * engine.getNodeVoltage). No hand-rolled CompiledAnalogCircuit, no fake
 * StatePool, no engine impersonators.
 *
 * Circuit shape:
 *   Vs → R_sense → senseVsrc(0V) → GND
 *                  └─ cccs:sense+
 *   cccs:sense- → GND
 *   cccs:out+   → R_load → GND
 *   cccs:out-   → GND
 *
 *   I_sense = Vs / R_sense (the 0V senseVsrc forces the node to 0V and
 *   measures the current through R_sense).
 *   I_out   = currentGain * I_sense  (default expression "I(sense)").
 *   V(R_load) = I_out * R_load
 */

import { describe, it, expect } from "vitest";
import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";

import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

// ---------------------------------------------------------------------------
// Circuit factory
// ---------------------------------------------------------------------------

interface CccsCircuitParams {
  vsVoltage?: number;
  rSense?: number;
  rLoad?: number;
  currentGain?: number;
  expression?: string;
  /** Drop the senseSourceLabel prop so setup() throws the canonical error. */
  omitSenseLabel?: boolean;
}

function buildCccsCircuit(facade: DefaultSimulatorFacade, p: CccsCircuitParams): Circuit {
  const cccsProps: Record<string, string | number> = {
    label: "cccs1",
    expression: p.expression ?? "I(sense)",
    currentGain: p.currentGain ?? 1.0,
  };
  if (p.omitSenseLabel !== true) {
    cccsProps.senseSourceLabel = "senseVsrc";
  }
  return facade.build({
    components: [
      { id: "vs",        type: "DcVoltageSource", props: { label: "vs1",       voltage: p.vsVoltage ?? 5.0 } },
      { id: "rsense",    type: "Resistor",        props: { label: "rsense",    resistance: p.rSense ?? 1000 } },
      { id: "senseVsrc", type: "DcVoltageSource", props: { label: "senseVsrc", voltage: 0 } },
      { id: "cccs",      type: "CCCS",            props: cccsProps },
      { id: "rload",     type: "Resistor",        props: { label: "rload",     resistance: p.rLoad ?? 1000 } },
      { id: "gnd",       type: "Ground" },
    ],
    connections: [
      ["vs:pos",        "rsense:pos"],
      ["rsense:neg",    "senseVsrc:pos"],
      ["senseVsrc:pos", "cccs:sense+"],
      ["senseVsrc:neg", "gnd:out"],
      ["cccs:sense-",   "gnd:out"],
      ["cccs:out+",     "rload:pos"],
      ["rload:neg",     "gnd:out"],
      ["cccs:out-",     "gnd:out"],
      ["vs:neg",        "gnd:out"],
    ],
  });
}

function nodeOf(fix: ReturnType<typeof buildFixture>, label: string): number {
  const n = fix.circuit.labelToNodeId.get(label);
  if (n === undefined) throw new Error(`label '${label}' not in labelToNodeId`);
  return n;
}

// ---------------------------------------------------------------------------
// CCCS tests
// ---------------------------------------------------------------------------

describe("CCCS", () => {
  it("current_mirror_gain_1", () => {
    // I_sense = 5V/1kΩ = 5mA, gain=1 → I_out=5mA
    // V(rload+) = 5mA * 1kΩ = 5V
    const fix = buildFixture({
      build: (_r, facade) => buildCccsCircuit(facade, { vsVoltage: 5.0, rSense: 1000, rLoad: 1000, currentGain: 1 }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);

    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "cccs1:out+"));
    expect(vOut).toBeCloseTo(5.0, 4);
  });

  it("current_gain_10", () => {
    // I_sense = 1V/1kΩ = 1mA, gain=10 → I_out=10mA
    // V(rload+) = 10mA * 1kΩ = 10V
    const fix = buildFixture({
      build: (_r, facade) => buildCccsCircuit(facade, { vsVoltage: 1.0, rSense: 1000, rLoad: 1000, currentGain: 10 }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);

    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "cccs1:out+"));
    expect(vOut).toBeCloseTo(10.0, 4);
  });

  it("nonlinear_expression", () => {
    // expression: 0.1 * I(sense)^2; I_sense = 10V/1kΩ = 10mA = 0.01A
    // I_out = 0.1 * (0.01)^2 = 1e-5 A = 10µA
    // V(rload+) = 10µA * 1kΩ = 10mV
    const fix = buildFixture({
      build: (_r, facade) => buildCccsCircuit(facade, { vsVoltage: 10.0, rSense: 1000, rLoad: 1000, expression: "0.1 * I(sense)^2" }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);

    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "cccs1:out+"));
    expect(vOut).toBeCloseTo(0.01, 4);
  });

  it("setup_throws_without_senseSourceLabel", () => {
    // If senseSourceLabel is not set, setup() must throw the canonical error.
    // buildFixture's warm-start calls coordinator.step() which runs _setup(),
    // so the throw surfaces here.
    expect(() => buildFixture({
      build: (_r, facade) => buildCccsCircuit(facade, { omitSenseLabel: true }),
    })).toThrow(/senseSourceLabel not set/);
  });
});
