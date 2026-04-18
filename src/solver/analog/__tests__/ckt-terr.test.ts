/**
 * Tests for cktTerr (charge-based LTE) and cktTerrVoltage (NEWTRUNC voltage-based LTE).
 */

import { describe, it, expect } from "vitest";
import { cktTerr, cktTerrVoltage, GEAR_LTE_FACTORS, __testHooks } from "../ckt-terr.js";
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

    // NGSPICE_REF: ngspice cktterr.c CKTterr, order=1 GEAR (BDF-1) path.
    // Divided difference (2nd) -> tolerance -> del = trtol*tol/max(abstol, factor*ddiff)
    // -> GEAR order 1 takes sqrt(del).
    const h0 = dt, h1 = dt;
    let d0 = q0, d1 = q1, d2 = q2;
    d0 = (d0 - d1) / h0;
    d1 = (d1 - d2) / h1;
    const dt0 = h1 + h0;
    d0 = (d0 - d1) / dt0;
    const ddiff = Math.abs(d0);
    const volttol = defaultParams.abstol + defaultParams.reltol * Math.max(Math.abs(q0), Math.abs(q1));
    const chargetolRaw = defaultParams.reltol * Math.max(Math.max(Math.abs(q0), Math.abs(q1)), defaultParams.chgtol);
    const chargetol = chargetolRaw / dt;
    const tol = Math.max(volttol, chargetol);
    const factor = 0.5; // GEAR_LTE_FACTORS[0]
    const denom = Math.max(defaultParams.abstol, factor * ddiff);
    const del = defaultParams.trtol * tol / denom;
    const NGSPICE_REF = Math.sqrt(del);

    expect(result).toBe(NGSPICE_REF);
  });

  it("order 2 bdf2: returns sqrt-scaled timestep", () => {
    // Use cubic charge history so 3rd divided difference is nonzero for order=2
    const dt = 1e-9;
    const q0 = 27e-12, q1 = 8e-12, q2 = 1e-12, q3 = 0;
    const r2 = cktTerr(dt, [dt, dt], 2, "bdf2", q0, q1, q2, q3, q0, q1, defaultParams);

    // NGSPICE_REF: ngspice cktterr.c CKTterr, order=2 GEAR (BDF-2) path.
    // 3rd divided difference -> tol -> del -> root via exp(log(del)/(order+1)).
    const h0 = dt, h1 = dt, h2 = dt;
    let d0 = q0, d1 = q1, d2 = q2, d3 = q3;
    d0 = (d0 - d1) / h0;
    d1 = (d1 - d2) / h1;
    d2 = (d2 - d3) / h2;
    let dt0 = h1 + h0, dt1 = h2 + h1;
    d0 = (d0 - d1) / dt0;
    d1 = (d1 - d2) / dt1;
    dt0 = dt1 + h0;
    d0 = (d0 - d1) / dt0;
    const ddiff = Math.abs(d0);
    const volttol = defaultParams.abstol + defaultParams.reltol * Math.max(Math.abs(q0), Math.abs(q1));
    const chargetolRaw = defaultParams.reltol * Math.max(Math.max(Math.abs(q0), Math.abs(q1)), defaultParams.chgtol);
    const chargetol = chargetolRaw / dt;
    const tol = Math.max(volttol, chargetol);
    const factor = 2 / 9; // GEAR_LTE_FACTORS[1]
    const denom = Math.max(defaultParams.abstol, factor * ddiff);
    const del = defaultParams.trtol * tol / denom;
    const NGSPICE_REF = Math.exp(Math.log(del) / (2 + 1));

    expect(r2).toBe(NGSPICE_REF);
  });

  it("constant charge history produces finite timestep (not Infinity) — abstol-gated", () => {
    // When ddiff=0, TRAP returns Infinity; GEAR returns sqrt(abstol-gated del)
    const dt = 1e-9;
    const q = 1e-12;
    const result = cktTerr(dt, [dt, dt], 1, "bdf1", q, q, q, q, q, q, defaultParams);

    // NGSPICE_REF: ngspice cktterr.c CKTterr, order=1 GEAR, ddiff=0 case.
    // Constant Q -> 2nd divided difference = 0 -> denom clamps to abstol ->
    // del = trtol*tol/abstol -> sqrt(del) for GEAR order 1.
    const volttol = defaultParams.abstol + defaultParams.reltol * Math.max(Math.abs(q), Math.abs(q));
    const chargetolRaw = defaultParams.reltol * Math.max(Math.max(Math.abs(q), Math.abs(q)), defaultParams.chgtol);
    const chargetol = chargetolRaw / dt;
    const tol = Math.max(volttol, chargetol);
    const denom = defaultParams.abstol; // max(abstol, 0.5 * 0) = abstol
    const del = defaultParams.trtol * tol / denom;
    const NGSPICE_REF = Math.sqrt(del);

    expect(result).toBe(NGSPICE_REF);
  });

  it("bdf2 order 2 returns positive finite timestep for cubic charge data", () => {
    // TRAP order 2 and BDF2 order 2 use different formula families.
    // Both must return a positive finite timestep for nonlinear input data.
    const dt = 1.0;
    const q0 = 27.0, q1 = 8.0, q2 = 1.0, q3 = 0.0;
    const rTrap = cktTerr(dt, [dt, dt], 2, "trapezoidal", q0, q1, q2, q3, q0, q1, defaultParams);
    const rBdf2 = cktTerr(dt, [dt, dt], 2, "bdf2", q0, q1, q2, q3, q0, q1, defaultParams);

    // Shared divided-difference bookkeeping (ngspice cktterr.c:43-59 order=2).
    const h0 = dt, h1 = dt, h2 = dt;
    let d0 = q0, d1 = q1, d2 = q2, d3 = q3;
    d0 = (d0 - d1) / h0;
    d1 = (d1 - d2) / h1;
    d2 = (d2 - d3) / h2;
    let dt0 = h1 + h0, dt1 = h2 + h1;
    d0 = (d0 - d1) / dt0;
    d1 = (d1 - d2) / dt1;
    dt0 = dt1 + h0;
    const diffSigned = (d0 - d1) / dt0; // signed 3rd divided difference (TRAP order-2 uses signed form)
    const ddiff = Math.abs(diffSigned);
    const volttol = defaultParams.abstol + defaultParams.reltol * Math.max(Math.abs(q0), Math.abs(q1));
    const chargetolRaw = defaultParams.reltol * Math.max(Math.max(Math.abs(q0), Math.abs(q1)), defaultParams.chgtol);
    const chargetol = chargetolRaw / dt;
    const tol = Math.max(volttol, chargetol);

    // NGSPICE_REF_TRAP: ngspice cktterr.c TRAP order 2:
    //   del = |deltaOld[0] * trtol * tol * 3 * (deltaOld[0]+deltaOld[1]) / diff|
    const d0old = dt, d1old = dt;
    const NGSPICE_REF_TRAP = Math.abs(d0old * defaultParams.trtol * tol * 3 * (d0old + d1old) / diffSigned);

    // NGSPICE_REF_BDF2: ngspice cktterr.c GEAR order 2:
    //   del = trtol*tol/max(abstol, factor*ddiff); result = exp(log(del)/(order+1))
    const factor = 2 / 9; // GEAR_LTE_FACTORS[1]
    const denom = Math.max(defaultParams.abstol, factor * ddiff);
    const del = defaultParams.trtol * tol / denom;
    const NGSPICE_REF_BDF2 = Math.exp(Math.log(del) / (2 + 1));

    expect(rTrap).toBe(NGSPICE_REF_TRAP);
    expect(rBdf2).toBe(NGSPICE_REF_BDF2);
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
    // GEAR: denom = max(lteAbstol, 0) = lteAbstol > 0, del > 0, sqrt > 0
    const v = 5.0;
    const dt = 1e-9;
    const lteReltol = 1e-3, lteAbstol = 1e-6, trtol = 7;
    const result = cktTerrVoltage(v, v, v, v, dt, [dt, dt], 1, "bdf1", lteReltol, lteAbstol, trtol);

    // NGSPICE_REF: ngspice ckttrunc.c NEWTRUNC GEAR order 1, ddiff=0 case.
    //   tol = lteAbstol + lteReltol * max(|vNow|,|v1|)
    //   delsum = deltaOld[0] + deltaOld[1]  (i from 0 to order inclusive, deltaOld.length=2)
    //   denom = max(lteAbstol, factor*ddiff) = lteAbstol (since ddiff=0)
    //   tmp   = (tol*trtol*delsum) / (denom*delta)
    //   result = delta * sqrt(tmp)
    const tol = lteAbstol + lteReltol * Math.max(Math.abs(v), Math.abs(v));
    const delsum = dt + dt; // deltaOld=[dt,dt], order=1 -> sum i=0..1
    const denom = lteAbstol;
    const tmp = (tol * trtol * delsum) / (denom * dt);
    const NGSPICE_REF = dt * Math.sqrt(tmp);

    expect(result).toBe(NGSPICE_REF);
  });

  it("order 1 bdf1: linear voltage gives finite (lteAbstol-gated) result", () => {
    // Linear ramp: 2nd divided diff = 0 for order=1; GEAR returns sqrt(del) where del>0
    const dt = 1e-9;
    const vNow = 4.0, v1 = 3.0, v2 = 2.0, v3 = 1.0;
    const lteReltol = 1e-3, lteAbstol = 1e-6, trtol = 7;
    const result = cktTerrVoltage(vNow, v1, v2, v3, dt, [dt, dt], 1, "bdf1", lteReltol, lteAbstol, trtol);

    // NGSPICE_REF: ngspice ckttrunc.c NEWTRUNC GEAR order 1.
    // For a strictly linear ramp, the 2nd divided difference is 0; denom clamps to lteAbstol.
    const h0 = dt, h1 = dt;
    let d0 = vNow, d1 = v1, d2 = v2;
    d0 = (d0 - d1) / h0;
    d1 = (d1 - d2) / h1;
    const dt0 = h1 + h0;
    d0 = (d0 - d1) / dt0;
    const ddiff = Math.abs(d0);
    const tol = lteAbstol + lteReltol * Math.max(Math.abs(vNow), Math.abs(v1));
    const factor = 0.5; // GEAR_LTE_FACTORS[0]
    const denom = Math.max(lteAbstol, factor * ddiff);
    const delsum = dt + dt; // deltaOld=[dt,dt], order=1 -> sum i=0..1
    const tmp = (tol * trtol * delsum) / (denom * dt);
    const NGSPICE_REF = dt * Math.sqrt(tmp);

    expect(result).toBe(NGSPICE_REF);
  });

  it("order 2 bdf2: applies sqrt root extraction for nonzero 3rd divided difference", () => {
    // Cubic data: v=27,8,1,0 at dt=1 gives 3rd divided diff = 1
    const dt = 1.0;
    const vNow = 27, v1 = 8, v2 = 1, v3 = 0;
    const lteReltol = 1e-3, lteAbstol = 1e-6, trtol = 7;
    const r2 = cktTerrVoltage(vNow, v1, v2, v3, dt, [dt, dt], 2, "bdf2", lteReltol, lteAbstol, trtol);

    // NGSPICE_REF: ngspice ckttrunc.c NEWTRUNC GEAR order 2.
    //   result = delta * exp(log(tmp) / (order+1))
    const h0 = dt, h1 = dt, h2 = dt;
    let d0 = vNow, d1 = v1, d2 = v2, d3 = v3;
    d0 = (d0 - d1) / h0;
    d1 = (d1 - d2) / h1;
    d2 = (d2 - d3) / h2;
    let dt0 = h1 + h0, dt1 = h2 + h1;
    d0 = (d0 - d1) / dt0;
    d1 = (d1 - d2) / dt1;
    dt0 = dt1 + h0;
    d0 = (d0 - d1) / dt0;
    const ddiff = Math.abs(d0);
    const tol = lteAbstol + lteReltol * Math.max(Math.abs(vNow), Math.abs(v1));
    const factor = 2 / 9; // GEAR_LTE_FACTORS[1]
    const denom = Math.max(lteAbstol, factor * ddiff);
    // deltaOld=[dt,dt], order=2 -> sum i=0..2 but deltaOld.length=2 so only i=0,1
    const delsum = dt + dt;
    const tmp = (tol * trtol * delsum) / (denom * dt);
    const NGSPICE_REF = dt * Math.exp(Math.log(tmp) / (2 + 1));

    expect(r2).toBe(NGSPICE_REF);
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
    // For GEAR, result = delta * sqrt(tmp) where tmp is linear in trtol.
    // Doubling trtol doubles tmp, so sqrt doubles... actually sqrt(2*tmp) = sqrt(2)*sqrt(tmp),
    // not exactly 2x. But the comparison still holds: bigger trtol -> bigger result.
    const dt = 1.0;
    const v0 = 9.0, v1 = 4.0, v2 = 1.0, v3 = 0.0;
    const rBig = cktTerrVoltage(v0, v1, v2, v3, dt, [dt, dt], 1, "bdf1", 1e-3, 1e-6, 14);
    const rSmall = cktTerrVoltage(v0, v1, v2, v3, dt, [dt, dt], 1, "bdf1", 1e-3, 1e-6, 7);
    expect(rBig).toBeGreaterThan(rSmall);
  });

  it("trapezoidal order 2 and bdf2 order 2 both return positive finite timestep for cubic data", () => {
    // TRAP order 2 and BDF2 order 2 use different formula families.
    // Both must return a positive finite timestep for nonlinear input data.
    const dt = 1.0;
    const v0 = 27.0, v1 = 8.0, v2 = 1.0, v3 = 0.0;
    const lteReltol = 1e-3, lteAbstol = 1e-6, trtol = 7;
    const rTrap = cktTerrVoltage(v0, v1, v2, v3, dt, [dt, dt], 2, "trapezoidal", lteReltol, lteAbstol, trtol);
    const rBdf2 = cktTerrVoltage(v0, v1, v2, v3, dt, [dt, dt], 2, "bdf2", lteReltol, lteAbstol, trtol);

    // Shared divided-difference (ngspice ckttrunc.c NEWTRUNC, order=2).
    const h0 = dt, h1 = dt, h2 = dt;
    let d0 = v0, d1 = v1, d2 = v2, d3 = v3;
    d0 = (d0 - d1) / h0;
    d1 = (d1 - d2) / h1;
    d2 = (d2 - d3) / h2;
    let dt0 = h1 + h0, dt1 = h2 + h1;
    d0 = (d0 - d1) / dt0;
    d1 = (d1 - d2) / dt1;
    dt0 = dt1 + h0;
    const diffSigned = (d0 - d1) / dt0; // signed 3rd divided difference
    const ddiff = Math.abs(diffSigned);
    const tol = lteAbstol + lteReltol * Math.max(Math.abs(v0), Math.abs(v1));

    // NGSPICE_REF_TRAP: ngspice ckttrunc.c NEWTRUNC TRAP order 2:
    //   del = |deltaOld[0] * trtol * tol * 3 * (deltaOld[0]+deltaOld[1]) / diff|
    const d0old = dt, d1old = dt;
    const NGSPICE_REF_TRAP = Math.abs(d0old * trtol * tol * 3 * (d0old + d1old) / diffSigned);

    // NGSPICE_REF_BDF2: ngspice ckttrunc.c NEWTRUNC GEAR order 2.
    const factor = 2 / 9; // GEAR_LTE_FACTORS[1]
    const denom = Math.max(lteAbstol, factor * ddiff);
    const delsum = dt + dt; // deltaOld=[dt,dt], order=2 but deltaOld.length=2
    const tmp = (tol * trtol * delsum) / (denom * dt);
    const NGSPICE_REF_BDF2 = dt * Math.exp(Math.log(tmp) / (2 + 1));

    expect(rTrap).toBe(NGSPICE_REF_TRAP);
    expect(rBdf2).toBe(NGSPICE_REF_BDF2);
  });

  it("order 2 linear data gives finite timestep (lteAbstol-gated)", () => {
    const dt = 1.0;
    const vNow = 4, v1 = 3, v2 = 2, v3 = 1;
    const lteReltol = 1e-3, lteAbstol = 1e-6, trtol = 7;
    const result = cktTerrVoltage(vNow, v1, v2, v3, dt, [dt, dt], 2, "bdf2", lteReltol, lteAbstol, trtol);

    // NGSPICE_REF: ngspice ckttrunc.c NEWTRUNC GEAR order 2.
    // Linear ramp -> 3rd divided difference = 0 -> denom clamps to lteAbstol.
    const h0 = dt, h1 = dt, h2 = dt;
    let d0 = vNow, d1 = v1, d2 = v2, d3 = v3;
    d0 = (d0 - d1) / h0;
    d1 = (d1 - d2) / h1;
    d2 = (d2 - d3) / h2;
    let dt0 = h1 + h0, dt1 = h2 + h1;
    d0 = (d0 - d1) / dt0;
    d1 = (d1 - d2) / dt1;
    dt0 = dt1 + h0;
    d0 = (d0 - d1) / dt0;
    const ddiff = Math.abs(d0);
    const tol = lteAbstol + lteReltol * Math.max(Math.abs(vNow), Math.abs(v1));
    const factor = 2 / 9; // GEAR_LTE_FACTORS[1]
    const denom = Math.max(lteAbstol, factor * ddiff);
    const delsum = dt + dt; // deltaOld=[dt,dt], order=2 but length=2
    const tmp = (tol * trtol * delsum) / (denom * dt);
    const NGSPICE_REF = dt * Math.exp(Math.log(tmp) / (2 + 1));

    expect(result).toBe(NGSPICE_REF);
  });
});

// ---------------------------------------------------------------------------
// Task 1.2.3 — zero_allocations_in_lte_path
// ---------------------------------------------------------------------------

describe("zero_allocations_in_lte_path", () => {
  it("zero_allocations_in_lte_path", () => {
    const RealF64 = Float64Array;
    const RealArray = Array;
    let f64Count = 0;
    let arrayCount = 0;

    (globalThis as unknown as Record<string, unknown>)["Float64Array"] = new Proxy(RealF64, {
      construct(target, args) {
        f64Count++;
        return new target(...(args as ConstructorParameters<typeof Float64Array>));
      },
    });
    (globalThis as unknown as Record<string, unknown>)["Array"] = new Proxy(RealArray, {
      construct(target, args) {
        arrayCount++;
        return new target(...(args as ConstructorParameters<typeof Array>));
      },
    });

    const dt = 1e-9;
    const deltaOld = new RealF64([dt, dt, dt]);
    const params: LteParams = { trtol: 7, reltol: 1e-3, abstol: 1e-6, chgtol: 1e-14 };

    // Warm up — first call may trigger internal initialisation not counted.
    cktTerr(dt, deltaOld, 1, "bdf1", 1e-12, 0.9e-12, 0.8e-12, 0, 1e-12, 0.9e-12, params);
    cktTerrVoltage(5.0, 4.9, 4.8, 4.7, dt, deltaOld, 1, "bdf1", 1e-3, 1e-6, 7);

    // Reset counters after warmup.
    f64Count = 0;
    arrayCount = 0;

    // Run 100 LTE evaluations across orders 1 and 2, charge-based and voltage-based.
    for (let i = 0; i < 50; i++) {
      const q = 1e-12 * (1 + i * 0.01);
      cktTerr(dt, deltaOld, 1, "bdf1", q, q * 0.99, q * 0.98, 0, q, q * 0.99, params);
      cktTerr(dt, deltaOld, 2, "bdf2", q, q * 0.99, q * 0.98, q * 0.97, q, q * 0.99, params);
      cktTerrVoltage(5 + i * 0.001, 4.9, 4.8, 4.7, dt, deltaOld, 1, "bdf1", 1e-3, 1e-6, 7);
      cktTerrVoltage(5 + i * 0.001, 4.9, 4.8, 4.7, dt, deltaOld, 2, "bdf2", 1e-3, 1e-6, 7);
    }

    (globalThis as unknown as Record<string, unknown>)["Float64Array"] = RealF64;
    (globalThis as unknown as Record<string, unknown>)["Array"] = RealArray;

    expect(f64Count).toBe(0);
    expect(arrayCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Task 3.1.1 — chargetol_includes_chgtol_in_reltol_scaling (Bug C1)
// ---------------------------------------------------------------------------

describe("chargetol_formula", () => {
  it("chargetol_includes_chgtol_in_reltol_scaling", () => {
    // q0=q1=1e-16, chgtol=1e-14: new formula puts chgtol inside reltol scaling
    // new:  reltol * max(max(|q0|,|q1|), chgtol) = 1e-3 * max(1e-16, 1e-14) = 1e-3 * 1e-14 = 1e-17
    // old:  max(reltol * max(|q0|,|q1|), chgtol) = max(1e-3*1e-16, 1e-14) = max(1e-19, 1e-14) = 1e-14
    const params: LteParams = {
      trtol: 7,
      reltol: 1e-3,
      abstol: 1e-12,
      chgtol: 1e-14,
    };
    cktTerr(
      1e-9,
      [1e-9, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9],
      1,
      "trapezoidal",
      1e-16,   // q0
      1e-16,   // q1
      1e-16,   // q2
      1e-16,   // q3
      1e-10,   // ccap0
      1e-10,   // ccap1
      params,
    );
    // The corrected formula: reltol * MAX(MAX(|q0|,|q1|), chgtol)
    const expected = 1e-3 * Math.max(Math.max(1e-16, 1e-16), 1e-14);
    expect(expected).toBe(1e-17); // confirm reference is exactly 1e-17
    expect(__testHooks.lastChargetol).toBe(expected); // bit-exact
    // Old formula would have produced 1e-14
    const oldFormula = Math.max(1e-3 * Math.max(1e-16, 1e-16), 1e-14);
    expect(oldFormula).toBe(1e-14);
    expect(__testHooks.lastChargetol).not.toBe(oldFormula);
  });
});

// ---------------------------------------------------------------------------
// Task 3.1.2 — GEAR LTE factor selection (Bug C2)
// ---------------------------------------------------------------------------

describe("gear_lte_factor_selection", () => {
  it("gear_lte_factor_order_3", () => {
    // GEAR order 3 must use factor 3/22, not 2/9 (the old order-2 factor)
    // GEAR_LTE_FACTORS[2] = 3/22
    expect(GEAR_LTE_FACTORS[2]).toBe(3 / 22);

    // Verify by comparing outputs: order 3 with factor 3/22 vs the old factor 2/9
    // With nonlinear charges, larger factor → smaller del → smaller result
    const dt = 1e-6;
    const q0 = 27e-12, q1 = 8e-12, q2 = 1e-12, q3 = 0;
    const params: LteParams = { trtol: 7, reltol: 1e-3, abstol: 1e-12, chgtol: 1e-14 };
    const resultOrder3 = cktTerr(dt, [dt, dt, dt], 3, "bdf2", q0, q1, q2, q3, q0, q1, params);

    // Reference using correct factor 3/22 for order 3
    // Compute ddiff for order=2 path (order=3 also uses order=2 divide-diff since only unrolled for 1,2)
    // The function falls into order=2 branch (else) for order=3
    const h0 = dt, h1 = dt, h2 = dt;
    let d0 = q0, d1 = q1, d2 = q2, d3 = q3;
    d0 = (d0 - d1) / h0;
    d1 = (d1 - d2) / h1;
    d2 = (d2 - d3) / h2;
    let dt0 = h1 + h0, dt1 = h2 + h1;
    d0 = (d0 - d1) / dt0;
    d1 = (d1 - d2) / dt1;
    dt0 = dt1 + h0;
    d0 = (d0 - d1) / dt0;
    const ddiff = Math.abs(d0);
    const volttol = 1e-12 + 1e-3 * Math.max(q0, q1);
    const chargetolRaw = 1e-3 * Math.max(Math.max(q0, q1), 1e-14);
    const chargetol = chargetolRaw / dt;
    const tol = Math.max(volttol, chargetol);
    const factor = 3 / 22; // correct GEAR order 3 factor
    const denom = Math.max(1e-12, factor * ddiff);
    const del = 7 * tol / denom;
    const expectedOrder3 = Math.exp(Math.log(del) / (3 + 1)); // order+1=4
    expect(resultOrder3).toBe(expectedOrder3);
  });

  it("gear_lte_factor_order_5", () => {
    // GEAR order 5 must use factor 10/137 (ngspice cktterr.c gearCoeff[4])
    // Repo cross-reference: spec/state-machines/ngspice-cktterr-vs-ckt-terr.md row 47
    expect(GEAR_LTE_FACTORS[4]).toBe(10 / 137);

    const dt = 1e-6;
    const q0 = 27e-12, q1 = 8e-12, q2 = 1e-12, q3 = 0;
    const params: LteParams = { trtol: 7, reltol: 1e-3, abstol: 1e-12, chgtol: 1e-14 };
    const resultOrder5 = cktTerr(dt, [dt, dt, dt, dt, dt], 5, "bdf2", q0, q1, q2, q3, q0, q1, params);

    // Reference using correct factor 10/137 for order 5 (order>=2 uses the same
    // order-2 divided-difference path; only the factor and root index differ).
    const h0 = dt, h1 = dt, h2 = dt;
    let d0 = q0, d1 = q1, d2 = q2, d3 = q3;
    d0 = (d0 - d1) / h0;
    d1 = (d1 - d2) / h1;
    d2 = (d2 - d3) / h2;
    let dt0 = h1 + h0, dt1 = h2 + h1;
    d0 = (d0 - d1) / dt0;
    d1 = (d1 - d2) / dt1;
    dt0 = dt1 + h0;
    d0 = (d0 - d1) / dt0;
    const ddiff = Math.abs(d0);
    const volttol = 1e-12 + 1e-3 * Math.max(q0, q1);
    const chargetolRaw = 1e-3 * Math.max(Math.max(q0, q1), 1e-14);
    const chargetol = chargetolRaw / dt;
    const tol = Math.max(volttol, chargetol);
    const factor = 10 / 137; // correct GEAR order 5 factor
    const denom = Math.max(1e-12, factor * ddiff);
    const del = 7 * tol / denom;
    const expectedOrder5 = Math.exp(Math.log(del) / (5 + 1)); // order+1=6
    expect(resultOrder5).toBe(expectedOrder5);

    // Regression guard against the incorrect 5/72 value.
    expect(GEAR_LTE_FACTORS[4]).not.toBe(5 / 72);
  });

  it("gear_lte_factor_order_6", () => {
    // GEAR order 6 must use factor 20/343
    expect(GEAR_LTE_FACTORS[5]).toBe(20 / 343);

    const dt = 1e-6;
    const q0 = 27e-12, q1 = 8e-12, q2 = 1e-12, q3 = 0;
    const params: LteParams = { trtol: 7, reltol: 1e-3, abstol: 1e-12, chgtol: 1e-14 };
    const resultOrder6 = cktTerr(dt, [dt, dt, dt, dt, dt], 6, "bdf2", q0, q1, q2, q3, q0, q1, params);

    // Bit-exact reference for order 6.
    const h0 = dt, h1 = dt, h2 = dt;
    let d0 = q0, d1 = q1, d2 = q2, d3 = q3;
    d0 = (d0 - d1) / h0;
    d1 = (d1 - d2) / h1;
    d2 = (d2 - d3) / h2;
    let dt0 = h1 + h0, dt1 = h2 + h1;
    d0 = (d0 - d1) / dt0;
    d1 = (d1 - d2) / dt1;
    dt0 = dt1 + h0;
    d0 = (d0 - d1) / dt0;
    const ddiff = Math.abs(d0);
    const volttol = 1e-12 + 1e-3 * Math.max(q0, q1);
    const chargetolRaw = 1e-3 * Math.max(Math.max(q0, q1), 1e-14);
    const chargetol = chargetolRaw / dt;
    const tol = Math.max(volttol, chargetol);
    const factor = 20 / 343;
    const denom = Math.max(1e-12, factor * ddiff);
    const del = 7 * tol / denom;
    const expectedOrder6 = Math.exp(Math.log(del) / (6 + 1));
    expect(resultOrder6).toBe(expectedOrder6);
  });
});

// ---------------------------------------------------------------------------
// Task 3.1.3 — V3/V4/V5/V6 formula fixes
// ---------------------------------------------------------------------------

describe("cktTerr_formula_fixes", () => {
  it("cktTerr_trap_order1_matches_ngspice", () => {
    // V3: TRAP order 1 formula: del = deltaOld[0] * sqrt(trtol * tol * 2 / ddiff)
    // Inputs chosen so ddiff is nonzero (nonlinear charge history)
    const dt = 1e-6;
    const deltaOld = [1e-6, 1e-6, 1e-6, 1e-6, 1e-6, 1e-6, 1e-6];
    const q0 = 1e-12, q1 = 0.8e-12, q2 = 0.5e-12, q3 = 0;
    const ccap0 = 1e-10, ccap1 = 0.8e-10;
    const params: LteParams = { trtol: 7, reltol: 1e-3, abstol: 1e-12, chgtol: 1e-14 };

    // Compute reference inline from corrected ngspice formula
    const h0 = dt, h1 = deltaOld[1];
    let d0 = q0, d1 = q1, d2 = q2;
    d0 = (d0 - d1) / h0;
    d1 = (d1 - d2) / h1;
    const dt0ref = h1 + h0;
    d0 = (d0 - d1) / dt0ref;
    const ddiff = Math.abs(d0);
    const chargetolRaw = 1e-3 * Math.max(Math.max(Math.abs(q0), Math.abs(q1)), 1e-14);
    const chargetol = chargetolRaw / dt;
    const volttol = 1e-12 + 1e-3 * Math.max(Math.abs(ccap0), Math.abs(ccap1));
    const tol = Math.max(volttol, chargetol);
    const d0ref = deltaOld[0];
    // ngspice cktterr.c TRAP order 1: del = deltaOld[0] * sqrt(trtol * tol * 2 / ddiff)
    const reference = d0ref * Math.sqrt(7 * tol * 2 / ddiff);

    const result = cktTerr(dt, deltaOld, 1, "trapezoidal", q0, q1, q2, q3, ccap0, ccap1, params);
    expect(result).toBe(reference); // bit-exact IEEE-754
  });

  it("cktTerr_trap_order2_matches_ngspice", () => {
    // V4: TRAP order 2 formula: del = |deltaOld[0] * trtol * tol * 3 * (deltaOld[0]+deltaOld[1]) / diff|
    const dt = 1e-6;
    const deltaOld = [1e-6, 1e-6, 1e-6, 1e-6, 1e-6, 1e-6, 1e-6];
    const q0 = 27e-12, q1 = 8e-12, q2 = 1e-12, q3 = 0;
    const ccap0 = 27e-6, ccap1 = 8e-6;
    const params: LteParams = { trtol: 7, reltol: 1e-3, abstol: 1e-12, chgtol: 1e-14 };

    // Compute reference inline from corrected ngspice formula
    const h0 = dt, h1 = deltaOld[1], h2 = deltaOld[2];
    let d0 = q0, d1 = q1, d2 = q2, d3 = q3;
    d0 = (d0 - d1) / h0;
    d1 = (d1 - d2) / h1;
    d2 = (d2 - d3) / h2;
    let dt0ref = h1 + h0, dt1ref = h2 + h1;
    d0 = (d0 - d1) / dt0ref;
    d1 = (d1 - d2) / dt1ref;
    dt0ref = dt1ref + h0;
    const diff0Final = (d0 - d1) / dt0ref; // signed final divided difference
    const chargetolRaw = 1e-3 * Math.max(Math.max(Math.abs(q0), Math.abs(q1)), 1e-14);
    const chargetol = chargetolRaw / dt;
    const volttol = 1e-12 + 1e-3 * Math.max(Math.abs(ccap0), Math.abs(ccap1));
    const tol = Math.max(volttol, chargetol);
    const d0r = deltaOld[0], d1r = deltaOld[1];
    // ngspice cktterr.c TRAP order 2: del = |deltaOld[0] * trtol * tol * 3 * (d0+d1) / diff|
    const reference = Math.abs(d0r * 7 * tol * 3 * (d0r + d1r) / diff0Final);

    const result = cktTerr(dt, deltaOld, 2, "trapezoidal", q0, q1, q2, q3, ccap0, ccap1, params);
    expect(result).toBe(reference); // bit-exact IEEE-754
  });

  it("cktTerrVoltage_gear_order2_matches_ngspice", () => {
    // V5: GEAR formula: tmp = (tol * trtol * delsum) / (denom * delta), result = delta * exp(log(tmp)/(order+1))
    const dt = 1e-6;
    const deltaOld = [1e-6, 1e-6, 1e-6, 1e-6, 1e-6, 1e-6, 1e-6];
    const vNow = 27.0, v1 = 8.0, v2 = 1.0, v3 = 0.0;
    const lteReltol = 1e-3, lteAbstol = 1e-6, trtol = 7;
    const order = 2;

    // Compute reference inline from corrected ngspice ckttrunc.c NEWTRUNC formula
    const h0 = dt, h1 = deltaOld[1], h2 = deltaOld[2];
    let d0v = vNow, d1v = v1, d2v = v2, d3v = v3;
    d0v = (d0v - d1v) / h0;
    d1v = (d1v - d2v) / h1;
    d2v = (d2v - d3v) / h2;
    let dt0v = h1 + h0, dt1v = h2 + h1;
    d0v = (d0v - d1v) / dt0v;
    d1v = (d1v - d2v) / dt1v;
    dt0v = dt1v + h0;
    d0v = (d0v - d1v) / dt0v;
    const ddiffV = Math.abs(d0v);
    const tolV = lteAbstol + lteReltol * Math.max(Math.abs(vNow), Math.abs(v1));
    // GEAR_LTE_FACTORS[1] = 2/9
    const factorV = 2 / 9;
    const delta = dt;
    let delsum = 0;
    for (let i = 0; i <= order && i < deltaOld.length; i++) delsum += deltaOld[i];
    const denomV = Math.max(lteAbstol, factorV * ddiffV);
    const tmp = (tolV * trtol * delsum) / (denomV * delta);
    const reference = delta * Math.exp(Math.log(tmp) / (order + 1));

    const result = cktTerrVoltage(vNow, v1, v2, v3, dt, deltaOld, order, "bdf2", lteReltol, lteAbstol, trtol);
    expect(result).toBe(reference); // bit-exact IEEE-754
  });

  it("cktTerr_gear_order1_sqrt", () => {
    // V6: GEAR order 1 must take sqrt(del), not return del directly
    // Verify: cktTerr GEAR order 1 result equals sqrt of the del computed before root extraction
    const dt = 1e-6;
    const deltaOld = [1e-6, 1e-6, 1e-6, 1e-6, 1e-6];
    const q0 = 1e-12, q1 = 0.8e-12, q2 = 0.5e-12, q3 = 0;
    const ccap0 = 1e-10, ccap1 = 0.8e-10;
    const params: LteParams = { trtol: 7, reltol: 1e-3, abstol: 1e-12, chgtol: 1e-14 };

    // Compute del directly (before root extraction)
    const h0 = dt, h1 = deltaOld[1];
    let d0 = q0, d1 = q1, d2 = q2;
    d0 = (d0 - d1) / h0;
    d1 = (d1 - d2) / h1;
    const dt0ref = h1 + h0;
    d0 = (d0 - d1) / dt0ref;
    const ddiff = Math.abs(d0);
    const chargetolRaw = 1e-3 * Math.max(Math.max(Math.abs(q0), Math.abs(q1)), 1e-14);
    const chargetol = chargetolRaw / dt;
    const volttol = 1e-12 + 1e-3 * Math.max(Math.abs(ccap0), Math.abs(ccap1));
    const tol = Math.max(volttol, chargetol);
    const factor = 0.5; // GEAR_LTE_FACTORS[0]
    const denom = Math.max(1e-12, factor * ddiff);
    const del = 7 * tol / denom;
    const expectedSqrt = Math.sqrt(del);

    const result = cktTerr(dt, deltaOld, 1, "bdf1", q0, q1, q2, q3, ccap0, ccap1, params);
    expect(result).toBe(expectedSqrt); // must be sqrt(del), not del
    expect(result).not.toBe(del);       // confirm del != sqrt(del) for this input
  });

  it("cktTerrVoltage_gear_order1_sqrt", () => {
    // V6: cktTerrVoltage GEAR order 1 must take sqrt
    const dt = 1e-6;
    const deltaOld = [1e-6, 1e-6, 1e-6, 1e-6, 1e-6];
    const vNow = 5.0, v1 = 4.0, v2 = 2.5, v3 = 0.5;
    const lteReltol = 1e-3, lteAbstol = 1e-6, trtol = 7;

    // Compute reference: delta * sqrt(tmp)
    const h0 = dt, h1 = deltaOld[1];
    let d0v = vNow, d1v = v1, d2v = v2;
    d0v = (d0v - d1v) / h0;
    d1v = (d1v - d2v) / h1;
    const dt0v = h1 + h0;
    d0v = (d0v - d1v) / dt0v;
    const ddiffV = Math.abs(d0v);
    const tolV = lteAbstol + lteReltol * Math.max(Math.abs(vNow), Math.abs(v1));
    const factorV = 0.5; // GEAR_LTE_FACTORS[0]
    const delta = dt;
    let delsum = 0;
    for (let i = 0; i <= 1 && i < deltaOld.length; i++) delsum += deltaOld[i];
    const denomV = Math.max(lteAbstol, factorV * ddiffV);
    const tmp = (tolV * trtol * delsum) / (denomV * delta);
    const expectedResult = delta * Math.sqrt(tmp);

    const result = cktTerrVoltage(vNow, v1, v2, v3, dt, deltaOld, 1, "bdf1", lteReltol, lteAbstol, trtol);
    expect(result).toBe(expectedResult);
  });

  it("gear_higher_order_root_is_order_plus_one", () => {
    // V6: GEAR order 3 root extraction must use exp(log(tmp)/(order+1)) = exp(log(tmp)/4)
    const dt = 1e-6;
    const deltaOld = [1e-6, 1e-6, 1e-6, 1e-6, 1e-6];
    const q0 = 27e-12, q1 = 8e-12, q2 = 1e-12, q3 = 0;
    const ccap0 = 27e-6, ccap1 = 8e-6;
    const params: LteParams = { trtol: 7, reltol: 1e-3, abstol: 1e-12, chgtol: 1e-14 };

    // Compute del (before root extraction)
    const h0 = dt, h1 = deltaOld[1], h2 = deltaOld[2];
    let d0 = q0, d1 = q1, d2 = q2, d3 = q3;
    d0 = (d0 - d1) / h0;
    d1 = (d1 - d2) / h1;
    d2 = (d2 - d3) / h2;
    let dt0 = h1 + h0, dt1 = h2 + h1;
    d0 = (d0 - d1) / dt0;
    d1 = (d1 - d2) / dt1;
    dt0 = dt1 + h0;
    d0 = (d0 - d1) / dt0;
    const ddiff = Math.abs(d0);
    const chargetolRaw = 1e-3 * Math.max(Math.max(Math.abs(q0), Math.abs(q1)), 1e-14);
    const chargetol = chargetolRaw / dt;
    const volttol = 1e-12 + 1e-3 * Math.max(Math.abs(ccap0), Math.abs(ccap1));
    const tol = Math.max(volttol, chargetol);
    const factor = 3 / 22; // GEAR_LTE_FACTORS[2] for order 3
    const denom = Math.max(1e-12, factor * ddiff);
    const del = 7 * tol / denom;
    // Correct: exp(log(del) / (3+1)) = exp(log(del)/4) = del^(1/4)
    const expectedOrderPlus1 = Math.exp(Math.log(del) / 4);
    // Wrong (old): exp(log(del) / 3) = del^(1/3)
    const wrongOrder = Math.exp(Math.log(del) / 3);

    const result = cktTerr(dt, deltaOld, 3, "bdf2", q0, q1, q2, q3, ccap0, ccap1, params);
    expect(result).toBe(expectedOrderPlus1); // bit-exact: uses (order+1)=4
    expect(result).not.toBe(wrongOrder);     // confirm old formula was different
  });
});
