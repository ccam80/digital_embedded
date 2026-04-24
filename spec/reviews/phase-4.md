# Review Report: Phase 4 — F5 Residual Limiting Primitives

## Summary

- **Tasks reviewed**: 5 (4.1.1, 4.1.2, 4.1.3, 4.2.1, 4.2.2)
- **Violations**: 3 (0 critical, 0 major, 3 minor)
- **Gaps**: 0
- **Weak tests**: 2
- **Legacy references**: 1
- **Verdict**: has-violations

---

## Violations

### V-001 — Minor

- **File**: `src/solver/analog/__tests__/newton-raphson-limiting.test.ts`, line 29
- **Rule violated**: Code Hygiene — Historical-provenance comments ban (rules.md §Code Hygiene: "Comments exist ONLY to explain complicated code to future developers. They never describe what was changed, what was removed, or historical behaviour.")
- **Quoted evidence**:
  ```
  // spice3f5 legacy formula at (vold=1.0, vto=1.5):
  //   vtsthi = |2*(1 - 1.5)| + 2 = 1 + 2 = 3
  //   vtstlo_spice3f = vtsthi/2 + 2 = 3.5
  // Gillespie formula: |1 - 1.5| + 1 = 1.5
  // Explicit guard against accidental revert.
  ```
- **Analysis**: The comment describes historical behaviour (the old spice3f5 formula) and what was replaced. It is a historical-provenance comment. Rules.md is unambiguous: such comments are banned. The test's behaviour (asserting `_computeVtstlo(1.0, 1.5) !== 3.5`) is the guard; the comment expounding the old formula is unnecessary history. The code the comment decorates is `expect(_computeVtstlo(1.0, 1.5)).not.toBe(3.5)` — the assertion itself is live and meaningful, so only the comment requires deletion, not the assertion. Severity is minor because the assertion is correct and the code path is not dead.

### V-002 — Minor

- **File**: `src/solver/analog/newton-raphson.ts`, lines 18–21
- **Rule violated**: Code Hygiene — Historical-provenance comments ban (rules.md §Code Hygiene)
- **Quoted evidence**:
  ```
  // Self-namespace import: lets intra-module calls (e.g. `fetlim` → `_computeVtstlo`)
  // route through the exports object rather than the lexical binding, so that
  // `vi.spyOn(NewtonRaphsonModule, "_computeVtstlo")` can intercept the call
  // from test code and guard against future inline re-expansion of the helper.
  ```
- **Analysis**: This comment explains an architecture/testability rationale (why `import * as self` is needed for spy interception), not historical behaviour. It does not use any banned words. This is arguably a legitimate "explains complicated code" comment for a non-obvious ES module pattern. However, it does explain the test hook rationale ("from test code") rather than purely the module mechanics. Borderline — reported for reviewer discretion.

### V-003 — Minor

- **File**: `src/components/io/led.ts`, lines 269–270
- **Rule violated**: TypeScript type safety — `(this as any)` casts suppress type checking without documented interface contract
- **Quoted evidence**:
  ```ts
  elementIndex: (this as any).elementIndex ?? -1,
  label: (this as any).label ?? "",
  ```
- **Analysis**: The `as any` casts are used to access `elementIndex` and `label` fields that are not declared on the LED element type. The same pattern is used in `bjt.ts` (pre-existing, not introduced in Phase 4), but the LED implementation introduces it in Phase 4 code. The `?? -1` and `?? ""` fallbacks suggest the fields may not be present on all element instances, which is a structural concern. The spec says to model this "verbatim on the diode pattern" — diode uses the same pattern, so this is spec-compliant. Reported for awareness; the spec explicitly mandated this pattern.

---

## Gaps

None found. All five tasks implemented their required deliverables:

- **4.1.1**: `_computeVtstlo` exported helper created with `Math.abs(vold - vto) + 1`; `fetlim` routes via `self._computeVtstlo`; `cite: devsup.c:101-102` present; all four spec-mandated test cases implemented with exact equality.
- **4.1.2**: `limvds` docstring updated to `devsup.c:17-40`; all six spec-mandated test cases implemented.
- **4.1.3**: Both pnjlim citations updated from old forms to `devsup.c:49-84`; grep confirms zero hits for old forms, two hits for new form.
- **4.2.1**: `ctx.limitingCollector`-gated push block added to `led.ts` after `s0[base + SLOT_VD] = vdLimited;`; all four spec-mandated tests implemented.
- **4.2.2**: L1 substrate pnjlim audit verified pass (all five argument/gate conditions met); L0 scope comment citing `architectural-alignment.md §E1` inserted immediately after `icheckLimited = vbeLimFlag || vbcLimFlag;`; comment-presence test (`bjt-l0-scope-comment.test.ts`) implemented.

---

## Weak Tests

### WT-001

- **Test path**: `src/components/io/__tests__/led.test.ts::describe("LED limitingCollector")::it("does not push when ctx.limitingCollector is null")`
- **What is wrong**: The test asserts only `not.toThrow()` — it has no positive assertion. It verifies absence of an exception but does not verify that `collector` was not mutated (trivially impossible since `collector` is not provided, but a future code change that reads from null before the guard would be caught only by the throw, not by any state assertion).
- **Quoted evidence**:
  ```ts
  expect(() => element.load(ctx)).not.toThrow();
  ```
- **Analysis**: The spec explicitly called this test the "does not push" guard, verified "by not throwing." The implementation faithfully follows the spec wording, so this may be a spec-level weak test rather than an implementation-level weakness. Reported as weak because the only assertion is the absence of a throw, with no positive verification that no push occurred.

### WT-002

- **Test path**: `src/components/io/__tests__/led.test.ts::describe("AnalogLED")::it("red_led_forward_drop")` and `it("blue_led_forward_drop")`
- **What is wrong**: These tests (pre-existing, not introduced in Phase 4) use `toBeGreaterThan`/`toBeLessThan` range assertions for the forward voltage (`1.65 < vf < 1.95`, `3.05 < vf < 3.35`). These are not Phase 4 introductions — noted here only for completeness as they appear in a modified file.
- **Quoted evidence**:
  ```ts
  expect(vf).toBeGreaterThan(1.65);
  expect(vf).toBeLessThan(1.95);
  ```
- **Analysis**: Pre-existing; not introduced by Phase 4. The Phase 4 changes do not modify these test cases. Reported in full report per instructions but should not block Phase 4.

---

## Legacy References

### LR-001

- **File**: `src/solver/analog/__tests__/newton-raphson-limiting.test.ts`, line 29
- **Quoted evidence**: `// spice3f5 legacy formula at (vold=1.0, vto=1.5):`
- **Analysis**: The word "legacy" appears in a test comment introduced by Phase 4 Task 4.1.1. Per rules.md §Code Hygiene, the comment is a historical-provenance reference. The code it decorates (the `not.toBe(3.5)` assertion) is live, but the comment describes the old formula that was replaced. This is the same finding as V-001 — listed here because it is a searchable legacy-word hit.

---

## Additional Observations (non-violation)

1. **`self` import pattern correctness**: The `import * as self from "./newton-raphson.js"` at line 22 is a legitimate ES module testability pattern required by the spec (Task 4.1.1 mandates `vi.spyOn` interception). The comment (V-002) is borderline; the import itself is correct.

2. **Pre-existing failures**: The progress.md correctly documents pre-existing test failures not caused by Phase 4 changes (e.g., `junction_cap_transient_matches_ngspice` crashing at `led.ts:255` due to a stale `voltages:` key in an old test fixture; three BJT tests crashing at `bjt.ts:850:32`). These are not Phase 4 regressions.

3. **Spec amendment in-place**: Task 4.2.2 involved correcting the phase spec file on disk (`spec/phase-4-f5-residual-limiting-primitives.md`) with a dated editorial note. The correction is accurate (removing stale `MODEINITPRED` from the L1 pnjlim skip mask), and the spec now matches the ngspice-aligned implementation. The current `bjt.ts:1325` gate `(mode & (MODEINITJCT | MODEINITSMSIG | MODEINITTRAN)) === 0` is correct.

4. **All acceptance criteria met**:
   - `grep "vtstlo = vtsthi" newton-raphson.ts` → 0 hits (confirmed)
   - `grep "Math.abs(vold - vto) + 1" newton-raphson.ts` → 1 hit inside `_computeVtstlo` (confirmed)
   - `grep "devsup.c:101-102" newton-raphson.ts` → comment present (confirmed)
   - `grep "devsup.c:17-40" newton-raphson.ts` → present in limvds docstring (confirmed)
   - `grep "devsup.c:49-84" newton-raphson.ts` → 2 hits (confirmed); 0 hits for old forms (confirmed)
   - `grep "limitingCollector" led.ts` → present (confirmed)
   - L0 scope comment with `architectural-alignment.md §E1` → present at lines 875–878 (confirmed)

---

## Files Reviewed

### Created in Phase 4
- `src/solver/analog/__tests__/newton-raphson-limiting.test.ts`
- `src/components/semiconductors/__tests__/bjt-l0-scope-comment.test.ts`

### Modified in Phase 4
- `src/solver/analog/newton-raphson.ts`
- `src/components/io/led.ts`
- `src/components/io/__tests__/led.test.ts`
- `src/components/semiconductors/bjt.ts`
- `spec/phase-4-f5-residual-limiting-primitives.md` (spec correction — dated editorial note added)
