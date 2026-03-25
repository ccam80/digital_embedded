/**
 * Tests for DigitalOutputPinModel and DigitalInputPinModel.
 *
 * Verifies:
 *  - Output pin stamps Norton equivalent (conductance + RHS current) in normal mode
 *  - Output pin stamps only 1/rHiZ conductance in Hi-Z mode
 *  - Switching between drive and Hi-Z changes stamp output
 *  - Companion model stamps correct capacitor conductance
 *  - Input pin stamps 1/rIn conductance
 *  - Threshold detection returns true/false/undefined correctly
 *  - Input companion model stamps correct capacitor conductance
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
// DigitalOutputPinModel tests
// ---------------------------------------------------------------------------

describe("OutputPin", () => {
  let solver: MockSolver;
  let pin: DigitalOutputPinModel;
  const NODE = 1;

  beforeEach(() => {
    solver = new MockSolver();
    pin = new DigitalOutputPinModel(CMOS_3V3);
    pin.init(NODE, -1);
  });

  it("stamps_norton_equivalent", () => {
    pin.setLogicLevel(true);
    pin.stamp(solver as any);

    // Conductance 1/rOut at (node-1, node-1) — MNA node IDs are 1-based
    const gOut = 1 / CMOS_3V3.rOut; // 1/50 = 0.02
    expect(solver.sumStamp(NODE - 1, NODE - 1)).toBeCloseTo(gOut, 10);

    // RHS current V_out/rOut = 3.3/50
    const expectedCurrent = CMOS_3V3.vOH / CMOS_3V3.rOut;
    expect(solver.sumRhs(NODE - 1)).toBeCloseTo(expectedCurrent, 10);
  });

  it("stamps_hiz_resistance", () => {
    pin.setHighZ(true);
    pin.stamp(solver as any);

    // Only 1/rHiZ conductance — no current source
    const gHiZ = 1 / CMOS_3V3.rHiZ;
    expect(solver.sumStamp(NODE - 1, NODE - 1)).toBeCloseTo(gHiZ, 15);
    expect(solver.rhs.length).toBe(0);
  });

  it("switches_between_drive_and_hiz", () => {
    // Drive mode: RHS present
    pin.setLogicLevel(false);
    pin.setHighZ(false);
    pin.stamp(solver as any);
    expect(solver.rhs.length).toBeGreaterThan(0);
    const driveG = solver.sumStamp(NODE - 1, NODE - 1);

    solver.reset();

    // Hi-Z mode: no RHS, different conductance
    pin.setHighZ(true);
    pin.stamp(solver as any);
    expect(solver.rhs.length).toBe(0);
    const hizG = solver.sumStamp(NODE - 1, NODE - 1);

    expect(driveG).not.toBeCloseTo(hizG, 6);

    solver.reset();

    // Back to drive mode
    pin.setHighZ(false);
    pin.stamp(solver as any);
    expect(solver.rhs.length).toBeGreaterThan(0);
    expect(solver.sumStamp(NODE - 1, NODE - 1)).toBeCloseTo(driveG, 10);
  });

  it("companion_stamps_capacitance", () => {
    const dt = 1e-6;
    pin.stampCompanion(solver as any, dt, "trapezoidal");

    // Trapezoidal: geq = 2*C/dt
    const C = CMOS_3V3.cOut;
    const geqExpected = (2 * C) / dt;
    expect(solver.sumStamp(NODE - 1, NODE - 1)).toBeCloseTo(geqExpected, 20);
  });

  it("nodeId_reflects_init", () => {
    expect(pin.nodeId).toBe(NODE);
  });

  it("currentVoltage_reflects_logic_level", () => {
    pin.setLogicLevel(true);
    expect(pin.currentVoltage).toBe(CMOS_3V3.vOH);

    pin.setLogicLevel(false);
    expect(pin.currentVoltage).toBe(CMOS_3V3.vOL);
  });

  it("isHiZ_reflects_state", () => {
    expect(pin.isHiZ).toBe(false);
    pin.setHighZ(true);
    expect(pin.isHiZ).toBe(true);
    pin.setHighZ(false);
    expect(pin.isHiZ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DigitalInputPinModel tests
// ---------------------------------------------------------------------------

describe("InputPin", () => {
  let solver: MockSolver;
  let pin: DigitalInputPinModel;
  const NODE = 2;

  beforeEach(() => {
    solver = new MockSolver();
    pin = new DigitalInputPinModel(CMOS_3V3);
    pin.init(NODE, 0);
  });

  it("stamps_input_resistance", () => {
    pin.stamp(solver as any);

    const gIn = 1 / CMOS_3V3.rIn; // 1e-7
    expect(solver.sumStamp(NODE - 1, NODE - 1)).toBeCloseTo(gIn, 15);
  });

  it("threshold_detection_high", () => {
    // 3.0V > vIH (2.0V) → true
    expect(pin.readLogicLevel(3.0)).toBe(true);
  });

  it("threshold_detection_low", () => {
    // 0.5V < vIL (0.8V) → false
    expect(pin.readLogicLevel(0.5)).toBe(false);
  });

  it("threshold_detection_indeterminate", () => {
    // 1.5V is between vIL (0.8V) and vIH (2.0V) → undefined
    expect(pin.readLogicLevel(1.5)).toBeUndefined();
  });

  it("threshold_boundary_exactly_at_vIH", () => {
    // voltage exactly at vIH is NOT strictly greater — indeterminate
    expect(pin.readLogicLevel(CMOS_3V3.vIH)).toBeUndefined();
  });

  it("threshold_boundary_just_above_vIH", () => {
    expect(pin.readLogicLevel(CMOS_3V3.vIH + 1e-9)).toBe(true);
  });

  it("threshold_boundary_exactly_at_vIL", () => {
    // voltage exactly at vIL is NOT strictly less — indeterminate
    expect(pin.readLogicLevel(CMOS_3V3.vIL)).toBeUndefined();
  });

  it("threshold_boundary_just_below_vIL", () => {
    expect(pin.readLogicLevel(CMOS_3V3.vIL - 1e-9)).toBe(false);
  });

  it("companion_stamps_capacitance", () => {
    const dt = 1e-6;
    pin.stampCompanion(solver as any, dt, "trapezoidal");

    // Trapezoidal: geq = 2*C/dt
    const C = CMOS_3V3.cIn;
    const geqExpected = (2 * C) / dt;
    expect(solver.sumStamp(NODE - 1, NODE - 1)).toBeCloseTo(geqExpected, 20);
  });

  it("companion_bdf1_stamps_correct_conductance", () => {
    const dt = 1e-9;
    pin.stampCompanion(solver as any, dt, "bdf1");

    const C = CMOS_3V3.cIn;
    const geqExpected = C / dt; // BDF-1: C/h
    expect(solver.sumStamp(NODE - 1, NODE - 1)).toBeCloseTo(geqExpected, 10);
  });

  it("companion_bdf2_stamps_correct_conductance", () => {
    const dt = 1e-9;
    pin.stampCompanion(solver as any, dt, "bdf2");

    const C = CMOS_3V3.cIn;
    const geqExpected = (3 * C) / (2 * dt); // BDF-2: 3C/2h
    expect(solver.sumStamp(NODE - 1, NODE - 1)).toBeCloseTo(geqExpected, 10);
  });

  it("nodeId_reflects_init", () => {
    expect(pin.nodeId).toBe(NODE);
  });
});
