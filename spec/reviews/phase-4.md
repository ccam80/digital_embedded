# Review Report: Phase 4 — .dig Parser & I/O

## Summary

| Item | Count |
|------|-------|
| Tasks reviewed | 6 (4.1.1, 4.1.2, 4.2.1, 4.4.1, 4.4.2, 4.4.3) |
| Violations — critical | 0 |
| Violations — major | 3 |
| Violations — minor | 4 |
| Gaps | 5 |
| Weak tests | 11 |
| Legacy references | 1 |

**Verdict: has-violations**

---

## Violations

### V-1 (major) — `src/io/dom-parser.ts:29-31` — `require()` in ESM/TypeScript production code violates module discipline

**Rule violated**: Code Hygiene — no fallbacks, no safety wrappers. The project uses ESM (`"type": "module"` implied by Vite/TS setup). A `require()` call in an ESM module is a runtime hazard; the eslint-disable comment confirms the agent knew this was wrong and suppressed the lint error rather than using a proper dynamic import.

**Evidence**:
```typescript
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DOMParser } = require("@xmldom/xmldom") as {
    DOMParser: new () => { parseFromString(xml: string, mimeType: string): Document };
  };
```

The comment `// eslint-disable-next-line @typescript-eslint/no-require-imports` is proof the agent knowingly bypassed a rule. The spec binding decision states `@xmldom/xmldom` is a runtime dependency for Node.js. A proper implementation uses `await import("@xmldom/xmldom")` (dynamic ESM import), which requires `createDomParser()` to be async — or a top-level await pattern. The agent used `require()` as a shortcut and disabled the lint rule.

**Severity**: major

---

### V-2 (major) — `src/io/dig-loader.ts:152-163` — Scope creep: un-specced "pass-through" logic for `generic` and `enabled` built-in attributes

**Rule violated**: Spec adherence — agents must not implement functionality not in the spec. Task 4.2.2 does not specify any special handling for `generic` or `enabled` built-in attributes at the loader layer. That logic belongs to task 4.5.1 (HGS Generic Circuit Resolution), which was not in scope for the tasks reviewed.

**Evidence**:
```typescript
  // Pass through built-in attributes used by generic circuit resolution.
  // These are not component-specific and may be present on any element.
  for (const key of ["generic", "enabled"] as const) {
    if (!bag.has(key) && entryByKey.has(key)) {
      const digValue = entryByKey.get(key)!;
      const strValue = digValueToString(digValue);
      bag.set(key, key === "enabled" ? strValue === "true" : strValue);
    }
  }
```

The comment explicitly describes this as supporting a separate phase's feature ("used by generic circuit resolution"). This is a scope creep violation that pre-emptively implements wave 4.5 logic inside a wave 4.2 file.

**Severity**: major

---

### V-3 (major) — `src/io/save-schema.ts` — `SavedElement` adds `instanceId` and `mirror` fields not in the spec

**Rule violated**: Spec adherence — Task 4.4.1 specifies `SavedElement` as `{ typeName: string; properties: Record<string, unknown>; position: { x: number; y: number }; rotation?: number }`. The implementation adds two unspecified fields.

**Evidence** (save-schema.ts, lines 31-46):
```typescript
export interface SavedElement {
  typeName: string;
  instanceId: string;        // NOT IN SPEC
  position: { x: number; y: number };
  rotation: number;
  mirror: boolean;           // NOT IN SPEC
  properties: Record<string, unknown>;
}
```

The spec says `rotation?: number` (optional). The implementation makes it required (`rotation: number`) — also a deviation. `instanceId` and `mirror` are scope creep.

**Severity**: major

---

### V-4 (minor) — `src/io/save.ts:45` — Historical-provenance comment banned by rules

**Rule violated**: Code Hygiene — "No historical-provenance comments." The word `previously` in the doc-comment describes historical behaviour of a function.

**Evidence** (save.ts, line 45):
```typescript
 * Decode a previously encoded bigint string back to bigint.
```

This is a marginal case — "previously encoded" refers to a prior call in the same pipeline, not a code-history comment. However the rules are absolute and the wording triggers the ban pattern. Reported per reviewer rules.

**Severity**: minor

---

### V-5 (minor) — `src/io/dig-loader.ts:218-220` — Comment explains pin mutation is intentional, which is a rule justification

**Rule violated**: Code Hygiene — "A comment that explains why a rule was bent is not a mitigating factor — it is proof the agent knowingly broke the rule." The agent casts `pin` through `unknown` to mutate a nominally-readonly field and then comments to explain why.

**Evidence** (dig-loader.ts, lines 218-220):
```typescript
  // Pin is declared readonly so we cast through unknown to set the flag.
  // This is intentional: the negation state comes from the .dig file, not
  // the component definition, so it must be applied post-construction.
```

The agent knowingly bypassed the TypeScript readonly contract and wrote justification comments. The correct solution is to design Pin to expose a setter or constructor parameter for this case.

**Severity**: minor

---

### V-6 (minor) — `src/io/dig-loader.ts:152` — Comment describes what code is for (relationship to other feature), violating historical-provenance ban

**Rule violated**: Code Hygiene — "No historical-provenance comments." The comment `// Pass through built-in attributes used by generic circuit resolution.` describes what other subsystem this code supports, which is a provenance/coordination comment.

**Evidence** (dig-loader.ts, line 152):
```typescript
  // Pass through built-in attributes used by generic circuit resolution.
  // These are not component-specific and may be present on any element.
```

**Severity**: minor

---

### V-7 (minor) — `src/io/attribute-map.ts:235-238` — `inverterConfigConverter.convert()` silently returns empty array for string input

**Rule violated**: Completeness — "No fallbacks. No backwards compatibility shims." The `convert(xmlValue)` method (the string-based path used for plain `AttributeMapping`) silently returns `[]` rather than parsing the string, with a comment explaining the string form is "not used". This is a fallback that hides potential errors.

**Evidence** (attribute-map.ts, lines 235-238):
```typescript
    convert(_xmlValue: string): PropertyValue {
      // The string form is not used for inverterConfig — it's always converted
      // from a typed DigValue in normal parsing flow.
      return [];
    },
```

The comment is a justification for the fallback. If this code path is truly dead, there should be a hard throw, not a silent empty return.

**Severity**: minor

---

## Gaps

### G-1 — Task 4.2.2 not completed; `dig-loader.ts` exists but is not recorded in `spec/progress.md`

**Spec requirement**: Task 4.2.2 specifies: Files to create: `src/io/dig-loader.ts` with `loadDigCircuit`, `createElementFromDig`, `applyInverterConfig`, `createWireFromDig`, `extractCircuitMetadata`. Tests: `src/io/__tests__/dig-loader.test.ts` with 8 named tests.

**What was found**: The file `src/io/dig-loader.ts` exists and contains the correct functions. `src/io/__tests__/dig-loader.test.ts` also exists. However, task 4.2.2 has no entry at all in `spec/progress.md`. The task is not marked complete, not partially complete, and not skipped. It is simply absent.

**File path**: `spec/progress.md` — no entry for task 4.2.2

This means the task was implemented (likely as an undocumented prerequisite for 4.4.3) but never formally recorded. The progress tracking is the source of truth per reviewer instructions, so this is a gap in both tracking and review coverage.

---

### G-2 — `parsesColor` test does not use an actual .dig file with `<awt-color>` as specified

**Spec requirement**: Task 4.1.2 test `parsesColor` — "parse a .dig file with `<awt-color>` (e.g., TafficLight3.dig), verify color has r/g/b/a values"

**What was found**: The test constructs an inline XML string rather than loading `TafficLight3.dig` or any actual .dig file from the reference corpus. This means the test does not exercise the file-reading pipeline for this case.

**File path**: `src/io/__tests__/dig-parser.test.ts:163-199`

---

### G-3 — `parsesRotation` test assertion is weaker than spec: "first Not element has rotation 3" but test does not verify this is specifically the first element

**Spec requirement**: Task 4.1.2 test `parsesRotation` — "parse mux.dig (has rotation attributes), verify Not element has rotation value 3"

**What was found**: The test filters all Not elements and checks `notElements[0]`. Whether index 0 is truly the "first" Not depends on parse order. More importantly, the test only asserts `rotEntry` is defined and has value 3, without verifying the exact element identity. This is an implementation-detail test (relying on parse order) rather than a behavioural test (verifying a specific element's property).

**File path**: `src/io/__tests__/dig-parser.test.ts:118-130`

---

### G-4 — Task 4.4.1 spec: `SavedElement.rotation` should be optional (`rotation?: number`); implementation makes it required

**Spec requirement**: Task 4.4.1 specifies `SavedElement: { typeName: string; properties: Record<string, unknown>; position: { x: number; y: number }; rotation?: number }` — rotation is optional.

**What was found**: `src/io/save-schema.ts:41` declares `rotation: number` (required). This deviates from the spec, making it impossible to save an element without an explicit rotation value.

**File path**: `src/io/save-schema.ts:41`

---

### G-5 — `loadsSrLatch` test in dig-loader asserts `wires.length > 0` rather than the exact expected wire count

**Spec requirement**: Task 4.2.2 test `loadsSrLatch` — the spec requires loading `sr-latch.dig` and verifying it produces a valid Circuit. The spec does not specify the exact wire count check but general test quality rules require exact values, not "greater than" checks.

**What was found**: `expect(circuit.wires.length).toBeGreaterThan(0)` — this is a trivially weak assertion. The sr-latch has a known fixed number of wires. The test should assert the exact count.

**File path**: `src/io/__tests__/dig-loader.test.ts:339`

---

## Weak Tests

### WT-1 — `src/io/__tests__/dig-parser.test.ts::DigParser::parsesSrLatch` — `wires.length > 0` is trivially weak

**Test path**: `src/io/__tests__/dig-parser.test.ts::DigParser::parsesSrLatch`

**Problem**: The assertion `expect(circuit.wires.length).toBeGreaterThan(0)` does not verify the expected wire count. An SR latch has a specific number of wires that should be verified exactly.

**Evidence** (line 99):
```typescript
    expect(circuit.wires.length).toBeGreaterThan(0);
```

---

### WT-2 — `src/io/__tests__/dig-parser.test.ts::DigParser::parsesRotation` — `andElements.length > 0` is trivially weak

**Test path**: `src/io/__tests__/dig-parser.test.ts::DigParser::parsesInputCount`

**Problem**: The assertion does not verify the exact number of And gates, only that at least one exists.

**Evidence** (line 154):
```typescript
    expect(andElements.length).toBeGreaterThan(0);
```

---

### WT-3 — `src/io/__tests__/dig-parser.test.ts::DigParser::parsesAndGateCircuit` — `toBeDefined()` chains without verifying content before using `!`

**Test path**: `src/io/__tests__/dig-parser.test.ts::DigParser::parsesAndGateCircuit`

**Problem**: Multiple `expect(x).toBeDefined()` assertions followed immediately by `x!.something` — the `toBeDefined` assertion does not prevent the subsequent `!` non-null assertion from running on undefined if the test framework is lenient. The design intent assertion (that the element has a specific label) should be the primary assertion.

**Evidence** (lines 47-51, 60):
```typescript
    expect(andEl).toBeDefined();
    const wideShapeEntry = andEl!.elementAttributes.find((e) => e.key === "wideShape");
    expect(wideShapeEntry).toBeDefined();
    expect(wideShapeEntry!.value).toEqual({ type: "boolean", value: true });
    ...
    expect(inA).toBeDefined();
```

---

### WT-4 — `src/io/__tests__/dig-parser.test.ts::DigParser::parsesTestData` — `toBeDefined()` without content verification prior to conditional

**Test path**: `src/io/__tests__/dig-parser.test.ts::DigParser::parsesTestData`

**Problem**: `expect(testcase).toBeDefined()` and `expect(testDataEntry).toBeDefined()` are used as guards before the real assertion. If either is undefined, the subsequent `if` block silently passes without running the actual content check.

**Evidence** (lines 107-115):
```typescript
    expect(testcase).toBeDefined();
    const testDataEntry = testcase!.elementAttributes.find((e) => e.key === "Testdata");
    expect(testDataEntry).toBeDefined();
    expect(testDataEntry!.value.type).toBe("testData");
    if (testDataEntry!.value.type === "testData") {
      expect(testDataEntry!.value.value).toContain("A B Y");
    }
```

The final `expect` inside the `if` block is unreachable if the type is not "testData" — but the test has already asserted `type === "testData"` on the line before. This means the `if` is redundant dead code that makes the assertion look conditional when it isn't.

---

### WT-5 — `src/io/__tests__/dig-parser.test.ts::DigParser::parsesRotation` — `toBeDefined()` without content check, `toBeGreaterThanOrEqual(1)` weak count

**Test path**: `src/io/__tests__/dig-parser.test.ts::DigParser::parsesRotation`

**Problem**: `expect(notElements.length).toBeGreaterThanOrEqual(1)` does not verify the exact count. If mux.dig changes to have zero Not elements, this passes with length 1 or more, but the real failure is that mux.dig should have exactly a specific number.

**Evidence** (line 124):
```typescript
    expect(notElements.length).toBeGreaterThanOrEqual(1);
```

---

### WT-6 — `src/io/__tests__/dig-parser.test.ts::DigParser::resolvesXStreamReference` — `toBeGreaterThanOrEqual(2)` weak count

**Test path**: `src/io/__tests__/dig-parser.test.ts::DigParser::resolvesXStreamReference`

**Problem**: `expect(notElements.length).toBeGreaterThanOrEqual(2)` — the mux.dig file has a fixed number of Not elements. A weak lower-bound check does not confirm the file parsed correctly.

**Evidence** (line 139):
```typescript
    expect(notElements.length).toBeGreaterThanOrEqual(2);
```

---

### WT-7 — `src/io/__tests__/dig-parser.test.ts::DigParser::domParserNodeJs` — `expect(doc).toBeDefined()` is trivially weak

**Test path**: `src/io/__tests__/dig-parser.test.ts::DigParser::domParserNodeJs`

**Problem**: `expect(doc).toBeDefined()` — `DOMParser.parseFromString` never returns undefined; it returns a Document or throws. This assertion is trivially true and tests nothing meaningful.

**Evidence** (line 257):
```typescript
    expect(doc).toBeDefined();
```

---

### WT-8 — `src/io/__tests__/dig-loader.test.ts::DigLoader::loadsAndGate` — `toBeDefined()` without asserting the actual label value

**Test path**: `src/io/__tests__/dig-loader.test.ts::DigLoader::loadsAndGate`

**Problem**: `expect(labelA).toBeDefined()` and `expect(labelB).toBeDefined()` are used to verify existence, but the existence check already logically follows from the `.find()` condition that includes the exact label value. The assertion structure is weak: if `find()` returned `undefined` for the wrong reason, `toBeDefined()` would fail with an unhelpful message rather than a targeted assertion failure.

**Evidence** (lines 127-131):
```typescript
    const labelA = inElements.find((el) => el.getProperties().getOrDefault("label", "") === "A");
    expect(labelA).toBeDefined();
    const labelB = inElements.find((el) => el.getProperties().getOrDefault("label", "") === "B");
    expect(labelB).toBeDefined();
```

---

### WT-9 — `src/io/__tests__/dig-loader.test.ts::DigLoader::loadsSrLatch` — `wires.length > 0` trivially weak

**Test path**: `src/io/__tests__/dig-loader.test.ts::DigLoader::loadsSrLatch`

**Problem**: `expect(circuit.wires.length).toBeGreaterThan(0)` — the SR latch has a known fixed number of wires. This assertion passes with 1 wire when the correct count is several.

**Evidence** (line 339):
```typescript
    expect(circuit.wires.length).toBeGreaterThan(0);
```

---

### WT-10 — `src/io/__tests__/dig-loader.test.ts::DigLoader::testDataExtracted` — `toBeDefined()` guard before the real assertion

**Test path**: `src/io/__tests__/dig-loader.test.ts::DigLoader::testDataExtracted`

**Problem**: `expect(testcaseEl).toBeDefined()` followed by non-null assertion `testcaseEl!`. The `toBeDefined` check does not fail fast — if `testcaseEl` is undefined, vitest will report the `toBeDefined` failure but the `!` on the next line will throw a different error if the test runner continues. The assertion chain is fragile.

**Evidence** (lines 259-263):
```typescript
    const testcaseEl = circuit.elements.find((el) => el.typeId === "Testcase");
    expect(testcaseEl).toBeDefined();
    const testData = testcaseEl!.getProperties().getOrDefault<string>("testData", "");
    expect(testData).toContain("A B Y");
```

---

### WT-11 — `src/io/__tests__/dig-schema.test.ts::DigSchema::entryStructure` — Multiple `if (isXValue(entry.value))` guards create silent pass conditions

**Test path**: `src/io/__tests__/dig-schema.test.ts::DigSchema::entryStructure` (multiple sub-tests)

**Problem**: Many tests in this describe block use the pattern `if (isStringValue(entry.value)) { expect(entry.value.value).toBe(...); }`. If the type guard returns false (e.g., because the type system allowed a wrong value), the `expect` inside the `if` block is silently skipped and the test passes. This is a conditional assertion that can mask failures.

**Evidence** (representative, line 150-153 in dig-schema.test.ts):
```typescript
      if (isStringValue(entry.value)) {
        expect(entry.value.value).toBe('A');
      }
```

This pattern appears in at least 12 test cases in the `entryStructure` describe block. The guard should not be needed — the test should use a direct discriminant check or cast, and the `expect` should run unconditionally.

---

## Legacy References

### LR-1 — `src/io/save.ts:45` — Word "previously" in doc-comment

**File path**: `src/io/save.ts:45`

**Evidence**:
```typescript
 * Decode a previously encoded bigint string back to bigint.
```

The word "previously" is in the banned list (rules.md: "Any comment containing words like... 'previously'..."). While the intent here is pipeline-sequential rather than historical-codebase, the rule is absolute: the word is banned regardless of context. This is a legacy reference pattern violation per the letter of the rules.

---

## Per-Task Analysis

### Task 4.1.1 — .dig XML Schema Types
**Files**: `src/io/dig-schema.ts`, `src/io/__tests__/dig-schema.test.ts`

**Spec adherence**: Full. All required types (`DigCircuit`, `DigVisualElement`, `DigWire`, `DigEntry`, `DigValue`, `RomListData`) are present with correct structure. The discriminated union has all 12 variants. Type guards and `DIG_VALUE_TYPES` constant are present and correct.

**Tests**: The named spec tests `typesAreExhaustive` and `entryStructure` are both present. The exhaustive switch test (WT-11) has the conditional assertion pattern weakness but is functionally correct.

**Issues found**: WT-11 (weak tests in entryStructure).

---

### Task 4.1.2 — .dig XML Parser
**Files**: `src/io/dig-parser.ts`, `src/io/dom-parser.ts`, `src/io/__tests__/dig-parser.test.ts`

**Spec adherence**: All required functions (`parseDigXml`, `resolveXStreamReference`, `parseAttributeValue`, `migrateVersion`) are present with correct signatures and semantics. All named spec tests are present. The `parsesColor` test uses inline XML rather than an actual .dig file (G-2).

**Tests**: WT-1 through WT-7 as documented. Multiple `toBeGreaterThan`/`toBeGreaterThanOrEqual`/`toBeDefined` weaknesses.

**Issues found**: V-1 (require() in dom-parser.ts), G-2 (parsesColor uses inline XML not file), WT-1, WT-2, WT-3, WT-4, WT-5, WT-6, WT-7.

---

### Task 4.2.1 — Attribute Mapping Framework
**Files**: `src/io/attribute-map.ts`, `src/io/__tests__/attribute-map.test.ts`

**Spec adherence**: All 11 converter factories present. `applyAttributeMappings` and `getUnmapped` present. The `DigAttributeMapping` interface extending `AttributeMapping` is present. The `inverterConfigConverter.convert()` fallback (V-7) is a hygiene violation. All named spec tests are present and pass expected behaviours.

**Tests**: No weaknesses found in the attribute-map tests specifically. Tests are concrete and specific.

**Issues found**: V-7 (fallback return in convert()).

---

### Task 4.2.2 — Circuit Construction from Parsed XML
**Files**: `src/io/dig-loader.ts`, `src/io/__tests__/dig-loader.test.ts`

**Spec adherence**: Task not recorded in progress.md (G-1). All required functions present. The `applyInverterConfig` function uses a readonly-cast workaround (V-5, V-6). The scope-creep generic/enabled passthrough (V-2) is present.

**Tests**: All named spec tests present. WT-8, WT-9, WT-10 weaknesses found.

**Issues found**: G-1, V-2, V-5, V-6, G-5, WT-8, WT-9, WT-10.

---

### Task 4.4.1 — JSON Save
**Files**: `src/io/save-schema.ts`, `src/io/save.ts`, `src/io/__tests__/save.test.ts`

**Spec adherence**: `serializeCircuit`, `SAVE_FORMAT_VERSION`, `encodeBigint`, `decodeBigint` all present. The `SavedElement` type has two extra fields not in the spec (`instanceId`, `mirror`) and changes `rotation` from optional to required (V-3, G-4). All 4 named spec tests are present.

**Tests**: Tests are concrete. No additional weaknesses beyond what was found.

**Issues found**: V-3, G-4, LR-1.

---

### Task 4.4.2 — JSON Load
**Files**: `src/io/load.ts`, `src/io/__tests__/load.test.ts`

**Spec adherence**: `deserializeCircuit`, `SavedCircuitSchema`, `migrateSavedCircuit` all present. All 5 named spec tests present. Implementation is clean.

**Tests**: Tests are specific, use exact values, and test error cases correctly. No weaknesses found.

**Issues found**: None specific to this task (the `SavedElement` schema deviation from 4.4.1 flows through here but is accounted for in V-3).

---

### Task 4.4.3 — Headless .dig Loading
**Files**: `src/headless/loader.ts`, `src/headless/__tests__/loader.test.ts`

**Spec adherence**: `SimulationLoader` class with `loadDig()` and `loadJson()` are present. All 4 named spec tests present. The loader correctly chains `parseDigXml → loadDigCircuit`. Environment detection is correct.

**Tests**: Tests are specific and concrete. No weaknesses found.

**Issues found**: None specific to this task (it inherits the dom-parser `require()` issue from task 4.1.2 via transitive use).
