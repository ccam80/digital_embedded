/**
 * Tests for DigitalOutputPinModel and DigitalInputPinModel.
 *
 * Task 1.1 — DigitalOutputPinModel (ideal voltage source):
 *  - drive mode stamps branch equation
 *  - hi-z mode stamps I=0
 *  - setLogicLevel toggles target voltage
 *  - loaded mode stamps rOut conductance
 *  - unloaded mode does not stamp rOut
 *  - setParam("rOut", 50) updates conductance on next stamp
 *  - setParam("vOH", 5.0) updates target voltage
 *
 * Task 1.2 — DigitalInputPinModel (sense-only + inline loading):
 *  - loaded input stamps rIn conductance
 *  - unloaded input stamps nothing
 *  - readLogicLevel thresholds correctly
 *  - setParam("rIn", 1e6) takes effect on next stamp
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  DigitalOutputPinModel,
  DigitalInputPinModel,
} from "../digital-pin-model.js";
import type { ResolvedPinElectrical } from "../../../core/pin-electrical.js";

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
// Shared test spec — CMOS 3.3V defaults
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

// ---------------------------------------------------------------------------
// DigitalOutputPinModel tests (Task 1.1)
// ---------------------------------------------------------------------------

describe("DigitalOutputPinModel", () => {
  // NODE = 1 → nodeIdx = 0 in the solver (0-based)
  // BRANCH = 4 → branchIdx = 4 in the augmented matrix (totalNodeCount + offset)
  const NODE = 1;
  const BRANCH = 4;
  const nodeIdx = NODE - 1; // 0
  const branchRow = BRANCH; // 4

  it("drive mode stamps branch equation", () => {
    const pin = new DigitalOutputPinModel(CMOS_3V3, false);
    pin.init(NODE, BRANCH);
    pin.setLogicLevel(true);
    const solver = new MockSolver();
    pin.stamp(solver as any);

    // branch eq: V_node coefficient → A[branchRow][nodeIdx] === 1
    expect(solver.sumStamp(branchRow, nodeIdx)).toBe(1);
    // branch eq RHS: z[branchRow] === vOH
    expect(solver.sumRhs(branchRow)).toBe(CMOS_3V3.vOH);
  });

  it("hi-z mode stamps I=0", () => {
    const pin = new DigitalOutputPinModel(CMOS_3V3, false);
    pin.init(NODE, BRANCH);
    pin.setHighZ(true);
    const solver = new MockSolver();
    pin.stamp(solver as any);

    // branch eq: I=0 → A[branchRow][branchRow] === 1
    expect(solver.sumStamp(branchRow, branchRow)).toBe(1);
    // branch eq RHS: z[branchRow] === 0
    expect(solver.sumRhs(branchRow)).toBe(0);
  });

  it("setLogicLevel toggles target voltage", () => {
    const pin = new DigitalOutputPinModel(CMOS_3V3, false);
    pin.init(NODE, BRANCH);

    pin.setLogicLevel(true);
    const solverHigh = new MockSolver();
    pin.stamp(solverHigh as any);
    expect(solverHigh.sumRhs(branchRow)).toBe(CMOS_3V3.vOH);

    pin.setLogicLevel(false);
    const solverLow = new MockSolver();
    pin.stamp(solverLow as any);
    expect(solverLow.sumRhs(branchRow)).toBe(CMOS_3V3.vOL);
  });

  it("loaded mode stamps rOut conductance", () => {
    const pin = new DigitalOutputPinModel(CMOS_3V3, true);
    pin.init(NODE, BRANCH);
    pin.setLogicLevel(false);
    const solver = new MockSolver();
    pin.stamp(solver as any);

    // A[nodeIdx][nodeIdx] must include 1/rOut
    expect(solver.sumStamp(nodeIdx, nodeIdx)).toBeCloseTo(
      1 / CMOS_3V3.rOut,
      10,
    );
  });

  it("unloaded mode does not stamp rOut", () => {
    const pin = new DigitalOutputPinModel(CMOS_3V3, false);
    pin.init(NODE, BRANCH);
    pin.setLogicLevel(false);
    const solver = new MockSolver();
    pin.stamp(solver as any);

    // A[nodeIdx][nodeIdx] must NOT include 1/rOut — sum should be 0
    expect(solver.sumStamp(nodeIdx, nodeIdx)).toBe(0);
  });

  it("setParam(rOut, 50) updates conductance on next stamp", () => {
    const pin = new DigitalOutputPinModel(CMOS_3V3, true);
    pin.init(NODE, BRANCH);
    pin.setLogicLevel(false);

    pin.setParam("rOut", 100);
    const solver = new MockSolver();
    pin.stamp(solver as any);

    expect(solver.sumStamp(nodeIdx, nodeIdx)).toBeCloseTo(1 / 100, 10);
  });

  it("setParam(vOH, 5.0) updates target voltage", () => {
    const pin = new DigitalOutputPinModel(CMOS_3V3, false);
    pin.init(NODE, BRANCH);
    pin.setLogicLevel(true);
    pin.setParam("vOH", 5.0);

    const solver = new MockSolver();
    pin.stamp(solver as any);

    expect(solver.sumRhs(branchRow)).toBe(5.0);
  });
});

// ---------------------------------------------------------------------------
// DigitalInputPinModel tests (Task 1.2)
// ---------------------------------------------------------------------------

describe("DigitalInputPinModel", () => {
  const NODE = 2;
  const nodeIdx = NODE - 1; // 1

  it("loaded input stamps rIn conductance", () => {
    const pin = new DigitalInputPinModel(CMOS_3V3, true);
    pin.init(NODE, 0);
    const solver = new MockSolver();
    pin.stamp(solver as any);

    expect(solver.sumStamp(nodeIdx, nodeIdx)).toBeCloseTo(
      1 / CMOS_3V3.rIn,
      15,
    );
  });

  it("unloaded input stamps nothing", () => {
    const pin = new DigitalInputPinModel(CMOS_3V3, false);
    pin.init(NODE, 0);
    const solver = new MockSolver();
    pin.stamp(solver as any);

    expect(solver.sumStamp(nodeIdx, nodeIdx)).toBe(0);
    expect(solver.stamps.length).toBe(0);
  });

  it("readLogicLevel thresholds correctly", () => {
    const pin = new DigitalInputPinModel(CMOS_3V3, false);
    pin.init(NODE, 0);

    // voltage > vIH → true
    expect(pin.readLogicLevel(CMOS_3V3.vIH + 0.1)).toBe(true);
    // voltage < vIL → false
    expect(pin.readLogicLevel(CMOS_3V3.vIL - 0.1)).toBe(false);
    // voltage between vIL and vIH → undefined
    expect(pin.readLogicLevel((CMOS_3V3.vIL + CMOS_3V3.vIH) / 2)).toBeUndefined();
  });

  it("setParam(rIn, 1e6) takes effect on next stamp", () => {
    const pin = new DigitalInputPinModel(CMOS_3V3, true);
    pin.init(NODE, 0);
    pin.setParam("rIn", 1e6);

    const solver = new MockSolver();
    pin.stamp(solver as any);

    expect(solver.sumStamp(nodeIdx, nodeIdx)).toBeCloseTo(1 / 1e6, 15);
  });
});
