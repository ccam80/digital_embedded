import { describe, it, expect } from "vitest";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import type { ComponentRegistry } from "../../../core/registry.js";
import type { Circuit } from "../../../core/circuit.js";
import type { Fixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";

// ---------------------------------------------------------------------------
// DIPL result-port classification tests — Surface 1 (T1 buildFixture)
//
// Every test drives the Buf gate (behavioral model) consumer. The Buf gate's
// single input routes through one DIPL composite (Loaded or Unloaded). The
// DIPL's result port becomes the gate's internal net "result_1". BUF is an
// identity driver, so ctrl_out == result_1 in steady state.
//
// Observable: gate's "out" pin voltage, which is the DOPL-rendered ctrl_out.
// The DOPL maps: V(out) = vOL + ctrl_out × (vOH − vOL) = 0 + result × 5.
//   result = 1.0 → V(out) = 5.0 V   (HIGH)
//   result = 0.5 → V(out) = 2.5 V   (indeterminate)
//   result = 0.0 → V(out) = 0.0 V   (LOW)
// The "out" pin is in labelToNodeId as "gate:out". Internal nets ("result_1",
// "ctrl_out") are not in labelToNodeId (subcircuit-internal allocation only).
//
// Default thresholds: vIH = 2.0 V, vIL = 0.8 V.
//   input > vIH   → result = 1.0  → V(out) = 5.0 V
//   vIL ≤ input ≤ vIH → result = 0.5 → V(out) = 2.5 V
//   input < vIL   → result = 0.0  → V(out) = 0.0 V
// ---------------------------------------------------------------------------

function nodeOf(fix: Fixture, label: string): number {
  const n = fix.circuit.labelToNodeId.get(label);
  if (n === undefined) throw new Error(`label '${label}' not in labelToNodeId`);
  return n;
}

// Expected out-pin voltages derived from DOPL transfer function V(out) = result × vOH
// (no external load; rOut=100Ω, vOH=5V, vOL=0V — defaults).
const V_HIGH = 5.0;   // result = 1.0
const V_MID  = 2.5;   // result = 0.5
const V_LOW  = 0.0;   // result = 0.0

function buildBufCircuit(vInput: number, loaded: number) {
  return (_registry: ComponentRegistry, facade: DefaultSimulatorFacade): Circuit => {
    return facade.build({
      components: [
        { id: "vs",   type: "DcVoltageSource", props: { label: "vs",   voltage: vInput } },
        { id: "gate", type: "Buf",             props: { label: "gate", model: "behavioral", loaded } },
        { id: "gnd",  type: "Ground" },
      ],
      connections: [
        ["vs:pos", "gate:In_1"],
        ["vs:neg", "gnd:out"],
      ],
    });
  };
}

function buildBufCircuitWithRdriver(vSource: number, rDriver: number, loaded: number) {
  return (_registry: ComponentRegistry, facade: DefaultSimulatorFacade): Circuit => {
    return facade.build({
      components: [
        { id: "vs",      type: "DcVoltageSource", props: { label: "vs",      voltage: vSource } },
        { id: "rDriver", type: "Resistor",        props: { label: "rDriver", resistance: rDriver } },
        { id: "gate",    type: "Buf",             props: { label: "gate",    model: "behavioral", loaded } },
        { id: "gnd",     type: "Ground" },
      ],
      connections: [
        ["vs:pos",      "rDriver:pos"],
        ["rDriver:neg", "gate:In_1"],
        ["vs:neg",      "gnd:out"],
      ],
    });
  };
}

// ---------------------------------------------------------------------------
// Loaded DIPL — result-port classification
// ---------------------------------------------------------------------------

describe("DIPL Loaded: result-port classification (T1)", () => {
  it("Loaded: vDD on node → result = 1.0", () => {
    const fix = buildFixture({ build: buildBufCircuit(5.0, 1) });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    // 5 V > vIH(2.0) → result = 1.0 → V(out) = V_HIGH = 5.0 V
    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "gate:out"));
    expect(vOut).toBeCloseTo(V_HIGH, 6);
  });

  it("Loaded: gnd on node → result = 0.0", () => {
    const fix = buildFixture({ build: buildBufCircuit(0.0, 1) });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    // 0 V < vIL(0.8) → result = 0.0 → V(out) = V_LOW = 0.0 V
    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "gate:out"));
    expect(vOut).toBeCloseTo(V_LOW, 6);
  });

  it("Loaded: mid-rail (1.5 V) on node → result = 0.5", () => {
    const fix = buildFixture({ build: buildBufCircuit(1.5, 1) });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    // 1.5 V is in-band: vIL(0.8) ≤ 1.5 ≤ vIH(2.0) → result = 0.5 → V(out) = V_MID = 2.5 V
    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "gate:out"));
    expect(vOut).toBeCloseTo(V_MID, 6);
  });

  it("Loaded: above-vIH (2.5 V) → result = 1.0", () => {
    const fix = buildFixture({ build: buildBufCircuit(2.5, 1) });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    // 2.5 V > vIH(2.0) → result = 1.0 → V(out) = V_HIGH = 5.0 V
    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "gate:out"));
    expect(vOut).toBeCloseTo(V_HIGH, 6);
  });

  it("Loaded: below-vIL (0.5 V) → result = 0.0", () => {
    const fix = buildFixture({ build: buildBufCircuit(0.5, 1) });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    // 0.5 V < vIL(0.8) → result = 0.0 → V(out) = V_LOW = 0.0 V
    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "gate:out"));
    expect(vOut).toBeCloseTo(V_LOW, 6);
  });

  it("Loaded: boundary v == vIH → result = 0.5", () => {
    const fix = buildFixture({ build: buildBufCircuit(2.0, 1) });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    // Exactly vIH(2.0): strict > check puts this in the indeterminate band → result = 0.5 → V(out) = V_MID
    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "gate:out"));
    expect(vOut).toBeCloseTo(V_MID, 6);
  });

  it("Loaded: boundary v == vIL → result = 0.5", () => {
    const fix = buildFixture({ build: buildBufCircuit(0.8, 1) });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    // Exactly vIL(0.8): strict < check puts this in the indeterminate band → result = 0.5 → V(out) = V_MID
    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "gate:out"));
    expect(vOut).toBeCloseTo(V_MID, 6);
  });

  it("Loaded: RC loading drops node into the indeterminate band → result = 0.5", () => {
    // Topology: DCVoltageSource(5V) → Resistor(Rdriver=4e6Ω) → Buf:In_1
    // Buf's loaded DIPL has rIn=1e6 shunting In_1 to GND.
    // Voltage divider: V(In_1) = 5 × 1e6/(4e6 + 1e6) = 1.0 V
    // Since vIL(0.8) ≤ 1.0 ≤ vIH(2.0), classification is indeterminate → result = 0.5.
    // Without the load, 5 V on In_1 would classify as 1.0 (HIGH).
    const fix = buildFixture({ build: buildBufCircuitWithRdriver(5.0, 4e6, 1) });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    // V(In_1) ≈ 1.0 V — the rIn load shifted the node into the indeterminate band
    const vNode = fix.engine.getNodeVoltage(nodeOf(fix, "gate:In_1"));
    expect(vNode).toBeCloseTo(1.0, 6);
    // result = 0.5 → V(out) = V_MID = 2.5 V
    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "gate:out"));
    expect(vOut).toBeCloseTo(V_MID, 6);
  });
});

// ---------------------------------------------------------------------------
// Unloaded DIPL — result-port classification
// ---------------------------------------------------------------------------

describe("DIPL Unloaded: result-port classification (T1)", () => {
  it("Unloaded: vDD on node → result = 1.0", () => {
    const fix = buildFixture({ build: buildBufCircuit(5.0, 0) });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    // 5 V > vIH(2.0) → result = 1.0 → V(out) = V_HIGH = 5.0 V
    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "gate:out"));
    expect(vOut).toBeCloseTo(V_HIGH, 6);
  });

  it("Unloaded: gnd → 0.0", () => {
    const fix = buildFixture({ build: buildBufCircuit(0.0, 0) });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    // 0 V < vIL(0.8) → result = 0.0 → V(out) = V_LOW = 0.0 V
    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "gate:out"));
    expect(vOut).toBeCloseTo(V_LOW, 6);
  });

  it("Unloaded: mid-rail → 0.5", () => {
    const fix = buildFixture({ build: buildBufCircuit(1.5, 0) });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    // 1.5 V in-band → result = 0.5 → V(out) = V_MID = 2.5 V
    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "gate:out"));
    expect(vOut).toBeCloseTo(V_MID, 6);
  });

  it("Unloaded: above-vIH → 1.0", () => {
    const fix = buildFixture({ build: buildBufCircuit(2.5, 0) });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    // 2.5 V > vIH(2.0) → result = 1.0 → V(out) = V_HIGH = 5.0 V
    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "gate:out"));
    expect(vOut).toBeCloseTo(V_HIGH, 6);
  });

  it("Unloaded: below-vIL → 0.0", () => {
    const fix = buildFixture({ build: buildBufCircuit(0.5, 0) });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    // 0.5 V < vIL(0.8) → result = 0.0 → V(out) = V_LOW = 0.0 V
    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "gate:out"));
    expect(vOut).toBeCloseTo(V_LOW, 6);
  });
});
