/**
 * Tests for the RealOpAmp railLim LimitingEvent capture (§3 J-014).
 *
 * §4c migration (2026-05-04): the original 19-line stub called
 * `facade.compile(/* CircuitSpec for unity-follower *‌/)` which does not
 * compile; replaced with `buildFixture` via a proper unity-follower circuit.
 *
 * `setLimitingCapture` / `getLimitingEvents` exist on
 * `DefaultSimulationCoordinator` (coordinator.ts:969-983) — the infrastructure
 * is present, so we implement the test for real rather than skipping.
 *
 * Circuit: unity-follower with Vin = Vcc+ + 1 = 16V (overdrives the positive
 * rail of ±15V supply). The RealOpAmp model invokes railLim when the computed
 * output would exceed Vcc+ - vSatPos; that path pushes a
 * `LimitingEvent { limitType: "railLim" }` into the limitingCollector and
 * increments ctx.noncon so the NR loop keeps iterating.
 *
 * Observable:
 *   - DCOP converges.
 *   - At least one LimitingEvent with limitType === "railLim" was captured.
 *   - The first such event has wasLimited === true.
 *   - Vout is clamped to ≤ Vcc+ - vSatPos = 13.5V.
 */

import { describe, it, expect } from "vitest";
import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";

import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

// ---------------------------------------------------------------------------
// Circuit factory
// ---------------------------------------------------------------------------

function buildUnityFollower(facade: DefaultSimulatorFacade, vinVoltage: number): Circuit {
  return facade.build({
    components: [
      { id: "vin",   type: "DcVoltageSource", props: { label: "vin",  voltage: vinVoltage } },
      { id: "vccp",  type: "DcVoltageSource", props: { label: "vccp", voltage:  15 } },
      { id: "vccn",  type: "DcVoltageSource", props: { label: "vccn", voltage: -15 } },
      { id: "opamp", type: "RealOpAmp",       props: {
          label:    "opamp",
          aol:      100000,
          gbw:      1e6,
          slewRate: 0.5e6,
          vos:      0,
          iBias:    0,
          rIn:      1e12,
          rOut:     75,
          iMax:     25e-3,
          vSatPos:  1.5,
          vSatNeg:  1.5,
        } },
      { id: "gnd",   type: "Ground" },
    ],
    connections: [
      ["vin:pos",   "opamp:in+"],
      ["opamp:out", "opamp:in-"],
      ["vccp:pos",  "opamp:Vcc+"],
      ["vccn:pos",  "opamp:Vcc-"],
      ["vin:neg",   "gnd:out"],
      ["vccp:neg",  "gnd:out"],
      ["vccn:neg",  "gnd:out"],
    ],
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("real-opamp railLim", () => {
  it("captures railLim LimitingEvent on Vcc+1 step", () => {
    // Vin = 16V overdrives the +15V supply. The railLim path must fire during
    // DCOP to clamp Vout to Vcc+ - vSatPos = 13.5V.
    const fix = buildFixture({
      build: (_r, facade) => buildUnityFollower(facade, 16 /* Vcc+ + 1 */),
    });

    // Enable limiting capture before running DCOP.
    fix.coordinator.setLimitingCapture(true);
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);

    const events = fix.coordinator.getLimitingEvents();
    const railEvents = events.filter(e => e.limitType === "railLim");
    expect(railEvents.length).toBeGreaterThan(0);
    expect(railEvents[0]!.wasLimited).toBe(true);

    // Vout must be clamped at or below the positive rail clamp (13.5V).
    const nodeId = fix.circuit.labelToNodeId.get("opamp:out");
    if (nodeId === undefined) throw new Error("opamp:out not in labelToNodeId");
    const vOut = fix.engine.getNodeVoltage(nodeId);
    expect(vOut).toBeLessThanOrEqual(13.5 + 0.1);
  });
});
