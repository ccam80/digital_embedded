/**
 * Tests for coordinator bridge logic (Task 1.7).
 *
 * Verifies that DefaultSimulationCoordinator uses BridgeOutputAdapter and
 * BridgeInputAdapter from compiledAnalog.bridgeAdaptersByGroupId instead of
 * inline voltage read/write logic.
 *
 * §4-compliant: every test reaches the bridge adapter through a fully
 * compiled & warm-started fixture (`buildFixture`). Adapter-only property
 * checks (`rOut`, threshold reads, hot-load setParam) call methods that are
 * pure reads with no engine-state side effects, so they remain
 * adapter-direct. Anything that touches MNA stamping / RHS values is
 * observed at the engine boundary by stepping the real coordinator and
 * reading node voltages.
 */

import { describe, it, expect, vi } from "vitest";
import type { BridgeOutputAdapter, BridgeInputAdapter } from "../analog/bridge-adapter.js";
import type { ConcreteCompiledAnalogCircuit } from "../analog/compiled-analog-circuit.js";
import { buildFixture } from "../analog/__tests__/fixtures/build-fixture.js";
import type { Fixture } from "../analog/__tests__/fixtures/build-fixture.js";
import { BitVector } from "../../core/signal.js";

// ---------------------------------------------------------------------------
// Real digital→analog bridge fixture
// ---------------------------------------------------------------------------
//
// Topology:
//
//   In(A) ──out──► Rload(50Ω) ──► node_X ──► Rpull(1MΩ) ──► Ground
//
// The `In` component has only a digital model; the `Rload` resistor has only
// an analog model. The wire between `A:out` and `Rload:pos` therefore
// produces a real cross-domain boundary group, which the unified compiler
// turns into a `BridgeOutputAdapter` (digital→analog direction).
//
// `Rpull = 1MΩ` to ground gives every test an *observable* analog node
// voltage at `Rload:neg`:
//
//   * Driven HIGH:  V(node_X) ≈ vOH · Rpull / (rOut + Rload + Rpull) ≈ vOH
//                   (rOut + Rload ≪ Rpull, so the divider barely loads it)
//   * Driven LOW:   V(node_X) ≈ 0 V
//   * Hi-Z:         V(node_X) ≈ 0 V (only the pull-down to ground; the
//                   bridge contributes no current)
//
// The contrast between driven-HIGH (≈ vOH) and Hi-Z (≈ 0 V) is the
// observable proof that `setHighZ(true)` disables the bridge's current
// contribution at the engine surface — without ever calling
// `outputAdapter.setup()` or `outputAdapter.load()` directly.

interface BridgeFixture {
  readonly fix: Fixture;
  readonly outputAdapter: BridgeOutputAdapter;
  readonly inputAdapter: BridgeInputAdapter | undefined;
  readonly nodeXId: number;
  readonly inputNetId: number;
  readonly bitWidth: number;
}

/**
 * Build a real mixed-signal fixture and return the (single) bridge adapter
 * the unified compiler produced. Used by every digital→analog test below.
 */
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
  expect(compiled.bridges.length).toBeGreaterThan(0);
  const bridge = compiled.bridges.find(b => b.direction === 'digital-to-analog');
  if (bridge === undefined) {
    throw new Error('buildOutputBridgeFixture: no digital-to-analog bridge produced');
  }

  const compiledAnalog = compiled.analog as ConcreteCompiledAnalogCircuit;
  const adapters = compiledAnalog.bridgeAdaptersByGroupId.get(bridge.boundaryGroupId);
  if (adapters === undefined) {
    throw new Error(`buildOutputBridgeFixture: no adapters for group ${bridge.boundaryGroupId}`);
  }
  const outputAdapter = adapters.find(
    (a): a is BridgeOutputAdapter => 'setLogicLevel' in a,
  );
  if (outputAdapter === undefined) {
    throw new Error('buildOutputBridgeFixture: bridge has no BridgeOutputAdapter');
  }
  const inputAdapter = adapters.find(
    (a): a is BridgeInputAdapter => 'readLogicLevel' in a,
  );

  // node_X = analog side of the bridge = `Rload:pos`. We assert via
  // `Rload:neg` (the same net under DCOP because the path from Rload:pos to
  // node_X is just the resistor; with Rpull=1MΩ ≫ Rload=50Ω the divider
  // makes V(Rload:neg) within 50 ppm of V(Rload:pos) when driven HIGH).
  // We read the bridge's own analog node directly via getAnalogNodeVoltage.

  return {
    fix,
    outputAdapter,
    inputAdapter,
    nodeXId: bridge.analogNodeId,
    inputNetId: bridge.digitalNetId,
    bitWidth: bridge.bitWidth,
  };
}

/**
 * Step the coordinator until the analog node voltage at `nodeId` settles to
 * within `tol` of itself across two consecutive steps, or `maxSteps` runs
 * out. Returns the final voltage. Centralises the warm-start advance so
 * each test reads a steady-state value rather than a transient sample.
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

// ---------------------------------------------------------------------------
// Test 1: digital output drives analog node via bridge adapter
// ---------------------------------------------------------------------------

describe('bridge adapter: digital output drives analog node', () => {
  it('outputAdapter rOut matches CMOS spec (drive impedance for vOH)', () => {
    const { outputAdapter, fix } = buildOutputBridgeFixture();
    // Default CMOS family rOut = 50Ω (set in src/core/pin-electrical.ts).
    expect(outputAdapter.rOut).toBe(50);
    fix.coordinator.dispose();
  });

  it('outputAdapter outputNodeId matches the bridge descriptor analogNodeId', () => {
    const { outputAdapter, nodeXId, fix } = buildOutputBridgeFixture();
    expect(outputAdapter.outputNodeId).toBe(nodeXId);
    fix.coordinator.dispose();
  });

  it('outputAdapter in bridgeAdaptersByGroupId is the exact same instance the coordinator resolved', () => {
    const { fix, outputAdapter } = buildOutputBridgeFixture();
    const compiled = fix.coordinator.compiled;
    const bridge = compiled.bridges.find(b => b.direction === 'digital-to-analog')!;
    const compiledAnalog = compiled.analog as ConcreteCompiledAnalogCircuit;
    const adapters = compiledAnalog.bridgeAdaptersByGroupId.get(bridge.boundaryGroupId)!;
    const found = adapters.find((a): a is BridgeOutputAdapter => 'setLogicLevel' in a);
    expect(found).toBe(outputAdapter);
    fix.coordinator.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 2: analog→digital threshold semantics live on the input adapter
// ---------------------------------------------------------------------------
//
// These are pure-read property tests on the adapter API, with no
// engine-state side effects. To exercise the analog→digital direction we
// hand-build a one-off fixture inline (Resistor divider drives an `Out`
// pin, which has only a digital model — that wire becomes the boundary).

function buildInputBridgeFixture(): {
  fix: Fixture;
  inputAdapter: BridgeInputAdapter;
} {
  const fix = buildFixture({
    build: (_registry, facade) => facade.build({
      components: [
        { id: 'vs',  type: 'DcVoltageSource', props: { label: 'VS', voltage: 3.3 } },
        { id: 'r',   type: 'Resistor',        props: { label: 'R', resistance: 1000 } },
        { id: 'Y',   type: 'Out',             props: { label: 'Y', bitWidth: 1 } },
        { id: 'gnd', type: 'Ground' },
      ],
      connections: [
        ['vs:pos', 'r:pos'],
        ['r:neg',  'Y:in'],   // analog→digital boundary
        ['vs:neg', 'gnd:out'],
      ],
    }),
  });
  const compiled = fix.coordinator.compiled;
  const bridge = compiled.bridges.find(b => b.direction === 'analog-to-digital');
  if (bridge === undefined) {
    throw new Error('buildInputBridgeFixture: no analog-to-digital bridge produced');
  }
  const compiledAnalog = compiled.analog as ConcreteCompiledAnalogCircuit;
  const adapters = compiledAnalog.bridgeAdaptersByGroupId.get(bridge.boundaryGroupId)!;
  const inputAdapter = adapters.find((a): a is BridgeInputAdapter => 'readLogicLevel' in a);
  if (inputAdapter === undefined) {
    throw new Error('buildInputBridgeFixture: bridge has no BridgeInputAdapter');
  }
  return { fix, inputAdapter };
}

describe('bridge adapter: analog voltage thresholds to digital via inputAdapter', () => {
  it('voltage above vIH → readLogicLevel returns true (logic 1)', () => {
    const { inputAdapter, fix } = buildInputBridgeFixture();
    // Default CMOS vIH = 2.0V (src/core/pin-electrical.ts).
    expect(inputAdapter.readLogicLevel(2.5)).toBe(true);
    fix.coordinator.dispose();
  });

  it('voltage below vIL → readLogicLevel returns false (logic 0)', () => {
    const { inputAdapter, fix } = buildInputBridgeFixture();
    // Default CMOS vIL = 0.8V.
    expect(inputAdapter.readLogicLevel(0.5)).toBe(false);
    fix.coordinator.dispose();
  });

  it('voltage in indeterminate band → readLogicLevel returns undefined', () => {
    const { inputAdapter, fix } = buildInputBridgeFixture();
    expect(inputAdapter.readLogicLevel(1.4)).toBeUndefined();
    fix.coordinator.dispose();
  });

  it('inputAdapter in bridgeAdaptersByGroupId is the exact same instance the coordinator resolved', () => {
    const { fix, inputAdapter } = buildInputBridgeFixture();
    const compiled = fix.coordinator.compiled;
    const bridge = compiled.bridges.find(b => b.direction === 'analog-to-digital')!;
    const compiledAnalog = compiled.analog as ConcreteCompiledAnalogCircuit;
    const adapters = compiledAnalog.bridgeAdaptersByGroupId.get(bridge.boundaryGroupId)!;
    const found = adapters.find((a): a is BridgeInputAdapter => 'readLogicLevel' in a);
    expect(found).toBe(inputAdapter);
    fix.coordinator.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 3: setParam updates electrical parameters
// ---------------------------------------------------------------------------

describe('bridge adapter: setParam updates electrical parameters', () => {
  it('setParam("rOut", newValue) changes rOut on outputAdapter', () => {
    const { outputAdapter, fix } = buildOutputBridgeFixture();
    const before = outputAdapter.rOut;
    outputAdapter.setParam('rOut', 100);
    expect(outputAdapter.rOut).toBe(100);
    expect(outputAdapter.rOut).not.toBe(before);
    fix.coordinator.dispose();
  });

  it('setParam("rIn", newValue) changes rIn on inputAdapter', () => {
    const { inputAdapter, fix } = buildInputBridgeFixture();
    const before = inputAdapter.rIn;
    inputAdapter.setParam('rIn', 5e6);
    expect(inputAdapter.rIn).toBe(5e6);
    expect(inputAdapter.rIn).not.toBe(before);
    fix.coordinator.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 4: hi-Z output stops driving analog node
//
// These are the §4-compliant rewrites of the deleted direct-`.load()` /
// direct-`.setup()` engine-impersonator tests. The driven-HIGH vs Hi-Z
// contrast is observed at the engine boundary — `analog.getNodeVoltage()`
// after stepping the real coordinator to steady state.
// ---------------------------------------------------------------------------

describe('bridge adapter: hi-Z output stops driving analog node', () => {
  it('setHighZ(true) collapses analog node voltage from ~vOH to ~0V (vs driven HIGH)', () => {
    const f = buildOutputBridgeFixture();

    // 1. Driven HIGH baseline: digital `A` = 1, hi-Z = false.
    f.fix.coordinator.writeByLabel('A', { type: 'digital', value: 1 });
    f.outputAdapter.setHighZ(false);
    const vDrivenHigh = stepToSteadyState(f.fix, f.nodeXId);

    // CMOS vOH = 3.3V; the resistor divider rOut=50Ω, Rload=50Ω, Rpull=1MΩ
    // so V(node_X) = vOH · 1e6 / (50 + 50 + 1e6) ≈ 3.2997 V.
    expect(vDrivenHigh).toBeGreaterThan(3.0);
    expect(vDrivenHigh).toBeLessThanOrEqual(3.3);

    // 2. Switch to Hi-Z: bridge contributes no current; only Rpull → GND.
    f.outputAdapter.setHighZ(true);
    const vHiZ = stepToSteadyState(f.fix, f.nodeXId);

    // The pull-down to ground dominates → V(node_X) ≈ 0 V.
    expect(Math.abs(vHiZ)).toBeLessThan(1e-3);

    // The contrast is the observable proof that hi-Z disables the bridge.
    expect(vDrivenHigh - vHiZ).toBeGreaterThan(2.0);

    f.fix.coordinator.dispose();
  });

  it('setHighZ(true) holds analog node at ~0V regardless of digital signal level', () => {
    const f = buildOutputBridgeFixture();

    // Lock the bridge into hi-Z first.
    f.outputAdapter.setHighZ(true);

    // Drive digital signal LOW and step to steady state.
    f.fix.coordinator.writeByLabel('A', { type: 'digital', value: 0 });
    const vLowHiZ = stepToSteadyState(f.fix, f.nodeXId);
    expect(Math.abs(vLowHiZ)).toBeLessThan(1e-3);

    // Now drive digital signal HIGH — hi-Z must still suppress the drive.
    f.fix.coordinator.writeByLabel('A', { type: 'digital', value: 1 });
    const vHighHiZ = stepToSteadyState(f.fix, f.nodeXId);
    expect(Math.abs(vHighHiZ)).toBeLessThan(1e-3);

    f.fix.coordinator.dispose();
  });

  it('after setHighZ(true), rOut is unchanged (hi-z uses rHiZ from spec internally)', () => {
    const { outputAdapter, fix } = buildOutputBridgeFixture();
    const rOutBefore = outputAdapter.rOut;
    outputAdapter.setHighZ(true);
    expect(outputAdapter.rOut).toBe(rOutBefore);
    fix.coordinator.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 5: digital→analog edge transitions post analog breakpoints
// ---------------------------------------------------------------------------

/**
 * Regression guard: when a digital→analog bridge sees a logic-level transition,
 * `_stepMixed` must call `analog.addBreakpoint(simTime)` so the next analog
 * step lands on the discontinuity (CKTorder=1 + dt clamp). Without this,
 * trapezoidal integration smears the gate edge across whatever dt the
 * controller had picked, producing parasitic ringing on inductor currents in
 * switching converters. Mirrors the CKTsetBreak pattern used by every analog
 * source (pulse, clock, pwl).
 */
describe('coordinator: digital→analog bridge edges register analog breakpoints', () => {
  it('posts addBreakpoint on logic level transition, no duplicate on steady-state', () => {
    const f = buildOutputBridgeFixture();
    const analog = f.fix.coordinator.getAnalogEngine()!;
    const digital = f.fix.coordinator.getDigitalEngine()!;
    const spy = vi.spyOn(analog, 'addBreakpoint');

    // First step: digital signal is 0, prevDaHigh starts false → no transition.
    f.fix.coordinator.step();
    const afterSteadyLow = spy.mock.calls.length;

    // Drive digital signal high → next _stepMixed must post a breakpoint.
    digital.setSignalValue(f.inputNetId, BitVector.fromNumber(1, f.bitWidth));
    f.fix.coordinator.step();
    const afterRisingEdge = spy.mock.calls.length;
    expect(afterRisingEdge).toBeGreaterThan(afterSteadyLow);

    // Hold high → no further breakpoint.
    digital.setSignalValue(f.inputNetId, BitVector.fromNumber(1, f.bitWidth));
    f.fix.coordinator.step();
    expect(spy.mock.calls.length).toBe(afterRisingEdge);

    // Drive low → falling edge posts another breakpoint.
    digital.setSignalValue(f.inputNetId, BitVector.fromNumber(0, f.bitWidth));
    f.fix.coordinator.step();
    expect(spy.mock.calls.length).toBeGreaterThan(afterRisingEdge);

    f.fix.coordinator.dispose();
  });

  it('reset() clears prevDaHigh so the next high level re-posts a breakpoint', () => {
    const f = buildOutputBridgeFixture();
    const analog = f.fix.coordinator.getAnalogEngine()!;
    const digital = f.fix.coordinator.getDigitalEngine()!;

    // Drive high once so prevDaHigh latches true.
    digital.setSignalValue(f.inputNetId, BitVector.fromNumber(1, f.bitWidth));
    f.fix.coordinator.step();

    f.fix.coordinator.reset();
    const spy = vi.spyOn(analog, 'addBreakpoint');

    // After reset, prevDaHigh is false. Driving high again must post a breakpoint.
    digital.setSignalValue(f.inputNetId, BitVector.fromNumber(1, f.bitWidth));
    f.fix.coordinator.step();
    expect(spy.mock.calls.length).toBeGreaterThan(0);

    f.fix.coordinator.dispose();
  });
});
