/**
 * W6.T1- Shape API tests (ss10.4 headless).
 *
 * Tests for getSessionShape(), getStepShape(), and getStepAtTime() on
 * ComparisonSession.createSelfCompare(). All tests are purely headless-
 * no ngspice DLL required.
 */

import { describe, it, expect } from "vitest";
import { ComparisonSession } from "./comparison-session.js";
import { DefaultSimulatorFacade } from "../../../../headless/default-facade.js";
import type { ComponentRegistry } from "../../../../core/registry.js";
import type { Circuit } from "../../../../core/circuit.js";

// ---------------------------------------------------------------------------
// Circuit factories- return a high-level Circuit via facade.build()
// ---------------------------------------------------------------------------

function buildRcCircuit(registry: ComponentRegistry): Circuit {
  const facade = new DefaultSimulatorFacade(registry);
  return facade.build({
    components: [
      { id: "vs",  type: "DcVoltageSource", props: { voltage: 5 } },
      { id: "r1",  type: "Resistor",        props: { resistance: 1000 } },
      { id: "c1",  type: "Capacitor",       props: { capacitance: 1e-6 } },
      { id: "gnd", type: "Ground" },
    ],
    connections: [
      ["vs:pos", "r1:A"],
      ["r1:B",   "c1:pos"],
      ["c1:neg", "gnd:out"],
      ["vs:neg", "gnd:out"],
    ],
  });
}

function buildHwrCircuit(registry: ComponentRegistry): Circuit {
  const facade = new DefaultSimulatorFacade(registry);
  return facade.build({
    components: [
      { id: "vs",   type: "DcVoltageSource", props: { voltage: 5 } },
      { id: "r1",   type: "Resistor",        props: { resistance: 1000 } },
      { id: "d1",   type: "Diode",           props: {} },
      { id: "gnd",  type: "Ground" },
    ],
    connections: [
      ["vs:pos",  "r1:A"],
      ["r1:B",    "d1:A"],
      ["d1:K",    "gnd:out"],
      ["vs:neg",  "gnd:out"],
    ],
  });
}

// ---------------------------------------------------------------------------
// getSessionShape
// ---------------------------------------------------------------------------

describe("getSessionShape", () => {
  it("5-step self-compare returns presenceCounts: { both: 5, oursOnly: 0, ngspiceOnly: 0 }", async () => {
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: buildRcCircuit,
      analysis: "tran",
      tStop: 5e-6,
      maxStep: 1e-6,
    });
    const shape = session.getSessionShape();
    // In self-compare mode the ngspice side is a deep clone of ours-
    // every step must be "both"; asymmetric counts must be zero.
    expect(shape.presenceCounts.oursOnly).toBe(0);
    expect(shape.presenceCounts.ngspiceOnly).toBe(0);
    expect(shape.presenceCounts.both).toBeGreaterThanOrEqual(5);
  }, 30_000);

  it("self-compare getStepShape(0).stepStartTimeDelta is exactly 0 (Goal F mechanical proof)", async () => {
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: buildHwrCircuit,
      analysis: "dcop",
    });
    expect(session.getStepShape(0).stepStartTimeDelta).toBe(0);
  }, 30_000);

  it("truncated ourSession reports presence: ngspiceOnly for the missing tail", async () => {
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: buildRcCircuit,
      analysis: "tran",
      tStop: 3e-6,
      maxStep: 1e-6,
    });

    // Reach into internal state to truncate the ourSession steps,
    // simulating a divergence in step count (ours fewer than ngspice).
    const ourSteps: unknown[] = (session as any)._ourSession.steps;
    expect(ourSteps.length).toBeGreaterThanOrEqual(2);
    // Remove the last step from ours so ngspice has one more
    ourSteps.pop();
    // Invalidate cached comparisons so getStepShape re-reads live arrays
    (session as any)._comparisons = null;

    const shape = session.getSessionShape();
    // The final step (only on ngspice side) must be reported as ngspiceOnly
    const lastShape = shape.steps[shape.steps.length - 1];
    expect(lastShape.presence).toBe("ngspiceOnly");
    expect(shape.presenceCounts.ngspiceOnly).toBeGreaterThanOrEqual(1);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// getStepAtTime
// ---------------------------------------------------------------------------

describe("getStepAtTime", () => {
  it("returns 0 for t=0 on a session with boot step (0,0)", async () => {
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: buildHwrCircuit,
      analysis: "dcop",
    });
    expect(session.getStepAtTime(0)).toBe(0);
  }, 30_000);

  it("returns null for t > simTime", async () => {
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: buildRcCircuit,
      analysis: "tran",
      tStop: 1e-6,
    });
    expect(session.getStepAtTime(1e6)).toBeNull();
  }, 30_000);
});
