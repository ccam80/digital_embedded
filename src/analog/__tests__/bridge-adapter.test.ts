/**
 * Tests for BridgeOutputAdapter and BridgeInputAdapter.
 *
 * Verifies:
 *  - OutputAdapter stamps Norton equivalent when logic high/low
 *  - OutputAdapter stamps only rHiZ conductance in Hi-Z mode
 *  - OutputAdapter re-stamps correct current after level change via stampNonlinear
 *  - InputAdapter stamps 1/rIn conductance
 *  - InputAdapter threshold detection returns true/false/undefined correctly
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  BridgeOutputAdapter,
  BridgeInputAdapter,
  makeBridgeOutputAdapter,
  makeBridgeInputAdapter,
} from "../bridge-adapter.js";
import type { ResolvedPinElectrical } from "../../core/pin-electrical.js";

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

  stamp(row: number, col: number, value: number): void {
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

const NODE = 1;

// ---------------------------------------------------------------------------
// BridgeOutputAdapter tests
// ---------------------------------------------------------------------------

describe("OutputAdapter", () => {
  let solver: MockSolver;
  let adapter: BridgeOutputAdapter;

  beforeEach(() => {
    solver = new MockSolver();
    adapter = makeBridgeOutputAdapter(CMOS_3V3, NODE);
  });

  it("stamps_norton_for_logic_high", () => {
    adapter.setLogicLevel(true);
    adapter.stamp(solver as any);
    adapter.stampNonlinear(solver as any);

    // stamp() and stampNonlinear() both call pinModel.stamp() — accumulate
    // conductance. For the purposes of this test we verify each call delivers
    // the expected values. We inspect only the stampNonlinear contribution by
    // resetting and calling stampNonlinear alone.
    solver.reset();
    adapter.stampNonlinear(solver as any);

    const gOut = 1 / CMOS_3V3.rOut; // 1/50 = 0.02
    expect(solver.sumStamp(NODE, NODE)).toBeCloseTo(gOut, 10);

    // RHS current: V_out / rOut = 3.3 / 50
    const expectedCurrent = CMOS_3V3.vOH / CMOS_3V3.rOut;
    expect(solver.sumRhs(NODE)).toBeCloseTo(expectedCurrent, 10);
  });

  it("stamps_norton_for_logic_low", () => {
    adapter.setLogicLevel(false);
    adapter.stamp(solver as any);
    solver.reset();
    adapter.stampNonlinear(solver as any);

    const gOut = 1 / CMOS_3V3.rOut;
    expect(solver.sumStamp(NODE, NODE)).toBeCloseTo(gOut, 10);

    // vOL = 0.0, so RHS current = 0.0 / 50 = 0.0
    const expectedCurrent = CMOS_3V3.vOL / CMOS_3V3.rOut;
    expect(solver.sumRhs(NODE)).toBeCloseTo(expectedCurrent, 10);
  });

  it("hiz_stamps_rhiz", () => {
    adapter.setHighZ(true);
    adapter.stamp(solver as any);

    // Hi-Z: only 1/rHiZ conductance — no current source
    const gHiZ = 1 / CMOS_3V3.rHiZ;
    expect(solver.sumStamp(NODE, NODE)).toBeCloseTo(gHiZ, 15);
    expect(solver.rhs.length).toBe(0);
  });

  it("level_change_updates_stamp", () => {
    // Set high, stamp once — record RHS current
    adapter.setLogicLevel(true);
    adapter.stamp(solver as any);
    const rhsHigh = solver.sumRhs(NODE);

    solver.reset();

    // Switch to low, stampNonlinear — verify RHS current changed
    adapter.setLogicLevel(false);
    adapter.stampNonlinear(solver as any);
    const rhsLow = solver.sumRhs(NODE);

    expect(rhsHigh).toBeCloseTo(CMOS_3V3.vOH / CMOS_3V3.rOut, 10);
    expect(rhsLow).toBeCloseTo(CMOS_3V3.vOL / CMOS_3V3.rOut, 10);
    expect(rhsHigh).not.toBeCloseTo(rhsLow, 6);
  });

  it("outputNodeId_matches_init_node", () => {
    expect(adapter.outputNodeId).toBe(NODE);
  });

  it("nodeIndices_contains_output_node", () => {
    expect(adapter.nodeIndices).toContain(NODE);
  });

  it("branchIndex_is_minus_one", () => {
    expect(adapter.branchIndex).toBe(-1);
  });

  it("isNonlinear_is_true", () => {
    expect(adapter.isNonlinear).toBe(true);
  });

  it("isReactive_is_true", () => {
    expect(adapter.isReactive).toBe(true);
  });

  it("updateOperatingPoint_is_noop", () => {
    // Should not throw and should not modify adapter state
    const voltages = new Float64Array([0, 3.3]);
    expect(() => adapter.updateOperatingPoint(voltages)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// BridgeInputAdapter tests
// ---------------------------------------------------------------------------

describe("InputAdapter", () => {
  let solver: MockSolver;
  let adapter: BridgeInputAdapter;

  beforeEach(() => {
    solver = new MockSolver();
    adapter = makeBridgeInputAdapter(CMOS_3V3, NODE);
  });

  it("stamps_input_loading", () => {
    adapter.stamp(solver as any);

    // Conductance 1/rIn at (node, node)
    const gIn = 1 / CMOS_3V3.rIn; // 1e-7
    expect(solver.sumStamp(NODE, NODE)).toBeCloseTo(gIn, 15);

    // Input loading is a linear resistor — no RHS entry
    expect(solver.rhs.length).toBe(0);
  });

  it("reads_threshold_high", () => {
    // 3.0V > vIH (2.0) → true
    expect(adapter.readLogicLevel(3.0)).toBe(true);
  });

  it("reads_threshold_low", () => {
    // 0.5V < vIL (0.8) → false
    expect(adapter.readLogicLevel(0.5)).toBe(false);
  });

  it("reads_threshold_indeterminate", () => {
    // 1.5V between vIL (0.8) and vIH (2.0) → undefined
    expect(adapter.readLogicLevel(1.5)).toBeUndefined();
  });

  it("inputNodeId_matches_init_node", () => {
    expect(adapter.inputNodeId).toBe(NODE);
  });

  it("nodeIndices_contains_input_node", () => {
    expect(adapter.nodeIndices).toContain(NODE);
  });

  it("branchIndex_is_minus_one", () => {
    expect(adapter.branchIndex).toBe(-1);
  });

  it("isNonlinear_is_false", () => {
    expect(adapter.isNonlinear).toBe(false);
  });

  it("isReactive_is_true", () => {
    expect(adapter.isReactive).toBe(true);
  });

  it("stampCompanion_stamps_capacitance", () => {
    // Must call stamp() first to cache the solver reference
    adapter.stamp(solver as any);
    solver.reset();

    const dt = 1e-6;
    adapter.stampCompanion(dt, "trapezoidal", new Float64Array(0));

    // Trapezoidal: geq = 2*C/dt
    const C = CMOS_3V3.cIn;
    const geqExpected = (2 * C) / dt;
    expect(solver.sumStamp(NODE, NODE)).toBeCloseTo(geqExpected, 20);
  });
});
