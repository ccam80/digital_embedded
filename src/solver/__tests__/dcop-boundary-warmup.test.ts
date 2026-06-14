/**
 * Standalone DC operating-point digital warmup for mixed-signal boundaries.
 *
 * A `.op` analysis does not run the transient mixed step, so without a one-step
 * digital warmup the boundary OUTPUT adapters sit at their drive-low defaults
 * and corrupt the bias point. dcOperatingPoint() now evaluates the digital
 * engine once and pushes each crossing output pin's level/Hi-Z onto its adapter
 * before the analog solve. This verifies the bias point reflects the real
 * digital state: a tri-state Driver drives the hub when enabled and releases it
 * (Hi-Z) when its select line deselects it.
 */

import { describe, it, expect } from "vitest";
import { buildFixture } from "../analog/__tests__/fixtures/build-fixture.js";
import type { Fixture } from "../analog/__tests__/fixtures/build-fixture.js";

// A(In)→drv:in, S(In)→drv:sel, drv:out→Rload→Rpull→gnd.
function buildDriverFixture(): Fixture {
  return buildFixture({
    build: (_r, facade) => facade.build({
      components: [
        { id: "A", type: "In", props: { label: "A", bitWidth: 1 } },
        { id: "S", type: "In", props: { label: "S", bitWidth: 1 } },
        { id: "drv", type: "Driver", props: { label: "drv", bitWidth: 1 } },
        { id: "Rload", type: "Resistor", props: { label: "Rload", resistance: 50 } },
        { id: "Rpull", type: "Resistor", props: { label: "Rpull", resistance: 1e6 } },
        { id: "gnd", type: "Ground" },
      ],
      connections: [
        ["A:out", "drv:in"],
        ["S:out", "drv:sel"],
        ["drv:out", "Rload:pos"],
        ["Rload:neg", "Rpull:pos"],
        ["Rpull:neg", "gnd:out"],
      ],
    }),
  });
}

function hubNode(fix: Fixture): number {
  const compiled = fix.coordinator.compiled;
  const bridge = compiled.bridges.find((b) => b.role === "output");
  if (bridge === undefined) throw new Error("no output bridge");
  return bridge.analogNodeId;
}

describe("DC-op digital warmup: tri-state boundary output", () => {
  it("sel=1 (enabled) drives the hub toward vOH at the bias point", () => {
    const fix = buildDriverFixture();
    const node = hubNode(fix);
    fix.coordinator.writeByLabel("A", { type: "digital", value: 1 });
    fix.coordinator.writeByLabel("S", { type: "digital", value: 1 });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    expect(dc!.nodeVoltages[node]!).toBeGreaterThan(3.0);
    fix.coordinator.dispose();
  });

  it("sel=0 (deselected) releases the hub at the bias point (not pinned)", () => {
    const fix = buildDriverFixture();
    const node = hubNode(fix);
    // data=1 but select=0 → Driver Hi-Z → adapter en=0 → only Rpull holds the hub.
    fix.coordinator.writeByLabel("A", { type: "digital", value: 1 });
    fix.coordinator.writeByLabel("S", { type: "digital", value: 0 });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    // Released: the hub is pulled to ~0 by Rpull, not driven to vOH.
    expect(Math.abs(dc!.nodeVoltages[node]!)).toBeLessThan(0.5);
    fix.coordinator.dispose();
  });
});
