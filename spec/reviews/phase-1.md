# Review Report: Phase 1 — models bag on ComponentDefinition

## Summary

- **Tasks reviewed**: 6 (P1-1 through P1-6)
- **Violations**: 4 (0 critical, 1 major, 3 minor)
- **Gaps**: 2
- **Weak tests**: 3
- **Legacy references**: 2
- **Verdict**: has-violations

---

## Violations

### V1 — MAJOR

**File**: `src/core/registry.ts`, line 397

**Rule violated**: Spec section 3 (Registry, "Proposed") requires `getByEngineType` to be **replaced** by `getWithModel(modelKey: string)`. The spec states: "`getByEngineType` is removed." (unified-component-architecture.md, Section 3, "Proposed").

**Evidence**:
```typescript
/** Return all definitions that have a simulation model for the given engine type. */
getByEngineType(engineType: "digital" | "analog"): ComponentDefinition[] {
  return Array.from(this._byName.values()).filter((d) => {
    if (engineType === "digital") return hasDigitalModel(d);
    if (engineType === "analog") return hasAnalogModel(d);
    return false;
  });
}
```

The spec's P1-5 task states "Migrate `getByEngineType()` internals to use `models` presence" — the implementation correctly migrated the internals. However, the Phase 1 spec (Section 3) calls for `getByEngineType` to be replaced by `getWithModel(modelKey: string)`. The old method name `getByEngineType` persists, and no `getWithModel` method was added. This is an incomplete migration: the internals changed but the API shape specified by the spec was not produced.

Note: P1-5 wording says "migrate internals" which is ambiguous — but Section 3 of the spec is unambiguous that `getByEngineType` is removed and `getWithModel` is the replacement. This inconsistency between the task label and the spec section is flagged for resolution.

**Severity**: Major

---

### V2 — MINOR

**File**: `src/core/__tests__/registry.test.ts`, lines 505, 519

**Rule violated**: "No commented-out code. No `# previously this was...` comments." and "All replaced or edited code is removed entirely." (rules.md Code Hygiene). The test constructs `ComponentDefinition` objects with a stale `engineType` field that no longer exists on the `ComponentDefinition` interface.

**Evidence**:
```typescript
const analogDiode = { ...makeDefinition("Diode"), engineType: "analog" as const };
```
(appears at both line 505 and line 519)

`engineType` was removed from `ComponentDefinition` by the unified architecture. These test-only constructs attach the removed field with a TypeScript cast (`as const`) to suppress errors. Spreading a removed field into an object is a backwards-compatibility shim embedded in test infrastructure. The tests themselves are exercising a valid behaviour (alias shadowing), but the construction method uses a removed field.

**Severity**: Minor

---

### V3 — MINOR

**File**: `src/core/__tests__/registry.test.ts`, lines 503–513

**Rule violated**: "No historical-provenance comments" (rules.md Code Hygiene). The test block contains a comment block that describes the pre-migration world and explains a "bug scenario" in terms of the removed `engineType` field.

**Evidence**:
```typescript
// An alias occupying "Diode" would shadow a later canonical "Diode"
// registration (get() checks aliases first). The fix is to never
// create such an alias — verify that the conflict is detectable.
const analogDiode = { ...makeDefinition("Diode"), engineType: "analog" as const };
// register() succeeds (name not in _byName), but get() would return
// PldDiode via the alias. This is the bug scenario we guard against
// in register-all.ts by not creating the conflicting alias.
registry.register(analogDiode);
// With the alias still present, get("Diode") returns PldDiode —
// demonstrating why the alias must not exist.
```

This is a historical-provenance comment block: it describes an intended fix in `register-all.ts`, references how the system worked during migration, and explains the motivating "bug scenario" in terms of removed concepts. Comments of this character are banned by rules.md regardless of whether they appear in test or production files.

**Severity**: Minor

---

### V4 — MINOR

**File**: `src/core/__tests__/registry.test.ts`, line 513

**Rule violated**: "Test assertions that verify implementation details rather than desired behaviour" (reviewer.md Posture). The assertion `expect(result!.name).toBe("PldDiode")` is labeled with the comment `// alias wins (the bug)`, meaning the test intentionally asserts buggy behaviour as the expected outcome.

**Evidence**:
```typescript
const result = registry.get("Diode");
expect(result!.name).toBe("PldDiode"); // alias wins (the bug)
```

A test that asserts the presence of a known bug is not a behavioural correctness test — it is a documentation artefact. The assertion will pass even after the bug is fixed in the wrong direction. The correct approach is to assert correct behaviour and let the test fail if the system is broken, not to encode the broken state as the expectation.

**Severity**: Minor

---

## Gaps

### G1

**Spec requirement**: Section 3 ("Registry", "Proposed") specifies: `getWithModel(modelKey: string): ComponentDefinition[]` — "Returns all definitions that have `models[modelKey]` defined." And: "`getByEngineType` is removed."

**What was actually found**: `getByEngineType` remains on `ComponentRegistry` (registry.ts line 397). No `getWithModel` method was added. The internal logic of `getByEngineType` was correctly updated (P1-5), but the API shape the spec specifies was not produced.

**File**: `src/core/registry.ts`

---

### G2

**Spec requirement**: Phase 1 task P1-3 specifies auto-population of `models` from flat fields inside `register()`: "In `register()`, auto-populate `models` from existing flat fields: `if (!def.models) { def.models = {}; if (def.executeFn && def.executeFn !== noOpAnalogExecuteFn) { def.models.digital = { ... }; } if (def.analogFactory) { def.models.analog = { ... }; } }`"

**What was actually found**: No auto-population logic exists in `register()` (registry.ts lines 285–300). The `register()` method spreads the definition and assigns a typeId, but contains no conditional check for `!def.models` and no shimming from flat fields. The implementation instead made `models` a required field on `ComponentDefinition` (line 232: `models: ComponentModels;`) and required all callers to supply it directly. This is a valid end state for Phase 2 (after all component definitions are migrated), but Phase 1 explicitly requires the shim so that "component definitions are NOT changed yet" (spec Phase 1 description, last paragraph). The shim was the mechanism for zero-behaviour-change migration.

**Note**: Since Phase 2 has already been completed (per progress.md) and all component definitions now supply `models` directly, the P1-3 shim was effectively skipped and Phase 1 and Phase 2 were collapsed. This is documented in progress.md. The gap is recorded because the spec task P1-3 was not implemented as specified — the registry was modified, but not with the shimming logic described.

**File**: `src/core/registry.ts`

---

## Weak Tests

### WT1

**Test**: `src/core/__tests__/registry.test.ts::ComponentRegistry::ComponentModels types and utilities (P1-1 through P1-5)::models field is preserved through register()` (line 399)

**Issue**: The first assertion `expect(stored.models).toBeDefined()` is trivially weak. `models` being defined could mean an empty object `{}`. The assertion does not verify that the models bag has the correct structure — only that it is non-null. The subsequent assertions on lines 404–405 are stronger and subsume this check entirely.

**Evidence**:
```typescript
expect(stored.models).toBeDefined();
expect(stored.models.digital).toBeDefined();
expect(stored.models.digital!.executeFn).toBe(noopExecuteFn);
```

This is the same WT1 finding from the prior wave review (spec/reviews/wave-0.1-1.1.md, WT1). It was NOT addressed in the Phase 1 implementation. The weak assertion persists at line 403.

---

### WT2

**Test**: `src/core/__tests__/registry.test.ts::ComponentRegistry::ComponentModels types and utilities (P1-1 through P1-5)::register() preserves explicitly supplied models` (line 449)

**Issue**: The assertion `expect(stored.models).toBe(customModels)` tests object identity only — it does not verify the contents of the stored models. A test that asserts identity does confirm that `register()` did not clone or replace the object, but it does not confirm that `customModels.digital.executeFn` is the function that was supplied. If the registry accidentally cloned `customModels` while preserving the same `executeFn` reference, the identity check would fail but the content check would pass — meaning the test catches the wrong failure mode.

**Evidence**:
```typescript
const customModels: ComponentModels = {
  digital: { executeFn: noopExecuteFn },
};
const def: ComponentDefinition = { ...makeDefinition("ExplicitModels"), models: customModels };
registry.register(def);
const stored = registry.get("ExplicitModels")!;
expect(stored.models).toBe(customModels);
```

This is the same WT2 finding from the prior wave review (spec/reviews/wave-0.1-1.1.md, WT2). It was NOT addressed. The identity-only assertion persists at line 456.

---

### WT3

**Test**: `src/core/__tests__/registry.test.ts::ComponentRegistry::alias must not shadow a later canonical name::registering a canonical name that matches an existing alias throws` (line 498)

**Issue**: The test's title says "registering a canonical name that matches an existing alias throws" — but the test body does NOT assert that `register()` throws. Instead, it calls `registry.register(analogDiode)` and then asserts that `get("Diode")` returns `PldDiode` (the wrong result). The test describes and asserts buggy behaviour. The title is misleading and the assertion verifies the broken state rather than the correct behaviour.

**Evidence**:
```typescript
it("registering a canonical name that matches an existing alias throws", () => {
  registry.register(makeDefinition("PldDiode"));
  registry.registerAlias("Diode", "PldDiode");
  const analogDiode = { ...makeDefinition("Diode"), engineType: "analog" as const };
  registry.register(analogDiode);
  const result = registry.get("Diode");
  expect(result!.name).toBe("PldDiode"); // alias wins (the bug)
});
```

No `toThrow` assertion is present despite the test's declared intention. The test encodes the known-broken state as the expected outcome, making it a negative specification of correct behaviour rather than a positive assertion.

---

## Legacy References

### LR1

**File**: `src/core/__tests__/registry.test.ts`, line 505

**Evidence**:
```typescript
const analogDiode = { ...makeDefinition("Diode"), engineType: "analog" as const };
```

`engineType` is the removed field from `ComponentDefinition`. Spreading it into a definition object and casting it references the pre-migration API that the unified architecture specification explicitly removes (spec Section 1 "Current" → "Proposed" transition removes `engineType`). This is a stale reference to the removed field embedded in test object construction.

---

### LR2

**File**: `src/core/__tests__/registry.test.ts`, line 519

**Evidence**:
```typescript
const analogDiode = { ...makeDefinition("Diode"), engineType: "analog" as const };
```

Same stale `engineType` reference, second occurrence in the same test file (second `it` block under `"alias must not shadow a later canonical name"`). Each occurrence is a separate stale reference and is reported individually.
