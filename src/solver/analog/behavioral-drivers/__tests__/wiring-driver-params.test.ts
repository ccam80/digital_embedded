/**
 * Task 1.2.3: rOut / vOH / vOL param hot-load tests for wiring drivers.
 *
 * Verifies that setParam accepts "rOut", "vOH", and "vOL" on all 5 wiring
 * driver classes without throwing. load() does not read the new params yet
 * (Phase 4 wires the Norton stamps); this test only pins down the setParam
 * surface.
 *
 * Tier: T1 (buildFixture). Each driver is exercised via its parent component
 * compiled in model: "behavioral", matching the canonical hot-load pattern
 * in behavioral-combinational.test.ts.
 */

import { describe, it, expect } from "vitest";
import { buildFixture } from "../../__tests__/fixtures/build-fixture.js";
import { DefaultSimulatorFacade } from "../../../../headless/default-facade.js";
import type { ComponentRegistry } from "../../../../core/registry.js";

function buildMuxFixture() {
  return (_registry: ComponentRegistry, facade: DefaultSimulatorFacade) =>
    facade.build({
      components: [
        { id: "vsSel", type: "DcVoltageSource", props: { voltage: 0.0 } },
        { id: "vsIn0", type: "DcVoltageSource", props: { voltage: 0.0 } },
        { id: "vsIn1", type: "DcVoltageSource", props: { voltage: 0.0 } },
        { id: "mux",   type: "Multiplexer",     props: { label: "mux", model: "behavioral", selectorBits: 1 } },
        { id: "rLoad", type: "Resistor",        props: { resistance: 10000 } },
        { id: "gnd",   type: "Ground" },
      ],
      connections: [
        ["vsSel:pos",  "mux:sel"],
        ["vsIn0:pos",  "mux:in_0"],
        ["vsIn1:pos",  "mux:in_1"],
        ["mux:out",    "rLoad:pos"],
        ["rLoad:neg",  "gnd:out"],
        ["vsSel:neg",  "gnd:out"],
        ["vsIn0:neg",  "gnd:out"],
        ["vsIn1:neg",  "gnd:out"],
      ],
    });
}

function buildDemuxFixture() {
  return (_registry: ComponentRegistry, facade: DefaultSimulatorFacade) =>
    facade.build({
      components: [
        { id: "vsSel", type: "DcVoltageSource", props: { voltage: 0.0 } },
        { id: "vsIn",  type: "DcVoltageSource", props: { voltage: 0.0 } },
        { id: "demux", type: "Demultiplexer",   props: { label: "demux", model: "behavioral", selectorBits: 1 } },
        { id: "r0",    type: "Resistor",        props: { resistance: 10000 } },
        { id: "r1",    type: "Resistor",        props: { resistance: 10000 } },
        { id: "gnd",   type: "Ground" },
      ],
      connections: [
        ["vsSel:pos",   "demux:sel"],
        ["vsIn:pos",    "demux:in"],
        ["demux:out_0", "r0:pos"],
        ["demux:out_1", "r1:pos"],
        ["r0:neg",      "gnd:out"],
        ["r1:neg",      "gnd:out"],
        ["vsSel:neg",   "gnd:out"],
        ["vsIn:neg",    "gnd:out"],
      ],
    });
}

function buildDecoderFixture() {
  return (_registry: ComponentRegistry, facade: DefaultSimulatorFacade) =>
    facade.build({
      components: [
        { id: "vsSel",   type: "DcVoltageSource", props: { voltage: 0.0 } },
        { id: "decoder", type: "Decoder",         props: { label: "decoder", model: "behavioral", selectorBits: 1 } },
        { id: "r0",      type: "Resistor",        props: { resistance: 10000 } },
        { id: "r1",      type: "Resistor",        props: { resistance: 10000 } },
        { id: "gnd",     type: "Ground" },
      ],
      connections: [
        ["vsSel:pos",     "decoder:sel"],
        ["decoder:out_0", "r0:pos"],
        ["decoder:out_1", "r1:pos"],
        ["r0:neg",        "gnd:out"],
        ["r1:neg",        "gnd:out"],
        ["vsSel:neg",     "gnd:out"],
      ],
    });
}

function buildSplitterFixture() {
  return (_registry: ComponentRegistry, facade: DefaultSimulatorFacade) =>
    facade.build({
      components: [
        { id: "vsIn",  type: "DcVoltageSource", props: { voltage: 0.0 } },
        { id: "spl",   type: "Splitter",        props: { label: "spl", model: "behavioral", inputSplitting: "8", outputSplitting: "4,4" } },
        { id: "rLo",   type: "Resistor",        props: { resistance: 10000 } },
        { id: "rHi",   type: "Resistor",        props: { resistance: 10000 } },
        { id: "gnd",   type: "Ground" },
      ],
      connections: [
        ["vsIn:pos",   "spl:0-7"],
        ["spl:0-3",    "rLo:pos"],
        ["spl:4-7",    "rHi:pos"],
        ["rLo:neg",    "gnd:out"],
        ["rHi:neg",    "gnd:out"],
        ["vsIn:neg",   "gnd:out"],
      ],
    });
}

function buildSevenSegFixture() {
  return (_registry: ComponentRegistry, facade: DefaultSimulatorFacade) =>
    facade.build({
      components: [
        { id: "seg",  type: "SevenSeg",        props: { label: "seg", model: "behavioral" } },
        { id: "vsA",  type: "DcVoltageSource", props: { voltage: 0.0 } },
        { id: "vsB",  type: "DcVoltageSource", props: { voltage: 0.0 } },
        { id: "vsC",  type: "DcVoltageSource", props: { voltage: 0.0 } },
        { id: "vsD",  type: "DcVoltageSource", props: { voltage: 0.0 } },
        { id: "vsE",  type: "DcVoltageSource", props: { voltage: 0.0 } },
        { id: "vsF",  type: "DcVoltageSource", props: { voltage: 0.0 } },
        { id: "vsG",  type: "DcVoltageSource", props: { voltage: 0.0 } },
        { id: "vsDp", type: "DcVoltageSource", props: { voltage: 0.0 } },
        { id: "gnd",  type: "Ground" },
      ],
      connections: [
        ["vsA:pos",  "seg:a"],
        ["vsB:pos",  "seg:b"],
        ["vsC:pos",  "seg:c"],
        ["vsD:pos",  "seg:d"],
        ["vsE:pos",  "seg:e"],
        ["vsF:pos",  "seg:f"],
        ["vsG:pos",  "seg:g"],
        ["vsDp:pos", "seg:dp"],
        ["vsA:neg",  "gnd:out"],
        ["vsB:neg",  "gnd:out"],
        ["vsC:neg",  "gnd:out"],
        ["vsD:neg",  "gnd:out"],
        ["vsE:neg",  "gnd:out"],
        ["vsF:neg",  "gnd:out"],
        ["vsG:neg",  "gnd:out"],
        ["vsDp:neg", "gnd:out"],
      ],
    });
}

function findByLabel(fix: ReturnType<typeof buildFixture>, label: string) {
  return fix.coordinator.compiled.allCircuitElements.find(
    e => e.getProperties().getOrDefault<string>("label", "") === label,
  );
}

describe("wiring-driver-params: accepts rOut/vOH/vOL via setParam without throwing", () => {
  it("Multiplexer (BehavioralMuxDriverElement): setParam rOut/vOH/vOL does not throw", () => {
    const fix = buildFixture({ build: buildMuxFixture() });
    const el = findByLabel(fix, "mux");
    expect(el).toBeDefined();
    expect(() => fix.coordinator.setComponentProperty(el!, "rOut", 200)).not.toThrow();
    expect(() => fix.coordinator.setComponentProperty(el!, "vOH", 3.3)).not.toThrow();
    expect(() => fix.coordinator.setComponentProperty(el!, "vOL", 0.5)).not.toThrow();
  });

  it("Demultiplexer (BehavioralDemuxDriverElement): setParam rOut/vOH/vOL does not throw", () => {
    const fix = buildFixture({ build: buildDemuxFixture() });
    const el = findByLabel(fix, "demux");
    expect(el).toBeDefined();
    expect(() => fix.coordinator.setComponentProperty(el!, "rOut", 200)).not.toThrow();
    expect(() => fix.coordinator.setComponentProperty(el!, "vOH", 3.3)).not.toThrow();
    expect(() => fix.coordinator.setComponentProperty(el!, "vOL", 0.5)).not.toThrow();
  });

  it("Decoder (BehavioralDecoderDriverElement): setParam rOut/vOH/vOL does not throw", () => {
    const fix = buildFixture({ build: buildDecoderFixture() });
    const el = findByLabel(fix, "decoder");
    expect(el).toBeDefined();
    expect(() => fix.coordinator.setComponentProperty(el!, "rOut", 200)).not.toThrow();
    expect(() => fix.coordinator.setComponentProperty(el!, "vOH", 3.3)).not.toThrow();
    expect(() => fix.coordinator.setComponentProperty(el!, "vOL", 0.5)).not.toThrow();
  });

  it("Splitter (BehavioralSplitterDriverElement): setParam rOut/vOH/vOL does not throw", () => {
    const fix = buildFixture({ build: buildSplitterFixture() });
    const el = findByLabel(fix, "spl");
    expect(el).toBeDefined();
    expect(() => fix.coordinator.setComponentProperty(el!, "rOut", 200)).not.toThrow();
    expect(() => fix.coordinator.setComponentProperty(el!, "vOH", 3.3)).not.toThrow();
    expect(() => fix.coordinator.setComponentProperty(el!, "vOL", 0.5)).not.toThrow();
  });

  it("SevenSeg (BehavioralSevenSegDriverElement): setParam rOut/vOH/vOL does not throw", () => {
    const fix = buildFixture({ build: buildSevenSegFixture() });
    const el = findByLabel(fix, "seg");
    expect(el).toBeDefined();
    expect(() => fix.coordinator.setComponentProperty(el!, "rOut", 200)).not.toThrow();
    expect(() => fix.coordinator.setComponentProperty(el!, "vOH", 3.3)).not.toThrow();
    expect(() => fix.coordinator.setComponentProperty(el!, "vOL", 0.5)).not.toThrow();
  });
});
