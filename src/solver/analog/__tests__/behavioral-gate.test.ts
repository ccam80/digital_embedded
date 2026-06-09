import { describe, it, expect } from "vitest";

import { buildFixture } from "./fixtures/build-fixture.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import type { ComponentRegistry } from "../../../core/registry.js";
import type { Circuit } from "../../../core/circuit.js";

// ---------------------------------------------------------------------------
// CMOS_3V3 family rails. Behavioral gate output drives toward VDD/GND through
// rOut; output sees a 10 kΩ load to ground.
// ---------------------------------------------------------------------------

const VDD = 3.3;
const GND = 0.0;
const LOAD_R = 10_000;

// ---------------------------------------------------------------------------
// Two-input gate circuit: vsA / vsB drive In_1 / In_2; rLoad on out to ground.
// ---------------------------------------------------------------------------

function build2InputGate(gateType: string, vA: number, vB: number) {
  return (_registry: ComponentRegistry, facade: DefaultSimulatorFacade): Circuit => {
    return facade.build({
      components: [
        { id: "vsA",   type: "DcVoltageSource", props: { label: "vsA", voltage: vA } },
        { id: "vsB",   type: "DcVoltageSource", props: { label: "vsB", voltage: vB } },
        { id: "gate",  type: gateType,          props: { label: "gate", model: "behavioral", inputCount: 2 } },
        { id: "rLoad", type: "Resistor",        props: { label: "rLoad", resistance: LOAD_R } },
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

// ---------------------------------------------------------------------------
// One-input gate circuit (NOT): vsIn drives `in`; rLoad on out to ground.
// ---------------------------------------------------------------------------

function build1InputGate(gateType: string, vIn: number) {
  return (_registry: ComponentRegistry, facade: DefaultSimulatorFacade): Circuit => {
    return facade.build({
      components: [
        { id: "vsIn",  type: "DcVoltageSource", props: { label: "vsIn", voltage: vIn } },
        { id: "gate",  type: gateType,          props: { label: "gate", model: "behavioral" } },
        { id: "rLoad", type: "Resistor",        props: { label: "rLoad", resistance: LOAD_R } },
        { id: "gnd",   type: "Ground" },
      ],
      connections: [
        ["vsIn:pos",  "gate:In_1"],
        ["gate:out",  "rLoad:pos"],
        ["rLoad:neg", "gnd:out"],
        ["vsIn:neg",  "gnd:out"],
      ],
    });
  };
}

// ---------------------------------------------------------------------------
// Helper: resolve node voltage by labelled pin.
// ---------------------------------------------------------------------------

function getNodeV(fix: ReturnType<typeof buildFixture>, label: string): number {
  const nodeId = fix.circuit.labelToNodeId.get(label);
  if (nodeId === undefined) throw new Error(`labelToNodeId has no entry for "${label}"`);
  return fix.engine.getNodeVoltage(nodeId);
}

// ---------------------------------------------------------------------------
// Category 2 (DCOP analytical) — AND gate truth table.
// Closed-form: AND drives `out` HIGH (~VDD) only when both inputs are HIGH;
// LOW (~GND) otherwise. Output high/low rails sag below VDD / above GND
// because rOut and the 10 kΩ load form a divider; assert directional rails.
// ---------------------------------------------------------------------------

describe("AND gate DCOP (T1)", () => {
  it("dcop_both_high_drives_output_high", () => {
    const fix = buildFixture({ build: build2InputGate("And", VDD, VDD) });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result?.converged).toBe(true);
    expect(getNodeV(fix, "gate:out")).toBeGreaterThan(2.0);
  });

  it("dcop_one_low_drives_output_low", () => {
    const fix = buildFixture({ build: build2InputGate("And", VDD, GND) });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result?.converged).toBe(true);
    expect(getNodeV(fix, "gate:out")).toBeLessThan(0.5);
  });

  it("dcop_both_low_drives_output_low", () => {
    const fix = buildFixture({ build: build2InputGate("And", GND, GND) });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result?.converged).toBe(true);
    expect(getNodeV(fix, "gate:out")).toBeLessThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// Category 2 (DCOP analytical) — NAND gate truth table.
// ---------------------------------------------------------------------------

describe("NAND gate DCOP (T1)", () => {
  it("dcop_nand_truth_table", () => {
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
// Category 2 (DCOP analytical) — OR gate truth table.
// ---------------------------------------------------------------------------

describe("OR gate DCOP (T1)", () => {
  it("dcop_or_truth_table", () => {
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

// ---------------------------------------------------------------------------
// Category 2 (DCOP analytical) — NOR gate truth table.
// ---------------------------------------------------------------------------

describe("NOR gate DCOP (T1)", () => {
  it("dcop_nor_truth_table", () => {
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
// Category 2 (DCOP analytical) — XOR gate truth table.
// ---------------------------------------------------------------------------

describe("XOR gate DCOP (T1)", () => {
  it("dcop_xor_truth_table", () => {
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
// Category 2 (DCOP analytical) — NOT gate inversion.
// ---------------------------------------------------------------------------

describe("NOT gate DCOP (T1)", () => {
  it("dcop_input_high_drives_output_low", () => {
    const fix = buildFixture({ build: build1InputGate("Not", VDD) });
    expect(fix.coordinator.dcOperatingPoint()?.converged).toBe(true);
    expect(getNodeV(fix, "gate:out")).toBeLessThan(0.5);
  });

  it("dcop_input_low_drives_output_high", () => {
    const fix = buildFixture({ build: build1InputGate("Not", GND) });
    expect(fix.coordinator.dcOperatingPoint()?.converged).toBe(true);
    expect(getNodeV(fix, "gate:out")).toBeGreaterThan(2.0);
  });
});

// ---------------------------------------------------------------------------
// Category 9 (bridge / digital) — pin-loading observable via per-net override.
//
// A non-ideal source drives In_1 through a 10 kΩ series resistor. With the
// CMOS_3V3 family's loaded-pin rIn = 100 kΩ, the divider yields:
//   vNet = 5 V * 100k / (10k + 100k) = 4.5454545454...V
// On an ideal pin (no input load), vNet stays at 5.0V exactly.
// This is the documented closed-form post-bridge observable and exercises
// the digital-pin loading path that the bridge-aware compile() consumes.
// ---------------------------------------------------------------------------

describe("AND gate pin loading (T1, bridge)", () => {
  function buildGateWithLoadedSel(loading: "loaded" | "ideal") {
    return (_registry: ComponentRegistry, facade: DefaultSimulatorFacade): Circuit => {
      const c = facade.build({
        components: [
          { id: "vsIn",  type: "DcVoltageSource", props: { label: "vsIn", voltage: 5 } },
          { id: "vsB",   type: "DcVoltageSource", props: { label: "vsB",  voltage: 0 } },
          { id: "rsrc",  type: "Resistor",        props: { label: "rsrc", resistance: 10_000 } },
          { id: "gate",  type: "And",             props: { label: "gate", model: "behavioral", inputCount: 2 } },
          { id: "rLoad", type: "Resistor",        props: { label: "rLoad", resistance: LOAD_R } },
          { id: "gnd",   type: "Ground" },
        ],
        connections: [
          ["vsIn:pos",  "rsrc:pos"],
          ["rsrc:neg",  "gate:In_1"],
          ["vsB:pos",   "gate:In_2"],
          ["gate:out",  "rLoad:pos"],
          ["rLoad:neg", "gnd:out"],
          ["vsIn:neg",  "gnd:out"],
          ["vsB:neg",   "gnd:out"],
        ],
      });
      c.metadata.digitalPinLoadingOverrides = [
        { anchor: { type: "pin", instanceId: "gate", pinLabel: "In_1" }, loading },
      ];
      return c;
    };
  }

  it("loaded_pin_sees_voltage_sag", () => {
    const fix = buildFixture({ build: buildGateWithLoadedSel("loaded") });
    expect(fix.coordinator.dcOperatingPoint()?.converged).toBe(true);
    // 5V * 1MΩ / (10kΩ + 1MΩ) = 4.95049504950...V — closed-form divider with the
    // DigitalInputPinLoaded default input impedance rIn = 1 MΩ.
    expect(getNodeV(fix, "gate:In_1")).toBeCloseTo(4.9504950495049505, 9);
  });

  it("ideal_pin_sees_full_source_voltage", () => {
    const fix = buildFixture({ build: buildGateWithLoadedSel("ideal") });
    expect(fix.coordinator.dcOperatingPoint()?.converged).toBe(true);
    expect(getNodeV(fix, "gate:In_1")).toBeCloseTo(5.0, 9);
  });
});

// ---------------------------------------------------------------------------
// Category 4 (parameter hot-load) — inputCount.
//
// inputCount is the structural parameter that defines how many `In_<n>` pins
// the gate exposes. It is consumed at compile() to build the pin layout, so
// the canonical Cat 4 mechanic builds the same gate twice with different
// inputCount values and asserts the documented post-compile observable
// differs (per the Canon's compile-time-seeded structural-properties rule).
// ---------------------------------------------------------------------------

function build3InputAnd(vA: number, vB: number, vC: number) {
  return (_registry: ComponentRegistry, facade: DefaultSimulatorFacade): Circuit => {
    return facade.build({
      components: [
        { id: "vsA",   type: "DcVoltageSource", props: { label: "vsA", voltage: vA } },
        { id: "vsB",   type: "DcVoltageSource", props: { label: "vsB", voltage: vB } },
        { id: "vsC",   type: "DcVoltageSource", props: { label: "vsC", voltage: vC } },
        { id: "gate",  type: "And",             props: { label: "gate", model: "behavioral", inputCount: 3 } },
        { id: "rLoad", type: "Resistor",        props: { label: "rLoad", resistance: LOAD_R } },
        { id: "gnd",   type: "Ground" },
      ],
      connections: [
        ["vsA:pos",   "gate:In_1"],
        ["vsB:pos",   "gate:In_2"],
        ["vsC:pos",   "gate:In_3"],
        ["gate:out",  "rLoad:pos"],
        ["rLoad:neg", "gnd:out"],
        ["vsA:neg",   "gnd:out"],
        ["vsB:neg",   "gnd:out"],
        ["vsC:neg",   "gnd:out"],
      ],
    });
  };
}

describe("AND gate parameter hot-load (T1)", () => {
  it("inputCount_3_with_one_input_low_drives_output_low", () => {
    // 3-input AND with one low input must still resolve LOW. If the inputCount
    // structural change were ignored at compile, the third pin (and its low
    // drive) would not enter the gate's truth-table evaluation and the output
    // would float HIGH. The test asserts the documented contract: every
    // declared input participates.
    const fix = buildFixture({ build: build3InputAnd(VDD, VDD, GND) });
    expect(fix.coordinator.dcOperatingPoint()?.converged).toBe(true);
    expect(getNodeV(fix, "gate:out")).toBeLessThan(0.5);
  });

  it("inputCount_3_with_all_inputs_high_drives_output_high", () => {
    const fix = buildFixture({ build: build3InputAnd(VDD, VDD, VDD) });
    expect(fix.coordinator.dcOperatingPoint()?.converged).toBe(true);
    expect(getNodeV(fix, "gate:out")).toBeGreaterThan(2.0);
  });
});

