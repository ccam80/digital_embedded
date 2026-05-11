// Tests cktLoad stamp correctness via end-to-end DCOP convergence using buildFixture.

import { describe, it, expect } from 'vitest';
import { buildFixture } from './fixtures/build-fixture.js';

import type { Circuit } from '../../../core/circuit.js';
import type { DefaultSimulatorFacade } from '../../../headless/default-facade.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildResistorDivider(facade: DefaultSimulatorFacade): Circuit {
  return facade.build({
    components: [
      { id: 'vs', type: 'DcVoltageSource', props: { label: 'V1', voltage: 5 } },
      { id: 'r1', type: 'Resistor',        props: { label: 'R1', resistance: 1000 } },
      { id: 'r2', type: 'Resistor',        props: { label: 'R2', resistance: 1000 } },
      { id: 'gnd', type: 'Ground' },
    ],
    connections: [
      ['vs:pos', 'r1:pos'],
      ['r1:neg', 'r2:pos'],
      ['r2:neg', 'gnd:out'],
      ['vs:neg', 'gnd:out'],
    ],
  });
}

function buildTwoSeriesVoltageSources(facade: DefaultSimulatorFacade): Circuit {
  return facade.build({
    components: [
      { id: 'v1',  type: 'DcVoltageSource', props: { label: 'V1', voltage: 3 } },
      { id: 'v2',  type: 'DcVoltageSource', props: { label: 'V2', voltage: 2 } },
      { id: 'r',   type: 'Resistor',        props: { label: 'R1', resistance: 1000 } },
      { id: 'gnd', type: 'Ground' },
    ],
    connections: [
      ['v1:pos', 'v2:neg'],
      ['v2:pos', 'r:pos'],
      ['r:neg',  'gnd:out'],
      ['v1:neg', 'gnd:out'],
    ],
  });
}

function buildCurrentSourceWithResistor(facade: DefaultSimulatorFacade): Circuit {
  return facade.build({
    components: [
      { id: 'i',   type: 'CurrentSource', props: { label: 'I1', current: 1e-3 } },
      { id: 'r',   type: 'Resistor',      props: { label: 'R1', resistance: 1000 } },
      { id: 'gnd', type: 'Ground' },
    ],
    connections: [
      ['i:pos',  'r:pos'],
      ['r:neg',  'gnd:out'],
      ['i:neg',  'gnd:out'],
    ],
  });
}

// ---------------------------------------------------------------------------
// Stamping tests
//
// These verify that cktLoad produces correct stamps end-to-end: a broken
// device load would produce wrong node voltages or fail to converge.
// ---------------------------------------------------------------------------

describe('Stamping', () => {
  it('resistor_divider_dc', () => {
    // R1 = R2 = 1kΩ, Vs = 5V → mid-node = 2.5V
    const fix = buildFixture({ build: (_r, facade) => buildResistorDivider(facade) });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);

    // mid-node label is 'R1:neg' / 'R2:pos'; use labelToNodeId
    const midNode = fix.circuit.labelToNodeId.get('R1:neg') ??
                    fix.circuit.labelToNodeId.get('R2:pos');
    expect(midNode).toBeDefined();
    const v = fix.engine.getNodeVoltage(midNode!);
    expect(v).toBeCloseTo(2.5, 6);
  });

  it('two_voltage_sources_series', () => {
    // V1=3V (gnd→n1), V2=2V (n1→n2), R=1kΩ (n2→gnd) → V(n2)=5V
    const fix = buildFixture({ build: (_r, facade) => buildTwoSeriesVoltageSources(facade) });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);

    const topNode = fix.circuit.labelToNodeId.get('R1:pos') ??
                    fix.circuit.labelToNodeId.get('V2:pos');
    expect(topNode).toBeDefined();
    const v = fix.engine.getNodeVoltage(topNode!);
    expect(v).toBeCloseTo(5.0, 6);
  });

  it('current_source_with_resistor', () => {
    // I=1mA into R=1kΩ → V(node1) = 1.0V
    const fix = buildFixture({ build: (_r, facade) => buildCurrentSourceWithResistor(facade) });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);

    const node = fix.circuit.labelToNodeId.get('R1:pos') ??
                 fix.circuit.labelToNodeId.get('I1:pos');
    expect(node).toBeDefined();
    const v = fix.engine.getNodeVoltage(node!);
    expect(v).toBeCloseTo(1.0, 6);
  });
});
