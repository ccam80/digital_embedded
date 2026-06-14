/**
 * Headless tests for the digitalPinLoading circuit metadata field, on the real
 * production registry (createDefaultRegistry). The per-pin boundary synthesis
 * expands real adapter composites, so these build real mixed circuits and read
 * the compiled bridge descriptors / per-pin adapter map.
 *
 * Ordering invariant: all > cross-domain >= none (per crossing-pin count).
 * Components never change partition based on loading mode.
 */

import { describe, it, expect } from 'vitest';
import { compileUnified } from '../compile.js';
import { createDefaultRegistry } from '../../components/register-all.js';
import { DefaultSimulatorFacade } from '../../headless/default-facade.js';

const registry = createDefaultRegistry();
const facade = new DefaultSimulatorFacade(registry);

// In(A),In(B) → And(digital) → Resistor → Ground. And:out↔Resistor is the
// real digital→analog boundary; "all" mode additionally loads the In→And nets.
function buildMixed(mode?: 'cross-domain' | 'all' | 'none') {
  const c = facade.build({
    components: [
      { id: 'A', type: 'In', props: { label: 'A', bitWidth: 1 } },
      { id: 'B', type: 'In', props: { label: 'B', bitWidth: 1 } },
      { id: 'g', type: 'And', props: { model: 'digital' } },
      { id: 'r', type: 'Resistor', props: { label: 'R', resistance: 1000 } },
      { id: 'gnd', type: 'Ground' },
    ],
    connections: [
      ['A:out', 'g:In_1'],
      ['B:out', 'g:In_2'],
      ['g:out', 'r:pos'],
      ['r:neg', 'gnd:out'],
    ],
  });
  if (mode) c.metadata.digitalPinLoading = mode;
  return c;
}

describe('digitalPinLoading- circuit metadata controls bridge adapter synthesis', () => {
  it('default (absent) is equivalent to cross-domain mode', () => {
    const resultDefault = compileUnified(buildMixed(), registry);
    const resultExplicit = compileUnified(buildMixed('cross-domain'), registry);
    expect(resultDefault.bridges.length).toBe(resultExplicit.bridges.length);
  });

  it('cross-domain mode produces exactly one bridge for the real boundary', () => {
    const result = compileUnified(buildMixed('cross-domain'), registry);
    expect(result.bridges).toHaveLength(1);
  });

  it('all mode produces more bridges than cross-domain for the same circuit', () => {
    const crossResult = compileUnified(buildMixed('cross-domain'), registry);
    const allResult = compileUnified(buildMixed('all'), registry);
    expect(allResult.bridges.length).toBeGreaterThan(crossResult.bridges.length);
  });

  it('all mode: bridge count is at least as large as cross-domain bridge count', () => {
    const crossDomain = compileUnified(buildMixed('cross-domain'), registry);
    const all = compileUnified(buildMixed('all'), registry);
    expect(all.bridges.length).toBeGreaterThanOrEqual(crossDomain.bridges.length);
  });

  it('none mode produces zero bridges for a purely digital circuit', () => {
    const circuit = facade.build({
      components: [
        { id: 'A', type: 'In', props: { label: 'A', bitWidth: 1 } },
        { id: 'B', type: 'In', props: { label: 'B', bitWidth: 1 } },
        { id: 'g', type: 'And' },
        { id: 'Y', type: 'Out', props: { label: 'Y', bitWidth: 1 } },
      ],
      connections: [
        ['A:out', 'g:In_1'],
        ['B:out', 'g:In_2'],
        ['g:out', 'Y:in'],
      ],
    });
    circuit.metadata.digitalPinLoading = 'none';
    const result = compileUnified(circuit, registry);
    expect(result.bridges).toHaveLength(0);
  });

  it('changing digitalPinLoading from cross-domain to all increases bridge count', () => {
    const crossResult = compileUnified(buildMixed('cross-domain'), registry);
    const allResult = compileUnified(buildMixed('all'), registry);
    expect(allResult.bridges.length).toBeGreaterThan(crossResult.bridges.length);
  });

  it('none mode on mixed circuit preserves the analog partition', () => {
    const result = compileUnified(buildMixed('none'), registry);
    expect(result.analog).not.toBeNull();
  });
});
