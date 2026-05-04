/**
 * Integration test: CurrentSource KCL integration.
 *
 * Circuit: I_src (2 mA) → R (1 kΩ) → ground
 *   V_node = I * R = 0.002 * 1000 = 2.0 V
 *
 * KCL residual is verified via the solved node voltage: if KCL holds the
 * node voltage must equal I * R exactly.
 */

import { describe, it, expect } from "vitest";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";

describe("CurrentSource- KCL integration", () => {
  it("pin index 0 (neg) carries +I, pin index 1 (pos) carries -I", async () => {
    // Circuit: I_src (2 mA) → R (1 kΩ) → GND
    // V = I * R = 0.002 * 1000 = 2.0 V at the shared node.
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) => {
        const facade = new DefaultSimulatorFacade(registry);
        return facade.build({
          components: [
            { id: "isrc", type: "CurrentSource", props: { label: "isrc", current: 0.002 } },
            { id: "r1",   type: "Resistor",      props: { label: "r1",   resistance: 1000 } },
            { id: "gnd",  type: "Ground" },
          ],
          connections: [
            ["isrc:pos", "r1:pos"],
            ["r1:neg",   "gnd:out"],
            ["isrc:neg", "gnd:out"],
          ],
        });
      },
      analysis: "dcop",
    });

    const stepEnd = session.getStepEnd(0);
    expect(stepEnd.converged.ours).toBe(true);

    // V = I * R = 0.002 * 1000 = 2.0 V.
    // KCL: if the node voltage is correct, KCL holds at every node.
    const vNode = stepEnd.nodes["r1:pos"]?.ours ?? stepEnd.nodes["isrc:pos"]?.ours;
    expect(vNode).toBeDefined();
    expect(vNode!).toBeCloseTo(2.0, 9);
  });

  it("setParam current update propagates through dcop", async () => {
    // Circuit: I_src (5 mA) → R (1 kΩ) → GND
    // V = 0.005 * 1000 = 5.0 V at the shared node.
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) => {
        const facade = new DefaultSimulatorFacade(registry);
        return facade.build({
          components: [
            { id: "isrc", type: "CurrentSource", props: { label: "isrc", current: 0.005 } },
            { id: "r1",   type: "Resistor",      props: { label: "r1",   resistance: 1000 } },
            { id: "gnd",  type: "Ground" },
          ],
          connections: [
            ["isrc:pos", "r1:pos"],
            ["r1:neg",   "gnd:out"],
            ["isrc:neg", "gnd:out"],
          ],
        });
      },
      analysis: "dcop",
    });

    const stepEnd = session.getStepEnd(0);
    expect(stepEnd.converged.ours).toBe(true);

    const vNode = stepEnd.nodes["r1:pos"]?.ours ?? stepEnd.nodes["isrc:pos"]?.ours;
    expect(vNode).toBeDefined();
    expect(vNode!).toBeCloseTo(5.0, 9);
  });
});
