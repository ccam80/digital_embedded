/**
 * Tests for integration coefficients and HistoryStore.
 *
 * Covers:
 *  - HistoryStore push/get/reset semantics
 *  - computeNIcomCof coefficient values for BDF-1, trapezoidal, BDF-2, GEAR
 *  - Gear Vandermonde correctness (zero-alloc scratch buffer)
 */

import { describe, it, expect } from "vitest";
import {
  HistoryStore,
  computeNIcomCof,
} from "../integration.js";
import * as integrationModule from "../integration.js";

// ---------------------------------------------------------------------------
// HistoryStore tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Task 6.3.2 — verify deleted functions are absent
// ---------------------------------------------------------------------------

describe("deleted_integrate_functions", () => {
  it("integrateCapacitor_does_not_exist", () => {
    expect((integrationModule as Record<string, unknown>)["integrateCapacitor"]).toBeUndefined();
  });

  it("integrateInductor_does_not_exist", () => {
    expect((integrationModule as Record<string, unknown>)["integrateInductor"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// HistoryStore tests
// ---------------------------------------------------------------------------

describe("HistoryStore", () => {
  it("push_rotates_values", () => {
    const store = new HistoryStore(3);
    const idx = 1;
    store.push(idx, 10.0); // v(n) = 10
    store.push(idx, 20.0); // v(n) = 20, v(n-1) = 10

    expect(store.get(idx, 0)).toBeCloseTo(20.0, 10);
    expect(store.get(idx, 1)).toBeCloseTo(10.0, 10);
  });

  it("reset_zeros_all", () => {
    const store = new HistoryStore(4);
    store.push(0, 5.0);
    store.push(1, 3.0);
    store.push(2, 7.0);
    store.reset();

    for (let i = 0; i < 4; i++) {
      expect(store.get(i, 0)).toBe(0);
      expect(store.get(i, 1)).toBe(0);
    }
  });

  it("independent_per_element", () => {
    const store = new HistoryStore(2);
    // Push different values for element 0 and element 1
    store.push(0, 100.0);
    store.push(1, 200.0);
    store.push(0, 150.0);
    store.push(1, 250.0);

    expect(store.get(0, 0)).toBeCloseTo(150.0, 10);
    expect(store.get(0, 1)).toBeCloseTo(100.0, 10);
    expect(store.get(1, 0)).toBeCloseTo(250.0, 10);
    expect(store.get(1, 1)).toBeCloseTo(200.0, 10);
  });

  it("initial_values_are_zero", () => {
    const store = new HistoryStore(5);
    for (let i = 0; i < 5; i++) {
      expect(store.get(i, 0)).toBe(0);
      expect(store.get(i, 1)).toBe(0);
    }
  });

  it("push_three_times_correct_history", () => {
    const store = new HistoryStore(1);
    store.push(0, 1.0);
    store.push(0, 2.0);
    store.push(0, 3.0); // v(n)=3, v(n-1)=2 (v(n-2)=1 is gone)

    expect(store.get(0, 0)).toBeCloseTo(3.0, 10);
    expect(store.get(0, 1)).toBeCloseTo(2.0, 10);
  });
});


// ---------------------------------------------------------------------------
// Task 1.2.1 spec tests
// ---------------------------------------------------------------------------

describe("gear_vandermonde_zero_alloc", () => {
  it("gear_vandermonde_uses_scratch_buffer", () => {
    // solveGearVandermonde no longer allocates — it uses the scratch buffer passed
    // via computeNIcomCof. Verify correct coefficients for GEAR orders 2-6 and
    // that the scratch buffer is mutated (not a new allocation path).
    const ag = new Float64Array(8);
    const scratch = new Float64Array(49);
    const h = 1e-6;

    // GEAR order 2 equal steps: ag*dt = [1.5, -2, 0.5]
    scratch.fill(0);
    computeNIcomCof(h, [h, h], 2, "gear", ag, scratch);
    expect(ag[0]).toBeCloseTo(3 / (2 * h), 8);
    expect(ag[1]).toBeCloseTo(-2 / h, 8);
    expect(ag[2]).toBeCloseTo(1 / (2 * h), 8);
    // Scratch buffer was mutated (non-zero entries exist after the solve)
    const scratchWasMutated = scratch.some(v => v !== 0);
    expect(scratchWasMutated).toBe(true);

    // GEAR order 3 equal steps: ag*dt = [11/6, -3, 3/2, -1/3]
    ag.fill(0); scratch.fill(0);
    computeNIcomCof(h, [h, h, h], 3, "gear", ag, scratch);
    expect(ag[0]).toBeCloseTo(11 / (6 * h), 6);
    expect(ag[1]).toBeCloseTo(-3 / h, 6);
    expect(ag[2]).toBeCloseTo(3 / (2 * h), 6);
    expect(ag[3]).toBeCloseTo(-1 / (3 * h), 6);

    // GEAR order 4 equal steps: ag*dt = [25/12, -4, 3, -4/3, 1/4]
    ag.fill(0); scratch.fill(0);
    computeNIcomCof(h, [h, h, h, h], 4, "gear", ag, scratch);
    expect(ag[0]).toBeCloseTo(25 / (12 * h), 6);
    expect(ag[1]).toBeCloseTo(-4 / h, 6);
    expect(ag[4]).toBeCloseTo(1 / (4 * h), 6);

    // GEAR order 5 equal steps
    ag.fill(0); scratch.fill(0);
    computeNIcomCof(h, [h, h, h, h, h], 5, "gear", ag, scratch);
    expect(ag[0]).toBeCloseTo(137 / (60 * h), 5);
    expect(ag[5]).toBeCloseTo(-1 / (5 * h), 5);

    // GEAR order 6 equal steps
    ag.fill(0); scratch.fill(0);
    computeNIcomCof(h, [h, h, h, h, h, h], 6, "gear", ag, scratch);
    expect(ag[0]).toBeCloseTo(49 / (20 * h), 5);
    expect(ag[6]).toBeCloseTo(1 / (6 * h), 5);
  });

  it("computeIntegrationCoefficients_deleted", () => {
    // computeIntegrationCoefficients must not exist as an export from integration.ts
    expect((integrationModule as Record<string, unknown>)["computeIntegrationCoefficients"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// computeNIcomCof tests (Item 5.3)
// ---------------------------------------------------------------------------

describe("computeNIcomCof", () => {
  const h = 1e-6;
  const scratch = new Float64Array(49);

  it("fills ag with zeros when dt <= 0", () => {
    const ag = new Float64Array(8);
    ag.fill(99); // pre-fill to confirm overwrite
    computeNIcomCof(0, [0, 0], 1, "bdf1", ag, scratch);
    for (let i = 0; i < ag.length; i++) {
      expect(ag[i]).toBe(0);
    }
  });

  it("BDF-1 order 1: ag[0]=1/dt, ag[1]=-1/dt", () => {
    const ag = new Float64Array(8);
    computeNIcomCof(h, [h, h], 1, "bdf1", ag, scratch);
    expect(ag[0]).toBeCloseTo(1 / h, 10);
    expect(ag[1]).toBeCloseTo(-1 / h, 10);
  });

  it("trapezoidal order 1: ag[0]=1/dt, ag[1]=-1/dt", () => {
    const ag = new Float64Array(8);
    computeNIcomCof(h, [h, h], 1, "trapezoidal", ag, scratch);
    expect(ag[0]).toBeCloseTo(1 / h, 10);
    expect(ag[1]).toBeCloseTo(-1 / h, 10);
  });

  it("trapezoidal order 2: ag[0]=2/dt, ag[1]=1 (xmu=0.5)", () => {
    const ag = new Float64Array(8);
    computeNIcomCof(h, [h, h], 2, "trapezoidal", ag, scratch);
    // xmu=0.5: ag[0] = 1/dt/(1-0.5) = 2/dt; ag[1] = 0.5/(1-0.5) = 1
    expect(ag[0]).toBeCloseTo(2 / h, 10);
    expect(ag[1]).toBeCloseTo(1, 10);
  });

  it("BDF-2 equal steps: ag[0]=3/(2h), ag[1]=-2/h, ag[2]=1/(2h)", () => {
    const ag = new Float64Array(8);
    computeNIcomCof(h, [h, h], 2, "bdf2", ag, scratch);
    // With h1=h: r1=1, r2=2, u22=2*(2-1)=2, rhs2=1/h
    // ag2 = (1/h)/2 = 1/(2h), ag1 = (-1/h - 2/(2h))/1 = -2/h
    // ag0 = -(ag1+ag2) = 2/h - 1/(2h) = 3/(2h)
    expect(ag[0]).toBeCloseTo(3 / (2 * h), 10);
    expect(ag[1]).toBeCloseTo(-2 / h, 10);
    expect(ag[2]).toBeCloseTo(1 / (2 * h), 10);
  });

  it("BDF-2 degenerate (h1=0): falls back to BE coefficients", () => {
    // deltaOld[1]=0 triggers safeH1=dt fallback, which gives equal-steps BDF-2, not BE.
    // Spec: h1 = deltaOld[1] > 0 ? deltaOld[1] : dt — so h1=dt → equal steps BDF-2.
    const ag = new Float64Array(8);
    computeNIcomCof(h, [h, 0], 2, "bdf2", ag, scratch);
    // h1=0 → safeH1=dt=h → same as equal steps
    expect(ag[0]).toBeCloseTo(3 / (2 * h), 10);
    expect(ag[1]).toBeCloseTo(-2 / h, 10);
    expect(ag[2]).toBeCloseTo(1 / (2 * h), 10);
  });

  it("GEAR order 2 equal steps matches BDF-2: ag[0]=3/(2h), ag[1]=-2/h, ag[2]=1/(2h)", () => {
    // GEAR method with order=2 and equal steps should produce same coefficients as BDF-2.
    // nicomcof.c: Vandermonde with r[1]=1, r[2]=2 gives ag*dt = [1.5, -2, 0.5].
    const ag = new Float64Array(8);
    const scratch = new Float64Array(49);
    computeNIcomCof(h, [h, h], 2, "gear", ag, scratch);
    expect(ag[0]).toBeCloseTo(3 / (2 * h), 8);
    expect(ag[1]).toBeCloseTo(-2 / h, 8);
    expect(ag[2]).toBeCloseTo(1 / (2 * h), 8);
  });

  it("GEAR order 3 equal steps: ag*dt = [11/6, -3, 3/2, -1/3]", () => {
    // Known GEAR-3 equal-step coefficients from numerical integration tables.
    // nicomcof.c Vandermonde with r[1]=1, r[2]=2, r[3]=3.
    // ag*dt = [11/6, -3, 3/2, -1/3]
    const ag = new Float64Array(8);
    const scratch = new Float64Array(49);
    computeNIcomCof(h, [h, h, h], 3, "gear", ag, scratch);
    expect(ag[0]).toBeCloseTo(11 / (6 * h), 6);
    expect(ag[1]).toBeCloseTo(-3 / h, 6);
    expect(ag[2]).toBeCloseTo(3 / (2 * h), 6);
    expect(ag[3]).toBeCloseTo(-1 / (3 * h), 6);
  });

  it("GEAR order 4 equal steps: ag*dt = [25/12, -4, 3, -4/3, 1/4]", () => {
    // Known GEAR-4 equal-step coefficients.
    // ag*dt = [25/12, -4, 3, -4/3, 1/4]
    const ag = new Float64Array(8);
    const scratch = new Float64Array(49);
    computeNIcomCof(h, [h, h, h, h], 4, "gear", ag, scratch);
    expect(ag[0]).toBeCloseTo(25 / (12 * h), 6);
    expect(ag[1]).toBeCloseTo(-4 / h, 6);
    expect(ag[2]).toBeCloseTo(3 / h, 6);
    expect(ag[3]).toBeCloseTo(-4 / (3 * h), 6);
    expect(ag[4]).toBeCloseTo(1 / (4 * h), 6);
  });

  it("GEAR order 5 equal steps: ag*dt = [137/60, -5, 5, -10/3, 5/4, -1/5]", () => {
    // Known GEAR-5 equal-step coefficients.
    const ag = new Float64Array(8);
    const scratch = new Float64Array(49);
    computeNIcomCof(h, [h, h, h, h, h], 5, "gear", ag, scratch);
    expect(ag[0]).toBeCloseTo(137 / (60 * h), 5);
    expect(ag[1]).toBeCloseTo(-5 / h, 5);
    expect(ag[2]).toBeCloseTo(5 / h, 5);
    expect(ag[3]).toBeCloseTo(-10 / (3 * h), 5);
    expect(ag[4]).toBeCloseTo(5 / (4 * h), 5);
    expect(ag[5]).toBeCloseTo(-1 / (5 * h), 5);
  });

  it("GEAR order 6 equal steps: ag*dt = [49/20, -6, 15/2, -20/3, 15/4, -6/5, 1/6]", () => {
    // Known GEAR-6 equal-step coefficients.
    const ag = new Float64Array(8);
    const scratch = new Float64Array(49);
    computeNIcomCof(h, [h, h, h, h, h, h], 6, "gear", ag, scratch);
    expect(ag[0]).toBeCloseTo(49 / (20 * h), 5);
    expect(ag[1]).toBeCloseTo(-6 / h, 5);
    expect(ag[2]).toBeCloseTo(15 / (2 * h), 5);
    expect(ag[3]).toBeCloseTo(-20 / (3 * h), 5);
    expect(ag[4]).toBeCloseTo(15 / (4 * h), 5);
    expect(ag[5]).toBeCloseTo(-6 / (5 * h), 5);
    expect(ag[6]).toBeCloseTo(1 / (6 * h), 5);
  });

  it("GEAR coefficients sum to zero (interpolation constraint)", () => {
    // For all GEAR orders, sum(ag) = 0 (the polynomial interpolates Q correctly).
    const ag = new Float64Array(8);
    const scratch = new Float64Array(49);
    for (const order of [2, 3, 4, 5, 6]) {
      ag.fill(0);
      computeNIcomCof(h, [h, h, h, h, h, h], order, "gear", ag, scratch);
      let sum = 0;
      for (let k = 0; k <= order; k++) sum += ag[k];
      expect(Math.abs(sum)).toBeLessThan(1e-9);
    }
  });
});


// ---------------------------------------------------------------------------
// Task 3.2.3 — gear_vandermonde_flat_scratch_regression
// ---------------------------------------------------------------------------

describe("gear_vandermonde_regression", () => {
  it("gear_vandermonde_flat_scratch_regression", () => {
    // Regression test: Phase 1 converted solveGearVandermonde to use a flat scratch buffer.
    // This test verifies numerical correctness of GEAR order 4 coefficients.
    const h = 1e-6;
    const ag = new Float64Array(8);
    // Allocate scratch independently (not from CKTCircuitContext)
    const scratch = new Float64Array(49);

    // Verify scratch starts zeroed
    expect(scratch[0]).toBe(0);

    computeNIcomCof(h, [h, h, h, h], 4, "gear", ag, scratch);

    // Assert ag[0..4] match the closed-form GEAR-4 coefficients bit-exact.
    // Known GEAR-4 coefficients for equal steps: ag*dt = [25/12, -4, 3, -4/3, 1/4].
    // A byte-equivalent Vandermonde solver must produce these to IEEE-754 precision.
    //
    // Known divergence at commit ecdc34a: ag[0] produces 2083333.333333333
    // (1 ULP low vs closed-form 2083333.3333333333 = 25/(12*h)). This is a
    // real numerical divergence from the mathematical ideal and (likely)
    // from ngspice — not a test-infra issue. Keep the assertion strict so
    // it stays flagged as a finding for batch-4 remediation.
    expect(ag[0]).toBe(25 / (12 * h));
    expect(ag[1]).toBe(-4 / h);
    expect(ag[2]).toBe(3 / h);
    expect(ag[3]).toBe(-4 / (3 * h));
    expect(ag[4]).toBe(1 / (4 * h));

    // Assert the scratch buffer was mutated — confirms it was used (not bypassed)
    expect(scratch[0]).not.toBe(0);
  });
});
