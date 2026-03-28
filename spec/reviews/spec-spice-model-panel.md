# Review Report: SPICE Model Parameters Panel & Test Parameter Alignment

## Summary

| Item | Count |
|------|-------|
| Tasks reviewed | 13 (P0.1–P0.4, P1.1–P1.5, P2.1, P3.1–P3.3) |
| Violations — critical | 4 |
| Violations — major | 2 |
| Violations — minor | 1 |
| Gaps | 3 |
| Weak tests | 2 |
| Legacy references | 0 |

**Verdict: has-violations**

---

## Violations

### V-1 (Critical) — `INVALID_SPICE_OVERRIDES` missing from `SolverDiagnosticCode` union

**File**: `src/solver/analog/compiler.ts`, lines 1641 and 2344
**Rule**: Type correctness — production code must not push diagnostics with a `code` that is not a member of the `SolverDiagnosticCode` union.

The compiler pushes a diagnostic with `code: "INVALID_SPICE_OVERRIDES"` at two sites:

```typescript
diagnostics.push({
  code: "INVALID_SPICE_OVERRIDES",
  severity: "warning",
  message: `Malformed _spiceModelOverrides JSON on component "${label}"`,
});
```

The `diagnostics` array is typed `SolverDiagnostic[]`. `SolverDiagnostic.code` is typed as `SolverDiagnosticCode`. The `SolverDiagnosticCode` union in `src/core/analog-types.ts` (lines 161–203) does not include `"INVALID_SPICE_OVERRIDES"`. This is a TypeScript compile error: the string literal `"INVALID_SPICE_OVERRIDES"` is not assignable to `SolverDiagnosticCode`.

---

### V-2 (Critical) — Pushed diagnostic object missing required fields and uses a nonexistent field

**File**: `src/solver/analog/compiler.ts`, lines 1640–1644 and 2343–2347
**Rule**: Type correctness — all required fields of a typed interface must be supplied.

The `SolverDiagnostic` interface (defined in `src/core/analog-types.ts` lines 234–253) requires these non-optional fields:
- `code: SolverDiagnosticCode`
- `severity: "info" | "warning" | "error"`
- `summary: string`
- `explanation: string`
- `suggestions: DiagnosticSuggestion[]`

The pushed objects supply only `code`, `severity`, and `message`. The fields `summary`, `explanation`, and `suggestions` are all absent. The field `message` does not exist on `SolverDiagnostic` at all — the interface uses `summary` for the one-line human-readable text. Both compiler sites carry this identical violation.

---

### V-3 (Critical) — Test asserts `warning!.message` which does not exist on `SolverDiagnostic`

**File**: `src/solver/analog/__tests__/spice-model-overrides.test.ts`, line 225
**Rule**: Rules.md — "Test the specific: exact values, exact types, exact error messages where applicable." Tests must not assert against nonexistent fields.

```typescript
expect(warning!.message).toContain("q1");
```

`SolverDiagnostic` has no `message` field. This expression evaluates to `undefined`, so the assertion `expect(undefined).toContain("q1")` either throws or passes vacuously. The test was reported as 7/7 passing, which means the assertion is not verifying the diagnostic message. The correct field is `summary` (which carries the one-line message text). This test provides zero coverage of the "message contains component label" behaviour it purports to test.

---

### V-4 (Critical) — P0.2 task detail entry absent from `spec/progress.md`

**File**: `spec/progress.md`
**Rule**: Rules.md — "write detailed progress to spec/progress.md so the next agent can continue from exactly where you stopped. Do not summarize — be specific."

The wave 1 table marks P0.2 ("Add TUNNEL to DeviceType union") as `done`, but there is no detailed task entry for P0.2 anywhere in the progress file. Entries exist for P0.1, P0.3, P0.4, P1.1, P1.2, P1.3, P1.5, P2.1, P3.1, and P3.2 — P0.2 is the only task with no detail record. A reviewer or subsequent agent cannot know from the progress file which file was modified, what the exact change was, or what tests verified it.

---

### V-5 (Major) — Backwards-compatibility fallback shims retained in `tunnel-diode.ts` factory

**File**: `src/components/semiconductors/tunnel-diode.ts`, lines 125–130
**Rule**: Rules.md — "No fallbacks. No backwards compatibility shims. No safety wrappers." and "All replaced or edited code is removed entirely. Scorched earth."

After migration to `_modelParams`, the factory still contains `?? defaultValue` fallbacks:

```typescript
const ip = modelParams?.IP ?? 5e-3;
const vp = modelParams?.VP ?? 0.08;
const iv = modelParams?.IV ?? 0.5e-3;
const vv = modelParams?.VV ?? 0.5;
const iS = modelParams?.IS ?? 1e-14;
const nCoeff = modelParams?.N ?? 1;
```

These are shims for the old property-bag-direct-read path that was supposed to be removed. If the compiler fails to inject `_modelParams` (regression), the factory silently uses hardcoded fallbacks. This masks compiler bugs. The scorched-earth rule requires removing the fallbacks and letting the factory fail loudly if `_modelParams` is absent.

The module-level constant `IS_THERMAL = 1e-14` (line 51) is also a remnant: after migration it only exists to provide the fallback value. It is dead once the fallbacks are removed.

---

### V-6 (Major) — P3.3 progress entry absent from `spec/progress.md`

**File**: `spec/progress.md`
**Rule**: Rules.md — same as V-4: every completed task must have a detailed entry.

The wave 4 table marks P3.3 ("E2E tests (spice-model-panel.spec.ts)") as `done`, but there is no detailed task entry for P3.3 in the progress file. The file ends at the P3.2 entry. Files created (`e2e/gui/spice-model-panel.spec.ts`), files modified (presumably `e2e/fixtures/ui-circuit-builder.ts` which received `setSpiceOverrides`), and test counts are all unrecorded.

---

### V-7 (Minor) — Historical-context comment in `tunnel-diode.ts`

**File**: `src/components/semiconductors/tunnel-diode.ts`, line 51
**Rule**: Rules.md — "No historical-provenance comments."

```typescript
/** Standard diode saturation current for thermal component. */
const IS_THERMAL = 1e-14;
```

After migration this constant's only purpose is to back the `?? 1e-14` fallback shim. Its JSDoc describes it as a legitimate design constant. A reader cannot distinguish it from a deliberate design choice vs. a pre-migration remnant. Together with the fallbacks in lines 125–130, this comment describes what the code used to do (read directly from a constant) rather than what it now does (read from `_modelParams`).

---

## Gaps

### G-1 — `INVALID_SPICE_OVERRIDES` not added to `SolverDiagnosticCode` union

**Spec requirement**: Part 1 Compiler Merge — the warning code `INVALID_SPICE_OVERRIDES` must be emittable as a valid `SolverDiagnostic`. The code appears in the spec as the `code` field of the diagnostic object. For any consumer that types diagnostics as `SolverDiagnostic[]` to use `d.code === "INVALID_SPICE_OVERRIDES"`, the literal must be in the union.
**What was found**: `SolverDiagnosticCode` in `src/core/analog-types.ts` does not include `"INVALID_SPICE_OVERRIDES"`. The union is exhaustive and the new code was not added to it.
**File**: `src/core/analog-types.ts`

---

### G-2 — P3.3 detailed progress entry missing entirely

**Spec requirement**: `spec/progress.md` must record all completed tasks with files created, files modified, and test counts.
**What was found**: No detailed P3.3 entry exists. The E2E test file `e2e/gui/spice-model-panel.spec.ts` was created, and `e2e/fixtures/ui-circuit-builder.ts` was modified to add `setSpiceOverrides`, but neither is recorded. Test count for P3.3 is unrecorded.
**File**: `spec/progress.md`

---

### G-3 — Part 2 injection via `setComponentProperty` not implemented as specified

**Spec requirement**: Part 2 "Injection Pattern" — "For each test, add `setComponentProperty` calls after component placement, before compilation." The spec defines `BJT_NPN_OVERRIDES = JSON.stringify({ IS: 1e-14, BF: 100, VAF: 100 })` as a string, and the call pattern as `await builder.setComponentProperty('Q1', '_spiceModelOverrides', BJT_NPN_OVERRIDES)`.
**What was found**: `BJT_NPN_OVERRIDES` and siblings are defined as `Record<string, number>` objects (not JSON strings). Injection is done via `await builder.setSpiceOverrides('Q1', BJT_NPN_OVERRIDES)` — a UI-path method that drives the property popup — not via `setComponentProperty`. The `setSpiceOverrides` method is not mentioned in the spec and was added to `UICircuitBuilder` as scope creep. The spec's `setComponentProperty` path directly writes to the element's PropertyBag without any UI dependency; the `setSpiceOverrides` path depends on the SPICE panel being visible and functional, adding implicit UI dependency to Part 2 tests.
**File**: `e2e/gui/analog-circuit-assembly.spec.ts`

---

## Weak Tests

### W-1 — Assertion on nonexistent `message` field is vacuously passing

**Test**: `src/solver/analog/__tests__/spice-model-overrides.test.ts::spice-model-overrides compiler merge::malformed_json: emits INVALID_SPICE_OVERRIDES warning and falls back to defaults`

```typescript
expect(warning!.message).toContain("q1");
```

`SolverDiagnostic` has no `message` field. `warning!.message` is `undefined`. The assertion `expect(undefined).toContain("q1")` is either throwing and being caught silently, or Vitest's `toContain` matcher accepts `undefined` as a false-pass. The test was reported as passing (7/7), confirming the assertion does not actually verify the component label appears in any diagnostic field. The test should assert `warning!.summary` (or `warning!.detail`) contains `"q1"`.

---

### W-2 — MCP "voltages differ" assertion does not test the override specifically

**Test**: `src/headless/__tests__/spice-model-overrides-mcp.test.ts::spice-model-overrides MCP surface — override via patch::patch with _spiceModelOverrides changes DC operating point vs default`

```typescript
let anyDiffers = false;
for (let i = 0; i < voltagesDefault.length; i++) {
  if (Math.abs(voltagesOverridden[i]! - voltagesDefault[i]!) > 1e-6) {
    anyDiffers = true;
    break;
  }
}
expect(anyDiffers).toBe(true);
```

This test builds two different circuits (Vb=0.7V in the baseline, Vb=2V in the overridden circuit) and checks that any voltage differs. The circuits differ in their base bias voltage — they would produce different voltages regardless of whether the SPICE override has any effect. The assertion does not isolate the override as the cause of the difference. A correct test would compile the same circuit with and without the override and compare specific node voltages.

---

## Legacy References

None found.

---

## Notes on Positive Findings (Non-Blocking)

- `TUNNEL_DIODE_DEFAULTS` in `model-defaults.ts` correctly matches the spec's 6-parameter definition (IP, VP, IV, VV, IS, N).
- `TUNNEL` is correctly added to the `DeviceType` union in `analog-types.ts` (P0.2 verified from source).
- `TUNNEL` is correctly registered in `model-library.ts` with `__default_TUNNEL` and `KNOWN_PARAMS` entries.
- `model-param-meta.ts` is complete and matches all spec-specified param counts (D=14, NPN=26, PNP=26, NMOS=25, PMOS=25, NJFET=12, PJFET=12, TUNNEL=6).
- Both compiler merge sites (lines 1633 and 2336) are structurally present and perform `{ ...resolvedModel.params, ...overrides }` merge correctly (modulo type violations noted above).
- `showSpiceModelParameters()` in `property-panel.ts` follows the Pin Electrical panel pattern as specified: collapsible toggle, `parseSI`/`formatSI`, placeholder shows default, clearing deletes key, blur/Enter commits.
- Canvas-popup visibility guard at lines 84–95 correctly implements the mutual-exclusion logic: `logical`/`analog-pins` → Pin Electrical; `analog` with `deviceType` → SPICE panel.
- `_spiceModelOverrides` PropertyDef is present and `hidden: true` on all checked semiconductor components (bjt, diode, tunnel-diode).
- All 13 E2E test injections for Part 2 are present and cover the full table from the spec.
- P3.3 E2E test file `spice-model-panel.spec.ts` covers all 5 specified test scenarios with appropriate Playwright assertions.
- `model-param-meta.test.ts` provides thorough coverage of `getParamMeta` including param counts, key coverage, unit correctness, and immutability.
