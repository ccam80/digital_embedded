/**
 * Differential ("across-component") voltage trace + split Y-axis tests.
 *
 * Test #1 (across-component value) runs against the REAL prod fixture
 * `fixtures/ac_rlc.dts` through the real engine/coordinator — no stub — to prove
 * the scope's voltageDiff channel reports V(pos) − V(neg) across the resistor,
 * the exact thing that read as "no drop" before this fix.
 *
 * Test #2 proves current and voltage channels auto-range on independent axes,
 * so a large current can't flatten the voltage traces.
 *
 * Test #3 proves the by-pin-label re-resolution used on trace restore maps the
 * resistor's pins back to the right nodes after compile.
 */

import { describe, it, expect } from "vitest";
import * as path from "node:path";

import { ScopePanel } from "../analog-scope-panel.js";
import { buildFixture } from "@/solver/analog/__tests__/fixtures/build-fixture.js";
import { resolveElementPinNodes } from "@/app/viewer-controller.js";
import {
  buildNonEngineCoordinator,
  type NonEngineCoordinator,
} from "@/test-utils/non-engine-coordinator.js";
import type { SignalAddress } from "@/compile/types.js";
import type { CircuitElement } from "@/core/element.js";
import type { CurrentResolverContext } from "@/solver/coordinator-types.js";

const AC_RLC = path.resolve("fixtures/ac_rlc.dts");

function findResistor(ctx: CurrentResolverContext): CircuitElement {
  for (const ce of ctx.elementToCircuitElement.values()) {
    if (ce.typeId === "Resistor") return ce;
  }
  throw new Error("ac_rlc fixture has no Resistor");
}

describe("scope differential voltage (real ac_rlc fixture)", () => {
  it("voltageDiff_channel_reports_resistor_drop_not_a_single_node", () => {
    const fix = buildFixture({ dtsPath: AC_RLC, params: { tStop: 3e-4, maxTimeStep: 3e-6 } });
    const ctx = fix.coordinator.getCurrentResolverContext();
    expect(ctx).not.toBeNull();

    const resistor = findResistor(ctx!);
    const pinNodes = resolveElementPinNodes(resistor, ctx!);
    const posNode = pinNodes.get("pos");
    const negNode = pinNodes.get("neg");
    expect(posNode).toBeDefined();
    expect(negNode).toBeDefined();
    expect(posNode).not.toBe(negNode); // both terminals are live nodes (the original bug's tell)

    const posAddr: SignalAddress = { domain: "analog", nodeId: posNode! };
    const negAddr: SignalAddress = { domain: "analog", nodeId: negNode! };

    const panel = new ScopePanel(null, fix.coordinator);
    panel.addVoltageDiffChannel(posAddr, negAddr, "V(R1)");

    let maxAbsDrop = 0;
    for (let i = 0; i < 100; i++) {
      fix.coordinator.step();
      panel.onStep(i);

      const pv = fix.coordinator.readSignal(posAddr);
      const nv = fix.coordinator.readSignal(negAddr);
      const expected = (pv.type === "analog" ? pv.voltage : 0) - (nv.type === "analog" ? nv.voltage : 0);

      const traced = panel.getTraceValues().find(t => t.label === "V(R1)");
      expect(traced).toBeDefined();
      // The traced channel value is exactly the node difference, not one node.
      expect(traced!.value).toBeCloseTo(expected, 9);
      maxAbsDrop = Math.max(maxAbsDrop, Math.abs(traced!.value));
    }

    // The drop is a real, non-trivial differential — not the flat ~0 the UI showed.
    expect(maxAbsDrop).toBeGreaterThan(0.1);
    panel.dispose();
  });
});

describe("scope split Y-axis", () => {
  function seed(): { coord: NonEngineCoordinator; vAddr: SignalAddress } {
    const coord = buildNonEngineCoordinator({ simTime: 0 });
    const vAddr: SignalAddress = { domain: "analog", nodeId: 3 };
    coord.setSignal(vAddr, { type: "analog", voltage: 5 });
    coord.setElementCurrent(0, 120); // large edge-spike-style current
    coord.setSimTime(1e-6);
    return { coord, vAddr };
  }

  it("current_magnitude_does_not_blow_out_the_voltage_axis", () => {
    const { coord, vAddr } = seed();
    const panel = new ScopePanel(null, coord);
    panel.addVoltageChannel(vAddr, "V");
    panel.addElementCurrentChannel(0, "I");
    panel.onStep(1);

    const { voltage, current } = panel.getAxisRanges();
    // Voltage axis stays near 5 V — not dragged toward 120 A.
    expect(voltage.yMax).toBeLessThan(20);
    expect(voltage.yMin).toBeGreaterThan(-20);
    // Current has its own axis spanning the large value.
    expect(current).not.toBeNull();
    expect(current!.yMax).toBeGreaterThan(100);
    panel.dispose();
  });
});

describe("voltageDiff trace restore re-resolution", () => {
  it("re_resolves_pin_labels_to_nodes_after_compile", () => {
    const fix = buildFixture({ dtsPath: AC_RLC });
    const ctx = fix.coordinator.getCurrentResolverContext();
    expect(ctx).not.toBeNull();

    const resistor = findResistor(ctx!);
    const resolved = resolveElementPinNodes(resistor, ctx!);

    // The same pin labels a saved voltageDiff trace stores re-resolve to the
    // resistor's actual compiled nodes.
    let resistorIndex = -1;
    for (const [idx, ce] of ctx!.elementToCircuitElement) {
      if (ce === resistor) { resistorIndex = idx; break; }
    }
    expect(resistorIndex).toBeGreaterThanOrEqual(0);
    const analogEl = ctx!.elements[resistorIndex]!;

    expect(resolved.get("pos")).toBe(analogEl.pinNodes.get("pos"));
    expect(resolved.get("neg")).toBe(analogEl.pinNodes.get("neg"));
  });
});
