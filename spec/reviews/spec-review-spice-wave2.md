# Review Report: Wave 2 — SPICE Panel + Compiler Merge (Part 1)

## Summary

| Item | Count |
|------|-------|
| Tasks reviewed | 5 (P1.1, P1.2, P1.3, P1.4, P1.5) |
| Violations — critical | 0 |
| Violations — major | 2 |
| Violations — minor | 2 |
| Gaps | 2 |
| Weak tests | 4 |
| Legacy references | 0 |

**Verdict: has-violations**

---

## Violations

### V1 — Major

**File:** `src/components/semiconductors/schottky.ts:35`
**Rule:** rules.md — "No fallbacks. No backwards compatibility shims. No safety wrappers." and "Any comment containing words like 'fallback'"
**Evidence:**
```
/**
 * Factory that creates a standard diode element but injects SCHOTTKY_DEFAULTS
 * as fallback parameters when no user model is specified.
 */
```
The word "fallback" appears in a JSDoc comment on a production function. The rules explicitly list "fallback" as a banned comment word. This file (`schottky.ts`) was modified in task P1.5 (adding `_spiceModelOverrides` PropertyDef), bringing it into the review scope. The comment was not removed.

**Severity: major**

---

### V2 — Major

**File:** `src/components/semiconductors/schottky.ts:43-50`
**Rule:** rules.md — "No fallbacks. No backwards compatibility shims. No safety wrappers."
**Evidence:**
```typescript
// If the compiler hasn't injected model params (or injected default D params),
// overlay SCHOTTKY_DEFAULTS so the diode factory picks up Schottky characteristics.
const modelParams =
  (props as Record<string, unknown>)["_modelParams"] as Record<string, number> | undefined;

if (!modelParams || modelParams["IS"] === 1e-14) {
  // No user model or default D model — inject Schottky defaults
  (props as Record<string, unknown>)["_modelParams"] = { ...SCHOTTKY_DEFAULTS };
}
```
This is a safety-wrapper / fallback pattern inside the element factory. The factory checks whether `_modelParams` is absent or matches a specific DIODE_DEFAULTS IS value (`1e-14`) and overwrites it with SCHOTTKY_DEFAULTS. This heuristic (`IS === 1e-14`) is a backwards-compatibility shim: it patches around the compiler's injection rather than trusting the compiler's output. The logic also bypasses the `_spiceModelOverrides` mechanism introduced in this wave — if a user sets a Schottky-specific override, this block will still overwrite it when the compiler injected "default D params". The companion comment explicitly describes the fallback intent. This file was modified in P1.5, making this a current-wave finding.

**Severity: major**

---

### V3 — Minor

**File:** `src/solver/analog/compiler.ts:1631-1632`
**Rule:** rules.md — "No historical-provenance comments … Comments exist ONLY to explain complicated code to future developers."
**Evidence:**
```
// Inject resolved model params into the PropertyBag directly rather
// than spreading (spreading PropertyBag loses _map contents).
```
This comment describes an implementation detail about how PropertyBag works when spread, which is legitimate explanatory content. However it also implicitly references that "spreading" was a prior approach that was abandoned ("directly rather than spreading"). This is on the border between allowed (explaining non-obvious technical behavior) and banned (describing what changed). Reported for human judgement.

**Severity: minor**

---

### V4 — Minor

**File:** `src/components/semiconductors/schottky.ts:49`
**Rule:** rules.md — "No historical-provenance comments"
**Evidence:**
```
// No user model or default D model — inject Schottky defaults
```
This inline comment explicitly describes the fallback condition in terms of what model was or wasn't provided by an external caller — it describes the caller's expected behaviour, not the code at that line. Together with V2 above, it documents a safety wrapper in terms of its intent rather than explaining non-obvious algorithm logic.

**Severity: minor**

---

## Gaps

### G1 — Task P1.4 not recorded in progress.md

**Spec requirement:** `spec/progress.md` is the source of truth for file lists. The progress file must record a completed task entry for P1.4 (Compiler merge with `_spiceModelOverrides` at both sites) including files modified.

**What was found:** The progress.md Wave 2 task table shows `P1.4` with status `pending`. There is no `## Task P1.4` section entry with status, agent, files created, files modified, or test counts. The wave completion report provided to the reviewer claims P1.4 is complete, and the code at compiler.ts:1633-1647 and 2336-2350 confirms the merge was implemented. The discrepancy means the progress file was not updated for P1.4.

**File:** `spec/progress.md` — P1.4 row shows status `pending`, no task detail section exists.

---

### G2 — Schottky factory bypasses `_spiceModelOverrides` merge

**Spec requirement (Part 1 — Compiler Merge):** The spec states that `_spiceModelOverrides` are applied at the two compiler sites that inject `_modelParams`. The intent is that all override logic lives in the compiler. The spec acceptance criterion states "Recompiling applies the override — `_modelParams.IS` equals `1e-14`".

**What was found:** `createSchottkyElement` in `schottky.ts` re-overwrites `_modelParams` after the compiler has injected it (including any user overrides), whenever `modelParams["IS"] === 1e-14`. For a Schottky diode where the user has set `_spiceModelOverrides: {"IS": 1e-14}`, the factory would overwrite the compiler's merged result with `SCHOTTKY_DEFAULTS`, discarding the override. The override mechanism specified in the spec does not function for the Schottky diode.

**File:** `src/components/semiconductors/schottky.ts:45-51`

---

## Weak Tests

### WT1

**Test:** `src/editor/__tests__/property-panel-spice.test.ts::showSpiceModelParameters::populates input value from stored _spiceModelOverrides`
**Problem:** The assertion `expect(isInput!.value).not.toBe("")` is a weak negative assertion. It verifies only that the IS input is not blank, not that it contains the correct representation of `1e-14`. The test stores `{ IS: 1e-14 }` and only confirms the field is non-empty — any non-empty string would pass.
**Evidence:**
```typescript
const element = makeElement({ _spiceModelOverrides: JSON.stringify({ IS: 1e-14 }) });
// ...
expect(isInput!.value).not.toBe("");
```

---

### WT2

**Test:** `src/editor/__tests__/property-panel-spice.test.ts::showSpiceModelParameters::sets placeholder to default value for each param`
**Problem:** `expect(inputs.some(i => i.placeholder !== "")).toBe(true)` only verifies that at least one input has a non-empty placeholder. It does not check that the IS parameter placeholder equals the expected SI-formatted value of the NPN default (`1e-16`), nor that all 26 placeholders are populated. A single non-empty placeholder would pass this test.
**Evidence:**
```typescript
expect(inputs.some(i => i.placeholder !== "")).toBe(true);
```

---

### WT3

**Test:** `src/editor/__tests__/property-panel-spice.test.ts::showSpiceModelParameters::commits override to _spiceModelOverrides on blur`
**Problem:** `expect(stored["IS"]).toBeCloseTo(1e-14, 20)` uses `toBeCloseTo` with a precision of 20 decimal places. `toBeCloseTo` in vitest/jest uses decimal places to compute the tolerance as `10^(-precision) / 2`. With precision 20 this is `5e-21`, which for the value `1e-14` is a relative tolerance of `5e-7`. This is not exact equality. The rules require "exact values, exact types, exact error messages where applicable". Since the value passes through `parseSI` (an SI parser) and is stored as a number, the test should use `toBe(1e-14)` or at minimum document why floating-point tolerance is needed. The current precision choice appears designed to make the test pass regardless of minor parsing variation.
**Evidence:**
```typescript
expect(stored["IS"]).toBeCloseTo(1e-14, 20);
```

---

### WT4

**Test:** `src/components/semiconductors/__tests__/spice-model-overrides-prop.test.ts` — all 5 per-component test groups for SCR, DIAC, and TRIAC
**Problem:** The test validates that SCR, DIAC, and TRIAC have `_spiceModelOverrides` PropertyDefs. However, SCR, DIAC, and TRIAC do not have a `deviceType` in their analog model (they are custom behavioral models, not standard SPICE device types). There is no corresponding `getParamMeta` entry for them. Having a `_spiceModelOverrides` PropertyDef on components that will never show the SPICE panel and never trigger the compiler merge branch is dead configuration. The tests verify structural shape (`hidden: true`, `type: STRING`, `defaultValue: ""`) but do not verify that the propertyDef is actually wired to any behaviour. This is not so much a bad assertion as testing configuration that has no functional effect — the tests pass trivially because they check the def's static shape, which is always set correctly.
**Evidence:**
```typescript
// ScrDefinition, DiacDefinition, TriacDefinition are included in SEMICONDUCTOR_DEFS
// but their analog models have no deviceType — the panel will never render for them
// and the compiler merge will never fire for them.
```

---

## Legacy References

None found.
