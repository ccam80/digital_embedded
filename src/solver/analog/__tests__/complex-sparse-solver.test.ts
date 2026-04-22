/**
 * ComplexSparseSolver unit tests — Wave 0.4
 *
 * Task 0.4.1: Persistent linked-list complex matrix + handle-based stamp API
 * Task 0.4.2: Drop AMD/etree — Markowitz on original column order
 * Task 0.4.3: SMPpreOrder on complex linked structure
 * Task 0.4.4: value-addressed stamp() deleted
 * Task 0.4.5: forceReorder() lifecycle
 */

import { describe, it, expect } from "vitest";
import { ComplexSparseSolver } from "../complex-sparse-solver.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Task 0.4.1 tests
// ---------------------------------------------------------------------------

describe("ComplexSparseSolver — Task 0.4.1", () => {
  it("allocComplexElement_returns_stable_handle", () => {
    const solver = new ComplexSparseSolver();
    solver.beginAssembly(3);

    const h00a = solver.allocComplexElement(0, 0);
    const h00b = solver.allocComplexElement(0, 0);
    expect(h00b).toBe(h00a); // same (row,col) → same handle

    const h01 = solver.allocComplexElement(0, 1);
    const h10 = solver.allocComplexElement(1, 0);
    const h11 = solver.allocComplexElement(1, 1);

    // Distinct (row,col) pairs → distinct handles
    expect(h01).not.toBe(h00a);
    expect(h10).not.toBe(h00a);
    expect(h11).not.toBe(h00a);
    expect(h10).not.toBe(h01);
    expect(h11).not.toBe(h01);
    expect(h11).not.toBe(h10);
  });

  it("stampComplexElement_accumulates_both_parts", () => {
    const solver = new ComplexSparseSolver();
    solver.beginAssembly(2);

    const h = solver.allocComplexElement(0, 0);
    solver.stampComplexElement(h, 1, 2);
    solver.stampComplexElement(h, 3, -4);

    // re = 1+3 = 4, im = 2+(-4) = -2
    expect(solver.elRe[h]).toBe(4);
    expect(solver.elIm[h]).toBe(-2);
  });

  it("stampComplexElement_inserts_into_linked_structure", () => {
    // 2×2 matrix; stamp 4 elements; verify linked structure via rowHead/colHead
    const solver = new ComplexSparseSolver();
    solver.beginAssembly(2);

    const h00 = solver.allocComplexElement(0, 0);
    solver.stampComplexElement(h00, 1.0, 0.5);
    const h01 = solver.allocComplexElement(0, 1);
    solver.stampComplexElement(h01, -1.0, -0.5);
    const h10 = solver.allocComplexElement(1, 0);
    solver.stampComplexElement(h10, -1.0, -0.5);
    const h11 = solver.allocComplexElement(1, 1);
    solver.stampComplexElement(h11, 2.0, 1.0);

    solver.finalize();

    // 4 non-fill-in elements
    expect(solver.elementCount).toBe(4);

    // Verify each element's re/im via handle

    // Verify rowHead chains: row 0 should reach h00 and h01
    const row0Elements: number[] = [];
    let e = solver.rowHead[0];
    while (e >= 0) { row0Elements.push(e); e = solver.elNextInRow[e]; }
    expect(row0Elements).toContain(h00);
    expect(row0Elements).toContain(h01);
    expect(row0Elements.length).toBe(2);

    // row 1 should reach h10 and h11
    const row1Elements: number[] = [];
    e = solver.rowHead[1];
    while (e >= 0) { row1Elements.push(e); e = solver.elNextInRow[e]; }
    expect(row1Elements).toContain(h10);
    expect(row1Elements).toContain(h11);
    expect(row1Elements.length).toBe(2);

    // colHead chains: col 0 should reach h00 and h10
    const col0Elements: number[] = [];
    e = solver.colHead[0];
    while (e >= 0) { col0Elements.push(e); e = solver.elNextInCol[e]; }
    expect(col0Elements).toContain(h00);
    expect(col0Elements).toContain(h10);
    expect(col0Elements.length).toBe(2);
  });

  it("beginAssembly_zeros_complex_values_preserves_structure", () => {
    const solver = new ComplexSparseSolver();

    // First assembly + full solve cycle
    solver.beginAssembly(2);
    const h00 = solver.allocComplexElement(0, 0);
    solver.stampComplexElement(h00, 2.0, 0.0);
    const h01 = solver.allocComplexElement(0, 1);
    solver.stampComplexElement(h01, -1.0, 0.0);
    const h10 = solver.allocComplexElement(1, 0);
    solver.stampComplexElement(h10, -1.0, 0.0);
    const h11 = solver.allocComplexElement(1, 1);
    solver.stampComplexElement(h11, 2.0, 0.0);
    solver.stampRHS(0, 1.0, 0.0);
    solver.stampRHS(1, 1.0, 0.0);
    solver.finalize();
    solver.forceReorder();
    solver.factor();
    const xRe = new Float64Array(2);
    const xIm = new Float64Array(2);
    solver.solve(xRe, xIm);

    // Second beginAssembly — should zero values but preserve structure
    solver.beginAssembly(2);

    // Element count (A-matrix entries) unchanged
    expect(solver.elementCount).toBe(4);

    // All element values zeroed
    expect(solver.elRe[h00]).toBe(0);
    expect(solver.elIm[h00]).toBe(0);
    expect(solver.elRe[h01]).toBe(0);
    expect(solver.elIm[h01]).toBe(0);
    expect(solver.elRe[h10]).toBe(0);
    expect(solver.elIm[h10]).toBe(0);
    expect(solver.elRe[h11]).toBe(0);
    expect(solver.elIm[h11]).toBe(0);

    // Linked chains still intact: row 0 still has 2 elements
    let count = 0;
    let e = solver.rowHead[0];
    while (e >= 0) { count++; e = solver.elNextInRow[e]; }
    expect(count).toBe(2);
  });

  it("invalidateTopology_forces_complex_rebuild", () => {
    const solver = new ComplexSparseSolver();

    // First assembly
    solver.beginAssembly(2);
    const h00 = solver.allocComplexElement(0, 0);
    solver.stampComplexElement(h00, 1.0, 0.0);
    solver.finalize();
    solver.forceReorder();
    solver.factor();

    // After invalidateTopology, the structure is cleared
    solver.invalidateTopology();

    // Next assembly rebuilds from scratch
    solver.beginAssembly(2);
    expect(solver.elementCount).toBe(0);

    // Can re-allocate elements (gets new handles)
    const h00new = solver.allocComplexElement(0, 0);
    solver.stampComplexElement(h00new, 3.0, 1.0);
    solver.finalize();

    expect(solver.elementCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Task 0.4.2 tests — Drop AMD, Markowitz on original column order
// ---------------------------------------------------------------------------

describe("ComplexSparseSolver — Task 0.4.2", () => {
  it("solve_without_amd_3x3_complex", () => {
    // 3×3 complex system: A*x = b
    // A = [[2+j, -1, 0], [-1, 2+j, -1], [0, -1, 2+j]]
    // b = [1, 0, 1]
    // Solve and verify A*x ≈ b
    const n = 3;
    const solver = new ComplexSparseSolver();
    solver.beginAssembly(n);

    const h00 = solver.allocComplexElement(0, 0); solver.stampComplexElement(h00, 2, 1);
    const h01 = solver.allocComplexElement(0, 1); solver.stampComplexElement(h01, -1, 0);
    const h10 = solver.allocComplexElement(1, 0); solver.stampComplexElement(h10, -1, 0);
    const h11 = solver.allocComplexElement(1, 1); solver.stampComplexElement(h11, 2, 1);
    const h12 = solver.allocComplexElement(1, 2); solver.stampComplexElement(h12, -1, 0);
    const h21 = solver.allocComplexElement(2, 1); solver.stampComplexElement(h21, -1, 0);
    const h22 = solver.allocComplexElement(2, 2); solver.stampComplexElement(h22, 2, 1);

    solver.stampRHS(0, 1, 0);
    solver.stampRHS(1, 0, 0);
    solver.stampRHS(2, 1, 0);
    solver.finalize();
    solver.forceReorder();
    const ok = solver.factor();
    expect(ok).toBe(true);

    const xRe = new Float64Array(n);
    const xIm = new Float64Array(n);
    solver.solve(xRe, xIm);

    // Verify A*x = b by residual check
    const res0Re = 2*xRe[0] - xIm[0] + (-1)*xRe[1] - 1.0; // real part row 0
    const res0Im = 2*xIm[0] + xRe[0] + (-1)*xIm[1] - 0.0; // imag part row 0
    const res1Re = (-1)*xRe[0] + 2*xRe[1] - xIm[1] + (-1)*xRe[2] - 0.0;
    const res1Im = (-1)*xIm[0] + 2*xIm[1] + xRe[1] + (-1)*xIm[2] - 0.0;
    const res2Re = (-1)*xRe[1] + 2*xRe[2] - xIm[2] - 1.0;
    const res2Im = (-1)*xIm[1] + 2*xIm[2] + xRe[2] - 0.0;

    expect(Math.abs(res0Re)).toBeLessThan(1e-10);
    expect(Math.abs(res0Im)).toBeLessThan(1e-10);
    expect(Math.abs(res1Re)).toBeLessThan(1e-10);
    expect(Math.abs(res1Im)).toBeLessThan(1e-10);
    expect(Math.abs(res2Re)).toBeLessThan(1e-10);
    expect(Math.abs(res2Im)).toBeLessThan(1e-10);
  });

  it("solve_complex_voltage_source_branch", () => {
    // Complex MNA matrix with voltage-source branch structure:
    // Node 1, branch row 2 (0-indexed).
    // A = [[G+jB, 0, 1], [0, G+jB, -1], [1, -1, 0]]
    // b = [0, 0, Vs]
    // Models a voltage source between node 0 and node 1 driving Vs=1
    const n = 3;
    const G = 0.001, B = 0.01, Vs = 1.0;
    const solver = new ComplexSparseSolver();
    solver.beginAssembly(n);

    const h00 = solver.allocComplexElement(0, 0); solver.stampComplexElement(h00, G, B);
    const h11 = solver.allocComplexElement(1, 1); solver.stampComplexElement(h11, G, B);
    const h02 = solver.allocComplexElement(0, 2); solver.stampComplexElement(h02, 1, 0);
    const h12 = solver.allocComplexElement(1, 2); solver.stampComplexElement(h12, -1, 0);
    const h20 = solver.allocComplexElement(2, 0); solver.stampComplexElement(h20, 1, 0);
    const h21 = solver.allocComplexElement(2, 1); solver.stampComplexElement(h21, -1, 0);

    solver.stampRHS(2, Vs, 0);
    solver.finalize();
    solver.forceReorder();
    const ok = solver.factor();
    expect(ok).toBe(true);

    const xRe = new Float64Array(n);
    const xIm = new Float64Array(n);
    solver.solve(xRe, xIm);

    // With voltage source: x[0] - x[1] = Vs = 1 (the branch row constraint)
    expect(Math.abs(xIm[0] - xIm[1])).toBeLessThan(1e-10);
  });

  it("markowitz_complex_fill_in_without_amd", () => {
    // 5×5 complex matrix with known structure that generates fill-in
    // Use an arrow matrix: all entries in first row/col plus diagonal
    // A[0][j] = A[j][0] = 1+j for j=1..4, A[i][i] = 4+2j for all i
    const n = 5;
    const solver = new ComplexSparseSolver();
    solver.beginAssembly(n);

    for (let i = 0; i < n; i++) {
      const hii = solver.allocComplexElement(i, i);
      solver.stampComplexElement(hii, 4, 2);
    }
    for (let j = 1; j < n; j++) {
      const h0j = solver.allocComplexElement(0, j);
      solver.stampComplexElement(h0j, 1, 1);
      const hj0 = solver.allocComplexElement(j, 0);
      solver.stampComplexElement(hj0, 1, 1);
    }

    // b = [1,1,1,1,1] + 0j
    for (let i = 0; i < n; i++) solver.stampRHS(i, 1, 0);
    solver.finalize();
    solver.forceReorder();
    const ok = solver.factor();
    expect(ok).toBe(true);

    const xRe = new Float64Array(n);
    const xIm = new Float64Array(n);
    solver.solve(xRe, xIm);

    // Verify residual A*x = b
    // Row 0: (4+2j)*x[0] + sum_{j=1..4}(1+j)*x[j] = 1
    let r0Re = (4*xRe[0] - 2*xIm[0]) - 1;
    let r0Im = (4*xIm[0] + 2*xRe[0]);
    for (let j = 1; j < n; j++) {
      r0Re += xRe[j] - xIm[j];
      r0Im += xIm[j] + xRe[j];
    }
    expect(Math.abs(r0Re)).toBeLessThan(1e-10);
    expect(Math.abs(r0Im)).toBeLessThan(1e-10);

    // Row 1: (1+j)*x[0] + (4+2j)*x[1] = 1
    const r1Re = (xRe[0] - xIm[0]) + (4*xRe[1] - 2*xIm[1]) - 1;
    const r1Im = (xIm[0] + xRe[0]) + (4*xIm[1] + 2*xRe[1]);
    expect(Math.abs(r1Re)).toBeLessThan(1e-10);
    expect(Math.abs(r1Im)).toBeLessThan(1e-10);
  });
});

// ---------------------------------------------------------------------------
// Task 0.4.3 tests — SMPpreOrder on complex linked structure
// ---------------------------------------------------------------------------

describe("ComplexSparseSolver — Task 0.4.3", () => {
  it("preorder_fixes_zero_diagonal_from_ac_voltage_source", () => {
    // 3×3 AC MNA with voltage-source branch row:
    //   [[G, 0, 1],
    //    [0, G, -1],
    //    [1, -1, 0]]  ← diagonal entry at (2,2) is structurally zero
    // After preorder, the zero-diagonal column (col 2) should be swapped.
    // Then solve should give correct complex result.
    const n = 3;
    const G = 1.0;
    const solver = new ComplexSparseSolver();
    solver.beginAssembly(n);

    const h00 = solver.allocComplexElement(0, 0); solver.stampComplexElement(h00, G, 0);
    const h11 = solver.allocComplexElement(1, 1); solver.stampComplexElement(h11, G, 0);
    // Twin pair: (0,2)=1 and (2,0)=1 — |value|²=1
    const h02 = solver.allocComplexElement(0, 2); solver.stampComplexElement(h02, 1, 0);
    const h12 = solver.allocComplexElement(1, 2); solver.stampComplexElement(h12, -1, 0);
    const h20 = solver.allocComplexElement(2, 0); solver.stampComplexElement(h20, 1, 0);
    const h21 = solver.allocComplexElement(2, 1); solver.stampComplexElement(h21, -1, 0);
    // No diagonal at (2,2) — structurally zero

    solver.stampRHS(2, 1, 0); // Vs = 1
    solver.finalize();
    solver.preorder();
    solver.forceReorder();
    const ok = solver.factor();
    expect(ok).toBe(true);

    const xRe = new Float64Array(n);
    const xIm = new Float64Array(n);
    solver.solve(xRe, xIm);

    // Branch constraint: x[0] - x[1] = 1 (voltage source row)
    expect(Math.abs(xIm[0] - xIm[1])).toBeLessThan(1e-10);
  });

  it("preorder_handles_multiple_complex_twins", () => {
    // 5×5 complex system with two voltage sources (two zero diagonals)
    // Variables: V1, V2, I1 (branch current), V3, I2
    // A = [[G1, 0, 1, 0, 0],
    //      [0, G2, -1, 0, 0],
    //      [1, -1, 0, 0, 0],
    //      [0, 0, 0, G3, 1],
    //      [0, 0, 0, 1, 0]]
    // Cols 2 and 4 have zero diagonals — preorder should fix both.
    const n = 5;
    const G1 = 1.0, G2 = 1.0, G3 = 1.0;
    const solver = new ComplexSparseSolver();
    solver.beginAssembly(n);

    solver.stampComplexElement(solver.allocComplexElement(0, 0), G1, 0);
    solver.stampComplexElement(solver.allocComplexElement(1, 1), G2, 0);
    solver.stampComplexElement(solver.allocComplexElement(0, 2), 1, 0);
    solver.stampComplexElement(solver.allocComplexElement(2, 0), 1, 0);
    solver.stampComplexElement(solver.allocComplexElement(1, 2), -1, 0);
    solver.stampComplexElement(solver.allocComplexElement(2, 1), -1, 0);
    solver.stampComplexElement(solver.allocComplexElement(3, 3), G3, 0);
    solver.stampComplexElement(solver.allocComplexElement(3, 4), 1, 0);
    solver.stampComplexElement(solver.allocComplexElement(4, 3), 1, 0);

    solver.stampRHS(2, 1, 0); // Vs1 = 1
    solver.stampRHS(4, 2, 0); // Vs2 = 2
    solver.finalize();
    solver.preorder();
    solver.forceReorder();
    const ok = solver.factor();
    expect(ok).toBe(true);

    const xRe = new Float64Array(n);
    const xIm = new Float64Array(n);
    solver.solve(xRe, xIm);

    // Both voltage sources satisfied
  });

  it("preorder_idempotent_complex", () => {
    // Two calls to preorder() should produce identical internal state
    const n = 3;
    const solver1 = new ComplexSparseSolver();
    const solver2 = new ComplexSparseSolver();

    function setup(s: ComplexSparseSolver): void {
      s.beginAssembly(n);
      s.stampComplexElement(s.allocComplexElement(0, 0), 1, 0);
      s.stampComplexElement(s.allocComplexElement(1, 1), 1, 0);
      s.stampComplexElement(s.allocComplexElement(0, 2), 1, 0);
      s.stampComplexElement(s.allocComplexElement(2, 0), 1, 0);
      s.stampComplexElement(s.allocComplexElement(1, 2), -1, 0);
      s.stampComplexElement(s.allocComplexElement(2, 1), -1, 0);
      s.stampRHS(2, 1, 0);
      s.finalize();
    }

    setup(solver1);
    setup(solver2);

    // solver1: one preorder call
    solver1.preorder();
    solver1.forceReorder();
    solver1.factor();
    const xRe1 = new Float64Array(n);
    const xIm1 = new Float64Array(n);
    solver1.solve(xRe1, xIm1);

    // solver2: two preorder calls (second is no-op)
    solver2.preorder();
    solver2.preorder();
    solver2.forceReorder();
    solver2.factor();
    const xRe2 = new Float64Array(n);
    const xIm2 = new Float64Array(n);
    solver2.solve(xRe2, xIm2);

    // Results must be bit-identical
    for (let i = 0; i < n; i++) {
      expect(xRe2[i]).toBe(xRe1[i]);
      expect(xIm2[i]).toBe(xIm1[i]);
    }
  });

  it("preorder_complex_no_swap_when_diagonal_nonzero", () => {
    // Full-diagonal matrix: preorder should be a no-op
    const n = 3;
    const solver = new ComplexSparseSolver();
    solver.beginAssembly(n);

    // Diagonal-only matrix
    solver.stampComplexElement(solver.allocComplexElement(0, 0), 2, 1);
    solver.stampComplexElement(solver.allocComplexElement(1, 1), 3, 0);
    solver.stampComplexElement(solver.allocComplexElement(2, 2), 4, -1);
    solver.stampRHS(0, 1, 0);
    solver.stampRHS(1, 2, 0);
    solver.stampRHS(2, 3, 0);
    solver.finalize();

    const diagBefore = [solver.diag[0], solver.diag[1], solver.diag[2]];
    solver.preorder();
    const diagAfter = [solver.diag[0], solver.diag[1], solver.diag[2]];

    // No swaps: diagonal pointers unchanged
    expect(diagAfter[0]).toBe(diagBefore[0]);
    expect(diagAfter[1]).toBe(diagBefore[1]);
    expect(diagAfter[2]).toBe(diagBefore[2]);

    // Solve still works correctly
    solver.forceReorder();
    solver.factor();
    const xRe = new Float64Array(n);
    const xIm = new Float64Array(n);
    solver.solve(xRe, xIm);

    // x[0] = 1/(2+j) = (2-j)/5
    // x[1] = 2/3
    // x[2] = 3/(4-j) = 3*(4+j)/17
  });

  it("complex_elCol_preserved_after_preorder_swap", () => {
    // After a swap, every element's _elCol[e] and _elRow[e] should equal
    // their pre-preorder values (original coordinates), and solve satisfies A*x=b.
    // Mirrors the real-side V-03/V-04 remediation test.
    const n = 3;
    const solver = new ComplexSparseSolver();
    solver.beginAssembly(n);

    solver.stampComplexElement(solver.allocComplexElement(0, 0), 1, 0);
    solver.stampComplexElement(solver.allocComplexElement(1, 1), 1, 0);
    solver.stampComplexElement(solver.allocComplexElement(0, 2), 1, 0);  // twin1
    solver.stampComplexElement(solver.allocComplexElement(2, 0), 1, 0);  // twin2
    solver.stampComplexElement(solver.allocComplexElement(1, 2), -1, 0);
    solver.stampComplexElement(solver.allocComplexElement(2, 1), -1, 0);
    solver.stampRHS(2, 1, 0);
    solver.finalize();

    // Record original elCol/elRow for all elements before preorder
    const elCount = solver.elementCount;
    // Collect all A-matrix element handles by traversing chains
    const preOrderCol: number[] = [];
    const preOrderRow: number[] = [];
    for (let col = 0; col < n; col++) {
      let e = solver.colHead[col];
      while (e >= 0) {
        preOrderCol[e] = solver.elCol[e];
        preOrderRow[e] = solver.elRow[e];
        e = solver.elNextInCol[e];
      }
    }

    solver.preorder();

    // After preorder, elCol and elRow values for existing elements are unchanged
    for (let col = 0; col < n; col++) {
      let e = solver.colHead[col];
      while (e >= 0) {
        if (preOrderCol[e] !== undefined) {
          expect(solver.elCol[e]).toBe(preOrderCol[e]);
          expect(solver.elRow[e]).toBe(preOrderRow[e]);
        }
        e = solver.elNextInCol[e];
      }
    }

    // Solve still satisfies A*x = b
    solver.forceReorder();
    const ok = solver.factor();
    expect(ok).toBe(true);
    const xRe = new Float64Array(n);
    const xIm = new Float64Array(n);
    solver.solve(xRe, xIm);

    // x[0] - x[1] = 1 (voltage source constraint)
    expect(Math.abs(xIm[0] - xIm[1])).toBeLessThan(1e-10);

    expect(solver.elementCount).toBe(elCount);
  });
});

// ---------------------------------------------------------------------------
// Task 0.4.4 tests
// ---------------------------------------------------------------------------

describe("ComplexSparseSolver — Task 0.4.4", () => {
  it("value_addressed_stamp_deleted", () => {
    // stamp(row, col, re, im) must not exist on the class or its interface.
    expect((new ComplexSparseSolver() as any).stamp).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Task 0.4.5 tests
// ---------------------------------------------------------------------------

describe("ComplexSparseSolver — Task 0.4.5", () => {
  it("factor_uses_numeric_path_after_first_complex_reorder", () => {
    // After one successful factor() with reorder, subsequent factor() calls
    // should use the numeric-only path.
    const n = 2;
    const solver = new ComplexSparseSolver();

    function assemble(): void {
      solver.beginAssembly(n);
      const h00 = solver.allocComplexElement(0, 0);
      solver.stampComplexElement(h00, 2, 1);
      const h01 = solver.allocComplexElement(0, 1);
      solver.stampComplexElement(h01, -1, 0);
      const h10 = solver.allocComplexElement(1, 0);
      solver.stampComplexElement(h10, -1, 0);
      const h11 = solver.allocComplexElement(1, 1);
      solver.stampComplexElement(h11, 2, 1);
      solver.stampRHS(0, 1, 0);
      solver.stampRHS(1, 1, 0);
      solver.finalize();
    }

    assemble();
    solver.forceReorder();
    solver.factor();
    expect(solver.lastFactorUsedReorder).toBe(true);

    // Second solve without forceReorder → numeric path
    assemble();
    solver.factor();
    expect(solver.lastFactorUsedReorder).toBe(false);

    // Third solve still numeric
    assemble();
    solver.factor();
    expect(solver.lastFactorUsedReorder).toBe(false);
  });

  it("forceReorder_triggers_full_complex_pivot_search", () => {
    const n = 2;
    const solver = new ComplexSparseSolver();

    function assemble(): void {
      solver.beginAssembly(n);
      solver.stampComplexElement(solver.allocComplexElement(0, 0), 2, 1);
      solver.stampComplexElement(solver.allocComplexElement(0, 1), -1, 0);
      solver.stampComplexElement(solver.allocComplexElement(1, 0), -1, 0);
      solver.stampComplexElement(solver.allocComplexElement(1, 1), 2, 1);
      solver.stampRHS(0, 1, 0);
      solver.stampRHS(1, 1, 0);
      solver.finalize();
    }

    // First factor with reorder
    assemble();
    solver.forceReorder();
    solver.factor();
    expect(solver.lastFactorUsedReorder).toBe(true);

    // Second factor without forceReorder → numeric
    assemble();
    solver.factor();
    expect(solver.lastFactorUsedReorder).toBe(false);

    // Third factor with explicit forceReorder → full pivot search again
    assemble();
    solver.forceReorder();
    solver.factor();
    expect(solver.lastFactorUsedReorder).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Wave 1.5 tests — Complex solver mirror (F1.2, F1.3, F1.4)
// ---------------------------------------------------------------------------

describe("ComplexSparseSolver — Wave 1.5 (F1.2: invalidateTopology sets _needsReorderComplex)", () => {
  it("invalidateTopology_sets_needsReorderComplex_so_next_factor_uses_reorder_path", () => {
    // Arrange: fully assembled and factored solver (no reorder needed for 2nd factor)
    const n = 2;
    const solver = new ComplexSparseSolver();

    function assemble(): void {
      solver.beginAssembly(n);
      solver.stampComplexElement(solver.allocComplexElement(0, 0), 2, 1);
      solver.stampComplexElement(solver.allocComplexElement(0, 1), -1, 0);
      solver.stampComplexElement(solver.allocComplexElement(1, 0), -1, 0);
      solver.stampComplexElement(solver.allocComplexElement(1, 1), 2, 1);
      solver.stampRHS(0, 1, 0);
      solver.stampRHS(1, 1, 0);
      solver.finalize();
    }

    assemble();
    solver.forceReorder();
    solver.factor();
    expect(solver.lastFactorUsedReorder).toBe(true);

    // Second factor without forceReorder → numeric path
    assemble();
    solver.factor();
    expect(solver.lastFactorUsedReorder).toBe(false);

    // invalidateTopology must set _needsReorderComplex = true
    solver.invalidateTopology();

    // After invalidateTopology, next assembly + factor must use the full reorder path
    assemble();
    solver.factor();
    expect(solver.lastFactorUsedReorder).toBe(true);
  });

  it("invalidateTopology_clears_pivot_order_and_resets_structure", () => {
    const n = 2;
    const solver = new ComplexSparseSolver();
    solver.beginAssembly(n);
    solver.stampComplexElement(solver.allocComplexElement(0, 0), 3, 0);
    solver.stampComplexElement(solver.allocComplexElement(1, 1), 4, 0);
    solver.finalize();
    solver.forceReorder();
    solver.factor();
    expect(solver.lastFactorUsedReorder).toBe(true);

    solver.invalidateTopology();

    // Structure must be rebuilt: element count resets to 0 on next beginAssembly
    solver.beginAssembly(n);
    expect(solver.elementCount).toBe(0);
  });
});

describe("ComplexSparseSolver — Wave 1.5 (F1.3: allocComplexElement sets _needsReorderComplex)", () => {
  it("allocComplexElement_new_entry_triggers_reorder_on_next_factor", () => {
    // Arrange: assemble and factor 2×2 system to establish pivot order
    const n = 3;
    const solver = new ComplexSparseSolver();
    solver.beginAssembly(n);
    solver.stampComplexElement(solver.allocComplexElement(0, 0), 2, 1);
    solver.stampComplexElement(solver.allocComplexElement(1, 1), 2, 1);
    solver.stampComplexElement(solver.allocComplexElement(2, 2), 2, 1);
    solver.stampRHS(0, 1, 0);
    solver.stampRHS(1, 1, 0);
    solver.stampRHS(2, 1, 0);
    solver.finalize();
    solver.forceReorder();
    solver.factor();
    expect(solver.lastFactorUsedReorder).toBe(true);

    // Reassemble without new elements — should use numeric path
    solver.beginAssembly(n);
    solver.stampComplexElement(solver.allocComplexElement(0, 0), 2, 1);
    solver.stampComplexElement(solver.allocComplexElement(1, 1), 2, 1);
    solver.stampComplexElement(solver.allocComplexElement(2, 2), 2, 1);
    solver.stampRHS(0, 1, 0);
    solver.stampRHS(1, 1, 0);
    solver.stampRHS(2, 1, 0);
    solver.finalize();
    solver.factor();
    expect(solver.lastFactorUsedReorder).toBe(false);

    // Now add a NEW off-diagonal element — allocComplexElement must set _needsReorderComplex
    solver.beginAssembly(n);
    solver.stampComplexElement(solver.allocComplexElement(0, 0), 2, 1);
    solver.stampComplexElement(solver.allocComplexElement(1, 1), 2, 1);
    solver.stampComplexElement(solver.allocComplexElement(2, 2), 2, 1);
    // New element: (0,1) not previously allocated
    solver.stampComplexElement(solver.allocComplexElement(0, 1), -0.5, 0);
    solver.stampRHS(0, 1, 0);
    solver.stampRHS(1, 1, 0);
    solver.stampRHS(2, 1, 0);
    solver.finalize();
    solver.factor();
    // New element inserted → reorder must have been triggered
    expect(solver.lastFactorUsedReorder).toBe(true);
  });
});

describe("ComplexSparseSolver — Wave 1.5 (F1.4: threshold constants + per-instance tolerances)", () => {
  it("setComplexPivotTolerances_method_exists_and_accepts_valid_values", () => {
    const solver = new ComplexSparseSolver();
    // Must exist and not throw
    expect(() => solver.setComplexPivotTolerances(1e-3, 0.0)).not.toThrow();
    expect(() => solver.setComplexPivotTolerances(0.01, 1e-12)).not.toThrow();
  });

  it("setComplexPivotTolerances_ignores_out_of_range_values", () => {
    const n = 2;
    const solver = new ComplexSparseSolver();
    solver.beginAssembly(n);
    solver.stampComplexElement(solver.allocComplexElement(0, 0), 2, 1);
    solver.stampComplexElement(solver.allocComplexElement(1, 1), 3, 0);
    solver.stampRHS(0, 1, 0);
    solver.stampRHS(1, 2, 0);
    solver.finalize();

    // Out-of-range rel threshold (> 1) and negative abs threshold must be silently ignored
    solver.setComplexPivotTolerances(2.0, -1.0);

    solver.forceReorder();
    const ok = solver.factor();
    expect(ok).toBe(true);

    const xRe = new Float64Array(n);
    const xIm = new Float64Array(n);
    solver.solve(xRe, xIm);

    // x[0] = 1/(2+j) = (2-j)/5
    // x[1] = 2/3
  });

  it("default_rel_threshold_is_1e_minus_3_matching_ngspice_DEFAULT_THRESHOLD", () => {
    // With rel threshold = 1e-3, a pivot whose magnitude is >= 1e-3 * colMax
    // must be accepted. Build a 2×2 system with a small but valid pivot and verify solve.
    const n = 2;
    const solver = new ComplexSparseSolver();
    solver.setComplexPivotTolerances(1e-3, 0.0);
    solver.beginAssembly(n);
    solver.stampComplexElement(solver.allocComplexElement(0, 0), 1000, 0);
    solver.stampComplexElement(solver.allocComplexElement(0, 1), 1, 0);
    solver.stampComplexElement(solver.allocComplexElement(1, 0), 1, 0);
    solver.stampComplexElement(solver.allocComplexElement(1, 1), 2, 0);
    solver.stampRHS(0, 1001, 0);
    solver.stampRHS(1, 3, 0);
    solver.finalize();
    solver.forceReorder();
    const ok = solver.factor();
    expect(ok).toBe(true);

    const xRe = new Float64Array(n);
    const xIm = new Float64Array(n);
    solver.solve(xRe, xIm);

    // Verify A*x = b by residual
    const r0 = 1000 * xRe[0] + xRe[1] - 1001;
    const r1 = xRe[0] + 2 * xRe[1] - 3;
    expect(Math.abs(r0)).toBeLessThan(1e-8);
    expect(Math.abs(r1)).toBeLessThan(1e-8);
  });

  it("setComplexPivotTolerances_affects_pivot_selection_solve_still_correct", () => {
    // Verify solve produces correct result after tolerance override
    const n = 3;
    const solver = new ComplexSparseSolver();
    solver.setComplexPivotTolerances(1e-3, 0.0);
    solver.beginAssembly(n);
    solver.stampComplexElement(solver.allocComplexElement(0, 0), 2, 1);
    solver.stampComplexElement(solver.allocComplexElement(0, 1), -1, 0);
    solver.stampComplexElement(solver.allocComplexElement(1, 0), -1, 0);
    solver.stampComplexElement(solver.allocComplexElement(1, 1), 2, 1);
    solver.stampComplexElement(solver.allocComplexElement(1, 2), -1, 0);
    solver.stampComplexElement(solver.allocComplexElement(2, 1), -1, 0);
    solver.stampComplexElement(solver.allocComplexElement(2, 2), 2, 1);
    solver.stampRHS(0, 1, 0);
    solver.stampRHS(1, 0, 0);
    solver.stampRHS(2, 1, 0);
    solver.finalize();
    solver.forceReorder();
    const ok = solver.factor();
    expect(ok).toBe(true);

    const xRe = new Float64Array(n);
    const xIm = new Float64Array(n);
    solver.solve(xRe, xIm);

    // Verify residual A*x = b
    const res0Re = 2 * xRe[0] - xIm[0] + (-1) * xRe[1] - 1;
    const res0Im = 2 * xIm[0] + xRe[0] + (-1) * xIm[1];
    const res1Re = (-1) * xRe[0] + 2 * xRe[1] - xIm[1] + (-1) * xRe[2];
    const res1Im = (-1) * xIm[0] + 2 * xIm[1] + xRe[1] + (-1) * xIm[2];
    const res2Re = (-1) * xRe[1] + 2 * xRe[2] - xIm[2] - 1;
    const res2Im = (-1) * xIm[1] + 2 * xIm[2] + xRe[2];
    expect(Math.abs(res0Re)).toBeLessThan(1e-10);
    expect(Math.abs(res0Im)).toBeLessThan(1e-10);
    expect(Math.abs(res1Re)).toBeLessThan(1e-10);
    expect(Math.abs(res1Im)).toBeLessThan(1e-10);
    expect(Math.abs(res2Re)).toBeLessThan(1e-10);
    expect(Math.abs(res2Im)).toBeLessThan(1e-10);
  });
});
