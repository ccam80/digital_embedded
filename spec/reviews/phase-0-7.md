# Review Report: Phases 0 & 7 — Dead Code Removal + Legacy Reference Review

## Summary

| Item | Count |
|------|-------|
| Tasks reviewed | 5 (0.1.1, 0.1.2, 0.1.3, 7.1.1, fix-batch7-verifier-issues) |
| Violations — critical | 0 |
| Violations — major | 3 |
| Violations — minor | 2 |
| Gaps | 1 |
| Weak tests | 3 |
| Legacy references | 2 |

**Verdict: has-violations**

---

## Violations

### V-1 — Historical-provenance comment marking dead code remnant (major)

**File**: `src/solver/analog/sparse-solver.ts` line 680
**Rule**: rules.md — "Historical-provenance comments are dead-code markers." / "All replaced or edited code is removed entirely."

**Evidence**:
```typescript
void etree; // _etree removed (unused)
```

The `_buildEtree()` method (lines 649–681) constructs the `etree` array across 30+ lines of elimination-tree logic, then immediately suppresses it with `void etree` and a comment announcing the symbol was removed. The method is still called from `_symbolicLU()` at line 693. This is the exact pattern rules.md identifies: an agent left dead or transitional code in place and wrote a comment to avoid deleting it. The entire `_buildEtree()` method body runs O(nnz) work on every topology change and produces no output — its result is discarded.

The comment "_etree removed (unused)" describes a past removal action, which is banned. Per rules.md: "Comments exist ONLY to explain complicated code to future developers. They never describe what was changed, what was removed, or historical behaviour."

**Severity**: major — dead code path executing on every topology change; the void-statement comment pair is a rules.md violation and signals incomplete removal.

---

### V-2 — `void unz` suppression used as a workaround in `_numericLUMarkowitz` (major)

**File**: `src/solver/analog/sparse-solver.ts` line 926
**Rule**: rules.md Code Hygiene — no workarounds.

**Evidence** (line 926):
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

`unz` is declared at line 825 (`let unz = 0`) and is actively written to in the loop immediately after the `void unz` statement. The `void` expression is a tool-complaint suppression workaround — it silences a lint/compiler warning without fixing the underlying structural issue. The variable is live and in active use; the `void` statement adds no semantic value and exists only to suppress a tool warning. This is a workaround, which rules.md bans.

**Severity**: major

---

### V-3 — `void unz` suppression in `_numericLUReusePivots` (major)

**File**: `src/solver/analog/sparse-solver.ts` line 1030
**Rule**: Same as V-2.

**Evidence** (line 1030):
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

Identical workaround pattern to V-2 in the sibling factorization method `_numericLUReusePivots`.

**Severity**: major

---

### V-4 — `_buildEtree()` call retained when method produces no observable output (minor)

**File**: `src/solver/analog/sparse-solver.ts` line 693
**Rule**: rules.md — "All replaced or edited code is removed entirely."

**Evidence**:
```typescript
private _symbolicLU(): void {
  const n = this._n;
  this._buildEtree();  // call retained; method produces nothing (see V-1)
  // Dense workspace
  this._x = new Float64Array(n);
  ...
```

The call `this._buildEtree()` at line 693 invokes a method whose sole output (`etree`) is suppressed inside the method body (V-1). The call should have been deleted along with the method body. It executes O(nnz) work on every topology change with zero effect on downstream state.

**Severity**: minor (consequential of V-1, listed separately per reporting rules)

---

### V-5 — `dcopFinalize_sets_initMode_to_transient` test stub typed `as const` prevents intermediate mutation from being representable (minor)

**File**: `src/solver/analog/__tests__/dc-operating-point.test.ts` lines 536–553
**Rule**: rules.md — "Tests ALWAYS assert desired behaviour." / "Test the specific."

**Evidence**:
```typescript
const statePool = {
  state0: new Float64Array(1),
  reset(): void { this.initMode = "transient"; },
  initMode: "transient" as const,
};
// ...
expect(statePool.initMode).toBe("transient");
```

The stub's `initMode` is typed `"transient" as const`. TypeScript narrows this to the literal type `"transient"`, making the property effectively immutable to any other string value at the type level. The production code in `dcopFinalize` writes `pool.initMode = "initSmsig"` (an intermediate value) and then `pool.initMode = "transient"`. If TypeScript enforces the const narrowing, the `"initSmsig"` assignment is silently rejected at compile time; the final assertion `toBe("transient")` then passes trivially — not because `dcopFinalize` correctly cycled through `"initSmsig"` and back to `"transient"`, but because the value was never changed from its initial `"transient"`. The test does not verify the behaviour it claims to verify. It should use a real `StatePool` instance or a stub with `initMode` typed as the full `"initJct" | "initFix" | "initFloat" | "initTran" | "initPred" | "initSmsig" | "transient"` union.

**Severity**: minor

---

## Gaps

### G-1 — Phase 0 acceptance criterion "grep for removed symbols returns zero hits" not fully met

**Spec requirement** (`spec/plan.md` Phase 0 Verification):
> "`npx tsc --noEmit` confirms no stale imports; grep for removed symbols returns zero hits"

**What was found**: The `etree` symbol (declared "removed" by the comment on line 680) still exists and is the return value of 25+ lines of live computation in `_buildEtree()`. A repo-wide search for `etree` returns a hit at `src/solver/analog/sparse-solver.ts:680`. The acceptance criterion is not met.

**File**: `src/solver/analog/sparse-solver.ts` lines 649–681, 693

---

## Weak Tests

### WT-1 — Multiple tests call private methods via `(solver as any)` — testing implementation details

**Test paths**:
- `src/solver/analog/__tests__/sparse-solver.test.ts::SparseSolver _countMarkowitz and _markowitzProducts::counts off-diagonal nonzeros correctly for a 3x3 tridiagonal matrix`
- `src/solver/analog/__tests__/sparse-solver.test.ts::SparseSolver _countMarkowitz and _markowitzProducts::computes Markowitz products and singletons for tridiagonal matrix`
- `src/solver/analog/__tests__/sparse-solver.test.ts::SparseSolver _countMarkowitz and _markowitzProducts::counts zero off-diagonals for a diagonal matrix`
- `src/solver/analog/__tests__/sparse-solver.test.ts::SparseSolver _countMarkowitz and _markowitzProducts::counts correctly for a dense 2x2 matrix`
- `src/solver/analog/__tests__/sparse-solver.test.ts::SparseSolver pivot selection::prefers singleton rows — singletons getter reflects matrix structure`
- `src/solver/analog/__tests__/sparse-solver.test.ts::SparseSolver _updateMarkowitzNumbers::decrements row and column counts after elimination`

**Evidence** (representative):
```typescript
(solver as any)._countMarkowitz();
(solver as any)._markowitzProducts();
```

Tests that call private methods via `as any` test implementation details rather than desired behaviour. If `_countMarkowitz` is renamed, inlined into `_numericLUMarkowitz`, or merged, these tests silently stop exercising any meaningful path. The desired behaviour is that `factorWithReorder()` produces correct Markowitz counts observable via the public getters `markowitzRow`, `markowitzCol`, `markowitzProd`, and `singletons`. Tests should call `factorWithReorder()` and check the public getters — not reach into private methods.

---

### WT-2 — `prefers singleton rows` assertion does not verify pivot preference behaviour

**Test path**: `src/solver/analog/__tests__/sparse-solver.test.ts::SparseSolver pivot selection::prefers singleton rows — singletons getter reflects matrix structure`

**Evidence**:
```typescript
solver.factorWithReorder();
(solver as any)._countMarkowitz();
(solver as any)._markowitzProducts();
expect(solver.singletons).toBeGreaterThan(0);
```

The test name claims to verify that singleton rows are _preferred_ as pivots. The assertion only checks that `singletons > 0`. It does not verify that any singleton was actually chosen as a pivot at step 0, nor that the factorization order reflects singleton preference. The assertion is trivially weak relative to the claimed behaviour.

---

### WT-3 — `decrements row and column counts after elimination` passes even if nothing was decremented

**Test path**: `src/solver/analog/__tests__/sparse-solver.test.ts::SparseSolver _updateMarkowitzNumbers::decrements row and column counts after elimination`

**Evidence**:
```typescript
(solver as any)._updateMarkowitzNumbers(0, 0, x, xNzIdx, 2, pinv);
const postRowSum = Array.from(solver.markowitzRow).reduce((a, b) => a + b, 0);
expect(postRowSum).toBeLessThanOrEqual(initialRowSum);
```

`toBeLessThanOrEqual(initialRowSum)` passes when `postRowSum === initialRowSum` — i.e., when zero decrements occurred. The test is named "decrements row and column counts" but its assertion allows a complete no-op result. The correct assertion for a method that must always decrement is `toBeLessThan(initialRowSum)`.

---

## Legacy References

### LR-1 — `void etree; // _etree removed (unused)` in sparse-solver.ts line 680

**File**: `src/solver/analog/sparse-solver.ts` line 680

**Quoted evidence**:
```
void etree; // _etree removed (unused)
```

The comment text "_etree removed (unused)" names a symbol that was supposedly removed and annotates its suppression. This is a historical-provenance reference in production code. Rules.md §Code Hygiene bans comments that "describe what was changed, what was removed, or historical behaviour."

---

### LR-2 — `_buildEtree()` body and call site are remnants of removed functionality

**File**: `src/solver/analog/sparse-solver.ts` lines 649–681 (body), line 693 (call site)

**Quoted evidence** (line 680 as the marker, body spans 649–681):
```typescript
void etree; // _etree removed (unused)
```

The `etree` local variable and all code that computes it (the `for` loop at lines 656–678 building the elimination tree) are dead code. The `void etree` statement is the legacy reference marker per rules.md: "The comment exists because an agent left dead or transitional code in place and wrote a comment to avoid deleting it." The method body and its call at line 693 are the legacy reference, not just the comment.

---

## Informational Note: Markowitz Pivot Selection Scope

The progress.md entry for task 2.2.4 acknowledges that the 4-phase `_searchForPivot` dispatcher (task 2.2.3) was subsequently deleted in fix-batch7 because it referenced deleted private methods. The `_numericLUMarkowitz()` method currently uses partial pivoting (max magnitude) for pivot selection rather than Markowitz product minimization. The Markowitz data structures are populated and updated but not used to select pivots. This divergence from the Phase 2 spec (which required Markowitz-based pivot selection matching ngspice spOrderAndFactor) is documented for user awareness. No violation is raised since fix-batch7 was an approved verifier-directed task that explicitly deleted `_searchForPivot`. This is a scope question for the user.
