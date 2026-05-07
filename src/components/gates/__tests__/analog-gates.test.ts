import { describe, it, expect } from "vitest";

import { buildFixture, type Fixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import type { ComponentRegistry } from "../../../core/registry.js";
import type { Circuit } from "../../../core/circuit.js";
import type { CircuitElement } from "../../../core/element.js";

// ---------------------------------------------------------------------------
// Bench builders
//
// Two-input gates (And, NAnd, Or, NOr, XOr, XNOr) and the one-input Not gate
// share the same canonical topology: ideal DcVoltageSources drive each input
// through the gate's behavioral model, and a 10 k load resistor on the
// output references ground. Output is observed at the analog node "gate:out".
// ---------------------------------------------------------------------------

const VDD = 5.0;
const GND_V = 0.0;
const LOAD_R = 10_000;

function build2InputGate(gateType: string, vA: number, vB: number) {
  return (_registry: ComponentRegistry, facade: DefaultSimulatorFacade): Circuit => {
    return facade.build({
      components: [
        { id: "vsA",   type: "DcVoltageSource", props: { label: "vsA", voltage: vA } },
        { id: "vsB",   type: "DcVoltageSource", props: { label: "vsB", voltage: vB } },
        { id: "gate",  type: gateType,         props: { label: "gate", model: "behavioral", inputCount: 2 } },
        { id: "rLoad", type: "Resistor",       props: { label: "rLoad", resistance: LOAD_R } },
        { id: "gnd",   type: "Ground" },
      ],
      connections: [
        ["vsA:pos",   "gate:In_1"],
        ["vsB:pos",   "gate:In_2"],
        ["gate:out",  "rLoad:pos"],
        ["rLoad:neg", "gnd:out"],
        ["vsA:neg",   "gnd:out"],
        ["vsB:neg",   "gnd:out"],
      ],
    });
  };
}

function build1InputGate(gateType: string, vIn: number) {
  return (_registry: ComponentRegistry, facade: DefaultSimulatorFacade): Circuit => {
    return facade.build({
      components: [
        { id: "vsIn",  type: "DcVoltageSource", props: { label: "vsIn", voltage: vIn } },
        { id: "gate",  type: gateType,         props: { label: "gate", model: "behavioral" } },
        { id: "rLoad", type: "Resistor",       props: { label: "rLoad", resistance: LOAD_R } },
        { id: "gnd",   type: "Ground" },
      ],
      connections: [
        ["vsIn:pos",  "gate:in"],
        ["gate:out",  "rLoad:pos"],
        ["rLoad:neg", "gnd:out"],
        ["vsIn:neg",  "gnd:out"],
      ],
    });
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nodeOf(fix: Fixture, label: string): number {
  const n = fix.circuit.labelToNodeId.get(label);
  if (n === undefined) throw new Error(`label '${label}' not in labelToNodeId`);
  return n;
}

function ceByLabel(fix: Fixture, label: string): CircuitElement {
  for (const ce of fix.circuit.elementToCircuitElement.values()) {
    if (ce.getProperties().getOrDefault<string>("label", "") === label) return ce;
  }
  throw new Error(`CircuitElement with label '${label}' not found`);
}

// Closed-form voltage band for a gate driving the LOAD_R resistor to ground.
// vOH default is 5.0 V, vOL default is 0.0 V. With rOut = 100 the divider
// puts the output above 4.9 V for HIGH and below 0.05 V for LOW.
function expectHigh(v: number): void {
  expect(v).toBeGreaterThan(VDD * 0.9);
}
function expectLow(v: number): void {
  expect(v).toBeLessThan(VDD * 0.1);
}

// ---------------------------------------------------------------------------
// Category 1 - Initialization (T1)
//
// Post-warm-start: a representative two-input AND with both inputs HIGH
// produces a non-zero finite output node voltage at step 0.
// ---------------------------------------------------------------------------

describe("Analog gates initialization (T1)", () => {
  it("init_and_two_high_inputs_drives_output_high", () => {
    const fix = buildFixture({ build: build2InputGate("And", VDD, VDD) });
    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "gate:out"));
    expectHigh(vOut);
  });
});

// ---------------------------------------------------------------------------
// Category 2 - DC operating point analytical (T1)
//
// Each two-input gate is exercised at the four input combinations its
// truth table defines; the one-input Not gate covers both polarities.
// vOH default = 5.0 V, vOL default = 0.0 V. Closed-form expectation: HIGH
// outputs land near vOH (above VDD*0.9), LOW outputs land near vOL (below
// VDD*0.1).
// ---------------------------------------------------------------------------

describe("Analog gates DCOP truth table (T1)", () => {
  it("dcop_and_truth_table", () => {
    for (const [a, b, expected] of [
      [VDD,   VDD,   "high"],
      [VDD,   GND_V, "low"],
      [GND_V, VDD,   "low"],
      [GND_V, GND_V, "low"],
    ] as const) {
      const fix = buildFixture({ build: build2InputGate("And", a, b) });
      const dc = fix.coordinator.dcOperatingPoint();
      expect(dc).not.toBeNull();
      expect(dc!.converged).toBe(true);
      const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "gate:out"));
      if (expected === "high") expectHigh(vOut); else expectLow(vOut);
    }
  });

  it("dcop_nand_truth_table", () => {
    for (const [a, b, expected] of [
      [VDD,   VDD,   "low"],
      [VDD,   GND_V, "high"],
      [GND_V, VDD,   "high"],
      [GND_V, GND_V, "high"],
    ] as const) {
      const fix = buildFixture({ build: build2InputGate("NAnd", a, b) });
      const dc = fix.coordinator.dcOperatingPoint();
      expect(dc).not.toBeNull();
      expect(dc!.converged).toBe(true);
      const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "gate:out"));
      if (expected === "high") expectHigh(vOut); else expectLow(vOut);
    }
  });

  it("dcop_or_truth_table", () => {
    for (const [a, b, expected] of [
      [VDD,   VDD,   "high"],
      [VDD,   GND_V, "high"],
      [GND_V, VDD,   "high"],
      [GND_V, GND_V, "low"],
    ] as const) {
      const fix = buildFixture({ build: build2InputGate("Or", a, b) });
      const dc = fix.coordinator.dcOperatingPoint();
      expect(dc).not.toBeNull();
      expect(dc!.converged).toBe(true);
      const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "gate:out"));
      if (expected === "high") expectHigh(vOut); else expectLow(vOut);
    }
  });

  it("dcop_nor_truth_table", () => {
    for (const [a, b, expected] of [
      [VDD,   VDD,   "low"],
      [VDD,   GND_V, "low"],
      [GND_V, VDD,   "low"],
      [GND_V, GND_V, "high"],
    ] as const) {
      const fix = buildFixture({ build: build2InputGate("NOr", a, b) });
      const dc = fix.coordinator.dcOperatingPoint();
      expect(dc).not.toBeNull();
      expect(dc!.converged).toBe(true);
      const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "gate:out"));
      if (expected === "high") expectHigh(vOut); else expectLow(vOut);
    }
  });

  it("dcop_xor_truth_table", () => {
    for (const [a, b, expected] of [
      [VDD,   VDD,   "low"],
      [VDD,   GND_V, "high"],
      [GND_V, VDD,   "high"],
      [GND_V, GND_V, "low"],
    ] as const) {
      const fix = buildFixture({ build: build2InputGate("XOr", a, b) });
      const dc = fix.coordinator.dcOperatingPoint();
      expect(dc).not.toBeNull();
      expect(dc!.converged).toBe(true);
      const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "gate:out"));
      if (expected === "high") expectHigh(vOut); else expectLow(vOut);
    }
  });

  it("dcop_xnor_truth_table", () => {
    for (const [a, b, expected] of [
      [VDD,   VDD,   "high"],
      [VDD,   GND_V, "low"],
      [GND_V, VDD,   "low"],
      [GND_V, GND_V, "high"],
    ] as const) {
      const fix = buildFixture({ build: build2InputGate("XNOr", a, b) });
      const dc = fix.coordinator.dcOperatingPoint();
      expect(dc).not.toBeNull();
      expect(dc!.converged).toBe(true);
      const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "gate:out"));
      if (expected === "high") expectHigh(vOut); else expectLow(vOut);
    }
  });

  it("dcop_not_truth_table", () => {
    for (const [vIn, expected] of [
      [VDD,   "low"],
      [GND_V, "high"],
    ] as const) {
      const fix = buildFixture({ build: build1InputGate("Not", vIn) });
      const dc = fix.coordinator.dcOperatingPoint();
      expect(dc).not.toBeNull();
      expect(dc!.converged).toBe(true);
      const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "gate:out"));
      if (expected === "high") expectHigh(vOut); else expectLow(vOut);
    }
  });
});

// ---------------------------------------------------------------------------
// Category 4 - Parameter hot-load (T1)
//
// vOH and vOL are documented behavioral-model output-rail parameters
// shared by every gate type. Raising vOH on a HIGH-driving gate raises
// V(gate:out); raising vOL on a LOW-driving gate raises V(gate:out).
// ---------------------------------------------------------------------------

describe("Analog gates parameter hot-load (T1)", () => {
  it("hotload_vOH_raises_high_output_voltage", () => {
    // And gate, both inputs HIGH - output is HIGH at default vOH = 5.0 V.
    const fix = buildFixture({ build: build2InputGate("And", VDD, VDD) });
    const outNode = nodeOf(fix, "gate:out");
    const before = fix.engine.getNodeVoltage(outNode);

    const gate = ceByLabel(fix, "gate");
    fix.coordinator.setComponentProperty(gate, "vOH", 8.0);
    fix.coordinator.step();

    const after = fix.engine.getNodeVoltage(outNode);
    // Documented contract: vOH is the HIGH-rail target voltage; raising
    // vOH must raise V(gate:out).
    expect(after).not.toBeCloseTo(before);
    expect(Math.sign(after - before)).toBe(1);
  });

  it("hotload_vOL_raises_low_output_voltage", () => {
    // And gate, both inputs LOW - output is LOW at default vOL = 0.0 V.
    const fix = buildFixture({ build: build2InputGate("And", GND_V, GND_V) });
    const outNode = nodeOf(fix, "gate:out");
    const before = fix.engine.getNodeVoltage(outNode);

    const gate = ceByLabel(fix, "gate");
    fix.coordinator.setComponentProperty(gate, "vOL", 1.0);
    fix.coordinator.step();

    const after = fix.engine.getNodeVoltage(outNode);
    // Documented contract: vOL is the LOW-rail target voltage; raising
    // vOL must raise V(gate:out).
    expect(after).not.toBeCloseTo(before);
    expect(Math.sign(after - before)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Category 9 - Bridge / digital interaction (T1)
//
// Every gate type registered through this aggregate file carries a
// behavioral analog model whose contract is "drive the input(s) at the
// analog surface; observe the documented digital truth-table value at
// the output." One it() per gate type asserts a representative truth
// table row that forces a HIGH or LOW output transition - the canonical
// observable for this digital-bridge category.
// ---------------------------------------------------------------------------

describe("Analog gates digital truth table (T1, Cat 9)", () => {
  it("bridge_and_high_high_drives_output_high", () => {
    const fix = buildFixture({ build: build2InputGate("And", VDD, VDD) });
    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "gate:out"));
    expectHigh(vOut);
  });

  it("bridge_nand_high_high_drives_output_low", () => {
    const fix = buildFixture({ build: build2InputGate("NAnd", VDD, VDD) });
    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "gate:out"));
    expectLow(vOut);
  });

  it("bridge_or_low_low_drives_output_low", () => {
    const fix = buildFixture({ build: build2InputGate("Or", GND_V, GND_V) });
    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "gate:out"));
    expectLow(vOut);
  });

  it("bridge_nor_low_low_drives_output_high", () => {
    const fix = buildFixture({ build: build2InputGate("NOr", GND_V, GND_V) });
    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "gate:out"));
    expectHigh(vOut);
  });

  it("bridge_xor_high_low_drives_output_high", () => {
    const fix = buildFixture({ build: build2InputGate("XOr", VDD, GND_V) });
    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "gate:out"));
    expectHigh(vOut);
  });

  it("bridge_xnor_high_low_drives_output_low", () => {
    const fix = buildFixture({ build: build2InputGate("XNOr", VDD, GND_V) });
    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "gate:out"));
    expectLow(vOut);
  });

  it("bridge_not_high_drives_output_low", () => {
    const fix = buildFixture({ build: build1InputGate("Not", VDD) });
    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "gate:out"));
    expectLow(vOut);
  });
});
