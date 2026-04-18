# Review Report: Phase 0 — Sparse Solver Rewrite

**Scope**: Tasks 0.1.1, 0.1.2, 0.1.3, 0.2.1, 0.3.1, 0.3.2, phase0-v03-v04-swapcols remediation, Task 0.1-fix  
**Date**: 2026-04-18  
**Files reviewed**:
- `src/solver/analog/sparse-solver.ts`
- `src/solver/analog/newton-raphson.ts`
- `src/solver/analog/__tests__/sparse-solver.test.ts`
- `src/solver/analog/__tests__/newton-raphson.test.ts`

---

## Summary

| Category | Count |
|---|---|
| Tasks reviewed | 8 |
| Violations — critical | 2 |
| Violations — major | 1 |
| Violations — minor | 2 |
| Gaps | 2 |
| Weak tests | 2 |
| Legacy references | 3 |

**Verdict: has-violations**

---

## Violations

### V-01 [critical] — Test file calls deleted interface methods `el.stamp()` and `el.stampNonlinear()` on AnalogElement instances

**File:** `src/solver/analog/__tests__/sparse-solver.test.ts`, lines 456, 461, 481, 482

**Rule violated:** rules.md — "All replaced or edited code is removed entirely. Scorched earth." Task 6.1.2 deleted `stamp` and `stampNonlinear` from the `AnalogElement` interface. `sparse-solver.test.ts` is listed as a modified file across multiple Phase 0 tasks in `spec/progress.md`. The test `mna_50node_realistic_circuit_performance` still calls these deleted methods on element instances.

**Evidence:**
```typescript
// sparse-solver.test.ts line 456
el.stamp(rawSolver);
// line 461
el.stampNonlinear(rawSolver);
// line 481
el.stamp(rawSolver);
// line 482
el.stampNonlinear(rawSolver);
```

Both `stamp` and `stampNonlinear` were removed from the `AnalogElement` interface in Task 6.1.2. These calls will fail at runtime (TypeScript type error) and demonstrate that the test file was not updated to reflect the `load(ctx)` migration.

**Severity: critical**

---

### V-02 [critical] — `newton-raphson.ts` JSDoc contains the banned word "fallback"

**File:** `src/solver/analog/newton-raphson.ts`, line 262

**Rule violated:** rules.md: "Any comment containing words like… 'fallback'… is almost never just a comment problem. The comment exists because an agent left dead or transitional code in place." Per reviewer instructions, "fallback" in a comment is a dead-code marker. The code decorated by this comment must be examined.

**Evidence:**
```typescript
 * (DC operating point solver) decides the appropriate fallback strategy.
```

The JSDoc at line 262 uses the banned word "fallback" to describe the DC operating point solver's behavior. Per rules, this comment's use of "fallback" must be treated as a dead-code marker: the code it decorates must be examined for transitional or dead logic.

**Severity: critical**

---

### V-03 [major] — `_resetForAssembly` diagonal-clear condition uses wrong column coordinate after preorder swaps

**File:** `src/solver/analog/sparse-solver.ts`, line 685

**Rule violated:** Spec acceptance criterion (Task 0.2.1): "After `SMPpreOrder`, diagonal elements resolve correctly." The diagonal-clear logic at line 685 reads `if (r === col && ...)` where `col` is the internal column loop variable and `r` is the element's row. After `_swapColumns`, `_preorderColPerm[col] != col` for swapped columns, so an element on the logical diagonal (row == original column) will not be recognized as diagonal when `col` != `r`. This leaves stale `_diag` entries for swapped columns.

**Evidence:**
```typescript
// line 685
if (r === col && this._diag[col] === e) {
```

After preorder, internal column `col` maps to original column `_preorderColPerm[col]`. An element is on the logical diagonal when `r === _preorderColPerm[col]`, not when `r === col`. The condition silently fails for any fill-in or A-element placed on the preorder-swapped diagonal.

**Severity: major**

---

### V-04 [minor] — Dead-explanation comment in `_resetForAssembly`

**File:** `src/solver/analog/sparse-solver.ts`, lines 692–698

**Rule violated:** rules.md: "No `# previously this was...` comments. Comments exist ONLY to explain complicated code to future developers. They never describe what was changed, what was removed, or historical behaviour."

**Evidence:**
```typescript
// Nothing to do — handle table entries for A-elements remain correct
// after clear. The handle (pool index) is still valid; only _elVal
// will be re-stamped before the next factorization.
```

This comment describes why code was intentionally omitted — a justification comment explaining a design decision in terms of what "remains correct" from a prior state. This is a historical-provenance/dead-explanation form that the rules prohibit. Comments must explain complicated code, not explain why code was not written.

**Severity: minor**

---

## Gaps

### G-01 — `complex-sparse-solver.ts` retains COO arrays and AMD artifacts (Wave 0.4 explicitly out of scope)

**Spec requirement:** Phase 0 overall goal: delete COO arrays and AMD artifacts from all sparse solver implementations.

**What was found:** `src/solver/analog/complex-sparse-solver.ts` retains `_perm`, `_permInv`, `_topologyDirty`, `_computeAMD()`, `_buildEtree()`, `_symbolicLU()`, and COO triplet arrays. Wave 0.4 is designated to fix this and is explicitly out of scope for this review per the assignment. Recorded as a gap for completeness.

**File:** `src/solver/analog/complex-sparse-solver.ts`

---

### G-02 — `_reach(k)` DFS in `_numericLUReusePivots` — borderline on "zero linked-list operations" criterion

**Spec requirement (Task 0.1.3):** "`factorNumerical()` touches zero linked-list operations — values are scattered from linked elements into existing CSC positions."

**What was found:** `_numericLUReusePivots()` uses `_aMatrixColStart`/`_aMatrixHandlesByCol` flat arrays for A-matrix scatter (correct, O(1) per element). However, it calls `_reach(k)` which performs a DFS over L's CSC column structure (`_lColPtr`/`_lRowIdx`). The `_reach()` DFS is over CSC arrays (not the persistent linked list), so this is not strictly a linked-list walk, but it is a non-trivial traversal. Whether this satisfies "zero linked-list operations" depends on interpretation. Recorded as a gap pending clarification.

**File:** `src/solver/analog/sparse-solver.ts`, `_numericLUReusePivots()`

---

## Weak Tests

### WT-01 — `mna_50node_realistic_circuit_performance`: calls deleted API methods and contains dead `performance.now()` calls

**Test path:** `src/solver/analog/__tests__/sparse-solver.test.ts::SparseSolver performance::mna_50node_realistic_circuit_performance`

**Issues:**
1. Calls `el.stamp(rawSolver)` and `el.stampNonlinear(rawSolver)` — both deleted from `AnalogElement` in Task 6.1.2. These calls are dead and will fail at runtime.
2. Lines 464, 466, 468, 470, 486, 488, 490, 492: multiple `performance.now()` calls whose return values are assigned to local variables that are never read. These are dead measurement code with discarded results — they produce no assertions and contribute no information.

**Evidence:**
```typescript
// line 456
el.stamp(rawSolver);
// line 464
const t0 = performance.now();  // t0 never used in any assertion
```

**Severity: test calls deleted interface methods (overlaps V-01) plus dead measurement code with zero assertions.**

---

### WT-02 — `preorder_fixes_zero_diagonal_from_voltage_source`: does not assert that a swap actually occurred

**Test path:** `src/solver/analog/__tests__/sparse-solver.test.ts::SparseSolver preorder::preorder_fixes_zero_diagonal_from_voltage_source`

**Issue:** The test only verifies that factorization succeeds and that `Ax=b` holds after `preorder()` is called. It does not assert that any column swap actually took place (`_preorderColPerm[i] !== i` for some `i`), nor that `_diag` was correctly populated after the swap. A trivially-correct solver with no preorder logic at all could pass this test as long as the circuit is solvable by some other means. The behavioral assertion (swap occurred, diagonal was fixed) is absent.

**Evidence:**
```typescript
// The test only checks:
expect(() => solver.factorWithReorder()).not.toThrow();
// and solution correctness — not that preorder actually swapped anything
```

---

## Legacy References

### L-01 — `complex-sparse-solver.ts` retains AMD symbols and COO arrays

**File:** `src/solver/analog/complex-sparse-solver.ts`

Retains: `_perm`, `_permInv`, `_topologyDirty`, `_computeAMD`, `_buildEtree`, `_symbolicLU`, and COO triplet field declarations. These are the exact artifacts Phase 0 was designed to delete. Wave 0.4 is assigned to remove them; this is a legacy reference that will persist until that wave lands.

---

### L-02 — `spec/progress.md` line 67: stale `stampAll` reference

**File:** `spec/progress.md`, line 67

`stampAll` was deleted in Phase 2.2. The progress entry at line 67 still references it as a method expected to be called in the NR loop, which is now incorrect. This is a stale API reference in the progress document.

---

### L-03 — `spec/progress.md` lines 84–89: stale CLARIFICATION NEEDED block

**File:** `spec/progress.md`, lines 84–89

The CLARIFICATION NEEDED block at lines 84–89 describes unresolved questions about Phase 2 and Phase 6 integration. Both phases have since landed (Phase 2.2 and Phase 6.1.2 are marked complete in progress.md). The block is stale — the questions it raises are no longer open.
