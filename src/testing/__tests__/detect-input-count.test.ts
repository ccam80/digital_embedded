/**
 * Tests for detectInputCount() — Task 7b.
 *
 * Verifies that the function correctly identifies the boundary between
 * input columns and output columns in a test-data header string by
 * matching against the circuit's labeled In/Clock/Out components.
 *
 * Test scenarios:
 *   - Circuit with In(A), In(B), Out(Y) + header "A B Y" → returns 2
 *   - Circuit with no labeled components → returns undefined
 *   - Circuit with only Out components → returns 0
 *   - Header with leading comment lines should be skipped
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { detectInputCount } from '../detect-input-count.js';
import { CircuitBuilder } from '../../headless/builder.js';
import { createDefaultRegistry } from '../../components/register-all.js';
import type { Circuit } from '../../core/circuit.js';
import type { ComponentRegistry } from '../../core/registry.js';

let registry: ComponentRegistry;
let builder: CircuitBuilder;

beforeEach(() => {
  registry = createDefaultRegistry();
  builder = new CircuitBuilder(registry);
});

describe('detectInputCount', () => {
  it('returns 2 for In(A), In(B), Out(Y) with header "A B Y"', () => {
    const circuit: Circuit = builder.build({
      components: [
        { id: 'a', type: 'In', props: { label: 'A', bitWidth: 1 } },
        { id: 'b', type: 'In', props: { label: 'B', bitWidth: 1 } },
        { id: 'g', type: 'And' },
        { id: 'y', type: 'Out', props: { label: 'Y', bitWidth: 1 } },
      ],
      connections: [
        ['a:out', 'g:In_1'],
        ['b:out', 'g:In_2'],
        ['g:out', 'y:in'],
      ],
    });

    const result = detectInputCount(circuit, registry, 'A B Y\n0 0 0\n0 1 0\n1 1 1');
    expect(result).toBe(2);
  });

  it('returns undefined for a circuit with no In/Out/Clock components', () => {
    // A circuit with only logic gates has no In/Clock/Out type components,
    // so neither inputLabels nor outputLabels are populated → undefined.
    const circuit: Circuit = builder.build({
      components: [
        { id: 'g1', type: 'And' },
        { id: 'g2', type: 'Not' },
      ],
      connections: [['g1:out', 'g2:in']],
    });

    const result = detectInputCount(circuit, registry, 'A B Y\n0 0 0');
    expect(result).toBeUndefined();
  });

  it('returns 0 for a circuit with only Out components (all columns are outputs)', () => {
    const circuit: Circuit = builder.build({
      components: [
        { id: 'c', type: 'Const', props: { label: 'ONE', defaultValue: 1, bitWidth: 1 } },
        { id: 'y', type: 'Out', props: { label: 'Y', bitWidth: 1 } },
      ],
      connections: [['c:out', 'y:in']],
    });

    const result = detectInputCount(circuit, registry, 'Y\n1');
    expect(result).toBe(0);
  });

  it('skips comment lines when searching for the header', () => {
    const circuit: Circuit = builder.build({
      components: [
        { id: 'a', type: 'In', props: { label: 'A', bitWidth: 1 } },
        { id: 'y', type: 'Out', props: { label: 'Y', bitWidth: 1 } },
      ],
      connections: [['a:out', 'y:in']],
    });

    const testData = '# this is a comment\n# another comment\nA Y\n0 0\n1 1';
    const result = detectInputCount(circuit, registry, testData);
    expect(result).toBe(1);
  });
});
