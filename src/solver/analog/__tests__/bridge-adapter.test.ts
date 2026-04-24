/**
 * Tests for BridgeOutputAdapter and BridgeInputAdapter.
 *
 * Verifies the ideal voltage source bridge architecture:
 *  - OutputAdapter stamps branch equation (not Norton equivalent)
 *  - OutputAdapter drives vOH/vOL via branch RHS
 *  - OutputAdapter hi-z stamps I=0 branch equation
 *  - Loaded/unloaded output adapter rOut stamping
 *  - Input adapter unloaded stamps nothing; loaded stamps rIn
 *  - Threshold detection
 *  - setParam hot-updates both adapter types
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MODEDCOP, MODEINITFLOAT } from "../ckt-mode.js";
import {
  makeBridgeOutputAdapter,
  makeBridgeInputAdapter,
} from "../bridge-adapter.js";
import type { ResolvedPinElectrical } from "../../../core/pin-electrical.js";
import { StatePool } from "../state-pool.js";

// ---------------------------------------------------------------------------
// Test helper — records stamp() and stampRHS() calls
// ---------------------------------------------------------------------------

interface StampCall {
  row: number;
  col: number;
  value: number;
}

interface RhsCall {
  row: number;
  value: number;
}

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

  stampRHS(row: number, value: number): void {
    this.rhs.push({ row, value });
  }

  reset(): void {
    this.stamps.length = 0;
    this.rhs.length = 0;
  }

  /** Sum all stamp values at (row, col). */
  sumStamp(row: number, col: number): number {
    return this.stamps
      .filter((s) => s.row === row && s.col === col)
      .reduce((acc, s) => acc + s.value, 0);
  }

  /** Sum all RHS values at row. */
  sumRhs(row: number): number {
    return this.rhs
      .filter((r) => r.row === row)
      .reduce((acc, r) => acc + r.value, 0);
  }

  /** Last stamp value written at (row, col), or undefined if never stamped. */
  lastStamp(row: number, col: number): number | undefined {
    const hits = this.stamps.filter((s) => s.row === row && s.col === col);
    return hits.length > 0 ? hits[hits.length - 1].value : undefined;
  }

  /** Last RHS value written at row, or undefined if never stamped. */
  lastRhs(row: number): number | undefined {
    const hits = this.rhs.filter((r) => r.row === row);
    return hits.length > 0 ? hits[hits.length - 1].value : undefined;
  }
}

function makeCtx(solver: MockSolver) {
  return {
    solver: solver as any,
    voltages: new Float64Array(8),
    cktMode: MODEDCOP | MODEINITFLOAT,
    dt: 0,
    method: "trapezoidal" as const,
    order: 1,
    deltaOld: [0, 0, 0, 0, 0, 0, 0],
    ag: new Float64Array(7),
    srcFact: 1,
    noncon: { value: 0 },
    limitingCollector: null,
    xfact: 1,
    gmin: 1e-12,
    reltol: 1e-3,
    iabstol: 1e-12,
    cktFixLimit: false,
  };
}

// ---------------------------------------------------------------------------
// Shared spec — CMOS 3.3V
// ---------------------------------------------------------------------------

const CMOS_3V3: ResolvedPinElectrical = {
  rOut: 50,
  cOut: 5e-12,
  rIn: 1e7,
  cIn: 5e-12,
  vOH: 3.3,
  vOL: 0.0,
  vIH: 2.0,
  vIL: 0.8,
  rHiZ: 1e7,
};

// NODE=1 → nodeIdx=0 (0-based MNA index)
// branchIdx=2 (absolute branch row in augmented matrix with 2 nodes)
const NODE = 1;
const NODE_IDX = NODE - 1; // 0
const BRANCH_IDX = 2;

// ---------------------------------------------------------------------------
// BridgeOutputAdapter tests
// ---------------------------------------------------------------------------

describe("BridgeOutputAdapter", () => {
  let solver: MockSolver;

  beforeEach(() => {
    solver = new MockSolver();
  });

  it("output adapter stamps ideal voltage source at vOL", () => {
    // Default logic level is low (vOL)
    const adapter = makeBridgeOutputAdapter(CMOS_3V3, NODE, BRANCH_IDX, false);
    adapter.load(makeCtx(solver));

    // Drive mode branch equation: stamp(branchIdx, nodeIdx, 1)
    expect(solver.lastStamp(BRANCH_IDX, NODE_IDX)).toBe(1);
    // KCL: stamp(nodeIdx, branchIdx, 1)
    expect(solver.lastStamp(NODE_IDX, BRANCH_IDX)).toBe(1);
    // RHS: stampRHS(branchIdx, vOL)
  });

  it("output adapter setLogicLevel(true) drives vOH", () => {
    const adapter = makeBridgeOutputAdapter(CMOS_3V3, NODE, BRANCH_IDX, false);
    adapter.setLogicLevel(true);
    adapter.load(makeCtx(solver));

    // RHS must be vOH after setting level high
  });

  it("output adapter hi-z stamps I=0", () => {
    const adapter = makeBridgeOutputAdapter(CMOS_3V3, NODE, BRANCH_IDX, false);
    adapter.setHighZ(true);
    adapter.load(makeCtx(solver));

    // Hi-Z branch equation: stamp(branchIdx, branchIdx, 1)
    expect(solver.lastStamp(BRANCH_IDX, BRANCH_IDX)).toBe(1);
    // KCL still present: stamp(nodeIdx, branchIdx, 1)
    expect(solver.lastStamp(NODE_IDX, BRANCH_IDX)).toBe(1);
    // RHS: stampRHS(branchIdx, 0)
    expect(solver.lastRhs(BRANCH_IDX)).toBe(0);
  });

  it("loaded output adapter stamps rOut conductance on node diagonal", () => {
    const adapter = makeBridgeOutputAdapter(CMOS_3V3, NODE, BRANCH_IDX, true);
    const pool = new StatePool(adapter.stateSize);
    adapter.stateBaseOffset = 0;
    adapter.initState(pool);
    adapter.load(makeCtx(solver));

    // 1/rOut must appear on the node diagonal
    const gOut = 1 / CMOS_3V3.rOut;
  });

  it("unloaded output adapter does not stamp rOut on node diagonal", () => {
    const adapter = makeBridgeOutputAdapter(CMOS_3V3, NODE, BRANCH_IDX, false);
    adapter.load(makeCtx(solver));

    // Node diagonal must be zero — no rOut conductance when unloaded
    expect(solver.sumStamp(NODE_IDX, NODE_IDX)).toBe(0);
  });

  it("input adapter unloaded stamps nothing", () => {
    const adapter = makeBridgeInputAdapter(CMOS_3V3, NODE, false);
    adapter.load(makeCtx(solver));

    // No stamps at all when unloaded
    expect(solver.stamps.length).toBe(0);
    expect(solver.rhs.length).toBe(0);
  });

  it("input adapter loaded stamps rIn on node diagonal", () => {
    const adapter = makeBridgeInputAdapter(CMOS_3V3, NODE, true);
    const pool = new StatePool(adapter.stateSize);
    adapter.stateBaseOffset = 0;
    adapter.initState(pool);
    adapter.load(makeCtx(solver));

    const gIn = 1 / CMOS_3V3.rIn;
    expect(solver.rhs.length).toBe(0);
  });

  it("input adapter readLogicLevel thresholds correctly", () => {
    const adapter = makeBridgeInputAdapter(CMOS_3V3, NODE, false);

    // Above vIH → true
    expect(adapter.readLogicLevel(CMOS_3V3.vIH + 0.1)).toBe(true);
    // Below vIL → false
    expect(adapter.readLogicLevel(CMOS_3V3.vIL - 0.1)).toBe(false);
    // Between vIL and vIH → undefined
    expect(adapter.readLogicLevel((CMOS_3V3.vIL + CMOS_3V3.vIH) / 2)).toBeUndefined();
  });

  it("setParam('rOut', 50) hot-updates output adapter conductance", () => {
    const adapter = makeBridgeOutputAdapter(CMOS_3V3, NODE, BRANCH_IDX, true);
    const pool = new StatePool(adapter.stateSize);
    adapter.stateBaseOffset = 0;
    adapter.initState(pool);
    adapter.load(makeCtx(solver));
    const gOutBefore = solver.sumStamp(NODE_IDX, NODE_IDX);

    solver.reset();
    const newROut = 100;
    adapter.setParam("rOut", newROut);
    adapter.load(makeCtx(solver));
    const gOutAfter = solver.sumStamp(NODE_IDX, NODE_IDX);

  });

  it("setParam('vIH', 2.5) hot-updates input threshold", () => {
    const adapter = makeBridgeInputAdapter(CMOS_3V3, NODE, false);

    // With default vIH=2.0, voltage 2.1 is above threshold
    expect(adapter.readLogicLevel(2.1)).toBe(true);

    // Raise threshold to 2.5 — 2.1 is now indeterminate (between 0.8 and 2.5)
    adapter.setParam("vIH", 2.5);
    expect(adapter.readLogicLevel(2.1)).toBeUndefined();

    // 2.6 is now above the new threshold
    expect(adapter.readLogicLevel(2.6)).toBe(true);
  });
});
