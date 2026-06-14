/**
 * Mid-simulation hot-load test for the per-pin boundary output adapter.
 *
 * Verifies that hot-loading `vOH` on the boundary-adapter wrapper
 * (`handle.wrapper.setParam("vOH", …)`, which routes through the composite
 * binding map to the inner tri-state pin) moves the driven analog node target
 * to the new vOH on the next stamp cycle, and does not disturb a logic-LOW
 * drive. Observed at the engine surface only.
 *
 *   In(A) ──out──► Rload(50Ω) ──► node ──► Rpull(1MΩ) ──► Ground
 *
 * With Rpull = 1MΩ the divider barely loads the finite-rOut bridge:
 *   V(node) ≈ vOH · Rpull / (rOut + Rload + Rpull)
 *           = vOH · 1e6 / (50 + 50 + 1e6) ≈ vOH · 0.9999
 */

import { describe, it, expect } from "vitest";
import { buildFixture } from "../analog/__tests__/fixtures/build-fixture.js";
import type { Fixture } from "../analog/__tests__/fixtures/build-fixture.js";
import type { BridgePinAdapterHandle } from "../analog/compiler.js";

function buildOutputFixture(): Fixture {
  return buildFixture({
    build: (_r, facade) => facade.build({
      components: [
        { id: "A", type: "In", props: { label: "A", bitWidth: 1 } },
        { id: "Rload", type: "Resistor", props: { label: "Rload", resistance: 50 } },
        { id: "Rpull", type: "Resistor", props: { label: "Rpull", resistance: 1e6 } },
        { id: "gnd", type: "Ground" },
      ],
      connections: [
        ["A:out", "Rload:pos"],
        ["Rload:neg", "Rpull:pos"],
        ["Rpull:neg", "gnd:out"],
      ],
    }),
  });
}

function outputAdapter(fix: Fixture): { handle: BridgePinAdapterHandle; nodeId: number } {
  const compiled = fix.coordinator.compiled;
  const bridge = compiled.bridges.find((b) => b.role === "output");
  if (bridge === undefined) throw new Error("no output bridge produced");
  const handle = compiled.analog!.bridgeAdaptersByPinKey.get(bridge.pinKey);
  if (handle === undefined) throw new Error(`no adapter handle for ${bridge.pinKey}`);
  return { handle, nodeId: bridge.analogNodeId };
}

function stepToSteadyState(fix: Fixture, nodeId: number, maxSteps = 200, tol = 1e-6): number {
  const analog = fix.coordinator.getAnalogEngine();
  if (analog === null) throw new Error("stepToSteadyState: no analog engine");
  let prev = analog.getNodeVoltage(nodeId);
  for (let i = 0; i < maxSteps; i++) {
    fix.coordinator.step();
    const cur = analog.getNodeVoltage(nodeId);
    if (Math.abs(cur - prev) < tol) return cur;
    prev = cur;
  }
  return prev;
}

/** Divider target: V(node) = vOH · Rpull / (rOut + Rload + Rpull). */
function dividerTarget(vOH: number): number {
  const rOut = 50;
  const Rload = 50;
  const Rpull = 1e6;
  return (vOH * Rpull) / (rOut + Rload + Rpull);
}

describe("boundary adapter: hot-load vOH mid-simulation", () => {
  it('setParam("vOH", 5.0) after steady-state HIGH moves the node target to ~5.0', () => {
    const fix = buildOutputFixture();
    const { handle, nodeId } = outputAdapter(fix);

    fix.coordinator.writeByLabel("A", { type: "digital", value: 1 });
    const vBefore = stepToSteadyState(fix, nodeId);
    const tBefore = dividerTarget(3.3);
    // ±3% band around the finite-rOut divider target (small over-vOH settling
    // overshoot is observed and tolerated).
    expect(Math.abs(vBefore - tBefore)).toBeLessThan(0.03 * tBefore);

    handle.wrapper.setParam("vOH", 5.0);
    const vAfter = stepToSteadyState(fix, nodeId);
    const tAfter = dividerTarget(5.0);
    expect(Math.abs(vAfter - tAfter)).toBeLessThan(0.03 * tAfter);

    expect(vAfter - vBefore).toBeGreaterThan(1.5);
    fix.coordinator.dispose();
  });

  it('setParam("vOH", 5.0) does not affect a logic-LOW drive (still ~0V)', () => {
    const fix = buildOutputFixture();
    const { handle, nodeId } = outputAdapter(fix);

    fix.coordinator.writeByLabel("A", { type: "digital", value: 0 });
    const vLowBefore = stepToSteadyState(fix, nodeId);
    expect(Math.abs(vLowBefore)).toBeLessThan(1e-3);

    handle.wrapper.setParam("vOH", 5.0);
    const vLowAfter = stepToSteadyState(fix, nodeId);
    expect(Math.abs(vLowAfter)).toBeLessThan(1e-3);
    fix.coordinator.dispose();
  });

  it('setParam("vOH", 5.0) while LOW, then switch HIGH, drives ~5.0', () => {
    const fix = buildOutputFixture();
    const { handle, nodeId } = outputAdapter(fix);

    fix.coordinator.writeByLabel("A", { type: "digital", value: 0 });
    const vLow = stepToSteadyState(fix, nodeId);
    expect(Math.abs(vLow)).toBeLessThan(1e-3);

    handle.wrapper.setParam("vOH", 5.0);

    fix.coordinator.writeByLabel("A", { type: "digital", value: 1 });
    const vHigh = stepToSteadyState(fix, nodeId);
    const t = dividerTarget(5.0);
    expect(Math.abs(vHigh - t)).toBeLessThan(0.03 * t);
    expect(vHigh).toBeGreaterThan(3.3 + 0.5);
    fix.coordinator.dispose();
  });
});
