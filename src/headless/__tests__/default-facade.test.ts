/**
 * Tests for DefaultSimulatorFacade — Task 10.
 *
 * Covers:
 *  1. Build + compile + step + readOutput (AND gate)
 *  2. Clock advancement: step() advances clocks for D flip-flop
 *  3. clockAdvance: false skips clock advancement
 *  4. Fresh engine per compile (no state leakage)
 *  5. readAllSignals returns Record<string, number> not Map
 *  6. patch() returns PatchResult with { diagnostics, addedIds }
 */

import { describe, it, expect } from 'vitest';
import { DefaultSimulatorFacade } from '../default-facade.js';
import { createDefaultRegistry } from '../../components/register-all.js';

const registry = createDefaultRegistry();

// ---------------------------------------------------------------------------
// Helper: build a 2-input AND gate with labeled I/O
// ---------------------------------------------------------------------------

function buildAndGate(facade: DefaultSimulatorFacade) {
  return facade.build({
    components: [
      { id: 'A',    type: 'In',  props: { label: 'A', bitWidth: 1 } },
      { id: 'B',    type: 'In',  props: { label: 'B', bitWidth: 1 } },
      { id: 'gate', type: 'And' },
      { id: 'Y',    type: 'Out', props: { label: 'Y', bitWidth: 1 } },
    ],
    connections: [
      ['A:out', 'gate:In_1'],
      ['B:out', 'gate:In_2'],
      ['gate:out', 'Y:in'],
    ],
  });
}

// ---------------------------------------------------------------------------
// Helper: build a D flip-flop with Clock
// ---------------------------------------------------------------------------

function buildDFlipFlop(facade: DefaultSimulatorFacade) {
  return facade.build({
    components: [
      { id: 'clk', type: 'Clock', props: { label: 'CLK' } },
      { id: 'D',   type: 'In',   props: { label: 'D', bitWidth: 1 } },
      { id: 'ff',  type: 'D_FF' },
      { id: 'Q',   type: 'Out',  props: { label: 'Q', bitWidth: 1 } },
    ],
    connections: [
      ['clk:out', 'ff:C'],
      ['D:out',   'ff:D'],
      ['ff:Q',    'Q:in'],
    ],
  });
}

// ===========================================================================

describe('DefaultSimulatorFacade', () => {

  // -------------------------------------------------------------------------
  // Test 1: Build + compile + step + readOutput
  // -------------------------------------------------------------------------

  it('builds an AND gate, compiles, steps, and reads output', () => {
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = buildAndGate(facade);

    const engine = facade.compile(circuit);
    expect(facade.getEngine()).toBe(engine);

    // A=1, B=1 → Y should be 1 after propagation
    facade.setInput(engine, 'A', 1);
    facade.setInput(engine, 'B', 1);
    facade.step(engine);

    expect(facade.readOutput(engine, 'Y')).toBe(1);

    // A=1, B=0 → Y should be 0
    facade.setInput(engine, 'B', 0);
    facade.step(engine);

    expect(facade.readOutput(engine, 'Y')).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Test 2: Clock advancement — step() advances clocks
  // -------------------------------------------------------------------------

  it('advances clocks on step() so flip-flop latches D', () => {
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = buildDFlipFlop(facade);
    const engine = facade.compile(circuit);

    // D=1; step multiple times to allow clock edge to fire and latch
    facade.setInput(engine, 'D', 1);

    // Run enough steps to get at least one rising clock edge
    for (let i = 0; i < 4; i++) {
      facade.step(engine);
    }

    // After a rising edge with D=1, Q should be 1
    expect(facade.readOutput(engine, 'Q')).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Test 3: clockAdvance: false — clocks do NOT advance
  // -------------------------------------------------------------------------

  it('does not advance clocks when clockAdvance: false', () => {
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = buildDFlipFlop(facade);
    const engine = facade.compile(circuit);

    facade.setInput(engine, 'D', 1);

    // Run many steps without clock advancement — flip-flop should not latch
    for (let i = 0; i < 10; i++) {
      facade.step(engine, { clockAdvance: false });
    }

    // Without clock edges, Q remains 0 (initial state)
    expect(facade.readOutput(engine, 'Q')).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Test 4: Fresh engine per compile — no state leakage
  // -------------------------------------------------------------------------

  it('produces a fresh engine on each compile() with no state leakage', () => {
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = buildAndGate(facade);

    // First compile and mutate state
    const engine1 = facade.compile(circuit);
    facade.setInput(engine1, 'A', 1);
    facade.setInput(engine1, 'B', 1);
    facade.step(engine1);
    expect(facade.readOutput(engine1, 'Y')).toBe(1);

    // Second compile produces a new engine
    const engine2 = facade.compile(circuit);
    expect(engine2).not.toBe(engine1);

    // New engine starts in clean state (Y=0 before any steps)
    facade.step(engine2);
    expect(facade.readOutput(engine2, 'Y')).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Test 5: readAllSignals returns Record<string, number>
  // -------------------------------------------------------------------------

  it('readAllSignals returns a plain Record, not a Map', () => {
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = buildAndGate(facade);
    const engine = facade.compile(circuit);

    facade.setInput(engine, 'A', 1);
    facade.setInput(engine, 'B', 1);
    facade.step(engine);

    const signals = facade.readAllSignals(engine);

    // Must be a plain object, not a Map
    expect(signals).not.toBeInstanceOf(Map);
    expect(signals).not.toBeNull();

    // Must contain the labeled signals
    expect('A' in signals).toBe(true);
    expect('B' in signals).toBe(true);
    expect('Y' in signals).toBe(true);
    expect(signals['Y']).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Test 6: patch() returns PatchResult with { diagnostics, addedIds }
  // -------------------------------------------------------------------------

  it('patch() returns PatchResult with diagnostics and addedIds', () => {
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = buildAndGate(facade);

    const result = facade.patch(circuit, [
      {
        op: 'add',
        spec: { id: 'newGate', type: 'And' },
        // intentionally no connections — leaves And inputs unconnected
      },
    ]);

    // Result must have diagnostics array and addedIds record
    expect(result).toHaveProperty('diagnostics');
    expect(result).toHaveProperty('addedIds');
    expect(Array.isArray(result.diagnostics)).toBe(true);
    expect(result.addedIds).not.toBeNull();
    expect(result.addedIds).not.toBeInstanceOf(Map);

    // The added And gate with unconnected inputs produces unconnected-input diagnostics
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain('unconnected-input');

    // The added component should appear in addedIds
    expect('newGate' in result.addedIds).toBe(true);
    expect(typeof result.addedIds['newGate']).toBe('string');
  });

  // -------------------------------------------------------------------------
  // G1: Analog dispatch — facade routes analog circuits to MNA engine
  // -------------------------------------------------------------------------

  it('routes analog circuits to analog engine and populates getCompiledAnalog()', () => {
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = buildAndGate(facade);
    circuit.metadata.engineType = 'analog';

    const engine = facade.compile(circuit);

    expect(facade.getEngine()).toBe(engine);
    // getCompiledAnalog() is populated for analog circuits
    expect(facade.getCompiledAnalog()).not.toBeNull();
    // getCompiled() is null for analog circuits (digital-only field)
    expect(facade.getCompiled()).toBeNull();
  });

  // -------------------------------------------------------------------------
  // G2: Engine dispose-on-recompile
  // -------------------------------------------------------------------------

  it('replaces and disposes the engine on recompile', () => {
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = buildAndGate(facade);

    const engine1 = facade.compile(circuit);
    expect(facade.getEngine()).toBe(engine1);

    const engine2 = facade.compile(circuit);
    expect(facade.getEngine()).toBe(engine2);
    expect(engine2).not.toBe(engine1);
  });

});
