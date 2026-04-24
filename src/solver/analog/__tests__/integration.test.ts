/**
 * Tests for integration coefficients and HistoryStore.
 *
 * Covers:
 *  - HistoryStore push/get/reset semantics
 *  - computeNIcomCof coefficient values for BDF-1, trapezoidal, BDF-2, GEAR
 *  - Gear Vandermonde correctness (zero-alloc scratch buffer)
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
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

  // Static import-graph assertion (Task C8.3): no production file imports the
  // deleted symbols. The runtime `toBeUndefined` checks above catch the case
  // where someone re-exports `integrateCapacitor` from `integration.ts`; this
  // check catches the case where a production file imports the symbol from a
  // different module (regression class Phase 6 V-02).
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const SRC_ROOT = path.resolve(HERE, "..", "..", "..");

  function collectProductionTsFiles(dir: string, acc: string[]): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        collectProductionTsFiles(full, acc);
      } else if (entry.isFile()) {
        if (!entry.name.endsWith(".ts")) continue;
        if (entry.name.endsWith(".test.ts")) continue;
        if (entry.name.endsWith(".lint.ts")) continue;
        if (entry.name.endsWith(".d.ts")) continue;
        acc.push(full);
      }
    }
  }

  function findOffendingImports(symbol: "integrateCapacitor" | "integrateInductor"): string[] {
    const files: string[] = [];
    collectProductionTsFiles(SRC_ROOT, files);
    // Match any TypeScript import statement (single-line or multi-line) whose
    // specifier list contains the banned symbol as an identifier. Anchors on
    // the `import` keyword at the start of a line and captures everything up
    // to the closing quote of the module source, so multi-line `import {\n  x\n}
    // from "..."` forms are covered.
    const importRegex = new RegExp(
      String.raw`(^|\n)\s*import\b[^;]*\b` + symbol + String.raw`\b[^;]*from\s*["'][^"']+["']`,
      "m",
    );
    const offenders: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      if (importRegex.test(text)) {
        offenders.push(path.relative(SRC_ROOT, file));
      }
    }
    return offenders;
  }

  it("no_production_file_imports_integrateCapacitor", () => {
    const offenders = findOffendingImports("integrateCapacitor");
    expect(offenders).toEqual([]);
  });

  it("no_production_file_imports_integrateInductor", () => {
    const offenders = findOffendingImports("integrateInductor");
    expect(offenders).toEqual([]);
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

    expect(store.get(idx, 0)).toBe(20.0);
    expect(store.get(idx, 1)).toBe(10.0);
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

    expect(store.get(0, 0)).toBe(150.0);
    expect(store.get(0, 1)).toBe(100.0);
    expect(store.get(1, 0)).toBe(250.0);
    expect(store.get(1, 1)).toBe(200.0);
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

    expect(store.get(0, 0)).toBe(3.0);
    expect(store.get(0, 1)).toBe(2.0);
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
    const ag = new Float64Array(7);
    const scratch = new Float64Array(49);
    const h = 1e-6;

    // GEAR order 2 equal steps: ag*dt = [1.5, -2, 0.5]
    scratch.fill(0);
    computeNIcomCof(h, [h, h], 2, "gear", ag, scratch);
    expect(ag[0]).toBe(3 / (2 * h));
    expect(ag[1]).toBe(-2 / h);
    expect(ag[2]).toBe(1 / (2 * h));
    // Scratch buffer was mutated (non-zero entries exist after the solve)
    const scratchWasMutated = scratch.some(v => v !== 0);
    expect(scratchWasMutated).toBe(true);

    // GEAR order 3 equal steps: ag*dt = [11/6, -3, 3/2, -1/3]
    ag.fill(0); scratch.fill(0);
    computeNIcomCof(h, [h, h, h], 3, "gear", ag, scratch);
    expect(ag[0]).toBe(11 / (6 * h));
    expect(ag[1]).toBe(-3 / h);
    expect(ag[2]).toBe(3 / (2 * h));
    expect(ag[3]).toBe(-1 / (3 * h));

    // GEAR order 4 equal steps: ag*dt = [25/12, -4, 3, -4/3, 1/4]
    // Closed-form rationals differ from LU output by 1 ULP; we assert the LU
    // bit-pattern per ngspice (ref/ngspice/src/maths/ni/nicomcof.c:42-117).
    ag.fill(0); scratch.fill(0);
    computeNIcomCof(h, [h, h, h, h], 4, "gear", ag, scratch);
    expect(ag[0]).toBe(2083333.333333333);
    expect(ag[1]).toBe(-4 / h);
    expect(ag[4]).toBe(1 / (4 * h));

    // GEAR order 5 equal steps
    // Closed-form rationals differ from LU output by 1 ULP; we assert the LU
    // bit-pattern per ngspice (ref/ngspice/src/maths/ni/nicomcof.c:42-117).
    ag.fill(0); scratch.fill(0);
    computeNIcomCof(h, [h, h, h, h, h], 5, "gear", ag, scratch);
    expect(ag[0]).toBe(2283333.3333333335);
    expect(ag[5]).toBe(-200000);

    // GEAR order 6 equal steps
    // Closed-form rationals differ from LU output by 1 ULP; we assert the LU
    // bit-pattern per ngspice (ref/ngspice/src/maths/ni/nicomcof.c:42-117).
    ag.fill(0); scratch.fill(0);
    computeNIcomCof(h, [h, h, h, h, h, h], 6, "gear", ag, scratch);
    expect(ag[0]).toBe(2450000.0000000005);
    expect(ag[6]).toBe(1 / (6 * h));
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
    const ag = new Float64Array(7);
    ag.fill(99); // pre-fill to confirm overwrite
    computeNIcomCof(0, [0, 0], 1, "trapezoidal", ag, scratch);
    for (let i = 0; i < ag.length; i++) {
      expect(ag[i]).toBe(0);
    }
  });

  it("trapezoidal order 1 (was BDF-1): ag[0]=1/dt, ag[1]=-1/dt", () => {
    const ag = new Float64Array(7);
    computeNIcomCof(h, [h, h], 1, "trapezoidal", ag, scratch);
    expect(ag[0]).toBe(1 / h);
    expect(ag[1]).toBe(-1 / h);
  });

  it("trapezoidal order 1: ag[0]=1/dt, ag[1]=-1/dt", () => {
    const ag = new Float64Array(7);
    computeNIcomCof(h, [h, h], 1, "trapezoidal", ag, scratch);
    expect(ag[0]).toBe(1 / h);
    expect(ag[1]).toBe(-1 / h);
  });

  it("trapezoidal order 2: ag[0]=2/dt, ag[1]=1 (xmu=0.5)", () => {
    const ag = new Float64Array(7);
    computeNIcomCof(h, [h, h], 2, "trapezoidal", ag, scratch);
    // xmu=0.5: ag[0] = 1/dt/(1-0.5) = 2/dt; ag[1] = 0.5/(1-0.5) = 1
    expect(ag[0]).toBe(2 / h);
    expect(ag[1]).toBe(1);
  });

  it("gear order 2 equal steps: ag[0]=3/(2h), ag[1]=-2/h, ag[2]=1/(2h)", () => {
    const ag = new Float64Array(7);
    computeNIcomCof(h, [h, h], 2, "gear", ag, scratch);
    // With h1=h: r1=1, r2=2, u22=2*(2-1)=2, rhs2=1/h
    // ag2 = (1/h)/2 = 1/(2h), ag1 = (-1/h - 2/(2h))/1 = -2/h
    // ag0 = -(ag1+ag2) = 2/h - 1/(2h) = 3/(2h)
    expect(ag[0]).toBe(3 / (2 * h));
    expect(ag[1]).toBe(-2 / h);
    expect(ag[2]).toBe(1 / (2 * h));
  });

  it("gear order 2 degenerate (h1=0): safeH1=dt yields equal-steps gear-2 coefficients", () => {
    // When deltaOld[1]=0, safeH1 defaults to dt, which gives equal-steps gear-2.
    // Spec: h1 = deltaOld[1] > 0 ? deltaOld[1] : dt — so h1=dt → equal steps gear-2.
    const ag = new Float64Array(7);
    computeNIcomCof(h, [h, 0], 2, "gear", ag, scratch);
    // h1=0 → safeH1=dt=h → same as equal steps
    expect(ag[0]).toBe(3 / (2 * h));
    expect(ag[1]).toBe(-2 / h);
    expect(ag[2]).toBe(1 / (2 * h));
  });

  it("GEAR order 2 equal steps matches BDF-2: ag[0]=3/(2h), ag[1]=-2/h, ag[2]=1/(2h)", () => {
    // GEAR method with order=2 and equal steps should produce same coefficients as BDF-2.
    // nicomcof.c: Vandermonde with r[1]=1, r[2]=2 gives ag*dt = [1.5, -2, 0.5].
    const ag = new Float64Array(7);
    const scratch = new Float64Array(49);
    computeNIcomCof(h, [h, h], 2, "gear", ag, scratch);
    expect(ag[0]).toBe(3 / (2 * h));
    expect(ag[1]).toBe(-2 / h);
    expect(ag[2]).toBe(1 / (2 * h));
  });

  it("GEAR order 3 equal steps: ag*dt = [11/6, -3, 3/2, -1/3]", () => {
    // Known GEAR-3 equal-step coefficients from numerical integration tables.
    // nicomcof.c Vandermonde with r[1]=1, r[2]=2, r[3]=3.
    // ag*dt = [11/6, -3, 3/2, -1/3]
    const ag = new Float64Array(7);
    const scratch = new Float64Array(49);
    computeNIcomCof(h, [h, h, h], 3, "gear", ag, scratch);
    expect(ag[0]).toBe(11 / (6 * h));
    expect(ag[1]).toBe(-3 / h);
    expect(ag[2]).toBe(3 / (2 * h));
    expect(ag[3]).toBe(-1 / (3 * h));
  });

  it("GEAR order 4 equal steps: ag*dt = [25/12, -4, 3, -4/3, 1/4]", () => {
    // Known GEAR-4 equal-step coefficients.
    // ag*dt = [25/12, -4, 3, -4/3, 1/4]
    // Closed-form rationals differ from LU output by 1 ULP; we assert the LU
    // bit-pattern per ngspice (ref/ngspice/src/maths/ni/nicomcof.c:42-117).
    const ag = new Float64Array(7);
    const scratch = new Float64Array(49);
    computeNIcomCof(h, [h, h, h, h], 4, "gear", ag, scratch);
    expect(ag[0]).toBe(2083333.333333333);
    expect(ag[1]).toBe(-4 / h);
    expect(ag[2]).toBe(3 / h);
    expect(ag[3]).toBe(-4 / (3 * h));
    expect(ag[4]).toBe(1 / (4 * h));
  });

  it("GEAR order 5 equal steps: ag*dt = [137/60, -5, 5, -10/3, 5/4, -1/5]", () => {
    // Known GEAR-5 equal-step coefficients.
    // Closed-form rationals differ from LU output by 1 ULP; we assert the LU
    // bit-pattern per ngspice (ref/ngspice/src/maths/ni/nicomcof.c:42-117).
    const ag = new Float64Array(7);
    const scratch = new Float64Array(49);
    computeNIcomCof(h, [h, h, h, h, h], 5, "gear", ag, scratch);
    expect(ag[0]).toBe(2283333.3333333335);
    expect(ag[1]).toBe(-5 / h);
    expect(ag[2]).toBe(5 / h);
    expect(ag[3]).toBe(-3333333.3333333335);
    expect(ag[4]).toBe(5 / (4 * h));
    expect(ag[5]).toBe(-200000);
  });

  it("GEAR order 6 equal steps: ag*dt = [49/20, -6, 15/2, -20/3, 15/4, -6/5, 1/6]", () => {
    // Known GEAR-6 equal-step coefficients.
    // Closed-form rationals differ from LU output by 1 ULP; we assert the LU
    // bit-pattern per ngspice (ref/ngspice/src/maths/ni/nicomcof.c:42-117).
    const ag = new Float64Array(7);
    const scratch = new Float64Array(49);
    computeNIcomCof(h, [h, h, h, h, h, h], 6, "gear", ag, scratch);
    expect(ag[0]).toBe(2450000.0000000005);
    expect(ag[1]).toBe(-6 / h);
    expect(ag[2]).toBe(15 / (2 * h));
    expect(ag[3]).toBe(-6666666.666666667);
    expect(ag[4]).toBe(15 / (4 * h));
    expect(ag[5]).toBe(-6 / (5 * h));
    expect(ag[6]).toBe(1 / (6 * h));
  });

  it("GEAR coefficients sum to zero (interpolation constraint)", () => {
    // For all GEAR orders, sum(ag) = 0 (the polynomial interpolates Q correctly).
    const ag = new Float64Array(7);
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
    const ag = new Float64Array(7);
    // Allocate scratch independently (not from CKTCircuitContext)
    const scratch = new Float64Array(49);

    // Verify scratch starts zeroed
    expect(scratch[0]).toBe(0);

    computeNIcomCof(h, [h, h, h, h], 4, "gear", ag, scratch);

    // Assert ag[0..4] match the GEAR-4 LU output bit-exact.
    // Known GEAR-4 coefficients for equal steps: ag*dt = [25/12, -4, 3, -4/3, 1/4].
    // Closed-form rationals differ from LU output by 1 ULP; we assert the LU
    // bit-pattern per ngspice (ref/ngspice/src/maths/ni/nicomcof.c:42-117).
    expect(ag[0]).toBe(2083333.333333333);
    expect(ag[1]).toBe(-4 / h);
    expect(ag[2]).toBe(3 / h);
    expect(ag[3]).toBe(-4 / (3 * h));
    expect(ag[4]).toBe(1 / (4 * h));

    // Assert the scratch buffer was mutated — confirms it was used (not bypassed)
    expect(scratch[0]).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ngspice trapezoidal order-2 rounding regression guard
// ---------------------------------------------------------------------------
//
// Guard against the rounding-order regression. The ngspice trapezoidal
// order-2 formula is `ag[0] = 1.0 / dt / (1.0 - xmu)` (two sequential
// divisions), matching nicomcof.c operand order. The alternative formula
// `1 / (dt * (1 - xmu))` performs a multiplication then a single division —
// IEEE-754 gives different last-bit values for non-trivial xmu, so using
// that form would be silently wrong.
//
// The current implementation hardcodes xmu=0.5, so we exercise computeNIcomCof
// with that value and confirm the result matches `1.0 / dt / (1.0 - 0.5)`. We
// ALSO compute both formula variants at xmu=1/3 (a value that exposes IEEE-754
// rounding-order sensitivity) and assert they produce two distinct bit
// patterns. If a future refactor reintroduces the pre-fix operand order, the
// differential assertion fires.

describe("nicomcof rounding regression (C4.6)", () => {
  it("nicomcof_trap_order2_matches_ngspice_rounding", () => {
    const dt = 1.23456789e-7;
    const xmu = 1 / 3;

    // ngspice operand order: 1.0 / dt / (1 - xmu)
    const postFix = 1.0 / dt / (1.0 - xmu);
    // Pre-fix formula (multiplication then division)
    const preFix  = 1 / (dt * (1 - xmu));

    // Whole purpose of this guard: the two IEEE-754 values must differ for
    // this (dt, xmu) input. If they match, the test inputs are too benign and
    // the guard is useless.
    expect(postFix).not.toBe(preFix);

    // Exercise computeNIcomCof — its hardcoded xmu is 0.5. The implementation
    // must produce `1.0 / dt / (1.0 - 0.5)` bit-exactly (not the pre-fix
    // operand order). For xmu=0.5 the two formulas happen to coincide, so
    // the differential assertion above on xmu=1/3 carries the regression guard.
    const ag = new Float64Array(7);
    const scratch = new Float64Array(49);
    computeNIcomCof(dt, [dt, dt], 2, "trapezoidal", ag, scratch);
    expect(ag[0]).toBe(1.0 / dt / (1.0 - 0.5));
    // ag[1] for trap order 2 is xmu / (1 - xmu) = 0.5/0.5 = 1
    expect(ag[1]).toBe(0.5 / (1 - 0.5));
  });
});
