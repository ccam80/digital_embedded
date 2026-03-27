# Review Report: Subcircuit Extraction Phase

## Summary

| Item | Count |
|------|-------|
| Tasks reviewed | 9 (SE-1, SE-3, SE-4, SE-5, SE-7, SE-8, SE-9a, SE-9b, flatten-port-test) |
| Violations — critical | 0 |
| Violations — major | 3 |
| Violations — minor | 3 |
| Gaps | 2 |
| Weak tests | 5 |
| Legacy references | 4 |

**Verdict**: has-violations

---

## Violations

### V-1
**File**: `src/solver/digital/flatten.ts`, line 411
**Rule**: Code Hygiene — "No historical-provenance comments. Any comment describing what code replaced, what it used to do, why it changed, or where it came from is banned."
**Evidence**:
```
 * For INPUT/OUTPUT directions, falls back to In/Out (legacy subcircuits).
```
The phrase "legacy subcircuits" describes historical context — that old subcircuits used `In`/`Out`. This is a banned historical-provenance comment. The function behaviour can be described in terms of what it does now, without reference to what the code used to do or what `.dig` files from the past look like.
**Severity**: major

---

### V-2
**File**: `src/solver/digital/flatten.ts`, line 430
**Rule**: Code Hygiene — no historical-provenance comments; no fallbacks or backwards-compatibility shims.
**Evidence**:
```typescript
  // Fall back to In/Out (legacy subcircuits)
```
Inline comment explicitly names the code as a "fallback" to "legacy" behaviour. Both words are on the banned list. The comment is proof the agent knowingly implemented a compatibility shim and justified it inline.
**Severity**: major

---

### V-3
**File**: `src/headless/__tests__/port-mcp.test.ts`, lines 61–63
**Rule**: Testing — "Tests ALWAYS assert desired behaviour. Never adjust tests to match perceived limitations in test data or package functionality."
**Evidence**:
```typescript
        // In/Out elements needed to drive the digital engine (Port is neutral infrastructure)
        { id: 'driveIn',  type: 'In',  props: { label: 'X_drive', bitWidth: 1 } },
        { id: 'readOut',  type: 'Out', props: { label: 'Z_read',  bitWidth: 1 } },
```
The spec acceptance criterion for SE-9a states: "`circuit_build` a subcircuit using Port interfaces, `circuit_compile` succeeds." The comment "In/Out elements needed to drive the digital engine" is an explicit admission that the test circuit is structured around a perceived limitation — the digital engine cannot drive/read a Port-only circuit. The test does not exercise Port-only compilation; it exercises a Port-decorated In/Out circuit. This is a test adjusted to work around a limitation rather than asserting the desired behaviour.
**Severity**: major

---

### V-4
**File**: `src/solver/digital/flatten.ts`, lines 410–412 (JSDoc block)
**Rule**: Code Hygiene — no backwards-compatibility shims described in comments.
**Evidence**:
```
 * Port elements (domain-agnostic) are tried first for all directions.
 * For INPUT/OUTPUT directions, falls back to In/Out (legacy subcircuits).
 * For BIDIRECTIONAL direction, returns undefined if no Port matches.
```
The JSDoc documents the "fallback" shim path using explicitly banned language. While the spec text (Flattener Update section) does specify the `In`/`Out` fallback path for backward compatibility, the comment uses banned vocabulary ("falls back", "legacy") that constitutes a historical-provenance comment.
**Severity**: minor

---

### V-5
**File**: `src/solver/digital/__tests__/flatten-port.test.ts`, line 241
**Rule**: Code Hygiene — no historical-provenance language in test names.
**Evidence**:
```typescript
  it("falls back to In/Out for INPUT/OUTPUT direction (legacy subcircuits)", () => {
```
The test name uses both "falls back" and "legacy subcircuits" — language that describes what was replaced and its historical role. Test names must describe desired behaviour, not historical context.
**Severity**: minor

---

### V-6
**File**: `src/solver/digital/__tests__/flatten-port.test.ts`, line 243
**Rule**: Code Hygiene — no historical-provenance comments.
**Evidence**:
```typescript
    const internal = new Circuit({ name: "LegacySub" });
```
The circuit fixture name `"LegacySub"` encodes legacy provenance. Fixture names must reflect what they test, not where it came from.
**Severity**: minor

---

## Gaps

### G-1
**Spec requirement**: `spec/subcircuit-extraction.md` — `flatten-port-test` task: the test file must be created as part of the task sequence.
**What was found**: `spec/progress.md` records `flatten-port-test` as **Status: skipped — file lock conflict**, "Files created: none". However, `src/solver/digital/__tests__/flatten-port.test.ts` exists and contains all 5 required tests. The file was created implicitly by a different agent (SE-2) without a corresponding progress entry. The task is complete in code but not in tracking.
**File**: `spec/progress.md` — `flatten-port-test` task shows Status: skipped, yet the file exists.

---

### G-2
**Spec requirement**: `spec/subcircuit-extraction.md`, Files to Create: "`src/app/subcircuit-dialog.ts` — Create Subcircuit modal dialog". This file must appear in a task's "Files created" entry.
**What was found**: `src/app/subcircuit-dialog.ts` exists and is wired in via `menu-toolbar.ts`. However, no reviewed task entry in `spec/progress.md` lists it as created. SE-8's progress entry lists only modified files, not this new file. The implementation is present; the tracking is missing.
**File**: `spec/progress.md` — SE-8 entry does not list `src/app/subcircuit-dialog.ts` as created.

---

## Weak Tests

### WT-1
**Test**: `src/components/io/__tests__/port.test.ts::PortDefinition::models is empty object (neutral infrastructure)`
**Problem**: `toBeDefined()` is a bare existence check. It only confirms `models` is not `undefined`. The real assertion follows (`Object.keys(PortDefinition.models as object).toHaveLength(0)`). The `toBeDefined()` call adds no diagnostic signal and is the JS equivalent of `is not None` without content checking.
**Evidence**:
```typescript
    expect(PortDefinition.models).toBeDefined();
    expect(Object.keys(PortDefinition.models as object)).toHaveLength(0);
```

---

### WT-2
**Test**: `src/headless/__tests__/port-mcp.test.ts::Port MCP surface — setInput/readOutput via Port labels::Port label resolves in labelSignalMap`
**Problem**: `toBeDefined()` on `portComp` at line 208 is a bare existence guard. The following line (`portComp!.label`) does the real assertion. `toBeDefined()` in isolation does not test behaviour.
**Evidence**:
```typescript
    const portComp = netlist.components.find(c => c.typeId === 'Port');
    expect(portComp).toBeDefined();
    expect(portComp!.label).toBe('drive_port');
```

---

### WT-3
**Test**: `src/solver/digital/__tests__/flatten-port.test.ts::flattenCircuit — Port interface elements::bridge wire connects subcircuit pin position to internal Port pin position`
**Problem**: `toBeDefined()` at line 407 ends the test without asserting any property of the bridge wire beyond its existence at a given position. The wire's bitWidth is not checked, nor is any other property. This tests only that a wire exists at specific coordinates.
**Evidence**:
```typescript
    expect(bridgeWire).toBeDefined();
  });
```

---

### WT-4
**Test**: `src/io/__tests__/subcircuit-store.test.ts::loadAllSubcircuits::returns StoredSubcircuit objects with all required fields`
**Problem**: After calling `storeSubcircuit("Test", "<circuit/>")`, the test checks only that field types are correct (`typeof entry.name === "string"`) rather than asserting the specific stored values. The test does not check that `entry.name === "Test"` or `entry.xml === "<circuit/>"`. This is the `isinstance`/type-only pattern — shape verification without content verification.
**Evidence**:
```typescript
    expect(typeof entry.name).toBe("string");
    expect(typeof entry.xml).toBe("string");
    expect(typeof entry.created).toBe("number");
    expect(typeof entry.modified).toBe("number");
```

---

### WT-5
**Test**: `src/headless/__tests__/port-mcp.test.ts::Port MCP surface — test vectors resolve Port labels::circuit_test against a Port-labeled circuit resolves columns correctly`
**Problem**: The test at lines 88–118 uses `"A B | Y_out"` test vectors where `Y_out` is an `Out`-labeled element, not a `Port`-labeled element. The comment in the test admits this: "use Out label for output column since Port is neutral infrastructure." The spec acceptance criterion for SE-9a states: "`circuit_test` against a Port-based subcircuit resolves test vector columns to Port labels." The test does not exercise Port label resolution in test vectors; it exercises `Out` label resolution. The test fails to demonstrate the stated acceptance criterion.
**Evidence** (lines 110–113):
```typescript
    // Test vectors: A B | Y_out  (use Out label for output column since Port is
    // neutral infrastructure — the labeled signal in labelSignalMap is Y)
    const testData = 'A B | Y_out\n0 0 0\n0 1 0\n1 0 0\n1 1 1';
```

---

## Legacy References

### LR-1
**File**: `src/solver/digital/flatten.ts`, line 411
**Stale reference**: `"legacy subcircuits"` — refers to the historical `.dig` file format using `In`/`Out` as interface elements. The term "legacy" encodes historical provenance in a production code JSDoc comment.

---

### LR-2
**File**: `src/solver/digital/flatten.ts`, line 430
**Stale reference**: `"// Fall back to In/Out (legacy subcircuits)"` — inline code comment describing the backwards-compatibility path by name using both "Fall back" and "legacy".

---

### LR-3
**File**: `src/solver/digital/__tests__/flatten-port.test.ts`, line 241
**Stale reference**: test name string `"falls back to In/Out for INPUT/OUTPUT direction (legacy subcircuits)"` — test description encodes legacy provenance language in a test name.

---

### LR-4
**File**: `src/solver/digital/__tests__/flatten-port.test.ts`, line 243
**Stale reference**: circuit fixture name `"LegacySub"` — fixture name encodes its legacy character rather than describing what it tests.
