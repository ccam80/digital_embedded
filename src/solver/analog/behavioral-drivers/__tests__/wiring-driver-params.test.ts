/**
 * Task 1.2.3: rOut / vOH / vOL param hot-load tests for wiring drivers.
 *
 * Verifies that setParam accepts "rOut", "vOH", and "vOL" on all 5 wiring
 * driver classes without throwing. load() does not read the new params yet
 * (Phase 4 wires the Norton stamps); this test only pins down the setParam
 * surface.
 *
 * Mux/Demux/Decoder/SevenSeg: T1 (buildFixture) via parent component compiled
 * in model: "behavioral", matching behavioral-combinational.test.ts.
 *
 * Splitter: direct element construction (mirrors memory-driver-params.test.ts)
 * to avoid the composite layer whose outer pin names differ from the netlist
 * port names used by buildSplitterNetlist.
 */

import { describe, it, expect } from "vitest";
import { buildFixture } from "../../__tests__/fixtures/build-fixture.js";
import { DefaultSimulatorFacade } from "../../../../headless/default-facade.js";
import type { ComponentRegistry } from "../../../../core/registry.js";
import { PropertyBag } from "../../../../core/properties.js";
import { BehavioralSplitterDriverElement } from "../splitter-driver.js";

function makeSplitterProps(params: Record<string, number>): PropertyBag {
  const bag = new PropertyBag();
  for (const [k, v] of Object.entries(params)) {
    bag.setModelParam(k, v);
  }
  return bag;
}

function splitterPinNodes(inputCount: number, outputCount: number): ReadonlyMap<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < inputCount; i++) m.set(`in_${i}`, i);
  for (let i = 0; i < outputCount; i++) m.set(`out_${i}`, inputCount + i);
  m.set("gnd", inputCount + outputCount);
  return m;
}

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

describe("wiring-driver-params: accepts rOut/vOH/vOL via setParam without throwing", () => {
  it("Multiplexer (BehavioralMuxDriverElement): setParam rOut/vOH/vOL does not throw", () => {
    const fix = buildFixture({ build: buildMuxFixture() });
    const el = fix.coordinator.compiled.labelToCircuitElement.get("mux");
    expect(el).toBeDefined();
    expect(el!.typeId).toBe("Multiplexer");

    expect(() => fix.coordinator.setComponentProperty(el!, "rOut", 200)).not.toThrow();
    expect(el!.getProperties().getModelParam<number>("rOut")).toBe(200);

    expect(() => fix.coordinator.setComponentProperty(el!, "vOH", 3.3)).not.toThrow();
    expect(el!.getProperties().getModelParam<number>("vOH")).toBe(3.3);

    expect(() => fix.coordinator.setComponentProperty(el!, "vOL", 0.5)).not.toThrow();
    expect(el!.getProperties().getModelParam<number>("vOL")).toBe(0.5);
  });

  it("Demultiplexer (BehavioralDemuxDriverElement): setParam rOut/vOH/vOL does not throw", () => {
    const fix = buildFixture({ build: buildDemuxFixture() });
    const el = fix.coordinator.compiled.labelToCircuitElement.get("demux");
    expect(el).toBeDefined();
    expect(el!.typeId).toBe("Demultiplexer");

    expect(() => fix.coordinator.setComponentProperty(el!, "rOut", 200)).not.toThrow();
    expect(el!.getProperties().getModelParam<number>("rOut")).toBe(200);

    expect(() => fix.coordinator.setComponentProperty(el!, "vOH", 3.3)).not.toThrow();
    expect(el!.getProperties().getModelParam<number>("vOH")).toBe(3.3);

    expect(() => fix.coordinator.setComponentProperty(el!, "vOL", 0.5)).not.toThrow();
    expect(el!.getProperties().getModelParam<number>("vOL")).toBe(0.5);
  });

  it("Decoder (BehavioralDecoderDriverElement): setParam rOut/vOH/vOL does not throw", () => {
    const fix = buildFixture({ build: buildDecoderFixture() });
    const el = fix.coordinator.compiled.labelToCircuitElement.get("decoder");
    expect(el).toBeDefined();
    expect(el!.typeId).toBe("Decoder");

    expect(() => fix.coordinator.setComponentProperty(el!, "rOut", 200)).not.toThrow();
    expect(el!.getProperties().getModelParam<number>("rOut")).toBe(200);

    expect(() => fix.coordinator.setComponentProperty(el!, "vOH", 3.3)).not.toThrow();
    expect(el!.getProperties().getModelParam<number>("vOH")).toBe(3.3);

    expect(() => fix.coordinator.setComponentProperty(el!, "vOL", 0.5)).not.toThrow();
    expect(el!.getProperties().getModelParam<number>("vOL")).toBe(0.5);
  });

  it("Splitter (BehavioralSplitterDriverElement): tolerates unknown setParam keys without throwing", () => {
    // Drivers no longer carry rOut/vOH/vOL — those concepts moved to the
    // pin boundary (DigitalOutputPinLoaded). The driver's setParam is a
    // no-op; external callers must continue to work.
    const props = makeSplitterProps({ inputCount: 1, outputCount: 2 });
    const pinNodes = splitterPinNodes(1, 2);
    const el = new BehavioralSplitterDriverElement(pinNodes, props);
    expect(() => el.setParam("rOut", 200)).not.toThrow();
    expect(() => el.setParam("vOH", 3.3)).not.toThrow();
    expect(() => el.setParam("vOL", 0.5)).not.toThrow();
  });

  it("SevenSeg (BehavioralSevenSegDriverElement): setParam rOut/vOH/vOL does not throw", () => {
    const fix = buildFixture({ build: buildSevenSegFixture() });
    const el = fix.coordinator.compiled.labelToCircuitElement.get("seg");
    expect(el).toBeDefined();
    expect(el!.typeId).toBe("SevenSeg");

    expect(() => fix.coordinator.setComponentProperty(el!, "rOut", 200)).not.toThrow();
    expect(el!.getProperties().getModelParam<number>("rOut")).toBe(200);

    expect(() => fix.coordinator.setComponentProperty(el!, "vOH", 3.3)).not.toThrow();
    expect(el!.getProperties().getModelParam<number>("vOH")).toBe(3.3);

    expect(() => fix.coordinator.setComponentProperty(el!, "vOL", 0.5)).not.toThrow();
    expect(el!.getProperties().getModelParam<number>("vOL")).toBe(0.5);
  });
});
