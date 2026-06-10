/**
 * Component voltage-trace node resolution parity (Surface 1, headless).
 *
 * The component right-click "Trace Voltage" menu (single-pin and differential)
 * must resolve each pin's MNA node from the same authoritative source the pin
 * colouring uses (`getPinVoltages` -> `elementResolvedPins`). A prior
 * world-position match against the wire->node table read a flat 0 V for any pin
 * whose net is joined through a Tunnel or a coincident-pin overlap, because no
 * wire endpoint sits on the pin. buckbjt is full of Tunnels, so it is the
 * canonical reproduction.
 */

import { describe, it, expect } from "vitest";
import * as path from "node:path";

import { buildFixture } from "@/solver/analog/__tests__/fixtures/build-fixture.js";
import { resolveElementPinNodes } from "@/app/viewer-controller.js";
import type { CircuitElement } from "@/core/element.js";

const BUCKBJT = path.resolve("fixtures/buckbjt.dts");

describe("component voltage-trace node resolution (buckbjt, tunnel-heavy)", () => {
  it("trace-menu pin node matches the pin-colouring node for every analog pin", () => {
    const fix = buildFixture({ dtsPath: BUCKBJT, params: { tStop: 5e-4, maxTimeStep: 5e-6 } });
    for (let i = 0; i < 50; i++) fix.coordinator.step();

    const ctx = fix.coordinator.getCurrentResolverContext();
    expect(ctx).not.toBeNull();

    let pinsChecked = 0;
    let sawTunnelJoinedPin = false; // a pin the old world-position matcher would have dropped

    for (const [, ce] of ctx!.elementToCircuitElement) {
      const el = ce as CircuitElement;
      // Pure 2-terminal analog devices whose pins carry user-facing labels.
      if (el.typeId !== "Resistor" && el.typeId !== "Capacitor" && el.typeId !== "Inductor") continue;

      const colorV = fix.coordinator.getPinVoltages(el); // authoritative colouring read
      if (!colorV) continue;
      const traceNodes = resolveElementPinNodes(el, ctx!); // the trace-menu resolution

      for (const pin of el.getPins()) {
        const node = traceNodes.get(pin.label);
        // Every pin the colouring path knows must resolve to a trace node.
        expect(node, `${el.typeId}.${pin.label} unresolved by trace menu`).toBeDefined();

        const sv = fix.coordinator.readSignal({ domain: "analog", nodeId: node! });
        const traceV = sv.type === "analog" ? sv.voltage : NaN;
        const colorVal = colorV.get(pin.label)!;
        expect(traceV).toBeCloseTo(colorVal, 9);

        // A non-zero pin proves the trace now reads the real swing, not 0 V.
        if (Math.abs(colorVal) > 1e-6 && (node ?? 0) > 0) sawTunnelJoinedPin = true;
        pinsChecked++;
      }
    }

    expect(pinsChecked).toBeGreaterThan(0);
    // The whole point: at least one live (non-ground) pin reads a real voltage.
    expect(sawTunnelJoinedPin, "expected at least one non-zero pin reading").toBe(true);
  });
});
