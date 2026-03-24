/**
 * CMOS inverter integration test.
 *
 * Verifies that PFET + NFET with VDD and Ground correctly implement
 * an inverter via the bus resolver's switch-driven net merging.
 */

import { describe, it, expect } from "vitest";
import { CircuitBuilder } from "../../headless/builder.js";
import { SimulationRunner } from "../../headless/runner.js";
import { createDefaultRegistry } from "@/components/register-all";

describe("CMOS inverter", () => {
  it("inverts: A=0 → Y=1, A=1 → Y=0", () => {
    const registry = createDefaultRegistry();
    const builder = new CircuitBuilder(registry);
    const circuit = builder.build({
      components: [
        { id: "in", type: "In", props: { label: "A" } },
        { id: "vdd", type: "VDD" },
        { id: "gnd", type: "Ground" },
        { id: "pf", type: "PFET" },
        { id: "nf", type: "NFET" },
        { id: "out", type: "Out", props: { label: "Y" } },
      ],
      connections: [
        ["in:out", "pf:G"],
        ["in:out", "nf:G"],
        ["vdd:out", "pf:S"],
        ["pf:D", "nf:D"],
        ["pf:D", "out:in"],
        ["nf:S", "gnd:out"],
      ],
    });

    const runner = new SimulationRunner(registry);
    const engine = runner.compile(circuit);

    // A=0: PFET conducts (G=0), NFET open → Y should be 1 (VDD)
    runner.setInput(engine, "A", 0);
    runner.runToStable(engine);
    // VDD outputs all-ones (0xFFFFFFFF); mask to 1-bit
    expect(runner.readOutput(engine, "Y") & 1).toBe(1);

    // A=1: NFET conducts (G=1), PFET open → Y should be 0 (GND)
    runner.setInput(engine, "A", 1);
    runner.runToStable(engine);
    expect(runner.readOutput(engine, "Y") & 1).toBe(0);
  });
});
