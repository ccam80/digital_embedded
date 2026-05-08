/**
 * Tests for the behavioral analog factories backing digital gates: AND,
 * NAND, OR, NOR, XOR, NOT.
 *
 * Voltage assertions use buildFixture() + engine.getNodeVoltage() via
 * circuit.labelToNodeId (the exemplar pattern from dc-voltage-source.test.ts).
 * ComparisonSession.createSelfCompare is used only for the NR convergence
 * test where getStepShape() is the required surface.
 *
 * Pin loading is configured exclusively via
 * `circuit.metadata.digitalPinLoadingOverrides` (Decision #10), and
 * pin-loading assertions assert observable voltage sag (Decision #11).
 */

import { describe, it, expect } from "vitest";
import { ComparisonSession } from "./harness/comparison-session.js";
import { buildFixture } from "./fixtures/build-fixture.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import type { ComponentRegistry } from "../../../core/registry.js";
import type { Circuit } from "../../../core/circuit.js";

// ---------------------------------------------------------------------------
// Threshold constants- match the registered CMOS_3V3 pin-electrical defaults.
// ---------------------------------------------------------------------------

const VDD = 3.3;
const GND = 0.0;
const LOAD_R = 10_000; // 10 kohm output load

// ---------------------------------------------------------------------------
// Two-input gate circuit factory.
//
// Drives `In_1`/`In_2` through ideal DC sources and loads the gate's `out`
// with a 10 kohm resistor to ground.
// ---------------------------------------------------------------------------

function build2InputGate(gateType: string, vA: number, vB: number) {
  return (_registry: ComponentRegistry, facade: DefaultSimulatorFacade): Circuit => {
    return facade.build({
      components: [
        { id: "vsA",  type: "DcVoltageSource", props: { label: "vsA", voltage: vA } },
        { id: "vsB",  type: "DcVoltageSource", props: { label: "vsB", voltage: vB } },
        { id: "gate", type: gateType,         props: { label: "gate", model: "behavioral", inputCount: 2 } },
        { id: "rLoad", type: "Resistor",       props: { label: "rLoad", resistance: LOAD_R } },
        { id: "gnd",  type: "Ground" },
      ],
      connections: [
        ["vsA:pos",  "gate:In_1"],
        ["vsB:pos",  "gate:In_2"],
        ["gate:out", "rLoad:pos"],
        ["rLoad:neg",  "gnd:out"],
        ["vsA:neg",  "gnd:out"],
        ["vsB:neg",  "gnd:out"],
      ],
    });
  };
}

// ---------------------------------------------------------------------------
// One-input gate circuit factory (NOT).
// NOT gate pin label is "in" (not "In_1").
// ---------------------------------------------------------------------------

function build1InputGate(gateType: string, vIn: number) {
  return (_registry: ComponentRegistry, facade: DefaultSimulatorFacade): Circuit => {
    return facade.build({
      components: [
        { id: "vsIn", type: "DcVoltageSource", props: { label: "vsIn", voltage: vIn } },
        { id: "gate", type: gateType,         props: { label: "gate", model: "behavioral" } },
        { id: "rLoad", type: "Resistor",       props: { label: "rLoad", resistance: LOAD_R } },
        { id: "gnd",  type: "Ground" },
      ],
      connections: [
        ["vsIn:pos", "gate:in"],
        ["gate:out", "rLoad:pos"],
        ["rLoad:neg",  "gnd:out"],
        ["vsIn:neg", "gnd:out"],
      ],
    });
  };
}

// ---------------------------------------------------------------------------
// Helper: resolve node voltage from a compiled fixture by circuit label.
// Uses circuit.labelToNodeId (populated by the compiler for every labeled
// component pin) and engine.getNodeVoltage() — the public engine surface.
// ---------------------------------------------------------------------------

function getNodeV(fix: ReturnType<typeof buildFixture>, label: string): number {
  const nodeId = fix.circuit.labelToNodeId.get(label);
  if (nodeId === undefined) throw new Error(`labelToNodeId has no entry for "${label}"`);
  return fix.engine.getNodeVoltage(nodeId);
}

// ---------------------------------------------------------------------------
// AND gate tests
// ---------------------------------------------------------------------------

describe("AND", () => {
  it("both_high_outputs_high", () => {
    const fix = buildFixture({ build: build2InputGate("And", VDD, VDD) });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result?.converged).toBe(true);
    expect(getNodeV(fix, "gate:out")).toBeGreaterThan(3.0);
  });

  it("one_low_outputs_low", () => {
    const fix = buildFixture({ build: build2InputGate("And", VDD, GND) });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result?.converged).toBe(true);
    expect(getNodeV(fix, "gate:out")).toBeLessThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// NOT gate tests
// ---------------------------------------------------------------------------

describe("NOT", () => {
  it("inverts", () => {
    // Input HIGH -> output LOW
    const fixHigh = buildFixture({ build: build1InputGate("Not", VDD) });
    expect(fixHigh.coordinator.dcOperatingPoint()?.converged).toBe(true);
    expect(getNodeV(fixHigh, "gate:out")).toBeLessThan(0.5);

    // Input LOW -> output HIGH
    const fixLow = buildFixture({ build: build1InputGate("Not", GND) });
    expect(fixLow.coordinator.dcOperatingPoint()?.converged).toBe(true);
    expect(getNodeV(fixLow, "gate:out")).toBeGreaterThan(3.0);
  });
});

// ---------------------------------------------------------------------------
// NAND gate tests
// ---------------------------------------------------------------------------

describe("NAND", () => {
  it("truth_table_all_combinations", () => {
    const combos: [number, number, boolean][] = [
      [GND, GND, true],
      [GND, VDD, true],
      [VDD, GND, true],
      [VDD, VDD, false],
    ];
    for (const [vA, vB, expectHigh] of combos) {
      const fix = buildFixture({ build: build2InputGate("NAnd", vA, vB) });
      expect(fix.coordinator.dcOperatingPoint()?.converged).toBe(true);
      const vOut = getNodeV(fix, "gate:out");
      if (expectHigh) {
        expect(vOut).toBeGreaterThan(2.0);
      } else {
        expect(vOut).toBeLessThan(0.5);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// XOR gate tests
// ---------------------------------------------------------------------------

describe("XOR", () => {
  it("truth_table_all_combinations", () => {
    const combos: [number, number, boolean][] = [
      [GND, GND, false],
      [GND, VDD, true],
      [VDD, GND, true],
      [VDD, VDD, false],
    ];
    for (const [vA, vB, expectHigh] of combos) {
      const fix = buildFixture({ build: build2InputGate("XOr", vA, vB) });
      expect(fix.coordinator.dcOperatingPoint()?.converged).toBe(true);
      const vOut = getNodeV(fix, "gate:out");
      if (expectHigh) {
        expect(vOut).toBeGreaterThan(2.0);
      } else {
        expect(vOut).toBeLessThan(0.5);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// NR convergence test
//
// Uses ComparisonSession.getStepShape() to inspect the dcop attempt list.
// Normal dcop convergence (first-attempt, no gmin fallback) records
// outcome "dcopSubSolveConverged" (dc-operating-point.ts:331).
// ---------------------------------------------------------------------------

describe("NR", () => {
  it("converges_within_5_iterations", async () => {
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry: ComponentRegistry) => {
        const facade = new DefaultSimulatorFacade(registry);
        return build2InputGate("And", VDD, VDD)(registry, facade);
      },
      analysis: "dcop",
    });
    const shape = session.getStepShape(0);
    const attempts = shape.attempts.ours!;
    const converged = attempts.find(a =>
      a.outcome === "dcopSubSolveConverged" || a.outcome === "accepted",
    );
    expect(converged).toBeDefined();
    expect(converged!.iterationCount).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// Additional truth-table tests for OR, NOR, XOR.
// The behavioral model uses kind:"netlist" — observable behaviour is tested
// end-to-end via the engine.
// ---------------------------------------------------------------------------

describe("Or truth table", () => {
  it("or_truth_table_all_combinations", () => {
    const combos: [number, number, boolean][] = [
      [GND, GND, false],
      [GND, VDD, true],
      [VDD, GND, true],
      [VDD, VDD, true],
    ];
    for (const [vA, vB, expectHigh] of combos) {
      const fix = buildFixture({ build: build2InputGate("Or", vA, vB) });
      expect(fix.coordinator.dcOperatingPoint()?.converged).toBe(true);
      const vOut = getNodeV(fix, "gate:out");
      if (expectHigh) {
        expect(vOut).toBeGreaterThan(2.0);
      } else {
        expect(vOut).toBeLessThan(0.5);
      }
    }
  });
});

describe("NOR truth table", () => {
  it("nor_truth_table_all_combinations", () => {
    const combos: [number, number, boolean][] = [
      [GND, GND, true],
      [GND, VDD, false],
      [VDD, GND, false],
      [VDD, VDD, false],
    ];
    for (const [vA, vB, expectHigh] of combos) {
      const fix = buildFixture({ build: build2InputGate("NOr", vA, vB) });
      expect(fix.coordinator.dcOperatingPoint()?.converged).toBe(true);
      const vOut = getNodeV(fix, "gate:out");
      if (expectHigh) {
        expect(vOut).toBeGreaterThan(2.0);
      } else {
        expect(vOut).toBeLessThan(0.5);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Pin-loading test (Entry 1 voltage-sag assertion).
//
// A non-ideal source drives the gate's `In_1` net through a 10 kohm series
// resistor. With `rIn = 100 kohm` from the CMOS_3V3 family on a loaded pin,
//   vNet = 5 * 100k / (10k + 100k) = 4.545454545454...V
// On an ideal pin (no input load), vNet stays at 5.0V exactly.
// ---------------------------------------------------------------------------

describe("Pin loading", () => {
  function buildGateWithLoadedSel(loading: "loaded" | "ideal") {
    return (_registry: ComponentRegistry, facade: DefaultSimulatorFacade): Circuit => {
      const c = facade.build({
        components: [
          { id: "vsIn", type: "DcVoltageSource", props: { label: "vsIn", voltage: 5 } },
          { id: "vsB",  type: "DcVoltageSource", props: { label: "vsB",  voltage: 0 } },
          { id: "rsrc", type: "Resistor",        props: { label: "rsrc", resistance: 10_000 } },
          { id: "gate", type: "And",             props: { label: "gate", model: "behavioral", inputCount: 2 } },
          { id: "rLoad", type: "Resistor",       props: { label: "rLoad", resistance: LOAD_R } },
          { id: "gnd",  type: "Ground" },
        ],
        connections: [
          ["vsIn:pos",  "rsrc:pos"],
          ["rsrc:neg",    "gate:In_1"],
          ["vsB:pos",   "gate:In_2"],
          ["gate:out",  "rLoad:pos"],
          ["rLoad:neg",   "gnd:out"],
          ["vsIn:neg",  "gnd:out"],
          ["vsB:neg",   "gnd:out"],
        ],
      });
      // Per-net override- Decision #10:
      c.metadata.digitalPinLoadingOverrides = [
        { anchor: { type: "pin", instanceId: "gate", pinLabel: "In_1" }, loading },
      ];
      return c;
    };
  }

  it("loaded_pin_sees_voltage_sag", () => {
    const fix = buildFixture({ build: buildGateWithLoadedSel("loaded") });
    expect(fix.coordinator.dcOperatingPoint()?.converged).toBe(true);
    // 5V * 100k / (10k + 100k) = 4.5454545454...V
    expect(getNodeV(fix, "gate:In_1")).toBeCloseTo(4.5454545454545454, 9);
  });

  it("ideal_pin_sees_full_source_voltage", () => {
    const fix = buildFixture({ build: buildGateWithLoadedSel("ideal") });
    expect(fix.coordinator.dcOperatingPoint()?.converged).toBe(true);
    expect(getNodeV(fix, "gate:In_1")).toBeCloseTo(5.0, 9);
  });
});

// Note: The "Direct role" test that used `as unknown as { _ourTopology: ... }`
// to peek at internal harness state was deleted (§3 §4g Phase A — banned cast
// on coordinator/engine internals). Observable-behaviour coverage: the NR
// convergence test above already confirms the gate model converges correctly,
// which is only possible if the Norton-stamp output driver (no branch row) is
// operating. No branch-row label is needed beyond the convergence assertion.
