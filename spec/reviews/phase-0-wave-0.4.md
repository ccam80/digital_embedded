# Review Report: Phase 0 Wave 0.4 — Complex Sparse Solver Parity

## Summary

| Item | Count |
|------|-------|
| Tasks reviewed | 5 (0.4.1, 0.4.2, 0.4.3, 0.4.4, 0.4.5) |
| Violations — critical | 0 |
| Violations — major | 2 |
| Violations — minor | 3 |
| Gaps | 3 |
| Weak tests | 3 |
| Legacy references | 0 |

**Verdict: has-violations**

---

## Violations

### V-1 (major): `forceReorder()` called after `finalize()` — violates spec placement

**File**: `src/solver/analog/ac-analysis.ts` lines 190–191

**Rule violated**: Task 0.4.5 spec description: "After the first frequency's `beginAssembly(N_ac)` and element stamps, call `solver.forceReorder()` exactly once". The files-to-modify note says: "`AcAnalysis.run()` calls `solver.forceReorder()` once before the first frequency's `finalize()` / `factor()`."

**Evidence**:
```typescript
      complexSolver.finalize();           // line 190 — finalize runs first
      if (fi === 0) complexSolver.forceReorder();  // line 191 — forceReorder AFTER finalize
      const ok = complexSolver.factor();  // line 192
```

**Problem**: The spec unambiguously says `forceReorder()` is called before `finalize()` / `factor()`. The implementation calls it after `finalize()`. `forceReorder()` sets `_needsReorderComplex = true`; because `finalize()` only recomputes Markowitz counts and does not branch on `_needsReorderComplex`, the net behavior is functionally equivalent here — but the placement violates the spec contract. If `finalize()` is ever extended to check reorder state (as it does on the real side where preorder interacts with `finalize`), this ordering will silently break.

**Severity**: major

---

### V-2 (major): `ac_sweep_caller_reuses_branch_handles_across_frequencies` does not test the production code path

**File**: `src/solver/analog/__tests__/ac-analysis.test.ts` lines 487–541

**Rule violated**: CLAUDE.md Three-Surface Testing Rule; spec Task 0.4.4 tests description: "Spy on `solver.allocComplexElement` on the exact solver instance used by `AcAnalysis.run()`."

**Evidence** (lines 488–527):
```typescript
  it("ac_sweep_caller_reuses_branch_handles_across_frequencies", () => {
    // Verify the handle-caching contract in ac-analysis.ts directly by simulating
    // the frequency-sweep loop logic: allocComplexElement called on fi===0 only,
    // ...
    // Uses a direct ComplexSparseSolver instance (no DC-OP path).
    const { ComplexSparseSolver: CSS } = ComplexSolverModule;
    const complexSolver = new CSS();
    const allocSpy = vi.spyOn(complexSolver, "allocComplexElement");
    // ... manually re-implements the loop
```

**Problem**: The test instantiates its own `ComplexSparseSolver`, manually re-implements the frequency-sweep loop (a copy of the code under test), and spies on its own solver — not the solver instance created inside `AcAnalysis.run()`. This test cannot detect regressions in the actual production caller. The spec explicitly requires spying on "the exact solver instance used by `AcAnalysis.run()`", which requires either exposing the solver or wrapping the constructor. The current test is a tautology: it only verifies that the test author's copy of the loop calls `allocComplexElement` twice.

**Severity**: major

---

### V-3 (minor): `void elCount` — dead variable suppressor in production test

**File**: `src/solver/analog/__tests__/complex-sparse-solver.test.ts` line 570

**Rule violated**: rules.md Code Hygiene — no dead or commented-out code.

**Evidence**:
```typescript
    void elCount;
```

**Problem**: `elCount` (line 532) is captured with `const elCount = solver.elementCount` but never asserted on. The `void elCount` suppresses the TypeScript "unused variable" error without adding any test value. This is a dead variable with a suppressor — the variable should either be asserted on (e.g. `expect(elCount).toBe(6)`) or removed entirely.

**Severity**: minor

---

### V-4 (minor): `_buildCSCFromLinked` method present in `complex-sparse-solver.ts` but not referenced in spec for the complex side

**File**: `src/solver/analog/complex-sparse-solver.ts` line 1094

**Rule violated**: Spec adherence — scope creep / unlisted method.

**Evidence** (Grep output):
```
1094:  private _buildCSCFromLinked(): void {
1124:      this._buildCSCFromLinked();
```

**Problem**: Task 0.4.3 modifies `complex-sparse-solver.ts` and the Task 0.4.1 "Files to modify" spec for the complex solver does not list `_buildCSCFromLinked` as a method to add. The corresponding real-side method `_buildCSCFromLinked` was specified in Task 0.1.3 for `sparse-solver.ts`. The complex solver having this method is plausibly correct (it is needed to scatter L/U values into CSC format after factorization), but no spec task for Wave 0.4 lists it as a file-to-create item. This may be scope creep or may be a gap in the spec. Flagging for user determination.

**Severity**: minor

---

### V-5 (minor): Test tolerances below IEEE-754 bit-exact bar required by spec

**File**: `src/solver/analog/__tests__/complex-sparse-solver.test.ts` lines 422–423 and 381–382

**Rule violated**: Spec "Bit-exactness target" for Wave 0.4: "Per-frequency node voltages match ngspice `.AC` output with `absDelta === 0` on both real and imaginary parts — same IEEE-754 bar applied to DC/transient in Phase 7."

**Evidence**:
```typescript
    // preorder_handles_multiple_complex_twins, lines 422-423:
    expect(xRe[0] - xRe[1]).toBeCloseTo(1.0, 8);   // 8 decimal places only
    expect(xRe[3]).toBeCloseTo(2.0, 8);              // 8 decimal places only

    // preorder_fixes_zero_diagonal_from_ac_voltage_source, lines 381-382:
    expect(xRe[0] - xRe[1]).toBeCloseTo(1.0, 10);
    expect(Math.abs(xIm[0] - xIm[1])).toBeLessThan(1e-10);
```

**Problem**: The spec sets an IEEE-754 bit-exact bar (absDelta === 0) for per-frequency node voltages. Unit tests that verify solver correctness with `toBeCloseTo(x, 8)` (1e-8 tolerance) and `toBeLessThan(1e-10)` do not meet this standard. These tests would pass even if the implementation has floating-point errors at the 9th–15th significant digit. The `preorder_handles_multiple_complex_twins` test uses `toBeCloseTo(1.0, 8)` which allows errors up to 5e-9.

Note: The bit-exact bar in the spec is specifically stated as a "target" for parity tests against ngspice output. The unit tests here are not parity tests per se, but the spec does not create a separate tolerance tier for unit tests. Flagging per rules.

**Severity**: minor

---

## Gaps

### G-1: `ac_sweep_caller_reuses_branch_handles_across_frequencies` — spec requires spying on production `AcAnalysis.run()` solver instance

**Spec requirement** (Task 0.4.4 tests): "Spy on `solver.allocComplexElement` on the exact solver instance used by `AcAnalysis.run()`. Assert it is invoked exactly twice across the whole sweep — both on frequency 0 (the AC voltage-source branch-row handles) — and zero times on frequencies 1 and 2."

**What was found**: The test creates an independent `ComplexSparseSolver` and re-implements the sweep loop manually. `AcAnalysis.run()` is never called in this test. The spy is placed on a test-local solver, not the production solver.

**File**: `src/solver/analog/__tests__/ac-analysis.test.ts` lines 487–541

---

### G-2: `ac_sweep_single_reorder_across_frequencies` does not call `AcAnalysis.run()`

**Spec requirement** (Task 0.4.5 tests): "5-point AC sweep; assert `solver.lastFactorUsedReorder === true` on frequency 1 and `false` on frequencies 2–5."

The spec implies this test exercises the production `AcAnalysis.run()` path to verify the forceReorder lifecycle end-to-end. Instead the test manually re-implements the sweep loop with its own `ComplexSparseSolver` instance (lines 552–591), never invoking `AcAnalysis.run()`.

**What was found**: The test at line 549–591 manually drives a `ComplexSparseSolver` through a loop. This verifies solver dispatch logic in isolation but cannot detect if `AcAnalysis.run()` fails to call `forceReorder()` at all or calls it at the wrong iteration.

**File**: `src/solver/analog/__tests__/ac-analysis.test.ts` lines 548–591

---

### G-3: `value_addressed_stamp_deleted` test is trivially weak for a deleted-method check

**Spec requirement** (Task 0.4.4 acceptance criteria): "Grep for `\.stamp\s*\(` on a `ComplexSparseSolver` variable anywhere in `src/` returns zero hits outside the test that asserts its absence."

**What was found**: The test `value_addressed_stamp_deleted` (line 579–582) only checks `(new ComplexSparseSolver() as any).stamp === undefined`. This passes if the method is deleted from the prototype. However, the acceptance criterion also requires a codebase-wide grep assertion. No such grep-based test exists. More importantly, any test that relies on `as any` runtime duck-typing is weaker than a TypeScript compile-time check (which would fail at `tsc --noEmit` if the method were still present in the interface). The test cannot verify that the interface declaration in `analog-types.ts` or `element.ts` also no longer carries `stamp`.

**File**: `src/solver/analog/__tests__/complex-sparse-solver.test.ts` lines 578–583

---

## Weak Tests

### W-1: `stampComplexElement_inserts_into_linked_structure` — col 1 chain not verified

**Test path**: `src/solver/analog/__tests__/complex-sparse-solver.test.ts::ComplexSparseSolver — Task 0.4.1::stampComplexElement_inserts_into_linked_structure`

**Problem**: The test verifies `rowHead[0]`, `rowHead[1]`, and `colHead[0]` chains but does not verify `colHead[1]` (which should contain `h01` and `h11`). The spec requires verifying the linked structure "accessible via `_rowHead`/`_colHead` chains" — a complete check requires both columns.

**Evidence** (lines 127–133):
```typescript
    // colHead chains: col 0 should reach h00 and h10
    const col0Elements: number[] = [];
    e = solver.colHead[0];
    while (e >= 0) { col0Elements.push(e); e = solver.elNextInCol[e]; }
    expect(col0Elements).toContain(h00);
    expect(col0Elements).toContain(h10);
    expect(col0Elements.length).toBe(2);
    // colHead[1] chain is never checked
```

**Severity**: weak assertion — incomplete coverage

---

### W-2: `void elCount` — captured variable never asserted on

**Test path**: `src/solver/analog/__tests__/complex-sparse-solver.test.ts::ComplexSparseSolver — Task 0.4.3::complex_elCol_preserved_after_preorder_swap`

**Problem**: `const elCount = solver.elementCount` (line 532) is captured before preorder to verify element count is preserved. The intent is clearly to assert that preorder does not create or destroy elements. However, the value is never used in an assertion — only `void elCount` appears (line 570) to suppress the unused-variable error. The element-count-invariant check is completely missing.

**Evidence**:
```typescript
    const elCount = solver.elementCount;   // line 532 — captured but never asserted
    // ... 38 lines later ...
    void elCount;                           // line 570 — suppressor only
```

**Severity**: weak assertion — captured invariant never verified

---

### W-3: `ac_sweep_caller_reuses_branch_handles_across_frequencies` — tests a hand-rolled copy of production code, not production code itself

**Test path**: `src/solver/analog/__tests__/ac-analysis.test.ts::AC — Task 0.4.4::ac_sweep_caller_reuses_branch_handles_across_frequencies`

**Problem**: The test manually re-implements the handle-caching loop (lines 507–527) rather than calling `AcAnalysis.run()`. The comment on line 488–491 admits this: "by simulating the frequency-sweep loop logic" and "Uses a direct ComplexSparseSolver instance (no DC-OP path)". An assertion on a hand-rolled copy of production logic is tautological — it verifies that the copy of the logic the test author wrote is correct, not that the actual production code is correct. If someone changes `ac-analysis.ts` to not cache handles, this test would still pass.

**Evidence** (lines 488–491):
```typescript
    // Verify the handle-caching contract in ac-analysis.ts directly by simulating
    // the frequency-sweep loop logic: allocComplexElement called on fi===0 only,
    // stampComplexElement called on every fi.
    // Uses a direct ComplexSparseSolver instance (no DC-OP path).
```

**Severity**: test does not verify the code under test

---

## Legacy References

None found.

---

## Notes on Tasks 0.4.2 and 0.4.3

Tasks 0.4.2 and 0.4.3 are reported in `spec/progress.md` as complete with "no files modified — already satisfied by 0.4.1 implementation". This means the agent implemented all three tasks in a single pass under Task 0.4.1. The implementation in `complex-sparse-solver.ts` confirms:

- No `_perm`, `_permInv`, `_computeAMD`, `_buildEtree`, or `_symbolicLU` names exist (Task 0.4.2 acceptance criterion met).
- `_allocateComplexWorkspace()` exists as the renamed replacement (Task 0.4.2 met).
- `preorder()` is implemented with `_didPreorderComplex` gate, `_findComplexTwin()`, `_swapComplexColumns()` (Task 0.4.3 met).
- Magnitude check uses `re*re + im*im === 1.0` (Task 0.4.3 met).
- `_preorderComplexColPerm` and `_extToIntComplexCol` are maintained in lockstep (Task 0.4.3 met).

The rolled-up delivery is architecturally sound. The violations are concentrated in the test quality (Tasks 0.4.4 and 0.4.5) and the `forceReorder` placement (Task 0.4.5).
