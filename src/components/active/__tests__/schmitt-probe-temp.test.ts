import { describe, it } from "vitest";
import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";

function buildNonInvFixture(opts: { vIn: number; tStop?: number; maxTimeStep?: number }) {
  const { vIn, tStop = 2e-5, maxTimeStep = 1e-6 } = opts;
  return buildFixture({
    build: (_r, facade) => facade.build({
      components: [
        { id: "vsrc",  type: "DcVoltageSource", props: { label: "vsrc", voltage: vIn } },
        { id: "rload", type: "Resistor",        props: { label: "rload", resistance: 10000 } },
        {
          id: "st",
          type: "SchmittNonInverting",
          props: { label: "st", vTH: 2.0, vTL: 1.0, vOH: 3.3, vOL: 0.0, rOut: 50 },
        },
        { id: "gnd", type: "Ground", props: { label: "gnd" } },
      ],
      connections: [
        ["vsrc:pos", "st:in"],
        ["vsrc:neg", "gnd:out"],
        ["st:out",   "rload:pos"],
        ["rload:neg", "gnd:out"],
      ],
    }),
    params: { tStop, maxTimeStep },
  });
}

describe("probe", () => {
  it("probe_vOH_hotload_convergence", () => {
    const fix = buildNonInvFixture({ vIn: 2.5, tStop: 1e-3, maxTimeStep: 1e-6 });
    const outNode = fix.circuit.labelToNodeId.get("st:out")!;
    console.log("outNode:", outNode);
    console.log("simTime before:", fix.engine.simTime);
    console.log("before vOut:", fix.engine.getNodeVoltage(outNode));

    fix.coordinator.setComponentProperty(fix.element("st"), "vOH", 5.0);

    for (let i = 0; i < 200; i++) {
      fix.coordinator.step();
      if (i < 5 || i % 20 === 0) {
        console.log(`step ${i+1}: simTime=${fix.engine.simTime?.toExponential(3)}, vOut=${fix.engine.getNodeVoltage(outNode)}`);
      }
    }
    const after200 = fix.engine.getNodeVoltage(outNode);
    console.log("final after 200 steps:", after200);
    console.log("expected:", 5.0 * 10000 / 10050);
  });

  it("probe_vTL_hotload_convergence", () => {
    // Start HIGH, raise vTL above vIn to force latch LOW
    const fix = buildNonInvFixture({ vIn: 2.5, tStop: 1e-3, maxTimeStep: 1e-6 });
    const outNode = fix.circuit.labelToNodeId.get("st:out")!;
    console.log("vTL before:", fix.engine.getNodeVoltage(outNode));

    fix.coordinator.setComponentProperty(fix.element("st"), "vTL", 2.6);

    for (let i = 0; i < 200; i++) {
      fix.coordinator.step();
      if (i < 5 || i % 20 === 0) {
        console.log(`step ${i+1}: simTime=${fix.engine.simTime?.toExponential(3)}, vOut=${fix.engine.getNodeVoltage(outNode)}`);
      }
    }
    console.log("final after 200 steps:", fix.engine.getNodeVoltage(outNode));
    console.log("expected: 0.0");
  });

  it("probe_vTH_hotload_convergence", () => {
    // Start LOW (vIn=1.5 between thresholds), lower vTH to 1.0 to flip HIGH
    const fix = buildNonInvFixture({ vIn: 1.5, tStop: 1e-3, maxTimeStep: 1e-6 });
    const outNode = fix.circuit.labelToNodeId.get("st:out")!;
    console.log("vTH before:", fix.engine.getNodeVoltage(outNode));

    fix.coordinator.setComponentProperty(fix.element("st"), "vTH", 1.0);

    for (let i = 0; i < 200; i++) {
      fix.coordinator.step();
      if (i < 5 || i % 20 === 0) {
        console.log(`step ${i+1}: simTime=${fix.engine.simTime?.toExponential(3)}, vOut=${fix.engine.getNodeVoltage(outNode)}`);
      }
    }
    console.log("final after 200 steps:", fix.engine.getNodeVoltage(outNode));
    console.log("expected:", 3.3 * 10000 / 10050);
  });
});
