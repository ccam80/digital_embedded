import { describe, it, expect } from "vitest";
import { buildFixture } from "../../__tests__/fixtures/build-fixture.js";
import { DefaultSimulatorFacade } from "../../../../headless/default-facade.js";
import type { ComponentRegistry } from "../../../../core/registry.js";
import type { Circuit } from "../../../../core/circuit.js";

function buildThresholderFixture(vIn: number) {
  return (_registry: ComponentRegistry, facade: DefaultSimulatorFacade): Circuit =>
    facade.build({
      components: [
        { id: "vsIn",  type: "DcVoltageSource",         props: { label: "vsIn",  voltage: vIn } },
        { id: "thresh", type: "DigitalInputThresholder", props: { label: "thresh" } },
        { id: "rLoad", type: "Resistor",                props: { label: "rLoad", resistance: 1_000_000 } },
        { id: "gnd",   type: "Ground" },
      ],
      connections: [
        ["vsIn:pos",      "thresh:in"],
        ["vsIn:neg",      "gnd:out"],
        ["thresh:gnd",    "gnd:out"],
        ["thresh:result", "rLoad:pos"],
        ["rLoad:neg",     "gnd:out"],
      ],
    });
}

describe("DigitalInputThresholderElement classification (Cat 2 DCOP)", () => {
  it("stamps HI (1.0V) when V(in) > vIH (vsIn=3.0V, defaults)", () => {
    const fix = buildFixture({ build: buildThresholderFixture(3.0) });
    const resultNode = fix.circuit.labelToNodeId.get("thresh:result")!;
    const gndNode = fix.circuit.labelToNodeId.get("thresh:gnd")!;
    const v = fix.engine.getNodeVoltage(resultNode) - fix.engine.getNodeVoltage(gndNode);
    expect(v).toBeCloseTo(1.0, 4);
  });

  it("stamps LO (0.0V) when V(in) < vIL (vsIn=0.5V, defaults)", () => {
    const fix = buildFixture({ build: buildThresholderFixture(0.5) });
    const resultNode = fix.circuit.labelToNodeId.get("thresh:result")!;
    const gndNode = fix.circuit.labelToNodeId.get("thresh:gnd")!;
    const v = fix.engine.getNodeVoltage(resultNode) - fix.engine.getNodeVoltage(gndNode);
    expect(v).toBeCloseTo(0.0, 4);
  });

  it("stamps indeterminate (0.5V) when V(in) in band [vIL, vIH] (vsIn=1.4V, defaults)", () => {
    const fix = buildFixture({ build: buildThresholderFixture(1.4) });
    const resultNode = fix.circuit.labelToNodeId.get("thresh:result")!;
    const gndNode = fix.circuit.labelToNodeId.get("thresh:gnd")!;
    const v = fix.engine.getNodeVoltage(resultNode) - fix.engine.getNodeVoltage(gndNode);
    expect(v).toBeCloseTo(0.5, 4);
  });

  it("stamps indeterminate (0.5V) at exact upper boundary V(in) == vIH (vsIn=2.0V, defaults)", () => {
    const fix = buildFixture({ build: buildThresholderFixture(2.0) });
    const resultNode = fix.circuit.labelToNodeId.get("thresh:result")!;
    const gndNode = fix.circuit.labelToNodeId.get("thresh:gnd")!;
    const v = fix.engine.getNodeVoltage(resultNode) - fix.engine.getNodeVoltage(gndNode);
    expect(v).toBeCloseTo(0.5, 4);
  });

  it("stamps indeterminate (0.5V) at exact lower boundary V(in) == vIL (vsIn=0.8V, defaults)", () => {
    const fix = buildFixture({ build: buildThresholderFixture(0.8) });
    const resultNode = fix.circuit.labelToNodeId.get("thresh:result")!;
    const gndNode = fix.circuit.labelToNodeId.get("thresh:gnd")!;
    const v = fix.engine.getNodeVoltage(resultNode) - fix.engine.getNodeVoltage(gndNode);
    expect(v).toBeCloseTo(0.5, 4);
  });
});

describe("DigitalInputThresholderElement hot-load (Cat 4)", () => {
  it("setComponentProperty(\"vIH\", 1.0) lowers HIGH threshold and reclassifies mid-band input as HI", () => {
    const fix = buildFixture({ build: buildThresholderFixture(1.5) });
    const resultNode = fix.circuit.labelToNodeId.get("thresh:result")!;
    const gndNode = fix.circuit.labelToNodeId.get("thresh:gnd")!;
    const before = fix.engine.getNodeVoltage(resultNode) - fix.engine.getNodeVoltage(gndNode);
    expect(before).toBeCloseTo(0.5, 4);

    const thrElt = fix.coordinator.compiled.labelToCircuitElement.get("thresh")!;
    fix.coordinator.setComponentProperty(thrElt, "vIH", 1.0);
    fix.coordinator.step();

    const after = fix.engine.getNodeVoltage(resultNode) - fix.engine.getNodeVoltage(gndNode);
    expect(after).toBeCloseTo(1.0, 4);
    expect(after).not.toBeCloseTo(before, 4);
  });

  it("setComponentProperty(\"vIL\", 1.5) raises LOW threshold and reclassifies mid-band input as LO", () => {
    const fix = buildFixture({ build: buildThresholderFixture(1.0) });
    const resultNode = fix.circuit.labelToNodeId.get("thresh:result")!;
    const gndNode = fix.circuit.labelToNodeId.get("thresh:gnd")!;
    const before = fix.engine.getNodeVoltage(resultNode) - fix.engine.getNodeVoltage(gndNode);
    expect(before).toBeCloseTo(0.5, 4);

    const thrElt = fix.coordinator.compiled.labelToCircuitElement.get("thresh")!;
    fix.coordinator.setComponentProperty(thrElt, "vIL", 1.5);
    fix.coordinator.step();

    const after = fix.engine.getNodeVoltage(resultNode) - fix.engine.getNodeVoltage(gndNode);
    expect(after).toBeCloseTo(0.0, 4);
    expect(after).not.toBeCloseTo(before, 4);
  });
});
