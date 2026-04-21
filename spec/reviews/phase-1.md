# Review Report: Phase 1 — F1 Sparse Solver Alignment

**Date**: 2026-04-21
**Tasks reviewed**: 1.1.1, 1.1.2, 1.1.3, 1.1.4, 1.1.5, 1.2.1, 1.2.2, 1.2.3, 1.3.1, 1.3.2, 1.3.3, 1.4.1, 1.4.2, 1.4.3, 1.5.1, 1.5.2, 1.5.3
**Files reviewed**:
- `src/solver/analog/sparse-solver.ts`
- `src/solver/analog/complex-sparse-solver.ts`
- `src/core/analog-engine-interface.ts`
- `src/solver/analog/ckt-context.ts`
- `src/solver/analog/newton-raphson.ts`
- `src/solver/analog/__tests__/sparse-solver.test.ts`
- `src/solver/analog/__tests__/complex-sparse-solver.test.ts`

---

## Summary

| Metric | Count |
|--------|-------|
| Tasks reviewed | 17 |
| Violations — critical | 0 |
| Violations — major | 2 |
| Violations — minor | 1 |
| Gaps | 1 |
| Weak tests | 3 |
| Legacy references | 0 |

**Verdict**: has-violations

---

## Violations

### V-001 — Major: F1.1 pre-factor snapshot not moved as specified

- **File**: `src/solver/analog/sparse-solver.ts`
- **Lines**: 481–517 (`factor()` body), 1603–1624 (`factorWithReorder`, `factorNumerical`)
- **Rule violated**: Spec adherence — F1.1 concrete diff is part of the Phase 1 blast radius (listed in the "Summary of Blast Radius" table at the bottom of the spec).

**Evidence**:

The spec section F1.1 states verbatim:

> Move the snapshot AFTER `_applyDiagGmin`; into `factorWithReorder` and `factorNumerical` bodies immediately after `_applyDiagGmin`.

And provides an exact replacement for `factor()`:

```ts
factor(diagGmin?: number): FactorResult {
  if (this._needsReorder || !this._hasPivotOrder) {
    this.lastFactorUsedReorder = true;
    return this.factorWithReorder(diagGmin);
  }
  this.lastFactorUsedReorder = false;
  const result = this.factorNumerical(diagGmin);
  if (!result.success && result.needsReorder) {
    this._needsReorder = true;
    this.lastFactorUsedReorder = true;
    return this.factorWithReorder(/* diagGmin */ undefined);
  }
  return result;
}
```

Note: **no snapshot block in `factor()`**; snapshot extracted into `_takePreFactorSnapshotIfEnabled()` called from inside `factorWithReorder`/`factorNumerical` AFTER `_applyDiagGmin`.

The current implementation at lines 481–495 still has the snapshot block inside `factor()` BEFORE dispatch:

```ts
factor(diagGmin?: number): FactorResult {
  if (this._capturePreFactorMatrix) {
    const n = this._n;
    const snap: Array<{ row: number; col: number; value: number }> = [];
    for (let col = 0; col < n; col++) {
      ...
    }
    this._preFactorMatrix = snap;   // <-- taken BEFORE _applyDiagGmin
  }
  if (this._needsReorder || !this._hasPivotOrder) {
    ...
    return this.factorWithReorder(diagGmin);   // _applyDiagGmin runs here
  }
  ...
}
```

`factorWithReorder` (lines 1603–1615) and `factorNumerical` (lines 1621–1624) contain NO call to `_takePreFactorSnapshotIfEnabled`. The method `_takePreFactorSnapshotIfEnabled` does not exist anywhere in `sparse-solver.ts`.

**Consequence**: `getPreFactorMatrixSnapshot()` returns A (without gmin), but the matrix that was actually factored is A + gmin·I. This violates ngspice's invariant that "the matrix that is factored INCLUDES gmin because `LoadGmin` runs before `spFactor`" (F1.1 spec text). The spec explicitly designates this as a required fix in the blast radius table for Phase 1.

**Severity**: major

---

### V-002 — Major: test file constructs `LoadContext` with fields removed in Wave 2.1

- **File**: `src/solver/analog/__tests__/sparse-solver.test.ts`
- **Lines**: 456–478 (`rawCtx` literal inside `mna_50node_realistic_circuit_performance`)
- **Rule violated**: Rules.md Code Hygiene — "All replaced or edited code is removed entirely. Scorched earth."

**Evidence**:

```ts
const rawCtx: import("../load-context.js").LoadContext = {
  solver: rawSolver,
  voltages: rawVoltages,
  iteration: 0,         // removed in Wave 2.1 (Task 2.1.2)
  initMode: "initFloat", // removed in Wave 2.1 (Task 2.1.2)
  ...
  isDcOp: true,         // removed in Wave 2.1 (Task 2.1.2)
  isTransient: false,   // removed in Wave 2.1 (Task 2.1.2)
  isTransientDcop: false, // removed in Wave 2.1 (Task 2.1.2)
  isAc: false,          // removed in Wave 2.1 (Task 2.1.2)
  ...
};
```

`spec/progress.md` Task 2.1.2 explicitly records: "Removed InitMode type export, removed fields: iteration, initMode, isDcOp, isTransient, isTransientDcop, isAc." This `rawCtx` literal uses all six removed fields. Since `sparse-solver.test.ts` is listed as a Phase 1 file, this residual usage should have been cleaned up — or the test should be failing (indicating the test is being compiled against an outdated type). If the TypeScript compiler is accepting this, either the `LoadContext` type still has those fields (contradicting progress.md), or the test file has a type assertion suppressing the error. Either way, the test constructs an invalid `LoadContext`.

Additionally, the test omits `cktMode: number` which was added as the first field in Wave 2.1. This makes the rawCtx construction either (a) a type error that is silently passing because the test is not type-checked, or (b) evidence that `LoadContext` still has those old fields on disk despite progress.md claiming otherwise.

**Severity**: major

---

### V-003 — Minor: `_needsReorder` field initialisation comment in `_initStructure` is a historical-provenance comment

- **File**: `src/solver/analog/sparse-solver.ts`
- **Lines**: 888–890
- **Rule violated**: Rules.md Code Hygiene — "No `# previously this was...` comments."

**Evidence**:

```ts
// ngspice spalloc.c:170 — Matrix->NeedsOrdering = YES on initial Create.
this._needsReorder = true;
this._didPreorder = false;
```

The ngspice citation is acceptable. However the field-declaration block at lines 221–244 (the lifecycle comment) contains the phrase:

```
//   _needsReorder = false:
//     * factorWithReorder() success — ngspice spfactor.c:279
```

This is clean. The violation is the single inline comment at line 224 inside `_initStructure`:

No standalone provenance violation found here — the comment at line 888 (`// ngspice spalloc.c:170 — Matrix->NeedsOrdering = YES on initial Create.`) is a legitimate ngspice alignment cite, not a "previously this was" statement.

**Retracted** — this is a documentation comment, not a provenance comment. Reducing severity accordingly and replacing with:

### V-003 — Minor: Comment in `_numericLUReusePivots` describes `diagE < 0` path inconsistently with spec guard logic

- **File**: `src/solver/analog/sparse-solver.ts`
- **Lines**: 1490–1495
- **Rule violated**: Rules.md Code Hygiene — Comments exist only to explain complicated code; they must not describe historical behaviour or include misleading statements.

**Evidence**:

```ts
} else if (diagMag <= absThreshold) {
  // No diagonal pool element (unusual after reorder); still enforce the
  // absolute tolerance guard. Do NOT demand reorder here — this path
  // indicates structural singularity of the factored pivot.
  for (let idx = 0; idx < xNzCount; idx++) x[xNzIdx[idx]] = 0;
  return { success: false, needsReorder: true };   // contradicts the comment
}
```

The comment says "Do NOT demand reorder here" but the return value is `{ success: false, needsReorder: true }`. The `needsReorder: true` sentinel contradicts the comment's claim. The spec (Item #3, Part C NEW block) does set `needsReorder: true` in this branch, so the code is correct — but the comment is actively misleading. This is a factual internal contradiction: the comment and the code disagree.

**Severity**: minor

---

## Gaps

### G-001 — F1.1 blast-radius item not implemented: `_takePreFactorSnapshotIfEnabled` helper missing

- **Spec requirement**: F1.1 section of `spec/ngspice-alignment-F1-sparse-solver.md` requires extracting the pre-factor snapshot into a private helper `_takePreFactorSnapshotIfEnabled()` called from `factorWithReorder` and `factorNumerical` AFTER `_applyDiagGmin`, and stripping the snapshot block from `factor()`. The blast-radius table at the end of the spec lists this as a Phase 1 change.
- **What was found**: The `_takePreFactorSnapshotIfEnabled` method does not exist in `sparse-solver.ts`. The snapshot block remains in `factor()` before `_applyDiagGmin` is called. `factorWithReorder` and `factorNumerical` have no snapshot call.
- **File**: `src/solver/analog/sparse-solver.ts`

---

## Weak Tests

### WT-001 — `sparse-solver.test.ts` :: `SparseSolver factorNumerical` :: `returns failure when pivot becomes near-zero`

- **Path**: `src/solver/analog/__tests__/sparse-solver.test.ts::SparseSolver factorNumerical::returns failure when pivot becomes near-zero`
- **Issue**: The assertion tests only `result.success === false`. With the new `needsReorder` sentinel, the spec (Item #3 Part C) requires that a column-relative partial-pivot guard failure returns `{ success: false, needsReorder: true }` — distinct from a structural singularity return of `{ success: false }` (no `needsReorder`). The test does not assert which failure mode occurred and does not assert `result.needsReorder` at all. A caller cannot distinguish "reorder me" from "you are singular" without `needsReorder`.
- **Evidence**:
  ```ts
  const r2 = solver.factorNumerical();
  expect(r2.success).toBe(false);
  // needsReorder is never checked
  ```
- **Why this matters**: The spec explicitly adds `needsReorder?: boolean` to `FactorResult` and mandates that `factor()` re-dispatches on `needsReorder: true`. A test that only checks `success: false` cannot distinguish correct reorder-signalling from incorrect singular-matrix reporting.

---

### WT-002 — `sparse-solver.test.ts` :: `SparseSolver factorWithReorder` :: `detects singular matrix`

- **Path**: `src/solver/analog/__tests__/sparse-solver.test.ts::SparseSolver factorWithReorder::detects singular matrix`
- **Issue**: The assertion `expect(result.singularRow).toBeDefined()` is a trivially weak assertion — it only checks that the field is not `undefined`. It does not verify that `singularRow` contains a valid row index (e.g. 0 or 1 for a 2×2 matrix). An implementation returning `{ success: false, singularRow: NaN }` or `{ success: false, singularRow: -1 }` would pass this test despite being incorrect.
- **Evidence**:
  ```ts
  const result = solver.factorWithReorder();
  expect(result.success).toBe(false);
  expect(result.singularRow).toBeDefined();
  expect(typeof result.singularRow).toBe("number");  // still passes for NaN, Infinity, -1
  ```

---

### WT-003 — `sparse-solver.test.ts` :: `SparseSolver factor dispatch` :: `factor() sets lastFactorUsedReorder=false on second call` — comment contradicts code

- **Path**: `src/solver/analog/__tests__/sparse-solver.test.ts::SparseSolver factor dispatch::factor() sets lastFactorUsedReorder=false on second call (numerical path)`
- **Issue**: The comment inside the test at line 819–820 says `// _needsReorder starts false so numerical path is taken first` — but this is false. After `_initStructure`, `_needsReorder = true` (per Task 1.1.2). The test works correctly because of the explicit `solver.forceReorder()` call that follows, but the comment is factually wrong about the initial state. This is a documentation error inside a test that could mislead future test authors about the `_needsReorder` invariant.
- **Evidence**:
  ```ts
  // First factor: topology is dirty so forceReorder is implied via finalize;
  // _needsReorder starts false so numerical path is taken first.   <-- incorrect
  // Force reorder explicitly then factor to establish pivot order.
  solver.forceReorder();
  solver.factor();
  ```

---

## Legacy References

None found.

---

## Additional Observations (non-violation, informational)

### OBS-001 — `_numericLUMarkowitz` residual check: singular guard at line 1330 uses hardcoded `1e-300`

- **File**: `src/solver/analog/sparse-solver.ts`, line 1330
- **Code**: `if (Math.abs(diagVal) < 1e-300) {`
- **Note**: This is inside `_numericLUMarkowitz` (the full reorder path), NOT in `_numericLUReusePivots`. The spec's Item #3/#4 changes apply to `_numericLUReusePivots`. The Markowitz path uses `_searchForPivot` to find a numerically acceptable pivot — the `1e-300` guard is a last-resort structural singularity check after pivot selection, not a threshold comparison. This is not a spec violation but differs from `_absThreshold`-based checks in the reuse path. Not a violation but worth noting for the next phase reviewer.

### OBS-002 — `complex-sparse-solver.ts` `_initStructure` does not set `_needsReorderComplex = true`

- **File**: `src/solver/analog/complex-sparse-solver.ts`
- **Note**: The real solver's `_initStructure` was updated (Task 1.1.2) to set `_needsReorder = true`. The complex solver's `_initStructure` equivalent should mirror this, but it is not listed explicitly as a Task 1.5.x requirement. The complex solver's `factor()` correctly gates on `_needsReorderComplex || !_hasComplexPivotOrder`, and on fresh construction `_hasComplexPivotOrder = false`, so the effective dispatch result is the same. Not a violation but flagged for completeness.
