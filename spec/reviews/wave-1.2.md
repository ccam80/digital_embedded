# Review Report: Wave 1.2 — MNA Infrastructure

## Summary

| Item | Count |
|------|-------|
| Tasks reviewed | 2 (1.2.1, 1.2.2) |
| Violations — critical | 0 |
| Violations — major | 1 |
| Violations — minor | 1 |
| Gaps | 2 |
| Weak tests | 2 |
| Legacy references | 0 |

**Verdict**: has-violations

---

## Violations

### V-1 (major) — `NodeMap.matrixSize` set to `nodeCount` only, formula is wrong

- **File**: `src/analog/node-map.ts`, line 293
- **Rule violated**: Spec adherence — "Files to create" component correctness
- **Evidence**:
  ```ts
  // line 293
  matrixSize: nodeCount,
  ```
  The spec defines `NodeMap.matrixSize` as `nodeCount + branchCount`. The returned object sets `branchCount: 0` and `matrixSize: nodeCount`. While these are numerically equal at construction (because `buildNodeMap` always starts with zero branches), the `matrixSize` field is documented as a derived value — `nodeCount + branchCount` — and will diverge silently if any downstream code increments `branchCount` without recalculating `matrixSize`. The spec says `matrixSize: number — nodeCount + branchCount`, making this a semantically wrong initialisation of a field whose job is to track the full MNA system dimension.

- **Severity**: major

---

### V-2 (minor) — `makeDiagnostic` sets undocumented default for required field `explanation`

- **File**: `src/analog/diagnostics.ts`, line 141
- **Rule violated**: Spec adherence — `makeDiagnostic` defaults only the listed optional fields
- **Evidence**:
  ```ts
  // line 137-148
  return {
    code,
    severity,
    summary,
    explanation: opts?.explanation ?? "",  // ← not listed in spec defaults
    suggestions: opts?.suggestions ?? [],
    ...
  };
  ```
  The spec says the factory fills required fields (`code`, `severity`, `summary`) and applies defaults for `suggestions → []` and the optional fields (`involvedNodes`, `involvedElements`, `simTime`, `detail`). It does not say `explanation` defaults to `""`. The `SolverDiagnostic` interface declares `explanation: string` (non-optional). By silently defaulting it to an empty string, `makeDiagnostic` allows callers to omit a field that is conceptually required and meaningful. A caller that does not supply `explanation` gets a blank string in the diagnostic panel with no warning. This is undocumented behaviour outside the spec's stated contract for the factory.

- **Severity**: minor

---

## Gaps

### G-1 — `NodeMap` has an extra `diagnostics` field not in the spec

- **Spec requirement**: `NodeMap` type has exactly these fields: `nodeCount`, `branchCount`, `matrixSize`, `wireToNodeId`, `labelToNodeId`, `elementNodes`.
- **What was actually found**: The implementation adds a seventh field `diagnostics: SolverDiagnostic[]` (node-map.ts lines 57-58) and populates it with the `no-ground` diagnostic.
- **File**: `src/analog/node-map.ts`, lines 57-58 and line 117 (local variable), lines 206-224 (push into it), line 297 (returned in object)
- **Impact**: The `no-ground` diagnostic is stored on the `NodeMap` instead of being emitted via a `DiagnosticCollector`. This means the compiler calling `buildNodeMap` must know to pull diagnostics out of the map, whereas the rest of the system uses `DiagnosticCollector.emit()`. The approach is internally consistent but diverges from the spec's type definition and the system's diagnostic dispatch pattern.

---

### G-2 — Spec acceptance criterion "Every diagnostic has code, severity, summary at minimum" is not tested for `makeDiagnostic` — `explanation` omission scenario

- **Spec requirement**: Task 1.2.1 acceptance criterion: "Every diagnostic has code, severity, summary at minimum." The spec also lists `explanation` as a field of `SolverDiagnostic`, and the test for `makeDiagnostic` (`fills_required_fields`) does not assert that calling the factory without `opts` does NOT produce a misleading empty `explanation`.
- **What was actually found**: The test file `src/analog/__tests__/diagnostics.test.ts` tests `explanation` only via the override path (line 160-169: "should allow overriding explanation via opts"). There is no test asserting the default value of `explanation` when `opts` is absent. Given that the implementation silently defaults `explanation` to `""`, this gap means a caller can produce a `SolverDiagnostic` with an empty `explanation` string with no test catching it.
- **File**: `src/analog/__tests__/diagnostics.test.ts` — no test for default `explanation` value

---

## Weak Tests

### WT-1 — `merged_wires_share_node_id`: bare `toBeDefined()` before value assertions

- **Test path**: `src/analog/__tests__/mna-assembler.test.ts::NodeMapping::merged_wires_share_node_id`
- **What's wrong**: Lines 153-154 assert `expect(id1).toBeDefined()` and `expect(id2).toBeDefined()` before the substantive assertions. The node ID type is `number | undefined` (returned from `Map.get()`). Asserting `toBeDefined()` alone tells us nothing about the value — it merely confirms the wire was found in the map. The subsequent `expect(id1).toBe(id2)` and `expect(id1).not.toBe(0)` do the real work, but TypeScript's non-null assertion on `id1` is not safe without a type-narrowing guard. The correct pattern is to check the value directly (`expect(id1).toBeGreaterThan(0)`) and let that serve as both the defined check and the value check.
- **Quoted evidence**:
  ```ts
  expect(id1).toBeDefined();
  expect(id2).toBeDefined();
  expect(id1).toBe(id2);
  expect(id1).not.toBe(0); // not ground
  ```

---

### WT-2 — `missing_ground_emits_diagnostic`: `toBeDefined()` on `find()` result before severity check

- **Test path**: `src/analog/__tests__/mna-assembler.test.ts::NodeMapping::missing_ground_emits_diagnostic`
- **What's wrong**: Line 207 asserts `expect(noGround).toBeDefined()` where `noGround` is the result of `Array.find()`. This is a weak existence check. The spec requires that "a diagnostic is emitted (not a hard error)" — but the test does not check that `noGround.code === "no-ground"` (which is the filter criterion, making it trivially true) or that the diagnostic contains any content beyond `severity`. A meaningful assertion would also check `noGround!.summary` contains a useful message, ensuring diagnostic quality is tested, not just existence.
- **Quoted evidence**:
  ```ts
  const noGround = nodeMap.diagnostics.find((d) => d.code === "no-ground");
  expect(noGround).toBeDefined();
  expect(noGround!.severity).toBe("warning");
  ```

---

## Legacy References

None found.

---

## Notes

### `ComplexSparseSolver` forward reference in `element.ts`

The `AnalogElement` interface in `src/analog/element.ts` (lines 34-37) declares a `ComplexSparseSolver` interface inline as a forward reference for the `stampAc` method. The spec explicitly acknowledges this: "`ComplexSparseSolver` type is defined in Phase 6." The implementation's inline declaration matches the spec's intent and is not a violation.

### Test count matches

The wave completion report states 14/14 tests passing for task 1.2.1 and 11/11 for task 1.2.2. The test file for 1.2.1 contains 14 `it()` calls and the test file for 1.2.2 contains 11 `it()` calls, matching the reported counts.

### `buildNodeMap` diagnostic routing

The ground-detection diagnostic is emitted into `NodeMap.diagnostics` rather than a `DiagnosticCollector`. This is captured as gap G-1. No `DiagnosticCollector` parameter was added to `buildNodeMap`, which is a design deviation. Wave 1.3 callers of `buildNodeMap` will need to manually drain `nodeMap.diagnostics` into their `DiagnosticCollector` — this interop mismatch is the practical consequence of G-1.
