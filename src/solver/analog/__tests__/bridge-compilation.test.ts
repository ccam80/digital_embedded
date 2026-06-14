/**
 * Per-pin boundary-adapter compilation tests.
 *
 * Verifies that the unified compiler synthesizes one finite-impedance
 * boundary-adapter composite per crossing digital pin, exposes it via
 * `bridgeAdaptersByPinKey` (keyed by the crossing pin's stable pinKey), and
 * that the expanded composite wrapper participates in the analog elements
 * array. Uses real compiled circuits (the synthesis binds each adapter's
 * `node` port to the shared analog hub by world-position, so synthetic
 * empty-pin partitions are not a valid construction path anymore).
 */

import { describe, it, expect } from 'vitest';
import { buildFixture } from './fixtures/build-fixture.js';
import type { Fixture } from './fixtures/build-fixture.js';

// In(A):out ──► Rload ──► Rpull ──► gnd.  One digital OUTPUT crossing.
function buildOutput(): Fixture {
  return buildFixture({
    build: (_r, facade) => facade.build({
      components: [
        { id: 'A', type: 'In', props: { label: 'A', bitWidth: 1 } },
        { id: 'Rload', type: 'Resistor', props: { label: 'Rload', resistance: 50 } },
        { id: 'Rpull', type: 'Resistor', props: { label: 'Rpull', resistance: 1e6 } },
        { id: 'gnd', type: 'Ground' },
      ],
      connections: [
        ['A:out', 'Rload:pos'],
        ['Rload:neg', 'Rpull:pos'],
        ['Rpull:neg', 'gnd:out'],
      ],
    }),
  });
}

// vs ──► r ──► Out(Y):in.  One analog→digital (INPUT) crossing.
function buildInput(): Fixture {
  return buildFixture({
    build: (_r, facade) => facade.build({
      components: [
        { id: 'vs', type: 'DcVoltageSource', props: { label: 'VS', voltage: 3.3 } },
        { id: 'r', type: 'Resistor', props: { label: 'R', resistance: 1000 } },
        { id: 'Y', type: 'Out', props: { label: 'Y', bitWidth: 1 } },
        { id: 'gnd', type: 'Ground' },
      ],
      connections: [
        ['vs:pos', 'r:pos'],
        ['r:neg', 'Y:in'],
        ['vs:neg', 'gnd:out'],
      ],
    }),
  });
}

// A(In):out AND Y(Out):in BOTH on one analog net (R:pos). Two crossing digital
// pins on one hub → two per-pin adapters (the old per-net bridge produced one).
function buildTwoPin(): Fixture {
  return buildFixture({
    build: (_r, facade) => facade.build({
      components: [
        { id: 'A', type: 'In', props: { label: 'A', bitWidth: 1 } },
        { id: 'Y', type: 'Out', props: { label: 'Y', bitWidth: 1 } },
        { id: 'R', type: 'Resistor', props: { label: 'R', resistance: 1e3 } },
        { id: 'gnd', type: 'Ground' },
      ],
      connections: [
        ['A:out', 'R:pos'],
        ['Y:in', 'R:pos'],
        ['R:neg', 'gnd:out'],
      ],
    }),
  });
}

describe('bridge-compilation: per-pin boundary adapters', () => {
  it('a digital OUTPUT crossing yields an output adapter handle keyed by pinKey', () => {
    const fix = buildOutput();
    const compiled = fix.coordinator.compiled;
    const bridge = compiled.bridges.find((b) => b.role === 'output');
    expect(bridge).toBeDefined();
    const handle = compiled.analog!.bridgeAdaptersByPinKey.get(bridge!.pinKey);
    expect(handle).toBeDefined();
    expect(handle!.role).toBe('output');
    // The expanded composite wrapper participates in the analog elements array.
    expect(compiled.analog!.elements).toContain(handle!.wrapper);
    fix.coordinator.dispose();
  });

  it('an analog→digital crossing yields an input adapter handle with a result node', () => {
    const fix = buildInput();
    const compiled = fix.coordinator.compiled;
    const bridge = compiled.bridges.find((b) => b.role === 'input');
    expect(bridge).toBeDefined();
    const handle = compiled.analog!.bridgeAdaptersByPinKey.get(bridge!.pinKey);
    expect(handle).toBeDefined();
    expect(handle!.role).toBe('input');
    // nResult is a real composite-internal MNA node the coordinator reads.
    expect(handle!.resultNodeId).toBeGreaterThan(0);
    fix.coordinator.dispose();
  });

  it('produces ONE adapter per crossing pin (two digital pins on one hub → two adapters)', () => {
    const fix = buildTwoPin();
    const compiled = fix.coordinator.compiled;
    const crossing = compiled.bridges;
    // One output (A:out) + one input (Y:in) crossing on the same analog hub.
    expect(crossing.filter((b) => b.role === 'output')).toHaveLength(1);
    expect(crossing.filter((b) => b.role === 'input')).toHaveLength(1);
    // Distinct pinKeys, each with its own resolved adapter handle.
    const keys = new Set(crossing.map((b) => b.pinKey));
    expect(keys.size).toBe(2);
    for (const b of crossing) {
      expect(compiled.analog!.bridgeAdaptersByPinKey.get(b.pinKey)).toBeDefined();
    }
    // All crossings share the same analog hub node.
    const nodes = new Set(crossing.map((b) => b.analogNodeId));
    expect(nodes.size).toBe(1);
    fix.coordinator.dispose();
  });
});
