/**
 * Test: chained CMOS inverter built from NFET/PFET switches.
 *
 * Validates that the bus resolver correctly handles simultaneous switch
 * open/close transitions without false burn detection. This is the
 * regression test for the stale cross-driver value bug.
 *
 * Note: VDD outputs 0xFFFFFFFF (all bits set) for any bit width. The bus
 * resolver propagates this raw value through switches. For 1-bit signals,
 * a logical high from VDD is 0xFFFFFFFF in the raw state array. We mask
 * to bit width when comparing expected values, matching how the wire
 * renderer interprets signal values.
 */

import { describe, it, expect } from "vitest";
import { createDefaultRegistry } from "../../components/register-all.js";
import { SimulationRunner } from "../../headless/runner.js";
import { CircuitBuilder } from "../../headless/builder.js";

/** Mask raw signal to 1-bit: 0 stays 0, any non-zero becomes 1. */
function bit(raw: number): number {
  return raw & 1;
}

describe("Chained CMOS inverters", () => {
  const registry = createDefaultRegistry();
  const builder = new CircuitBuilder(registry);
  const runner = new SimulationRunner(registry);

  function buildChainedInverters() {
    return builder.build({
      components: [
        { id: "in", type: "In", props: { label: "A" } },
        { id: "vdd1", type: "VDD" },
        { id: "p1", type: "PFET", props: { label: "P1" } },
        { id: "n1", type: "NFET", props: { label: "N1" } },
        { id: "gnd1", type: "Ground" },
        { id: "vdd2", type: "VDD" },
        { id: "p2", type: "PFET", props: { label: "P2" } },
        { id: "n2", type: "NFET", props: { label: "N2" } },
        { id: "gnd2", type: "Ground" },
        { id: "out", type: "Out", props: { label: "Y" } },
      ],
      connections: [
        ["in:out", "p1:G"],
        ["in:out", "n1:G"],
        ["vdd1:out", "p1:S"],
        ["p1:D", "n1:D"],
        ["n1:S", "gnd1:out"],
        ["p1:D", "p2:G"],
        ["p1:D", "n2:G"],
        ["vdd2:out", "p2:S"],
        ["p2:D", "n2:D"],
        ["n2:S", "gnd2:out"],
        ["p2:D", "out:in"],
      ],
    });
  }

  it("compiles without bus conflict", () => {
    const circuit = buildChainedInverters();
    expect(() => runner.compile(circuit)).not.toThrow();
  });

  it("A=0 → Y=0 (double inversion)", () => {
    const circuit = buildChainedInverters();
    const engine = runner.compile(circuit);
    runner.setInput(engine, "A", 0);
    runner.runToStable(engine);
    expect(bit(runner.readOutput(engine, "Y"))).toBe(0);
  });

  it("A=1 → Y=1 (double inversion)", () => {
    const circuit = buildChainedInverters();
    const engine = runner.compile(circuit);
    runner.setInput(engine, "A", 1);
    runner.runToStable(engine);
    expect(bit(runner.readOutput(engine, "Y"))).toBe(1);
  });

  it("toggles correctly", () => {
    const circuit = buildChainedInverters();
    const engine = runner.compile(circuit);

    runner.setInput(engine, "A", 0);
    runner.runToStable(engine);
    expect(bit(runner.readOutput(engine, "Y"))).toBe(0);

    runner.setInput(engine, "A", 1);
    runner.runToStable(engine);
    expect(bit(runner.readOutput(engine, "Y"))).toBe(1);

    runner.setInput(engine, "A", 0);
    runner.runToStable(engine);
    expect(bit(runner.readOutput(engine, "Y"))).toBe(0);
  });
});
