# Review Report: Phase 6 — Directory Restructure

## Summary

- **Tasks reviewed**: 1 (Phase 6 is a single-task phase: file moves + import updates)
- **Files examined**: All files in `src/solver/digital/`, `src/solver/analog/`, `src/solver/coordinator.ts`, `src/solver/coordinator-types.ts`, `src/compile/index.ts`, `src/compile/__tests__/compile-integration.test.ts`, `src/app/app-init.ts`, `src/headless/default-facade.ts`
- **Violations**: 4
- **Gaps**: 1
- **Weak tests**: 0
- **Legacy references**: 2
- **Verdict**: `has-violations`

---

## Violations

### V-1 — Historical-provenance comment: stale old paths in file header
- **File**: `src/compile/__tests__/compile-integration.test.ts`
- **Lines**: 8–9
- **Rule violated**: "No historical-provenance comments. Any comment describing what code replaced, what it used to do, why it changed, or where it came from is banned." (`spec/.context/rules.md`, Code Hygiene section)
- **Evidence**:
  ```
  *   src/engine/__tests__/compiler.test.ts
  *   src/analog/__tests__/compiler.test.ts
  ```
  These paths do not exist after Phase 6. The comment documents where the test patterns were originally taken from — a historical-provenance statement describing the file's origin. The Phase 6 restructure moved these files to `src/solver/digital/__tests__/compiler.test.ts` and `src/solver/analog/__tests__/compiler.test.ts` respectively, but the header was not updated. Even if the paths were updated, the comment would still be a historical-provenance violation because it describes code lineage rather than explaining code behaviour to future developers.
- **Severity**: major

### V-2 — Historical-provenance comment: "Legacy" inline comment
- **File**: `src/compile/__tests__/compile-integration.test.ts`
- **Line**: 413
- **Rule violated**: "No historical-provenance comments." (`spec/.context/rules.md`, Code Hygiene section)
- **Evidence**:
  ```typescript
  // Legacy detects feedback SCC
  const legacyFeedback = reference.evaluationOrder.filter((g) => g.isFeedback);
  ```
  The word "Legacy" in the comment explicitly frames the `reference` compile path as the old system being compared against the new unified path. This is a historical-provenance label describing what the code used to do vs. what replaced it.
- **Severity**: major

### V-3 — Backwards-compatibility shim naming: `legacyNetId` and `legacyNetIdA` variables
- **File**: `src/compile/__tests__/compile-integration.test.ts`
- **Lines**: 376, 379, 383, 877, 880, 884
- **Rule violated**: "No fallbacks. No backwards compatibility shims. No safety wrappers." and "No historical-provenance comments." (`spec/.context/rules.md`, Code Hygiene section)
- **Evidence**:
  ```typescript
  // line 376
  const legacyNetId = reference.wireToNetId.get(wire);
  // line 379
  expect(legacyNetId).toBeDefined();
  // line 383
  expect(unifiedAddr.netId).toBe(legacyNetId);

  // line 877
  const legacyNetIdA = reference.labelToNetId.get('A');
  // line 880
  expect(legacyNetIdA).toBeDefined();
  // line 884
  expect(unifiedAddrA.netId).toBe(legacyNetIdA);
  ```
  Naming a variable `legacyNetId` (vs `unifiedAddr`) establishes a "legacy vs unified" dichotomy within a single test. This is precisely the backwards-compatibility shim pattern: old system output is extracted under a "legacy" name and compared to a "new" system output. The test is structured as a shim verification rather than as a direct behavioural assertion on the unified pipeline alone. In clean code after a completed refactor, there is no "legacy" — there is only the current system being tested against its specification.
- **Severity**: major

### V-4 — Duplicate contradictory JSDoc sentences on `BridgeState` interface
- **File**: `src/solver/coordinator.ts`
- **Lines**: 44–47
- **Rule violated**: "No commented-out code. No `# previously this was...` comments." and general code hygiene — duplicate/conflicting documentation is a quality defect. (`spec/.context/rules.md`, Code Hygiene section)
- **Evidence**:
  ```typescript
  /**
   * Per-bridge runtime state for the coordinator's bridge sync logic.
   * Per-bridge internal state for bridge sync between analog and digital domains.
   */
  interface BridgeState {
  ```
  The JSDoc block contains two near-identical sentences that contradict each other ("runtime state for the coordinator's bridge sync logic" vs "internal state for bridge sync between analog and digital domains"). This is a merge/edit artifact — likely two versions of the same comment that were both retained during the file move. One sentence must be removed to leave a single accurate description.
- **Severity**: minor

---

## Gaps

### G-1 — Spec Step 9 (CLAUDE.md path references): not verified as updated
- **Spec requirement**: Phase 6 spec Step 3, item 9: "CLAUDE.md — update file path references."
- **What was found**: The `CLAUDE.md` file (project root) still contains multiple references to `src/engine/` and `src/analog/` in its documentation tables. Specifically, the "Key Files" tables for the headless and editor architecture sections do not reflect the Phase 6 directory restructure. The file at `C:/local_working_projects/digital_in_browser/CLAUDE.md` has not been updated to reference `src/solver/digital/`, `src/solver/analog/`, and `src/solver/coordinator.ts` in its prose/tables.
  - Example: The spec mentions `src/analog/analog-engine.ts` is now `src/solver/analog/analog-engine.ts`, but CLAUDE.md documentation tables still list the old path form.
- **File**: `C:/local_working_projects/digital_in_browser/CLAUDE.md`
- **Note**: CLAUDE.md is not a TypeScript source file, so this is a documentation gap rather than a compile/runtime defect. The spec explicitly listed it as a required update (Step 3, item 9). The `progress.md` Phase 6 entry does not mention CLAUDE.md in its files-modified list, confirming it was skipped.

---

## Weak Tests

None found.

The test assertions in `compile-integration.test.ts` assert specific values (exact net IDs, exact feedback SCC counts, exact component indices) rather than trivially-true assertions. The `legacyNetId` naming is a code hygiene violation (reported above as V-3) but the assertions themselves are behaviourally substantive.

---

## Legacy References

### L-1 — Stale path reference in file header comment
- **File**: `src/compile/__tests__/compile-integration.test.ts`
- **Lines**: 8–9
- **Evidence**:
  ```
  *   src/engine/__tests__/compiler.test.ts
  *   src/analog/__tests__/compiler.test.ts
  ```
  After Phase 6, these paths no longer exist. The correct paths are `src/solver/digital/__tests__/compiler.test.ts` and `src/solver/analog/__tests__/compiler.test.ts`.

### L-2 — `legacyFeedback`, `legacyNetId`, `legacyNetIdA` variable names
- **File**: `src/compile/__tests__/compile-integration.test.ts`
- **Lines**: 376, 413–414, 877
- **Evidence**:
  ```typescript
  const legacyNetId = ...      // line 376
  const legacyFeedback = ...   // line 414
  const legacyNetIdA = ...     // line 877
  ```
  These names carry the semantic of "old/replaced system output" vs "new unified system output." After Phase 6 completes a purely structural restructure, there is no "legacy" vs "new" — the unified pipeline is the only pipeline.
