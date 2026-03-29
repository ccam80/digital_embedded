# Review Report: Wave 6 — digitalPinLoading metadata + bridge synthesis

## Summary

| Item | Count |
|------|-------|
| Tasks reviewed | 3 (W6.1, W6.2, W6.3) |
| Violations — critical | 1 |
| Violations — major | 2 |
| Violations — minor | 1 |
| Gaps | 3 |
| Weak tests | 4 |
| Legacy references | 0 |

**Verdict: has-violations**

---

## Violations

### V1 — CRITICAL — Per-net override resolution result discarded

**File:** `src/compile/compile.ts`
**Lines:** 128–132

**Rule violated:** Completeness rule — "Never mark work as deferred, TODO, or 'not implemented.'" The spec (model-unification.md lines 712–718) explicitly requires that after `resolveLoadingOverrides()` the resolved map is applied to "that group's partition boundary handling". The `resolved` Map is computed but then silently discarded.

**Evidence:**
```typescript
// Resolve per-net loading overrides (maps stable net IDs to loading modes)
const overrides = circuit.metadata.digitalPinLoadingOverrides ?? [];
const { diagnostics: overrideDiags } =
  resolveLoadingOverrides(overrides, groups, circuit.elements);
diagnostics.push(...overrideDiags);
```

The destructuring extracts only `diagnostics: overrideDiags` — the `resolved` field (a `Map<number, 'loaded' | 'ideal'>`) is never bound to a variable and never passed to `partitionByDomain` or `compileAnalogPartition`. Per-net loading overrides are parsed and their diagnostic warnings are emitted, but the override values themselves have no effect on bridge synthesis. The feature is functionally incomplete.

**Severity: critical**

---

### V2 — MAJOR — `resolveModelAssignments` silently swallows unknown `simulationModel` instead of throwing

**File:** `src/compile/extract-connectivity.ts`
**Lines:** 91–97

**Rule violated:** Spec model-unification.md lines 192–197 requires: "When `simulationModel` is set to a key that doesn't exist: `getActiveModelKey()` throws with the invalid key and the list of valid keys. The compiler catches this and emits a diagnostic... No silent fallback — the user must fix the property."

The `resolveModelAssignments` function in `extract-connectivity.ts` directly contradicts the spec and also contradicts the behaviour of `getActiveModelKey` in `registry.ts`. When `simulationModel` is set to an unrecognized value (including the legacy `"logical"` sub-mode), `resolveModelAssignments` silently routes the component to the first MNA model key instead of throwing.

**Evidence:**
```typescript
} else if (
  typeof simulationModelProp === 'string' &&
  simulationModelProp.length > 0 &&
  firstMnaKey !== undefined
) {
  // Unrecognized prop value but component has mna models — route to first mna key
  modelKey = firstMnaKey;
```

The comment itself confirms the agent knowingly diverged from the spec. The `"// Unrecognized prop value but component has mna models — route to first mna key"` comment describes a fallback behaviour that the spec explicitly bans.

**Severity: major**

---

### V3 — MAJOR — Duplicate comment block in `resolveModelAssignments` — prohibited historical-provenance / commented reasoning

**File:** `src/compile/extract-connectivity.ts`
**Lines:** 75–78

**Rule violated:** Code Hygiene rule — "No commented-out code. No `# previously this was...` comments." and "Historical-provenance comments... are banned." The presence of two consecutive `// Resolve model key:` comment lines — one describing the old fallback chain, the next describing the new strategy — is either commented-out code or a historical-provenance comment documenting what the code replaced.

**Evidence:**
```typescript
// Resolve model key: simulationModel prop > defaultModel > first key.
// Resolve model key: check simulationModel prop against known model keys,
// then fall back to defaultModel, then first available key.
// Unknown prop values with mnaModels present route to the first mna key.
```

The first line is a duplicate/prior version of the second. This is a stale comment left from an earlier draft of the function. The presence of both explains what changed, which is banned.

**Severity: major**

---

### V4 — MINOR — `save-schema.ts` not updated (spec-required file omitted from Wave 6)

**File:** `src/io/save-schema.ts`

**Rule violated:** Spec adherence — the Wave 6 task specification (model-unification.md line 906) explicitly lists `save-schema.ts` as a required file to modify: "`compile.ts`, `compiler.ts`, `src/core/circuit.ts`, `save-schema.ts`". The serialization spec (lines 459–471) also specifies additions to `SavedMetadata`:

```typescript
interface SavedMetadata {
  digitalPinLoading?: "cross-domain" | "all" | "none";
  digitalPinLoadingOverrides?: Array<{ ... }>;
}
```

The current `SavedMetadata` in `src/io/save-schema.ts` contains neither field. The `engineType` field (specified for removal, line 471) is still present.

**Evidence:** `src/io/save-schema.ts` `SavedMetadata` interface contains:
- No `digitalPinLoading` field
- No `digitalPinLoadingOverrides` field
- Still has `engineType?: string` (spec says: "Delete from save schema and all serialization/deserialization paths")

**Severity: minor** (save/load is Wave 9; however the spec lists `save-schema.ts` as a Wave 6 deliverable, making this a scope gap)

---

## Gaps

### G1 — E2E test surface missing for Wave 6

**Spec requirement:** model-unification.md lines 941–944, "Wave 6 (digitalPinLoading): 3. **E2E:** Set loading mode via menu, verify simulation behavior changes." CLAUDE.md Three-Surface Testing Rule requires every user-facing feature to be tested across all three surfaces: headless API, MCP tool, and E2E/UI test.

**What was found:** No E2E test file exists for `digitalPinLoading`. Searching `e2e/**` for `digitalPinLoading` returns zero matches. The headless (W6.1: 14 tests) and MCP (W6.1: 5 tests) surfaces are covered but the E2E surface is absent.

**File:** No file — gap is the absence of a required file under `e2e/`.

---

### G2 — Per-net override integration never wired into partition/bridge synthesis

**Spec requirement:** model-unification.md lines 712–718 — after computing the `resolved: Map<groupId, 'loaded'|'ideal'>`, the compiler must apply the override map to partition boundary handling. The progress.md entry for W6.2 acknowledges this was partial: "The field blocked on W6.1 holding the circuit.ts file lock throughout this agent's run."

**What was found:** `compile.ts:128–132` calls `resolveLoadingOverrides` and extracts only `diagnostics`. The `resolved` map is never stored, never passed to `partitionByDomain`, and never passed to `compileAnalogPartition`. The entire per-net override system (stableNetId, resolveLoadingOverrides, PinLoadingOverride interface) is implemented and tested in isolation but has zero effect on compilation output.

**File:** `src/compile/compile.ts:128–132`

---

### G3 — `save-schema.ts` missing `digitalPinLoading` / `digitalPinLoadingOverrides` and `engineType` not removed

**Spec requirement:** model-unification.md lines 459–471 specifies additions to `SavedMetadata` (`digitalPinLoading`, `digitalPinLoadingOverrides`) and removal of `engineType`.

**What was found:** `src/io/save-schema.ts` `SavedMetadata` interface has no `digitalPinLoading`, no `digitalPinLoadingOverrides`, and retains `engineType?: string` which the spec says to delete. The Wave 6 task specification lists `save-schema.ts` as a required deliverable file.

**File:** `src/io/save-schema.ts`

---

## Weak Tests

### WT1 — `digital-pin-loading.test.ts` — "all mode" test only checks `bridges.length > 0`, not exact count

**Test path:** `src/solver/analog/__tests__/digital-pin-loading.test.ts::digitalPinLoading: all::all mode: dual-model component in digital partition gets bridge adapters`

**What is wrong:** The assertion `expect(compiled.bridges.length).toBeGreaterThan(0)` is trivially weak. The spec acceptance criterion is "`all` > `cross-domain` > `none` (zero loading stamps)" — a count comparison. A single bridge with 0 adapters would satisfy this assertion. The next test in the same describe block (adapter counts) provides stronger coverage, but this particular test asserts only non-emptiness.

**Evidence:**
```typescript
expect(compiled.bridges.length).toBeGreaterThan(0);
```

---

### WT2 — `digital-pin-loading.test.ts` — intermediate filter result checked with `> 0` before indexing

**Test path:** `src/solver/analog/__tests__/digital-pin-loading.test.ts::digitalPinLoading: all::all mode: bridge has correct adapter counts (2 inputs + 1 output)`

**What is wrong:** `expect(inlineBridges.length).toBeGreaterThan(0)` before `inlineBridges[0]!` is a guard assertion that tests only that the array is non-empty, not which bridge it is. If multiple bridges exist the test silently picks the first, which may not be the DigitalXor bridge. The assertion should identify the bridge by the component's instanceId or label, not positional indexing.

**Evidence:**
```typescript
const inlineBridges = compiled.bridges.filter(
  b => b.inputAdapters.length > 0 || b.outputAdapters.length > 0,
);
expect(inlineBridges.length).toBeGreaterThan(0);

const bridge = inlineBridges[0]!;
```

---

### WT3 — `digital-pin-loading-mcp.test.ts` — compile-without-errors test uses only `not.toThrow()` + `not.toBeNull()`

**Test path:** `src/headless/__tests__/digital-pin-loading-mcp.test.ts::digitalPinLoading MCP surface — mode all::circuit_compile with digitalPinLoading="all" compiles without errors`

**What is wrong:** The test verifies only that compilation succeeds without errors. It does not verify that the `"all"` mode produced any bridge adapters for the And gate (the defining behaviour of `"all"` mode). "No errors" is necessary but not sufficient evidence that `digitalPinLoading="all"` was respected.

**Evidence:**
```typescript
expect(() => facade.compile(circuit)).not.toThrow();
const compiled = facade.getCompiledUnified();
expect(compiled).not.toBeNull();
const errors = compiled!.diagnostics.filter(d => d.severity === 'error');
expect(errors).toHaveLength(0);
```

---

### WT4 — `digital-pin-loading.test.ts` — "none bridge count equals cross-domain" test is duplicated

**Test path 1:** `src/solver/analog/__tests__/digital-pin-loading.test.ts::digitalPinLoading: none::none bridge count matches cross-domain (same boundary detection)`
**Test path 2:** `src/solver/analog/__tests__/digital-pin-loading.test.ts::digitalPinLoading: ordering invariant (all > cross-domain >= none)::none bridge count equals cross-domain bridge count (same partition boundary detection)`

**What is wrong:** Both tests assert `compiledNone.bridges.toHaveLength(compiledCross.bridges.length)` using the same circuit construction (`simulationModel: "logical"`). They are functionally identical — the second adds no new coverage. One of these is redundant test count padding.

**Evidence (test 1):**
```typescript
expect(compiledNone.bridges).toHaveLength(compiledCross.bridges.length);
```
**Evidence (test 2):**
```typescript
expect(compiledNone.bridges).toHaveLength(compiledCross.bridges.length);
```

---

## Legacy References

None found.
