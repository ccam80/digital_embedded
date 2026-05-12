/**
 * Gate driver param hot-load tests (Cat 4, T1).
 *
 * Exercises rOut, vOH, and vOL setParam branches on all 8 gate driver
 * elements by driving each through its parent behavioral gate component.
 * Asserts no throw when params are mutated via coordinator.setComponentProperty.
 *
 * Tier: fixture-only (T1).
 */

import { describe, it, expect } from "vitest";
import { buildFixture } from "../../__tests__/fixtures/build-fixture.js";
import type { Fixture } from "../../__tests__/fixtures/build-fixture.js";
import { DefaultSimulatorFacade } from "../../../../headless/default-facade.js";
import type { ComponentRegistry } from "../../../../core/registry.js";
import type { Circuit } from "../../../../core/circuit.js";
import type { CircuitElement } from "../../../../core/element.js";

// ---------------------------------------------------------------------------
// Topology builders
// ---------------------------------------------------------------------------

const VDD = 5.0;
const GND_V = 0.0;
const LOAD_R = 10_000;

function build2InputGate(gateType: string) {
  return (_registry: ComponentRegistry, facade: DefaultSimulatorFacade): Circuit => {
    return facade.build({
      components: [
        { id: "vsA",   type: "DcVoltageSource", props: { label: "vsA",   voltage: VDD } },
        { id: "vsB",   type: "DcVoltageSource", props: { label: "vsB",   voltage: GND_V } },
        { id: "gate",  type: gateType,          props: { label: "gate",  model: "behavioral", inputCount: 2 } },
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

function buildNotGate() {
  return (_registry: ComponentRegistry, facade: DefaultSimulatorFacade): Circuit => {
    return facade.build({
      components: [
        { id: "vsIn",  type: "DcVoltageSource", props: { label: "vsIn",  voltage: VDD } },
        { id: "gate",  type: "Not",             props: { label: "gate",  model: "behavioral" } },
        { id: "rLoad", type: "Resistor",        props: { label: "rLoad", resistance: LOAD_R } },
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

function buildBufGate() {
  return (_registry: ComponentRegistry, facade: DefaultSimulatorFacade): Circuit => {
    return facade.build({
      components: [
        { id: "vsIn",  type: "DcVoltageSource", props: { label: "vsIn",  voltage: VDD } },
        { id: "gate",  type: "Buf",             props: { label: "gate",  model: "behavioral" } },
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

function ceByLabel(fix: Fixture, label: string): CircuitElement {
  for (const ce of fix.circuit.elementToCircuitElement.values()) {
    if (ce.getProperties().getOrDefault<string>("label", "") === label) return ce;
  }
  throw new Error(`CircuitElement with label '${label}' not found`);
}

function setGateParams(fix: Fixture): void {
  const gate = ceByLabel(fix, "gate");
  fix.coordinator.setComponentProperty(gate, "rOut", 200);
  fix.coordinator.setComponentProperty(gate, "vOH", 3.3);
  fix.coordinator.setComponentProperty(gate, "vOL", 0.5);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Gate driver params — rOut / vOH / vOL setParam (Cat 4, T1)", () => {
  it("And driver: setParam rOut/vOH/vOL does not throw", () => {
    const fix = buildFixture({ build: build2InputGate("And") });
    expect(() => setGateParams(fix)).not.toThrow();
  });

  it("NAnd driver: setParam rOut/vOH/vOL does not throw", () => {
    const fix = buildFixture({ build: build2InputGate("NAnd") });
    expect(() => setGateParams(fix)).not.toThrow();
  });

  it("Or driver: setParam rOut/vOH/vOL does not throw", () => {
    const fix = buildFixture({ build: build2InputGate("Or") });
    expect(() => setGateParams(fix)).not.toThrow();
  });

  it("NOr driver: setParam rOut/vOH/vOL does not throw", () => {
    const fix = buildFixture({ build: build2InputGate("NOr") });
    expect(() => setGateParams(fix)).not.toThrow();
  });

  it("XOr driver: setParam rOut/vOH/vOL does not throw", () => {
    const fix = buildFixture({ build: build2InputGate("XOr") });
    expect(() => setGateParams(fix)).not.toThrow();
  });

  it("XNOr driver: setParam rOut/vOH/vOL does not throw", () => {
    const fix = buildFixture({ build: build2InputGate("XNOr") });
    expect(() => setGateParams(fix)).not.toThrow();
  });

  it("Not driver: setParam rOut/vOH/vOL does not throw", () => {
    const fix = buildFixture({ build: buildNotGate() });
    expect(() => setGateParams(fix)).not.toThrow();
  });

  it("Buf driver: setParam rOut/vOH/vOL does not throw", () => {
    const fix = buildFixture({ build: buildBufGate() });
    expect(() => setGateParams(fix)).not.toThrow();
  });
});
