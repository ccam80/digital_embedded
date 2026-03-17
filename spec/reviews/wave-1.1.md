# Review Report: Wave 1.1 — Sparse Solver

## Summary

| Item | Count |
|------|-------|
| Tasks reviewed | 1 (Task 1.1.1) |
| Violations — critical | 0 |
| Violations — major | 2 |
| Violations — minor | 2 |
| Gaps | 2 |
| Weak tests | 2 |
| Legacy references | 0 |

**Verdict**: has-violations

---

## Violations

### Violation 1

- **File**: `src/analog/__tests__/sparse-solver.test.ts`, line 297–300
- **Rule**: Rules — Testing: "No `pytest.approx()` with loose tolerances to make tests pass." (TypeScript equivalent: performance assertions with explicitly bloated thresholds to guarantee pass.)
- **Evidence**:
  ```ts
  // CI-relaxed performance targets (5x relaxed as per spec)
  expect(tSymbolic).toBeLessThan(5);    // 1ms * 5
  expect(tFactor).toBeLessThan(2.5);    // 0.5ms * 5
  expect(tSolve).toBeLessThan(1.0);     // 0.2ms * 5
  ```
  The comment reads "CI-relaxed performance targets (5x relaxed as per spec)". The spec says to apply a CI tolerance, but the agent explicitly states it has multiplied the spec targets by 5× in the comment. This is a comment that describes a deliberate loosening of a test threshold — the very pattern the rules prohibit. The spec states "5x relaxed for CI" once, and the test adds its own inline justification comment confirming it knowingly inflated the thresholds. A comment explaining why a tolerance was loosened is proof of intentional rule-bending, not a mitigating factor.
- **Severity**: major

### Violation 2

- **File**: `src/analog/__tests__/sparse-solver.test.ts`, line 106–107
- **Rule**: Rules — Testing: "Test the specific: exact values, exact types, exact error messages where applicable." Weak assertion: `toBeDefined()` without checking the actual value.
- **Evidence**:
  ```ts
  expect(result.singularRow).toBeDefined();
  expect(typeof result.singularRow).toBe("number");
  ```
  `singularRow` is asserted only to be defined and of type `number`. The spec for `detects_singular_matrix` says "assert `factor()` returns `{ success: false }` with `singularRow` set". The singular matrix `[[1,1],[1,1]]` has a known algebraic structure — row 1 becomes all-zeros after elimination, so `singularRow` must be 1. The test does not assert the specific row value. "Is defined and is a number" is a trivially weak assertion for a two-row matrix where the singular row is deterministic.
- **Severity**: major

### Violation 3

- **File**: `src/analog/sparse-solver.ts`, lines 145–155
- **Rule**: Code Hygiene — "No fallbacks. No backwards compatibility shims. No safety wrappers." The `factor()` method contains a silent retry-on-failure path with internal state mutation disguised as normal control flow.
- **Evidence**:
  ```ts
  factor(): FactorResult {
    const result = this._numericLU();
    if (!result.success && result.singularRow === undefined) {
      // Pattern proved insufficient — force re-analysis and retry once.
      this._topologyDirty = true;
      this._computeAMD();
      this._allocateNumericArrays();
      this._prevCscColPtr = this._cscColPtr.slice();
      this._prevCscRowIdx = this._cscRowIdx.slice();
      this._topologyDirty = false;
      return this._numericLU();
    }
    return result;
  }
  ```
  The spec says: "Triggers re-symbolization if no valid pivot is found in the current pattern." The implementation silently swallows the failure condition (`result.singularRow === undefined`), mutates internal topology state, and retries. The distinction `!result.success && result.singularRow === undefined` (pivot threshold not met) versus `!result.success && result.singularRow !== undefined` (true singularity) is not surfaced to the caller or tested. This is a hidden fallback path with no test coverage of the branch where it triggers.
- **Severity**: minor

### Violation 4

- **File**: `src/analog/sparse-solver.ts`, lines 274–275
- **Rule**: Code Hygiene — no heap allocations on the hot path. The CSC duplicate-summing loop allocates JavaScript plain arrays (`tempRows: number[]`, `tempVals: number[]`) and creates `Array<[number, number]>` per column inside `_buildCSC()`.
- **Evidence**:
  ```ts
  const tempRows: number[] = [];
  const tempVals: number[] = [];
  // ...
  for (let j = 0; j < n; j++) {
    const col: Array<[number, number]> = [];  // allocated per column
  ```
  `_buildCSC()` is called from `finalize()` which is called every NR iteration. The spec says "All internal arrays pre-allocated after first symbolic pass; no heap allocations on numeric factor + solve hot path." `finalize()` is part of the hot NR path (step d in the NR algorithm in the spec). The plain `number[]` and per-column `Array<[number, number]>` allocations violate the no-allocation constraint. The spec's intent is that `beginAssembly` / `finalize` / `factor` / `solve` do not allocate after the first symbolic pass. The CSC conversion does allocate.
- **Severity**: minor

---

## Gaps

### Gap 1

- **Spec requirement**: "Symbolic factorization: determines nonzero pattern of L and U factors without computing values; runs once per topology change." (Task 1.1.1 description and implementation notes.) The spec is explicit: the symbolic phase computes the **nonzero pattern of L and U** separately from numeric values.
- **What was found**: No symbolic LU factorization is implemented. `_computeAMD()` runs the AMD ordering and `_allocateNumericArrays()` pre-allocates a dense n×n matrix. There is no symbolic sparsity analysis — the implementation uses a full **dense** LU factorization (`_luA: Float64Array = new Float64Array(n * n)`) that operates on all n² entries regardless of sparsity. The AMD ordering is computed, permutation applied to the dense matrix, and dense Gaussian elimination performed. The symbolic step (determining which entries of L and U are structurally nonzero and skipping zeros during numeric factorization) is absent.
- **File**: `src/analog/sparse-solver.ts` (entire `_numericLU` method, lines 439–525)

### Gap 2

- **Spec requirement**: "Pivot selection uses threshold partial pivoting within the symbolic nonzero pattern (Markowitz strategy): among pivot candidates within the existing symbolic nonzero pattern, select the one that minimizes Markowitz count (row_nnz - 1) × (col_nnz - 1), subject to `|candidate| >= pivotThreshold × max(|column|)`."
- **What was found**: The implementation uses standard threshold partial pivoting (maximum absolute value among candidates that exceed the threshold) without any Markowitz count computation. No `row_nnz` or `col_nnz` tracking exists. The pivot selection loop at lines 473–483 selects the row with the largest absolute value above threshold — this is not the Markowitz strategy. The Markowitz criterion minimizes fill-in during elimination; the current implementation ignores fill-in entirely.
- **File**: `src/analog/sparse-solver.ts`, lines 458–497 (`_numericLU` pivot selection)

---

## Weak Tests

### Weak Test 1

- **Test path**: `src/analog/__tests__/sparse-solver.test.ts::SparseSolver::detects_singular_matrix`
- **Problem**: `singularRow` is asserted only to be defined and of type `number`. For the specific 2×2 singular matrix `[[1,1],[1,1]]`, the singular row is deterministic (row 1 after AMD permutation). The assertion `expect(result.singularRow).toBeDefined()` would pass even if `singularRow` were set to a nonsense value like `-1` or `999`. The spec says "assert `factor()` returns `{ success: false }` with `singularRow` set" — "set" implies checking a meaningful value, not just type.
- **Evidence**:
  ```ts
  expect(result.singularRow).toBeDefined();
  expect(typeof result.singularRow).toBe("number");
  ```

### Weak Test 2

- **Test path**: `src/analog/__tests__/sparse-solver.test.ts::SparseSolver::reuses_symbolic_across_numeric_refactor`
- **Problem**: The spec requires verifying that the symbolic pass ran only once: "verify symbolic ran only once (internal state check or timing comparison)". The test only verifies that both solutions are numerically correct — it makes no assertion about whether the symbolic phase was cached. A bug where AMD is recomputed on every `finalize()` call would still pass this test. No internal state is inspected (e.g., checking `_topologyDirty` flag state or counting AMD invocations).
- **Evidence**: The test calls `solver.finalize()` twice and checks both solutions are correct, but has no assertion relating to symbolic reuse. The comment "topology should NOT be dirty — same nonzero pattern" at line 157 acknowledges the intent but no assertion enforces it.

---

## Legacy References

None found.
