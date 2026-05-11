/**
 * Tests for bridge MNA element integration in compileAnalogPartition.
 *
 * Task 1.6: Verifies that bridge stubs produce BridgeOutputDriverElement /
 * BridgeInputDriverElement MNA elements, keyed by group ID in
 * bridgeAdaptersByGroupId, and that loading flags honour digitalPinLoading.
 */

import { describe, it, expect } from 'vitest';
import { compileAnalogPartition } from '../compiler.js';
import type {
  SolverPartition,
  ConnectivityGroup,
  BridgeStub,
  BridgeDescriptor,
} from '../../../compile/types.js';
import type { BridgeOutputDriverElement } from '../behavioral-drivers/bridge-output-driver.js';
import { ComponentRegistry } from '../../../core/registry.js';

const CMOS_3V3 = { rOut: 50, cOut: 5e-12, rIn: 1e7, cIn: 5e-12, vOH: 3.3, vOL: 0.0, vIH: 2.0, vIL: 0.8, rHiZ: 1e7 };

function makeBoundaryGroup(groupId: number): ConnectivityGroup {
  return { groupId, pins: [], wires: [], domains: new Set(['digital', 'analog']), bitWidth: 1 };
}

function makeStub(group: ConnectivityGroup, direction: 'digital-to-analog' | 'analog-to-digital'): BridgeStub {
  const descriptor: BridgeDescriptor = { boundaryGroup: group, direction, bitWidth: 1, electricalSpec: CMOS_3V3 };
  return { boundaryGroupId: group.groupId, descriptor };
}

function makePartition(stubs: BridgeStub[], groups: ConnectivityGroup[]): SolverPartition {
  return { components: [], groups, bridgeStubs: stubs };
}

describe('bridge-compilation: boundary group adapter creation', () => {
  it('boundary group produces output adapter for digital-to-analog direction', () => {
    const group = makeBoundaryGroup(1);
    const stub = makeStub(group, 'digital-to-analog');
    const partition = makePartition([stub], [group]);
    const compiled = compileAnalogPartition(partition, new ComponentRegistry(), undefined, undefined, undefined, 'cross-domain');
    expect(compiled.bridgeAdaptersByGroupId.has(1)).toBe(true);
    const adapters = compiled.bridgeAdaptersByGroupId.get(1)!;
    expect(adapters).toHaveLength(1);
    expect(adapters[0]).toHaveProperty('setLogicLevel');
  });

  it('boundary group produces input adapter for analog-to-digital direction', () => {
    const group = makeBoundaryGroup(2);
    const stub = makeStub(group, 'analog-to-digital');
    const partition = makePartition([stub], [group]);
    const compiled = compileAnalogPartition(partition, new ComponentRegistry(), undefined, undefined, undefined, 'cross-domain');
    expect(compiled.bridgeAdaptersByGroupId.has(2)).toBe(true);
    const adapters = compiled.bridgeAdaptersByGroupId.get(2)!;
    expect(adapters).toHaveLength(1);
    expect(adapters[0]).toHaveProperty('readLogicLevel');
  });
});

describe('bridge-compilation: bridge output adapter branch index', () => {
  it('bridge output adapter has branch index >= 0', () => {
    const group = makeBoundaryGroup(1);
    const stub = makeStub(group, 'digital-to-analog');
    const partition = makePartition([stub], [group]);
    const compiled = compileAnalogPartition(partition, new ComponentRegistry(), undefined, undefined, undefined, 'cross-domain');
    const adapter = compiled.bridgeAdaptersByGroupId.get(1)![0] as BridgeOutputDriverElement;
    expect(adapter.branchIndex).toBeGreaterThanOrEqual(0);
  });
});

describe('bridge-compilation: bridge adapters appear in elements array', () => {
  it('bridge adapters participate in analog elements array', () => {
    const group = makeBoundaryGroup(1);
    const stub = makeStub(group, 'digital-to-analog');
    const partition = makePartition([stub], [group]);
    const compiled = compileAnalogPartition(partition, new ComponentRegistry(), undefined, undefined, undefined, 'cross-domain');
    expect(compiled.elements.length).toBeGreaterThan(0);
    const adapter = compiled.bridgeAdaptersByGroupId.get(1)![0];
    expect(compiled.elements).toContain(adapter);
  });
});

