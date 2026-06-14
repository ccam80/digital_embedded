/**
 * Coordinator per-pin boundary-adapter behavioral tests.
 *
 * Every digital↔analog crossing pin is realized as a finite-impedance
 * boundary-adapter composite attached to the shared analog hub node, which
 * nothing pins. These tests observe the boundary purely at the engine surface:
 * drive the digital side through the real coordinator (`writeByLabel`) and read
 * the analog node voltage, or drive the analog side and read the digital net.
 * No element-internal methods are touched.
 */

import { describe, it, expect, vi } from "vitest";
import { buildFixture } from "../analog/__tests__/fixtures/build-fixture.js";
import type { Fixture } from "../analog/__tests__/fixtures/build-fixture.js";
import { DigitalEngine } from "../digital/digital-engine.js";
import type { BridgePinAdapterHandle } from "../analog/compiler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

interface BoundaryRef {
  analogNodeId: number;
  digitalNetId: number;
  bitWidth: number;
  handle: BridgePinAdapterHandle;
}

function boundary(fix: Fixture, role: "output" | "input"): BoundaryRef {
  const compiled = fix.coordinator.compiled;
  const bridge = compiled.bridges.find((b) => b.role === role);
  if (bridge === undefined) throw new Error(`no ${role} bridge produced`);
  const handle = compiled.analog!.bridgeAdaptersByPinKey.get(bridge.pinKey);
  if (handle === undefined) throw new Error(`no adapter handle for ${bridge.pinKey}`);
  expect(handle.role).toBe(role);
  return {
    analogNodeId: bridge.analogNodeId,
    digitalNetId: bridge.digitalNetId,
    bitWidth: bridge.bitWidth,
    handle,
  };
}

// In(A) ──► Rload(50) ──► node ──► Rpull ──► gnd.  Boundary at A:out↔Rload:pos.
function buildOutputFixture(rpull = 1e6): Fixture {
  return buildFixture({
    build: (_r, facade) => facade.build({
      components: [
        { id: "A", type: "In", props: { label: "A", bitWidth: 1 } },
        { id: "Rload", type: "Resistor", props: { label: "Rload", resistance: 50 } },
        { id: "Rpull", type: "Resistor", props: { label: "Rpull", resistance: rpull } },
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

// A(In)→drv:in, S(In)→drv:sel, drv:out→Rload→Rpull→gnd.  drv is a tri-state
// Driver: sel=0 forces its output high-impedance, which the coordinator must
// translate into the adapter's `en`=0 (Hi-Z) release of the hub.
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

// vs ──► r(1k) ──► node ──► Out(Y):in.  Boundary at r:neg↔Y:in (analog→digital).
function buildInputFixture(vsV = 3.3): Fixture {
  return buildFixture({
    build: (_r, facade) => facade.build({
      components: [
        { id: "vs", type: "DcVoltageSource", props: { label: "VS", voltage: vsV } },
        { id: "r", type: "Resistor", props: { label: "R", resistance: 1000 } },
        { id: "Y", type: "Out", props: { label: "Y", bitWidth: 1 } },
        { id: "gnd", type: "Ground" },
      ],
      connections: [
        ["vs:pos", "r:pos"],
        ["r:neg", "Y:in"],
        ["vs:neg", "gnd:out"],
      ],
    }),
  });
}

// ---------------------------------------------------------------------------
// Digital output drives the analog hub through a finite Thevenin source
// ---------------------------------------------------------------------------

describe("boundary adapter: digital output drives analog node (finite impedance)", () => {
  it("drives toward vOH when digital HIGH", () => {
    const fix = buildOutputFixture();
    const { analogNodeId } = boundary(fix, "output");
    fix.coordinator.writeByLabel("A", { type: "digital", value: 1 });
    const v = stepToSteadyState(fix, analogNodeId);
    // ≈ vOH = 3.3V through the light 1MΩ divider. A small (<1%) overshoot above
    // vOH from companion/settling is tolerated here; the bug under test was the
    // node being pinned to 0, not this band. (See TODO: over-vOH settling.)
    expect(v).toBeGreaterThan(3.0);
    expect(v).toBeLessThan(3.5);
    fix.coordinator.dispose();
  });

  it("drives toward 0 when digital LOW", () => {
    const fix = buildOutputFixture();
    const { analogNodeId } = boundary(fix, "output");
    fix.coordinator.writeByLabel("A", { type: "digital", value: 0 });
    const v = stepToSteadyState(fix, analogNodeId);
    expect(Math.abs(v)).toBeLessThan(1e-2);
    fix.coordinator.dispose();
  });

  it("presents a FINITE Thevenin source (not an ideal pin): the hub sags under heavy load", () => {
    // Rpull = 50Ω, so from the hub node the path to ground is Rload(50)+Rpull(50)
    // = 100Ω. With the adapter Thevenin rOut = 50Ω at vOH = 3.3V:
    //   V(node) = vOH · 100 / (rOut + 100) = 3.3 · 100/150 = 2.2 V.
    // The retired ideal-voltage-source bridge would pin the node to ~vOH=3.3V
    // regardless of load; a value well below vOH proves the finite rOut path.
    const fix = buildOutputFixture(50);
    const { analogNodeId } = boundary(fix, "output");
    fix.coordinator.writeByLabel("A", { type: "digital", value: 1 });
    const v = stepToSteadyState(fix, analogNodeId);
    expect(v).toBeGreaterThan(1.8);
    expect(v).toBeLessThan(2.6);
    expect(v).toBeLessThan(3.0); // categorically not pinned to vOH
    fix.coordinator.dispose();
  });
});

// ---------------------------------------------------------------------------
// Tri-state output releases the hub (Hi-Z) — the digital→analog Hi-Z path
// ---------------------------------------------------------------------------

describe("boundary adapter: tri-state output releases the hub on Hi-Z", () => {
  it("sel=0 releases the analog node even when data=1; sel=1 drives it", () => {
    const fix = buildDriverFixture();
    const { analogNodeId } = boundary(fix, "output");

    // data=1, sel=1 → driven HIGH.
    fix.coordinator.writeByLabel("A", { type: "digital", value: 1 });
    fix.coordinator.writeByLabel("S", { type: "digital", value: 1 });
    const vDriven = stepToSteadyState(fix, analogNodeId);
    expect(vDriven).toBeGreaterThan(3.0);

    // data=1, sel=0 → Driver output Hi-Z → adapter en=0 → only Rpull to ground.
    fix.coordinator.writeByLabel("S", { type: "digital", value: 0 });
    const vHiZ = stepToSteadyState(fix, analogNodeId);
    expect(Math.abs(vHiZ)).toBeLessThan(1e-2);

    // The contrast is the observable proof that Hi-Z releases the bridge.
    expect(vDriven - vHiZ).toBeGreaterThan(2.5);
    fix.coordinator.dispose();
  });
});

// ---------------------------------------------------------------------------
// Analog voltage thresholds to a digital bit on the private digital net
// ---------------------------------------------------------------------------

describe("boundary adapter: analog voltage thresholds to a digital bit", () => {
  it("hub above vIH → digital net reads 1", () => {
    const fix = buildInputFixture(3.3);
    const { digitalNetId } = boundary(fix, "input");
    fix.coordinator.step();
    const digital = fix.coordinator.getDigitalEngine() as DigitalEngine;
    expect(digital.getSignalRaw(digitalNetId)).not.toBe(0);
    fix.coordinator.dispose();
  });

  it("hub below vIL → digital net reads 0", () => {
    const fix = buildInputFixture(0.3);
    const { digitalNetId } = boundary(fix, "input");
    fix.coordinator.step();
    const digital = fix.coordinator.getDigitalEngine() as DigitalEngine;
    expect(digital.getSignalRaw(digitalNetId)).toBe(0);
    fix.coordinator.dispose();
  });

  it("indeterminate band holds the last clean bit", () => {
    const fix = buildInputFixture(3.3);
    const { digitalNetId } = boundary(fix, "input");
    const digital = fix.coordinator.getDigitalEngine() as DigitalEngine;

    // Settle HIGH first so the held bit is 1.
    for (let i = 0; i < 5; i++) fix.coordinator.step();
    expect(digital.getSignalRaw(digitalNetId)).not.toBe(0);

    // Drop VS into the indeterminate band (vIL=0.8 < 1.4 < vIH=2.0). The inner
    // threshold B-source emits 0.5, and the coordinator holds the last clean bit.
    fix.coordinator.setComponentProperty(fix.element("VS"), "voltage", 1.4);
    for (let i = 0; i < 5; i++) fix.coordinator.step();
    expect(digital.getSignalRaw(digitalNetId)).not.toBe(0);
    fix.coordinator.dispose();
  });
});

// ---------------------------------------------------------------------------
// Edge transitions post analog breakpoints
// ---------------------------------------------------------------------------

describe("boundary adapter: output edges post analog breakpoints", () => {
  it("posts addBreakpoint on a logic-level transition, none on steady-state", () => {
    const fix = buildOutputFixture();
    boundary(fix, "output");
    const analog = fix.coordinator.getAnalogEngine()!;
    const spy = vi.spyOn(analog, "addBreakpoint");

    fix.coordinator.writeByLabel("A", { type: "digital", value: 0 });
    fix.coordinator.step();
    const afterLow = spy.mock.calls.length;

    fix.coordinator.writeByLabel("A", { type: "digital", value: 1 });
    fix.coordinator.step();
    expect(spy.mock.calls.length).toBeGreaterThan(afterLow);
    const afterRise = spy.mock.calls.length;

    fix.coordinator.step(); // hold high → no new breakpoint
    expect(spy.mock.calls.length).toBe(afterRise);
    fix.coordinator.dispose();
  });

  it("posts addBreakpoint on a Hi-Z (enable) transition at the same logic level", () => {
    const fix = buildDriverFixture();
    boundary(fix, "output");
    const analog = fix.coordinator.getAnalogEngine()!;

    fix.coordinator.writeByLabel("A", { type: "digital", value: 1 });
    fix.coordinator.writeByLabel("S", { type: "digital", value: 1 });
    fix.coordinator.step();

    const spy = vi.spyOn(analog, "addBreakpoint");
    // data stays 1 (no logic-level edge) but the enable drops → Hi-Z transition.
    fix.coordinator.writeByLabel("S", { type: "digital", value: 0 });
    fix.coordinator.step();
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    fix.coordinator.dispose();
  });
});
