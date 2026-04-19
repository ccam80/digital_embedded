/**
 * R5: Mid-simulation hot-load test for bridge output adapter.
 *
 * Verifies that calling setParam("vOH", 5.0) on a BridgeOutputAdapter
 * mid-simulation (after reaching steady state) causes the analog node
 * voltage target to change to the new vOH on the next stamp cycle.
 *
 * The bridge output adapter uses an ideal voltage source branch equation.
 * At steady state the analog node voltage equals the branch RHS, so verifying
 * the RHS after re-stamping is equivalent to verifying the node voltage.
 */

import { describe, it, expect } from 'vitest';
import { makeBridgeOutputAdapter } from '../analog/bridge-adapter.js';
import type { ResolvedPinElectrical } from '../../core/pin-electrical.js';

const CMOS: ResolvedPinElectrical = {
  rOut: 50, cOut: 0, rIn: 1e7, cIn: 0,
  vOH: 3.3, vOL: 0.0, vIH: 2.0, vIL: 0.8, rHiZ: 1e9,
};

// Branch index in the augmented MNA matrix (matches coordinator-bridge.test.ts)
const BRANCH_IDX = 2;

// ---------------------------------------------------------------------------
// MockSolver — records stamp/stampRHS calls
// ---------------------------------------------------------------------------

interface RhsCall { row: number; value: number }

class MockSolver {
  readonly rhs: RhsCall[] = [];
  private readonly _handles: Array<{ row: number; col: number }> = [];

  allocElement(row: number, col: number): number {
    this._handles.push({ row, col });
    return this._handles.length - 1;
  }

  stampElement(_handle: number, _value: number): void { /* not needed for RHS checks */ }

  stampRHS(row: number, value: number): void {
    this.rhs.push({ row, value });
  }

  reset(): void {
    this.rhs.length = 0;
  }

  lastRhs(row: number): number | undefined {
    const hits = this.rhs.filter((r) => r.row === row);
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

// ---------------------------------------------------------------------------
// R5: hot-load vOH mid-simulation
// ---------------------------------------------------------------------------

describe('bridge adapter: hot-load vOH mid-simulation', () => {
  it('setParam("vOH", 5.0) after N steps causes analog node target to change to 5.0', () => {
    const adapter = makeBridgeOutputAdapter(CMOS, 1, BRANCH_IDX, false);
    const solver = new MockSolver();

    // Drive high from the start (coordinator sets logic level before each step)
    adapter.setLogicLevel(true);

    // Step N=5 times to reach steady state — each step re-stamps the branch equation
    const N = 5;
    for (let i = 0; i < N; i++) {
      solver.reset();
      adapter.load(makeCtx(solver));
    }

    // Verify steady state: branch RHS equals vOH = 3.3
    expect(solver.lastRhs(BRANCH_IDX)).toBeCloseTo(CMOS.vOH, 10);

    // Hot-load: update vOH to 5.0 mid-simulation
    adapter.setParam('vOH', 5.0);

    // Step again — coordinator re-stamps after param change
    solver.reset();
    adapter.load(makeCtx(solver));

    // Verify: analog node target has changed to the new vOH
    expect(solver.lastRhs(BRANCH_IDX)).toBeCloseTo(5.0, 10);
    // Confirm it is different from the original vOH
    expect(solver.lastRhs(BRANCH_IDX)).not.toBeCloseTo(CMOS.vOH, 5);
  });

  it('setParam("vOH", 5.0) does not affect vOL drive (logic low still drives 0V)', () => {
    const adapter = makeBridgeOutputAdapter(CMOS, 1, BRANCH_IDX, false);
    const solver = new MockSolver();

    // Drive low
    adapter.setLogicLevel(false);

    // Reach steady state
    for (let i = 0; i < 5; i++) {
      solver.reset();
      adapter.load(makeCtx(solver));
    }
    expect(solver.lastRhs(BRANCH_IDX)).toBeCloseTo(CMOS.vOL, 10);

    // Hot-load vOH — should not affect the low-level voltage
    adapter.setParam('vOH', 5.0);
    solver.reset();
    adapter.load(makeCtx(solver));

    // vOL is unchanged
    expect(solver.lastRhs(BRANCH_IDX)).toBeCloseTo(CMOS.vOL, 10);
  });

  it('setParam("vOH", 5.0) then switch to high drives 5.0', () => {
    const adapter = makeBridgeOutputAdapter(CMOS, 1, BRANCH_IDX, false);
    const solver = new MockSolver();

    // Start low, reach steady state
    adapter.setLogicLevel(false);
    for (let i = 0; i < 3; i++) {
      solver.reset();
      adapter.load(makeCtx(solver));
    }

    // Hot-load new vOH
    adapter.setParam('vOH', 5.0);

    // Coordinator switches to high (digital output goes high)
    adapter.setLogicLevel(true);
    solver.reset();
    adapter.load(makeCtx(solver));

    // Analog node target must now be 5.0, not the original 3.3
    expect(solver.lastRhs(BRANCH_IDX)).toBeCloseTo(5.0, 10);
  });
});
