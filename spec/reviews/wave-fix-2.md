# Review Report: Wave FIX.2 — API + Rendering fixes

## Summary

| Field | Value |
|-------|-------|
| Tasks reviewed | 4 (A1, A3, R1, R2) |
| Violations — critical | 0 |
| Violations — major | 2 |
| Violations — minor | 3 |
| Gaps | 2 |
| Weak tests | 4 |
| Legacy references | 0 |
| Verdict | has-violations |

---

## Violations

### V1 — MAJOR: Duplicate A3 progress entry (second agent found nothing to do)

- **File**: `spec/progress.md`, lines 1285–1290
- **Rule violated**: Code Hygiene — the second A3 entry is a no-op duplicate that contradicts the first. One agent claimed to do work (deleted `locale-loader.ts`, modified `index.ts`); a second agent ran the same task, found everything already done, and logged a duplicate completion entry with "Files modified: none". A false or redundant completion record in `progress.md` corrupts the source-of-truth file list used by all future reviewers and orchestrators.
- **Evidence** (lines 1285–1290):
  ```
  ## Task A3: `locale-loader.ts` feature flag pattern — eliminate
  - **Status**: complete
  - **Agent**: implementer
  - **Files created**: none
  - **Files modified**: none
  - **Tests**: N/A — pre-existing condition. `src/i18n/locale-loader.ts` does not exist...
  ```
- **Severity**: major

---

### V2 — MAJOR: `draw-path-filled.test.ts` — `toBeGreaterThanOrEqual(1)` assertions on gate fill/stroke counts

- **File**: `src/editor/__tests__/draw-path-filled.test.ts`, lines 231, 242, 263, 274
- **Rule violated**: Rules — "Test the specific: exact values, exact types." The rules explicitly require exact values. `toBeGreaterThanOrEqual(1)` is a weak assertion that would pass if a gate emitted 100 fill calls or 1 fill call.
- **Evidence**:
  - Line 231: `expect(filledCalls.length).toBeGreaterThanOrEqual(1);` (AND gate filled call count — a companion test at lines 289–299 fixes this with `toBe(2)`, but this earlier test remains weak and passes even with wrong counts)
  - Line 242: `expect(strokeCalls.length).toBeGreaterThanOrEqual(1);` (AND gate stroke count)
  - Line 263: `expect(filledCalls.length).toBeGreaterThanOrEqual(1);` (OR gate fill count — no exact-count companion test exists)
  - Line 274: `expect(filledCalls.length).toBeGreaterThanOrEqual(1);` (NOT gate fill count — companion at 277–287 fixes this for NOT, but line 274 remains weak)
- **Severity**: major

---

### V3 — MINOR: `zip.test.ts::createsZip` — `toBeInstanceOf(Blob)` without size check

- **File**: `src/export/__tests__/zip.test.ts`, lines 49–50
- **Rule violated**: Tests must assert desired behaviour. `expect(blob).toBeInstanceOf(Blob)` does not verify the blob is non-empty. A zero-byte blob of type `application/zip` would pass. No `expect(blob.size).toBeGreaterThan(0)` assertion is present.
- **Evidence** (lines 47–51):
  ```typescript
  const blob = await exportZip(circuit, subcircuits, dataFiles);
  expect(blob).toBeInstanceOf(Blob);
  expect(blob.type).toBe("application/zip");
  ```
- **Severity**: minor (the MIME type check provides partial coverage; size is the missing piece)

---

### V4 — MINOR: `i18n-full.test.ts` — `switchLocale` describe block tests no locale switch

- **File**: `src/i18n/__tests__/i18n-full.test.ts`, lines 149–172
- **Rule violated**: Tests must assert desired behaviour. The `switchLocale` describe block never actually switches to a different locale. All three tests call `setLocale('en')` while already in locale `'en'` (set by `beforeEach`). The test named "should switch to a different locale" would pass even if `setLocale` were a no-op for the current locale.
- **Evidence** (lines 150–156):
  ```typescript
  it('should switch to a different locale', async () => {
    expect(getLocale()).toBe('en');
    await setLocale('en');
    expect(getLocale()).toBe('en');
  });
  ```
- **Severity**: minor

---

### V5 — MINOR: `i18n-full.test.ts` — `fallbackToEnglish` tests do not exercise a non-English locale

- **File**: `src/i18n/__tests__/i18n-full.test.ts`, lines 66–76
- **Rule violated**: Tests must assert desired behaviour. The `fallbackToEnglish` describe block contains two tests that remain in locale `'en'` throughout. The test "should use English as fallback when current locale is not en" never sets a non-English locale before calling `i18n()` — it tests nothing about fallback behaviour.
- **Evidence** (lines 72–75):
  ```typescript
  it('should use English as fallback when current locale is not en', async () => {
    const result = i18n('menu.file.open');
    expect(result).toBe('Open');
  });
  ```
- **Severity**: minor

---

## Gaps

### G1 — OR gate has no exact-count drawPath test

- **Spec requirement**: `fix-spec.md` R1 requires the fill/stroke two-pass pattern to be applied to all IEEE gate shapes. The test file covers AND and NOT with exact-count companion tests (AND at lines 289–299: `expect(pathCalls.length).toBe(2)` with index checks; NOT at lines 277–287: `expect(pathCalls.length).toBe(2)` with index checks). OR has no equivalent.
- **What was found**: OR gate test at lines 255–264 only checks `filledCalls.length >= 1`. No companion test verifying the exact call count is 2 or that the first call has `filled=true` and the second has `filled=false`.
- **File**: `src/editor/__tests__/draw-path-filled.test.ts`

---

### G2 — NAND, NOR, XOR, XNOR gates have no test coverage in `draw-path-filled.test.ts`

- **Spec requirement**: `fix-spec.md` R1 lists all seven IEEE gate files as affected: `and.ts`, `or.ts`, `nand.ts`, `nor.ts`, `xor.ts`, `xnor.ts`, `not.ts`. The fix was applied to all seven gate files (confirmed by source review — all seven have the two-pass `drawPath(path, true)` / `drawPath(path, false)` pattern). However the test file only covers AND, OR, and NOT.
- **What was found**: `draw-path-filled.test.ts` describes coverage as "(AND, OR, NOT)" in lines 1–13 but the `describe("IEEE gate shapes emit filled drawPath calls")` block has no test cases for NAND, NOR, XOR, or XNOR IEEE shapes. Four of seven affected gate types are untested.
- **File**: `src/editor/__tests__/draw-path-filled.test.ts`

---

## Weak Tests

### WT1 — `zip.test.ts::exportZip::createsZip` — bare `toBeInstanceOf(Blob)` without size check

- **Path**: `src/export/__tests__/zip.test.ts::exportZip::createsZip`
- **Problem**: `expect(blob).toBeInstanceOf(Blob)` does not verify the blob has non-zero size. A zero-byte or malformed ZIP with the correct MIME type would pass.
- **Evidence** (line 49): `expect(blob).toBeInstanceOf(Blob);`

---

### WT2 — `i18n-full.test.ts::switchLocale::should switch to a different locale` — no actual locale switch

- **Path**: `src/i18n/__tests__/i18n-full.test.ts::i18n Full Implementation::switchLocale::should switch to a different locale`
- **Problem**: Calls `setLocale('en')` while already in `'en'`. Both before and after assertions check `getLocale() === 'en'`. This passes even if `setLocale` is a no-op when the locale is unchanged.
- **Evidence** (lines 150–156):
  ```typescript
  it('should switch to a different locale', async () => {
    expect(getLocale()).toBe('en');
    await setLocale('en');
    expect(getLocale()).toBe('en');
  });
  ```

---

### WT3 — `i18n-full.test.ts::fallbackToEnglish::should use English as fallback when current locale is not en` — tests no non-English locale

- **Path**: `src/i18n/__tests__/i18n-full.test.ts::i18n Full Implementation::fallbackToEnglish::should use English as fallback when current locale is not en`
- **Problem**: Despite the name promising a non-English-locale test, `getLocale()` is `'en'` throughout. No `setLocale('de')` or equivalent call is made. The assertion passes trivially.
- **Evidence** (lines 72–75):
  ```typescript
  it('should use English as fallback when current locale is not en', async () => {
    const result = i18n('menu.file.open');
    expect(result).toBe('Open');
  });
  ```

---

### WT4 — `draw-path-filled.test.ts::AND gate IEEE shape emits at least one drawPath with filled=true` — `>=1` is weaker than the companion exact-count test

- **Path**: `src/editor/__tests__/draw-path-filled.test.ts::IEEE gate shapes emit filled drawPath calls::AND gate IEEE shape emits at least one drawPath with filled=true`
- **Problem**: Uses `expect(filledCalls.length).toBeGreaterThanOrEqual(1)`. A companion test at lines 289–299 already verifies exact count `toBe(2)` with index assertions. The `>=1` assertion is therefore a weak duplicate of a stronger test and adds no safety net that the stronger test does not provide.
- **Evidence** (lines 230–232):
  ```typescript
  const filledCalls = pathCalls.filter((c) => c.filled === true);
  expect(filledCalls.length).toBeGreaterThanOrEqual(1);
  ```

---

## Legacy References

None found.

---

## Notes

**A3 implementation result is correct**: Despite the duplicate progress entry, the implementation state is clean. `src/i18n/locale-loader.ts` does not exist. `src/i18n/index.ts` uses a single Vite dynamic `import()` code path with no `registerLocaleModule`, no mutable `localeModules` registry, and no feature-flag pattern. The duplicate entry is a process artifact, not an implementation defect.

**R2 translate removal verified**: Grep across all `src/components/**/*.ts` for `ctx.translate(` returns zero matches. The `element-renderer.ts` pre-translate at line 62 is present and correct. The `text-rectangle.test.ts` file was updated to assert that `draw()` does NOT translate to component position (line 138–148), which is the correct post-R2 assertion.

**A1 callers verified**: No remaining callers of `exportZip` with the old `(mainCircuitXml: string, mainFileName: string, ...)` signature were found. The updated signature `(circuit: Circuit, subcircuits, dataFiles?)` is consistently used.

**XOR third `drawPath` call**: `xor.ts` lines 220–233 make a third `drawPath(path, false)` for the extra back-curve that visually distinguishes XOR from OR. This is stroke-only with no fill partner, which is correct. The `>=1` fill assertion for OR is therefore inappropriate for XOR but OR correctly emits exactly 2 paths and lacks an exact-count test (captured in G1).
