/**
 * Mid-simulation hot-load test for the bridge output adapter.
 *
 * Verifies that calling `setParam("vOH", 5.0)` on a `BridgeOutputDriverElement`
 * mid-simulation causes the analog node voltage target to change to the new
 * vOH on the next stamp cycle, and that hot-loading vOH does not affect the
 * vOL drive when the output is logic LOW.
 *
 * §4-compliant: every assertion is observed at the engine boundary by
 * stepping the real coordinator and reading node voltages. Topology mirrors
 * the canonical `coordinator-bridge.test.ts` fixture:
 *
 *   In(A) ──out──► Rload(50Ω) ──► node_X ──► Rpull(1MΩ) ──► Ground
 *
 * With Rpull = 1MΩ the resistive divider barely loads the bridge:
 *
 *   V(node_X) ≈ vOH · Rpull / (rOut + Rload + Rpull)
 *             = vOH · 1e6 / (50 + 50 + 1e6)
 *             ≈ vOH · 0.9999
 *
 * so a driven HIGH at vOH=3.3 settles to ~3.2997 V, and at vOH=5.0 to
 * ~4.9995 V. Driven LOW settles to ~0 V independent of vOH.
 */

import { describe, it, expect } from "vitest";
import type { BridgeOutputDriverElement } from "../analog/behavioral-drivers/bridge-output-driver.js";
import { buildFixture } from "../analog/__tests__/fixtures/build-fixture.js";
import type { Fixture } from "../analog/__tests__/fixtures/build-fixture.js";

// ---------------------------------------------------------------------------
// Real digital→analog bridge fixture (mirrors coordinator-bridge.test.ts).
// Self-contained: no cross-test-file imports.
// ---------------------------------------------------------------------------

interface BridgeFixture {
  readonly fix: Fixture;
  readonly outputAdapter: BridgeOutputDriverElement;
  readonly nodeXId: number;
}

function buildOutputBridgeFixture(): BridgeFixture {
  const fix = buildFixture({
    build: (_registry, facade) => facade.build({
      components: [
        { id: 'A',     type: 'In',       props: { label: 'A', bitWidth: 1 } },
        { id: 'Rload', type: 'Resistor', props: { label: 'Rload', resistance: 50 } },
        { id: 'Rpull', type: 'Resistor', props: { label: 'Rpull', resistance: 1e6 } },
        { id: 'gnd',   type: 'Ground' },
      ],
      connections: [
        ['A:out',     'Rload:pos'],   // digital→analog boundary
        ['Rload:neg', 'Rpull:pos'],
        ['Rpull:neg', 'gnd:out'],
      ],
    }),
  });

  const compiled = fix.coordinator.compiled;
  const bridge = compiled.bridges.find(b => b.direction === 'digital-to-analog');
  if (bridge === undefined) {
    throw new Error('buildOutputBridgeFixture: no digital-to-analog bridge produced');
  }

  const adapters = compiled.analog!.bridgeAdaptersByGroupId.get(bridge.boundaryGroupId);
  if (adapters === undefined) {
    throw new Error(`buildOutputBridgeFixture: no adapters for group ${bridge.boundaryGroupId}`);
  }
  const outputAdapter = adapters.find(
    (a): a is BridgeOutputDriverElement => 'setLogicLevel' in a,
  );
  if (outputAdapter === undefined) {
    throw new Error('buildOutputBridgeFixture: bridge has no BridgeOutputDriverElement');
  }

  return {
    fix,
    outputAdapter,
    nodeXId: bridge.analogNodeId,
  };
}

/**
 * Step the coordinator until the analog node voltage at `nodeId` settles to
 * within `tol` of itself across two consecutive steps, or `maxSteps` runs
 * out. Returns the final voltage.
 */
function stepToSteadyState(
  fix: Fixture,
  nodeId: number,
  maxSteps = 200,
  tol = 1e-6,
): number {
  const analog = fix.coordinator.getAnalogEngine();
  if (analog === null) throw new Error('stepToSteadyState: no analog engine');
  let prev = analog.getNodeVoltage(nodeId);
  for (let i = 0; i < maxSteps; i++) {
    fix.coordinator.step();
    const cur = analog.getNodeVoltage(nodeId);
    if (Math.abs(cur - prev) < tol) return cur;
    prev = cur;
  }
  return prev;
}

/** Divider target: V(node_X) = vOH · Rpull / (rOut + Rload + Rpull). */
function dividerTarget(vOH: number): number {
  const rOut = 50;
  const Rload = 50;
  const Rpull = 1e6;
  return vOH * Rpull / (rOut + Rload + Rpull);
}

// ---------------------------------------------------------------------------
// Hot-load vOH mid-simulation
// ---------------------------------------------------------------------------

describe('bridge adapter: hot-load vOH mid-simulation', () => {
  it('setParam("vOH", 5.0) after steady-state HIGH causes analog node target to change to ~5.0', () => {
    const { fix, outputAdapter, nodeXId } = buildOutputBridgeFixture();

    // Drive HIGH and step to steady state with default vOH = 3.3.
    fix.coordinator.writeByLabel('A', { type: 'digital', value: 1 });
    outputAdapter.setLogicLevel(true);
    const vBefore = stepToSteadyState(fix, nodeXId);

    const vTargetBefore = dividerTarget(3.3); // ≈ 3.2997
    expect(vBefore).toBeGreaterThan(vTargetBefore - 1e-3);
    expect(vBefore).toBeLessThan(vTargetBefore + 1e-3);

    // Hot-load: update vOH to 5.0 mid-simulation.
    outputAdapter.setParam('vOH', 5.0);

    // Step again — the next load() must restamp using the new vOH.
    const vAfter = stepToSteadyState(fix, nodeXId);

    const vTargetAfter = dividerTarget(5.0); // ≈ 4.9995
    expect(vAfter).toBeGreaterThan(vTargetAfter - 1e-3);
    expect(vAfter).toBeLessThan(vTargetAfter + 1e-3);

    // The hot-load must have moved the node voltage by ~1.7 V.
    expect(vAfter - vBefore).toBeGreaterThan(1.5);

    fix.coordinator.dispose();
  });

  it('setParam("vOH", 5.0) does not affect vOL drive (logic low still drives ~0V)', () => {
    const { fix, outputAdapter, nodeXId } = buildOutputBridgeFixture();

    // Drive LOW and step to steady state.
    fix.coordinator.writeByLabel('A', { type: 'digital', value: 0 });
    outputAdapter.setLogicLevel(false);
    const vLowBefore = stepToSteadyState(fix, nodeXId);
    expect(Math.abs(vLowBefore)).toBeLessThan(1e-3);

    // Hot-load vOH — must not affect a logic-LOW drive (vOL is unchanged).
    outputAdapter.setParam('vOH', 5.0);
    const vLowAfter = stepToSteadyState(fix, nodeXId);
    expect(Math.abs(vLowAfter)).toBeLessThan(1e-3);

    fix.coordinator.dispose();
  });

  it('setParam("vOH", 5.0) then switch to HIGH drives ~5.0', () => {
    const { fix, outputAdapter, nodeXId } = buildOutputBridgeFixture();

    // Start LOW, reach steady state at ~0 V.
    fix.coordinator.writeByLabel('A', { type: 'digital', value: 0 });
    outputAdapter.setLogicLevel(false);
    const vLow = stepToSteadyState(fix, nodeXId);
    expect(Math.abs(vLow)).toBeLessThan(1e-3);

    // Hot-load new vOH while still LOW.
    outputAdapter.setParam('vOH', 5.0);

    // Now switch to HIGH — the analog node target must be the *new* vOH = 5.0.
    fix.coordinator.writeByLabel('A', { type: 'digital', value: 1 });
    outputAdapter.setLogicLevel(true);
    const vHigh = stepToSteadyState(fix, nodeXId);

    const vTarget = dividerTarget(5.0); // ≈ 4.9995
    expect(vHigh).toBeGreaterThan(vTarget - 1e-3);
    expect(vHigh).toBeLessThan(vTarget + 1e-3);

    // Confirm we moved well past the original vOH = 3.3 ceiling.
    expect(vHigh).toBeGreaterThan(3.3 + 0.5);

    fix.coordinator.dispose();
  });
});
