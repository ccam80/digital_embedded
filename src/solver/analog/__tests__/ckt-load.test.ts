/**
 * Tests for cktLoad correctness.
 *
 * All tests go through `buildFixture` and drive the simulation via the
 * coordinator's public surface. No direct cktLoad/cktMode/rhs/noncon
 * introspection — those are internal ngspice-mirroring details whose
 * structural correctness is covered by:
 *   ngspice-parity/load-order-parity.test.ts
 *
 * Stamping group: end-to-end solve tests verifying that cktLoad produces
 * correct stamps (if it didn't, DCOP would not converge to the expected
 * node voltages).
 */

import { describe, it, expect } from 'vitest';
import { buildFixture } from './fixtures/build-fixture.js';

import type { Circuit } from '../../../core/circuit.js';
import type { DefaultSimulatorFacade } from '../../../headless/default-facade.js';

// ---------------------------------------------------------------------------
// Deleted tests — internal cktLoad / RHS / noncon / troubleNode / ics / E_SINGULAR
// ---------------------------------------------------------------------------
//
// Deleted: CKTload / single_pass_stamps_all_contributions.
// Coverage: ngspice-parity/load-order-parity.test.ts
// Reason: assertion was on internal solver factor() return after one cktLoad
//         pass; structural correctness covered by parity matrix-entry check.
//
// Deleted: CKTload / nodesets_applied_after_device_loads.
// Coverage: ngspice-parity/load-order-parity.test.ts
// Reason: only asserted solver.factor() == 0 after cktLoad with nodesets;
//         observable outcome is convergence, covered by Stamping tests below.
//
// Deleted: CKTload / noncon_incremented_by_device_limiting.
// Coverage: ngspice-parity/load-order-parity.test.ts
// Reason: asserted ctx.noncon internal field; no public surface equivalent.
//
// Deleted: nodesets / srcFact_scales_nodeset_rhs.
// Coverage: ngspice-parity/load-order-parity.test.ts
// Reason: asserted rhs[1] value directly after cktLoad; internal RHS
//         inspection with no public surface equivalent.
//
// Deleted: nodesets / nodeset_applied_in_MODEDCOP_MODEINITFIX.
// Coverage: ngspice-parity/load-order-parity.test.ts
// Reason: same — direct rhs[] assertion on internal cktLoad state.
//
// Deleted: nodesets / nodeset_NOT_applied_in_MODEDCOP_MODEINITFLOAT.
// Coverage: ngspice-parity/load-order-parity.test.ts
// Reason: same — bitfield-gate check via internal rhs[]; no public surface.
//
// Deleted: ics / ic_stamped_in_MODETRANOP_without_MODEUIC.
// Coverage: ngspice-parity/load-order-parity.test.ts
// Reason: asserted rhs[1] = 1e10 * icValue; internal IC-stamping gate check.
//
// Deleted: ics / ic_NOT_stamped_when_MODEUIC_set.
// Coverage: ngspice-parity/load-order-parity.test.ts
// Reason: asserted rhs[1] == 0 when MODEUIC set; internal cktMode flag check.
//
// Deleted: ics / ic_NOT_stamped_in_MODEDCOP.
// Coverage: ngspice-parity/load-order-parity.test.ts
// Reason: asserted rhs[1] == 0 in DCOP mode; internal mode-gate check.
//
// Deleted: troubleNode / troubleNode_zeroed_when_noncon_rises.
// Coverage: ngspice-parity/load-order-parity.test.ts
// Reason: asserted ctx.troubleNode internal field; no public surface.
//
// Deleted: troubleNode / troubleNode_not_touched_when_noncon_stays_zero.
// Coverage: ngspice-parity/load-order-parity.test.ts
// Reason: same — ctx.troubleNode is an internal field; no public surface.
//
// Deleted: E_SINGULAR / e_singular_recovery_via_cktLoad.
// Coverage: ngspice-parity/load-order-parity.test.ts
// Reason: used a Proxy SparseSolver injected via makeSimpleCtx (deleted
//         helper); asserted factorCallCount / stubWalkedReorder — internal
//         solver retry path. Structural correctness (NR converges) is
//         subsumed by Stamping tests; the reorder-path detail has no public
//         surface equivalent.

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
