# Review Report: Phase 6 (Waves 6.3 & 6.4)

## Summary

| Item | Value |
|------|-------|
| Tasks reviewed | 9 (6.3.1 – 6.3.6, 6.4.1 – 6.4.3) |
| Violations — critical | 1 |
| Violations — major | 3 |
| Violations — minor | 2 |
| Gaps | 2 |
| Weak tests | 6 |
| Legacy references | 1 |

**Verdict: has-violations**

---

## Violations

### V-001 — Critical — Historical-provenance mega-comment block in parser.ts

**File**: `src/testing/parser.ts`, lines 741–844

**Rule**: "No historical-provenance comments. Any comment describing what code replaced, what it used to do, why it changed, or where it came from is banned."

**Evidence** (partial excerpt):
```
 * UPDATE: The spec shows `simpleTable` with "A B Y" where A,B are inputs
 * Strategy adopted: the *last* name(s) that appear only in output-typical
 * Re-reading the spec carefully:
 * Resolution: the test `simpleTable` checks:
 * Final decision: We implement `parseTestData(text, inputNames?)`. When
 * Actually re-reading the test spec once more: "verify 2 inputs (A, B),
 * The simplest resolution: make `parseTestData` accept an optional
```

This is a 103-line block (lines 741–844) of in-code deliberation documenting the agent's design reasoning process: it describes what was attempted, what was reconsidered, partial strategies abandoned, and the "final decision." Multiple sub-headings within it say "UPDATE:", "Strategy adopted:", "Re-reading the spec carefully:", "Resolution:", "Final decision:", "Actually re-reading the test spec once more:", "The simplest resolution:". Every one of these is a historical-provenance comment describing why the code changed or what previous approaches were rejected. The rules ban this entirely — comments exist only to explain complicated code to future developers.

**Severity**: Critical

---

### V-002 — Major — Scope creep: `src/testing/run-all.ts` not in spec

**File**: `src/testing/run-all.ts`

**Rule**: Agents must not add files outside the spec scope. Scope creep must be flagged.

**Evidence**: The task 6.3 spec lists these files to create under `src/testing/`:
- `src/testing/parser.ts`
- `src/testing/executor.ts`
- `src/testing/results-ui.ts`
- `src/testing/export.ts`
- `src/testing/comparison.ts`

`src/testing/run-all.ts` appears in none of the Wave 6.3 task specifications. It exports `runAllTests`, `AggregateTestResults`, `TestcaseResult`, and `registerRunAllShortcut` — none of these symbols appear in the phase 6 spec at all. The file was created without being requested.

**Severity**: Major

---

### V-003 — Major — `run-all.ts` contains a backward-compatibility comment

**File**: `src/testing/run-all.ts`, line 34

**Rule**: "No backwards compatibility shims. No safety wrappers." and "No historical-provenance comments."

**Evidence**:
```typescript
 * Returns 0 if no In elements are found, which causes parseTestData to treat
 * all columns as inputs (backward-compatible behavior).
```

The phrase "backward-compatible behavior" is explicitly listed as a banned red-flag phrase in the reviewer instructions. Even if the behavior itself were acceptable, naming it "backward-compatible" in a comment is a rules violation. This comment describes fallback/compatibility semantics rather than explaining the code's purpose.

**Severity**: Major

---

### V-004 — Major — `executeTests` signature differs from spec

**File**: `src/testing/executor.ts`, lines 69–74

**Rule**: Spec API compliance — function signatures must match the spec.

**Evidence**: The spec (task 6.3.2) defines:
```typescript
executeTests(facade: SimulatorFacade, engine: SimulationEngine, circuit: Circuit, testData: ParsedTestData): TestResults
```

The implementation defines:
```typescript
export function executeTests(
  facade: RunnerFacade,   // ← different type: RunnerFacade, not SimulatorFacade
  engine: SimulationEngine,
  _circuit: Circuit,
  testData: ParsedTestData,
): TestResults
```

The first parameter type is `RunnerFacade` (a locally-defined minimal interface), not `SimulatorFacade` as specified. The implementation introduces an undocumented structural interface `RunnerFacade` and uses it instead. While the implementation is compatible at runtime due to structural typing, this is a deviation from the spec API contract. The parameter `_circuit` is also prefixed with `_` to suppress unused-variable warnings, which signals it is being silently ignored rather than used — but the spec implies it is present for "future metadata access" (as stated in the executor comment on line 65), which is an implicit TODO.

**Severity**: Major

---

### V-005 — Minor — `_circuit` unused parameter with suppression prefix

**File**: `src/testing/executor.ts`, line 73

**Rule**: "Never mark work as deferred, TODO, or 'not implemented.'"

**Evidence**:
```typescript
  _circuit: Circuit,
```

The `_` prefix on a required parameter is a TypeScript convention for suppressing unused-variable lint errors. The comment on line 65 reads: `"The circuit (unused for execution, included for future metadata access)"`. This is a deferred implementation — the parameter is accepted but silently dropped with a justification comment explaining it is for future use. This is a TODO-equivalent: the spec requires the parameter, and the implementation ignores it while flagging it as reserved for something not yet implemented.

**Severity**: Minor

---

### V-006 — Minor — Historical-provenance comment in `postmessage-adapter.ts`

**File**: `src/io/postmessage-adapter.ts`, lines 388–390

**Rule**: "No historical-provenance comments."

**Evidence**:
```typescript
  /** Unwrap ChainResolver to access inner resolvers; otherwise return singleton. */
  private _flattenResolvers(): readonly FileResolver[] {
```

This comment is acceptable on its own, but note the pattern around it at lines 362–385: the `_clearCaches` and `_updateResolverBasePath` methods contain the pattern:
```typescript
    } else if (
      typeof (r as unknown as { clear?: () => void }).clear === 'function'
    ) {
      (r as unknown as { clear(): void }).clear();
    }
```

This is a duck-typing "fallback" pattern — if the resolver is not a `CacheResolver` instance but has a `.clear()` method, call it anyway. This is a backwards-compatibility shim for unknown resolver implementations. The rules prohibit fallbacks and safety wrappers. The same pattern appears in `_updateResolverBasePath` for `setBasePath`. These unsafe casts and duck-typed fallbacks represent defensive coding that the rules explicitly ban.

**Severity**: Minor

---

## Gaps

### G-001 — Task 6.3.4 `endToEnd` test missing from test-runner.test.ts

**Spec requirement** (task 6.3.4):
```
src/headless/__tests__/test-runner.test.ts::endToEnd —
  facade.loadDig('circuits/half-adder.dig') → compile → runTests → all vectors pass
```

**What was found**: The test file `src/headless/__tests__/test-runner.test.ts` contains tests named `embeddedTests`, `externalTests`, `noTestData`, `multipleTestcases`, `extractEmbeddedTestData` (several variants). There is no test named `endToEnd` and no test that loads a real `.dig` file from disk, compiles it, and runs the full pipeline. The parser and executor are mocked via `vi.mock()`. The spec explicitly requires this test to exercise the full end-to-end path.

**File path**: `src/headless/__tests__/test-runner.test.ts`

---

### G-002 — Task 6.4.3 spec tests not implemented: `parseParams`, `checkpointPath`, `iframeSetup`

**Spec requirement** (task 6.4.3):
```
src/tutorial/__tests__/tutorial-host.test.ts::parseParams —
  `?tutorial=intro-to-logic&step=2` → correct tutorial and step values
src/tutorial/__tests__/tutorial-host.test.ts::checkpointPath —
  tutorial "intro-to-logic", step 2 → base path `tutorials/intro-to-logic/checkpoint-2/`
src/tutorial/__tests__/tutorial-host.test.ts::iframeSetup —
  verify iframe src includes correct `base` parameter
```

**What was found**: The tutorial-host.test.ts file groups tests under `describe('parseParams')`, `describe('checkpointPath')`, and `describe('iframeSetup')`, which correspond to the spec names. These are present. However, the spec lists exactly these three test IDs. The actual test file has many additional tests beyond the spec (scope creep in test coverage), but more importantly, the `iframeSetup` describe block tests `buildIframeSrc` in isolation rather than testing what the spec says: "verify iframe src includes correct `base` parameter." The spec means verifying the full iframe setup through the `TutorialHost`, not just the helper function. The `TutorialHost` iframe setup tests in the file (`TutorialHost` describe block) assert only `expect(host).toBeDefined()` — a trivially true assertion (see Weak Tests below) — and do not verify that the iframe src contains the correct base parameter.

**File path**: `src/tutorial/__tests__/tutorial-host.test.ts`

---

## Weak Tests

### W-001 — `results-ui.test.ts::rendersTable` — toBeTruthy guard without content check

**Test path**: `src/testing/__tests__/results-ui.test.ts::rendersTable`

**Evidence**:
```typescript
const table = container.querySelector("table");
expect(table).toBeTruthy();

const rows = table!.querySelectorAll("tbody tr");
expect(rows.length).toBe(4);
```

The `expect(table).toBeTruthy()` is a guard assertion — it asserts only that a DOM element was returned, not anything about its content. The rules flag `toBeTruthy()` (equivalent to `not.toBeNull()`) as a weak guard assertion when used before the real assertions. The actual check (`rows.length === 4`) is the meaningful assertion; the guard adds noise and signals the implementer was uncertain whether the element would exist at all.

---

### W-002 — `results-ui.test.ts::summaryText` — toBeTruthy guard before content check

**Test path**: `src/testing/__tests__/results-ui.test.ts::summaryText`

**Evidence**:
```typescript
const summary = container.querySelector(".test-summary");
expect(summary).toBeTruthy();
expect(summary!.textContent).toContain("3/4 passed");
```

Same pattern as W-001. The `toBeTruthy()` guard is weak — if the element is absent, the non-null assertion `!` on the next line would throw a more descriptive error anyway.

---

### W-003 — `results-ui.test.ts::emptyResults` — toBeTruthy guard before content check

**Test path**: `src/testing/__tests__/results-ui.test.ts::emptyResults`

**Evidence**:
```typescript
const noVectorsMsg = container.querySelector(".test-no-vectors");
expect(noVectorsMsg).toBeTruthy();
expect(noVectorsMsg!.textContent).toContain("No test vectors");
```

Same pattern as W-001 and W-002.

---

### W-004 — `tutorial-host.test.ts` — multiple trivially-true assertions on `host` identity

**Test path**: `src/tutorial/__tests__/tutorial-host.test.ts::TutorialHost` (multiple tests)

**Evidence**:
```typescript
it('initializes with correct container', () => {
  const host = new TutorialHost('instructions');
  expect(host).toBeDefined();
});

it('registers iframes for management', () => {
  const host = new TutorialHost('instructions');
  const iframe = document.createElement('iframe');
  host.registerIframe(iframe);
  expect(host).toBeDefined(); // ← trivially true: constructor cannot return undefined
});

it('handles iframe registration with multiple iframes', () => {
  const host = new TutorialHost('instructions');
  const iframe1 = document.createElement('iframe');
  const iframe2 = document.createElement('iframe');
  host.registerIframe(iframe1);
  host.registerIframe(iframe2);
  expect(host).toBeDefined(); // ← trivially true
});
```

`expect(host).toBeDefined()` on a class instance is trivially true — a `new` expression never returns `undefined`. These tests assert nothing meaningful about the behavior they claim to test. The `registerIframe` tests do not verify that the iframes are actually stored or that `iframes.length` changes. These are implementation-details-agnostic tests that would pass even if `registerIframe()` were an empty function body.

---

### W-005 — `tutorial-host.test.ts::throws when container not found` — misleading test asserting wrong thing

**Test path**: `src/tutorial/__tests__/tutorial-host.test.ts::TutorialHost::throws when container not found`

**Evidence**:
```typescript
it('throws when container not found', () => {
  const host = new TutorialHost('nonexistent');
  expect(() => {
    host.registerIframe(document.createElement('iframe'));
  }).not.toThrow(); // registerIframe doesn't check container
});
```

The test name says "throws when container not found" but the assertion is `.not.toThrow()`. The comment "registerIframe doesn't check container" exposes that the test was written to justify the implementation's omission rather than assert desired behaviour. The test name is a direct contradiction of what is being asserted. This is an assertion that verifies an implementation detail (that `registerIframe` does not check the container), not a desired behaviour.

---

### W-006 — `postmessage-adapter.test.ts::loadJson` — does not verify circuit or subcircuits loaded

**Test path**: `src/io/__tests__/postmessage-adapter.test.ts::loadJson`

**Evidence**:
```typescript
it("loadJson — valid digb JSON loads circuit and compiles engine, digital-loaded sent", async () => {
  // ...
  await dispatch({ type: "digital-load-json", data: digbJson });
  expect(sent).toContainEqual({ type: "digital-loaded" });
  expect(facade.compile).toHaveBeenCalled();
});
```

The spec requires: "simulate `digital-load-json` with .digb content, verify circuit + subcircuits loaded." The test only checks that `digital-loaded` was sent and that `facade.compile` was called. It does not verify that the circuit was correctly deserialized from the JSON (e.g., that the circuit has the expected elements) or that subcircuits were loaded. `expect(facade.compile).toHaveBeenCalled()` is a weak assertion — it confirms a call was made but not with what argument, nor what the resulting circuit state is.

---

## Legacy References

### L-001 — "backward-compatible behavior" in `src/testing/run-all.ts`

**File**: `src/testing/run-all.ts`, line 34

**Evidence**:
```typescript
 * Returns 0 if no In elements are found, which causes parseTestData to treat
 * all columns as inputs (backward-compatible behavior).
```

The phrase "backward-compatible behavior" is a legacy reference. It implies there is a previous behaviour being preserved for compatibility, which is banned by the rules: "No backwards compatibility shims. No safety wrappers." and the red-flag word list includes "backwards compatible". This is found in a file that is itself scope creep (V-002), compounding the issue.
