/**
 * Tests for bridge MNA element integration in compileAnalogPartition.
 *
 * Task 1.6: Verifies that bridge stubs produce BridgeOutputAdapter /
 * BridgeInputAdapter MNA elements, keyed by group ID in
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
import type { BridgeOutputAdapter, BridgeInputAdapter } from '../bridge-adapter.js';
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

interface StampCall { row: number; col: number; value: number }
interface RhsCall   { row: number; value: number }

class MockSolver {
  readonly stamps: StampCall[] = [];
  readonly rhs: RhsCall[] = [];
  private readonly _handles: Array<{ row: number; col: number }> = [];
  allocElement(row: number, col: number): number {
    this._handles.push({ row, col });
    return this._handles.length - 1;
  }
  stampElement(handle: number, value: number): void {
    const { row, col } = this._handles[handle];
    this.stamps.push({ row, col, value });
  }
  stampRHS(row: number, value: number): void { this.rhs.push({ row, value }); }
  reset(): void { this.stamps.length = 0; this.rhs.length = 0; this._handles.length = 0; }
  sumStamp(row: number, col: number): number {
    return this.stamps.filter(s => s.row === row && s.col === col).reduce((a, s) => a + s.value, 0);
  }
  lastRhs(row: number): number | undefined {
    const hits = this.rhs.filter(r => r.row === row);
    return hits.length > 0 ? hits[hits.length - 1]!.value : undefined;
  }
}

function makeCtx(solver: MockSolver) {
  return {
    solver: solver as any,
    voltages: new Float64Array(8),
    iteration: 0,
    initMode: 'initFloat' as const,
    dt: 0,
    method: 'trapezoidal' as const,
    order: 1,
    deltaOld: [0, 0, 0, 0, 0, 0, 0],
    ag: new Float64Array(8),
    srcFact: 1,
    noncon: { value: 0 },
    limitingCollector: null,
    isDcOp: true,
    isTransient: false,

    isTransientDcop: false,

    isAc: false,
    xfact: 1,
    gmin: 1e-12,
    uic: false,
    reltol: 1e-3,
    iabstol: 1e-12,
  };
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
    const adapter = compiled.bridgeAdaptersByGroupId.get(1)![0] as BridgeOutputAdapter;
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

describe('bridge-compilation: none mode bridge adapters are unloaded', () => {
  it('none mode output adapter does not stamp rOut conductance', () => {
    const group = makeBoundaryGroup(1);
    const stub = makeStub(group, 'digital-to-analog');
    const partition = makePartition([stub], [group]);
    const compiled = compileAnalogPartition(partition, new ComponentRegistry(), undefined, undefined, undefined, 'none');
    const adapter = compiled.bridgeAdaptersByGroupId.get(1)![0] as BridgeOutputAdapter;
    const solver = new MockSolver();
    adapter.load(makeCtx(solver));
    // nodeId=1 -> nodeIdx=0. Unloaded: no rOut conductance on diagonal.
    expect(solver.sumStamp(0, 0)).toBe(0);
  });

  it('none mode input adapter stamps nothing', () => {
    const group = makeBoundaryGroup(2);
    const stub = makeStub(group, 'analog-to-digital');
    const partition = makePartition([stub], [group]);
    const compiled = compileAnalogPartition(partition, new ComponentRegistry(), undefined, undefined, undefined, 'none');
    const adapter = compiled.bridgeAdaptersByGroupId.get(2)![0] as BridgeInputAdapter;
    const solver = new MockSolver();
    adapter.load(makeCtx(solver));
    expect(solver.stamps.length).toBe(0);
    expect(solver.rhs.length).toBe(0);
  });
});

describe('bridge-compilation: cross-domain mode bridge adapters are loaded', () => {
  it('cross-domain mode output adapter stamps rOut conductance', () => {
    const group = makeBoundaryGroup(1);
    const stub = makeStub(group, 'digital-to-analog');
    const partition = makePartition([stub], [group]);
    const compiled = compileAnalogPartition(partition, new ComponentRegistry(), undefined, undefined, undefined, 'cross-domain');
    const adapter = compiled.bridgeAdaptersByGroupId.get(1)![0] as BridgeOutputAdapter;
    const solver = new MockSolver();
    adapter.load(makeCtx(solver));
    const gOut = 1 / CMOS_3V3.rOut;
    // nodeId=1 -> nodeIdx=0. Loaded: 1/rOut on diagonal.
    expect(solver.sumStamp(0, 0)).toBeCloseTo(gOut, 8);
  });
});

describe('bridge-compilation: per-net ideal override produces unloaded adapters', () => {
  it('per-net ideal override on boundary group produces unloaded output adapter', () => {
    const group = makeBoundaryGroup(1);
    group.loadingMode = 'ideal';
    const stub = makeStub(group, 'digital-to-analog');
    const partition = makePartition([stub], [group]);
    const compiled = compileAnalogPartition(partition, new ComponentRegistry(), undefined, undefined, undefined, 'cross-domain');
    const adapter = compiled.bridgeAdaptersByGroupId.get(1)![0] as BridgeOutputAdapter;
    const solver = new MockSolver();
    adapter.load(makeCtx(solver));
    expect(solver.sumStamp(0, 0)).toBe(0);
  });
});

describe('bridge-compilation: bridge output in hi-z mode stamps I=0', () => {
  it('hi-z output stamps I=0 branch equation', () => {
    const group = makeBoundaryGroup(1);
    const stub = makeStub(group, 'digital-to-analog');
    const partition = makePartition([stub], [group]);
    const compiled = compileAnalogPartition(partition, new ComponentRegistry(), undefined, undefined, undefined, 'cross-domain');
    const adapter = compiled.bridgeAdaptersByGroupId.get(1)![0] as BridgeOutputAdapter;
    adapter.setHighZ(true);
    const solver = new MockSolver();
    adapter.load(makeCtx(solver));
    expect(solver.lastRhs(adapter.branchIndex)).toBe(0);
  });
});
