# Review Report: Wave FIX.3

**Scope**: Wave FIX.3 — main.ts gut + engine wiring + API + spec
**Phase**: fix-spec remediation
**Tasks reviewed**: G1, I1, A2, S1
**Date**: 2026-03-06

---

## Summary

| Metric | Count |
|--------|-------|
| Tasks reviewed | 4 |
| Violations — critical | 1 |
| Violations — major | 3 |
| Violations — minor | 1 |
| Gaps | 2 |
| Weak tests | 2 |
| Legacy references | 1 |
| **Verdict** | **has-violations** |

---

## Violations

### Violation 1 — CRITICAL

**File**: `src/app/app-init.ts:119`
**Rule violated**: Completeness — implementation must match the spec. The spec (fix-spec.md §I1 and §A2) defines `bind()` as `bind(circuit: Circuit, engine: SimulationEngine, wireNetMap, pinNetMap)` with `circuit` as the first parameter. The interface in `editor-binding.ts` correctly declares this 4-parameter signature. However the actual call site passes only 3 arguments with the wrong types in wrong positions.

**Evidence**:
```typescript
// src/app/app-init.ts:119
binding.bind(engine, compiled.wireToNetId, compiled.pinNetMap);
```

**Expected call** (per spec §I1 pseudocode and the `EditorBinding.bind()` interface):
```typescript
binding.bind(circuit, engine, compiled.wireToNetId, compiled.pinNetMap);
```

**Impact**: At runtime, `engine` (a `DigitalEngine`) is passed as the `circuit: Circuit` argument, `compiled.wireToNetId` is passed as the `engine: SimulationEngine` argument, `compiled.pinNetMap` is passed as the `wireNetMap` argument, and the actual `pinNetMap` parameter receives `undefined`. This will cause:
- `this._circuit` to be set to the engine object (wrong type)
- `this._engine` to be set to the wire-to-net Map (wrong type) — meaning `_engine.getSignalRaw()` will throw `TypeError: not a function` at runtime
- `this._wireNetMap` to be set to the pinNetMap map (wrong map)
- `this._pinNetMap` to be `undefined`, causing `_pinNetMap.get()` to throw immediately

**Severity**: Critical — the engine wiring is broken. Every call to `getWireValue()`, `getPinValue()`, or `setInput()` will throw a TypeError at runtime. The Step/Run buttons will fail on first use.

---

### Violation 2 — MAJOR

**File**: `src/engine/compiled-circuit.ts:11`
**Rule violated**: rules.md §Code Hygiene — "No historical-provenance comments." The banned pattern is explicitly: `Java reference: de.neemann.digital.*`

**Evidence**:
```typescript
 * Java reference: de.neemann.digital.core.Model (the runtime execution graph)
```

This file (`compiled-circuit.ts`) was modified as part of task I1 (adding the `pinNetMap` field). The pre-existing Java reference comment was not removed, despite M6 in the fix-spec explicitly listing this file as containing a banned comment (`src/runtime/timing-diagram.ts:19` is listed, and compiled-circuit.ts carries the same pattern). The file was touched in this wave and the comment should have been cleaned.

**Severity**: Major — rule explicitly bans all `Java reference:` JSDoc lines. The file was modified in this wave; the comment was within scope to clean.

---

### Violation 3 — MAJOR

**File**: `src/integration/__tests__/editor-binding.test.ts:95`
**Rule violated**: rules.md §Testing — "Test the specific: exact values, exact types, exact error messages where applicable." Assertion `expect(rawCall).toBeDefined()` only verifies that a matching call record exists; it does not verify the correct `netId` was used.

**Evidence**:
```typescript
const rawCall = engine.calls.find(
  (c) => c.method === "getSignalRaw" && c.netId === 3,
);
expect(rawCall).toBeDefined();
```

The `find()` predicate already filters by `netId === 3`, so `toBeDefined()` is confirming `netId === 3` indirectly via the filter — but this is a weak assertion pattern. The test should explicitly assert `rawCall!.netId === 3` or use a more direct call-argument assertion. The same pattern applies to `setCall` below.

**Severity**: Major — the assertion as written does verify the correct netId via the find predicate, but a developer could refactor the predicate and the expect line would still pass trivially if `calls` is non-empty. The spec rule requires explicit value assertions.

---

### Violation 4 — MAJOR

**File**: `src/integration/__tests__/editor-binding.test.ts:106`
**Rule violated**: rules.md §Testing — same as Violation 3. `expect(setCall).toBeDefined()` is a weak stand-alone assertion after a `find()` that already filters by method and netId.

**Evidence**:
```typescript
const setCall = engine.calls.find(
  (c) => c.method === "setSignalValue" && c.netId === 3,
);
expect(setCall).toBeDefined();
if (setCall?.method === "setSignalValue") {
  expect(setCall.value).toBe(value);
}
```

The value assertion `expect(setCall.value).toBe(value)` is inside a conditional guard `if (setCall?.method === ...)`. If `setCall` is `undefined`, the value assertion is silently skipped. The `toBeDefined()` on line 106 does not prevent this because it only throws if `setCall` is `undefined`, but the structural issue remains: the value assertion is guarded by a conditional, not by a unconditional expect. If the conditional were accidentally false (e.g., wrong method name in the record), the test still passes.

**Severity**: Major — the inner value assertion `expect(setCall.value).toBe(value)` is inside a conditional guard that will silently not execute if the `if` branch is not entered, making it an effectively optional assertion.

---

### Violation 5 — MINOR

**File**: `src/integration/editor-binding.ts:72, 83, 90`
**Rule violated**: rules.md §Code Hygiene — dead fields. The `_circuit` field is stored in `bind()` and cleared in `unbind()` but is never read or used anywhere in the implementation.

**Evidence**:
```typescript
private _circuit: Circuit | null = null;   // line 72
// ...
this._circuit = circuit;                    // line 83 — written but never read
// ...
this._circuit = null;                       // line 90 — cleared but never used
```

The `Circuit` import on line 14 exists solely for this dead field. No method in `EditorBindingImpl` reads `_circuit`. This is dead code that increases coupling without providing any functionality. If `circuit` was intended for future use, that is a deferred/TODO pattern banned by rules.md §Completeness.

**Severity**: Minor — dead field, unused import.

---

## Gaps

### Gap 1

**Spec requirement** (fix-spec.md §I1): The `compileAndBind()` function pseudocode specifies `binding.bind(engine, compiled.wireToNetId, compiled.pinNetMap)` in the spec body — but this conflicts with the A2 spec (§A2) which says the corrected `bind()` signature takes `circuit: Circuit` as the first parameter. The implementation follows the I1 pseudocode's 3-argument form (missing `circuit`) rather than the A2-corrected 4-argument interface that was simultaneously implemented.

**What was found**: The interface in `editor-binding.ts` was updated to the correct 4-argument form `bind(circuit, engine, wireNetMap, pinNetMap)`. But the call site in `app-init.ts:119` uses the old 3-argument form `bind(engine, wireToNetId, pinNetMap)`.

**File**: `src/app/app-init.ts:119`

This gap directly causes Violation 1. The fix spec was internally inconsistent — A2 updated the interface signature, but I1's pseudocode was not updated to match. The implementation agent followed the I1 pseudocode rather than the updated A2 interface. Result: the call site is wrong.

---

### Gap 2

**Spec requirement** (fix-spec.md §I1): `wireSignalAccessAdapter` should implement `WireSignalAccess` by delegating to `binding.getWireValue(wire)` and resolving bit width from `compiled.netWidths`.

**What was found**: The `wireSignalAccessAdapter` at `src/app/app-init.ts:135-148` correctly delegates to `binding.getWireValue(wire)` and reads `compiled.netWidths[netId]`. However, due to Violation 1 (broken `bind()` call), `binding.getWireValue()` will throw at runtime because `this._engine` will be a `Map` object, not an engine. The adapter's implementation is structurally correct but will never work correctly until the `bind()` call is fixed.

**File**: `src/app/app-init.ts:135-148`

This gap is a runtime consequence of Violation 1, not a separate implementation error.

---

## Weak Tests

### Weak Test 1

**Test path**: `src/integration/__tests__/editor-binding.test.ts::EditorBinding::getWireValue — bind with known wireNetMap, mock engine returns specific value for net ID`

**What is wrong**: After finding the call record with `find(c => c.method === "getSignalRaw" && c.netId === 3)`, the assertion `expect(rawCall).toBeDefined()` does not assert `rawCall.netId === 3` explicitly. The intent to verify the correct netId is expressed only through the filter predicate, not through a direct assertion. This is an indirect assertion pattern: if the filter logic changed or was misapplied, no explicit assertion would catch it.

**Quoted evidence**:
```typescript
const rawCall = engine.calls.find(
  (c) => c.method === "getSignalRaw" && c.netId === 3,
);
expect(rawCall).toBeDefined();
```

---

### Weak Test 2

**Test path**: `src/integration/__tests__/editor-binding.test.ts::EditorBinding::setInput — call setInput(), verify engine.setSignalValue() called with correct net ID`

**What is wrong**: The value assertion `expect(setCall.value).toBe(value)` is wrapped in a conditional `if (setCall?.method === "setSignalValue")`. If `setCall` is defined but the `method` field does not equal `"setSignalValue"` for any reason, the inner `toBe` assertion is silently skipped and the test passes. Rules require unconditional assertions.

**Quoted evidence**:
```typescript
if (setCall?.method === "setSignalValue") {
  expect(setCall.value).toBe(value);
}
```

---

## Legacy References

### Legacy Reference 1

**File**: `src/engine/compiled-circuit.ts:11`
**Stale reference**: `* Java reference: de.neemann.digital.core.Model (the runtime execution graph)`

This file was modified in Wave FIX.3 (task I1) to add the `pinNetMap` field. The `Java reference:` JSDoc line is a banned historical-provenance pattern per rules.md §Code Hygiene and fix-spec.md §M6. The file was within scope for this wave and the comment was not removed.

---

## Per-Task Findings Summary

| Task | Status | Key Issues |
|------|--------|-----------|
| G1 — Reduce main.ts to minimal placeholder | Correctly implemented | `src/main.ts` is exactly 2 lines. No violations. |
| I1 — Wire simulation engine to UI | Has critical defect | `binding.bind()` call passes wrong arguments (Violation 1 / Gap 1). `_circuit` dead field (Violation 5). Java reference comment not removed (Violation 2). |
| A2 — EditorBinding.bind() circuit parameter | Interface correct; call site broken | Interface updated to 4-arg form correctly. All tests pass in isolation (they call `bind(circuit, engine, ...)` correctly). But the production call site in `app-init.ts` was not updated. |
| S1 — Update spec for analyseSequential | Correctly implemented | `spec/phase-8-analysis-synthesis.md` now shows `analyseSequential(facade: SequentialAnalysisFacade, stateVars, inputs, outputs)`. No code changes needed; spec-only. |
