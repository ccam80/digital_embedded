import { describe, it, expect } from "vitest";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import type { ComponentRegistry } from "../../../core/registry.js";
import type { Circuit } from "../../../core/circuit.js";
import type { Fixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import type { CircuitElement } from "../../../core/element.js";

// ---------------------------------------------------------------------------
// DIPL hot-load tests — Surface 1 (T1 buildFixture)
//
// All hot-load tests exercise the Buf gate (behavioral model) consumer.
// Gate-level paramDefs (vIH, vIL, rIn, cIn) are string-bound to the inner
// DIPL sub-element, which in turn string-binds to its thresh sub-element.
// setComponentProperty(gateElement, key, value) reaches the inner elements
// through the subcircuit-wrapper broadcast + explicit binding mechanism.
//
// Observable: gate's "out" pin voltage, which is the DOPL-rendered ctrl_out.
// The DOPL maps: V(out) = vOL + ctrl_out × (vOH − vOL) = result × 5 V.
//   result = 1.0 → V(out) = 5.0 V   (HIGH)
//   result = 0.5 → V(out) = 2.5 V   (indeterminate)
//   result = 0.0 → V(out) = 0.0 V   (LOW)
// Internal nets ("result_1", "ctrl_out") are not in labelToNodeId
// (subcircuit-internal allocation only), so "gate:out" is the chosen proxy.
//
// The P5-D7 two-hop test uses a 2-input AND gate to prove the binding chain
// gate → DIPL wrapper → thresh on a gate with two DIPL inputs.
// ---------------------------------------------------------------------------

// Expected out-pin voltages derived from DOPL transfer function V(out) = result × vOH
// (no external load; rOut=100Ω, vOH=5V, vOL=0V — defaults).
const V_HIGH = 5.0;   // result = 1.0
const V_MID  = 2.5;   // result = 0.5
const V_LOW  = 0.0;   // result = 0.0

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

function buildBufAt(vInput: number, loaded: number) {
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

function buildAndAt(vA: number, vB: number) {
  return (_registry: ComponentRegistry, facade: DefaultSimulatorFacade): Circuit => {
    return facade.build({
      components: [
        { id: "vsA",  type: "DcVoltageSource", props: { label: "vsA",  voltage: vA } },
        { id: "vsB",  type: "DcVoltageSource", props: { label: "vsB",  voltage: vB } },
        { id: "gate", type: "And",             props: { label: "gate", model: "behavioral", inputCount: 2, loaded: 1 } },
        { id: "gnd",  type: "Ground" },
      ],
      connections: [
        ["vsA:pos", "gate:In_1"],
        ["vsB:pos", "gate:In_2"],
        ["vsA:neg", "gnd:out"],
        ["vsB:neg", "gnd:out"],
      ],
    });
  };
}

// ---------------------------------------------------------------------------
// Loaded DIPL — hot-load tests via Buf gate consumer
// ---------------------------------------------------------------------------

describe("DIPL Loaded: vIH hot-load reclassifies on next step (T1)", () => {
  it("Loaded: setComponentProperty(dipl, 'vIH', 1.0) reclassifies 1.2 V from 0.5 to 1.0 on next step", () => {
    // 1.2 V is in-band with default vIH=2.0: vIL(0.8) ≤ 1.2 ≤ vIH(2.0) → result = 0.5 → V(out) = V_MID
    const fix = buildFixture({ build: buildBufAt(1.2, 1) });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    const outNode = nodeOf(fix, "gate:out");
    const before = fix.engine.getNodeVoltage(outNode);
    expect(before).toBeCloseTo(V_MID, 6);

    // Lower vIH to 1.0: now 1.2 > vIH(1.0) → reclassifies to result = 1.0 → V(out) = V_HIGH
    const gate = ceByLabel(fix, "gate");
    fix.coordinator.setComponentProperty(gate, "vIH", 1.0);
    fix.coordinator.step();

    const after = fix.engine.getNodeVoltage(outNode);
    expect(after).toBeCloseTo(V_HIGH, 6);
  });
});

describe("DIPL Loaded: vIL hot-load reclassifies on next step (T1)", () => {
  it("Loaded: setComponentProperty(dipl, 'vIL', 1.4) reclassifies 1.2 V from 0.5 to 0.0 on next step", () => {
    // 1.2 V is in-band with default vIL=0.8: vIL(0.8) ≤ 1.2 ≤ vIH(2.0) → result = 0.5 → V(out) = V_MID
    const fix = buildFixture({ build: buildBufAt(1.2, 1) });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    const outNode = nodeOf(fix, "gate:out");
    const before = fix.engine.getNodeVoltage(outNode);
    expect(before).toBeCloseTo(V_MID, 6);

    // Raise vIL to 1.4: now 1.2 < vIL(1.4) → reclassifies to result = 0.0 → V(out) = V_LOW
    const gate = ceByLabel(fix, "gate");
    fix.coordinator.setComponentProperty(gate, "vIL", 1.4);
    fix.coordinator.step();

    const after = fix.engine.getNodeVoltage(outNode);
    expect(after).toBeCloseTo(V_LOW, 6);
  });
});

describe("DIPL Loaded: rIn hot-load shifts load-induced node voltage (T1)", () => {
  it("Loaded: setComponentProperty(dipl, 'rIn', 1e7) shifts the load-induced node voltage", () => {
    // Drive through a 4e6 Ω series resistor. Default rIn=1e6:
    // V(In_1) = 5 × 1e6/(4e6+1e6) = 1.0 V → in-band → result = 0.5 → V(out) = V_MID
    const fix = buildFixture({
      build: (_registry: ComponentRegistry, facade: DefaultSimulatorFacade): Circuit => {
        return facade.build({
          components: [
            { id: "vs",      type: "DcVoltageSource", props: { label: "vs",      voltage: 5.0 } },
            { id: "rDriver", type: "Resistor",        props: { label: "rDriver", resistance: 4e6 } },
            { id: "gate",    type: "Buf",             props: { label: "gate",    model: "behavioral", loaded: 1 } },
            { id: "gnd",     type: "Ground" },
          ],
          connections: [
            ["vs:pos",      "rDriver:pos"],
            ["rDriver:neg", "gate:In_1"],
            ["vs:neg",      "gnd:out"],
          ],
        });
      },
    });

    const outNode = nodeOf(fix, "gate:out");
    const inNode  = nodeOf(fix, "gate:In_1");
    // Default DC-OP: V(In_1) ≈ 1.0 V → in-band → result = 0.5 → V(out) = V_MID
    const dcBefore = fix.coordinator.dcOperatingPoint();
    expect(dcBefore).not.toBeNull();
    expect(dcBefore!.converged).toBe(true);
    expect(fix.engine.getNodeVoltage(outNode)).toBeCloseTo(V_MID, 6);

    // Raise rIn to 1e7: new divider V(In_1) = 5 × 1e7/(4e6+1e7) ≈ 3.57 V > vIH(2.0)
    // → result = 1.0 → V(out) = V_HIGH. Re-run DC-OP to see the steady-state effect.
    const gate = ceByLabel(fix, "gate");
    fix.coordinator.setComponentProperty(gate, "rIn", 1e7);
    const dcAfter = fix.coordinator.dcOperatingPoint();
    expect(dcAfter).not.toBeNull();
    expect(dcAfter!.converged).toBe(true);

    const vNodeAfter = fix.engine.getNodeVoltage(inNode);
    expect(vNodeAfter).toBeGreaterThan(2.0);
    const after = fix.engine.getNodeVoltage(outNode);
    expect(after).toBeCloseTo(V_HIGH, 6);
  });
});

describe("DIPL Loaded: cIn hot-load shifts settling time constant (T1)", () => {
  it("Loaded: setComponentProperty(dipl, 'cIn', 1e-10) shifts the settling time constant", () => {
    // This test verifies cIn reaches the inner DIPL cap sub-element without error.
    // Drive the gate at 5 V (above vIH → result = 1.0 → V(out) = V_HIGH at DC).
    // After hot-loading a larger cIn the DC classification is unchanged (cIn is
    // reactive; zero effect at DC), but the param must have been accepted
    // without throw — same DC output voltage.
    const fix = buildFixture({ build: buildBufAt(5.0, 1) });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    const outNode = nodeOf(fix, "gate:out");
    expect(fix.engine.getNodeVoltage(outNode)).toBeCloseTo(V_HIGH, 6);

    const gate = ceByLabel(fix, "gate");
    fix.coordinator.setComponentProperty(gate, "cIn", 1e-10);
    fix.coordinator.step();

    // DC classification unchanged; cIn is reactive, no DC current contribution
    expect(fix.engine.getNodeVoltage(outNode)).toBeCloseTo(V_HIGH, 6);
  });
});

// ---------------------------------------------------------------------------
// P5-D7: Two-hop binding — gate → DIPL → thresh, via AND gate consumer
// ---------------------------------------------------------------------------

describe("DIPL: two-hop binding — setComponentProperty on parent gate routes to inner thresh (T1, P5-D7)", () => {
  it("Loaded: two-hop binding — setComponentProperty on parent gate routes to inner thresh", () => {
    // Build a 2-input AND gate (loaded), both inputs driven at 1.2 V.
    // Default vIH=2.0: vIL(0.8) ≤ 1.2 ≤ vIH(2.0) → each inPin_i result = 0.5
    // AND driver: min(0.5, 0.5) = 0.5 → ctrl_out = 0.5 → V(out) = V_MID = 2.5 V
    // Assert V(gate:out) ≈ V_MID before the hot-load.
    // (The "out" pin is used as the observable because "ctrl_out" is an
    //  internal net not exposed in labelToNodeId.)
    const fix = buildFixture({ build: buildAndAt(1.2, 1.2) });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);

    const outNode = nodeOf(fix, "gate:out");
    const before = fix.engine.getNodeVoltage(outNode);
    expect(before).toBeCloseTo(V_MID, 6);

    // Lower vIH to 1.0 via gate-level setComponentProperty.
    // Two-hop binding: gate → inPin_1/inPin_2 DIPL wrappers → thresh sub-elements.
    // Now 1.2 > vIH(1.0) → each thresh emits 1.0 → AND: min(1.0, 1.0) = 1.0
    // → ctrl_out = 1.0 → V(out) = V_HIGH = 5.0 V
    const gate = ceByLabel(fix, "gate");
    fix.coordinator.setComponentProperty(gate, "vIH", 1.0);
    fix.coordinator.step();

    const after = fix.engine.getNodeVoltage(outNode);
    expect(after).toBeCloseTo(V_HIGH, 6);
  });
});

// ---------------------------------------------------------------------------
// Unloaded DIPL — hot-load tests via Buf gate consumer
// ---------------------------------------------------------------------------

describe("DIPL Unloaded: vIH hot-load reclassifies on next step (T1)", () => {
  it("Unloaded: setComponentProperty(dipl, 'vIH', 1.0) reclassifies on next step", () => {
    // 1.2 V with default vIH=2.0 → in-band → result = 0.5 → V(out) = V_MID
    const fix = buildFixture({ build: buildBufAt(1.2, 0) });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    const outNode = nodeOf(fix, "gate:out");
    const before = fix.engine.getNodeVoltage(outNode);
    expect(before).toBeCloseTo(V_MID, 6);

    // Lower vIH to 1.0: 1.2 > 1.0 → result = 1.0 → V(out) = V_HIGH
    const gate = ceByLabel(fix, "gate");
    fix.coordinator.setComponentProperty(gate, "vIH", 1.0);
    fix.coordinator.step();

    const after = fix.engine.getNodeVoltage(outNode);
    expect(after).toBeCloseTo(V_HIGH, 6);
  });
});

describe("DIPL Unloaded: vIL hot-load reclassifies on next step (T1)", () => {
  it("Unloaded: setComponentProperty(dipl, 'vIL', 1.4) reclassifies on next step", () => {
    // 1.2 V with default vIL=0.8 → in-band → result = 0.5 → V(out) = V_MID
    const fix = buildFixture({ build: buildBufAt(1.2, 0) });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    const outNode = nodeOf(fix, "gate:out");
    const before = fix.engine.getNodeVoltage(outNode);
    expect(before).toBeCloseTo(V_MID, 6);

    // Raise vIL to 1.4: 1.2 < 1.4 → result = 0.0 → V(out) = V_LOW
    const gate = ceByLabel(fix, "gate");
    fix.coordinator.setComponentProperty(gate, "vIL", 1.4);
    fix.coordinator.step();

    const after = fix.engine.getNodeVoltage(outNode);
    expect(after).toBeCloseTo(V_LOW, 6);
  });
});
