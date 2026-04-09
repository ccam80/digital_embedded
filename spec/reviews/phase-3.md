# Review Report: Phase 3 — Stream 2: MCP Tool Layer

## Summary

- **Tasks reviewed**: S2-A, S2-B, S2-C, S2-D
- **Files reviewed**: `scripts/mcp/harness-session-state.ts`, `scripts/mcp/harness-format.ts`, `scripts/mcp/harness-tools.ts`, `scripts/circuit-mcp-server.ts`, `scripts/mcp/__tests__/harness-session-state.test.ts`, `scripts/mcp/__tests__/harness-format.test.ts`, `scripts/mcp/__tests__/harness-tools.test.ts`
- **Violations**: 7 (2 critical, 3 major, 2 minor)
- **Gaps**: 6
- **Weak tests**: 6
- **Legacy references**: 0
- **Verdict**: has-violations

---

## Violations

### V1 — CRITICAL — `filter: "worst"` does not sort by `absDelta` descending

**File**: `scripts/mcp/harness-tools.ts`, lines 961–963

**Rule violated**: Spec §2.3 "When `filter: 'worst'`, the `worstN` (default 10) entries with the largest `absDelta` are returned, sorted descending by `absDelta`."

**Evidence**:
```typescript
if (args.filter === "worst") {
  const n = args.worstN ?? 10;
  entries = entries.slice(0, n);
}
```

The implementation simply calls `slice(0, n)` on the array as-is. There is no sort step before the slice. If `getDivergences()` returns entries in chronological order (as it does), the "worst" filter returns the first N entries, not the N entries with the largest `absDelta`. The spec explicitly mandates descending sort by `absDelta`. The required implementation is `entries.sort((a, b) => b.absDelta - a.absDelta).slice(0, n)`.

**Severity**: critical

---

### V2 — CRITICAL — `cktMode` is hardcoded to 0 in `integration-coefficients` output

**File**: `scripts/mcp/harness-tools.ts`, line 692

**Rule violated**: Spec §2.3 "Integration Coefficients" output shape: `cktMode: number` — "raw CKTmode flags bitmask from ngspice session". Spec §9 table: `StepSnapshot.cktMode` → `step + integrationCoefficients: true`.

**Evidence**:
```typescript
cktMode: 0,
```

`cktMode` is always emitted as the literal `0` regardless of the actual value in the session data. The `getIntegrationCoefficients()` call returns `report` which should contain the `cktMode` field (via `StepSnapshot.cktMode`). Hardcoding it to zero silently destroys diagnostic information that the spec mandates be exposed.

**Severity**: critical

---

### V3 — MAJOR — `prevNodes` is always an empty object in `step-iterations` output

**File**: `scripts/mcp/harness-tools.ts`, line 719

**Rule violated**: Spec §2.3 "Step Iterations" output shape `IterationDataJSON.prevNodes`: "Previous-iteration node voltages keyed by node label. Same keys as `nodes`." Spec §9 table: `IterationSnapshot.prevVoltages` → `step + iterations: true` → `iterationData[].prevNodes`.

**Evidence**:
```typescript
prevNodes: {},
```

`prevNodes` is unconditionally set to an empty object. `IterationSnapshot.prevVoltages` (a `Float64Array`) is never read. The field exists in the output but carries no data, making the specified diagnostic path permanently unusable.

**Severity**: major

---

### V4 — MAJOR — Slot glob pattern matching is not case-insensitive and metacharacters are not escaped

**File**: `scripts/mcp/harness-tools.ts`, line 640

**Rule violated**: Spec Appendix "Glob Matching for Slot Filters": "Matching is case-insensitive." Reference implementation uses `new RegExp(regexStr, "i")` and full metacharacter escaping: `pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")`.

**Evidence**:
```typescript
slots.filter((s) => args.slots!.some((pat) => new RegExp("^" + pat.replace(/\*/g, ".*") + "$").test(s)))
```

Two defects in this line:
1. The `RegExp` is constructed without the `"i"` flag. A glob pattern `"q_*"` will fail to match slot `"Q_BE"`.
2. Only `*` is converted to `.*`; other regex metacharacters (`.`, `+`, `^`, `$`, `{`, `}`, `(`, `)`, `|`, `[`, `]`, `\`) are not escaped. A slot name or pattern containing any of these will produce incorrect regex matching.

**Severity**: major

---

### V5 — MAJOR — `harness_compare_matrix` does not validate `iteration` out of range

**File**: `scripts/mcp/harness-tools.ts`, lines 1018–1063

**Rule violated**: Spec §2.5 Error Cases: "`iteration` out of range → `harness_compare_matrix: iteration <n> out of range [0, <max>] at step <s>`"

**Evidence**: The handler validates that `step` is within range (lines 1027–1031) but performs no check that `args.iteration` is within the valid NR iteration range for that step. The session method `compareMatrixAt` is called with the unchecked `args.iteration` directly. An out-of-bounds iteration index will produce undefined behaviour (crash or empty result) rather than the specified error message.

**Severity**: major

---

### V6 — MINOR — `ConvergenceDataJSON.worstSlot` field is never populated

**File**: `scripts/mcp/harness-tools.ts`, lines 595–601 (P3 handler) and 616–622 (P4 handler)

**Rule violated**: Spec §2.3 "Per-Element Convergence" output shape: `worstSlot?: string` — "slot name with largest delta, if available".

**Evidence** (identical pattern in both P3 and P4):
```typescript
const convergenceData = items.map((e: any) => ({
  label: e.label,
  deviceType: e.deviceType,
  converged: e.ourConverged,
  noncon: e.ourConverged ? 0 : 1,
  worstDelta: e.worstDelta !== undefined ? formatNumber(e.worstDelta) : undefined,
}));
```

`worstSlot` is absent from the mapped output. When the underlying `ConvergenceDetailReport` element carries a slot name for the worst delta, that information is silently dropped.

**Severity**: minor

---

### V7 — MINOR — `noncon` field in `ConvergenceDataJSON` is fabricated (0 or 1) rather than read from data

**File**: `scripts/mcp/harness-tools.ts`, lines 599 and 620

**Rule violated**: Spec §2.3 `ConvergenceDataJSON.noncon: number` — "element's contribution to the noncon counter". This is a numeric count from capture data, not a boolean indicator.

**Evidence**:
```typescript
noncon: e.ourConverged ? 0 : 1,
```

The implementation synthesises a fake `noncon` value of 0 or 1 based on the boolean `ourConverged` flag. The actual per-element `noncon` contribution from `ConvergenceDetailReport.elements` is never read. An element can be converged but have contributed a noncon count in a prior iteration, and the actual count can be any non-negative integer.

**Severity**: minor

---

## Gaps

### G1 — `scripts/mcp/__tests__/harness-serialization.test.ts` — File entirely absent

**Spec requirement**: §10.9 "Serialization Unit Tests" — File `scripts/mcp/__tests__/harness-serialization.test.ts` with 11 specific named tests covering `formatEngineering`, `comparedValueToJSON`, `globMatch`, `matrixPositionLabel`, and `resolveNodeLabel`.

**What was found**: The file does not exist. `scripts/mcp/__tests__/harness-format.test.ts` covers `formatNumber`, `formatComparedValue`, and `suggestComponents` but not `globMatch`, `matrixPositionLabel`, or `resolveNodeLabel`. None of the 11 §10.9 tests exist anywhere in the test suite.

**File path**: `scripts/mcp/__tests__/harness-serialization.test.ts`

---

### G2 — `harness_query` slots glob filter test missing from test suite

**Spec requirement**: §10.4 — "`component: 'Q1'` + `slots: ['Q_*']` → only `Q_*` slots in output"

**What was found**: No test for slot glob filtering exists in `harness-tools.test.ts`. Search for `Q_*`, `slots`, and `slot.*filter` in the test file returns no matches. The spec explicitly requires this test by name and assertion. This gap also means violation V4 (case-insensitive glob) is undetectable by the test suite.

**File path**: `scripts/mcp/__tests__/harness-tools.test.ts`

---

### G3 — `harness_query` `stepRange` and `timeRange` filter tests missing

**Spec requirement**: §10.4 — "`stepRange: [2, 5]` → only steps 2-5 in output" and "`timeRange: [0, 1e-3]` → steps filtered by simTime"

**What was found**: No test for `stepRange` or `timeRange` filtering exists in `harness-tools.test.ts`. Both are explicitly required by §10.4 with named assertions.

**File path**: `scripts/mcp/__tests__/harness-tools.test.ts`

---

### G4 — `filter: "worst"` sort-by-absDelta behaviour not tested

**Spec requirement**: §10.4 — "`filter: 'worst'` + `worstN: 3` → top 3 by `absDelta`"

**What was found**: The existing test for `filter: "worst"` (lines 655–662) only asserts `data.queryMode === "divergences"`. It does not verify that the returned entries are sorted descending by `absDelta` nor that only the top `worstN` entries are present. The broken sort-before-slice implementation (V1) passes this test undetected.

**File path**: `scripts/mcp/__tests__/harness-tools.test.ts`

---

### G5 — `harness_compare_matrix` `iteration` out-of-range test missing

**Spec requirement**: §10.6 — "`iteration` out of range → `isError: true`"

**What was found**: The `harness_compare_matrix` test suite includes a step-out-of-range test (lines 784–791) but no iteration-out-of-range test. The spec §10.6 table explicitly lists this as a required test. This gap also means violation V5 (missing iteration range check) is undetectable by the test suite.

**File path**: `scripts/mcp/__tests__/harness-tools.test.ts`

---

### G6 — `filter: "divergences"` withinTol assertion missing from `harness_query` tests

**Spec requirement**: §10.4 — "`filter: 'divergences'` → only `withinTol: false` entries"

**What was found**: The test at lines 645–653 verifies `queryMode: "divergences"` and that `divergences` is an array but does not assert that all returned entries have `withinTol: false`. The spec requires verifying that the filter actually excludes in-tolerance entries.

**File path**: `scripts/mcp/__tests__/harness-tools.test.ts`

---

## Weak Tests

### WT1 — `filter: "worst"` test asserts only queryMode, not sort order or entry selection

**Test path**: `scripts/mcp/__tests__/harness-tools.test.ts::harness_query::filter worst returns divergences queryMode top entries`

**What is wrong**: The test only asserts `data.queryMode === "divergences"`. It does not verify that the entries are sorted by `absDelta` descending or that `worstN` limits the result set correctly. This assertion is so weak it passes even if `filter: "worst"` returns random entries — and it does pass despite the broken implementation in V1.

**Evidence**:
```typescript
const data = JSON.parse(result.content[0].text);
expect(data.queryMode).toBe("divergences");
```

---

### WT2 — `harness_describe` nodeMapping test conditionally skips assertion

**Test path**: `scripts/mcp/__tests__/harness-tools.test.ts::harness_describe::nodeMapping entries have ourIndex ngspiceIndex label`

**What is wrong**: The shape assertions are wrapped in `if (data.nodeMapping.length > 0)`. If `nodeMapping` is empty the test passes vacuously. The spec §10.5 requires "nodeMapping populated after `harness_run`". The test does not call `harness_run` first to guarantee a non-empty mapping, so the condition is always false in the test setup and the assertions never execute.

**Evidence**:
```typescript
if (data.nodeMapping.length > 0) {
  expect(data.nodeMapping[0]).toHaveProperty("ourIndex");
  expect(data.nodeMapping[0]).toHaveProperty("ngspiceIndex");
  expect(data.nodeMapping[0]).toHaveProperty("label");
}
```

---

### WT3 — `harness_query` component-step-end does not verify FormattedNumber shape on slot values

**Test path**: `scripts/mcp/__tests__/harness-tools.test.ts::harness_query::component+step returns component-step-end queryMode`

**What is wrong**: The test asserts `queryMode` and `stepEnd.label` but does not verify that slot values in `stepEnd.slots` are `FormattedNumber` objects with `raw` and `display` fields. Spec §5 mandates FormattedNumber wrapping on all numeric output. This is an implementation-detail check (mode dispatch) not a behaviour check (correct output shape).

**Evidence**:
```typescript
expect(data.queryMode).toBe("component-step-end");
expect(data.stepEnd.label).toBe("Q1");
```

---

### WT4 — `harness_query` step-end `converged` assertion is only `.toBeDefined()`

**Test path**: `scripts/mcp/__tests__/harness-tools.test.ts::harness_query::step only returns step-end queryMode with converged field`

**What is wrong**: `expect(data.stepEnd.converged).toBeDefined()` passes for any truthy or falsy value including `null`, `0`, or an empty string. The spec requires `converged: { ours: boolean; ngspice: boolean }`. The assertion should verify `data.stepEnd.converged.ours` and `data.stepEnd.converged.ngspice` are booleans.

**Evidence**:
```typescript
expect(data.stepEnd.converged).toBeDefined();
```

---

### WT5 — `harness_export` `sizeBytes` assertion uses `>= 0` which is trivially true

**Test path**: `scripts/mcp/__tests__/harness-tools.test.ts::harness_export::export returns handle exportedAt dtsPath cirPath analysis summary topology steps sizeBytes`

**What is wrong**: `expect(data.sizeBytes).toBeGreaterThanOrEqual(0)` passes for any non-negative number including zero. The spec requires `sizeBytes` to reflect the actual JSON byte size of the `steps` array. The assertion should be `> 0` when steps are non-empty, or should verify `data.sizeBytes === JSON.stringify(data.steps).length`.

**Evidence**:
```typescript
expect(data.sizeBytes).toBeGreaterThanOrEqual(0);
```

---

### WT6 — `harness_query` step-iterations asserts only `Array` without content inspection

**Test path**: `scripts/mcp/__tests__/harness-tools.test.ts::harness_query::step+iterations returns step-iterations queryMode`

**What is wrong**: The test asserts `data.iterationData` is an array (`toBeInstanceOf(Array)`) but does not inspect any element. It does not verify that numeric fields (`simTime`, `noncon`, node voltages) are `FormattedNumber` objects with `raw` and `display` fields as required by spec §5. This is a bare instanceof check without content verification.

**Evidence**:
```typescript
expect(data.iterationData).toBeInstanceOf(Array);
```

---

## Legacy References

None found.
