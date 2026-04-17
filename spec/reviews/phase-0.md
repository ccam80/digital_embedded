# Review Report: Phase 0 — Sparse Solver Rewrite

## Summary

| Item | Count |
|------|-------|
| Tasks reviewed | 7 (0.1.1, 0.1.2, 0.1.3, 0.2.1, 0.3.1, 0.3.2, batch-1 fix) |
| Violations — critical | 1 |
| Violations — major | 2 |
| Violations — minor | 1 |
| Gaps | 1 |
| Weak tests | 2 |
| Legacy references | 0 |

**Verdict: has-violations**

---

## Violations

### V-01 [CRITICAL] — `_buildCSCFromLinked()` does not implement the specified algorithm

**File:** `src/solver/analog/sparse-solver.ts`, lines 1162–1173

**Rule violated:** Spec adherence — Task 0.1.3 specifies that `_buildCSCFromLinked()` walks the pool once, reads `_elVal` into the CSC arrays using stored indices, "producing cache-optimal CSC L/U for forward/backward substitution." The spec states: "After `factorWithReorder()` completes, `_buildCSCFromLinked()` walks the pool once, reading `_elVal` into the CSC arrays using the stored indices."

**Evidence:**
```typescript
private _buildCSCFromLinked(): void {
  const n = this._n;
  const lnz = this._lColPtr[n];
  const unz = this._uColPtr[n];
  // Walk all elements and verify their CSC index mappings are in bounds
  for (let e = 0; e < this._elCount; e++) {
    const li = this._lValueIndex[e];
    if (li >= 0 && li >= lnz) this._lValueIndex[e] = -1;
    const ui = this._uValueIndex[e];
    if (ui >= 0 && ui >= unz) this._uValueIndex[e] = -1;
  }
}
```

**What the spec requires:** The method must snapshot element values from the linked structure into the CSC arrays: `_lVals[elem.lValueIndex] = elem._elVal` for each element with a valid `lValueIndex`. The implementation instead performs only an integrity check — it clamps out-of-bounds index pointers to -1 but never writes any values into `_lVals` or `_uVals`. The actual value population is done inside `_numericLUMarkowitz()` itself (lines 1019–1047), which writes directly to `_lVals`/`_uVals` during the scatter loop. So `_buildCSCFromLinked()` as named is misleading: it is described in comments as a "verify CSC L/U index mappings" helper, not a "build CSC from linked" helper.

**Impact:** The spec's acceptance criterion for Task 0.1.3 is "CSC is rebuilt only on reorder events, not every NR iteration." The values are populated inline in `_numericLUMarkowitz`, so the CSC data is correct. However, the described architecture — a post-factor snapshot pass using `lValueIndex`/`uValueIndex` — is not implemented. The method named `_buildCSCFromLinked` performs bounds clamping instead of value population. This is a deviation from the specified algorithm: the spec says this method exists to populate CSC L/U via `_lValueIndex`/`_uValueIndex`, but it does not do that. The named concept exists (as an integrity check), but not the specified implementation. The test `csc_solve_matches_linked_factor` verifies that some elements have valid `lValueIndex`/`uValueIndex` entries, which is true, but the test does not verify that `_buildCSCFromLinked()` performs the snapshot (it cannot — the method is private and the values are already in CSC before it runs). Severity: **critical** because the implementation of a spec-named method deviates from the spec description in a way that could create divergent behavior in future modifications and because the spec's acceptance criterion for Task 0.1.3 depends on this design being correct.

---

### V-02 [MAJOR] — `_numericLUReusePivots()` contains a linked-list walk in the hot path

**File:** `src/solver/analog/sparse-solver.ts`, lines 1091–1103

**Rule violated:** Task 0.1.3 acceptance criterion: "`factorNumerical()` touches zero linked-list operations — values are scattered from linked elements into existing CSC positions."

**Evidence:**
```typescript
for (let k = 0; k < n; k++) {
  // Scatter A-matrix entries for column k into dense workspace
  let xNzCount = 0;
  let ae = this._colHead[k];
  while (ae >= 0) {                          // ← linked-list walk
    if (!(this._elFlags[ae] & FLAG_FILL_IN)) {
      const row = this._elRow[ae];
      if (x[row] === 0) xNzIdx[xNzCount++] = row;
      x[row] += this._elVal[ae];
    }
    ae = this._elNextInCol[ae];              // ← chain traversal
  }
  // ... and then _reach(k) which also walks L's column chain
  const reachTop = this._reach(k);
```

**What the spec requires:** The spec says `_numericLUReusePivots()` must scatter values "via O(1) index lookup (`_lVals[elem.lValueIndex] = elem.value`)… No linked-structure rebuild, no pivot search." Instead, the implementation walks the linked-list column chain for every column k, and calls `_reach(k)` which also performs a DFS over L's column structure. These are not O(1) operations — they are O(nnz) linked-list traversals. The U and L value scatter at lines 1128–1137 does use O(1) CSC index iteration (iterating over `_uColPtr`/`_lColPtr` ranges), so those loops are correct. But the initial scatter of A-values into the dense workspace via `_colHead` chain walk, and the `_reach()` call, are linked-list operations in the hot path. The spec's acceptance criterion "zero linked-list operations" is not satisfied.

**Severity: major** — directly violates a named acceptance criterion.

---

### V-03 [MAJOR] — Historical-provenance comment in `_swapColumns` documents internal architecture deviation from ngspice

**File:** `src/solver/analog/sparse-solver.ts`, lines 477–482

**Rule violated:** rules.md: "No `# previously this was...` comments. Comments exist ONLY to explain complicated code to future developers. They never describe what was changed, what was removed, or historical behaviour."

**Evidence:**
```typescript
/**
 * Swap columns col1 and col2 in the persistent linked structure.
 * Unlike ngspice SwapCols (sputils.c:283-301), we MUST also update per-element
 * _elCol fields. ngspice skips this because preorder runs before row-linking
 * and uses IntToExtColMap to translate column indices in factor/solve. Our
 * architecture has no IntToExtColMap: rows are linked at allocation time, and
 * _elCol[e] is read by _removeFromCol (to find _colHead) and by
 * _updateMarkowitzNumbers (to count column contributions). Both must see the
 * current (post-swap) column assignment or they corrupt the factorization.
 */
```

**Analysis:** This comment begins "Unlike ngspice SwapCols... ngspice skips this because... Our architecture has no IntToExtColMap... rows are linked at allocation time." This is a historical-provenance comment: it describes the historical ngspice behavior and how the implementation "replaced" or "diverged from" that behavior and why. The rules require that comments "never describe what was changed, what was removed, or historical behaviour." The reference to "ngspice skips this because preorder runs before row-linking" and "Our architecture has no IntToExtColMap" are historical/comparative. A compliant comment would only explain the mechanics of the current code. Per the rules, this does not indicate dead code, but it is a banned comment form.

**Severity: major** — violates the explicit historical-provenance comment ban in rules.md.

---

### V-04 [MINOR] — `allocElement` fallback comment uses the banned word "fallback"

**File:** `src/solver/analog/sparse-solver.ts`, line 199

**Rule violated:** rules.md: banned-phrase comments. While the reviewer instructions note that "fallback" in a comment is a dead-code marker, in this instance the comment describes a legitimate code path (O(column chain length) for very large matrices), not dead/transitional code. However the word "fallback" is itself in the banned list per the rules.

**Evidence:**
```
 * O(column chain length) fallback for very large matrices.
```

The code it annotates (lines 209–233) is the real walk-the-chain path used when `n > _handleTableN`, which is a genuine live code path. The comment is not a dead-code marker. This is a minor violation of the word-level ban on "fallback" in comments.

**Severity: minor**

---

## Gaps

### G-01 — Task 0.1.3 acceptance criterion: `factorNumerical()` touches zero linked-list operations

**Spec requirement (Task 0.1.3):** "`factorNumerical()` touches zero linked-list operations — values are scattered from linked elements into existing CSC positions."

**What was found:** `_numericLUReusePivots()` (called by `factorNumerical()`) contains a linked-list chain walk of the column structure (`_colHead`/`_elNextInCol`) on every column k of the NR hot path, plus a call to `_reach(k)` which performs a DFS through L's CSC column structure. These are not O(1) lookups. The spec's "zero linked-list operations" criterion is not satisfied.

**File:** `src/solver/analog/sparse-solver.ts` lines 1091–1137

**Note:** This gap overlaps with V-02. Both the violation (hot-path linked-list walk) and the gap (acceptance criterion unmet) are reported separately per instructions.

---

## Weak Tests

### WT-01 — `csc_solve_matches_linked_factor`: does not verify that `_buildCSCFromLinked()` performs the population step

**Test path:** `src/solver/analog/__tests__/sparse-solver.test.ts::SparseSolver CSC from linked structure::csc_solve_matches_linked_factor`

**Issue:** The test verifies solve correctness and checks that `lValueIndex`/`uValueIndex` have some entries >= 0. It does not verify that `_buildCSCFromLinked()` actually copies element values into `_lVals`/`_uVals`. The test asserts:
```typescript
let hasLIndex = false;
let hasUIndex = false;
for (let e = 0; e < elCount; e++) {
  if (lValueIndex[e] >= 0) hasLIndex = true;
  if (uValueIndex[e] >= 0) hasUIndex = true;
}
expect(hasLIndex).toBe(true);
expect(hasUIndex).toBe(true);
```
This only checks that some indices are non-negative. It does not verify the actual CSC value arrays (`_lVals`, `_uVals`) match the linked-structure element values — which is the entire point of the spec's `_buildCSCFromLinked()` contract. The acceptance criterion "CSC is rebuilt only on reorder events" cannot be verified from this test either. A test that actually reads back `_lVals[lValueIndex[e]]` and compares it to `_elVal[e]` would be needed.

---

### WT-02 — `numeric_refactor_reuses_csc_pattern`: `lastFactorUsedReorder` check is on the method called, not on whether the CSC sparsity pattern was actually reused

**Test path:** `src/solver/analog/__tests__/sparse-solver.test.ts::SparseSolver CSC from linked structure::numeric_refactor_reuses_csc_pattern`

**Issue:** The test verifies `solver.lastFactorUsedReorder === false` after `factorNumerical()`. This is an implementation-detail assertion (which dispatch path was taken), not a behavioral assertion about the CSC sparsity pattern being reused. The spec's acceptance criterion is "CSC is rebuilt only on reorder events, not every NR iteration." The test does not assert that the CSC sparsity structure (`_lColPtr`, `_lRowIdx`, `_uColPtr`, `_uRowIdx`) is identical before and after the numerical factorization — which would be the correct behavioral assertion. The correctness assertion (`x[0] ≈ 1.0`, `x[1] ≈ 1.0`) does test desired behavior, so the test is not entirely implementation-detail focused, but the pattern-reuse criterion is untested.

---

## Legacy References

None found in `src/solver/analog/sparse-solver.ts` or `src/solver/analog/newton-raphson.ts`.

---

## Additional Notes

The following items from the coordinator's concern list were explicitly verified clean:

1. **Handle-based stamp API O(1) in hot path:** `stampElement(handle, value)` is `_elVal[handle] += value` — unconditionally O(1). Confirmed clean.

2. **`stamp(row, col, value)` retained without banned-phrase comments:** The method at lines 249–252 is a thin wrapper with no deferral comments, no "pending Phase 6", no "TODO". The JSDoc says "Convenience method: find-or-create element at (row, col) and accumulate value." Clean.

3. **All COO fields deleted:** No `_cooRows`, `_cooCols`, `_cooVals`, `_cooCount`, `_cooToCsc`, `_prevCooCount`, `_bldColCount`, `_bldColPos`, `_bldBucketRows`, `_bldBucketCooIdx` found in sparse-solver.ts. Confirmed clean.

4. **AMD artifacts deleted:** No `_computeAMD`, `_buildEtree`, `_perm`, `_permInv`, `_symbolicLU` found. Confirmed clean.

5. **`_lValueIndex`/`_uValueIndex` exist:** Both declared at lines 62–67 and used. Confirmed.

6. **`preorder()` implements SMPpreOrder:** Implements twin-pair detection with monotonic `startAt` cursor, `_countTwins`, `_swapColumns` helpers. Confirmed.

7. **`forceReorder()` at the three ngspice-matching points:**
   - initJct→initFix: line 549 in newton-raphson.ts — confirmed.
   - initTran when `iteration <= 0` (0-based = iterno <= 1 in 1-based): line 565-566 — confirmed.
   - E_SINGULAR recovery: line 384 followed by `continue` at line 385 — confirmed.

8. **E_SINGULAR recovery uses `forceReorder() + continue`:** Lines 381–385 check `!solver.lastFactorUsedReorder`, call `solver.forceReorder()`, then `continue`. The `continue` returns to the top of the `for` loop, re-executing Step A (clear noncon) and Step B (stampAll). Confirmed correct.

9. **`_topologyDirty` / `_prevCooCount` deleted:** Neither found. Confirmed clean.

10. **All spec-required test names present:** All 15 Phase 0 spec-required test names found in the test files. Confirmed.

---

## Appendix: `_buildCSCFromLinked` — Spec vs Implementation

The spec (Task 0.1.3) says:

> "After `factorWithReorder()` completes, `_buildCSCFromLinked()` walks the pool once, reading `_elVal` into the CSC arrays using the stored indices — producing cache-optimal CSC L/U for forward/backward substitution."

The implementation's `_buildCSCFromLinked()` does not walk the pool to read `_elVal` into CSC arrays. Instead, the L/U values are written inline during `_numericLUMarkowitz()` at lines 1019–1047 as each L/U entry is created. `_buildCSCFromLinked()` is then called as a post-pass that clamps out-of-range indices. The comment at line 1160 says "Verify CSC L/U index mappings are consistent after factorWithReorder."

The factual situation: the CSC values are correct (populated inline), but the architecture described in the spec (post-factor snapshot pass) is not what was built. The method name `_buildCSCFromLinked` no longer accurately describes what the method does. This matters for Task 0.1.3's acceptance criterion around `_numericLUReusePivots` using O(1) scatter — the spec's design was: "After `factorWithReorder()` completes, `_buildCSCFromLinked()` walks the pool once" to set up `_lValueIndex`/`_uValueIndex` mappings for subsequent `_numericLUReusePivots` calls. In the implementation, these mappings are set during `_numericLUMarkowitz` itself, so the hot-path path (`_numericLUReusePivots`) still has to scatter A-values via a chain walk before accessing CSC positions, making the hot-path chain-walk (V-02) unavoidable with the current design.
