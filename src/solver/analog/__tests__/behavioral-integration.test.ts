import { describe, it, expect } from "vitest";

import { buildFixture, type Fixture } from "./fixtures/build-fixture.js";
import type { ComponentRegistry } from "../../../core/registry.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import type { Circuit } from "../../../core/circuit.js";
import type { CircuitElement } from "../../../core/element.js";

// ---------------------------------------------------------------------------
// Bench builders
//
// Behavioral analog netlist integration smoke - exercises the path
// `digital-component -> behavioral subcircuit -> MNA engine -> analog observable`
// end-to-end. Two topology variants:
//   1. AND gate, both inputs HIGH, behavioral model, R-load to GND.
//   2. D flip-flop, behavioral model, dual R-loads on Q and ~Q to GND.
// Both are programmatic via facade.build (T1).
// ---------------------------------------------------------------------------

const VDD = 3.3;
const VDD_FULL = 5.0;
const GND_V = 0.0;
const LOAD_R = 10_000;

function buildAndGateCircuit(vA: number, vB: number) {
  return (_registry: ComponentRegistry, facade: DefaultSimulatorFacade): Circuit =>
    facade.build({
      components: [
        { id: "vsA",   type: "DcVoltageSource", props: { label: "vsA",   voltage: vA } },
        { id: "vsB",   type: "DcVoltageSource", props: { label: "vsB",   voltage: vB } },
        { id: "and1",  type: "And",             props: { label: "and1",  model: "behavioral", inputCount: 2 } },
        { id: "rLoad", type: "Resistor",        props: { label: "rLoad", resistance: LOAD_R } },
        { id: "gnd",   type: "Ground" },
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

function buildDffCircuit(vClk: number, vD: number) {
  return (_registry: ComponentRegistry, facade: DefaultSimulatorFacade): Circuit =>
    facade.build({
      components: [
        { id: "dff1",    type: "D_FF",           props: { label: "dff1",    model: "behavioral" } },
        { id: "rLoadQ",  type: "Resistor",       props: { label: "rLoadQ",  resistance: LOAD_R } },
        { id: "rLoadQB", type: "Resistor",       props: { label: "rLoadQB", resistance: LOAD_R } },
        { id: "vsClk",   type: "DcVoltageSource", props: { label: "vsClk", voltage: vClk } },
        { id: "vsD",     type: "DcVoltageSource", props: { label: "vsD",   voltage: vD   } },
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

// Closed-form rail bands for the behavioral driver into a 10 kohm load.
// Default rOut = 100 ohm, vOH = 5.0 V, vOL = 0.0 V -> divider ratio
// 10000 / (10000 + 100) ~= 0.9901, so HIGH rails > VDD_FULL * 0.9 and LOW
// rails < VDD_FULL * 0.1.
function expectHigh(v: number): void {
  expect(v).toBeGreaterThan(VDD_FULL * 0.9);
}
function expectLow(v: number): void {
  expect(v).toBeLessThan(VDD_FULL * 0.1);
}

// ---------------------------------------------------------------------------
// Category 1 - Initialization (T1)
//
// Post-warm-start: the AND gate's behavioral output node holds a HIGH
// reading at step 0 when both inputs are HIGH. The D_FF Q node, with D=0
// and C=0 at startup, holds LOW.
// ---------------------------------------------------------------------------

describe("Behavioral integration initialization (T1)", () => {
  it("init_and_two_high_inputs_drives_output_high", () => {
    const fix = buildFixture({ build: buildAndGateCircuit(VDD, VDD) });
    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "and1:out"));
    expectHigh(vOut);
  });

  it("init_dff_idle_drives_q_low", () => {
    const fix = buildFixture({ build: buildDffCircuit(GND_V, GND_V) });
    const vQ = fix.engine.getNodeVoltage(nodeOf(fix, "dff1:Q"));
    expectLow(vQ);
  });
});

// ---------------------------------------------------------------------------
// Category 2 - DC operating point analytical (T1)
//
// AND truth-table HIGH/LOW combinations rail correctly. D flip-flop with
// idle clock + D=0 produces complementary Q/~Q rails (Q low, ~Q high).
// ---------------------------------------------------------------------------

describe("Behavioral integration DCOP (T1)", () => {
  it("dcop_and_both_high_rails_to_voh", () => {
    const fix = buildFixture({ build: buildAndGateCircuit(VDD, VDD) });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "and1:out"));
    expectHigh(vOut);
  });

  it("dcop_and_one_low_rails_to_vol", () => {
    const fix = buildFixture({ build: buildAndGateCircuit(VDD, GND_V) });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "and1:out"));
    expectLow(vOut);
  });

  it("dcop_dff_idle_q_low_qbar_high", () => {
    const fix = buildFixture({ build: buildDffCircuit(GND_V, GND_V) });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    const vQ  = fix.engine.getNodeVoltage(nodeOf(fix, "dff1:Q"));
    const vQB = fix.engine.getNodeVoltage(nodeOf(fix, "dff1:~Q"));
    expectLow(vQ);
    expectHigh(vQB);
  });
});

// ---------------------------------------------------------------------------
// Category 4 - Parameter hot-load (T1)
//
// Behavioral-model parameters: vOH (HIGH-rail target), vOL (LOW-rail target),
// rOut (output drive resistance), vIH (input HIGH-classification threshold).
// One it() per documented parameter that scales the primary observable.
// ---------------------------------------------------------------------------

describe("Behavioral integration parameter hot-load (T1)", () => {
  it("hotload_voh_raises_and_high_output", () => {
    const fix = buildFixture({ build: buildAndGateCircuit(VDD, VDD) });
    const outNode = nodeOf(fix, "and1:out");
    const before = fix.engine.getNodeVoltage(outNode);

    const gate = ceByLabel(fix, "and1");
    fix.coordinator.setComponentProperty(gate, "vOH", 8.0);
    fix.coordinator.step();

    const after = fix.engine.getNodeVoltage(outNode);
    // Documented contract: vOH is the HIGH-rail target; raising vOH raises V(out).
    expect(after).not.toBeCloseTo(before);
    expect(Math.sign(after - before)).toBe(1);
  });

  it("hotload_vol_raises_and_low_output", () => {
    const fix = buildFixture({ build: buildAndGateCircuit(VDD, GND_V) });
    const outNode = nodeOf(fix, "and1:out");
    const before = fix.engine.getNodeVoltage(outNode);

    const gate = ceByLabel(fix, "and1");
    fix.coordinator.setComponentProperty(gate, "vOL", 1.0);
    fix.coordinator.step();

    const after = fix.engine.getNodeVoltage(outNode);
    // Documented contract: vOL is the LOW-rail target; raising vOL raises V(out).
    expect(after).not.toBeCloseTo(before);
    expect(Math.sign(after - before)).toBe(1);
  });

  it("hotload_rout_changes_dff_qbar_divider", () => {
    // Idle D_FF: ~Q drives HIGH. rOut and rLoad form a divider; raising rOut
    // lowers V(~Q). Documented contract: rOut is the output drive resistance.
    const fix = buildFixture({ build: buildDffCircuit(GND_V, GND_V) });
    const qbarNode = nodeOf(fix, "dff1:~Q");
    const before = fix.engine.getNodeVoltage(qbarNode);

    const dff = ceByLabel(fix, "dff1");
    fix.coordinator.setComponentProperty(dff, "rOut", 5_000);
    fix.coordinator.step();

    const after = fix.engine.getNodeVoltage(qbarNode);
    expect(after).not.toBeCloseTo(before);
    expect(Math.sign(after - before)).toBe(-1);
  });

  it("hotload_vih_threshold_classifies_input", () => {
    // AND with both inputs at VDD = 3.3 V crosses default vIH = 2.0 V -> HIGH
    // -> output rails to vOH. Raising vIH above 3.3 V reclassifies the inputs
    // as LOW per the documented threshold contract -> output should rail to vOL.
    const fix = buildFixture({ build: buildAndGateCircuit(VDD, VDD) });
    const outNode = nodeOf(fix, "and1:out");
    const before = fix.engine.getNodeVoltage(outNode);

    const gate = ceByLabel(fix, "and1");
    fix.coordinator.setComponentProperty(gate, "vIL", 3.5);
    fix.coordinator.setComponentProperty(gate, "vIH", 4.0);
    fix.coordinator.step();

    const after = fix.engine.getNodeVoltage(outNode);
    // Documented contract: vIH is the input HIGH-classification threshold;
    // pushing it above the drive voltage must reclassify the inputs to LOW
    // and drop V(out) toward vOL.
    expect(after).not.toBeCloseTo(before);
    expect(Math.sign(after - before)).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// Category 9 - Bridge / digital interaction (T1)
//
// AND gate: analog-driven inputs produce analog-side rail outputs whose
// values match the digital truth table. D flip-flop: rising clock edge with
// D=HIGH propagates HIGH onto Q at the analog-side observable.
// ---------------------------------------------------------------------------

describe("Behavioral integration bridge (T1, Cat 9)", () => {
  it("bridge_and_high_high_drives_output_high", () => {
    const fix = buildFixture({ build: buildAndGateCircuit(VDD, VDD) });
    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "and1:out"));
    expectHigh(vOut);
  });

  it("bridge_and_high_low_drives_output_low", () => {
    const fix = buildFixture({ build: buildAndGateCircuit(VDD, GND_V) });
    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "and1:out"));
    expectLow(vOut);
  });

  it("bridge_dff_clock_edge_captures_d_high_onto_q", () => {
    // Build with D=HIGH, C=LOW, then drive a rising edge on the clock.
    const fix = buildFixture({ build: buildDffCircuit(GND_V, VDD) });
    const qNode = nodeOf(fix, "dff1:Q");

    // Settle a few steps with C=LOW: Q remains LOW.
    for (let i = 0; i < 3; i++) fix.coordinator.step();
    expectLow(fix.engine.getNodeVoltage(qNode));

    // Drive C HIGH via the source's voltage param to produce a rising edge.
    fix.coordinator.setSourceByLabel("vsClk", "voltage", VDD);
    for (let i = 0; i < 5; i++) fix.coordinator.step();

    // Documented contract: rising clock edge latches D onto Q.
    const vQ = fix.engine.getNodeVoltage(qNode);
    expectHigh(vQ);
  });
});
