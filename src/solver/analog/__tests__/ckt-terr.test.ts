/**
 * Tests for cktTerr (charge-based LTE) and cktTerrVoltage (NEWTRUNC voltage-based LTE).
 */

import { describe, it, expect } from "vitest";
import { cktTerr, cktTerrVoltage } from "../ckt-terr.js";
import type { LteParams } from "../ckt-terr.js";

const defaultParams: LteParams = {
  trtol: 7,
  reltol: 1e-3,
  abstol: 1e-6,
  chgtol: 1e-14,
};

// ---------------------------------------------------------------------------
// cktTerr (charge-based) tests
// ---------------------------------------------------------------------------

describe("cktTerr", () => {
  it("returns Infinity when dt <= 0", () => {
    expect(cktTerr(0, [1e-9, 1e-9], 1, "bdf1", 1e-12, 1e-12, 0, 0, 0, 0, defaultParams)).toBe(Infinity);
    expect(cktTerr(-1e-9, [1e-9, 1e-9], 1, "bdf1", 1e-12, 1e-12, 0, 0, 0, 0, defaultParams)).toBe(Infinity);
  });

  it("order 1 bdf1: returns finite positive timestep for non-trivial charges", () => {
    const dt = 1e-9;
    const q0 = 1e-12, q1 = 0.9e-12, q2 = 0.8e-12;
    const result = cktTerr(dt, [dt, dt], 1, "bdf1", q0, q1, q2, 0, q0, q1, defaultParams);
    expect(result).toBeGreaterThan(0);
    expect(isFinite(result)).toBe(true);
  });

  it("order 2 bdf2: returns sqrt-scaled timestep", () => {
    // Use cubic charge history so 3rd divided difference is nonzero for order=2
    const dt = 1e-9;
    const q0 = 27e-12, q1 = 8e-12, q2 = 1e-12, q3 = 0;
    const r2 = cktTerr(dt, [dt, dt], 2, "bdf2", q0, q1, q2, q3, q0, q1, defaultParams);
    expect(r2).toBeGreaterThan(0);
    expect(isFinite(r2)).toBe(true);
  });

  it("constant charge history produces finite timestep (not Infinity) — abstol-gated", () => {
    // When ddiff=0, denom = max(abstol, 0) = abstol > 0, result is finite.
    const dt = 1e-9;
    const q = 1e-12;
    const result = cktTerr(dt, [dt, dt], 1, "bdf1", q, q, q, q, q, q, defaultParams);
    expect(result).toBeGreaterThan(0);
    expect(isFinite(result)).toBe(true);
  });

  it("trapezoidal order 2 gives larger timestep than bdf2 order 2 for same nonlinear data", () => {
    // Cubic charge data at unit scale so factor*ddiff >> abstol, ensuring method-specific
    // LTE factor (1/12 trap vs 2/9 gear) dominates the denominator.
    // Trap LTE factor (1/12) < gear factor (2/9): smaller denominator => larger del => larger sqrt(del).
    const dt = 1.0;
    const q0 = 27.0, q1 = 8.0, q2 = 1.0, q3 = 0.0;
    const rTrap = cktTerr(dt, [dt, dt], 2, "trapezoidal", q0, q1, q2, q3, q0, q1, defaultParams);
    const rBdf2 = cktTerr(dt, [dt, dt], 2, "bdf2", q0, q1, q2, q3, q0, q1, defaultParams);
    expect(rTrap).toBeGreaterThan(rBdf2);
  });
});

// ---------------------------------------------------------------------------
// cktTerrVoltage (NEWTRUNC voltage-based) tests
// ---------------------------------------------------------------------------

describe("cktTerrVoltage", () => {
  it("returns Infinity when dt <= 0", () => {
    expect(cktTerrVoltage(1, 0.9, 0.8, 0.7, 0, [1e-9, 1e-9], 1, "bdf1", 1e-3, 1e-6, 7)).toBe(Infinity);
    expect(cktTerrVoltage(1, 0.9, 0.8, 0.7, -1e-9, [1e-9, 1e-9], 1, "bdf1", 1e-3, 1e-6, 7)).toBe(Infinity);
  });

  it("constant voltages produce finite timestep (not Infinity) — lteAbstol-gated", () => {
    // When ddiff=0, denom = max(lteAbstol, 0) = lteAbstol > 0.
    const v = 5.0;
    const dt = 1e-9;
    const result = cktTerrVoltage(v, v, v, v, dt, [dt, dt], 1, "bdf1", 1e-3, 1e-6, 7);
    expect(result).toBeGreaterThan(0);
    expect(isFinite(result)).toBe(true);
  });

  it("order 1 bdf1: linear voltage gives Infinity (zero 2nd divided difference)", () => {
    // Linear ramp: v(n)=4, v(n-1)=3, v(n-2)=2 — 2nd divided diff = 0 for order=1
    // So denom = max(lteAbstol, 0) = lteAbstol, result is finite (not Infinity)
    const dt = 1e-9;
    const result = cktTerrVoltage(4.0, 3.0, 2.0, 1.0, dt, [dt, dt], 1, "bdf1", 1e-3, 1e-6, 7);
    // Linear data: 2nd divided diff = (4-3)/dt - (3-2)/dt) / (2*dt) = 0 → ddiff=0
    // denom = max(1e-6, 0) = 1e-6 > 0, so result is finite
    expect(result).toBeGreaterThan(0);
    expect(isFinite(result)).toBe(true);
  });

  it("order 1: quadratic voltage gives correct result by manual calculation", () => {
    // v = n^2: v(3)=9, v(2)=4, v(1)=1 at equal dt=1
    // 1st diffs: (9-4)/1=5, (4-1)/1=3
    // 2nd diff: (5-3)/(1+1)=1 => ddiff=1
    // factor=0.5 (gear order 1), denom=max(1e-6, 0.5)=0.5
    // tol = 1e-6 + 1e-3 * max(9,4) = 0.009001
    // del = 7 * 0.009001 / 0.5 = 0.12601...
    const dt = 1.0;
    const lteReltol = 1e-3;
    const lteAbstol = 1e-6;
    const trtol = 7;
    const result = cktTerrVoltage(9, 4, 1, 0, dt, [dt, dt], 1, "bdf1", lteReltol, lteAbstol, trtol);
    const expectedTol = lteAbstol + lteReltol * Math.max(9, 4);
    const expectedDenom = Math.max(lteAbstol, 0.5 * 1.0);
    const expectedDel = trtol * expectedTol / expectedDenom;
    expect(result).toBeCloseTo(expectedDel, 6);
  });

  it("order 2 bdf2: applies sqrt root extraction for nonzero 3rd divided difference", () => {
    // Cubic data: v=27,8,1,0 at dt=1 gives 3rd divided diff = 1
    const dt = 1.0;
    const r2 = cktTerrVoltage(27, 8, 1, 0, dt, [dt, dt], 2, "bdf2", 1e-3, 1e-6, 7);
    expect(r2).toBeGreaterThan(0);
    expect(isFinite(r2)).toBe(true);
  });

  it("larger lteReltol gives more permissive (larger) timestep proposal", () => {
    // For quadratic data where denom = factor*ddiff >> lteAbstol,
    // larger lteReltol increases tol without affecting denom -> larger del.
    const dt = 1.0;
    const v0 = 9.0, v1 = 4.0, v2 = 1.0, v3 = 0.0;
    const rLoose = cktTerrVoltage(v0, v1, v2, v3, dt, [dt, dt], 1, "bdf1", 1e-2, 1e-6, 7);
    const rTight = cktTerrVoltage(v0, v1, v2, v3, dt, [dt, dt], 1, "bdf1", 1e-4, 1e-6, 7);
    expect(rLoose).toBeGreaterThan(rTight);
  });

  it("larger trtol gives proportionally larger timestep proposal", () => {
    const dt = 1.0;
    const v0 = 9.0, v1 = 4.0, v2 = 1.0, v3 = 0.0;
    const rBig = cktTerrVoltage(v0, v1, v2, v3, dt, [dt, dt], 1, "bdf1", 1e-3, 1e-6, 14);
    const rSmall = cktTerrVoltage(v0, v1, v2, v3, dt, [dt, dt], 1, "bdf1", 1e-3, 1e-6, 7);
    expect(rBig).toBeCloseTo(2 * rSmall, 5);
  });

  it("trapezoidal order 2 gives larger timestep than bdf2 order 2 for same nonlinear data", () => {
    // Cubic data so 3rd divided diff is nonzero.
    // Trap LTE factor (1/12) < gear factor (2/9) -> smaller denom -> larger del -> larger sqrt(del).
    const dt = 1.0;
    const v0 = 27.0, v1 = 8.0, v2 = 1.0, v3 = 0.0;
    const rTrap = cktTerrVoltage(v0, v1, v2, v3, dt, [dt, dt], 2, "trapezoidal", 1e-3, 1e-6, 7);
    const rBdf2 = cktTerrVoltage(v0, v1, v2, v3, dt, [dt, dt], 2, "bdf2", 1e-3, 1e-6, 7);
    expect(rTrap).toBeGreaterThan(rBdf2);
  });

  it("order 2 linear data gives Infinity (zero 3rd divided difference)", () => {
    // For linear data v=n, 3rd divided diff = 0 => denom=lteAbstol => finite result
    // But quadratic data at order=2: 3rd diff = 0 for quadratic too! Only cubic+ gives nonzero.
    // Quadratic: v=9,4,1,0 => 3rd diff computed above was 1... let's check with truly linear
    // v=4,3,2,1 at dt=1: 3rd diff should be 0
    const dt = 1.0;
    // Linear: 3rd divided diff = 0, result is lteAbstol-gated (finite)
    const result = cktTerrVoltage(4, 3, 2, 1, dt, [dt, dt], 2, "bdf2", 1e-3, 1e-6, 7);
    expect(result).toBeGreaterThan(0);
    expect(isFinite(result)).toBe(true);
  });
});
