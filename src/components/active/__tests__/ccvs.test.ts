/**
 * Tests for Current-Controlled Voltage Source (CCVS) analog element.
 *
 * Test pattern (per §4c/§4d): every test routes through `buildFixture`,
 * uses the registered `DcVoltageSource` for both source and sense roles, and
 * verifies behaviour via the public coordinator surface (dcOperatingPoint /
 * engine.getNodeVoltage). No hand-rolled CompiledAnalogCircuit, no fake
 * StatePool, no engine impersonators.
 *
 * Circuit shape:
 *   Vs → R_sense → senseVsrc(0V) → GND
 *                  └─ ccvs:sense+
 *   ccvs:sense- → GND
 *   ccvs:out+ → R_load → GND
 *   ccvs:out- → GND
 *
 *   I_sense = Vs / R_sense (the 0V senseVsrc forces the node to 0V and
 *   measures the current through R_sense).
 *   V_out   = transresistance * I_sense  (default expression "I(sense)").
 */

import { describe, it, expect } from "vitest";
import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";

import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

// ---------------------------------------------------------------------------
// Circuit factory
// ---------------------------------------------------------------------------

interface CcvsCircuitParams {
  vsVoltage?: number;
  rSense?: number;
  rLoad?: number;
  transresistance?: number;
  expression?: string;
  /** Drop the senseSourceLabel prop so setup() throws the canonical error. */
  omitSenseLabel?: boolean;
}

function buildCcvsCircuit(facade: DefaultSimulatorFacade, p: CcvsCircuitParams): Circuit {
  const ccvsProps: Record<string, string | number> = {
    label: "ccvs1",
    expression: p.expression ?? "I(sense)",
    transresistance: p.transresistance ?? 1000,
  };
  if (p.omitSenseLabel !== true) {
    ccvsProps.senseSourceLabel = "senseVsrc";
  }
  return facade.build({
    components: [
      { id: "vs",        type: "DcVoltageSource", props: { label: "vs1",       voltage: p.vsVoltage ?? 5.0 } },
      { id: "rsense",    type: "Resistor",        props: { label: "rsense",    resistance: p.rSense ?? 5000 } },
      { id: "senseVsrc", type: "DcVoltageSource", props: { label: "senseVsrc", voltage: 0 } },
      { id: "ccvs",      type: "CCVS",            props: ccvsProps },
      // The CCVS output is a stiff voltage source, but a floating output node
      // gives the matrix no DC reference for that subnet. R_load (1MΩ) ties
      // the output to ground without changing the senseport semantics.
      { id: "rload",     type: "Resistor",        props: { label: "rload",     resistance: 1e6 } },
      { id: "gnd",       type: "Ground" },
    ],
    connections: [
      ["vs:pos",        "rsense:pos"],
      ["rsense:neg",    "senseVsrc:pos"],
      ["senseVsrc:pos", "ccvs:sense+"],
      ["senseVsrc:neg", "gnd:out"],
      ["ccvs:sense-",   "gnd:out"],
      ["ccvs:out+",     "rload:pos"],
      ["rload:neg",     "gnd:out"],
      ["ccvs:out-",     "gnd:out"],
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
// CCVS tests
// ---------------------------------------------------------------------------

describe("CCVS", () => {
  it("transresistance_1k", () => {
    // I_sense = 5V/5kΩ = 1mA, rm=1000Ω → V_out = 1mA*1kΩ = 1V
    const fix = buildFixture({
      build: (_r, facade) => buildCcvsCircuit(facade, { transresistance: 1000 }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);

    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "ccvs1:out+"));
    expect(vOut).toBeCloseTo(1.0, 4);
  });

  it("zero_current_zero_output", () => {
    // Vs=0V → I_sense=0 → V_out=0
    const fix = buildFixture({
      build: (_r, facade) => buildCcvsCircuit(facade, { vsVoltage: 0, transresistance: 1000 }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);

    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "ccvs1:out+"));
    expect(vOut).toBeCloseTo(0.0, 6);
  });

  it("sense_port_zero_voltage_drop", () => {
    // The 0V sense source enforces V(sense+) = V(sense-) = 0V.
    // sense- is wired to GND, so V(sense+) must equal 0V.
    const fix = buildFixture({
      build: (_r, facade) => buildCcvsCircuit(facade, { transresistance: 1000 }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);

    const vSensePlus = fix.engine.getNodeVoltage(nodeOf(fix, "ccvs1:sense+"));
    expect(vSensePlus).toBeCloseTo(0.0, 6);
  });

  it("setup_throws_without_senseSourceLabel", () => {
    // If senseSourceLabel is not set, setup() must throw the canonical error.
    // buildFixture's warm-start calls coordinator.step() which runs _setup(),
    // so the throw surfaces here.
    expect(() => buildFixture({
      build: (_r, facade) => buildCcvsCircuit(facade, { omitSenseLabel: true }),
    })).toThrow(/senseSourceLabel not set/);
  });
});
