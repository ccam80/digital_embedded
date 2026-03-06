# Review Report: Phase 9 — Export & Application Features

## Summary

| Item | Count |
|------|-------|
| Tasks reviewed | 7 (9.1.1, 9.1.2, 9.1.3, 9.1.4, 9.2.1, 9.2.2, 9.3.1) |
| Violations — critical | 2 |
| Violations — major | 4 |
| Violations — minor | 3 |
| Gaps | 2 |
| Weak tests | 6 |
| Legacy references | 0 |

**Verdict: has-violations**

---

## Violations

### V-01 — Critical | Task 9.1.4 | `src/export/zip.ts`

**Rule violated**: Spec adherence — function signature diverges from specification without authorisation.

**Evidence** (lines 31–36):
```typescript
export function exportZip(
  mainCircuitXml: string,
  mainFileName: string,
  subcircuits: Map<string, string>,
  dataFiles?: Map<string, ArrayBuffer>,
): Promise<Blob>
```

The spec (phase-9-export-application.md, Task 9.1.4) mandates:
```
exportZip(circuit: Circuit, subcircuits: Map<string, string>, dataFiles?: Map<string, ArrayBuffer>): Promise<Blob>
```

The implementation replaces the `circuit: Circuit` parameter with two raw-string parameters (`mainCircuitXml: string, mainFileName: string`). The `Circuit` type has been discarded and the caller is expected to pre-serialize the circuit to XML and supply the filename — responsibilities that belong inside the function according to the spec. This is a breaking API contract deviation.

**Severity**: critical

---

### V-02 — Critical | Task 9.2.1 | `src/i18n/locale-loader.ts`

**Rule violated**: Code Hygiene — feature flag / environment-variable toggle for old/new behaviour. The `localeModules` map acts as a compile-time environment toggle that switches between "import" (test) mode and "fetch" (browser) mode based on whether a key is present.

**Evidence** (lines 11–14, 34–45):
```typescript
// Locale modules loaded dynamically for testing
const localeModules: Record<string, () => Promise<{ default: LocaleData }>> = {
  en: () => import('./locales/en.json'),
};
```
```typescript
    // Try to load via direct import first (for testing)
    if (localeModules[locale]) {
      const module = await localeModules[locale]();
      data = module.default;
    } else {
      // Fall back to fetch for runtime (browser)
      const response = await fetch(`/src/i18n/locales/${locale}.json`);
```

This is a runtime fork between two loading strategies gated by a mutable module-level registry. The comment "for testing" at line 34 and "for runtime (browser)" at line 39 are explicit historical-provenance comments explaining why the code uses one path vs another — a direct violation of the historical-provenance comment ban. The `registerLocaleModule` export at line 91 also exposes this toggle as a public API, compounding the violation.

**Severity**: critical

---

### V-03 — Major | Task 9.2.1 | `src/i18n/index.ts`

**Rule violated**: Code Hygiene — historical-provenance comment ("// Fallback: use English or empty map") at line 30.

**Evidence** (lines 29–32):
```typescript
  } catch (error) {
    // Fallback: use English or empty map
    console.warn(`Failed to load locale ${initialLocale}, using empty locale data`);
    localeData = {};
```

The comment "Fallback: use English or empty map" is a historical-provenance comment describing what the code does as a fallback strategy — the word "fallback" is explicitly listed in the banned comment category in rules.md. The comment exists to justify a shortcut (silently swallowing locale load errors with an empty map) and describes implementation decisions that belong in architecture documents, not in production code.

**Severity**: major

---

### V-04 — Major | Task 9.2.1 | `src/i18n/locale-loader.ts`

**Rule violated**: Code Hygiene — historical-provenance comment "// Fall back to fetch for runtime (browser)" at line 39.

**Evidence** (lines 38–40):
```typescript
    } else {
      // Fall back to fetch for runtime (browser)
      const response = await fetch(`/src/i18n/locales/${locale}.json`);
```

The word "fallback" in the comment labels this else-branch as a fallback path — a banned comment type per rules.md. The comment describes the conditional routing strategy rather than explaining complex logic.

**Severity**: major

---

### V-05 — Major | Task 9.1.4 | `src/export/__tests__/zip.test.ts`

**Rule violated**: Code Hygiene — historical-provenance comment containing "For now" at line 18.

**Evidence** (lines 16–20):
```typescript
/**
 * Helper to extract files from a ZIP Blob.
 * Uses the browser's DecompressionStream API (available in modern browsers and Node 18+).
 * For now, we use a basic approach: parse the ZIP format manually or use a library.
 *
 * Note: fflate is already a dependency. We can use it to unzip as well.
 */
```

"For now" is explicitly listed in rules.md as a banned comment word. This comment signals that the implementation is provisional and a better approach exists but was deferred — a clear shortcut-justification comment.

**Severity**: major

---

### V-06 — Major | Task 9.2.1 | `src/i18n/locale-loader.ts`

**Rule violated**: Code Hygiene — "// Locale modules loaded dynamically for testing" at line 11 is a historical-provenance comment that describes the purpose of the `localeModules` registry in terms of its test-environment origin, not in terms of what it does for future developers.

**Evidence** (lines 10–14):
```typescript

// Locale modules loaded dynamically for testing
const localeModules: Record<string, () => Promise<{ default: LocaleData }>> = {
  en: () => import('./locales/en.json'),
};
```

The comment "for testing" instructs the reader about a testing concern at module level in production code — a direct violation of the historical-provenance comment ban ("comments exist ONLY to explain complicated code to future developers").

**Severity**: major

---

### V-07 — Minor | Task 9.1.3 | `src/export/gif.ts`

**Rule violated**: Implementation completeness — spec specifies `gif.js` (Web Worker-based, ~50KB) or a modern lightweight alternative. The implementation uses `gifenc` (line 18: `import { GIFEncoder, quantize, applyPalette } from "gifenc"`). `gifenc` is an acceptable lightweight alternative, but the implementation contains the comment at line 203:

**Evidence** (lines 202–204):
```typescript
  // gifenc expects delay in milliseconds; it converts to GIF centiseconds internally.
  const delayMs = frameDelay;
```

This is a redundant comment — `delayMs = frameDelay` is a no-op alias assignment with a comment that describes the library's internal behaviour rather than explaining complex code. The comment would be unnecessary if the variable were named meaningfully or the value passed directly. It is borderline but the intent appears to be explaining why no conversion was applied, which verges on historical-provenance ("this replaced a centisecond calculation").

**Severity**: minor

---

### V-08 — Minor | Task 9.2.1 | `src/i18n/index.ts`

**Rule violated**: Code Hygiene — `console.warn` at line 31 and `console.error` at lines 115 and 156 in production module code. These are debugging artifacts that should not be in production code. Rules require no "safety wrappers" and no fallback with error suppression.

**Evidence** (line 31):
```typescript
    console.warn(`Failed to load locale ${initialLocale}, using empty locale data`);
```

(line 115):
```typescript
    console.error(`Failed to set locale to ${locale}:`, error);
```

(line 155):
```typescript
      console.error('Error in locale change callback:', error);
```

**Severity**: minor

---

### V-09 — Minor | Task 9.3.1 | `src/components/library-74xx.ts`

**Rule violated**: Implementation completeness — `register74xxLibrary` registers a stub factory (lines 190–193) that throws `Error` at runtime when called:

```typescript
factory: (_props: PropertyBag): SubcircuitElement => {
  throw new Error(
    `74xx component "${entry.name}" must be loaded from "${entry.file}" before placement.`,
  );
},
```

The spec acceptance criteria state "Representative ICs load and simulate correctly" and "74xx category appears in component palette". Registering components whose factory unconditionally throws means no 74xx component can actually be instantiated through the standard registry `factory` path. While `register74xxSubcircuit` provides a replacement path, the stub violates the completeness rule ("Never write `pass` or `raise NotImplementedError` in production code") — this `throw new Error(...)` in a factory is the TypeScript equivalent of `raise NotImplementedError`.

**Severity**: minor

---

## Gaps

### G-01 — Task 9.1.4 | Spec vs Implementation

**Spec requirement**: `exportZip(circuit: Circuit, subcircuits: Map<string, string>, dataFiles?: Map<string, ArrayBuffer>): Promise<Blob>`

The spec passes a `Circuit` object as the first parameter. The function is responsible for serialising the circuit to XML and determining the filename.

**What was found**: The implementation takes `(mainCircuitXml: string, mainFileName: string, subcircuits: Map<string, string>, dataFiles?: Map<string, ArrayBuffer>)`. The serialisation responsibility and filename decision have been pushed to callers. The `Circuit` type is never imported or used in `zip.ts`.

**File**: `src/export/zip.ts`, lines 31–36

---

### G-02 — Task 9.3.1 | Spec vs Implementation

**Spec requirement**: Spec states "All ~60 74xx .dig files bundled". The reference source is `ref/Digital/src/main/dig/74xx/`. The progress.md entry states "121 files copied from ref/Digital/src/main/dig/lib/DIL Chips/74xx/".

**What was found**: `lib/74xx/` contains 121 files. The spec says ~60, and references `ref/Digital/src/main/dig/74xx/` as the source. The implementation copied from a different subdirectory (`lib/DIL Chips/74xx/`) that contains significantly more files (121 vs ~60). The manifest (`LIBRARY_74XX` in `library-74xx.ts`) contains 121 entries. Whether the additional ~61 files are appropriate inclusions or scope creep cannot be determined without checking the reference directory, but the discrepancy between the spec's stated source path and the implementation's actual source path is a gap.

**File**: `src/components/library-74xx.ts`, `lib/74xx/`

---

## Weak Tests

### WT-01 — Task 9.2.1 | `src/i18n/__tests__/i18n-full.test.ts::fallbackToEnglish::should fall back to English when key missing in current locale`

**Problem**: The `fallbackToEnglish` describe block is supposed to test that switching to a locale that lacks a key falls back to English. Both tests in this block actually keep or switch to English locale and verify English strings — they never exercise a non-English locale. The test does not verify the fallback behaviour at all.

**Evidence** (lines 74–88):
```typescript
it('should fall back to English when key missing in current locale', async () => {
  // First load a German locale (simulated with partial data)
  // For this test, we'll use a spy on the locale data
  await setLocale('en');           // <-- still English

  // Verify English has the key
  expect(i18n('menu.file.open')).toBe('Open');
});

it('should use English as fallback when current locale is not en', async () => {
  // Set to a non-existent locale that won't have all keys
  const result = i18n('menu.file.open');  // <-- locale never changed
  expect(result).toBe('Open');
});
```

The spec requires: `fallbackToEnglish — switch to German, key missing in German → falls back to English string`. Neither test switches to German or any non-English locale.

---

### WT-02 — Task 9.2.1 | `src/i18n/__tests__/i18n-full.test.ts::switchLocale::should switch to a different locale`

**Problem**: The test is supposed to verify that `setLocale` switches to a different locale (the spec requires `switchLocale — set locale to German, verify German strings returned`). The test only ever switches to English and checks it stays English — it never actually switches locales.

**Evidence** (lines 164–170):
```typescript
it('should switch to a different locale', async () => {
  expect(getLocale()).toBe('en');
  await setLocale('en');           // <-- same locale
  expect(getLocale()).toBe('en');
});
```

The spec test `switchLocale` requires setting locale to German and verifying German strings are returned. This test provides no such coverage.

---

### WT-03 — Task 9.2.1 | `src/i18n/__tests__/i18n-full.test.ts::switchLocale::should return English strings after switching locale`

**Problem**: After switching locale (to 'en', same as current), it verifies that English strings are returned. This is trivially true — the locale was already English.

**Evidence** (lines 172–176):
```typescript
it('should return English strings after switching locale', async () => {
  await setLocale('en');
  const result = i18n('menu.file.open');
  expect(result).toBe('Open');
});
```

This assertion is trivially true and provides no coverage of actual locale switching behaviour.

---

### WT-04 — Task 9.1.4 | `src/export/__tests__/gif.test.ts::frameDelay::100ms delay is encoded as 10 centiseconds in GIF metadata`

**Problem**: The assertion `expect(delays.length).toBeGreaterThan(0)` at line 213 is a weak guard assertion that does not verify a specific count. If `extractGifDelays` returns any number of delays (even 1 for a 3-step GIF), the guard passes. The meaningful assertion is `expect(d).toBe(10)` inside the loop, but the guard itself does not verify the correct number of delay entries.

**Evidence** (lines 211–217):
```typescript
const delays = extractGifDelays(data);
expect(delays.length).toBeGreaterThan(0);
// 100ms = 10 centiseconds
for (const d of delays) {
  expect(d).toBe(10);
}
```

A stronger assertion would be `expect(delays.length).toBe(3)` (matching the 3 steps configured for this test).

---

### WT-05 — Task 9.1.4 | `src/export/__tests__/gif.test.ts::frameDelay::200ms delay is encoded as 20 centiseconds in GIF metadata`

**Problem**: Same issue as WT-04 — `expect(delays.length).toBeGreaterThan(0)` at line 236 is a weak guard. Should assert `delays.length === 2` (the test uses 2 steps).

**Evidence** (lines 234–240):
```typescript
const delays = extractGifDelays(data);
expect(delays.length).toBeGreaterThan(0);
// 200ms = 20 centiseconds
for (const d of delays) {
  expect(d).toBe(20);
}
```

---

### WT-06 — Task 9.3.1 | `src/components/__tests__/library-74xx.test.ts::manifestComplete::all manifest entries have non-empty name, description, and file`

**Problem**: The assertions `expect(entry.name.length).toBeGreaterThan(0)` (lines 45–47) are weak length checks without content verification. A name of `" "` (single space) would pass. The spec requires names like "7400" (specific format). The test does not verify the naming convention (numeric 74xx format) or that descriptions are meaningful.

**Evidence** (lines 44–49):
```typescript
for (const entry of LIBRARY_74XX) {
  expect(entry.name.length).toBeGreaterThan(0);
  expect(entry.description.length).toBeGreaterThan(0);
  expect(entry.file.length).toBeGreaterThan(0);
  expect(entry.file.endsWith('.dig')).toBe(true);
}
```

---

## Legacy References

None found.

---

## Notes on Acceptable Deviations

- The `gifenc` library used in Task 9.1.3 differs from the spec's suggested `gif.js`, but the spec explicitly permits "a modern lightweight alternative." `gifenc` is a legitimate choice. No violation recorded for this substitution.
- The `toBeCloseTo(value, 5)` assertions in `svg.test.ts` (lines 125–126, 185–186) use precision 5 (5 decimal places), which is not a loose tolerance designed to hide failures — it accounts for floating-point arithmetic in dimension calculations. No violation recorded.
- The 121 .dig files in `lib/74xx/` vs the spec's "~60" is reported as a gap (G-02) rather than a violation, since the spec uses approximate language and the source directory discrepancy may reflect a legitimate decision.
