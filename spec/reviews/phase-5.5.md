# Review Report: Phase 5.5 — Cross-Cutting Modifications

## Summary

| Item | Count |
|------|-------|
| Tasks reviewed | 4 |
| Violations | 9 |
| Gaps | 5 |
| Weak tests | 2 |
| Legacy references | 1 |
| **Verdict** | **has-violations** |

---

## Violations

### V-01
- **File**: `src/i18n/index.ts`, lines 8, 25–35, 108–118
- **Rule violated**: Completeness — "Never mark work as deferred, TODO, or 'not implemented.'" / Code Hygiene — "No fallbacks. No backwards compatibility shims."
- **Evidence**:
  ```typescript
  import { loadLocale, getCachedLocale, clearLocaleCache } from './locale-loader';
  ...
  export async function initializeI18n(initialLocale: string = 'en'): Promise<void> {
    try {
      localeData = await loadLocale(initialLocale);
      currentLocale = initialLocale;
    } catch (error) {
      // Fallback: use English or empty map
      console.warn(`Failed to load locale ${initialLocale}, using empty locale data`);
      localeData = {};
  ```
- **Severity**: critical
- **Explanation**: The spec requires a simple pass-through implementation — `i18n()` returns the key unchanged, `setLocale()` is a no-op, `getLocale()` returns `'en'`. Instead, the agent implemented a full locale-loading system with JSON files, a fetch-based loader, dynamic imports, a module cache, fallback chains, and an async `setLocale`. This is far outside the task scope ("Phase 9 replaces with locale-aware lookup") and introduces a browser dependency (`fetch`) via `locale-loader.ts`. The `// Fallback: use English or empty map` comment on line 31 is an explicit fallback, banned by the Code Hygiene rules. The word "Fallback" appears three additional times in `locale-loader.ts` (lines 4, 19, 39), all in a file that should not exist.

### V-02
- **File**: `src/i18n/locale-loader.ts`, line 40
- **Rule violated**: Code Hygiene — "No fallbacks. No backwards compatibility shims." / Implementation rules — task 5.5.2 acceptance criterion: "No browser dependencies"
- **Evidence**:
  ```typescript
  // Fall back to fetch for runtime (browser)
  const response = await fetch(`/src/i18n/locales/${locale}.json`);
  ```
- **Severity**: critical
- **Explanation**: `fetch` is a browser API. The spec acceptance criterion explicitly states "No browser dependencies." The file `locale-loader.ts` is entirely out of scope for Phase 5.5 — the spec says to create only `src/i18n/index.ts` with a pass-through. The comment "Fall back to fetch for runtime (browser)" is a fallback comment, banned by the rules.

### V-03
- **File**: `src/i18n/locale-loader.ts`, lines 34–35, 39
- **Rule violated**: Code Hygiene — "No fallbacks."
- **Evidence**:
  ```typescript
  // Try to load via direct import first (for testing)
  if (localeModules[locale]) {
    ...
  } else {
    // Fall back to fetch for runtime (browser)
  ```
- **Severity**: major
- **Explanation**: The entire try/import-then-fall-back-to-fetch pattern is a fallback shim. The file should not exist at all. The word "fallback" / "Fall back" is used explicitly on line 39.

### V-04
- **File**: `src/i18n/index.ts`, line 31
- **Rule violated**: Code Hygiene — "No fallbacks." / Historical-provenance comment ban
- **Evidence**:
  ```typescript
  // Fallback: use English or empty map
  console.warn(`Failed to load locale ${initialLocale}, using empty locale data`);
  localeData = {};
  ```
- **Severity**: major
- **Explanation**: Comment explicitly describes a fallback strategy. Banned by the rules. This also documents historical/alternative behaviour, which is the definition of a historical-provenance comment.

### V-05
- **File**: `src/i18n/index.ts`, lines 55–59
- **Rule violated**: Code Hygiene — "No fallbacks."
- **Evidence**:
  ```typescript
  // Fall back to English if not found and current locale is not English
  if (!value && currentLocale !== 'en') {
    const enData = getCachedLocale('en');
    if (enData) {
      value = getNestedValue(enData, key);
    }
  }
  ```
- **Severity**: major
- **Explanation**: A second fallback chain in the `i18n()` function body: falls back from non-English locale data to English locale data. This is a backwards-compatibility shim. The spec requires a pure pass-through that returns the key; no fallback chains should exist.

### V-06
- **File**: `src/engine/__tests__/snapshot.test.ts`, lines 140–141
- **Rule violated**: Code Hygiene — "No historical-provenance comments." / The "workaround" keyword is explicitly listed as a red flag.
- **Evidence**:
  ```typescript
  // We control values by resetting and writing via setSignalValue (BitVector-free
  // workaround: use a circuit that writes specific values per step iteration).
  ```
- **Severity**: minor
- **Explanation**: The comment uses the word "workaround" which is explicitly banned by the rules. A comment that explains why a pattern was chosen because of a limitation ("BitVector-free workaround") is exactly the type of comment the rules forbid.

### V-07
- **File**: `src/io/digb-deserializer.ts`, lines 123–125
- **Rule violated**: Code Hygiene — "No historical-provenance comments." Comments must not describe what code is doing to work around something, or why a constraint exists.
- **Evidence**:
  ```typescript
  // Restore the persisted instanceId (readonly on the class, but must be
  // restored exactly for round-trip fidelity).
  (element as { instanceId: string }).instanceId = savedEl.id;
  ```
- **Severity**: minor
- **Explanation**: The comment explains why the property is being force-cast ("readonly on the class, but must be restored exactly for round-trip fidelity") — this describes a workaround/constraint justification. The rules state comments exist only to explain complicated code to future developers; they must not describe why a rule is being bent. The cast itself may also indicate a design issue in the `CircuitElement` API, but that is a gap concern.

### V-08
- **File**: `src/i18n/index.ts`, lines 1–6 (file header comment)
- **Rule violated**: Code Hygiene — comments must only explain complicated code, not describe intent or future plans.
- **Evidence**:
  ```typescript
  /**
   * Internationalization (i18n) module.
   *
   * Provides locale-aware string lookup with parameter interpolation,
   * fallback chains, and locale change events.
   */
  ```
- **Severity**: minor
- **Explanation**: The file header documents "fallback chains" and "locale change events" — neither of which should exist in a Phase 5.5 pass-through implementation. The header is accurate to what was built, but what was built is outside spec scope.

### V-09
- **File**: `src/engine/digital-engine.ts`, lines 721–722
- **Rule violated**: Code Hygiene — historical-provenance / environment-toggle comment.
- **Evidence**:
  ```typescript
  // In a browser environment, use requestAnimationFrame. In Node/test
  // environments, use setImmediate/setTimeout as fallback.
  ```
- **Severity**: minor
- **Explanation**: The word "fallback" appears in a comment describing environment-branching behaviour. While the branching itself may be necessary, the comment uses the banned word "fallback" to justify an environment-conditional code path. Per the rules, a justification comment next to a conditional is worse, not better.

---

## Gaps

### G-01
- **Spec requirement**: Task 5.5.2 — `setLocale(locale: string): void` (synchronous no-op). The spec explicitly shows the signature as `void`, not `Promise<void>`, and states it is a no-op.
- **What was found**: `setLocale` is implemented as `async function setLocale(locale: string): Promise<void>` (line 108 of `src/i18n/index.ts`). It is not a no-op — it loads locale JSON files, populates `localeData`, and fires callbacks.
- **File**: `src/i18n/index.ts`, line 108

### G-02
- **Spec requirement**: Task 5.5.2 — `src/i18n/index.ts` only. No other files should be created for this task.
- **What was found**: Two additional files were created outside the spec scope: `src/i18n/locale-loader.ts` and locale JSON files at `src/i18n/locales/en.json`, `src/i18n/locales/de.json`, `src/i18n/locales/zh.json`. These are scope creep. Phase 9 is specified as the phase where locale-aware lookup is introduced.
- **File**: `src/i18n/locale-loader.ts`, `src/i18n/locales/`

### G-03
- **Spec requirement**: Task 5.5.2 — test `locale::setNoOp` — `setLocale('de')` does not throw; `getLocale()` returns `'de'` (verifying that setLocale stores the locale but is a no-op).
- **What was found**: The test named `setNoOp` is absent. Instead there are two replacement tests: `setLocaleUpdatesCurrentLocale` (calls `setLocale('en')`) and `setLocaleWithMissingLocaleKeepsCurrent` (calls `setLocale('xx')` and expects `'en'` to be returned — the opposite of what the spec requires). Neither test calls `setLocale('de')` and asserts `getLocale() === 'de'`. The `setLocaleWithMissingLocaleKeepsCurrent` test actually asserts behaviour that contradicts the spec (`getLocale()` returning `'en'` after `setLocale('xx')` rather than `'xx'`).
- **File**: `src/i18n/__tests__/i18n.test.ts`

### G-04
- **Spec requirement**: Task 5.5.1 — `ThemeColor` union must include keys matching the semantic names listed in the spec: `wire-logic-1`, `wire-logic-0`, `wire-high-z`, `wire-error`, `wire-undefined`, `grid`, `component-fill`, `component-stroke`, `selected`. The spec says: "Add any missing `ThemeColor` keys needed for the semantic colors above."
- **What was found**: The `ThemeColor` union uses uppercase/underscore names (`WIRE_HIGH`, `WIRE_LOW`, `WIRE_Z`, `WIRE_ERROR`, `WIRE_UNDEFINED`, `GRID`, `COMPONENT_FILL`, `COMPONENT`, `SELECTION`) rather than the kebab-case names in the spec. The spec says to add keys for `wire-logic-1`, `wire-logic-0`, `wire-high-z`, etc. While the semantic colors are present under different names, the spec explicitly lists the keys that must be added, and none of those kebab-case keys exist in the implementation.
- **File**: `src/core/renderer-interface.ts`, lines 30–43

### G-05
- **Spec requirement**: Task 5.5.2 — `src/i18n/index.ts` must have "No browser dependencies."
- **What was found**: The module imports from `./locale-loader` (line 8), which contains `fetch` (a browser API) on line 40 of `locale-loader.ts`. The `i18n/index.ts` module itself does not call `fetch` directly, but its import chain introduces the browser dependency. The acceptance criterion "No browser dependencies" is violated.
- **File**: `src/i18n/index.ts`, line 8; `src/i18n/locale-loader.ts`, line 40

---

## Weak Tests

### WT-01
- **Test path**: `src/i18n/__tests__/i18n.test.ts::i18n::locale::setLocaleWithMissingLocaleKeepsCurrent`
- **What is wrong**: The test calls `setLocale('xx')` and asserts `getLocale() === 'en'`, which encodes the fallback-keeps-current behaviour of the out-of-spec implementation. This assertion tests implementation detail (error-handling fallback behaviour) rather than the desired spec behaviour (setLocale is a no-op that stores any locale string). The spec requires `setLocale('de')` to result in `getLocale() === 'de'` unconditionally. This test effectively validates a deviation from the spec.
- **Evidence**:
  ```typescript
  it('setLocaleWithMissingLocaleKeepsCurrent', async () => {
    // 'xx' locale file does not exist, so setLocale keeps current locale
    await setLocale('xx');
    expect(getLocale()).toBe('en');
  });
  ```

### WT-02
- **Test path**: `src/engine/__tests__/snapshot.test.ts::restorePausesEngine::transitions engine to PAUSED state after restoring a snapshot`
- **What is wrong**: The test does not actually start the engine in a RUNNING state before restoring — it calls `start()` then immediately `stop()` (commenting that "continuous run uses RAF/setTimeout; stop it by calling stop first then manually set to RUNNING via start"). The test never reaches a state where the engine is RUNNING at the point of `restoreSnapshot`. The assertion `expect(eng.getState()).toBe(EngineState.PAUSED)` after `restoreSnapshot` is correct, but the test does not demonstrate the transition _from_ RUNNING to PAUSED as the spec describes ("start engine, restore snapshot, assert `getState()` is `PAUSED`"). The `void id2; // used to verify below` comment with no actual verification of `id2` is also suspicious dead code.
- **Evidence**:
  ```typescript
  eng.start();
  // In test environment start() sets RUNNING even without actual scheduling
  // (setState is called synchronously)
  // However continuous run uses RAF/setTimeout; stop it by calling stop first
  // then manually set to RUNNING via start to capture the state.

  // Use stop() to get to PAUSED, then restore should keep it PAUSED
  eng.stop();
  expect(eng.getState()).toBe(EngineState.PAUSED);
  ...
  eng.restoreSnapshot(id);
  expect(eng.getState()).toBe(EngineState.PAUSED);
  ```

---

## Legacy References

### LR-01
- **File**: `src/i18n/locale-loader.ts`, lines 39–44
- **Stale reference**: `fetch(`/src/i18n/locales/${locale}.json`)`
- **Explanation**: `fetch` is a browser runtime API. Its presence in this module creates a browser dependency in the i18n module tree, directly violating the Task 5.5.2 acceptance criterion "No browser dependencies." The entire `locale-loader.ts` file is out of scope for Phase 5.5 and should not exist.
