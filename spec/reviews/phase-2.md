# Review Report: Phase 2 — Matrix Factorization (Wave 2)

Tasks reviewed: 2.1.1, 2.1.2, 2.1.3, 2.2.1, 2.2.2, 2.2.3, 2.2.4

---

## Summary

| Field | Value |
|-------|-------|
| Tasks reviewed | 7 (2.1.1, 2.1.2, 2.1.3, 2.2.1, 2.2.2, 2.2.3, 2.2.4) |
| Violations — critical | 0 |
| Violations — major | 3 |
| Violations — minor | 2 |
| Gaps | 2 |
| Weak tests | 6 |
| Legacy references | 0 |
| Verdict | has-violations |

---

## Violations

### V-1 — Major: `_numericLUReusePivots` uses wrong L-entry classification condition

**File**: `src/solver/analog/sparse-solver.ts`, line 1048
**Rule**: SPICE-Correct Implementations Only (CLAUDE.md)

**Evidence**:
```typescript
if (pinv[i] <= k) continue;
```

**Analysis**: In `_numericLUMarkowitz` (the full-pivot analogue), the L-entry loop at line 944 guards with `if (pinv[i] >= 0) continue` — meaning: skip rows already pivoted (pinv >= 0), store L entries only for unpivoted rows (pinv < 0). This is correct: L entries are multipliers for rows not yet eliminated.

In `_numericLUReusePivots` the guard is `if (pinv[i] <= k) continue`. Because `_numericLUReusePivots` does NOT reset `pinv` (correct per spec — "Does NOT call pinv.fill(-1)"), `pinv[i]` retains the step at which each row was pivoted during the prior `factorWithReorder` call. For the current step k, the pivot row `q[k]` has `pinv[q[k]] = k` from the prior run. Rows to be eliminated in future steps have `pinv[i] > k`. The condition `<= k` incorrectly excludes the current pivot row (`pinv[q[k]] = k`) from being considered — but actually the pivot row is handled separately (stored in U), so this exclusion is about the L entries for OTHER rows. Let me state the correct invariant precisely: L entries are rows `i` where `pinv[i] > k` (not yet pivoted in future steps, unpivoted). The condition `pinv[i] <= k` correctly skips already-eliminated rows and the current pivot row. However, in the original `_numericLUMarkowitz` path at line 944, pinv is reset to -1 at the start and row `i` is marked `pinv[pivotRow] = k` just before the L loop. In the reuse path, `pinv[i]` for rows pivoted in previous steps holds values 0..k-1, for the current step k holds k, and for future steps holds k+1..n-1. Thus `pinv[i] <= k` skips rows with pinv 0..k (all prior pivots and current pivot), keeping only `pinv[i] > k` (future pivots) for L. This is the correct set of unpivoted rows in the reuse path.

Reconsidering: the condition `pinv[i] <= k` in `_numericLUReusePivots` at line 1048 IS actually correct for the reuse path, unlike the framing above. The progress.md note confirms the implementer was aware of this difference. However, this differs from `_numericLUMarkowitz` which uses `pinv[i] >= 0` — but that method calls `pinv.fill(-1)` at start so unpivoted rows have pinv=-1 (< 0). The semantics are equivalent for their respective paths. This is not a bug; it is a correct adaptation of the L-entry guard to the non-reset-pinv path. Withdrawing the severity escalation on the correctness claim — but the inconsistency between the two methods and the absence of a comment explaining the semantic difference remains a code quality concern. This violation is reclassified below.

**Revised assessment**: The condition is correct for the reuse path semantics. Not a bug. Downgraded to a code clarity concern (no violation).

---

### V-1 (revised) — Major: `void unz` is dead no-op code in two factorization methods

**File**: `src/solver/analog/sparse-solver.ts`, lines 926 and 1030
**Rule**: Code Hygiene — No commented-out code. No dead code.

**Evidence** (line 926, inside `_numericLUMarkowitz`):
```typescript
void unz;
for (let idx = 0; idx < xNzCount; idx++) {
  const i = xNzIdx[idx];
  if (x[i] === 0) continue;
  const s = pinv[i];
  if (s >= 0 && s < k) {
    this._uRowIdx[unz] = i;
    this._uVals[unz] = x[i];
    unz++;
  }
}
```

And at line 1030 inside `_numericLUReusePivots` with identical pattern.

**Analysis**: `void unz` is a JavaScript no-op expression used to silence a linter/compiler "declared but not used before assignment" or "value is never read" warning. `unz` IS actively used — it is incremented immediately within the following loop. The `void` expression has zero runtime effect. This is dead noise code introduced to suppress a spurious warning rather than diagnosing its root cause. The rules prohibit any code that serves no functional purpose.

**Severity**: Major

---

### V-2 — Major: `_searchForPivot` 4-phase dispatcher was implemented (task 2.2.3) then deleted — pivot selection not Markowitz-driven

**File**: `src/solver/analog/sparse-solver.ts` (absent); progress.md task fix-batch7-verifier-issues
**Rule**: Completeness — Never mark work as deferred or not implemented.

**Evidence** (progress.md, fix-batch7-verifier-issues):
> "deleted _numericLU, _searchForPivot, _searchDiagonal, _searchSingletons, _searchColumn, _searchEntireMatrix"

And in progress.md task 2.2.4 notes:
> "Pivot selection currently uses partial pivoting (same as _numericLU) because the Markowitz row counts become stale after fill-in entries are created during elimination … Switching to Markowitz-based pivot selection requires implementing fill-in tracking in the reduced matrix, which is a separate enhancement."

**Analysis**: Task 2.2.3 required implementing `_searchForPivot` as a callable 4-phase dispatcher. Task 2.2.4 required wiring it into `factorWithReorder`. The batch-7 fix agent deleted all search methods to resolve TypeScript errors. The progress.md deferral note for task 2.2.4 explicitly acknowledges the Markowitz pivot selection is not used — "a separate enhancement." This is a prohibited deferral under rules.md and CLAUDE.md. The Markowitz data structures are computed and updated but have no effect on pivot choice. The current `_numericLUMarkowitz` pivot selection loop (lines 869–903) uses plain magnitude-based partial pivoting identical to the old `_numericLU`.

**Severity**: Major

---

### V-3 — Minor: Comment in `_numericLUMarkowitz` claims Markowitz data influences pivot selection but it does not

**File**: `src/solver/analog/sparse-solver.ts`, lines 862–868
**Rule**: Code Hygiene — Comments must not misrepresent what the code does.

**Evidence**:
```typescript
// Pivot selection: find maximum magnitude among unpivoted rows,
// apply relative threshold, then select the largest acceptable entry.
// The Markowitz data structures (_markowitzRow, _markowitzCol,
// _markowitzProd, _singletons) are populated and updated at each step
// for instrumentation and accessible via public getters.
```

**Analysis**: The actual pivot selection code (lines 869–903) uses magnitude-based partial pivoting only — it does not consult `_markowitzProd` or `_singletons`. The comment states Markowitz structures "are populated and updated at each step" implying they drive the selection. This misleads a future developer into believing Markowitz-weighted pivot selection is active.

**Severity**: Minor

---

### V-4 — Minor: `_updateMarkowitzNumbers` column scan is O(n * nnz) — does not match ngspice algorithm complexity

**File**: `src/solver/analog/sparse-solver.ts`, lines 1172–1183
**Rule**: SPICE-Correct Implementations Only (CLAUDE.md)

**Evidence**:
```typescript
for (let origC = 0; origC < n; origC++) {
  const start = colPtr[origC];
  const end = colPtr[origC + 1];
  for (let p = start; p < end; p++) {
    if (rowIdx[p] === origPivotRow) {
```

**Analysis**: To find all columns containing an entry in `origPivotRow`, the implementation scans all n columns in CSC. This is O(nnz) per invocation, called at each of n steps: O(n * nnz) total. ngspice `UpdateMarkowitzNumbers` in spfactor.c locates affected columns directly via the pivot row's nonzero list, giving O(nnz_row) per step. For realistic MNA matrices this may be tolerable, but CLAUDE.md requires matching the ngspice source function. The algorithmic complexity diverges materially.

**Severity**: Minor

---

## Gaps

### G-1 — `_searchForPivot` 4-phase dispatcher absent from production code

**Spec requirement** (impl-spec-wave-2.md, task 2.2.3):
> "Implement _searchForPivot() — 4-phase dispatcher"
> Singleton detection, diagonal preference, column search, and full matrix fallback as distinct named phases.

**What was found**: `_searchForPivot`, `_searchDiagonal`, `_searchSingletons`, `_searchColumn`, and `_searchEntireMatrix` are absent from `sparse-solver.ts`. The batch-7 fix agent deleted all five methods to resolve TypeScript errors. Tests that exercised these methods were replaced with end-to-end `factorWithReorder` calls that do not validate 4-phase dispatch behaviour.

**File**: `src/solver/analog/sparse-solver.ts`

---

### G-2 — Markowitz pivot selection is computed but not used to make pivot decisions

**Spec requirement** (impl-spec-wave-2.md, tasks 2.2.1–2.2.4):
> Tasks 2.2.1–2.2.4 build Markowitz data structures, counting, products, search, and update — all to be wired into `factorWithReorder` for Markowitz-weighted pivot selection.

**What was found**: `factorWithReorder` calls `_countMarkowitz`, `_markowitzProducts`, and `_updateMarkowitzNumbers`. These populate `_markowitzRow`, `_markowitzCol`, `_markowitzProd`, and `_singletons`. However, the pivot selection loop (lines 869–903) does not consult any of these values when choosing `pivotRow`. The Markowitz infrastructure is entirely decorative — its outputs are stored in public getters for "instrumentation" but have no effect on the factorization. Progress.md task 2.2.4 notes explicitly defer Markowitz-based pivot selection as "a separate enhancement."

**File**: `src/solver/analog/sparse-solver.ts`, lines 862–903

---

## Weak Tests

### WT-1 — `singularRow` not validated to an exact value

**Test**: `src/solver/analog/__tests__/sparse-solver.test.ts::SparseSolver::detects_singular_matrix` (lines 93–108)

**Evidence**:
```typescript
expect(result.singularRow).toBeDefined();
expect(typeof result.singularRow).toBe("number");
```

**Problem**: For a deterministic 2×2 singular matrix [[1,1],[1,1]], `singularRow` should be a specific step index. `toBeDefined()` + `typeof === "number"` passes even if `singularRow` is `NaN`, `Infinity`, or a wrong step index. The test must assert the exact value.

---

### WT-2 — `singularRow` in `factorWithReorder` singular detection not validated to an exact value

**Test**: `src/solver/analog/__tests__/sparse-solver.test.ts::SparseSolver factorWithReorder::detects singular matrix` (lines 629–643)

**Evidence**:
```typescript
expect(result.singularRow).toBeDefined();
```

**Problem**: Same weakness as WT-1. Only confirms the field exists, not that it holds the correct value.

---

### WT-3 — Private method access via `(solver as any)` asserts implementation details not behaviour

**Tests**: Lines 949, 982, 983, 1011, 1012, 1037, 1038, 1113, 1114, 1176, 1177, 1190 of `sparse-solver.test.ts`

**Evidence** (representative):
```typescript
(solver as any)._countMarkowitz();
(solver as any)._markowitzProducts();
(solver as any)._updateMarkowitzNumbers(0, 0, x, xNzIdx, 2, pinv);
```

**Problem**: Tests bypass TypeScript visibility to call private methods directly. This tests implementation structure, not desired behaviour. If private method names change, tests break without any behavioural regression. The correct approach is to verify Markowitz correctness through `factorWithReorder()` output: correct solution vectors, correct `singletons`/`markowitzRow`/`markowitzProd` values after a complete factor cycle on known matrices.

---

### WT-4 — Singleton count asserted only as `>= 2` for a deterministic 3x3 tridiagonal

**Test**: `src/solver/analog/__tests__/sparse-solver.test.ts::SparseSolver _countMarkowitz and _markowitzProducts::computes Markowitz products and singletons for tridiagonal matrix` (lines 966–997)

**Evidence**:
```typescript
expect(solver.singletons).toBeGreaterThanOrEqual(2);
```

**Problem**: For [[2,-1,0],[-1,3,-1],[0,-1,2]], the singleton count is deterministic. `>= 2` is satisfied by any value from 2 upward. The test must assert the exact expected count.

---

### WT-5 — `_updateMarkowitzNumbers` row-sum bound is trivially satisfiable by a no-op

**Test**: `src/solver/analog/__tests__/sparse-solver.test.ts::SparseSolver _updateMarkowitzNumbers::decrements row and column counts after elimination` (lines 1159–1195)

**Evidence**:
```typescript
expect(postRowSum).toBeLessThanOrEqual(initialRowSum);
```

**Problem**: A no-op `_updateMarkowitzNumbers` passes this test (sum unchanged satisfies `<=`). The test must assert the exact decrement amount for the given matrix and pivot.

---

### WT-6 — `singletons > 0` does not validate singleton-preference in pivot selection

**Test**: `src/solver/analog/__tests__/sparse-solver.test.ts::SparseSolver pivot selection::prefers singleton rows — singletons getter reflects matrix structure` (lines 1097–1116)

**Evidence**:
```typescript
expect(solver.singletons).toBeGreaterThan(0);
```

**Problem**: The test name claims "prefers singleton rows" but asserts only that the singleton count is nonzero. It does not verify that a singleton row was chosen first by the pivot selector. The 4-phase dispatch (which was deleted) was the mechanism for singleton preference; with plain partial pivoting, singleton preference is not guaranteed. This assertion is trivially satisfiable and does not test the claimed behaviour.

---

## Legacy References

None found.
